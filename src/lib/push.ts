import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { currentAuthSessionIdentity } from './auth-session';
import { StoreError } from './errors';
import { getNotificationPermissionState, requestNotificationPermission } from './notifications';
import { supabase } from './supabase';

// Server-sent push (Expo push) for a practice with staff: device
// registration and the per-member "Notify me about..." choices. See
// docs/NOTIFICATIONS.md. Everything degrades: when the build has no push
// project, the device is a simulator, the OS permission is off, or the
// migration is not applied yet, nothing crashes and the settings explain.
//
// The OS permission prompt is only ever raised from enablePush(), which the
// Workspace screen calls when the member turns push on. Sign-in refreshes a
// registration silently and never prompts.

export type NotificationKind = 'new_lead' | 'assigned_to_me' | 'overdue_mine' | 'directory_decision' | 'directory_submission' | 'bed_opened';

export type NotificationPreferences = {
  pushEnabled: boolean;
  newLead: boolean;
  assignedToMe: boolean;
  overdueMine: boolean;
  directoryDecision: boolean;
  directorySubmission: boolean; // platform admins only; ignored server-side for everyone else
  bedOpened: boolean; // opt-in: a program you favorited or added to your network opens a bed
};

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  pushEnabled: false,
  newLead: true,
  assignedToMe: true,
  overdueMine: true,
  directoryDecision: true,
  directorySubmission: false,
  bedOpened: false,
};

export const NOTIFICATION_KIND_ROWS: { key: NotificationKind; label: string; description: string; adminOnly?: boolean }[] = [
  { key: 'new_lead', label: 'A new lead arrives', description: 'From the intake link or a teammate’s quick-add, until someone takes it.' },
  { key: 'assigned_to_me', label: 'Something is assigned to me', description: 'A case or follow-up a teammate hands to you.' },
  { key: 'overdue_mine', label: 'My follow-ups are past due', description: 'One reminder a day, around 9 AM your time.' },
  { key: 'directory_decision', label: 'A directory decision', description: 'When ReferralFit reviews a listing your practice submitted.' },
  { key: 'bed_opened', label: 'A bed opens at a program I follow', description: 'When a program you favorited or added to your network goes from full or unknown to a bed open. Off until you turn it on.' },
  { key: 'directory_submission', label: 'A new directory submission', description: 'Platform admins only.', adminOnly: true },
];

const KIND_COLUMNS: Record<NotificationKind, keyof NotificationPreferences> = {
  new_lead: 'newLead',
  assigned_to_me: 'assignedToMe',
  overdue_mine: 'overdueMine',
  directory_decision: 'directoryDecision',
  directory_submission: 'directorySubmission',
  bed_opened: 'bedOpened',
};

export function preferenceFor(preferences: NotificationPreferences, kind: NotificationKind): boolean {
  return Boolean(preferences[KIND_COLUMNS[kind]]);
}

export function withPreference(preferences: NotificationPreferences, kind: NotificationKind, value: boolean): NotificationPreferences {
  return { ...preferences, [KIND_COLUMNS[kind]]: value };
}

// Minutes east of UTC for the device right now (JavaScript reports the
// opposite sign). Drives the 9 AM overdue reminder.
export function deviceTzOffsetMinutes(now = new Date()): number {
  return -now.getTimezoneOffset();
}

type PreferencesRow = {
  push_enabled: boolean;
  new_lead: boolean;
  assigned_to_me: boolean;
  overdue_mine: boolean;
  directory_decision: boolean;
  directory_submission: boolean;
  // Added by 20261001150000_bed_availability.sql; absent on an older server.
  bed_opened?: boolean | null;
};

function mapPreferences(row: PreferencesRow | null): NotificationPreferences {
  if (!row) return DEFAULT_NOTIFICATION_PREFERENCES;
  return {
    pushEnabled: Boolean(row.push_enabled),
    newLead: Boolean(row.new_lead),
    assignedToMe: Boolean(row.assigned_to_me),
    overdueMine: Boolean(row.overdue_mine),
    directoryDecision: Boolean(row.directory_decision),
    directorySubmission: Boolean(row.directory_submission),
    bedOpened: Boolean(row.bed_opened),
  };
}

export type PreferencesState = {
  preferences: NotificationPreferences;
  // false when the server does not have the team-basics migration yet (the
  // table is missing): the card explains instead of offering switches.
  available: boolean;
};

const BASE_PREFERENCE_COLUMNS = 'push_enabled, new_lead, assigned_to_me, overdue_mine, directory_decision, directory_submission';

