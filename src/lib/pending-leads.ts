import type { LeadUrgency, NewLeadInput } from './cases';
import type { NewLeadDraft } from './NewLeadSheet';

// ─── Leads that have not reached the server yet ─────────────────────────────
// A New lead whose save failed keeps its draft and its ids for a retry
// (App.tsx leadRetries). Kept only in memory, it was lost when iOS ended the
// app, which it does on a long call or under memory pressure. Each one is
// also written to this device, per account, and read back at launch; it is
// removed only once the server has the lead.
//
// Retries send the SAME case / contact / follow-up ids (create_lead treats a
// repeat of a lead that already landed as a no-op success), so a retry after
// a save that did land, or two retries racing, never makes a second lead.
//
// Dependency-free (no React / AsyncStorage) so scripts/pending-leads-test.mjs
// can run it in plain node; App.tsx does the reading and writing.

export const PENDING_LEADS_KEY_PREFIX = 'referralfit-pending-leads-v1:';

export function pendingLeadsKey(userId: string): string {
  return `${PENDING_LEADS_KEY_PREFIX}${userId.toLowerCase()}`;
}

export type PendingLeadIds = { caseId: string; contactId: string; followUpId: string };

export type PendingLead = {
  ids: PendingLeadIds;
  draft: NewLeadDraft;
  // Why it did not save, shown on Today and in the reopened sheet.
  message: string;
  // true: the server was not reached (retry quietly); false: refused.
  retryable: boolean;
  // The workspace it was taken in: a lead is never replayed into another.
  orgId: string;
  // When the caller was taken down (ISO) and the first call's due day/time
  // then (device-local), so a quiet retry keeps the original clock.
  capturedAt: string;
  dueOn: string;
  dueTime: string | null;
};

type StoredEnvelope = { version: 1; entries: PendingLead[] };

const URGENCIES: LeadUrgency[] = ['none', 'immediate_danger'];
const STAMP_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value: unknown, max = 500): string | null {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

function parseEntry(raw: unknown): PendingLead | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  const ids = entry.ids as Record<string, unknown> | undefined;
  const draft = entry.draft as Record<string, unknown> | undefined;
  if (!ids || !draft) return null;
  const caseId = text(ids.caseId);
  const contactId = text(ids.contactId);
  const followUpId = text(ids.followUpId);
  if (!caseId || !contactId || !followUpId || ![caseId, contactId, followUpId].every((id) => UUID_RE.test(id))) return null;
  const callerName = text(draft.callerName);
  const phone = text(draft.phone);
  if (!callerName || phone === null) return null;
  const urgency = URGENCIES.includes(draft.urgency as LeadUrgency) ? (draft.urgency as LeadUrgency) : 'none';
  const dueOn = text(entry.dueOn);
  const dueTime = entry.dueTime === null ? null : text(entry.dueTime);
  const capturedAt = text(entry.capturedAt);
  return {
    ids: { caseId: caseId.toLowerCase(), contactId: contactId.toLowerCase(), followUpId: followUpId.toLowerCase() },
    draft: {
      callerName,
      phone,
      email: text(draft.email) ?? '',
      aboutRelationship: text(draft.aboutRelationship) ?? '',
      aboutFirstName: text(draft.aboutFirstName) ?? '',
      leadSource: text(draft.leadSource) ?? 'Unspecified',
      urgency,
    },
    message: text(entry.message, 1000) ?? 'This lead has not reached the server yet.',
    retryable: entry.retryable !== false,
    orgId: (text(entry.orgId) ?? '').toLowerCase(),
    capturedAt: capturedAt && !Number.isNaN(new Date(capturedAt).getTime()) ? capturedAt : new Date(0).toISOString(),
    dueOn: dueOn && STAMP_RE.test(dueOn) ? dueOn : '',
    dueTime: dueTime && TIME_RE.test(dueTime) ? dueTime : null,
  };
}

// What was stored, made safe: unreadable entries are dropped (never the
// whole list), and one lead appears once.
export function parsePendingLeads(raw: string | null): PendingLead[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const entries = parsed && typeof parsed === 'object' && Array.isArray((parsed as { entries?: unknown }).entries)
    ? (parsed as { entries: unknown[] }).entries
    : [];
  const seen = new Set<string>();
  const leads: PendingLead[] = [];
  for (const item of entries) {
    const lead = parseEntry(item);
    if (!lead || seen.has(lead.ids.caseId)) continue;
    seen.add(lead.ids.caseId);
    leads.push(lead);
  }
  return leads;
}

export function serializePendingLeads(leads: PendingLead[]): string {
  const envelope: StoredEnvelope = {
    version: 1,
    entries: leads.map((lead) => ({
      ids: lead.ids,
      draft: lead.draft,
      message: lead.message,
      retryable: lead.retryable,
      orgId: lead.orgId,
      capturedAt: lead.capturedAt,
      dueOn: lead.dueOn,
      dueTime: lead.dueTime,
    })),
  };
  return JSON.stringify(envelope);
}

// The leads on screen plus the ones read from the device, oldest first, one
// per case id. A lead already on screen wins (it has the latest message).
export function mergePendingLeads<T extends PendingLead>(current: T[], stored: T[]): T[] {
  const byCase = new Map<string, T>();
  for (const lead of stored) byCase.set(lead.ids.caseId, lead);
  for (const lead of current) byCase.set(lead.ids.caseId, lead);
  return Array.from(byCase.values()).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}

// Which ones to send again without asking: only those that failed for want
// of a connection (a refusal needs the person to fix the details), only in
// the workspace they were taken in, and never the one open in the sheet.
export function leadsToRetryQuietly<T extends PendingLead>(leads: T[], orgId: string, openInSheet: T | null): T[] {
  const org = orgId.toLowerCase();
  return leads.filter((lead) => lead.retryable && lead !== openInSheet && (!lead.orgId || lead.orgId === org));
}

// The create_lead input for a quiet retry: the same ids and the original
// first-call clock (a lead taken at 2:10 PM is still due at 2:25 PM).
export function pendingLeadInput(lead: PendingLead, fallbackDueOn: string): NewLeadInput {
  return {
    caseId: lead.ids.caseId,
    contactId: lead.ids.contactId,
    followUpId: lead.ids.followUpId,
    callerName: lead.draft.callerName,
    phone: lead.draft.phone,
    email: lead.draft.email,
    aboutRelationship: lead.draft.aboutRelationship,
    aboutFirstName: lead.draft.aboutFirstName,
    leadSource: lead.draft.leadSource,
    urgency: lead.draft.urgency,
    dueOn: lead.dueOn || fallbackDueOn,
    dueTime: lead.dueOn ? lead.dueTime : null,
  };
}

// Today's line for an unsaved lead: the caller, and who it is about.
export function pendingLeadLabel(lead: PendingLead): string {
  const about = lead.draft.aboutFirstName.trim();
  return about ? `${lead.draft.callerName} — about ${about}` : lead.draft.callerName;
}
