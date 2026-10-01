// Outcomes loop: the pure math behind post-placement check-ins, the partner
// track record and the Business "Outcomes" row. Mirrors the server side
// (20261001160000_outcomes_loop.sql): the scorecard view, the network
// aggregate and schedule_placement_check_ins all compute these the same
// way, so a number shown here matches the one the server would show.
//
// Nothing here is family-facing. The interventionist records what the
// family told them; the family is never asked to rate anything.

import type { Partner, Referral } from '../data';

/** Days after admission when a check-in is due. The server owns this list. */
export const CHECK_IN_OFFSETS_DAYS = [7, 30, 90] as const;

export type CheckInOffset = (typeof CHECK_IN_OFFSETS_DAYS)[number];

function addDays(stamp: string, days: number): string {
  const [year, month, day] = stamp.split('-').map(Number);
  const date = new Date(year, month - 1, day + days);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

/**
 * The check-ins a placement would schedule from an admission date: one per
 * offset whose due date is today or later. Identical to the server rule, so
 * the outcome sheet can tell the user what will land on Today.
 */
export function checkInSchedule(admittedOn: string, today: string): { days: CheckInOffset; dueOn: string }[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(admittedOn)) return [];
  return CHECK_IN_OFFSETS_DAYS
    .map((days) => ({ days, dueOn: addDays(admittedOn, days) }))
    .filter((item) => item.dueOn >= today);
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function daysBetween(from: string, to: string): number | null {
  const a = new Date(`${from}T12:00:00`).getTime();
  const b = new Date(`${to}T12:00:00`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

export type OutcomeSummary = {
  /** Outbound referrals that were admitted. */
  placements: number;
  /** Admitted referrals whose completed flag has been answered either way. */
  decidedPlacements: number;
  completed: number;
  /** completed / decidedPlacements; null until something is decided. */
  completionRate: number | null;
  /** Median of admittedOn minus the referral date, admitted referrals only. */
  medianDaysToAdmit: number | null;
  /** Mean 1-5 family experience over rated outbound referrals. */
  averageFamilyExperience: number | null;
  rated: number;
  /** Admitted, still enrolled, not yet completed. */
  stillEnrolled: number;
};

/**
 * Summarise outbound referrals the way partner_scorecard does, so the
 * Business tiles and the node tests share one definition.
 */
export function summarizeOutcomes(referrals: Referral[]): OutcomeSummary {
  const outbound = referrals.filter((referral) => referral.direction === 'Outbound');
  const admitted = outbound.filter((referral) => referral.admitted === true);
  const decided = admitted.filter((referral) => referral.completed === true || referral.completed === false);
  const completed = decided.filter((referral) => referral.completed === true);
  const daysToAdmit = admitted.flatMap((referral) => {
    if (!referral.admittedOn) return [];
    const days = daysBetween(referral.date, referral.admittedOn);
    return days == null || days < 0 ? [] : [days];
  });
  const ratings = outbound.flatMap((referral) => (referral.familyExperience == null ? [] : [referral.familyExperience]));
  return {
    placements: admitted.length,
    decidedPlacements: decided.length,
    completed: completed.length,
    completionRate: decided.length ? completed.length / decided.length : null,
    medianDaysToAdmit: median(daysToAdmit),
    averageFamilyExperience: ratings.length ? ratings.reduce((sum, value) => sum + value, 0) / ratings.length : null,
    rated: ratings.length,
    stillEnrolled: admitted.filter((referral) => referral.stillEnrolled === true && referral.completed !== true).length,
  };
}

/**
 * Whether the directory listing behind this partner bills any carrier
 * out-of-network (set by the program in the Center Portal; copied onto the
 * tenant partner by the directory sync). Null when nothing is marked.
 */
export function billsOutOfNetwork(partner: Pick<Partner, 'insuranceNetworks'>): boolean | null {
  const networks = partner.insuranceNetworks;
  if (!networks) return null;
  const carriers = Object.keys(networks);
  if (!carriers.length) return null;
  return carriers.some((carrier) => (networks[carrier] || []).includes('Out-of-network'));
}

export function formatRate(rate: number | null): string {
  return rate == null ? '—' : `${Math.round(rate * 100)}%`;
}

export function formatDays(days: number | null): string {
  if (days == null) return '—';
  const rounded = Math.round(days * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} ${rounded === 1 ? 'day' : 'days'}`;
}

export function formatStars(value: number | null): string {
  return value == null ? '—' : `${(Math.round(value * 10) / 10).toFixed(1)}★`;
}
