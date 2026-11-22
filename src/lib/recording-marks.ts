// Which recordings were reviewed, kept on ReferralFit's server as well as on
// each device (docs/DAY_REVIEW.md, "Fieldy on the web"), so the phone and the
// web app never offer the same recording twice. The pure rules: the shape
// kept on a device, the rows sent to the server, and how the two are joined.
//
// What reaches the server is only a recording's id (the recorder's own), the
// times it was reviewed, failed or saved from, and the fingerprints of items
// saved from it: each one a short one-way hash (day-review.ts signatureHash,
// "h:" and at most 12 base-36 characters), never words. Anything else in a
// fingerprint list is dropped before it is sent, and the server refuses it
// too (supabase/migrations/20261122130000_day_review_recordings.sql).
//
// Joining never loses a mark: a recording reviewed on either side is
// reviewed; fingerprints are a union (the newest 200 kept); the earliest
// failure and "review failed" time are kept.
//
// No React, no network: scripts/fieldy-test.mjs covers this file.

/**
 * What a device keeps for one recorder and account. `saved` holds, per
 * recording, "<when> <fingerprint> <fingerprint> ...". `synced`: every mark
 * kept here is known to be on the server too (false until the first copy up,
 * and again after a write the server did not take).
 */
export type ReadState = {
  floor: string;
  reviewed: Record<string, string>;
  failing: Record<string, string>;
  saved: Record<string, string>;
  unreviewable: Record<string, string>;
  synced: boolean;
};

/** A row of public.day_review_recordings, as read back. */
export type ServerMark = {
  recording_id: string;
  reviewed_at: string | null;
  failing_since: string | null;
  unreviewable_since: string | null;
  unreviewable_tried_at: string | null;
  saved_at: string | null;
  fingerprints: string[] | null;
};

/** One recording's marks, sent to public.day_review_mark_recordings (merged there, never replacing). */
export type MarkRow = {
  id: string;
  reviewed_at?: string;
  failing_since?: string;
  clear_failing?: true;
  unreviewable_since?: string;
  unreviewable_tried_at?: string;
  clear_unreviewable?: true;
  saved_at?: string;
  fingerprints?: string[];
};

export const FINGERPRINT = /^h:[0-9a-z]{1,12}$/;
export const MAX_FINGERPRINTS = 200;
export const MAX_RECORDING_ID = 200;
/** Rows per call to the server (it refuses more). */
export const MARKS_PER_CALL = 200;

const validTime = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const validId = (id: string) => id.length > 0 && id.length <= MAX_RECORDING_ID;

/** The fingerprints in a kept `saved` entry ("<when> h:.. h:.."), only those that are fingerprints. */
export function fingerprintsOf(entry: string | undefined): string[] {
  return entry ? entry.split(' ').slice(1).filter((item) => FINGERPRINT.test(item)) : [];
}

/** `before` then `added`, each once, the newest `max` kept (as day-review.ts mergeFingerprints). */
export function unionNewest(before: string[], added: string[], max = MAX_FINGERPRINTS): string[] {
  const fresh = new Set(added);
  return [...new Set([...before.filter((item) => !fresh.has(item)), ...added])].filter(Boolean).slice(-max);
}

const earlier = (a: string | undefined, b: string | undefined) => (!a ? b : !b ? a : Date.parse(a) <= Date.parse(b) ? a : b);
const later = (a: string | undefined, b: string | undefined) => (!a ? b : !b ? a : Date.parse(a) >= Date.parse(b) ? a : b);

/**
 * The rows that put these recordings' marks on the server, from what this
 * device keeps. `clearFailing`: recordings read again after failing (their
 * failure clock stops); `clearUnreviewable`: recordings whose review came
 * back. A recording with nothing kept (and nothing cleared) sends nothing.
 */
export function rowsFor(state: ReadState, ids: Iterable<string>, clearFailing: Set<string> = new Set(), clearUnreviewable: Set<string> = new Set()): MarkRow[] {
  const out: MarkRow[] = [];
  for (const id of new Set(ids)) {
    if (!validId(id)) continue;
    if (validTime(state.reviewed[id])) {
      out.push({ id, reviewed_at: state.reviewed[id] });
      continue;
    }
    const row: MarkRow = { id };
    if (validTime(state.failing[id])) row.failing_since = state.failing[id];
    else if (clearFailing.has(id)) row.clear_failing = true;
    const [since, tried] = (state.unreviewable[id] || '').split(' ');
    if (validTime(since)) {
      row.unreviewable_since = since;
      if (validTime(tried)) row.unreviewable_tried_at = tried;
    } else if (clearUnreviewable.has(id)) row.clear_unreviewable = true;
    const saved = state.saved[id];
    const savedAt = saved?.split(' ')[0];
    const fingerprints = fingerprintsOf(saved).slice(-MAX_FINGERPRINTS);
    if (validTime(savedAt) && fingerprints.length) {
      row.saved_at = savedAt;
      row.fingerprints = fingerprints;
    }
    if (Object.keys(row).length > 1) out.push(row);
  }
  return out;
}

