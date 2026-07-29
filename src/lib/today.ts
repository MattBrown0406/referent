import type { Partner } from '../data';
import type { FollowUp, FollowUpKind } from './store';

// ─── Today Command Center — pure engine ─────────────────────────────────────
// Everything here is dependency-free (no React/Supabase/AsyncStorage) so the
// section bucketing, date math, cadence computation, and partner-snooze
// pruning are unit-testable in plain node (scripts/today-test.mjs).

export type TodayContext = {
  caseTitle?: string;
  partnerName?: string;
  partnerPhone?: string;
  // Referral admit-check (packet flow): referral with a packet sent and no
  // admit decision yet — Done routes to the outcome capture sheet.
  referralAwaitingAnswer?: boolean;
};

export type TodayCard = {
  id: string; // follow-up id, or `cadence-{partnerId}` for virtual cards
  kind: FollowUpKind | 'cadence';
  title: string;
  subtitle: string;
  daysOverdue: number; // 0 when due today / cadence crossed today
  dueTime?: string; // HH:MM 24h
  followUp?: FollowUp; // set for backed cards
  partnerId?: string;
  caseId?: string;
  referralId?: string;
  waitingOn?: string;
  context: TodayContext;
  virtual?: { partnerId: string; overdueBy: number }; // cadence cards only
};

export type TodaySections = {
  overdue: TodayCard[];
  today: TodayCard[];
  partnersDue: TodayCard[];
};

