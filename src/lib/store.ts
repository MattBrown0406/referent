import AsyncStorage from '@react-native-async-storage/async-storage';

import { fetchCaseFile, fetchCaseList, newUuid, type CaseFile, type CaseList } from './cases';
import {
  makeCaseFileEnvelope,
  makeCaseFileIndexEnvelope,
  makeCaseListEnvelope,
  parseCachedCaseFile,
  parseCachedCaseList,
  parseCaseFileIndex,
  touchCaseFileIndex,
  type CachedCaseFile,
  type CachedCaseList,
} from './case-cache';
import { currentAuthSessionIdentity } from './auth-session';
import { RejectedWritesError, StoreError, describeError, errorCode } from './errors';
import { fetchAllPages } from './paging';
import { supabase } from './supabase';
import type {
  ClientPopulation,
  FinancialRelationship,
  InsuranceNetworkPreference,
  LocationPreference,
  Partner,
  PartnerType,
  PlacementReason,
  Referral,
  ReferralMatch,
} from '../data';
import type { PlacementCandidate } from './matching';

// ─── Types ──────────────────────────────────────────────────────────────────

export type TouchKind = 'call' | 'text' | 'email' | 'meeting' | 'other';

export type Touch = {
  id: string;
  partnerId: string;
  kind: TouchKind;
  note: string;
  occurredAt: string; // ISO timestamptz
};

export type FollowUpStatus = 'open' | 'done' | 'skipped';

// v4 Today Command Center kinds (migration 20260724190000). 'touch' is a
// partner-relationship touch (Done → Log touch); the rest are self-evident.
// 'check_in' (migration 20261001160000) is a post-placement outcome check-in
// created by the server 7, 30 and 90 days after admission.
export type FollowUpKind = 'follow_up' | 'first_call' | 'promised_call' | 'waiting_on' | 'consult' | 'touch' | 'check_in';

export type FollowUp = {
  id: string;
  partnerId?: string;
  referralId?: string;
  caseId?: string; // v3 case-files linkage
  title: string;
  dueOn: string; // YYYY-MM-DD
  status: FollowUpStatus;
  completedAt?: string; // ISO timestamptz
  note: string;
  kind?: FollowUpKind; // v4 — absent rows read as 'follow_up' (DB default)
  dueTime?: string; // HH:MM (24h, from the DB time column) — consults mostly
  waitingOn?: string; // who/what we're waiting on, when kind='waiting_on'
  snoozedUntil?: string; // YYYY-MM-DD — hides the item from Today until then
  // Team basics. assignedTo: a workspace member's user id; null means
  // "explicitly unassigned" (sent to the server), undefined means untouched
  // (omitted from writes, so a build that predates the column still saves).
  // A follow-up with no assignee belongs to whoever its case is assigned to.
  assignedTo?: string | null;
  completedBy?: string; // server-stamped; never written by the client
  checkInDays?: number; // 7 | 30 | 90 when kind='check_in'; server-written
};

/**
 * Network-wide figures for the listing behind a partner, from
 * fetch_global_partner_stats. Present only when the directory discloses them
 * (five distinct referring workspaces). Matching uses them as the prior for
 * a partner this workspace has little history with.
 */
export type NetworkTrackRecord = {
  admitRate: number | null; // 0-1
  familyExperience: number | null; // 1-5
  completionRate: number | null; // 0-1
};

export type PartnerScorecard = {
  partnerId: string;
  referralsSent: number;
  admits: number;
  nonAdmits: number;
  avgFamilyExperience: number | null;
  lastReferralOn: string | null; // YYYY-MM-DD
  // Outcomes loop (migration 20261001160000). Absent on cached cards from
  // older builds; readers treat missing as zero / unknown.
  completed?: number;
  decidedPlacements?: number;
  completionRate?: number | null; // completed / decided placements
  medianDaysToAdmit?: number | null;
  stillEnrolled?: number;
  network?: NetworkTrackRecord;
};

// Patch for the v2 outcome-enrichment columns on referrals (admitted,
// admitted_on, family_experience, outcome_note). Packet fields
// (packet_sent_at, match_profile_id) are set at insert time inside
// referralToRow from the Referral object itself.
export type ReferralOutcomePatch = {
  admitted?: boolean | null;
  admittedOn?: string | null; // YYYY-MM-DD
  familyExperience?: number | null; // 1-5
  outcomeNote?: string;
  outcome?: Referral['outcome'];
  // Outcomes loop. checkIn stamps referrals.last_check_in_at on the server.
  completed?: boolean | null;
  completedOn?: string | null; // YYYY-MM-DD
  stillEnrolled?: boolean | null;
  checkIn?: boolean;
};

export type Snapshot = {
  partners: Partner[];
  referrals: Referral[];
  referralMatches: ReferralMatch[];
  touches: Touch[];
  followUps: FollowUp[];
  scorecards: Record<string, PartnerScorecard>;
};

export type PacketCaseEvent = {
  id: string;
  caseId: string;
  kind: string;
  body: string;
  referralId?: string;
  contactId?: string;
  occurredAt: string;
};

/**
 * Why a program was chosen from a match: the shortlist the clinician saw,
 * with scores, the pick and its rank, and the reason when it was not the top
 * result. Written right after the assignment (placement_decisions).
 */
export type PlacementDecision = {
  id: string;
  matchProfileId: string;
  caseId?: string;
  referralId?: string;
  chosenPartnerId: string;
  chosenRank: number;
  reason?: PlacementReason;
  reasonNote?: string;
  candidates: PlacementCandidate[];
  weights: Record<string, number>;
  decidedAt: string;
};

export type HydrateResult = {
  snapshot: Snapshot;
  source: 'remote' | 'cache';
  // Set when queued changes could not be synced during hydration (some were
  // rejected and set aside — see listRejectedWrites — or the flush failed and
  // the saved copy is shown). Hydration still returns data either way.
  syncError?: string;
};

/**
 * A queued offline change the server refused. It is moved out of the live
 * queue (so later changes keep syncing and pendingWriteCount can reach 0) and
 * kept here until the user retries or discards it.
 */
export type RejectedWrite = {
  id: string;
  kind: string; // the queued operation kind, e.g. 'partner.update'
  summary: string; // what the change was, in plain words
  reason: string; // the server's explanation
  code?: string; // PostgREST / Postgres error code, when there was one
  rejectedAt: string; // ISO timestamptz
};

// ─── AsyncStorage keys ──────────────────────────────────────────────────────

// The old v1 keys were global to the device. They are intentionally never read:
// there is no trustworthy owner metadata with which to assign their contents to
// an authenticated account. Leaving them quarantined is safer than leaking one
// user's cached data or queued writes into another account.
const CACHE_KEY_PREFIX = 'referralfit-cache-v2:';
const QUEUE_KEY_PREFIX = 'referralfit-write-queue-v2:';
const WORKSPACE_KEY_PREFIX = 'referralfit-workspace-v1:';
// Saved copies of case data (see case-cache.ts for shape and bounds). Same
// account key and workspace binding as the snapshot cache; wiped with it.
const CASE_LIST_KEY_PREFIX = 'referralfit-case-list-v1:';
const CASE_FILE_INDEX_KEY_PREFIX = 'referralfit-case-file-index-v1:';
const CASE_FILE_KEY_PREFIX = 'referralfit-case-file-v1:';
// Queued changes the server refused (see RejectedWrite). Same account key and
// workspace binding as the queue; guarded by the queue lock.
const REJECTED_KEY_PREFIX = 'referralfit-rejected-writes-v1:';

function accountStorageKey(prefix: string, userId: string): string {
  if (!isUuid(userId)) throw new StoreError('Cannot use offline storage without a valid account ID.', false);
  return `${prefix}${userId.toLowerCase()}`;
}

// ─── Error classification ───────────────────────────────────────────────────

export function isNetworkError(error: unknown): boolean {
  if (!error) return false;
  const anyError = error as { name?: string; message?: string; status?: number; code?: string };
  // supabase-js reports a token refresh that never reached the server this way
  // (status 0), so it must be classified before the status check below.
  if (anyError.name === 'AuthRetryableFetchError') return true;
  // PostgREST / Supabase errors carry a status or PG code — those reached the
  // server, so queueing them would just fail again on flush.
  if (typeof anyError.status === 'number' || (anyError.code && /^[0-9A-Z]{5}$/.test(anyError.code))) return false;
  const message = String(anyError.message || error).toLowerCase();
  return (
    message.includes('network request failed') ||
    message.includes('failed to fetch') ||
    message.includes('networkerror') ||
    message.includes('fetch failed') ||
    message.includes('econnrefused') ||
    message.includes('enotfound') ||
    message.includes('etimedout') ||
    message.includes('timeout') ||
    message.includes('offline') ||
    message.includes('internet')
  );
}

export { RejectedWritesError, StoreError, describeError } from './errors';

// offline: the identity came from the session persisted on this device because
// an expired access token could not be refreshed without a connection (see
// auth-session.ts). It fences the account's on-device cache and queue only;
// nothing is sent to the server under it — writes queue, reads use the cache.
type SessionFence = { userId: string; sessionId: string; offline: boolean };

async function sessionFence(expectedUserId?: string): Promise<SessionFence> {
  const identity = await currentAuthSessionIdentity({ allowOffline: true });
  if (!identity || !isUuid(identity.userId)) throw new StoreError('You must be signed in to use offline data.', false);
  if (expectedUserId && expectedUserId.toLowerCase() !== identity.userId) {
    throw new StoreError('The signed-in account changed. Retry this action for the current account.', false);
  }
  return { userId: identity.userId, sessionId: identity.sessionId, offline: Boolean(identity.offline) };
}

async function assertSessionFence(fence: SessionFence, queued = false): Promise<void> {
  const current = await sessionFence(fence.userId);
  if (current.sessionId !== fence.sessionId) {
    throw new StoreError('The signed-in session changed while saving. Retry for the current account.', queued);
  }
}

// isNetworkError() classifies this as a lost connection (no status/code, and
// the message says offline), so callers treat it exactly like a failed fetch.
function offlineError(): StoreError {
  return new StoreError('Offline: the server cannot be reached right now.', false);
}

async function readBindingUnlocked(userId: string): Promise<string | null> {
  try {
    const stored = await AsyncStorage.getItem(accountStorageKey(WORKSPACE_KEY_PREFIX, userId));
    return stored && isUuid(stored) ? stored.toLowerCase() : null;
  } catch (error) {
    throw persistenceError('cache', error);
  }
}

// Server-verified workspace: required before any server write. A lost
// connection is rethrown untouched so callers can queue.
async function assertWorkspaceFence(fence: SessionFence): Promise<string> {
  if (fence.offline) throw offlineError();
  const storedOrg = await readBindingUnlocked(fence.userId);
  const result = await supabase.rpc('current_org_id');
  if (result.error) {
    if (isNetworkError(result.error)) throw result.error;
    throw new StoreError(`The active workspace could not be verified: ${describeError(result.error)}`, false);
  }
  if (typeof result.data !== 'string' || !storedOrg
      || result.data.toLowerCase() !== storedOrg) {
    throw new StoreError('The active workspace changed. Reload before saving.', false);
  }
  await assertSessionFence(fence);
  return storedOrg;
}

// Workspace check for writes to this device's own saved copies. The server is
// asked when it can be reached (and wins on a mismatch); with no connection
// the binding last verified on this device stands — exactly the binding an
// offline launch reads the caches under — so offline edits still reach the
// cache instead of failing every save.
async function assertCacheWorkspaceFence(fence: SessionFence): Promise<string> {
  const storedOrg = await readBindingUnlocked(fence.userId);
  if (!storedOrg) throw new StoreError('This device has no verified workspace for offline data yet. Reconnect and reload.', false);
  if (!fence.offline) {
    const result = await supabase.rpc('current_org_id');
    if (result.error) {
      if (!isNetworkError(result.error)) {
        throw new StoreError(`The active workspace could not be verified: ${describeError(result.error)}`, false);
      }
    } else if (typeof result.data !== 'string' || result.data.toLowerCase() !== storedOrg) {
      throw new StoreError('The active workspace changed. Reload before saving.', false);
    }
  }
  await assertSessionFence(fence);
  return storedOrg;
}

function persistenceError(area: 'cache' | 'offline queue', error: unknown): StoreError {
  const detail = error ? `: ${describeError(error)}` : '';
  return new StoreError(`Could not durably save the ${area}${detail}`, false);
}

// ─── Offline write queue (account-scoped, serialized FIFO) ──────────────────

