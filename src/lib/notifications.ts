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

// lastContact is a YYYY-MM-DD stamp: a LOCAL calendar day. new Date('2026-10-20')
// would be UTC midnight — the evening before in US time zones — and every
// cadence would count one day too many (mirrors partnerDaysSinceContact in
// today.ts, so reminders and Today agree).
function parseContactBasis(basis: string): Date {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(basis);
  return dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(basis);
}

function daysSinceContact(partner: Partner, now = new Date()): number {
  const basis = partner.lastContact || partner.createdAt || '';
  const parsed = parseContactBasis(basis);
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

// Lock-screen copy is generic on purpose. A reminder shows on a locked phone
// and in Notification Center, where anyone nearby can read it: no client,
// family, case, program, or partner name ever goes into a title or body.
// Counts and clock times are fine. The tap opens the app, which shows the item
// after unlock. (Server-sent pushes follow the same rule; docs/NOTIFICATIONS.md.)
export const GENERIC_FOLLOW_UP_BODY = 'A follow-up is due. Open ReferralFit to see it.';

function clockLabel(dueTime: string): string {
  const [hourRaw, minuteRaw] = dueTime.split(':');
  const hour24 = Number(hourRaw) || 0;
  const minute = String(minuteRaw || '00').padStart(2, '0').slice(0, 2);
  const hour = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour}:${minute} ${hour24 >= 12 ? 'PM' : 'AM'}`;
}
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
  // Whose reminders these are. Defaults to the schedule owner (the ownerId
  // passed to rescheduleNotifications, which App.tsx sets to the user id).
  userId?: string;
  // Who a case is assigned to; defaults to a lookup in `cases`.
  caseAssignee?: (caseId: string) => string | undefined;
  // 'mine' (default): follow-up reminders and consult alerts only for what is
  // assigned to this user, or to nobody (Today's Mine rule). 'everyone'
  // schedules every open follow-up in the workspace.
  scope?: 'mine' | 'everyone';
};

// Today's Mine rule (filterTodaySections / cardAssignee in today.ts): a
// follow-up is mine when it is assigned to me, or to nobody and its case is
// assigned to me or to nobody. Teammates' work never buzzes this phone.
export function followUpIsMine(
  followUp: FollowUp,
  userId: string,
  caseAssignee: (caseId: string) => string | undefined,
): boolean {
  const me = userId.toLowerCase();
  const assignee = followUp.assignedTo
    ? followUp.assignedTo.toLowerCase()
    : followUp.caseId ? caseAssignee(followUp.caseId)?.toLowerCase() : undefined;
  return !assignee || assignee === me;
}

// A closed or lost case's follow-ups stop reminding (Today hides them too,
// and the server skips them on close). A placement check-in still reminds:
// the family's outcome is worth recording after the case itself is done.
// Mirrors inactiveCaseIds / followUpOnInactiveCase in today.ts.
function followUpOnClosedCase(followUp: FollowUp, closedCaseIds: ReadonlySet<string>): boolean {
  return Boolean(followUp.caseId && closedCaseIds.has(followUp.caseId) && followUp.kind !== 'check_in');
}

// The follow-ups this device should remind about, per the input's scope.
export function reminderFollowUps(input: NotificationInput, ownerId: string): FollowUp[] {
  const closedCaseIds = new Set((input.cases || [])
    .filter((record) => record.status === 'closed' || record.status === 'lost')
    .map((record) => record.id));
  const followUps = (input.followUps || [])
    .filter((followUp) => followUp.status === 'open' && !followUpOnClosedCase(followUp, closedCaseIds));
  if (input.scope === 'everyone') return followUps;
  const userId = input.userId || ownerId;
  const assigneeByCase = new Map((input.cases || []).map((record) => [record.id, record.assignedTo]));
  const caseAssignee = input.caseAssignee ?? ((caseId: string) => assigneeByCase.get(caseId));
  return followUps.filter((followUp) => followUpIsMine(followUp, userId, caseAssignee));
}

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

export function todayLoad(
  followUps: FollowUp[],
  partners: Partner[],
  now = new Date(),
  cases: Pick<CaseRecord, 'id' | 'status'>[] = [],
): { actions: number; overdueCount: number } {
  const today = dateStamp(startOfToday(now));
  const closedCaseIds = new Set(cases.filter((record) => record.status === 'closed' || record.status === 'lost').map((record) => record.id));
  const due = followUpsDue(followUps, now).filter((followUp) => !followUpOnClosedCase(followUp, closedCaseIds));
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

  const { partners } = input;
  // The user's own follow-ups and consult alerts come before partner cadence
  // nags: with many partners past cadence the nags alone would use up the
  // MAX_SCHEDULED slots and the user's own reminders would never be set.
  const followUps = reminderFollowUps(input, ownerId);
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
        body: `Consult at ${clockLabel(followUp.dueTime)}`,
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

  const openFollowUps = followUps
    .filter((followUp) => followUp.status === 'open' && !(followUp.kind === 'consult' && followUp.dueTime))
    .sort((a, b) => (a.snoozedUntil || a.dueOn).localeCompare(b.snoozedUntil || b.dueOn));
  // Items whose 9:00 reminder time has already passed (overdue, or due today
  // after 9) would all fire at the next 9:00 at once — one summary instead.
  // Items due later each keep their own reminder on their day.
  const todayStamp = dateStamp(startOfToday(now));
  const pastDue: FollowUp[] = [];
  const upcoming: { followUp: FollowUp; when: Date }[] = [];
  for (const followUp of openFollowUps) {
    const effectiveDue = followUp.snoozedUntil || followUp.dueOn;
    const parsed = new Date(`${effectiveDue}T12:00:00`);
    if (Number.isNaN(parsed.getTime())) continue;
    const when = atTime(new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()), 9, 0);
    if (when.getTime() <= now.getTime()) pastDue.push(followUp);
    else upcoming.push({ followUp, when });
  }
  if (pastDue.length && remaining > 0 && isScheduleCurrent(generation, ownerId)) {
    const allOverdue = pastDue.every((followUp) => (followUp.snoozedUntil || followUp.dueOn) < todayStamp);
    const body = pastDue.length === 1
      ? GENERIC_FOLLOW_UP_BODY
      : allOverdue ? `${pastDue.length} overdue follow-ups` : `${pastDue.length} follow-ups due or overdue`;
    if (await scheduleIfCurrent(generation, ownerId, {
      content: {
        title: pastDue.length === 1 ? 'Follow-up due' : 'Follow-ups due',
        body,
        data: { target: 'home', ownerId },
        ...(Platform.OS === 'android' ? { channelId: 'referralfit' } : null),
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: nextTime(9, 0, now),
        ...(Platform.OS === 'android' ? { channelId: 'referralfit' } : null),
      },
    })) remaining -= 1;
  }
  for (const { when } of upcoming) {
    if (remaining <= 0 || !isScheduleCurrent(generation, ownerId)) break;
    if (await scheduleIfCurrent(generation, ownerId, {
      content: {
        title: 'Follow-up due',
        body: GENERIC_FOLLOW_UP_BODY,
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
          body: `Time to reach out to a referral partner — it's been ${ageAtDelivery} ${ageAtDelivery === 1 ? 'day' : 'days'}`,
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
}

