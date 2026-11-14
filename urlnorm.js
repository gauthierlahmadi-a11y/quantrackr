// Conservative URL analysis for job links.
//
// The legacy normaliser kept only `hostname + pathname`. Every Google Jobs share link is
// https://www.google.com/search?ibp=htl;jobs&q=...&htidocid=<ID>#fpstate=...&htidocid=<ID>
// so all of them collapsed to "google.com/search" and unrelated jobs were merged.
//
// analyseUrl() never guesses: it only reports `isJobSpecific: true` (and a `comparisonKey`)
// when the URL itself carries a job identifier in a format we understand and have tests for.

/** Reviewed allowlist of tracking parameters. Everything else is preserved. */
export const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid', 'igshid',
]);

/** Extra tracking parameters that are only removed for a specific, understood provider. */
const PROVIDER_TRACKING = {
  linkedin: new Set(['trk', 'trackingid', 'refid', 'lipi', 'originalsubdomain', 'eboost']),
};

/** Query/fragment parameters that are known to carry a job identifier. */
const JOB_ID_PARAMS = new Set([
  'jobid', 'job_id', 'jid', 'gh_jid', 'requisitionid', 'requisition_id', 'reqid', 'req_id',
  'jk', 'vjk', 'currentjobid', 'ji', 'positionid', 'position_id', 'offerid', 'offer_id',
  'job', 'posting', 'posting_id', 'postingid', 'opening', 'req', 'requisition', 'position',
]);

/** Path segments that describe a listing page or landing page rather than one job. */
const GENERIC_SEGMENTS = new Set([
  'careers', 'career', 'jobs', 'job', 'emplois', 'emploi', 'offres', 'offres-emploi', 'recrutement',
  'join-us', 'joinus', 'search', 'search-results', 'results', 'opportunities', 'students', 'student',
  'early-careers', 'early-career', 'internships', 'internship', 'graduates', 'graduate', 'apply',
  'work-with-us', 'vacancies', 'positions', 'openings', 'en', 'fr', 'de', 'index', 'home', 'view',
]);

const LOCALE_SEGMENT = /^[a-z]{2}([-_][a-z]{2})?$/i;

function parseParams(str) {
  if (!str || !str.includes('=')) return new URLSearchParams();
  try { return new URLSearchParams(str); } catch { return new URLSearchParams(); }
}

function lowerKeyed(params) {
  const o = {};
  for (const [k, v] of params) if (!(k.toLowerCase() in o)) o[k.toLowerCase()] = v;
  return o;
}

function detectProvider(host) {
  if (/(^|\.)google\.[a-z.]+$/.test(host)) return 'google';
  if (/(^|\.)linkedin\.com$/.test(host)) return 'linkedin';
  if (/(^|\.)indeed\.[a-z.]+$/.test(host)) return 'indeed';
  if (/(^|\.)welcometothejungle\.com$/.test(host)) return 'wttj';
  if (/(^|\.)greenhouse\.io$/.test(host)) return 'greenhouse';
  if (/(^|\.)lever\.co$/.test(host)) return 'lever';
  if (/(^|\.)myworkdayjobs\.com$/.test(host)) return 'workday';
  return null;
}

const failure = (raw, code) => ({
  originalUrl: raw == null ? null : String(raw),
  normalizedUrl: null,
  comparisonKey: null,
  isJobSpecific: false,
  provider: null,
  jobId: null,
  safe: false,
  warnings: [code],
});

/**
 * @returns {{originalUrl:string|null, normalizedUrl:string|null, comparisonKey:string|null,
 *            isJobSpecific:boolean, provider:string|null, jobId:string|null, safe:boolean,
 *            warnings:string[]}}
 */
