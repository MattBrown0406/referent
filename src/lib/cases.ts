import { decode } from 'base64-arraybuffer';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';

import { StoreError } from './errors';
import { currentAuthSessionIdentity, type AuthSessionIdentity } from './auth-session';
import { fetchAllPages } from './paging';
import { phoneSearchSuffix } from './phone';
import { supabase } from './supabase';
import { memberIdLast4, type CaseBenefits, type PartnerPlanStatus, type SubscriberRelationship, type VobRequest, type VobStatus } from './insurance';
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
  // Lead capture (server-set, never written by the client). lead_captured_at
  // marks a case that arrived as a lead (New lead quick-add or the intake
  // link); first_touch_at is stamped by a trigger on the first logged call,
  // text, email, or meeting and never moves. Both feed speed-to-lead.
  firstTouchAt?: string; // ISO timestamptz
  leadCapturedAt?: string; // ISO timestamptz
  leadUrgency?: LeadUrgency;
  // Team basics: the workspace member this case is assigned to (optional).
  // Changed only through assignCase so the timeline records it.
  assignedTo?: string;
  createdAt: string; // ISO timestamptz
  updatedAt: string; // ISO timestamptz
};

export type LeadUrgency = 'none' | 'immediate_danger';

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
  // The member who did it. Stamped server-side from the signed-in user;
  // empty for automated entries (the intake link) and never sent by the app.
  actorId?: string;
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
  first_touch_at?: string | null;
  lead_captured_at?: string | null;
  lead_urgency?: string | null;
  assigned_to?: string | null;
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
  actor_id?: string | null;
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
    firstTouchAt: row.first_touch_at || undefined,
    leadCapturedAt: row.lead_captured_at || undefined,
    leadUrgency: row.lead_urgency === 'immediate_danger' ? 'immediate_danger' : undefined,
    assignedTo: row.assigned_to ? String(row.assigned_to).toLowerCase() : undefined,
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
    actorId: row.actor_id ? String(row.actor_id).toLowerCase() : undefined,
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

// The Cases tab: every case in the workspace plus every case contact, so each
// card can show the family's primary name and phone without opening the file.
export type CaseList = {
  cases: CaseRecord[];
  contacts: CaseContact[];
};

// One case file's lazy overlays, loaded when the file is opened (or refreshed
// while it is open). Contacts come from CaseList.
export type CaseFile = {
  events: CaseEvent[];
  documents: CaseDocument[];
};

type CaseAccountFence = AuthSessionIdentity & { orgId: string };

async function currentCaseAccount(): Promise<CaseAccountFence> {
  const identity = await currentAuthSessionIdentity();
  if (!identity) throw new StoreError('No authenticated account is available for this case operation.', false);
  const { data: orgId, error } = await supabase.rpc('current_org_id');
  if (error) throw new StoreError(error.message || 'The active workspace could not be verified.', false);
  if (typeof orgId !== 'string' || !orgId) throw new StoreError('No active workspace is available.', false);
  return { ...identity, orgId: orgId.toLowerCase() };
}

async function assertCaseAccount(expected: CaseAccountFence): Promise<void> {
  try {
    const current = await currentCaseAccount();
    if (current.userId === expected.userId && current.sessionId === expected.sessionId
        && current.orgId === expected.orgId) return;
  } catch {
    // Normalize sign-out/session replacement into the same stale-operation error.
  }
  throw new StoreError('Account changed before the case operation completed.', false);
}

// `operation` receives the acting user (attribution on inserts, storage folder)
// and the active workspace (org_id scope for reads); both are re-verified after
// the operation so an account or workspace switch mid-flight is rejected.
async function withStableCaseAccount<T>(operation: (userId: string, orgId: string) => Promise<T>): Promise<T> {
  const fence = await currentCaseAccount();
  try {
    const result = await operation(fence.userId, fence.orgId);
    await assertCaseAccount(fence);
    return result;
  } catch (error) {
    await assertCaseAccount(fence);
    throw error;
  }
}