type QueueOp =
  | { kind: 'partner.insert'; row: Record<string, unknown> }
  | { kind: 'partner.update'; id: string; patch: Record<string, unknown> }
  | { kind: 'referral.insert'; row: Record<string, unknown> }
  | { kind: 'match.insert'; row: Record<string, unknown> }
  | { kind: 'match.update'; id: string; patch: Record<string, unknown> }
  | { kind: 'match.delete'; id: string }
  | { kind: 'touch.insert'; row: Record<string, unknown> }
  | { kind: 'follow_up.insert'; row: Record<string, unknown> }
  | { kind: 'follow_up.update'; id: string; patch: Record<string, unknown> }
  | { kind: 'follow_up.complete_next'; completed: Record<string, unknown>; next: Record<string, unknown>; event: Record<string, unknown> | null }
  | { kind: 'follow_up.complete_outcome'; completed: Record<string, unknown>; referralId: string; outcome: Record<string, unknown> }
  | { kind: 'match.save_case'; match: Record<string, unknown>; caseId: string }
  | { kind: 'referral.assign_match'; referral: Record<string, unknown>; match: Record<string, unknown> }
  | { kind: 'packet.finalize'; referral: Record<string, unknown>; match: Record<string, unknown> | null; touch: Record<string, unknown>; followUp: Record<string, unknown>; event: Record<string, unknown> | null }
  | { kind: 'contact.log_activity'; event: Record<string, unknown> | null; touch: Record<string, unknown> | null }
  | { kind: 'outreach.sent'; completedId: string | null; next: Record<string, unknown>; event: Record<string, unknown> | null; touch: Record<string, unknown> | null }
  | { kind: 'referral.update'; id: string; patch: Record<string, unknown> }
  | { kind: 'placement.insert'; row: Record<string, unknown> }
  | { kind: 'referral.record_outcome'; referralId: string; outcome: Record<string, unknown>; completed: Record<string, unknown> | null };

// parentWaits: for ops the server refused only because a row they reference
// does not exist (yet), how often and since when — keyed by queueOpKey(op).
// Older builds ignore the field, so the envelope version stays 2.
type ParentWait = { first: string; attempts: number };
type QueueEnvelope = { version: 2; userId: string; ops: QueueOp[]; parentWaits?: Record<string, ParentWait> };
type QueueState = { ops: QueueOp[]; parentWaits: Record<string, ParentWait> };
let queueMutex: Promise<void> = Promise.resolve();

async function withQueueLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = queueMutex;
  let release!: () => void;
  queueMutex = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

function isQueueOp(value: unknown): value is QueueOp {
  if (!value || typeof value !== 'object') return false;
  const op = value as { kind?: unknown; row?: unknown; id?: unknown; patch?: unknown; completed?: unknown; completedId?: unknown; next?: unknown; event?: unknown; referralId?: unknown; outcome?: unknown; referral?: unknown; match?: unknown; caseId?: unknown; touch?: unknown; followUp?: unknown };
  const insertKinds = ['partner.insert', 'referral.insert', 'match.insert', 'touch.insert', 'follow_up.insert', 'placement.insert'];
  const updateKinds = ['partner.update', 'match.update', 'follow_up.update', 'referral.update'];
  if (typeof op.kind !== 'string') return false;
  if (insertKinds.includes(op.kind)) return Boolean(op.row && typeof op.row === 'object');
  if (op.kind === 'match.delete') return typeof op.id === 'string';
  if (op.kind === 'follow_up.complete_next') {
    return Boolean(op.completed && typeof op.completed === 'object' && op.next && typeof op.next === 'object'
      && (op.event === null || (op.event && typeof op.event === 'object')));
  }
  if (op.kind === 'follow_up.complete_outcome') {
    return Boolean(op.completed && typeof op.completed === 'object' && typeof op.referralId === 'string' && op.outcome && typeof op.outcome === 'object');
  }
  if (op.kind === 'referral.record_outcome') {
    return typeof op.referralId === 'string' && Boolean(op.outcome && typeof op.outcome === 'object')
      && (op.completed === null || Boolean(op.completed && typeof op.completed === 'object'));
  }
  if (op.kind === 'match.save_case') return Boolean(op.match && typeof op.match === 'object' && typeof op.caseId === 'string');
  if (op.kind === 'referral.assign_match') return Boolean(op.referral && typeof op.referral === 'object' && op.match && typeof op.match === 'object');
  if (op.kind === 'packet.finalize') return Boolean(op.referral && typeof op.referral === 'object' && op.touch && typeof op.touch === 'object'
    && op.followUp && typeof op.followUp === 'object' && (op.match === null || (op.match && typeof op.match === 'object'))
    && (op.event === null || (op.event && typeof op.event === 'object')));
  if (op.kind === 'outreach.sent') return Boolean(
    (op.completedId === null || typeof op.completedId === 'string')
    && op.next && typeof op.next === 'object'
    && (op.event === null || (op.event && typeof op.event === 'object'))
    && (op.touch === null || (op.touch && typeof op.touch === 'object'))
    && (op.event !== null || op.touch !== null));
  if (op.kind === 'contact.log_activity') return Boolean(
    (op.event === null || (op.event && typeof op.event === 'object'))
    && (op.touch === null || (op.touch && typeof op.touch === 'object'))
    && (op.event !== null || op.touch !== null));
  return updateKinds.includes(op.kind) && typeof op.id === 'string' && Boolean(op.patch && typeof op.patch === 'object');
}

async function readQueueStateUnlocked(userId: string): Promise<QueueState> {
  const key = accountStorageKey(QUEUE_KEY_PREFIX, userId);
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(key);
  } catch (error) {
    throw persistenceError('offline queue', error);
  }
  if (!raw) return { ops: [], parentWaits: {} };
  try {
    const parsed = JSON.parse(raw) as Partial<QueueEnvelope>;
    if (parsed.version !== 2 || parsed.userId?.toLowerCase() !== userId || !Array.isArray(parsed.ops) || !parsed.ops.every(isQueueOp)) {
      throw new Error('stored queue failed account or format validation');
    }
    return { ops: parsed.ops, parentWaits: sanitizeParentWaits(parsed.parentWaits) };
  } catch (error) {
    throw persistenceError('offline queue', error);
  }
}

async function readQueueUnlocked(userId: string): Promise<QueueOp[]> {
  return (await readQueueStateUnlocked(userId)).ops;
}

function sanitizeParentWaits(value: unknown): Record<string, ParentWait> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const waits: Record<string, ParentWait> = {};
  for (const [key, wait] of Object.entries(value as Record<string, unknown>)) {
    const candidate = wait as Partial<ParentWait> | null;
    if (candidate && typeof candidate.first === 'string' && typeof candidate.attempts === 'number' && Number.isFinite(candidate.attempts)) {
      waits[key] = { first: candidate.first, attempts: candidate.attempts };
    }
  }
  return waits;
}

// Stable identity of a queued op for its parent-wait bookkeeping (identical
// ops share one entry, which is what we want).
function queueOpKey(op: QueueOp): string {
  return uuidFromLegacyId(JSON.stringify(op));
}

async function writeQueueUnlocked(userId: string, ops: QueueOp[], parentWaits: Record<string, ParentWait> = {}): Promise<void> {
  const live = new Set(ops.map(queueOpKey));
  const waits = Object.fromEntries(Object.entries(parentWaits).filter(([key]) => live.has(key)));
  const envelope: QueueEnvelope = { version: 2, userId, ops, ...(Object.keys(waits).length ? { parentWaits: waits } : {}) };
  try {
    await AsyncStorage.setItem(accountStorageKey(QUEUE_KEY_PREFIX, userId), JSON.stringify(envelope));
  } catch (error) {
    throw persistenceError('offline queue', error);
  }
}

// Caller holds the queue lock.
async function enqueueOpUnlocked(fence: SessionFence, op: QueueOp): Promise<void> {
  await assertSessionFence(fence);
  const { ops, parentWaits } = await readQueueStateUnlocked(fence.userId);
  await assertSessionFence(fence);
  await writeQueueUnlocked(fence.userId, [...ops, bindQueueOp(op, fence.userId)], parentWaits);
  await assertSessionFence(fence, true);
}

async function enqueueOp(fence: SessionFence, op: QueueOp): Promise<void> {
  await withQueueLock(() => enqueueOpUnlocked(fence, op));
}

// ─── Rejected changes (account-scoped, guarded by the queue lock) ──────────

type RejectedEntry = { id: string; op: QueueOp; reason: string; code?: string; rejectedAt: string };
type RejectedEnvelope = { version: 1; userId: string; entries: RejectedEntry[] };

function isRejectedEntry(value: unknown): value is RejectedEntry {
  const entry = value as Partial<RejectedEntry> | null;
  return Boolean(entry && typeof entry === 'object' && typeof entry.id === 'string' && typeof entry.reason === 'string'
    && typeof entry.rejectedAt === 'string' && isQueueOp(entry.op) && (entry.code === undefined || typeof entry.code === 'string'));
}

async function readRejectedUnlocked(userId: string): Promise<RejectedEntry[]> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(accountStorageKey(REJECTED_KEY_PREFIX, userId));
  } catch (error) {
    throw persistenceError('offline queue', error);
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Partial<RejectedEnvelope>;
    if (parsed.version !== 1 || parsed.userId?.toLowerCase() !== userId || !Array.isArray(parsed.entries) || !parsed.entries.every(isRejectedEntry)) {
      throw new Error('stored rejected changes failed account or format validation');
    }
    return parsed.entries;
  } catch (error) {
    throw persistenceError('offline queue', error);
  }
}

async function writeRejectedUnlocked(userId: string, entries: RejectedEntry[]): Promise<void> {
  const envelope: RejectedEnvelope = { version: 1, userId, entries };
  try {
    await AsyncStorage.setItem(accountStorageKey(REJECTED_KEY_PREFIX, userId), JSON.stringify(envelope));
  } catch (error) {
    throw persistenceError('offline queue', error);
  }
}

// Durably record a refused op BEFORE it leaves the live queue: a crash between
// the two writes leaves it in both places (replayed once more, then listed
// once — entries are de-duplicated), never in neither.
async function rejectOpUnlocked(fence: SessionFence, op: QueueOp, reason: string, code: string | undefined): Promise<RejectedEntry> {
  await assertSessionFence(fence);
  const entries = await readRejectedUnlocked(fence.userId);
  const serialized = JSON.stringify(op);
  const existing = entries.find((entry) => JSON.stringify(entry.op) === serialized);
  if (existing) return existing;
  const entry: RejectedEntry = { id: newUuid(), op, reason, ...(code ? { code } : {}), rejectedAt: new Date().toISOString() };
  await writeRejectedUnlocked(fence.userId, [...entries, entry]);
  await assertSessionFence(fence, true);
  return entry;
}

function rowLabel(row: Record<string, unknown> | null | undefined): string {
  if (!row) return '';
  for (const field of ['name', 'title', 'client_label', 'organization']) {
    const value = row[field];
    if (typeof value === 'string' && value.trim()) return ` “${value.trim()}”`;
  }
  return '';
}

function describeQueueOp(op: QueueOp): string {
  switch (op.kind) {
    case 'partner.insert': return `Add partner${rowLabel(op.row)}`;
    case 'partner.update': return `Edit partner${rowLabel(op.patch)}`;
    case 'referral.insert': return `Log referral${rowLabel(op.row)}`;
    case 'referral.update': return 'Update a referral';
    case 'referral.record_outcome': return 'Record a placement outcome';
    case 'referral.assign_match': return `Assign a program${rowLabel(op.match)}`;
    case 'match.insert': return `Save match${rowLabel(op.row)}`;
    case 'match.update': return `Edit match${rowLabel(op.patch)}`;
    case 'match.delete': return 'Remove a match';
    case 'match.save_case': return `Save match${rowLabel(op.match)} to its file`;
    case 'touch.insert': return 'Log a partner touch';
    case 'follow_up.insert': return `Add follow-up${rowLabel(op.row)}`;
    case 'follow_up.update': return `Edit follow-up${rowLabel(op.patch)}`;
    case 'follow_up.complete_next': return `Complete a follow-up and schedule${rowLabel(op.next)}`;
    case 'follow_up.complete_outcome': return 'Complete a follow-up with its outcome';
    case 'packet.finalize': return `Send a referral packet${rowLabel(op.referral)}`;
    case 'contact.log_activity': return 'Log contact activity';
    case 'outreach.sent': return `Log outreach and schedule${rowLabel(op.next)}`;
    case 'placement.insert': return 'Record why a program was chosen';
  }
}

function toRejectedWrite(entry: RejectedEntry): RejectedWrite {
  return {
    id: entry.id,
    kind: entry.op.kind,
    summary: describeQueueOp(entry.op),
    reason: entry.reason,
    ...(entry.code ? { code: entry.code } : {}),
    rejectedAt: entry.rejectedAt,
  };
}

function rejectedWritesError(entries: RejectedEntry[]): RejectedWritesError {
  const count = entries.length;
  const reasons = Array.from(new Set(entries.map((entry) => entry.reason))).slice(0, 3).join('; ');
  const noun = count === 1 ? 'change' : 'changes';
  const verb = count === 1 ? 'was' : 'were';
  return new RejectedWritesError(
    `${count} queued ${noun} could not be saved and ${verb} set aside so later changes can sync: ${reasons}`,
    count,
  );
}

