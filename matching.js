// Duplicate detection. All thresholds and rules live in MATCH_RULES / the functions below.
//
// Tiers
//   strong    safe to merge automatically (shared provider job ID on the same platform, or a shared
//             job-specific URL), AND no conflicting evidence.
//   probable  same employer + highly similar title + same city + compatible details, with no IDs
//             that prove otherwise. NEVER merged automatically: shown as "Possible duplicate".
//   none      everything else. Missing data is never treated as equality.
//
// The legacy code merged on any shared key OR a fuzzy score, using a key that collapsed every
// Google Jobs link to "google.com/search". This module replaces it.

import { analyseUrl } from './urlnorm.js';
import { normCompany, normPlace, titleSimilarity } from './text.js';
import { decorate } from './normalize.js';

export const MATCH_RULES = {
  titleSimilarityMin: 0.8,      // Jaccard on normalised title tokens, probable tier only
  postedToleranceDays: 21,      // posted dates are often "3 days ago": allow slack
  requireCityForProbable: true, // unknown city => cannot be probable
  genericTypes: ['Internship'], // compatible with any specific internship type
};

const DAY = 864e5;
const TARGET_RANK = { confirmed: 3, year_only: 2, conflict: 1, not_confirmed: 0 };

export const pairKey = (a, b) => [a, b].sort().join('~');

/** Identity evidence for a job (or merged job): provider IDs per platform + job-specific URL keys. */
export function identityOf(job) {
  const platformIds = {};  // platform -> Set(ids)
  const urlKeys = new Set();
  const recs = job.sourceRecords && job.sourceRecords.length ? job.sourceRecords : null;
  const add = (platform, id) => { if (id) (platformIds[platform] = platformIds[platform] || new Set()).add(String(id)); };
  const addUrl = (u) => { const a = analyseUrl(u); if (a.comparisonKey) urlKeys.add(a.comparisonKey); };
  if (recs) {
    for (const r of recs) {
      add(`${r.provider}:${r.engine}`, r.providerJobId);
      addUrl(r.listingUrl);
      (r.applyOptions || []).forEach((o) => addUrl(o.url));
    }
  } else {
    add(`${job.provider}:${job.engine}`, job.providerJobId);
    if (job.shareUrl && job.shareUrl.comparisonKey) urlKeys.add(job.shareUrl.comparisonKey);
    (job.applyOptions || []).forEach((o) => o.key && urlKeys.add(o.key));
  }
  return { platformIds, urlKeys, reqIds: new Set(job.requisitionIds || []) };
}

const inter = (A, B) => [...A].filter((x) => B.has(x));

/** Conflicting evidence that must block an automatic merge. Returns a reason code or null. */
export function hardConflict(a, b) {
  const ca = a.normalizedCompany, cb = b.normalizedCompany;
  if (ca && cb && ca !== cb) return 'different_employer';
  const ia = identityOf(a), ib = identityOf(b);
  if (ia.reqIds.size && ib.reqIds.size && !inter(ia.reqIds, ib.reqIds).length) return 'different_requisition_id';
  for (const p of Object.keys(ia.platformIds)) {
    if (ib.platformIds[p] && !inter(ia.platformIds[p], ib.platformIds[p]).length) return 'different_provider_job_id';
  }
  return null;
}

const typeCompatible = (a, b) => {
  const x = a.internshipType, y = b.internshipType;
  if (!x || !y || x === 'Not stated' || y === 'Not stated' || x === y) return true;
  return MATCH_RULES.genericTypes.includes(x) || MATCH_RULES.genericTypes.includes(y);
};
const targetCompatible = (a, b) => {
  const A = (a.targetEvidence && a.targetEvidence.years) || [], B = (b.targetEvidence && b.targetEvidence.years) || [];
  return !A.length || !B.length || A.some((y) => B.includes(y));
};
const postedCompatible = (a, b) => {
  if (!a.postedAt || !b.postedAt) return true;
  return Math.abs(new Date(a.postedAt) - new Date(b.postedAt)) / DAY <= MATCH_RULES.postedToleranceDays;
};

