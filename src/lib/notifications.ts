import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import type { Partner, Referral, ReferralMatch } from '../data';
import type { CaseRecord } from './cases';
import type { FollowUp } from './store';

// ─── Behavior ───────────────────────────────────────────────────────────────

let handlerInstalled = false;

export function ensureNotificationHandler(): void {
  if (handlerInstalled) return;
  handlerInstalled = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

// ─── Permission + channel ───────────────────────────────────────────────────

export async function ensureNotificationSetup(): Promise<boolean> {
  ensureNotificationHandler();
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('referralfit', {
        name: 'ReferralFit',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return true;
    if (!current.canAskAgain) return false;
    const requested = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: true, allowSound: true },
    });
    return requested.granted;
  } catch {
    return false;
  }
}

// ─── Going-cold formula (mirrors the partners_going_cold view) ──────────────

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function daysSinceContact(partner: Partner): number {
  const basis = partner.lastContact || partner.createdAt || '';
  const parsed = new Date(basis);
  const basisDay = Number.isNaN(parsed.getTime())
    ? startOfToday()
    : new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  return Math.max(0, Math.round((startOfToday().getTime() - basisDay.getTime()) / 86400000));
}

export type ColdPartner = { partner: Partner; daysSince: number; overdueBy: number };

export function partnersGoingCold(partners: Partner[]): ColdPartner[] {
  return partners
    .filter((partner) => partner.touchCadenceDays != null && partner.touchCadenceDays > 0)
    .map((partner) => {
      const daysSince = daysSinceContact(partner);
      const cadence = partner.touchCadenceDays as number;
      return { partner, daysSince, overdueBy: daysSince - cadence };
    })
    .filter((entry) => entry.overdueBy > 0)
    .sort((a, b) => b.overdueBy - a.overdueBy);
}

// ─── Scheduling ─────────────────────────────────────────────────────────────

const MAX_SCHEDULED = 50; // iOS hard limit is 64 — stay well under it.
const RENAG_DAYS = 2; // while overdue, re-nag every 2 days
const RENAG_OCCURRENCES = 3; // ...but only schedule the next 3 occurrences.

function nextTime(hour: number, minute: number): Date {
  const now = new Date();
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0);
  if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

function atTime(base: Date, hour: number, minute: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0);
}

export type NotificationInput = {
  partners: Partner[];
  referralMatches: ReferralMatch[];
  referrals: Referral[];
  followUps?: FollowUp[]; // optional so older call sites keep compiling
  cases?: CaseRecord[]; // optional — active-case count in the briefing
};

function dateStamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Open follow-ups whose effective due date (snooze-aware, mirroring the
// today_actions view: coalesce(snoozed_until, due_on)) is today or earlier.
export function followUpsDue(followUps: FollowUp[]): FollowUp[] {
  const today = dateStamp(startOfToday());
  return followUps
    .filter((followUp) => followUp.status === 'open' && (followUp.snoozedUntil || followUp.dueOn) <= today)
    .sort((a, b) => (a.snoozedUntil || a.dueOn).localeCompare(b.snoozedUntil || b.dueOn));
}

// The home-screen action load: today actions (snooze-aware) + partners whose
// cadence is due today or past (overdueBy >= 0 — the cadence cards).
export function todayLoad(followUps: FollowUp[], partners: Partner[]): { actions: number; overdueCount: number } {
  const today = dateStamp(startOfToday());
  const due = followUpsDue(followUps);
  const overdueCount = due.filter((followUp) => followUp.dueOn < today).length;
  const cadenceDue = partners
    .filter((partner) => partner.touchCadenceDays != null && partner.touchCadenceDays > 0)
    .filter((partner) => daysSinceContact(partner) >= (partner.touchCadenceDays as number))
    .length;
  return { actions: due.length + cadenceDue, overdueCount };
}

// Recompute and reschedule everything: one daily 7 AM briefing (only when
// there is something worth saying), then per-partner cadence nags at 9 AM,
// then one reminder per open follow-up at 9 AM on its due date.
// Priority when capped: briefing first, then most-overdue partners, then
// follow-ups by due date.
export async function rescheduleNotifications({ partners, referralMatches, referrals, followUps = [], cases = [] }: NotificationInput): Promise<void> {
  ensureNotificationHandler();
  try {
    const granted = await ensureNotificationSetup();
    if (!granted) return;
    await Notifications.cancelAllScheduledNotificationsAsync();

    let remaining = MAX_SCHEDULED;
    const now = new Date();

    // (a) Daily briefing at 7:00 AM — the Today Command Center load:
    // "N actions today · M overdue" (today_actions semantics + cadence
    // cards). Skip entirely when there is nothing actionable.
    const load = todayLoad(followUps, partners);
    if (load.actions > 0) {
      const body = load.overdueCount > 0
        ? `${load.actions} ${load.actions === 1 ? 'action' : 'actions'} today · ${load.overdueCount} overdue`
        : `${load.actions} ${load.actions === 1 ? 'action' : 'actions'} today`;
      await Notifications.scheduleNotificationAsync({
        content: {
          title: 'ReferralFit briefing',
          body,
          data: { target: 'home' },
          ...(Platform.OS === 'android' ? { channelId: 'referralfit' } : null),
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DAILY,
          hour: 7,
          minute: 0,
          ...(Platform.OS === 'android' ? { channelId: 'referralfit' } : null),
        },
      });
      remaining -= 1;
    }

    // (a2) Consults with a due_time get their own reminder 30 minutes ahead —
    // these are appointments, not nags. Only future ones are scheduled
    // (today's already-passed consult is on the Home list anyway). Snoozed
    // consults fire on the snooze date instead.
    for (const followUp of followUps) {
      if (remaining <= 0) break;
      if (followUp.status !== 'open' || followUp.kind !== 'consult' || !followUp.dueTime) continue;
      const effectiveDue = followUp.snoozedUntil || followUp.dueOn;
      const parsed = new Date(`${effectiveDue}T12:00:00`);
      if (Number.isNaN(parsed.getTime())) continue;
      const [hour, minute] = followUp.dueTime.split(':').map(Number);
      const when = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), hour || 0, (minute || 0) - 30, 0);
      if (when.getTime() <= now.getTime()) continue;
      await Notifications.scheduleNotificationAsync({
        content: {
          title: 'Consult in 30 minutes',
          body: `${followUp.title} · ${followUp.dueTime}`,
          data: { target: 'home' },
          ...(Platform.OS === 'android' ? { channelId: 'referralfit' } : null),
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: when,
          ...(Platform.OS === 'android' ? { channelId: 'referralfit' } : null),
        },
      });
      remaining -= 1;
    }

    // (b) Per-partner cadence nags at 9:00 AM on the day they cross their
    // cadence; if already overdue, start tomorrow 9 AM and re-nag every
    // RENAG_DAYS days (next RENAG_OCCURRENCES occurrences max).
    const withCadence = partners.filter((partner) => partner.touchCadenceDays != null && partner.touchCadenceDays > 0);
    const candidates = withCadence
      .map((partner) => {
        const daysSince = daysSinceContact(partner);
        const cadence = partner.touchCadenceDays as number;
        const overdueBy = daysSince - cadence;
        const due = new Date(startOfToday());
        due.setDate(due.getDate() + (cadence - daysSince));
        return { partner, daysSince, overdueBy, due };
      })
      // Overdue partners first (most overdue at the front), then upcoming
      // nags ordered by how soon they cross their cadence.
      .sort((a, b) => (b.overdueBy - a.overdueBy) || (a.daysSince - b.daysSince));

    for (const { partner, daysSince, overdueBy, due } of candidates) {
      if (remaining <= 0) break;
      const dates: Date[] = [];
      if (overdueBy > 0) {
        const first = nextTime(9, 0);
        for (let occurrence = 0; occurrence < RENAG_OCCURRENCES; occurrence += 1) {
          const when = new Date(first);
          when.setDate(when.getDate() + occurrence * RENAG_DAYS);
          dates.push(when);
        }
      } else {
        let when = atTime(due, 9, 0);
        if (when.getTime() <= now.getTime()) {
          // Crosses the cadence today but 9 AM already passed — nag tomorrow.
          when = nextTime(9, 0);
        }
        dates.push(when);
      }
      for (const when of dates) {
        if (remaining <= 0) break;
        await Notifications.scheduleNotificationAsync({
          content: {
            title: 'ReferralFit',
            body: `Time to reach out to ${partner.name} — it's been ${daysSince} ${daysSince === 1 ? 'day' : 'days'}`,
            data: { target: 'directory', partnerId: partner.id },
            ...(Platform.OS === 'android' ? { channelId: 'referralfit' } : null),
          },
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.DATE,
            date: when,
            ...(Platform.OS === 'android' ? { channelId: 'referralfit' } : null),
          },
        });
        remaining -= 1;
      }
    }

    // (c) One reminder per open follow-up at 9:00 AM on its effective due
    // date (snooze-aware — a snoozed item nags on the snooze date). If that
    // day has already passed (or 9 AM has), the reminder goes to the next
    // 9 AM. Taps route to the home tab.
    const openFollowUps = followUps
      .filter((followUp) => followUp.status === 'open')
      .sort((a, b) => (a.snoozedUntil || a.dueOn).localeCompare(b.snoozedUntil || b.dueOn));
    const partnerById = new Map(partners.map((partner) => [partner.id, partner]));
    for (const followUp of openFollowUps) {
      if (remaining <= 0) break;
      const effectiveDue = followUp.snoozedUntil || followUp.dueOn;
      const parsed = new Date(`${effectiveDue}T12:00:00`);
      if (Number.isNaN(parsed.getTime())) continue;
      const dueDay = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
      let when = atTime(dueDay, 9, 0);
      if (when.getTime() <= now.getTime()) {
        // Due date already passed (or 9 AM today did) — remind tomorrow 9 AM.
        when = nextTime(9, 0);
      }
      const partnerName = followUp.partnerId ? partnerById.get(followUp.partnerId)?.name : undefined;
      await Notifications.scheduleNotificationAsync({
        content: {
          title: 'Follow-up due',
          body: partnerName ? `${followUp.title} — ${partnerName}` : followUp.title,
          data: { target: 'home' },
          ...(Platform.OS === 'android' ? { channelId: 'referralfit' } : null),
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: when,
          ...(Platform.OS === 'android' ? { channelId: 'referralfit' } : null),
        },
      });
      remaining -= 1;
    }
  } catch {
    // Notification scheduling must never break the app (e.g. in Expo Go or
    // on web, where local notifications are unsupported).
  }
}

// ─── Tap handling ───────────────────────────────────────────────────────────

export type NotificationTarget = 'home' | 'directory';

// Returns a cleanup function. The response listener covers taps while the app
// is running or backgrounded; getLastNotificationResponse covers a cold start
// from a notification tap.
export function subscribeToNotificationResponses(
  onTarget: (target: NotificationTarget, partnerId?: string) => void,
): () => void {
  const extract = (response: Notifications.NotificationResponse | null) => {
    const data = response?.notification?.request?.content?.data as { target?: string; partnerId?: string } | undefined;
    if (!data?.target) return;
    if (data.target === 'home' || data.target === 'directory') {
      onTarget(data.target, typeof data.partnerId === 'string' ? data.partnerId : undefined);
    }
  };

  const subscription = Notifications.addNotificationResponseReceivedListener(extract);
  Notifications.getLastNotificationResponseAsync().then(extract).catch(() => undefined);
  return () => subscription.remove();
}