// 42703: a column the server does not have yet (the bed-availability
// migration is newer than the database). Read and write without it so the
// other switches keep working; bed_opened then reads as off.
const UNDEFINED_COLUMN = '42703';

export async function fetchNotificationPreferences(userId: string): Promise<PreferencesState> {
  let { data, error } = await supabase
    .from('notification_preferences')
    .select(`${BASE_PREFERENCE_COLUMNS}, bed_opened`)
    .eq('user_id', userId)
    .maybeSingle();
  if (error?.code === UNDEFINED_COLUMN) {
    ({ data, error } = await supabase
      .from('notification_preferences')
      .select(BASE_PREFERENCE_COLUMNS)
      .eq('user_id', userId)
      .maybeSingle());
  }
  if (error?.code === '42P01') return { preferences: DEFAULT_NOTIFICATION_PREFERENCES, available: false };
  if (error) throw new StoreError(error.message || 'Could not load notification settings.', false);
  return { preferences: mapPreferences(data as PreferencesRow | null), available: true };
}

export async function saveNotificationPreferences(userId: string, preferences: NotificationPreferences): Promise<void> {
  const row = {
    user_id: userId,
    push_enabled: preferences.pushEnabled,
    new_lead: preferences.newLead,
    assigned_to_me: preferences.assignedToMe,
    overdue_mine: preferences.overdueMine,
    directory_decision: preferences.directoryDecision,
    directory_submission: preferences.directorySubmission,
    tz_offset_minutes: deviceTzOffsetMinutes(),
  };
  let { error } = await supabase.from('notification_preferences').upsert({ ...row, bed_opened: preferences.bedOpened }, { onConflict: 'user_id' });
  if (error?.code === UNDEFINED_COLUMN) {
    ({ error } = await supabase.from('notification_preferences').upsert(row, { onConflict: 'user_id' }));
  }
  if (error) throw new StoreError(error.message || 'Could not save notification settings.', false);
}

// ─── Device registration ────────────────────────────────────────────────────

// The Expo push token this device registered, per account, on disk: an
// in-memory copy alone is gone after an app restart, and an offline launch
// never re-registers, so sign-out could not tell the server to stop pushing to
// this device. `pendingUnregister` marks a sign-out (or push turned off) whose
// unregister call could not reach the server; it is retried the next time
// this account signs in on this device.
const PUSH_REGISTRATION_KEY_PREFIX = 'referralfit-push-registration-v1:';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type StoredPushRegistration = { version: 1; userId: string; token: string; pendingUnregister?: boolean };

let registeredToken: string | null = null;
let registeredUserId: string | null = null;

function pushRegistrationKey(userId: string): string | null {
  return UUID_RE.test(userId) ? `${PUSH_REGISTRATION_KEY_PREFIX}${userId.toLowerCase()}` : null;
}

async function readStoredRegistration(userId: string): Promise<StoredPushRegistration | null> {
  const key = pushRegistrationKey(userId);
  if (!key) return null;
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPushRegistration>;
    if (parsed.version !== 1 || typeof parsed.token !== 'string' || !parsed.token
        || typeof parsed.userId !== 'string' || parsed.userId.toLowerCase() !== userId.toLowerCase()) return null;
    return { version: 1, userId: parsed.userId.toLowerCase(), token: parsed.token, ...(parsed.pendingUnregister ? { pendingUnregister: true } : {}) };
  } catch {
    return null;
  }
}

// Best effort: a device that cannot save the record behaves as before.
async function writeStoredRegistration(userId: string, token: string, pendingUnregister = false): Promise<void> {
  const key = pushRegistrationKey(userId);
  if (!key) return;
  const record: StoredPushRegistration = { version: 1, userId: userId.toLowerCase(), token, ...(pendingUnregister ? { pendingUnregister: true } : {}) };
  try {
    await AsyncStorage.setItem(key, JSON.stringify(record));
  } catch {
    // ignore
  }
}

async function clearStoredRegistration(userId: string): Promise<void> {
  const key = pushRegistrationKey(userId);
  if (!key) return;
  try {
    await AsyncStorage.removeItem(key);
  } catch {
    // ignore
  }
}

// The account a registration belongs to: the caller's, else the session on
// this device (read offline-tolerantly; it is only a storage key here).
async function registrationOwner(userId?: string): Promise<string | null> {
  if (userId) return userId.toLowerCase();
  try {
    return (await currentAuthSessionIdentity({ allowOffline: true }))?.userId ?? null;
  } catch {
    return null;
  }
}

