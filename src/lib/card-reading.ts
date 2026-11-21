// Reading the insurance card into Benefits (docs/FAMILY_ASSESSMENT.md,
// "Reading the card, 2026-11-21"). The ai-assist function (read_card) reads
// the family's card photos on the practitioner's own key and answers with
// the carrier, the plan name and the LAST FOUR of the member ID. This file
// turns that into the Benefits form: it fills only the fields that are
// empty, and lists every field where the card reads something else, so the
// practitioner sees both and picks. Nothing is saved until they tap Save.
// Pure: no React, no Supabase.

import { memberIdLast4 } from './insurance';

export type CardReading = {
  /** The app's carrier name when one matched, otherwise as printed. */
  carrier: string;
  /** The insurer as printed on the card. */
  cardCarrier: string;
  planName: string;
  /** Exactly four letters or digits, or "". */
  memberIdLast4: string;
  /** What was unclear, in a short sentence; "" when all was clear. */
  note: string;
};

const LIMITS = { carrier: 120, planName: 120, note: 300 };

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max).trim() : '';
}

/** The function's answer, read defensively; null when nothing usable came back. */
export function readCardReading(value: unknown): CardReading | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const last4 = typeof input.memberIdLast4 === 'string' ? memberIdLast4(input.memberIdLast4) : '';
  const reading: CardReading = {
    carrier: text(input.carrier, LIMITS.carrier),
    cardCarrier: text(input.cardCarrier, LIMITS.carrier),
    planName: text(input.planName, LIMITS.planName),
    // Only ever four characters: the server refuses anything else.
    memberIdLast4: last4.length === 4 ? last4 : '',
    note: text(input.note, LIMITS.note),
  };
  // An insurer the app does not list comes back only as printed (cardCarrier): still a reading.
  return reading.carrier || reading.cardCarrier || reading.planName || reading.memberIdLast4 ? reading : null;
}

export type CardField = 'carrier' | 'planName' | 'memberIdLast4';

export const CARD_FIELD_LABELS: Record<CardField, string> = {
  carrier: 'Carrier',
  planName: 'Plan name',
  memberIdLast4: 'Member ID, last four',
};

const FIELDS: CardField[] = ['carrier', 'planName', 'memberIdLast4'];

export type CardPlanFields = Record<CardField, string>;

/** A field where the form already had something and the card reads something else. */
export type CardDifference = { field: CardField; label: string; current: string; read: string };

export type CardFill = {
  /** The form's three fields after the fill: empty ones take the card's reading. */
  fields: CardPlanFields;
  /** The labels of the fields filled from the card. */
  filled: string[];
  differences: CardDifference[];
};

function same(left: string, right: string): boolean {
  const fold = (value: string) => value.toLowerCase().replace(/[^0-9a-z]+/g, '');
  return fold(left) === fold(right);
}

/**
 * The card's reading over what the form holds: an empty field takes the
 * reading, a field that already has something keeps it, and the reading is
 * listed beside it when they differ. Nothing the practitioner has is ever
 * replaced here.
 */
export function cardFill(current: CardPlanFields, reading: CardReading): CardFill {
  const fields = { ...current };
  const filled: string[] = [];
  const differences: CardDifference[] = [];
  for (const field of FIELDS) {
    const read = reading[field];
    if (!read) continue;
    const have = current[field].trim();
    if (!have) {
      fields[field] = read;
      filled.push(CARD_FIELD_LABELS[field]);
    } else if (!same(have, read)) {
      differences.push({ field, label: CARD_FIELD_LABELS[field], current: have, read });
    }
  }
  return { fields, filled, differences };
}

/** The sides that have a photo recorded, for the request. */
export function cardSides(assessment: { cardFront: boolean; cardBack: boolean }): ('front' | 'back')[] {
  return [...(assessment.cardFront ? ['front' as const] : []), ...(assessment.cardBack ? ['back' as const] : [])];
}

/** What was read, in one line, for when the form cannot open (offline). */
export function cardReadingLine(reading: CardReading): string {
  return [
    reading.carrier || reading.cardCarrier,
    reading.planName,
    reading.memberIdLast4 ? `member ID ending ${reading.memberIdLast4}` : '',
  ].filter(Boolean).join(', ');
}
