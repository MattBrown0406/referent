import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

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

export type NotificationKind = 'new_lead' | 'assigned_to_me' | 'overdue_mine' | 'directory_decision' | 'directory_submission';

export type NotificationPreferences = {
  pushEnabled: boolean;
  newLead: boolean;
  assignedToMe: boolean;
  overdueMine: boolean;
  directoryDecision: boolean;
  directorySubmission: boolean; // platform admins only; ignored server-side for everyone else
};

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  pushEnabled: false,
  newLead: true,
  assignedToMe: true,
  overdueMine: true,
  directoryDecision: true,
  directorySubmission: false,
};

export const NOTIFICATION_KIND_ROWS: { key: NotificationKind; label: string; description: string; adminOnly?: boolean }[] = [
  { key: 'new_lead', label: 'A new lead arrives', description: 'From the intake link or a teammate’s quick-add, until someone takes it.' },
  { key: 'assigned_to_me', label: 'Something is assigned to me', description: 'A case or follow-up a teammate hands to you.' },
  { key: 'overdue_mine', label: 'My follow-ups are past due', description: 'One reminder a day, around 9 AM your time.' },
  { key: 'directory_decision', label: 'A directory decision', description: 'When ReferralFit reviews a listing your practice submitted.' },
  { key: 'directory_submission', label: 'A new directory submission', description: 'Platform admins only.', adminOnly: true },
];

const KIND_COLUMNS: Record<NotificationKind, keyof NotificationPreferences> = {
  new_lead: 'newLead',
  assigned_to_me: 'assignedToMe',
  overdue_mine: 'overdueMine',
  directory_decision: 'directoryDecision',
  directory_submission: 'directorySubmission',
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
  };
}

export type PreferencesState = {
  preferences: NotificationPreferences;
  // false when the server does not have the team-basics migration yet (the
  // table is missing): the card explains instead of offering switches.
  available: boolean;
};

export async function fetchNotificationPreferences(userId: string): Promise<PreferencesState> {
  const { data, error } = await supabase
    .from('notification_preferences')
    .select('push_enabled, new_lead, assigned_to_me, overdue_mine, directory_decision, directory_submission')
    .eq('user_id', userId)
    .maybeSingle();
  if (error?.code === '42P01') return { preferences: DEFAULT_NOTIFICATION_PREFERENCES, available: false };
  if (error) throw new StoreError(error.message || 'Could not load notification settings.', false);
  return { preferences: mapPreferences(data as PreferencesRow | null), available: true };
}

export async function saveNotificationPreferences(userId: string, preferences: NotificationPreferences): Promise<void> {
  const { error } = await supabase.from('notification_preferences').upsert({
    user_id: userId,
    push_enabled: preferences.pushEnabled,
    new_lead: preferences.newLead,
    assigned_to_me: preferences.assignedToMe,
    overdue_mine: preferences.overdueMine,
    directory_decision: preferences.directoryDecision,
    directory_submission: preferences.directorySubmission,
    tz_offset_minutes: deviceTzOffsetMinutes(),
  }, { onConflict: 'user_id' });
  if (error) throw new StoreError(error.message || 'Could not save notification settings.', false);
}

// ─── Device registration ────────────────────────────────────────────────────

let registeredToken: string | null = null;

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
// permission must already be granted.
export async function registerThisDevice(): Promise<PushRegistration> {
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
  return { ok: true, token };
}

// The user-initiated path from Workspace settings: ask the OS (once), then
// register. Returns the reason when it cannot be turned on.
export async function enablePush(): Promise<PushRegistration> {
  if (Platform.OS === 'web') return { ok: false, reason: 'Push notifications are not available on the web.' };
  const granted = await requestNotificationPermission();
  if (!granted) return { ok: false, reason: 'Notifications are off for ReferralFit in your phone’s Settings. Turn them on there, then try again.' };
  return registerThisDevice();
}

// Sign-in: keep the registration fresh for members who turned push on.
// Silent by design; any failure is simply "no push on this device".
export async function refreshPushRegistration(userId: string): Promise<void> {
  try {
    const { preferences, available } = await fetchNotificationPreferences(userId);
    if (!available || !preferences.pushEnabled) return;
    await registerThisDevice();
  } catch {
    // Offline, or the server does not have push yet.
  }
}

// Sign-out on this device: stop every push for this token.
export async function unregisterThisDevice(): Promise<void> {
  const token = registeredToken;
  registeredToken = null;
  if (!token) return;
  try {
    await supabase.rpc('unregister_push_token', { p_token: token });
  } catch {
    // Best effort; the dispatcher prunes a dead token on its own.
  }
}
