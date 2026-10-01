import { partnerTypes } from '../data';
import type {
  ClientPopulation,
  InsuranceNetworkPreference,
  LocationPreference,
  Partner,
  ReferralMatch,
} from '../data';

// ─── Matching ───────────────────────────────────────────────────────────────
// Pure ranking logic: no React, no Supabase, no side effects, so it runs in
// plain node (scripts/matching-test.mjs) and the app, the Match Packet, and
// the placement record all read the same numbers.
//
// The rule, in order:
//   1. Hard requirements hide a program; they never demote it. Level of care,
//      population, a way to pay, location, and every must-have need.
//   2. A 0-100 fit score from four weighted parts (constants below).
//   3. Ties: lower family cost first, then a rotation seeded by the match
//      profile id (stable for that family, different for the next).
//
// Referral counts (inbound / outbound) and any financial relationship with a
// program are NOT inputs. The functions here never read them.

// ─── Weights (tune here) ────────────────────────────────────────────────────

/** Share of the client's preferred (non-must-have) needs the program offers. */
export const WEIGHT_CLINICAL_FIT = 50;
/** Cost to the family: in-network, out-of-network, or cash under budget. */
export const WEIGHT_FAMILY_COST = 25;
/** Close to family / away from home, from the state on each side. */
export const WEIGHT_LOCATION = 10;
/** Family-experience average and admit rate, shrunk toward the network. */
export const WEIGHT_TRACK_RECORD = 15;
export const MAX_SCORE = WEIGHT_CLINICAL_FIT + WEIGHT_FAMILY_COST + WEIGHT_LOCATION + WEIGHT_TRACK_RECORD;

/** Out-of-network earns this share of the cost points and a "verify benefits" flag. */
export const OUT_OF_NETWORK_COST_SHARE = 0.5;
/** Cash pay at exactly the budget earns this share; the further under budget, the closer to full points. */
export const CASH_AT_BUDGET_COST_SHARE = 0.5;
/** Cash pay with no budget set earns this share (cost still breaks ties). */
export const CASH_NO_BUDGET_COST_SHARE = 0.5;
/** Shrinkage prior: a program's outcomes count as if blended with this many network-average cases. */
export const TRACK_RECORD_PRIOR_CASES = 5;
/** Needs that are must-have unless the clinician says otherwise (medication-assisted treatment). */
export const MUST_HAVE_BY_DEFAULT = ['MAT'];
/** Needs that describe who the client is. Always requirements, never preferences. */
export const POPULATION_NEEDS = ['Men only', 'Women only', 'Adolescent'];

// ─── Partner helpers (shared with App.tsx) ──────────────────────────────────

export function typesForPartner(partner: Partner): Partner['type'][] {
  if (partner.types?.length) return partner.types;
  const legacyTypes = (partner.levels || []).filter((level): level is Partner['type'] => partnerTypes.includes(level as Partner['type']));
  return legacyTypes.length ? legacyTypes : [partner.type];
}

export function monthlyCostForPartner(partner: Partner): number {
  return partner.monthlyCost ?? partner.cashMax ?? partner.cashMin ?? 0;
}

export function networkCapabilitiesForPartner(partner: Partner, insurance: string): InsuranceNetworkPreference[] {
  const explicit = partner.insuranceNetworks?.[insurance];
  if (explicit?.length) return explicit;
  return partner.insurance.includes(insurance) ? ['In-network'] : [];
}

export function hasFinancialRelationship(partner: Pick<Partner, 'financialRelationship'>): boolean {
  return Boolean(partner.financialRelationship && partner.financialRelationship !== 'none');
}

// ─── Population ─────────────────────────────────────────────────────────────

const ADOLESCENT_POPULATIONS = ['Adolescent', 'Adolescents', 'Teens'];
const ADULT_POPULATIONS = ['Adults', 'Men', 'Women'];

export function isMenOnly(partner: Partner): boolean {
  return partner.therapies.includes('Men only') || (partner.populations.includes('Men') && !partner.populations.includes('Women'));
}

