import AsyncStorage from '@react-native-async-storage/async-storage';

import { newUuid } from './cases';
import { currentAuthSessionIdentity } from './auth-session';
import { StoreError } from './errors';
import { supabase } from './supabase';
import type {
  InsuranceNetworkPreference,
  Partner,
  PartnerType,
  Referral,
  ReferralMatch,
} from '../data';

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
export type FollowUpKind = 'follow_up' | 'first_call' | 'promised_call' | 'waiting_on' | 'consult' | 'touch';

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
};

export type PartnerScorecard = {
  partnerId: string;
  referralsSent: number;
  admits: number;
  nonAdmits: number;
  avgFamilyExperience: number | null;
  lastReferralOn: string | null; // YYYY-MM-DD
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

export type HydrateResult = {
  snapshot: Snapshot;
  source: 'remote' | 'cache';
};

// ─── AsyncStorage keys ──────────────────────────────────────────────────────

// The old v1 keys were global to the device. They are intentionally never read:
// there is no trustworthy owner metadata with which to assign their contents to
// an authenticated account. Leaving them quarantined is safer than leaking one
// user's cached data or queued writes into another account.
const CACHE_KEY_PREFIX = 'referralfit-cache-v2:';
const QUEUE_KEY_PREFIX = 'referralfit-write-queue-v2:';

function accountStorageKey(prefix: string, userId: string): string {
  if (!isUuid(userId)) throw new StoreError('Cannot use offline storage without a valid account ID.', false);
  return `${prefix}${userId.toLowerCase()}`;
}

// ─── Error classification ───────────────────────────────────────────────────

function isNetworkError(error: unknown): boolean {
  if (!error) return false;
  const anyError = error as { name?: string; message?: string; status?: number; code?: string };
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

export { StoreError } from './errors';

type SessionFence = { userId: string; sessionId: string };

async function sessionFence(expectedUserId?: string): Promise<SessionFence> {
  const identity = await currentAuthSessionIdentity();
  if (!identity || !isUuid(identity.userId)) throw new StoreError('You must be signed in to use offline data.', false);
  if (expectedUserId && expectedUserId.toLowerCase() !== identity.userId) {
    throw new StoreError('The signed-in account changed. Retry this action for the current account.', false);
  }
  return identity;
}

async function assertSessionFence(fence: SessionFence, queued = false): Promise<void> {
  const current = await sessionFence(fence.userId);
  if (current.sessionId !== fence.sessionId) {
    throw new StoreError('The signed-in session changed while saving. Retry for the current account.', queued);
  }
}

function persistenceError(area: 'cache' | 'offline queue', error: unknown): StoreError {
  const detail = error instanceof Error && error.message ? `: ${error.message}` : '';
  return new StoreError(`Could not durably save the ${area}${detail}`, false);
}

// ─── Offline write queue (account-scoped, serialized FIFO) ──────────────────

type QueueOp =
  | { kind: 'partner.insert'; row: Record<string, unknown> }
  | { kind: 'partner.update'; id: string; patch: Record<string, unknown> }
  | { kind: 'referral.insert'; row: Record<string, unknown> }
  | { kind: 'match.insert'; row: Record<string, unknown> }
  | { kind: 'match.update'; id: string; patch: Record<string, unknown> }
  | { kind: 'touch.insert'; row: Record<string, unknown> }
  | { kind: 'follow_up.insert'; row: Record<string, unknown> }
  | { kind: 'follow_up.update'; id: string; patch: Record<string, unknown> }
  | { kind: 'follow_up.complete_next'; completed: Record<string, unknown>; next: Record<string, unknown>; event: Record<string, unknown> | null }
  | { kind: 'follow_up.complete_outcome'; completed: Record<string, unknown>; referralId: string; outcome: Record<string, unknown> }
  | { kind: 'match.save_case'; match: Record<string, unknown>; caseId: string }
  | { kind: 'referral.assign_match'; referral: Record<string, unknown>; match: Record<string, unknown> }
  | { kind: 'packet.finalize'; referral: Record<string, unknown>; match: Record<string, unknown> | null; touch: Record<string, unknown>; followUp: Record<string, unknown>; event: Record<string, unknown> | null }
  | { kind: 'contact.log_activity'; event: Record<string, unknown> | null; touch: Record<string, unknown> | null }
  | { kind: 'referral.update'; id: string; patch: Record<string, unknown> };

type QueueEnvelope = { version: 2; userId: string; ops: QueueOp[] };
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
  const op = value as { kind?: unknown; row?: unknown; id?: unknown; patch?: unknown; completed?: unknown; next?: unknown; event?: unknown; referralId?: unknown; outcome?: unknown; referral?: unknown; match?: unknown; caseId?: unknown; touch?: unknown; followUp?: unknown };
  const insertKinds = ['partner.insert', 'referral.insert', 'match.insert', 'touch.insert', 'follow_up.insert'];
  const updateKinds = ['partner.update', 'match.update', 'follow_up.update', 'referral.update'];
  if (typeof op.kind !== 'string') return false;
  if (insertKinds.includes(op.kind)) return Boolean(op.row && typeof op.row === 'object');
  if (op.kind === 'follow_up.complete_next') {
    return Boolean(op.completed && typeof op.completed === 'object' && op.next && typeof op.next === 'object'
      && (op.event === null || (op.event && typeof op.event === 'object')));
  }
  if (op.kind === 'follow_up.complete_outcome') {
    return Boolean(op.completed && typeof op.completed === 'object' && typeof op.referralId === 'string' && op.outcome && typeof op.outcome === 'object');
  }
  if (op.kind === 'match.save_case') return Boolean(op.match && typeof op.match === 'object' && typeof op.caseId === 'string');
  if (op.kind === 'referral.assign_match') return Boolean(op.referral && typeof op.referral === 'object' && op.match && typeof op.match === 'object');
  if (op.kind === 'packet.finalize') return Boolean(op.referral && typeof op.referral === 'object' && op.touch && typeof op.touch === 'object'
    && op.followUp && typeof op.followUp === 'object' && (op.match === null || (op.match && typeof op.match === 'object'))
    && (op.event === null || (op.event && typeof op.event === 'object')));
  if (op.kind === 'contact.log_activity') return Boolean(
    (op.event === null || (op.event && typeof op.event === 'object'))
    && (op.touch === null || (op.touch && typeof op.touch === 'object'))
    && (op.event !== null || op.touch !== null));
  return updateKinds.includes(op.kind) && typeof op.id === 'string' && Boolean(op.patch && typeof op.patch === 'object');
}

async function readQueueUnlocked(userId: string): Promise<QueueOp[]> {
  const key = accountStorageKey(QUEUE_KEY_PREFIX, userId);
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(key);
  } catch (error) {
    throw persistenceError('offline queue', error);
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Partial<QueueEnvelope>;
    if (parsed.version !== 2 || parsed.userId?.toLowerCase() !== userId || !Array.isArray(parsed.ops) || !parsed.ops.every(isQueueOp)) {
      throw new Error('stored queue failed account or format validation');
    }
    return parsed.ops;
  } catch (error) {
    throw persistenceError('offline queue', error);
  }
}

