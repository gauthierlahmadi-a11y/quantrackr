import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../api/jobs/search.js';
import { createLogin } from '../api/auth/login.js';
import { issueCookie } from '../api/_lib/auth.js';
import { validateQuery, mapJobs } from '../api/_lib/serpapi.js';
import { _resetMemory } from '../api/_lib/ratelimit.js';

const SECRET_KEY = 'SERP-SECRET-KEY-DO-NOT-LEAK';
const ENV = { SERPAPI_API_KEY: SECRET_KEY, APP_PASSCODE: 'open sesame', SESSION_SECRET: 'x'.repeat(32) };
const cookie = () => issueCookie(ENV).split(';')[0];
const mkRes = () => { const r = { headers: {}, code: 200, body: null, setHeader(k, v) { r.headers[k] = v; }, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
const mkReq = (o = {}) => ({ method: 'GET', headers: { cookie: cookie(), 'x-forwarded-for': '1.2.3.4' }, query: { q: 'finance intern', engine: 'google_jobs' }, ...o });
const up = (status, body, headers = {}) => ({ status, ok: status < 400, headers: { get: (k) => headers[k.toLowerCase()] || null }, json: async () => { if (body === undefined) throw new Error('bad json'); return body; } });
const run = async (fetchFn, req = mkReq(), env = ENV) => {
  const logs = []; const orig = console.log; console.log = (m) => logs.push(String(m));
  const res = mkRes();
  try { await createHandler({ env, fetchFn, sleep: async () => {}, random: () => 0 })(req, res); } finally { console.log = orig; }
  return { res, logs };
};
beforeEach(() => _resetMemory());

const goodBody = { search_metadata: { id: 'abc', status: 'Success' }, jobs_results: [{ title: 'T', company_name: 'C', location: 'Paris, France', via: 'via X', share_link: 'https://www.google.com/search?ibp=htl;jobs&htidocid=DOC%3D%3D', job_id: Buffer.from(JSON.stringify({ htidocid: 'DOC==' })).toString('base64'), apply_options: [{ title: 'X', link: 'https://x.com/j/1234567' }] }], serpapi_pagination: { next_page_token: 'NEXT' } };

test('missing provider configuration returns a safe error (after auth)', async () => {
  const { res } = await run(async () => up(200, goodBody), mkReq(), { ...ENV, SERPAPI_API_KEY: '' });
  assert.equal(res.code, 503); assert.equal(res.body.error.category, 'not_configured');
});

test('unauthenticated callers get 401 and learn nothing about configuration', async () => {
  const { res } = await run(async () => up(200, goodBody), mkReq({ headers: {} }), { ...ENV, SERPAPI_API_KEY: '' });
  assert.equal(res.code, 401);
  assert.equal(res.body.error.category, 'auth_required');
  assert.doesNotMatch(JSON.stringify(res.body), /configured/i);
});

test('server fails closed when no access control is configured, unless explicitly delegated to the platform', async () => {
  const bare = { SERPAPI_API_KEY: SECRET_KEY };
  assert.equal((await run(async () => up(200, goodBody), mkReq({ headers: {} }), bare)).res.code, 503);
  assert.equal((await run(async () => up(200, goodBody), mkReq({ headers: {} }), { ...bare, ALLOW_UNAUTHENTICATED: '1' })).res.code, 200);
});

test('forged or tampered session cookies and cross-site requests are refused', async () => {
  assert.equal((await run(async () => up(200, goodBody), mkReq({ headers: { cookie: 'vt_session=abc.def' } }))).res.code, 401);
  assert.equal((await run(async () => up(200, goodBody), mkReq({ headers: { cookie: cookie(), 'sec-fetch-site': 'cross-site' } }))).res.code, 403);
});

test('wrong method rejected', async () => { assert.equal((await run(async () => up(200, goodBody), mkReq({ method: 'POST' }))).res.code, 405); });

test('successful search: mapped jobs, stable docid, next-page token forwarded, key not echoed', async () => {
  let calledUrl;
  const { res, logs } = await run(async (u) => { calledUrl = String(u); return up(200, goodBody); });
  assert.equal(res.code, 200);
  assert.equal(res.body.jobs[0].providerJobId, 'DOC==');
  assert.equal(res.body.nextPageToken, 'NEXT');
  assert.equal(res.body.noResults, false);
  assert.match(calledUrl, /api_key=/);
  assert.doesNotMatch(JSON.stringify(res.body) + logs.join('\n') + JSON.stringify(res.headers), new RegExp(SECRET_KEY));
});

test('upstream authentication error is categorised as provider_auth (not the user login)', async () => {
  const { res, logs } = await run(async () => up(401, { error: 'Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key' }));
  assert.equal(res.body.error.category, 'provider_auth');
  assert.doesNotMatch(JSON.stringify(res.body) + logs.join(''), new RegExp(SECRET_KEY));
});

test('quota exhaustion vs transient rate limit; Retry-After respected', async () => {
  const q = await run(async () => up(429, { error: 'Your account has run out of searches.' }));
  assert.equal(q.res.body.error.category, 'quota'); assert.equal(q.res.body.error.retryable, false);
  let n = 0;
  const r = await run(async () => (++n < 2 ? up(429, { error: 'slow down' }, { 'retry-after': '2' }) : up(200, goodBody)));
  assert.equal(r.res.code, 200); assert.equal(n, 2);
  const g = await run(async () => up(429, { error: 'slow down' }, { 'retry-after': '120' }));
  assert.equal(g.res.code, 429); assert.equal(g.res.headers['Retry-After'], '120');
});

test('timeouts are categorised and retried a bounded number of times', async () => {
  let n = 0;
  const { res } = await run(async () => { n++; throw Object.assign(new Error('t'), { name: 'TimeoutError' }); });
  assert.equal(res.code, 504); assert.equal(res.body.error.category, 'timeout'); assert.equal(n, 3);
});

test('network errors are categorised', async () => {
  const { res } = await run(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); });
  assert.equal(res.body.error.category, 'network');
});

