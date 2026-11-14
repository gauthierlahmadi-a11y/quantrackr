// Executes a search plan. Pure orchestration: the network call (`fetchPage`) and the cache are injected,
// so every behaviour (budget, cancellation, retries, pagination, counts) is testable with mocks.
//
// Rules enforced here:
//  * strictly sequential requests, one query at a time
//  * provider requests never exceed settings.maxSearches for the run (pages included)
//  * cache hits are labelled as cache and never count as provider requests
//  * nothing is retried automatically; "retry failed" re-runs only failed queries
//  * cancellation stops the queue and aborts the in-flight request; partial results are kept
//  * a repeated next-page token ends pagination (no loops)

import { normalizeProviderJob } from './normalize.js';
import { groupResults, matchTracked } from './matching.js';
import { cacheKeyFor } from './planner.js';

const FATAL = new Set(['auth_required', 'not_configured', 'provider_auth', 'quota', 'rate_limited']);

/**
 * @param {object} o
 * @param {object} o.plan                       output of buildPlan()
 * @param {(params:object, pageToken:string|null, signal:AbortSignal)=>Promise<object>} o.fetchPage
 * @param {{get:Function,set:Function,ttlHours:number}|null} o.cache
 * @param {()=>Date} [o.now]
 * @param {(snap:object)=>void} [o.onUpdate]
 */
export function createSearchRun({ plan, fetchPage, cache = null, now = () => new Date(), onUpdate = () => {} }) {
  const settings = plan.settings;
  const maxRequests = settings.maxSearches;
  const target = settings.year ? { year: settings.year, season: settings.season } : null;
  const ttlMs = (cache?.ttlHours ?? 12) * 36e5;

  const queries = plan.queries.map((q) => ({
    id: q.id, label: q.label, params: q.params, cacheKey: q.cacheKey,
    status: 'pending', pages: [], nextToken: null, seenTokens: new Set(), error: null, failedToken: null,
  }));
  const state = { providerRequests: 0, cancelled: false, fatal: null, running: false, ctl: null, startedAt: null };

  const emit = () => { try { onUpdate(snapshot()); } catch { /* UI errors must not break the run */ } };
  const budgetLeft = () => maxRequests - state.providerRequests;

  async function runPage(q, token) {
    const key = token ? cacheKeyFor(q.params, token) : q.cacheKey;
    if (settings.useCache && cache) {
      const hit = cache.get(key);
      if (hit && now() - new Date(hit.at) < ttlMs) {
        q.pages.push({ n: q.pages.length + 1, token, source: 'cache', at: hit.at, jobs: hit.jobs, rawCount: hit.jobs.length, requestId: null });
        q.nextToken = hit.nextToken || null;
        return { cached: true };
      }
    }
    if (budgetLeft() <= 0) return { budget: true };
    state.ctl = new AbortController();
    state.providerRequests++;
    try {
      const res = await fetchPage(q.params, token, state.ctl.signal);
      const jobs = Array.isArray(res.jobs) ? res.jobs : [];
      const at = res.retrievedAt || now().toISOString();
      q.pages.push({ n: q.pages.length + 1, token, source: 'provider', at, jobs, rawCount: jobs.length, requestId: res.requestId || null, noResults: !!res.noResults });
      q.nextToken = res.nextPageToken || null;
      if (cache) cache.set(key, { key, at, params: q.params, pageToken: token || null, jobs, nextToken: q.nextToken });
      return { ok: true };
    } catch (e) {
      if (state.cancelled || (e && e.category === 'cancelled')) return { cancelled: true };
      throw e;
    } finally { state.ctl = null; }
  }

  function trackToken(q) {
    // Guard against a provider returning a token we already used (would loop forever).
    if (q.nextToken) {
      if (q.seenTokens.has(q.nextToken)) { q.nextToken = null; q.tokenRepeated = true; }
      else q.seenTokens.add(q.nextToken);
    }
  }

  async function runQuery(q, token = null) {
    q.status = 'running'; q.error = null; emit();
    try {
      const r = await runPage(q, token);
      if (r.cancelled) { q.status = 'cancelled'; return; }
      if (r.budget) { q.status = q.pages.length ? 'ok' : 'skipped_budget'; return; }
      q.status = 'ok'; q.failedToken = null; trackToken(q);
    } catch (e) {
      q.status = 'failed'; q.failedToken = token;
      q.error = { category: e.category || 'network', message: e.message || 'Request failed', retryAfter: e.retryAfter || null, requestId: e.requestId || null };
      if (FATAL.has(q.error.category)) state.fatal = q.error;
    }
  }

  async function runList(list) {
    if (state.running) return;
    state.running = true; state.cancelled = false; state.fatal = null; state.startedAt = state.startedAt || now().toISOString();
    try {
      for (const q of list) {
        if (state.cancelled) { if (q.status === 'pending' || q.status === 'failed') q.status = q.status === 'pending' ? 'cancelled' : q.status; continue; }
        if (state.fatal) break;
        await runQuery(q, q.failedToken);
        emit();
      }
      if (state.cancelled) for (const q of list) if (q.status === 'pending' || q.status === 'running') q.status = 'cancelled';
    } finally { state.running = false; emit(); }
  }

  const api = {
    start: () => runList(queries.filter((q) => q.status === 'pending')),
    /** Re-run only the failed queries (and only the page that failed). Successful queries are untouched. */
    retryFailed: () => runList(queries.filter((q) => q.status === 'failed')),
    /** Continue queries that were cancelled or not attempted. */
    resume: () => { queries.forEach((q) => { if (q.status === 'cancelled' || q.status === 'skipped_budget') q.status = 'pending'; }); return runList(queries.filter((q) => q.status === 'pending')); },
    /** Fetch the next page of one query. Counts against the same budget. */
    async loadMore(queryId) {
      const q = queries.find((x) => x.id === queryId);
      const why = canLoadMore(q);
      if (why) return { ok: false, reason: why };
      if (state.running) return { ok: false, reason: 'busy' };
      state.running = true; state.cancelled = false;
      try { await runQuery(q, q.nextToken); } finally { state.running = false; emit(); }
      return { ok: true };
    },
    cancel() { state.cancelled = true; if (state.ctl) state.ctl.abort(); emit(); },
    canLoadMore: (id) => canLoadMore(queries.find((x) => x.id === id)),
    snapshot: () => snapshot(),
    results: (opts) => results(opts),
    queries,
  };

  function canLoadMore(q) {
    if (!q) return 'unknown_query';
    if (!settings.allowPages) return 'pages_not_allowed';
    if (!q.nextToken) return 'no_next_page';
    if (q.status === 'running') return 'busy';
    const used = queries.reduce((a, x) => a + Math.max(0, x.pages.filter((p) => p.source === 'provider').length - (x.pages.some((p) => p.source === 'provider' && p.n === 1) ? 1 : 0)), 0);
    if (budgetLeft() <= 0) return 'budget_exhausted';
    if (used >= plan.extraPageLimit) return 'extra_page_limit_reached';
    return null;
  }

  function results(opts = {}) {
    return buildResults(queries.map((q) => ({ params: q.params, pages: q.pages })), { target, postedWithinDays: settings.postedWithinDays, today: now(), ...opts });
  }

  function snapshot() {
    const by = (s) => queries.filter((q) => q.status === s).length;
    const providerPages = queries.flatMap((q) => q.pages.filter((p) => p.source === 'provider'));
    const lastProvider = providerPages.map((p) => p.at).sort().pop() || null;
    return {
      running: state.running, cancelled: state.cancelled, fatal: state.fatal,
      queries: queries.map((q) => ({
        id: q.id, label: q.label, status: q.status, error: q.error, nextToken: !!q.nextToken, tokenRepeated: !!q.tokenRepeated,
        pages: q.pages.map((p) => ({ n: p.n, source: p.source, at: p.at, rawCount: p.rawCount, noResults: !!p.noResults })),
        canLoadMore: canLoadMore(q) === null, loadMoreBlockedBy: canLoadMore(q),
      })),
      counters: {
        queriesPlanned: queries.length,
        queriesAttempted: queries.filter((q) => !['pending', 'skipped_budget'].includes(q.status) && (q.pages.length || q.error || q.status === 'cancelled' || q.status === 'running')).length,
        successful: by('ok'), failed: by('failed'), cancelled: by('cancelled'), skippedBudget: by('skipped_budget'),
        cacheHits: queries.reduce((a, q) => a + q.pages.filter((p) => p.source === 'cache').length, 0),
        providerRequests: state.providerRequests, requestBudget: maxRequests,
        lastProviderRetrievalAt: lastProvider,
      },
    };
  }

  return api;
}

