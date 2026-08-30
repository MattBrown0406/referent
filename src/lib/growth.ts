import type { Partner, Referral } from '../data';
import type { CaseRecord } from './cases';
import { currentAuthSessionIdentity, type AuthSessionIdentity } from './auth-session';
import { recommendRelationshipActions, type RelationshipRecommendation } from './intelligence';
import type { FollowUp, PartnerScorecard, Touch } from './store';
import { supabase } from './supabase';

export type ReferralSource = {
  id: string;
  partnerId?: string;
  label: string;
  publicPracticeDisplay: string;
  publicSourceDisplay: string;
  active: boolean;
  submissionCount: number;
  createdAt: string;
  updatedAt: string;
};

export type HandoffStatus =
  | 'sent'
  | 'received'
  | 'contact_attempted'
  | 'family_reached'
  | 'consult_scheduled'
  | 'closed';

export type ReferralHandoff = {
  id: string;
  referralId: string;
  caseId?: string;
  partnerId: string;
  clientAlias: string;
  recipientDisplay: string;
  recipientEmail: string;
  status: HandoffStatus;
  version: number;
  dueOn?: string;
  revokedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateReferralSourceInput = {
  partnerId?: string;
  label: string;
  publicPracticeDisplay: string;
  publicSourceDisplay: string;
};

export type CreateHandoffInput = {
  referralId: string;
  caseId?: string;
  partnerId: string;
  clientAlias: string;
  recipientDisplay: string;
  recipientEmail?: string;
};

export type CreatedHandoff = {
  handoffId: string;
  url: string;
  status: HandoffStatus;
  version: number;
};

export class GrowthError extends Error {
  readonly offline: boolean;
  readonly conflict: boolean;

  constructor(message: string, options: { offline?: boolean; conflict?: boolean } = {}) {
    super(message);
    this.name = 'GrowthError';
    this.offline = Boolean(options.offline);
    this.conflict = Boolean(options.conflict);
  }
}

type ReferralSourceRow = {
  id: string;
  partner_id: string | null;
  label: string;
  public_practice_display: string;
  public_source_display: string;
  active: boolean;
  submission_count: number | string;
  created_at: string;
  updated_at: string;
};

type ReferralHandoffRow = {
  id: string;
  referral_id: string;
  case_id: string | null;
  partner_id: string;
  client_alias: string;
  recipient_display: string;
  recipient_email: string | null;
  status: HandoffStatus;
  version: number;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
};

type HandoffReminderRow = {
  referral_handoff_id: string | null;
  due_on: string;
  status: string;
};

const HANDOFF_NEXT: Partial<Record<HandoffStatus, HandoffStatus>> = {
  sent: 'received',
  received: 'contact_attempted',
  contact_attempted: 'family_reached',
  family_reached: 'consult_scheduled',
  consult_scheduled: 'closed',
};

function isNetworkError(error: unknown): boolean {
  const value = error as { message?: unknown; status?: unknown; code?: unknown } | null;
  if (typeof value?.status === 'number' || (typeof value?.code === 'string' && /^[0-9A-Z]{5}$/.test(value.code))) {
    return false;
  }
  const message = String(value?.message || error || '').toLowerCase();
  return ['network request failed', 'failed to fetch', 'fetch failed', 'networkerror', 'offline', 'internet', 'timeout', 'econnrefused']
    .some((part) => message.includes(part));
}

function normalizeError(error: unknown, fallback: string): GrowthError {
  if (error instanceof GrowthError) return error;
  const value = error as { message?: unknown; code?: unknown } | null;
  const message = typeof value?.message === 'string' && value.message.trim() ? value.message : fallback;
  const conflict = value?.code === '40001' || /version conflict/i.test(message);
  return new GrowthError(
    conflict ? 'This handoff changed elsewhere. The latest status has been loaded.' : message,
    { conflict, offline: isNetworkError(error) },
  );
}

async function accountFence(): Promise<AuthSessionIdentity> {
  const identity = await currentAuthSessionIdentity();
  if (!identity) throw new GrowthError('Sign in again to manage referral growth.', { offline: false });
  return identity;
}

async function assertFence(expected: AuthSessionIdentity): Promise<void> {
  const current = await currentAuthSessionIdentity();
  if (!current || current.userId !== expected.userId || current.sessionId !== expected.sessionId) {
    throw new GrowthError('The signed-in account changed. Reopen Referral Growth and try again.');
  }
}

async function withStableAccount<T>(work: (identity: AuthSessionIdentity) => Promise<T>): Promise<T> {
  const identity = await accountFence();
  try {
    const result = await work(identity);
    await assertFence(identity);
    return result;
  } catch (error) {
    await assertFence(identity);
    throw normalizeError(error, 'Referral Growth could not reach the server.');
  }
}

function cleanRequired(value: string, label: string, maxLength: number): string {
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > maxLength) {
    throw new GrowthError(`${label} must be between 1 and ${maxLength} characters.`);
  }
  return cleaned;
}

