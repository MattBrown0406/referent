import AsyncStorage from '@react-native-async-storage/async-storage';

import { newUuid } from './cases';
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

export type HydrateResult = {
  snapshot: Snapshot;
  source: 'remote' | 'cache';
};

// ─── AsyncStorage keys ──────────────────────────────────────────────────────

const CACHE_KEY = 'referralfit-cache-v1';
const QUEUE_KEY = 'referralfit-write-queue-v1';
const LEGACY_STORAGE_KEY = 'referralfit-v2';

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

export class StoreError extends Error {
  queued: boolean;
  constructor(message: string, queued: boolean) {
    super(message);
    this.queued = queued;
  }
}

// ─── Offline write queue (simple FIFO, last-write-wins) ─────────────────────

type QueueOp =
  | { kind: 'partner.insert'; row: Record<string, unknown> }
  | { kind: 'partner.update'; id: string; patch: Record<string, unknown> }
  | { kind: 'referral.insert'; row: Record<string, unknown> }
  | { kind: 'match.insert'; row: Record<string, unknown> }
  | { kind: 'match.update'; id: string; patch: Record<string, unknown> }
  | { kind: 'touch.insert'; row: Record<string, unknown> }
  | { kind: 'follow_up.insert'; row: Record<string, unknown> }
  | { kind: 'follow_up.update'; id: string; patch: Record<string, unknown> }
  | { kind: 'referral.update'; id: string; patch: Record<string, unknown> };

async function readQueue(): Promise<QueueOp[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueueOp[]) : [];
  } catch {
    return [];
  }
}

async function writeQueue(ops: QueueOp[]): Promise<void> {
  try {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(ops));
  } catch {
    // Nothing else we can do; avoid crashing the UI over a cache write.
  }
}

async function enqueueOp(op: QueueOp): Promise<void> {
  const ops = await readQueue();
  ops.push(op);
  await writeQueue(ops);
}

async function applyQueueOp(op: QueueOp): Promise<void> {
  let error: { message: string } | null = null;
  switch (op.kind) {
    case 'partner.insert':
      ({ error } = await supabase.from('partners').upsert(op.row));
      break;
    case 'partner.update':
      ({ error } = await supabase.from('partners').update(op.patch).eq('id', op.id));
      break;
    case 'referral.insert':
      ({ error } = await supabase.from('referrals').upsert(op.row));
      break;
    case 'match.insert':
      ({ error } = await supabase.from('match_profiles').upsert(op.row));
      break;
    case 'match.update':
      ({ error } = await supabase.from('match_profiles').update(op.patch).eq('id', op.id));
      break;
    case 'touch.insert':
      ({ error } = await supabase.from('touches').insert(op.row));
      break;
    case 'follow_up.insert':
      ({ error } = await supabase.from('follow_ups').upsert(op.row));
      break;
    case 'follow_up.update':
      ({ error } = await supabase.from('follow_ups').update(op.patch).eq('id', op.id));
      break;
    case 'referral.update':
      ({ error } = await supabase.from('referrals').update(op.patch).eq('id', op.id));
      break;
  }
  if (error) throw error;
}

// Flush queued mutations FIFO. Stops at the first network failure (we are still
// offline); throws only for genuine server-side errors so the caller can drop
// the poisoned op. Returns the number of ops that were applied.
export async function flushWriteQueue(): Promise<number> {
  let flushed = 0;
  let ops = await readQueue();
  while (ops.length) {
    const [head, ...rest] = ops;
    try {
      await applyQueueOp(head);
    } catch (error) {
      if (isNetworkError(error)) break; // still offline — keep the queue as-is
      // Server rejected the op (constraint, RLS, ...). Drop it rather than
      // blocking the whole queue forever, and keep flushing the rest.
    }
    ops = rest;
    flushed += 1;
    await writeQueue(ops);
  }
  return flushed;
}

