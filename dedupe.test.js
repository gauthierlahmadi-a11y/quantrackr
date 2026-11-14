import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProviderJob } from '../public/lib/normalize.js';
import { groupResults, classifyPair, matchTracked } from '../public/lib/matching.js';
import { wire, docid, googleShare, CTX } from './fixtures.js';

const norm = (o, ctx = CTX) => { const r = normalizeProviderJob(wire(o), ctx); assert.ok(r.ok, r.reason); return r.job; };
const group = (list, opts) => groupResults(list.map((o) => (o.id ? o : norm(o))), opts);

test('REGRESSION: 23 distinct Google Jobs results stay 23 separate rows', () => {
  const jobs = Array.from({ length: 23 }, (_, i) => norm({ n: i + 1, via: ['via LinkedIn', 'via Indeed', 'via Welcome to the Jungle', 'via Bright Network'][i % 4] }));
  const g = groupResults(jobs);
  assert.equal(g.groups.length, 23);
  assert.equal(g.stats.confirmedDuplicates, 0);
  assert.equal(g.stats.possibleDuplicates, 0);
  for (const grp of g.groups) assert.equal(grp.job.sourceRecords.length, 1, 'no unrelated sources attached');
});

test('distinct jobs sharing hostname+path but with different job-id query parameters stay separate', () => {
  const mk = (n, company) => norm({ n, company, docid: null, via: 'via Company site', shareLink: `https://careers.example.com/jobs?jobId=${n}00`, applyOptions: [] });
  const g = groupResults([mk(1, 'Alpha Capital'), mk(2, 'Beta Partners')]);
  assert.equal(g.groups.length, 2);
});

test('jobs that differ only in a meaningful URL fragment stay separate', () => {
  const mk = (n) => norm({ n, company: 'Same Bank', title: `Analyst ${n}`, docid: null, shareLink: `https://careers.samebank.com/openings#job=${n}11`, applyOptions: [] });
  assert.equal(groupResults([mk(1), mk(2)]).groups.length, 2);
});

test('a generic careers landing page shared by several roles creates no match', () => {
  const mk = (n, title) => norm({ n, company: 'Big Bank', title, docid: null, location: 'Paris, France', shareLink: null, applyOptions: [{ title: 'Company', link: 'https://careers.bigbank.com/careers' }] });
  const g = groupResults([mk(1, 'M&A Intern'), mk(2, 'Equity Research Intern'), mk(3, 'Private Equity Intern')]);
  assert.equal(g.groups.length, 3);
  assert.equal(g.stats.possibleDuplicates, 0);
});

test('exact same provider job id (same provider+engine) merges, with reason', () => {
  const a = norm({ n: 5, via: 'via LinkedIn' }), b = norm({ n: 5, via: 'via Indeed', postedText: '5 days ago' });
  a.id = 'rec-a'; b.id = 'rec-b';
  const g = groupResults([a, b]);
  assert.equal(g.groups.length, 1);
  assert.equal(g.groups[0].reasons[0].reason, 'provider_job_id');
  assert.equal(g.stats.confirmedDuplicates, 1);
});

test('exact repeat of the same record merges (page repeated)', () => {
  const a = norm({ n: 7 }), b = norm({ n: 7 });
  assert.equal(a.id, b.id);
  const g = groupResults([a, b]);
  assert.equal(g.groups.length, 1);
  assert.equal(g.groups[0].reasons[0].reason, 'exact_repeat');
});

test('missing provider ids never match each other (and no "p:null" style keys)', () => {
  const a = norm({ n: 1, docid: null, company: 'Acme', title: 'Credit Analyst Intern', shareLink: null, applyOptions: [], location: 'Lyon, France' });
  const b = norm({ n: 2, docid: null, company: 'Acme', title: 'Treasury Intern', shareLink: null, applyOptions: [], location: 'Lyon, France' });
  const c = classifyPair(a, b);
  assert.equal(c.tier, 'none');
  assert.equal(groupResults([a, b]).groups.length, 2);
});