// Case files belong to the workspace, not the row creator: every teammate sees
// (and works) every case in the org. RLS enforces the same boundary server-side.
//
// Up front: the case list and every case contact (a handful per case; the
// card's family name/phone line reads from them). The timeline and documents
// are per-case overlays fetched when a file is opened: case_events grows with
// every call, text and status change, and loading the whole workspace's
// timeline on launch and on every foreground is what does not scale.
//
// The list pages on the immutable created_at (plus id) and is re-sorted to
// the updated_at order the Cases tab shows, so a teammate's edit landing
// mid-fetch cannot shift a case across a page boundary.
export async function fetchCaseList(): Promise<CaseList> {
  return withStableCaseAccount(async (_userId, orgId) => {
    const [caseRows, contactRows] = await Promise.all([
      fetchAllPages<CaseRow>((from, to) => supabase.from('cases').select('*').eq('org_id', orgId).order('created_at', { ascending: false }).order('id').range(from, to)),
      fetchAllPages<CaseContactRow>((from, to) => supabase.from('case_contacts').select('*').eq('org_id', orgId).order('created_at', { ascending: true }).order('id').range(from, to)),
    ]);
    return {
      cases: caseRows.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(mapCaseRow),
      contacts: contactRows.map(mapContactRow),
    };
  });
}

