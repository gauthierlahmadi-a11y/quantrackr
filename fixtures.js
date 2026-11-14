// Deterministic, provider-shaped fixtures. TEST-ONLY: nothing here is ever imported by the app.
// Shapes follow SerpApi's documented Google Jobs response (share_link with htidocid in both the
// query string and the fragment; apply_options; job_id) after the proxy's mapping step.

export const RETRIEVED = '2026-11-13T10:00:00.000Z';
export const TARGET = { year: 2027, season: 'summer' };
export const CTX = { provider: 'serpapi', engine: 'google_jobs', retrievedAt: RETRIEVED, query: 'finance internship Paris', params: { location: 'Paris, France', gl: 'fr', hl: 'en' }, target: TARGET };

export const docid = (n) => `FIXTURE${String(n).padStart(4, '0')}AAAAAA==`;

export function googleShare(id, q = 'finance internship paris') {
  const enc = encodeURIComponent(id);
  return `https://www.google.com/search?ibp=htl;jobs&q=${encodeURIComponent(q)}&htidocid=${enc}&hl=en-US&shndl=-1&shem=vslcca&source=sh/x/job/li/m1/1#fpstate=tldetail&htivrt=jobs&htiq=${encodeURIComponent(q)}&htidocid=${enc}`;
}

/** Wire-shape record as returned by /api/jobs/search. */
export function wire(o = {}) {
  const n = o.n ?? 1;
  const id = o.docid === undefined ? docid(n) : o.docid;      // pass docid:null for "missing provider id"
  return {
    providerJobId: id,
    providerJobToken: id ? 'tok-' + id : null,
    title: o.title ?? `Finance Intern ${n}`,
    company: o.company ?? `Company ${n}`,
    location: o.location ?? 'Paris, France',
    via: o.via ?? 'via LinkedIn',
    description: o.description ?? 'Join our team for a summer internship starting in June 2027.',
    postedText: o.postedText ?? '3 days ago',
    scheduleType: o.scheduleType ?? 'Internship',
    salaryText: o.salaryText ?? null,
    shareLink: o.shareLink === undefined ? (id ? googleShare(id) : null) : o.shareLink,
    sourceLink: null,
    applyOptions: o.applyOptions ?? [{ title: 'LinkedIn', link: `https://www.linkedin.com/jobs/view/${400000000 + n}/?utm_source=google_jobs_apply&utm_medium=organic` }],
    extensions: o.extensions ?? [],
    thumbnail: null,
    sponsored: !!o.sponsored,
  };
}
