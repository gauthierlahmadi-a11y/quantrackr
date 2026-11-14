// Normalise one provider record (the "wire" shape returned by /api/jobs/search) into the
// internal job schema.
//
// Principles:
//  * Never derive a start date, deadline, salary or target period from the search query.
//  * Keep raw text when parsing is uncertain; use null / "Not stated" when nothing is known.
//  * A missing deadline never rejects a listing. Only a missing company or title does.
//  * "completeness" measures which fields are present. It is NOT a truth or verification score.

import { analyseUrl, safeHref } from './urlnorm.js';
import { cleanText, normCompany, normTitle, hashStr, ymd } from './text.js';
import { CITIES, COUNTRIES, COUNTRY_ALIASES, SEASON_WORDS } from './catalog.js';

const KNOWN_CITY = new Set(CITIES.map((c) => c.city.toLowerCase()));

const MONTHS = {
  jan: 0, janvier: 0, janv: 0, january: 0, feb: 1, february: 1, fevrier: 1, fev: 1, mar: 2, march: 2, mars: 2,
  apr: 3, april: 3, avril: 3, avr: 3, may: 4, mai: 4, jun: 5, june: 5, juin: 5, jul: 6, july: 6, juillet: 6,
  aug: 7, august: 7, aout: 7, sep: 8, sept: 8, september: 8, septembre: 8, oct: 9, october: 9, octobre: 9,
  nov: 10, november: 10, novembre: 10, dec: 11, december: 11, decembre: 11,
};

const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const mkDate = (y, m, d) => { const x = new Date(y, m, d); return x.getMonth() === m && x.getDate() === d ? ymd(x) : null; };

