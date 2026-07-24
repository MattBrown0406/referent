import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import type { Partner, Referral, ReferralMatch } from '../data';

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
};

// Recompute and reschedule everything: one daily 7 AM briefing (only when
// there is something worth saying), then per-partner cadence nags at 9 AM.
// Priority when capped: briefing first, then most-overdue partners.
export async function rescheduleNotifications({ partners, referralMatches, referrals }: NotificationInput): Promise<void> {
  ensureNotificationHandler();
  try {
    const granted = await ensureNotificationSetup();
    if (!granted) return;
    await Notifications.cancelAllScheduledNotificationsAsync();

    const cold = partnersGoingCold(partners);
    const matchesInProgress = referralMatches.filter((match) => match.status === 'Matching').length;
    const pendingReferrals = referrals.filter((referral) => referral.outcome === 'Pending').length;

    let remaining = MAX_SCHEDULED;

    // (a) Daily briefing at 7:00 AM — skip entirely when everything is zero.
    if (cold.length > 0 || matchesInProgress > 0 || pendingReferrals > 0) {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: 'ReferralFit briefing',
          body: `${cold.length} ${cold.length === 1 ? 'partner' : 'partners'} going cold · ${matchesInProgress} ${matchesInProgress === 1 ? 'match' : 'matches'} in progress · ${pendingReferrals} pending ${pendingReferrals === 1 ? 'referral' : 'referrals'}`,
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

    const now = new Date();
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
