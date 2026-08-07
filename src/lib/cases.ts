import { decode } from 'base64-arraybuffer';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';

import { StoreError } from './errors';
import { currentAuthSessionIdentity, type AuthSessionIdentity } from './auth-session';
import { phoneSearchSuffix } from './phone';
import { supabase } from './supabase';
import type { FollowUp } from './store';

// ─── Types ──────────────────────────────────────────────────────────────────

export type CaseStatus =
  | 'inquiry'
  | 'consult'
  | 'deciding'
  | 'engaged'
  | 'intervention'
  | 'placed'
  | 'aftercare'
  | 'closed'
  | 'lost';

export type PaymentStatus = 'none' | 'quoted' | 'deposit' | 'paid' | 'partial' | 'refunded';

export type CaseEventKind =
  | 'call'
  | 'text'
  | 'email'
  | 'meeting'
  | 'note'
  | 'voice_note'
  | 'status_change'
  | 'payment'
  | 'referral'
  | 'document'
  | 'system';

export type CaseRecord = {
  id: string;
  title: string;
  status: CaseStatus;
  summary: string;
  leadSource: string;
  leadSourceDetail: string;
  lostReason: string;
  stageChangedAt: string;
  paymentStatus: PaymentStatus;
  quotedAmount: number | null;
  paidAmount: number;
  matchProfileId?: string;
  createdAt: string; // ISO timestamptz
  updatedAt: string; // ISO timestamptz
};

export type CaseContact = {
  id: string;
  caseId: string;
  name: string;
  relationship: string;
  phone: string;
  // phone_e164 is GENERATED ALWAYS … STORED on the server — never written.
  email: string;
  isPrimary: boolean;
  note: string;
};

export type CaseEvent = {
  id: string;
  caseId: string;
  kind: CaseEventKind;
  body: string;
  contactId?: string;
  referralId?: string;
  documentId?: string;
  occurredAt: string; // ISO timestamptz
};

export type CaseDocument = {
  id: string;
  caseId: string;
  label: string;
  storagePath: string; // {owner_id}/{case_id}/{uuid}.{ext} in bucket case-documents
  mimeType: string;
  sizeBytes: number | null;
  createdAt: string;
};

export type CaseSearchResult = { caseId: string; matchedBy: 'title' | 'contact' | 'phone' };

// Closed and lost cases drop out of the active list and briefing count.
export const CLOSED_CASE_STATUSES: CaseStatus[] = ['closed', 'lost'];

export function isOpenCase(record: CaseRecord): boolean {
  return !CLOSED_CASE_STATUSES.includes(record.status);
}

// ─── Row ↔ app-type mapping (snake_case DB ↔ camelCase app) ─────────────────

type CaseRow = {
  id: string;
  title: string;
  status: CaseStatus;
  summary: string | null;
  lead_source: string | null;
  lead_source_detail: string | null;
  lost_reason: string | null;
  stage_changed_at: string | null;
  payment_status: PaymentStatus;
  quoted_amount: number | null;
  paid_amount: number | null;
  match_profile_id: string | null;
  created_at: string;
  updated_at: string;
};

type CaseContactRow = {
  id: string;
  case_id: string;
  name: string;
  relationship: string | null;
  phone: string | null;
  email: string | null;
  is_primary: boolean | null;
  note: string | null;
};

type CaseEventRow = {
  id: string;
  case_id: string;
  kind: CaseEventKind;
  body: string | null;
  contact_id: string | null;
  referral_id: string | null;
  document_id: string | null;
  occurred_at: string;
};

type CaseDocumentRow = {
  id: string;
  case_id: string;
  label: string;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number | null;
  created_at: string;
};

