// Reproduces the reported failure against the ORIGINAL code: 23 distinct Google Jobs results
// collapse into one card. This test documents the root cause and must keep passing, because it
// proves the legacy algorithm is the thing that was wrong (it is not used by the app any more).
import test from 'node:test';
import assert from 'node:assert/strict';
import { nu, keysOf, dedupe } from './legacy/legacy-dedupe.mjs';
import { googleShare, docid } from './fixtures.js';

const legacyX = (n) => ({
  providerJobId: null,                       // Google Jobs records often reach the UI without an id
  canonicalUrl: googleShare(docid(n)),
  companyName: `Company ${n}`, roleTitle: `Finance Intern ${n}`, city: n % 2 ? 'Paris' : null,
  sources: [{ label: ['LinkedIn', 'Indeed', 'Welcome to the Jungle', 'Bright Network'][n % 4], via: 'via', url: googleShare(docid(n)), applyUrl: null }],
  dataQualityScore: 50,
});

test('legacy nu() reduces every Google Jobs share link to the same key', () => {
  const keys = new Set(Array.from({ length: 23 }, (_, i) => nu(googleShare(docid(i)))));
  assert.deepEqual([...keys], ['google.com/search']);
});

test('legacy dedupe collapses 23 unrelated jobs into 1 card with 22 "duplicates"', () => {
  const list = Array.from({ length: 23 }, (_, i) => legacyX(i + 1));
  assert.ok(keysOf(list[0]).includes('u:google.com/search'));
  const { out, rm } = dedupe(list);
  assert.equal(out.length, 1);
  assert.equal(rm, 22);
  assert.ok(out[0].sources.length >= 4, 'unrelated source labels were unioned onto one record');
});
