import type { PartnerType, ReferralMatch } from '../data';
import { identifyingTextProblem } from './identifying-text';

// ─── Level-of-care assessment: the pure rules ───────────────────────────────
// A short, structured intake across six areas gives a recommended level of
// care and a written rationale. The six areas follow the widely used
// six-dimension framework for substance-use placement; every question,
// descriptor, rule and sentence here is ReferralFit's own wording. Nothing is
// copied from any licensed criteria, scale or decision rule.
//
// DECISION SUPPORT, NOT A DIAGNOSIS. The recommendation is a starting point
// for the practitioner's clinical judgment. They can always choose a
// different level; when they do, they say why in one line, and that reason
// travels with the rationale.
//
// Everything here is dependency-free (no React, Supabase or storage) so it
// runs in plain node (scripts/level-of-care-test.mjs). The server applies the
// same rules (public.level_of_care_recommendation in
// supabase/migrations/20261104150000_level_of_care.sql) and refuses to save
// a recommendation that does not match them; both test suites check a digest
// of every one of the 15,625 possible rating sets, so the two cannot drift.
//
// Matching reads only the CHOSEN level, as the match's levelOfCare (which the
// practitioner could always set by hand). Scores and ranking never read
// anything else from here.

// ─── The six areas ──────────────────────────────────────────────────────────

export type DimensionKey = 'withdrawal' | 'physical' | 'emotional' | 'readiness' | 'relapse' | 'environment';

/** In the order the sheet asks them and the server stores them (p_ratings[1..6]). */
export const DIMENSION_KEYS: DimensionKey[] = ['withdrawal', 'physical', 'emotional', 'readiness', 'relapse', 'environment'];

export type Rating = 0 | 1 | 2 | 3 | 4;
export const RATINGS: Rating[] = [0, 1, 2, 3, 4];
export type Ratings = Record<DimensionKey, Rating>;

/** The word each rating stands for in a sentence: "significant relapse risk (3 of 4)". */
export const RATING_WORDS: Record<Rating, string> = { 0: 'none', 1: 'mild', 2: 'moderate', 3: 'significant', 4: 'severe' };

export const NOTE_MAX = 200;
export const REASON_MAX = 200;
export const REASON_MIN = 3;

export type DimensionInfo = {
  key: DimensionKey;
  /** 1-6, as practitioners number the six areas. */
  number: number;
  title: string;
  /** What the area covers, one line. */
  covers: string;
  /** Lower case, for sentences: "significant <phrase> (3 of 4)". */
  phrase: string;
  /** For each rating 0-4: a short label and what it looks like. Our own words. */
  ratings: Record<Rating, { label: string; descriptor: string }>;
};

