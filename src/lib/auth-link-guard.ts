import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import { AUTH_FLOW_WINDOW_MS, normalizeEmail, type AuthFlowKind, type AuthFlowStarts } from './auth-flows';

// When this device last started a sign-up or a password reset (LoginScreen).
// App.tsx accepts tokens from a referralfit://auth/... link only for a flow
// started here in the last 24 hours (decideAuthLink in auth-flows.ts), and
// clears the record once a link has been used. Device-wide, not per account:
// nobody is signed in yet when these flows start.
const AUTH_FLOW_STARTS_KEY = 'referralfit.authFlowStarts.v1';

export async function readAuthFlowStarts(): Promise<AuthFlowStarts> {
  try {
    const raw = await AsyncStorage.getItem(AUTH_FLOW_STARTS_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const starts: AuthFlowStarts = {};
    for (const kind of ['signup', 'recovery'] as AuthFlowKind[]) {
      if (typeof parsed[kind] === 'number') starts[kind] = parsed[kind] as number;
    }
    return starts;
  } catch {
    return {};
  }
}

async function writeAuthFlowStarts(starts: AuthFlowStarts): Promise<void> {
  await AsyncStorage.setItem(AUTH_FLOW_STARTS_KEY, JSON.stringify(starts));
}

// The email each flow was started for, in the same 24 hours: a link is used
// only for one of them, so a genuine link to someone else's account (sent to
// a person who had just asked for their own) never signs this device into
// it. A few at once, for a mistyped address tried again.
const AUTH_FLOW_EMAILS_KEY = 'referralfit.authFlowEmails.v1';
const AUTH_FLOW_EMAILS_MAX = 5;

type FlowEmails = Partial<Record<AuthFlowKind, { email: string; at: number }[]>>;

async function readFlowEmails(): Promise<FlowEmails> {
  try {
    const raw = await AsyncStorage.getItem(AUTH_FLOW_EMAILS_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const out: FlowEmails = {};
    for (const kind of ['signup', 'recovery'] as AuthFlowKind[]) {
      const list = Array.isArray(parsed[kind]) ? parsed[kind] as unknown[] : [];
      out[kind] = list.flatMap((item) => {
        const entry = item as { email?: unknown; at?: unknown };
        return typeof entry?.email === 'string' && typeof entry.at === 'number' ? [{ email: entry.email, at: entry.at }] : [];
      });
    }
    return out;
  } catch {
    return {};
  }
}

// The emails this device started `kind` for in the last 24 hours, newest
// first ([] when none was recorded: an older build, or storage failed).
export async function readAuthFlowEmails(kind: AuthFlowKind, now = Date.now()): Promise<string[]> {
  const list = (await readFlowEmails())[kind] || [];
  // A future date (the clock was set back since) still counts: dropping it
  // would leave nothing to check a link against.
  return list.filter((entry) => now - entry.at <= AUTH_FLOW_WINDOW_MS).map((entry) => entry.email);
}

// Addresses older than the window leave this device (a shared computer
// keeps no typed address past the day it was asked for). Run at launch.
export async function pruneAuthFlowEmails(now = Date.now()): Promise<void> {
  try {
    const all = await readFlowEmails();
    let changed = false;
    for (const kind of ['signup', 'recovery'] as AuthFlowKind[]) {
      const kept = (all[kind] || []).filter((entry) => now - entry.at <= AUTH_FLOW_WINDOW_MS);
      if (kept.length !== (all[kind] || []).length) changed = true;
      if (kept.length) all[kind] = kept;
      else delete all[kind];
    }
    if (!changed) return;
    if (Object.keys(all).length) await AsyncStorage.setItem(AUTH_FLOW_EMAILS_KEY, JSON.stringify(all));
    else await AsyncStorage.removeItem(AUTH_FLOW_EMAILS_KEY);
  } catch {
    // ignored: read again, the entries are filtered anyway
  }
}

// Best effort: a storage failure must never block sign-up or a reset. The
// link then asks the user to sign in instead of signing them in by itself.
export async function recordAuthFlowStart(kind: AuthFlowKind, email: string, now = Date.now()): Promise<void> {
  try {
    await writeAuthFlowStarts({ ...await readAuthFlowStarts(), [kind]: now });
    const all = await readFlowEmails();
    const address = normalizeEmail(email);
    const kept = (all[kind] || []).filter((entry) => entry.email !== address && now - entry.at >= 0 && now - entry.at <= AUTH_FLOW_WINDOW_MS);
    all[kind] = [{ email: address, at: now }, ...kept].slice(0, AUTH_FLOW_EMAILS_MAX);
    await AsyncStorage.setItem(AUTH_FLOW_EMAILS_KEY, JSON.stringify(all));
  } catch {
    // ignored: see above
  }
}

// A link for this flow was used: the next one needs a fresh start.
export async function clearAuthFlowStart(kind: AuthFlowKind): Promise<void> {
  try {
    const starts = await readAuthFlowStarts();
    delete starts[kind];
    await writeAuthFlowStarts(starts);
    const emails = await readFlowEmails();
    delete emails[kind];
    await AsyncStorage.setItem(AUTH_FLOW_EMAILS_KEY, JSON.stringify(emails));
  } catch {
    // ignored: the record expires after 24 hours anyway
  }
}

// In a browser, the web app's own origin (https://app.referralfit.com): auth
// emails send people back there, and only links on it are read. null in the
// iPhone app.
export function currentWebOrigin(): string | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  return window.location.origin || null;
}

// A used (or refused) auth link's tokens must not stay in the address bar,
// the browser history, or a bookmark: replace the page URL with the app root.
export function clearAuthLinkFromAddressBar(): void {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  try {
    window.history.replaceState(null, '', '/');
  } catch {
    // ignored: the tokens are single-use and expire within the hour
  }
}