// A sign-out we did not start (the session was revoked or expired on the
// server, or forceLocalSignOut) never ran unregisterThisDevice. Mark every
// registration still on this device for unregister at the next sign-in on it
// (refreshPushRegistration — same account, or any other account).
export async function markRegistrationsForUnregister(): Promise<void> {
  registeredToken = null;
  registeredUserId = null;
  let keys: readonly string[];
  try {
    keys = await AsyncStorage.getAllKeys();
  } catch {
    return;
  }
  for (const key of keys) {
    if (!key.startsWith(PUSH_REGISTRATION_KEY_PREFIX)) continue;
    const record = await readStoredRegistration(key.slice(PUSH_REGISTRATION_KEY_PREFIX.length));
    if (record && !record.pendingUnregister) await writeStoredRegistration(record.userId, record.token, true);
  }
}

let signOutWatchInstalled = false;
function watchSignOut(): void {
  if (signOutWatchInstalled) return;
  const auth = supabase.auth as unknown as { onAuthStateChange?: (callback: (event: string) => void) => unknown };
  if (typeof auth.onAuthStateChange !== 'function') return;
  signOutWatchInstalled = true;
  auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') void markRegistrationsForUnregister();
  });
}
watchSignOut();

export type PushRegistration = { ok: true; token: string } | { ok: false; reason: string };

// Why a device cannot register, in plain words. None of these is an error
// the member can fix in the app, so the card says so instead of alerting.
export function describeRegistrationFailure(error: unknown): string {
  const code = (error as { code?: string })?.code || '';
  const message = (error as { message?: string })?.message || '';
  if (code === 'ERR_NOTIFICATIONS_NO_EXPERIENCE_ID' || /projectId/i.test(message)) {
    return 'This build has no push project configured yet.';
  }
  if (/simulator|not supported|E_REGISTRATION_FAILED|aps-environment|entitlement/i.test(message)) {
    return 'Push is not available on this device or build yet.';
  }
  return 'Push is not available on this device yet.';
}

async function expoPushToken(): Promise<string> {
  // expo-notifications reads the EAS projectId from app.json
  // (extra.eas.projectId) itself and throws ERR_NOTIFICATIONS_NO_EXPERIENCE_ID
  // when the build has none.
  const { data } = await Notifications.getExpoPushTokenAsync();
  return data;
}

// Register this device for the signed-in account. Never prompts: the OS
// permission must already be granted. `userId` (optional) names the account;
// without it the signed-in session's user is used.
export async function registerThisDevice(userId?: string): Promise<PushRegistration> {
  if (Platform.OS === 'web') return { ok: false, reason: 'Push notifications are not available on the web.' };
  if (await getNotificationPermissionState() !== 'authorized') {
    return { ok: false, reason: 'Notifications are off for ReferralFit in your phone’s Settings.' };
  }
  let token: string;
  try {
    token = await expoPushToken();
  } catch (error) {
    return { ok: false, reason: describeRegistrationFailure(error) };
  }
  const { error } = await supabase.rpc('register_push_token', {
    p_token: token,
    p_platform: Platform.OS === 'android' ? 'android' : 'ios',
    p_tz_offset_minutes: deviceTzOffsetMinutes(),
  });
  if (error) {
    // 42883: the RPC does not exist yet (migration not applied).
    if (error.code === '42883' || error.code === 'PGRST202') return { ok: false, reason: 'Push is not set up on the server yet.' };
    return { ok: false, reason: error.message || 'The device could not be registered.' };
  }
  registeredToken = token;
  const owner = await registrationOwner(userId);
  registeredUserId = owner;
  if (owner) await writeStoredRegistration(owner, token);
  return { ok: true, token };
}

// The user-initiated path from Workspace settings: ask the OS (once), then
// register. Returns the reason when it cannot be turned on.
export async function enablePush(userId?: string): Promise<PushRegistration> {
  if (Platform.OS === 'web') return { ok: false, reason: 'Push notifications are not available on the web.' };
  const granted = await requestNotificationPermission();
  if (!granted) return { ok: false, reason: 'Notifications are off for ReferralFit in your phone’s Settings. Turn them on there, then try again.' };
  return registerThisDevice(userId);
}