export const DIMENSIONS: Record<DimensionKey, DimensionInfo> = {
  withdrawal: {
    key: 'withdrawal',
    number: 1,
    title: 'Withdrawal risk',
    covers: 'How risky it would be to stop or cut down now, and whether withdrawal has already started.',
    phrase: 'withdrawal risk',
    ratings: {
      0: { label: 'None', descriptor: 'No recent heavy use and no signs of withdrawal.' },
      1: { label: 'Mild', descriptor: 'Some discomfort is likely if use stops; it can be handled at home.' },
      2: { label: 'Moderate', descriptor: 'Withdrawal is likely to be hard; a medical provider should keep an eye on it.' },
      3: { label: 'Significant', descriptor: 'Heavy daily use of alcohol, sedatives or opioids, or a hard withdrawal before; needs medically supervised withdrawal.' },
      4: { label: 'Severe', descriptor: 'Dangerous withdrawal now or expected: seizures, confusion or hallucinations, now or in the past. Needs medical care today.' },
    },
  },
  physical: {
    key: 'physical',
    number: 2,
    title: 'Physical health',
    covers: 'Medical conditions, injuries, pregnancy or pain that affect safety or treatment.',
    phrase: 'physical health needs',
    ratings: {
      0: { label: 'None', descriptor: 'No health problems that affect treatment.' },
      1: { label: 'Mild', descriptor: 'Stable conditions the client manages on their own.' },
      2: { label: 'Moderate', descriptor: 'Conditions that need regular attention but are stable, such as managed diabetes or chronic pain.' },
      3: { label: 'Significant', descriptor: 'Conditions that need close medical monitoring or nursing care during treatment.' },
      4: { label: 'Severe', descriptor: 'An unstable or sudden medical problem that a doctor needs to see before placement.' },
    },
  },
  emotional: {
    key: 'emotional',
    number: 3,
    title: 'Emotional, behavioral or cognitive',
    covers: 'Mental health, mood, behavior and thinking, including whether the client can stay safe.',
    phrase: 'emotional, behavioral or cognitive needs',
    ratings: {
      0: { label: 'None', descriptor: 'No mental health or behavior concerns.' },
      1: { label: 'Mild', descriptor: 'Some stress, low mood or worry that does not get in the way of daily life.' },
      2: { label: 'Moderate', descriptor: 'Symptoms that get in the way of daily life or recovery and need care alongside treatment.' },
      3: { label: 'Significant', descriptor: 'Serious symptoms or behavior that need daily support or psychiatric care.' },
      4: { label: 'Severe', descriptor: 'Cannot stay safe or manage day to day: for example, thoughts of suicide with a plan, losing touch with reality, or violence.' },
    },
  },
  readiness: {
    key: 'readiness',
    number: 4,
    title: 'Readiness and engagement',
    covers: 'How willing the client is to take part in treatment. A higher rating means less ready.',
    phrase: 'readiness and engagement concerns',
    ratings: {
      0: { label: 'Ready', descriptor: 'Wants help and is already taking steps toward it.' },
      1: { label: 'Mostly ready', descriptor: 'Agrees to treatment, with some doubts.' },
      2: { label: 'Unsure', descriptor: 'Goes along when family or others push; follow-through is uneven.' },
      3: { label: 'Reluctant', descriptor: 'Does not see a problem, or turns down most help.' },
      4: { label: 'Refusing', descriptor: 'Rejects treatment outright, or is required to attend with no buy-in at all.' },
    },
  },
  relapse: {
    key: 'relapse',
    number: 5,
    title: 'Relapse or continued-use risk',
    covers: 'How likely use is to continue, or come back, without more structure.',
    phrase: 'relapse or continued-use risk',
    ratings: {
      0: { label: 'Low', descriptor: 'A steady stretch without use and solid ways of coping.' },
      1: { label: 'Some', descriptor: 'Occasional cravings, mostly handled.' },
      2: { label: 'Moderate', descriptor: 'Recent use or strong cravings; few ways of coping.' },
      3: { label: 'Significant', descriptor: 'Likely to keep using without structure every day.' },
      4: { label: 'Severe', descriptor: 'Cannot stop even for a short time without round-the-clock structure, or keeps relapsing soon after treatment.' },
    },
  },
  environment: {
    key: 'environment',
    number: 6,
    title: 'Recovery environment',
    covers: 'Where the client lives, the people around them, work or school, and who supports recovery.',
    phrase: 'recovery environment concerns',
    ratings: {
      0: { label: 'Supportive', descriptor: 'A stable home without substances, with people who back recovery.' },
      1: { label: 'Mostly supportive', descriptor: 'Some stress at home or a few gaps in support.' },
      2: { label: 'Mixed', descriptor: 'Substances or conflict at home, or few people to lean on.' },
      3: { label: 'Unsupportive', descriptor: 'Home or friends work against recovery, or housing is unstable.' },
      4: { label: 'Unsafe', descriptor: 'Violence, abuse or active use at home, or no safe place to live.' },
    },
  },
};

// ─── Levels of care ─────────────────────────────────────────────────────────

/** The partner types that are levels of care. 'Interventionist' is not one. */
export type PlacementLevel = Extract<PartnerType, 'Detox' | 'Inpatient' | 'IOP / PHP' | 'Sober Living' | 'Therapist'>;
export const PLACEMENT_LEVELS: PlacementLevel[] = ['Detox', 'Inpatient', 'IOP / PHP', 'Sober Living', 'Therapist'];

/** The treatment levels the rules choose between, least to most intensive. */
export type PrimaryLevel = Extract<PlacementLevel, 'Therapist' | 'IOP / PHP' | 'Inpatient'>;
export const PRIMARY_LEVELS: PrimaryLevel[] = ['Therapist', 'IOP / PHP', 'Inpatient'];

export const LEVEL_LABELS: Record<PlacementLevel, string> = {
  Detox: 'Detox (medically supervised withdrawal)',
  Inpatient: 'Inpatient (residential)',
  'IOP / PHP': 'IOP / PHP (intensive outpatient or day treatment)',
  'Sober Living': 'Sober living',
  Therapist: 'Outpatient therapy',
};

export function isPlacementLevel(value: unknown): value is PlacementLevel {
  return typeof value === 'string' && (PLACEMENT_LEVELS as string[]).includes(value);
}

// ─── THE RULES (one table; a clinician can review and adjust it here) ───────
//
// Read it like this. Every area is rated 0 (none) to 4 (severe). Version 2:
// Matt's clinical decisions of 2026-11-05 (oversight, the moderate rule in
// together, and firstStep.stepDownAtLeast) on top of version 1.
//
//   primary    Areas 2-6: the treatment level each rating asks for ON ITS
//              OWN. The recommended level is the most intensive any rule
//              asks for.
//   together   Some risks that each ask for less add up to 24-hour structure
//              (Inpatient):
//                serious   two or more of readiness, relapse and environment
//                          rated 3 or 4;
//                moderate  four or more of physical, emotional, readiness,
//                          relapse and environment rated 2 or more.
//   oversight  Withdrawal rated 2 or more needs medical oversight, so the
//              level is at least IOP / PHP.
//   firstStep  Withdrawal rated 3 or 4: medically supervised withdrawal
//              (Detox) comes first, then the level, which is never lower
//              than stepDownAtLeast (IOP / PHP): after detox, step down no
//              lower than intensive outpatient.
//   support    Environment rated 3 or 4: sober living is added as a support
//              level (a stable place to live, during or after treatment).
//
// Physical 4 and emotional 4 stay Inpatient (the primary table), with their
// urgent safety flags below. There is no emergency first step (Matt's
// decision): emergencies go to 911 / 988 through the flags.
//
// Every rule only ever moves UP as a rating rises, so raising any rating can
// never lower what is recommended (the test checks all 15,625 rating sets).
//
// Changing a rule? Change it here AND in public.level_of_care_recommendation
// (the migration), bump `version` in both, and update the digest the two test
// suites share. A server that does not know the app's version refuses to
// save, rather than store a recommendation it cannot check.

