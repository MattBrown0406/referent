/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEmptyEnvelope,
  generateId,
  migrateStoredData,
  normalizePartner,
  normalizeReferral,
  normalizeReferralMatch,
} from '../types';
import {
  LEGACY_BACKUP_PREFIX,
  LEGACY_STORAGE_KEY,
  RESTORE_BACKUP_PREFIX,
  STORAGE_KEY,
  loadStoredData,
  restoreStoredData,
  saveStoredData,
  updateStoredData,
  type KeyValueStorage,
} from '../storage';

class MemoryStorage implements KeyValueStorage {
  readonly writes: Array<[string, string]> = [];

  constructor(private readonly values: Record<string, string> = {}) {}

  async getItem(key: string) {
    return this.values[key] ?? null;
  }

  async setItem(key: string, value: string) {
    this.writes.push([key, value]);
    this.values[key] = value;
  }
}

test('legacy records are normalized into render-safe domain objects', () => {
  const partner = normalizePartner({ id: 'p-old', name: 'Alex' });
  assert.deepEqual(partner.insurance, []);
  assert.deepEqual(partner.therapies, []);
  assert.deepEqual(partner.populations, []);
  assert.deepEqual(partner.levels, []);
  assert.deepEqual(partner.types, []);
  assert.deepEqual(partner.regions, []);
  assert.deepEqual(partner.outOfNetworkInsurance, []);
  assert.equal(partner.organization, '');
  assert.equal(partner.cashMin, null);
  assert.equal(partner.inbound, 0);

  const referral = normalizeReferral({ id: 'r-old' });
  assert.equal(referral.partnerId, '');
  assert.equal(referral.note, '');
  assert.equal(referral.direction, 'Inbound');

  const match = normalizeReferralMatch({ id: 'm-old' });
  assert.deepEqual(match.therapies, []);
  assert.deepEqual(match.networkPreferences, []);
  assert.equal(match.clientLabel, '');
  assert.equal(match.status, 'Matching');
});

test('schema-v3 envelope includes referral data and empty workflow collections/settings', () => {
  const envelope = createEmptyEnvelope();
  assert.equal(envelope.schemaVersion, 3);
  assert.deepEqual(envelope.partners, []);
  assert.deepEqual(envelope.referrals, []);
  assert.deepEqual(envelope.referralMatches, []);
  assert.deepEqual(envelope.cases, []);
  assert.deepEqual(envelope.participants, []);
  assert.deepEqual(envelope.checklistCompletions, []);
  assert.deepEqual(envelope.documentReferences, []);
  assert.deepEqual(envelope.tasks, []);
  assert.deepEqual(envelope.appointments, []);
  assert.deepEqual(envelope.revenueEntries, []);
  assert.deepEqual(envelope.settings, { cloudSyncEnabled: false, lastCloudSyncAt: null });
});

test('migration recognizes v2 referral payload and normalizes every row', () => {
  const migrated = migrateStoredData({
    partners: [{ id: 'p1', name: 'Legacy' }],
    referrals: [{ id: 'r1', partnerId: 'p1' }],
    referralMatches: [{ id: 'm1' }],
  });

  assert.equal(migrated.schemaVersion, 3);
  assert.deepEqual(migrated.partners[0].insurance, []);
  assert.equal(migrated.referrals[0].partnerId, 'p1');
  assert.deepEqual(migrated.referralMatches[0].therapies, []);
});

test('migration rejects undocumented, versioned, and invalid top-level shapes', () => {
  const invalid: unknown[] = [
    {},
    { arbitrary: [] },
    { schemaVersion: 2, partners: [], referrals: [], referralMatches: [] },
    { schemaVersion: 4, partners: [], referrals: [], referralMatches: [] },
    { partners: [], referrals: [] },
    { partners: {}, referrals: [], referralMatches: [] },
    { partners: [], referrals: {}, referralMatches: [] },
    { partners: [], referrals: [], referralMatches: {} },
    { partners: [], referrals: [], referralMatches: [], unexpected: true },
  ];

  for (const value of invalid) {
    assert.throws(() => migrateStoredData(value), /schema|collection|legacy|array|version/i);
  }
});

