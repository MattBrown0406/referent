import { requireOptionalNativeModule } from 'expo';
import * as Clipboard from 'expo-clipboard';
import * as SecureStore from 'expo-secure-store';
import { Alert, Linking, Platform } from 'react-native';

import {
  digitsForPhone,
  looksLikeAnthropicKey,
  mailtoUrl,
  smsUrl,
  type CallDraft,
  type DraftRequestBody,
  type OutreachDraft,
} from './outreach';
import { beginOverlay } from './overlay';
import { supabase } from './supabase';

// ─── AI drafts (the draft-follow-up Edge Function) ──────────────────────────

export type DraftFailureReason =
  | 'offline' // no connection; try again later
  | 'key' // no key, or Anthropic refused this one: set it up again
  | 'limit' // the daily cap
  | 'refused' // the model declined this request
  | 'unavailable'; // anything else, usually transient

export class DraftUnavailableError extends Error {
  constructor(message: string, readonly reason: DraftFailureReason) {
    super(message);
  }
}

type FunctionErrorBody = { error?: { code?: string; message?: string } };

async function functionErrorBody(error: unknown): Promise<FunctionErrorBody> {
  const context = (error as { context?: unknown }).context;
  if (context && typeof (context as Response).json === 'function') {
    try {
      return await (context as Response).clone().json() as FunctionErrorBody;
    } catch {
      return {};
    }
  }
  return {};
}

const OFFLINE_MESSAGE = 'No connection. Write this one yourself, or try again when you are back online.';
const KEY_CODES = ['key_required', 'key_invalid', 'key_forbidden'];
// The function answers within about 50 seconds (its Anthropic deadline);
// stop waiting just after that, before iOS's own one-minute request timeout
// would surface as "no connection".
const DRAFT_CLIENT_TIMEOUT_MS = 56_000;

// The user's own Anthropic key rides along in the request body on every call
// (never a header: platform request logs can record headers); the function
// uses it for that one request and never stores it.
async function invokeDraftFunction(body: Record<string, unknown>, apiKey: string): Promise<unknown> {
  let result: Awaited<ReturnType<typeof supabase.functions.invoke>>;
  try {
    result = await supabase.functions.invoke('draft-follow-up', { body: { ...body, anthropicKey: apiKey }, timeout: DRAFT_CLIENT_TIMEOUT_MS });
  } catch {
    throw new DraftUnavailableError(OFFLINE_MESSAGE, 'offline');
  }
  if (result.error) {
    const name = (result.error as { name?: string }).name || '';
    const cause = (result.error as { context?: { name?: unknown } }).context;
    if (name === 'FunctionsFetchError' && cause?.name === 'AbortError') {
      throw new DraftUnavailableError('The draft took too long. Write this one yourself, or try again.', 'unavailable');
    }
    if (name === 'FunctionsFetchError' || name === 'FunctionsRelayError') throw new DraftUnavailableError(OFFLINE_MESSAGE, 'offline');
    const payload = await functionErrorBody(result.error);
    const code = payload.error?.code || '';
    const message = payload.error?.message || 'Drafting is unavailable right now.';
    if (KEY_CODES.includes(code)) throw new DraftUnavailableError(message, 'key');
    if (code === 'daily_limit') throw new DraftUnavailableError(message, 'limit');
    if (code === 'refused') throw new DraftUnavailableError(message, 'refused');
    throw new DraftUnavailableError(message, 'unavailable');
  }
  return result.data;
}

function isDraft(value: unknown): value is OutreachDraft {
  const draft = value as Partial<OutreachDraft> | null;
  if (!draft || typeof draft !== 'object') return false;
  if (draft.channel === 'text') return typeof (draft as { body?: unknown }).body === 'string';
  if (draft.channel === 'email') return typeof (draft as { subject?: unknown }).subject === 'string' && typeof (draft as { body?: unknown }).body === 'string';
  if (draft.channel === 'call') {
    const call = draft as Partial<CallDraft>;
    return typeof call.opener === 'string' && typeof call.voicemail === 'string' && Array.isArray(call.talkingPoints);
  }
  return false;
}