// ─── Date helpers ───────────────────────────────────────────────────────────

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function dateStamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Parse a YYYY-MM-DD stamp as a LOCAL date (no UTC shift).
export function parseStamp(stamp: string): Date {
  const [year, month, day] = stamp.split('-').map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function daysOverdue(dueOn: string, today: Date): number {
  const diff = startOfDay(today).getTime() - startOfDay(parseStamp(dueOn)).getTime();
  return Math.max(0, Math.round(diff / 86400000));
}

// ─── Next-step date math ────────────────────────────────────────────────────

export type WhenChoice = 'today' | 'tomorrow' | 'in3days' | 'nextweek' | 'custom';

export function nextStepDate(choice: WhenChoice, today: Date, customStamp?: string): string {
  switch (choice) {
    case 'today': return dateStamp(today);
    case 'tomorrow': return dateStamp(addDays(today, 1));
    case 'in3days': return dateStamp(addDays(today, 3));
    // Next-week snooze/scheduling convention in this app: +7 days.
    case 'nextweek': return dateStamp(addDays(today, 7));
    case 'custom': return customStamp || dateStamp(today);
  }
}

export type SnoozeChoice = 'plus1' | 'plus2' | 'nextweek';

export function snoozeDate(choice: SnoozeChoice, today: Date): string {
  if (choice === 'plus1') return dateStamp(addDays(today, 1));
  if (choice === 'plus2') return dateStamp(addDays(today, 2));
  return dateStamp(addDays(today, 7));
}

// ─── Cadence (mirrors partnersGoingCold in notifications.ts) ────────────────

export function partnerDaysSinceContact(partner: Partner, today: Date): number {
  const basis = partner.lastContact || partner.createdAt || '';
  const parsed = new Date(basis);
  const basisDay = Number.isNaN(parsed.getTime())
    ? startOfDay(today)
    : startOfDay(parsed);
  return Math.max(0, Math.round((startOfDay(today).getTime() - basisDay.getTime()) / 86400000));
}

export type PartnerDue = { partnerId: string; name: string; organization: string; phone: string; daysSince: number; overdueBy: number };

// Partners at or past their stay-in-touch cadence (due today included —
// overdueBy === 0 means it crosses today). Local snoozes hide a partner until
// the snoozed date; a real touch resets the clock via lastContact.
export function partnersDueToday(partners: Partner[], today: Date, snoozes: Record<string, string> = {}): PartnerDue[] {
  const todayStamp = dateStamp(today);
  return partners
    .filter((partner) => partner.touchCadenceDays != null && partner.touchCadenceDays > 0)
    .map((partner) => {
      const daysSince = partnerDaysSinceContact(partner, today);
      const cadence = partner.touchCadenceDays as number;
      return { partner, daysSince, overdueBy: daysSince - cadence };
    })
    .filter((entry) => entry.overdueBy >= 0)
    .filter((entry) => {
      const snoozedUntil = snoozes[entry.partner.id];
      return !snoozedUntil || snoozedUntil <= todayStamp;
    })
    .sort((a, b) => b.overdueBy - a.overdueBy)
    .map((entry) => ({
      partnerId: entry.partner.id,
      name: entry.partner.name,
      organization: entry.partner.organization,
      phone: entry.partner.phone,
      daysSince: entry.daysSince,
      overdueBy: entry.overdueBy,
    }));
}

// Prune expired snoozes so the AsyncStorage map can't grow unboundedly.
export function prunePartnerSnoozes(snoozes: Record<string, string>, today: Date): Record<string, string> {
  const todayStamp = dateStamp(today);
  const next: Record<string, string> = {};
  for (const [partnerId, until] of Object.entries(snoozes)) {
    if (until >= todayStamp) next[partnerId] = until;
  }
  return next;
}

// ─── Card construction ──────────────────────────────────────────────────────

function formatDueTime(dueTime: string): string {
  const [hourRaw, minuteRaw] = dueTime.split(':');
  let hour = Number(hourRaw);
  const minute = String(minuteRaw || '00').padStart(2, '0');
  const suffix = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${minute} ${suffix}`;
}

export function followUpToCard(
  followUp: FollowUp,
  today: Date,
  context: TodayContext = {},
): TodayCard {
  const kind = followUp.kind || 'follow_up';
  const overdue = daysOverdue(followUp.dueOn, today);
  const bits: string[] = [];
  if (context.caseTitle) bits.push(context.caseTitle);
  if (context.partnerName) bits.push(context.partnerName);
  if (kind === 'waiting_on' && followUp.waitingOn) bits.push(`Waiting on: ${followUp.waitingOn}`);
  if (followUp.dueTime) bits.push(`due ${formatDueTime(followUp.dueTime)}`);
  return {
    id: followUp.id,
    kind,
    title: followUp.title,
    subtitle: bits.join(' · '),
    daysOverdue: overdue,
    dueTime: followUp.dueTime,
    followUp,
    partnerId: followUp.partnerId,
    caseId: followUp.caseId,
    referralId: followUp.referralId,
    waitingOn: followUp.waitingOn,
    context,
  };
}

export function partnerDueToCard(due: PartnerDue): TodayCard {
  return {
    id: `cadence-${due.partnerId}`,
    kind: 'cadence',
    title: due.organization,
    subtitle: due.overdueBy > 0
      ? `${due.name} · ${due.daysSince} days since contact · ${due.overdueBy} past cadence`
      : `${due.name} · cadence reached today (${due.daysSince} days)`,
    daysOverdue: 0, // cadence cards never join the OVERDUE section
    partnerId: due.partnerId,
    context: { partnerName: due.name, partnerPhone: due.phone },
    virtual: { partnerId: due.partnerId, overdueBy: due.overdueBy },
  };
}

// ─── Section bucketing ──────────────────────────────────────────────────────
// OVERDUE: any backed card with daysOverdue > 0, most-overdue first (virtual
// partner cadence cards never go here — they live in PARTNERS DUE).
// TODAY: due today. Consults with a due_time first by time, then the rest
// ordered first_call → promised_call → waiting_on → consult → touch →
// follow_up; ties break on title for stability.
// PARTNERS DUE: virtual cadence cards, most-past-cadence first.

const TODAY_KIND_ORDER: Record<string, number> = {
  first_call: 0,
  promised_call: 1,
  waiting_on: 2,
  consult: 3,
  touch: 4,
  follow_up: 5,
};

export function buildTodaySections(
  followUps: FollowUp[],
  partnersDue: PartnerDue[],
  today: Date,
  contextFor: (followUp: FollowUp) => TodayContext,
): TodaySections {
  const todayStamp = dateStamp(today);
  const overdue: TodayCard[] = [];
  const dueToday: TodayCard[] = [];

  for (const followUp of followUps) {
    if (followUp.status !== 'open') continue;
    // Snooze mirrors the server view (today_actions uses
    // coalesce(snoozed_until, due_on) <= CURRENT_DATE).
    const effectiveDue = followUp.snoozedUntil || followUp.dueOn;
    if (effectiveDue > todayStamp) continue;
    const card = followUpToCard(followUp, today, contextFor(followUp));
    // Overdue is measured against the ORIGINAL due date (the view's
    // days_overdue), not the snooze date.
    if (card.daysOverdue > 0) overdue.push(card);
    else dueToday.push(card);
  }

  overdue.sort((a, b) => b.daysOverdue - a.daysOverdue || a.title.localeCompare(b.title));

  const timedConsults = dueToday
    .filter((card) => card.kind === 'consult' && card.dueTime)
    .sort((a, b) => (a.dueTime as string).localeCompare(b.dueTime as string));
  const rest = dueToday
    .filter((card) => !(card.kind === 'consult' && card.dueTime))
    .sort((a, b) => (TODAY_KIND_ORDER[a.kind] ?? 9) - (TODAY_KIND_ORDER[b.kind] ?? 9) || a.title.localeCompare(b.title));

  return { overdue, today: [...timedConsults, ...rest], partnersDue: partnersDue.map(partnerDueToCard) };
}