test('provider ids from different providers do not automatically match', () => {
  const a = norm({ n: 1, docid: 'SHARED-ID-123', company: 'Acme', title: 'Analyst Intern', shareLink: null, applyOptions: [] });
  const b = norm({ n: 1, docid: 'SHARED-ID-123', company: 'Acme', title: 'Completely Different Role', shareLink: null, applyOptions: [], location: 'Lyon, France' }, { ...CTX, engine: 'indeed_jobs' });
  assert.equal(classifyPair(a, b).tier, 'none');
  assert.equal(groupResults([a, b]).groups.length, 2);
});

test('same employer and city but different roles remain separate', () => {
  const a = norm({ n: 1, company: 'Acme', title: 'M&A Summer Analyst', docid: 'A1' });
  const b = norm({ n: 2, company: 'Acme', title: 'Equity Research Summer Analyst', docid: 'A2' });
  const g = groupResults([a, b]);
  assert.equal(g.groups.length, 2);
  assert.equal(g.stats.possibleDuplicates, 0);
});

test('same employer and role in two different cities remain separate', () => {
  const a = norm({ n: 1, company: 'Acme', title: 'Finance Intern', location: 'Paris, France', docid: null, shareLink: null, applyOptions: [] });
  const b = norm({ n: 2, company: 'Acme', title: 'Finance Intern', location: 'London, United Kingdom', docid: null, shareLink: null, applyOptions: [] });
  const g = groupResults([a, b]);
  assert.equal(g.groups.length, 2);
  assert.equal(g.stats.possibleDuplicates, 0);
});

test('same title and company but different requisition ids are not duplicates', () => {
  const mk = (req) => norm({ company: 'Acme', title: 'Finance Intern', docid: null, shareLink: null, applyOptions: [], description: `Summer 2027 internship. Requisition ID: ${req}` });
  const g = groupResults([mk('REQ-10001'), mk('REQ-20002')]);
  assert.equal(g.groups.length, 2);
  assert.equal(g.stats.possibleDuplicates, 0);
});

test('a fuzzy match is flagged for review and NOT merged', () => {
  const a = norm({ n: 1, company: 'Acme Bank', title: 'Finance Summer Intern Paris', docid: null, shareLink: null, applyOptions: [] });
  const b = norm({ n: 2, company: 'Acme Bank SA', title: 'Summer Finance Intern Paris', docid: null, shareLink: null, applyOptions: [] });
  assert.equal(classifyPair(a, b).tier, 'probable');
  const g = groupResults([a, b]);
  assert.equal(g.groups.length, 2);
  assert.equal(g.stats.possibleDuplicates, 1);
  assert.equal(g.groups[0].possible.length, 1);
  // the user can explicitly confirm, which is then recorded as such
  const merged = groupResults([a, b], { decisions: { [[a.id, b.id].sort().join('~')]: 'merge' } });
  assert.equal(merged.groups.length, 1);
  assert.equal(merged.groups[0].reasons[0].reason, 'user_confirmed');
  const kept = groupResults([a, b], { decisions: { [[a.id, b.id].sort().join('~')]: 'separate' } });
  assert.equal(kept.stats.possibleDuplicates, 0);
});

test('a job with a missing or unparseable URL is kept, flagged, and has no clickable link', () => {
  const j = norm({ n: 9, docid: null, shareLink: 'javascript:alert(1)', applyOptions: [{ title: 'x', link: 'not a url' }] });
  assert.equal(j.shareUrl.safe, false);
  assert.equal(j.applyOptions.length, 0);
  assert.ok(j.warnings.some((w) => w.code === 'bad_listing_url'));
  assert.ok(j.warnings.some((w) => w.code === 'no_links'));
});

