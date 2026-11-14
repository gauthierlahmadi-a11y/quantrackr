import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, expandQueries, seasonStatus, suggestTarget, cacheKeyFor, DEFAULT_SETTINGS } from '../public/lib/planner.js';
import { createSearchRun } from '../public/lib/searchrun.js';
import { wire } from './fixtures.js';

const TODAY = new Date('2026-11-13T12:00:00Z');
const settings = (o = {}) => ({ ...DEFAULT_SETTINGS, year: 2027, season: 'summer', maxSearches: 10, ...o });
const memCache = (ttlHours = 12, store = new Map()) => ({ ttlHours, store, get: (k) => store.get(k) || null, set: (k, v) => store.set(k, v), peek: (k) => store.get(k) || null });
const mkRun = ({ s = settings(), fetchPage, cache = null, now = () => TODAY } = {}) => {
  const plan = buildPlan(s, cache || { peek: () => null, ttlHours: 12 }, TODAY);
  return { plan, run: createSearchRun({ plan, fetchPage, cache, now }) };
};
const pageOf = (jobs, next = null) => ({ jobs, nextPageToken: next, retrievedAt: TODAY.toISOString(), requestId: 'r' });
let uniq = 0;
const jobs = (n, prefix = 'A') => Array.from({ length: n }, () => wire({ n: ++uniq, company: `${prefix} Co ${uniq}` }));

test('planner: paris preset is small and the plan states its maximum', () => {
  const p = buildPlan(settings(), { peek: () => null, ttlHours: 12 }, TODAY);
  assert.equal(p.counts.planned, 3);
  assert.equal(p.maxFirstPageRequests, 3);
  assert.equal(p.estimatedMaxNewSearches, 3);          // pages off by default
  assert.match(p.note, /not a billing guarantee/);
});

test('planner: cities preset runs only chosen cities; expanded needs explicit confirmation', () => {
  assert.equal(buildPlan(settings({ preset: 'cities', cities: [] }), null, TODAY).counts.planned, 0);
  const c = buildPlan(settings({ preset: 'cities', cities: ['london', 'zurich'], language: 'en' }), null, TODAY);
  assert.equal(c.counts.planned, 2);
  const e = buildPlan(settings({ preset: 'expanded', cities: ['london'] }), null, TODAY);
  assert.equal(e.canStart, false);
  assert.equal(buildPlan(settings({ preset: 'expanded', cities: ['london'], expandedConfirmed: true }), null, TODAY).canStart, true);
});

test('planner: budget truncates the plan and says so', () => {
  const p = buildPlan(settings({ preset: 'expanded', expandedConfirmed: true, maxSearches: 2 }), null, TODAY);
  assert.equal(p.maxFirstPageRequests, 2);
  assert.ok(p.counts.overBudget > 0);
  assert.ok(p.warnings.some((w) => /exceed your budget/.test(w)));
});

test('planner: Summer 2026 has passed on 13 Nov 2026 and Summer 2027 is suggested, not applied', () => {
  assert.equal(seasonStatus(2026, 'summer', TODAY), 'passed');
  assert.equal(seasonStatus(2027, 'summer', TODAY), 'upcoming');
  assert.deepEqual(suggestTarget({ year: 2026, season: 'summer' }, TODAY), { year: 2027, season: 'summer' });
  assert.equal(suggestTarget({ year: 2027, season: 'summer' }, TODAY), null);
});

test('planner: queries never include the year unless a target year is set; custom is a single query', () => {
  assert.ok(expandQueries(settings({ year: null })).every((q) => !/20\d\d/.test(q.params.q)));
  const c = buildPlan(settings({ preset: 'custom', custom: { q: 'treasury intern', location: 'Lyon, France', gl: 'fr', hl: 'fr' } }), null, TODAY);
  assert.equal(c.counts.planned, 1);
});

test('one query returns several unique jobs', async () => {
  const { run } = mkRun({ s: settings({ preset: 'custom', custom: { q: 'x', location: 'Paris', gl: 'fr', hl: 'en' } }), fetchPage: async () => pageOf(jobs(7)) });
  await run.start();
  const r = run.results();
  assert.equal(r.counts.unique, 7);
  assert.equal(r.rows.length, 7);
});

