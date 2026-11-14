// Versioned, non-destructive storage helpers: migration, backup, separate search cache,
// suspicious-source detection, detach/attach. `storage` is any localStorage-like object.

import { analyseUrl } from './urlnorm.js';
import { computeCompleteness } from './normalize.js';
import { normCompany } from './text.js';

export const SCHEMA_VERSION = 3;
export const KEYS = { data: 'ventureTrack.v2', backup: 'ventureTrack.backup.', cache: 'ventureTrack.searchCache.v1' };

/** User-owned fields. Nothing in this module may overwrite or drop these. */
export const USER_FIELDS = ['status', 'notes', 'contacts', 'checklist', 'reminders', 'docs', 'fav', 'custom', 'activity', 'edited', 'priority', 'arch', 'chk', 'conflicts', 'next', 'appliedAt', 'sal', 'dl', 'added'];

const safeJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

export function backupBeforeMigration(storage, raw, stamp = new Date().toISOString()) {
  if (!raw) return null;
  const key = KEYS.backup + stamp.replace(/[^0-9]/g, '').slice(0, 14);
  try { storage.setItem(key, raw); return key; } catch { return null; }   // quota: continue, the export button remains
}

/** Legacy source list -> source records. Flags are computed separately; nothing is dropped. */
function legacySources(x) {
  return (x.sources || []).map((s, i) => ({
    recordId: 'legacy' + i, provider: 'serpapi', engine: (x.engine || 'google_jobs'), providerJobId: null,
    label: s.label || s.via || null, listingUrl: s.url || null,
    applyOptions: s.applyUrl ? [{ label: s.label || null, url: s.applyUrl }] : [],
    retrievedAt: x.retrievedAt || x.lastCheckedAt || null, query: x.searchQuery || null, location: null, page: 1,
    matchReason: 'legacy_unverified', legacy: true,
  }));
}

/** Flag (never change) records whose attached sources look like unrelated jobs. */
export function reviewSources(x) {
  const recs = (x && x.sourceRecords) || [];
  const reasons = [];
  const keys = recs.flatMap((r) => [r.listingUrl, ...(r.applyOptions || []).map((o) => o.url)].map((u) => analyseUrl(u)));
  const googleIds = new Set(keys.filter((k) => k.provider === 'google' && k.jobId).map((k) => k.jobId));
  if (googleIds.size > 1) reasons.push('Several different Google Jobs listings are attached to this one record.');
  const specific = new Set(keys.filter((k) => k.comparisonKey && k.provider !== 'google').map((k) => k.comparisonKey));
  const hostPaths = new Map();
  for (const k of keys) if (k.safe) { const u = new URL(k.originalUrl); const hp = u.hostname + u.pathname; if (!hostPaths.has(hp)) hostPaths.set(hp, new Set()); hostPaths.get(hp).add(u.search + u.hash); }
  if ([...hostPaths.values()].some((v) => v.size > 1) && !googleIds.size) reasons.push('Links share a path but differ in query or fragment, so they may be different jobs.');
  if (specific.size > 1 && new Set(keys.filter((k) => k.comparisonKey).map((k) => k.provider)).size === 1) reasons.push('Several different job IDs from the same site are attached.');
  const labels = new Set(recs.map((r) => (r.label || '').toLowerCase()).filter(Boolean));
  if (recs.length >= 4 || labels.size >= 4) reasons.push(`${recs.length} sources / ${labels.size} source names are attached (unusually many for one job).`);
  return { suspicious: reasons.length > 0, reasons, checkedAt: new Date().toISOString() };
}

/** Convert one legacy opportunity without losing anything. Idempotent. */
export function migrateOpp(o) {
  if (!o || typeof o !== 'object') return null;
  const out = { ...o };
  if (out.x && typeof out.x === 'object') {
    const x = { ...out.x };
    if (!Array.isArray(x.sourceRecords)) x.sourceRecords = legacySources(x);
    if (!x.legacy && (x.sourceVerificationStatus || x.freshnessStatus)) x.legacy = { sourceVerificationStatus: x.sourceVerificationStatus || null, freshnessStatus: x.freshnessStatus || null };
    if (!x.normalizedCompany) x.normalizedCompany = normCompany(x.companyName || '');
    x.provider = x.provider || 'serpapi'; x.engine = x.engine || (x.params && x.params.source === 'indeed_jobs' ? 'indeed_jobs' : 'google_jobs');
    x.sourceCheck = x.sourceCheck || { status: 'not_checked', at: null };   // legacy "verified" was a retrieval, not a check
    if (!x.completeness) x.completeness = computeCompleteness({ companyName: x.companyName, roleTitle: x.roleTitle, locationText: x.location, city: x.city, description: x.description, shareUrl: { safe: !!x.canonicalUrl }, applyOptions: (x.sources || []).filter((s) => s.applyUrl), postedAt: x.postedDate, internshipType: x.internshipType, deadline: x.deadline, sourceLabel: (x.sources || [])[0] && x.sources[0].label });
    out.x = x;
    out.srcReview = out.srcReview && out.srcReview.checkedAt ? out.srcReview : reviewSources(x);
  }
  if (out.gone === true && !out.notReturned) out.notReturned = { at: (out.x && out.x.lastCheckedAt) || null };   // was "Listing no longer found"
  out.detachedSources = Array.isArray(out.detachedSources) ? out.detachedSources : [];
  return out;
}

/**
 * @returns {{data:object, backupKey:string|null, migrated:boolean, skipped:number}}
 * Idempotent: running it on an already-migrated store returns an equal store.
 */