test('migration accepts only v3 envelopes with every required collection and valid settings types', () => {
  const valid = createEmptyEnvelope();
  assert.deepEqual(migrateStoredData(valid), valid);

  for (const key of [
    'partners', 'referrals', 'referralMatches', 'cases', 'participants',
    'checklistCompletions', 'documentReferences', 'tasks', 'appointments', 'revenueEntries',
  ] as const) {
    assert.throws(() => migrateStoredData({ ...valid, [key]: {} }), /collection|array/i, key);
  }
  assert.throws(() => migrateStoredData({ ...valid, settings: [] }), /settings/i);
  assert.throws(
    () => migrateStoredData({ ...valid, settings: { ...valid.settings, cloudSyncEnabled: 'yes' } }),
    /settings/i,
  );
  assert.throws(
    () => migrateStoredData({ ...valid, settings: { ...valid.settings, lastCloudSyncAt: 42 } }),
    /settings/i,
  );
  assert.throws(() => migrateStoredData({ ...valid, unexpected: true }), /unknown|unexpected|field/i);
  assert.throws(
    () => migrateStoredData({ ...valid, settings: { ...valid.settings, unexpected: true } }),
    /settings|unknown|unexpected|field/i,
  );
  assert.throws(() => migrateStoredData({ ...valid, partners: [42] }), /partner|record|row/i);
  assert.throws(() => migrateStoredData({ ...valid, tasks: [{ id: 'keep' }, null] }), /task|record|row/i);
  assert.throws(
    () => migrateStoredData({
      ...valid,
      partners: [normalizePartner({ id: 'same' }), normalizePartner({ id: 'same' })],
    }),
    /duplicate|id/i,
  );
});

test('loader backs up exact legacy JSON before writing migrated v3 data', async () => {
  const raw = '{\n  "partners": [{"id":"p1","name":"Legacy"}],\n  "referrals": [],\n  "referralMatches": []\n}';
  const storage = new MemoryStorage({ [LEGACY_STORAGE_KEY]: raw });
  const result = await loadStoredData(storage, { now: () => new Date('2026-07-22T12:34:56.789Z') });

  assert.equal(result.status, 'migrated');
  if (result.status !== 'migrated') return;
  assert.equal(result.backupKey, 'referralfit-v2-backup-2026-07-22T12-34-56-789Z');
  assert.deepEqual(storage.writes.map(([key]) => key), [result.backupKey, STORAGE_KEY]);
  assert.equal(storage.writes[0][1], raw);
  assert.equal(JSON.parse(storage.writes[1][1]).schemaVersion, 3);
});

test('malformed legacy JSON returns recovery result without overwriting or backing up source', async () => {
  const raw = '{ definitely not json';
  const storage = new MemoryStorage({ [LEGACY_STORAGE_KEY]: raw });
  const result = await loadStoredData(storage);

  assert.equal(result.status, 'recovery');
  if (result.status !== 'recovery') return;
  assert.equal(result.sourceKey, LEGACY_STORAGE_KEY);
  assert.equal(result.raw, raw);
  assert.match(result.error, /parse/i);
  assert.deepEqual(storage.writes, []);
  assert.equal(await storage.getItem(LEGACY_STORAGE_KEY), raw);
});

test('existing schema-v3 data loads without creating another backup', async () => {
  const stored = createEmptyEnvelope();
  stored.partners.push(normalizePartner({ id: 'p1', name: 'Current' }));
  const storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(stored) });

  const result = await loadStoredData(storage);
  assert.equal(result.status, 'loaded');
  assert.deepEqual(storage.writes, []);
});

test('loader rejects parseable data stored under the wrong schema key without writes', async () => {
  const legacy = { partners: [], referrals: [], referralMatches: [] };
  const v3 = createEmptyEnvelope();

  for (const [sourceKey, value] of [
    [STORAGE_KEY, legacy],
    [LEGACY_STORAGE_KEY, v3],
  ] as const) {
    const storage = new MemoryStorage({ [sourceKey]: JSON.stringify(value) });
    const result = await loadStoredData(storage);
    assert.equal(result.status, 'recovery');
    assert.deepEqual(storage.writes, []);
  }
});

test('loader returns recovery without writes for invalid collection types', async () => {
  const malformedV3 = { ...createEmptyEnvelope(), partners: {} };
  const storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(malformedV3) });
  const result = await loadStoredData(storage);
  assert.equal(result.status, 'recovery');
  assert.deepEqual(storage.writes, []);
});

