export type CaseKind = 'intervention' | 'coaching';
export type CaseStatus = 'new' | 'engaged' | 'preparing' | 'scheduled' | 'completed' | 'closed';
export type PaymentStatus = 'pending' | 'received';

export interface LegacyProvenance {
  sourceId: string;
  legacyId: string;
  importedAt: string;
}

export interface WorkflowCase {
  id: string;
  kind: CaseKind;
  name: string;
  status: CaseStatus;
  archivedAt: string | null;
  referralId?: string;
  referralMatchId?: string;
  placementPartnerId?: string;
  identifiedPatientName?: string;
  primarySubstance?: string;
  contact?: string;
  notes?: string;
  focus?: string;
  createdAt: string;
  updatedAt: string;
  legacy?: LegacyProvenance;
}

export interface Participant {
  id: string;
  caseId: string;
  name: string;
  role?: string;
  phone?: string;
  email?: string;
  notes?: string;
  legacy?: LegacyProvenance;
}

export interface ChecklistItem {
  id: string;
  caseId: string;
  key: string;
  label: string;
  completedAt: string | null;
  legacy?: LegacyProvenance;
}

/** A local document reference. Legacy imports may remain name-only; newly picked files include a durable app-local URI. */
export interface CaseDocumentReference {
  id: string;
  caseId: string;
  name: string;
  uri?: string;
  mimeType?: string;
  size?: number;
  legacy?: LegacyProvenance;
}

export interface WorkflowTask {
  id: string;
  caseId?: string;
  title: string;
  dueDate?: string;
  note?: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  legacy?: LegacyProvenance;
}

export interface WorkflowAppointment {
  id: string;
  caseId?: string;
  title: string;
  /** Canonical UTC ISO-8601 instant. */
  startsAt: string;
  /** Canonical UTC ISO-8601 instant. */
  endsAt: string;
  /** IANA timezone used to present the appointment. */
  timeZone: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
  legacy?: LegacyProvenance;
}

export interface PaymentEntry {
  id: string;
  caseId: string;
  amountCents: number;
  status: PaymentStatus;
  /** Calendar date (YYYY-MM-DD) on which revenue or receivable is effective. */
  effectiveDate: string;
  note?: string;
  legacy?: LegacyProvenance;
}

export interface LegacyImportRecord {
  id: string;
  sourceId: string;
  fingerprint: string;
  importedAt: string;
}

export interface WorkflowState {
  cases: Record<string, WorkflowCase>;
  participants: Record<string, Participant>;
  checklistItems: Record<string, ChecklistItem>;
  documents: Record<string, CaseDocumentReference>;
  tasks: Record<string, WorkflowTask>;
  appointments: Record<string, WorkflowAppointment>;
  payments: Record<string, PaymentEntry>;
  imports: Record<string, LegacyImportRecord>;
}

export interface CaseDetail {
  case: WorkflowCase;
  participants: Participant[];
  checklistItems: ChecklistItem[];
  documents: CaseDocumentReference[];
  tasks: WorkflowTask[];
  appointments: WorkflowAppointment[];
  payments: PaymentEntry[];
  outstandingBalanceCents: number;
}
