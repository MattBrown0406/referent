// True cost to the family: what a family would pay out of pocket for a stay
// at one program, from the plan's benefits on the case (case_benefits), the
// program's VOB answer (vob_requests) and the program's own cash cost.
// Migration 20261104120000_family_cost.sql stores the numbers; the formulas
// are written out in docs/FAMILY_COST.md. Pure: no React, no Supabase, so it
// runs in plain node (scripts/family-cost-test.mjs).
//
// Three rules hold everywhere this is shown:
//   1. It is an estimate, never a quote, and it says so.
//   2. Unknown is said out loud as unknown, with what is missing. It is never
//      $0 and never "affordable" (the same rule matching.ts keeps for a cash
//      cost not on file). A known $0 (the out-of-pocket max is already met)
//      is a real answer and is shown.
//   3. It never changes a match's score or rank: matching.ts does not read
//      it. And it is the family's business: the program's copy of a packet
//      never carries it (packet.ts drops it for that audience).
//
// low / high: low is the best case the numbers allow, high the worst. One of
// them can be null: "up to $high" (in-network on the billed price, which the
// plan's allowed amount can only lower) or "$low or more" (out-of-network
// when the balance bill cannot be priced, because nothing caps it).

import { formatMoney } from '../data';
import type { InsuranceNetworkPreference, Partner } from '../data';
import { knownMonthlyCostForPartner } from './matching';
import {
  isVobAnswered,
  type NetworkBenefits,
  type PlanCosts,
  type PlanNetworkStatus,
  type VobCosts,
  type VobRequest,
} from './insurance';

// ─── Constants ──────────────────────────────────────────────────────────────

export const DEFAULT_STAY_DAYS = 30;
export const MAX_STAY_DAYS = 365;
/** The length-of-stay choices on the case file. */
export const STAY_DAY_CHOICES = [14, 30, 45, 60, 90];
/** A monthly cash cost covers 30 days. */
export const DAYS_PER_MONTH = 30;
/** Mirrored by the CHECK constraints and patch_whole_number in the migration. */
export const MAX_PLAN_DOLLARS = 1000000;
export const MAX_DAILY_DOLLARS = 100000;

export const ESTIMATE_LABEL = 'Estimate, not a quote';
export const ESTIMATE_FOOTNOTE = 'Estimates, not quotes: the carrier and the program confirm the real numbers. They never change how programs are ranked.';
export const PACKET_COST_DISCLAIMER = 'Estimate only, not a quote: your insurance company and the program confirm the actual cost.';
export const BALANCE_BILLING_WARNING = 'Out-of-network, the program can bill the family the difference between its price and what the plan allows (balance billing). That part is not capped by the out-of-pocket max.';
export const PRECERT_WARNING = 'The plan needs pre-authorization before admission. Without it, the plan may pay nothing.';

// ─── Types ──────────────────────────────────────────────────────────────────

/** in_network / out_of_network: the plan pays its share. full_cost: insured, but the plan pays nothing here. */
export type CostRoute = 'in_network' | 'out_of_network' | 'full_cost' | 'cash' | 'unknown';

/** The network for one program: a VOB answer on the case, else what the program reports. */
export type NetworkAnswer = 'in_network' | 'out_of_network' | 'not_accepted' | 'unknown';

export type ProgramCashCost = Pick<Partner, 'monthlyCost' | 'cashMin' | 'cashMax'>;

export type VobCostAnswer = VobCosts & Pick<VobRequest, 'quotedOutOfPocket'>;

export type FamilyCostInput = {
  payment: 'insurance' | 'cash';
  network: NetworkAnswer;
  /** The network came from a VOB answer on this case, not the program's own listing. */
  confirmedByVob?: boolean;
  benefits: PlanCosts | null;
  vob: VobCostAnswer | null;
  program: ProgramCashCost | null;
  days?: number;
};

export type FamilyCostEstimate = {
  /** false: low and high are both null and `missing` says why. */
  known: boolean;
  route: CostRoute;
  days: number;
  low: number | null;
  high: number | null;
  /** What the numbers came from, in plain words, in order. */
  basis: string[];
  /** What is needed before there is a number (empty when known). */
  missing: string[];
  /** The first thing to do about it, short enough for a card: "add benefits". */
  nextStep: string;
  warnings: string[];
  /** A few family-facing words for the packet, '' when nothing needs saying. */
  note: string;
  balanceBilling: boolean;
  precertRequired: boolean | null;
};

