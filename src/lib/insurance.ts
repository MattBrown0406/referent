// Insurance as a workflow: the family's plan on a case, verification of
// benefits (VOB) requests to programs, and "which of my partners take this
// plan?". Pure: no React, no Supabase. The server calls live in cases.ts;
// the matching migration is 20261001170000_insurance_workflow.sql.
//
// What is stored about the plan: carrier, plan name, the LAST FOUR
// characters of the member id, and who the subscriber is. Never the full
// member id, never a date of birth, never an SSN. This is case-file data:
// it stays under the workspace RLS and never reaches the directory, the
// portal, a push payload, or an aggregate.

import type { InsuranceNetworkPreference, Partner } from '../data';

// ─── Types ──────────────────────────────────────────────────────────────────

export type VobStatus = 'requested' | 'pending' | 'in_network' | 'out_of_network' | 'not_accepted';

export const VOB_STATUSES: VobStatus[] = ['requested', 'pending', 'in_network', 'out_of_network', 'not_accepted'];

/** Answered means the program said something definite; requested and pending are still open. */
export const VOB_ANSWERED_STATUSES: VobStatus[] = ['in_network', 'out_of_network', 'not_accepted'];

export function isVobAnswered(status: VobStatus): boolean {
  return VOB_ANSWERED_STATUSES.includes(status);
}

/** Mirrors vob_status_label() in the migration. */
export function vobStatusLabel(status: VobStatus): string {
  switch (status) {
    case 'requested': return 'requested';
    case 'pending': return 'pending with the program';
    case 'in_network': return 'in-network';
    case 'out_of_network': return 'out-of-network';
    case 'not_accepted': return 'not accepted';
    default: return status;
  }
}

export type SubscriberRelationship = '' | 'self' | 'spouse' | 'parent' | 'child' | 'other';

export const SUBSCRIBER_RELATIONSHIPS: { value: SubscriberRelationship; label: string }[] = [
  { value: '', label: 'Not set' },
  { value: 'self', label: 'The person entering treatment' },
  { value: 'parent', label: 'A parent' },
  { value: 'spouse', label: 'A spouse' },
  { value: 'child', label: 'A child' },
  { value: 'other', label: 'Someone else' },
];

export function subscriberRelationshipLabel(value: string): string {
  return SUBSCRIBER_RELATIONSHIPS.find((item) => item.value === value)?.label || 'Not set';
}

export type CaseBenefits = {
  caseId: string;
  carrier: string;
  planName: string;
  memberIdLast4: string; // exactly four characters or empty; the server refuses more
  subscriberRelationship: SubscriberRelationship;
  updatedAt: string;
};

export type VobRequest = {
  id: string;
  caseId: string;
  partnerId?: string;
  globalPartnerId?: string;
  programName: string;
  status: VobStatus;
  requestedAt: string; // ISO timestamptz
  requestedBy?: string;
  answeredAt?: string; // ISO timestamptz, server-stamped when answered
  answeredBy: string; // the person at the program, free text
  note: string;
  quotedOutOfPocket: number | null; // whole dollars
  followUpId?: string;
};

export type PlanNetworkStatus = 'in_network' | 'out_of_network' | 'unknown';

export type PlanNetworkSource = 'listing' | 'partner' | 'none';

export type PartnerPlanStatus = {
  partnerId: string;
  organization: string;
  networkStatus: PlanNetworkStatus;
  source: PlanNetworkSource;
  sameState: boolean | null;
};

// ─── The plan: what the app keeps and what it refuses ───────────────────────

/** Only the last four characters of whatever was typed; the full id never leaves the keyboard. */
export function memberIdLast4(input: string): string {
  const cleaned = input.replace(/[^0-9A-Za-z]/g, '');
  return cleaned.slice(-4);
}

export function planLabel(benefits: Pick<CaseBenefits, 'carrier' | 'planName'> | null | undefined): string {
  if (!benefits) return '';
  return [benefits.carrier, benefits.planName].filter(Boolean).join(' ');
}

// ─── "Which of my partners take this plan?" ─────────────────────────────────
// Mirrors partners_for_plan() in the migration, for the client's own copy of
// a partner (the server is authoritative and also reads the linked listing).
// An explicit networks entry wins; a carrier listed under insurance with no
// entry counts as in-network (the same reading matching.ts uses); anything
// else is unknown, never out-of-network. Self-reported by programs.

