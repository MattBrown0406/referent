// Matching integrity: src/lib/matching.ts run in plain node, no build step.
//
//   (a) a program failing any hard requirement is hidden, never demoted
//   (b) referral counts can never change the order (property-style)
//   (c) score components sum to the total, max 100, weights as documented
//   (d) ties: lower family cost first, then a rotation that is stable for one
//       match profile id and differs across ids
//   (e) track record: one 5-star review cannot outrank twenty 4.6s; no
//       history scores the prior, and bad history never beats none
//   (f) a financial relationship never changes the order or any score
//   (h) location preference: "Away from home" searches every state
//   (i) a cash cost not on file is unknown, never free

import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'matching-test');
const require = createRequire(import.meta.url);
const ts = require(path.join(repoRoot, 'node_modules', 'typescript'));

function transpileTo(relSrc, outName) {
  const source = readFileSync(path.join(repoRoot, relSrc), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const outPath = path.join(tmpDir, outName);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, js);
  return outPath;
}

mkdirSync(tmpDir, { recursive: true });
transpileTo('src/data.ts', 'data.js');
transpileTo('src/lib/beds.ts', 'lib/beds.js');
transpileTo('src/lib/matching.ts', 'lib/matching.js');

const m = require(path.join(tmpDir, 'lib', 'matching.js'));
const {
  rankPrograms, scoreProgram, trackRecordPrior, trackRecordScore, rotationKey, defaultMustHaveNeeds,
  mustHaveNeedsForProfile, populationForProfile, rankOfPartner, placementCandidates,
  WEIGHT_CLINICAL_FIT, WEIGHT_FAMILY_COST, WEIGHT_LOCATION, WEIGHT_TRACK_RECORD, MAX_SCORE,
  TRACK_RECORD_PRIOR_CASES, MUST_HAVE_BY_DEFAULT, OUT_OF_NETWORK_COST_SHARE,
  priorTrackRecordScore, priorForCard, knownMonthlyCostForPartner, monthlyCostForPartner, regionFitForPartner,
  CASH_UNKNOWN_COST_SHARE,
} = m;

// ─── Fixtures ───────────────────────────────────────────────────────────────

let seq = 0;
function partner(overrides = {}) {
  seq += 1;
  return {
    id: `p${seq}`,
    name: `Contact ${seq}`,
    organization: `Program ${seq}`,
    type: 'Inpatient',
    types: ['Inpatient'],
    city: 'Bend',
    state: 'OR',
    regions: [],
    phone: '',
    email: '',
    monthlyCost: 20000,
    insuranceNetworks: {},
    cashMin: 0,
    cashMax: 0,
    insurance: [],
    therapies: [],
    populations: ['Adults'],
    levels: ['Inpatient'],
    note: '',
    inbound: 0,
    outbound: 0,
    lastContact: '2026-09-01',
    ...overrides,
  };
}