type Need = { text: string; step: string };

const NEED = {
  benefits: { text: 'the plan benefits (deductible, coinsurance, out-of-pocket max)', step: 'add benefits' },
  inBenefits: { text: 'the in-network benefits (deductible, coinsurance, out-of-pocket max)', step: 'add benefits' },
  inDeductible: { text: 'the in-network deductible', step: 'add benefits' },
  inCoinsurance: { text: 'the in-network coinsurance', step: 'add benefits' },
  oonKnown: { text: 'whether the plan pays anything out-of-network', step: 'add out-of-network benefits' },
  oonDeductible: { text: 'the out-of-network deductible', step: 'add out-of-network benefits' },
  oonCoinsurance: { text: 'the out-of-network coinsurance', step: 'add out-of-network benefits' },
  rate: { text: 'the program’s daily rate (record it on the VOB answer)', step: 'add the daily rate' },
  network: { text: 'whether this program is in-network for the plan (request a VOB)', step: 'request a VOB' },
  cash: { text: 'the program’s cash cost', step: 'add the cash cost' },
  fullCostRate: { text: 'the program’s billed daily rate or cash cost', step: 'add the daily rate' },
} satisfies Record<string, Need>;

// ─── Small helpers ──────────────────────────────────────────────────────────

/** 1 to 365 whole days; anything else is the 30-day default. */
export function normalizeStayDays(days?: number | null): number {
  if (typeof days !== 'number' || !Number.isFinite(days) || days < 1) return DEFAULT_STAY_DAYS;
  return Math.min(MAX_STAY_DAYS, Math.round(days));
}

function dollars(value: number): number {
  return Math.round(value);
}

