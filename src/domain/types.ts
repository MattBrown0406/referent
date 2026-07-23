export const PARTNER_TYPES = [
  'Inpatient',
  'IOP / PHP',
  'Interventionist',
  'Therapist',
  'Sober Living',
  'Detox',
] as const;

export type PartnerType = (typeof PARTNER_TYPES)[number];
export type ReferralDirection = 'Inbound' | 'Outbound';
export type InsuranceNetworkPreference = 'In-network' | 'Out-of-network';
export type ReferralOutcome = 'Placed' | 'Introduced' | 'Consulted' | 'Pending';

export interface Partner {
  id: string;
  name: string;
  organization: string;
  type: PartnerType;
  types: PartnerType[];
  city: string;
  state: string;
  regions: string[];
  phone: string;
  email: string;
  website: string;
  /** Null means no valid cash price was explicitly recorded; zero means explicitly free. */
  cashMin: number | null;
  /** Null means no valid cash price was explicitly recorded; zero means explicitly free. */
  cashMax: number | null;
  insurance: string[];
  /** Insurance plans for which out-of-network benefits can actually be used. */
  outOfNetworkInsurance: string[];
  therapies: string[];
  populations: string[];
  levels: string[];
  note: string;
  /** @deprecated Compatibility only. Derive current counts from Referral rows. */
  inbound: number;
  /** @deprecated Compatibility only. Derive current counts from Referral rows. */
  outbound: number;
  lastContact: string;
  favorite: boolean;
}

export interface Referral {
  id: string;
  partnerId: string;
  direction: ReferralDirection;
  date: string;
  clientLabel: string;
  outcome: ReferralOutcome;
  note: string;
}

export interface ReferralMatch {
  id: string;
  clientLabel: string;
  levelOfCare: PartnerType | 'Any type';
  state: string;
  insurance: string;
  networkPreferences: InsuranceNetworkPreference[];
  maxBudget?: number;
  therapies: string[];
  status: 'Matching' | 'Referred';
  createdAt: string;
  updatedAt: string;
  assignedPartnerId?: string;
  referralId?: string;
}

export interface DomainSettings {
  cloudSyncEnabled: boolean;
  lastCloudSyncAt: string | null;
}

/** Workflow rows are introduced by the workflow domain; v3 reserves their collections now. */
export type WorkflowRecord = Record<string, unknown>;