function bindQueueOp(op: QueueOp, userId: string): QueueOp {
  if ('row' in op) return { ...op, row: { ...op.row, owner_id: userId } } as QueueOp;
  return op;
}

// A queued insert is replayed with ON CONFLICT (id) DO NOTHING: replaying it
// after it already landed (the app was killed before the queue was rewritten)
// is a no-op, and it can never overwrite a newer version of the row — e.g. a
// queued match insert replayed after the match was assigned online.
const INSERT_ONCE = { onConflict: 'id', ignoreDuplicates: true } as const;

// Inserts carry owner_id (attribution: who created the row). Updates and
// deletes target rows by workspace (org_id), never by owner: teammates share
// every workspace row, and an owner-scoped update against a colleague's row
// would match nothing and report success while the change silently vanished.
async function applyQueueOp(op: QueueOp, userId: string, orgId: string): Promise<void> {
  let error: { message: string } | null = null;
  switch (op.kind) {
    case 'partner.insert':
      ({ error } = await supabase.from('partners').upsert({ ...op.row, owner_id: userId }, INSERT_ONCE));
      break;
    case 'partner.update':
      ({ error } = await supabase.from('partners').update(op.patch).eq('id', op.id).eq('org_id', orgId));
      break;
    case 'referral.insert':
      ({ error } = await supabase.from('referrals').upsert({ ...op.row, owner_id: userId }, INSERT_ONCE));
      break;
    case 'match.insert':
      ({ error } = await supabase.from('match_profiles').upsert({ ...op.row, owner_id: userId }, INSERT_ONCE));
      break;
    case 'match.update':
      ({ error } = await supabase.from('match_profiles').update(op.patch).eq('id', op.id).eq('org_id', orgId));
      break;
    case 'match.delete':
      ({ error } = await supabase.from('match_profiles').delete().eq('id', op.id).eq('org_id', orgId));
      break;
    case 'touch.insert':
      ({ error } = await supabase.from('touches').upsert({ ...op.row, owner_id: userId }, INSERT_ONCE));
      break;
    case 'follow_up.insert':
      ({ error } = await supabase.from('follow_ups').upsert({ ...op.row, owner_id: userId }, INSERT_ONCE));
      break;
    case 'follow_up.update':
      ({ error } = await supabase.from('follow_ups').update(op.patch).eq('id', op.id).eq('org_id', orgId));
      break;
    case 'follow_up.complete_next':
      ({ error } = await supabase.rpc('complete_follow_up_with_next', { p_completed: op.completed, p_next: op.next, p_event: op.event }));
      break;
    case 'follow_up.complete_outcome':
      ({ error } = await supabase.rpc('complete_follow_up_with_outcome', {
        p_completed: op.completed,
        p_referral_id: op.referralId,
        p_outcome: op.outcome,
      }));
      break;
    case 'match.save_case':
      ({ error } = await supabase.rpc('save_match_with_case', { p_expected_owner_id: userId, p_match: op.match, p_case_id: op.caseId }));
      break;
    case 'referral.assign_match':
      ({ error } = await supabase.rpc('assign_match_referral', { p_expected_owner_id: userId, p_referral: op.referral, p_match: op.match }));
      break;
    case 'packet.finalize':
      ({ error } = await supabase.rpc('finalize_match_packet', {
        p_expected_owner_id: userId, p_referral: op.referral, p_match: op.match,
        p_touch: op.touch, p_follow_up: op.followUp, p_event: op.event,
      }));
      break;
    case 'contact.log_activity':
      ({ error } = await supabase.rpc('log_contact_activity', {
        p_expected_owner_id: userId, p_event: op.event, p_touch: op.touch,
      }));
      break;
    case 'outreach.sent':
      ({ error } = await supabase.rpc('record_outreach_sent', {
        p_expected_owner_id: userId, p_completed_id: op.completedId, p_next: op.next, p_event: op.event, p_touch: op.touch,
      }));
      break;
    case 'referral.update':
      ({ error } = await supabase.from('referrals').update(op.patch).eq('id', op.id).eq('org_id', orgId));
      break;
    case 'placement.insert':
      ({ error } = await supabase.from('placement_decisions').upsert({ ...op.row, owner_id: userId }, { onConflict: 'id', ignoreDuplicates: true }));
      break;
    case 'referral.record_outcome':
      ({ error } = await supabase.rpc('record_placement_outcome', {
        p_referral_id: op.referralId, p_outcome: op.outcome, p_completed: op.completed,
      }));
      break;
  }
  if (error) throw error;
}

// A foreign-key violation usually means the parent row (partner/referral/case)
// simply has not been inserted yet — its own op may sit later in the queue, or
// it failed on a previous pass. Those ops are retried, not dropped, so a
// referral whose partner failed once is not lost. But a parent that never
// arrives (a teammate deleted it, or its own insert was rejected) would hold
// the op — and every change behind it — forever, so after a bounded number of
// server refusals, or a week, the op is set aside as rejected too.
function isMissingParentError(error: unknown): boolean {
  const err = error as { code?: string; message?: string } | null;
  const code = err?.code ?? '';
  const message = err?.message ?? '';
  return code === '23503' || /foreign key constraint/i.test(message);
}

export const MAX_PARENT_WAIT_ATTEMPTS = 12;
export const MAX_PARENT_WAIT_MS = 7 * 24 * 60 * 60 * 1000;

type FlushOutcome = {
  flushed: number; // ops applied on the server
  rejected: RejectedEntry[]; // ops the server refused, moved to the rejected list
  remaining: number; // ops still in the live queue
};

// Flush queued mutations FIFO. Caller holds the queue lock. Stops quietly at
// the first network failure (the queue on disk is consistent after every op).
// An op the server refuses is moved to the rejected list and the flush moves
// on, so one bad change can no longer block every change behind it.
async function flushQueueUnlocked(fence: SessionFence): Promise<FlushOutcome> {
  const state = await readQueueStateUnlocked(fence.userId);
  const waits: Record<string, ParentWait> = { ...state.parentWaits };
  let ops = state.ops;
  const outcome: FlushOutcome = { flushed: 0, rejected: [], remaining: ops.length };
  if (!ops.length || fence.offline) return outcome;

  // Server workspace check before each op; null = no connection.
  const verify = async (): Promise<string | null> => {
    try {
      return await assertWorkspaceFence(fence);
    } catch (error) {
      if (isNetworkError(error)) return null;
      throw error;
    }
  };
  const reject = async (op: QueueOp, error: unknown, reason?: string) => {
    outcome.rejected.push(await rejectOpUnlocked(fence, op, reason ?? describeError(error, 'The server refused this change.'), errorCode(error)));
    delete waits[queueOpKey(op)];
  };

  const deferred: QueueOp[] = [];
  while (ops.length) {
    const [head, ...rest] = ops;
    const orgId = await verify();
    if (orgId === null) return outcome;
    try {
      await applyQueueOp(head, fence.userId, orgId);
      outcome.flushed += 1;
      delete waits[queueOpKey(head)];
    } catch (error) {
      if (isNetworkError(error)) return outcome; // queue on disk is unchanged
      if (isMissingParentError(error)) deferred.push(head);
      else await reject(head, error);
    }
    await assertSessionFence(fence);
    ops = rest;
    await writeQueueUnlocked(fence.userId, [...ops, ...deferred], waits);
    outcome.remaining = ops.length + deferred.length;
  }

  // Retry children whose parents appeared later in the FIFO. Each flush that
  // reaches the server and still finds the parent missing counts once.
  const retained: QueueOp[] = [];
  for (let index = 0; index < deferred.length; index += 1) {
    const op = deferred[index];
    const orgId = await verify();
    if (orgId === null) return outcome;
    try {
      await applyQueueOp(op, fence.userId, orgId);
      outcome.flushed += 1;
      delete waits[queueOpKey(op)];
    } catch (error) {
      if (isNetworkError(error)) return outcome;
      if (isMissingParentError(error)) {
        const key = queueOpKey(op);
        const now = Date.now();
        const previous = waits[key];
        const wait: ParentWait = { first: previous?.first ?? new Date(now).toISOString(), attempts: (previous?.attempts ?? 0) + 1 };
        const waitedMs = now - Date.parse(wait.first);
        if (wait.attempts >= MAX_PARENT_WAIT_ATTEMPTS || (Number.isFinite(waitedMs) && waitedMs >= MAX_PARENT_WAIT_MS)) {
          await reject(op, error, `It depends on a record that was never saved or was deleted (${describeError(error)}).`);
        } else {
          waits[key] = wait;
          retained.push(op);
        }
      } else {
        await reject(op, error);
      }
    }
    await assertSessionFence(fence);
    await writeQueueUnlocked(fence.userId, [...retained, ...deferred.slice(index + 1)], waits);
    outcome.remaining = retained.length + deferred.length - index - 1;
  }
  return outcome;
}

// Returns the number of ops applied. Stops quietly offline (returns what was
// applied so far). When the server refused queued ops they are moved to the
// rejected list — every later op still flushes — and RejectedWritesError is
// thrown afterwards so the caller can tell the user; it is not raised again
// for the same ops on later flushes.
export async function flushWriteQueue(expectedUserId: string): Promise<number> {
  const fence = await sessionFence(expectedUserId);
  const outcome = await withQueueLock(() => flushQueueUnlocked(fence));
  if (outcome.rejected.length) throw rejectedWritesError(outcome.rejected);
  return outcome.flushed;
}

export async function pendingWriteCount(expectedUserId: string): Promise<number> {
  const fence = await sessionFence(expectedUserId);
  return withQueueLock(async () => {
    await assertSessionFence(fence);
    const count = (await readQueueUnlocked(fence.userId)).length;
    await assertSessionFence(fence);
    return count;
  });
}

// Changes the server refused, oldest first, for a "N changes could not be
// saved" notice. They are no longer in the live queue.
export async function listRejectedWrites(expectedUserId: string): Promise<RejectedWrite[]> {
  const fence = await sessionFence(expectedUserId);
  return withQueueLock(async () => {
    await assertSessionFence(fence);
    const entries = await readRejectedUnlocked(fence.userId);
    await assertSessionFence(fence);
    return entries.map(toRejectedWrite);
  });
}

export async function rejectedWriteCount(expectedUserId: string): Promise<number> {
  return (await listRejectedWrites(expectedUserId)).length;
}

// Drop a refused change for good. The next refresh replaces whatever it had
// changed locally with the server's copy (a row it would have created is
// removed from the saved copy, since nothing will create it any more).
export async function discardRejectedWrite(expectedUserId: string, rejectedId: string): Promise<void> {
  const fence = await sessionFence(expectedUserId);
  await withQueueLock(async () => {
    await assertSessionFence(fence);
    const entries = await readRejectedUnlocked(fence.userId);
    const next = entries.filter((entry) => entry.id !== rejectedId);
    if (next.length !== entries.length) await writeRejectedUnlocked(fence.userId, next);
    await assertSessionFence(fence);
  });
}

export async function discardAllRejectedWrites(expectedUserId: string): Promise<void> {
  const fence = await sessionFence(expectedUserId);
  await withQueueLock(async () => {
    await assertSessionFence(fence);
    if ((await readRejectedUnlocked(fence.userId)).length) await writeRejectedUnlocked(fence.userId, []);
    await assertSessionFence(fence);
  });
}

// Put a refused change back at the end of the live queue and flush. Returns
// the number of ops applied; throws RejectedWritesError (and lists it again)
// if the server still refuses it. Offline it simply stays queued.
export async function retryRejectedWrite(expectedUserId: string, rejectedId: string): Promise<number> {
  const fence = await sessionFence(expectedUserId);
  await withQueueLock(async () => {
    await assertSessionFence(fence);
    const entries = await readRejectedUnlocked(fence.userId);
    const entry = entries.find((item) => item.id === rejectedId);
    if (!entry) throw new StoreError('That change is no longer waiting to be retried.', false);
    const { ops, parentWaits } = await readQueueStateUnlocked(fence.userId);
    await assertSessionFence(fence);
    // Live queue first, then out of the rejected list: never in neither.
    await writeQueueUnlocked(fence.userId, [...ops, entry.op], parentWaits);
    await writeRejectedUnlocked(fence.userId, entries.filter((item) => item.id !== rejectedId));
    await assertSessionFence(fence, true);
  });
  return flushWriteQueue(fence.userId);
}

export type WorkspaceChangeOptions = {
  // Account deletion: changes the server already refused are moot. Joining
  // another workspace keeps the default and refuses until they are handled.
  discardRejected?: boolean;
};