function positive(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function isEmptyNetworkBenefits(benefits: NetworkBenefits | null | undefined): boolean {
  if (!benefits) return true;
  return benefits.deductible == null && benefits.deductibleMet == null && benefits.oopMax == null
    && benefits.oopMet == null && benefits.coinsurancePct == null;
}

export function hasPlanCosts(plan: PlanCosts | null | undefined): boolean {
  if (!plan) return false;
  return !isEmptyNetworkBenefits(plan.inNetwork) || !isEmptyNetworkBenefits(plan.outOfNetwork) || plan.oonBenefits != null;
}

function hasVobCosts(vob: Partial<VobCosts> | null | undefined): boolean {
  if (!vob) return false;
  return vob.allowedDailyRate != null || vob.billedDailyRate != null || vob.copayPerDay != null || vob.precertRequired != null;
}

function networkLine(label: string, confirmedByVob: boolean | undefined): string {
  return confirmedByVob ? `${label}, confirmed by VOB` : `${label}, as the program reports it (a VOB confirms it)`;
}

function estimate(
  partial: Pick<FamilyCostEstimate, 'route' | 'days' | 'basis'> & Partial<FamilyCostEstimate>,
): FamilyCostEstimate {
  return {
    known: false,
    low: null,
    high: null,
    missing: [],
    nextStep: '',
    warnings: [],
    note: '',
    balanceBilling: false,
    precertRequired: null,
    ...partial,
  };
}

function unknownEstimate(
  route: CostRoute,
  days: number,
  needs: Need[],
  basis: string[],
  extra: Partial<FamilyCostEstimate> = {},
): FamilyCostEstimate {
  return estimate({
    ...extra,
    route,
    days,
    basis,
    known: false,
    low: null,
    high: null,
    missing: needs.map((need) => need.text),
    nextStep: needs[0]?.step || 'add benefits',
  });
}

// ─── The plan's share ───────────────────────────────────────────────────────
// For `total` dollars of care the plan allows:
//   deductible left = max(0, deductible - met so far)
//   share           = min(total, deductible left)
//                     + coinsurance% x max(0, total - deductible left)
//   out-of-pocket left = max(0, out-of-pocket max - met so far)
//   low  = min(share + copays, out-of-pocket left)  copays count toward the max
//   high = min(share, out-of-pocket left) + copays  a plan where they do not
// With no out-of-pocket max on file nothing is capped (low = high = share +
// copays), which can only overstate. A met amount left blank is read as 0
// met, which can only overstate too.

type PlanShare = { low: number; high: number; deductibleLeft: number; oopLeft: number | null; capped: boolean };

export function planShare(total: number, benefits: NetworkBenefits, copays = 0): PlanShare {
  const deductibleLeft = Math.max(0, (benefits.deductible ?? 0) - (benefits.deductibleMet ?? 0));
  const deductiblePart = Math.min(total, deductibleLeft);
  const coinsurancePart = ((benefits.coinsurancePct ?? 0) / 100) * Math.max(0, total - deductibleLeft);
  const share = deductiblePart + coinsurancePart;
  const oopLeft = benefits.oopMax == null ? null : Math.max(0, benefits.oopMax - (benefits.oopMet ?? 0));
  if (oopLeft == null) return { low: share + copays, high: share + copays, deductibleLeft, oopLeft, capped: false };
  return {
    low: Math.min(share + copays, oopLeft),
    high: Math.min(share, oopLeft) + copays,
    deductibleLeft,
    oopLeft,
    capped: share + copays > oopLeft,
  };
}

function shareBasis(benefits: NetworkBenefits, share: PlanShare, copayPerDay: number | null, days: number): string[] {
  const lines = [
    `Deductible left: ${formatMoney(share.deductibleLeft)}${benefits.deductibleMet == null ? ' (assuming none is met yet)' : ''}`,
    `After that the family pays ${benefits.coinsurancePct}% coinsurance`,
    share.oopLeft == null
      ? 'No out-of-pocket max on file, so nothing is capped'
      : `Out-of-pocket max left: ${formatMoney(share.oopLeft)}${benefits.oopMet == null ? ' (assuming nothing is paid toward it yet)' : ''}${share.capped ? ', which caps the total' : ''}`,
  ];
  if (copayPerDay) {
    lines.push(`Copay: ${formatMoney(copayPerDay)} a day, ${formatMoney(copayPerDay * days)} in all`);
    if (share.oopLeft != null && dollars(share.low) !== dollars(share.high)) {
      lines.push('The higher number is for a plan that does not count copays toward the out-of-pocket max');
    }
  }
  return lines;
}

function quoteLine(vob: VobCostAnswer | null): string[] {
  return vob?.quotedOutOfPocket != null ? [`The program quoted about ${formatMoney(vob.quotedOutOfPocket)} out of pocket`] : [];
}

// ─── Cash ───────────────────────────────────────────────────────────────────
// days x the program's daily cash rate. There is no daily cash field, so it
// comes from the monthly cost over 30 days. A legacy cash range (cashMin <
// cashMax, the monthly cost blank or equal to the top of it) gives a range.
// 0 is how "not entered" is stored, never free.

function cashRange(program: ProgramCashCost | null, days: number): { low: number; high: number; basis: string } | null {
  if (!program) return null;
  const min = positive(program.cashMin);
  const max = positive(program.cashMax);
  const monthly = knownMonthlyCostForPartner(program);
  if (min != null && max != null && min < max && (monthly == null || monthly === max)) {
    return {
      low: dollars((min * days) / DAYS_PER_MONTH),
      high: dollars((max * days) / DAYS_PER_MONTH),
      basis: `The program’s cash cost: ${formatMoney(min)}–${formatMoney(max)} a month, for ${days} days`,
    };
  }
  if (monthly == null) return null;
  const total = dollars((monthly * days) / DAYS_PER_MONTH);
  return {
    low: total,
    high: total,
    basis: `The program’s cash cost: ${formatMoney(monthly)} a month (about ${formatMoney(monthly / DAYS_PER_MONTH)} a day) × ${days} days`,
  };
}

function cashEstimate(program: ProgramCashCost | null, days: number): FamilyCostEstimate {
  const cash = cashRange(program, days);
  if (!cash) return unknownEstimate('cash', days, [NEED.cash], ['Paying privately']);
  return estimate({ route: 'cash', days, known: true, low: cash.low, high: cash.high, basis: ['Paying privately', cash.basis] });
}

// ─── Full cost: insured, but the plan pays nothing at this program ──────────

function fullCostEstimate(input: FamilyCostInput, days: number, reason: string, note: string): FamilyCostEstimate {
  const billed = input.vob?.billedDailyRate ?? null;
  const basis = [reason];
  if (billed != null) {
    const total = billed * days;
    basis.push(`${formatMoney(billed)} a day × ${days} days = ${formatMoney(total)}, the program’s billed price`);
    return estimate({ route: 'full_cost', days, known: true, low: total, high: total, basis, note });
  }
  const cash = cashRange(input.program, days);
  if (cash) {
    basis.push(cash.basis, 'Ask the program whether it has a lower self-pay rate');
    return estimate({ route: 'full_cost', days, known: true, low: cash.low, high: cash.high, basis, note });
  }
  return unknownEstimate('full_cost', days, [NEED.fullCostRate], basis, { note });
}

// ─── In-network ─────────────────────────────────────────────────────────────

function inNetworkEstimate(input: FamilyCostInput, days: number, common: Partial<FamilyCostEstimate>): FamilyCostEstimate {
  const benefits = input.benefits?.inNetwork ?? null;
  const needs: Need[] = [];
  if (!input.benefits) needs.push(NEED.benefits);
  else if (isEmptyNetworkBenefits(benefits)) needs.push(NEED.inBenefits);
  else {
    if (benefits?.deductible == null) needs.push(NEED.inDeductible);
    if (benefits?.coinsurancePct == null) needs.push(NEED.inCoinsurance);
  }
  const allowed = input.vob?.allowedDailyRate ?? null;
  const billed = input.vob?.billedDailyRate ?? null;
  const rate = allowed ?? billed;
  if (rate == null) needs.push(NEED.rate);
  const basis = [networkLine('In-network', input.confirmedByVob)];
  if (needs.length || !benefits || rate == null) {
    if (benefits?.oopMax != null) {
      const oopLeft = Math.max(0, benefits.oopMax - (benefits.oopMet ?? 0));
      basis.push(`In-network, the out-of-pocket max left (${formatMoney(oopLeft)}) is usually the most the family pays this plan year`);
    }
    return unknownEstimate('in_network', days, needs, [...basis, ...quoteLine(input.vob)], common);
  }
  const copayPerDay = input.vob?.copayPerDay ?? null;
  const share = planShare(rate * days, benefits, (copayPerDay ?? 0) * days);
  basis.push(allowed != null
    ? `${formatMoney(allowed)} a day × ${days} days = ${formatMoney(allowed * days)}, the plan’s allowed amount`
    : `${formatMoney(billed as number)} a day × ${days} days = ${formatMoney(rate * days)}, the program’s billed price. The plan’s allowed amount is usually lower, so this is the most it should be`);
  basis.push(...shareBasis(benefits, share, copayPerDay, days), ...quoteLine(input.vob));
  return estimate({
    ...common,
    route: 'in_network',
    days,
    known: true,
    low: allowed != null ? dollars(share.low) : null,
    high: dollars(share.high),
    basis,
  });
}

// ─── Out-of-network ─────────────────────────────────────────────────────────
// The OON numbers on the allowed amount, as in-network, plus the balance
// bill: (billed - allowed) a day, on top and NOT capped. The share only
// falls as the allowed amount rises, so on the billed price alone (allowed
// unknown) it is the best case: "$low or more".

function outOfNetworkEstimate(input: FamilyCostInput, days: number, common: Partial<FamilyCostEstimate>): FamilyCostEstimate {
  const plan = input.benefits;
  if (plan?.oonBenefits === false) {
    return fullCostEstimate(input, days, 'The plan has no out-of-network benefits, so the family pays the full cost', 'the plan does not pay for out-of-network care');
  }
  const note = 'the program can also bill what the plan does not cover';
  const extra: Partial<FamilyCostEstimate> = { ...common, balanceBilling: true, note, warnings: [BALANCE_BILLING_WARNING, ...(common.warnings || [])] };
  const benefits = plan?.outOfNetwork ?? null;
  const needs: Need[] = [];
  if (!plan) needs.push(NEED.benefits);
  else if (plan.oonBenefits == null && isEmptyNetworkBenefits(benefits)) needs.push(NEED.oonKnown);
  else {
    if (benefits?.deductible == null) needs.push(NEED.oonDeductible);
    if (benefits?.coinsurancePct == null) needs.push(NEED.oonCoinsurance);
  }
  const allowed = input.vob?.allowedDailyRate ?? null;
  const billed = input.vob?.billedDailyRate ?? null;
  const rate = allowed ?? billed;
  if (rate == null) needs.push(NEED.rate);
  const basis = [networkLine('Out-of-network', input.confirmedByVob)];
  if (needs.length || !benefits || rate == null) {
    return unknownEstimate('out_of_network', days, needs, [...basis, ...quoteLine(input.vob)], extra);
  }
  const copayPerDay = input.vob?.copayPerDay ?? null;
  const share = planShare(rate * days, benefits, (copayPerDay ?? 0) * days);
  basis.push(allowed != null
    ? `${formatMoney(allowed)} a day × ${days} days = ${formatMoney(allowed * days)}, the plan’s allowed amount`
    : `${formatMoney(billed as number)} a day × ${days} days = ${formatMoney(rate * days)}, the program’s billed price, as if the plan allowed all of it (the best case)`);
  basis.push(...shareBasis(benefits, share, copayPerDay, days));
  let high: number | null = null;
  if (allowed != null && billed != null) {
    const balance = Math.max(0, billed - allowed) * days;
    high = share.high + balance;
    basis.push(balance > 0
      ? `Balance bill: ${formatMoney(billed - allowed)} a day between the billed price (${formatMoney(billed)}) and the allowed amount, ${formatMoney(balance)} in all, not capped`
      : 'The program bills no more than the plan allows, so no balance bill is expected');
  } else if (allowed != null) {
    basis.push('The program’s billed price is not on file, so the balance bill cannot be priced');
  } else {
    basis.push('The plan’s allowed amount is not on file; it is usually lower, and the program can bill the family the rest');
  }
  basis.push(...quoteLine(input.vob));
  return estimate({
    ...extra,
    route: 'out_of_network',
    days,
    known: true,
    low: dollars(share.low),
    high: high == null ? null : dollars(high),
    basis,
  });
}

// ─── The estimate ───────────────────────────────────────────────────────────

export function estimateFamilyCost(input: FamilyCostInput): FamilyCostEstimate {
  const days = normalizeStayDays(input.days);
  if (input.payment === 'cash') return cashEstimate(input.program, days);
  const precertRequired = input.vob?.precertRequired ?? null;
  const common: Partial<FamilyCostEstimate> = { precertRequired, warnings: precertRequired === true ? [PRECERT_WARNING] : [] };
  switch (input.network) {
    case 'in_network':
      return inNetworkEstimate(input, days, common);
    case 'out_of_network':
      return outOfNetworkEstimate(input, days, common);
    case 'not_accepted':
      return fullCostEstimate(input, days, 'The program does not take this plan, so the family pays the full cost', 'the program does not take this plan');
    default: {
      const needs = input.benefits && hasPlanCosts(input.benefits) ? [NEED.network] : [NEED.benefits, NEED.network];
      return unknownEstimate('unknown', days, needs, ['Network not known for this plan'], common);
    }
  }
}

// ─── Words ──────────────────────────────────────────────────────────────────

/** "$3,500–$5,000", "$3,500", "up to $6,000", "$8,000 or more", or "unknown". Never "$0" for unknown. */
export function formatCostRange(result: Pick<FamilyCostEstimate, 'known' | 'low' | 'high'>): string {
  if (!result.known) return 'unknown';
  const { low, high } = result;
  if (low != null && high != null) return low === high ? formatMoney(low) : `${formatMoney(low)}–${formatMoney(high)}`;
  if (high != null) return `up to ${formatMoney(high)}`;
  if (low != null) return `${formatMoney(low)} or more`;
  return 'unknown';
}

/** The ranked card line: "Est. family cost (30 days): $X–$Y" or "…: unknown — add benefits". */
export function familyCostCardLine(result: FamilyCostEstimate): string {
  const head = `Est. family cost (${result.days} days)`;
  return result.known ? `${head}: ${formatCostRange(result)}` : `${head}: unknown — ${result.nextStep}`;
}

function amount(value: number | null): string {
  return value == null ? '' : formatMoney(value);
}

/** "$3,000 deductible ($500 met) · $6,000 out-of-pocket max · 20% coinsurance", or "Not entered". */
export function networkBenefitsSummary(benefits: NetworkBenefits | null | undefined): string {
  if (!benefits || isEmptyNetworkBenefits(benefits)) return 'Not entered';
  const parts = [
    benefits.deductible != null ? `${amount(benefits.deductible)} deductible${benefits.deductibleMet != null ? ` (${amount(benefits.deductibleMet)} met)` : ''}` : '',
    benefits.oopMax != null ? `${amount(benefits.oopMax)} out-of-pocket max${benefits.oopMet != null ? ` (${amount(benefits.oopMet)} met)` : ''}` : '',
    benefits.coinsurancePct != null ? `${benefits.coinsurancePct}% coinsurance` : '',
  ].filter(Boolean);
  return parts.join(' · ') || 'Partly entered';
}

export function outOfNetworkSummary(plan: PlanCosts | null | undefined): string {
  if (!plan) return 'Not entered';
  if (plan.oonBenefits === false) return 'No out-of-network benefits';
  const summary = networkBenefitsSummary(plan.outOfNetwork);
  return summary === 'Not entered' && plan.oonBenefits === true ? 'Has out-of-network benefits; amounts not entered' : summary;
}

// ─── Validation (mirrors case_benefits_merge_costs and the CHECKs) ──────────

const FIELD_WORDS: Record<keyof NetworkBenefits, string> = {
  deductible: 'deductible',
  deductibleMet: 'deductible met so far',
  oopMax: 'out-of-pocket max',
  oopMet: 'out-of-pocket met so far',
  coinsurancePct: 'coinsurance',
};

function wholeWithin(value: number | null, max: number): boolean {
  return value == null || (Number.isInteger(value) && value >= 0 && value <= max);
}

/** The first problem with a plan's cost sharing, in plain words, or null. */
export function planCostsProblem(plan: PlanCosts): string | null {
  const sides: [string, NetworkBenefits][] = [['In-network', plan.inNetwork], ['Out-of-network', plan.outOfNetwork]];
  for (const [label, benefits] of sides) {
    for (const key of ['deductible', 'deductibleMet', 'oopMax', 'oopMet'] as const) {
      if (!wholeWithin(benefits[key], MAX_PLAN_DOLLARS)) return `${label} ${FIELD_WORDS[key]}: enter whole dollars from $0 to ${formatMoney(MAX_PLAN_DOLLARS)}.`;
    }
    if (!wholeWithin(benefits.coinsurancePct, 100)) return `${label} coinsurance: enter a whole percent from 0 to 100.`;
    if (benefits.deductibleMet != null && benefits.deductible != null && benefits.deductibleMet > benefits.deductible) {
      return `${label}: the deductible met so far cannot be more than the deductible.`;
    }
    if (benefits.oopMet != null && benefits.oopMax != null && benefits.oopMet > benefits.oopMax) {
      return `${label}: the out-of-pocket met so far cannot be more than the out-of-pocket max.`;
    }
  }
  if (plan.oonBenefits === false && !isEmptyNetworkBenefits(plan.outOfNetwork)) {
    return 'The plan has no out-of-network benefits, so it has no out-of-network amounts.';
  }
  return null;
}

/** The first problem with a VOB answer's rates, in plain words, or null. */
export function vobCostsProblem(costs: VobCosts): string | null {
  const fields: [keyof VobCosts, string][] = [['allowedDailyRate', 'Allowed rate per day'], ['billedDailyRate', 'Billed rate per day'], ['copayPerDay', 'Copay per day']];
  for (const [key, label] of fields) {
    if (!wholeWithin(costs[key] as number | null, MAX_DAILY_DOLLARS)) return `${label}: enter whole dollars from $0 to ${formatMoney(MAX_DAILY_DOLLARS)}.`;
  }
  return null;
}

// ─── One program on one case ────────────────────────────────────────────────

/** The matcher's network for the profile's plan, as the program reports it. */
export function perProgramNetwork(status: InsuranceNetworkPreference | null | undefined): PlanNetworkStatus {
  if (status === 'In-network') return 'in_network';
  if (status === 'Out-of-network') return 'out_of_network';
  return 'unknown';
}

type VobForCost = Pick<VobRequest, 'partnerId' | 'programName' | 'status' | 'answeredAt' | 'requestedAt' | 'quotedOutOfPocket'> & VobCosts;

function sameProgramName(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  return Boolean(left) && left === b.trim().toLowerCase();
}

/**
 * The VOB request that speaks for a program on this case: the latest
 * answered one, else the latest with any rate on it. A request typed by
 * name (no partner) counts for the partner with that name.
 */
export function vobForProgram<T extends VobForCost>(requests: T[], program: { partnerId?: string; programName: string }): T | null {
  const mine = requests.filter((item) => (program.partnerId && item.partnerId === program.partnerId)
    || (!item.partnerId && sameProgramName(item.programName, program.programName)));
  const answered = mine
    .filter((item) => isVobAnswered(item.status) && item.answeredAt)
    .sort((a, b) => (b.answeredAt || '').localeCompare(a.answeredAt || ''));
  if (answered.length) return answered[0];
  return mine.filter(hasVobCosts).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0] || null;
}