const OP: PrimaryLevel = 'Therapist';
const IOP: PrimaryLevel = 'IOP / PHP';
const IN: PrimaryLevel = 'Inpatient';

/** Areas that add up: when `count` or more of `dimensions` are rated `atOrAbove` or higher, `level` at least. */
export type TogetherRule = { key: 'serious' | 'moderate'; dimensions: readonly DimensionKey[]; atOrAbove: Rating; count: number; level: PrimaryLevel };

export type RulesTable = {
  version: number;
  primary: Record<Exclude<DimensionKey, 'withdrawal'>, readonly [PrimaryLevel, PrimaryLevel, PrimaryLevel, PrimaryLevel, PrimaryLevel]>;
  together: readonly TogetherRule[];
  oversight: { dimension: DimensionKey; atOrAbove: Rating; level: PrimaryLevel };
  firstStep: { dimension: DimensionKey; atOrAbove: Rating; level: 'Detox'; stepDownAtLeast: PrimaryLevel };
  support: { dimension: DimensionKey; atOrAbove: Rating; level: 'Sober Living' };
};

export const LEVEL_OF_CARE_RULES: RulesTable = {
  version: 2,
  primary: {
    //            rated 0   1    2    3    4
    // Medical needs that need monitoring or nursing call for 24-hour care.
    physical: [OP, OP, IOP, IN, IN],
    // Mental health needing daily support or psychiatric care: 24-hour care.
    emotional: [OP, OP, IOP, IN, IN],
    // Low readiness asks for more structure and engagement work, never on
    // its own for residential care.
    readiness: [OP, OP, OP, IOP, IOP],
    // Use likely to continue: daily structure; unable to stop at all: 24-hour.
    relapse: [OP, OP, IOP, IOP, IN],
    // An unsupportive home (3) adds sober living (support, below); an unsafe
    // one (4) also calls for 24-hour care away from it.
    environment: [OP, OP, OP, OP, IN],
  },
  together: [
    { key: 'serious', dimensions: ['readiness', 'relapse', 'environment'], atOrAbove: 3, count: 2, level: IN },
    { key: 'moderate', dimensions: ['physical', 'emotional', 'readiness', 'relapse', 'environment'], atOrAbove: 2, count: 4, level: IN },
  ],
  oversight: { dimension: 'withdrawal', atOrAbove: 2, level: IOP },
  firstStep: { dimension: 'withdrawal', atOrAbove: 3, level: 'Detox', stepDownAtLeast: IOP },
  support: { dimension: 'environment', atOrAbove: 3, level: 'Sober Living' },
};

export const RULES_VERSION = LEVEL_OF_CARE_RULES.version;

// ─── The recommendation ─────────────────────────────────────────────────────

export type Recommendation = {
  /** The treatment level (after any first step). */
  level: PrimaryLevel;
  /** 'Detox' when withdrawal comes first, else null. */
  firstStep: 'Detox' | null;
  /** 'Sober Living' as a support level, else null. */
  support: 'Sober Living' | null;
  /**
   * The areas the rationale names as the reason for `level`, in area order:
   * the areas that ask for it on their own (with the areas of a serious
   * `together` rule that also gives it); else the areas of the `together`
   * rule that gives it; else withdrawal, when only its floor (oversight, or
   * the step down after detox) gives it. Empty for outpatient therapy.
   */
  drivers: DimensionKey[];
  /** The `together` rule the level sentence names (no area asks for `level` on its own), else null. */
  together: TogetherRule['key'] | null;
  /** 'oversight' or 'stepDown' when only a withdrawal floor gives `level`, else null. */
  floor: 'oversight' | 'stepDown' | null;
};

const PRIMARY_RANK: Record<PrimaryLevel, number> = { Therapist: 1, 'IOP / PHP': 2, Inpatient: 3 };

export function primaryRank(level: PrimaryLevel): number {
  return PRIMARY_RANK[level];
}

export function isRating(value: unknown): value is Rating {
  return value === 0 || value === 1 || value === 2 || value === 3 || value === 4;
}

function byArea(a: DimensionKey, b: DimensionKey): number {
  return DIMENSION_KEYS.indexOf(a) - DIMENSION_KEYS.indexOf(b);
}