// Joining another workspace changes the tenant behind an otherwise unchanged
// auth user. Flush the old workspace queue, refuse to cross the boundary while
// anything remains unsynced, then remove the account-scoped cache so hydrate()
// cannot interpret old-workspace rows as new unsynced local records.
export async function prepareForWorkspaceChange(expectedUserId: string, options: WorkspaceChangeOptions = {}): Promise<void> {
  const fence = await sessionFence(expectedUserId);
  if (fence.offline) throw new StoreError('Connect to the internet so this device can sync its changes, then try again.', false);
  try {
    await flushWriteQueue(fence.userId);
  } catch (error) {
    if (!(error instanceof RejectedWritesError) || !options.discardRejected) throw error;
  }
  await assertSessionFence(fence);
  // Match hydrate's cache-then-queue lock order to avoid lock inversion.
  await withCacheLock(async () => {
    await withQueueLock(async () => {
      const pending = await readQueueUnlocked(fence.userId);
      if (pending.length) {
        throw new StoreError('Sync pending changes before joining another workspace.', true);
      }
      const rejected = await readRejectedUnlocked(fence.userId);
      if (rejected.length && !options.discardRejected) {
        throw new StoreError(
          `${rejected.length} ${rejected.length === 1 ? 'change' : 'changes'} on this device could not be saved. Retry or discard ${rejected.length === 1 ? 'it' : 'them'} before joining another workspace.`,
          false,
        );
      }
      try {
        await AsyncStorage.multiRemove([
          accountStorageKey(CACHE_KEY_PREFIX, fence.userId),
          accountStorageKey(QUEUE_KEY_PREFIX, fence.userId),
          accountStorageKey(REJECTED_KEY_PREFIX, fence.userId),
          accountStorageKey(WORKSPACE_KEY_PREFIX, fence.userId),
          ...await caseCacheKeys(fence.userId),
        ]);
      } catch (error) {
        throw persistenceError('cache', error);
      }
      await assertSessionFence(fence);
    });
  });
}

// The workspace this account's local cache and queue were last bound to, or
// null if never bound on this device. Used only when the server cannot be
// asked: an offline launch reads the caches under their last verified
// binding, and the next foreground return with signal re-verifies (and wipes
// on a change) exactly as before. Queued writes still flush only after
// assertWorkspaceFence confirms the server agrees.
export async function readBoundWorkspace(expectedUserId: string): Promise<string | null> {
  const fence = await sessionFence(expectedUserId);
  let stored: string | null;
  try {
    stored = await AsyncStorage.getItem(accountStorageKey(WORKSPACE_KEY_PREFIX, fence.userId));
  } catch (error) {
    throw persistenceError('cache', error);
  }
  await assertSessionFence(fence);
  return stored && isUuid(stored) ? stored.toLowerCase() : null;
}

// Whether this account's session is currently known only from the device
// (expired access token, no connection to refresh it). App.tsx can use it to
// skip server lookups that would otherwise wait out supabase-js's retries.
export async function isOfflineSession(expectedUserId: string): Promise<boolean> {
  return (await sessionFence(expectedUserId)).offline;
}

// Bind account-local cache/queue data to the authoritative server workspace.
// A missing marker is treated as untrusted legacy state and quarantined too.
export async function bindLocalWorkspace(expectedUserId: string, orgId: string): Promise<boolean> {
  if (!isUuid(orgId)) throw new StoreError('A valid workspace is required before loading offline data.', false);
  const fence = await sessionFence(expectedUserId);
  const workspaceKey = accountStorageKey(WORKSPACE_KEY_PREFIX, fence.userId);
  return withCacheLock(async () => withQueueLock(async () => {
    await assertSessionFence(fence);
    let previous: string | null;
    try {
      previous = await AsyncStorage.getItem(workspaceKey);
    } catch (error) {
      throw persistenceError('cache', error);
    }
    const changed = previous?.toLowerCase() !== orgId.toLowerCase();
    if (changed) {
      try {
        await AsyncStorage.multiRemove([
          accountStorageKey(CACHE_KEY_PREFIX, fence.userId),
          accountStorageKey(QUEUE_KEY_PREFIX, fence.userId),
          accountStorageKey(REJECTED_KEY_PREFIX, fence.userId),
          ...await caseCacheKeys(fence.userId),
        ]);
        await AsyncStorage.setItem(workspaceKey, orgId.toLowerCase());
      } catch (error) {
        throw persistenceError('cache', error);
      }
    }
    await assertSessionFence(fence);
    return changed;
  }));
}

// ─── Row ↔ app-type mapping (snake_case DB ↔ camelCase app) ─────────────────

type PartnerRow = {
  id: string;
  name: string;
  organization: string | null;
  types: string[] | null;
  city: string | null;
  state: string | null;
  regions: string[] | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  monthly_cost: number | null;
  insurance_networks: unknown;
  cash_min: number | null;
  cash_max: number | null;
  insurance: string[] | null;
  therapies: string[] | null;
  populations: string[] | null;
  levels: string[] | null;
  note: string | null;
  favorite: boolean | null;
  touch_cadence_days: number | null;
  last_contact_at: string | null;
  created_at: string;
  global_partner_id?: string | null;
  global_listing_status?: string | null;
  directory_rejected_at?: string | null;
  directory_review_note?: string | null;
  // Matching integrity (20261001130000). Private to the workspace; never
  // part of any directory field list.
  financial_relationship?: string | null;
  financial_relationship_note?: string | null;
};

type ReferralRow = {
  id: string;
  partner_id: string;
  direction: 'inbound' | 'outbound';
  referred_on: string;
  client_label: string | null;
  outcome: Referral['outcome'];
  note: string | null;
  admitted: boolean | null;
  admitted_on: string | null;
  family_experience: number | null;
  outcome_note: string | null;
  packet_sent_at: string | null;
  match_profile_id: string | null;
  case_id: string | null; // v3 case-files linkage
  // Outcomes loop (20261001160000); optional so older rows still map.
  completed?: boolean | null;
  completed_on?: string | null;
  still_enrolled?: boolean | null;
  last_check_in_at?: string | null;
};

type MatchRow = {
  id: string;
  client_label: string | null;
  level_of_care: string;
  state: string | null;
  insurance: string | null;
  network_preferences: string[] | null;
  max_budget: number | null;
  therapies: string[] | null;
  status: 'Matching' | 'Referred';
  assigned_partner_id: string | null;
  referral_id: string | null;
  case_id: string | null; // v3 case-files linkage
  created_at: string;
  updated_at: string;
  // Matching integrity (20261001130000)
  must_have_therapies?: string[] | null;
  population?: string | null;
  location_preference?: string | null;
};

type TouchRow = {
  id: string;
  partner_id: string;
  kind: TouchKind;
  note: string | null;
  occurred_at: string;
};

type BalanceRow = {
  partner_id: string;
  inbound: number | string | null;
  outbound: number | string | null;
};

type FollowUpRow = {
  id: string;
  partner_id: string | null;
  referral_id: string | null;
  case_id: string | null; // v3 case-files linkage
  title: string;
  due_on: string;
  status: FollowUpStatus;
  completed_at: string | null;
  note: string | null;
  kind: FollowUpKind | null; // v4 today-command-center
  due_time: string | null; // Postgres time serializes as "HH:MM:SS"
  waiting_on: string | null;
  snoozed_until: string | null;
  assigned_to?: string | null;
  completed_by?: string | null;
  check_in_days?: number | null;
};

type ScorecardRow = {
  partner_id: string;
  referrals_sent: number | string | null;
  admits: number | string | null;
  non_admits: number | string | null;
  avg_family_experience: number | string | null;
  last_referral_on: string | null;
  completed?: number | string | null;
  decided_placements?: number | string | null;
  completion_rate?: number | string | null;
  median_days_to_admit?: number | string | null;
  still_enrolled?: number | string | null;
};

type NetworkStatsRow = {
  global_partner_id: string;
  admit_rate: number | string | null;
  family_experience: number | string | null;
  completion_rate?: number | string | null;
  disclosed: boolean;
};

function toNumber(value: number | string | null | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function localDateStamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// The calendar day, on this device, of a timestamptz (or a plain YYYY-MM-DD,
// returned as is). Slicing the ISO string would give the UTC day, so an
// evening touch in a US time zone would be recorded as tomorrow.
function toDateStamp(iso: string | null | undefined, fallback: string): string {
  if (!iso) return fallback;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso.slice(0, 10) : localDateStamp(parsed);
}

const insuranceNetworkStatuses = new Set<InsuranceNetworkPreference>(['In-network', 'Out-of-network']);

function sanitizeInsuranceNetworks(value: unknown, insurance: string[]): Partial<Record<string, InsuranceNetworkPreference[]>> {
  const plans = insurance.filter((plan) => plan !== 'Cash pay');
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) {
    return Object.fromEntries(plans.map((plan) => [plan, ['In-network' as InsuranceNetworkPreference]]));
  }

  const rawNetworks = value as Record<string, unknown>;
  return Object.fromEntries(plans.flatMap((plan) => {
    const rawStatuses = rawNetworks[plan];
    if (!Array.isArray(rawStatuses)) return [];
    const statuses = [...new Set(rawStatuses.filter(
      (status): status is InsuranceNetworkPreference => typeof status === 'string' && insuranceNetworkStatuses.has(status as InsuranceNetworkPreference),
    ))];
    return statuses.length ? [[plan, statuses] as const] : [];
  }));
}

function mapPartnerRow(row: PartnerRow, balance: BalanceRow | undefined): Partner {
  const types = (row.types || []) as PartnerType[];
  const primary = types[0] || 'Inpatient';
  return {
    id: row.id,
    name: row.name,
    organization: row.organization || '',
    type: primary,
    types: types.length ? types : undefined,
    city: row.city || '',
    state: row.state || '',
    regions: row.regions || [],
    phone: row.phone || '',
    email: row.email || '',
    website: row.website || undefined,
    monthlyCost: toNumber(row.monthly_cost) || toNumber(row.cash_max) || toNumber(row.cash_min),
    insuranceNetworks: sanitizeInsuranceNetworks(row.insurance_networks, row.insurance || []),
    cashMin: toNumber(row.cash_min),
    cashMax: toNumber(row.cash_max),
    insurance: row.insurance || [],
    therapies: row.therapies || [],
    populations: row.populations || [],
    levels: row.levels || [],
    note: row.note || '',
    inbound: toNumber(balance?.inbound),
    outbound: toNumber(balance?.outbound),
    lastContact: toDateStamp(row.last_contact_at, toDateStamp(row.created_at, '')),
    favorite: Boolean(row.favorite),
    touchCadenceDays: row.touch_cadence_days ?? undefined,
    createdAt: row.created_at,
    globalPartnerId: row.global_partner_id ?? undefined,
    globalListingStatus: row.global_partner_id && (row.global_listing_status === 'pending' || row.global_listing_status === 'archived' || row.global_listing_status === 'active')
      ? row.global_listing_status
      : undefined,
    directoryRejectedAt: row.directory_rejected_at ?? undefined,
    directoryReviewNote: row.directory_review_note || undefined,
    financialRelationship: sanitizeFinancialRelationship(row.financial_relationship),
    financialRelationshipNote: row.financial_relationship_note || undefined,
  };
}

const financialRelationships = new Set<FinancialRelationship>(['none', 'consulting_fee', 'marketing_agreement', 'speaking_fee', 'shared_ownership', 'other']);
function sanitizeFinancialRelationship(value: unknown): FinancialRelationship {
  return typeof value === 'string' && financialRelationships.has(value as FinancialRelationship) ? (value as FinancialRelationship) : 'none';
}

const clientPopulationValues = new Set<ClientPopulation>(['Any', 'Men', 'Women', 'Adolescent']);
function sanitizePopulation(value: unknown): ClientPopulation {
  return typeof value === 'string' && clientPopulationValues.has(value as ClientPopulation) ? (value as ClientPopulation) : 'Any';
}

const locationPreferenceValues = new Set<LocationPreference>(['No preference', 'Close to family', 'Away from home']);
function sanitizeLocationPreference(value: unknown): LocationPreference {
  return typeof value === 'string' && locationPreferenceValues.has(value as LocationPreference) ? (value as LocationPreference) : 'No preference';
}

function mapReferralRow(row: ReferralRow): Referral {
  return {
    id: row.id,
    partnerId: row.partner_id,
    direction: row.direction === 'inbound' ? 'Inbound' : 'Outbound',
    date: row.referred_on,
    clientLabel: row.client_label || '',
    outcome: row.outcome,
    note: row.note || '',
    packetSentAt: row.packet_sent_at || undefined,
    matchProfileId: row.match_profile_id || undefined,
    caseId: row.case_id || undefined,
    admitted: row.admitted,
    admittedOn: row.admitted_on || undefined,
    familyExperience: row.family_experience,
    outcomeNote: row.outcome_note || '',
    completed: row.completed ?? null,
    completedOn: row.completed_on || undefined,
    stillEnrolled: row.still_enrolled ?? null,
    lastCheckInAt: row.last_check_in_at || undefined,
  };
}

