import type { Referral } from '../data';
import type { CaseRecord, CaseStatus } from './cases';
import { StoreError } from './errors';
import { currentAuthSessionIdentity } from './auth-session';
import { supabase } from './supabase';

export const LEAD_SOURCES = [
  'Unspecified',
  'Professional referral',
  'Former client or family',
  'Website',
  'Inbound call',
  'Social media',
  'Community event',
  'Other',
] as const;

export type LeadSource = (typeof LEAD_SOURCES)[number] | string;
export type BusinessPeriod = 30 | 90 | 365 | 'all';
export type IntegrationProvider = 'square' | 'pandadoc';
export type IntegrationRecordType = 'customer' | 'invoice' | 'payment' | 'refund' | 'document';

export type CaseStageHistory = {
  id: string;
  caseId: string;
  status: CaseStatus;
  enteredAt: string;
  exitedAt?: string;
};

export type CaseIntegration = {
  id: string;
  caseId: string;
  provider: IntegrationProvider;
  recordType: IntegrationRecordType;
  externalId: string;
  status: string;
  amountCents: number | null;
  paidAmountCents: number | null;
  currency: string;
  dueOn?: string;
  completedAt?: string;
  externalUrl: string;
  metadata: Record<string, unknown>;
  lastSyncedAt?: string;
  updatedAt: string;
};

export type BusinessData = {
  stages: CaseStageHistory[];
  integrations: CaseIntegration[];
};

export type LeadSourceMetric = {
  source: string;
  cases: number;
  placed: number;
  quoted: number;
  collected: number;
};

export type FunnelMetric = {
  key: 'inquiry' | 'consult' | 'engaged' | 'placed';
  label: string;
  value: number;
  rate: number;
};

export type BusinessDashboardMetrics = {
  casesCreated: number;
  activeCases: number;
  quotedRevenue: number;
  collectedRevenue: number;
  outstandingRevenue: number;
  placedCases: number;
  lostCases: number;
  placementRate: number;
  outboundReferrals: number;
  outboundPlaced: number;
  referralPlacementRate: number;
  averageDaysToEngaged: number | null;
  funnel: FunnelMetric[];
  sources: LeadSourceMetric[];
  pendingContracts: number;
  openInvoices: number;
  overdueInvoices: number;
};

type StageRow = {
  id: string;
  case_id: string;
  status: CaseStatus;
  entered_at: string;
  exited_at: string | null;
};

type IntegrationRow = {
  id: string;
  case_id: string;
  provider: IntegrationProvider;
  record_type: IntegrationRecordType;
  external_id: string;
  status: string;
  amount_cents: number | string | null;
  paid_amount_cents: number | string | null;
  currency: string;
  due_on: string | null;
  completed_at: string | null;
  external_url: string;
  metadata: Record<string, unknown> | null;
  last_synced_at: string | null;
  updated_at: string;
};

function mapStage(row: StageRow): CaseStageHistory {
  return {
    id: row.id,
    caseId: row.case_id,
    status: row.status,
    enteredAt: row.entered_at,
    exitedAt: row.exited_at || undefined,
  };
}

function mapIntegration(row: IntegrationRow): CaseIntegration {
  return {
    id: row.id,
    caseId: row.case_id,
    provider: row.provider,
    recordType: row.record_type,
    externalId: row.external_id,
    status: row.status || 'linked',
    amountCents: row.amount_cents == null ? null : Number(row.amount_cents),
    paidAmountCents: row.paid_amount_cents == null ? null : Number(row.paid_amount_cents),
    currency: row.currency || 'USD',
    dueOn: row.due_on || undefined,
    completedAt: row.completed_at || undefined,
    externalUrl: row.external_url || '',
    metadata: row.metadata || {},
    lastSyncedAt: row.last_synced_at || undefined,
    updatedAt: row.updated_at,
  };
}

async function currentAccountId(): Promise<string> {
  const identity = await currentAuthSessionIdentity();
  if (!identity) throw new StoreError('Sign in before loading business data.', false);
  return identity.userId;
}

export async function fetchBusinessData(): Promise<BusinessData> {
  const userId = await currentAccountId();
  const [stagesResult, integrationsResult] = await Promise.all([
    supabase.from('case_stage_history').select('*').eq('owner_id', userId).order('entered_at', { ascending: true }),
    supabase.from('case_integrations').select('*').eq('owner_id', userId).order('updated_at', { ascending: false }),
  ]);
  const firstError = stagesResult.error || integrationsResult.error;
  if (firstError) throw new StoreError(firstError.message, false);
  return {
    stages: ((stagesResult.data || []) as StageRow[]).map(mapStage),
    integrations: ((integrationsResult.data || []) as IntegrationRow[]).map(mapIntegration),
  };
}

