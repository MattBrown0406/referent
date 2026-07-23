import assert from 'node:assert/strict';
import test from 'node:test';

import { createEmptyEnvelope, migrateStoredData } from '../../domain/types';
import { workflowCollectionsFromState, workflowStateFromEnvelope } from '../persistence';
import { createEmptyWorkflowState } from '../state';

const at = '2026-07-22T12:00:00.000Z';

test('workflow persistence round-trips records and import fingerprints', () => {
  const state = createEmptyWorkflowState();
  state.cases.case1 = { id: 'case1', kind: 'intervention', name: 'Jones', status: 'new', archivedAt: null, createdAt: at, updatedAt: at };
  state.imports.import1 = { id: 'import1', sourceId: 'backup', fingerprint: 'abc', importedAt: at };
  const envelope = { ...createEmptyEnvelope(), ...workflowCollectionsFromState(state) };
  assert.deepEqual(workflowStateFromEnvelope(migrateStoredData(envelope)), state);
});

test('workflow persistence rejects malformed current rows instead of silently dropping them', () => {
  const envelope = createEmptyEnvelope();
  envelope.cases = [{ id: 'case1', name: 'Broken', kind: 'wrong', status: 'new', archivedAt: null, createdAt: at, updatedAt: at }];
  assert.throws(() => workflowStateFromEnvelope(envelope), /invalid record/i);

  const badAppointment = createEmptyEnvelope();
  badAppointment.appointments = [{ id: 'a', title: 'Bad', startsAt: 'garbage', endsAt: 'also-bad', timeZone: 'Nope/Zone', createdAt: at, updatedAt: at }];
  assert.throws(() => workflowStateFromEnvelope(badAppointment), /invalid record/i);

  const unsafeDocument = createEmptyEnvelope();
  unsafeDocument.documentReferences = [{ id: 'd', caseId: 'case1', name: 'Unsafe', uri: 'intent://evil' }];
  assert.throws(() => workflowStateFromEnvelope(unsafeDocument), /invalid record/i);
});