export function recommend(ratings: Ratings, rules: RulesTable = LEVEL_OF_CARE_RULES): Recommendation {
  let level: PrimaryLevel = OP;
  const raise = (asked: PrimaryLevel) => { if (PRIMARY_RANK[asked] > PRIMARY_RANK[level]) level = asked; };
  const primaryKeys = Object.keys(rules.primary) as (keyof RulesTable['primary'])[];
  for (const key of primaryKeys) raise(rules.primary[key][ratings[key]]);
  const fired = rules.together
    .map((rule) => ({ rule, raised: rule.dimensions.filter((key) => ratings[key] >= rule.atOrAbove) }))
    .filter(({ rule, raised }) => raised.length >= rule.count);
  for (const { rule } of fired) raise(rule.level);
  const firstStep = ratings[rules.firstStep.dimension] >= rules.firstStep.atOrAbove ? rules.firstStep.level : null;
  const oversight = ratings[rules.oversight.dimension] >= rules.oversight.atOrAbove;
  if (oversight) raise(rules.oversight.level);
  if (firstStep) raise(rules.firstStep.stepDownAtLeast);

  // What the rationale names as the reason, most specific first.
  let drivers: DimensionKey[] = [];
  let together: Recommendation['together'] = null;
  let floor: Recommendation['floor'] = null;
  if (level !== OP) {
    const atLevel = fired.filter(({ rule }) => rule.level === level);
    const individual: DimensionKey[] = primaryKeys.filter((key) => rules.primary[key][ratings[key]] === level);
    if (individual.length) {
      drivers = individual;
      for (const { rule, raised } of atLevel) {
        if (rule.key === 'serious') for (const key of raised) if (!drivers.includes(key)) drivers.push(key);
      }
    } else if (atLevel.length) {
      const named = atLevel.find(({ rule }) => rule.key === 'serious') || atLevel[0];
      drivers = named.raised.slice();
      together = named.rule.key;
    } else {
      floor = firstStep && rules.firstStep.stepDownAtLeast === level ? 'stepDown' : 'oversight';
      drivers = [floor === 'stepDown' ? rules.firstStep.dimension : rules.oversight.dimension];
    }
    drivers.sort(byArea);
  }
  return {
    level,
    firstStep,
    support: ratings[rules.support.dimension] >= rules.support.atOrAbove ? rules.support.level : null,
    drivers,
    together,
    floor,
  };
}

/** "Detox, then Inpatient, with Sober Living": the path, in level names. */
export function pathLabel(rec: Pick<Recommendation, 'level' | 'firstStep' | 'support'>): string {
  return `${rec.firstStep ? `${rec.firstStep}, then ` : ''}${rec.level}${rec.support ? `, with ${rec.support}` : ''}`;
}

/** What "Use recommended" picks: the first step when there is one (where the client goes now). */
export function defaultChoice(rec: Pick<Recommendation, 'level' | 'firstStep'>): PlacementLevel {
  return rec.firstStep ?? rec.level;
}

/**
 * The chosen level follows the recommendation: it is where the
 * recommendation sends the client now, the first step when there is one
 * (recommended_first_step ?? recommended_level, as the server reads it).
 * Skipping a recommended detox for the level after it is a different level
 * and needs a reason.
 */
export function followsRecommendation(rec: Pick<Recommendation, 'level' | 'firstStep'>, chosen: PlacementLevel): boolean {
  return chosen === defaultChoice(rec);
}

// ─── The rationale (2-4 short sentences; never anything about who) ──────────
// Built only from the ratings and fixed words: no notes, no names, no case.

function rated(key: DimensionKey, ratings: Ratings): string {
  const rating = ratings[key];
  return `${RATING_WORDS[rating]} ${DIMENSIONS[key].phrase} (${rating} of 4)`;
}

function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

const LEVEL_PHRASES: Record<PrimaryLevel, string> = {
  Inpatient: 'inpatient (residential) care',
  'IOP / PHP': 'intensive outpatient or day treatment (IOP / PHP)',
  Therapist: 'outpatient therapy',
};

