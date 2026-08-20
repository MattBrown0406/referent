export type ReferentType =
  | 'Detox'
  | 'Residential / Inpatient'
  | 'PHP'
  | 'IOP'
  | 'Therapist'
  | 'Psychiatrist'
  | 'Interventionist'
  | 'Sober Living'
  | 'Recovery Coach';

export const REFERENT_TYPES: ReferentType[] = [
  'Detox',
  'Residential / Inpatient',
  'PHP',
  'IOP',
  'Therapist',
  'Psychiatrist',
  'Interventionist',
  'Sober Living',
  'Recovery Coach',
];

export const SPECIALTIES = [
  'Trauma',
  'Dual Diagnosis',
  'CBT',
  'DBT',
  'EMDR',
  'IFS',
  'Equine Therapy',
  'Experiential / Adventure',
  'Somatic Experiencing',
  'Family Systems',
  '12-Step Integration',
  'MAT',
  'Eating Disorders',
  'Process Addictions',
  'Sex Addiction',
  'Young Adults',
  'Adolescents',
  'LGBTQ+ Affirming',
  'Faith-Based',
  'Chronic Relapse',
] as const;

export const PRICE_UNITS = ['/month', '/episode', '/session', '/case', '/day'] as const;
export type PriceUnit = (typeof PRICE_UNITS)[number];

export interface Referent {
  id: string;
  name: string;
  organization?: string;
  type: ReferentType;
  city: string;
  state: string; // 2-letter
  phone?: string;
  email?: string;
  website?: string;
  cashPrice?: number;
  priceUnit?: PriceUnit;
  insurance: string[];
  specialties: string[];
  notes?: string;
  createdAt: string;
}

export type ReferralDirection = 'inbound' | 'outbound';

export interface Referral {
  id: string;
  referentId: string;
  direction: ReferralDirection;
  clientLabel: string; // initials only — no PHI
  date: string; // ISO
  note?: string;
}

export interface MatchCriteria {
  type: ReferentType | null;
  state: string | null;
  /** 'Cash Pay' or an insurance provider name */
  payment: string;
  cashBudget: string; // raw text input, max monthly budget
  specialties: string[];
}

export interface MatchResult {
  referent: Referent;
  total: number;
  clinical: number;
  payment: number;
  geography: number;
  reciprocity: number;
  netInbound: number;
  matchedSpecialties: string[];
  paymentNote: string;
}