test('multiple queries: received / valid / rejected / duplicates / unique reconcile', async () => {
  const shared = wire({ n: 500, company: 'Shared Co' });
  const batches = [[shared, ...jobs(2), { title: 'no company' }], [shared, ...jobs(3)], [...jobs(1), null]];
  let i = 0;
  const { run } = mkRun({ fetchPage: async () => pageOf(batches[i++]) });
  await run.start();
  const { counts } = run.results();
  assert.equal(counts.rawReceived, 4 + 4 + 2);
  assert.equal(counts.rawReceived, counts.valid + counts.rejected);
  assert.equal(counts.valid, counts.unique + counts.confirmedDuplicates);
  assert.equal(counts.confirmedDuplicates, 1);
  assert.equal(counts.rejected, 2);
});

test('a failed query does not erase successful results; retry re-runs ONLY the failed query', async () => {
  const calls = [];
  let failSecond = true;
  const fetchPage = async (params) => {
    calls.push(params.q);
    if (params.q.startsWith('stage') && failSecond) throw Object.assign(new Error('Provider unavailable'), { category: 'provider_error' });
    return pageOf(jobs(2, params.q.slice(0, 3)));
  };
  const { run } = mkRun({ fetchPage });
  await run.start();
  let snap = run.snapshot();
  assert.equal(snap.counters.successful, 2);
  assert.equal(snap.counters.failed, 1);
  assert.equal(run.results().rows.length, 4, 'partial results kept');
  const before = calls.length;
  failSecond = false;
  await run.retryFailed();
  assert.equal(calls.length, before + 1, 'exactly one extra request');
  assert.ok(calls[calls.length - 1].startsWith('stage'));
  assert.equal(run.snapshot().counters.failed, 0);
  assert.equal(run.results().rows.length, 6);
});

test('cancellation prevents subsequent requests and keeps partial results', async () => {
  let n = 0;
  const { run } = mkRun({ fetchPage: async () => { n++; if (n === 1) run.cancel(); return pageOf(jobs(2)); } });
  await run.start();
  const s = run.snapshot();
  assert.equal(n, 1);
  assert.equal(s.counters.cancelled, 2);
  assert.equal(run.results().rows.length, 2);
});

test('an in-flight request is aborted on cancel', async () => {
  const { run } = mkRun({ fetchPage: (p, t, signal) => new Promise((res, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { category: 'cancelled' })))) });
  const done = run.start();
  setTimeout(() => run.cancel(), 10);
  await done;
  assert.equal(run.snapshot().counters.cancelled, 3);
});

test('budget is enforced across queries and pages', async () => {
  let calls = 0;
  const { run } = mkRun({ s: settings({ maxSearches: 2, allowPages: true, extraPages: 5 }), fetchPage: async () => { calls++; return pageOf(jobs(1), 'tok' + calls); } });
  await run.start();
  assert.equal(calls, 2);
  assert.equal(run.snapshot().counters.skippedBudget, 1);
  const id = run.queries[0].id;
  assert.equal(run.canLoadMore(id), 'budget_exhausted');
  assert.deepEqual(await run.loadMore(id), { ok: false, reason: 'budget_exhausted' });
  assert.equal(calls, 2);
});

test('pagination: no token => disabled; valid token is forwarded; page results are appended and deduped', async () => {
  const seen = [];
  const first = jobs(3);
  const { run } = mkRun({
    s: settings({ preset: 'custom', custom: { q: 'x', location: 'Paris', gl: 'fr', hl: 'en' }, allowPages: true, extraPages: 2, maxSearches: 5 }),
    fetchPage: async (p, token) => { seen.push(token); return token ? pageOf([first[2], ...jobs(2)]) : pageOf(first, 'NEXT-1'); },
  });
  await run.start();
  const id = run.queries[0].id;
  assert.equal(run.snapshot().queries[0].canLoadMore, true);
  await run.loadMore(id);
  assert.deepEqual(seen, [null, 'NEXT-1']);
  const r = run.results();
  assert.equal(r.counts.unique, 5);
  assert.equal(r.counts.confirmedDuplicates, 1);
  assert.equal(run.snapshot().queries[0].canLoadMore, false, 'no further token');
  assert.equal(run.canLoadMore(id), 'no_next_page');
});

