import { decode } from 'base64-arraybuffer';
import * as FileSystem from 'expo-file-system/legacy';

import { phoneSearchSuffix } from './phone';
import { supabase } from './supabase';
import { StoreError } from './store';

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

export async function fetchCaseData(): Promise<CaseFileData> {
  const [casesRes, contactsRes, eventsRes, documentsRes] = await Promise.all([
    supabase.from('cases').select('*').order('updated_at', { ascending: false }),
    supabase.from('case_contacts').select('*').order('created_at', { ascending: true }),
    supabase.from('case_events').select('*').order('occurred_at', { ascending: false }),
    supabase.from('case_documents').select('*').order('created_at', { ascending: true }),
  ]);
  const firstError = casesRes.error || contactsRes.error || eventsRes.error || documentsRes.error;
  if (firstError) throw firstError;
  return {
    cases: ((casesRes.data || []) as CaseRow[]).map(mapCaseRow),
    caseContacts: ((contactsRes.data || []) as CaseContactRow[]).map(mapContactRow),
    caseEvents: ((eventsRes.data || []) as CaseEventRow[]).map(mapEventRow),
    caseDocuments: ((documentsRes.data || []) as CaseDocumentRow[]).map(mapDocumentRow),
  };
}

// ─── The "14 months ago" lookup ─────────────────────────────────────────────
// One ilike .or() per table; phone uses a trailing-% suffix match (PostgREST
// has no endsWith, and the generated phone_e164 column is indexed). Rows are
// de-duplicated and classified client-side by the caller.

function escapeIlike(value: string): string {
  return value.replace(/[%_\\]/g, (char) => `\\${char}`);
}

export async function searchCases(query: string): Promise<CaseSearchResult[]> {
  const text = query.trim();
  const suffix = phoneSearchSuffix(text);
  const textPattern = `%${escapeIlike(text)}%`;
  const requests: PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>[] = [];
  if (text) {
    requests.push(supabase.from('cases').select('id').or(`title.ilike.${textPattern}`));
    requests.push(supabase.from('case_contacts').select('case_id').or(`name.ilike.${textPattern}`));
  }
  if (suffix) {
    requests.push(supabase.from('case_contacts').select('case_id').or(`phone_e164.ilike.${suffix}`));
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
  return [...results.values()];
}

// ─── Write path ─────────────────────────────────────────────────────────────
// Case files are interaction data (timeline ordering matters), so writes go
// straight to the server and throw on failure instead of queueing offline.
// The caller applies the optimistic local update first and rolls back on
// error — no queue means no phantom timeline entries after a rejected write.

async function runOrThrow(execute: () => PromiseLike<{ error: { message: string } | null }>): Promise<void> {
  const { error } = await execute();
  if (error) throw new StoreError(error.message, false);
}

export async function createCase(record: CaseRecord): Promise<void> {
  const row = caseToRow(record);
  await runOrThrow(() => supabase.from('cases').insert(row));
}

export async function updateCase(record: CaseRecord): Promise<void> {
  const row = caseToRow(record);
  const { id, ...patch } = row;
  await runOrThrow(() => supabase.from('cases').update(patch).eq('id', record.id));
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

export async function deleteDocumentRow(id: string): Promise<void> {
  await runOrThrow(() => supabase.from('case_documents').delete().eq('id', id));
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
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const rand = Math.floor(Math.random() * 16);
    return (char === 'x' ? rand : (rand & 0x3) | 0x8).toString(16);
  });
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
  const storagePath = `${input.ownerId}/${input.caseId}/${input.documentId}.${sanitizeExt(input.fileName, input.mimeType)}`;
  const base64 = await readAsBase64(input.localUri);
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, decode(base64), { contentType: input.mimeType, upsert: false });
  if (error) throw new StoreError(error.message, false);
  return { storagePath };
}

// 60-second signed URL for viewing. The URL expires; the row never stores it.
export async function createCaseFileSignedUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, 60);
  if (error || !data?.signedUrl) throw new StoreError(error?.message || 'Could not sign the file URL', false);
  return data.signedUrl;
}

export async function removeCaseFile(storagePath: string): Promise<void> {
  const { error } = await supabase.storage.from(BUCKET).remove([storagePath]);
  if (error) throw new StoreError(error.message, false);
}
