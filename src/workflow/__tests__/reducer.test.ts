import assert from 'node:assert/strict';
import test from 'node:test';

import { createEmptyWorkflowState } from '../state';
import { workflowReducer } from '../reducer';
import type { WorkflowCase, WorkflowTask } from '../types';

const workflowCase: WorkflowCase = {
  id: 'case-1',
  kind: 'intervention',
  name: 'Jones Family',
  status: 'new',
  archivedAt: null,
  referralId: 'referral-1',
  referralMatchId: 'match-1',
  placementPartnerId: 'partner-1',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
};

const task: WorkflowTask = {
  id: 'task-1',
  caseId: 'case-1',
  title: 'Call family',
  dueDate: '2026-07-22',
  completedAt: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
};

test('CRUD actions are immutable and archive/restore a case without losing links', () => {
  const empty = createEmptyWorkflowState();
  const added = workflowReducer(empty, { type: 'case/upsert', value: workflowCase });
  assert.notEqual(added, empty);
  assert.deepEqual(empty.cases, {});
  assert.equal(added.cases['case-1']?.referralMatchId, 'match-1');

  const archived = workflowReducer(added, {
    type: 'case/archive',
    id: 'case-1',
    at: '2026-07-22T12:00:00.000Z',
  });
  assert.equal(archived.cases['case-1']?.archivedAt, '2026-07-22T12:00:00.000Z');
  assert.equal(added.cases['case-1']?.archivedAt, null);

  const restored = workflowReducer(archived, {
    type: 'case/restore',
    id: 'case-1',
    at: '2026-07-22T13:00:00.000Z',
  });
  assert.equal(restored.cases['case-1']?.archivedAt, null);
  assert.equal(restored.cases['case-1']?.referralId, 'referral-1');

  const removed = workflowReducer(restored, { type: 'case/remove', id: 'case-1' });
  assert.equal(removed.cases['case-1'], undefined);
});

test('task completion and reopening retain the stable task ID', () => {
  let state = workflowReducer(createEmptyWorkflowState(), { type: 'task/upsert', value: task });
  state = workflowReducer(state, {
    type: 'task/complete',
    id: task.id,
    at: '2026-07-22T10:00:00.000Z',
  });
  assert.equal(state.tasks[task.id]?.completedAt, '2026-07-22T10:00:00.000Z');

  state = workflowReducer(state, {
    type: 'task/reopen',
    id: task.id,
    at: '2026-07-22T11:00:00.000Z',
  });
  assert.equal(state.tasks[task.id]?.id, task.id);
  assert.equal(state.tasks[task.id]?.completedAt, null);
});

test('checklist completion stores an explicit completion timestamp', () => {
  const state = workflowReducer(createEmptyWorkflowState(), {
    type: 'checklist/upsert',
    value: {
      id: 'check-1',
      caseId: 'case-1',
      key: 'contractSigned',
      label: 'Contract signed',
      completedAt: '2026-07-22T10:00:00.000Z',
    },
  });
  assert.equal(state.checklistItems['check-1']?.completedAt, '2026-07-22T10:00:00.000Z');
});
