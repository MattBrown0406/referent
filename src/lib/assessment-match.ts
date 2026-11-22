// From a finished family assessment to the Match form (Matt, 2026-11-21).
//
// The family already told the practice who their loved one is, how they
// pay and what they hope for. This reads those answers into the Match
// form's own fields so the ranked list is there at once, and says, line by
// line, what came from which answer. Nothing here ranks or saves anything:
// the practitioner sees the form filled in, checks it, and saves as usual.
//
// Rules (kept narrow on purpose, so a field is filled only when an answer
// says so plainly):
//   - population: under 18 is Adolescent; otherwise the gender answer (Male
//     is Men, Female is Women). Men and Women hide only programs for the
//     other group. "Men only" / "Women only" are never added from the
//     family's words (they are requirements and would hide every co-ed
//     program): a request for gender-specific care is "to check".
//   - needs are added as preferences (they raise a program, never hide
//     one), from plain answers and from the family's preferences, skipping
//     any clause that says no to it ("no faith-based programs"). MAT is
//     never added on its own: it is a must-have by default and would hide
//     programs, so it is listed under "to check" instead.
//   - payment: the case's plan on file wins (as "Find placement" already
//     does); otherwise the carrier the family typed, when it names one the
//     form lists. The family's budget is for the whole stay, and the Match
//     budget is per month, so it is "to check", never filled in. State
//     Medicaid and a carrier the form does not list are "to check".
//   - level of care: the level chosen on the case's own level-of-care
//     rating, never a guess from the answers.
//
// Pure (no React, no Supabase): scripts/assessment-match-test.mjs.

import type { ClientPopulation } from '../data';
import type { Answers } from './assessment-schema';

export type AssessmentMatchInput = {
  answers: Answers;
  /** The carrier on the case's Benefits, if any. */
  planCarrier?: string;
  /** The level chosen on the case's level-of-care rating, if any. */
  ratedLevel?: string | null;
  /** The payment choices the form offers (for the case's state, or every state). */
  insuranceOptions: string[];
  /** The needs the form offers (therapyOptions). */
  needOptions: string[];
};

export type AssessmentMatch = {
  population: ClientPopulation;
  /** Needs to select, every one a preference unless it is a population need. */
  needs: string[];
  /** A payment choice from insuranceOptions (or the case's plan), or 'Cash pay' when the answers name none. */
  insurance: string;
  /** The rated level, when there is one. */
  levelOfCare: string | null;
  /** What was filled in, and from which answer, in plain words. */
  used: string[];
  /** What the answers raise that the form cannot decide on its own. */
  toCheck: string[];
};

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const yes = (value: unknown): boolean => value === 'yes' || value === true;

/** Common ways families write a carrier, mapped to the form's name for it. */
const CARRIER_ALIASES: { pattern: RegExp; name: string }[] = [
  { pattern: /\b(bcbs|blue\s*cross|blue\s*shield|bluecross|blueshield)\b/i, name: 'Blue Cross' },
  { pattern: /\b(uhc|united\s*health\s*care|unitedhealthcare|united\s*healthcare|optum)\b/i, name: 'UnitedHealthcare' },
  { pattern: /\bkaiser\b/i, name: 'Kaiser Permanente' },
  { pattern: /\bmolina\b/i, name: 'Molina Healthcare' },
  { pattern: /\boscar\b/i, name: 'Oscar Health' },
  { pattern: /\btri[\s-]?care\b/i, name: 'Tricare' },
  { pattern: /\baetna\b/i, name: 'Aetna' },
  { pattern: /\bcigna\b/i, name: 'Cigna' },
  { pattern: /\bhumana\b/i, name: 'Humana' },
  { pattern: /\banthem\b/i, name: 'Anthem' },
  { pattern: /\bambetter\b/i, name: 'Ambetter' },
];

/** The form's payment choice the family's typed carrier names, or null. */
export function carrierFromText(typed: string, options: string[]): string | null {
  const value = typed.trim();
  if (!value) return null;
  const lower = value.toLowerCase();
  // The form's own names first, longest first ("Aetna Better Health of Ohio" before "Aetna").
  const named = options
    .filter((option) => option !== 'Cash pay')
    .slice()
    .sort((a, b) => b.length - a.length)
    .find((option) => lower === option.toLowerCase() || lower.includes(option.toLowerCase()));
  if (named) return named;
  for (const alias of CARRIER_ALIASES) {
    if (alias.pattern.test(value) && options.includes(alias.name)) return alias.name;
  }
  return null;
}