async function writeQueueUnlocked(userId: string, ops: QueueOp[]): Promise<void> {
  const envelope: QueueEnvelope = { version: 2, userId, ops };
  try {
    await AsyncStorage.setItem(accountStorageKey(QUEUE_KEY_PREFIX, userId), JSON.stringify(envelope));
  } catch (error) {
    throw persistenceError('offline queue', error);
  }
}

async function enqueueOp(fence: SessionFence, op: QueueOp): Promise<void> {
  await withQueueLock(async () => {
    await assertSessionFence(fence);
    const ops = await readQueueUnlocked(fence.userId);
    await assertSessionFence(fence);
    await writeQueueUnlocked(fence.userId, [...ops, bindQueueOp(op, fence.userId)]);
    await assertSessionFence(fence, true);
  });
}

async function enqueueOps(fence: SessionFence, additions: QueueOp[]): Promise<void> {
  if (!additions.length) return;
  await withQueueLock(async () => {
    await assertSessionFence(fence);
    const ops = await readQueueUnlocked(fence.userId);
    await assertSessionFence(fence);
    const existing = new Set(ops.map((op) => JSON.stringify(op)));
    const uniqueAdditions = additions.map((op) => bindQueueOp(op, fence.userId)).filter((op) => {
      const serialized = JSON.stringify(op);
      if (existing.has(serialized)) return false;
      existing.add(serialized);
      return true;
    });
    if (uniqueAdditions.length) await writeQueueUnlocked(fence.userId, [...ops, ...uniqueAdditions]);
    await assertSessionFence(fence, uniqueAdditions.length > 0);
  });
}