/** Every recording this device keeps a mark for. */
export function idsIn(state: ReadState): string[] {
  return [...new Set([...Object.keys(state.reviewed), ...Object.keys(state.failing), ...Object.keys(state.saved), ...Object.keys(state.unreviewable)])];
}

/**
 * This device's state with the server's marks joined in (a new object;
 * `local` is not changed). Reviewed on either side: reviewed, and whatever
 * else was kept for it goes. Otherwise the earliest failure and "review
 * failed" times, and every fingerprint (the newest 200).
 */
export function withServerMarks(local: ReadState, marks: ServerMark[]): ReadState {
  const next: ReadState = {
    ...local, reviewed: { ...local.reviewed }, failing: { ...local.failing }, saved: { ...local.saved }, unreviewable: { ...local.unreviewable },
  };
  for (const mark of marks) {
    const id = typeof mark?.recording_id === 'string' ? mark.recording_id : '';
    if (!validId(id)) continue;
    if (validTime(next.reviewed[id]) || validTime(mark.reviewed_at)) {
      next.reviewed[id] = earlier(validTime(next.reviewed[id]) ? next.reviewed[id] : undefined, validTime(mark.reviewed_at) ? mark.reviewed_at : undefined)!;
      delete next.failing[id];
      delete next.saved[id];
      delete next.unreviewable[id];
      continue;
    }
    const failing = earlier(validTime(next.failing[id]) ? next.failing[id] : undefined, validTime(mark.failing_since) ? mark.failing_since : undefined);
    if (failing) next.failing[id] = failing;
    // "<since> <last tried>": the first failure on either side, the latest try on either.
    const [mineSince, mineTried] = (next.unreviewable[id] || '').split(' ');
    const since = earlier(validTime(mineSince) ? mineSince : undefined, validTime(mark.unreviewable_since) ? mark.unreviewable_since : undefined);
    if (since) {
      const tried = later(validTime(mineTried) ? mineTried : validTime(mineSince) ? mineSince : undefined,
        validTime(mark.unreviewable_tried_at) ? mark.unreviewable_tried_at : validTime(mark.unreviewable_since) ? mark.unreviewable_since : undefined);
      next.unreviewable[id] = tried ? `${since} ${tried}` : since;
    }
    const theirs = (Array.isArray(mark.fingerprints) ? mark.fingerprints : []).filter((item) => typeof item === 'string' && FINGERPRINT.test(item));
    if (theirs.length) {
      const mineAt = next.saved[id]?.split(' ')[0];
      const mine = fingerprintsOf(next.saved[id]);
      const theirsAt = validTime(mark.saved_at) ? mark.saved_at : undefined;
      // The older list first, so the newest saves are the ones kept.
      const mineFirst = !theirsAt || (validTime(mineAt) && Date.parse(mineAt) <= Date.parse(theirsAt));
      const joined = mineFirst ? unionNewest(mine, theirs) : unionNewest(theirs, mine);
      const at = later(validTime(mineAt) ? mineAt : undefined, theirsAt) ?? new Date().toISOString();
      next.saved[id] = [at, ...joined].join(' ');
    }
  }
  return next;
}

/** Ids in groups whose joined length stays under `maxChars` (each group is one request's filter). */
export function idGroups(ids: string[], maxChars = 3000, maxCount = 100): string[][] {
  const groups: string[][] = [];
  let group: string[] = [];
  let length = 0;
  for (const id of [...new Set(ids)].filter(validId)) {
    if (group.length && (length + id.length + 3 > maxChars || group.length >= maxCount)) {
      groups.push(group);
      group = [];
      length = 0;
    }
    group.push(id);
    length += id.length + 3;
  }
  if (group.length) groups.push(group);
  return groups;
}

/** In groups of `size`. */
export function inGroups<T>(items: T[], size = MARKS_PER_CALL): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

/**
 * The server does not have the table or function yet (the migration is not
 * applied): PGRST202 unknown function, PGRST205 / 42P01 unknown table,
 * 42883 unknown signature, 42703 unknown column. The app then keeps the
 * marks on the device only, as before.
 */
export function notOnServerYet(code: unknown): boolean {
  return code === 'PGRST202' || code === 'PGRST205' || code === '42P01' || code === '42883' || code === '42703';
}
