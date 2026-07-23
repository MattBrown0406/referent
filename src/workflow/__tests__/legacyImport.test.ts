import assert from 'node:assert/strict';
import test from 'node:test';

import { importLegacyInterventionOS, LegacyImportError } from '../legacyImport';
import { createEmptyWorkflowState } from '../state';

const importedAt = '2026-07-22T12:00:00.000Z';

function legacyPayload() {
  return {
    families: [
      {
        id: 'legacy-family-1',
        name: ' Smith Family ',
        type: 'intervention',
        status: 'Preparing',
        participants: [{ id: 'legacy-person-1', name: 'Ann Smith', role: 'Mother', phone: '555-0100' }],
        checklist: { contractSent: true, contractSigned: false },
        documents: ['Contract.pdf', { name: 'Notes.txt', storagePath: '/must/not/import' }],
        amount: '7500.25',
        paymentStatus: 'received',
        archived: false,
      },
      { id: 'legacy-family-2', name: 'smith family', type: 'coaching', status: 'New', amount: 100, paymentStatus: 'pending' },
      { id: 'legacy-family-3', name: 'Jones Family', type: 'intervention', status: 'Scheduled' },
    ],
    scheduleItems: [
      { id: 'legacy-appt-1', title: 'Prep call', family: ' Jones Family ', startsAt: '2026-07-22T16:00:00-07:00', note: 'Prepare' },
    ],
    tasks: [
      { id: 'legacy-task-1', title: 'Ambiguous call', family: 'SMITH FAMILY', dueDate: '2026-07-23', completed: false },
      { id: 'legacy-task-2', title: 'Unique call', familyName: 'jones family', dueDate: '2026-07-23', completed: true },
    ],
    caseFilter: 'intervention',
    scheduleFilter: 'schedule',
    selectedCalendarId: '',
    savedAt: '2026-07-20T00:00:00.000Z',
  };
}

test('legacy import normalizes nested records, cents, provenance, links, and name-only documents', () => {
  const result = importLegacyInterventionOS(createEmptyWorkflowState(), JSON.stringify(legacyPayload()), {
    sourceId: 'iphone-backup', importedAt, defaultTimeZone: 'America/Los_Angeles',
  });
  const smith = Object.values(result.state.cases).find((item) => item.legacy?.legacyId === 'legacy-family-1');
  const jones = Object.values(result.state.cases).find((item) => item.legacy?.legacyId === 'legacy-family-3');
  assert.ok(smith);
  assert.ok(jones);
  assert.equal(smith.id, 'legacy:iphone-backup:case:legacy-family-1');
  assert.equal(smith.status, 'preparing');
  assert.equal(Object.values(result.state.participants)[0]?.caseId, smith.id);
  assert.equal(Object.values(result.state.checklistItems).find((item) => item.key === 'contractSent')?.completedAt, importedAt);
  assert.deepEqual(Object.values(result.state.documents).map((item) => Object.keys(item).sort()), [
    ['caseId', 'id', 'legacy', 'name'],
    ['caseId', 'id', 'legacy', 'name'],
  ]);
  assert.deepEqual(Object.values(result.state.documents).map((item) => item.name), ['Contract.pdf', 'Notes.txt']);
  assert.equal(Object.values(result.state.payments).find((item) => item.caseId === smith.id)?.amountCents, 750_025);

  const ambiguous = Object.values(result.state.tasks).find((item) => item.title === 'Ambiguous call');
  const unique = Object.values(result.state.tasks).find((item) => item.title === 'Unique call');
  assert.equal(ambiguous?.caseId, undefined);
  assert.equal(unique?.caseId, jones.id);
  assert.ok(unique?.completedAt);
  assert.match(result.warnings.join('\n'), /ambiguous.*SMITH FAMILY/i);

  const appointment = Object.values(result.state.appointments)[0];
  assert.equal(appointment?.caseId, jones.id);
  assert.equal(appointment?.startsAt, '2026-07-22T23:00:00.000Z');
  assert.equal(appointment?.timeZone, 'America/Los_Angeles');
});

test('same source and payload is idempotent using fingerprint and deterministic source IDs', () => {
  const first = importLegacyInterventionOS(createEmptyWorkflowState(), legacyPayload(), {
    sourceId: 'iphone-backup', importedAt, defaultTimeZone: 'UTC',
  });
  const second = importLegacyInterventionOS(first.state, legacyPayload(), {
    sourceId: 'iphone-backup', importedAt: '2026-07-23T00:00:00.000Z', defaultTimeZone: 'UTC',
  });
  assert.equal(second.alreadyImported, true);
  assert.deepEqual(second.state, first.state);
  assert.equal(Object.keys(second.state.imports).length, 1);
  const changed = legacyPayload();
  changed.families[0].name = 'Changed family';
  assert.throws(
    () => importLegacyInterventionOS(first.state, changed, {
      sourceId: 'iphone-backup', importedAt, defaultTimeZone: 'UTC',
    }),
    /already imported|different content/i,
  );
});

