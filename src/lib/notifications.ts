import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import type { Partner, Referral, ReferralMatch } from '../data';
import type { CaseRecord } from './cases';
import type { FollowUp } from './store';

// ─── Behavior ───────────────────────────────────────────────────────────────

let handlerInstalled = false;
let scheduleGeneration = 0;
let scheduleOwnerId: string | null = null;
let scheduleChain: Promise<void> = Promise.resolve();
const handledResponseIds = new Set<string>();

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

export type NotificationPermissionState = 'authorized' | 'askable' | 'blocked' | 'unsupported';

async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('referralfit', {
    name: 'ReferralFit',
    importance: Notifications.AndroidImportance.DEFAULT,
  });
}

export function permissionAllowsNotifications(status: Notifications.NotificationPermissionsStatus): boolean {
  if (status.granted) return true;
  const iosStatus = status.ios?.status;
  return iosStatus === Notifications.IosAuthorizationStatus.AUTHORIZED
    || iosStatus === Notifications.IosAuthorizationStatus.PROVISIONAL
    || iosStatus === Notifications.IosAuthorizationStatus.EPHEMERAL;
}

export async function getNotificationPermissionState(): Promise<NotificationPermissionState> {
  ensureNotificationHandler();
  if (Platform.OS === 'web') return 'unsupported';
  try {
    await ensureAndroidChannel();
    const current = await Notifications.getPermissionsAsync();
    if (permissionAllowsNotifications(current)) return 'authorized';
    return current.canAskAgain ? 'askable' : 'blocked';
  } catch {
    return 'unsupported';
  }
}

// Native permission requests are deliberately isolated to this user-initiated
// function. Background hydration/sync paths may inspect permission, but must
// never cause an OS prompt.
export async function requestNotificationPermission(): Promise<boolean> {
  ensureNotificationHandler();
  if (Platform.OS === 'web') return false;
  try {
    await ensureAndroidChannel();
    const current = await Notifications.getPermissionsAsync();
    if (permissionAllowsNotifications(current)) return true;
    if (!current.canAskAgain) return false;
    const requested = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: true, allowSound: true },
    });
    return permissionAllowsNotifications(requested);
  } catch {
    return false;
  }
}

// ─── Going-cold formula (mirrors the partners_going_cold view) ──────────────

