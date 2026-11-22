// Which recordings were reviewed, kept on ReferralFit's server as well as on
// each device (docs/DAY_REVIEW.md, "Fieldy on the web"), so the phone and the
// web app never offer the same recording twice. The pure rules: the shape
// kept on a device, the rows sent to the server, and how the two are joined.
//
// What reaches the server is only a recording's id (the recorder's own), the
// times it was reviewed, failed, was cleared or saved from, and the
// fingerprints of items saved from it: each one a short one-way hash
// (day-review.ts signatureHash, "h:" and at most 12 base-36 characters),
// never words. Anything else in a fingerprint list is dropped before it is
// sent, and the server refuses it too
// (supabase/migrations/20261122130000_day_review_recordings.sql).
//
// Joining never loses a mark: a recording reviewed on either side is
// reviewed; fingerprints are a union (the newest 200 kept); the earliest
// failure and "review failed" time are kept, unless a clear newer than the
// mark's last time says it is over (a failing recording read again, a review
// that came back). A reviewed mark is never cleared.
//
// No React, no network: scripts/fieldy-test.mjs covers this file.

/**
 * A change kept on this device that the server has not confirmed yet: what
 * changed for one recording, written in the same step as the change itself,
 * so a send cut off (the phone closing the app mid-request) is sent again at
 * the next read. `at`: when, `n`: which change (two in the same millisecond
 * differ), `failingCleared` / `unreviewableCleared`: a clear and its time
 * (the tombstone, until the server has it).
 */
export type Unsent = { at: string; n: string; failingCleared?: string; unreviewableCleared?: string };

/**
 * What a device keeps for one recorder and account. `saved` holds, per
 * recording, "<when> <fingerprint> <fingerprint> ...". `unsent`: changes the
 * server has not confirmed (at most MAX_UNSENT). `synced`: false when
 * everything kept here must be copied up once (kept before the server knew
 * of it, or changes dropped from a full unsent list).
 */
export type ReadState = {
  floor: string;
  reviewed: Record<string, string>;
  failing: Record<string, string>;
  saved: Record<string, string>;
  unreviewable: Record<string, string>;
  unsent: Record<string, Unsent>;
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
  failing_cleared_at?: string | null;
  unreviewable_cleared_at?: string | null;
};

/** One recording's marks, sent to public.day_review_mark_recordings (merged there, never replacing). */
export type MarkRow = {
  id: string;
  reviewed_at?: string;
  failing_since?: string;
  failing_cleared_at?: string;
  unreviewable_since?: string;
  unreviewable_tried_at?: string;
  unreviewable_cleared_at?: string;
  saved_at?: string;
  fingerprints?: string[];
};

export const FINGERPRINT = /^h:[0-9a-z]{1,12}$/;
export const MAX_FINGERPRINTS = 200;
export const MAX_RECORDING_ID = 200;
/** Rows per call to the server (it refuses more). */
export const MARKS_PER_CALL = 200;
/** Unconfirmed changes kept; past this the oldest go and everything is copied up once instead. */
export const MAX_UNSENT = 300;
/** As long as the server keeps a row (and a device its marks). */
export const KEEP_MS = 14 * 24 * 60 * 60 * 1000;

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

/** A clear newer than a mark's time ends it; a mark newer than the clear is a new one (it stays). */
const outlives = (markAt: string | undefined, clearedAt: string | undefined) => !clearedAt || (validTime(markAt) && Date.parse(markAt) > Date.parse(clearedAt));

/**
 * The rows that put these recordings' marks on the server, from what this
 * device keeps, with the clears not yet confirmed (`unsent`). A recording
 * with nothing kept and nothing cleared sends nothing.
 */
