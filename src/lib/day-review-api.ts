// Day review: calling the day-review Edge Function with the user's own
// Anthropic key, and saving approved rows through the writes the app already
// makes (create_lead, case events, partner touches, follow-ups, referrals,
// import_partners). The rules live in day-review.ts. See docs/DAY_REVIEW.md.

import { createLead, newUuid } from './cases';
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

/**
 * Saves one approved row. Resolves with '' when saved (or queued to send
 * when back online, as every write in the app is), or with the reason it
 * could not be.
 */
export async function saveReviewRow(row: ReviewRow, userId: string, today: string): Promise<string> {
  const now = new Date().toISOString();
  try {
    switch (row.kind) {
      case 'new_lead': {
        const lead = leadWrite(row);
        await createLead({
          caseId: newUuid(),
          contactId: newUuid(),
          followUpId: newUuid(),
          ...lead,
          dueOn: today,
          dueTime: null,
        }, userId);
        return '';
      }
      case 'case_note':
        await logContactActivity(caseEventWrite(row, newUuid(), now), null, userId);
        return '';
      case 'partner_note':
        await logContactActivity(null, partnerTouchWrite(row, newUuid(), now), userId);
        return '';
      case 'follow_up':
        await createFollowUp(followUpWrite(row, newUuid()), userId);
        return '';
      case 'referral':
        await createReferral(referralWrite(row, newUuid(), today), userId);
        return '';
      case 'new_partner': {
        const importRow = newPartnerWrite(row);
        if (!importRow) return 'Nothing to add.';
        const result = await importPartners([importRow], userId);
        if (!result.added && !result.linked) return 'Already in your network.';
        // What was said about them is the new partner's first touch.
        const partnerId = result.ids?.[0];
        if (partnerId && row.text.trim()) {
          try {
            await logContactActivity(null, partnerTouchWrite({ ...row, partnerId }, newUuid(), now), userId);
          } catch {
            return 'The partner was added, but the note could not be saved. Add it from the partner.';
          }
        }
        return '';
      }
    }
  } catch (error) {
    return describeError(error);
  }
}
