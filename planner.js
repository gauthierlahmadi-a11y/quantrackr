// Budget-aware query planner.
//
// The planner never runs anything. It turns the user's choices into an explicit list of provider
// searches, says how many may be sent, and how many are expected to be served from the local cache.
// Estimates are ESTIMATES: SerpApi's own accounting (successful searches count; cached, errored and
// failed ones do not, per its documentation) is the authority, and its cache lasts about one hour.

import { CITIES, ROLE_FAMILIES, SEASONS } from './catalog.js';
import { hashStr } from './text.js';

export const LIMITS = { maxSearchesCap: 40, maxQueryLength: 200 };

export const DEFAULT_SETTINGS = {
  preset: 'paris',
  year: null,                 // filled from the stored target; never silently changed
  season: 'summer',
  cities: [],                 // ids from CITIES, used by "cities" and "expanded"
  families: ['ib', 'pe', 'am'],
  language: 'both',           // 'en' | 'fr' | 'both'
  custom: { q: '', location: 'Paris, France', gl: 'fr', hl: 'en' },
  maxSearches: 4,
  useCache: true,
  allowPages: false,
  extraPages: 2,
  postedWithinDays: '',       // local filter only; see README (Google's chips filter is deprecated)
  engine: 'google_jobs',
  expandedConfirmed: false,
};

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(+n) ? Math.floor(+n) : lo));

/** Season window end for a given year (inclusive, local time). Winter belongs to the year it starts in. */
export function seasonEnd(year, season) {
  const s = SEASONS[season];
  if (!s || season === 'any') return new Date(year, 11, 31, 23, 59, 59);
  if (season === 'winter') return new Date(year + 1, 2, 0, 23, 59, 59);   // last day of February
  return new Date(year, s.endMonth + 1, 0, 23, 59, 59);
}
export function seasonStart(year, season) {
  const s = SEASONS[season];
  if (!s || season === 'any') return new Date(year, 0, 1);
  return new Date(year, s.startMonth, 1);
}

/** @returns {'passed'|'in_progress'|'upcoming'} relative to `today`. */
export function seasonStatus(year, season, today = new Date()) {
  if (seasonEnd(year, season) < today) return 'passed';
  if (seasonStart(year, season) <= today) return 'in_progress';
  return 'upcoming';
}

/** The next cycle that has not ended yet (same season). Returns null if the target is not past. */
export function suggestTarget(target, today = new Date()) {
  if (!target || !target.year || seasonStatus(target.year, target.season, today) !== 'passed') return null;
  let y = target.year;
  while (seasonStatus(y, target.season, today) === 'passed') y++;
  return { year: y, season: target.season };
}

const seasonWord = (season, lang) => (SEASONS[season] ? SEASONS[season][lang] : '');
const join = (...p) => p.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
const cityById = (id) => CITIES.find((c) => c.id === id);
const familyById = (id) => ROLE_FAMILIES.find((f) => f.id === id);

export function cacheKeyFor(params, pageToken) {
  const p = params || {};
  return 'q' + hashStr(JSON.stringify([p.engine || 'google_jobs', String(p.q || '').toLowerCase(), String(p.location || '').toLowerCase(), p.gl || '', p.hl || '', pageToken || '']));
}

function mkQuery(label, q, loc, hl, engine) {
  const params = { engine, q: q.slice(0, LIMITS.maxQueryLength), location: loc.location, gl: loc.gl, hl };
  return { id: 'pq' + hashStr(JSON.stringify(params)), label, params, cacheKey: cacheKeyFor(params) };
}