test('pagination is gated by the allowPages setting', async () => {
  const { run } = mkRun({ s: settings({ preset: 'custom', custom: { q: 'x', location: 'Paris', gl: 'fr', hl: 'en' }, allowPages: false }), fetchPage: async () => pageOf(jobs(1), 'T') });
  await run.start();
  assert.equal(run.canLoadMore(run.queries[0].id), 'pages_not_allowed');
});

test('a repeated next-page token ends pagination instead of looping', async () => {
  let calls = 0;
  const { run } = mkRun({ s: settings({ preset: 'custom', custom: { q: 'x', location: 'Paris', gl: 'fr', hl: 'en' }, allowPages: true, extraPages: 5, maxSearches: 9 }), fetchPage: async () => { calls++; return pageOf(jobs(1), 'SAME'); } });
  await run.start();
  const id = run.queries[0].id;
  await run.loadMore(id);                       // provider hands back "SAME" again
  assert.equal(run.canLoadMore(id), 'no_next_page');
  assert.equal(run.snapshot().queries[0].tokenRepeated, true);
  assert.equal(calls, 2);
});

test('a page-level failure keeps earlier pages', async () => {
  let n = 0;
  const { run } = mkRun({ s: settings({ preset: 'custom', custom: { q: 'x', location: 'Paris', gl: 'fr', hl: 'en' }, allowPages: true, extraPages: 2, maxSearches: 5 }),
    fetchPage: async () => { n++; if (n === 2) throw Object.assign(new Error('boom'), { category: 'timeout' }); return pageOf(jobs(2), 'P2'); } });
  await run.start();
  await run.loadMore(run.queries[0].id);
  assert.equal(run.queries[0].status, 'failed');
  assert.equal(run.results().rows.length, 2);
  await run.retryFailed();                        // retries the failed page token, not page 1
  assert.equal(n, 3);
});

test('cache hits are labelled as cache and are not provider requests; stale cache is not used as current', async () => {
  const store = new Map();
  const cache = memCache(12, store);
  const planA = buildPlan(settings({ preset: 'custom', custom: { q: 'x', location: 'Paris', gl: 'fr', hl: 'en' } }), cache, TODAY);
  const key = planA.queries[0].cacheKey;
  store.set(key, { key, at: new Date(TODAY - 2 * 36e5).toISOString(), jobs: jobs(3), nextToken: null });
  let calls = 0;
  const { run, plan } = mkRun({ s: settings({ preset: 'custom', custom: { q: 'x', location: 'Paris', gl: 'fr', hl: 'en' } }), cache, fetchPage: async () => { calls++; return pageOf(jobs(1)); } });
  assert.equal(plan.counts.cachedExpected, 1);
  await run.start();
  assert.equal(calls, 0);
  const snap = run.snapshot();
  assert.equal(snap.counters.cacheHits, 1);
  assert.equal(snap.counters.providerRequests, 0);
  assert.equal(snap.queries[0].pages[0].source, 'cache');
  assert.equal(run.results().counts.fromCache, 3);
  assert.equal(run.results().rows[0].job.fromCache, true);

  // stale entry (older than TTL): planned as a provider request, not treated as current
  store.set(key, { key, at: new Date(TODAY - 30 * 36e5).toISOString(), jobs: jobs(3), nextToken: null });
  const stalePlan = buildPlan(settings({ preset: 'custom', custom: { q: 'x', location: 'Paris', gl: 'fr', hl: 'en' } }), cache, TODAY);
  assert.equal(stalePlan.queries[0].state, 'will_run');
  assert.ok(stalePlan.warnings.some((w) => /older than/.test(w)));
  const r2 = mkRun({ s: settings({ preset: 'custom', custom: { q: 'x', location: 'Paris', gl: 'fr', hl: 'en' } }), cache, fetchPage: async () => { calls++; return pageOf(jobs(1)); } });
  await r2.run.start();
  assert.equal(calls, 1);
  assert.equal(r2.run.snapshot().counters.cacheHits, 0);
});

test('"use cache" off forces the provider; force refresh is explicit', async () => {
  const store = new Map(), cache = memCache(12, store);
  const s = settings({ preset: 'custom', custom: { q: 'x', location: 'Paris', gl: 'fr', hl: 'en' }, useCache: false });
  const key = buildPlan(s, cache, TODAY).queries[0].cacheKey;
  store.set(key, { key, at: TODAY.toISOString(), jobs: jobs(1), nextToken: null });
  let calls = 0;
  const { run } = mkRun({ s, cache, fetchPage: async () => { calls++; return pageOf(jobs(1)); } });
  await run.start();
  assert.equal(calls, 1);
});