export function rationale(ratings: Ratings, rec: Recommendation = recommend(ratings)): string[] {
  const sentences: string[] = [];
  const mentioned = new Set<DimensionKey>();
  if (rec.firstStep) {
    sentences.push(`Withdrawal risk is ${RATING_WORDS[ratings.withdrawal]} (${ratings.withdrawal} of 4), so medically supervised withdrawal (detox) comes first.`);
    mentioned.add('withdrawal');
  }
  const lead = rec.firstStep ? `After detox, ${LEVEL_PHRASES[rec.level]}` : capitalize(LEVEL_PHRASES[rec.level]);
  const named = listJoin(rec.drivers.map((key) => rated(key, ratings)));
  if (rec.level === OP) {
    sentences.push(`${lead} is recommended: no ${rec.firstStep ? 'other ' : ''}area calls for more structure than regular sessions.`);
  } else if (rec.floor === 'stepDown') {
    sentences.push(`After detox, step down no lower than ${LEVEL_PHRASES[rec.level]}.`);
  } else if (rec.floor === 'oversight') {
    sentences.push(`Withdrawal risk is ${RATING_WORDS[ratings.withdrawal]} (${ratings.withdrawal} of 4) and needs medical oversight, so at least ${LEVEL_PHRASES[rec.level]} is recommended.`);
  } else if (rec.together === 'serious') {
    sentences.push(`${lead} is recommended because serious risks occur together: ${named}.`);
  } else if (rec.together === 'moderate') {
    const least = Math.min(...rec.drivers.map((key) => ratings[key])) as Rating;
    const higher = rec.drivers.some((key) => ratings[key] > least) ? ' or higher' : '';
    sentences.push(`Several areas are at ${RATING_WORDS[least]} risk${higher} together, which calls for ${LEVEL_PHRASES[rec.level]}${rec.firstStep ? ' after detox' : ''}: ${named}.`);
  } else {
    sentences.push(`${lead} is recommended because of ${named}.`);
  }
  for (const key of rec.drivers) mentioned.add(key);
  if (rec.support) {
    const when = rec.level === IN ? 'after residential care' : 'during treatment';
    sentences.push(mentioned.has('environment')
      ? `Sober living is also recommended as a stable, substance-free place to live ${when}.`
      : `${capitalize(DIMENSIONS.environment.phrase)} are ${RATING_WORDS[ratings.environment]} (${ratings.environment} of 4), so sober living is recommended as a stable, substance-free place to live ${when}.`);
    mentioned.add('environment');
  }
  const others = DIMENSION_KEYS.filter((key) => !mentioned.has(key));
  if (others.length) {
    const notable = others.filter((key) => ratings[key] >= 2);
    const every = mentioned.size === 0;
    if (notable.length) sentences.push(`Also noted: ${listJoin(notable.map((key) => rated(key, ratings)))}.`);
    else if (others.some((key) => ratings[key] === 1)) sentences.push(every ? 'Every area is rated mild or none.' : 'Other areas are rated mild or none.');
    // After detox with nothing else to report, the outpatient sentence has
    // already said that no other area calls for more.
    else if (!(rec.firstStep && rec.level === OP)) sentences.push(every ? 'No area shows a concern.' : 'No other area shows a concern.');
  }
  return sentences;
}

// ─── Safety flags ───────────────────────────────────────────────────────────

export type FlagSeverity = 'emergency' | 'urgent' | 'advice';
export type SafetyFlag = { key: string; severity: FlagSeverity; title: string; text: string };
/** A flag rule: raised when ANY of its triggers holds (an area at one of the listed ratings). */
export type FlagTrigger = { dimension: DimensionKey; when: readonly Rating[] };
export type FlagRule = SafetyFlag & { triggers: readonly FlagTrigger[] };

export const EMERGENCY_FLAG: SafetyFlag = {
  key: 'imminent_danger',
  severity: 'emergency',
  title: 'Someone may be in immediate danger',
  text: 'If anyone is in immediate danger, call 911 now. For thoughts of suicide or an emotional crisis, call or text 988 (the Suicide & Crisis Lifeline). Stay with the person, or keep a safe adult with them, until help arrives. Placement can wait until everyone is safe.',
};

// Which ratings raise which flag. Our own wording; plain and calm. The flags
// are CUMULATIVE: a higher rating keeps every flag a lower one raised (an
// urgent flag at 4 comes with the advice for 3), so a worse picture never
// shows less. They are words only: the recommendation rules above (and the
// digest both test suites share) never read them.
const DETOX_FIRST: FlagTrigger = { dimension: LEVEL_OF_CARE_RULES.firstStep.dimension, when: RATINGS.filter((rating) => rating >= LEVEL_OF_CARE_RULES.firstStep.atOrAbove) };

export const FLAG_RULES: FlagRule[] = [
  {
    key: 'withdrawal_urgent', triggers: [{ dimension: 'withdrawal', when: [4] }], severity: 'urgent',
    title: 'Arrange medically supervised withdrawal today',
    text: 'Severe withdrawal risk: the client should not stop on their own. Arrange a medically supervised setting today. Seizures, confusion or hallucinations during withdrawal are an emergency: call 911.',
  },
  {
    key: 'medical_urgent', triggers: [{ dimension: 'physical', when: [4] }], severity: 'urgent',
    title: 'Arrange an urgent medical evaluation',
    text: 'Arrange an urgent medical evaluation before placement: the client\'s doctor today, urgent care, or an emergency department. Programs may need a doctor\'s clearance to admit. If symptoms are life-threatening, call 911.',
  },
  {
    key: 'psychiatric_urgent', triggers: [{ dimension: 'emotional', when: [4] }], severity: 'urgent',
    title: 'Arrange an urgent psychiatric evaluation',
    text: 'Arrange an urgent psychiatric evaluation before placement. If there are thoughts of suicide, call or text 988. If anyone is in danger now, call 911.',
  },
  {
    key: 'environment_unsafe', triggers: [{ dimension: 'environment', when: [4] }], severity: 'urgent',
    title: 'Plan a safe place to stay until admission',
    text: 'The living situation is unsafe. Plan where the client can stay safely until admission. If anyone is being hurt or threatened, call 911.',
  },
  {
    key: 'withdrawal_oversight', triggers: [{ dimension: 'withdrawal', when: [2, 3, 4] }], severity: 'advice',
    title: 'Arrange detox first, or a program with on-site withdrawal management',
    text: 'Withdrawal needs medical oversight at this level of risk. Arrange detox first, or choose a program that manages withdrawal on site, with medical staff.',
  },
  {
    key: 'medical_capacity', triggers: [{ dimension: 'physical', when: [3, 4] }], severity: 'advice',
    title: 'Ask about medical care on site',
    text: 'Ask each program whether it can manage these medical needs on site, with nursing.',
  },
  {
    key: 'psychiatric_capacity', triggers: [{ dimension: 'emotional', when: [3, 4] }], severity: 'advice',
    title: 'Look for psychiatric care on site',
    text: 'Look for programs with psychiatric care on site (the "Dual diagnosis" need on the match).',
  },
  {
    // Relapse risk 3 or more, or detox as the first step.
    key: 'overdose_risk', triggers: [{ dimension: 'relapse', when: [3, 4] }, DETOX_FIRST], severity: 'advice',
    title: 'Plan for overdose risk',
    text: 'After detox or any break from use, tolerance drops, so using the same amount as before can cause an overdose. Make sure the family has naloxone (Narcan) and knows how to use it, and to call 911 if someone may be overdosing.',
  },
];