export function isWomenOnly(partner: Partner): boolean {
  return partner.therapies.includes('Women only') || (partner.populations.includes('Women') && !partner.populations.includes('Men'));
}

export function servesAdolescents(partner: Partner): boolean {
  return partner.therapies.includes('Adolescent') || partner.populations.some((population) => ADOLESCENT_POPULATIONS.includes(population));
}

/**
 * No population recorded is read as adults (the partner form's default),
 * unless the program lists Adolescent as a need, in which case it is read as
 * adolescent-only: the safer reading for an adult client.
 */
export function servesAdults(partner: Partner): boolean {
  if (partner.populations.some((population) => ADULT_POPULATIONS.includes(population))) return true;
  return partner.populations.length === 0 && !partner.therapies.includes('Adolescent');
}

export function isAdolescentOnly(partner: Partner): boolean {
  return servesAdolescents(partner) && !servesAdults(partner);
}

/** Older profiles carry the population as a selected need; newer ones carry it on the profile. */
export function populationForProfile(profile: Pick<ReferralMatch, 'population' | 'therapies'>): ClientPopulation {
  if (profile.population && profile.population !== 'Any') return profile.population;
  if (profile.therapies.includes('Adolescent')) return 'Adolescent';
  if (profile.therapies.includes('Women only')) return 'Women';
  if (profile.therapies.includes('Men only')) return 'Men';
  return profile.population || 'Any';
}

export function populationFits(population: ClientPopulation, partner: Partner): boolean {
  switch (population) {
    case 'Men':
      return !isWomenOnly(partner) && !isAdolescentOnly(partner);
    case 'Women':
      return !isMenOnly(partner) && !isAdolescentOnly(partner);
    case 'Adolescent':
      return servesAdolescents(partner);
    default:
      return true;
  }
}

// ─── Needs ──────────────────────────────────────────────────────────────────

export function partnerOffersNeed(partner: Partner, need: string): boolean {
  if (need === 'Men only') return partner.therapies.includes(need) || (partner.populations.includes('Men') && !partner.populations.includes('Women'));
  if (need === 'Women only') return partner.therapies.includes(need) || (partner.populations.includes('Women') && !partner.populations.includes('Men'));
  if (need === 'LGBTQ+') return partner.therapies.includes(need) || partner.populations.includes('LGBTQ+');
  if (need === 'Adolescent') return partner.therapies.includes(need) || partner.populations.some((population) => ADOLESCENT_POPULATIONS.includes(population));
  return partner.therapies.includes(need);
}

export function isPopulationNeed(need: string): boolean {
  return POPULATION_NEEDS.includes(need);
}

/** Must-have defaults for a list of selected needs: MAT only. */
export function defaultMustHaveNeeds(therapies: string[]): string[] {
  return therapies.filter((need) => MUST_HAVE_BY_DEFAULT.includes(need));
}

/**
 * The needs a profile requires: its explicit must-haves (or the defaults when
 * the profile predates must-haves) plus every population need, which is
 * always a requirement. Only needs that are actually selected count.
 */
export function mustHaveNeedsForProfile(profile: Pick<ReferralMatch, 'therapies' | 'mustHaveTherapies'>): string[] {
  const explicit = profile.mustHaveTherapies ?? defaultMustHaveNeeds(profile.therapies);
  return profile.therapies.filter((need) => explicit.includes(need) || isPopulationNeed(need));
}

export function preferredNeedsForProfile(profile: Pick<ReferralMatch, 'therapies' | 'mustHaveTherapies'>): string[] {
  const required = mustHaveNeedsForProfile(profile);
  return profile.therapies.filter((need) => !required.includes(need));
}

// ─── Payment ────────────────────────────────────────────────────────────────

