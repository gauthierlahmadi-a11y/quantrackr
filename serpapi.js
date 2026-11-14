// SerpApi request validation, response mapping and error classification. No network here.
export const ENGINES = new Set(['google_jobs', 'indeed_jobs']);
const ALLOWED = new Set(['engine', 'q', 'location', 'gl', 'hl', 'next_page_token']);
const ctl = /[\u0000-\u001f\u007f]/g;
const one = (v) => (Array.isArray(v) ? v[0] : v);

/** @returns {{ok:true, params:object}|{ok:false, message:string}} */
export function validateQuery(query) {
  const extra = Object.keys(query || {}).filter((k) => !ALLOWED.has(k));
  if (extra.length) return { ok: false, message: 'Unsupported parameter(s): ' + extra.slice(0, 5).map((k) => k.replace(/[^\w-]/g, '').slice(0, 24)).join(', ') };
  const engine = one(query.engine) || 'google_jobs';
  if (!ENGINES.has(engine)) return { ok: false, message: 'Unsupported engine.' };
  const q = String(one(query.q) ?? '').replace(ctl, ' ').replace(/\s+/g, ' ').trim();
  if (q.length < 2 || q.length > 200) return { ok: false, message: 'q must be 2-200 characters.' };
  const p = { engine, q };
  const loc = one(query.location);
  if (loc != null && loc !== '') { const l = String(loc).replace(ctl, ' ').trim(); if (l.length > 100) return { ok: false, message: 'location too long.' }; if (l) p.location = l; }
  const gl = one(query.gl); if (gl) { if (!/^[a-z]{2}$/i.test(gl)) return { ok: false, message: 'gl must be a two-letter country code.' }; p.gl = String(gl).toLowerCase(); }
  const hl = one(query.hl); if (hl) { if (!/^[a-z]{2,3}(-[a-z0-9]{2,3})?$/i.test(hl)) return { ok: false, message: 'hl is not a valid language code.' }; p.hl = String(hl).toLowerCase(); }
  const tok = one(query.next_page_token);
  if (tok) {
    if (engine !== 'google_jobs') return { ok: false, message: 'Pagination token is only supported for google_jobs.' };
    if (typeof tok !== 'string' || tok.length > 2000 || !/^[A-Za-z0-9_\-=+/.%]+$/.test(tok)) return { ok: false, message: 'Invalid next_page_token.' };
    p.next_page_token = tok;
  }
  return { ok: true, params: p };
}

/** Upstream query string. Indeed uses `l` for location. The result contains the API key: never log it. */
export function buildUpstream(params, apiKey) {
  const u = new URLSearchParams({ engine: params.engine, api_key: apiKey, q: params.q });
  if (params.engine === 'google_jobs') { for (const k of ['location', 'gl', 'hl', 'next_page_token']) if (params[k]) u.set(k, params[k]); }
  else if (params.location) u.set('l', params.location);
  return u;
}

function decodeDocId(jobId) {
  try { const j = JSON.parse(Buffer.from(String(jobId), 'base64').toString('utf8')); return j && typeof j.htidocid === 'string' ? j.htidocid : null; } catch { return null; }
}
function docIdFromLink(link) {
  try { const u = new URL(link); return u.searchParams.get('htidocid') || new URLSearchParams(u.hash.slice(1)).get('htidocid'); } catch { return null; }
}
const str = (v, max = 4000) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : null);

/** Provider records vary: every field is optional and type-checked. */
export function mapJobs(data, engine) {
  const list = Array.isArray(data.jobs_results) ? data.jobs_results : null;
  if (!list) return null;
  return list.filter((j) => j && typeof j === 'object').map((j) => {
    if (engine === 'indeed_jobs') {
      const link = str(j.link);
      return { providerJobId: str(j.job_id) || null, providerJobToken: null, title: str(j.title), company: str(j.company_name), location: str(j.location), via: 'Indeed',
        description: str(j.description || j.snippet, 1500), postedText: str(j.posted_at || j.date), scheduleType: str(j.job_type), salaryText: str(typeof j.salary === 'string' ? j.salary : null),
        shareLink: link, sourceLink: null, applyOptions: link ? [{ title: 'Indeed', link }] : [], extensions: [], thumbnail: null, sponsored: j.sponsored === true };
    }
    const de = j.detected_extensions && typeof j.detected_extensions === 'object' ? j.detected_extensions : {};
    const share = str(j.share_link);
    const docid = decodeDocId(j.job_id) || (share ? docIdFromLink(share) : null);   // job_id strings differ per query; htidocid is the stable part
    return { providerJobId: docid, providerJobToken: str(j.job_id, 6000), title: str(j.title), company: str(j.company_name), location: str(j.location), via: str(j.via),
      description: str(j.description, 1500), postedText: str(de.posted_at), scheduleType: str(de.schedule_type), salaryText: str(de.salary),
      shareLink: share, sourceLink: str(j.source_link),
      applyOptions: (Array.isArray(j.apply_options) ? j.apply_options : []).filter((a) => a && typeof a.link === 'string').slice(0, 12).map((a) => ({ title: str(a.title, 120), link: a.link.slice(0, 2000) })),
      extensions: (Array.isArray(j.extensions) ? j.extensions : []).filter((e) => typeof e === 'string').slice(0, 12).map((e) => e.slice(0, 120)),
      thumbnail: str(j.thumbnail, 1000), sponsored: false };
  });
}

/**
 * Classify an upstream answer. SerpApi may answer HTTP 200 with an `error` string
 * ("Google hasn't returned any results for this query." = successful empty search).
 */
export function classifyUpstream(status, body) {
  const err = body && typeof body.error === 'string' ? body.error : '';
  if (status === 401 || status === 403) return { category: 'provider_auth', retryable: false, message: 'The search provider rejected the server credentials.' };
  if (status === 429) return /run out of searches|out of searches|plan|quota/i.test(err)
    ? { category: 'quota', retryable: false, message: 'The provider search allowance is used up.' }
    : { category: 'upstream_rate_limit', retryable: true, message: 'The provider is rate limiting requests.' };
  if (status === 404) return { category: 'provider_error', retryable: false, message: 'The provider endpoint was not found.' };
  if (status >= 500 || (body && body.search_metadata && body.search_metadata.status === 'Error')) return { category: 'provider_error', retryable: true, message: 'The provider could not complete the search.' };
  if (status >= 400) return { category: 'provider_error', retryable: false, message: 'The provider rejected the request.' };
  if (body == null || typeof body !== 'object') return { category: 'invalid_response', retryable: false, message: 'The provider returned an unreadable response.' };
  if (err && /hasn't returned any results|no results/i.test(err)) return { category: 'no_results', retryable: false, message: 'No results.' };
  if (err) return { category: 'provider_error', retryable: /try again later/i.test(err), message: 'The provider reported an error.' };
  return null;
}