export function planNetworkStatusForPartner(partner: Pick<Partner, 'insurance' | 'insuranceNetworks'>, plan: string): PlanNetworkStatus {
  const key = plan.trim();
  if (!key || key === 'Cash pay') return 'unknown';
  const explicit: InsuranceNetworkPreference[] | undefined = partner.insuranceNetworks?.[key];
  if (explicit && explicit.length) {
    if (explicit.includes('In-network')) return 'in_network';
    if (explicit.includes('Out-of-network')) return 'out_of_network';
  }
  return partner.insurance.includes(key) ? 'in_network' : 'unknown';
}

export function planNetworkStatusLabel(status: PlanNetworkStatus): string {
  switch (status) {
    case 'in_network': return 'In-network';
    case 'out_of_network': return 'Out-of-network';
    default: return 'Not listed';
  }
}

/**
 * The honest label for a partner against a plan on one case. Directory and
 * partner data is what the program says about itself ("per program"); a
 * VOB answer on this case is what the carrier actually said ("confirmed by
 * VOB"), and it upgrades the label for this case only. The partner's own
 * network data is never rewritten by a VOB.
 */
export function planStatusLine(
  perProgram: PlanNetworkStatus,
  caseRequests: Pick<VobRequest, 'partnerId' | 'status' | 'answeredAt'>[],
  partnerId: string,
): { text: string; confirmed: boolean } {
  const confirmed = latestAnsweredVob(caseRequests, partnerId);
  if (confirmed) {
    return { text: `${vobStatusLabel(confirmed.status)} · confirmed by VOB`, confirmed: true };
  }
  return { text: `${planNetworkStatusLabel(perProgram)} · per program`, confirmed: false };
}

export function latestAnsweredVob<T extends Pick<VobRequest, 'partnerId' | 'status' | 'answeredAt'>>(requests: T[], partnerId: string): T | null {
  return requests
    .filter((item) => item.partnerId === partnerId && isVobAnswered(item.status) && item.answeredAt)
    .sort((a, b) => (b.answeredAt || '').localeCompare(a.answeredAt || ''))[0] || null;
}

/** In-network first, then out-of-network, then unknown; same state before other states; then by name. */
export function sortPlanStatuses<T extends Pick<PartnerPlanStatus, 'networkStatus' | 'sameState' | 'organization'>>(items: T[]): T[] {
  const rank: Record<PlanNetworkStatus, number> = { in_network: 0, out_of_network: 1, unknown: 2 };
  return [...items].sort((a, b) => rank[a.networkStatus] - rank[b.networkStatus]
    || Number(b.sameState === true) - Number(a.sameState === true)
    || a.organization.localeCompare(b.organization));
}

// ─── The chase follow-up ────────────────────────────────────────────────────
// Mirrors next_business_day() in the migration: the day after `from`, with
// Saturday and Sunday rolling to Monday. Dates are YYYY-MM-DD, device-local.

export function nextBusinessDay(from: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(from);
  if (!match) return '';
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(date.getTime())) return '';
  date.setDate(date.getDate() + 1);
  if (date.getDay() === 6) date.setDate(date.getDate() + 2);
  else if (date.getDay() === 0) date.setDate(date.getDate() + 1);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function vobChaseTitle(programName: string): string {
  return `Check on VOB: ${programName}`;
}

// ─── The Business tile ──────────────────────────────────────────────────────
// Mirrors vob_turnaround_stats() in the migration: median days from
// requested to answered over answered requests, by the date requested, in
// the period. Workspace totals only; never per person.

export type VobTiming = Pick<VobRequest, 'requestedAt' | 'answeredAt'>;

export type VobTurnaroundMetric = {
  requested: number;
  answered: number;
  medianDays: number | null; // one decimal
};

export function summarizeVobTurnaround(rows: VobTiming[], periodStartMs: number): VobTurnaroundMetric {
  const scoped = rows.filter((row) => {
    const requested = new Date(row.requestedAt).getTime();
    return Number.isFinite(requested) && requested >= periodStartMs;
  });
  const days = scoped.flatMap((row) => {
    if (!row.answeredAt) return [];
    const elapsed = (new Date(row.answeredAt).getTime() - new Date(row.requestedAt).getTime()) / 86400000;
    return Number.isFinite(elapsed) && elapsed >= 0 ? [elapsed] : [];
  });
  const sorted = [...days].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = !sorted.length ? null : sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return {
    requested: scoped.length,
    answered: days.length,
    medianDays: median == null ? null : Math.round(median * 10) / 10,
  };
}

export function formatTurnaroundDays(days: number | null): string {
  if (days == null) return '—';
  if (days < 1) return 'same day';
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}