// Other accounts on this device whose sign-out could not unregister the
// device (no connection at the time).
async function otherAccountsPendingUnregister(userId: string): Promise<StoredPushRegistration[]> {
  let keys: readonly string[];
  try {
    keys = await AsyncStorage.getAllKeys();
  } catch {
    return [];
  }
  const own = pushRegistrationKey(userId);
  const records: StoredPushRegistration[] = [];
  for (const key of keys) {
    if (!key.startsWith(PUSH_REGISTRATION_KEY_PREFIX) || key === own) continue;
    const record = await readStoredRegistration(key.slice(PUSH_REGISTRATION_KEY_PREFIX.length));
    if (record?.pendingUnregister) records.push(record);
  }
  return records;
}

// Only a token's owner can unregister it (unregister_push_token deletes WHERE
// user_id = auth.uid(), and there is no session-less path), but
// register_push_token moves a token to the caller and deletes every other
// account's row for it. So the signed-in account claims the old account's
// token and then releases it: the device stops receiving the old account's
// pushes, and receives this account's only if it registers below.
async function releaseOtherAccountToken(record: StoredPushRegistration): Promise<boolean> {
  const claimed = await supabase.rpc('register_push_token', {
    p_token: record.token,
    p_platform: Platform.OS === 'android' ? 'android' : 'ios',
    p_tz_offset_minutes: null,
  });
  if (claimed.error) return false; // retried at the next sign-in or launch
  const released = await supabase.rpc('unregister_push_token', { p_token: record.token });
  return !released.error;
}

// Sign-in (any account): keep the registration fresh for members who turned
// push on, and finish any unregister that could not reach the server at an
// earlier sign-out on this device — this account's or another account's.
// Silent by design; any failure is simply "no push on this device", retried
// at the next sign-in or launch.
export async function refreshPushRegistration(userId: string): Promise<void> {
  try {
    const stored = await readStoredRegistration(userId);
    if (stored) {
      registeredToken = stored.token;
      registeredUserId = stored.userId;
    }
    const others = await otherAccountsPendingUnregister(userId);
    const { preferences, available } = await fetchNotificationPreferences(userId);
    if (!available) return;
    let registeredNow: string | null = null;
    if (preferences.pushEnabled) {
      const registration = await registerThisDevice(userId);
      if (registration.ok) registeredNow = registration.token;
    } else if (stored?.pendingUnregister) {
      await unregisterThisDevice(userId);
    }
    for (const record of others) {
      // Registering this account already moved the same token away from them.
      if ((registeredNow && registeredNow === record.token) || await releaseOtherAccountToken(record)) {
        await clearStoredRegistration(record.userId);
      }
    }
  } catch {
    // Offline, or the server does not have push yet.
  }
}

// Sign-out (or push turned off) on this device: stop every push for this
// token. Works after an app restart or an offline launch because the token is
// read back from disk; if the server cannot be reached the unregister is
// remembered and retried at this account's next sign-in. `userId` (optional)
// names the account; without it the signed-in session's user is used.
export async function unregisterThisDevice(userId?: string): Promise<void> {
  const owner = await registrationOwner(userId ?? registeredUserId ?? undefined);
  const stored = owner ? await readStoredRegistration(owner) : null;
  const memoryToken = registeredToken && (!owner || !registeredUserId || registeredUserId === owner) ? registeredToken : null;
  const token = memoryToken ?? stored?.token ?? null;
  registeredToken = null;
  registeredUserId = null;
  if (!token) return;
  let reached = false;
  let offline = false;
  try {
    // An expired session with no connection would make the call below wait
    // out supabase-js's refresh retries first; skip straight to "retry later".
    offline = Boolean((await currentAuthSessionIdentity({ allowOffline: true }))?.offline);
  } catch {
    offline = false;
  }
  if (!offline) {
    try {
      const { error } = await supabase.rpc('unregister_push_token', { p_token: token });
      // Any answer from the server (even "no such function") means retrying
      // later would not help; only a lost connection is retried.
      reached = !error || !isLostConnection(error);
    } catch (error) {
      reached = !isLostConnection(error);
    }
  }
  if (!owner) return;
  if (reached) await clearStoredRegistration(owner);
  else await writeStoredRegistration(owner, token, true);
}

function isLostConnection(error: unknown): boolean {
  const value = error as { name?: unknown; message?: unknown; code?: unknown; status?: unknown } | null;
  if (!value) return false;
  if (value.name === 'AuthRetryableFetchError') return true;
  if (typeof value.status === 'number' || (typeof value.code === 'string' && /^[0-9A-Z]{5}$/.test(value.code))) return false;
  const message = String(value.message ?? '').toLowerCase();
  return message.includes('network request failed') || message.includes('failed to fetch') || message.includes('fetch failed')
    || message.includes('timeout') || message.includes('offline') || message.includes('internet');
}
