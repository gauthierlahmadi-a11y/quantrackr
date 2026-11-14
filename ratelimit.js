// Fixed-window limiter. With Upstash/Vercel KV REST credentials it is PERSISTENT and SHARED across
// serverless instances. Without them it falls back to per-instance memory, which is best-effort only
// (each cold start/instance has its own counter) and must not be relied on as a global limit.
const mem = new Map();
const cfg = (env) => ({ url: env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL, token: env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN });
export const limiterMode = (env = process.env) => { const c = cfg(env); return c.url && c.token ? 'shared' : 'instance'; };

async function hit(key, windowS, env, fetchFn) {
  const c = cfg(env);
  if (c.url && c.token) {
    try {
      const r = await fetchFn(c.url.replace(/\/$/, '') + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json' }, body: JSON.stringify([['INCR', key], ['EXPIRE', key, String(windowS), 'NX']]), signal: AbortSignal.timeout(2500) });
      const j = await r.json();
      const n = Number(j && j[0] && j[0].result);
      if (r.ok && Number.isFinite(n)) return { n, mode: 'shared' };
    } catch { /* fall through to memory */ }
  }
  const now = Date.now(); const e = mem.get(key);
  if (!e || e.reset < now) { mem.set(key, { n: 1, reset: now + windowS * 1000 }); return { n: 1, mode: 'instance' }; }
  e.n++; return { n: e.n, mode: 'instance' };
}

/** @returns {{allowed:boolean, retryAfter:number, mode:string}} checks hourly and daily caps */
export async function consume(id, { env = process.env, fetchFn = fetch, scope = 'search', limits } = {}) {
  const hourly = limits ? limits.hourly : Number(env.SEARCH_LIMIT_PER_HOUR) || 30, daily = limits ? limits.daily : Number(env.SEARCH_LIMIT_PER_DAY) || 100;
  const h = await hit(`vt:${scope}:h:${id}`, 3600, env, fetchFn);
  if (h.n > hourly) return { allowed: false, retryAfter: 3600, mode: h.mode };
  const d = await hit(`vt:${scope}:d:${id}`, 86400, env, fetchFn);
  if (d.n > daily) return { allowed: false, retryAfter: 86400, mode: d.mode };
  return { allowed: true, retryAfter: 0, mode: d.mode };
}
export const _resetMemory = () => mem.clear();