/**
 * @returns {{tier:'strong'|'probable'|'none', reason:string, conflicts:string[], evidence:string[]}}
 */
export function classifyPair(a, b) {
  if (a.id && a.id === b.id) return { tier: 'strong', reason: 'exact_repeat', conflicts: [], evidence: ['same record'] };
  const conflict = hardConflict(a, b);
  const ia = identityOf(a), ib = identityOf(b);

  const sharedIds = [];
  for (const p of Object.keys(ia.platformIds)) if (ib.platformIds[p]) sharedIds.push(...inter(ia.platformIds[p], ib.platformIds[p]).map((i) => `${p}#${i}`));
  const sharedUrls = inter(ia.urlKeys, ib.urlKeys);

  if (conflict === 'different_employer') {
    // Same URL/ID but different employers is suspicious (aggregator redirect, reused id): never merge.
    return { tier: 'none', reason: sharedIds.length || sharedUrls.length ? 'identifier_shared_but_employers_differ' : 'different_employer', conflicts: [conflict], evidence: [] };
  }
  if (sharedIds.length) {
    return conflict
      ? { tier: 'probable', reason: 'provider_job_id_with_conflicting_evidence', conflicts: [conflict], evidence: sharedIds }
      : { tier: 'strong', reason: 'provider_job_id', conflicts: [], evidence: sharedIds };
  }
  if (sharedUrls.length) {
    return conflict
      ? { tier: 'probable', reason: 'job_url_with_conflicting_evidence', conflicts: [conflict], evidence: sharedUrls }
      : { tier: 'strong', reason: 'job_url', conflicts: [], evidence: sharedUrls };
  }
  if (conflict) return { tier: 'none', reason: conflict, conflicts: [conflict], evidence: [] };

  // ---- fuzzy: requires explicit evidence on every identity field -------------------------
  if (!a.normalizedCompany || !b.normalizedCompany) return { tier: 'none', reason: 'missing_company', conflicts: [], evidence: [] };
  const sim = titleSimilarity(a.roleTitle, b.roleTitle);
  if (sim < MATCH_RULES.titleSimilarityMin) return { tier: 'none', reason: 'titles_differ', conflicts: [], evidence: [] };
  const ya = (a.roleTitle.match(/\b20\d{2}\b/g) || []).join(), yb = (b.roleTitle.match(/\b20\d{2}\b/g) || []).join();
  if (ya && yb && ya !== yb) return { tier: 'none', reason: 'title_years_differ', conflicts: [], evidence: [] };
  const ca = a.city ? normPlace(a.city) : '', cb = b.city ? normPlace(b.city) : '';
  if (MATCH_RULES.requireCityForProbable && (!ca || !cb)) return { tier: 'none', reason: 'location_unknown', conflicts: [], evidence: [] };
  if (ca !== cb) return { tier: 'none', reason: 'different_city', conflicts: [], evidence: [] };
  if (!typeCompatible(a, b)) return { tier: 'none', reason: 'different_internship_type', conflicts: [], evidence: [] };
  if (!targetCompatible(a, b)) return { tier: 'none', reason: 'different_target_year', conflicts: [], evidence: [] };
  if (!postedCompatible(a, b)) return { tier: 'none', reason: 'posting_dates_far_apart', conflicts: [], evidence: [] };
  return { tier: 'probable', reason: 'same_company_title_city', conflicts: [], evidence: [`title similarity ${sim.toFixed(2)}`] };
}

const REASON_TEXT = {
  exact_repeat: 'Exact repeat of the same record',
  provider_job_id: 'Same provider job ID',
  job_url: 'Same job-specific listing/application URL',
  user_confirmed: 'Merged by you after review',
  user_linked: 'Linked by you',
  original: 'Original source record',
};
export const reasonText = (r) => REASON_TEXT[r] || r;

/**
 * Group raw valid results. Only strong matches merge. Probable matches stay separate rows,
 * flagged for review. A strong match is refused (and surfaced for review) if merging the two
 * groups would put conflicting records together.
 * @param {object[]} jobs normalised jobs
 * @param {{decisions?:Record<string,'merge'|'separate'>}} opts
 */