export type ProgramCostArgs = {
  /** The family's payment: a plan name, or 'Cash pay'. */
  insurance: string;
  plan: PlanCosts | null;
  requests: VobForCost[];
  partner?: (ProgramCashCost & Pick<Partner, 'id' | 'organization'>) | null;
  /** A program outside the network (a VOB typed by name). */
  programName?: string;
  /** What the program reports for the plan (partners_for_plan / the matcher). */
  perProgram: PlanNetworkStatus;
  days?: number;
};

export function familyCostForProgram(args: ProgramCostArgs): FamilyCostEstimate {
  if (args.insurance === 'Cash pay') {
    return estimateFamilyCost({ payment: 'cash', network: 'unknown', benefits: null, vob: null, program: args.partner ?? null, days: args.days });
  }
  const vob = vobForProgram(args.requests, { partnerId: args.partner?.id, programName: args.partner?.organization || args.programName || '' });
  const answered = vob && isVobAnswered(vob.status) && vob.answeredAt ? vob.status as NetworkAnswer : null;
  return estimateFamilyCost({
    payment: 'insurance',
    network: answered ?? args.perProgram,
    confirmedByVob: Boolean(answered),
    benefits: args.plan,
    vob,
    program: args.partner ?? null,
    days: args.days,
  });
}

