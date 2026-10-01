// Matching integrity: src/lib/matching.ts run in plain node, no build step.
//
//   (a) a program failing any hard requirement is hidden, never demoted
//   (b) referral counts can never change the order (property-style)
//   (c) score components sum to the total, max 100, weights as documented
//   (d) ties: lower family cost first, then a rotation that is stable for one
//       match profile id and differs across ids
//   (e) track record: one 5-star review cannot outrank twenty 4.6s
//   (f) a financial relationship never changes the order or any score

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
transpileTo('src/lib/matching.ts', 'lib/matching.js');

const m = require(path.join(tmpDir, 'lib', 'matching.js'));
const {
  rankPrograms, scoreProgram, trackRecordPrior, trackRecordScore, rotationKey, defaultMustHaveNeeds,
  mustHaveNeedsForProfile, populationForProfile, rankOfPartner, placementCandidates,
  WEIGHT_CLINICAL_FIT, WEIGHT_FAMILY_COST, WEIGHT_LOCATION, WEIGHT_TRACK_RECORD, MAX_SCORE,
  TRACK_RECORD_PRIOR_CASES, MUST_HAVE_BY_DEFAULT, OUT_OF_NETWORK_COST_SHARE,
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
  assert.equal(cash(0, 10000), 25);
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
  assert.equal(trackRecordScore(undefined, prior).score, 7.5, 'no data is neutral');
  assert.equal(trackRecordScore({ admits: 0, nonAdmits: 0, avgFamilyExperience: 5 }, prior).score, 7.5, 'a rating with no decided cases is still neutral');
  // End to end: identical programs except the scorecard.
  const a = partner({ id: 'one-five' });
  const b = partner({ id: 'twenty' });
  assert.deepEqual(ids(rankPrograms(profile({ insurance: 'Cash pay' }), [a, b], cards)), ['twenty', 'one-five']);
  // More evidence moves the score further from the prior, in both directions.
  const strong = trackRecordScore({ admits: 20, nonAdmits: 0, avgFamilyExperience: 5 }, prior).score;
  const weak = trackRecordScore({ admits: 0, nonAdmits: 20, avgFamilyExperience: 1 }, prior).score;
  assert.ok(strong > 7.5 && strong <= 15 && weak < 7.5 && weak >= 0);
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