export function activateReferralFitNotificationOwner(ownerId: string): Promise<void> {
  scheduleOwnerId = ownerId;
  ++scheduleGeneration;
  // A tap that launched the app arrived before anyone was signed in: hand it
  // over now (for this account only) — the work below clears the OS copy.
  deliverHeldTaps();
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

// Local reminders carry { target, partnerId, ownerId }. Server-sent pushes
// (see docs/NOTIFICATIONS.md) carry { kind, user_id, case_id, ... } and
// nothing private: the app resolves the item after sign-in. Either way a tap
// is honored only for the account the notification was addressed to.
export type NotificationTarget = 'home' | 'directory' | 'case' | 'workspace';

export type RemotePushData = {
  kind?: string;
  user_id?: string;
  case_id?: string;
  follow_up_id?: string;
  global_partner_id?: string;
};

export function remotePushTarget(data: RemotePushData): { target: NotificationTarget; caseId?: string } | null {
  switch (data.kind) {
    case 'new_lead':
    case 'assigned_to_me':
      return typeof data.case_id === 'string' && data.case_id ? { target: 'case', caseId: data.case_id } : { target: 'home' };
    case 'overdue_mine':
      return { target: 'home' };
    case 'directory_decision':
    case 'directory_submission':
      return { target: 'workspace' };
    case 'bed_opened':
      // The listing id is in data; the app opens the Directory, where the
      // live count shows. Nothing about the program is in the push itself.
      return { target: 'directory' };
    default:
      return null;
  }
}

type TapListener = (target: NotificationTarget, partnerId?: string, caseId?: string) => void;
type Tap = { requestId: string; ownerId: string; target: NotificationTarget; partnerId?: string; caseId?: string };

const tapListeners = new Set<TapListener>();
// Taps that arrived while no account was active yet (the app was launched by
// the tap, before hydration reached activateReferralFitNotificationOwner) or
// before anything subscribed. Bounded; another account's taps are dropped.
const heldTaps: Tap[] = [];
const MAX_HELD_TAPS = 10;

function tapOf(response: Notifications.NotificationResponse | null): Tap | null {
  const requestId = response?.notification?.request?.identifier;
  if (!requestId) return null;
  const data = response.notification.request.content.data as ({ target?: string; partnerId?: string; ownerId?: string } & RemotePushData) | undefined;
  if (!data) return null;
  if (typeof data.kind === 'string') {
    if (typeof data.user_id !== 'string' || !data.user_id) return null;
    const remote = remotePushTarget(data);
    if (!remote) return null;
    return { requestId, ownerId: data.user_id.toLowerCase(), target: remote.target, caseId: remote.caseId };
  }
  if (typeof data.ownerId !== 'string' || !data.ownerId) return null;
  if (data.target !== 'home' && data.target !== 'directory') return null;
  return { requestId, ownerId: data.ownerId.toLowerCase(), target: data.target, partnerId: typeof data.partnerId === 'string' ? data.partnerId : undefined };
}

// true when the tap is finished with (delivered, a duplicate, or another
// account's); false when it must wait for an owner or a subscriber.
function deliverTap(tap: Tap): boolean {
  if (handledResponseIds.has(tap.requestId)) return true;
  if (!scheduleOwnerId) return false;
  if (tap.ownerId !== scheduleOwnerId.toLowerCase()) return true;
  if (!tapListeners.size) return false;
  handledResponseIds.add(tap.requestId);
  for (const listener of Array.from(tapListeners)) listener(tap.target, tap.partnerId, tap.caseId);
  return true;
}

function receiveResponse(response: Notifications.NotificationResponse | null): void {
  const tap = tapOf(response);
  if (!tap || deliverTap(tap)) return;
  if (heldTaps.some((held) => held.requestId === tap.requestId)) return;
  heldTaps.push(tap);
  if (heldTaps.length > MAX_HELD_TAPS) heldTaps.shift();
}

function deliverHeldTaps(): void {
  const waiting = heldTaps.splice(0);
  for (const tap of waiting) if (!deliverTap(tap)) heldTaps.push(tap);
}

// The callback receives (target, partnerId, caseId). A tap is delivered once,
// only while its account is the active notification owner; a tap that
// arrives before the owner is set (cold start) is held and delivered when
// activateReferralFitNotificationOwner names that same account.
export function subscribeToNotificationResponses(onTarget: TapListener): () => void {
  tapListeners.add(onTarget);
  const subscription = Notifications.addNotificationResponseReceivedListener(receiveResponse);
  deliverHeldTaps();
  Notifications.getLastNotificationResponseAsync()
    .then((response) => {
      // Held in memory if it cannot be delivered yet, so the OS copy can go.
      receiveResponse(response);
      if (response) return Notifications.clearLastNotificationResponseAsync();
      return undefined;
    })
    .catch(() => undefined);
  return () => {
    tapListeners.delete(onTarget);
    subscription.remove();
  };
}