test('invalid JSON from the provider is an error, not an empty result', async () => {
  const { res } = await run(async () => up(200, undefined));
  assert.equal(res.code, 502); assert.equal(res.body.error.category, 'invalid_response');
});

test('upstream 404 and error JSON never become a successful empty search', async () => {
  const a = await run(async () => up(404, { error: 'Not found' }));
  assert.equal(a.res.code, 502); assert.notEqual(a.res.body.status, 'ok');
  const b = await run(async () => up(200, { search_metadata: { status: 'Error' }, error: 'We could not get valid results.' }));
  assert.equal(b.res.body.status, 'error');
  const c = await run(async () => up(200, { error: 'Something odd' }));
  assert.equal(c.res.body.status, 'error');
  const d = await run(async () => up(200, { search_metadata: { status: 'Success' }, nothing: true, error: undefined }));
  assert.equal(d.res.body.status, 'ok'); assert.equal(d.res.body.noResults, true);
  const e = await run(async () => up(200, { unexpected: 'shape' }));
  assert.equal(e.res.body.error.category, 'invalid_response');
});

test('"Google hasn\'t returned any results" is a successful empty search, flagged noResults', async () => {
  const { res } = await run(async () => up(200, { search_metadata: { status: 'Success' }, error: "Google hasn't returned any results for this query." }));
  assert.equal(res.code, 200); assert.equal(res.body.noResults, true); assert.deepEqual(res.body.jobs, []);
});

test('transient provider 5xx is retried then succeeds; invalid requests are not retried', async () => {
  let n = 0;
  const ok = await run(async () => (++n < 3 ? up(503, { error: 'x' }) : up(200, goodBody)));
  assert.equal(ok.res.code, 200); assert.equal(n, 3);
  let m = 0;
  await run(async () => { m++; return up(400, { error: 'bad' }); });
  assert.equal(m, 1);
});

test('unsupported / malformed parameters are rejected before any upstream call', async () => {
  let calls = 0; const f = async () => { calls++; return up(200, goodBody); };
  for (const query of [{ q: 'x', fromage: '3' }, { q: 'a' }, { q: 'x'.repeat(201) }, { q: 'ok', engine: 'google' }, { q: 'ok', gl: 'france' }, { q: 'ok', next_page_token: '<script>' }, { q: 'ok', engine: 'indeed_jobs', next_page_token: 'abc' }]) {
    const { res } = await run(f, mkReq({ query }));
    assert.equal(res.code, 400, JSON.stringify(query));
  }
  assert.equal(calls, 0);
  assert.equal(validateQuery({ q: ' finance\u0000  intern ', hl: 'FR', gl: 'FR' }).params.q, 'finance intern');
});

test('rate limit applies and is reported with Retry-After', async () => {
  const env = { ...ENV, SEARCH_LIMIT_PER_HOUR: '2' };
  const f = async () => up(200, goodBody);
  assert.equal((await run(f, mkReq(), env)).res.code, 200);
  assert.equal((await run(f, mkReq(), env)).res.code, 200);
  const third = await run(f, mkReq(), env);
  assert.equal(third.res.code, 429); assert.equal(third.res.body.error.category, 'rate_limited'); assert.ok(third.res.headers['Retry-After']);
});

test('shared limiter is used when Upstash credentials exist', async () => {
  const seen = [];
  const env = { ...ENV, UPSTASH_REDIS_REST_URL: 'https://redis.example', UPSTASH_REDIS_REST_TOKEN: 't' };
  const f = async (u, o) => { if (String(u).includes('redis.example')) { seen.push(o.body); return { ok: true, json: async () => [{ result: 1 }, { result: 1 }] }; } return up(200, goodBody); };
  const { res } = await run(f, mkReq(), env);
  assert.equal(res.code, 200); assert.equal(res.body.limiter, 'shared'); assert.ok(seen.length >= 1);
});

test('login: wrong passcode 401, right passcode sets HttpOnly SameSite=Strict cookie, brute force is limited', async () => {
  const login = createLogin({ env: ENV, fetchFn: async () => up(200, {}) });
  const call = async (body) => { const r = mkRes(); await login({ method: 'POST', headers: { 'x-forwarded-for': '9.9.9.9' }, body }, r); return r; };
  assert.equal((await call({ passcode: 'nope' })).code, 401);
  const good = await call({ passcode: 'open sesame' });
  assert.equal(good.code, 200);
  assert.match(good.headers['Set-Cookie'], /HttpOnly.*Secure.*SameSite=Strict/);
  let last; for (let i = 0; i < 12; i++) last = await call({ passcode: 'nope' });
  assert.equal(last.code, 429);
});

test('mapJobs tolerates missing/null/odd fields', () => {
  const jobs = mapJobs({ jobs_results: [null, 'str', { title: null, company_name: 5, apply_options: [{ link: 7 }, null, { title: 'a', link: 'https://a.com/1234567' }], detected_extensions: null }] }, 'google_jobs');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].applyOptions.length, 1);
  assert.equal(jobs[0].title, null);
  assert.equal(mapJobs({}, 'google_jobs'), null);
});