// The open case file's timeline and documents, for one case only. The
// timeline is ordered newest-first by the server; the UI sorts again
// defensively.
export async function fetchCaseFile(caseId: string): Promise<CaseFile> {
  return withStableCaseAccount(async (_userId, orgId) => {
    const [eventRows, documentRows] = await Promise.all([
      fetchAllPages<CaseEventRow>((from, to) => supabase.from('case_events').select('*').eq('org_id', orgId).eq('case_id', caseId).order('occurred_at', { ascending: false }).order('id').range(from, to)),
      fetchAllPages<CaseDocumentRow>((from, to) => supabase.from('case_documents').select('*').eq('org_id', orgId).eq('case_id', caseId).order('created_at', { ascending: true }).order('id').range(from, to)),
    ]);
    return {
      events: eventRows.map(mapEventRow),
      documents: documentRows.map(mapDocumentRow),
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
  const orgId = fence.orgId;
  const text = query.trim();
  const suffix = phoneSearchSuffix(text);
  const textPattern = `%${escapeIlike(text)}%`;
  // Contact hits carry their own row id for paging; matches are keyed by case.
  const noHits: Promise<{ id: string; case_id: string }[]> = Promise.resolve([]);
  let titleHits: Promise<{ id: string }[]> = noHits;
  let nameHits = noHits;
  let phoneHits = noHits;
  if (text) {
    titleHits = fetchAllPages<{ id: string }>((from, to) => supabase.from('cases').select('id').eq('org_id', orgId).or(`title.ilike.${textPattern}`).order('id').range(from, to));
    nameHits = fetchAllPages<{ id: string; case_id: string }>((from, to) => supabase.from('case_contacts').select('id, case_id').eq('org_id', orgId).or(`name.ilike.${textPattern}`).order('id').range(from, to));
  }
  if (suffix) {
    phoneHits = fetchAllPages<{ id: string; case_id: string }>((from, to) => supabase.from('case_contacts').select('id, case_id').eq('org_id', orgId).or(`phone_e164.ilike.${suffix}`).order('id').range(from, to));
  }
  if (!text && !suffix) return [];
  let titleRows: { id: string }[];
  let nameRows: { case_id: string }[];
  let phoneRows: { case_id: string }[];
  try {
    [titleRows, nameRows, phoneRows] = await Promise.all([titleHits, nameHits, phoneHits]);
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError((error as { message?: string })?.message || 'Case search failed.', false);
  }

  const results = new Map<string, CaseSearchResult>();
  for (const row of titleRows) {
    results.set(row.id, { caseId: row.id, matchedBy: 'title' });
  }
  for (const row of nameRows) {
    if (!results.has(row.case_id)) results.set(row.case_id, { caseId: row.case_id, matchedBy: 'contact' });
  }
  for (const row of phoneRows) {
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

// ─── Lead capture: the in-app "New lead" quick-add ──────────────────────────
// The server builds the case, primary contact, first-call follow-up, and
// timeline entry in one transaction (create_lead). The client supplies the
// ids so its optimistic rows match what lands, plus the device-local due day
// and the first-call target time (the server's clock is UTC).

export type NewLeadInput = {
  caseId: string;
  contactId: string;
  followUpId: string;
  callerName: string;
  phone: string;
  email: string;
  aboutRelationship: string;
  aboutFirstName: string;
  leadSource: string;
  urgency: LeadUrgency;
  dueOn: string; // YYYY-MM-DD, device-local
  dueTime: string | null; // HH:MM 24h, device-local
};

// Mirrors lead_case_title() in the migration so the optimistic case card
// reads exactly like the saved one.
export function leadCaseTitle(input: Pick<NewLeadInput, 'callerName' | 'aboutRelationship' | 'aboutFirstName'>): string {
  const caller = input.callerName.trim();
  const about = `${input.aboutRelationship.trim()} ${input.aboutFirstName.trim()}`.trim();
  return about ? `${caller} — ${about}` : caller;
}

export function leadFollowUpTitle(caseTitle: string): string {
  return `First call — ${caseTitle}`;
}

export async function createLead(input: NewLeadInput, expectedUserId: string): Promise<void> {
  await runOrThrow(() => supabase.rpc('create_lead', {
    p_expected_owner_id: expectedUserId,
    p_lead: {
      id: input.caseId,
      contact_id: input.contactId,
      follow_up_id: input.followUpId,
      caller_name: input.callerName,
      phone: input.phone,
      email: input.email,
      about_relationship: input.aboutRelationship,
      about_first_name: input.aboutFirstName,
      lead_source: input.leadSource,
      urgency: input.urgency,
      due_on: input.dueOn,
      due_time: input.dueTime ?? '',
    },
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

// Assign (or unassign with null) a case. The server checks membership,
// writes the timeline entry, and returns its wording so the optimistic row
// matches. "Take this lead" is this call with the caller's own id.
export type CaseAssignment = { eventBody: string; occurredAt: string };

export async function assignCase(caseId: string, assignedTo: string | null, eventId: string): Promise<CaseAssignment> {
  return withStableCaseAccount(async () => {
    const { data, error } = await supabase.rpc('assign_case', {
      p_case_id: caseId,
      p_assigned_to: assignedTo,
      p_event_id: eventId,
    });
    if (error) throw new StoreError(error.message, false);
    const row = (Array.isArray(data) ? data[0] : data) as { event_body?: unknown; occurred_at?: unknown } | null;
    if (!row || typeof row.event_body !== 'string' || typeof row.occurred_at !== 'string') {
      throw new StoreError('The assignment was saved but could not be read back. Refresh the case.', false);
    }
    return { eventBody: row.event_body, occurredAt: row.occurred_at };
  });
}

// ─── Insurance as a workflow (migration 20261001170000) ─────────────────────
// The family's plan and the VOB requests on one case. Read when the case
// file opens; written only through the RPCs so every change lands on the
// timeline with the member who made it. Nothing here is cached offline.

type CaseBenefitsRow = {
  case_id: string;
  carrier: string | null;
  plan_name: string | null;
  member_id_last4: string | null;
  subscriber_relationship: string | null;
  updated_at: string;
};

type VobRequestRow = {
  id: string;
  case_id: string;
  partner_id: string | null;
  global_partner_id: string | null;
  program_name: string | null;
  status: VobStatus;
  requested_at: string;
  requested_by: string | null;
  answered_at: string | null;
  answered_by: string | null;
  note: string | null;
  quoted_out_of_pocket: number | null;
  follow_up_id: string | null;
};

function mapBenefitsRow(row: CaseBenefitsRow): CaseBenefits {
  return {
    caseId: row.case_id,
    carrier: row.carrier || '',
    planName: row.plan_name || '',
    memberIdLast4: row.member_id_last4 || '',
    subscriberRelationship: (row.subscriber_relationship || '') as SubscriberRelationship,
    updatedAt: row.updated_at,
  };
}

function mapVobRow(row: VobRequestRow): VobRequest {
  return {
    id: row.id,
    caseId: row.case_id,
    partnerId: row.partner_id || undefined,
    globalPartnerId: row.global_partner_id || undefined,
    programName: row.program_name || '',
    status: row.status,
    requestedAt: row.requested_at,
    requestedBy: row.requested_by ? String(row.requested_by).toLowerCase() : undefined,
    answeredAt: row.answered_at || undefined,
    answeredBy: row.answered_by || '',
    note: row.note || '',
    quotedOutOfPocket: row.quoted_out_of_pocket == null ? null : Number(row.quoted_out_of_pocket),
    followUpId: row.follow_up_id || undefined,
  };
}

export type CaseBenefitsFile = { plan: CaseBenefits | null; requests: VobRequest[] };

export async function fetchCaseBenefits(caseId: string): Promise<CaseBenefitsFile> {
  return withStableCaseAccount(async (_userId, orgId) => {
    const [planRows, requestRows] = await Promise.all([
      fetchAllPages<CaseBenefitsRow>((from, to) => supabase.from('case_benefits').select('*').eq('org_id', orgId).eq('case_id', caseId).order('case_id').range(from, to)),
      fetchAllPages<VobRequestRow>((from, to) => supabase.from('vob_requests').select('*').eq('org_id', orgId).eq('case_id', caseId).order('requested_at', { ascending: false }).order('id').range(from, to)),
    ]);
    return {
      plan: planRows.length ? mapBenefitsRow(planRows[0]) : null,
      requests: requestRows.map(mapVobRow),
    };
  });
}

export type CaseBenefitsPatch = Partial<Pick<CaseBenefits, 'carrier' | 'planName' | 'memberIdLast4' | 'subscriberRelationship'>>;

export type SavedCaseBenefits = Pick<CaseBenefits, 'carrier' | 'planName' | 'memberIdLast4' | 'subscriberRelationship'> & {
  eventBody: string; // '' when nothing changed (no timeline entry was written)
  occurredAt: string;
};

export async function saveCaseBenefits(caseId: string, eventId: string, patch: CaseBenefitsPatch): Promise<SavedCaseBenefits> {
  return withStableCaseAccount(async () => {
    const rpcPatch: Record<string, unknown> = {};
    if ('carrier' in patch) rpcPatch.carrier = patch.carrier;
    if ('planName' in patch) rpcPatch.plan_name = patch.planName;
    if ('memberIdLast4' in patch) rpcPatch.member_id_last4 = memberIdLast4(patch.memberIdLast4 || '');
    if ('subscriberRelationship' in patch) rpcPatch.subscriber_relationship = patch.subscriberRelationship;
    const { data, error } = await supabase.rpc('save_case_benefits', { p_case_id: caseId, p_patch: rpcPatch, p_event_id: eventId });
    if (error) throw new StoreError(error.message, false);
    const row = (Array.isArray(data) ? data[0] : data) as {
      carrier?: unknown; plan_name?: unknown; member_id_last4?: unknown; subscriber_relationship?: unknown; event_body?: unknown; occurred_at?: unknown;
    } | null;
    if (!row || typeof row.carrier !== 'string' || typeof row.plan_name !== 'string' || typeof row.member_id_last4 !== 'string'
      || typeof row.subscriber_relationship !== 'string' || typeof row.event_body !== 'string' || typeof row.occurred_at !== 'string') {
      throw new StoreError('The plan was saved but could not be read back. Refresh the case.', false);
    }
    return {
      carrier: row.carrier,
      planName: row.plan_name,
      memberIdLast4: row.member_id_last4,
      subscriberRelationship: row.subscriber_relationship as SubscriberRelationship,
      eventBody: row.event_body,
      occurredAt: row.occurred_at,
    };
  });
}

export type VobRequestInput = {
  id: string;
  caseId: string;
  partnerId?: string;
  programName?: string; // used only when there is no partner
  note?: string;
  dueOn: string; // YYYY-MM-DD, device-local next business day
  followUpId: string;
  eventId: string;
};

export type RequestedVob = {
  id: string;
  programName: string;
  globalPartnerId?: string;
  requestedAt: string;
  followUpId?: string;
  dueOn?: string;
  eventBody: string; // '' when the id already existed
};

export async function requestVob(input: VobRequestInput): Promise<RequestedVob> {
  return withStableCaseAccount(async () => {
    const { data, error } = await supabase.rpc('request_vob', {
      p_request: {
        id: input.id,
        case_id: input.caseId,
        partner_id: input.partnerId ?? null,
        program_name: input.programName ?? '',
        note: input.note ?? '',
        due_on: input.dueOn,
        follow_up_id: input.followUpId,
        event_id: input.eventId,
      },
    });
    if (error) throw new StoreError(error.message, false);
    const row = (Array.isArray(data) ? data[0] : data) as {
      id?: unknown; program_name?: unknown; global_partner_id?: unknown; requested_at?: unknown; follow_up_id?: unknown; due_on?: unknown; event_body?: unknown;
    } | null;
    if (!row || typeof row.id !== 'string' || typeof row.program_name !== 'string' || typeof row.requested_at !== 'string' || typeof row.event_body !== 'string') {
      throw new StoreError('The VOB request was saved but could not be read back. Refresh the case.', false);
    }
    return {
      id: row.id,
      programName: row.program_name,
      globalPartnerId: typeof row.global_partner_id === 'string' ? row.global_partner_id : undefined,
      requestedAt: row.requested_at,
      followUpId: typeof row.follow_up_id === 'string' ? row.follow_up_id : undefined,
      dueOn: typeof row.due_on === 'string' ? row.due_on : undefined,
      eventBody: row.event_body,
    };
  });
}

export type VobStatusPatch = Partial<Pick<VobRequest, 'status' | 'answeredBy' | 'note' | 'quotedOutOfPocket'>>;

export type UpdatedVob = Pick<VobRequest, 'status' | 'answeredAt' | 'answeredBy' | 'note' | 'quotedOutOfPocket'> & {
  eventBody: string; // '' when the status did not change (no timeline entry)
  occurredAt: string;
};

export async function updateVobStatus(id: string, eventId: string, patch: VobStatusPatch): Promise<UpdatedVob> {
  return withStableCaseAccount(async () => {
    const rpcPatch: Record<string, unknown> = {};
    if ('status' in patch) rpcPatch.status = patch.status;
    if ('answeredBy' in patch) rpcPatch.answered_by = patch.answeredBy;
    if ('note' in patch) rpcPatch.note = patch.note;
    if ('quotedOutOfPocket' in patch) rpcPatch.quoted_out_of_pocket = patch.quotedOutOfPocket;
    const { data, error } = await supabase.rpc('update_vob_status', { p_id: id, p_patch: rpcPatch, p_event_id: eventId });
    if (error) throw new StoreError(error.message, false);
    const row = (Array.isArray(data) ? data[0] : data) as {
      status?: unknown; answered_at?: unknown; answered_by?: unknown; note?: unknown; quoted_out_of_pocket?: unknown; event_body?: unknown; occurred_at?: unknown;
    } | null;
    if (!row || typeof row.status !== 'string' || typeof row.answered_by !== 'string' || typeof row.note !== 'string'
      || typeof row.event_body !== 'string' || typeof row.occurred_at !== 'string') {
      throw new StoreError('The VOB update was saved but could not be read back. Refresh the case.', false);
    }
    return {
      status: row.status as VobStatus,
      answeredAt: typeof row.answered_at === 'string' ? row.answered_at : undefined,
      answeredBy: row.answered_by,
      note: row.note,
      quotedOutOfPocket: row.quoted_out_of_pocket == null ? null : Number(row.quoted_out_of_pocket),
      eventBody: row.event_body,
      occurredAt: row.occurred_at,
    };
  });
}

// "Which of my partners take this plan?" Server-side, for the whole
// workspace, from each partner's own data or its linked listing. The
// answer is what programs report about themselves ("per program").
export async function fetchPartnersForPlan(plan: string, state: string): Promise<PartnerPlanStatus[]> {
  return withStableCaseAccount(async () => {
    const { data, error } = await supabase.rpc('partners_for_plan', { p_insurance: plan, p_state: state || null });
    if (error) throw new StoreError(error.message, false);
    const rows = (Array.isArray(data) ? data : []) as { partner_id?: unknown; organization?: unknown; network_status?: unknown; source?: unknown; same_state?: unknown }[];
    return rows.flatMap((row): PartnerPlanStatus[] => {
      if (typeof row.partner_id !== 'string' || typeof row.network_status !== 'string') return [];
      const status = row.network_status === 'in_network' || row.network_status === 'out_of_network' ? row.network_status : 'unknown';
      const source = row.source === 'listing' || row.source === 'partner' ? row.source : 'none';
      return [{
        partnerId: row.partner_id,
        organization: typeof row.organization === 'string' ? row.organization : '',
        networkStatus: status,
        source,
        sameState: typeof row.same_state === 'boolean' ? row.same_state : null,
      }];
    });
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