test('save cannot bypass required legacy initialization or overwrite malformed v3', async () => {
  const legacyRaw = JSON.stringify({ partners: [], referrals: [], referralMatches: [] });
  const legacyStorage = new MemoryStorage({ [LEGACY_STORAGE_KEY]: legacyRaw });
  await assert.rejects(() => saveStoredData(legacyStorage, createEmptyEnvelope()), /load|migrat|legacy/i);
  assert.deepEqual(legacyStorage.writes, []);

  const malformedV3 = JSON.stringify({ schemaVersion: 3, partners: [] });
  const v3Storage = new MemoryStorage({ [STORAGE_KEY]: malformedV3 });
  await assert.rejects(() => saveStoredData(v3Storage, createEmptyEnvelope()), /existing|recover|invalid/i);
  assert.deepEqual(v3Storage.writes, []);
  assert.equal(await v3Storage.getItem(STORAGE_KEY), malformedV3);
});

test('save runtime-validates its payload before writing', async () => {
  const storage = new MemoryStorage();
  await assert.rejects(
    () => saveStoredData(storage, { ...createEmptyEnvelope(), tasks: {} } as unknown as ReturnType<typeof createEmptyEnvelope>),
    /collection|array/i,
  );
  assert.deepEqual(storage.writes, []);
});

test('current v3 core rows reject missing required fields instead of normalizing corruption', () => {
  const malformed = createEmptyEnvelope();
  malformed.partners = [{ id: 'p-only' } as never];
  assert.throws(() => migrateStoredData(malformed), /partner.*invalid|unknown field|required/i);
});

test('existing data is changed through serialized functional updates, not stale full snapshots', async () => {
  const storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(createEmptyEnvelope()) });
  await assert.rejects(() => saveStoredData(storage, createEmptyEnvelope()), /update|existing/i);

  await Promise.all([
    updateStoredData(storage, (current) => ({
      ...current,
      partners: [...current.partners, normalizePartner({ id: 'p-a', name: 'A' })],
    })),
    updateStoredData(storage, (current) => ({
      ...current,
      referrals: [...current.referrals, normalizeReferral({ id: 'r-b', partnerId: 'p-a' })],
    })),
  ]);

  const stored = JSON.parse((await storage.getItem(STORAGE_KEY)) ?? '{}');
  assert.deepEqual(stored.partners.map((item: { id: string }) => item.id), ['p-a']);
  assert.deepEqual(stored.referrals.map((item: { id: string }) => item.id), ['r-b']);
});

test('migration chooses a deterministic non-colliding backup suffix', async () => {
  const raw = JSON.stringify({ partners: [], referrals: [], referralMatches: [] });
  const timestamp = '2026-07-22T12-34-56-789Z';
  const base = `${LEGACY_BACKUP_PREFIX}${timestamp}`;
  const storage = new MemoryStorage({
    [LEGACY_STORAGE_KEY]: raw,
    [base]: 'older backup',
    [`${base}-1`]: 'newer backup',
  });
  const result = await loadStoredData(storage, { now: () => new Date('2026-07-22T12:34:56.789Z') });

  assert.equal(result.status, 'migrated');
  if (result.status !== 'migrated') return;
  assert.equal(result.backupKey, `${base}-2`);
  assert.deepEqual(storage.writes.map(([key]) => key), [`${base}-2`, STORAGE_KEY]);
  assert.equal(await storage.getItem(base), 'older backup');
  assert.equal(await storage.getItem(`${base}-1`), 'newer backup');
});

test('generated IDs are prefixed, collision-resistant UUIDs', () => {
  const ids = new Set(Array.from({ length: 500 }, () => generateId('partner')));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.match(id, /^partner-[0-9a-f]{8}-[0-9a-f-]{27}$/i);
});

test('explicit restore validates first and backs up the exact current serialization', async () => {
  const currentRaw = JSON.stringify({ ...createEmptyEnvelope(), partners: [normalizePartner({ id: 'old', name: 'Old' })] });
  const replacement = { ...createEmptyEnvelope(), partners: [normalizePartner({ id: 'new', name: 'New' })] };
  const storage = new MemoryStorage({ [STORAGE_KEY]: currentRaw });
  const restored = await restoreStoredData(storage, JSON.stringify(replacement), { now: () => new Date('2026-07-22T12:00:00.000Z') });
  assert.ok(restored.backupKey?.startsWith(RESTORE_BACKUP_PREFIX));
  assert.deepEqual(storage.writes[0], [restored.backupKey!, currentRaw]);
  assert.deepEqual(JSON.parse((await storage.getItem(STORAGE_KEY))!), replacement);

  const invalidStorage = new MemoryStorage({ [STORAGE_KEY]: currentRaw });
  await assert.rejects(() => restoreStoredData(invalidStorage, '{}'), /not valid ReferralFit data/i);
  assert.equal(invalidStorage.writes.length, 0);
});