/** The rule's triggers that hold for these ratings. */
export function flagRuleApplies(rule: Pick<FlagRule, 'triggers'>, ratings: Partial<Record<DimensionKey, Rating>>): boolean {
  return rule.triggers.some((trigger) => {
    const rating = ratings[trigger.dimension];
    return rating !== undefined && trigger.when.includes(rating);
  });
}

/** The flags for these answers: an emergency first, then urgent, then advice. */
export function safetyFlags(ratings: Ratings, imminentDanger: boolean): SafetyFlag[] {
  const flags: SafetyFlag[] = imminentDanger ? [EMERGENCY_FLAG] : [];
  for (const severity of ['urgent', 'advice'] as FlagSeverity[]) {
    for (const rule of FLAG_RULES) {
      if (rule.severity === severity && flagRuleApplies(rule, ratings)) {
        flags.push({ key: rule.key, severity: rule.severity, title: rule.title, text: rule.text });
      }
    }
  }
  return flags;
}

/** The flags one area's rating raises on its own, shown under that area as it is rated. */
export function inlineFlags(key: DimensionKey, rating: Rating | undefined): SafetyFlag[] {
  if (rating === undefined) return [];
  return FLAG_RULES
    .filter((rule) => rule.triggers.some((trigger) => trigger.dimension === key && trigger.when.includes(rating)))
    .map((rule) => ({ key: rule.key, severity: rule.severity, title: rule.title, text: rule.text }));
}

// ─── Validation (the server applies the same rules: case_assessment_problem) ─

export const REASON_PROBLEMS = {
  missing: 'Say why you chose a different level. The reason goes in the program\'s packet.',
  tooLong: `Keep the reason to ${REASON_MAX} characters`,
  multiline: 'Keep the reason to one line',
} as const;

/** Under the reason field: the program reads it, so what identifyingTextProblem refuses stays out. */
export const REASON_HINT = 'Leave out names, contact details, dates and money; the program reads this.';

// Line breaks, tabs and other control characters (Postgres [[:cntrl:]]).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

/** The names a reason may not carry: the case's title and its contact names. */
export function reasonNames(input: { caseTitle?: string | null; contactNames?: (string | null | undefined)[] }): string[] {
  return [input.caseTitle, ...(input.contactNames || [])].filter((value): value is string => typeof value === 'string' && value.trim() !== '');
}

/**
 * The first thing wrong with an override reason, or null. Mirrors
 * case_assessment_reason_problem: 3 to 200 characters on one line, then the
 * one shared check for text programs read (identifying-text.ts: no names,
 * contact details, dates, ID numbers or money). `names` are the case's title
 * and its contact names (reasonNames).
 */
export function reasonProblem(reason: string, names: (string | null | undefined)[] = []): string | null {
  const trimmed = reason.trim();
  // Characters as the server counts them (length()), not UTF-16 units.
  const length = Array.from(trimmed).length;
  if (length < REASON_MIN) return REASON_PROBLEMS.missing;
  if (length > REASON_MAX) return REASON_PROBLEMS.tooLong;
  if (CONTROL.test(reason)) return REASON_PROBLEMS.multiline;
  return identifyingTextProblem(trimmed, names.filter((value): value is string => typeof value === 'string' && value.trim() !== ''));
}

/** null when the chosen level follows the recommendation (no reason needed), else the reason's first problem. */
export function overrideProblem(rec: Pick<Recommendation, 'level' | 'firstStep'>, chosen: PlacementLevel | null, reason: string, names: (string | null | undefined)[] = []): string | null {
  if (!chosen || !isPlacementLevel(chosen)) return 'Choose a level of care';
  if (followsRecommendation(rec, chosen)) return null;
  return reasonProblem(reason, names);
}