function mapMatchRow(row: MatchRow): ReferralMatch {
  return {
    id: row.id,
    clientLabel: row.client_label || '',
    levelOfCare: row.level_of_care as ReferralMatch['levelOfCare'],
    state: row.state || '',
    insurance: row.insurance || '',
    networkPreferences: (row.network_preferences || []) as InsuranceNetworkPreference[],
    maxBudget: row.max_budget ?? undefined,
    therapies: row.therapies || [],
    // Rows from before 20261001130000 have no must-have list; leaving it
    // undefined lets the matcher apply the defaults (MAT only).
    mustHaveTherapies: Array.isArray(row.must_have_therapies) ? row.must_have_therapies : undefined,
    population: sanitizePopulation(row.population),
    locationPreference: sanitizeLocationPreference(row.location_preference),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    assignedPartnerId: row.assigned_partner_id || undefined,
    referralId: row.referral_id || undefined,
    caseId: row.case_id || undefined,
  };
}

function mapTouchRow(row: TouchRow): Touch {
  return {
    id: row.id,
    partnerId: row.partner_id,
    kind: row.kind,
    note: row.note || '',
    occurredAt: row.occurred_at,
  };
}

function mapFollowUpRow(row: FollowUpRow): FollowUp {
  return {
    id: row.id,
    partnerId: row.partner_id || undefined,
    referralId: row.referral_id || undefined,
    caseId: row.case_id || undefined,
    title: row.title,
    dueOn: row.due_on,
    status: row.status,
    completedAt: row.completed_at || undefined,
    note: row.note || '',
    kind: row.kind || 'follow_up',
    // time columns come back as "HH:MM:SS" — keep HH:MM for display/compare.
    dueTime: row.due_time ? row.due_time.slice(0, 5) : undefined,
    waitingOn: row.waiting_on || undefined,
    snoozedUntil: row.snoozed_until || undefined,
    assignedTo: row.assigned_to ? String(row.assigned_to).toLowerCase() : undefined,
    completedBy: row.completed_by ? String(row.completed_by).toLowerCase() : undefined,
    checkInDays: row.check_in_days ?? undefined,
  };
}

function toNullableNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapScorecardRow(row: ScorecardRow): PartnerScorecard {
  return {
    partnerId: row.partner_id,
    referralsSent: toNumber(row.referrals_sent),
    admits: toNumber(row.admits),
    nonAdmits: toNumber(row.non_admits),
    avgFamilyExperience: toNullableNumber(row.avg_family_experience),
    lastReferralOn: row.last_referral_on,
    completed: toNumber(row.completed),
    decidedPlacements: toNumber(row.decided_placements),
    completionRate: toNullableNumber(row.completion_rate),
    medianDaysToAdmit: toNullableNumber(row.median_days_to_admit),
    stillEnrolled: toNumber(row.still_enrolled),
  };
}

// Network priors for matching: the disclosed directory figures for every
// listing this workspace's partners are linked to. Best effort — a workspace
// without the directory entitlement, or offline, simply ranks on its own
// history (the RPC error is swallowed, never surfaced).
async function fetchNetworkTrackRecords(globalPartnerIds: string[]): Promise<Map<string, NetworkTrackRecord>> {
  const result = new Map<string, NetworkTrackRecord>();
  const ids = Array.from(new Set(globalPartnerIds.filter(Boolean)));
  for (let index = 0; index < ids.length; index += 200) {
    const chunk = ids.slice(index, index + 200);
    const { data, error } = await supabase.rpc('fetch_global_partner_stats', { p_ids: chunk });
    if (error) return result;
    for (const row of (data || []) as NetworkStatsRow[]) {
      if (!row.disclosed) continue;
      result.set(row.global_partner_id, {
        admitRate: toNullableNumber(row.admit_rate),
        familyExperience: toNullableNumber(row.family_experience),
        completionRate: toNullableNumber(row.completion_rate ?? null),
      });
    }
  }
  return result;
}

// App type → insert/update rows. `id` is included so optimistic local objects
// keep the same identity once they reach the server (and upserts stay
// idempotent when flushed from the offline queue).
function partnerToRow(partner: Partner): Record<string, unknown> {
  const types = partner.types?.length ? partner.types : [partner.type];
  return {
    id: safeId(partner.id),
    name: partner.name,
    organization: partner.organization,
    types,
    city: partner.city,
    state: partner.state,
    regions: partner.regions,
    phone: partner.phone,
    email: partner.email,
    website: partner.website || null,
    monthly_cost: partner.monthlyCost ?? partner.cashMax ?? partner.cashMin ?? 0,
    insurance_networks: partner.insuranceNetworks || {},
    // Keep legacy clients coherent while the monthly-cost UI rolls out.
    cash_min: partner.monthlyCost ?? partner.cashMin ?? 0,
    cash_max: partner.monthlyCost ?? partner.cashMax ?? partner.cashMin ?? 0,
    insurance: partner.insurance,
    therapies: partner.therapies,
    populations: partner.populations,
    levels: partner.levels,
    note: partner.note,
    favorite: Boolean(partner.favorite),
    touch_cadence_days: partner.touchCadenceDays ?? null,
    financial_relationship: partner.financialRelationship || 'none',
    financial_relationship_note: partner.financialRelationshipNote || '',
  };
}

// Last line of defence: every PK/FK sent upstream must be a uuid. If any code
// path still yields a legacy prefixed id, map it deterministically here so the
// write succeeds instead of erroring out in the user's face.
function safeId(value: string | undefined | null): string | null {
  if (!value) return null;
  return isUuid(value) ? value : uuidFromLegacyId(value);
}

function referralToRow(referral: Referral): Record<string, unknown> {
  return {
    id: safeId(referral.id),
    partner_id: safeId(referral.partnerId),
    direction: referral.direction === 'Inbound' ? 'inbound' : 'outbound',
    referred_on: referral.date,
    client_label: referral.clientLabel,
    outcome: referral.outcome,
    note: referral.note,
    // v2 columns (deployed migration 20260724150000) — packet + outcome data
    packet_sent_at: referral.packetSentAt ?? null,
    match_profile_id: safeId(referral.matchProfileId),
    case_id: safeId(referral.caseId),
    admitted: referral.admitted ?? null,
    admitted_on: referral.admittedOn ?? null,
    family_experience: referral.familyExperience ?? null,
    outcome_note: referral.outcomeNote ?? '',
    // Outcomes loop columns are only sent when set, so a build that predates
    // migration 20261001160000 on the server still inserts cleanly.
    ...(referral.completed === undefined ? {} : { completed: referral.completed }),
    ...(referral.completedOn === undefined ? {} : { completed_on: referral.completedOn || null }),
    ...(referral.stillEnrolled === undefined ? {} : { still_enrolled: referral.stillEnrolled }),
  };
}

function matchToRow(match: ReferralMatch): Record<string, unknown> {
  return {
    id: safeId(match.id),
    client_label: match.clientLabel,
    level_of_care: match.levelOfCare,
    state: match.state,
    insurance: match.insurance,
    network_preferences: match.networkPreferences || [],
    max_budget: match.maxBudget ?? null,
    therapies: match.therapies,
    must_have_therapies: match.mustHaveTherapies ?? null,
    population: match.population || 'Any',
    location_preference: match.locationPreference || 'No preference',
    status: match.status,
    assigned_partner_id: safeId(match.assignedPartnerId),
    referral_id: safeId(match.referralId),
    case_id: safeId(match.caseId),
  };
}

function placementToRow(decision: PlacementDecision): Record<string, unknown> {
  return {
    id: safeId(decision.id),
    match_profile_id: safeId(decision.matchProfileId),
    case_id: safeId(decision.caseId),
    referral_id: safeId(decision.referralId),
    chosen_partner_id: safeId(decision.chosenPartnerId),
    chosen_rank: decision.chosenRank,
    reason: decision.reason ?? null,
    reason_note: decision.reasonNote ?? '',
    candidates: decision.candidates.map((candidate) => ({ ...candidate, partnerId: safeId(candidate.partnerId) })),
    weights: decision.weights,
    decided_at: decision.decidedAt,
  };
}

function touchToRow(touch: Touch): Record<string, unknown> {
  return {
    id: safeId(touch.id),
    partner_id: safeId(touch.partnerId),
    kind: touch.kind,
    note: touch.note,
    occurred_at: touch.occurredAt,
  };
}

function followUpToRow(followUp: FollowUp): Record<string, unknown> {
  return {
    id: safeId(followUp.id),
    partner_id: safeId(followUp.partnerId),
    referral_id: safeId(followUp.referralId),
    case_id: safeId(followUp.caseId),
    title: followUp.title,
    due_on: followUp.dueOn,
    status: followUp.status,
    completed_at: followUp.completedAt ?? null,
    note: followUp.note,
    kind: followUp.kind ?? 'follow_up',
    due_time: followUp.dueTime ?? null,
    waiting_on: followUp.waitingOn ?? '',
    snoozed_until: followUp.snoozedUntil ?? null,
    // completed_by is stamped server-side from the signed-in member.
    ...(followUp.assignedTo === undefined ? {} : { assigned_to: followUp.assignedTo ? safeId(followUp.assignedTo) : null }),
  };
}

function packetEventToRow(event: PacketCaseEvent): Record<string, unknown> {
  return {
    id: safeId(event.id), case_id: safeId(event.caseId), kind: event.kind,
    body: event.body, referral_id: safeId(event.referralId), contact_id: safeId(event.contactId), occurred_at: event.occurredAt,
  };
}

function referralOutcomePatchToRow(patch: ReferralOutcomePatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.admitted !== undefined) row.admitted = patch.admitted;
  if (patch.admittedOn !== undefined) row.admitted_on = patch.admittedOn;
  if (patch.familyExperience !== undefined) row.family_experience = patch.familyExperience;
  if (patch.outcomeNote !== undefined) row.outcome_note = patch.outcomeNote;
  if (patch.outcome !== undefined) row.outcome = patch.outcome;
  if (patch.completed !== undefined) row.completed = patch.completed;
  if (patch.completedOn !== undefined) row.completed_on = patch.completedOn;
  if (patch.stillEnrolled !== undefined) row.still_enrolled = patch.stillEnrolled;
  if (patch.checkIn !== undefined) row.check_in = patch.checkIn;
  return row;
}

// ─── Local cache ────────────────────────────────────────────────────────────

type CacheEnvelope = { version: 2; userId: string; snapshot: Snapshot };
let cacheMutex: Promise<void> = Promise.resolve();

async function withCacheLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = cacheMutex;
  let release!: () => void;
  cacheMutex = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

function parseSnapshot(value: unknown): Snapshot | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = value as Partial<Snapshot>;
  if (!Array.isArray(parsed.partners)) return null;
  return {
    partners: parsed.partners as Partner[],
    referrals: Array.isArray(parsed.referrals) ? parsed.referrals : [],
    referralMatches: Array.isArray(parsed.referralMatches) ? parsed.referralMatches : [],
    touches: Array.isArray(parsed.touches) ? parsed.touches : [],
    followUps: Array.isArray(parsed.followUps) ? parsed.followUps : [],
    scorecards: parsed.scorecards && typeof parsed.scorecards === 'object' ? parsed.scorecards : {},
  };
}

async function writeCacheUnlocked(fence: SessionFence, snapshot: Snapshot): Promise<void> {
  const envelope: CacheEnvelope = { version: 2, userId: fence.userId, snapshot };
  try {
    await AsyncStorage.setItem(accountStorageKey(CACHE_KEY_PREFIX, fence.userId), JSON.stringify(envelope));
  } catch (error) {
    throw persistenceError('cache', error);
  }
}

async function readCacheUnlocked(fence: SessionFence): Promise<Snapshot | null> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(accountStorageKey(CACHE_KEY_PREFIX, fence.userId));
  } catch (error) {
    throw persistenceError('cache', error);
  }
  if (!raw) return null;
  try {
    const envelope = JSON.parse(raw) as Partial<CacheEnvelope>;
    if (envelope.version !== 2 || envelope.userId?.toLowerCase() !== fence.userId) return null;
    return parseSnapshot(envelope.snapshot);
  } catch {
    // Corrupt account-local cache is ignored; unlike queue corruption it does
    // not represent unsynced work and can safely be replaced from the server.
    return null;
  }
}

async function writeCache(fence: SessionFence, snapshot: Snapshot): Promise<void> {
  await withCacheLock(async () => {
    await assertSessionFence(fence);
    await writeCacheUnlocked(fence, snapshot);
    await assertSessionFence(fence);
  });
}

async function readCache(fence: SessionFence): Promise<Snapshot | null> {
  return withCacheLock(async () => {
    await assertSessionFence(fence);
    const snapshot = await readCacheUnlocked(fence);
    await assertSessionFence(fence);
    return snapshot;
  });
}