function profile(overrides = {}) {
  return {
    id: 'm-1',
    clientLabel: 'J.R.',
    levelOfCare: 'Any type',
    state: 'OR',
    insurance: 'Cash pay',
    networkPreferences: ['In-network'],
    maxBudget: undefined,
    therapies: [],
    status: 'Matching',
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

const noCards = {};
const ids = (ranked) => ranked.map((score) => score.partner.id);

// ─── (a) hard requirements hide, never demote ───────────────────────────────

{
  // Bug A: "Women only" + "Trauma" must not surface a men-only trauma program.
  const menOnlyTrauma = partner({ id: 'men-trauma', therapies: ['Men only', 'Trauma'], populations: ['Men'] });
  const womenTrauma = partner({ id: 'women-trauma', therapies: ['Women only', 'Trauma'], populations: ['Women'] });
  const coedNoTrauma = partner({ id: 'coed', therapies: ['CBT'], populations: ['Adults'] });
  // An older profile carries the population as a need. "Women only" as a
  // need asks for a women-only program, so the coed one is out as well.
  const legacy = profile({ therapies: ['Women only', 'Trauma'] });
  assert.deepEqual(ids(rankPrograms(legacy, [menOnlyTrauma, womenTrauma, coedNoTrauma], noCards)), ['women-trauma'],
    'a men-only program never appears for a Women only search, even when it offers the other need');
  assert.equal(populationForProfile(legacy), 'Women');
  // The population field alone says who the client is: a woman may see coed, never men-only.
  const explicit = profile({ therapies: ['Trauma'], population: 'Women' });
  assert.deepEqual(ids(rankPrograms(explicit, [menOnlyTrauma, womenTrauma, coedNoTrauma], noCards)), ['women-trauma', 'coed']);
  const male = profile({ therapies: ['Trauma'], population: 'Men' });
  assert.deepEqual(ids(rankPrograms(male, [menOnlyTrauma, womenTrauma, coedNoTrauma], noCards)), ['men-trauma', 'coed']);
  const hidden = scoreProgram(explicit, menOnlyTrauma, undefined, trackRecordPrior(noCards));
  assert.equal(hidden.eligible, false);
  assert.deepEqual(hidden.failedRequirements, ['population']);
  assert.ok(hidden.total > 0, 'the score is still computed; eligibility is what hides it');
}

{
  // Adolescent vs adult-only, both directions.
  const adultOnly = partner({ id: 'adult', populations: ['Adults'], therapies: ['Trauma'] });
  const teenOnly = partner({ id: 'teen', populations: ['Adolescents'], therapies: ['Trauma'] });
  const both = partner({ id: 'both', populations: ['Adults', 'Teens'], therapies: ['Trauma'] });
  const teenByNeed = partner({ id: 'teen-need', populations: [], therapies: ['Adolescent'] });
  const teen = profile({ population: 'Adolescent', therapies: ['Trauma'] });
  assert.deepEqual(ids(rankPrograms(teen, [adultOnly, teenOnly, both, teenByNeed], noCards)).sort(), ['both', 'teen', 'teen-need'].sort());
  const adultWoman = profile({ population: 'Women', therapies: ['Trauma'] });
  assert.deepEqual(ids(rankPrograms(adultWoman, [adultOnly, teenOnly, both, teenByNeed], noCards)).sort(), ['adult', 'both'].sort(),
    'an adult never sees an adolescent-only program');
  const legacyTeen = profile({ therapies: ['Adolescent', 'Trauma'] });
  assert.deepEqual(ids(rankPrograms(legacyTeen, [adultOnly, teenOnly, both], noCards)).sort(), ['both', 'teen'].sort());
}

{
  // MAT defaults to must-have; a program without it is hidden, not demoted.
  assert.deepEqual(MUST_HAVE_BY_DEFAULT, ['MAT']);
  assert.deepEqual(defaultMustHaveNeeds(['Trauma', 'MAT', 'CBT']), ['MAT']);
  const withMat = partner({ id: 'mat', therapies: ['MAT'] });
  const everythingButMat = partner({ id: 'no-mat', therapies: ['Trauma', 'CBT', 'DBT', 'EMDR'] });
  const legacyMat = profile({ therapies: ['MAT', 'Trauma', 'CBT'] }); // no mustHaveTherapies saved
  assert.deepEqual(mustHaveNeedsForProfile(legacyMat), ['MAT']);
  assert.deepEqual(ids(rankPrograms(legacyMat, [everythingButMat, withMat], noCards)), ['mat'],
    'without MAT the program is hidden even though it offers every other need');
  const matPreferred = profile({ therapies: ['MAT', 'Trauma', 'CBT'], mustHaveTherapies: [] });
  assert.deepEqual(ids(rankPrograms(matPreferred, [everythingButMat, withMat], noCards)), ['no-mat', 'mat'],
    'the clinician can demote MAT to preferred, and then coverage decides');
  // Population needs stay required even when the must-have list is empty.
  assert.deepEqual(mustHaveNeedsForProfile({ therapies: ['Women only', 'Trauma'], mustHaveTherapies: [] }), ['Women only']);
}

{
  // Level of care, payment, and location are requirements too.
  const inpatient = partner({ id: 'inpatient', types: ['Inpatient'] });
  const sober = partner({ id: 'sober', types: ['Sober Living'] });
  assert.deepEqual(ids(rankPrograms(profile({ levelOfCare: 'Sober Living' }), [inpatient, sober], noCards)), ['sober']);
  const cheap = partner({ id: 'cheap', monthlyCost: 5000 });
  const dear = partner({ id: 'dear', monthlyCost: 50000 });
  assert.deepEqual(ids(rankPrograms(profile({ insurance: 'Cash pay', maxBudget: 10000 }), [dear, cheap], noCards)), ['cheap']);
  const inNet = partner({ id: 'in', insurance: ['Aetna'], insuranceNetworks: { Aetna: ['In-network'] } });
  const oon = partner({ id: 'oon', insurance: ['Aetna'], insuranceNetworks: { Aetna: ['Out-of-network'] } });
  const none = partner({ id: 'none', insurance: ['Cigna'] });
  assert.deepEqual(ids(rankPrograms(profile({ insurance: 'Aetna', networkPreferences: ['In-network'] }), [none, oon, inNet], noCards)), ['in']);
  const both = rankPrograms(profile({ insurance: 'Aetna', networkPreferences: ['In-network', 'Out-of-network'] }), [none, oon, inNet], noCards);
  assert.deepEqual(ids(both), ['in', 'oon']);
  assert.equal(both[1].verifyBenefits, true, 'out-of-network carries the verify-benefits flag');
  assert.equal(both[0].verifyBenefits, false);
  assert.equal(both[1].components.cost, WEIGHT_FAMILY_COST * OUT_OF_NETWORK_COST_SHARE);
  const oregon = partner({ id: 'or', state: 'OR' });
  const idaho = partner({ id: 'id', state: 'ID' });
  const national = partner({ id: 'nat', state: 'CA', regions: ['Nationwide'] });
  assert.deepEqual(ids(rankPrograms(profile({ state: 'OR', locationPreference: 'Close to family' }), [idaho, national, oregon], noCards)), ['or', 'nat'],
    'out of state is hidden unless the program serves nationwide; close-to-family then prefers the home state');
}

// ─── (b) referral counts can never change the order ────────────────────────

{
  // Deterministic PRNG (mulberry32) with a fixed seed.
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const random = rng(20261001);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const needs = ['Trauma', 'Dual diagnosis', 'CBT', 'DBT', 'EMDR', 'MAT', 'Family systems', 'Faith based'];
  for (let round = 0; round < 25; round += 1) {
    const partners = Array.from({ length: 12 }, (_, index) => partner({
      id: `f${round}-${index}`,
      state: pick(['OR', 'OR', 'WA', 'CA']),
      regions: random() < 0.3 ? ['Nationwide'] : [],
      monthlyCost: 5000 + Math.floor(random() * 6) * 5000,
      therapies: needs.filter(() => random() < 0.5),
      populations: pick([['Adults'], ['Men'], ['Women'], ['Adults', 'Teens']]),
      insurance: random() < 0.6 ? ['Aetna'] : [],
      insuranceNetworks: random() < 0.6 ? { Aetna: [pick(['In-network', 'Out-of-network'])] } : {},
      inbound: Math.floor(random() * 10),
      outbound: Math.floor(random() * 10),
      financialRelationship: random() < 0.2 ? 'consulting_fee' : 'none',
    }));
    const cards = Object.fromEntries(partners.filter(() => random() < 0.5).map((item) => [item.id, {
      partnerId: item.id, referralsSent: 10, admits: Math.floor(random() * 10), nonAdmits: Math.floor(random() * 5),
      avgFamilyExperience: random() < 0.7 ? 2 + Math.round(random() * 30) / 10 : null, lastReferralOn: null,
    }]));
    const p = profile({
      id: `m-${round}`,
      state: pick(['OR', 'ANY', 'WA']),
      insurance: random() < 0.5 ? 'Cash pay' : 'Aetna',
      networkPreferences: random() < 0.5 ? ['In-network'] : ['In-network', 'Out-of-network'],
      maxBudget: random() < 0.5 ? 20000 : undefined,
      therapies: needs.filter(() => random() < 0.4),
      population: pick(['Any', 'Men', 'Women']),
      locationPreference: pick(['No preference', 'Close to family', 'Away from home']),
    });
    const base = rankPrograms(p, partners, cards);
    const baseIds = ids(base);
    for (let permutation = 0; permutation < 4; permutation += 1) {
      const permuted = partners.map((item) => ({ ...item, inbound: Math.floor(random() * 50), outbound: Math.floor(random() * 50) }));
      const again = rankPrograms(p, permuted, cards);
      assert.deepEqual(ids(again), baseIds, `round ${round}: inbound/outbound permutation ${permutation} changed the order`);
      assert.deepEqual(again.map((s) => s.total), base.map((s) => s.total));
    }
    // (f) toggling the financial relationship changes neither order nor score.
    const flipped = partners.map((item) => ({ ...item, financialRelationship: item.financialRelationship === 'none' ? 'shared_ownership' : 'none' }));
    const flippedRank = rankPrograms(p, flipped, cards);
    assert.deepEqual(ids(flippedRank), baseIds, `round ${round}: a financial relationship changed the order`);
    assert.deepEqual(flippedRank.map((s) => [s.total, s.components]), base.map((s) => [s.total, s.components]));
    assert.ok(flippedRank.every((s, i) => s.disclosure !== base[i].disclosure), 'the disclosure flag follows the field');
    // (c) components sum to the total; nothing exceeds its weight or 100.
    for (const score of base) {
      const sum = score.components.clinical + score.components.cost + score.components.location + score.components.trackRecord;
      assert.ok(Math.abs(sum - score.total) < 0.051, `components must sum to the total (${sum} vs ${score.total})`);
      assert.ok(score.total >= 0 && score.total <= MAX_SCORE);
      assert.ok(score.components.clinical <= WEIGHT_CLINICAL_FIT && score.components.cost <= WEIGHT_FAMILY_COST);
      assert.ok(score.components.location <= WEIGHT_LOCATION && score.components.trackRecord <= WEIGHT_TRACK_RECORD);
    }
  }
}

// ─── (c) score components as specified ─────────────────────────────────────

{
  assert.deepEqual([WEIGHT_CLINICAL_FIT, WEIGHT_FAMILY_COST, WEIGHT_LOCATION, WEIGHT_TRACK_RECORD, MAX_SCORE, TRACK_RECORD_PRIOR_CASES], [50, 25, 10, 15, 100, 5]);
  const prior = trackRecordPrior(noCards);
  // All needs met, in-network, no location preference, no track record = 50 + 25 + 10 + 7.5.
  const full = partner({ therapies: ['Trauma', 'CBT'], insurance: ['Aetna'], insuranceNetworks: { Aetna: ['In-network'] } });
  const s1 = scoreProgram(profile({ insurance: 'Aetna', therapies: ['Trauma', 'CBT'] }), full, undefined, prior);
  assert.deepEqual(s1.components, { clinical: 50, cost: 25, location: 10, trackRecord: 7.5 });
  assert.equal(s1.total, 92.5);
  // Half the preferred needs = 25 clinical; the must-have is not part of the share.
  const half = partner({ therapies: ['Trauma', 'MAT'], insurance: ['Aetna'], insuranceNetworks: { Aetna: ['In-network'] } });
  const s2 = scoreProgram(profile({ insurance: 'Aetna', therapies: ['MAT', 'Trauma', 'CBT'] }), half, undefined, prior);
  assert.equal(s2.components.clinical, 25);
  assert.deepEqual(s2.requiredNeeds, ['MAT']);
  assert.deepEqual(s2.matchedNeeds, ['Trauma']);
  assert.deepEqual(s2.missingNeeds, ['CBT']);
  // No preferred needs at all = full clinical points.
  assert.equal(scoreProgram(profile({ insurance: 'Aetna', therapies: ['MAT'] }), half, undefined, prior).components.clinical, 50);
  // Cash: at budget = half the cost points, well under = more, no budget = half.
  const cash = (cost, budget) => scoreProgram(profile({ insurance: 'Cash pay', maxBudget: budget }), partner({ monthlyCost: cost }), undefined, prior).components.cost;
  assert.equal(cash(10000, 10000), 12.5);
  assert.equal(cash(5000, 10000), 18.8);
  // 0 is a cost never entered, not a free program: neutral points, never full
  // (this asserted 25 before: an unknown cost scored as the cheapest possible).
  assert.equal(cash(0, 10000), WEIGHT_FAMILY_COST * CASH_UNKNOWN_COST_SHARE);
  assert.equal(cash(0, undefined), 12.5);
  assert.equal(cash(30000, undefined), 12.5);
  assert.ok(cash(2000, 10000) > cash(8000, 10000), 'cash scores higher the further under budget');
  // Location: close/away from the state on each side; unknown state is neutral.
  const loc = (pref, state, partnerState) => scoreProgram(profile({ state, locationPreference: pref }), partner({ state: partnerState, regions: ['Nationwide'] }), undefined, prior).components.location;
  assert.equal(loc('Close to family', 'OR', 'OR'), 10);
  assert.equal(loc('Close to family', 'OR', 'CA'), 0);
  assert.equal(loc('Away from home', 'OR', 'CA'), 10);
  assert.equal(loc('Away from home', 'OR', 'OR'), 0);
  assert.equal(loc('Close to family', 'ANY', 'OR'), 5);
  assert.equal(loc('No preference', 'OR', 'CA'), 10);
}

// ─── (d) ties: cost first, then a rotation seeded by the profile id ─────────

{
  const cheap = partner({ id: 'cheap', monthlyCost: 8000 });
  const dear = partner({ id: 'dear', monthlyCost: 9000 });
  // Same fit (no needs, no budget), different cost: cheaper wins, every time.
  for (const id of ['m-a', 'm-b', 'm-c']) {
    assert.deepEqual(ids(rankPrograms(profile({ id, insurance: 'Cash pay' }), [dear, cheap], noCards)), ['cheap', 'dear']);
  }
  // Insurance: in-network beats out-of-network on cost even at equal totals.
  const inNet = partner({ id: 'in', insurance: ['Aetna'], insuranceNetworks: { Aetna: ['In-network'] } });
  const oon = partner({ id: 'oon', insurance: ['Aetna'], insuranceNetworks: { Aetna: ['Out-of-network'] } });
  const bothRank = rankPrograms(profile({ insurance: 'Aetna', networkPreferences: ['In-network', 'Out-of-network'] }), [oon, inNet], noCards);
  assert.deepEqual(ids(bothRank), ['in', 'oon']);
  // Fully tied programs: the order is stable for one profile id and differs across ids.
  const tied = Array.from({ length: 6 }, (_, i) => partner({ id: `tie-${i}`, monthlyCost: 10000 }));
  const orders = new Set();
  for (let i = 0; i < 12; i += 1) {
    const id = `family-${i}`;
    const first = ids(rankPrograms(profile({ id, insurance: 'Cash pay' }), tied, noCards));
    const second = ids(rankPrograms(profile({ id, insurance: 'Cash pay' }), tied.slice().reverse(), noCards));
    assert.deepEqual(first, second, 'the same profile id gives the same order regardless of input order');
    orders.add(first.join(','));
  }
  assert.ok(orders.size >= 4, `tied programs must rotate across families (saw ${orders.size} distinct orders)`);
  assert.equal(rotationKey('m-1', 'p-1'), rotationKey('m-1', 'p-1'));
  assert.notEqual(rotationKey('m-1', 'p-1'), rotationKey('m-2', 'p-1'));
}

// ─── (e) track record: one 5-star cannot beat twenty 4.6s ──────────────────

{
  const card = (id, decided, admits, experience) => [id, { partnerId: id, referralsSent: decided, admits, nonAdmits: decided - admits, avgFamilyExperience: experience, lastReferralOn: null }];
  // A realistic network around 4.1 stars and a 70% admit rate.
  const cards = Object.fromEntries([
    card('one-five', 1, 1, 5.0),
    card('twenty', 20, 18, 4.6),
    card('n1', 12, 8, 4.0), card('n2', 9, 6, 3.8), card('n3', 15, 11, 4.2), card('n4', 7, 5, 4.1),
  ]);
  const prior = trackRecordPrior(cards);
  const single = trackRecordScore(cards['one-five'], prior).score;
  const twenty = trackRecordScore(cards.twenty, prior).score;
  assert.ok(twenty > single, `twenty 4.6s (${twenty}) must outrank a single 5-star (${single})`);
  // The same claim on the experience signal alone: equal admit rates, only the stars differ.
  const equalAdmits = { ...cards, 'one-five': { ...cards['one-five'], admits: 1, nonAdmits: 0 }, twenty: { ...cards.twenty, admits: 20, nonAdmits: 0 } };
  const priorEqual = trackRecordPrior(equalAdmits);
  assert.ok(trackRecordScore(equalAdmits.twenty, priorEqual).score > trackRecordScore(equalAdmits['one-five'], priorEqual).score);
  // No data scores the prior, not a flat 7.5 (7.5 is the prior only when nobody has data).
  const priorScore = priorTrackRecordScore(prior);
  assert.ok(priorScore > 7.5, `this network is better than a coin flip (${priorScore})`);
  assert.equal(trackRecordScore(undefined, prior).score, priorScore, 'no data scores exactly the prior');
  assert.equal(trackRecordScore({ admits: 0, nonAdmits: 0, avgFamilyExperience: 5 }, prior).score, priorScore, 'a rating with no decided cases still scores the prior');
  assert.equal(trackRecordScore(undefined, trackRecordPrior(noCards)).score, 7.5, 'with nobody\'s data the prior is half');
  // End to end: identical programs except the scorecard.
  const a = partner({ id: 'one-five' });
  const b = partner({ id: 'twenty' });
  assert.deepEqual(ids(rankPrograms(profile({ insurance: 'Cash pay' }), [a, b], cards)), ['twenty', 'one-five']);
  // More evidence moves the score further from the prior, in both directions.
  const strong = trackRecordScore({ admits: 20, nonAdmits: 0, avgFamilyExperience: 5 }, prior).score;
  const weak = trackRecordScore({ admits: 0, nonAdmits: 20, avgFamilyExperience: 1 }, prior).score;
  assert.ok(strong > priorScore && strong <= 15 && weak < priorScore && weak >= 0);
}

{
  // Bad evidence never beats no evidence (reviewer's case): in a workspace
  // with a good record, a program whose only referral was a 1-star
  // non-admit used to score 9.3 and outrank a never-used program at 7.5.
  const cards = {
    good1: { admits: 8, nonAdmits: 2, avgFamilyExperience: 4.2 },
    good2: { admits: 9, nonAdmits: 1, avgFamilyExperience: 4.4 },
    bad: { admits: 0, nonAdmits: 1, avgFamilyExperience: 1 },
  };
  const ranked = rankPrograms(profile({ id: 'mp1', insurance: 'Cash pay', maxBudget: 30000 }), [partner({ id: 'bad' }), partner({ id: 'never' })], cards);
  assert.deepEqual(ids(ranked), ['never', 'bad'], 'a never-used program outranks one with only a bad referral');
  const prior = trackRecordPrior(cards);
  assert.ok(ranked[1].components.trackRecord < ranked[0].components.trackRecord);
  assert.equal(ranked[0].components.trackRecord, Math.round(priorTrackRecordScore(prior) * 10) / 10);

  // Property: for any prior (workspace or network), a record no better than
  // the program's prior on every signal never scores above that program with
  // no record, and one no worse never scores below it. Includes the old
  // cutoff case: a weak network (N) inside a strong workspace (W), five or
  // more bad local cases. Switching the prior from N to W at five cases used
  // to lift the score above the no-evidence one.
  let state = 7;
  const random = () => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return state / 4294967296; };
  const toStars = (unit) => 1 + 4 * unit;
  for (let round = 0; round < 400; round += 1) {
    const workspace = { experience: random(), admitRate: random(), completion: random() };
    const network = random() < 0.6 ? { admitRate: random(), familyExperience: toStars(random()), completionRate: random() < 0.8 ? random() : null } : undefined;
    const p = priorForCard({ admits: 0, nonAdmits: 0, avgFamilyExperience: null, network }, workspace);
    const none = trackRecordScore({ admits: 0, nonAdmits: 0, avgFamilyExperience: null, network }, workspace).score;
    const decided = 1 + Math.floor(random() * 40);
    const placements = Math.floor(random() * (decided + 1));
    const worse = {
      admits: Math.floor(decided * p.admitRate * random()),
      avgFamilyExperience: toStars(p.experience * random()),
      completionRate: p.completion * random(),
    };
    const better = {
      admits: Math.min(decided, Math.ceil(decided * (p.admitRate + (1 - p.admitRate) * random()))),
      avgFamilyExperience: toStars(p.experience + (1 - p.experience) * random()),
      completionRate: p.completion + (1 - p.completion) * random(),
    };
    const card = (signals) => ({ ...signals, nonAdmits: decided - signals.admits, decidedPlacements: placements, network });
    assert.ok(trackRecordScore(card(worse), workspace).score <= none + 1e-9, `round ${round}: worse-than-prior evidence beat no evidence`);
    assert.ok(trackRecordScore(card(better), workspace).score >= none - 1e-9, `round ${round}: better-than-prior evidence fell below no evidence`);
  }
  const weakNetwork = { admitRate: 0.2, familyExperience: 1.8, completionRate: 0.2 };
  const strongWorkspace = { experience: 0.9, admitRate: 0.9, completion: 0.9 };
  const noRecord = trackRecordScore({ admits: 0, nonAdmits: 0, avgFamilyExperience: null, network: weakNetwork }, strongWorkspace).score;
  for (const decided of [1, 4, 5, 6, 12]) {
    const bad = trackRecordScore({ admits: 0, nonAdmits: decided, avgFamilyExperience: 1, decidedPlacements: 0, network: weakNetwork }, strongWorkspace).score;
    assert.ok(bad <= noRecord, `${decided} one-star non-admits (${bad}) must not beat no record (${noRecord})`);
  }
}

// ─── (g) outcomes loop: completion joins the blend; network prior for thin history ──

{
  const { TRACK_RECORD_BLEND, priorForCard } = m;
  assert.ok(Math.abs(TRACK_RECORD_BLEND.experience + TRACK_RECORD_BLEND.completion + TRACK_RECORD_BLEND.admitRate - 1) < 1e-9, 'the blend sums to one');
  assert.ok(TRACK_RECORD_BLEND.experience > TRACK_RECORD_BLEND.completion && TRACK_RECORD_BLEND.experience > TRACK_RECORD_BLEND.admitRate, 'family experience stays the primary signal');
  const card = (id, decided, admits, experience, placements, completion) => [id, {
    partnerId: id, referralsSent: decided, admits, nonAdmits: decided - admits, avgFamilyExperience: experience, lastReferralOn: null,
    decidedPlacements: placements, completionRate: completion,
  }];
  const cards = Object.fromEntries([
    card('one-five', 1, 1, 5.0, 1, 1),
    card('twenty', 20, 18, 4.6, 15, 0.8),
    card('n1', 12, 8, 4.0, 6, 0.5), card('n2', 9, 6, 3.8, 4, 0.75), card('n3', 15, 11, 4.2, 8, 0.625), card('n4', 7, 5, 4.1, 3, 0.67),
  ]);
  const prior = trackRecordPrior(cards);
  assert.ok(prior.completion > 0.5 && prior.completion < 0.8, `completion prior is case-weighted (${prior.completion})`);
  // A partner with no data scores the prior, with or without completion data.
  assert.equal(trackRecordScore(undefined, prior).score, priorTrackRecordScore(prior));
  assert.equal(trackRecordScore({ admits: 0, nonAdmits: 0, avgFamilyExperience: 5, decidedPlacements: 0, completionRate: 1 }, prior).score, priorTrackRecordScore(prior));
  // Completion cannot push above the max, even with absurd inputs.
  const perfect = trackRecordScore({ admits: 50, nonAdmits: 0, avgFamilyExperience: 5, decidedPlacements: 50, completionRate: 1 }, { experience: 1, admitRate: 1, completion: 1 }).score;
  assert.ok(Math.abs(perfect - WEIGHT_TRACK_RECORD) < 1e-9, `everything perfect scores exactly the weight (${perfect})`);
  const overcooked = trackRecordScore({ admits: 50, nonAdmits: 0, avgFamilyExperience: 5, decidedPlacements: 500, completionRate: 7 }, prior).score;
  assert.ok(overcooked <= WEIGHT_TRACK_RECORD, 'more placements than cases, or a rate above one, cannot exceed the weight');
  // One 5-star with one perfect completion still cannot beat twenty 4.6s.
  assert.ok(trackRecordScore(cards.twenty, prior).score > trackRecordScore(cards['one-five'], prior).score);
  // Completion moves the score in the right direction, everything else fixed.
  const base = { admits: 10, nonAdmits: 2, avgFamilyExperience: 4.2 };
  const high = trackRecordScore({ ...base, decidedPlacements: 8, completionRate: 1 }, prior).score;
  const none = trackRecordScore({ ...base }, prior).score;
  const low = trackRecordScore({ ...base, decidedPlacements: 8, completionRate: 0 }, prior).score;
  assert.ok(high > none && none > low, `completion ranks ${high} > ${none} > ${low}`);
  // Network prior: a thin local history leans on the disclosed network
  // figures; enough local history ignores them; withheld figures fall back.
  const network = { admitRate: 0.95, familyExperience: 4.9, completionRate: 0.95 };
  const thin = { admits: 1, nonAdmits: 1, avgFamilyExperience: 3, decidedPlacements: 1, completionRate: 0 };
  assert.ok(trackRecordScore({ ...thin, network }, prior).score > trackRecordScore(thin, prior).score, 'a strong network record lifts a thin local one');
  // The network is the prior at any amount of local history (no switch at
  // five cases: that switch let bad local evidence lift a score). Its pull
  // fades as local cases accrue: a rich record barely moves.
  const rich = { admits: 20, nonAdmits: 2, avgFamilyExperience: 4.4, decidedPlacements: 10, completionRate: 0.7 };
  const thinLift = trackRecordScore({ ...thin, network }, prior).score - trackRecordScore(thin, prior).score;
  const richLift = trackRecordScore({ ...rich, network }, prior).score - trackRecordScore(rich, prior).score;
  assert.ok(richLift >= 0 && richLift < thinLift / 2, `a rich local record leans on the network far less (${richLift} vs ${thinLift})`);
  assert.ok(richLift <= WEIGHT_TRACK_RECORD * TRACK_RECORD_PRIOR_CASES / (22 + TRACK_RECORD_PRIOR_CASES), 'the prior weighs k / (n + k) at most');
  // With no local history, the disclosed network figures are the score.
  assert.equal(trackRecordScore({ admits: 0, nonAdmits: 0, avgFamilyExperience: null, network }, prior).score, priorTrackRecordScore(priorForCard({ admits: 0, nonAdmits: 0, avgFamilyExperience: null, network }, prior)));
  assert.ok(trackRecordScore({ admits: 0, nonAdmits: 0, avgFamilyExperience: null, network }, prior).score > trackRecordScore(undefined, prior).score, 'a strong network record lifts a never-used program');
  assert.deepEqual(priorForCard({ ...thin, network: { admitRate: null, familyExperience: null, completionRate: null } }, prior), prior, 'withheld network figures fall back to the workspace prior');
  // Referral counts still never change the order, with completion in play.
  const programs = ['one-five', 'twenty', 'n1', 'n2'].map((id) => partner({ id }));
  const order = ids(rankPrograms(profile({ id: 'm-outcomes', insurance: 'Cash pay' }), programs, cards));
  const permuted = programs.map((item, index) => ({ ...item, inbound: 40 - index * 7, outbound: index * 11 }));
  assert.deepEqual(ids(rankPrograms(profile({ id: 'm-outcomes', insurance: 'Cash pay' }), permuted, cards)), order);
  assert.equal(order[0], 'twenty');
}

// ─── (h) location preference: what the GEOGRAPHY state means ───────────────

{
  // Away from home: the state is home, not a filter. Every out-of-state
  // program stays and scores the location points; home-state programs stay
  // too (a preference demotes, it never hides) with none. Before, the state
  // still filtered, so only home-state programs (scored 0) and nationwide
  // ones survived: the preference hid exactly what the family asked for.
  const inOR = partner({ id: 'in-or', state: 'OR' });
  const inCA = partner({ id: 'in-ca', state: 'CA' });
  const inWA = partner({ id: 'in-wa', state: 'WA' });
  const natCA = partner({ id: 'nat-ca', state: 'CA', regions: ['Nationwide'] });
  const programs = [inOR, inCA, inWA, natCA];
  const away = rankPrograms(profile({ state: 'OR', locationPreference: 'Away from home' }), programs, noCards);
  assert.deepEqual(ids(away).sort(), ['in-ca', 'in-or', 'in-wa', 'nat-ca'], 'away from home hides nothing for being out of state');
  assert.equal(ids(away).at(-1), 'in-or', 'the home-state program sorts last');
  assert.ok(away.every((score) => score.regionFit && !score.failedRequirements.includes('location')));
  assert.deepEqual(away.map((score) => score.components.location), [10, 10, 10, 0]);
  assert.deepEqual(away.map((score) => score.sameState), [false, false, false, true]);
  // Close to family and No preference keep the state as the search area.
  const close = rankPrograms(profile({ state: 'OR', locationPreference: 'Close to family' }), programs, noCards);
  assert.deepEqual(ids(close), ['in-or', 'nat-ca']);
  assert.deepEqual(close.map((score) => score.components.location), [10, 0]);
  const none = rankPrograms(profile({ state: 'OR', locationPreference: 'No preference' }), programs, noCards);
  assert.deepEqual(ids(none).sort(), ['in-or', 'nat-ca']);
  assert.deepEqual(ids(rankPrograms(profile({ state: 'OR' }), programs, noCards)).sort(), ['in-or', 'nat-ca'], 'an older profile with no preference filters as before');
  const hidden = scoreProgram(profile({ state: 'OR', locationPreference: 'Close to family' }), inCA, undefined, trackRecordPrior(noCards));
  assert.deepEqual(hidden.failedRequirements, ['location'], 'out of state is a requirement under close to family: hidden, not demoted');
  // No state: nothing to filter by or measure from, whatever the preference.
  for (const locationPreference of ['No preference', 'Close to family', 'Away from home']) {
    assert.equal(rankPrograms(profile({ state: 'ANY', locationPreference }), programs, noCards).length, 4);
  }
  assert.equal(regionFitForPartner({ state: 'OR', locationPreference: 'Away from home' }, inCA), true);
  assert.equal(regionFitForPartner({ state: 'OR', locationPreference: 'Close to family' }, inCA), false);
  assert.equal(regionFitForPartner({ state: 'OR' }, inCA), false);
}

// ─── (i) a cash cost not on file is unknown, never free ────────────────────

{
  const prior = trackRecordPrior(noCards);
  const unknown = partner({ id: 'unknown', monthlyCost: 0, cashMin: 0, cashMax: 0 });
  assert.equal(knownMonthlyCostForPartner(unknown), null);
  assert.equal(monthlyCostForPartner(unknown), 0, 'display value stays 0 for the UI');
  assert.equal(knownMonthlyCostForPartner(partner({ monthlyCost: 0, cashMax: 15000, cashMin: 9000 })), 15000, 'a blank monthly cost falls back to the legacy range, as on load');
  assert.equal(knownMonthlyCostForPartner(partner({ monthlyCost: undefined, cashMax: 0, cashMin: 9000 })), 9000);
  // Reviewer's case: budget 30,000; a priced program vs one with no cost.
  // The unknown used to earn the full 25 and win.
  const priced = partner({ id: 'priced', monthlyCost: 9000 });
  const budgeted = rankPrograms(profile({ insurance: 'Cash pay', maxBudget: 30000 }), [unknown, priced], noCards);
  assert.deepEqual(ids(budgeted), ['priced', 'unknown']);
  assert.equal(budgeted[1].components.cost, 12.5, 'unknown cost earns neutral points, never full');
  assert.ok(budgeted[0].components.cost > budgeted[1].components.cost);
  assert.equal(budgeted[1].familyCost, null);
  assert.equal(budgeted[1].eligible, true, 'an unknown cost is not hidden: the budget cannot be checked either way');
  // Equal fit: a known cost sorts first in the tie-break, budget or not.
  const atBudget = partner({ id: 'at-budget', monthlyCost: 30000 });
  for (const id of ['m-x', 'm-y', 'm-z', 'm-w']) {
    const tied = rankPrograms(profile({ id, insurance: 'Cash pay', maxBudget: 30000 }), [unknown, atBudget], noCards);
    assert.equal(tied[0].total, tied[1].total, 'at budget and unknown score the same');
    assert.deepEqual(ids(tied), ['at-budget', 'unknown'], 'a known cost wins the tie over an unknown one');
    const noBudget = rankPrograms(profile({ id, insurance: 'Cash pay' }), [unknown, partner({ id: 'dear', monthlyCost: 90000 })], noCards);
    assert.deepEqual(ids(noBudget), ['dear', 'unknown'], 'even an expensive known cost sorts before an unknown one');
  }
  // Two unknowns still rotate by profile id, like any other tie.
  const unknowns = Array.from({ length: 6 }, (_, i) => partner({ id: `u-${i}`, monthlyCost: 0, cashMin: 0, cashMax: 0 }));
  const orders = new Set(Array.from({ length: 12 }, (_, i) => ids(rankPrograms(profile({ id: `fam-${i}`, insurance: 'Cash pay' }), unknowns, noCards)).join(',')));
  assert.ok(orders.size >= 4);
  // Insurance is untouched: in-network still 0, out-of-network 1.
  const inNet = scoreProgram(profile({ insurance: 'Aetna' }), partner({ insurance: ['Aetna'], insuranceNetworks: { Aetna: ['In-network'] }, monthlyCost: 0 }), undefined, prior);
  assert.equal(inNet.familyCost, 0);
  assert.equal(inNet.components.cost, WEIGHT_FAMILY_COST);
}

// ─── Placement helpers ──────────────────────────────────────────────────────

{
  const ranked = rankPrograms(profile({ insurance: 'Cash pay' }), Array.from({ length: 7 }, (_, i) => partner({ id: `c${i}`, monthlyCost: 1000 * (i + 1) })), noCards);
  const shown = placementCandidates(ranked);
  assert.equal(shown.length, 5);
  assert.deepEqual(shown.map((c) => c.rank), [1, 2, 3, 4, 5]);
  assert.ok(shown.every((c) => typeof c.total === 'number' && c.components && typeof c.disclosure === 'boolean'));
  assert.equal(rankOfPartner(ranked, ranked[2].partner.id), 3);
  assert.equal(rankOfPartner(ranked, 'not-shown'), 8);
}

console.log('matching integrity: ok');
unlinkSync(path.join(tmpDir, 'data.js'));
unlinkSync(path.join(tmpDir, 'lib', 'matching.js'));