export async function requestOutreachDraft(body: DraftRequestBody, apiKey: string): Promise<{ draft: OutreachDraft; remaining: number | null }> {
  const data = await invokeDraftFunction(body as unknown as Record<string, unknown>, apiKey) as { draft?: unknown; remaining?: unknown } | null;
  if (!data || !isDraft(data.draft)) {
    throw new DraftUnavailableError('The draft came back unreadable. Try again.', 'unavailable');
  }
  return { draft: data.draft, remaining: typeof data.remaining === 'number' ? data.remaining : null };
}

// One free call (Anthropic's model list) through the function: proves the key
// works before it is saved. Throws DraftUnavailableError with reason 'key'
// when Anthropic refuses it.
export async function verifyAnthropicKey(apiKey: string): Promise<void> {
  const data = await invokeDraftFunction({ action: 'verify' }, apiKey) as { ok?: unknown } | null;
  if (!data || data.ok !== true) throw new DraftUnavailableError('The key could not be checked. Try again.', 'unavailable');
}

// The practice name signs emails. RLS limits the read to the caller's org.
export async function fetchPracticeName(): Promise<string> {
  try {
    const { data, error } = await supabase.from('orgs').select('name').maybeSingle();
    if (error || !data) return '';
    return typeof data.name === 'string' ? data.name : '';
  } catch {
    return '';
  }
}

// ─── The user's own Anthropic key, on this device only ──────────────────────
// One per account per device, never sent to ReferralFit's database. On the
// phone: the keychain, never synced (WHEN_UNLOCKED_THIS_DEVICE_ONLY keeps it
// out of iCloud Keychain and backups). In a browser (Matt, 2026-11-21): this
// browser's own storage for this account, or only this tab
// (sessionStorage) when the practitioner chooses; every copy in the browser
// is removed at sign-out (removeBrowserAnthropicKeys). Saving it is also the
// consent to AI drafts: the setup screen says exactly what is shared and
// with whom first (App Review 5.1.2(i)).

export const aiKeysSupported = Platform.OS === 'ios' || Platform.OS === 'android' || Platform.OS === 'web';
export const KEY_IN_BROWSER = Platform.OS === 'web';

const KEY_PREFIX = 'referralfit.anthropicKey.v1.';

function keyName(userId: string): string {
  return `${KEY_PREFIX}${userId.toLowerCase().replace(/[^a-z0-9._-]/g, '')}`;
}

type BrowserStore = { getItem(name: string): string | null; setItem(name: string, value: string): void; removeItem(name: string): void; key(index: number): string | null; readonly length: number };

/** This browser's storage, or null (private mode can refuse it; never on the phone). */
function browserStore(kind: 'local' | 'session'): BrowserStore | null {
  if (!KEY_IN_BROWSER) return null;
  try {
    const scope = globalThis as unknown as { localStorage?: BrowserStore; sessionStorage?: BrowserStore };
    return (kind === 'local' ? scope.localStorage : scope.sessionStorage) ?? null;
  } catch {
    return null;
  }
}

/** Where this browser keeps the key for this account: 'tab' (only until the tab closes), 'browser', or null. */
export function browserKeyScope(userId: string): 'tab' | 'browser' | null {
  if (!KEY_IN_BROWSER || !userId) return null;
  try {
    if (browserStore('session')?.getItem(keyName(userId))) return 'tab';
    if (browserStore('local')?.getItem(keyName(userId))) return 'browser';
  } catch { /* storage refused */ }
  return null;
}

export async function getAnthropicKey(userId: string): Promise<string | null> {
  if (!aiKeysSupported || !userId) return null;
  try {
    const key = KEY_IN_BROWSER
      ? browserStore('session')?.getItem(keyName(userId)) ?? browserStore('local')?.getItem(keyName(userId)) ?? null
      : await SecureStore.getItemAsync(keyName(userId));
    return key && looksLikeAnthropicKey(key) ? key : null;
  } catch {
    return null;
  }
}