function bindQueueOp(op: QueueOp, userId: string): QueueOp {
  if ('row' in op) return { ...op, row: { ...op.row, owner_id: userId } } as QueueOp;
  return op;
}

async function applyQueueOp(op: QueueOp, userId: string): Promise<void> {
  let error: { message: string } | null = null;
  switch (op.kind) {
    case 'partner.insert':
      ({ error } = await supabase.from('partners').upsert({ ...op.row, owner_id: userId }));
      break;
    case 'partner.update':
      ({ error } = await supabase.from('partners').update(op.patch).eq('id', op.id).eq('owner_id', userId));
      break;
    case 'referral.insert':
      ({ error } = await supabase.from('referrals').upsert({ ...op.row, owner_id: userId }));
      break;
    case 'match.insert':
      ({ error } = await supabase.from('match_profiles').upsert({ ...op.row, owner_id: userId }));
      break;
    case 'match.update':
      ({ error } = await supabase.from('match_profiles').update(op.patch).eq('id', op.id).eq('owner_id', userId));
      break;
    case 'touch.insert':
      ({ error } = await supabase.from('touches').upsert({ ...op.row, owner_id: userId }, { onConflict: 'id' }));
      break;
    case 'follow_up.insert':
      ({ error } = await supabase.from('follow_ups').upsert({ ...op.row, owner_id: userId }));
      break;
    case 'follow_up.update':
      ({ error } = await supabase.from('follow_ups').update(op.patch).eq('id', op.id).eq('owner_id', userId));
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
    case 'referral.update':
      ({ error } = await supabase.from('referrals').update(op.patch).eq('id', op.id).eq('owner_id', userId));
      break;
  }
  if (error) throw error;
}

// Flush queued mutations FIFO. Stops at the first network failure (we are still
// offline); throws for genuine server-side errors while retaining the rejected
// op on disk. Returns the number of ops that were applied.
// A foreign-key violation usually means the parent row (partner/referral/case)
// simply has not been inserted yet — its own op may sit later in the queue, or
// it failed on a previous pass. Those ops must be retried, never dropped, or a
// referral whose partner failed once is lost forever.
function isMissingParentError(error: unknown): boolean {
  const err = error as { code?: string; message?: string } | null;
  const code = err?.code ?? '';
  const message = err?.message ?? '';
  return code === '23503' || /foreign key constraint/i.test(message);
}

export async function flushWriteQueue(expectedUserId: string): Promise<number> {
  const fence = await sessionFence(expectedUserId);
  return withQueueLock(async () => {
    await assertSessionFence(fence);
    let flushed = 0;
    let ops = await readQueueUnlocked(fence.userId);
    const deferred: QueueOp[] = [];

    while (ops.length) {
      const [head, ...rest] = ops;
      try {
        await applyQueueOp(head, fence.userId);
        flushed += 1;
      } catch (error) {
        if (isNetworkError(error)) return flushed; // queue on disk is unchanged
        if (isMissingParentError(error)) {
          deferred.push(head);
        } else {
          // Never claim a rejected write disappeared successfully. Keep the
          // exact operation durable and surface the rejection so the UI can
          // tell the user rather than silently losing data.
          await writeQueueUnlocked(fence.userId, [head, ...rest, ...deferred]);
          const message = error instanceof Error ? error.message : String(error);
          throw new StoreError(`A queued change was rejected by the server and remains pending: ${message}`, true);
        }
      }
      await assertSessionFence(fence);
      ops = rest;
      await writeQueueUnlocked(fence.userId, [...ops, ...deferred]);
      await assertSessionFence(fence);
    }

    // Retry children whose parents appeared later in the FIFO.
    const retry = [...deferred];
    const retained: QueueOp[] = [];
    for (let index = 0; index < retry.length; index += 1) {
      const op = retry[index];
      try {
        await applyQueueOp(op, fence.userId);
        flushed += 1;
      } catch (error) {
        if (isNetworkError(error) || isMissingParentError(error)) {
          retained.push(op);
        } else {
          await writeQueueUnlocked(fence.userId, [...retained, op, ...retry.slice(index + 1)]);
          const message = error instanceof Error ? error.message : String(error);
          throw new StoreError(`A queued dependent change was rejected and remains pending: ${message}`, true);
        }
      }
      await assertSessionFence(fence);
      await writeQueueUnlocked(fence.userId, [...retained, ...retry.slice(index + 1)]);
      await assertSessionFence(fence);
    }
    return flushed;
  });
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
  insurance_networks: Record<string, InsuranceNetworkPreference[]> | null;
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
};