test('invalid local times and timezones are handled without inventing unrelated appointments', () => {
  const payload = { families: [], tasks: [], scheduleItems: [
    { id: 'bad-time', title: 'Bad time', date: '2026-07-22', time: '99:99' },
    { id: 'bad-zone', title: 'Bad zone', startsAt: '2026-07-22T16:00:00Z', timeZone: 'Not/AZone' },
  ] };
  const result = importLegacyInterventionOS(createEmptyWorkflowState(), payload, {
    sourceId: 'time-check', importedAt, defaultTimeZone: 'UTC',
  });
  assert.equal(result.state.appointments['legacy:time-check:appointment:bad-time'], undefined);
  assert.equal(result.state.appointments['legacy:time-check:appointment:bad-zone']?.timeZone, 'UTC');
  assert.match(result.warnings.join('\n'), /invalid date|invalid timezone/i);
});

test('duplicate explicit legacy IDs reject the import instead of overwriting records', () => {
  const payload = { families: [
    { id: 'dup', name: 'First' },
    { id: 'dup', name: 'Second' },
  ], tasks: [], scheduleItems: [] };
  assert.throws(
    () => importLegacyInterventionOS(createEmptyWorkflowState(), payload, {
      sourceId: 'duplicates', importedAt, defaultTimeZone: 'UTC',
    }),
    /duplicate.*family.*dup/i,
  );
});

test('import accepts and returns workflow only, leaving referral state untouched', () => {
  const appState = { referral: { referrals: { 'ref-1': { id: 'ref-1', status: 'open' } } }, workflow: createEmptyWorkflowState() };
  const originalReferral = structuredClone(appState.referral);
  const result = importLegacyInterventionOS(appState.workflow, legacyPayload(), {
    sourceId: 'isolated', importedAt, defaultTimeZone: 'UTC',
  });
  appState.workflow = result.state;
  assert.deepEqual(appState.referral, originalReferral);
  assert.equal('referral' in (result.state as object), false);
});

test('malformed top-level legacy payloads are rejected', () => {
  for (const payload of [null, [], {}, { families: {}, scheduleItems: [], tasks: [] }, { families: [], scheduleItems: [] }]) {
    assert.throws(
      () => importLegacyInterventionOS(createEmptyWorkflowState(), payload, { sourceId: 'bad', importedAt, defaultTimeZone: 'UTC' }),
      LegacyImportError,
    );
  }
  assert.throws(
    () => importLegacyInterventionOS(createEmptyWorkflowState(), '{not json', { sourceId: 'bad', importedAt, defaultTimeZone: 'UTC' }),
    LegacyImportError,
  );
});

test('encoded import IDs cannot collide across delimiter-containing source and legacy IDs', () => {
  const base = { scheduleItems: [], tasks: [] };
  const first = importLegacyInterventionOS(createEmptyWorkflowState(), { ...base, families: [{ id: 'case:c', name: 'Original' }] }, { sourceId: 'a', importedAt, defaultTimeZone: 'UTC' });
  const second = importLegacyInterventionOS(first.state, { ...base, families: [{ id: 'c', name: 'Replacement' }] }, { sourceId: 'a:case', importedAt, defaultTimeZone: 'UTC' });
  assert.deepEqual(Object.values(second.state.cases).map((row) => row.name).sort(), ['Original', 'Replacement']);

  const occupied = createEmptyWorkflowState();
  occupied.cases['legacy:a:case:c'] = { id: 'legacy:a:case:c', kind: 'intervention', name: 'Manual', status: 'new', archivedAt: null, createdAt: importedAt, updatedAt: importedAt };
  assert.throws(
    () => importLegacyInterventionOS(occupied, { ...base, families: [{ id: 'c', name: 'Overwrite' }] }, { sourceId: 'a', importedAt, defaultTimeZone: 'UTC' }),
    /overwrite/i,
  );
});

test('distinct payloads that collided under the former 32-bit hash are rejected as changed content', () => {
  const base = { scheduleItems: [], tasks: [] };
  const first = importLegacyInterventionOS(createEmptyWorkflowState(), { ...base, families: [{ id: '36456', name: 'Family 36456' }] }, { sourceId: 'collision-source', importedAt, defaultTimeZone: 'UTC' });
  assert.throws(
    () => importLegacyInterventionOS(first.state, { ...base, families: [{ id: '40443', name: 'Family 40443' }] }, { sourceId: 'collision-source', importedAt, defaultTimeZone: 'UTC' }),
    /different content/i,
  );
});