export async function pendingWriteCount(): Promise<number> {
  return (await readQueue()).length;
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
    id: partner.id,
    name: partner.name,
    organization: partner.organization,
    types,
    city: partner.city,
    state: partner.state,
    regions: partner.regions,
    phone: partner.phone,
    email: partner.email,
    website: partner.website || null,
    cash_min: partner.cashMin,
    cash_max: partner.cashMax,
    insurance: partner.insurance,
    therapies: partner.therapies,
    populations: partner.populations,
    levels: partner.levels,
    note: partner.note,
    favorite: Boolean(partner.favorite),
    touch_cadence_days: partner.touchCadenceDays ?? null,
  };
}

function referralToRow(referral: Referral): Record<string, unknown> {
  return {
    id: referral.id,
    partner_id: referral.partnerId,
    direction: referral.direction === 'Inbound' ? 'inbound' : 'outbound',
    referred_on: referral.date,
    client_label: referral.clientLabel,
    outcome: referral.outcome,
    note: referral.note,
    // v2 columns (deployed migration 20260724150000) — packet + outcome data
    packet_sent_at: referral.packetSentAt ?? null,
    match_profile_id: referral.matchProfileId ?? null,
    case_id: referral.caseId ?? null,
    admitted: referral.admitted ?? null,
    admitted_on: referral.admittedOn ?? null,
    family_experience: referral.familyExperience ?? null,
    outcome_note: referral.outcomeNote ?? '',
  };
}

function matchToRow(match: ReferralMatch): Record<string, unknown> {
  return {
    id: match.id,
    client_label: match.clientLabel,
    level_of_care: match.levelOfCare,
    state: match.state,
    insurance: match.insurance,
    network_preferences: match.networkPreferences || [],
    max_budget: match.maxBudget ?? null,
    therapies: match.therapies,
    status: match.status,
    assigned_partner_id: match.assignedPartnerId ?? null,
    referral_id: match.referralId ?? null,
    case_id: match.caseId ?? null,
  };
}

function touchToRow(touch: Touch): Record<string, unknown> {
  return {
    id: touch.id,
    partner_id: touch.partnerId,
    kind: touch.kind,
    note: touch.note,
    occurred_at: touch.occurredAt,
  };
}

function followUpToRow(followUp: FollowUp): Record<string, unknown> {
  return {
    id: followUp.id,
    partner_id: followUp.partnerId ?? null,
    referral_id: followUp.referralId ?? null,
    case_id: followUp.caseId ?? null,
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

async function writeCache(snapshot: Snapshot): Promise<void> {
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(snapshot));
  } catch {
    // Cache is best-effort.
  }
}

async function readCache(): Promise<Snapshot | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.partners)) return null;
    return {
      partners: parsed.partners as Partner[],
      referrals: Array.isArray(parsed.referrals) ? parsed.referrals : [],
      referralMatches: Array.isArray(parsed.referralMatches) ? parsed.referralMatches : [],
      touches: Array.isArray(parsed.touches) ? parsed.touches : [],
      followUps: Array.isArray(parsed.followUps) ? parsed.followUps : [],
      scorecards: parsed.scorecards && typeof parsed.scorecards === 'object' ? parsed.scorecards : {},
    };
  } catch {
    return null;
  }
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

function repairSnapshotIds(snapshot: Snapshot): { snapshot: Snapshot; repaired: number } {
  const remap = new Map<string, string>();
  const idFor = (old: string | undefined | null): string | undefined => {
    if (!old) return old ?? undefined;
    if (isUuid(old)) return old;
    let next = remap.get(old);
    if (!next) {
      next = newUuid();
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

// Same treatment for anything already sitting in the write queue.
async function repairWriteQueueIds(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    if (!raw) return 0;
    const text = raw;
    const bad = new Set<string>();
    // ids look like p-<digits>-<alnum> / r- / m- / t- / f- / c- / cc- / e-
    const re = /"((?:p|r|m|t|f|c|cc|e)-\d{10,}-[a-z0-9]{4,})"/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) bad.add(match[1]);
    if (!bad.size) return 0;
    let patched = text;
    bad.forEach((oldId) => {
      patched = patched.split(`"${oldId}"`).join(`"${newUuid()}"`);
    });
    await AsyncStorage.setItem(QUEUE_KEY, patched);
    return bad.size;
  } catch {
    return 0;
  }
}

// One-shot import of the pre-Supabase AsyncStorage blob so existing installs
// keep their data. Returns null when there is nothing worth importing.
async function readLegacySnapshot(): Promise<Snapshot | null> {
  try {
    const raw = await AsyncStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw);
    const partners = Array.isArray(stored.partners) ? stored.partners as Partner[] : [];
    const referrals = Array.isArray(stored.referrals) ? stored.referrals as Referral[] : [];
    const referralMatches = Array.isArray(stored.referralMatches) ? stored.referralMatches as ReferralMatch[] : [];
    if (!partners.length && !referrals.length && !referralMatches.length) return null;
    return { partners, referrals, referralMatches, touches: [], followUps: [], scorecards: {} };
  } catch {
    return null;
  }
}