export function groupResults(jobs, opts = {}) {
  const decisions = opts.decisions || {};
  const n = jobs.length;
  const parent = jobs.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const membersOf = (root) => jobs.filter((_, i) => find(i) === root);
  const reasons = jobs.map(() => []);
  const review = [];  // {i, j, tier, reason, conflicts}

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const key = pairKey(jobs[i].id, jobs[j].id);
      if (decisions[key] === 'separate') continue;
      let c = classifyPair(jobs[i], jobs[j]);
      if (decisions[key] === 'merge') c = { tier: 'strong', reason: 'user_confirmed', conflicts: [], evidence: [] };
      if (c.tier !== 'strong') continue;
      const ri = find(i), rj = find(j);
      if (ri === rj) continue;
      let blocked = null;
      if (c.reason !== 'user_confirmed') {
        for (const x of membersOf(ri)) { for (const y of membersOf(rj)) { blocked = hardConflict(x, y); if (blocked) break; } if (blocked) break; }
      }
      if (blocked) { review.push({ i, j, tier: 'probable', reason: 'strong_match_blocked_by_' + blocked, conflicts: [blocked] }); continue; }
      parent[rj] = ri;
      reasons[ri].push({ a: jobs[i].id, b: jobs[j].id, reason: c.reason, evidence: c.evidence });
    }
  }
  // merge reason lists of absorbed roots
  const rootReasons = {};
  for (let i = 0; i < n; i++) { const r = find(i); (rootReasons[r] = rootReasons[r] || []).push(...reasons[i]); }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (find(i) === find(j)) continue;
      const key = pairKey(jobs[i].id, jobs[j].id);
      if (decisions[key] === 'separate') continue;
      const c = classifyPair(jobs[i], jobs[j]);
      if (c.tier === 'probable') review.push({ i, j, tier: 'probable', reason: c.reason, conflicts: c.conflicts });
    }
  }

  const byRoot = new Map();
  jobs.forEach((j, i) => { const r = find(i); if (!byRoot.has(r)) byRoot.set(r, []); byRoot.get(r).push(j); });
  const groups = [...byRoot.entries()].map(([root, members]) => ({
    id: members[0].id,
    members,
    reasons: rootReasons[root] || [],
    job: members.length === 1 ? members[0] : mergeMembers(members, rootReasons[root] || []),
    possible: [],           // filled below: [{otherGroupId, reason}]
  }));
  const gOf = (idx) => groups.find((g) => g.members.includes(jobs[idx]));
  const seen = new Set();
  for (const r of review) {
    const ga = gOf(r.i), gb = gOf(r.j);
    if (!ga || !gb || ga === gb) continue;
    const k = pairKey(ga.id, gb.id);
    if (seen.has(k)) continue; seen.add(k);
    ga.possible.push({ otherId: gb.id, reason: r.reason, conflicts: r.conflicts });
    gb.possible.push({ otherId: ga.id, reason: r.reason, conflicts: r.conflicts });
  }
  return {
    groups,
    stats: {
      valid: n,
      unique: groups.length,
      confirmedDuplicates: n - groups.length,   // records absorbed into another record
      possibleDuplicates: seen.size,            // pairs of separate rows needing review
    },
  };
}

const fill = (a, b, keys) => keys.forEach((k) => { if ((a[k] == null || a[k] === '') && b[k] != null && b[k] !== '') a[k] = b[k]; });

