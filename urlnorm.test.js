import test from 'node:test';
import assert from 'node:assert/strict';
import { analyseUrl, safeHref } from '../public/lib/urlnorm.js';
import { googleShare, docid } from './fixtures.js';

test('Google Jobs share links: identity is the htidocid, not host+path', () => {
  const a = analyseUrl(googleShare(docid(1))), b = analyseUrl(googleShare(docid(2)));
  assert.equal(a.isJobSpecific, true);
  assert.notEqual(a.comparisonKey, b.comparisonKey);
  // same job, different session noise (shndl/shem/source/q) => same key
  const noisy = analyseUrl(googleShare(docid(1), 'a completely different query'));
  assert.equal(noisy.comparisonKey, a.comparisonKey);
});

test('Google search page without a job id has no strong key', () => {
  const a = analyseUrl('https://www.google.com/search?ibp=htl;jobs&q=finance+intern&hl=en-US');
  assert.equal(a.comparisonKey, null);
  assert.equal(a.isJobSpecific, false);
});

test('same host and path, different job-identifying query parameter => different keys', () => {
  const a = analyseUrl('https://careers.example.com/jobs?jobId=111'), b = analyseUrl('https://careers.example.com/jobs?jobId=222');
  assert.ok(a.comparisonKey && b.comparisonKey && a.comparisonKey !== b.comparisonKey);
});

test('fragments that identify a job are preserved; fragments are not discarded globally', () => {
  const a = analyseUrl('https://careers.example.com/jobs#job=111'), b = analyseUrl('https://careers.example.com/jobs#job=222');
  assert.notEqual(a.comparisonKey, b.comparisonKey);
  const r1 = analyseUrl('https://careers.example.com/app#/jobs/12345'), r2 = analyseUrl('https://careers.example.com/app#/jobs/67890');
  assert.notEqual(r1.comparisonKey, r2.comparisonKey);
  assert.match(analyseUrl('https://example.com/page#section-2').normalizedUrl, /#section-2$/);
});

test('harmless tracking parameters are removed, unknown parameters are kept', () => {
  const a = analyseUrl('https://www.indeed.com/viewjob?jk=1d67b343245e0e9c&utm_campaign=google_jobs_apply&utm_source=google_jobs_apply&utm_medium=organic');
  const b = analyseUrl('https://indeed.com/viewjob?jk=1d67b343245e0e9c&fbclid=abc');
  assert.equal(a.comparisonKey, 'indeed:1d67b343245e0e9c');
  assert.equal(a.comparisonKey, b.comparisonKey);
  const c = analyseUrl('https://example.com/x?keepme=1&utm_source=z');
  assert.match(c.normalizedUrl, /keepme=1/);
  assert.doesNotMatch(c.normalizedUrl, /utm_source/);
});

test('generic careers landing pages never produce a strong key', () => {
  for (const u of ['https://careers.example.com/', 'https://careers.example.com/careers', 'https://careers.example.com/en/jobs', 'https://example.com/careers/search']) {
    const a = analyseUrl(u);
    assert.equal(a.comparisonKey, null, u);
    assert.equal(a.isJobSpecific, false, u);
  }
});

test('provider formats: LinkedIn, Lever, Workday', () => {
  assert.equal(analyseUrl('https://www.linkedin.com/jobs/view/4012345678/?trk=abc').comparisonKey, 'linkedin:4012345678');
  assert.equal(analyseUrl('https://www.linkedin.com/jobs/search/?keywords=intern').comparisonKey, null);
  assert.match(analyseUrl('https://jobs.lever.co/acme/bc7e35ed-e80a-4868-a953-67d627de3deb').comparisonKey, /^lever:acme:/);
  assert.match(analyseUrl('https://peets.wd12.myworkdayjobs.com/en-US/Peets/job/Barista_R630').comparisonKey, /^workday:/);
});

test('malformed, unsafe and missing URLs are rejected without throwing', () => {
  for (const [u, w] of [[null, 'missing_url'], ['', 'missing_url'], ['not a url', 'malformed_url'], ['javascript:alert(1)', 'unsupported_protocol'], ['https://u:p@example.com/a/1234567', 'embedded_credentials'], ['ftp://example.com/x', 'unsupported_protocol']]) {
    const a = analyseUrl(u);
    assert.equal(a.safe, false);
    assert.equal(a.comparisonKey, null);
    assert.ok(a.warnings.includes(w), `${u} -> ${a.warnings}`);
    assert.equal(safeHref(u), null);
  }
});

test('the URL the user sees is the original, not the comparison form', () => {
  const raw = 'https://www.Example.com/Jobs/1234567/?utm_source=x';
  const a = analyseUrl(raw);
  assert.equal(a.originalUrl, raw);
  assert.equal(safeHref(raw), raw);
});