export function analyseUrl(raw) {
  if (raw == null || String(raw).trim() === '') return failure(raw, 'missing_url');
  let u;
  try { u = new URL(String(raw).trim()); } catch { return failure(raw, 'malformed_url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return failure(raw, 'unsupported_protocol');
  if (u.username || u.password) return failure(raw, 'embedded_credentials');
  if (!u.hostname.includes('.')) return failure(raw, 'malformed_url');

  const warnings = [];
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const provider = detectProvider(host);
  const path = u.pathname.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
  const segs = path.split('/').filter(Boolean);
  const drop = new Set([...TRACKING_PARAMS, ...(PROVIDER_TRACKING[provider] || [])]);

  const kept = [...u.searchParams].filter(([k]) => !drop.has(k.toLowerCase()));
  kept.sort(([a], [b]) => a.localeCompare(b));
  const qObj = lowerKeyed(new URLSearchParams(kept));
  const fragParams = parseParams(u.hash.replace(/^#/, ''));
  const fObj = lowerKeyed(fragParams);

  // ---- identity extraction ------------------------------------------------------------
  let key = null, jobId = null;

  if (provider === 'google') {
    const docid = qObj.htidocid || fObj.htidocid;
    if (path === '/search' && docid) { jobId = docid; key = `google_jobs:${docid}`; }
    else warnings.push('google_search_page_without_job_id');
  } else if (provider === 'linkedin') {
    const m = /^\/jobs\/view\/(?:[^/]*-)?(\d{6,})\/?$/.exec(path);
    const id = m ? m[1] : /^\d{6,}$/.test(qObj.currentjobid || '') ? qObj.currentjobid : null;
    if (id) { jobId = id; key = `linkedin:${id}`; } else warnings.push('linkedin_page_without_job_id');
  } else if (provider === 'indeed') {
    const id = qObj.jk || qObj.vjk;
    if (id && /^[0-9a-f]{8,}$/i.test(id)) { jobId = id.toLowerCase(); key = `indeed:${jobId}`; }
    else warnings.push('indeed_page_without_job_id');
  } else if (provider === 'lever') {
    const m = /^\/([^/]+)\/([0-9a-f-]{36})$/i.exec(path);
    if (m) { jobId = m[2].toLowerCase(); key = `lever:${m[1].toLowerCase()}:${jobId}`; }
    else warnings.push('lever_page_without_job_id');
  } else if (provider === 'greenhouse') {
    const m = /^\/([^/]+)\/jobs\/(\d+)$/.exec(path);
    if (m) { jobId = m[2]; key = `greenhouse:${m[1].toLowerCase()}:${jobId}`; }
    else if (qObj.gh_jid) { jobId = qObj.gh_jid; key = `greenhouse:${host}:${jobId}`; }
    else warnings.push('greenhouse_page_without_job_id');
  } else if (provider === 'workday') {
    const rest = LOCALE_SEGMENT.test(segs[0] || '') ? segs.slice(1) : segs;
    const ji = rest.indexOf('job');
    if (ji >= 0 && rest.length - ji >= 2) { jobId = rest.slice(ji + 1).join('/'); key = `workday:${host}/${rest.join('/')}`; }
    else warnings.push('workday_page_without_job');
  } else if (provider === 'wttj') {
    const m = /^\/[a-z]{2}\/companies\/([^/]+)\/jobs\/([^/]+)$/i.exec(path);
    if (m) { jobId = m[2]; key = `wttj:${m[1].toLowerCase()}/${m[2].toLowerCase()}`; }
    else warnings.push('wttj_page_without_job');
  }

  // Generic (unknown or unmatched) hosts: only an explicit identifier counts.
  if (!key && !['google', 'linkedin', 'indeed'].includes(provider)) {
    const idParam = Object.keys({ ...qObj, ...fObj }).find((k) => JOB_ID_PARAMS.has(k) && String({ ...qObj, ...fObj }[k]).length >= 3);
    const meaningful = segs.filter((s) => !GENERIC_SEGMENTS.has(s.toLowerCase()) && !LOCALE_SEGMENT.test(s));
    const last = segs[segs.length - 1] || '';
    const idLikeLast = /\d{5,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|[0-9a-f]{16,}/i.test(last);
    const hashRoute = /^#\/(.+)$/.exec(u.hash || '');           // e.g. #/jobs/12345 (single-page apps)
    const hashLast = hashRoute ? hashRoute[1].split('/').filter(Boolean).pop() : '';
    if (idParam) {
      jobId = String({ ...qObj, ...fObj }[idParam]);
      key = `url:${host}${path}?${idParam}=${jobId}`;
    } else if (hashRoute && /\d{3,}|[0-9a-f]{8}-[0-9a-f]{4}/i.test(hashLast)) {
      jobId = hashLast;
      key = `url:${host}${path}#/${hashRoute[1]}`;
    } else if (idLikeLast && meaningful.length >= 1 && segs.length >= 2) {
      jobId = last;
      key = `url:${host}${path}`;
    } else if (!meaningful.length) {
      warnings.push('generic_landing_page');
    } else {
      warnings.push('url_does_not_identify_a_job');
    }
  }

  // ---- comparison URL (never shown to the user, never opened) --------------------------
  const q = new URLSearchParams(kept).toString();
  let normalizedUrl;
  if (provider === 'google' && key) {
    normalizedUrl = `https://google.com/search?ibp=htl;jobs&htidocid=${encodeURIComponent(jobId)}`;
  } else {
    // Fragments are preserved: some providers use them to identify the job.
    normalizedUrl = `${u.protocol}//${host}${u.port ? ':' + u.port : ''}${path}${q ? '?' + q : ''}${u.hash && u.hash !== '#' ? u.hash : ''}`;
  }

  return {
    originalUrl: String(raw),
    normalizedUrl,
    comparisonKey: key,
    isJobSpecific: !!key,
    provider,
    jobId,
    safe: true,
    warnings,
  };
}

/** The href to expose as a clickable link, or null when the URL is not a safe http(s) URL. */
export function safeHref(raw) {
  const a = analyseUrl(raw);
  return a.safe ? a.originalUrl : null;
}
