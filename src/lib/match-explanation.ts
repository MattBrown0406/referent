// ─── Why these programs: the family's explanation of a match ────────────────
// Plain language, written from the ranking the Match screen already shows
// (src/lib/matching.ts). It explains the order; it never changes it: the
// programs appear exactly as ranked, and every sentence comes from the same
// numbers the ranker used. Pure (no React, no network), so
// scripts/match-explanation-test.mjs covers it.
//
// With the practitioner's own Anthropic key, the ai-assist function can
// rewrite the intro and each program's "why" in warmer words
// (rewriteFacts / applyRewrite). It gets these facts only, in this order,
// and its answer is checked (supabase/functions/ai-assist/explain.ts). The
// cautions, any financial-relationship disclosure, how the order was decided
// and the closing are never sent for rewriting: the app adds them as written
// here, so they cannot be dropped or softened.
//
// Nothing here names the family or the client: the text is meant to be sent
// to the family, and it may be forwarded.

import { stateOptions } from '../data';
import type { ReferralMatch } from '../data';
import {
  compareBedAvailability,
  compareFamilyCost,
  isPopulationNeed,
  mustHaveNeedsForProfile,
  populationForProfile,
  typesForPartner,
  WEIGHT_CLINICAL_FIT,
  WEIGHT_FAMILY_COST,
  WEIGHT_LOCATION,
  WEIGHT_TRACK_RECORD,
  type ProgramScore,
  type ScoreComponents,
} from './matching';
import { buildFitReasons, disclosureLine, packetFitInput } from './packet';

export const EXPLAIN_DEFAULT = 3;
export const EXPLAIN_MAX = 5;

export type ExplainedProgram = {
  rank: number;
  name: string;
  /** "Inpatient · Detox, Bend, OR" */
  where: string;
  fit: number;
  /** Why it fits, from the same facts as the packet's family copy. */
  reasons: string[];
  /** Why it comes before the next program shown ('' for the last one). */
  order: string;
  /** What the family should check: needs it does not list, benefits, a cost not on file. Never rewritten. */
  cautions: string[];
  /** The financial-relationship disclosure, when there is one. Never rewritten, never left out. */
  disclosure: string;
};

export type MatchExplanation = {
  /** Eligible programs in all. */
  eligible: number;
  intro: string;
  programs: ExplainedProgram[];
  /** How the order is decided. Never rewritten. */
  howRanked: string;
  /** Never rewritten. */
  closing: string;
};

function stateName(code: string): string {
  return stateOptions.find((state) => state.code === code)?.name || code;
}

