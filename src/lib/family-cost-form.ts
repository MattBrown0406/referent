// The plan editor's and the VOB answer's cost fields: what is typed, and the
// whole-dollar values family-cost.ts estimates from. Amounts are parsed with
// parseWholeDollars (business.ts), like every money field in the app, and
// checked with the same rules as the server (planCostsProblem /
// vobCostsProblem mirror 20261104120000_family_cost.sql).

import { parseWholeDollars } from './business';
import {
  EMPTY_NETWORK_BENEFITS,
  type NetworkBenefits,
  type PlanCosts,
  type VobCosts,
} from './insurance';
import { planCostsProblem, vobCostsProblem } from './family-cost';

export type NetworkBenefitsDraft = Record<keyof NetworkBenefits, string>;

export type PlanCostsDraft = {
  inNetwork: NetworkBenefitsDraft;
  outOfNetwork: NetworkBenefitsDraft;
  oonBenefits: boolean | null;
};

export type VobCostsDraft = {
  allowedDailyRate: string;
  billedDailyRate: string;
  copayPerDay: string;
  precertRequired: boolean | null;
};

/** The five fields of one network, in the order the editor shows them. */
export const NETWORK_BENEFIT_FIELDS: { key: keyof NetworkBenefits; label: string; words: string; placeholder: string }[] = [
  { key: 'deductible', label: 'DEDUCTIBLE', words: 'deductible', placeholder: '3000' },
  { key: 'deductibleMet', label: 'DEDUCTIBLE MET SO FAR', words: 'deductible met so far', placeholder: '500' },
  { key: 'oopMax', label: 'OUT-OF-POCKET MAX', words: 'out-of-pocket max', placeholder: '6000' },
  { key: 'oopMet', label: 'OUT-OF-POCKET MET SO FAR', words: 'out-of-pocket met so far', placeholder: '1200' },
  { key: 'coinsurancePct', label: 'COINSURANCE, % THE FAMILY PAYS', words: 'coinsurance', placeholder: '20' },
];

export const VOB_COST_FIELDS: { key: Exclude<keyof VobCostsDraft, 'precertRequired'>; label: string; words: string; placeholder: string }[] = [
  { key: 'allowedDailyRate', label: 'PLAN’S ALLOWED RATE PER DAY (OPTIONAL)', words: 'allowed rate per day', placeholder: '850' },
  { key: 'billedDailyRate', label: 'PROGRAM’S BILLED RATE PER DAY (OPTIONAL)', words: 'billed rate per day', placeholder: '1400' },
  { key: 'copayPerDay', label: 'COPAY PER DAY (OPTIONAL)', words: 'copay per day', placeholder: '0' },
];

/** Yes / No / Not sure, for "out-of-network benefits?" and "pre-authorization required?". */
export const TRISTATE_OPTIONS: { value: boolean | null; label: string }[] = [
  { value: true, label: 'Yes' },
  { value: false, label: 'No' },
  { value: null, label: 'Not sure' },
];

function text(value: number | null): string {
  return value == null ? '' : String(value);
}

function networkDraft(benefits: NetworkBenefits | null | undefined): NetworkBenefitsDraft {
  const source = benefits || EMPTY_NETWORK_BENEFITS;
  return {
    deductible: text(source.deductible),
    deductibleMet: text(source.deductibleMet),
    oopMax: text(source.oopMax),
    oopMet: text(source.oopMet),
    coinsurancePct: text(source.coinsurancePct),
  };
}

export function planCostsDraft(plan: PlanCosts | null | undefined): PlanCostsDraft {
  return {
    inNetwork: networkDraft(plan?.inNetwork),
    outOfNetwork: networkDraft(plan?.outOfNetwork),
    oonBenefits: plan?.oonBenefits ?? null,
  };
}

export function vobCostsDraft(costs: VobCosts | null | undefined): VobCostsDraft {
  return {
    allowedDailyRate: text(costs?.allowedDailyRate ?? null),
    billedDailyRate: text(costs?.billedDailyRate ?? null),
    copayPerDay: text(costs?.copayPerDay ?? null),
    precertRequired: costs?.precertRequired ?? null,
  };
}

/** "20", "20%" or " 20 % " → 20; blank → null; anything else (decimals, words, over 100) → undefined. */
export function parseWholePercent(input: string): number | null | undefined {
  const value = input.trim();
  if (!value) return null;
  const match = /^(\d{1,3})\s*%?$/.exec(value);
  if (!match) return undefined;
  const percent = Number(match[1]);
  return percent <= 100 ? percent : undefined;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

function parseNetwork(label: string, draft: NetworkBenefitsDraft): Parsed<NetworkBenefits> {
  const value = { ...EMPTY_NETWORK_BENEFITS };
  for (const field of NETWORK_BENEFIT_FIELDS) {
    const typed = draft[field.key] ?? '';
    if (field.key === 'coinsurancePct') {
      const percent = parseWholePercent(typed);
      if (percent === undefined) return { ok: false, message: `${label} coinsurance: enter a whole percent from 0 to 100, like 20, or leave it blank.` };
      value.coinsurancePct = percent;
      continue;
    }
    const parsed = parseWholeDollars(typed);
    if (parsed === undefined) return { ok: false, message: `${label} ${field.words}: enter whole dollars, like 1500 or $1,500, or leave it blank.` };
    value[field.key] = parsed;
  }
  return { ok: true, value };
}

/** The editor's cost fields as whole dollars, or the first problem in plain words. "No" out-of-network benefits clears those amounts. */
export function parsePlanCostsDraft(draft: PlanCostsDraft): Parsed<PlanCosts> {
  const inNetwork = parseNetwork('In-network', draft.inNetwork);
  if (!inNetwork.ok) return inNetwork;
  const outOfNetwork = draft.oonBenefits === false ? { ok: true as const, value: { ...EMPTY_NETWORK_BENEFITS } } : parseNetwork('Out-of-network', draft.outOfNetwork);
  if (!outOfNetwork.ok) return outOfNetwork;
  const value: PlanCosts = { inNetwork: inNetwork.value, outOfNetwork: outOfNetwork.value, oonBenefits: draft.oonBenefits };
  const problem = planCostsProblem(value);
  return problem ? { ok: false, message: problem } : { ok: true, value };
}

export function parseVobCostsDraft(draft: VobCostsDraft): Parsed<VobCosts> {
  const value: VobCosts = { allowedDailyRate: null, billedDailyRate: null, copayPerDay: null, precertRequired: draft.precertRequired };
  for (const field of VOB_COST_FIELDS) {
    const parsed = parseWholeDollars(draft[field.key] ?? '');
    if (parsed === undefined) return { ok: false, message: `The ${field.words}: enter whole dollars, like 850 or $850, or leave it blank.` };
    value[field.key] = parsed;
  }
  const problem = vobCostsProblem(value);
  return problem ? { ok: false, message: problem } : { ok: true, value };
}
