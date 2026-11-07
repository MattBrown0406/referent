import { identifyingTextProblem } from './identifying-text';
import { OfflineError, StoreError, asOfflineError, describeError, errorCode, withHttpStatus } from './errors';
import { supabase } from './supabase';

// ─── Referral handoffs ──────────────────────────────────────────────────────
// After referring a family to a program, the practitioner sends the program a
// private link. The program's page (the portal's /h, signed out) shows a
// client alias, the practice's name and the status, and the program steps it
// forward: received, family contacted, family reached, consult scheduled,
// closed. Each step is recorded once, in order, and moves the practitioner's
// reminder on (migration 20261106130000; docs/HANDOFFS.md).
//
// Privacy: the program reads the alias, never the client label, the case or
// a contact. The alias passes the same identifying-details check as a
// placement request's note (here and again on the server). The link's token
// is shown once, at creation; the server keeps only its hash.

export type HandoffStatus = 'sent' | 'received' | 'contact_attempted' | 'family_reached' | 'consult_scheduled' | 'closed';

export const HANDOFF_STEPS: { status: HandoffStatus; label: string }[] = [
  { status: 'sent', label: 'Sent' },
  { status: 'received', label: 'Received' },
  { status: 'contact_attempted', label: 'Contact attempted' },
  { status: 'family_reached', label: 'Family reached' },
  { status: 'consult_scheduled', label: 'Consult scheduled' },
  { status: 'closed', label: 'Closed' },
];

export const HANDOFF_ALIAS_MAX = 80;
export const HANDOFF_RECIPIENT_MAX = 120;

// The program's page. The token goes in the fragment, so it never reaches a
// server log, a proxy or a Referer header.
export const HANDOFF_PAGE = 'https://portal.referralfit.com/h';

export type ReferralHandoff = {
  id: string;
  referralId: string;
  caseId: string | null;
  partnerId: string;
  clientAlias: string;
  recipientDisplay: string;
  recipientEmail: string;
  status: HandoffStatus;
  version: number;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // The open reminder's day, when there is one.
  dueOn: string | null;
};

export type CreatedHandoff = { handoffId: string; link: string };

export function handoffStatusLabel(status: HandoffStatus): string {
  return HANDOFF_STEPS.find((step) => step.status === status)?.label ?? status;
}

export function nextHandoffStatus(status: HandoffStatus): HandoffStatus | null {
  const index = HANDOFF_STEPS.findIndex((step) => step.status === status);
  return index >= 0 && index < HANDOFF_STEPS.length - 1 ? HANDOFF_STEPS[index + 1].status : null;
}

export function handoffLink(token: string): string {
  return `${HANDOFF_PAGE}#${token}`;
}

export function isHandoffOpen(handoff: Pick<ReferralHandoff, 'status' | 'revokedAt'>): boolean {
  return !handoff.revokedAt && handoff.status !== 'closed';
}

// What is wrong with an alias, in plain words, or null. `names`: the case's
// title and contact names; `label`: the referral's client label. The server
// checks again with the same rules.
export function handoffAliasProblem(alias: string, names: readonly string[], label: string | null): string | null {
  const trimmed = alias.trim();
  if (!trimmed) return 'Add an alias the program can call this family by, such as Family A.';
  if (trimmed.length > HANDOFF_ALIAS_MAX) return `Keep the alias to ${HANDOFF_ALIAS_MAX} characters.`;
  return identifyingTextProblem(trimmed, names.filter((value) => value.trim() !== ''), label);
}

