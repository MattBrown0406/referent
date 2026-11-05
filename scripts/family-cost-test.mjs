// True cost to the family: src/lib/family-cost.ts and family-cost-form.ts run
// in plain node, no build step (same transpile approach as packet-test.mjs).
//
//   (a) in-network: deductible partly met, fully met, under the deductible,
//       the out-of-pocket cap, coinsurance 0 and 100, copays, billed-only
//   (b) out-of-network: with benefits (balance billing on top, uncapped),
//       allowed-only / billed-only, no out-of-network benefits, not known
//   (c) cash pay from the monthly cost and the legacy cash range
//   (d) unknowns: always "unknown" with what is missing, never $0
//   (e) length of stay: every route scales, bad values fall back to 30
//   (f) which VOB speaks for a program, and which programs a case lists
//   (g) the form: parseWholeDollars amounts, percent, the server's rules
//   (h) the wire format matches the migration's columns
//   (i) the packet: the family copy gets the estimate, the program copy never
//   (j) matching integrity: estimating never changes a score or the order

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'family-cost-test');
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

mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
transpileTo('src/data.ts', 'data.js');
for (const name of ['beds', 'matching', 'insurance', 'family-cost', 'family-cost-form', 'packet', 'business', 'paging', 'outcomes']) {
  transpileTo(`src/lib/${name}.ts`, `lib/${name}.js`);
}
// business.ts (parseWholeDollars) reaches Supabase at module load; stub only that.
writeFileSync(path.join(tmpDir, 'lib', 'errors.js'), 'exports.StoreError = class StoreError extends Error {};');
writeFileSync(path.join(tmpDir, 'lib', 'auth-session.js'), 'exports.currentAuthSessionIdentity = async () => null;');
writeFileSync(path.join(tmpDir, 'lib', 'supabase.js'), 'exports.supabase = {};');

const fc = require(path.join(tmpDir, 'lib', 'family-cost.js'));
const form = require(path.join(tmpDir, 'lib', 'family-cost-form.js'));
const { buildPacket, buildFitReasons, packetFitInput } = require(path.join(tmpDir, 'lib', 'packet.js'));
const matching = require(path.join(tmpDir, 'lib', 'matching.js'));
const { parseWholeDollars } = require(path.join(tmpDir, 'lib', 'business.js'));
const {
  estimateFamilyCost, formatCostRange, familyCostCardLine, normalizeStayDays, planShare,
  familyCostForProgram, vobForProgram, caseCostPrograms, familyCostPacketLines, perProgramNetwork,
  planCostsProblem, vobCostsProblem, networkBenefitsSummary, outOfNetworkSummary, hasPlanCosts,
  BALANCE_BILLING_WARNING, PRECERT_WARNING, PACKET_COST_DISCLAIMER, DEFAULT_STAY_DAYS, MAX_STAY_DAYS,
} = fc;
// The wire format lives beside the types (cases.ts reads and writes with it).
const {
  planCostsFromRow, planCostsToPatch, vobCostsFromRow, vobCostsToPatch, PLAN_COST_COLUMNS, VOB_COST_COLUMNS,
} = require(path.join(tmpDir, 'lib', 'insurance.js'));