// ─── Legacy non-uuid id repair ───────────────────────────────────────────────
// Builds up to 1.0.0(8) generated ids like `p-1785096121092-t1etoz4`, which the
// uuid primary keys reject ("invalid input syntax for type uuid"). Any such row
// is stranded in the local cache and its queued write can never succeed. This
// pass rewrites those ids to real uuids (and repoints FK references) before the
// cache is used or the queue is flushed, so the next sync heals itself.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): boolean {
  return typeof value === 'string' && UUID_RE.test(value);
}

// DETERMINISTIC old-id -> uuid mapping. This must be stable across both repair
// passes (cache and write queue) and across launches: if the cached partner and
// the queued referral that references it were given different random uuids, the
// referral insert would fail with a foreign-key violation instead of syncing.
function uuidFromLegacyId(oldId: string): string {
  // 4 independent FNV-1a passes (different offsets) -> 32 hex chars.
  const hex: string[] = [];
  for (let pass = 0; pass < 4; pass += 1) {
    let h = 0x811c9dc5 ^ (pass * 0x01000193);
    for (let i = 0; i < oldId.length; i += 1) {
      h ^= oldId.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    hex.push(h.toString(16).padStart(8, '0'));
  }
  const raw = hex.join('');
  const version = `4${raw.slice(13, 16)}`;                        // RFC4122 v4
  const variant = ((parseInt(raw[16], 16) & 0x3) | 0x8).toString(16) + raw.slice(17, 20);
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${version}-${variant}-${raw.slice(20, 32)}`;
}

function repairSnapshotIds(snapshot: Snapshot): { snapshot: Snapshot; repaired: number } {
  const remap = new Map<string, string>();
  const idFor = (old: string | undefined | null): string | undefined => {
    if (!old) return old ?? undefined;
    if (isUuid(old)) return old;
    let next = remap.get(old);
    if (!next) {
      next = uuidFromLegacyId(old);
      remap.set(old, next);
    }
    return next;
  };

  const partners = snapshot.partners.map((p) => ({ ...p, id: idFor(p.id) as string }));
  const referrals = snapshot.referrals.map((r) => ({
    ...r,
    id: idFor(r.id) as string,
    partnerId: idFor(r.partnerId) as string,
    matchProfileId: idFor(r.matchProfileId),
    caseId: idFor(r.caseId),
  }));
  const referralMatches = snapshot.referralMatches.map((m) => ({
    ...m,
    id: idFor(m.id) as string,
    assignedPartnerId: idFor(m.assignedPartnerId),
    referralId: idFor(m.referralId),
    caseId: idFor(m.caseId),
  }));
  const touches = snapshot.touches.map((t) => ({
    ...t,
    id: idFor(t.id) as string,
    partnerId: idFor(t.partnerId) as string,
  }));
  const followUps = snapshot.followUps.map((f) => ({
    ...f,
    id: idFor(f.id) as string,
    partnerId: idFor(f.partnerId),
    referralId: idFor(f.referralId),
    caseId: idFor(f.caseId),
  }));

  const scorecards: Snapshot['scorecards'] = {};
  Object.entries(snapshot.scorecards || {}).forEach(([key, value]) => {
    const mapped = idFor(key);
    if (mapped) scorecards[mapped] = value;
  });

  return {
    snapshot: { partners, referrals, referralMatches, touches, followUps, scorecards },
    repaired: remap.size,
  };
}

// Follow-up ids the local cache has but the open-follow-up load did not return
// are checked against the server by id: a row the server has always wins.
const FOLLOW_UP_PROBE_CHUNK = 200;

async function fetchFollowUpsById(ids: string[]): Promise<FollowUpRow[]> {
  const rows: FollowUpRow[] = [];
  for (let start = 0; start < ids.length; start += FOLLOW_UP_PROBE_CHUNK) {
    const chunk = ids.slice(start, start + FOLLOW_UP_PROBE_CHUNK);
    rows.push(...await fetchAllPages<FollowUpRow>((from, to) => supabase.from('follow_ups').select('*').in('id', chunk).order('id').range(from, to)));
  }
  return rows;
}

// Ids of rows that a change still waiting on this device would create: every
// op in the live queue and in the rejected list (a refused change keeps its
// row visible until the user retries or discards it).
type PendingRows = {
  partners: Set<string>;
  referrals: Set<string>;
  matches: Set<string>;
  touches: Set<string>;
  followUps: Set<string>;
};

function rowIdOf(row: Record<string, unknown> | null | undefined): string | null {
  const id = row?.id;
  return typeof id === 'string' && id ? id.toLowerCase() : null;
}

function pendingCreatedRows(ops: QueueOp[]): PendingRows {
  const pending: PendingRows = { partners: new Set(), referrals: new Set(), matches: new Set(), touches: new Set(), followUps: new Set() };
  const add = (set: Set<string>, row: Record<string, unknown> | null | undefined) => {
    const id = rowIdOf(row);
    if (id) set.add(id);
  };
  for (const op of ops) {
    switch (op.kind) {
      case 'partner.insert': add(pending.partners, op.row); break;
      case 'referral.insert': add(pending.referrals, op.row); break;
      case 'match.insert': add(pending.matches, op.row); break;
      case 'touch.insert': add(pending.touches, op.row); break;
      case 'follow_up.insert': add(pending.followUps, op.row); break;
      case 'follow_up.complete_next': add(pending.followUps, op.next); break;
      case 'match.save_case': add(pending.matches, op.match); break;
      case 'referral.assign_match': add(pending.referrals, op.referral); add(pending.matches, op.match); break;
      case 'packet.finalize':
        add(pending.referrals, op.referral);
        add(pending.matches, op.match);
        add(pending.touches, op.touch);
        add(pending.followUps, op.followUp);
        break;
      case 'contact.log_activity': add(pending.touches, op.touch); break;
      case 'outreach.sent': add(pending.followUps, op.next); add(pending.touches, op.touch); break;
      default: break;
    }
  }
  return pending;
}

// Caller holds the cache lock (cache-then-queue order, like hydrate).
async function readPendingRows(fence: SessionFence): Promise<PendingRows> {
  return withQueueLock(async () => {
    await assertSessionFence(fence);
    const queued = await readQueueUnlocked(fence.userId);
    const rejected = await readRejectedUnlocked(fence.userId);
    return pendingCreatedRows([...queued, ...rejected.map((entry) => entry.op)]);
  });
}

function isPendingRow(set: Set<string>, id: string): boolean {
  return set.has(id.toLowerCase());
}

// Merge rows that exist only in this account's local cache into a freshly
// fetched server snapshot.
//
// A row the cache has and the server load lacks is one of two things: a local
// row that has not reached the server yet, or a row someone deleted on the
// server (a teammate, another device). Only the first may survive, and only
// while the change that creates it is still waiting on this device — in the
// live queue or the rejected list (`pending`). Anything else is dropped from
// the saved copy: re-inserting it would undo the deletion. Nothing is queued
// here; the op that creates a pending row is already durable.
//
// Partners, referrals, match profiles and touches load in full (paged), so
// "missing from remote" is meaningful for them. Follow-ups load open rows only,
// so a cached one can be missing because it was completed:
//   - cached rows that are not open are never candidates;
//   - cached open rows the remote load lacks are looked up by id on the server.
//     A row the server has wins (kept if still open, dropped if completed). An
//     id the server does not know survives only while a pending op creates it.
async function mergeUnsyncedLocal(remote: Snapshot, local: Snapshot | null, pending: PendingRows): Promise<{ snapshot: Snapshot }> {
  if (!local) return { snapshot: remote };
  const keepUnsynced = <T extends { id: string }>(r: T[], l: T[], created: Set<string>): T[] => {
    const have = new Set(r.map((x) => x.id));
    return [...r, ...l.filter((x) => x.id && !have.has(x.id) && isPendingRow(created, x.id))];
  };

  const remoteFollowUpIds = new Set(remote.followUps.map((row) => row.id));
  const openCandidates = local.followUps.filter((row) => row.id && row.status === 'open' && !remoteFollowUpIds.has(row.id));
  const serverCopies = openCandidates.length ? await fetchFollowUpsById(openCandidates.map((row) => row.id)) : [];
  const serverById = new Map(serverCopies.map((row) => [row.id, row]));
  return {
    snapshot: {
      partners: keepUnsynced(remote.partners, local.partners, pending.partners),
      referrals: keepUnsynced(remote.referrals, local.referrals, pending.referrals),
      referralMatches: keepUnsynced(remote.referralMatches, local.referralMatches, pending.matches),
      touches: keepUnsynced(remote.touches, local.touches, pending.touches),
      followUps: [
        ...remote.followUps,
        ...serverCopies.filter((row) => row.status === 'open').map(mapFollowUpRow),
        ...openCandidates.filter((row) => !serverById.has(row.id) && isPendingRow(pending.followUps, row.id)),
      ],
      scorecards: remote.scorecards,
    },
  };
}

// ─── Read path ──────────────────────────────────────────────────────────────

// Every list is paged (see paging.ts) and ordered on an immutable key plus the
// primary key, so a teammate's edit landing mid-fetch cannot move a row across
// a page boundary. Lists the UI reads in a mutable order (match profiles by
// updated_at, follow-ups by due_on) are re-sorted here after the full load.
//
// Follow-ups: Today, the case file and local reminders only ever read OPEN
// follow-ups, so those load in full and are never count-limited. Completed
// rows (done/skipped) are not loaded at all — nothing renders them, and the old
// due_on-ordered read was what dropped the newest open items past 1,000 rows.
async function fetchSnapshot(): Promise<Snapshot> {
  const [partnerRows, referralRows, matchRows, touchRows, balanceRows, followUpRows, scorecardRows] = await Promise.all([
    fetchAllPages<PartnerRow>((from, to) => supabase.from('partners').select('*').order('created_at', { ascending: false }).order('id').range(from, to)),
    fetchAllPages<ReferralRow>((from, to) => supabase.from('referrals').select('*').order('referred_on', { ascending: false }).order('id').range(from, to)),
    fetchAllPages<MatchRow>((from, to) => supabase.from('match_profiles').select('*').order('created_at', { ascending: false }).order('id').range(from, to)),
    fetchAllPages<TouchRow>((from, to) => supabase.from('touches').select('*').order('occurred_at', { ascending: false }).order('id').range(from, to)),
    fetchAllPages<BalanceRow>((from, to) => supabase.from('partner_balances').select('partner_id, inbound, outbound').order('partner_id').range(from, to), { keyOf: (row) => row.partner_id }),
    fetchAllPages<FollowUpRow>((from, to) => supabase.from('follow_ups').select('*').eq('status', 'open').order('created_at', { ascending: false }).order('id').range(from, to)),
    fetchAllPages<ScorecardRow>((from, to) => supabase.from('partner_scorecard').select('partner_id, referrals_sent, admits, non_admits, avg_family_experience, last_referral_on, completed, decided_placements, completion_rate, median_days_to_admit, still_enrolled').order('partner_id').range(from, to), { keyOf: (row) => row.partner_id }),
  ]);

  const balanceByPartner = new Map<string, BalanceRow>();
  for (const row of balanceRows) balanceByPartner.set(row.partner_id, row);

  const networkByListing = await fetchNetworkTrackRecords(partnerRows.map((row) => row.global_partner_id as string).filter(Boolean));
  const listingByPartner = new Map<string, string>();
  for (const row of partnerRows) if (row.global_partner_id) listingByPartner.set(row.id, row.global_partner_id as string);

  const scorecards: Record<string, PartnerScorecard> = {};
  for (const row of scorecardRows) {
    const card = mapScorecardRow(row);
    const listingId = listingByPartner.get(row.partner_id);
    const network = listingId ? networkByListing.get(listingId) : undefined;
    scorecards[row.partner_id] = network ? { ...card, network } : card;
  }

  return {
    partners: partnerRows.map((row) => mapPartnerRow(row, balanceByPartner.get(row.id))),
    referrals: referralRows.map(mapReferralRow),
    referralMatches: matchRows.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(mapMatchRow),
    touches: touchRows.map(mapTouchRow),
    followUps: followUpRows.sort((a, b) => a.due_on.localeCompare(b.due_on)).map(mapFollowUpRow),
    scorecards,
  };
}

function emptySnapshot(): Snapshot {
  return { partners: [], referrals: [], referralMatches: [], touches: [], followUps: [], scorecards: {} };
}

// Anything thrown by the data layer as a readable StoreError (PostgREST errors
// are plain objects; a lost connection is passed through for classification).
function asStoreError(error: unknown): unknown {
  if (error instanceof StoreError || isNetworkError(error)) return error;
  return new StoreError(describeError(error), false);
}

// Hydrate app state for one authenticated account. Remote is the source of
// truth; network failure falls back only to that account's validated v2 cache.
// Legacy global blobs remain quarantined because their owner cannot be proven.
// A queued change the server refuses never locks the account out: it is set
// aside (listRejectedWrites) and hydration continues; any other sync failure
// shows the saved copy rather than an error.
export async function hydrate(expectedUserId: string): Promise<HydrateResult> {
  const fence = await sessionFence(expectedUserId);
  let syncError: string | undefined;
  try {
    const cachedBefore = await readCache(fence);
    if (cachedBefore) {
      const { snapshot: fixed, repaired } = repairSnapshotIds(cachedBefore);
      if (repaired > 0) await writeCache(fence, fixed);
    }

    // No connection to refresh the session: the saved copy is all there is,
    // and asking the server would only wait out supabase-js's retries.
    if (fence.offline) return { snapshot: (await readCache(fence)) ?? emptySnapshot(), source: 'cache' };

    try {
      await flushWriteQueue(fence.userId);
    } catch (error) {
      if (error instanceof RejectedWritesError) {
        // Set aside; everything behind it flushed. Carry on to the server copy.
        syncError = error.message;
      } else {
        await assertSessionFence(fence);
        const cached = await readCache(fence);
        if (cached) return { snapshot: cached, source: 'cache', syncError: describeError(error) };
        throw error;
      }
    }
    await assertSessionFence(fence);
    const remote = await fetchSnapshot();
    await assertSessionFence(fence);

    const merged = await withCacheLock(async () => {
      await assertSessionFence(fence);
      const latestLocal = await readCacheUnlocked(fence);
      const pending = await readPendingRows(fence);
      const result = await mergeUnsyncedLocal(remote, latestLocal, pending);
      await assertSessionFence(fence);
      await writeCacheUnlocked(fence, result.snapshot);
      await assertSessionFence(fence);
      return result.snapshot;
    });
    return { snapshot: merged, source: 'remote', ...(syncError ? { syncError } : {}) };
  } catch (error) {
    if (error instanceof StoreError) throw error;
    await assertSessionFence(fence);
    const cached = await readCache(fence);
    if (cached) return { snapshot: cached, source: 'cache', ...(syncError ? { syncError } : {}) };
    if (isNetworkError(error)) return { snapshot: emptySnapshot(), source: 'cache' };
    throw asStoreError(error);
  }
}

// Refresh the account-scoped offline cache from the latest in-memory state.
// Offline it still saves: the binding last verified on this device stands in
// for the server's workspace answer (assertCacheWorkspaceFence).
export async function persistCache(snapshot: Snapshot, expectedUserId: string): Promise<void> {
  // Acquire the cache lock before resolving the session so concurrent persists
  // commit in call order rather than getSession() completion order.
  await withCacheLock(async () => {
    const fence = await sessionFence(expectedUserId);
    await assertCacheWorkspaceFence(fence);
    await writeCacheUnlocked(fence, snapshot);
    await assertCacheWorkspaceFence(fence);
  });
}

// ─── Write path ─────────────────────────────────────────────────────────────
// Every mutator: caller applies the optimistic local update first, then calls
// the mutator. Network failures queue the op and resolve quietly (the local
// state is already correct); server failures raise StoreError so the caller
// can surface a message.

// supabase-js query builders are thenables (PromiseLike), not real Promises.
// `execute` receives the acting user (owner_id on inserts) and the bound
// workspace (org_id filter on updates/deletes) verified by the workspace fence.
//
// Ordering: a change must never reach the server ahead of older changes still
// queued on this device, or a later flush would replay the stale ones over it
// (a queued full-row partner patch reverting a newer note; a queued match
// insert undoing an assignment made online). So under the queue lock the queue
// is flushed first, and if anything is still waiting (no connection, or a
// parent row not saved yet) this change is queued behind it instead.
async function runOrQueue(
  expectedUserId: string,
  op: QueueOp,
  execute: (userId: string, orgId: string) => PromiseLike<{ error: { message: string } | null }>,
): Promise<void> {
  const fence = await sessionFence(expectedUserId);
  if (fence.offline) {
    await enqueueOp(fence, op);
    return;
  }
  await withQueueLock(async () => {
    if ((await readQueueUnlocked(fence.userId)).length) {
      // A refused older change is set aside (listRejectedWrites); it does not
      // fail this unrelated save.
      const drained = await flushQueueUnlocked(fence);
      if (drained.remaining > 0) {
        await enqueueOpUnlocked(fence, op);
        return;
      }
    }
    let result: { error: { message: string } | null };
    try {
      const orgId = await assertWorkspaceFence(fence);
      result = await execute(fence.userId, orgId);
    } catch (error) {
      if (!isNetworkError(error)) throw asStoreError(error);
      await enqueueOpUnlocked(fence, op);
      return;
    }
    if (!result.error) {
      await assertSessionFence(fence);
      return;
    }
    if (isNetworkError(result.error)) {
      await enqueueOpUnlocked(fence, op);
      return;
    }
    throw new StoreError(describeError(result.error), false);
  });
}

// The columns of `next` whose values differ from `previous` (the row as this
// device last saved it). Sending only those means an edit never rewrites a
// field the user did not touch — whatever a teammate saved there meanwhile
// survives, and a replayed queued edit cannot revert it.
function changedColumns(next: Record<string, unknown>, previous: Record<string, unknown> | null): Record<string, unknown> {
  if (!previous) return next;
  const patch: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(next)) {
    if (JSON.stringify(value) !== JSON.stringify(previous[column])) patch[column] = value;
  }
  return patch;
}

function withoutId(row: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...rest } = row;
  return rest;
}

// The saved copy of one row, as it was before the edit being written: App.tsx
// persists the cache only after the store accepts a write. Best effort — no
// copy means the full row is sent, as before.
async function savedRow<T>(expectedUserId: string, pick: (snapshot: Snapshot) => T | undefined): Promise<T | undefined> {
  try {
    const fence = await sessionFence(expectedUserId);
    const snapshot = await readCache(fence);
    return snapshot ? pick(snapshot) : undefined;
  } catch {
    return undefined;
  }
}

export async function createPartner(partner: Partner, expectedUserId: string): Promise<void> {
  const row = partnerToRow(partner);
  await runOrQueue(expectedUserId, { kind: 'partner.insert', row }, (userId) => supabase.from('partners').insert({ ...row, owner_id: userId }));
}

export async function updatePartner(partner: Partner, expectedUserId: string): Promise<void> {
  const row = partnerToRow(partner);
  const before = await savedRow(expectedUserId, (snapshot) => snapshot.partners.find((item) => safeId(item.id) === row.id));
  const patch = changedColumns(withoutId(row), before ? withoutId(partnerToRow(before)) : null);
  if (!Object.keys(patch).length) return; // nothing changed since the saved copy
  await runOrQueue(expectedUserId, { kind: 'partner.update', id: safeId(partner.id) as string, patch }, (_userId, orgId) =>
    supabase.from('partners').update(patch).eq('id', safeId(partner.id)).eq('org_id', orgId));
}

export async function createReferral(referral: Referral, expectedUserId: string): Promise<void> {
  const row = referralToRow(referral);
  await runOrQueue(expectedUserId, { kind: 'referral.insert', row }, (userId) => supabase.from('referrals').insert({ ...row, owner_id: userId }));
}

export async function createMatchProfile(match: ReferralMatch, expectedUserId: string): Promise<void> {
  const row = matchToRow(match);
  await runOrQueue(expectedUserId, { kind: 'match.insert', row }, (userId) => supabase.from('match_profiles').insert({ ...row, owner_id: userId }));
}

export async function updateMatchProfile(match: ReferralMatch, expectedUserId: string): Promise<void> {
  const row = matchToRow(match);
  const safeMatchId = safeId(match.id) as string;
  const before = await savedRow(expectedUserId, (snapshot) => snapshot.referralMatches.find((item) => safeId(item.id) === safeMatchId));
  const patch = changedColumns(withoutId(row), before ? withoutId(matchToRow(before)) : null);
  if (!Object.keys(patch).length) return; // nothing changed since the saved copy
  await runOrQueue(expectedUserId, { kind: 'match.update', id: safeMatchId, patch }, (_userId, orgId) =>
    supabase.from('match_profiles').update(patch).eq('id', safeMatchId).eq('org_id', orgId));
}

export async function deleteMatchProfile(matchId: string, expectedUserId: string): Promise<void> {
  const safeMatchId = safeId(matchId) as string;
  await runOrQueue(expectedUserId, { kind: 'match.delete', id: safeMatchId }, (_userId, orgId) =>
    supabase.from('match_profiles').delete().eq('id', safeMatchId).eq('org_id', orgId));
}

export async function createTouch(touch: Touch, expectedUserId: string): Promise<void> {
  const row = touchToRow(touch);
  await runOrQueue(expectedUserId, { kind: 'touch.insert', row }, (userId) => supabase.from('touches').upsert({ ...row, owner_id: userId }, { onConflict: 'id' }));
}

export async function saveMatchWithCase(match: ReferralMatch, caseId: string, expectedUserId: string): Promise<void> {
  const row = matchToRow(match);
  await runOrQueue(expectedUserId, { kind: 'match.save_case', match: row, caseId: safeId(caseId) as string }, (userId) =>
    supabase.rpc('save_match_with_case', { p_expected_owner_id: userId, p_match: row, p_case_id: safeId(caseId) }));
}

export async function assignMatchReferral(referral: Referral, match: ReferralMatch, expectedUserId: string): Promise<void> {
  const referralRow = referralToRow(referral);
  const matchRow = matchToRow(match);
  await runOrQueue(expectedUserId, { kind: 'referral.assign_match', referral: referralRow, match: matchRow }, (userId) =>
    supabase.rpc('assign_match_referral', { p_expected_owner_id: userId, p_referral: referralRow, p_match: matchRow }));
}

// The placement record follows the assignment write (never precedes it): if
// the assignment is rejected the record is not attempted, and offline both
// queue FIFO so the referral lands first.
export async function recordPlacementDecision(decision: PlacementDecision, expectedUserId: string): Promise<void> {
  const row = placementToRow(decision);
  await runOrQueue(expectedUserId, { kind: 'placement.insert', row }, (userId) =>
    // Append-only on the server (insert + select policies): a retried op
    // that already landed is a no-op, never an update.
    supabase.from('placement_decisions').upsert({ ...row, owner_id: userId }, { onConflict: 'id', ignoreDuplicates: true }));
}

export async function finalizeMatchPacket(
  referral: Referral,
  match: ReferralMatch | null,
  touch: Touch,
  followUp: FollowUp,
  event: PacketCaseEvent | null,
  expectedUserId: string,
): Promise<void> {
  const op: QueueOp = {
    kind: 'packet.finalize', referral: referralToRow(referral), match: match ? matchToRow(match) : null,
    touch: touchToRow(touch), followUp: followUpToRow(followUp), event: event ? packetEventToRow(event) : null,
  };
  await runOrQueue(expectedUserId, op, (userId) => supabase.rpc('finalize_match_packet', {
    p_expected_owner_id: userId, p_referral: op.referral, p_match: op.match,
    p_touch: op.touch, p_follow_up: op.followUp, p_event: op.event,
  }));
}

export async function logContactActivity(
  event: PacketCaseEvent | null,
  touch: Touch | null,
  expectedUserId: string,
): Promise<void> {
  if (!event && !touch) throw new StoreError('A case event or partner touch is required.', false);
  const op: QueueOp = {
    kind: 'contact.log_activity',
    event: event ? packetEventToRow(event) : null,
    touch: touch ? touchToRow(touch) : null,
  };
  await runOrQueue(expectedUserId, op, (userId) => supabase.rpc('log_contact_activity', {
    p_expected_owner_id: userId, p_event: op.event, p_touch: op.touch,
  }));
}

// A follow-up text or email that was sent, or a call that was logged, from
// the outreach sheet: closes the step it came from (if any), logs the case
// event and/or partner touch, and creates the next step — one atomic,
// replay-safe write (record_outreach_sent).
export async function recordOutreachSent(
  completedId: string | null,
  next: FollowUp,
  event: PacketCaseEvent | null,
  touch: Touch | null,
  expectedUserId: string,
): Promise<void> {
  if (!event && !touch) throw new StoreError('A case event or partner touch is required.', false);
  const op: QueueOp = {
    kind: 'outreach.sent',
    completedId: completedId ? safeId(completedId) as string : null,
    next: followUpToRow(next),
    event: event ? packetEventToRow(event) : null,
    touch: touch ? touchToRow(touch) : null,
  };
  await runOrQueue(expectedUserId, op, (userId) => supabase.rpc('record_outreach_sent', {
    p_expected_owner_id: userId, p_completed_id: op.completedId, p_next: op.next, p_event: op.event, p_touch: op.touch,
  }));
}

export async function createFollowUp(followUp: FollowUp, expectedUserId: string): Promise<void> {
  const row = followUpToRow(followUp);
  await runOrQueue(expectedUserId, { kind: 'follow_up.insert', row }, (userId) => supabase.from('follow_ups').insert({ ...row, owner_id: userId }));
}

export async function updateFollowUp(followUp: FollowUp, expectedUserId: string): Promise<void> {
  const row = followUpToRow(followUp);
  const safeFollowUpId = safeId(followUp.id) as string;
  const before = await savedRow(expectedUserId, (snapshot) => snapshot.followUps.find((item) => safeId(item.id) === safeFollowUpId));
  const patch = changedColumns(withoutId(row), before ? withoutId(followUpToRow(before)) : null);
  if (!Object.keys(patch).length) return; // nothing changed since the saved copy
  await runOrQueue(expectedUserId, { kind: 'follow_up.update', id: safeFollowUpId, patch }, (_userId, orgId) =>
    supabase.from('follow_ups').update(patch).eq('id', safeFollowUpId).eq('org_id', orgId));
}

export async function completeFollowUpWithNext(
  completed: FollowUp,
  next: FollowUp,
  event: { id: string; caseId: string; kind: string; body: string; occurredAt: string } | null,
  expectedUserId: string,
): Promise<void> {
  const completedRow = followUpToRow(completed);
  const nextRow = followUpToRow(next);
  const eventRow = event ? {
    id: event.id,
    case_id: event.caseId,
    kind: event.kind,
    body: event.body,
    occurred_at: event.occurredAt,
  } : null;
  await runOrQueue(
    expectedUserId,
    { kind: 'follow_up.complete_next', completed: completedRow, next: nextRow, event: eventRow },
    () => supabase.rpc('complete_follow_up_with_next', { p_completed: completedRow, p_next: nextRow, p_event: eventRow }),
  );
}

export async function completeFollowUpWithOutcome(
  completed: FollowUp,
  referralId: string,
  outcome: ReferralOutcomePatch,
  expectedUserId: string,
): Promise<void> {
  const completedRow = followUpToRow(completed);
  const safeReferralId = safeId(referralId) as string;
  const outcomeRow = referralOutcomePatchToRow(outcome);
  await runOrQueue(
    expectedUserId,
    { kind: 'follow_up.complete_outcome', completed: completedRow, referralId: safeReferralId, outcome: outcomeRow },
    () => supabase.rpc('complete_follow_up_with_outcome', {
      p_completed: completedRow,
      p_referral_id: safeReferralId,
      p_outcome: outcomeRow,
    }),
  );
}

// Outcomes loop: one server path (record_placement_outcome) for the admit
// question and for every check-in. It updates the referral, optionally
// completes the follow-up that prompted it, and creates the 7 / 30 / 90 day
// check-ins once when the referral is an admission. Queued offline like any
// other write; the check-ins themselves arrive on the next refresh.
export async function recordPlacementOutcome(
  referralId: string,
  outcome: ReferralOutcomePatch,
  completed: FollowUp | null,
  expectedUserId: string,
): Promise<void> {
  const safeReferralId = safeId(referralId) as string;
  const outcomeRow = referralOutcomePatchToRow(outcome);
  const completedRow = completed ? followUpToRow(completed) : null;
  await runOrQueue(
    expectedUserId,
    { kind: 'referral.record_outcome', referralId: safeReferralId, outcome: outcomeRow, completed: completedRow },
    () => supabase.rpc('record_placement_outcome', {
      p_referral_id: safeReferralId,
      p_outcome: outcomeRow,
      p_completed: completedRow,
    }),
  );
}

// Partial update of the v2 outcome columns on a referral.
export async function updateReferralOutcome(id: string, patch: ReferralOutcomePatch, expectedUserId: string): Promise<void> {
  const row = referralOutcomePatchToRow(patch);
  const safeReferralId = safeId(id) as string;
  await runOrQueue(expectedUserId, { kind: 'referral.update', id: safeReferralId, patch: row }, (_userId, orgId) =>
    supabase.from('referrals').update(row).eq('id', safeReferralId).eq('org_id', orgId));
}

export async function updateReferralPacketStamp(
  id: string,
  packetSentAt: string,
  matchProfileId: string,
  expectedUserId: string,
): Promise<void> {
  const patch = { packet_sent_at: packetSentAt, match_profile_id: safeId(matchProfileId) };
  const safeReferralId = safeId(id) as string;
  await runOrQueue(expectedUserId, { kind: 'referral.update', id: safeReferralId, patch }, (_userId, orgId) =>
    supabase.from('referrals').update(patch).eq('id', safeReferralId).eq('org_id', orgId));
}

// Attach (or detach) a case on a match profile.
export async function updateMatchCase(id: string, caseId: string | null, expectedUserId: string): Promise<void> {
  const patch = { case_id: safeId(caseId) };
  const safeMatchId = safeId(id) as string;
  await runOrQueue(expectedUserId, { kind: 'match.update', id: safeMatchId, patch }, (_userId, orgId) =>
    supabase.from('match_profiles').update(patch).eq('id', safeMatchId).eq('org_id', orgId));
}

// Re-hydrate from the server and durably update this account's cache. Returns
// null only for an actual network failure (or a session known to be offline);
// persistence/session failures surface.
export async function refreshSnapshot(expectedUserId: string): Promise<Snapshot | null> {
  const fence = await sessionFence(expectedUserId);
  if (fence.offline) return null;
  try {
    const remote = await fetchSnapshot();
    await assertSessionFence(fence);
    return await withCacheLock(async () => {
      await assertSessionFence(fence);
      const latestLocal = await readCacheUnlocked(fence);
      const pending = await readPendingRows(fence);
      const merged = await mergeUnsyncedLocal(remote, latestLocal, pending);
      await assertSessionFence(fence);
      await writeCacheUnlocked(fence, merged.snapshot);
      await assertSessionFence(fence);
      return merged.snapshot;
    });
  } catch (error) {
    if (error instanceof StoreError) throw error;
    if (isNetworkError(error)) return null;
    throw asStoreError(error);
  }
}

// ─── Saved copies of case data ──────────────────────────────────────────────
// Cases are NOT part of the Snapshot and never pass through mergeUnsyncedLocal:
// case writes go straight to the server (cases.ts), so a cached case row can
// never be an unsynced local insert, and nothing here is ever re-uploaded.
// These copies are read-only fallbacks for an offline launch or a case file
// opened with no signal. They live under the same account key and workspace
// binding as the snapshot cache and are wiped with it.
//
// Layout: one blob for the case list + every contact (always complete), one
// small index of saved files (oldest first, bounded, see case-cache.ts) and
// one blob per saved case file so a timeline edit rewrites one case, not all.

function caseFileStorageKey(userId: string, caseId: string): string {
  if (!isUuid(caseId)) throw new StoreError('Cannot save a case file without a valid case ID.', false);
  return `${accountStorageKey(CASE_FILE_KEY_PREFIX, userId)}:${caseId.toLowerCase()}`;
}

// Every key the case cache owns for one account, including any saved file
// the index has lost track of, so a workspace change removes them all.
async function caseCacheKeys(userId: string): Promise<string[]> {
  const filePrefix = `${accountStorageKey(CASE_FILE_KEY_PREFIX, userId)}:`;
  let allKeys: readonly string[];
  try {
    allKeys = await AsyncStorage.getAllKeys();
  } catch (error) {
    throw persistenceError('cache', error);
  }
  return [
    accountStorageKey(CASE_LIST_KEY_PREFIX, userId),
    accountStorageKey(CASE_FILE_INDEX_KEY_PREFIX, userId),
    ...allKeys.filter((key) => key.startsWith(filePrefix)),
  ];
}

async function readJsonUnlocked(key: string): Promise<unknown> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(key);
  } catch (error) {
    throw persistenceError('cache', error);
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // A corrupt saved copy holds no unsynced work; it is simply replaced by
    // the next successful read from the server.
    return null;
  }
}

async function readCaseListCacheUnlocked(fence: SessionFence): Promise<CachedCaseList | null> {
  return parseCachedCaseList(await readJsonUnlocked(accountStorageKey(CASE_LIST_KEY_PREFIX, fence.userId)), fence.userId);
}

async function writeCaseListCacheUnlocked(fence: SessionFence, list: CaseList, savedAt: string): Promise<void> {
  try {
    await AsyncStorage.setItem(accountStorageKey(CASE_LIST_KEY_PREFIX, fence.userId), JSON.stringify(makeCaseListEnvelope(fence.userId, list, savedAt)));
  } catch (error) {
    throw persistenceError('cache', error);
  }
}

async function readCaseFileCacheUnlocked(fence: SessionFence, caseId: string): Promise<CachedCaseFile | null> {
  return parseCachedCaseFile(await readJsonUnlocked(caseFileStorageKey(fence.userId, caseId)), fence.userId, caseId);
}

async function writeCaseFileCacheUnlocked(fence: SessionFence, caseId: string, file: CaseFile, savedAt: string): Promise<void> {
  const indexKey = accountStorageKey(CASE_FILE_INDEX_KEY_PREFIX, fence.userId);
  const index = touchCaseFileIndex(parseCaseFileIndex(await readJsonUnlocked(indexKey), fence.userId), caseId.toLowerCase(), savedAt);
  try {
    await AsyncStorage.multiSet([
      [caseFileStorageKey(fence.userId, caseId), JSON.stringify(makeCaseFileEnvelope(fence.userId, caseId, file, savedAt))],
      [indexKey, JSON.stringify(makeCaseFileIndexEnvelope(fence.userId, index.entries))],
    ]);
    if (index.evicted.length) await AsyncStorage.multiRemove(index.evicted.map((evictedId) => caseFileStorageKey(fence.userId, evictedId)));
  } catch (error) {
    throw persistenceError('cache', error);
  }
}

export type CaseListLoad = { list: CaseList; source: 'remote' | 'cache'; savedAt: string };
export type CaseFileLoad = { file: CaseFile; source: 'remote' | 'cache'; savedAt: string; truncated: boolean };

// The case list and every contact: from the server when it can be reached,
// otherwise the saved copy. Throws only when neither is available, or for a
// genuine server/session error. Persisting is the caller's job (persistCaseList)
// so the saved copy also follows in-memory edits that landed online.
export async function loadCaseList(expectedUserId: string): Promise<CaseListLoad> {
  const fence = await sessionFence(expectedUserId);
  let remote: CaseList;
  try {
    if (fence.offline) throw offlineError(); // straight to the saved copy
    remote = await fetchCaseList();
  } catch (error) {
    if (!isNetworkError(error)) throw error;
    await assertSessionFence(fence);
    const cached = await withCacheLock(async () => {
      await assertSessionFence(fence);
      const copy = await readCaseListCacheUnlocked(fence);
      await assertSessionFence(fence);
      return copy;
    });
    if (!cached) throw error;
    return { list: cached.list, source: 'cache', savedAt: cached.savedAt };
  }
  await assertSessionFence(fence);
  return { list: remote, source: 'remote', savedAt: new Date().toISOString() };
}

// One case file's timeline and document metadata, same fallback rules.
export async function loadCaseFile(expectedUserId: string, caseId: string): Promise<CaseFileLoad> {
  const fence = await sessionFence(expectedUserId);
  let remote: CaseFile;
  try {
    if (fence.offline) throw offlineError(); // straight to the saved copy
    remote = await fetchCaseFile(caseId);
  } catch (error) {
    if (!isNetworkError(error)) throw error;
    await assertSessionFence(fence);
    const cached = await withCacheLock(async () => {
      await assertSessionFence(fence);
      const copy = await readCaseFileCacheUnlocked(fence, caseId);
      await assertSessionFence(fence);
      return copy;
    });
    if (!cached) throw error;
    return { file: cached.file, source: 'cache', savedAt: cached.savedAt, truncated: cached.truncated };
  }
  await assertSessionFence(fence);
  return { file: remote, source: 'remote', savedAt: new Date().toISOString(), truncated: false };
}

// Save the in-memory case list (server-loaded or edited online) as the
// offline copy for this account. Never called with a cache-sourced list.
// Same fence as persistCache: the server, when it can be reached, must still
// agree on the bound workspace, so a copy is never written under a binding
// that has moved on.
export async function persistCaseList(list: CaseList, expectedUserId: string): Promise<void> {
  await withCacheLock(async () => {
    const fence = await sessionFence(expectedUserId);
    await assertCacheWorkspaceFence(fence);
    await writeCaseListCacheUnlocked(fence, list, new Date().toISOString());
    await assertCacheWorkspaceFence(fence);
  });
}

// Save one open case file the same way. Bounded and LRU-evicted in
// writeCaseFileCacheUnlocked.
export async function persistCaseFile(caseId: string, file: CaseFile, expectedUserId: string): Promise<void> {
  await withCacheLock(async () => {
    const fence = await sessionFence(expectedUserId);
    await assertCacheWorkspaceFence(fence);
    await writeCaseFileCacheUnlocked(fence, caseId, file, new Date().toISOString());
    await assertCacheWorkspaceFence(fence);
  });
}
