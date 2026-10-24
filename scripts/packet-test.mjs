// Packet generator fixture test — runs src/lib/packet.ts (plus its only
// runtime dependency, formatMoney from src/data.ts) in plain node with no
// build step. Prints the exact text a family/partner would receive.

import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'packet-test');
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

execFileSync('mkdir', ['-p', tmpDir]);

// packet.ts only uses formatMoney + stateOptions from data.ts, but data.ts is
// self-contained, so we can load the real thing. packet.ts imports '../data'
// — mirror that relative layout inside the temp dir (lib/packet.js → data.js).
transpileTo('src/data.ts', 'data.js');
transpileTo('src/lib/beds.ts', 'lib/beds.js');
transpileTo('src/lib/matching.ts', 'lib/matching.js');
transpileTo('src/lib/packet.ts', 'lib/packet.js');

const { buildFitReasons, buildPacket, labelLooksLikeFullName } = require(path.join(tmpDir, 'lib', 'packet.js'));

// ─── Fixtures ───────────────────────────────────────────────────────────────

const partnerA = {
  id: 'p-fixture-a',
  name: 'Sarah Ellison',
  organization: 'Riverstone Recovery Center',
  type: 'Inpatient',
  types: ['Inpatient', 'Detox'],
  city: 'Bend',
  state: 'OR',
  regions: ['Nationwide'],
  phone: '(541) 555-0142',
  email: 'admissions@riverstonerecovery.com',
  website: 'https://riverstonerecovery.com',
  monthlyCost: 30000,
  insuranceNetworks: {
    Aetna: ['In-network'],
    Cigna: ['Out-of-network'],
    UnitedHealthcare: ['In-network', 'Out-of-network'],
  },
  cashMin: 18000,
  cashMax: 42000,
  insurance: ['Aetna', 'Cigna', 'UnitedHealthcare', 'Regence BlueCross BlueShield of Oregon'],
  therapies: ['Trauma', 'Dual diagnosis', 'MAT', 'Family systems'],
  populations: ['Adults'],
  levels: ['Inpatient', 'Detox'],
  note: '',
  inbound: 0,
  outbound: 0,
  lastContact: '2026-07-20',
};

const partnerB = {
  id: 'p-fixture-b',
  name: 'Marcus Webb',
  organization: 'High Desert Sober Living',
  type: 'Sober Living',
  city: 'Redmond',
  state: 'OR',
  regions: ['Central Oregon'],
  phone: '(541) 555-0198',
  email: 'marcus@highdesertsoberliving.org',
  website: '',
  monthlyCost: 2400,
  insuranceNetworks: {},
  cashMin: 1200,
  cashMax: 2400,
  insurance: [],
  therapies: ['Men only', 'Chronic relapse'],
  populations: ['Men'],
  levels: ['Sober Living'],
  note: '',
  inbound: 0,
  outbound: 0,
  lastContact: '2026-07-22',
};

const profileInsurance = {
  id: 'm-fixture-1',
  clientLabel: 'J.R. — Portland family',
  levelOfCare: 'Inpatient',
  state: 'OR',
  insurance: 'Aetna',
  networkPreferences: ['In-network'],
  therapies: ['Trauma', 'Dual diagnosis'],
  status: 'Matching',
  createdAt: '2026-07-24T00:00:00.000Z',
  updatedAt: '2026-07-24T00:00:00.000Z',
};

const profileCash = {
  id: 'm-fixture-2',
  clientLabel: 'K.M.',
  levelOfCare: 'Sober Living',
  state: 'OR',
  insurance: 'Cash pay',
  networkPreferences: ['In-network'],
  maxBudget: 2500,
  therapies: ['Men only'],
  status: 'Matching',
  createdAt: '2026-07-24T00:00:00.000Z',
  updatedAt: '2026-07-24T00:00:00.000Z',
};

// ─── 1. Family-audience packet (insurance fixture) ─────────────────────────