function mapCaseRow(row: CaseRow): CaseRecord {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    summary: row.summary || '',
    leadSource: row.lead_source || 'Unspecified',
    leadSourceDetail: row.lead_source_detail || '',
    lostReason: row.lost_reason || '',
    stageChangedAt: row.stage_changed_at || row.created_at,
    paymentStatus: row.payment_status,
    quotedAmount: row.quoted_amount,
    paidAmount: row.paid_amount ?? 0,
    matchProfileId: row.match_profile_id || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapContactRow(row: CaseContactRow): CaseContact {
  return {
    id: row.id,
    caseId: row.case_id,
    name: row.name,
    relationship: row.relationship || '',
    phone: row.phone || '',
    email: row.email || '',
    isPrimary: Boolean(row.is_primary),
    note: row.note || '',
  };
}

function mapEventRow(row: CaseEventRow): CaseEvent {
  return {
    id: row.id,
    caseId: row.case_id,
    kind: row.kind,
    body: row.body || '',
    contactId: row.contact_id || undefined,
    referralId: row.referral_id || undefined,
    documentId: row.document_id || undefined,
    occurredAt: row.occurred_at,
  };
}

function mapDocumentRow(row: CaseDocumentRow): CaseDocument {
  return {
    id: row.id,
    caseId: row.case_id,
    label: row.label,
    storagePath: row.storage_path,
    mimeType: row.mime_type || '',
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
  };
}

function caseToRow(record: CaseRecord): Record<string, unknown> {
  return {
    id: record.id,
    title: record.title,
    status: record.status,
    summary: record.summary,
    lead_source: record.leadSource,
    lead_source_detail: record.leadSourceDetail,
    lost_reason: record.lostReason,
    payment_status: record.paymentStatus,
    quoted_amount: record.quotedAmount,
    paid_amount: record.paidAmount,
    match_profile_id: record.matchProfileId ?? null,
  };
}

function contactToRow(contact: CaseContact): Record<string, unknown> {
  // phone_e164 deliberately omitted — GENERATED ALWAYS column.
  return {
    id: contact.id,
    case_id: contact.caseId,
    name: contact.name,
    relationship: contact.relationship,
    phone: contact.phone,
    email: contact.email,
    is_primary: contact.isPrimary,
    note: contact.note,
  };
}

function eventToRow(event: CaseEvent): Record<string, unknown> {
  return {
    id: event.id,
    case_id: event.caseId,
    kind: event.kind,
    body: event.body,
    contact_id: event.contactId ?? null,
    referral_id: event.referralId ?? null,
    document_id: event.documentId ?? null,
    occurred_at: event.occurredAt,
  };
}

function followUpToRpcRow(followUp: FollowUp): Record<string, unknown> {
  return {
    id: followUp.id,
    partner_id: followUp.partnerId ?? null,
    referral_id: followUp.referralId ?? null,
    case_id: followUp.caseId ?? null,
    title: followUp.title,
    due_on: followUp.dueOn,
    status: followUp.status,
    completed_at: followUp.completedAt ?? null,
    note: followUp.note,
    kind: followUp.kind,
    due_time: followUp.dueTime ?? null,
    waiting_on: followUp.waitingOn ?? null,
    snoozed_until: followUp.snoozedUntil ?? null,
  };
}

function documentToRow(document: CaseDocument): Record<string, unknown> {
  return {
    id: document.id,
    case_id: document.caseId,
    label: document.label,
    storage_path: document.storagePath,
    mime_type: document.mimeType,
    size_bytes: document.sizeBytes,
  };
}

// ─── Read path ──────────────────────────────────────────────────────────────

export type CaseFileData = {
  cases: CaseRecord[];
  caseContacts: CaseContact[];
  caseEvents: CaseEvent[];
  caseDocuments: CaseDocument[];
};

type CaseAccountFence = AuthSessionIdentity;

async function currentCaseAccount(): Promise<CaseAccountFence> {
  const identity = await currentAuthSessionIdentity();
  if (!identity) throw new StoreError('No authenticated account is available for this case operation.', false);
  return identity;
}

async function assertCaseAccount(expected: CaseAccountFence): Promise<void> {
  try {
    const current = await currentCaseAccount();
    if (current.userId === expected.userId && current.sessionId === expected.sessionId) return;
  } catch {
    // Normalize sign-out/session replacement into the same stale-operation error.
  }
  throw new StoreError('Account changed before the case operation completed.', false);
}

async function withStableCaseAccount<T>(operation: (userId: string) => Promise<T>): Promise<T> {
  const fence = await currentCaseAccount();
  try {
    const result = await operation(fence.userId);
    await assertCaseAccount(fence);
    return result;
  } catch (error) {
    await assertCaseAccount(fence);
    throw error;
  }
}

export async function fetchCaseData(): Promise<CaseFileData> {
  return withStableCaseAccount(async (userId) => {
    const [casesRes, contactsRes, eventsRes, documentsRes] = await Promise.all([
      supabase.from('cases').select('*').eq('owner_id', userId).order('updated_at', { ascending: false }),
      supabase.from('case_contacts').select('*').eq('owner_id', userId).order('created_at', { ascending: true }),
      supabase.from('case_events').select('*').eq('owner_id', userId).order('occurred_at', { ascending: false }),
      supabase.from('case_documents').select('*').eq('owner_id', userId).order('created_at', { ascending: true }),
    ]);
    const firstError = casesRes.error || contactsRes.error || eventsRes.error || documentsRes.error;
    if (firstError) throw firstError;
    return {
      cases: ((casesRes.data || []) as CaseRow[]).map(mapCaseRow),
      caseContacts: ((contactsRes.data || []) as CaseContactRow[]).map(mapContactRow),
      caseEvents: ((eventsRes.data || []) as CaseEventRow[]).map(mapEventRow),
      caseDocuments: ((documentsRes.data || []) as CaseDocumentRow[]).map(mapDocumentRow),
    };
  });
}

// ─── The "14 months ago" lookup ─────────────────────────────────────────────
// One ilike .or() per table; phone uses a trailing-% suffix match (PostgREST
// has no endsWith, and the generated phone_e164 column is indexed). Rows are
// de-duplicated and classified client-side by the caller.

function escapeIlike(value: string): string {
  return value.replace(/[%_\\]/g, (char) => `\\${char}`);
}

export async function searchCases(query: string): Promise<CaseSearchResult[]> {
  const fence = await currentCaseAccount();
  const userId = fence.userId;
  const text = query.trim();
  const suffix = phoneSearchSuffix(text);
  const textPattern = `%${escapeIlike(text)}%`;
  const requests: PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>[] = [];
  if (text) {
    requests.push(supabase.from('cases').select('id').eq('owner_id', userId).or(`title.ilike.${textPattern}`));
    requests.push(supabase.from('case_contacts').select('case_id').eq('owner_id', userId).or(`name.ilike.${textPattern}`));
  }
  if (suffix) {
    requests.push(supabase.from('case_contacts').select('case_id').eq('owner_id', userId).or(`phone_e164.ilike.${suffix}`));
  }
  if (!requests.length) return [];
  const [titleRes, nameRes, phoneRes] = await Promise.all(requests);
  const firstError = titleRes?.error || nameRes?.error || phoneRes?.error;
  if (firstError) throw new StoreError(firstError.message, false);

  const results = new Map<string, CaseSearchResult>();
  for (const row of ((titleRes?.data || []) as { id: string }[])) {
    results.set(row.id, { caseId: row.id, matchedBy: 'title' });
  }
  for (const row of ((nameRes?.data || []) as { case_id: string }[])) {
    if (!results.has(row.case_id)) results.set(row.case_id, { caseId: row.case_id, matchedBy: 'contact' });
  }
  for (const row of ((phoneRes?.data || []) as { case_id: string }[])) {
    if (!results.has(row.case_id)) results.set(row.case_id, { caseId: row.case_id, matchedBy: 'phone' });
  }
  await assertCaseAccount(fence);
  return [...results.values()];
}

// ─── Write path ─────────────────────────────────────────────────────────────
// Case files are interaction data (timeline ordering matters), so writes go
// straight to the server and throw on failure instead of queueing offline.
// The caller applies the optimistic local update first and rolls back on
// error — no queue means no phantom timeline entries after a rejected write.

async function runOrThrow(execute: () => PromiseLike<{ error: { message: string } | null }>): Promise<void> {
  await withStableCaseAccount(async () => {
    const { error } = await execute();
    if (error) throw new StoreError(error.message, false);
  });
}

export async function createCase(record: CaseRecord, expectedUserId: string): Promise<void> {
  const row = { ...caseToRow(record), owner_id: expectedUserId };
  await runOrThrow(() => supabase.from('cases').insert(row));
}

// The case and its initial children are one user action. The matching RPC is a
// single Postgres transaction, so a failed contact or first-call insert cannot
// leave a ghost case behind on the server.
export async function createCaseBundle(
  record: CaseRecord,
  primaryContact: CaseContact | null,
  firstFollowUp: FollowUp | null,
  expectedUserId: string,
): Promise<void> {
  const followUpRow = firstFollowUp ? followUpToRpcRow(firstFollowUp) : null;
  await runOrThrow(() => supabase.rpc('create_case_bundle', {
    p_expected_owner_id: expectedUserId,
    p_case: caseToRow(record),
    p_contact: primaryContact ? contactToRow(primaryContact) : null,
    p_follow_up: followUpRow,
  }));
}

export type RecordedCasePayment = {
  paidAmount: number;
  paymentStatus: PaymentStatus;
  occurredAt: string;
  eventBody: string;
};

export type CasePaymentPatch = Partial<Pick<CaseRecord, 'paymentStatus' | 'quotedAmount' | 'paidAmount'>>;

export type CorrectedCasePayment = RecordedCasePayment & {
  quotedAmount: number | null;
};

export async function recordCasePayment(
  caseId: string,
  eventId: string,
  amount: number,
  note: string,
): Promise<RecordedCasePayment> {
  return withStableCaseAccount(async () => {
    const { data, error } = await supabase.rpc('record_case_payment', {
      p_case_id: caseId,
      p_event_id: eventId,
      p_amount: amount,
      p_note: note,
    });
    if (error) throw new StoreError(error.message, false);
    const row = (Array.isArray(data) ? data[0] : data) as {
      paid_amount?: unknown;
      payment_status?: unknown;
      occurred_at?: unknown;
      event_body?: unknown;
    } | null;
    if (!row || typeof row.paid_amount !== 'number' || typeof row.payment_status !== 'string'
      || typeof row.occurred_at !== 'string' || typeof row.event_body !== 'string') {
      throw new StoreError('The payment was saved but its confirmed total could not be read. Refresh the case before adding another payment.', false);
    }
    return {
      paidAmount: row.paid_amount,
      paymentStatus: row.payment_status as PaymentStatus,
      occurredAt: row.occurred_at,
      eventBody: row.event_body,
    };
  });
}

export async function updateCasePaymentWithEvent(
  caseId: string,
  eventId: string,
  patch: CasePaymentPatch,
): Promise<CorrectedCasePayment> {
  return withStableCaseAccount(async () => {
    const rpcPatch: Record<string, unknown> = {};
    if ('paymentStatus' in patch) rpcPatch.payment_status = patch.paymentStatus;
    if ('quotedAmount' in patch) rpcPatch.quoted_amount = patch.quotedAmount;
    if ('paidAmount' in patch) rpcPatch.paid_amount = patch.paidAmount;
    const { data, error } = await supabase.rpc('update_case_payment_with_event', {
      p_case_id: caseId,
      p_event_id: eventId,
      p_patch: rpcPatch,
    });
    if (error) throw new StoreError(error.message, false);
    const row = (Array.isArray(data) ? data[0] : data) as {
      paid_amount?: unknown;
      payment_status?: unknown;
      quoted_amount?: unknown;
      occurred_at?: unknown;
      event_body?: unknown;
    } | null;
    if (!row || typeof row.paid_amount !== 'number' || typeof row.payment_status !== 'string'
      || typeof row.occurred_at !== 'string' || typeof row.event_body !== 'string') {
      throw new StoreError('The payment update was saved but its confirmed values could not be read. Refresh the case before editing payment details again.', false);
    }
    return {
      paidAmount: row.paid_amount,
      paymentStatus: row.payment_status as PaymentStatus,
      quotedAmount: row.quoted_amount == null ? null : Number(row.quoted_amount),
      occurredAt: row.occurred_at,
      eventBody: row.event_body,
    };
  });
}

export type CaseDetailsPatch = Partial<Pick<CaseRecord, 'title' | 'summary'>>;

export type UpdatedCaseDetails = {
  title: string;
  summary: string;
  occurredAt: string;
  eventBody: string;
};

export async function updateCaseDetailsWithEvent(
  caseId: string,
  eventId: string,
  patch: CaseDetailsPatch,
  eventBody: string,
): Promise<UpdatedCaseDetails> {
  return withStableCaseAccount(async () => {
    const { data, error } = await supabase.rpc('update_case_details_with_event', {
      p_case_id: caseId,
      p_event_id: eventId,
      p_patch: patch,
      p_event_body: eventBody,
    });
    if (error) throw new StoreError(error.message, false);
    const row = (Array.isArray(data) ? data[0] : data) as {
      title?: unknown;
      summary?: unknown;
      occurred_at?: unknown;
      event_body?: unknown;
    } | null;
    if (!row || typeof row.title !== 'string' || typeof row.summary !== 'string'
      || typeof row.occurred_at !== 'string' || typeof row.event_body !== 'string') {
      throw new StoreError('The case details were saved but their confirmed values could not be read. Refresh the case before editing again.', false);
    }
    return {
      title: row.title,
      summary: row.summary,
      occurredAt: row.occurred_at,
      eventBody: row.event_body,
    };
  });
}

export type CaseBusinessDetailsPatch = Partial<Pick<CaseRecord, 'leadSource' | 'leadSourceDetail' | 'lostReason'>>;

export type UpdatedCaseBusinessDetails = {
  leadSource: string;
  leadSourceDetail: string;
  lostReason: string;
  occurredAt: string;
  eventBody: string;
};

export async function updateCaseBusinessDetailsWithEvent(
  caseId: string,
  eventId: string,
  patch: CaseBusinessDetailsPatch,
  eventBody: string,
): Promise<UpdatedCaseBusinessDetails> {
  return withStableCaseAccount(async () => {
    const rpcPatch: Record<string, unknown> = {};
    if ('leadSource' in patch) rpcPatch.lead_source = patch.leadSource;
    if ('leadSourceDetail' in patch) rpcPatch.lead_source_detail = patch.leadSourceDetail;
    if ('lostReason' in patch) rpcPatch.lost_reason = patch.lostReason;
    const { data, error } = await supabase.rpc('update_case_business_details_with_event', {
      p_case_id: caseId,
      p_event_id: eventId,
      p_patch: rpcPatch,
      p_event_body: eventBody,
    });
    if (error) throw new StoreError(error.message, false);
    const row = (Array.isArray(data) ? data[0] : data) as {
      lead_source?: unknown;
      lead_source_detail?: unknown;
      lost_reason?: unknown;
      occurred_at?: unknown;
      event_body?: unknown;
    } | null;
    if (!row || typeof row.lead_source !== 'string' || typeof row.lead_source_detail !== 'string'
      || typeof row.lost_reason !== 'string' || typeof row.occurred_at !== 'string'
      || typeof row.event_body !== 'string') {
      throw new StoreError('The business details were saved but their confirmed values could not be read. Refresh the case before editing again.', false);
    }
    return {
      leadSource: row.lead_source,
      leadSourceDetail: row.lead_source_detail,
      lostReason: row.lost_reason,
      occurredAt: row.occurred_at,
      eventBody: row.event_body,
    };
  });
}

export async function updateCase(record: CaseRecord): Promise<void> {
  await runOrThrow(() => supabase.from('cases').update({
    summary: record.summary,
    updated_at: new Date().toISOString(),
  }).eq('id', record.id));
}

export async function updateCaseWithEvent(record: CaseRecord, event: CaseEvent): Promise<void> {
  await runOrThrow(() => supabase.rpc('update_case_with_event', {
    p_case: caseToRow(record),
    p_event: eventToRow(event),
  }));
}

export async function completeFollowUpWithCase(
  completed: FollowUp,
  record: CaseRecord,
  event: CaseEvent,
  applyStatus = true,
): Promise<void> {
  await runOrThrow(() => supabase.rpc('complete_follow_up_with_case', {
    p_completed: followUpToRpcRow(completed),
    p_case: { ...caseToRow(record), apply_status: applyStatus },
    p_event: eventToRow(event),
  }));
}

export async function saveContactAtomic(contact: CaseContact): Promise<void> {
  await runOrThrow(() => supabase.rpc('save_case_contact', { p_contact: contactToRow(contact) }));
}

export async function createContact(contact: CaseContact): Promise<void> {
  const row = contactToRow(contact);
  await runOrThrow(() => supabase.from('case_contacts').insert(row));
}

export async function updateContact(contact: CaseContact): Promise<void> {
  const row = contactToRow(contact);
  const { id, ...patch } = row;
  await runOrThrow(() => supabase.from('case_contacts').update(patch).eq('id', contact.id));
}

export async function deleteContact(id: string): Promise<void> {
  await runOrThrow(() => supabase.from('case_contacts').delete().eq('id', id));
}

export async function createEvent(event: CaseEvent): Promise<void> {
  const row = eventToRow(event);
  await runOrThrow(() => supabase.from('case_events').insert(row));
}

// Timeline convenience: build + insert an event for a case in one call.
export async function logCaseEvent(
  caseId: string,
  kind: CaseEventKind,
  body: string,
  links: { contactId?: string; referralId?: string; documentId?: string } = {},
  id?: string,
): Promise<CaseEvent> {
  const event: CaseEvent = {
    id: id || uuidish(),
    caseId,
    kind,
    body,
    contactId: links.contactId,
    referralId: links.referralId,
    documentId: links.documentId,
    occurredAt: new Date().toISOString(),
  };
  await createEvent(event);
  return event;
}

export async function createDocumentRow(document: CaseDocument): Promise<void> {
  const row = documentToRow(document);
  await runOrThrow(() => supabase.from('case_documents').insert(row));
}

export async function saveDocumentWithEvent(document: CaseDocument, event: CaseEvent): Promise<void> {
  await runOrThrow(() => supabase.rpc('save_case_document_with_event', {
    p_document: documentToRow(document),
    p_event: eventToRow(event),
  }));
}

export async function deleteDocumentRow(id: string): Promise<void> {
  await runOrThrow(() => supabase.from('case_documents').delete().eq('id', id));
}

export async function restoreDocumentRow(document: CaseDocument, eventIds: string[] = []): Promise<void> {
  await runOrThrow(() => supabase.rpc('restore_case_document', {
    p_document: documentToRow(document),
    p_event_ids: eventIds,
  }));
}

// ─── Storage — private bucket 'case-documents', signed URLs only ────────────

const BUCKET = 'case-documents';

export type UploadCaseFileInput = {
  ownerId: string;
  caseId: string;
  documentId: string; // uuid used for both the row id and the object name
  localUri: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number | null;
};

// Path convention (matches the storage RLS policies): {owner}/{case}/{uuid}.{ext}
function sanitizeExt(fileName: string, mimeType: string): string {
  const fromName = (fileName.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (fromName && fromName.length <= 5) return fromName;
  const fromMime = (mimeType.split('/').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return fromMime || 'bin';
}

function uuidish(): string {
  return Crypto.randomUUID();
}

export function newDocumentId(): string {
  return uuidish();
}

/** Client-generated primary key for any table (all PKs are Postgres uuid). */
export function newUuid(): string {
  return uuidish();
}

// Read the picked file as base64 (the legacy FileSystem API — the new
// expo-file-system File API isn't needed for a straight upload) and upload to
// the PRIVATE bucket. Never uses public URLs. Web fallback: fetch the blob
// URL the picker returns and read it as base64 (no FileSystem on web).
async function readAsBase64(localUri: string): Promise<string> {
  if (localUri.startsWith('blob:') || localUri.startsWith('data:')) {
    const response = await fetch(localUri);
    const buffer = await response.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
    return btoa(binary);
  }
  return FileSystem.readAsStringAsync(localUri, { encoding: 'base64' });
}

export async function uploadCaseFile(input: UploadCaseFileInput): Promise<{ storagePath: string }> {
  return withStableCaseAccount(async (userId) => {
  if (input.ownerId !== userId) throw new StoreError('The document owner does not match the active account.', false);
  const storagePath = `${input.ownerId}/${input.caseId}/${input.documentId}.${sanitizeExt(input.fileName, input.mimeType)}`;
  const base64 = await readAsBase64(input.localUri);
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, decode(base64), { contentType: input.mimeType, upsert: false });
  if (error) throw new StoreError(error.message, false);
  return { storagePath };
  });
}

// 60-second signed URL for viewing. The URL expires; the row never stores it.
export async function createCaseFileSignedUrl(storagePath: string): Promise<string> {
  return withStableCaseAccount(async () => {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, 60);
  if (error || !data?.signedUrl) throw new StoreError(error?.message || 'Could not sign the file URL', false);
  return data.signedUrl;
  });
}

export async function removeCaseFile(storagePath: string): Promise<void> {
  await withStableCaseAccount(async () => {
  const { error } = await supabase.storage.from(BUCKET).remove([storagePath]);
  if (error) throw new StoreError(error.message, false);
  });
}