let checks = 0;
function check(label, actual, expected) {
  assert.deepEqual(actual, expected, label);
  checks += 1;
}
function ok(label, value) {
  assert.ok(value, label);
  checks += 1;
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const none = { deductible: null, deductibleMet: null, oopMax: null, oopMet: null, coinsurancePct: null };
// In-network: $3,000 deductible with $1,000 met, $6,000 out-of-pocket max
// with $1,500 met, 20% coinsurance. Out-of-network: $6,000 / $12,000 / 40%.
const inNet = { deductible: 3000, deductibleMet: 1000, oopMax: 6000, oopMet: 1500, coinsurancePct: 20 };
const oonNet = { deductible: 6000, deductibleMet: 0, oopMax: 12000, oopMet: 0, coinsurancePct: 40 };
const plan = { inNetwork: inNet, outOfNetwork: oonNet, oonBenefits: true };
const vob = (over = {}) => ({ allowedDailyRate: null, billedDailyRate: null, copayPerDay: null, precertRequired: null, quotedOutOfPocket: null, ...over });
const program = { monthlyCost: 30000, cashMin: 30000, cashMax: 30000 };
const est = (over) => estimateFamilyCost({ payment: 'insurance', network: 'in_network', confirmedByVob: true, benefits: plan, vob: vob(), program, ...over });

// ─── (a) In-network ─────────────────────────────────────────────────────────

{
  // $300 a day x 30 = $9,000 allowed. Deductible left $2,000, then 20% of
  // $7,000 = $1,400: $3,400, under the $4,500 out-of-pocket left.
  const r = est({ vob: vob({ allowedDailyRate: 300 }) });
  check('partly met deductible: known', r.known, true);
  check('partly met deductible: route', r.route, 'in_network');
  check('partly met deductible: $3,400', [r.low, r.high], [3400, 3400]);
  check('partly met deductible: range text', formatCostRange(r), '$3,400');
  check('card line', familyCostCardLine(r), 'Est. family cost (30 days): $3,400');
  ok('basis says confirmed by VOB', r.basis[0] === 'In-network, confirmed by VOB');
  ok('basis shows the deductible left', r.basis.includes('Deductible left: $2,000'));
  ok('basis shows the coinsurance', r.basis.includes('After that the family pays 20% coinsurance'));
  ok('basis shows the out-of-pocket left', r.basis.includes('Out-of-pocket max left: $4,500'));
  check('no warnings in-network without pre-authorization', r.warnings, []);
  check('not balance billing in-network', r.balanceBilling, false);
}
{
  // $800 a day x 30 = $24,000: $2,000 + 20% of $22,000 = $6,400 > $4,500 left.
  const r = est({ vob: vob({ allowedDailyRate: 800 }) });
  check('out-of-pocket cap reached: capped at what is left', [r.low, r.high], [4500, 4500]);
  ok('basis says the cap applies', r.basis.some((line) => line.endsWith('which caps the total')));
}
{
  const r = est({ benefits: { ...plan, inNetwork: { ...inNet, oopMet: 6000 } }, vob: vob({ allowedDailyRate: 800 }) });
  check('out-of-pocket already met: a real $0', [r.known, r.low, r.high], [true, 0, 0]);
  check('a known $0 is shown as $0', formatCostRange(r), '$0');
}
{
  const r = est({ benefits: { ...plan, inNetwork: { ...inNet, deductibleMet: 3000 } }, vob: vob({ allowedDailyRate: 300 }) });
  check('deductible fully met: coinsurance only (20% of $9,000)', [r.low, r.high], [1800, 1800]);
}
{
  // $50 a day x 30 = $1,500 of care, under the $2,000 deductible left: the
  // family pays the $1,500, not $2,000 plus a negative coinsurance.
  const r = est({ vob: vob({ allowedDailyRate: 50 }) });
  check('a stay that never clears the deductible', [r.low, r.high], [1500, 1500]);
}
{
  const r = est({ benefits: { ...plan, inNetwork: { ...inNet, coinsurancePct: 0 } }, vob: vob({ allowedDailyRate: 800 }) });
  check('coinsurance 0: only the deductible left', [r.low, r.high], [2000, 2000]);
}
{
  const r = est({ benefits: { ...plan, inNetwork: { ...inNet, coinsurancePct: 100 } }, vob: vob({ allowedDailyRate: 800 }) });
  check('coinsurance 100: everything, up to the cap', [r.low, r.high], [4500, 4500]);
  const uncapped = est({ benefits: { ...plan, inNetwork: { ...inNet, coinsurancePct: 100, oopMax: null, oopMet: null } }, vob: vob({ allowedDailyRate: 800 }) });
  check('coinsurance 100 with no out-of-pocket max: the whole allowed cost', [uncapped.low, uncapped.high], [24000, 24000]);
  ok('no cap is said out loud', uncapped.basis.includes('No out-of-pocket max on file, so nothing is capped'));
}
{
  const r = est({ benefits: { ...plan, inNetwork: { ...inNet, deductibleMet: null, oopMet: null } }, vob: vob({ allowedDailyRate: 300 }) });
  // Nothing met: $3,000 + 20% of $6,000 = $4,200, under the full $6,000.
  check('met amounts left blank read as nothing met (can only overstate)', [r.low, r.high], [4200, 4200]);
  ok('the assumption is in the basis', r.basis.includes('Deductible left: $3,000 (assuming none is met yet)'));
  ok('the out-of-pocket assumption too', r.basis.some((line) => line.includes('(assuming nothing is paid toward it yet)')));
}
{
  // $300 x 30 = $9,000: share $3,400; copays $50 x 30 = $1,500.
  // Counting toward the max: min($4,900, $4,500) = $4,500. Not: $3,400 + $1,500.
  const r = est({ vob: vob({ allowedDailyRate: 300, copayPerDay: 50 }) });
  check('copays: low counts them toward the max, high does not', [r.low, r.high], [4500, 4900]);
  check('copays: range text', formatCostRange(r), '$4,500–$4,900');
  ok('copays are explained', r.basis.includes('Copay: $50 a day, $1,500 in all'));
  ok('the range is explained', r.basis.includes('The higher number is for a plan that does not count copays toward the out-of-pocket max'));
  const noMax = est({ benefits: { ...plan, inNetwork: { ...inNet, oopMax: null, oopMet: null } }, vob: vob({ allowedDailyRate: 300, copayPerDay: 50 }) });
  check('copays with no max: simply added', [noMax.low, noMax.high], [4900, 4900]);
}
{
  // Billed only: the allowed amount can only be lower, so it is a ceiling.
  // $1,000 x 30 = $30,000: $2,000 + 20% of $28,000 = $7,600, capped at $4,500.
  const r = est({ vob: vob({ billedDailyRate: 1000 }) });
  check('billed only in-network: "up to"', [r.low, r.high], [null, 4500]);
  check('billed only in-network: text', formatCostRange(r), 'up to $4,500');
  const small = est({ vob: vob({ billedDailyRate: 100 }) });
  // $3,000: $2,000 + 20% of $1,000 = $2,200.
  check('billed only, under the cap', formatCostRange(small), 'up to $2,200');
}
{
  const r = est({ confirmedByVob: false, vob: vob({ allowedDailyRate: 300 }) });
  ok('per program network is labelled as such', r.basis[0] === 'In-network, as the program reports it (a VOB confirms it)');
  const pre = est({ vob: vob({ allowedDailyRate: 300, precertRequired: true }) });
  check('pre-authorization: warned', pre.warnings, [PRECERT_WARNING]);
  check('pre-authorization: carried', pre.precertRequired, true);
  const quoted = est({ vob: vob({ allowedDailyRate: 300, quotedOutOfPocket: 2500 }) });
  ok('the program quote rides along', quoted.basis.includes('The program quoted about $2,500 out of pocket'));
}
{
  // planShare on its own: the formulas exactly.
  check('planShare: partly met', planShare(9000, inNet), { low: 3400, high: 3400, deductibleLeft: 2000, oopLeft: 4500, capped: false });
  check('planShare: capped', planShare(24000, inNet).capped, true);
  check('planShare: no deductible', planShare(10000, { ...none, deductible: 0, coinsurancePct: 30 }).low, 3000);
}

// ─── (b) Out-of-network ─────────────────────────────────────────────────────

{
  // Allowed $600 x 30 = $18,000: $6,000 + 40% of $12,000 = $10,800 (under
  // the $12,000 max). Balance bill ($1,200 - $600) x 30 = $18,000, uncapped.
  const r = est({ network: 'out_of_network', vob: vob({ allowedDailyRate: 600, billedDailyRate: 1200 }) });
  check('OON with benefits: share, then the balance bill on top', [r.low, r.high], [10800, 28800]);
  check('OON: route', r.route, 'out_of_network');
  check('OON: balance billing flagged', r.balanceBilling, true);
  ok('OON: the balance-billing warning', r.warnings.includes(BALANCE_BILLING_WARNING));
  ok('OON: the balance bill is in the basis', r.basis.some((line) => line.startsWith('Balance bill: $600 a day')));
  check('OON: family note for the packet', r.note, 'the program can also bill what the plan does not cover');
}
{
  const capped = est({ network: 'out_of_network', vob: vob({ allowedDailyRate: 1000, billedDailyRate: 1500 }) });
  // $30,000 allowed: $6,000 + 40% of $24,000 = $15,600 -> capped at $12,000;
  // the $15,000 balance bill is NOT capped: $27,000.
  check('OON: the max caps the share, never the balance bill', [capped.low, capped.high], [12000, 27000]);
  const allowedOnly = est({ network: 'out_of_network', vob: vob({ allowedDailyRate: 600 }) });
  check('OON allowed only: "or more" (balance bill unpriced)', formatCostRange(allowedOnly), '$10,800 or more');
  const billedOnly = est({ network: 'out_of_network', vob: vob({ billedDailyRate: 1200 }) });
  // As if the plan allowed $36,000: $6,000 + 40% of $30,000 = $18,000 -> $12,000 cap. Best case.
  check('OON billed only: the best case, "or more"', [billedOnly.low, billedOnly.high], [12000, null]);
  check('OON billed only: text', formatCostRange(billedOnly), '$12,000 or more');
  ok('OON billed only: still warned', billedOnly.warnings.includes(BALANCE_BILLING_WARNING));
  const noBalance = est({ network: 'out_of_network', vob: vob({ allowedDailyRate: 600, billedDailyRate: 600 }) });
  check('OON billed = allowed: no balance bill', [noBalance.low, noBalance.high], [10800, 10800]);
  ok('OON billed = allowed: still warned', noBalance.warnings.includes(BALANCE_BILLING_WARNING));
}
{
  const noOon = { ...plan, outOfNetwork: none, oonBenefits: false };
  const billed = est({ network: 'out_of_network', benefits: noOon, vob: vob({ billedDailyRate: 1200 }) });
  check('no OON benefits: the full billed cost', [billed.route, billed.low, billed.high], ['full_cost', 36000, 36000]);
  ok('no OON benefits: said plainly', billed.basis[0] === 'The plan has no out-of-network benefits, so the family pays the full cost');
  check('no OON benefits: family note', billed.note, 'the plan does not pay for out-of-network care');
  const cash = est({ network: 'out_of_network', benefits: noOon, vob: vob() });
  check('no OON benefits, no billed rate: the cash cost', [cash.low, cash.high], [30000, 30000]);
  const neither = est({ network: 'out_of_network', benefits: noOon, vob: vob(), program: { monthlyCost: 0, cashMin: 0, cashMax: 0 } });
  check('no OON benefits and no price: unknown', [neither.known, neither.low, neither.high, neither.nextStep], [false, null, null, 'add the daily rate']);
}
{
  const unknownOon = est({ network: 'out_of_network', benefits: { ...plan, outOfNetwork: none, oonBenefits: null }, vob: vob({ allowedDailyRate: 600 }) });
  check('OON benefits not known: unknown', unknownOon.known, false);
  check('OON benefits not known: next step', unknownOon.nextStep, 'add out-of-network benefits');
  ok('OON benefits not known: says what is missing', unknownOon.missing.includes('whether the plan pays anything out-of-network'));
  ok('OON benefits not known: balance billing still warned', unknownOon.warnings.includes(BALANCE_BILLING_WARNING));
  const implied = est({ network: 'out_of_network', benefits: { ...plan, oonBenefits: null }, vob: vob({ allowedDailyRate: 600, billedDailyRate: 1200 }) });
  check('OON amounts entered imply benefits', [implied.low, implied.high], [10800, 28800]);
  const notAccepted = est({ network: 'not_accepted', vob: vob({ billedDailyRate: 1200 }) });
  check('not accepted: the full cost', [notAccepted.route, notAccepted.low], ['full_cost', 36000]);
  check('not accepted: family note', notAccepted.note, 'the program does not take this plan');
}

// ─── (c) Cash ───────────────────────────────────────────────────────────────

{
  const cash = (programOver, days) => estimateFamilyCost({ payment: 'cash', network: 'unknown', benefits: null, vob: null, program: programOver, days });
  check('cash: monthly cost for 30 days', formatCostRange(cash(program)), '$30,000');
  check('cash: route', cash(program).route, 'cash');
  check('cash: 45 days', [cash(program, 45).low, cash(program, 45).high], [45000, 45000]);
  check('cash: 14 days', cash(program, 14).low, 14000);
  ok('cash: basis shows the daily rate', cash(program).basis.includes('The program’s cash cost: $30,000 a month (about $1,000 a day) × 30 days'));
  // A legacy range (store.ts loads monthlyCost as cash_max when it is blank).
  const range = { monthlyCost: 42000, cashMin: 18000, cashMax: 42000 };
  check('cash: legacy range', formatCostRange(cash(range)), '$18,000–$42,000');
  check('cash: legacy range, monthly blank', formatCostRange(cash({ monthlyCost: 0, cashMin: 18000, cashMax: 42000 })), '$18,000–$42,000');
  check('cash: an explicit monthly cost beats the range', formatCostRange(cash({ monthlyCost: 25000, cashMin: 18000, cashMax: 42000 })), '$25,000');
  const blank = cash({ monthlyCost: 0, cashMin: 0, cashMax: 0 });
  check('cash: nothing on file is unknown, never $0', [blank.known, formatCostRange(blank)], [false, 'unknown']);
  check('cash: card line for unknown', familyCostCardLine(blank), 'Est. family cost (30 days): unknown — add the cash cost');
  check('cash: no program at all is unknown', cash(null).known, false);
  ok('cash: never warned about insurance', cash(program).warnings.length === 0 && !cash(program).balanceBilling);
}

// ─── (d) Unknowns ───────────────────────────────────────────────────────────

{
  const noPlan = est({ benefits: null, vob: vob({ allowedDailyRate: 300 }) });
  check('no plan on file: unknown', [noPlan.known, noPlan.low, noPlan.high], [false, null, null]);
  check('no plan on file: card line', familyCostCardLine(noPlan), 'Est. family cost (30 days): unknown — add benefits');
  const carrierOnly = est({ benefits: { inNetwork: none, outOfNetwork: none, oonBenefits: null }, vob: vob({ allowedDailyRate: 300 }) });
  check('a plan with no amounts: add benefits', carrierOnly.nextStep, 'add benefits');
  const noRate = est({ vob: vob() });
  check('no daily rate: unknown', noRate.known, false);
  check('no daily rate: next step', noRate.nextStep, 'add the daily rate');
  ok('no daily rate: the in-network ceiling is still stated', noRate.basis.includes('In-network, the out-of-pocket max left ($4,500) is usually the most the family pays this plan year'));
  const noVob = est({ vob: null });
  check('no VOB at all: unknown', noVob.nextStep, 'add the daily rate');
  const noCoins = est({ benefits: { ...plan, inNetwork: { ...inNet, coinsurancePct: null } }, vob: vob({ allowedDailyRate: 300 }) });
  check('no coinsurance: unknown with what is missing', noCoins.missing, ['the in-network coinsurance']);
  const noDeductible = est({ benefits: { ...plan, inNetwork: { ...inNet, deductible: null } }, vob: vob() });
  check('no deductible and no rate: both listed', noDeductible.missing, ['the in-network deductible', 'the program’s daily rate (record it on the VOB answer)']);
  const network = est({ network: 'unknown', vob: vob({ allowedDailyRate: 300 }) });
  check('network not known: request a VOB', [network.known, network.nextStep, network.route], [false, 'request a VOB', 'unknown']);
  const nothing = est({ network: 'unknown', benefits: null });
  check('nothing known: benefits first', [nothing.nextStep, nothing.missing.length], ['add benefits', 2]);
  // Whatever the low/high fields hold, unknown is never "$0".
  check('formatCostRange never says $0 for unknown', formatCostRange({ known: false, low: 0, high: 0 }), 'unknown');
  for (const r of [noPlan, carrierOnly, noRate, noVob, noCoins, network, nothing]) {
    ok('unknown never carries numbers', r.low === null && r.high === null && !familyCostCardLine(r).includes('$'));
    ok('unknown never says affordable', !JSON.stringify(r).toLowerCase().includes('afford'));
  }
}

// ─── (e) Length of stay ─────────────────────────────────────────────────────

{
  check('default stay', DEFAULT_STAY_DAYS, 30);
  check('normalize: missing', normalizeStayDays(undefined), 30);
  check('normalize: 0', normalizeStayDays(0), 30);
  check('normalize: negative', normalizeStayDays(-5), 30);
  check('normalize: NaN', normalizeStayDays(Number.NaN), 30);
  check('normalize: rounds', normalizeStayDays(44.6), 45);
  check('normalize: caps at a year', normalizeStayDays(400), MAX_STAY_DAYS);
  // In-network $300 a day: 14 days = $4,200 -> $2,000 + 20% of $2,200 = $2,440;
  // 60 days = $18,000 -> $5,200 -> capped at $4,500.
  const at = (days) => est({ days, vob: vob({ allowedDailyRate: 300 }) });
  check('stay 14 days', at(14).low, 2440);
  check('stay 30 days', at(30).low, 3400);
  check('stay 60 days hits the cap', at(60).low, 4500);
  check('the card line names the stay', familyCostCardLine(at(60)), 'Est. family cost (60 days): $4,500');
  const oon = (days) => est({ days, network: 'out_of_network', vob: vob({ allowedDailyRate: 600, billedDailyRate: 1200 }) });
  // 10 days: $6,000 allowed -> all deductible: $6,000; balance $6,000.
  check('OON 10 days', [oon(10).low, oon(10).high], [6000, 12000]);
  check('OON balance bill grows with the stay, uncapped', oon(90).high - oon(90).low, 600 * 90);
  check('full cost scales', est({ days: 10, network: 'not_accepted', vob: vob({ billedDailyRate: 1200 }) }).low, 12000);
  check('an invalid stay falls back to 30 days', est({ days: 0, vob: vob({ allowedDailyRate: 300 }) }).days, 30);
}

// ─── (f) One program on one case ────────────────────────────────────────────

const vobRow = (over) => ({
  id: over.id, caseId: 'c1', partnerId: undefined, programName: 'Cascade Recovery', status: 'requested',
  requestedAt: '2026-11-01T10:00:00Z', answeredAt: undefined, answeredBy: '', note: '', quotedOutOfPocket: null,
  allowedDailyRate: null, billedDailyRate: null, copayPerDay: null, precertRequired: null, ...over,
});
{
  const requests = [
    vobRow({ id: 'old', partnerId: 'p1', status: 'out_of_network', answeredAt: '2026-11-01T12:00:00Z', allowedDailyRate: 500 }),
    vobRow({ id: 'new', partnerId: 'p1', status: 'in_network', answeredAt: '2026-11-03T12:00:00Z', allowedDailyRate: 300 }),
    vobRow({ id: 'open', partnerId: 'p1', status: 'pending', requestedAt: '2026-11-04T09:00:00Z', billedDailyRate: 999 }),
    vobRow({ id: 'other', partnerId: 'p2', status: 'in_network', answeredAt: '2026-11-04T12:00:00Z', allowedDailyRate: 1 }),
  ];
  check('the latest answered VOB speaks for the program', vobForProgram(requests, { partnerId: 'p1', programName: 'Cascade Recovery' }).id, 'new');
  check('another program’s answer never counts', vobForProgram(requests, { partnerId: 'p3', programName: 'Elsewhere' }), null);
  const unanswered = [vobRow({ id: 'a', partnerId: 'p1' }), vobRow({ id: 'b', partnerId: 'p1', billedDailyRate: 900, requestedAt: '2026-10-30T10:00:00Z' })];
  check('no answer yet: the one with rates on it', vobForProgram(unanswered, { partnerId: 'p1', programName: 'x' }).id, 'b');
  check('no answer and no rates: none', vobForProgram([vobRow({ id: 'a', partnerId: 'p1' })], { partnerId: 'p1', programName: 'x' }), null);
  const byName = [vobRow({ id: 'typed', programName: '  cascade RECOVERY ', status: 'in_network', answeredAt: '2026-11-02T00:00:00Z', allowedDailyRate: 300 })];
  check('a VOB typed by name counts for the partner with that name', vobForProgram(byName, { partnerId: 'p9', programName: 'Cascade Recovery' }).id, 'typed');

  const partner = { id: 'p1', organization: 'Cascade Recovery', ...program };
  const answered = familyCostForProgram({ insurance: 'Aetna', plan, requests, partner, perProgram: 'out_of_network' });
  check('a VOB answer beats what the program reports', [answered.route, answered.low], ['in_network', 3400]);
  ok('and says it was confirmed', answered.basis[0] === 'In-network, confirmed by VOB');
  const reported = familyCostForProgram({ insurance: 'Aetna', plan, requests: unanswered, partner, perProgram: 'in_network' });
  check('no answer: the program’s own network, the VOB’s billed rate', [reported.route, reported.low, reported.high], ['in_network', null, 4500]);
  const cashPay = familyCostForProgram({ insurance: 'Cash pay', plan, requests, partner, perProgram: 'in_network' });
  check('cash pay ignores the plan and the VOBs', [cashPay.route, cashPay.low], ['cash', 30000]);
  const days = familyCostForProgram({ insurance: 'Aetna', plan, requests, partner, perProgram: 'in_network', days: 14 });
  check('the stay passes through', [days.days, days.low], [14, 2440]);
  check('perProgramNetwork', [perProgramNetwork('In-network'), perProgramNetwork('Out-of-network'), perProgramNetwork(null)], ['in_network', 'out_of_network', 'unknown']);
}
{
  const partners = [{ id: 'p1', organization: 'Cascade Recovery' }, { id: 'p2', organization: 'Juniper Ridge' }, { id: 'p3', organization: 'Old Mill' }];
  const requests = [
    vobRow({ id: '1', partnerId: 'p2', programName: 'Juniper Ridge', requestedAt: '2026-11-01T00:00:00Z' }),
    vobRow({ id: '2', partnerId: 'p1', programName: 'Cascade Recovery', requestedAt: '2026-11-03T00:00:00Z' }),
    vobRow({ id: '3', partnerId: 'p2', programName: 'Juniper Ridge', requestedAt: '2026-11-04T00:00:00Z' }),
    vobRow({ id: '4', programName: 'juniper ridge', requestedAt: '2026-11-02T00:00:00Z' }),
    vobRow({ id: '5', programName: 'Sunrise House', requestedAt: '2026-10-30T00:00:00Z' }),
    vobRow({ id: '6', programName: '   ', requestedAt: '2026-10-29T00:00:00Z' }),
  ];
  check('case programs: referred program first, then VOBs newest first, once each',
    caseCostPrograms(requests, partners, 'p3').map((item) => item.programName),
    ['Old Mill', 'Juniper Ridge', 'Cascade Recovery', 'Sunrise House']);
  check('case programs: no referral', caseCostPrograms(requests, partners).map((item) => item.key), ['partner:p2', 'partner:p1', 'name:sunrise house']);
  check('case programs: none', caseCostPrograms([], partners), []);
}

// ─── (g) The form ───────────────────────────────────────────────────────────

{
  const draft = {
    inNetwork: { deductible: '$3,000', deductibleMet: '1,000', oopMax: '6000', oopMet: '', coinsurancePct: '20%' },
    outOfNetwork: { deductible: '6000', deductibleMet: '0', oopMax: '12,000', oopMet: '', coinsurancePct: ' 40 ' },
    oonBenefits: true,
  };
  const parsed = form.parsePlanCostsDraft(draft);
  check('form: amounts as whole dollars', parsed, {
    ok: true,
    value: {
      inNetwork: { deductible: 3000, deductibleMet: 1000, oopMax: 6000, oopMet: null, coinsurancePct: 20 },
      outOfNetwork: { deductible: 6000, deductibleMet: 0, oopMax: 12000, oopMet: null, coinsurancePct: 40 },
      oonBenefits: true,
    },
  });
  // The same parser as every money field in the app.
  for (const typed of ['$3,000', '1,000', '6000', '', '0', '1500.00', '1500.50', '4,50', 'abc']) {
    const one = form.parsePlanCostsDraft({ ...draft, inNetwork: { ...draft.inNetwork, deductibleMet: '', deductible: typed } });
    const expected = parseWholeDollars(typed);
    check(`form: "${typed}" reads as parseWholeDollars does`, one.ok ? one.value.inNetwork.deductible : undefined, expected);
  }
  check('form: cents are refused in plain words', form.parsePlanCostsDraft({ ...draft, inNetwork: { ...draft.inNetwork, deductible: '3000.50' } }),
    { ok: false, message: 'In-network deductible: enter whole dollars, like 1500 or $1,500, or leave it blank.' });
  check('form: coinsurance over 100', form.parsePlanCostsDraft({ ...draft, inNetwork: { ...draft.inNetwork, coinsurancePct: '120' } }).ok, false);
  check('form: met above the total', form.parsePlanCostsDraft({ ...draft, inNetwork: { ...draft.inNetwork, deductibleMet: '5000' } }),
    { ok: false, message: 'In-network: the deductible met so far cannot be more than the deductible.' });
  check('form: out-of-pocket met above the max', form.parsePlanCostsDraft({ ...draft, outOfNetwork: { ...draft.outOfNetwork, oopMet: '20000' } }),
    { ok: false, message: 'Out-of-network: the out-of-pocket met so far cannot be more than the out-of-pocket max.' });
  const noOon = form.parsePlanCostsDraft({ ...draft, oonBenefits: false, outOfNetwork: { ...draft.outOfNetwork, deductible: 'garbage' } });
  check('form: "No" out-of-network benefits clears those amounts (even bad ones)', noOon.ok && noOon.value.outOfNetwork, none);
  check('form: percent', [form.parseWholePercent('20'), form.parseWholePercent('20 %'), form.parseWholePercent(''), form.parseWholePercent('100'), form.parseWholePercent('101'), form.parseWholePercent('20.5'), form.parseWholePercent('-1')], [20, 20, null, 100, undefined, undefined, undefined]);
  check('form: draft round trip', form.parsePlanCostsDraft(form.planCostsDraft(plan)), { ok: true, value: plan });
  check('form: an empty plan is an empty draft', form.planCostsDraft(null).inNetwork, { deductible: '', deductibleMet: '', oopMax: '', oopMet: '', coinsurancePct: '' });
  check('form: VOB rates', form.parseVobCostsDraft({ allowedDailyRate: '850', billedDailyRate: '$1,400', copayPerDay: '', precertRequired: true }),
    { ok: true, value: { allowedDailyRate: 850, billedDailyRate: 1400, copayPerDay: null, precertRequired: true } });
  check('form: VOB cents refused', form.parseVobCostsDraft({ allowedDailyRate: '850.25', billedDailyRate: '', copayPerDay: '', precertRequired: null }).ok, false);
  check('form: VOB over the cap', form.parseVobCostsDraft({ allowedDailyRate: '100001', billedDailyRate: '', copayPerDay: '', precertRequired: null }),
    { ok: false, message: 'Allowed rate per day: enter whole dollars from $0 to $100,000.' });
  check('form: VOB draft round trip', form.parseVobCostsDraft(form.vobCostsDraft({ allowedDailyRate: 600, billedDailyRate: null, copayPerDay: 25, precertRequired: false })),
    { ok: true, value: { allowedDailyRate: 600, billedDailyRate: null, copayPerDay: 25, precertRequired: false } });

  check('rules: a valid plan', planCostsProblem(plan), null);
  check('rules: negative', planCostsProblem({ ...plan, inNetwork: { ...inNet, oopMax: -1 } }), 'In-network out-of-pocket max: enter whole dollars from $0 to $1,000,000.');
  check('rules: fractional', planCostsProblem({ ...plan, inNetwork: { ...inNet, deductible: 10.5 } }) !== null, true);
  check('rules: over the cap', planCostsProblem({ ...plan, outOfNetwork: { ...oonNet, deductible: 1000001, deductibleMet: 0 } }) !== null, true);
  check('rules: coinsurance', planCostsProblem({ ...plan, inNetwork: { ...inNet, coinsurancePct: 101 } }), 'In-network coinsurance: enter a whole percent from 0 to 100.');
  check('rules: no OON benefits with OON amounts', planCostsProblem({ ...plan, oonBenefits: false }), 'The plan has no out-of-network benefits, so it has no out-of-network amounts.');
  check('rules: met without a total is fine', planCostsProblem({ ...plan, inNetwork: { ...inNet, deductible: null } }), null);
  check('rules: VOB', [vobCostsProblem({ allowedDailyRate: 0, billedDailyRate: 100000, copayPerDay: null, precertRequired: null }), vobCostsProblem({ allowedDailyRate: -1, billedDailyRate: null, copayPerDay: null, precertRequired: null }) !== null], [null, true]);

  check('summary: in-network', networkBenefitsSummary(inNet), '$3,000 deductible ($1,000 met) · $6,000 out-of-pocket max ($1,500 met) · 20% coinsurance');
  check('summary: nothing', networkBenefitsSummary(none), 'Not entered');
  check('summary: no OON', outOfNetworkSummary({ ...plan, outOfNetwork: none, oonBenefits: false }), 'No out-of-network benefits');
  check('summary: OON yes, no amounts', outOfNetworkSummary({ ...plan, outOfNetwork: none, oonBenefits: true }), 'Has out-of-network benefits; amounts not entered');
  check('hasPlanCosts', [hasPlanCosts(null), hasPlanCosts({ inNetwork: none, outOfNetwork: none, oonBenefits: null }), hasPlanCosts({ inNetwork: none, outOfNetwork: none, oonBenefits: false }), hasPlanCosts(plan)], [false, false, true, true]);
}

// ─── (h) The wire format (insurance.ts) matches the migration ───────────────

{
  const migration = readFileSync(path.join(repoRoot, 'supabase/migrations/20261104120000_family_cost.sql'), 'utf8');
  const casesSource = readFileSync(path.join(repoRoot, 'src/lib/cases.ts'), 'utf8');
  check('plan patch keys are the plan cost columns', Object.keys(planCostsToPatch(plan)).sort(), [...PLAN_COST_COLUMNS].sort());
  check('VOB patch keys are the VOB cost columns', Object.keys(vobCostsToPatch(vob())).sort(), [...VOB_COST_COLUMNS].sort());
  for (const column of [...PLAN_COST_COLUMNS, ...VOB_COST_COLUMNS]) {
    ok(`migration adds ${column}`, new RegExp(`ADD COLUMN IF NOT EXISTS ${column} `).test(migration));
    ok(`migration reads the ${column} patch key`, migration.includes(`p_patch ? '${column}'`));
  }
  const selectOf = (name) => (new RegExp(`const ${name} = '([^']+)'`).exec(casesSource) || [])[1]?.split(',').map((item) => item.trim());
  check('cases.ts reads every plan cost column', selectOf('PLAN_COST_SELECT'), [...PLAN_COST_COLUMNS]);
  check('cases.ts reads every VOB cost column', selectOf('VOB_COST_SELECT'), [...VOB_COST_COLUMNS]);
  check('a row round trips', planCostsFromRow(planCostsToPatch(plan)), plan);
  check('an older server’s row reads as not entered', planCostsFromRow({ carrier: 'Aetna' }), { inNetwork: none, outOfNetwork: none, oonBenefits: null });
  check('a VOB row round trips', vobCostsFromRow(vobCostsToPatch({ allowedDailyRate: 600, billedDailyRate: 1200, copayPerDay: 0, precertRequired: false })), { allowedDailyRate: 600, billedDailyRate: 1200, copayPerDay: 0, precertRequired: false });
  check('an older server’s VOB row reads as not known', vobCostsFromRow({}), { allowedDailyRate: null, billedDailyRate: null, copayPerDay: null, precertRequired: null });
  check('"No" OON benefits sends the OON amounts as null', planCostsToPatch({ ...plan, oonBenefits: false }).oon_deductible, null);
}

// ─── (i) The packet ─────────────────────────────────────────────────────────

const partnerA = {
  id: 'p-a', name: 'Sarah Ellison', organization: 'Riverstone Recovery Center', type: 'Inpatient', types: ['Inpatient'],
  city: 'Bend', state: 'OR', regions: ['Nationwide'], phone: '(541) 555-0142', email: 'admissions@riverstone.example',
  monthlyCost: 30000, cashMin: 30000, cashMax: 30000, insurance: ['Aetna'], insuranceNetworks: { Aetna: ['In-network'] },
  therapies: ['Trauma', 'MAT'], populations: ['Adults'], levels: ['Inpatient'], note: '', inbound: 0, outbound: 0, lastContact: '2026-10-01',
};
const profile = {
  id: 'm-1', clientLabel: 'J.R. — Portland family', levelOfCare: 'Inpatient', state: 'OR', insurance: 'Aetna',
  networkPreferences: ['In-network'], therapies: ['Trauma'], status: 'Matching', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', caseId: 'c1',
};
{
  const requests = [vobRow({ id: 'v', partnerId: 'p-a', programName: partnerA.organization, status: 'in_network', answeredAt: '2026-11-03T00:00:00Z', allowedDailyRate: 300, copayPerDay: 50 })];
  const lines = familyCostPacketLines({ insurance: 'Aetna', plan, requests, partner: partnerA, perProgram: 'in_network' });
  check('packet lines: side by side', lines, [
    'ESTIMATED COST TO YOUR FAMILY (30 DAYS)',
    '- With Aetna, in-network: $4,500–$4,900',
    '- Paying privately: $30,000',
    PACKET_COST_DISCLAIMER,
  ]);
  const longer = familyCostPacketLines({ insurance: 'Aetna', plan, requests, partner: partnerA, perProgram: 'in_network', days: 45 });
  check('packet lines: the stay is named', longer[0], 'ESTIMATED COST TO YOUR FAMILY (45 DAYS)');
  const oonLines = familyCostPacketLines({ insurance: 'Aetna', plan, requests: [], partner: { ...partnerA, monthlyCost: 0, cashMin: 0, cashMax: 0 }, perProgram: 'out_of_network' });
  check('packet lines: nothing known, nothing said', oonLines, []);
  const cashOnly = familyCostPacketLines({ insurance: 'Cash pay', plan: null, requests: [], partner: partnerA, perProgram: 'unknown' });
  check('packet lines: cash pay family', cashOnly, ['ESTIMATED COST TO YOUR FAMILY (30 DAYS)', '- Paying privately: $30,000', PACKET_COST_DISCLAIMER]);
  const halfKnown = familyCostPacketLines({ insurance: 'Aetna', plan, requests: [], partner: partnerA, perProgram: 'in_network' });
  check('packet lines: an unknown side says "not known yet", never $0', halfKnown[1], '- With Aetna, in-network: not known yet');
  const oonKnown = familyCostPacketLines({ insurance: 'Aetna', plan, requests: [vobRow({ id: 'o', partnerId: 'p-a', status: 'out_of_network', answeredAt: '2026-11-03T00:00:00Z', allowedDailyRate: 600, billedDailyRate: 1200 })], partner: partnerA, perProgram: 'out_of_network' });
  check('packet lines: OON says the program can bill more', oonKnown[1], '- With Aetna, out-of-network: $10,800–$28,800 (the program can also bill what the plan does not cover)');

  const score = matching.scoreProgram(profile, partnerA, undefined, matching.trackRecordPrior({}));
  const fit = packetFitInput(score, profile);
  const family = buildPacket(profile, partnerA, buildFitReasons(profile, partnerA, fit, 'family'), 'family', lines);
  ok('family copy carries the estimate', family.includes('ESTIMATED COST TO YOUR FAMILY (30 DAYS)') && family.includes('- With Aetna, in-network: $4,500–$4,900'));
  ok('family copy carries the disclaimer', family.includes(PACKET_COST_DISCLAIMER));
  ok('family copy: the estimate sits before the client criteria', family.indexOf('ESTIMATED COST') < family.indexOf('CLIENT CRITERIA'));
  const partnerCopy = buildPacket(profile, partnerA, buildFitReasons(profile, partnerA, fit, 'partner'), 'partner', lines);
  const partnerPlain = buildPacket(profile, partnerA, buildFitReasons(profile, partnerA, fit, 'partner'), 'partner');
  check('program copy never carries the family’s finances, whatever is passed', partnerCopy, partnerPlain);
  for (const line of lines) ok(`program copy omits "${line.slice(0, 30)}"`, !partnerCopy.includes(line));
  ok('program copy has no estimate wording at all', !/ESTIMATED COST|Paying privately|out of pocket|deductible|coinsurance/i.test(partnerCopy));
  const familyPlain = buildPacket(profile, partnerA, buildFitReasons(profile, partnerA, fit, 'family'), 'family');
  ok('no lines, no section (the 1.0.4 packet unchanged)', !familyPlain.includes('ESTIMATED COST'));
}

// ─── (j) Matching integrity ─────────────────────────────────────────────────

{
  const partners = [0, 1, 2, 3, 4, 5].map((i) => ({
    ...partnerA,
    id: `p${i}`,
    organization: `Program ${i}`,
    monthlyCost: 10000 * (i + 1),
    cashMin: 10000 * (i + 1),
    cashMax: 10000 * (i + 1),
    insuranceNetworks: { Aetna: i % 2 ? ['Out-of-network'] : ['In-network'] },
    therapies: i % 3 ? ['Trauma', 'MAT'] : ['MAT'],
  }));
  const snapshot = JSON.stringify(partners);
  const prof = { ...profile, networkPreferences: ['In-network', 'Out-of-network'] };
  const before = matching.rankPrograms(prof, partners, {});
  const requests = partners.map((item, i) => vobRow({ id: `v${i}`, partnerId: item.id, programName: item.organization, status: i % 2 ? 'out_of_network' : 'in_network', answeredAt: '2026-11-03T00:00:00Z', allowedDailyRate: 100 * (i + 1), billedDailyRate: 200 * (i + 1) }));
  const estimates = before.map((score) => familyCostForProgram({ insurance: prof.insurance, plan, requests, partner: score.partner, perProgram: perProgramNetwork(score.networkStatus) }));
  const after = matching.rankPrograms(prof, partners, {});
  check('ranking is identical after estimating', after.map((score) => [score.partner.id, score.total, score.components]), before.map((score) => [score.partner.id, score.total, score.components]));
  check('estimating never touches the partners', JSON.stringify(partners), snapshot);
  ok('every ranked card got an estimate', estimates.length === before.length && estimates.every((item) => item.known));
  // The fixture's estimates are not in rank order, so if they were an input
  // the order above could not have survived.
  const lows = estimates.map((item) => item.low);
  ok('the ranked order is not the estimate order', lows.some((low, i) => i > 0 && low < lows[i - 1]));
  const matchingSource = readFileSync(path.join(repoRoot, 'src/lib/matching.ts'), 'utf8');
  ok('matching.ts never imports the estimator', !matchingSource.includes('family-cost') && !/estimateFamilyCost|familyCostForProgram/.test(matchingSource));
  const appSource = readFileSync(path.join(repoRoot, 'App.tsx'), 'utf8');
  ok('App ranks with the same inputs as before', appSource.includes('() => rankPrograms(draftMatchProfile, partners, scorecards, bedOptions),'));
  check('the weights are unchanged', matching.scoringWeights(), { clinical: 50, cost: 25, location: 10, trackRecord: 15, priorCases: 5 });
}

console.log(`family cost: ${checks} checks ok`);