export type PaymentFit = {
  paymentFit: boolean;
  networkStatus: InsuranceNetworkPreference | null; // null when cash pay
  /** Cash pay: the monthly cost. Insurance: 0 in-network, 1 out-of-network. Lower wins ties. */
  familyCost: number;
  verifyBenefits: boolean;
  costScore: number;
};

export function paymentFitForPartner(profile: Pick<ReferralMatch, 'insurance' | 'networkPreferences' | 'maxBudget'>, partner: Partner): PaymentFit {
  if (profile.insurance === 'Cash pay') {
    const cost = monthlyCostForPartner(partner);
    const budget = profile.maxBudget && profile.maxBudget > 0 ? profile.maxBudget : null;
    const paymentFit = budget == null || cost <= budget;
    let costScore = 0;
    if (paymentFit) {
      if (budget == null) {
        costScore = WEIGHT_FAMILY_COST * CASH_NO_BUDGET_COST_SHARE;
      } else {
        const underBudget = budget > 0 ? Math.max(0, Math.min(1, 1 - cost / budget)) : 0;
        costScore = WEIGHT_FAMILY_COST * (CASH_AT_BUDGET_COST_SHARE + (1 - CASH_AT_BUDGET_COST_SHARE) * underBudget);
      }
    }
    return { paymentFit, networkStatus: null, familyCost: cost, verifyBenefits: false, costScore };
  }
  const preferences = profile.networkPreferences?.length ? profile.networkPreferences : (['In-network'] as InsuranceNetworkPreference[]);
  const networkCapabilities = networkCapabilitiesForPartner(partner, profile.insurance);
  const isInNetwork = networkCapabilities.includes('In-network');
  const isOutOfNetwork = networkCapabilities.includes('Out-of-network');
  const inNetworkFit = preferences.includes('In-network') && isInNetwork;
  const outOfNetworkFit = preferences.includes('Out-of-network') && isOutOfNetwork;
  const paymentFit = inNetworkFit || outOfNetworkFit;
  const networkStatus: InsuranceNetworkPreference | null = inNetworkFit ? 'In-network' : isOutOfNetwork ? 'Out-of-network' : null;
  const costScore = !paymentFit ? 0 : networkStatus === 'In-network' ? WEIGHT_FAMILY_COST : WEIGHT_FAMILY_COST * OUT_OF_NETWORK_COST_SHARE;
  return {
    paymentFit,
    networkStatus,
    familyCost: networkStatus === 'In-network' ? 0 : 1,
    verifyBenefits: paymentFit && networkStatus === 'Out-of-network',
    costScore,
  };
}

// ─── Location ───────────────────────────────────────────────────────────────

export function regionFitForPartner(profile: Pick<ReferralMatch, 'state'>, partner: Partner): boolean {
  return !profile.state || profile.state === 'ANY' || partner.state === profile.state || partner.regions.includes('Nationwide');
}

/**
 * Distance proxy: the only location data on both sides is the state, so
 * "close" means the program is in the client's state and "away" means it is
 * not. With no client state there is nothing to compare, so the score is
 * neutral (half).
 */
export function locationScore(profile: Pick<ReferralMatch, 'state' | 'locationPreference'>, partner: Partner): { score: number; sameState: boolean | null } {
  const preference: LocationPreference = profile.locationPreference || 'No preference';
  const known = Boolean(profile.state) && profile.state !== 'ANY';
  const sameState = known ? partner.state === profile.state : null;
  if (preference === 'No preference') return { score: WEIGHT_LOCATION, sameState };
  if (sameState === null) return { score: WEIGHT_LOCATION / 2, sameState };
  const wanted = preference === 'Close to family' ? sameState : !sameState;
  return { score: wanted ? WEIGHT_LOCATION : 0, sameState };
}

// ─── Track record ───────────────────────────────────────────────────────────

/** The slice of a partner scorecard the ranking reads. */
export type TrackRecord = {
  admits: number;
  nonAdmits: number;
  avgFamilyExperience: number | null; // 1-5
};

