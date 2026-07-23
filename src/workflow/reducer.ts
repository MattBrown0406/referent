import type {
  CaseDocumentReference,
  ChecklistItem,
  LegacyImportRecord,
  Participant,
  PaymentEntry,
  WorkflowAppointment,
  WorkflowCase,
  WorkflowState,
  WorkflowTask,
} from './types';

type UpsertAction =
  | { type: 'case/upsert'; value: WorkflowCase }
  | { type: 'participant/upsert'; value: Participant }
  | { type: 'checklist/upsert'; value: ChecklistItem }
  | { type: 'document/upsert'; value: CaseDocumentReference }
  | { type: 'task/upsert'; value: WorkflowTask }
  | { type: 'appointment/upsert'; value: WorkflowAppointment }
  | { type: 'payment/upsert'; value: PaymentEntry }
  | { type: 'import/upsert'; value: LegacyImportRecord };

type RemoveAction = {
  type:
    | 'case/remove'
    | 'participant/remove'
    | 'checklist/remove'
    | 'document/remove'
    | 'task/remove'
    | 'appointment/remove'
    | 'payment/remove';
  id: string;
};

export type WorkflowAction =
  | UpsertAction
  | RemoveAction
  | { type: 'case/archive' | 'case/restore'; id: string; at: string }
  | { type: 'task/complete' | 'task/reopen'; id: string; at: string }
  | { type: 'checklist/complete' | 'checklist/reopen'; id: string; at: string };

function upsert<T extends { id: string }>(records: Record<string, T>, value: T): Record<string, T> {
  return { ...records, [value.id]: value };
}

function remove<T>(records: Record<string, T>, id: string): Record<string, T> {
  if (!(id in records)) return records;
  const next = { ...records };
  delete next[id];
  return next;
}

export function workflowReducer(state: WorkflowState, action: WorkflowAction): WorkflowState {
  switch (action.type) {
    case 'case/upsert': return { ...state, cases: upsert(state.cases, action.value) };
    case 'participant/upsert': return { ...state, participants: upsert(state.participants, action.value) };
    case 'checklist/upsert': return { ...state, checklistItems: upsert(state.checklistItems, action.value) };
    case 'document/upsert': return { ...state, documents: upsert(state.documents, action.value) };
    case 'task/upsert': return { ...state, tasks: upsert(state.tasks, action.value) };
    case 'appointment/upsert': return { ...state, appointments: upsert(state.appointments, action.value) };
    case 'payment/upsert': return { ...state, payments: upsert(state.payments, action.value) };
    case 'import/upsert': return { ...state, imports: upsert(state.imports, action.value) };
    case 'case/remove': return { ...state, cases: remove(state.cases, action.id) };
    case 'participant/remove': return { ...state, participants: remove(state.participants, action.id) };
    case 'checklist/remove': return { ...state, checklistItems: remove(state.checklistItems, action.id) };
    case 'document/remove': return { ...state, documents: remove(state.documents, action.id) };
    case 'task/remove': return { ...state, tasks: remove(state.tasks, action.id) };
    case 'appointment/remove': return { ...state, appointments: remove(state.appointments, action.id) };
    case 'payment/remove': return { ...state, payments: remove(state.payments, action.id) };
    case 'case/archive':
    case 'case/restore': {
      const current = state.cases[action.id];
      if (!current) return state;
      const archivedAt = action.type === 'case/archive' ? action.at : null;
      return {
        ...state,
        cases: upsert(state.cases, { ...current, archivedAt, updatedAt: action.at }),
      };
    }
    case 'task/complete':
    case 'task/reopen': {
      const current = state.tasks[action.id];
      if (!current) return state;
      const completedAt = action.type === 'task/complete' ? action.at : null;
      return {
        ...state,
        tasks: upsert(state.tasks, { ...current, completedAt, updatedAt: action.at }),
      };
    }
    case 'checklist/complete':
    case 'checklist/reopen': {
      const current = state.checklistItems[action.id];
      if (!current) return state;
      const completedAt = action.type === 'checklist/complete' ? action.at : null;
      return {
        ...state,
        checklistItems: upsert(state.checklistItems, { ...current, completedAt }),
      };
    }
  }
}