export function rowsFor(state: ReadState, ids: Iterable<string>): MarkRow[] {
  const out: MarkRow[] = [];
  for (const id of new Set(ids)) {
    if (!validId(id)) continue;
    if (validTime(state.reviewed[id])) {
      out.push({ id, reviewed_at: state.reviewed[id] });
      continue;
    }
    const row: MarkRow = { id };
    const pending = state.unsent?.[id];
    if (validTime(state.failing[id])) row.failing_since = state.failing[id];
    if (validTime(pending?.failingCleared)) row.failing_cleared_at = pending!.failingCleared;
    const [since, tried] = (state.unreviewable[id] || '').split(' ');
    if (validTime(since)) {
      row.unreviewable_since = since;
      if (validTime(tried)) row.unreviewable_tried_at = tried;
    }
    if (validTime(pending?.unreviewableCleared)) row.unreviewable_cleared_at = pending!.unreviewableCleared;
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

let changes = 0;

/**
 * Notes, in the state being written, that this recording changed and the
 * server has not confirmed it. `clear`: a failure clock stopped (a failing
 * recording read again) or a "review failed" mark ended (its review came
 * back), at `at`; kept as a tombstone until the server confirms it. At most
 * MAX_UNSENT kept (and none older than KEEP_MS): past that the oldest go and
 * `synced` turns false, so everything kept here is copied up once instead.
 */
export function noteUnsent(state: ReadState, id: string, at: string, clear: { failing?: boolean; unreviewable?: boolean } = {}): void {
  if (!validId(id) || !validTime(at)) return;
  const unsent = state.unsent ?? (state.unsent = {});
  const before = unsent[id];
  changes = (changes + 1) % 1_000_000;
  const entry: Unsent = { at, n: `${changes.toString(36)}${Math.random().toString(36).slice(2, 7)}` };
  const failingCleared = clear.failing ? later(before?.failingCleared, at) : before?.failingCleared;
  const unreviewableCleared = clear.unreviewable ? later(before?.unreviewableCleared, at) : before?.unreviewableCleared;
  if (failingCleared) entry.failingCleared = failingCleared;
  if (unreviewableCleared) entry.unreviewableCleared = unreviewableCleared;
  delete unsent[id];
  unsent[id] = entry;
  const cutoff = Date.parse(at) - KEEP_MS;
  const kept = Object.entries(unsent).filter(([, item]) => Date.parse(item.at) >= cutoff)
    .sort(([, x], [, y]) => Date.parse(x.at) - Date.parse(y.at));
  const dropped = kept.length > MAX_UNSENT;
  state.unsent = Object.fromEntries(kept.slice(-MAX_UNSENT));
  if (dropped) state.synced = false;
}

/** An unsent list read back from a device (anything unreadable dropped), at most MAX_UNSENT. */
export function readUnsent(value: unknown): Record<string, Unsent> {
  const out: Record<string, Unsent> = {};
  for (const [id, item] of Object.entries(value && typeof value === 'object' ? value : {})) {
    if (!validId(id) || !item || typeof item !== 'object') continue;
    const { at, n, failingCleared, unreviewableCleared } = item as Partial<Unsent>;
    if (!validTime(at) || typeof n !== 'string') continue;
    out[id] = { at, n, ...(validTime(failingCleared) ? { failingCleared } : {}), ...(validTime(unreviewableCleared) ? { unreviewableCleared } : {}) };
  }
  return Object.fromEntries(Object.entries(out).sort(([, x], [, y]) => Date.parse(x.at) - Date.parse(y.at)).slice(-MAX_UNSENT));
}

/**
 * What to send now: the unconfirmed changes, or (when `synced` is false)
 * everything kept here with them. `sent`: each unsent change as it was, to
 * be confirmed (confirmSent) once the server took the rows.
 */
export function pendingRows(state: ReadState): { rows: MarkRow[]; sent: Record<string, string>; full: boolean } {
  const unsent = state.unsent ?? {};
  const sent = Object.fromEntries(Object.entries(unsent).map(([id, item]) => [id, JSON.stringify(item)]));
  const full = !state.synced;
  const ids = full ? [...idsIn(state), ...Object.keys(unsent)] : Object.keys(unsent);
  return { rows: rowsFor(state, ids), sent, full };
}

/**
 * The server took the rows pendingRows made: each change sent is taken off
 * the list, unless it changed again since (then it is sent again); a full
 * copy marks the state synced, unless the list filled up meanwhile (a change
 * may have been dropped from it). Answers whether anything changed.
 */
export function confirmSent(state: ReadState, sent: Record<string, string>, full: boolean): boolean {
  let changed = false;
  const unsent = state.unsent ?? {};
  if (full && !state.synced && Object.keys(unsent).length < MAX_UNSENT) {
    state.synced = true;
    changed = true;
  }
  for (const [id, was] of Object.entries(sent)) {
    if (unsent[id] && JSON.stringify(unsent[id]) === was) {
      delete unsent[id];
      changed = true;
    }
  }
  state.unsent = unsent;
  return changed;
}

/**
 * This device's state with the server's marks joined in (a new object;
 * `local` is not changed). Reviewed on either side: reviewed, and whatever
 * else was kept for it goes. Otherwise the earliest failure and "review
 * failed" times, and every fingerprint (the newest 200); a clear (the
 * server's, or one here not confirmed yet) ends any failure or "review
 * failed" mark whose last time is not after it.
 */
export function withServerMarks(local: ReadState, marks: ServerMark[]): ReadState {
  const next: ReadState = {
    ...local, reviewed: { ...local.reviewed }, failing: { ...local.failing }, saved: { ...local.saved }, unreviewable: { ...local.unreviewable },
    unsent: { ...(local.unsent ?? {}) },
  };
  const at = (value: unknown) => (validTime(value) ? value : undefined);
  for (const mark of marks) {
    const id = typeof mark?.recording_id === 'string' ? mark.recording_id : '';
    if (!validId(id)) continue;
    if (validTime(next.reviewed[id]) || validTime(mark.reviewed_at)) {
      next.reviewed[id] = earlier(at(next.reviewed[id]), at(mark.reviewed_at))!;
      delete next.failing[id];
      delete next.saved[id];
      delete next.unreviewable[id];
      continue;
    }
    const pending = next.unsent[id];
    const failingCleared = later(at(mark.failing_cleared_at), at(pending?.failingCleared));
    const failing = earlier(
      outlives(next.failing[id], failingCleared) ? at(next.failing[id]) : undefined,
      outlives(mark.failing_since ?? undefined, failingCleared) ? at(mark.failing_since) : undefined,
    );
    if (failing) next.failing[id] = failing;
    else delete next.failing[id];
    // "<since> <last tried>": the first failure on either side, the latest try on either,
    // of the marks whose last try is after any clear.
    const unreviewableCleared = later(at(mark.unreviewable_cleared_at), at(pending?.unreviewableCleared));
    const [mineSince, mineTriedKept] = (next.unreviewable[id] || '').split(' ');
    const mineTried = at(mineTriedKept) ?? at(mineSince);
    const theirsTried = at(mark.unreviewable_tried_at) ?? at(mark.unreviewable_since);
    const mineLives = Boolean(at(mineSince)) && outlives(mineTried, unreviewableCleared);
    const theirsLive = Boolean(at(mark.unreviewable_since)) && outlives(theirsTried, unreviewableCleared);
    const since = earlier(mineLives ? mineSince : undefined, theirsLive ? mark.unreviewable_since! : undefined);
    if (since) {
      const tried = later(mineLives ? mineTried : undefined, theirsLive ? theirsTried : undefined);
      next.unreviewable[id] = tried ? `${since} ${tried}` : since;
    } else delete next.unreviewable[id];
    const theirs = (Array.isArray(mark.fingerprints) ? mark.fingerprints : []).filter((item) => typeof item === 'string' && FINGERPRINT.test(item));
    if (theirs.length) {
      const mineAt = next.saved[id]?.split(' ')[0];
      const mine = fingerprintsOf(next.saved[id]);
      const theirsAt = at(mark.saved_at);
      // The older list first, so the newest saves are the ones kept.
      const mineFirst = !theirsAt || (validTime(mineAt) && Date.parse(mineAt) <= Date.parse(theirsAt));
      const joined = mineFirst ? unionNewest(mine, theirs) : unionNewest(theirs, mine);
      const savedAt = later(at(mineAt), theirsAt) ?? new Date().toISOString();
      next.saved[id] = [savedAt, ...joined].join(' ');
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