export type CaseCostProgram = { key: string; partnerId?: string; programName: string };

/**
 * The programs the case file estimates: the program the family was referred
 * to (when the case's match has one), then every program asked for a VOB,
 * newest first, once each.
 */
export function caseCostPrograms(
  requests: Pick<VobRequest, 'partnerId' | 'programName' | 'requestedAt'>[],
  partners: Pick<Partner, 'id' | 'organization'>[],
  assignedPartnerId?: string,
): CaseCostProgram[] {
  const ordered = [...requests].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  const result: CaseCostProgram[] = [];
  const partnerIds = [assignedPartnerId, ...ordered.map((item) => item.partnerId)].filter((id): id is string => Boolean(id));
  for (const id of partnerIds) {
    if (result.some((item) => item.partnerId === id)) continue;
    const partner = partners.find((item) => item.id === id);
    const name = partner?.organization || ordered.find((item) => item.partnerId === id)?.programName || '';
    if (name) result.push({ key: `partner:${id}`, partnerId: id, programName: name });
  }
  for (const item of ordered) {
    if (item.partnerId || !item.programName.trim()) continue;
    if (result.some((entry) => sameProgramName(entry.programName, item.programName))) continue;
    result.push({ key: `name:${item.programName.trim().toLowerCase()}`, programName: item.programName.trim() });
  }
  return result;
}

// ─── The family's packet ────────────────────────────────────────────────────
// Side by side for the program being sent: with the family's plan, and
// paying privately. Nothing when neither is known. The program's copy never
// gets these lines (buildPacket drops them for that audience).

export function familyCostPacketLines(args: ProgramCostArgs): string[] {
  const days = normalizeStayDays(args.days);
  const insured = args.insurance && args.insurance !== 'Cash pay' ? familyCostForProgram({ ...args, days }) : null;
  const cash = familyCostForProgram({ ...args, insurance: 'Cash pay', days });
  if (!insured?.known && !cash.known) return [];
  const lines = [`ESTIMATED COST TO YOUR FAMILY (${days} DAYS)`];
  if (insured) {
    const route = insured.route === 'in_network' ? ', in-network' : insured.route === 'out_of_network' ? ', out-of-network' : '';
    const value = insured.known ? `${formatCostRange(insured)}${insured.note ? ` (${insured.note})` : ''}` : 'not known yet';
    lines.push(`- With ${args.insurance}${route}: ${value}`);
  }
  lines.push(`- Paying privately: ${cash.known ? formatCostRange(cash) : 'not known yet'}`);
  lines.push(PACKET_COST_DISCLAIMER);
  return lines;
}