const BUDGET_LABELS: Record<string, string> = {
  '10000-15000': '$10,000 - $15,000',
  '15000-20000': '$15,000 - $20,000',
  '20000-30000': '$20,000 - $30,000',
  '30000-40000': '$30,000 - $40,000',
  '40000-50000': '$40,000 - $50,000',
  '50000+': '$50,000+',
};

/** Needs the family's own words ask for ("Treatment preferences or requirements"). */
const PREFERENCE_NEEDS: { pattern: RegExp; need: string }[] = [
  { pattern: /\b(faith|christian|spiritual|church|jewish|catholic)\b/i, need: 'Faith based' },
  { pattern: /\b(lgbt|lgbtq|gay|lesbian|trans|queer)\b/i, need: 'LGBTQ+' },
  { pattern: /\bemdr\b/i, need: 'EMDR' },
  { pattern: /\bdbt\b/i, need: 'DBT' },
  { pattern: /\bcbt\b/i, need: 'CBT' },
  { pattern: /\bifs\b|internal family systems/i, need: 'IFS' },
  { pattern: /\b(equine|horse)/i, need: 'Equine' },
  { pattern: /\b(adventure|wilderness|outdoor)/i, need: 'Adventure' },
  { pattern: /\bfamily (program|therapy|systems|work)\b/i, need: 'Family systems' },
  { pattern: /\btrauma\b/i, need: 'Trauma' },
  { pattern: /\b(eating disorder|anorexia|bulimia|binge eating)/i, need: 'Eating disorders' },
  { pattern: /\bgambl/i, need: 'Gambling' },
];

/** Words that turn a clause into a "no" ("no wilderness", "does not need EMDR"). */
const NEGATION = /\b(no|not|never|none|nothing|without|avoid(s|ed|ing)?|against|dont|doesnt|isnt|wont|cant|cannot|refus(e|es|ed|ing)|hat(e|es|ed|ing)|dislik(e|es|ed|ing)|rather not|instead of|other than|except)\b|n't\b|\bnon[\s-]?(faith|spiritual|religious|christian|denominational\s+only|12[\s-]?step|wilderness|outdoor|equine|clinical)/i;

/** Everyday words that start with "non" and mean yes: "non-denominational", "non-negotiable". */
const NON_YES = /\bnon[\s-]?(denominational|negotiable|profit|judg\w*)/gi;

/** The family's preferences as clauses, keeping only the ones that ask for something. */
export function wantedClauses(preferences: string): string[] {
  return preferences
    // "Anything but X" is a no to X; then each sentence, and each side of a
    // "but", stands alone (never split on "and": "doesn't need EMDR and DBT").
    .replace(/\banything but\b/gi, 'not')
    .replace(NON_YES, (word) => word.replace(/^non[\s-]?/i, ''))
    .split(/[.,;:!?\n]+|\s[-–—]\s|[–—]|\b(?:but|though|although|however|whereas)\b/i)
    .map((clause) => clause.trim())
    .filter((clause) => clause && !NEGATION.test(clause.replace(/’/g, "'")));
}

const GENDER_SPECIFIC = /\b(gender[\s-]?specific|single[\s-]?gender|same[\s-]?gender|men[\s-]?only|male[\s-]?only|women[\s-]?only|female[\s-]?only|all[\s-]?(male|men|female|women))\b/i;

/** Opioids or alcohol named anywhere in the substance answers. */
function namesOpioidsOrAlcohol(answers: Answers): boolean {
  const pattern = /\b(opioid|opiate|heroin|fentanyl|oxy|percocet|vicodin|hydrocodone|morphine|methadone|suboxone|buprenorphine|kratom|alcohol|drinking|beer|wine|vodka|liquor)/i;
  if (pattern.test(text(answers.primarySubstances))) return true;
  const list = Array.isArray(answers.substancesUsed) ? answers.substancesUsed : [];
  return list.some((row) => {
    if (!row || typeof row !== 'object') return false;
    return pattern.test(text((row as Record<string, unknown>).substance));
  });
}

function age(answers: Answers): number | null {
  const raw = answers.age;
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  return Number.isFinite(value) && value > 0 && value < 120 ? Math.floor(value) : null;
}