export type IntegrationInput = Omit<CaseIntegration, 'id' | 'updatedAt' | 'metadata' | 'paidAmountCents'> & {
  id?: string;
  metadata?: Record<string, unknown>;
  paidAmountCents?: number | null;
};

export async function saveCaseIntegration(input: IntegrationInput): Promise<CaseIntegration> {
  const userId = await currentAccountId();
  const row = {
    ...(input.id ? { id: input.id } : {}),
    owner_id: userId,
    case_id: input.caseId,
    provider: input.provider,
    record_type: input.recordType,
    external_id: input.externalId.trim(),
    status: input.status.trim() || 'linked',
    amount_cents: input.amountCents,
    currency: input.currency.trim().toUpperCase() || 'USD',
    due_on: input.dueOn || null,
    external_url: input.externalUrl.trim(),
    ...(input.paidAmountCents !== undefined ? { paid_amount_cents: input.paidAmountCents } : {}),
    ...(input.completedAt !== undefined ? { completed_at: input.completedAt || null } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };
  const { data, error } = await supabase
    .from('case_integrations')
    .upsert(row, { onConflict: 'owner_id,provider,record_type,external_id' })
    .select('*')
    .single();
  if (error || !data) throw new StoreError(error?.message || 'The external record could not be linked.', false);
  return mapIntegration(data as IntegrationRow);
}

export async function deleteCaseIntegration(id: string): Promise<void> {
  const userId = await currentAccountId();
  const { error } = await supabase.from('case_integrations').delete().eq('id', id).eq('owner_id', userId);
  if (error) throw new StoreError(error.message, false);
}

function periodStart(period: BusinessPeriod, now: Date): number {
  if (period === 'all') return Number.NEGATIVE_INFINITY;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (period - 1));
  return start.getTime();
}

const terminalDocumentStatuses = new Set([
  'document.completed', 'document.paid', 'document.declined', 'document.voided',
  'completed', 'paid', 'declined', 'voided',
]);
const terminalInvoiceStatuses = new Set(['paid', 'canceled', 'cancelled', 'refunded']);

type CaseRevenue = { quoted: number; collected: number; outstanding: number };

function revenueForCase(record: CaseRecord, integrations: CaseIntegration[]): CaseRevenue {
  const squareInvoices = integrations.filter((item) => item.caseId === record.id
    && item.provider === 'square' && item.recordType === 'invoice' && item.amountCents != null);
  if (!squareInvoices.length) {
    const quoted = record.quotedAmount || 0;
    return {
      quoted,
      collected: record.paidAmount,
      outstanding: Math.max(quoted - record.paidAmount, 0),
    };
  }

  return squareInvoices.reduce<CaseRevenue>((totals, invoice) => {
    const status = invoice.status.toLowerCase();
    const quoted = (invoice.amountCents || 0) / 100;
    const reversed = ['canceled', 'cancelled', 'refunded'].includes(status);
    const collected = reversed ? 0 : (invoice.paidAmountCents == null
      ? (status === 'paid' ? quoted : 0)
      : Math.min(invoice.paidAmountCents / 100, quoted));
    totals.quoted += quoted;
    totals.collected += collected;
    totals.outstanding += terminalInvoiceStatuses.has(status) ? 0 : Math.max(quoted - collected, 0);
    return totals;
  }, { quoted: 0, collected: 0, outstanding: 0 });
}

function hasReached(
  record: CaseRecord,
  stages: CaseStageHistory[],
  target: 'consult' | 'engaged' | 'placed',
): boolean {
  const reached = new Set(stages.filter((item) => item.caseId === record.id).map((item) => item.status));
  reached.add(record.status);
  if (target === 'consult') {
    return [...reached].some((status) => ['consult', 'deciding', 'engaged', 'intervention', 'placed', 'aftercare'].includes(status));
  }
  if (target === 'engaged') {
    return [...reached].some((status) => ['engaged', 'intervention', 'placed', 'aftercare'].includes(status));
  }
  return reached.has('placed') || reached.has('aftercare');
}

function localDateStamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function computeBusinessDashboard(
  cases: CaseRecord[],
  referrals: Referral[],
  data: BusinessData,
  period: BusinessPeriod,
  now = new Date(),
): BusinessDashboardMetrics {
  const start = periodStart(period, now);
  const scopedCases = cases.filter((record) => new Date(record.createdAt).getTime() >= start);
  const scopedIds = new Set(scopedCases.map((record) => record.id));
  const scopedStages = data.stages.filter((item) => scopedIds.has(item.caseId));
  const consulted = scopedCases.filter((record) => hasReached(record, scopedStages, 'consult')).length;
  const engaged = scopedCases.filter((record) => hasReached(record, scopedStages, 'engaged')).length;
  const placed = scopedCases.filter((record) => hasReached(record, scopedStages, 'placed')).length;
  const base = scopedCases.length || 1;
  const scopedIntegrations = data.integrations.filter((item) => scopedIds.has(item.caseId));
  const revenueByCase = new Map(scopedCases.map((record) => [record.id, revenueForCase(record, scopedIntegrations)]));

  const sourceMap = new Map<string, LeadSourceMetric>();
  for (const record of scopedCases) {
    const source = record.leadSource?.trim() || 'Unspecified';
    const metric = sourceMap.get(source) || { source, cases: 0, placed: 0, quoted: 0, collected: 0 };
    const revenue = revenueByCase.get(record.id) || { quoted: 0, collected: 0, outstanding: 0 };
    metric.cases += 1;
    metric.quoted += revenue.quoted;
    metric.collected += revenue.collected;
    if (hasReached(record, scopedStages, 'placed')) metric.placed += 1;
    sourceMap.set(source, metric);
  }

  const engagedDurations = scopedCases.flatMap((record) => {
    const firstEngaged = scopedStages
      .filter((item) => item.caseId === record.id && ['engaged', 'intervention', 'placed', 'aftercare'].includes(item.status))
      .sort((a, b) => a.enteredAt.localeCompare(b.enteredAt))[0];
    if (!firstEngaged) return [];
    const duration = new Date(firstEngaged.enteredAt).getTime() - new Date(record.createdAt).getTime();
    return Number.isFinite(duration) && duration >= 0 ? [duration / 86400000] : [];
  });

  const startStamp = period === 'all' ? '' : localDateStamp(new Date(start));
  const scopedReferrals = referrals.filter((referral) => !startStamp || referral.date >= startStamp);
  const outboundReferrals = scopedReferrals.filter((referral) => referral.direction === 'Outbound');
  const outboundPlaced = outboundReferrals.filter((referral) => referral.outcome === 'Placed').length;
  const today = localDateStamp(now);
  const squareInvoices = scopedIntegrations.filter((item) => item.provider === 'square' && item.recordType === 'invoice');
  const openInvoices = squareInvoices.filter((item) => !terminalInvoiceStatuses.has(item.status.toLowerCase()));

  return {
    casesCreated: scopedCases.length,
    activeCases: scopedCases.filter((record) => !['closed', 'lost'].includes(record.status)).length,
    quotedRevenue: [...revenueByCase.values()].reduce((sum, revenue) => sum + revenue.quoted, 0),
    collectedRevenue: [...revenueByCase.values()].reduce((sum, revenue) => sum + revenue.collected, 0),
    outstandingRevenue: [...revenueByCase.values()].reduce((sum, revenue) => sum + revenue.outstanding, 0),
    placedCases: placed,
    lostCases: scopedCases.filter((record) => record.status === 'lost').length,
    placementRate: scopedCases.length ? placed / scopedCases.length : 0,
    outboundReferrals: outboundReferrals.length,
    outboundPlaced,
    referralPlacementRate: outboundReferrals.length ? outboundPlaced / outboundReferrals.length : 0,
    averageDaysToEngaged: engagedDurations.length
      ? engagedDurations.reduce((sum, value) => sum + value, 0) / engagedDurations.length
      : null,
    funnel: [
      { key: 'inquiry', label: 'Inquiries', value: scopedCases.length, rate: scopedCases.length ? 1 : 0 },
      { key: 'consult', label: 'Consulted', value: consulted, rate: consulted / base },
      { key: 'engaged', label: 'Engaged', value: engaged, rate: engaged / base },
      { key: 'placed', label: 'Placed', value: placed, rate: placed / base },
    ],
    sources: [...sourceMap.values()].sort((a, b) => b.cases - a.cases || b.collected - a.collected),
    pendingContracts: scopedIntegrations.filter((item) => item.provider === 'pandadoc'
      && item.recordType === 'document' && !terminalDocumentStatuses.has(item.status.toLowerCase())).length,
    openInvoices: openInvoices.length,
    overdueInvoices: openInvoices.filter((item) => Boolean(item.dueOn && item.dueOn < today)).length,
  };
}