/** Pure: settings -> list of provider queries (no budget applied yet). */
export function expandQueries(settings) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const engine = s.engine === 'indeed_jobs' ? 'indeed_jobs' : 'google_jobs';
  const yr = s.year ? String(s.year) : '';
  const wantEn = s.language === 'en' || s.language === 'both';
  const wantFr = s.language === 'fr' || s.language === 'both';
  const out = [];
  const paris = cityById('paris');

  const parisQueries = () => {
    if (wantEn) out.push(mkQuery('Paris · finance internship (EN)', join('finance internship Paris', seasonWord(s.season, 'en'), yr), paris, 'en', engine));
    if (wantFr) out.push(mkQuery('Paris · stage finance (FR)', join('stage finance Paris', seasonWord(s.season, 'fr'), yr), paris, 'fr', engine));
    const fams = s.families.map(familyById).filter(Boolean);
    if (fams.length) out.push(mkQuery(`Paris · ${fams.map((f) => f.id.toUpperCase()).join('/')} roles (EN)`, join(fams.slice(0, 3).map((f) => f.en).join(' '), 'internship Paris', yr), paris, 'en', engine));
  };

  if (s.preset === 'paris') parisQueries();
  else if (s.preset === 'cities') {
    for (const id of s.cities) {
      const c = cityById(id); if (!c) continue;
      if (wantEn) out.push(mkQuery(`${c.city} · finance internship (EN)`, join('finance internship', c.city, seasonWord(s.season, 'en'), yr), c, 'en', engine));
      if (wantFr && c.langs.includes('fr')) out.push(mkQuery(`${c.city} · stage finance (FR)`, join('stage finance', c.city, seasonWord(s.season, 'fr'), yr), c, 'fr', engine));
    }
  } else if (s.preset === 'custom') {
    const c = s.custom || {}; const q = String(c.q || '').trim();
    if (q) out.push(mkQuery('Custom search', q, { location: String(c.location || '').trim().slice(0, 100), gl: /^[a-z]{2}$/.test(c.gl || '') ? c.gl : '' }, /^[a-z]{2,3}(-[a-z]{2})?$/i.test(c.hl || '') ? c.hl : 'en', engine));
  } else if (s.preset === 'expanded') {
    parisQueries();
    for (const f of s.families.map(familyById).filter(Boolean)) {
      if (wantEn) out.push(mkQuery(`Paris · ${f.label} (EN)`, join(f.en, 'internship Paris', seasonWord(s.season, 'en'), yr), paris, 'en', engine));
      if (wantFr) out.push(mkQuery(`Paris · ${f.label} (FR)`, join('stage', f.fr, 'Paris', yr), paris, 'fr', engine));
    }
    for (const id of s.cities) {
      const c = cityById(id); if (!c || c.id === 'paris') continue;
      if (wantEn) out.push(mkQuery(`${c.city} · finance internship (EN)`, join('finance internship', c.city, seasonWord(s.season, 'en'), yr), c, 'en', engine));
    }
  }
  const seen = new Set();
  return out.filter((q) => (seen.has(q.id) ? false : seen.add(q.id)));
}

/**
 * @param {object} settings
 * @param {{peek:(key:string)=>{at:string}|null, ttlHours:number}} cacheView
 */
export function buildPlan(settings, cacheView, now = new Date()) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const maxSearches = clamp(s.maxSearches, 1, LIMITS.maxSearchesCap);
  const all = expandQueries(s);
  const ttlMs = (cacheView?.ttlHours ?? 12) * 36e5;
  const warnings = [];
  let budget = maxSearches, cached = 0, willRun = 0, over = 0, stale = 0;

  const queries = all.map((q) => {
    const hit = cacheView && cacheView.peek ? cacheView.peek(q.cacheKey) : null;
    const age = hit ? now - new Date(hit.at) : null;
    const cacheState = !hit ? 'none' : age < ttlMs ? 'fresh' : 'stale';
    if (cacheState === 'stale') stale++;
    let state;
    if (s.useCache && cacheState === 'fresh') { state = 'cached'; cached++; }
    else if (budget > 0) { state = 'will_run'; budget--; willRun++; }
    else { state = 'over_budget'; over++; }
    return { ...q, cacheState, state };
  });

  if (!all.length) warnings.push(s.preset === 'cities' ? 'Choose at least one city.' : s.preset === 'custom' ? 'Enter a query to search.' : 'No queries to run.');
  if (over) warnings.push(`${over} planned search(es) exceed your budget of ${maxSearches} and will not be sent.`);
  if (stale && s.useCache) warnings.push(`${stale} cached result set(s) are older than ${cacheView.ttlHours} h and will not be treated as current.`);
  if (s.preset === 'expanded' && !s.expandedConfirmed) warnings.push('Expanded search sends many searches. Confirm the maximum below to enable it.');

  const extraPageLimit = s.allowPages ? Math.max(0, Math.min(clamp(s.extraPages, 0, 20), maxSearches - willRun)) : 0;
  return {
    settings: { ...s, maxSearches },
    queries,
    counts: { planned: all.length, willRun, cachedExpected: cached, overBudget: over },
    maxFirstPageRequests: willRun,
    extraPageLimit,
    estimatedMaxNewSearches: willRun + extraPageLimit,
    canStart: willRun + cached > 0 && !(s.preset === 'expanded' && !s.expandedConfirmed),
    warnings,
    note: 'Estimate only, not a billing guarantee. SerpApi decides what counts: successful searches count; cached, errored and failed searches do not.',
  };
}
