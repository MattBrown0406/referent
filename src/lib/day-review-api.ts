// Day review: calling the day-review Edge Function with the user's own
// Anthropic key, and saving approved rows through the writes the app already
// makes (create_lead, case events, partner touches, follow-ups, referrals,
// import_partners). The rules live in day-review.ts. See docs/DAY_REVIEW.md.

import { createLead } from './cases';
import {
  caseEventWrite,
  followUpWrite,
  leadWrite,
  newPartnerWrite,
  partnerTouchWrite,
  readFoundItems,
  referralWrite,
  type FoundItem,
  type ReviewRow,
} from './day-review';
import { describeError } from './errors';
import { importPartners } from './partner-import-api';
import { createFollowUp, createReferral, logContactActivity } from './store';
import { supabase } from './supabase';

export type ReviewFailureReason =
  | 'offline' // no connection; try again later
  | 'key' // no key, or Anthropic refused this one: set it up again
  | 'limit' // the daily cap
  | 'refused' // the model declined these notes
  | 'unavailable'; // anything else, usually passing

export class ReviewUnavailableError extends Error {
  constructor(message: string, readonly reason: ReviewFailureReason) {
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

const OFFLINE_MESSAGE = 'No connection. Your notes are still here; try again when you are back online.';
const KEY_CODES = ['key_required', 'key_invalid', 'key_forbidden'];
// The function answers within about 55 seconds (its Anthropic deadline);
// stop waiting just after that, before iOS's own one-minute request timeout
// would surface as "no connection".
const DAY_REVIEW_CLIENT_TIMEOUT_MS = 58_000;

/**
 * Sends the notes and today's date (nothing else from the workspace) and
 * returns what the function found. The key rides in the request body, never
 * a header, and is never stored by the function.
 */
export async function requestDayReview(notes: string, today: string, apiKey: string): Promise<{ items: FoundItem[]; remaining: number | null }> {
  let result: Awaited<ReturnType<typeof supabase.functions.invoke>>;
  try {
    result = await supabase.functions.invoke('day-review', {
      body: { text: notes, today, anthropicKey: apiKey },
      timeout: DAY_REVIEW_CLIENT_TIMEOUT_MS,
    });
  } catch {
    throw new ReviewUnavailableError(OFFLINE_MESSAGE, 'offline');
  }
  if (result.error) {
    const name = (result.error as { name?: string }).name || '';
    const cause = (result.error as { context?: { name?: unknown } }).context;
    if (name === 'FunctionsFetchError' && cause?.name === 'AbortError') {
      throw new ReviewUnavailableError('The review took too long. Try a shorter part of the day.', 'unavailable');
    }
    if (name === 'FunctionsFetchError' || name === 'FunctionsRelayError') throw new ReviewUnavailableError(OFFLINE_MESSAGE, 'offline');
    const payload = await functionErrorBody(result.error);
    const code = payload.error?.code || '';
    const message = payload.error?.message || 'Review is unavailable right now.';
    if (KEY_CODES.includes(code)) throw new ReviewUnavailableError(message, 'key');
    if (code === 'daily_limit') throw new ReviewUnavailableError(message, 'limit');
    if (code === 'refused') throw new ReviewUnavailableError(message, 'refused');
    throw new ReviewUnavailableError(message, 'unavailable');
  }
  const data = result.data as { items?: unknown; remaining?: unknown } | null;
  if (!data || !Array.isArray(data.items)) {
    throw new ReviewUnavailableError('The review came back unreadable. Try again.', 'unavailable');
  }
  return { items: readFoundItems(data.items), remaining: typeof data.remaining === 'number' ? data.remaining : null };
}

export type SaveResult = {
  /** The row is in ReferralFit (or queued to send when back online, as every write in the app is). */
  saved: boolean;
  /** Why it was not saved; or, when saved, what still needs doing by hand. */
  message: string;
};

const SAVED: SaveResult = { saved: true, message: '' };

// A follow-up or referral is a plain insert under the row's own id. When a
// save is tried again after a failure that happened after the row landed,
// the second insert is refused as a duplicate; the row is there, so it is
// saved.
async function alreadyThere(table: 'follow_ups' | 'referrals', id: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.from(table).select('id').eq('id', id).maybeSingle();
    return !error && Boolean(data);
  } catch {
    return false;
  }
}

export type SaveOptions = {
  today: string;
  /** A new lead's first call: the time it is due today (HH:MM), from the practice's lead response target. */
  leadDueTime: string | null;
  /** A referral sent despite a license concern: the line kept on it (integrity.ts licenseOverrideNote). */
  licenseNote?: string;
};

/**
 * Saves one approved row under the ids it was given when the review was
 * built, so trying again writes the same records, never second copies.
 */
const likeExactly = (value: string) => value.replace(/[\\%_]/g, (match) => `\\${match}`);

/** The partner an import skipped as already there: by directory listing, email, or organization. */
async function existingPartnerId(importRow: NonNullable<ReturnType<typeof newPartnerWrite>>): Promise<string | null> {
  const attempts = 'global_id' in importRow
    ? [supabase.from('partners').select('id').eq('global_partner_id', importRow.global_id).limit(1)]
    : [
      importRow.email ? supabase.from('partners').select('id').ilike('email', likeExactly(importRow.email)).limit(1) : null,
      importRow.organization ? supabase.from('partners').select('id').ilike('organization', likeExactly(importRow.organization)).limit(1) : null,
    ];
  for (const attempt of attempts) {
    if (!attempt) continue;
    const { data, error } = await attempt;
    const id = !error && Array.isArray(data) ? (data[0] as { id?: unknown } | undefined)?.id : null;
    if (typeof id === 'string') return id;
  }
  return null;
}

export async function saveReviewRow(row: ReviewRow, userId: string, options: SaveOptions): Promise<SaveResult> {
  const now = new Date().toISOString();
  const { today } = options;
  try {
    switch (row.kind) {
      case 'new_lead': {
        // create_lead treats a repeat of a lead that already landed as success.
        await createLead({
          caseId: row.ids.caseId,
          contactId: row.ids.contactId,
          followUpId: row.ids.followUpId,
          ...leadWrite(row),
          dueOn: today,
          dueTime: options.leadDueTime,
        }, userId);
        return SAVED;
      }
      case 'case_note':
        // log_contact_activity upserts by id: a repeat changes nothing.
        await logContactActivity(caseEventWrite(row, now), null, userId);
        return SAVED;
      case 'partner_note':
        await logContactActivity(null, partnerTouchWrite(row, now), userId);
        return SAVED;
      case 'follow_up': {
        const write = followUpWrite(row);
        try {
          await createFollowUp(write, userId);
        } catch (error) {
          if (await alreadyThere('follow_ups', write.id)) return SAVED;
          throw error;
        }
        return SAVED;
      }
      case 'referral': {
        const write = referralWrite(row, today, options.licenseNote);
        try {
          await createReferral(write, userId);
        } catch (error) {
          if (await alreadyThere('referrals', write.id)) return SAVED;
          throw error;
        }
        return SAVED;
      }
      case 'new_partner': {
        const importRow = newPartnerWrite(row);
        if (!importRow) return { saved: false, message: 'Nothing to add.' };
        const result = await importPartners([importRow], userId);
        let partnerId = result.ids?.[0];
        if (!result.added && !result.linked && !partnerId) {
          // Already in the network (or imported by a try that lost its
          // answer): the note still belongs on that partner.
          const existing = row.text.trim() ? await existingPartnerId(importRow) : null;
          if (!existing) return { saved: true, message: 'Already in your network: nothing was added.' };
          partnerId = existing;
          try {
            await logContactActivity(null, partnerTouchWrite(row, now, partnerId), userId);
          } catch {
            return { saved: true, message: 'Already in your network, but the note could not be saved. Add it from the partner.' };
          }
          return { saved: true, message: 'Already in your network: the note was added to it.' };
        }
        // What was said about them is the new partner's first touch. The
        // partner is in either way: a failed note is saved with a message,
        // so a second tap never imports the partner again.
        if (!partnerId) return { saved: true, message: 'The partner was added. Add the note from the partner.' };
        if (row.text.trim()) {
          try {
            await logContactActivity(null, partnerTouchWrite(row, now, partnerId), userId);
          } catch {
            return { saved: true, message: 'The partner was added, but the note could not be saved. Add it from the partner.' };
          }
        }
        return SAVED;
      }
    }
  } catch (error) {
    return { saved: false, message: describeError(error) };
  }
}