export function matchFromAssessment(input: AssessmentMatchInput): AssessmentMatch {
  const { answers, needOptions, insuranceOptions } = input;
  const used: string[] = [];
  const toCheck: string[] = [];
  const needs: string[] = [];
  const addNeed = (need: string, why: string) => {
    if (!needOptions.includes(need) || needs.includes(need)) return;
    needs.push(need);
    used.push(`${need}: ${why}`);
  };

  // Who: population.
  let population: ClientPopulation = 'Any';
  const years = age(answers);
  const gender = text(answers.gender);
  if (years !== null && years < 18) {
    population = 'Adolescent';
    used.push(`Adolescent: age ${years}`);
  } else if (gender === 'male') {
    population = 'Men';
    used.push('Men: gender Male');
  } else if (gender === 'female') {
    population = 'Women';
    used.push('Women: gender Female');
  }

  const preferences = text(answers.treatmentPreferences);
  const wanted = wantedClauses(preferences);
  if (wanted.some((clause) => GENDER_SPECIFIC.test(clause))) {
    toCheck.push(population === 'Men'
      ? 'The family may want gender-specific care: add Men only if so (it hides co-ed programs).'
      : population === 'Women'
        ? 'The family may want gender-specific care: add Women only if so (it hides co-ed programs).'
        : 'The family may want gender-specific care: choose Men only or Women only if that fits.');
  }

  // Needs from the answers.
  if (text(answers.traumaHistory) === 'yes') addNeed('Trauma', 'a history of trauma');
  if (yes(answers.psychiatricHistory) || yes(answers.mentalHealthSigns)) {
    addNeed('Dual diagnosis', yes(answers.psychiatricHistory) ? 'psychiatric diagnoses or hospital stays' : 'signs of depression, anxiety or a mood disorder');
  }
  if (yes(answers.chronicPain)) addNeed('Chronic pain', 'chronic pain');
  const programs = Array.isArray(answers.treatmentHistory) ? answers.treatmentHistory.filter((row) => row && typeof row === 'object') : [];
  if (programs.length >= 2) addNeed('Chronic relapse', `${programs.length} programs before`);
  for (const rule of PREFERENCE_NEEDS) {
    if (wanted.some((clause) => rule.pattern.test(clause))) addNeed(rule.need, 'the family’s treatment preferences');
  }
  if (/\bgambl/i.test(text(answers.primarySubstances))) addNeed('Gambling', 'named as a concern');

  if (namesOpioidsOrAlcohol(answers)) toCheck.push('Opioids or alcohol are named: add MAT if your loved one needs medication (it hides programs without it).');
  if (yes(answers.seizureHistory) || yes(answers.deliriumTremensHistory)) toCheck.push('Seizures or DTs in withdrawal: medical detox may need to come first.');

  // How they pay.
  let insurance = 'Cash pay';
  const planCarrier = (input.planCarrier || '').trim();
  const typedCarrier = text(answers.insuranceProvider);
  if (planCarrier) {
    insurance = planCarrier;
    used.push(`${planCarrier}: the plan on the case’s Benefits`);
    if (!insuranceOptions.includes(planCarrier)) {
      const named = carrierFromText(planCarrier, insuranceOptions);
      toCheck.push(named
        ? `The plan on Benefits, “${planCarrier.slice(0, 60)}”, is not one of Match’s plan names: choose ${named} if that is the plan.`
        : `The plan on Benefits, “${planCarrier.slice(0, 60)}”, is not one of Match’s plan names, so programs may not show as in network: choose the closest plan.`);
    }
  } else if (typedCarrier) {
    const named = carrierFromText(typedCarrier, insuranceOptions);
    if (named) {
      insurance = named;
      used.push(`${named}: the family wrote “${typedCarrier.slice(0, 60)}”`);
    } else {
      toCheck.push(`The family wrote “${typedCarrier.slice(0, 60)}” for insurance: choose the plan by hand.`);
    }
  }
  if (yes(answers.stateMedicaid) && insurance === 'Cash pay') {
    toCheck.push('State Medicaid: pick the state, then its Medicaid plan.');
  }
  const budgetValue = text(answers.budgetForTreatment);
  if (BUDGET_LABELS[budgetValue]) {
    toCheck.push(`The family’s budget is ${BUDGET_LABELS[budgetValue]} for the whole stay. Match’s budget is per month, so set it by hand if you use one.`);
  }

  // Level of care: only from the practitioner's own rating.
  const levelOfCare = input.ratedLevel ? input.ratedLevel : null;
  if (levelOfCare) used.push(`${levelOfCare}: the level you chose on the level-of-care rating`);
  else toCheck.push('No level of care yet: rate it from the assessment for a closer match.');

  if (!used.length) toCheck.unshift('Nothing in the answers fills in the form on its own.');
  return { population, needs, insurance, levelOfCare, used, toCheck };
}