/** Parse an explicit calendar date. Returns {date, confidence} or null. Never guesses a missing year. */
export function parseExplicitDate(text) {
  const s = fold(text);
  let m;
  if ((m = /(\d{4})-(\d{2})-(\d{2})/.exec(s))) { const d = mkDate(+m[1], m[2] - 1, +m[3]); return d ? { date: d, confidence: 'exact' } : null; }
  if ((m = /\b(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})\b/.exec(s))) { const d = mkDate(+m[3], m[2] - 1, +m[1]); return d ? { date: d, confidence: 'parsed' } : null; }
  if ((m = /(\d{1,2})(?:st|nd|rd|th|er)?\s+([a-z]+)\.?,?\s+(\d{4})/.exec(s)) && m[2] in MONTHS) {
    const d = mkDate(+m[3], MONTHS[m[2]], +m[1]); return d ? { date: d, confidence: 'parsed' } : null;
  }
  if ((m = /([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/.exec(s)) && m[1] in MONTHS) {
    const d = mkDate(+m[3], MONTHS[m[1]], +m[2]); return d ? { date: d, confidence: 'parsed' } : null;
  }
  return null;
}

/** "3 days ago", "il y a 2 semaines", "today", or an explicit date. */
export function parsePosted(text, refIso) {
  if (text == null || String(text).trim() === '') return { date: null, confidence: 'unknown' };
  const ex = parseExplicitDate(text);
  if (ex) return ex;
  const s = fold(text), ref = refIso ? new Date(refIso) : new Date();
  ref.setHours(0, 0, 0, 0);
  const rel = /(\d+)\s*\+?\s*(hour|heure|day|jour|week|semaine|month|mois)/.exec(s);
  if (rel) {
    const n = +rel[1], u = rel[2];
    const days = /week|semaine/.test(u) ? 7 * n : /month|mois/.test(u) ? 30 * n : /hour|heure/.test(u) ? 0 : n;
    const d = new Date(ref); d.setDate(d.getDate() - days);
    return { date: ymd(d), confidence: 'approximate' };
  }
  if (/today|just posted|aujourd/.test(s)) return { date: ymd(ref), confidence: 'approximate' };
  if (/yesterday|hier/.test(s)) { const d = new Date(ref); d.setDate(d.getDate() - 1); return { date: ymd(d), confidence: 'approximate' }; }
  return { date: null, confidence: 'unknown' };
}

const DEADLINE_CUE = /(?:deadline|apply by|applications? (?:close|due)|closing date|date limite|candidater avant(?: le)?|candidatures? jusqu'au)\W{0,8}([^\n]{0,40})/i;
const ROLLING_CUE = /(?:rolling (?:basis|applications?|admissions?|recruitment)|applications? (?:are )?reviewed on a rolling|until (?:the )?(?:position|role|vacancy) (?:is )?filled|au fil de l.eau)/i;

/** Deadline only from an explicit cue followed by an explicit date. "rolling" needs its own cue phrase. */
export function parseDeadline(description, refIso) {
  const d = cleanText(description) || '';
  const m = DEADLINE_CUE.exec(d);
  if (m) {
    const p = parseExplicitDate(m[1]);
    if (p) return { date: p.date, text: m[0].trim(), confidence: p.confidence };
    return { date: null, text: m[0].trim(), confidence: 'unparsed' };
  }
  if (ROLLING_CUE.test(d)) return { date: null, text: 'Rolling applications (stated in description)', confidence: 'rolling_stated' };
  return { date: null, text: null, confidence: 'unknown' };
}

/** Years/seasons in the listing text itself. The search query is deliberately not an input. */
export function targetEvidence(texts, target) {
  const out = { status: 'not_confirmed', years: [], seasons: [] };
  if (!target || !target.year) return out;
  const cue = /(start|begin|commenc|d[eé]but|intern|stage|summer|[eé]t[eé]|spring|printemps|autumn|automne|programme|program|cohort|rentr[eé]e|from|à partir)/i;
  const years = new Set();
  for (const { text, strong } of texts) {
    const t = String(text || '');
    for (const m of t.matchAll(/\b(20\d{2})\b/g)) {
      const ctx = t.slice(Math.max(0, m.index - 60), m.index + 60);
      if (strong || cue.test(ctx)) years.add(+m[1]);
    }
    for (const [k, re] of Object.entries(SEASON_WORDS)) if (re.test(t)) out.seasons.push(k);
  }
  out.years = [...years].sort();
  out.seasons = [...new Set(out.seasons)];
  const yearOk = years.has(target.year);
  const seasonOk = !target.season || target.season === 'any' || out.seasons.includes(target.season);
  if (yearOk && seasonOk) out.status = 'confirmed';
  else if (yearOk) out.status = 'year_only';                 // year matches, season not evidenced
  else if (years.size) out.status = 'conflict';              // a different year is stated
  return out;
}

export const TARGET_LABEL = {
  confirmed: 'Target year/season confirmed in listing',
  year_only: 'Target year found; season not confirmed',
  conflict: 'Listing mentions a different year',
  not_confirmed: 'Target year/season not confirmed',
};

function parseLocation(loc) {
  const text = cleanText(loc);
  if (!text) return { text: null, city: null, country: null };
  const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
  const last = parts[parts.length - 1] || '';
  const canon = COUNTRIES.find((c) => c.toLowerCase() === last.toLowerCase()) || COUNTRY_ALIASES[last.toLowerCase()] || null;
  let city = null;
  if (parts.length > 1) city = parts[0];                                   // "Paris, France"
  else if (KNOWN_CITY.has(parts[0].toLowerCase())) city = parts[0];        // bare "Paris"
  const country = canon || (parts.length === 1 && !city && COUNTRIES.includes(parts[0]) ? parts[0] : null);
  if (city && country && city.toLowerCase() === country.toLowerCase() && parts.length === 1) city = null;
  return { text, city, country };
}

const FN = [
  ['Investment Banking', /investment bank|m&a|mergers|\bibd\b|advisory/i],
  ['Private Equity', /private equity|buyout|venture|private markets/i],
  ['Asset Management', /asset manage|portfolio|fund manage|gestion d.actifs/i],
  ['Equity Research', /equity research|research analyst/i],
  ['Sales & Trading', /sales and trading|sales & trading|global markets|trading|\bmarkets\b/i],
  ['Corporate Finance', /corporate finance|fp&a|treasury|financial control|controlling/i],
  ['Wealth Management', /wealth|private bank/i],
  ['Risk', /\brisk\b|compliance|credit analyst/i],
  ['FinTech', /fintech|payments/i],
  ['Strategy', /strateg|consult/i],
];
const FIN = /financ|bank|invest|equity|asset|trading|markets|m&a|audit|risk|wealth|analyst|fund|banque/i;

const SOURCE_LABELS = [
  [/linkedin/i, 'LinkedIn'], [/indeed/i, 'Indeed'], [/jungle/i, 'Welcome to the Jungle'],
  [/efinancial/i, 'eFinancialCareers'], [/bright network/i, 'Bright Network'],
];

export function sourceLabelFor(via) {
  const v = cleanText(via);
  if (!v) return null;
  const bare = v.replace(/^via\s+/i, '').trim();
  if (!bare) return null;
  for (const [re, label] of SOURCE_LABELS) if (re.test(bare)) return label;
  return bare;
}

const REQ_RE = /\b(?:req(?:uisition)?(?:\s*(?:id|no\.?|number|#))?|job\s*(?:id|ref)|reference|ref\.?)\s*[:#]?\s*([A-Z]{0,4}[-_]?\d{4,}[A-Z0-9-]*)\b/gi;

export function extractRequisitionIds(text, applyAnalyses = []) {
  const ids = new Set();
  const t = cleanText(text) || '';
  for (const m of t.matchAll(REQ_RE)) ids.add(m[1].toUpperCase());
  for (const a of applyAnalyses) {
    if (a.provider === 'workday' && a.jobId) { const r = /_(R\d{3,})$/.exec(a.jobId); if (r) ids.add(r[1].toUpperCase()); }
    if (a.provider === 'greenhouse' && a.jobId) ids.add(String(a.jobId));
  }
  return [...ids];
}

/**
 * Completeness = share of useful fields present, as returned by the provider.
 * It says nothing about whether the listing is genuine or still open.
 */
export function computeCompleteness(j) {
  const checks = [
    ['company', 10, !!j.companyName], ['title', 10, !!j.roleTitle], ['location', 10, !!j.locationText],
    ['city', 5, !!j.city], ['description', 15, !!j.description], ['listing link', 10, !!(j.shareUrl && j.shareUrl.safe)],
    ['application link', 10, (j.applyOptions || []).some((a) => a.url)], ['posted date', 10, !!j.postedAt],
    ['internship type', 5, j.internshipType && j.internshipType !== 'Not stated'],
    ['deadline', 5, !!j.deadline || j.deadlineConfidence === 'rolling_stated'], ['source label', 10, !!j.sourceLabel],
  ];
  const total = checks.reduce((a, c) => a + c[1], 0);
  const got = checks.reduce((a, c) => a + (c[2] ? c[1] : 0), 0);
  return {
    score: Math.round((100 * got) / total),
    present: checks.filter((c) => c[2]).map((c) => c[0]),
    missing: checks.filter((c) => !c[2]).map((c) => c[0]),
  };
}

/** Relevance with reasons. The query's year never counts as evidence of the job's year. */
export function computeRelevance(j) {
  let score = 0; const reasons = [];
  const add = (n, why) => { score += n; reasons.push(`${n > 0 ? '+' : ''}${n} ${why}`); };
  if (FIN.test(j.roleTitle || '')) add(30, 'finance term in title'); else if (FIN.test(j.description || '')) add(15, 'finance term in description only');
  if (/intern|stage|stagiaire|spring week|apprenti|praktikum/i.test(j.roleTitle || '')) add(25, 'internship term in title');
  else if (/intern|stage/i.test(j.description || '')) add(10, 'internship term in description only');
  const wanted = j.search && j.search.location ? normCompany(String(j.search.location).split(',')[0]) : '';
  if (wanted && j.city && normCompany(j.city) === wanted) add(20, 'city matches the searched city');
  if (j.targetStatus === 'confirmed') add(15, 'target year/season stated in listing');
  else if (j.targetStatus === 'year_only') add(8, 'target year stated in listing');
  else if (j.targetStatus === 'conflict') add(-25, 'listing states a different year');
  return { score: Math.max(0, Math.min(100, score)), reasons };
}

/**
 * @param {object} raw  wire record from the proxy
 * @param {object} ctx  {provider, engine, retrievedAt, query, params, target:{year,season}}
 * @returns {{ok:true, job:object}|{ok:false, reason:string, company:string, role:string}}
 */
export function normalizeProviderJob(raw, ctx) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'Malformed record', company: 'Unknown', role: 'Untitled' };
  const company = cleanText(raw.company), role = cleanText(raw.title);
  if (!company || !role) return { ok: false, reason: !company ? 'Missing company name' : 'Missing role title', company: company || 'Unknown', role: role || 'Untitled' };

  const provider = ctx.provider || 'serpapi', engine = ctx.engine || 'google_jobs';
  const warnings = [];
  const shareUrl = analyseUrl(raw.shareLink || raw.sourceLink || null);
  if (raw.shareLink && !shareUrl.safe) warnings.push({ code: 'bad_listing_url', severity: 'warn', text: 'The listing link was malformed or unsafe and is not clickable.' });
  const applyOptions = (Array.isArray(raw.applyOptions) ? raw.applyOptions : []).map((a) => {
    const an = analyseUrl(a && a.link);
    return an.safe ? { label: cleanText(a.title), url: an.originalUrl, key: an.comparisonKey, jobSpecific: an.isJobSpecific, host: an.provider } : null;
  }).filter(Boolean);
  const droppedApply = (Array.isArray(raw.applyOptions) ? raw.applyOptions.length : 0) - applyOptions.length;
  if (droppedApply > 0) warnings.push({ code: 'bad_apply_url', severity: 'warn', text: `${droppedApply} application link(s) were malformed or unsafe and were dropped.` });
  if (!shareUrl.safe && !applyOptions.length) warnings.push({ code: 'no_links', severity: 'warn', text: 'No listing or application link was returned.' });
  else if (!applyOptions.length) warnings.push({ code: 'no_apply_link', severity: 'info', text: 'No direct application link returned (a listing link exists).' });

  const loc = parseLocation(raw.location);
  const description = cleanText(raw.description);
  const sched = cleanText(raw.scheduleType);
  const T = role + ' ' + (description || '');
  const posted = parsePosted(raw.postedText, ctx.retrievedAt);
  const dl = parseDeadline(description, ctx.retrievedAt);
  const ev = targetEvidence([{ text: role, strong: true }, { text: (raw.extensions || []).join(' '), strong: false }, { text: description, strong: false }], ctx.target);

  const salaryText = cleanText(raw.salaryText);
  const nums = salaryText && salaryText.replace(/,/g, '').match(/\d+(?:\.\d+)?/g);
  const type = /spring week/i.test(T) ? 'Spring Week'
    : /off.?cycle/i.test(T) ? 'Off-cycle Internship'
    : /graduate (programme|program|scheme)/i.test(T) ? 'Graduate Programme'
    : /apprenti|alternance/i.test(T) ? 'Apprenticeship'
    : /intern|stage|stagiaire/i.test(role) || /intern/i.test(sched || '') ? (/summer|été|\bete\b/i.test(T) ? 'Summer Internship' : 'Internship')
    : /intern|stage/i.test(T) ? 'Internship' : 'Not stated';

  const providerJobId = raw.providerJobId ? String(raw.providerJobId).trim() || null : null;
  const reqIds = extractRequisitionIds(description, applyOptions.map((a) => analyseUrl(a.url)));
  const sourceLabel = sourceLabelFor(raw.via);

  const job = {
    id: 'j' + hashStr([provider, engine, providerJobId || '', shareUrl.originalUrl || '', role, company, loc.text || '', description || '', applyOptions.map((a) => a.url).join(','), cleanText(raw.postedText) || ''].join('|')),  // identical raw record => identical id
    provider, engine, providerJobId, providerJobToken: raw.providerJobToken || null,
    companyName: company, roleTitle: role, normalizedCompany: normCompany(company), normalizedRole: normTitle(role),
    sourceLabel, sourceVia: cleanText(raw.via), shareUrl, applyOptions,
    locationText: loc.text, city: loc.city, country: loc.country,
    internshipType: type, employmentType: sched,
    function: (FN.find((f) => f[1].test(role)) || FN.find((f) => f[1].test(T)) || ['Unclassified'])[0],
    sector: FIN.test(T) ? 'Finance' : null,
    remoteType: /remote|télétravail/i.test(T) ? 'Remote' : /hybrid|hybride/i.test(T) ? 'Hybrid' : null,
    postedText: cleanText(raw.postedText), postedAt: posted.date, postedConfidence: posted.confidence,
    deadline: dl.date, deadlineText: dl.text, deadlineConfidence: dl.confidence,
    description: description && description.slice(0, 1500),
    salaryText, salaryMin: nums ? +nums[0] : null, salaryMax: nums ? +nums[nums.length - 1] : null,
    salaryCurrency: salaryText ? (/€|eur/i.test(salaryText) ? 'EUR' : /£|gbp/i.test(salaryText) ? 'GBP' : /chf/i.test(salaryText) ? 'CHF' : /\$|usd/i.test(salaryText) ? 'USD' : null) : null,
    salaryPeriod: salaryText ? (/month|mois|mensuel/i.test(salaryText) ? 'month' : /year|\ban\b|annuel/i.test(salaryText) ? 'year' : /hour|heure/i.test(salaryText) ? 'hour' : null) : null,
    thumbnail: safeHref(raw.thumbnail),
    requisitionIds: reqIds,
    sponsored: !!raw.sponsored,
    targetStatus: ev.status, targetEvidence: { years: ev.years, seasons: ev.seasons },
    retrievedAt: ctx.retrievedAt,
    search: { query: ctx.query || null, location: (ctx.params && ctx.params.location) || null, gl: (ctx.params && ctx.params.gl) || null, hl: (ctx.params && ctx.params.hl) || null, engine, page: ctx.page || 1, target: ctx.target || null },
    sourceCheck: { status: 'not_checked', at: null },
    warnings,
    sourceRecords: [],
    matchLog: [],
    fieldConflicts: {},
  };

  // Source record: lossless provenance for this retrieval of this listing.
  job.sourceRecords.push({
    recordId: job.id, provider, engine, providerJobId, label: sourceLabel,
    listingUrl: shareUrl.safe ? shareUrl.originalUrl : null,
    applyOptions: applyOptions.map((a) => ({ label: a.label, url: a.url })),
    retrievedAt: ctx.retrievedAt, query: ctx.query || null, location: job.search.location, page: ctx.page || 1,
    matchReason: 'original',
  });

  decorate(job);
  return { ok: true, job };
}

/** Recompute warnings that depend on merged values, completeness and relevance. Idempotent. */
export function decorate(job, today = ymd(new Date())) {
  const w = (job.warnings || []).filter((x) => !x.derived);
  const add = (code, severity, text) => w.push({ code, severity, text, derived: true });
  if (!job.deadline && job.deadlineConfidence !== 'rolling_stated') add('deadline_unknown', 'info', 'Deadline not stated.');
  if (job.deadline && job.postedAt && job.deadline < job.postedAt) add('implausible_deadline', 'warn', 'Deadline is earlier than the posting date.');
  if (job.deadline && job.deadline < today) add('deadline_passed', 'warn', 'The stated deadline has passed.');
  if (job.postedAt && job.postedConfidence !== 'unknown' && job.postedAt > today) add('implausible_posted', 'warn', 'Posting date is in the future.');
  if (job.targetStatus && job.targetStatus !== 'confirmed') add('target_' + job.targetStatus, job.targetStatus === 'conflict' ? 'warn' : 'info', TARGET_LABEL[job.targetStatus]);
  if (job.sponsored) add('sponsored', 'warn', 'Marked as sponsored or promoted by the provider.');
  if (/graduates? only|recent graduates?|dipl[oô]m[eé]s/i.test((job.roleTitle || '') + ' ' + (job.description || ''))) add('graduate_only', 'warn', 'Text suggests graduate-only eligibility.');
  if (/full.?time/i.test(job.employmentType || '') && !/intern|stage|apprenti|graduate/i.test((job.roleTitle || '') + ' ' + (job.description || ''))) add('full_time', 'warn', 'Looks like a permanent full-time role, not an internship.');
  job.warnings = w;
  job.completeness = computeCompleteness(job);
  job.relevance = computeRelevance(job);
  return job;
}