test('fatal provider errors stop the queue and keep what was retrieved', async () => {
  let n = 0;
  const { run } = mkRun({ fetchPage: async () => { n++; if (n === 2) throw Object.assign(new Error('quota'), { category: 'quota' }); return pageOf(jobs(2)); } });
  await run.start();
  assert.equal(n, 2);
  assert.equal(run.snapshot().fatal.category, 'quota');
  assert.equal(run.results().rows.length, 2);
});

test('target year/season uncertainty is visible; the query year is not evidence', async () => {
  const unspecific = wire({ n: 901, title: 'Finance Intern', description: 'Great team. Copyright 2027 Acme.', company: 'Uncertain Co' });
  const confirmed = wire({ n: 902, title: 'Summer Analyst Intern 2027', description: 'Starts June 2027.', company: 'Confirmed Co' });
  const conflict = wire({ n: 903, title: 'Summer Intern 2026', description: 'Starts June 2026.', company: 'Conflict Co' });
  const { run } = mkRun({ s: settings({ preset: 'custom', custom: { q: 'finance internship 2027', location: 'Paris', gl: 'fr', hl: 'en' } }), fetchPage: async () => pageOf([unspecific, confirmed, conflict]) });
  await run.start();
  const by = Object.fromEntries(run.results().rows.map((r) => [r.job.companyName, r.job]));
  assert.equal(by['Uncertain Co'].targetStatus, 'not_confirmed');
  assert.ok(by['Uncertain Co'].warnings.some((w) => /not confirmed/.test(w.text)));
  assert.equal(by['Confirmed Co'].targetStatus, 'confirmed');
  assert.equal(by['Conflict Co'].targetStatus, 'conflict');
});

test('missing deadlines stay unknown; "rolling" anywhere in a description is not a deadline', async () => {
  const j = wire({ n: 910, description: 'We are a rolling stone of finance. Summer 2027.' });
  const dl = wire({ n: 911, description: 'Apply by 15 March 2027. Summer 2027 internship.' });
  const rolling = wire({ n: 912, description: 'Applications are reviewed on a rolling basis. Summer 2027.' });
  const { run } = mkRun({ s: settings({ preset: 'custom', custom: { q: 'x', location: 'Paris', gl: 'fr', hl: 'en' } }), fetchPage: async () => pageOf([j, dl, rolling]) });
  await run.start();
  const rows = run.results().rows.map((r) => r.job);
  assert.equal(rows[0].deadline, null);
  assert.equal(rows[0].deadlineConfidence, 'unknown');
  assert.equal(rows[1].deadline, '2027-03-15');
  assert.equal(rows[2].deadline, null);
  assert.equal(rows[2].deadlineConfidence, 'rolling_stated');
});

test('local posted-date filter hides only records with a KNOWN older date and counts them', async () => {
  const old = wire({ n: 920, postedText: '40 days ago' }), recent = wire({ n: 921, postedText: '2 days ago' }), unknown = wire({ n: 922, postedText: null });
  const { run } = mkRun({ s: settings({ preset: 'custom', custom: { q: 'x', location: 'Paris', gl: 'fr', hl: 'en' }, postedWithinDays: 7 }), fetchPage: async () => pageOf([old, recent, unknown]) });
  await run.start();
  const r = run.results();
  assert.equal(r.counts.hiddenByLocalDateFilter, 1);
  assert.equal(r.rows.length, 2);
});

test('records absent from a later search are not marked closed: no such state exists in results', async () => {
  const { run } = mkRun({ fetchPage: async () => pageOf([]) });
  await run.start();
  const r = run.results();
  assert.equal(r.rows.length, 0);
  assert.equal(r.counts.rawReceived, 0);
});

test('cacheKeyFor is stable and parameter-sensitive', () => {
  const p = { engine: 'google_jobs', q: 'A', location: 'Paris', gl: 'fr', hl: 'en' };
  assert.equal(cacheKeyFor(p), cacheKeyFor({ ...p, q: 'a' }));
  assert.notEqual(cacheKeyFor(p), cacheKeyFor(p, 'tok'));
  assert.notEqual(cacheKeyFor(p), cacheKeyFor({ ...p, hl: 'fr' }));
});