async function importLegacySnapshot(legacy: Snapshot): Promise<void> {
  // Order matters: partners first (referrals/matches reference them), then
  // referrals, then matches (referral_id FK).
  if (legacy.partners.length) {
    const { error } = await supabase.from('partners').upsert(legacy.partners.map(partnerToRow));
    if (error) throw error;
  }
  if (legacy.referrals.length) {
    const { error } = await supabase.from('referrals').upsert(legacy.referrals.map(referralToRow));
    if (error) throw error;
  }
  if (legacy.referralMatches.length) {
    const { error } = await supabase.from('match_profiles').upsert(legacy.referralMatches.map(matchToRow));
    if (error) throw error;
  }
  await AsyncStorage.removeItem(LEGACY_STORAGE_KEY).catch(() => undefined);
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

// Hydrate app state. Remote is the source of truth; on any failure the
// AsyncStorage cache is used and the caller shows the offline indicator.
// Also flushes any queued offline writes before reading (so the read reflects
// them), and imports the legacy AsyncStorage blob on first authenticated run.
export async function hydrate(): Promise<HydrateResult> {
  try {
    // Heal ids written by builds <= 1.0.0(8) BEFORE anything is sent upstream,
    // otherwise the same rows keep failing with "invalid input syntax for type
    // uuid" forever (both the queued op and the cached row).
    await repairWriteQueueIds();
    const cachedBefore = await readCache();
    if (cachedBefore) {
      const { snapshot: fixed, repaired } = repairSnapshotIds(cachedBefore);
      if (repaired > 0) {
        await writeCache(fixed);
        // Push the repaired rows up so the server gets the records that were
        // stranded locally (upsert — safe if some already exist).
        try {
          await importLegacySnapshot(fixed);
        } catch (error) {
          if (!isNetworkError(error)) console.warn('[store] repaired-id upsert failed');
        }
      }
    }
    await flushWriteQueue();
    const legacy = await readLegacySnapshot();
    if (legacy) {
      try {
        await importLegacySnapshot(legacy);
      } catch (error) {
        // If the import cannot reach the server, keep going with the legacy
        // data as this session's cache rather than showing an empty app.
        if (isNetworkError(error)) {
          await writeCache(legacy);
          return { snapshot: legacy, source: 'cache' };
        }
        console.warn('[store] legacy import failed');
      }
    }
    const snapshot = await fetchSnapshot();
    await writeCache(snapshot);
    return { snapshot, source: 'remote' };
  } catch (error) {
    const cached = await readCache();
    if (cached) return { snapshot: cached, source: 'cache' };
    if (isNetworkError(error)) {
      return { snapshot: { partners: [], referrals: [], referralMatches: [], touches: [], followUps: [], scorecards: {} }, source: 'cache' };
    }
    throw error;
  }
}

// Refresh the offline cache from the latest in-memory state (called after
// every local write, whether it synced or queued).
export async function persistCache(snapshot: Snapshot): Promise<void> {
  await writeCache(snapshot);
}

// ─── Write path ─────────────────────────────────────────────────────────────
// Every mutator: caller applies the optimistic local update first, then calls
// the mutator. Network failures queue the op and resolve quietly (the local
// state is already correct); server failures raise StoreError so the caller
// can surface a message.

// supabase-js query builders are thenables (PromiseLike), not real Promises.
async function runOrQueue(op: QueueOp, execute: () => PromiseLike<{ error: { message: string } | null }>): Promise<void> {
  const { error } = await execute();
  if (!error) return;
  if (isNetworkError(error)) {
    await enqueueOp(op);
    return;
  }
  throw new StoreError(error.message, false);
}

export async function createPartner(partner: Partner): Promise<void> {
  const row = partnerToRow(partner);
  await runOrQueue({ kind: 'partner.insert', row }, () => supabase.from('partners').insert(row));
}

export async function updatePartner(partner: Partner): Promise<void> {
  const row = partnerToRow(partner);
  const { id, ...patch } = row;
  await runOrQueue({ kind: 'partner.update', id: partner.id, patch }, () =>
    supabase.from('partners').update(patch).eq('id', partner.id));
}

export async function createReferral(referral: Referral): Promise<void> {
  const row = referralToRow(referral);
  await runOrQueue({ kind: 'referral.insert', row }, () => supabase.from('referrals').insert(row));
}

export async function createMatchProfile(match: ReferralMatch): Promise<void> {
  const row = matchToRow(match);
  await runOrQueue({ kind: 'match.insert', row }, () => supabase.from('match_profiles').insert(row));
}

export async function updateMatchProfile(match: ReferralMatch): Promise<void> {
  const row = matchToRow(match);
  const { id, ...patch } = row;
  await runOrQueue({ kind: 'match.update', id: match.id, patch }, () =>
    supabase.from('match_profiles').update(patch).eq('id', match.id));
}

export async function createTouch(touch: Touch): Promise<void> {
  const row = touchToRow(touch);
  await runOrQueue({ kind: 'touch.insert', row }, () => supabase.from('touches').insert(row));
}

// Assignment flow: create the outbound referral first, then point the match
// profile at it. Not a real transaction over PostgREST — if the second write
// fails it is queued and will land on the next flush.
export async function assignMatchReferral(referral: Referral, match: ReferralMatch): Promise<void> {
  await createReferral(referral);
  await updateMatchProfile(match);
}

export async function createFollowUp(followUp: FollowUp): Promise<void> {
  const row = followUpToRow(followUp);
  await runOrQueue({ kind: 'follow_up.insert', row }, () => supabase.from('follow_ups').insert(row));
}

export async function updateFollowUp(followUp: FollowUp): Promise<void> {
  const row = followUpToRow(followUp);
  const { id, ...patch } = row;
  await runOrQueue({ kind: 'follow_up.update', id: followUp.id, patch }, () =>
    supabase.from('follow_ups').update(patch).eq('id', followUp.id));
}

// Partial update of the v2 outcome columns on a referral (admitted,
// family_experience, outcome_note, outcome). Kept separate from
// createReferral so the caller never has to round-trip the whole row.
export async function updateReferralOutcome(id: string, patch: ReferralOutcomePatch): Promise<void> {
  const row = referralOutcomePatchToRow(patch);
  await runOrQueue({ kind: 'referral.update', id, patch: row }, () =>
    supabase.from('referrals').update(row).eq('id', id));
}

// Stamp packet_sent_at (and match_profile_id when it isn't set yet) onto an
// existing referral — used when a packet is sent for an already-assigned
// match, where no new referral row is created.
export async function updateReferralPacketStamp(id: string, packetSentAt: string, matchProfileId: string): Promise<void> {
  const patch = { packet_sent_at: packetSentAt, match_profile_id: matchProfileId };
  await runOrQueue({ kind: 'referral.update', id, patch }, () =>
    supabase.from('referrals').update(patch).eq('id', id));
}

// Attach (or detach) a case on a match profile — a narrow patch used by the
// case detail's "Find placement" flow; caseId null detaches.
export async function updateMatchCase(id: string, caseId: string | null): Promise<void> {
  const patch = { case_id: caseId };
  await runOrQueue({ kind: 'match.update', id, patch }, () =>
    supabase.from('match_profiles').update(patch).eq('id', id));
}

// Re-hydrate from the server (used after flushing the offline queue so local
// state converges back to the source of truth). Returns null offline.
export async function refreshSnapshot(): Promise<Snapshot | null> {
  try {
    const snapshot = await fetchSnapshot();
    await writeCache(snapshot);
    return snapshot;
  } catch {
    return null;
  }
}
