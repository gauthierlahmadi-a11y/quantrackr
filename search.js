// GET /api/jobs/search  — authenticated, rate-limited proxy to SerpApi. The key never leaves the server.
import crypto from 'node:crypto';
import { validateQuery, buildUpstream, mapJobs, classifyUpstream } from '../_lib/serpapi.js';
import { authMode, hasValidSession, crossSite, clientKey } from '../_lib/auth.js';
import { consume, limiterMode } from '../_lib/ratelimit.js';
import { log } from '../_lib/log.js';

const HTTP = { auth_required: 401, forbidden: 403, bad_request: 400, method_not_allowed: 405, rate_limited: 429, quota: 429, upstream_rate_limit: 429, not_configured: 503, auth_not_configured: 503, provider_auth: 502, provider_error: 502, invalid_response: 502, network: 502, timeout: 504 };
const DEADLINE_MS = 25000, ATTEMPT_MS = 10000, MAX_ATTEMPTS = 3;

export function createHandler({ env = process.env, fetchFn = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), random = Math.random } = {}) {
  return async function handler(req, res) {
    const rid = crypto.randomBytes(6).toString('hex');
    const t0 = Date.now();
    res.setHeader('Cache-Control', 'no-store');
    const fail = (category, message, extra = {}) => {
      if (extra.retryAfter) res.setHeader('Retry-After', String(extra.retryAfter));
      log({ rid, evt: 'error', category, status: HTTP[category] || 500, ms: Date.now() - t0, ...(extra.log || {}) });
      return res.status(HTTP[category] || 500).json({ status: 'error', requestId: rid, error: { category, message, retryable: !!extra.retryable, retryAfter: extra.retryAfter || null } });
    };

    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return fail('method_not_allowed', 'Use GET.'); }
    if (crossSite(req)) return fail('forbidden', 'Cross-site requests are not allowed.');

    const mode = authMode(env);
    if (mode === 'unconfigured') return fail('auth_not_configured', 'Access control is not configured on the server.');
    if (mode === 'passcode' && !hasValidSession(req, env)) return fail('auth_required', 'Sign in required.');

    // Authenticated from here on, so reporting configuration problems no longer leaks anything.
    const KEY = env.SERPAPI_API_KEY;
    if (!KEY) return fail('not_configured', 'The search provider is not configured on the server.');

    const v = validateQuery(req.query);
    if (!v.ok) return fail('bad_request', v.message);

    const rl = await consume(clientKey(req), { env, fetchFn });
    if (!rl.allowed) return fail('rate_limited', 'Search limit reached. Try again later.', { retryAfter: rl.retryAfter, retryable: false, log: { limiter: rl.mode } });

    const url = 'https://serpapi.com/search.json?' + buildUpstream(v.params, KEY);   // contains the key: never logged or returned
    const start = Date.now();
    let last = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const left = DEADLINE_MS - (Date.now() - start);
      if (left < 1500) break;
      let status = 0, body = null;
      try {
        const r = await fetchFn(url, { signal: AbortSignal.timeout(Math.min(ATTEMPT_MS, left)), headers: { Accept: 'application/json' } });
        status = r.status;
        const retryAfter = Number(r.headers && r.headers.get && r.headers.get('retry-after')) || 0;
        try { body = await r.json(); } catch { body = null; }
        last = { status, body, retryAfter };
      } catch (e) {
        const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
        last = { net: true, timedOut, code: (e && e.cause && e.cause.code) || e.name };
        log({ rid, evt: 'upstream_exception', category: timedOut ? 'timeout' : 'network', attempt });
        if (attempt < MAX_ATTEMPTS) { await sleep(400 * 2 ** (attempt - 1) + Math.floor(random() * 250)); continue; }
        break;
      }
      log({ rid, evt: 'upstream', upstreamStatus: status, attempt, engine: v.params.engine });
      const bad = classifyUpstream(status, body);
      if (!bad) break;
      if (bad.category === 'no_results') { last = { ...last, empty: true }; break; }
      last = { ...last, bad };
      if (bad.retryable && attempt < MAX_ATTEMPTS) {
        const wait = last.retryAfter ? last.retryAfter * 1000 : 400 * 2 ** (attempt - 1) + Math.floor(random() * 250);
        if (wait > 5000 || wait > DEADLINE_MS - (Date.now() - start)) break;     // too long to wait inside one function call
        await sleep(wait); continue;
      }
      break;
    }

    if (!last) return fail('timeout', 'The search took too long.', { retryable: true });
    if (last.net) return last.timedOut ? fail('timeout', 'The provider timed out.', { retryable: true }) : fail('network', 'Could not reach the provider.', { retryable: true, log: { upstreamStatus: 0 } });
    if (last.bad) return fail(last.bad.category, last.bad.message, { retryable: last.bad.retryable, retryAfter: last.retryAfter || null, log: { upstreamStatus: last.status } });

    const jobs = last.empty ? [] : mapJobs(last.body, v.params.engine);
    if (jobs === null) {
      if (last.body && last.body.search_metadata && last.body.search_metadata.status === 'Success' && !last.body.error) {
        return res.status(200).json(ok(rid, v.params, [], last.body, true, rl.mode));       // Success without a jobs list: genuinely empty
      }
      return fail('invalid_response', 'The provider response had an unexpected shape.');
    }
    log({ rid, evt: 'ok', status: 200, ms: Date.now() - t0, engine: v.params.engine, limiter: rl.mode });
    return res.status(200).json(ok(rid, v.params, jobs, last.body, jobs.length === 0, rl.mode));
  };
}

function ok(rid, params, jobs, body, noResults, limiter) {
  const next = body && body.serpapi_pagination && typeof body.serpapi_pagination.next_page_token === 'string' ? body.serpapi_pagination.next_page_token : null;
  return {
    status: 'ok', requestId: rid, engine: params.engine, retrievedAt: new Date().toISOString(), jobs, rawCount: jobs.length, noResults,
    nextPageToken: params.engine === 'google_jobs' ? next : null,
    providerSearchId: (body && body.search_metadata && typeof body.search_metadata.id === 'string') ? body.search_metadata.id : null,
    limiter,
  };
}

export default createHandler();