// Fit inputs carry the ranker's components (src/lib/matching.ts scoreProgram).
const fitA = { networkStatus: 'In-network', verifyBenefits: false, requiredNeeds: [], matchedNeeds: ['Trauma', 'Dual diagnosis'], regionFit: true, sameState: true, paymentFit: true, locationPreference: 'No preference' };
const reasonsA = buildFitReasons(profileInsurance, partnerA, fitA);
assert.deepEqual(reasonsA, ['Provides Inpatient level of care', 'In-network with Aetna', 'Serves Oregon', 'Offers Trauma', 'Offers Dual diagnosis']);
// A must-have is named as required; close-to-family reads from the same state flag.
const reasonsRequired = buildFitReasons({ ...profileInsurance, locationPreference: 'Close to family', mustHaveTherapies: ['MAT'] }, partnerA, { ...fitA, requiredNeeds: ['MAT'], locationPreference: 'Close to family' });
assert.deepEqual(reasonsRequired, ['Provides Inpatient level of care', 'In-network with Aetna', 'In Oregon, close to family', 'Provides MAT (required)', 'Offers Trauma']);
// A disclosed financial relationship is always in the packet, both audiences; none means no line.
assert.ok(!buildPacket(profileInsurance, partnerA, reasonsA, 'family').includes('Disclosure:'));
const disclosedPartner = { ...partnerA, financialRelationship: 'consulting_fee', financialRelationshipNote: 'quarterly training' };
for (const audience of ['family', 'partner']) {
  const text = buildPacket(profileInsurance, disclosedPartner, reasonsA, audience);
  assert.ok(text.includes('Disclosure: our practice has a financial relationship with this program (consulting fee: quarterly training). It played no part in this recommendation'), `${audience} packet carries the disclosure`);
}
// Scores never appear in a packet.
assert.ok(!/\b\d{1,3}\s*\/\s*100\b|fit score/i.test(buildPacket(profileInsurance, disclosedPartner, reasonsA, 'family')));
console.log('═'.repeat(64));
console.log('PACKET 1 — audience: FAMILY (insurance / in-network fixture)');
console.log('═'.repeat(64));
console.log(buildPacket(profileInsurance, partnerA, reasonsA, 'family'));

// ─── 2. Partner-audience packet (same fixture) ─────────────────────────────

console.log('\n' + '═'.repeat(64));
console.log('PACKET 2 — audience: PARTNER (same match, partner ordering)');
console.log('═'.repeat(64));
console.log(buildPacket(profileInsurance, partnerA, reasonsA, 'partner'));

// ─── 3. Cash-pay packet with budget (family audience) ──────────────────────

const fitB = { networkStatus: null, verifyBenefits: false, requiredNeeds: ['Men only'], matchedNeeds: [], regionFit: true, sameState: true, paymentFit: true, locationPreference: 'No preference' };
const reasonsB = buildFitReasons(profileCash, partnerB, fitB);
assert(reasonsB.includes('Monthly cash cost is $2,400 — within the $2,500 budget'));
assert(!reasonsB.some((reason) => reason.includes('starts at') || reason.includes('rates $')));
console.log('\n' + '═'.repeat(64));
console.log('PACKET 3 — audience: FAMILY (cash pay + budget fixture)');
console.log('═'.repeat(64));
console.log(buildPacket(profileCash, partnerB, reasonsB, 'family'));

// ─── 4. A cash cost not on file is never "within budget" ───────────────────
// 0 is how a cost that was never entered is stored. It used to read
// "Monthly cash cost is $0 — within the $2,500 budget".
const partnerNoCost = { ...partnerB, monthlyCost: 0, cashMin: 0, cashMax: 0 };
const reasonsNoCost = buildFitReasons(profileCash, partnerNoCost, fitB);
assert(reasonsNoCost.includes('Monthly cash cost not on file — confirm it with the program'));
assert(!reasonsNoCost.some((reason) => reason.includes('$0') || reason.includes('within')), 'an unknown cost never claims to fit the budget');
assert(!buildPacket(profileCash, partnerNoCost, reasonsNoCost, 'family').includes('$0'));
// The legacy range stands in for a blank monthly cost, as it does on load.
assert(buildFitReasons(profileCash, { ...partnerB, monthlyCost: 0, cashMin: 1200, cashMax: 2400 }, fitB).includes('Monthly cash cost is $2,400 — within the $2,500 budget'));
// A budget of 0 is no budget (as in the ranking), so nothing is "within" it.
assert(buildFitReasons({ ...profileCash, maxBudget: 0 }, partnerB, fitB).includes('Monthly cash cost: $2,400'));
assert(!buildPacket({ ...profileCash, maxBudget: 0 }, partnerB, reasonsB, 'family').includes('up to $0'), 'a budget of 0 is never printed');

// The family's budget never reaches the program's copy: it would tell the
// program the most the family can pay. The family's copy keeps it.
const reasonsBPartner = buildFitReasons(profileCash, partnerB, fitB, 'partner');
assert(reasonsBPartner.includes('Monthly cash cost: $2,400'), 'the program copy still states the program\'s own cost');
const partnerCashPacket = buildPacket(profileCash, partnerB, reasonsBPartner, 'partner');
assert(!/budget|\$2,500/i.test(partnerCashPacket), 'no budget line or amount in the program copy');
assert(buildPacket(profileCash, partnerB, reasonsB, 'family').includes('- Budget: up to $2,500'), 'the family copy keeps the budget');

