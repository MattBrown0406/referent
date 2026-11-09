// Why these programs (docs/MATCH_EXPLANATION.md): the family's explanation
// in src/lib/match-explanation.ts follows the ranking exactly, explains each
// step of the order from the ranker's own numbers, keeps cautions and
// disclosures, and names no one. Run with: node scripts/match-explanation-test.mjs

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'match-explanation-test');
const require = createRequire(import.meta.url);
const ts = require(path.join(repoRoot, 'node_modules', 'typescript'));
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

function transpileTo(relSrc, outName) {
  const js = ts.transpileModule(read(relSrc), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const outPath = path.join(tmpDir, outName);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, js);
}

transpileTo('src/data.ts', 'data.js');
transpileTo('src/lib/beds.ts', 'lib/beds.js');
transpileTo('src/lib/matching.ts', 'lib/matching.js');
transpileTo('src/lib/packet.ts', 'lib/packet.js');
transpileTo('src/lib/match-explanation.ts', 'lib/match-explanation.js');
const { rankPrograms } = require(path.join(tmpDir, 'lib', 'matching.js'));
const x = require(path.join(tmpDir, 'lib', 'match-explanation.js'));

let checks = 0;
const check = (fn, label) => {
  try { fn(); } catch (error) { console.error(`FAIL ${label || ''}`); throw error; }
  checks += 1;
};

let seq = 0;
function partner(overrides = {}) {
  seq += 1;
  return {
    id: `p${seq}`, name: `Contact ${seq}`, organization: `Program ${seq}`, type: 'Inpatient', types: ['Inpatient'],
    city: 'Bend', state: 'OR', regions: [], phone: '', email: '', monthlyCost: 20000, insuranceNetworks: {},
    cashMin: 0, cashMax: 0, insurance: [], therapies: [], populations: ['Adults'], levels: ['Inpatient'], note: '',
    inbound: 0, outbound: 0, lastContact: '2026-09-01', ...overrides,
  };
}

const profile = {
  id: 'm1', clientLabel: 'A.R.', levelOfCare: 'Inpatient', state: 'OR', insurance: 'Aetna',
  networkPreferences: ['In-network', 'Out-of-network'], therapies: ['MAT', 'EMDR', 'Family program'],
  mustHaveTherapies: ['MAT'], locationPreference: 'Close to family', status: 'Matching',
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
};

const juniper = partner({ organization: 'Juniper Ridge Recovery', city: 'Bend', insuranceNetworks: { Aetna: ['In-network'] }, therapies: ['MAT', 'EMDR', 'Family program'] });
const cedar = partner({ organization: 'Cedar House', city: 'Salem', insuranceNetworks: { Aetna: ['In-network'] }, therapies: ['MAT', 'EMDR'] });
const harbor = partner({
  organization: 'Harbor Light', city: 'Portland', insuranceNetworks: { Aetna: ['Out-of-network'] }, therapies: ['MAT'],
  financialRelationship: 'consulting_fee', financialRelationshipNote: 'quarterly clinical consulting',
});
const noMat = partner({ organization: 'No MAT Ranch', insuranceNetworks: { Aetna: ['In-network'] }, therapies: ['EMDR', 'Family program'] });

const ranked = rankPrograms(profile, [harbor, cedar, noMat, juniper], {});

// ─── It follows the ranking ────────────────────────────────────────────────
check(() => assert.deepEqual(ranked.map((score) => score.partner.organization), ['Juniper Ridge Recovery', 'Cedar House', 'Harbor Light']), 'the fixture ranks as expected (no MAT is hidden)');
check(() => {
  const explanation = x.explainMatches(profile, ranked, 3);
  assert.deepEqual(explanation.programs.map((program) => program.name), ranked.slice(0, 3).map((score) => score.partner.organization), 'the same programs, in the same order');
  assert.deepEqual(explanation.programs.map((program) => program.rank), [1, 2, 3]);
  assert.deepEqual(explanation.programs.map((program) => program.fit), ranked.slice(0, 3).map((score) => Math.round(score.total)));
  assert.equal(explanation.eligible, 3);
}, 'the explanation is the ranking');
check(() => {
  assert.equal(x.explainMatches(profile, ranked, 1).programs.length, 1);
  assert.equal(x.explainMatches(profile, ranked, 9).programs.length, 3, 'never more than are ranked');
  assert.equal(x.explainMatches(profile, ranked, 0).programs.length, 3, 'a bad count falls back to the default');
  assert.equal(x.explainMatches(profile, [], 3).programs.length, 0);
  assert.match(x.explainMatches(profile, [], 3).intro, /No program meets every requirement yet/);
}, 'how many are explained');

