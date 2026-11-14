// Small text helpers shared by the data layer. Pure functions, no DOM access,
// so they run identically in the browser and in Node tests.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** Strip tags/entities without a DOM. Output is always escaped again before it is rendered. */
export function cleanText(value) {
  if (value == null) return null;
  const t = String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#?\w+);/g, (m, e) => (e in ENTITIES ? ENTITIES[e] : m))
    .replace(/\s+/g, ' ')
    .trim();
  return t || null;
}

const GENDER_TOKENS = new Set(['h', 'f', 'm', 'w', 'd', 'x']);

const baseNorm = (s) =>
  String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // keep short ampersand abbreviations (M&A, P&L, FP&A) as one token instead of "m and a"
    .replace(/\b(\w{1,2})&(\w{1,2})\b/g, '$1$2')
    .replace(/&/g, ' and ');

/** Company-name normalisation (legal suffixes removed). */
export function normCompany(s) {
  return baseNorm(s)
    .replace(/\b(j p morgan|jp morgan|jpmorgan chase)\b/g, 'jpmorgan')
    .replace(/\b(sa|sas|ltd|plc|gmbh|ag|inc|llc|nv|bv|group|groupe|co|corp|corporation|limited)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Title normalisation: language variants unified, gender markers like (H/F) dropped. */
export function normTitle(s) {
  return baseNorm(s)
    .replace(/\b(internship|stagiaire|stage|praktikum|praktikant)\b/g, 'intern')
    .replace(/\bib\b/g, 'investment banking')
    .replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter((t) => t && !GENDER_TOKENS.has(t)).join(' ');
}

export function normPlace(s) {
  return baseNorm(s)
    .replace(/\b\d{1,2}(er|e|eme|th|st|nd|rd)?\b/g, ' ') // arrondissements, postcodes
    .replace(/\barrondissement\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'et', 'de', 'du', 'des', 'la', 'le', 'les', 'in', 'at', 'for', 'to', 'en', 'pour']);

export function titleTokens(s) {
  return new Set(normTitle(s).split(' ').filter((t) => t && !STOP.has(t)));
}

/** Jaccard similarity of title tokens, 0..1. Empty titles never match. */
export function titleSimilarity(a, b) {
  const A = titleTokens(a), B = titleTokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / new Set([...A, ...B]).size;
}

export function hashStr(s) {
  let h = 5381;
  for (const c of String(s)) h = (h * 33 ^ c.charCodeAt(0)) >>> 0;
  return h.toString(36);
}

export const ymd = (d) =>
  d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