/**
 * In a browser, every account's key leaves it except `keepUserId`'s (the
 * account signed in here now): at sign-out, account deletion, a session
 * that ended, or another account signing in.
 */
export function removeBrowserAnthropicKeys(keepUserId?: string): void {
  const keep = keepUserId ? keyName(keepUserId) : null;
  for (const kind of ['local', 'session'] as const) {
    const store = browserStore(kind);
    if (!store) continue;
    try {
      const names: string[] = [];
      for (let index = 0; index < store.length; index += 1) {
        const name = store.key(index);
        if (name && name.startsWith(KEY_PREFIX) && name !== keep) names.push(name);
      }
      for (const name of names) store.removeItem(name);
    } catch { /* storage refused: nothing was kept */ }
  }
}

// Whoever depends on there being a key (the recordings count behind the Today
// card and the day review reminder) hears when one is saved or removed.
const keyListeners = new Set<(userId: string) => void>();

/** Calls back after this phone's Anthropic key is saved or removed. Returns the unsubscribe. */
export function onAnthropicKeyChange(listener: (userId: string) => void): () => void {
  keyListeners.add(listener);
  return () => { keyListeners.delete(listener); };
}

function keyChanged(userId: string): void {
  for (const listener of [...keyListeners]) {
    try { listener(userId); } catch { /* a listener's failure is its own */ }
  }
}

