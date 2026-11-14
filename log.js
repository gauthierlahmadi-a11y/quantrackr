// Structured, secret-free logging: only whitelisted scalar fields are ever written.
const OK = new Set(['rid', 'evt', 'engine', 'upstreamStatus', 'category', 'attempt', 'ms', 'status', 'limiter']);
export function log(fields) {
  const o = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!OK.has(k)) continue;
    if (typeof v === 'number' || typeof v === 'boolean') o[k] = v;
    else if (typeof v === 'string') o[k] = v.slice(0, 80);
  }
  console.log(JSON.stringify(o));
}
