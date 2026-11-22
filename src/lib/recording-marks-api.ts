// Which recordings were reviewed, on ReferralFit's server
// (public.day_review_recordings; docs/DAY_REVIEW.md, "Fieldy on the web"):
// read back under row-level security (each account sees only its own rows),
// written through public.day_review_mark_recordings, which joins what it is
// sent with what is there and never takes a mark away. The rules are in
// src/lib/recording-marks.ts.
//
// Sent: recording ids, times, and fingerprints (one-way hashes). Never a
// recording's words, a summary, a transcript, or a recorder's sign-in.
//
// Before the migration is applied the server answers "unknown table or
// function": these calls then answer null / false and the device keeps the
// marks on its own, as before. Asked again after a while, so the app picks
// the table up once it exists without being opened again.

import { inGroups, idGroups, notOnServerYet, type MarkRow, type ServerMark } from './recording-marks';
import { supabase } from './supabase';

const RECHECK_MISSING_MS = 10 * 60_000;
let missingSince = 0;

const codeOf = (error: unknown) => (error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined);

/** The server is known to be without the table (checked again every ten minutes). */
function knownMissing(): boolean {
  return missingSince > 0 && Date.now() - missingSince < RECHECK_MISSING_MS;
}

function noted(error: unknown): void {
  if (notOnServerYet(codeOf(error))) missingSince = Date.now();
}

/**
 * Only for the account signed in on this device now: a call made for
 * another account (a sign-out or a switch on its way) is never sent, so one
 * account's marks never land on another's rows.
 */
async function signedInAs(userId: string): Promise<boolean> {
  if (!userId) return false;
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.user?.id === userId;
  } catch {
    return false;
  }
}

/**
 * The server's marks for these recordings of one recorder, or null when the
 * server cannot say (no table yet, offline, another account signed in).
 */
export async function fetchServerMarks(recorder: string, userId: string, ids: string[]): Promise<ServerMark[] | null> {
  if (knownMissing() || !(await signedInAs(userId))) return null;
  const out: ServerMark[] = [];
  for (const group of idGroups(ids)) {
    const { data, error } = await supabase
      .from('day_review_recordings')
      .select('recording_id, reviewed_at, failing_since, unreviewable_since, unreviewable_tried_at, saved_at, fingerprints')
      .eq('user_id', userId)
      .eq('recorder', recorder)
      .in('recording_id', group);
    if (error) {
      noted(error);
      return null;
    }
    if (Array.isArray(data)) out.push(...(data as ServerMark[]));
  }
  missingSince = 0;
  return out;
}

/**
 * These marks joined into the server's, in calls of at most 200. True only
 * when every call was taken; false when any was not (the device then copies
 * everything it keeps up again later).
 */
export async function sendServerMarks(recorder: string, userId: string, rows: MarkRow[]): Promise<boolean> {
  if (!rows.length) return true;
  if (knownMissing() || !(await signedInAs(userId))) return false;
  for (const group of inGroups(rows)) {
    const { error } = await supabase.rpc('day_review_mark_recordings', { p_recorder: recorder, p_marks: group });
    if (error) {
      noted(error);
      return false;
    }
  }
  missingSince = 0;
  return true;
}
