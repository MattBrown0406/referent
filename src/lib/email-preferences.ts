import { StoreError } from './errors';
import { supabase } from './supabase';

// Workspace > "Email me about...": the answer email and the morning summary
// (migration 20261108120000_email_alerts.sql, docs/EMAIL.md). Both work on
// the web and on iPhone; the server sends them. A server without the
// migration reads as unavailable and the card explains instead of offering
// switches. The device's time zone goes with every save, so the morning
// summary arrives around 7 AM where the member is.

export type EmailPreferences = {
  placementResponse: boolean;
  dailySummary: boolean;
};

export type EmailPreferencesState = {
  available: boolean;
  preferences: EmailPreferences;
};

export const DEFAULT_EMAIL_PREFERENCES: EmailPreferences = { placementResponse: true, dailySummary: false };

export const EMAIL_PREFERENCE_ROWS: { key: keyof EmailPreferences; label: string; description: string }[] = [
  {
    key: 'placementResponse',
    label: 'A program answers my placement request',
    description: 'A short email when programs answer, a couple of minutes after the first one. Program names and client details stay in the app.',
  },
  {
    key: 'dailySummary',
    label: 'A morning summary',
    description: 'Around 7 AM your time: how many new leads, follow-ups and program answers are waiting. Counts only, and only on days with something waiting.',
  },
];

export function emailTzOffsetMinutes(now = new Date()): number {
  return -now.getTimezoneOffset();
}

/** The server does not have the email migration yet. */
export function isMissingEmailFeature(error: { code?: string } | null | undefined): boolean {
  const code = error?.code;
  return code === 'PGRST202' || code === '42883' || code === '42P01';
}

type Row = { placement_response?: unknown; daily_summary?: unknown };

export function mapEmailPreferences(row: Row | null | undefined): EmailPreferences {
  if (!row) return DEFAULT_EMAIL_PREFERENCES;
  return {
    placementResponse: typeof row.placement_response === 'boolean' ? row.placement_response : DEFAULT_EMAIL_PREFERENCES.placementResponse,
    dailySummary: typeof row.daily_summary === 'boolean' ? row.daily_summary : DEFAULT_EMAIL_PREFERENCES.dailySummary,
  };
}

/** The RPC arguments for one change: the other choice is kept (null). */
export function emailPreferenceArgs(key: keyof EmailPreferences, value: boolean, now = new Date()) {
  return {
    p_placement_response: key === 'placementResponse' ? value : null,
    p_daily_summary: key === 'dailySummary' ? value : null,
    p_tz_offset_minutes: emailTzOffsetMinutes(now),
  };
}

export async function fetchEmailPreferences(): Promise<EmailPreferencesState> {
  const { data, error } = await supabase.rpc('get_email_preferences');
  if (isMissingEmailFeature(error)) return { available: false, preferences: DEFAULT_EMAIL_PREFERENCES };
  if (error) throw new StoreError(error.message || 'Could not load email settings.', false);
  return { available: true, preferences: mapEmailPreferences((Array.isArray(data) ? data[0] : data) as Row | null) };
}

export async function saveEmailPreference(key: keyof EmailPreferences, value: boolean): Promise<EmailPreferences> {
  const { data, error } = await supabase.rpc('set_email_preferences', emailPreferenceArgs(key, value));
  if (error) throw new StoreError(error.message || 'Could not save that choice.', false);
  return mapEmailPreferences((Array.isArray(data) ? data[0] : data) as Row | null);
}