function startOfToday(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function daysBetween(a: Date, b: Date): number {
  const aDay = startOfToday(a).getTime();
  const bDay = startOfToday(b).getTime();
  return Math.round((bDay - aDay) / 86400000);
}

function daysSinceContact(partner: Partner, now = new Date()): number {
  const basis = partner.lastContact || partner.createdAt || '';
  const parsed = new Date(basis);
  const basisDay = Number.isNaN(parsed.getTime()) ? startOfToday(now) : startOfToday(parsed);
  return Math.max(0, daysBetween(basisDay, now));
}

export type ColdPartner = { partner: Partner; daysSince: number; overdueBy: number };

export function partnersGoingCold(partners: Partner[], now = new Date()): ColdPartner[] {
  return partners
    .filter((partner) => partner.touchCadenceDays != null && partner.touchCadenceDays > 0)
    .map((partner) => {
      const daysSince = daysSinceContact(partner, now);
      const cadence = partner.touchCadenceDays as number;
      return { partner, daysSince, overdueBy: daysSince - cadence };
    })
    .filter((entry) => entry.overdueBy > 0)
    .sort((a, b) => b.overdueBy - a.overdueBy);
}

// ─── Scheduling ─────────────────────────────────────────────────────────────

const MAX_SCHEDULED = 50; // iOS hard limit is 64 — stay well under it.
const RENAG_DAYS = 2;
const RENAG_OCCURRENCES = 3;

function nextTime(hour: number, minute: number, now = new Date()): Date {
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
  followUps?: FollowUp[];
  cases?: CaseRecord[];
};

function dateStamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function followUpsDue(followUps: FollowUp[], now = new Date()): FollowUp[] {
  const today = dateStamp(startOfToday(now));
  return followUps
    .filter((followUp) => followUp.status === 'open' && (followUp.snoozedUntil || followUp.dueOn) <= today)
    .sort((a, b) => (a.snoozedUntil || a.dueOn).localeCompare(b.snoozedUntil || b.dueOn));
}

export function todayLoad(followUps: FollowUp[], partners: Partner[], now = new Date()): { actions: number; overdueCount: number } {
  const today = dateStamp(startOfToday(now));
  const due = followUpsDue(followUps, now);
  // Once a snooze expires, overdue age follows the original due date just like
  // today_actions/buildTodaySections; the snooze controls visibility, not age.
  const overdueCount = due.filter((followUp) => followUp.dueOn < today).length;
  const cadenceDue = partners
    .filter((partner) => partner.touchCadenceDays != null && partner.touchCadenceDays > 0)
    .filter((partner) => daysSinceContact(partner, now) >= (partner.touchCadenceDays as number))
    .length;
  return { actions: due.length + cadenceDue, overdueCount };
}

function queueScheduleWork(work: () => Promise<void>): Promise<void> {
  const next = scheduleChain.catch(() => undefined).then(work);
  scheduleChain = next;
  return next;
}

async function scheduleIfCurrent(
  generation: number,
  ownerId: string,
  request: Notifications.NotificationRequestInput,
): Promise<boolean> {
  if (!isScheduleCurrent(generation, ownerId)) return false;
  await Notifications.scheduleNotificationAsync(request);
  return isScheduleCurrent(generation, ownerId);
}

function isScheduleCurrent(generation: number, ownerId: string): boolean {
  return generation === scheduleGeneration && ownerId === scheduleOwnerId;
}

async function replaceSchedule(input: NotificationInput, generation: number, ownerId: string): Promise<void> {
  const permission = await getNotificationPermissionState();
  if (!isScheduleCurrent(generation, ownerId)) return;
  if (permission !== 'authorized') {
    await Notifications.cancelAllScheduledNotificationsAsync();
    return;
  }

  await Notifications.cancelAllScheduledNotificationsAsync();
  if (!isScheduleCurrent(generation, ownerId)) return;

  const { partners, followUps = [] } = input;
  let remaining = MAX_SCHEDULED;
  const now = new Date();

  // Static copy is intentional: a repeating notification cannot carry a live
  // count. The current count is shown after the user opens the app.
  if (remaining > 0 && await scheduleIfCurrent(generation, ownerId, {
    content: {
      title: 'ReferralFit briefing',
      body: "Open ReferralFit to review today's actions.",
      data: { target: 'home', ownerId },
      ...(Platform.OS === 'android' ? { channelId: 'referralfit' } : null),
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DAILY,
      hour: 7,
      minute: 0,
      ...(Platform.OS === 'android' ? { channelId: 'referralfit' } : null),
    },
  })) remaining -= 1;

  for (const followUp of followUps) {
    if (remaining <= 0 || !isScheduleCurrent(generation, ownerId)) break;
    if (followUp.status !== 'open' || followUp.kind !== 'consult' || !followUp.dueTime) continue;
    const effectiveDue = followUp.snoozedUntil || followUp.dueOn;
    const parsed = new Date(`${effectiveDue}T12:00:00`);
    if (Number.isNaN(parsed.getTime())) continue;
    const [hour, minute] = followUp.dueTime.split(':').map(Number);
    const when = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), hour || 0, (minute || 0) - 30, 0);
    if (when.getTime() <= now.getTime()) continue;
    if (await scheduleIfCurrent(generation, ownerId, {
      content: {
        title: 'Consult in 30 minutes',
        body: `${followUp.title} · ${followUp.dueTime}`,
        data: { target: 'home', ownerId },
        ...(Platform.OS === 'android' ? { channelId: 'referralfit' } : null),
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: when,
        ...(Platform.OS === 'android' ? { channelId: 'referralfit' } : null),
      },
    })) remaining -= 1;
  }

  const candidates = partners
    .filter((partner) => partner.touchCadenceDays != null && partner.touchCadenceDays > 0)
    .map((partner) => {
      const daysSince = daysSinceContact(partner, now);
      const cadence = partner.touchCadenceDays as number;
      const overdueBy = daysSince - cadence;
      const due = startOfToday(now);
      due.setDate(due.getDate() + (cadence - daysSince));
      return { partner, daysSince, overdueBy, due };
    })
    .sort((a, b) => (b.overdueBy - a.overdueBy) || (a.daysSince - b.daysSince));

  for (const { partner, daysSince, overdueBy, due } of candidates) {
    if (remaining <= 0 || !isScheduleCurrent(generation, ownerId)) break;
    const dates: Date[] = [];
    if (overdueBy > 0) {
      const first = nextTime(9, 0, now);
      for (let occurrence = 0; occurrence < RENAG_OCCURRENCES; occurrence += 1) {
        const when = new Date(first);
        when.setDate(when.getDate() + occurrence * RENAG_DAYS);
        dates.push(when);
      }
    } else {
      let when = atTime(due, 9, 0);
      if (when.getTime() <= now.getTime()) when = nextTime(9, 0, now);
      dates.push(when);
    }
    for (const when of dates) {
      if (remaining <= 0 || !isScheduleCurrent(generation, ownerId)) break;
      const ageAtDelivery = daysSince + Math.max(0, daysBetween(now, when));
      if (await scheduleIfCurrent(generation, ownerId, {
        content: {
          title: 'ReferralFit',
          body: `Time to reach out to ${partner.name} — it's been ${ageAtDelivery} ${ageAtDelivery === 1 ? 'day' : 'days'}`,
          data: { target: 'directory', partnerId: partner.id, ownerId },
          ...(Platform.OS === 'android' ? { channelId: 'referralfit' } : null),
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: when,
          ...(Platform.OS === 'android' ? { channelId: 'referralfit' } : null),
        },
      })) remaining -= 1;
    }
  }

  const openFollowUps = followUps
    .filter((followUp) => followUp.status === 'open' && !(followUp.kind === 'consult' && followUp.dueTime))
    .sort((a, b) => (a.snoozedUntil || a.dueOn).localeCompare(b.snoozedUntil || b.dueOn));
  const partnerById = new Map(partners.map((partner) => [partner.id, partner]));
  for (const followUp of openFollowUps) {
    if (remaining <= 0 || !isScheduleCurrent(generation, ownerId)) break;
    const effectiveDue = followUp.snoozedUntil || followUp.dueOn;
    const parsed = new Date(`${effectiveDue}T12:00:00`);
    if (Number.isNaN(parsed.getTime())) continue;
    const dueDay = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
    let when = atTime(dueDay, 9, 0);
    if (when.getTime() <= now.getTime()) when = nextTime(9, 0, now);
    const partnerName = followUp.partnerId ? partnerById.get(followUp.partnerId)?.name : undefined;
    if (await scheduleIfCurrent(generation, ownerId, {
      content: {
        title: 'Follow-up due',
        body: partnerName ? `${followUp.title} — ${partnerName}` : followUp.title,
        data: { target: 'home', ownerId },
        ...(Platform.OS === 'android' ? { channelId: 'referralfit' } : null),
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: when,
        ...(Platform.OS === 'android' ? { channelId: 'referralfit' } : null),
      },
    })) remaining -= 1;
  }
}