export type TrackRecordPrior = {
  /** Network-average family experience, normalised 0-1 (0.5 when nobody has data). */
  experience: number;
  /** Network-average admit rate, 0-1 (0.5 when nobody has data). */
  admitRate: number;
};

function normaliseExperience(avg: number): number {
  return Math.max(0, Math.min(1, (avg - 1) / 4));
}

/** Case-weighted network averages; the prior every program is shrunk toward. */
export function trackRecordPrior(scorecards: Record<string, TrackRecord | undefined>): TrackRecordPrior {
  let decidedTotal = 0;
  let admitsTotal = 0;
  let experienceWeight = 0;
  let experienceTotal = 0;
  for (const card of Object.values(scorecards)) {
    if (!card) continue;
    const decided = card.admits + card.nonAdmits;
    if (decided <= 0) continue;
    decidedTotal += decided;
    admitsTotal += card.admits;
    if (card.avgFamilyExperience != null) {
      experienceWeight += decided;
      experienceTotal += decided * normaliseExperience(card.avgFamilyExperience);
    }
  }
  return {
    experience: experienceWeight > 0 ? experienceTotal / experienceWeight : 0.5,
    admitRate: decidedTotal > 0 ? admitsTotal / decidedTotal : 0.5,
  };
}

/**
 * 0..WEIGHT_TRACK_RECORD. No decided cases scores neutral (half). Otherwise
 * each signal is blended with TRACK_RECORD_PRIOR_CASES network-average cases,
 * so one great review cannot outrank twenty good ones.
 */
export function trackRecordScore(card: TrackRecord | undefined, prior: TrackRecordPrior): { score: number; decidedCases: number } {
  const decided = card ? card.admits + card.nonAdmits : 0;
  if (!card || decided <= 0) return { score: WEIGHT_TRACK_RECORD / 2, decidedCases: 0 };
  const k = TRACK_RECORD_PRIOR_CASES;
  const admitRate = (card.admits + k * prior.admitRate) / (decided + k);
  const experienceRaw = card.avgFamilyExperience != null ? normaliseExperience(card.avgFamilyExperience) : prior.experience;
  const experience = (decided * experienceRaw + k * prior.experience) / (decided + k);
  return { score: WEIGHT_TRACK_RECORD * (0.5 * experience + 0.5 * admitRate), decidedCases: decided };
}

// ─── Scoring ────────────────────────────────────────────────────────────────

export type ScoreComponents = {
  clinical: number;
  cost: number;
  location: number;
  trackRecord: number;
};

export type Requirement = 'level' | 'population' | 'payment' | 'location' | 'mustHave';

export type ProgramScore = {
  partner: Partner;
  eligible: boolean;
  failedRequirements: Requirement[];
  /** 0-100, the four components summed and rounded to one decimal. */
  total: number;
  components: ScoreComponents;
  /** Must-have needs the program offers (all of them when eligible). */
  requiredNeeds: string[];
  /** Preferred needs the program offers. */
  matchedNeeds: string[];
  /** Preferred needs it does not offer. */
  missingNeeds: string[];
  networkStatus: InsuranceNetworkPreference | null;
  verifyBenefits: boolean;
  familyCost: number;
  regionFit: boolean;
  sameState: boolean | null;
  decidedCases: number;
  disclosure: boolean;
};

export type MatchProfileInput = Pick<ReferralMatch,
  'id' | 'levelOfCare' | 'state' | 'insurance' | 'networkPreferences' | 'maxBudget' | 'therapies' | 'mustHaveTherapies' | 'population' | 'locationPreference'
