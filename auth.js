// Server-side access control for a personal deployment.
//  * APP_PASSCODE + SESSION_SECRET set  -> login required; HttpOnly, SameSite=Strict, HMAC-signed cookie
//  * ALLOW_UNAUTHENTICATED=1            -> no app-level auth (use ONLY behind Vercel Deployment Protection)
//  * neither                            -> fail closed (503)
import crypto from 'node:crypto';
const COOKIE = 'vt_session';
const TTL_S = 60 * 60 * 24 * 14;
const b64 = (b) => Buffer.from(b).toString('base64url');
const sign = (p, secret) => crypto.createHmac('sha256', secret).update(p).digest('base64url');
const eq = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };

export function authMode(env = process.env) {
  if (env.APP_PASSCODE && env.SESSION_SECRET && env.SESSION_SECRET.length >= 16) return 'passcode';
  if (env.ALLOW_UNAUTHENTICATED === '1') return 'platform';
  return 'unconfigured';
}
export function checkPasscode(given, env = process.env) { return authMode(env) === 'passcode' && typeof given === 'string' && eq(given, env.APP_PASSCODE); }
export function issueCookie(env = process.env, now = Date.now()) {
  const p = b64(JSON.stringify({ exp: Math.floor(now / 1000) + TTL_S }));
  return `${COOKIE}=${p}.${sign(p, env.SESSION_SECRET)}; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=${TTL_S}`;
}
export const clearCookie = () => `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=0`;
export function hasValidSession(req, env = process.env, now = Date.now()) {
  if (authMode(env) !== 'passcode') return false;
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || '');
  if (!m) return false;
  const [p, s] = m[1].split('.');
  if (!p || !s || !eq(s, sign(p, env.SESSION_SECRET))) return false;
  try { return JSON.parse(Buffer.from(p, 'base64url').toString()).exp > now / 1000; } catch { return false; }
}
/** Cross-site browser requests are refused even if a cookie were somehow attached. */
export const crossSite = (req) => req.headers['sec-fetch-site'] === 'cross-site';
export const clientKey = (req) => crypto.createHash('sha256').update(String((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.headers['x-real-ip'] || 'unknown')).digest('hex').slice(0, 16);