export function activateReferralFitNotificationOwner(ownerId: string): Promise<void> {
  scheduleOwnerId = ownerId;
  ++scheduleGeneration;
  return queueScheduleWork(async () => {
    await Notifications.cancelAllScheduledNotificationsAsync();
    await Notifications.dismissAllNotificationsAsync();
    await Notifications.clearLastNotificationResponseAsync();
  });
}

export function rescheduleNotifications(input: NotificationInput, ownerId: string): Promise<void> {
  if (!ownerId || ownerId !== scheduleOwnerId) return Promise.resolve();
  const generation = ++scheduleGeneration;
  return queueScheduleWork(() => replaceSchedule(input, generation, ownerId));
}

export function cancelReferralFitNotifications(): Promise<void> {
  scheduleOwnerId = null;
  ++scheduleGeneration;
  return queueScheduleWork(async () => {
    await Notifications.cancelAllScheduledNotificationsAsync();
    await Notifications.dismissAllNotificationsAsync();
    await Notifications.clearLastNotificationResponseAsync();
  });
}

// ─── Tap handling ───────────────────────────────────────────────────────────

export type NotificationTarget = 'home' | 'directory';

export function subscribeToNotificationResponses(
  onTarget: (target: NotificationTarget, partnerId?: string) => void,
): () => void {
  const extract = (response: Notifications.NotificationResponse | null) => {
    const requestId = response?.notification?.request?.identifier;
    if (!requestId || handledResponseIds.has(requestId)) return;
    const data = response.notification.request.content.data as { target?: string; partnerId?: string; ownerId?: string } | undefined;
    if (!scheduleOwnerId || data?.ownerId !== scheduleOwnerId) return;
    if (data?.target !== 'home' && data?.target !== 'directory') return;
    handledResponseIds.add(requestId);
    onTarget(data.target, typeof data.partnerId === 'string' ? data.partnerId : undefined);
  };

  const subscription = Notifications.addNotificationResponseReceivedListener(extract);
  Notifications.getLastNotificationResponseAsync()
    .then((response) => {
      extract(response);
      if (response) return Notifications.clearLastNotificationResponseAsync();
      return undefined;
    })
    .catch(() => undefined);
  return () => subscription.remove();
}