/** Lossless merge of confirmed duplicates. Source records are kept; conflicting values are recorded. */
export function mergeMembers(members, reasons) {
  const best = [...members].sort((x, y) => (y.completeness?.score || 0) - (x.completeness?.score || 0))[0];
  const out = JSON.parse(JSON.stringify(best));
  out.sourceRecords = JSON.parse(JSON.stringify(best.sourceRecords || []));
  out.fieldConflicts = { ...(best.fieldConflicts || {}) };
  const rsn = (id) => (reasons.find((r) => r.a === id || r.b === id) || {}).reason || 'provider_job_id';

  for (const m of members) {
    if (m === best) continue;
    fill(out, m, ['city', 'country', 'locationText', 'postedText', 'postedAt', 'postedConfidence', 'employmentType', 'function', 'sector', 'remoteType', 'thumbnail', 'sourceLabel', 'sourceVia', 'providerJobId', 'providerJobToken']);
    if (out.internshipType === 'Not stated' && m.internshipType !== 'Not stated') out.internshipType = m.internshipType;
    if (!out.deadline && m.deadline) { out.deadline = m.deadline; out.deadlineText = m.deadlineText; out.deadlineConfidence = m.deadlineConfidence; }
    else if (!out.deadline && out.deadlineConfidence === 'unknown' && m.deadlineText) { out.deadlineText = m.deadlineText; out.deadlineConfidence = m.deadlineConfidence; }
    if ((m.description || '').length > (out.description || '').length) out.description = m.description;
    if (!out.salaryText && m.salaryText) fill(out, m, ['salaryText', 'salaryMin', 'salaryMax', 'salaryCurrency', 'salaryPeriod']);
    if (!(out.shareUrl && out.shareUrl.safe) && m.shareUrl && m.shareUrl.safe) out.shareUrl = m.shareUrl;
    const have = new Set(out.applyOptions.map((a) => a.url));
    (m.applyOptions || []).forEach((a) => { if (!have.has(a.url)) { out.applyOptions.push(a); have.add(a.url); } });
    out.requisitionIds = [...new Set([...(out.requisitionIds || []), ...(m.requisitionIds || [])])];
    out.sponsored = out.sponsored && m.sponsored;
    if ((TARGET_RANK[m.targetStatus] || 0) > (TARGET_RANK[out.targetStatus] || 0)) out.targetStatus = m.targetStatus;
    out.targetEvidence = { years: [...new Set([...(out.targetEvidence?.years || []), ...(m.targetEvidence?.years || [])])].sort(), seasons: [...new Set([...(out.targetEvidence?.seasons || []), ...(m.targetEvidence?.seasons || [])])] };
    const seenW = new Set(out.warnings.map((w) => w.code));
    (m.warnings || []).filter((w) => !w.derived && !seenW.has(w.code)).forEach((w) => out.warnings.push(w));
    if (m.retrievedAt > out.retrievedAt) out.retrievedAt = m.retrievedAt;
    for (const r of m.sourceRecords || []) out.sourceRecords.push({ ...r, matchReason: rsn(m.id), matchedTo: best.id });
    for (const f of ['roleTitle', 'locationText', 'postedText']) {
      if (m[f] && best[f] && String(m[f]).toLowerCase() !== String(best[f]).toLowerCase()) {
        const arr = (out.fieldConflicts[f] = out.fieldConflicts[f] || [{ value: best[f], recordId: best.id }]);
        if (!arr.some((x) => x.value === m[f])) arr.push({ value: m[f], recordId: m.id });
      }
    }
  }
  out.matchLog = reasons;
  out.mergedFrom = members.map((m) => m.id);
  return decorate(out);
}

/**
 * Match a freshly retrieved job against the user's tracked opportunities.
 * Manual entries can only ever be "probable": they have no provider identifiers.
 * @returns {{tier:'strong'|'probable'|'none', opp?:object, reason?:string}}
 */
export function matchTracked(job, opps) {
  let best = { tier: 'none' };
  for (const o of opps) {
    if (o.arch && !o.live) continue;
    const cand = o.live && o.x ? o.x : manualPseudoJob(o);
    const c = classifyPair(job, cand);
    if (c.tier === 'strong') return { tier: 'strong', opp: o, reason: c.reason };
    if (c.tier === 'probable' && best.tier === 'none') best = { tier: 'probable', opp: o, reason: c.reason };
  }
  return best;
}

function manualPseudoJob(o) {
  const city = o.city && o.city !== 'Not stated' ? o.city : null;
  return {
    id: 'manual:' + o.id, provider: 'manual', engine: 'manual', providerJobId: null,
    companyName: o.co, normalizedCompany: normCompany(o.co), roleTitle: o.role || '', city,
    internshipType: null, requisitionIds: [], postedAt: null, targetEvidence: { years: [] },
    shareUrl: null, applyOptions: [], sourceRecords: [],
  };
}