function publicLabel(value: string, label: string): string {
  const cleaned = cleanRequired(value, label, 120);
  if (/[^\s@]+@[^\s@]+|(?:\+?\d[\d ().-]{6,}\d)/.test(cleaned)) {
    throw new GrowthError(`${label} cannot contain contact or client information.`);
  }
  return cleaned;
}

function mapSource(row: ReferralSourceRow): ReferralSource {
  return {
    id: row.id,
    partnerId: row.partner_id || undefined,
    label: row.label,
    publicPracticeDisplay: row.public_practice_display,
    publicSourceDisplay: row.public_source_display,
    active: row.active,
    submissionCount: Math.max(0, Number(row.submission_count) || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapHandoff(row: ReferralHandoffRow, dueOn?: string): ReferralHandoff {
  return {
    id: row.id,
    referralId: row.referral_id,
    caseId: row.case_id || undefined,
    partnerId: row.partner_id,
    clientAlias: row.client_alias,
    recipientDisplay: row.recipient_display,
    recipientEmail: row.recipient_email || '',
    status: row.status,
    version: row.version,
    dueOn,
    revokedAt: row.revoked_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The portal origin is deployment configuration, never inferred from API URLs. */
export function referralPortalBase(): string | null {
  const configured = process.env.EXPO_PUBLIC_REFERRAL_PORTAL_URL?.trim();
  if (!configured) return null;
  try {
    const parsed = new URL(configured);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return configured.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function referralSourceUrl(sourceId: string): string | null {
  const base = referralPortalBase();
  return base ? `${base}/r/${sourceId}` : null;
}

function handoffUrl(token: string): string {
  const base = referralPortalBase();
  if (!base) throw new GrowthError('Set EXPO_PUBLIC_REFERRAL_PORTAL_URL to create and share handoffs.');
  return `${base}/h/${token}`;
}

export function nextHandoffStatus(status: HandoffStatus): HandoffStatus | null {
  return HANDOFF_NEXT[status] || null;
}

export async function fetchReferralGrowth(): Promise<{ sources: ReferralSource[]; handoffs: ReferralHandoff[] }> {
  return withStableAccount(async () => {
    const [sourcesResult, handoffsResult, remindersResult] = await Promise.all([
      supabase.from('referral_sources').select('*').order('created_at', { ascending: false }),
      supabase.from('referral_handoffs').select('*').order('updated_at', { ascending: false }),
      supabase.from('follow_ups')
        .select('referral_handoff_id,due_on,status')
        .eq('kind', 'referral_handshake')
        .eq('status', 'open'),
    ]);
    const error = sourcesResult.error || handoffsResult.error || remindersResult.error;
    if (error) throw error;
    const dueByHandoff = new Map<string, string>();
    for (const reminder of (remindersResult.data || []) as HandoffReminderRow[]) {
      if (reminder.referral_handoff_id && reminder.status === 'open') {
        dueByHandoff.set(reminder.referral_handoff_id, reminder.due_on);
      }
    }
    return {
      sources: ((sourcesResult.data || []) as ReferralSourceRow[]).map(mapSource),
      handoffs: ((handoffsResult.data || []) as ReferralHandoffRow[])
        .map((row) => mapHandoff(row, dueByHandoff.get(row.id))),
    };
  });
}

export async function createReferralSource(input: CreateReferralSourceInput): Promise<ReferralSource> {
  return withStableAccount(async (identity) => {
    const row = {
      owner_id: identity.userId,
      partner_id: input.partnerId || null,
      label: publicLabel(input.label, 'Internal link label'),
      public_practice_display: publicLabel(input.publicPracticeDisplay, 'Practice display'),
      public_source_display: publicLabel(input.publicSourceDisplay, 'Source display'),
      active: true,
    };
    const { data, error } = await supabase.from('referral_sources').insert(row).select('*').single();
    if (error) throw error;
    return mapSource(data as ReferralSourceRow);
  });
}

export async function setReferralSourceActive(sourceId: string, active: boolean): Promise<ReferralSource> {
  return withStableAccount(async () => {
    const { data, error } = await supabase.from('referral_sources')
      .update({ active })
      .eq('id', sourceId)
      .select('*')
      .single();
    if (error) throw error;
    return mapSource(data as ReferralSourceRow);
  });
}

export async function createReferralHandoff(input: CreateHandoffInput): Promise<CreatedHandoff> {
  // Refuse before the RPC: a token cannot be recovered if portal configuration is missing.
  if (!referralPortalBase()) throw new GrowthError('Set EXPO_PUBLIC_REFERRAL_PORTAL_URL to create and share handoffs.');
  const alias = cleanRequired(input.clientAlias, 'Private alias', 32);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(alias)) {
    throw new GrowthError('Use a private alias with letters, numbers, periods, underscores, or hyphens — never a full name.');
  }
  return withStableAccount(async () => {
    const { data, error } = await supabase.rpc('create_referral_handoff', {
      p_referral_id: input.referralId,
      p_case_id: input.caseId || null,
      p_partner_id: input.partnerId,
      p_client_alias: alias,
      p_recipient_display: publicLabel(input.recipientDisplay, 'Recipient display'),
      p_recipient_email: input.recipientEmail?.trim().toLowerCase() || '',
    });
    if (error) throw error;
    const row = (Array.isArray(data) ? data[0] : data) as {
      handoff_id?: unknown;
      token?: unknown;
      status?: unknown;
      version?: unknown;
    } | null;
    if (!row || typeof row.handoff_id !== 'string' || typeof row.token !== 'string'
      || typeof row.status !== 'string' || typeof row.version !== 'number') {
      throw new GrowthError('The handoff was created, but its one-time link could not be read. Revoke it from the refreshed list.');
    }
    return {
      handoffId: row.handoff_id,
      url: handoffUrl(row.token),
      status: row.status as HandoffStatus,
      version: row.version,
    };
  });
}

export async function transitionReferralHandoff(
  handoffId: string,
  expectedVersion: number,
  status: HandoffStatus,
): Promise<{ status: HandoffStatus; version: number }> {
  return withStableAccount(async () => {
    const { data, error } = await supabase.rpc('transition_referral_handoff', {
      p_handoff_id: handoffId,
      p_expected_version: expectedVersion,
      p_next_status: status,
    });
    if (error) throw error;
    const row = (Array.isArray(data) ? data[0] : data) as { status?: unknown; version?: unknown } | null;
    if (!row || typeof row.status !== 'string' || typeof row.version !== 'number') {
      throw new GrowthError('The handoff changed, but its confirmed status could not be read. Refresh before continuing.');
    }
    return { status: row.status as HandoffStatus, version: row.version };
  });
}

export async function revokeReferralHandoff(handoffId: string): Promise<void> {
  await withStableAccount(async () => {
    const { error } = await supabase.rpc('revoke_referral_handoff', { p_handoff_id: handoffId });
    if (error) throw error;
  });
}

export function buildRelationshipRecommendations(input: {
  asOf: string;
  partners: Partner[];
  referrals: Referral[];
  touches: Touch[];
  followUps: FollowUp[];
  scorecards: Record<string, PartnerScorecard>;
  cases: CaseRecord[];
}): RelationshipRecommendation[] {
  return recommendRelationshipActions(input).slice(0, 5);
}
