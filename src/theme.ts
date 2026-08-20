import { ReferentType } from './types';

export const colors = {
  bg: '#F2F2F7',
  card: '#FFFFFF',
  text: '#111318',
  subtext: '#6B7280',
  border: '#E5E7EB',
  accent: '#0F766E',
  accentSoft: '#CCFBF1',
  inbound: '#15803D',
  inboundSoft: '#DCFCE7',
  outbound: '#B45309',
  outboundSoft: '#FEF3C7',
  danger: '#B91C1C',
  chipBg: '#EEF2F6',
  chipSelected: '#0F766E',
};

export const typeColors: Record<ReferentType, { bg: string; fg: string }> = {
  'Detox': { bg: '#FEE2E2', fg: '#B91C1C' },
  'Residential / Inpatient': { bg: '#E0E7FF', fg: '#4338CA' },
  'PHP': { bg: '#EDE9FE', fg: '#6D28D9' },
  'IOP': { bg: '#DBEAFE', fg: '#1D4ED8' },
  'Therapist': { bg: '#DCFCE7', fg: '#15803D' },
  'Psychiatrist': { bg: '#CCFBF1', fg: '#0F766E' },
  'Interventionist': { bg: '#FEF3C7', fg: '#B45309' },
  'Sober Living': { bg: '#FCE7F3', fg: '#BE185D' },
  'Recovery Coach': { bg: '#F3F4F6', fg: '#374151' },
};