>;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function scoreProgram(
  profile: MatchProfileInput,
  partner: Partner,
  card: TrackRecord | undefined,
  prior: TrackRecordPrior,
): ProgramScore {
  const failed: Requirement[] = [];
  if (profile.levelOfCare !== 'Any type' && !typesForPartner(partner).includes(profile.levelOfCare)) failed.push('level');
  if (!populationFits(populationForProfile(profile), partner)) failed.push('population');
  const payment = paymentFitForPartner(profile, partner);
  if (!payment.paymentFit) failed.push('payment');
  const regionFit = regionFitForPartner(profile, partner);
  if (!regionFit) failed.push('location');
  const required = mustHaveNeedsForProfile(profile);
  const requiredNeeds = required.filter((need) => partnerOffersNeed(partner, need));
  if (requiredNeeds.length !== required.length) failed.push('mustHave');

  const preferred = preferredNeedsForProfile(profile);
  const matchedNeeds = preferred.filter((need) => partnerOffersNeed(partner, need));
  const missingNeeds = preferred.filter((need) => !matchedNeeds.includes(need));
  const clinical = preferred.length ? WEIGHT_CLINICAL_FIT * (matchedNeeds.length / preferred.length) : WEIGHT_CLINICAL_FIT;
  const location = locationScore(profile, partner);
  const track = trackRecordScore(card, prior);
  const components: ScoreComponents = {
    clinical: round1(clinical),
    cost: round1(payment.costScore),
    location: round1(location.score),
    trackRecord: round1(track.score),
  };
  return {
    partner,
    eligible: failed.length === 0,
    failedRequirements: failed,
    total: round1(components.clinical + components.cost + components.location + components.trackRecord),
    components,
    requiredNeeds,
    matchedNeeds,
    missingNeeds,
    networkStatus: payment.networkStatus,
    verifyBenefits: payment.verifyBenefits,
    familyCost: payment.familyCost,
    regionFit,
    sameState: location.sameState,
    decidedCases: track.decidedCases,
    disclosure: hasFinancialRelationship(partner),
  };
}

// ─── Ties ───────────────────────────────────────────────────────────────────

/** FNV-1a, 32-bit. Small, dependency-free, and stable across platforms. */
export function rotationKey(matchProfileId: string, partnerId: string): number {
  const text = `${matchProfileId}:${partnerId}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export function compareScored(profileId: string, a: ProgramScore, b: ProgramScore): number {
  return b.total - a.total
    || a.familyCost - b.familyCost
    || rotationKey(profileId, a.partner.id) - rotationKey(profileId, b.partner.id)
    || a.partner.id.localeCompare(b.partner.id);
}

/** Eligible programs, best first. Referral counts never enter. */
export function rankPrograms(
  profile: MatchProfileInput,
  partners: Partner[],
  scorecards: Record<string, TrackRecord | undefined>,
): ProgramScore[] {
  const prior = trackRecordPrior(scorecards);
  return partners
    .map((partner) => scoreProgram(profile, partner, scorecards[partner.id], prior))
    .filter((score) => score.eligible)
    .sort((a, b) => compareScored(profile.id, a, b));
}

// ─── Placement record ───────────────────────────────────────────────────────

export const PLACEMENT_CANDIDATES_SHOWN = 5;

export type PlacementCandidate = {
  partnerId: string;
  rank: number;
  total: number;
  components: ScoreComponents;
  disclosure: boolean;
};

export function placementCandidates(ranked: ProgramScore[]): PlacementCandidate[] {
  return ranked.slice(0, PLACEMENT_CANDIDATES_SHOWN).map((score, index) => ({
    partnerId: score.partner.id,
    rank: index + 1,
    total: score.total,
    components: score.components,
    disclosure: score.disclosure,
  }));
}

/** 1-based rank of a partner in the ranked list; one past the end when it was not shown. */
export function rankOfPartner(ranked: { partner: { id: string } }[], partnerId: string): number {
  const index = ranked.findIndex((score) => score.partner.id === partnerId);
  return index >= 0 ? index + 1 : ranked.length + 1;
}

export function scoringWeights() {
  return {
    clinical: WEIGHT_CLINICAL_FIT,
    cost: WEIGHT_FAMILY_COST,
    location: WEIGHT_LOCATION,
    trackRecord: WEIGHT_TRACK_RECORD,
    priorCases: TRACK_RECORD_PRIOR_CASES,
  };
}