export async function saveAnthropicKey(userId: string, apiKey: string, options: { tabOnly?: boolean } = {}): Promise<void> {
  if (!aiKeysSupported) throw new Error('AI drafts need the iPhone app.');
  // Never a key with no account in its name: nothing could read it back or remove it.
  if (!userId) throw new Error('Sign in again, then add your key.');
  if (KEY_IN_BROWSER) {
    const keep = browserStore(options.tabOnly ? 'session' : 'local');
    if (!keep) throw new Error('This browser does not let ReferralFit keep the key (a private window can refuse). Try a normal window.');
    try {
      keep.setItem(keyName(userId), apiKey);
    } catch {
      throw new Error('This browser did not keep the key. Try a normal window.');
    }
    // Only one copy: the other storage forgets this account's key.
    try { browserStore(options.tabOnly ? 'local' : 'session')?.removeItem(keyName(userId)); } catch { /* nothing kept */ }
  } else {
    await SecureStore.setItemAsync(keyName(userId), apiKey, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  }
  keyChanged(userId);
}

export async function removeAnthropicKey(userId: string): Promise<void> {
  if (!aiKeysSupported || !userId) return;
  if (KEY_IN_BROWSER) {
    for (const kind of ['local', 'session'] as const) {
      try { browserStore(kind)?.removeItem(keyName(userId)); } catch { /* nothing kept */ }
    }
  } else {
    await SecureStore.deleteItemAsync(keyName(userId)).catch(() => undefined);
  }
  keyChanged(userId);
}

// ─── Sending from the phone's own apps ──────────────────────────────────────
// 'sent' and 'cancelled' come from the iOS Messages / Mail compose sheets,
// which report what the user did. 'unknown' means the app handed off to
// another app (or Android, which never reports) and the user is asked.

export type SendResult = 'sent' | 'cancelled' | 'unknown' | 'failed';

type SmsModule = typeof import('expo-sms');
type MailModule = typeof import('expo-mail-composer');

// Loaded lazily and only when the native module is in this binary: an older
// build without it (or an over-the-air update to one) falls back to links
// instead of crashing at launch.
let smsModule: SmsModule | null | undefined;
let mailModule: MailModule | null | undefined;

function loadSms(): SmsModule | null {
  if (smsModule !== undefined) return smsModule;
  try {
    smsModule = Platform.OS !== 'web' && requireOptionalNativeModule('ExpoSMS') ? require('expo-sms') as SmsModule : null;
  } catch {
    smsModule = null;
  }
  return smsModule;
}

function loadMail(): MailModule | null {
  if (mailModule !== undefined) return mailModule;
  try {
    mailModule = Platform.OS !== 'web' && requireOptionalNativeModule('ExpoMailComposer') ? require('expo-mail-composer') as MailModule : null;
  } catch {
    mailModule = null;
  }
  return mailModule;
}

async function openUrl(url: string): Promise<boolean> {
  try {
    // The web opens at once: Safari allows a mail window only during the tap.
    if (Platform.OS === 'web') {
      await Linking.openURL(url);
      return true;
    }
    if (!(await Linking.canOpenURL(url))) return false;
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}

// Messages reports back only through its delegate, so if iOS ever lets the
// compose sheet go without calling it, sendSMSAsync never settles and the
// overlay would block every later sheet. The follow-up sheet releases it when
// it closes: the user reaching that sheet means the compose sheet is gone.
let releasePendingCompose: (() => void) | null = null;

function beginComposeOverlay(): () => void {
  const endOverlay = beginOverlay();
  const end = () => {
    endOverlay();
    if (releasePendingCompose === end) releasePendingCompose = null;
  };
  releasePendingCompose = end;
  return end;
}

export function releaseComposeOverlay() {
  releasePendingCompose?.();
}

// A browser cannot send a text: the message goes on the clipboard to send
// from the practitioner's phone, and the sheet then asks whether it went.
async function copyTextForPhone(phone: string, body: string): Promise<SendResult> {
  try {
    if (!(await Clipboard.setStringAsync(body))) return 'failed';
  } catch {
    return 'failed';
  }
  Alert.alert('Text copied', `A browser can't send texts. Paste it into a message to ${phone.trim()} from your phone.`);
  return 'unknown';
}

export async function sendTextMessage(phone: string, body: string): Promise<SendResult> {
  const digits = digitsForPhone(phone);
  if (!digits) return 'failed';
  if (Platform.OS === 'web') return copyTextForPhone(phone, body);
  const sms = loadSms();
  if (sms) {
    try {
      if (await sms.isAvailableAsync()) {
        const endOverlay = beginComposeOverlay();
        try {
          const { result } = await sms.sendSMSAsync([digits], body);
          return result;
        } finally {
          endOverlay();
        }
      }
    } catch {
      // Fall through to the Messages link.
    }
  }
  return (await openUrl(smsUrl(digits, body, Platform.OS))) ? 'unknown' : 'failed';
}

export async function sendEmailMessage(email: string, subject: string, body: string): Promise<SendResult> {
  const mail = loadMail();
  if (mail) {
    try {
      if (await mail.isAvailableAsync()) {
        const endOverlay = beginComposeOverlay();
        let status: string;
        try {
          ({ status } = await mail.composeAsync({ recipients: [email.trim()], subject, body }));
        } finally {
          endOverlay();
        }
        if (status === 'sent') return 'sent';
        // Saved as a draft is not sent; nothing is logged.
        if (status === 'cancelled' || status === 'saved') return 'cancelled';
        return 'unknown';
      }
    } catch {
      // Fall through to the mailto link (Gmail, Outlook, …).
    }
  }
  return (await openUrl(mailtoUrl(email, subject, body))) ? 'unknown' : 'failed';
}

export async function placeCall(phone: string): Promise<SendResult> {
  const digits = digitsForPhone(phone);
  if (!digits) return 'failed';
  // A browser cannot place a call (a computer has no dialer): it shows the
  // number, as every other Call on the web does, and goes on only once the
  // practitioner says they called from their phone.
  if (Platform.OS === 'web') {
    return new Promise<SendResult>((resolve) => {
      Alert.alert(
        'Call',
        `${phone.trim()}\n\nA browser can't place calls. Use your phone, then come back to log how it went.`,
        [
          { text: 'Not now', style: 'cancel', onPress: () => resolve('cancelled') },
          { text: 'I called', onPress: () => resolve('unknown') },
        ],
        { cancelable: true, onDismiss: () => resolve('cancelled') },
      );
    });
  }
  return (await openUrl(`tel:${digits}`)) ? 'unknown' : 'failed';
}