/**
 * Pure: normalise -> group -> match against tracked -> local date filter, with reconciled counts.
 * @param {{params:object, pages:{n:number,source:string,at:string,jobs:object[],rawCount:number}[]}[]} queryPages
 */
export function buildResults(queryPages, { target = null, opps = [], decisions = {}, postedWithinDays = '', today = new Date() } = {}) {
  const accepted = [], rejected = [];
  let rawReceived = 0, fromCache = 0;
  for (const q of queryPages) {
    for (const p of q.pages) {
      rawReceived += p.rawCount; if (p.source === 'cache') fromCache += p.rawCount;
      for (const raw of p.jobs) {
        const n = normalizeProviderJob(raw, { provider: 'serpapi', engine: q.params.engine, retrievedAt: p.at, query: q.params.q, params: q.params, target, page: p.n });
        if (n.ok) { n.job.fromCache = p.source === 'cache'; accepted.push(n.job); }
        else rejected.push({ company: n.company, role: n.role, reason: n.reason, query: q.params.q });
      }
    }
  }
  const g = groupResults(accepted, { decisions });
  const days = +postedWithinDays || 0;
  let hidden = 0;
  const rows = g.groups.map((grp) => {
    const t = matchTracked(grp.job, opps);
    return { ...grp, tracked: t.tier === 'none' ? null : t };
  }).filter((row) => {
    if (!days || !row.job.postedAt) return true;                    // unknown dates are kept (and flagged), never guessed
    if ((today - new Date(row.job.postedAt)) / 864e5 > days) { hidden++; return false; }
    return true;
  });
  const visibleIds = new Set(rows.map((r) => r.id));
  for (const r of rows) r.possible = r.possible.filter((p) => visibleIds.has(p.otherId));
  return {
    rows, rejected,
    counts: {
      rawReceived, fromCache, valid: accepted.length, rejected: rejected.length,
      confirmedDuplicates: g.stats.confirmedDuplicates, unique: g.stats.unique, hiddenByLocalDateFilter: hidden, shown: rows.length,
      possibleDuplicates: rows.reduce((a, r) => a + r.possible.length, 0) / 2,
      alreadyTracked: rows.filter((r) => r.tracked && r.tracked.tier === 'strong').length,
      possiblyTracked: rows.filter((r) => r.tracked && r.tracked.tier === 'probable').length,
    },
  };
}