// ─── What it says ──────────────────────────────────────────────────────────
const explanation = x.explainMatches(profile, ranked, 3);
const [first, second, third] = explanation.programs;
check(() => {
  assert.equal(explanation.intro, "These are the 3 programs that fit your loved one's needs best, in order. Each one provides Inpatient care, works with Aetna, serves Oregon, and offers MAT.");
  const two = x.explainMatches(profile, ranked, 2);
  assert.match(two.intro, /the 2 programs that fit your loved one's needs best, in order, out of 3 that meet every requirement\./);
}, 'the intro says what every program met');
check(() => {
  assert.ok(first.reasons.includes('In-network with Aetna'));
  assert.ok(first.reasons.some((line) => /Offers/.test(line)));
  assert.equal(first.where, 'Inpatient, Bend, OR');
  assert.match(first.order, /^It ranks above Cedar House mainly because it offers more of what your loved one needs\.$/);
  assert.equal(third.order, '', 'the last one shown has no "above"');
}, 'why it fits and why it comes first');
check(() => {
  assert.ok(second.cautions.some((line) => /Does not list Family program: ask the program/.test(line)), 'needs it does not list');
  assert.ok(third.cautions.some((line) => /verify benefits/i.test(line)), 'out of network');
  assert.ok(!third.reasons.some((line) => /verify benefits/i.test(line)), 'a caution is not a reason');
}, 'cautions');
check(() => {
  assert.match(third.disclosure, /^Disclosure: our practice has a financial relationship with this program \(consulting fee: quarterly clinical consulting\)\./);
  assert.equal(first.disclosure, '');
}, 'a disclosed relationship is in');
check(() => {
  const text = x.explanationText(explanation);
  assert.match(text, /^Why these programs\n\n/);
  assert.ok(text.indexOf('1. Juniper Ridge Recovery') < text.indexOf('2. Cedar House') && text.indexOf('2. Cedar House') < text.indexOf('3. Harbor Light'), 'in ranked order');
  assert.match(text, /1\. Juniper Ridge Recovery \(Inpatient, Bend, OR\) · fit \d+ of 100\nWhy it fits: /);
  assert.match(text, /To check: /);
  assert.ok(text.includes(third.disclosure));
  assert.match(text, /How the order was decided: each program gets a fit score out of 100\. Up to 50 points/);
  assert.match(text, /never part of the score/);
  assert.match(text, /you are free to choose any program\.$/);
  assert.ok(!text.includes('A.R.'), 'the client label is not in the family text');
}, 'the text the family gets');

// ─── Ties and order reasons ────────────────────────────────────────────────
check(() => {
  const base = { partner: { organization: 'A Place' }, total: 80, components: { clinical: 40, cost: 20, location: 10, trackRecord: 10 }, bedAvailability: null, familyCost: 0 };
  const next = { ...base, partner: { organization: 'B Place' } };
  assert.equal(x.orderReason(base, { ...next, total: 70, components: { ...base.components, cost: 10 } }), 'It ranks above B Place mainly because it is likely to cost your family less.');
  assert.equal(x.orderReason(base, { ...next, total: 75, components: { ...base.components, location: 5 } }), 'It ranks above B Place mainly because its location fits what you asked for better.');
  assert.equal(x.orderReason({ ...base, bedAvailability: true }, next), 'It ties with B Place on fit and comes first because it has a confirmed open bed.');
  assert.equal(x.orderReason(base, { ...next, familyCost: 1 }), 'It ties with B Place on fit and comes first because it is likely to cost your family less.');
  assert.equal(x.orderReason(base, next), 'It ties with B Place on fit; the app sets the order between them fairly.');
}, 'why one comes before the next');

// ─── The rewrite ───────────────────────────────────────────────────────────
check(() => {
  const facts = x.rewriteFacts(explanation);
  assert.deepEqual(Object.keys(facts.programs[0]).sort(), ['fit', 'name', 'order', 'rank', 'reasons', 'where']);
  const sent = JSON.stringify(facts);
  assert.ok(!sent.includes('Disclosure'), 'disclosures are never sent for rewriting');
  assert.ok(!sent.includes('To check') && !sent.includes('ask the program'), 'cautions are never sent');
  assert.ok(!sent.includes('A.R.'), 'no client label');
}, 'only the facts are sent');
check(() => {
  const rewrite = {
    intro: 'Here are three programs for your loved one, in order.',
    programs: explanation.programs.map((program) => ({ rank: program.rank, text: `${program.name} is a warm fit.` })),
  };
  assert.equal(x.rewriteMatches(explanation, rewrite), true);
  const text = x.explanationText(explanation, rewrite);
  assert.match(text, /Here are three programs/);
  assert.match(text, /Juniper Ridge Recovery is a warm fit\./);
  assert.ok(text.includes(third.disclosure), 'the disclosure stays');
  assert.match(text, /To check: /, 'the cautions stay');
  assert.match(text, /How the order was decided/);
  const swapped = { ...rewrite, programs: [...rewrite.programs].reverse() };
  assert.equal(x.rewriteMatches(explanation, swapped), false, 'a rewrite in another order is not used');
  assert.doesNotMatch(x.explanationText(explanation, swapped), /warm fit/);
  const stale = { ...rewrite, programs: rewrite.programs.map((item, index) => (index === 1 ? { ...item, text: 'Somewhere Else is a warm fit.' } : item)) };
  assert.equal(x.rewriteMatches(explanation, stale), false, 'a rewrite for another ranking is not used');
  assert.equal(x.rewriteMatches(explanation, null), false);
}, 'a rewrite replaces only the words it may');
check(() => {
  const text = x.explanationText(explanation);
  const edited = text.replace(third.disclosure, '');
  const fixed = x.withDisclosures(edited, explanation);
  assert.equal(fixed.added, 1);
  assert.ok(fixed.text.endsWith(`Harbor Light: ${third.disclosure}`), 'a removed disclosure is added back');
  assert.deepEqual(x.withDisclosures(text, explanation), { text, added: 0 });
}, 'a disclosure cannot be edited out');

// ─── Wiring ────────────────────────────────────────────────────────────────
const sheet = read('src/lib/MatchExplanationSheet.tsx');
const app = read('App.tsx');
const api = read('src/lib/ai-assist-api.ts');
check(() => {
  assert.match(app, /<MatchExplanationSheet\n\s+visible=\{showMatchExplanation\}\n\s+userId=\{activeUserId\}\n\s+profile=\{draftMatchProfile\}\n\s+ranked=\{matches\}/, 'the sheet gets the Match screen’s own ranking');
  assert.match(app, /\|\| showDayReview \|\| showMatchExplanation\n/, 'the sheet counts as open');
  assert.match(app, /setShowMatchExplanation\(false\);\n\s+setOutreach\(null\);/, 'signing out closes it');
}, 'App');
check(() => {
  assert.match(sheet, /const \{ text: body, added \} = finalText\(\);/);
  assert.equal(sheet.split('withDisclosures(').length - 1, 1);
  assert.match(sheet, /function finalText\(\)[^]*?withDisclosures\(text\.trim\(\), explanation\)/, 'what is sent always carries the disclosures');
  assert.match(sheet, /requestExplanationRewrite\(facts, key\)/);
  assert.match(sheet, /const facts = rewriteFacts\(explanation\);/, 'only the facts go to the rewrite');
}, 'the sheet');
check(() => {
  assert.match(api, /body: \{ action, \.\.\.payload, anthropicKey: apiKey \}/, 'the key rides in the body');
  assert.match(api, /invokeAssist\('explain_matches', \{ facts \}, apiKey\)/);
}, 'the call');
check(() => {
  const fn = read('supabase/functions/ai-assist/index.ts');
  assert.match(fn, /claim_ai_assist/);
  assert.doesNotMatch(fn, /console\.(log|error|warn)\([^)]*(body|facts|apiKey|prompt|text)\b/, 'the function never logs input or the key');
  assert.match(fn, /new Anthropic\(\{ apiKey, timeout: DEADLINE_MS, maxRetries: 0 \}\)/);
  assert.match(read('supabase/config.toml'), /\[functions\.ai-assist\]\nverify_jwt = false/, 'the function checks the session itself');
  assert.match(read('.github/workflows/quality.yml'), /supabase\/functions\/ai-assist\//, 'CI runs the function tests');
}, 'the function');

console.log(`match-explanation-test: ${checks} checks passed`);