type ScorecardRow = {
  partner_id: string;
  referrals_sent: number | string | null;
  admits: number | string | null;
  non_admits: number | string | null;
  avg_family_experience: number | string | null;
  last_referral_on: string | null;
};

function toNumber(value: number | string | null | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toDateStamp(iso: string | null | undefined, fallback: string): string {
  return iso ? iso.slice(0, 10) : fallback;
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
    insuranceNetworks: row.insurance_networks && Object.keys(row.insurance_networks).length
      ? row.insurance_networks
      : Object.fromEntries((row.insurance || []).filter((plan) => plan !== 'Cash pay').map((plan) => [plan, ['In-network' as InsuranceNetworkPreference]])),
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
  };
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
  };
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
    status: match.status,
    assigned_partner_id: safeId(match.assignedPartnerId),
    referral_id: safeId(match.referralId),
    case_id: safeId(match.caseId),
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

// Merge rows that exist only in this account's local cache into a freshly
// fetched server snapshot. The caller durably queues all missing inserts before
// publishing the merged cache, so there is no fire-and-forget data-loss window.
function mergeUnsyncedLocal(remote: Snapshot, local: Snapshot | null): { snapshot: Snapshot; ops: QueueOp[] } {
  if (!local) return { snapshot: remote, ops: [] };
  const merge = <T extends { id: string }>(r: T[], l: T[]): { rows: T[]; missing: T[] } => {
    const have = new Set(r.map((x) => x.id));
    const missing = l.filter((x) => x.id && !have.has(x.id));
    return { rows: [...r, ...missing], missing };
  };
  const partners = merge(remote.partners, local.partners);
  const referrals = merge(remote.referrals, local.referrals);
  const matches = merge(remote.referralMatches, local.referralMatches);
  const touches = merge(remote.touches, local.touches);
  const followUps = merge(remote.followUps, local.followUps);
  const referralRows = referrals.missing.map((row) => referralToRow(row));
  const matchRows = matches.missing.map((row) => matchToRow(row));
  const ops: QueueOp[] = [
    ...partners.missing.map((row): QueueOp => ({ kind: 'partner.insert', row: partnerToRow(row) })),
    // A referral and match profile can point at each other. Insert both bases
    // with the cyclic columns cleared, then restore those links only after both
    // parents exist. This keeps recovery queues parent-before-child.
    ...referralRows.map((row): QueueOp => ({ kind: 'referral.insert', row: { ...row, match_profile_id: null } })),
    ...matchRows.map((row): QueueOp => ({ kind: 'match.insert', row: { ...row, referral_id: null } })),
    ...referralRows.filter((row) => row.match_profile_id).map((row): QueueOp => ({
      kind: 'referral.update', id: row.id as string, patch: { match_profile_id: row.match_profile_id },
    })),
    ...matchRows.filter((row) => row.referral_id).map((row): QueueOp => ({
      kind: 'match.update', id: row.id as string, patch: { referral_id: row.referral_id },
    })),
    ...touches.missing.map((row): QueueOp => ({ kind: 'touch.insert', row: touchToRow(row) })),
    ...followUps.missing.map((row): QueueOp => ({ kind: 'follow_up.insert', row: followUpToRow(row) })),
  ];
  return {
    snapshot: {
      partners: partners.rows,
      referrals: referrals.rows,
      referralMatches: matches.rows,
      touches: touches.rows,
      followUps: followUps.rows,
      scorecards: remote.scorecards,
    },
    ops,
  };
}

// ─── Read path ──────────────────────────────────────────────────────────────