function joinWords(items: string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function programName(score: ProgramScore): string {
  return score.partner.organization?.trim() || score.partner.name?.trim() || 'This program';
}

// What every program on the list has in common: the requirements it met.
function introFor(profile: ReferralMatch, shown: number, eligible: number): string {
  const met: string[] = [];
  if (profile.levelOfCare !== 'Any type') met.push(`provides ${profile.levelOfCare} care`);
  if (profile.insurance === 'Cash pay') met.push('takes private pay');
  else if (profile.insurance) met.push(`works with ${profile.insurance}`);
  if (profile.state && profile.state !== 'ANY') {
    const state = stateName(profile.state);
    met.push(profile.locationPreference === 'Away from home' ? `can take someone from ${state}` : `serves ${state}`);
  }
  const population = populationForProfile(profile);
  if (population === 'Men') met.push('takes men');
  else if (population === 'Women') met.push('takes women');
  else if (population === 'Adolescent') met.push('takes adolescents');
  const mustHave = mustHaveNeedsForProfile(profile).filter((need) => !isPopulationNeed(need));
  if (mustHave.length) met.push(`offers ${joinWords(mustHave)}`);
  const which = shown === 1 ? 'the program that fits' : `the ${shown} programs that fit`;
  const of = eligible > shown ? `, out of ${eligible} that meet every requirement` : '';
  const each = met.length ? ` ${shown === 1 ? 'It' : 'Each one'} ${joinWords(met)}.` : '';
  return `These are ${which} your loved one's needs best, in order${of}.${each}`;
}

const HOW_RANKED = `How the order was decided: each program gets a fit score out of 100. Up to ${WEIGHT_CLINICAL_FIT} points for offering what your loved one needs, ${WEIGHT_FAMILY_COST} for the cost to your family, ${WEIGHT_LOCATION} for location, and ${WEIGHT_TRACK_RECORD} for how families placed there have done. When two programs tie, a confirmed open bed comes first, then the lower cost to your family. How many people a program refers, and any business relationship with a program, are never part of the score.`;

const CLOSING = 'This is a starting point for our conversation, not a medical decision. Each program confirms admission, an open bed and the cost before anything is final, and you are free to choose any program.';

const COMPONENT_REASON: Record<keyof ScoreComponents, string> = {
  clinical: 'it offers more of what your loved one needs',
  cost: 'it is likely to cost your family less',
  location: 'its location fits what you asked for better',
  trackRecord: 'its track record with families is stronger',
};

const round1 = (value: number) => Math.round(value * 10) / 10;

/** "Disclosure about <program>: our practice has a financial relationship with this program …" */
export function namedDisclosure(name: string, line: string | null): string {
  if (!line) return '';
  return line.startsWith('Disclosure: ') ? `Disclosure about ${name}: ${line.slice('Disclosure: '.length)}` : `${name}: ${line}`;
}

/** Why `a` is listed before `b`, from the same comparison the ranker made (compareScored). */
export function orderReason(a: ProgramScore, b: ProgramScore): string {
  const next = programName(b);
  // A cost that is not on file is listed last, but it is not a higher cost:
  // say what is known, never "costs less" against a cost nobody has.
  const costUnknown = a.familyCost != null && b.familyCost == null;
  if (round1(a.total) === round1(b.total)) {
    if (compareBedAvailability(a, b) < 0) return `It ties with ${next} on fit and comes first because it has a confirmed open bed.`;
    if (costUnknown) return `It ties with ${next} on fit and comes first because its cost to your family is on file and ${next}'s is not yet.`;
    if (compareFamilyCost(a, b) < 0) return `It ties with ${next} on fit and comes first because it is likely to cost your family less.`;
    return `It ties with ${next} on fit; the app sets the order between them fairly.`;
  }
  const keys = Object.keys(COMPONENT_REASON) as (keyof ScoreComponents)[];
  const [best] = keys
    .map((key) => [key, a.components[key] - b.components[key]] as const)
    .sort((left, right) => right[1] - left[1]);
  if (!best || best[1] <= 0.05) return `It ranks above ${next} on overall fit.`;
  if (best[0] === 'cost' && costUnknown) return `It ranks above ${next} mainly because its cost to your family is on file and ${next}'s is not yet.`;
  if (best[0] === 'cost' && a.familyCost == null) return `It ranks above ${next} on overall fit.`;
  return `It ranks above ${next} mainly because ${COMPONENT_REASON[best[0]]}.`;
}

// A fit reason that is really something to check moves to the cautions.
const CAUTION_REASON = /verify benefits|not on file|confirm it/i;

/**
 * The explanation of the first `shown` programs, in ranked order. `ranked`
 * must be the Match screen's own list (rankPrograms), unchanged.
 */
export function explainMatches(profile: ReferralMatch, ranked: ProgramScore[], shown = EXPLAIN_DEFAULT): MatchExplanation {
  const count = Math.max(1, Math.min(EXPLAIN_MAX, Math.floor(shown) || EXPLAIN_DEFAULT));
  const list = ranked.slice(0, count);
  const programs = list.map((score, index): ExplainedProgram => {
    const partner = score.partner;
    const fitReasons = buildFitReasons(profile, partner, packetFitInput(score, profile), 'family');
    const reasons = fitReasons.filter((line) => !CAUTION_REASON.test(line));
    const cautions = fitReasons.filter((line) => CAUTION_REASON.test(line));
    if (score.bedAvailability === true) reasons.push('Has a confirmed open bed');
    if (score.missingNeeds.length) cautions.push(`Does not list ${joinWords(score.missingNeeds)}: ask the program`);
    if (score.verifyBenefits && !cautions.some((line) => /verify benefits/i.test(line))) {
      cautions.push('Out of network: check your benefits before deciding');
    }
    const place = [partner.city, partner.state].filter((part) => part?.trim()).join(', ');
    const kind = typesForPartner(partner).join(' · ');
    return {
      rank: index + 1,
      name: programName(score),
      where: [kind, place].filter(Boolean).join(', '),
      fit: Math.round(score.total),
      reasons,
      order: index < list.length - 1 ? orderReason(score, list[index + 1]) : '',
      cautions,
      // Named, so two programs' disclosures are never the same words and
      // each one is checked for on its own (withDisclosures).
      disclosure: namedDisclosure(programName(score), disclosureLine(partner)),
    };
  });
  return {
    eligible: ranked.length,
    intro: list.length ? introFor(profile, list.length, ranked.length) : 'No program meets every requirement yet.',
    programs,
    howRanked: HOW_RANKED,
    closing: CLOSING,
  };
}

// ─── The rewrite (with the practitioner's own key) ──────────────────────────

/** What is sent for rewriting: no cautions, disclosures, names of people, or the closing. */
export type RewriteFacts = {
  intro: string;
  programs: { rank: number; name: string; where: string; fit: number; reasons: string[]; order: string }[];
};

/** `madeFrom`: the facts it was written from (factsKey), so a rewrite is never used once they change. */
export type Rewrite = { intro: string; programs: { rank: number; text: string }[]; madeFrom?: string };

/** The facts a rewrite is made from, as one string to compare. */
export function factsKey(explanation: MatchExplanation): string {
  return JSON.stringify(rewriteFacts(explanation));
}

export function rewriteFacts(explanation: MatchExplanation): RewriteFacts {
  return {
    intro: explanation.intro,
    programs: explanation.programs.map(({ rank, name, where, fit, reasons, order }) => ({ rank, name, where, fit, reasons, order })),
  };
}

// As the ai-assist function compares (supabase/functions/ai-assist/common.ts): any alphabet, accents dropped, ł ø ß folded.
const FOLD: Record<string, string> = { 'ł': 'l', 'ø': 'o', 'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'đ': 'd', 'þ': 'th', 'ı': 'i' };
const loose = (value: string) => ` ${value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[łøßæœđþı]/g, (letter) => FOLD[letter] ?? letter).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

/**
 * The rewrite fits only the explanation it was made for: the same facts
 * (when it says which), the same programs in the same order, each paragraph
 * naming its own program. A rewrite made before the ranking or its facts
 * changed is not used.
 */
export function rewriteMatches(explanation: MatchExplanation, rewrite: Rewrite | null): boolean {
  if (!rewrite || rewrite.programs.length !== explanation.programs.length) return false;
  // Made from other facts (a fit, a bed or a cost changed since): its words may be wrong now.
  if (rewrite.madeFrom !== undefined && rewrite.madeFrom !== factsKey(explanation)) return false;
  return rewrite.programs.every((item, index) => {
    const program = explanation.programs[index];
    return item.rank === program.rank && item.text.trim().length > 0 && loose(item.text).includes(loose(program.name));
  });
}

// ─── The text the family gets ───────────────────────────────────────────────

function deterministicWhy(program: ExplainedProgram): string {
  const why = program.reasons.length ? `Why it fits: ${program.reasons.join('; ')}.` : 'It meets every requirement.';
  return [why, program.order].filter(Boolean).join(' ');
}

/**
 * The explanation as plain text, ready to send. With a rewrite that matches
 * (rewriteMatches), its words replace the intro and each "why"; the cautions,
 * disclosures, how the order was decided and the closing stay as written.
 */
export function explanationText(explanation: MatchExplanation, rewrite: Rewrite | null = null): string {
  const use = rewriteMatches(explanation, rewrite) ? rewrite : null;
  const parts: string[] = ['Why these programs', use ? use.intro.trim() || explanation.intro : explanation.intro];
  explanation.programs.forEach((program, index) => {
    const lines = [`${program.rank}. ${program.name}${program.where ? ` (${program.where})` : ''} · fit ${program.fit} of 100`];
    lines.push(use ? use.programs[index].text.trim() : deterministicWhy(program));
    if (program.cautions.length) lines.push(`To check: ${program.cautions.join('; ')}.`);
    if (program.disclosure) lines.push(program.disclosure);
    parts.push(lines.join('\n'));
  });
  parts.push(explanation.howRanked, explanation.closing);
  return parts.join('\n\n');
}

/**
 * The disclosures must reach the family even when the practitioner edits
 * the text: any that are no longer there word for word are added back at
 * the end (as withDisclosure does for the packet).
 */
export function withDisclosures(text: string, explanation: MatchExplanation): { text: string; added: number } {
  const missing = explanation.programs.filter((program) => program.disclosure && !text.includes(program.disclosure));
  if (!missing.length) return { text, added: 0 };
  const lines = missing.map((program) => program.disclosure);
  return { text: `${text.trimEnd()}\n\n${lines.join('\n\n')}`, added: missing.length };
}