test('confirmed duplicates from two providers keep BOTH source records and all apply options', () => {
  const viaGoogle = norm({ n: 1, company: 'Acme', title: 'Finance Intern', via: 'via Indeed',
    applyOptions: [{ title: 'Indeed', link: 'https://www.indeed.com/viewjob?jk=1d67b343245e0e9c&utm_source=google_jobs_apply' }, { title: 'Acme careers', link: 'https://careers.acme.com/jobs?jobId=9911' }] });
  const viaIndeed = normalizeProviderJob({
    providerJobId: '1d67b343245e0e9c', title: 'Finance Intern', company: 'Acme', location: 'Paris, France', via: 'Indeed',
    shareLink: 'https://www.indeed.com/viewjob?jk=1d67b343245e0e9c', applyOptions: [{ title: 'Indeed', link: 'https://www.indeed.com/viewjob?jk=1d67b343245e0e9c' }],
    description: 'Summer 2027 internship in corporate finance with a much longer description than the other record.',
  }, { ...CTX, engine: 'indeed_jobs' }).job;
  const g = groupResults([viaGoogle, viaIndeed]);
  assert.equal(g.groups.length, 1);
  const j = g.groups[0].job;
  assert.equal(j.sourceRecords.length, 2);
  assert.deepEqual(new Set(j.sourceRecords.map((r) => r.engine)), new Set(['google_jobs', 'indeed_jobs']));
  assert.ok(j.sourceRecords.every((r) => r.matchReason));
  assert.ok(j.applyOptions.some((a) => /careers\.acme\.com/.test(a.url)), 'second apply option preserved');
  assert.equal(g.groups[0].reasons[0].reason, 'job_url');
});

test('a strong match is blocked when merging would join conflicting records', () => {
  // A~B share a url key, B~C share a url key, but A and C have different platform ids
  const A = norm({ n: 1, company: 'Acme', docid: 'ID-A', title: 'Finance Intern', applyOptions: [{ title: 'x', link: 'https://careers.acme.com/jobs?jobId=777' }] });
  const B = norm({ n: 2, company: 'Acme', docid: 'ID-B', title: 'Finance Intern', applyOptions: [{ title: 'x', link: 'https://careers.acme.com/jobs?jobId=777' }] });
  assert.equal(classifyPair(A, B).tier, 'probable');         // same url, different ids on same platform => review, not merge
  assert.equal(groupResults([A, B]).groups.length, 2);
});

test('same job URL but different employers is never a duplicate', () => {
  const link = 'https://careers.example.com/jobs?jobId=555';
  const A = norm({ n: 1, company: 'Alpha Capital', docid: null, shareLink: link, applyOptions: [] });
  const B = norm({ n: 2, company: 'Beta Partners', docid: null, shareLink: link, applyOptions: [] });
  assert.equal(classifyPair(A, B).tier, 'none');
  assert.equal(classifyPair(A, B).reason, 'identifier_shared_but_employers_differ');
});

test('counts reconcile: raw = valid + rejected; valid = unique + confirmed duplicates', () => {
  const raw = [wire({ n: 1 }), wire({ n: 1 }), wire({ n: 2 }), { title: 'No company' }, null];
  const ok = [], rej = [];
  raw.forEach((r) => { const n = normalizeProviderJob(r, CTX); (n.ok ? ok : rej).push(n.job); });
  const g = groupResults(ok);
  assert.equal(raw.length, ok.length + rej.length);
  assert.equal(g.stats.valid, g.stats.unique + g.stats.confirmedDuplicates);
  assert.deepEqual([g.stats.unique, g.stats.confirmedDuplicates, rej.length], [2, 1, 2]);
});

test('tracked matching: strong on shared id, probable-only for manual entries, never fuzzy-auto', () => {
  const live = norm({ n: 3, company: 'Acme', title: 'Finance Intern' });
  const opps = [
    { id: 'o1', live: true, x: live, co: 'Acme', role: 'Finance Intern' },
    { id: 'o2', live: false, x: null, co: 'Beta', role: 'Equity Research Intern', city: 'Paris' },
  ];
  const again = norm({ n: 3, company: 'Acme', title: 'Finance Intern', postedText: '6 days ago' });
  assert.equal(matchTracked(again, opps).tier, 'strong');
  const manualLookalike = norm({ n: 4, company: 'Beta', title: 'Equity Research Intern', location: 'Paris, France' });
  const m = matchTracked(manualLookalike, opps);
  assert.equal(m.tier, 'probable');
  assert.equal(m.opp.id, 'o2');
  assert.equal(matchTracked(norm({ n: 99, company: 'Other' }), opps).tier, 'none');
});
