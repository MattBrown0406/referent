import AsyncStorage from '@react-native-async-storage/async-storage';
import { requireOptionalNativeModule } from 'expo';
import { Linking, Platform } from 'react-native';

import {
  digitsForPhone,
  mailtoUrl,
  smsUrl,
  type CallDraft,
  type DraftRequestBody,
  type OutreachDraft,
} from './outreach';
import { supabase } from './supabase';

// ─── AI drafts (the draft-follow-up Edge Function) ──────────────────────────

export class DraftUnavailableError extends Error {
  // 'limit' and 'refused' are final for this request; the rest may clear up.
  constructor(message: string, readonly reason: 'offline' | 'limit' | 'refused' | 'unavailable') {
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

export async function requestOutreachDraft(body: DraftRequestBody): Promise<{ draft: OutreachDraft; remaining: number | null }> {
  let result: Awaited<ReturnType<typeof supabase.functions.invoke>>;
  try {
    result = await supabase.functions.invoke('draft-follow-up', { body });
  } catch {
    throw new DraftUnavailableError('No connection. Write this one yourself, or try again when you are back online.', 'offline');
  }
  if (result.error) {
    const name = (result.error as { name?: string }).name || '';
    if (name === 'FunctionsFetchError' || name === 'FunctionsRelayError') {
      throw new DraftUnavailableError('No connection. Write this one yourself, or try again when you are back online.', 'offline');
    }
    const payload = await functionErrorBody(result.error);
    const code = payload.error?.code || '';
    const message = payload.error?.message || 'Drafting is unavailable right now.';
    if (code === 'daily_limit') throw new DraftUnavailableError(message, 'limit');
    if (code === 'refused') throw new DraftUnavailableError(message, 'refused');
    throw new DraftUnavailableError(message, 'unavailable');
  }
  const data = result.data as { draft?: unknown; remaining?: unknown } | null;
  if (!data || !isDraft(data.draft)) {
    throw new DraftUnavailableError('The draft came back unreadable. Try again.', 'unavailable');
  }
  return { draft: data.draft, remaining: typeof data.remaining === 'number' ? data.remaining : null };
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

// ─── Consent before anything goes to the AI provider ────────────────────────
// Asked once per account on this device (App Review 5.1.2: say what is shared
// with a third-party AI and get permission first). Withdrawn by simply not
// using the AI button; nothing is sent until the user taps Draft.

const CONSENT_KEY_PREFIX = 'referralfit.outreach.aiConsent.v1:';

export async function hasAiDraftConsent(userId: string): Promise<boolean> {
  try {
    return Boolean(await AsyncStorage.getItem(`${CONSENT_KEY_PREFIX}${userId.toLowerCase()}`));
  } catch {
    return false;
  }
}

export async function saveAiDraftConsent(userId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(`${CONSENT_KEY_PREFIX}${userId.toLowerCase()}`, new Date().toISOString());
  } catch {
    // Not durable on this device: the sheet simply asks again next time.
  }
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
    if (!(await Linking.canOpenURL(url))) return false;
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}

export async function sendTextMessage(phone: string, body: string): Promise<SendResult> {
  const digits = digitsForPhone(phone);
  if (!digits) return 'failed';
  const sms = loadSms();
  if (sms) {
    try {
      if (await sms.isAvailableAsync()) {
        const { result } = await sms.sendSMSAsync([digits], body);
        return result;
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
        const { status } = await mail.composeAsync({ recipients: [email.trim()], subject, body });
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
  return (await openUrl(`tel:${digits}`)) ? 'unknown' : 'failed';
}

