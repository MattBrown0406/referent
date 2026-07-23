import assert from 'node:assert/strict';
import test from 'node:test';

import {
  selectCaseDetail,
  selectOpenTasks,
  selectOutstandingBalanceCents,
  selectPipelineCounts,
  selectRevenue,
  selectTodaysAppointments,
} from '../selectors';
import { createEmptyWorkflowState } from '../state';
import type { WorkflowState } from '../types';

function fixture(): WorkflowState {
  const state = createEmptyWorkflowState();
  state.cases['case-1'] = {
    id: 'case-1', kind: 'intervention', name: 'Jones Family', status: 'preparing', archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  state.cases['case-2'] = {
    id: 'case-2', kind: 'coaching', name: 'Reed Family', status: 'new', archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  state.cases['archived'] = {
    id: 'archived', kind: 'coaching', name: 'Old Family', status: 'new', archivedAt: '2026-02-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z',
  };
  state.tasks.open = {
    id: 'open', caseId: 'case-1', title: 'Open', dueDate: '2026-07-22', completedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  state.tasks.done = { ...state.tasks.open, id: 'done', title: 'Done', completedAt: '2026-07-20T00:00:00.000Z' };
  state.appointments.latePacific = {
    id: 'latePacific', caseId: 'case-1', title: 'Late Pacific',
    startsAt: '2026-07-23T06:30:00.000Z', endsAt: '2026-07-23T07:00:00.000Z', timeZone: 'America/Los_Angeles',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  state.appointments.nextDay = {
    ...state.appointments.latePacific, id: 'nextDay', title: 'Next day', startsAt: '2026-07-23T08:00:00.000Z', endsAt: '2026-07-23T08:30:00.000Z',
  };
  state.payments.jan = { id: 'jan', caseId: 'case-1', amountCents: 100_00, status: 'received', effectiveDate: '2026-01-15' };
  state.payments.july = { id: 'july', caseId: 'case-1', amountCents: 250_00, status: 'received', effectiveDate: '2026-07-05' };
  state.payments.pending = { id: 'pending', caseId: 'case-1', amountCents: 75_00, status: 'pending', effectiveDate: '2026-07-10' };
  state.payments.old = { id: 'old', caseId: 'case-1', amountCents: 999_00, status: 'received', effectiveDate: '2025-12-31' };
  state.participants.person = { id: 'person', caseId: 'case-1', name: 'Jane Jones', role: 'Parent' };
  state.documents.doc = { id: 'doc', caseId: 'case-1', name: 'Agreement.pdf' };
  state.checklistItems.check = { id: 'check', caseId: 'case-1', key: 'signed', label: 'Signed', completedAt: null };
  return state;
}

test("today's appointments use the supplied date and timezone at a timezone boundary", () => {
  const state = fixture();
  assert.deepEqual(
    selectTodaysAppointments(state, 'America/Los_Angeles', '2026-07-22').map((item) => item.id),
    ['latePacific'],
  );
  assert.deepEqual(
    selectTodaysAppointments(state, 'UTC', '2026-07-23').map((item) => item.id),
    ['latePacific', 'nextDay'],
  );
});

test('open tasks, pipeline counts, and outstanding balances exclude completed/archived/received records', () => {
  const state = fixture();
  assert.deepEqual(selectOpenTasks(state).map((task) => task.id), ['open']);
  assert.deepEqual(selectPipelineCounts(state), {
    new: 1, engaged: 0, preparing: 1, scheduled: 0, completed: 0, closed: 0,
  });
  assert.equal(selectOutstandingBalanceCents(state), 75_00);
  assert.equal(selectOutstandingBalanceCents(state, 'case-1'), 75_00);
});

test('MTD and YTD revenue use effective date and received payments only', () => {
  assert.deepEqual(selectRevenue(fixture(), '2026-07-22'), { mtdCents: 250_00, ytdCents: 350_00 });
});

test('case detail aggregates all case-linked workflow records', () => {
  const detail = selectCaseDetail(fixture(), 'case-1');
  assert.equal(detail?.case.name, 'Jones Family');
  assert.deepEqual(detail?.participants.map((item) => item.id), ['person']);
  assert.deepEqual(detail?.tasks.map((item) => item.id).sort(), ['done', 'open']);
  assert.deepEqual(detail?.appointments.map((item) => item.id).sort(), ['latePacific', 'nextDay']);
  assert.deepEqual(detail?.documents.map((item) => item.name), ['Agreement.pdf']);
  assert.equal(detail?.outstandingBalanceCents, 75_00);
});
