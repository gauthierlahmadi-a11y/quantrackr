import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAndMigrate, migrateOpp, reviewSources, createCache, clearSearchCache, attachListing, detachSources, KEYS, SCHEMA_VERSION, USER_FIELDS } from '../public/lib/store.js';
import { normalizeProviderJob } from '../public/lib/normalize.js';
import { wire, CTX, googleShare, docid } from './fixtures.js';

const fakeStorage = (init = {}) => { const m = new Map(Object.entries(init)); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m }; };
const tracked = () => ({
  id: 'o1', co: 'Acme', role: 'Finance Intern', status: 'Applied', notes: 'Spoke to Marie, send CV', contacts: [{ n: 'Marie' }], checklist: [{ t: 'CV', d: true }],
  reminders: [{ d: '2026-12-01', t: 'Follow up' }], docs: [{ name: 'cv.pdf', size: 1234 }], fav: true, custom: { salary: '1500' }, edited: { role: true }, activity: [{ t: 'Applied' }], live: true,
  x: { companyName: 'Acme', roleTitle: 'Finance Intern', canonicalUrl: googleShare(docid(1)), sourceVerificationStatus: 'Live and verified',
    sources: Array.from({ length: 5 }, (_, i) => ({ label: ['LinkedIn', 'Indeed', 'Welcome to the Jungle', 'Bright Network', 'Glassdoor'][i], url: googleShare(docid(i + 1)), applyUrl: null })) },
});
const legacyStore = (opps) => JSON.stringify({ v: 2, opps, p: { theme: 'x' }, cache: { k1: { ts: Date.parse('2026-11-12'), xs: [{ companyName: 'Cached Co', roleTitle: 'Intern' }] } } });

test('migration preserves every user-owned field and original record', () => {
  const o = tracked();
  const st = fakeStorage({ [KEYS.data]: legacyStore([o]) });
  const { data, backupKey, migrated } = loadAndMigrate(st);
  assert.equal(migrated, true);
  assert.ok(backupKey && st.getItem(backupKey), 'backup written first');
  const m = data.opps[0];
  for (const f of USER_FIELDS) assert.deepEqual(m[f], o[f], f);
  assert.equal(m.x.sources.length, 5, 'legacy source list preserved');
  assert.equal(m.x.sourceRecords.length, 5);
  assert.equal(m.x.legacy.sourceVerificationStatus, 'Live and verified');
  assert.equal(data.p.theme, 'x');
  assert.deepEqual(data.p.target, { year: 2026, season: 'summer' }, 'previous implicit target kept, not silently changed');
  assert.equal(data.schema, SCHEMA_VERSION);
});

test('migration is idempotent', () => {
  const st = fakeStorage({ [KEYS.data]: legacyStore([tracked()]) });
  const once = loadAndMigrate(st).data;
  st.setItem(KEYS.data, JSON.stringify(once));
  const twice = loadAndMigrate(st);
  assert.equal(twice.migrated, false);
  assert.deepEqual(twice.data, once);
  assert.deepEqual(migrateOpp(migrateOpp(tracked())).x.sourceRecords, migrateOpp(tracked()).x.sourceRecords);
});

test('one malformed record does not erase the rest', () => {
  const st = fakeStorage({ [KEYS.data]: legacyStore([tracked(), null, 'garbage', { id: 'o3', co: 'B', role: 'R', status: 'Saved' }]) });
  const { data, skipped } = loadAndMigrate(st);
  assert.equal(skipped, 2);
  assert.deepEqual(data.opps.map((o) => o.id), ['o1', 'o3']);
});

test('corrupt JSON in storage does not throw and does not destroy the raw value', () => {
  const st = fakeStorage({ [KEYS.data]: '{not json' });
  const r = loadAndMigrate(st);
  assert.equal(r.data, null);
  assert.equal(st.getItem(KEYS.data), '{not json');
});

test('suspected previously merged sources are flagged, not changed', () => {
  const { data } = loadAndMigrate(fakeStorage({ [KEYS.data]: legacyStore([tracked()]) }));
  const m = data.opps[0];
  assert.equal(m.srcReview.suspicious, true);
  assert.ok(m.srcReview.reasons.some((r) => /Google Jobs/.test(r)));
  assert.equal(m.x.sourceRecords.length, 5);
  assert.equal(reviewSources({ sourceRecords: [{ label: 'LinkedIn', listingUrl: googleShare(docid(1)), applyOptions: [] }] }).suspicious, false);
});

test('legacy cache moves to its own key; clearing it leaves applications intact', () => {
  const st = fakeStorage({ [KEYS.data]: legacyStore([tracked()]) });
  const { data } = loadAndMigrate(st);
  st.setItem(KEYS.data, JSON.stringify(data));
  assert.equal(data.cache, undefined);
  assert.ok(JSON.parse(st.getItem(KEYS.cache)).legacy.k1.jobs.length === 1);
  const cache = createCache(st);
  cache.set('a', { key: 'a', at: '2026-11-13T00:00:00Z', jobs: [] });
  clearSearchCache(st);
  assert.equal(st.getItem(KEYS.cache), null);
  assert.equal(JSON.parse(st.getItem(KEYS.data)).opps[0].notes, 'Spoke to Marie, send CV');
});

test('cache survives quota errors by evicting oldest entries instead of throwing', () => {
  let fail = true;
  const st = fakeStorage();
  const orig = st.setItem;
  st.setItem = (k, v) => { if (fail && v.length > 400) throw new Error('QuotaExceededError'); return orig(k, v); };
  const c = createCache(st, { maxEntries: 10 });
  c.set('old', { key: 'old', at: '2026-01-01T00:00:00Z', jobs: [] });
  assert.doesNotThrow(() => c.set('new', { key: 'new', at: '2026-11-01T00:00:00Z', jobs: Array(20).fill({ title: 'x'.repeat(30) }) }));
});

test('refresh/attach keeps all personal data; detach moves sources aside without deleting', () => {
  const { data } = loadAndMigrate(fakeStorage({ [KEYS.data]: legacyStore([tracked()]) }));
  const opp = data.opps[0];
  const job = normalizeProviderJob(wire({ n: 1, company: 'Acme', title: 'Finance Intern' }), CTX).job;
  const attached = attachListing(opp, job, 'user_linked');
  for (const f of USER_FIELDS) assert.deepEqual(attached[f], opp[f], f);
  assert.equal(attached.x.sourceRecords.length, 6);
  const detached = detachSources(attached, ['legacy1', 'legacy2']);
  for (const f of USER_FIELDS) assert.deepEqual(detached[f], opp[f], f);
  assert.equal(detached.x.sourceRecords.length, 4);
  assert.equal(detached.detachedSources.length, 2);
});