export interface SchemaV3Envelope {
  schemaVersion: 3;
  partners: Partner[];
  referrals: Referral[];
  referralMatches: ReferralMatch[];
  cases: WorkflowRecord[];
  participants: WorkflowRecord[];
  checklistCompletions: WorkflowRecord[];
  documentReferences: WorkflowRecord[];
  tasks: WorkflowRecord[];
  appointments: WorkflowRecord[];
  revenueEntries: WorkflowRecord[];
  workflowImports: WorkflowRecord[];
  settings: DomainSettings;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringValue = (value: unknown, fallback = '') =>
  typeof value === 'string' ? value : fallback;

const numberValue = (value: unknown, fallback = 0) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const nonNegativePrice = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

const booleanValue = (value: unknown, fallback = false) =>
  typeof value === 'boolean' ? value : fallback;

const stringArray = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const recordArray = (value: unknown): WorkflowRecord[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const isPartnerType = (value: unknown): value is PartnerType =>
  typeof value === 'string' && (PARTNER_TYPES as readonly string[]).includes(value);

const partnerTypeArray = (value: unknown) => stringArray(value).filter(isPartnerType);

export function generateId(prefix: string): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return `${prefix}-${cryptoApi.randomUUID()}`;

  if (typeof cryptoApi?.getRandomValues === 'function') {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${prefix}-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // Older runtimes: combine independent random words with time instead of Date.now alone.
  const randomHex = () => Math.floor(Math.random() * 0x1_0000_0000).toString(16).padStart(8, '0');
  const hex = `${randomHex()}${randomHex()}${randomHex()}${randomHex()}`;
  return `${prefix}-${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function normalizePartner(input: unknown): Partner {
  const source = isRecord(input) ? input : {};
  const legacyTypes = partnerTypeArray(source.types);
  const type = isPartnerType(source.type) ? source.type : legacyTypes[0] ?? 'Inpatient';
  const cashMin = nonNegativePrice(source.cashMin);
  const rawCashMax = nonNegativePrice(source.cashMax);
  const cashMax = cashMin !== null && rawCashMax !== null && rawCashMax < cashMin ? null : rawCashMax;

  return {
    id: stringValue(source.id) || generateId('partner'),
    name: stringValue(source.name),
    organization: stringValue(source.organization),
    type,
    types: legacyTypes,
    city: stringValue(source.city),
    state: stringValue(source.state),
    regions: stringArray(source.regions),
    phone: stringValue(source.phone),
    email: stringValue(source.email),
    website: stringValue(source.website),
    cashMin,
    cashMax,
    insurance: stringArray(source.insurance),
    outOfNetworkInsurance: stringArray(source.outOfNetworkInsurance),
    therapies: stringArray(source.therapies),
    populations: stringArray(source.populations),
    levels: stringArray(source.levels),
    note: stringValue(source.note),
    inbound: numberValue(source.inbound),
    outbound: numberValue(source.outbound),
    lastContact: stringValue(source.lastContact),
    favorite: booleanValue(source.favorite),
  };
}

export function normalizeReferral(input: unknown): Referral {
  const source = isRecord(input) ? input : {};
  const direction: ReferralDirection = source.direction === 'Outbound' ? 'Outbound' : 'Inbound';
  const outcomes: ReferralOutcome[] = ['Placed', 'Introduced', 'Consulted', 'Pending'];
  const outcome = outcomes.includes(source.outcome as ReferralOutcome)
    ? (source.outcome as ReferralOutcome)
    : 'Introduced';

  return {
    id: stringValue(source.id) || generateId('referral'),
    partnerId: stringValue(source.partnerId),
    direction,
    date: stringValue(source.date),
    clientLabel: stringValue(source.clientLabel),
    outcome,
    note: stringValue(source.note),
  };
}

export function normalizeReferralMatch(input: unknown): ReferralMatch {
  const source = isRecord(input) ? input : {};
  const levelOfCare = source.levelOfCare === 'Any type' || isPartnerType(source.levelOfCare)
    ? source.levelOfCare
    : 'Any type';
  const networkPreferences = stringArray(source.networkPreferences).filter(
    (value): value is InsuranceNetworkPreference => value === 'In-network' || value === 'Out-of-network',
  );
  const maxBudget = numberValue(source.maxBudget, Number.NaN);

  return {
    id: stringValue(source.id) || generateId('match'),
    clientLabel: stringValue(source.clientLabel),
    levelOfCare,
    state: stringValue(source.state, 'ANY'),
    insurance: stringValue(source.insurance, 'Cash pay'),
    networkPreferences,
    ...(Number.isFinite(maxBudget) && maxBudget > 0 ? { maxBudget } : {}),
    therapies: stringArray(source.therapies),
    status: source.status === 'Referred' ? 'Referred' : 'Matching',
    createdAt: stringValue(source.createdAt),
    updatedAt: stringValue(source.updatedAt),
    ...(typeof source.assignedPartnerId === 'string' ? { assignedPartnerId: source.assignedPartnerId } : {}),
    ...(typeof source.referralId === 'string' ? { referralId: source.referralId } : {}),
  };
}

export function createEmptyEnvelope(): SchemaV3Envelope {
  return {
    schemaVersion: 3,
    partners: [],
    referrals: [],
    referralMatches: [],
    cases: [],
    participants: [],
    checklistCompletions: [],
    documentReferences: [],
    tasks: [],
    appointments: [],
    revenueEntries: [],
    workflowImports: [],
    settings: { cloudSyncEnabled: false, lastCloudSyncAt: null },
  };
}

export function migrateStoredData(input: unknown): SchemaV3Envelope {
  if (!isRecord(input)) throw new Error('Stored data must be an object.');

  const coreCollections = ['partners', 'referrals', 'referralMatches'] as const;
  const workflowCollections = [
    'cases',
    'participants',
    'checklistCompletions',
    'documentReferences',
    'tasks',
    'appointments',
    'revenueEntries',
    'workflowImports',
  ] as const;
  const requireArrays = (keys: readonly string[]) => {
    for (const key of keys) {
      if (!Array.isArray(input[key])) throw new Error(`Stored data collection "${key}" must be an array.`);
    }
  };
  const requireRecordRows = (keys: readonly string[]) => {
    for (const key of keys) {
      const rows = input[key] as unknown[];
      if (rows.some((row) => !isRecord(row))) {
        throw new Error(`Stored data collection "${key}" contains a non-record row.`);
      }
    }
  };
  const requireUniqueIds = (keys: readonly string[]) => {
    for (const key of keys) {
      const rows = input[key] as Record<string, unknown>[];
      const ids = rows.map((row) => row.id);
      if (ids.some((id) => typeof id !== 'string' || !id.trim())) {
        throw new Error(`Stored v3 collection "${key}" contains a row without a valid id.`);
      }
      if (new Set(ids).size !== ids.length) {
        throw new Error(`Stored v3 collection "${key}" contains duplicate ids.`);
      }
    }
  };
  const requireExactKeys = (record: Record<string, unknown>, allowed: readonly string[], label: string) => {
    const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) throw new Error(`${label} contains unknown field(s): ${unknown.join(', ')}.`);
  };

  const isV3 = input.schemaVersion === 3;
  if (isV3) {
    requireExactKeys(input, ['schemaVersion', ...coreCollections, ...workflowCollections, 'settings'], 'Stored v3 data');
    requireArrays([...coreCollections, ...workflowCollections]);
    requireRecordRows([...coreCollections, ...workflowCollections]);
    requireUniqueIds([...coreCollections, ...workflowCollections]);
    for (const partner of input.partners as Record<string, unknown>[]) {
      requireExactKeys(partner, [
        'id', 'name', 'organization', 'type', 'types', 'city', 'state', 'regions', 'phone', 'email', 'website',
        'cashMin', 'cashMax', 'insurance', 'outOfNetworkInsurance', 'therapies', 'populations', 'levels', 'note',
        'inbound', 'outbound', 'lastContact', 'favorite',
      ], 'Stored v3 partner');
      const stringFields = ['id', 'name', 'organization', 'city', 'state', 'phone', 'email', 'website', 'note', 'lastContact'];
      const arrayFields = ['types', 'regions', 'insurance', 'outOfNetworkInsurance', 'therapies', 'populations', 'levels'];
      const validPrice = (value: unknown) => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
      if (stringFields.some((key) => typeof partner[key] !== 'string')
        || arrayFields.some((key) => !Array.isArray(partner[key]) || (partner[key] as unknown[]).some((value) => typeof value !== 'string'))
        || !isPartnerType(partner.type)
        || !validPrice(partner.cashMin) || !validPrice(partner.cashMax)
        || (typeof partner.cashMin === 'number' && typeof partner.cashMax === 'number' && partner.cashMax < partner.cashMin)
        || typeof partner.inbound !== 'number' || !Number.isFinite(partner.inbound)
        || typeof partner.outbound !== 'number' || !Number.isFinite(partner.outbound)
        || typeof partner.favorite !== 'boolean') {
        throw new Error('Stored v3 partner contains invalid fields.');
      }
    }
    for (const referral of input.referrals as Record<string, unknown>[]) {
      requireExactKeys(referral, ['id', 'partnerId', 'direction', 'date', 'clientLabel', 'outcome', 'note'], 'Stored v3 referral');
      if (['id', 'partnerId', 'date', 'clientLabel', 'note'].some((key) => typeof referral[key] !== 'string')
        || !['Inbound', 'Outbound'].includes(String(referral.direction))
        || !['Placed', 'Introduced', 'Consulted', 'Pending'].includes(String(referral.outcome))) {
        throw new Error('Stored v3 referral contains invalid fields.');
      }
    }
    for (const match of input.referralMatches as Record<string, unknown>[]) {
      requireExactKeys(match, [
        'id', 'clientLabel', 'levelOfCare', 'state', 'insurance', 'networkPreferences', 'maxBudget', 'therapies',
        'status', 'createdAt', 'updatedAt', 'assignedPartnerId', 'referralId',
      ], 'Stored v3 referral match');
      if (['id', 'clientLabel', 'state', 'insurance', 'createdAt', 'updatedAt'].some((key) => typeof match[key] !== 'string')
        || !(match.levelOfCare === 'Any type' || isPartnerType(match.levelOfCare))
        || !Array.isArray(match.networkPreferences)
        || (match.networkPreferences as unknown[]).some((value) => value !== 'In-network' && value !== 'Out-of-network')
        || !Array.isArray(match.therapies) || (match.therapies as unknown[]).some((value) => typeof value !== 'string')
        || !['Matching', 'Referred'].includes(String(match.status))
        || (match.maxBudget !== undefined && (typeof match.maxBudget !== 'number' || !Number.isFinite(match.maxBudget) || match.maxBudget <= 0))
        || (match.assignedPartnerId !== undefined && typeof match.assignedPartnerId !== 'string')
        || (match.referralId !== undefined && typeof match.referralId !== 'string')) {
        throw new Error('Stored v3 referral match contains invalid fields.');
      }
    }
    if (!isRecord(input.settings)
      || typeof input.settings.cloudSyncEnabled !== 'boolean'
      || !(typeof input.settings.lastCloudSyncAt === 'string' || input.settings.lastCloudSyncAt === null)) {
      throw new Error('Stored data settings are invalid.');
    }
    requireExactKeys(input.settings, ['cloudSyncEnabled', 'lastCloudSyncAt'], 'Stored data settings');
  } else {
    if ('schemaVersion' in input) throw new Error(`Unsupported stored data schema version: ${String(input.schemaVersion)}.`);
    requireExactKeys(input, coreCollections, 'Stored legacy data');
    requireArrays(coreCollections);
    requireRecordRows(coreCollections);
  }

  const envelope = createEmptyEnvelope();
  envelope.partners = (input.partners as unknown[]).map(normalizePartner);
  envelope.referrals = (input.referrals as unknown[]).map(normalizeReferral);
  envelope.referralMatches = (input.referralMatches as unknown[]).map(normalizeReferralMatch);

  if (isV3) {
    envelope.cases = recordArray(input.cases);
    envelope.participants = recordArray(input.participants);
    envelope.checklistCompletions = recordArray(input.checklistCompletions);
    envelope.documentReferences = recordArray(input.documentReferences);
    envelope.tasks = recordArray(input.tasks);
    envelope.appointments = recordArray(input.appointments);
    envelope.revenueEntries = recordArray(input.revenueEntries);
    envelope.workflowImports = recordArray(input.workflowImports);
    const settings = input.settings as Record<string, unknown>;
    envelope.settings = {
      cloudSyncEnabled: settings.cloudSyncEnabled as boolean,
      lastCloudSyncAt: settings.lastCloudSyncAt as string | null,
    };
  }

  return envelope;
}