async function fetchSnapshot(): Promise<Snapshot> {
  const [partnersRes, referralsRes, matchesRes, touchesRes, balancesRes, followUpsRes, scorecardsRes] = await Promise.all([
    supabase.from('partners').select('*').order('created_at', { ascending: false }),
    supabase.from('referrals').select('*').order('referred_on', { ascending: false }),
    supabase.from('match_profiles').select('*').order('updated_at', { ascending: false }),
    supabase.from('touches').select('*').order('occurred_at', { ascending: false }),
    supabase.from('partner_balances').select('partner_id, inbound, outbound'),
    supabase.from('follow_ups').select('*').order('due_on', { ascending: true }),
    supabase.from('partner_scorecard').select('partner_id, referrals_sent, admits, non_admits, avg_family_experience, last_referral_on'),
  ]);
  const firstError = partnersRes.error || referralsRes.error || matchesRes.error || touchesRes.error || balancesRes.error || followUpsRes.error || scorecardsRes.error;
  if (firstError) throw firstError;

  const balanceByPartner = new Map<string, BalanceRow>();
  for (const row of (balancesRes.data || []) as BalanceRow[]) balanceByPartner.set(row.partner_id, row);

  const scorecards: Record<string, PartnerScorecard> = {};
  for (const row of (scorecardsRes.data || []) as ScorecardRow[]) {
    scorecards[row.partner_id] = mapScorecardRow(row);
  }

  return {
    partners: ((partnersRes.data || []) as PartnerRow[]).map((row) => mapPartnerRow(row, balanceByPartner.get(row.id))),
    referrals: ((referralsRes.data || []) as ReferralRow[]).map(mapReferralRow),
    referralMatches: ((matchesRes.data || []) as MatchRow[]).map(mapMatchRow),
    touches: ((touchesRes.data || []) as TouchRow[]).map(mapTouchRow),
    followUps: ((followUpsRes.data || []) as FollowUpRow[]).map(mapFollowUpRow),
    scorecards,
  };
}

// Hydrate app state for one authenticated account. Remote is the source of
// truth; network failure falls back only to that account's validated v2 cache.
// Legacy global blobs remain quarantined because their owner cannot be proven.
export async function hydrate(expectedUserId: string): Promise<HydrateResult> {
  const fence = await sessionFence(expectedUserId);
  try {
    const cachedBefore = await readCache(fence);
    if (cachedBefore) {
      const { snapshot: fixed, repaired } = repairSnapshotIds(cachedBefore);
      if (repaired > 0) await writeCache(fence, fixed);
    }

    await flushWriteQueue(fence.userId);
    await assertSessionFence(fence);
    const remote = await fetchSnapshot();
    await assertSessionFence(fence);

    const merged = await withCacheLock(async () => {
      await assertSessionFence(fence);
      const latestLocal = await readCacheUnlocked(fence);
      const result = mergeUnsyncedLocal(remote, latestLocal);
      // Queue persistence happens first: the cache must never claim an unsynced
      // local row is safe until its retry operation is durable.
      await enqueueOps(fence, result.ops);
      await writeCacheUnlocked(fence, result.snapshot);
      await assertSessionFence(fence);
      return result.snapshot;
    });
    return { snapshot: merged, source: 'remote' };
  } catch (error) {
    if (error instanceof StoreError) throw error;
    await assertSessionFence(fence);
    const cached = await readCache(fence);
    if (cached) return { snapshot: cached, source: 'cache' };
    if (isNetworkError(error)) {
      return { snapshot: { partners: [], referrals: [], referralMatches: [], touches: [], followUps: [], scorecards: {} }, source: 'cache' };
    }
    throw error;
  }
}

// Refresh the account-scoped offline cache from the latest in-memory state.
export async function persistCache(snapshot: Snapshot, expectedUserId: string): Promise<void> {
  // Acquire the cache lock before resolving the session so concurrent persists
  // commit in call order rather than getSession() completion order.
  await withCacheLock(async () => {
    const fence = await sessionFence(expectedUserId);
    await assertSessionFence(fence);
    await writeCacheUnlocked(fence, snapshot);
    await assertSessionFence(fence);
  });
}

// ─── Write path ─────────────────────────────────────────────────────────────
// Every mutator: caller applies the optimistic local update first, then calls
// the mutator. Network failures queue the op and resolve quietly (the local
// state is already correct); server failures raise StoreError so the caller
// can surface a message.

// supabase-js query builders are thenables (PromiseLike), not real Promises.
async function runOrQueue(
  expectedUserId: string,
  op: QueueOp,
  execute: (userId: string) => PromiseLike<{ error: { message: string } | null }>,
): Promise<void> {
  const fence = await sessionFence(expectedUserId);
  let result: { error: { message: string } | null };
  try {
    result = await execute(fence.userId);
  } catch (error) {
    if (!isNetworkError(error)) throw error;
    await assertSessionFence(fence);
    await enqueueOp(fence, op);
    return;
  }
  await assertSessionFence(fence);
  if (!result.error) return;
  if (isNetworkError(result.error)) {
    await enqueueOp(fence, op);
    return;
  }
  throw new StoreError(result.error.message, false);
}