export function noteProblem(note: string): string | null {
  return note.trim().length > NOTE_MAX ? `Keep each note to ${NOTE_MAX} characters` : null;
}

// ─── The draft the sheet fills in, and what goes to the server ──────────────

export type AssessmentDraft = {
  ratings: Partial<Record<DimensionKey, Rating>>;
  notes: Partial<Record<DimensionKey, string>>;
  imminentDanger: boolean | null;
  chosenLevel: PlacementLevel | null;
  overrideReason: string;
};

export function emptyDraft(): AssessmentDraft {
  return { ratings: {}, notes: {}, imminentDanger: null, chosenLevel: null, overrideReason: '' };
}

/** All six rated: the ratings as a full set, else null. */
export function completeRatings(partial: Partial<Record<DimensionKey, Rating>>): Ratings | null {
  const result = {} as Ratings;
  for (const key of DIMENSION_KEYS) {
    const value = partial[key];
    if (!isRating(value)) return null;
    result[key] = value;
  }
  return result;
}

/** The arguments of save_case_assessment, in its order. */
export type AssessmentInput = {
  ratings: number[];
  notes: string[];
  imminentDanger: boolean;
  rulesVersion: number;
  recommendedLevel: PrimaryLevel;
  recommendedFirstStep: 'Detox' | null;
  recommendedSupport: 'Sober Living' | null;
  chosenLevel: PlacementLevel;
  overrideReason: string;
};

export function prepareAssessment(draft: AssessmentDraft, names: (string | null | undefined)[] = []): { input: AssessmentInput; recommendation: Recommendation } | { problem: string } {
  if (draft.imminentDanger === null) return { problem: 'Answer the safety question first' };
  const ratings = completeRatings(draft.ratings);
  if (!ratings) {
    const missing = DIMENSION_KEYS.find((key) => !isRating(draft.ratings[key]));
    return { problem: `Rate ${missing ? DIMENSIONS[missing].title.toLowerCase() : 'every area'} first` };
  }
  for (const key of DIMENSION_KEYS) {
    const problem = noteProblem(draft.notes[key] || '');
    if (problem) return { problem: `${DIMENSIONS[key].title}: ${problem.toLowerCase()}` };
  }
  const rec = recommend(ratings);
  const problem = overrideProblem(rec, draft.chosenLevel, draft.overrideReason, names);
  if (problem) return { problem };
  const chosen = draft.chosenLevel as PlacementLevel;
  return {
    recommendation: rec,
    input: {
      ratings: DIMENSION_KEYS.map((key) => ratings[key]),
      notes: DIMENSION_KEYS.map((key) => (draft.notes[key] || '').trim()),
      imminentDanger: draft.imminentDanger,
      rulesVersion: RULES_VERSION,
      recommendedLevel: rec.level,
      recommendedFirstStep: rec.firstStep,
      recommendedSupport: rec.support,
      chosenLevel: chosen,
      overrideReason: followsRecommendation(rec, chosen) ? '' : draft.overrideReason.trim(),
    },
  };
}

// ─── A saved assessment ─────────────────────────────────────────────────────

export type CaseAssessment = {
  id: string;
  caseId: string;
  ratings: Ratings;
  notes: Record<DimensionKey, string>;
  imminentDanger: boolean;
  recommendation: Pick<Recommendation, 'level' | 'firstStep' | 'support'>;
  chosenLevel: PlacementLevel;
  overrideReason: string;
  rulesVersion: number;
  assessedBy: string | null;
  assessedAt: string;
};

export const ASSESSMENT_COLUMNS = [
  'id', 'case_id',
  'withdrawal_rating', 'physical_rating', 'emotional_rating', 'readiness_rating', 'relapse_rating', 'environment_rating',
  'withdrawal_note', 'physical_note', 'emotional_note', 'readiness_note', 'relapse_note', 'environment_note',
  'imminent_danger', 'recommended_level', 'recommended_first_step', 'recommended_support',
  'chosen_level', 'override_reason', 'rules_version', 'assessed_by', 'assessed_at',
] as const;

