// Static reference data used by the planner and the normaliser. Nothing here is job data.

export const CITIES = [
  { id: 'paris', city: 'Paris', country: 'France', location: 'Paris, France', gl: 'fr', langs: ['en', 'fr'] },
  { id: 'london', city: 'London', country: 'United Kingdom', location: 'London, United Kingdom', gl: 'uk', langs: ['en'] },
  { id: 'frankfurt', city: 'Frankfurt', country: 'Germany', location: 'Frankfurt, Germany', gl: 'de', langs: ['en'] },
  { id: 'amsterdam', city: 'Amsterdam', country: 'Netherlands', location: 'Amsterdam, Netherlands', gl: 'nl', langs: ['en'] },
  { id: 'zurich', city: 'Zurich', country: 'Switzerland', location: 'Zurich, Switzerland', gl: 'ch', langs: ['en'] },
  { id: 'geneva', city: 'Geneva', country: 'Switzerland', location: 'Geneva, Switzerland', gl: 'ch', langs: ['en', 'fr'] },
  { id: 'luxembourg', city: 'Luxembourg', country: 'Luxembourg', location: 'Luxembourg', gl: 'lu', langs: ['en'] },
  { id: 'milan', city: 'Milan', country: 'Italy', location: 'Milan, Italy', gl: 'it', langs: ['en'] },
  { id: 'madrid', city: 'Madrid', country: 'Spain', location: 'Madrid, Spain', gl: 'es', langs: ['en'] },
  { id: 'dublin', city: 'Dublin', country: 'Ireland', location: 'Dublin, Ireland', gl: 'ie', langs: ['en'] },
  { id: 'brussels', city: 'Brussels', country: 'Belgium', location: 'Brussels, Belgium', gl: 'be', langs: ['en', 'fr'] },
];

export const COUNTRIES = [
  'France', 'United Kingdom', 'Germany', 'Netherlands', 'Switzerland', 'Luxembourg', 'Spain', 'Italy', 'Belgium', 'Ireland',
];

/** Country names as providers sometimes return them → canonical name. */
export const COUNTRY_ALIASES = {
  uk: 'United Kingdom', 'royaume-uni': 'United Kingdom', allemagne: 'Germany', 'pays-bas': 'Netherlands',
  suisse: 'Switzerland', espagne: 'Spain', italie: 'Italy', belgique: 'Belgium', irlande: 'Ireland',
};

export const ROLE_FAMILIES = [
  { id: 'ib', label: 'Investment banking / M&A', en: 'investment banking analyst', fr: 'analyste banque d’investissement' },
  { id: 'pe', label: 'Private equity / venture', en: 'private equity', fr: 'private equity' },
  { id: 'am', label: 'Asset management', en: 'asset management', fr: 'gestion d’actifs' },
  { id: 'er', label: 'Equity research', en: 'equity research', fr: 'analyste recherche actions' },
  { id: 'st', label: 'Sales & trading / markets', en: 'sales and trading', fr: 'marchés financiers' },
  { id: 'cf', label: 'Corporate finance', en: 'corporate finance', fr: 'finance d’entreprise' },
];

export const SEASONS = {
  spring: { en: 'spring', fr: 'printemps', startMonth: 2, endMonth: 4 },   // Mar–May
  summer: { en: 'summer', fr: 'été', startMonth: 5, endMonth: 7 },         // Jun–Aug
  autumn: { en: 'autumn', fr: 'automne', startMonth: 8, endMonth: 10 },    // Sep–Nov
  winter: { en: 'winter', fr: 'hiver', startMonth: 11, endMonth: 1 },      // Dec–Feb
  any: { en: '', fr: '', startMonth: 0, endMonth: 11 },
};

export const SEASON_WORDS = {
  spring: /\b(spring|printemps)\b/i,
  summer: /\b(summer|ete|été)\b/i,
  autumn: /\b(autumn|fall|automne)\b/i,
  winter: /\b(winter|hiver)\b/i,
};