// ─── 5. Away from home: the state is home, not where to look ───────────────
const awayProfile = { ...profileInsurance, locationPreference: 'Away from home' };
const awayFit = { ...fitA, locationPreference: 'Away from home' };
assert(buildFitReasons(awayProfile, { ...partnerA, state: 'CA' }, { ...awayFit, sameState: false }).includes('Outside Oregon, away from home'));
const awayInState = buildFitReasons(awayProfile, partnerA, { ...awayFit, sameState: true });
assert(!awayInState.some((reason) => reason.includes('Oregon')), 'a home-state program gets no location bullet when the family wants distance');
const awayPacket = buildPacket(awayProfile, partnerA, reasonsA, 'partner');
assert(awayPacket.includes('- Home state: Oregon') && awayPacket.includes('- Location preference: Away from home'));
assert(!awayPacket.includes('- Location: Oregon'));
assert(buildPacket(profileInsurance, partnerA, reasonsA, 'partner').includes('- Location: Oregon'), 'other preferences keep the Location line');
// A program with no state on file is not "outside Oregon": the fit the
// ranker hands the packet says unknown (sameState null), so no claim is made.
{
  const { scoreProgram, trackRecordPrior } = require(path.join(tmpDir, 'lib', 'matching.js'));
  const { packetFitInput } = require(path.join(tmpDir, 'lib', 'packet.js'));
  const awayCash = { ...awayProfile, insurance: 'Cash pay', therapies: [], mustHaveTherapies: [] };
  for (const state of ['—', '', 'OREGON']) {
    const noState = { ...partnerA, state };
    const fit = packetFitInput(scoreProgram(awayCash, noState, undefined, trackRecordPrior({})), awayCash);
    assert.equal(fit.sameState, null);
    assert(!buildFitReasons(awayCash, noState, fit).some((reason) => reason.includes('away from home')), `state ${JSON.stringify(state)} never reads as away from home`);
  }
  const inCA = { ...partnerA, state: 'CA' };
  const fitCA = packetFitInput(scoreProgram(awayCash, inCA, undefined, trackRecordPrior({})), awayCash);
  assert(buildFitReasons(awayCash, inCA, fitCA).includes('Outside Oregon, away from home'), 'a program confirmed out of state still gets the line');
}

// ─── 6. The disclosure survives editing (EKRA) ─────────────────────────────
// The packet text is editable. For a program with a financial relationship,
// a disclosure deleted or reworded in the editor is put back on the end
// before sharing, and the composer says it was added back.
{
  const { withDisclosure, disclosureLine } = require(path.join(tmpDir, 'lib', 'packet.js'));
  const line = disclosureLine(disclosedPartner);
  const full = buildPacket(profileInsurance, disclosedPartner, reasonsA, 'family');
  assert.deepEqual(withDisclosure(full, disclosedPartner), { text: full, added: false }, 'an intact disclosure is left alone');
  const stripped = full.replace(line, '').replace(/\n{3,}/g, '\n\n');
  const restored = withDisclosure(`${stripped}\n\n`, disclosedPartner);
  assert.equal(restored.added, true, 'a removed disclosure is reported as added back');
  assert.ok(restored.text.endsWith(`\n\n${line}`), 'the disclosure goes back on the end, after one blank line');
  assert.equal(restored.text.split(line).length - 1, 1, 'exactly one disclosure');
  const reworded = withDisclosure(full.replace('It played no part', 'It played little part'), disclosedPartner);
  assert.equal(reworded.added, true, 'a reworded disclosure does not count');
  assert.deepEqual(withDisclosure('Short note', partnerA), { text: 'Short note', added: false }, 'no relationship, nothing added');
  assert.deepEqual(withDisclosure('', disclosedPartner), { text: line, added: true });
  const appSource = readFileSync(path.join(repoRoot, 'App.tsx'), 'utf8');
  const shareBody = appSource.slice(appSource.indexOf('async function sharePacketText()'), appSource.indexOf('function closePacketComposer()'));
  assert.match(shareBody, /const ensured = withDisclosure\(packetText, packetTarget\.partner\);[\s\S]*setPacketDisclosureRestored\(true\)[\s\S]*message: ensured\.text/, 'the share sheet always gets the text with the disclosure');
  assert.match(appSource, /\{packetDisclosureRestored \? \([\s\S]{0,200}added back/, 'the composer tells the user the disclosure was added back');
}

// ─── De-identification heuristic spot checks ───────────────────────────────

console.log('\n' + '─'.repeat(64));
console.log('labelLooksLikeFullName checks:');
for (const label of ['J.R.', 'K.M. — Bend family', 'John Robinson', 'J.R. Portland', 'Sarah Ellison']) {
  console.log(`  "${label}" → ${labelLooksLikeFullName(label)}`);
}

unlinkSync(path.join(tmpDir, 'data.js'));
unlinkSync(path.join(tmpDir, 'lib', 'matching.js'));
unlinkSync(path.join(tmpDir, 'lib', 'packet.js'));