type Row = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A row from case_assessments (or the RPC's jsonb); null when it is not one. */
export function assessmentFromRow(row: Row | null | undefined): CaseAssessment | null {
  if (!row || typeof row !== 'object') return null;
  if (typeof row.id !== 'string' || typeof row.case_id !== 'string' || typeof row.assessed_at !== 'string') return null;
  const ratings = {} as Ratings;
  const notes = {} as Record<DimensionKey, string>;
  for (const key of DIMENSION_KEYS) {
    const value = Number(row[`${key}_rating`]);
    if (!isRating(value)) return null;
    ratings[key] = value;
    notes[key] = text(row[`${key}_note`]);
  }
  const level = row.recommended_level;
  if (level !== 'Therapist' && level !== 'IOP / PHP' && level !== 'Inpatient') return null;
  if (!isPlacementLevel(row.chosen_level)) return null;
  return {
    id: row.id.toLowerCase(),
    caseId: row.case_id.toLowerCase(),
    ratings,
    notes,
    imminentDanger: row.imminent_danger === true,
    recommendation: {
      level,
      firstStep: row.recommended_first_step === 'Detox' ? 'Detox' : null,
      support: row.recommended_support === 'Sober Living' ? 'Sober Living' : null,
    },
    chosenLevel: row.chosen_level,
    overrideReason: text(row.override_reason),
    rulesVersion: Number(row.rules_version) || 0,
    assessedBy: typeof row.assessed_by === 'string' && row.assessed_by ? row.assessed_by.toLowerCase() : null,
    assessedAt: row.assessed_at,
  };
}

/** Newest first; the first one is current. */
export function sortAssessments(list: CaseAssessment[]): CaseAssessment[] {
  return list.slice().sort((a, b) => b.assessedAt.localeCompare(a.assessedAt) || b.id.localeCompare(a.id));
}

export function currentAssessment(list: CaseAssessment[] | null | undefined): CaseAssessment | null {
  return list && list.length ? sortAssessments(list)[0] : null;
}

/** The timeline entry: the levels only, never a rating. "; chosen X" whenever X is not where the recommendation sends the client now (followsRecommendation). Mirrors case_assessment_event_body. */
export function assessmentEventBody(rec: Pick<Recommendation, 'level' | 'firstStep' | 'support'>, chosen: PlacementLevel): string {
  return `Level-of-care assessment: recommended ${pathLabel(rec)}${followsRecommendation(rec, chosen) ? '' : `; chosen ${chosen}`}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Nov 4, 2026", in the phone's time zone. */
export function formatAssessedDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

/** The stored recommendation, its rationale and flags, worked out again from the stored ratings. */
export function assessmentRationale(assessment: CaseAssessment): string[] {
  const rec = recommend(assessment.ratings);
  // A row saved under other rules keeps what it said; its rationale is only
  // rebuilt when today's rules give the same recommendation.
  if (pathLabel(rec) !== pathLabel(assessment.recommendation)) return [];
  return rationale(assessment.ratings, rec);
}

// ─── Where it shows ─────────────────────────────────────────────────────────

/**
 * The program copy of the packet: the recommended and chosen level, the
 * reason for a different level, the rationale, and the date. Never the
 * client's identity, the notes, or anything from the case. `matchLevel` is
 * the level the referral is for; a different one is said plainly.
 */
export function levelOfCarePacketLines(assessment: CaseAssessment | null, matchLevel: ReferralMatch['levelOfCare']): string[] {
  if (!assessment) return [];
  const lines = [
    'LEVEL-OF-CARE RATIONALE',
    `- Recommended: ${pathLabel(assessment.recommendation)}`,
    `- Chosen: ${assessment.chosenLevel}`,
  ];
  if (!followsRecommendation(assessment.recommendation, assessment.chosenLevel) && assessment.overrideReason.trim()) {
    lines.push(`- Reason for a different level: ${assessment.overrideReason.trim()}`);
  }
  if (matchLevel !== 'Any type' && matchLevel !== assessment.chosenLevel) {
    lines.push(`- This referral is for ${matchLevel}, which is not the level chosen in the assessment.`);
  }
  const sentences = assessmentRationale(assessment);
  if (sentences.length) lines.push(sentences.join(' '));
  const date = formatAssessedDate(assessment.assessedAt);
  lines.push(`Assessed ${date ? `${date} ` : ''}across six areas, following the widely used six-dimension framework. Decision support for the practitioner's clinical judgment, not a diagnosis.`);
  return lines;
}

/** "Assessed: Inpatient · Nov 4, 2026", on the match criteria. */
export function assessedLevelLine(assessment: CaseAssessment): string {
  const date = formatAssessedDate(assessment.assessedAt);
  return `Assessed: ${assessment.chosenLevel}${date ? ` · ${date}` : ''}`;
}

/** A gentle note when the match's level is moved away from the assessment, else null. */
export function matchLevelNote(assessment: CaseAssessment | null, matchLevel: ReferralMatch['levelOfCare']): string | null {
  if (!assessment || matchLevel === assessment.chosenLevel) return null;
  const chosen = assessment.chosenLevel;
  if (matchLevel === 'Any type') return `The assessment chose ${chosen}. "Any level of care" ranks programs of every level.`;
  const rec = assessment.recommendation;
  if (matchLevel === rec.level || matchLevel === rec.firstStep || matchLevel === rec.support) {
    return `The assessment chose ${chosen} for now; ${matchLevel} is also on its recommended path (${pathLabel(rec)}).`;
  }
  return `This is different from the assessed level (${chosen}). That is fine if the plan changed; reassess from the case file so the program's packet tells the same story.`;
}

// ─── The server without the migration ───────────────────────────────────────

/** PGRST202 unknown function, PGRST205 / 42P01 unknown table, 42703 unknown column, 42883 unknown signature. */
export function isMissingAssessmentSchema(code: string | null | undefined): boolean {
  return code === 'PGRST202' || code === 'PGRST205' || code === '42P01' || code === '42703' || code === '42883';
}