export function recipientProblem(display: string, email: string): string | null {
  if (!display.trim()) return 'Name the program or person receiving this handoff.';
  if (display.trim().length > HANDOFF_RECIPIENT_MAX) return `Keep the name to ${HANDOFF_RECIPIENT_MAX} characters.`;
  const address = email.trim();
  if (address && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return 'Check the email address, or leave it empty.';
  return null;
}

const STATUSES = new Set<string>(HANDOFF_STEPS.map((step) => step.status));

type HandoffRow = {
  id: string; referral_id: string; case_id: string | null; partner_id: string; client_alias: string;
  recipient_display: string; recipient_email: string | null; status: string; version: number;
  revoked_at: string | null; created_at: string; updated_at: string;
};

function mapHandoff(row: HandoffRow, dueOn: string | null): ReferralHandoff | null {
  if (!STATUSES.has(row.status)) return null;
  return {
    id: row.id,
    referralId: row.referral_id,
    caseId: row.case_id,
    partnerId: row.partner_id,
    clientAlias: row.client_alias,
    recipientDisplay: row.recipient_display,
    recipientEmail: row.recipient_email ?? '',
    status: row.status as HandoffStatus,
    version: row.version,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dueOn,
  };
}

// A readable StoreError; one that never got an answer is an OfflineError.
function handoffFailure(error: unknown, status: number | undefined, fallback: string): StoreError {
  if (error instanceof StoreError) return error;
  // Checked first: errors.ts reads 40001 (a serialization failure) as
  // retryable, i.e. offline. Here it is the handoff's version check.
  if (errorCode(error) === '40001') return new StoreError('This handoff changed meanwhile. The latest status is shown now.', false);
  const offline = asOfflineError(withHttpStatus(error, status));
  if (offline instanceof OfflineError) return offline;
  return new StoreError(describeError(error, fallback), false);
}

// The workspace's handoffs, newest first (a practice sends tens, not
// thousands; one page covers them), with each open reminder's day.
export async function fetchHandoffs(): Promise<ReferralHandoff[]> {
  const [handoffs, reminders] = await Promise.all([
    supabase.from('referral_handoffs')
      .select('id, referral_id, case_id, partner_id, client_alias, recipient_display, recipient_email, status, version, revoked_at, created_at, updated_at')
      .order('created_at', { ascending: false }).order('id').limit(500),
    supabase.from('follow_ups').select('referral_handoff_id, due_on')
      .eq('kind', 'referral_handshake').eq('status', 'open').not('referral_handoff_id', 'is', null).limit(1000),
  ]);
  if (handoffs.error) throw handoffFailure(handoffs.error, handoffs.status, 'Could not load handoffs.');
  const due = new Map<string, string>();
  for (const row of (reminders.data || []) as { referral_handoff_id: string | null; due_on: string }[]) {
    if (row.referral_handoff_id) due.set(row.referral_handoff_id, row.due_on);
  }
  return ((handoffs.data || []) as HandoffRow[]).flatMap((row) => {
    const mapped = mapHandoff(row, due.get(row.id) ?? null);
    return mapped ? [mapped] : [];
  });
}

export type CreateHandoffInput = {
  referralId: string;
  caseId: string | null;
  partnerId: string;
  clientAlias: string;
  recipientDisplay: string;
  recipientEmail: string;
};

export async function createHandoff(input: CreateHandoffInput): Promise<CreatedHandoff> {
  const { data, error, status } = await supabase.rpc('create_referral_handoff', {
    p_referral_id: input.referralId,
    p_case_id: input.caseId,
    p_partner_id: input.partnerId,
    p_client_alias: input.clientAlias.trim(),
    p_recipient_display: input.recipientDisplay.trim(),
    p_recipient_email: input.recipientEmail.trim(),
  });
  if (error) throw handoffFailure(error, status, 'Could not create the handoff.');
  const row = (Array.isArray(data) ? data[0] : data) as { handoff_id?: unknown; token?: unknown } | null;
  if (!row || typeof row.handoff_id !== 'string' || typeof row.token !== 'string' || !/^[0-9a-f]{64}$/.test(row.token)) {
    throw new StoreError('The handoff was created, but its link could not be read. Revoke it and send a new one.', false);
  }
  return { handoffId: row.handoff_id, link: handoffLink(row.token) };
}

// The practitioner steps it forward (the program told them by phone).
export async function advanceHandoff(handoff: ReferralHandoff): Promise<{ status: HandoffStatus; version: number }> {
  const next = nextHandoffStatus(handoff.status);
  if (!next) throw new StoreError('This handoff is already closed.', false);
  const { data, error, status } = await supabase.rpc('transition_referral_handoff', {
    p_handoff_id: handoff.id, p_expected_version: handoff.version, p_next_status: next,
  });
  if (error) throw handoffFailure(error, status, 'Could not update the handoff.');
  const row = (Array.isArray(data) ? data[0] : data) as { status?: unknown; version?: unknown } | null;
  if (!row || typeof row.status !== 'string' || !STATUSES.has(row.status) || typeof row.version !== 'number') {
    throw new StoreError('The handoff was updated, but its status could not be read. Refresh to see it.', false);
  }
  return { status: row.status as HandoffStatus, version: row.version };
}

// The link stops working; the reminder is dropped.
export async function revokeHandoff(handoffId: string): Promise<void> {
  const { error, status } = await supabase.rpc('revoke_referral_handoff', { p_handoff_id: handoffId });
  if (error) throw handoffFailure(error, status, 'Could not revoke the handoff.');
}
