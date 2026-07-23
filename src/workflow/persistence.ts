import type { SchemaV3Envelope, WorkflowRecord } from '../domain/types';
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

type Row = Record<string, unknown>;

const isRecord = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasString = (row: Row, key: string) => typeof row[key] === 'string' && (row[key] as string).trim().length > 0;
const optionalString = (row: Row, key: string) => row[key] === undefined || typeof row[key] === 'string';
const isCanonicalInstant = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
};
const nullableInstant = (row: Row, key: string) => row[key] === null || isCanonicalInstant(row[key]);
const optionalNullableInstant = (row: Row, key: string) => row[key] === undefined || nullableInstant(row, key);
const isDateOnly = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const optionalDateOnly = (row: Row, key: string) => row[key] === undefined || isDateOnly(row[key]);
const isIanaTimeZone = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value.trim()) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0)); return true; } catch { return false; }
};

function indexRows<T>(label: string, rows: WorkflowRecord[], validate: (row: Row) => boolean): Record<string, T> {
  const indexed: Record<string, T> = {};
  for (const value of rows) {
    if (!isRecord(value) || !hasString(value, 'id') || !validate(value)) {
      throw new Error(`Stored workflow ${label} contains an invalid record. Saving is disabled until it is recovered.`);
    }
    const id = value.id as string;
    if (indexed[id]) throw new Error(`Stored workflow ${label} contains duplicate id "${id}".`);
    indexed[id] = value as T;
  }
  return indexed;
}

export function workflowStateFromEnvelope(envelope: SchemaV3Envelope): WorkflowState {
  return {
    cases: indexRows<WorkflowCase>('cases', envelope.cases, (row) =>
      hasString(row, 'name')
      && ['intervention', 'coaching'].includes(String(row.kind))
      && ['new', 'engaged', 'preparing', 'scheduled', 'completed', 'closed'].includes(String(row.status))
      && optionalNullableInstant(row, 'archivedAt')
      && ['referralId', 'referralMatchId', 'placementPartnerId', 'identifiedPatientName', 'primarySubstance', 'contact', 'notes', 'focus'].every((key) => optionalString(row, key))
      && isCanonicalInstant(row.createdAt)
      && isCanonicalInstant(row.updatedAt)),
    participants: indexRows<Participant>('participants', envelope.participants, (row) =>
      hasString(row, 'caseId') && hasString(row, 'name') && ['role', 'phone', 'email', 'notes'].every((key) => optionalString(row, key))),
    checklistItems: indexRows<ChecklistItem>('checklist items', envelope.checklistCompletions, (row) =>
      hasString(row, 'caseId') && hasString(row, 'key') && hasString(row, 'label') && nullableInstant(row, 'completedAt')),
    documents: indexRows<CaseDocumentReference>('document references', envelope.documentReferences, (row) =>
      hasString(row, 'caseId') && hasString(row, 'name') && (row.uri === undefined || (typeof row.uri === 'string' && row.uri.startsWith('file://')))
      && optionalString(row, 'mimeType')
      && (row.size === undefined || (typeof row.size === 'number' && Number.isFinite(row.size) && row.size >= 0))),
    tasks: indexRows<WorkflowTask>('tasks', envelope.tasks, (row) =>
      hasString(row, 'title') && optionalString(row, 'caseId') && optionalDateOnly(row, 'dueDate') && optionalString(row, 'note')
      && nullableInstant(row, 'completedAt') && isCanonicalInstant(row.createdAt) && isCanonicalInstant(row.updatedAt)),
    appointments: indexRows<WorkflowAppointment>('appointments', envelope.appointments, (row) =>
      hasString(row, 'title') && optionalString(row, 'caseId') && isCanonicalInstant(row.startsAt) && isCanonicalInstant(row.endsAt)
      && Date.parse(row.endsAt as string) > Date.parse(row.startsAt as string) && isIanaTimeZone(row.timeZone)
      && optionalString(row, 'note') && isCanonicalInstant(row.createdAt) && isCanonicalInstant(row.updatedAt)),
    payments: indexRows<PaymentEntry>('payments', envelope.revenueEntries, (row) =>
      hasString(row, 'caseId') && typeof row.amountCents === 'number' && Number.isSafeInteger(row.amountCents) && row.amountCents >= 0
      && ['pending', 'received'].includes(String(row.status)) && isDateOnly(row.effectiveDate) && optionalString(row, 'note')),
    imports: indexRows<LegacyImportRecord>('import records', envelope.workflowImports, (row) =>
      hasString(row, 'sourceId') && hasString(row, 'fingerprint') && isCanonicalInstant(row.importedAt)),
  };
}

export function workflowCollectionsFromState(state: WorkflowState): Pick<
  SchemaV3Envelope,
  'cases' | 'participants' | 'checklistCompletions' | 'documentReferences' | 'tasks' | 'appointments' | 'revenueEntries' | 'workflowImports'
> {
  return {
    cases: Object.values(state.cases) as unknown as WorkflowRecord[],
    participants: Object.values(state.participants) as unknown as WorkflowRecord[],
    checklistCompletions: Object.values(state.checklistItems) as unknown as WorkflowRecord[],
    documentReferences: Object.values(state.documents) as unknown as WorkflowRecord[],
    tasks: Object.values(state.tasks) as unknown as WorkflowRecord[],
    appointments: Object.values(state.appointments) as unknown as WorkflowRecord[],
    revenueEntries: Object.values(state.payments) as unknown as WorkflowRecord[],
    workflowImports: Object.values(state.imports) as unknown as WorkflowRecord[],
  };
}