export async function createPartner(partner: Partner, expectedUserId: string): Promise<void> {
  const row = partnerToRow(partner);
  await runOrQueue(expectedUserId, { kind: 'partner.insert', row }, (userId) => supabase.from('partners').insert({ ...row, owner_id: userId }));
}

export async function updatePartner(partner: Partner, expectedUserId: string): Promise<void> {
  const row = partnerToRow(partner);
  const { id, ...patch } = row;
  await runOrQueue(expectedUserId, { kind: 'partner.update', id: safeId(partner.id) as string, patch }, (userId) =>
    supabase.from('partners').update(patch).eq('id', safeId(partner.id)).eq('owner_id', userId));
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
  const { id, ...patch } = row;
  const safeMatchId = safeId(match.id) as string;
  await runOrQueue(expectedUserId, { kind: 'match.update', id: safeMatchId, patch }, (userId) =>
    supabase.from('match_profiles').update(patch).eq('id', safeMatchId).eq('owner_id', userId));
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

export async function createFollowUp(followUp: FollowUp, expectedUserId: string): Promise<void> {
  const row = followUpToRow(followUp);
  await runOrQueue(expectedUserId, { kind: 'follow_up.insert', row }, (userId) => supabase.from('follow_ups').insert({ ...row, owner_id: userId }));
}

export async function updateFollowUp(followUp: FollowUp, expectedUserId: string): Promise<void> {
  const row = followUpToRow(followUp);
  const { id, ...patch } = row;
  const safeFollowUpId = safeId(followUp.id) as string;
  await runOrQueue(expectedUserId, { kind: 'follow_up.update', id: safeFollowUpId, patch }, (userId) =>
    supabase.from('follow_ups').update(patch).eq('id', safeFollowUpId).eq('owner_id', userId));
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

// Partial update of the v2 outcome columns on a referral.
export async function updateReferralOutcome(id: string, patch: ReferralOutcomePatch, expectedUserId: string): Promise<void> {
  const row = referralOutcomePatchToRow(patch);
  const safeReferralId = safeId(id) as string;
  await runOrQueue(expectedUserId, { kind: 'referral.update', id: safeReferralId, patch: row }, (userId) =>
    supabase.from('referrals').update(row).eq('id', safeReferralId).eq('owner_id', userId));
}

export async function updateReferralPacketStamp(
  id: string,
  packetSentAt: string,
  matchProfileId: string,
  expectedUserId: string,
): Promise<void> {
  const patch = { packet_sent_at: packetSentAt, match_profile_id: safeId(matchProfileId) };
  const safeReferralId = safeId(id) as string;
  await runOrQueue(expectedUserId, { kind: 'referral.update', id: safeReferralId, patch }, (userId) =>
    supabase.from('referrals').update(patch).eq('id', safeReferralId).eq('owner_id', userId));
}

// Attach (or detach) a case on a match profile.
export async function updateMatchCase(id: string, caseId: string | null, expectedUserId: string): Promise<void> {
  const patch = { case_id: safeId(caseId) };
  const safeMatchId = safeId(id) as string;
  await runOrQueue(expectedUserId, { kind: 'match.update', id: safeMatchId, patch }, (userId) =>
    supabase.from('match_profiles').update(patch).eq('id', safeMatchId).eq('owner_id', userId));
}

// Re-hydrate from the server and durably update this account's cache. Returns
// null only for an actual network failure; persistence/session failures surface.
export async function refreshSnapshot(expectedUserId: string): Promise<Snapshot | null> {
  const fence = await sessionFence(expectedUserId);
  try {
    const remote = await fetchSnapshot();
    await assertSessionFence(fence);
    return await withCacheLock(async () => {
      await assertSessionFence(fence);
      const latestLocal = await readCacheUnlocked(fence);
      const merged = mergeUnsyncedLocal(remote, latestLocal);
      await enqueueOps(fence, merged.ops);
      await writeCacheUnlocked(fence, merged.snapshot);
      await assertSessionFence(fence);
      return merged.snapshot;
    });
  } catch (error) {
    if (error instanceof StoreError) throw error;
    if (isNetworkError(error)) return null;
    throw error;
  }
}