export function loadAndMigrate(storage) {
  const raw = storage.getItem(KEYS.data);
  const parsed = raw ? safeJson(raw, null) : null;
  if (!parsed || typeof parsed !== 'object') return { data: null, backupKey: null, migrated: false, skipped: 0 };
  if (parsed.schema >= SCHEMA_VERSION) return { data: parsed, backupKey: null, migrated: false, skipped: 0 };
  const backupKey = backupBeforeMigration(storage, raw);
  const { data, skipped } = migrateData(parsed, storage);
  return { data, backupKey, migrated: true, skipped };
}

/** Core migration, also used for imported export files. Never drops user data; skips only unreadable records. */
export function migrateData(parsed, storage = null) {
  let skipped = 0;
  const opps = (Array.isArray(parsed.opps) ? parsed.opps : []).map((o) => { const m = migrateOpp(o); if (!m) skipped++; return m; }).filter(Boolean);
  const data = { ...parsed, opps, schema: SCHEMA_VERSION };
  if (parsed.cache) {                                      // legacy cache lived inside the user store: move it
    if (storage) moveLegacyCache(storage, parsed.cache);
    delete data.cache;
  }
  data.p = { ...(parsed.p || {}) };
  data.p.target = data.p.target || { year: 2026, season: 'summer' };   // the app's previous implicit target, kept as the user's choice
  data.sync = parsed.sync && typeof parsed.sync === 'object' ? parsed.sync : {};
  ['docs', 'reminders', 'acts', 'searches'].forEach((k) => { data[k] = Array.isArray(parsed[k]) ? parsed[k] : []; });
  data.dupDecisions = data.dupDecisions && typeof data.dupDecisions === 'object' ? data.dupDecisions : {};
  return { data, skipped };
}

function moveLegacyCache(storage, legacy) {
  const store = readCacheStore(storage);
  for (const [k, v] of Object.entries(legacy || {})) {
    if (!v || !Array.isArray(v.xs)) continue;
    store.legacy = store.legacy || {};
    store.legacy[k] = { at: v.ts ? new Date(v.ts).toISOString() : null, jobs: v.xs };   // old normalised shape, kept for recovery only
  }
  writeCacheStore(storage, store);
}

// ---- search cache (separate key; clearing it never touches applications) ----------------
export function readCacheStore(storage) { return safeJson(storage.getItem(KEYS.cache), null) || { v: 1, entries: {} }; }
export function writeCacheStore(storage, s) { try { storage.setItem(KEYS.cache, JSON.stringify(s)); return true; } catch { return false; } }

export function createCache(storage, { ttlHours = 12, maxEntries = 30 } = {}) {
  let store = readCacheStore(storage);
  store.entries = store.entries || {};
  return {
    ttlHours,
    get: (k) => store.entries[k] || null,
    peek: (k) => store.entries[k] || null,
    set(k, v) {
      store.entries[k] = v;
      const keys = Object.keys(store.entries).sort((a, b) => store.entries[a].at < store.entries[b].at ? 1 : -1);
      keys.slice(maxEntries).forEach((x) => delete store.entries[x]);
      while (!writeCacheStore(storage, store) && Object.keys(store.entries).length > 1) {   // quota: drop oldest until it fits
        const oldest = Object.keys(store.entries).sort((a, b) => store.entries[a].at > store.entries[b].at ? 1 : -1)[0];
        if (oldest === k) break; delete store.entries[oldest];
      }
    },
    clear() { store = { v: 1, entries: {}, legacy: store.legacy }; writeCacheStore(storage, store); },
  };
}
export function clearSearchCache(storage) { try { storage.removeItem(KEYS.cache); return true; } catch { return false; } }

// ---- tracked-application operations (non-destructive) ------------------------------------
/** Attach a confirmed/linked listing to a tracked application. User-owned fields are never touched. */
export function attachListing(opp, job, reason) {
  const out = { ...opp };
  const x = out.x ? { ...out.x } : null;
  const incoming = (job.sourceRecords || []).map((r) => ({ ...r, matchReason: reason }));
  if (!x) { out.x = { ...job, sourceRecords: incoming }; out.live = true; return out; }
  const have = new Set((x.sourceRecords || []).map((r) => r.recordId));
  x.sourceRecords = [...(x.sourceRecords || []), ...incoming.filter((r) => !have.has(r.recordId))];
  x.retrievedAt = job.retrievedAt > (x.retrievedAt || '') ? job.retrievedAt : x.retrievedAt;
  const have2 = new Set((x.applyOptions || []).map((a) => a.url));
  x.applyOptions = [...(x.applyOptions || []), ...(job.applyOptions || []).filter((a) => !have2.has(a.url))];
  out.x = x;
  out.srcReview = reviewSources(x);
  return out;
}

/** Move chosen sources off a record into `detachedSources` (kept, restorable). Needs explicit confirmation upstream. */
export function detachSources(opp, recordIds) {
  const ids = new Set(recordIds);
  const x = { ...opp.x };
  const gone = (x.sourceRecords || []).filter((r) => ids.has(r.recordId));
  x.sourceRecords = (x.sourceRecords || []).filter((r) => !ids.has(r.recordId));
  const out = { ...opp, x, detachedSources: [...(opp.detachedSources || []), ...gone.map((r) => ({ ...r, detachedAt: new Date().toISOString() }))] };
  out.srcReview = reviewSources(x);
  return out;
}
