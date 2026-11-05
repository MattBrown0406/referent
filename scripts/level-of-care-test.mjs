// Level-of-care assessment: src/lib/level-of-care.ts, src/lib/level-of-care-api.ts
// (with Supabase stubbed) and the packet's program copy run in plain node, no
// build step (the same transpile approach as placement-request-test).
//
//   (a) the rules table: its shape, and the exact mapping for named cases
//   (b) every area at every rating, the others at 0
//   (c) monotonic: raising any rating never lowers what is recommended (all
//       15,625 rating sets, every area)
//   (d) the server's rules are the app's: one digest of all 15,625 sets,
//       asserted here and in supabase/tests/level_of_care_test.sql
//   (e) the rationale: 2-4 sentences, factual, built from ratings only (never
//       a note, a name or anything about the case)
//   (f) safety flags: urgent evaluations at 4, 911 / 988 for immediate danger
//   (g) override validation (the server's words, shared fixtures)
//   (h) what is sent to the server, and how a saved row reads back
//   (i) the packet: the program copy carries the rationale, the family copy
//       never carries ratings or the rationale
//   (j) matching reads only the chosen level; placement requests read nothing
//   (k) the match note and the timeline wording
//   (l) the API: hides on a server without the migration, OfflineError on a
//       lost connection, the server's words otherwise
//   (m) the screens: the one-sheet rule, decision support said plainly,
//       Retry reuses the id, the licensing rule
//   (n) the migration follows the paste rules and is additive

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'level-of-care-test');
const require = createRequire(import.meta.url);
const ts = require(path.join(repoRoot, 'node_modules', 'typescript'));

function transpileTo(relSrc, outName, rewrite = (js) => js) {
  const source = readFileSync(path.join(repoRoot, relSrc), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const outPath = path.join(tmpDir, outName);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, rewrite(js));
  return outPath;
}

mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
transpileTo('src/data.ts', 'data.js');
for (const name of ['beds', 'matching', 'packet', 'errors', 'identifying-text', 'level-of-care']) transpileTo(`src/lib/${name}.ts`, `lib/${name}.js`);

// level-of-care-api.ts with its network edges stubbed: a fake Supabase
// client the tests drive, a uuid, and React hooks it never calls here.
writeFileSync(path.join(tmpDir, 'lib', 'supabase.js'), 'exports.supabase = globalThis.__assessmentSupabase;');
writeFileSync(path.join(tmpDir, 'lib', 'cases.js'), "let n = 0; exports.newUuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;");
writeFileSync(path.join(tmpDir, 'lib', 'react.js'), 'exports.useCallback = (f) => f; exports.useEffect = () => {}; exports.useRef = (v) => ({ current: v }); exports.useState = (v) => [v, () => {}];');
transpileTo('src/lib/level-of-care-api.ts', 'lib/level-of-care-api.js', (js) => js.replace(/require\("react"\)/, 'require("./react")'));

// The tests never reach the network.
globalThis.fetch = () => { throw new Error('level-of-care-test: the real network must never be called'); };
const fake = { from: null, rpc: null };
globalThis.__assessmentSupabase = {
  from: (table) => fake.from(table),
  rpc: (name, args) => fake.rpc(name, args),
};

const L = require(path.join(tmpDir, 'lib', 'level-of-care.js'));
const api = require(path.join(tmpDir, 'lib', 'level-of-care-api.js'));
const errors = require(path.join(tmpDir, 'lib', 'errors.js'));
const matching = require(path.join(tmpDir, 'lib', 'matching.js'));
const { buildPacket, buildFitReasons } = require(path.join(tmpDir, 'lib', 'packet.js'));
const data = require(path.join(tmpDir, 'data.js'));

const migration = readFileSync(path.join(repoRoot, 'supabase/migrations/20261104150000_level_of_care.sql'), 'utf8');
const pgtap = readFileSync(path.join(repoRoot, 'supabase/tests/level_of_care_test.sql'), 'utf8');

let checks = 0;
function check(label, actual, expected) {
  assert.deepEqual(actual, expected, label);
  checks += 1;
}
function ok(label, value) {
  assert.ok(value, label);
  checks += 1;
}

const KEYS = L.DIMENSION_KEYS;
const ratingsOf = (digits) => Object.fromEntries(KEYS.map((key, index) => [key, Number(String(digits)[index])]));
const path3 = (rec) => `${rec.firstStep || '-'}|${rec.level}|${rec.support || '-'}`;

function* everyRatingSet() {
  for (let w = 0; w < 5; w += 1) for (let p = 0; p < 5; p += 1) for (let m = 0; m < 5; m += 1)
    for (let r = 0; r < 5; r += 1) for (let u = 0; u < 5; u += 1) for (let e = 0; e < 5; e += 1) yield [w, p, m, r, u, e];
}

// ─── (a) The rules table ────────────────────────────────────────────────────

{
  const rules = L.LEVEL_OF_CARE_RULES;
  check('rules version 2 (Matt\'s decisions of 2026-11-05)', [rules.version, L.RULES_VERSION], [2, 2]);
  check('the six areas, in the order the server stores them', KEYS, ['withdrawal', 'physical', 'emotional', 'readiness', 'relapse', 'environment']);
  check('areas 2-6 each map every rating to a treatment level', Object.keys(rules.primary).sort(), ['emotional', 'environment', 'physical', 'readiness', 'relapse']);
  for (const [key, row] of Object.entries(rules.primary)) {
    check(`${key}: five ratings`, row.length, 5);
    ok(`${key}: only treatment levels`, row.every((level) => L.PRIMARY_LEVELS.includes(level)));
  }
  check('the exact table', rules.primary, {
    physical: ['Therapist', 'Therapist', 'IOP / PHP', 'Inpatient', 'Inpatient'],
    emotional: ['Therapist', 'Therapist', 'IOP / PHP', 'Inpatient', 'Inpatient'],
    readiness: ['Therapist', 'Therapist', 'Therapist', 'IOP / PHP', 'IOP / PHP'],
    relapse: ['Therapist', 'Therapist', 'IOP / PHP', 'IOP / PHP', 'Inpatient'],
    environment: ['Therapist', 'Therapist', 'Therapist', 'Therapist', 'Inpatient'],
  });
  check('risks together: serious (two of three at 3+) and moderate (four of five at 2+)', rules.together, [
    { key: 'serious', dimensions: ['readiness', 'relapse', 'environment'], atOrAbove: 3, count: 2, level: 'Inpatient' },
    { key: 'moderate', dimensions: ['physical', 'emotional', 'readiness', 'relapse', 'environment'], atOrAbove: 2, count: 4, level: 'Inpatient' },
  ]);
  check('withdrawal oversight, the first step and its step down, support', [rules.oversight, rules.firstStep, rules.support], [
    { dimension: 'withdrawal', atOrAbove: 2, level: 'IOP / PHP' },
    { dimension: 'withdrawal', atOrAbove: 3, level: 'Detox', stepDownAtLeast: 'IOP / PHP' },
    { dimension: 'environment', atOrAbove: 3, level: 'Sober Living' },
  ]);
  check('placement levels: the five levels of care, never Interventionist', L.PLACEMENT_LEVELS, ['Detox', 'Inpatient', 'IOP / PHP', 'Sober Living', 'Therapist']);
  ok('every placement level is a partner type', L.PLACEMENT_LEVELS.every((level) => data.partnerTypes.includes(level)));
  ok('Interventionist is not a level of care', !L.isPlacementLevel('Interventionist') && !L.isPlacementLevel('Any type'));

  // Named cases (the docs' examples). first step | level | support.
  const cases = {
    '000000': '-|Therapist|-',
    '111111': '-|Therapist|-',
    '300000': 'Detox|IOP / PHP|-', // detox first; after it, step down no lower than IOP / PHP
    '400000': 'Detox|IOP / PHP|-',
    '311111': 'Detox|IOP / PHP|-',
    '200000': '-|IOP / PHP|-', // moderate withdrawal needs medical oversight: at least IOP / PHP, no detox
    '020000': '-|IOP / PHP|-',
    '003000': '-|Inpatient|-',
    '030000': '-|Inpatient|-',
    '000300': '-|IOP / PHP|-',
    '000400': '-|IOP / PHP|-', // low readiness alone never asks for residential care
    '000020': '-|IOP / PHP|-',
    '000030': '-|IOP / PHP|-',
    '000040': '-|Inpatient|-',
    '000003': '-|Therapist|Sober Living', // unsupportive home, other risks lower: sober living as support
    '000004': '-|Inpatient|Sober Living',
    '000330': '-|Inpatient|-', // two serious risks together
    '000033': '-|Inpatient|Sober Living',
    '000303': '-|Inpatient|Sober Living',
    '000223': '-|IOP / PHP|Sober Living', // three areas at 2+ (four are needed for the moderate rule)
    '022220': '-|Inpatient|-', // four areas at moderate risk together
    '022210': '-|IOP / PHP|-', // three are not enough
    '002222': '-|Inpatient|-',
    '322223': 'Detox|Inpatient|Sober Living', // five areas at 2+ together
    '040000': '-|Inpatient|-', // severe physical needs: Inpatient with the urgent flag, no emergency first step
    '004000': '-|Inpatient|-',
    '432123': 'Detox|Inpatient|Sober Living',
    '444444': 'Detox|Inpatient|Sober Living',
  };
  for (const [digits, expected] of Object.entries(cases)) check(`rules: ${digits}`, path3(L.recommend(ratingsOf(digits))), expected);
  // The docs' named-cases table is exactly what the app writes, row by row.
  const docs = readFileSync(path.join(repoRoot, 'docs/LEVEL_OF_CARE.md'), 'utf8');
  for (const digits of Object.keys(cases)) {
    const ratings = ratingsOf(digits);
    const row = `| ${digits.split('').join(' ')} | ${L.pathLabel(L.recommend(ratings))} | ${L.rationale(ratings).join(' ')} |`;
    ok(`the docs list the named case ${digits} as the app writes it`, docs.includes(`\n${row}\n`));
  }
  check('the docs name the same number of cases', (docs.split('### Named cases')[1].split('### The rationale')[0].match(/^\| [0-4] [0-4] [0-4] [0-4] [0-4] [0-4] \|/gm) || []).length, Object.keys(cases).length);
  ok('the docs give the rules version and the date of Matt\'s decisions', /version\s+2\*\*/.test(docs) && docs.includes('2026-11-05'));
  for (const rule of L.FLAG_RULES) ok(`the docs' flags table has "${rule.title}" as the app words it`, docs.includes(`| ${rule.severity} | ${rule.title} | ${rule.text} |`));
}

// ─── (b) Every area at every rating ─────────────────────────────────────────

{
  const expected = {
    withdrawal: ['-|Therapist|-', '-|Therapist|-', '-|IOP / PHP|-', 'Detox|IOP / PHP|-', 'Detox|IOP / PHP|-'],
    physical: ['-|Therapist|-', '-|Therapist|-', '-|IOP / PHP|-', '-|Inpatient|-', '-|Inpatient|-'],
    emotional: ['-|Therapist|-', '-|Therapist|-', '-|IOP / PHP|-', '-|Inpatient|-', '-|Inpatient|-'],
    readiness: ['-|Therapist|-', '-|Therapist|-', '-|Therapist|-', '-|IOP / PHP|-', '-|IOP / PHP|-'],
    relapse: ['-|Therapist|-', '-|Therapist|-', '-|IOP / PHP|-', '-|IOP / PHP|-', '-|Inpatient|-'],
    environment: ['-|Therapist|-', '-|Therapist|-', '-|Therapist|-', '-|Therapist|Sober Living', '-|Inpatient|Sober Living'],
  };
  for (const key of KEYS) {
    for (const rating of L.RATINGS) {
      const ratings = { ...ratingsOf('000000'), [key]: rating };
      check(`${key} at ${rating}, the rest at 0`, path3(L.recommend(ratings)), expected[key][rating]);
      const info = L.DIMENSIONS[key].ratings[rating];
      ok(`${key} ${rating}: a short label and descriptor`, info.label.length > 0 && info.label.length <= 20 && info.descriptor.length > 10 && info.descriptor.length <= 160);
    }
    ok(`${key}: a title, a line on what it covers, and a phrase`, L.DIMENSIONS[key].title && L.DIMENSIONS[key].covers && L.DIMENSIONS[key].phrase);
    check(`${key}: numbered as practitioners number the areas`, L.DIMENSIONS[key].number, KEYS.indexOf(key) + 1);
  }
}

// ─── (c) Monotonic ──────────────────────────────────────────────────────────

{
  let pairs = 0;
  for (const set of everyRatingSet()) {
    const base = L.recommend(ratingsOf(set.join('')));
    for (let index = 0; index < 6; index += 1) {
      if (set[index] === 4) continue;
      const raised = set.slice();
      raised[index] += 1;
      const up = L.recommend(ratingsOf(raised.join('')));
      pairs += 1;
      if (L.primaryRank(up.level) < L.primaryRank(base.level) || (base.firstStep && !up.firstStep) || (base.support && !up.support)) {
        assert.fail(`raising ${KEYS[index]} from ${set.join('')} lowered the recommendation: ${path3(base)} -> ${path3(up)}`);
      }
    }
  }
  checks += 1;
  ok(`monotonic over every rating set and area (${pairs} raises)`, pairs === 15625 * 6 - 3125 * 6);
}

// ─── (d) The server's rules are the app's ───────────────────────────────────

const lines = [];
for (const set of everyRatingSet()) {
  const rec = L.recommend(ratingsOf(set.join('')));
  lines.push(`${set.join('')}:${rec.level}|${rec.firstStep || '-'}|${rec.support || '-'}`);
}
const DIGEST = createHash('md5').update(lines.join('\n')).digest('hex');
{
  check('15,625 rating sets', lines.length, 15625);
  check('the rules digest (change it here and in the pgTAP test together)', DIGEST, 'a000c8832bb2cf95d732b8cdcf0eae3f');
  ok('the pgTAP test asserts the same digest over the server\'s rules', pgtap.includes(`'${DIGEST}'`) && pgtap.includes('level_of_care_recommendation(ARRAY[w, p, m, r, u, e], 2)'));
  ok('the migration accepts only the same version', /IF p_rules_version IS DISTINCT FROM 2 THEN/.test(migration) && L.RULES_VERSION === 2);
}

{
  // Version 2, rule by rule, over every rating set.
  for (const set of everyRatingSet()) {
    const ratings = ratingsOf(set.join(''));
    const rec = L.recommend(ratings);
    const rank = L.primaryRank(rec.level);
    if (ratings.withdrawal === 2 && rank < 2) assert.fail(`${set.join('')}: withdrawal 2 is at least IOP / PHP`);
    if (rec.firstStep === 'Detox' && rank < 2) assert.fail(`${set.join('')}: after detox, no lower than IOP / PHP`);
    const moderate = ['physical', 'emotional', 'readiness', 'relapse', 'environment'].filter((key) => ratings[key] >= 2).length;
    if (moderate >= 4 && rec.level !== 'Inpatient') assert.fail(`${set.join('')}: four or more areas at 2+ is Inpatient`);
    if ((ratings.physical === 4 || ratings.emotional === 4) && rec.level !== 'Inpatient') assert.fail(`${set.join('')}: physical or emotional 4 stays Inpatient`);
    if (rec.firstStep !== null && rec.firstStep !== 'Detox') assert.fail('the only first step is Detox: no emergency first step');
  }
  checks += 1;
}

// ─── (e) The rationale ──────────────────────────────────────────────────────

{
  let counted = 0;
  for (const set of everyRatingSet()) {
    const ratings = ratingsOf(set.join(''));
    const sentences = L.rationale(ratings);
    if (sentences.length < 2 || sentences.length > 4) assert.fail(`${set.join('')}: ${sentences.length} sentences`);
    for (const sentence of sentences) {
      if (!/^[A-Z]/.test(sentence) || !sentence.endsWith('.')) assert.fail(`${set.join('')}: not a sentence: ${sentence}`);
      // The only numbers are the ratings, "(n of 4)".
      if (/[0-9]/.test(sentence.replace(/\([0-4] of 4\)/g, ''))) assert.fail(`${set.join('')}: a number other than a rating: ${sentence}`);
      if (/ASAM/i.test(sentence)) assert.fail('never the licensed name');
    }
    counted += 1;
  }
  ok(`every rating set gets 2-4 short, factual sentences (${counted})`, counted === 15625);
  check('the rationale for a named case', L.rationale(ratingsOf('323223')), [
    'Withdrawal risk is significant (3 of 4), so medically supervised withdrawal (detox) comes first.',
    'After detox, inpatient (residential) care is recommended because of significant emotional, behavioral or cognitive needs (3 of 4).',
    'Recovery environment concerns are significant (3 of 4), so sober living is recommended as a stable, substance-free place to live after residential care.',
    'Also noted: moderate physical health needs (2 of 4), moderate readiness and engagement concerns (2 of 4) and moderate relapse or continued-use risk (2 of 4).',
  ]);
  check('serious risks together are named as such', L.rationale(ratingsOf('011331'))[0],
    'Inpatient (residential) care is recommended because serious risks occur together: significant readiness and engagement concerns (3 of 4) and significant relapse or continued-use risk (3 of 4).');
  check('moderate withdrawal: medical oversight, at least intensive outpatient', L.rationale(ratingsOf('200000')), [
    'Withdrawal risk is moderate (2 of 4) and needs medical oversight, so at least intensive outpatient or day treatment (IOP / PHP) is recommended.',
    'No other area shows a concern.',
  ]);
  check('after detox, step down no lower than intensive outpatient', L.rationale(ratingsOf('300000')), [
    'Withdrawal risk is significant (3 of 4), so medically supervised withdrawal (detox) comes first.',
    'After detox, step down no lower than intensive outpatient or day treatment (IOP / PHP).',
    'No other area shows a concern.',
  ]);
  check('several moderate risks together call for residential care', L.rationale(ratingsOf('022220')), [
    'Several areas are at moderate risk together, which calls for inpatient (residential) care: moderate physical health needs (2 of 4), moderate emotional, behavioral or cognitive needs (2 of 4), moderate readiness and engagement concerns (2 of 4) and moderate relapse or continued-use risk (2 of 4).',
    'No other area shows a concern.',
  ]);
  check('after detox, with one of them higher', L.rationale(ratingsOf('322223')), [
    'Withdrawal risk is significant (3 of 4), so medically supervised withdrawal (detox) comes first.',
    'Several areas are at moderate risk or higher together, which calls for inpatient (residential) care after detox: moderate physical health needs (2 of 4), moderate emotional, behavioral or cognitive needs (2 of 4), moderate readiness and engagement concerns (2 of 4), moderate relapse or continued-use risk (2 of 4) and significant recovery environment concerns (3 of 4).',
    'Sober living is also recommended as a stable, substance-free place to live after residential care.',
  ]);
  check('a floor that does not set the level is only noted', L.rationale(ratingsOf('220000')), [
    'Intensive outpatient or day treatment (IOP / PHP) is recommended because of moderate physical health needs (2 of 4).',
    'Also noted: moderate withdrawal risk (2 of 4).',
  ]);
  check('nothing to report says so', L.rationale(ratingsOf('000000')), [
    'Outpatient therapy is recommended: no area calls for more structure than regular sessions.',
    'No area shows a concern.',
  ]);
  ok('the rationale only ever reads the ratings (no notes, no case)', L.rationale.length <= 2 && !/notes|case|label|title/i.test(
    readFileSync(path.join(repoRoot, 'src/lib/level-of-care.ts'), 'utf8').split('export function rationale(')[1].split('\n// ─── Safety flags')[0].replace(/\/\/[^\n]*/g, '')));
}

// ─── (f) Safety flags ───────────────────────────────────────────────────────

{
  const keys = (digits, danger = false) => L.safetyFlags(ratingsOf(digits), danger).map((flag) => flag.key);
  check('nothing to flag', keys('111111'), []);
  check('physical 4: an urgent medical evaluation (and the on-site advice of 3)', keys('040000'), ['medical_urgent', 'medical_capacity']);
  check('emotional 4: an urgent psychiatric evaluation (and the on-site advice of 3)', keys('004000'), ['psychiatric_urgent', 'psychiatric_capacity']);
  ok('the medical flag says to arrange an urgent medical evaluation', /urgent medical evaluation/.test(L.safetyFlags(ratingsOf('040000'), false)[0].text));
  ok('the psychiatric flag says to arrange an urgent psychiatric evaluation, and gives 988 and 911', (() => {
    const text = L.safetyFlags(ratingsOf('004000'), false)[0].text;
    return /urgent psychiatric evaluation/.test(text) && /988/.test(text) && /911/.test(text);
  })());
  check('withdrawal 4 and environment 4 are urgent too, with the advice that comes with them', keys('400004'), ['withdrawal_urgent', 'environment_unsafe', 'withdrawal_oversight', 'overdose_risk']);
  check('advice: moderate withdrawal, medical and psychiatric care on site', keys('233000'), ['withdrawal_oversight', 'medical_capacity', 'psychiatric_capacity']);
  check('immediate danger comes first, then urgent, then advice', keys('243000', true), ['imminent_danger', 'medical_urgent', 'withdrawal_oversight', 'medical_capacity', 'psychiatric_capacity']);
  // Cumulative: a worse rating never shows less advice.
  check('withdrawal 2, 3 and 4: the withdrawal advice', ['200000', '300000', '400000'].map((digits) => keys(digits).includes('withdrawal_oversight')), [true, true, true]);
  const withdrawalAdvice = (digits) => L.safetyFlags(ratingsOf(digits), false).filter((flag) => flag.key === 'withdrawal_oversight').map((flag) => flag.title);
  check('worded for the rating: at 2 a medical provider oversees withdrawal wherever the client goes; at 3 and 4 detox comes first',
    ['200000', '300000', '400000'].map(withdrawalAdvice),
    [['Make sure a medical provider oversees withdrawal at whichever level is chosen'],
      ['Arrange detox first, or a program with on-site withdrawal management'],
      ['Arrange detox first, or a program with on-site withdrawal management']]);
  check('the withdrawal-2 advice in plain words', L.safetyFlags(ratingsOf('200000'), false).find((flag) => flag.key === 'withdrawal_oversight').text,
    'Withdrawal needs medical oversight at this level of risk. Make sure a medical provider oversees withdrawal at whichever level is chosen.');
  check('inline under withdrawal: the same wording', [L.inlineFlags('withdrawal', 2).map((flag) => flag.title), L.inlineFlags('withdrawal', 4).map((flag) => flag.title)],
    [['Make sure a medical provider oversees withdrawal at whichever level is chosen'], ['Arrange medically supervised withdrawal today', 'Arrange detox first, or a program with on-site withdrawal management', 'Plan for overdose risk']]);
  ok('the two wordings split exactly where the rules do (oversight from 2, detox first from 3)', (() => {
    const [atTwo, detox] = L.FLAG_RULES.filter((rule) => rule.key === 'withdrawal_oversight');
    return atTwo.triggers[0].when.join(',') === '2' && detox.triggers[0].when.join(',') === '3,4'
      && L.LEVEL_OF_CARE_RULES.oversight.atOrAbove === 2 && L.LEVEL_OF_CARE_RULES.firstStep.atOrAbove === 3;
  })());
  check('withdrawal 0 and 1: no withdrawal advice', ['000000', '100000'].map((digits) => keys(digits).includes('withdrawal_oversight')), [false, false]);
  check('medical and psychiatric care on site at 3 and at 4', [keys('030000'), keys('040000'), keys('003000'), keys('004000')],
    [['medical_capacity'], ['medical_urgent', 'medical_capacity'], ['psychiatric_capacity'], ['psychiatric_urgent', 'psychiatric_capacity']]);
  const oversight = L.FLAG_RULES.filter((rule) => rule.key === 'withdrawal_oversight')[1];
  check('the withdrawal advice at 3 and 4 in plain words', oversight.title, 'Arrange detox first, or a program with on-site withdrawal management');
  // Overdose risk: relapse 3 or more, or detox as the first step.
  check('overdose risk: relapse 3 or 4, or detox first', [keys('000030'), keys('000040'), keys('300000'), keys('000020'), keys('200000')].map((list) => list.includes('overdose_risk')), [true, true, true, false, false]);
  const overdose = L.FLAG_RULES.find((rule) => rule.key === 'overdose_risk');
  ok('overdose risk: lowered tolerance, naloxone (Narcan), 911', /tolerance/.test(overdose.text) && /naloxone \(Narcan\)/.test(overdose.text) && /911/.test(overdose.text) && overdose.severity === 'advice');
  for (const set of everyRatingSet()) {
    const ratings = ratingsOf(set.join(''));
    const detoxFirst = L.recommend(ratings).firstStep === 'Detox';
    const has = keys(set.join('')).includes('overdose_risk');
    if (has !== (ratings.relapse >= 3 || detoxFirst)) assert.fail(`${set.join('')}: overdose flag ${has}, expected ${ratings.relapse >= 3 || detoxFirst}`);
    // Cumulative: raising any one rating never removes a flag.
    for (let index = 0; index < 6; index += 1) {
      if (set[index] === 4) continue;
      const higher = set.slice();
      higher[index] += 1;
      const before = keys(set.join(''));
      const after = keys(higher.join(''));
      if (before.some((key) => !after.includes(key))) assert.fail(`${set.join('')} -> ${higher.join('')}: a flag went away`);
    }
  }
  checks += 2;
  check('inline under an area: the flags its rating raises', [L.inlineFlags('relapse', 3).map((flag) => flag.key), L.inlineFlags('withdrawal', 3).map((flag) => flag.key), L.inlineFlags('relapse', undefined)],
    [['overdose_risk'], ['withdrawal_oversight', 'overdose_risk'], []]);
  const emergency = L.safetyFlags(ratingsOf('000000'), true);
  check('immediate danger alone', emergency.map((flag) => [flag.key, flag.severity]), [['imminent_danger', 'emergency']]);
  ok('immediate danger: 911 and 988 guidance', /call 911/.test(emergency[0].text) && /988/.test(emergency[0].text));
  ok('flags are only emergency, urgent or advice', L.FLAG_RULES.every((rule) => ['urgent', 'advice'].includes(rule.severity)));
  for (const key of ['physical', 'emotional']) {
    for (const set of everyRatingSet()) {
      if (set[KEYS.indexOf(key)] !== 4) continue;
      const flags = keys(set.join(''));
      if (!flags.includes(key === 'physical' ? 'medical_urgent' : 'psychiatric_urgent')) assert.fail(`${set.join('')}: missing the urgent ${key} flag`);
    }
    checks += 1;
  }
}

// ─── (g) Override validation ────────────────────────────────────────────────

// The same fixtures and words are asserted on the server
// (case_assessment_reason_problem in the pgTAP test).
const REASON_FIXTURES = [
  ['', [], L.REASON_PROBLEMS.missing],
  ['  ok ', [], L.REASON_PROBLEMS.missing],
  ['x'.repeat(201), [], L.REASON_PROBLEMS.tooLong],
  ['Family declined residential\nwants IOP', [], L.REASON_PROBLEMS.multiline],
  ['Call mom at jane@example.com', [], 'Leave out email addresses. Programs read this.'],
  ['Reach her at 541-555-0142', [], 'Leave out phone and ID numbers. Programs read this.'],
  ['See www.example.org for the plan', [], 'Leave out links and web addresses. Programs read this.'],
  ['Family declined residential; daily IOP near home', [], null],
  ['2 prior residential stays in 12 months', [], null],
  ['Family can pay 40,000 for a private program', [], 'Leave money out. Programs read this.'],
  ['DOB 3/14/1985, too young for this level', [], 'Leave out dates such as a birth date. Programs read this.'],
  ['Rivera wants to stay near work', ['Rivera intervention'], 'Leave out names ("rivera" is a name on this case). Programs read this.'],
  ['Mother prefers weekly sessions', ['Rivera intervention', 'Mother'], null],
];
{
  for (const [reason, names, expected] of REASON_FIXTURES) check(`reason: ${JSON.stringify(reason.slice(0, 30))}`, L.reasonProblem(reason, names), expected);
  for (const [reason, , expected] of REASON_FIXTURES) {
    if (reason.includes('\n')) continue; // the pgTAP file writes this one with chr(10)
    if (reason.length > 60) continue; // and this one with repeat()
    ok(`the server is tested with the same reason: ${reason.slice(0, 30)}`, pgtap.includes(`'${reason.replace(/'/g, "''")}'`));
    if (expected) ok(`and the same words: ${expected}`, pgtap.includes(`'${expected.replace(/'/g, "''")}'`));
  }
  for (const expected of Object.values(L.REASON_PROBLEMS)) ok(`the server uses the same words: ${expected}`, migration.includes(expected.replace(/'/g, "''")));
  ok('the server screens the reason with the shared check and the case\'s names', /public\.identifying_text_problem\(p_reason, p_names\)/.test(migration));
  const levelSource = readFileSync(path.join(repoRoot, 'src/lib/level-of-care.ts'), 'utf8');
  ok('the app screens it with the shared check, with no ad hoc patterns left', /return identifyingTextProblem\(trimmed, /.test(levelSource) && !/const (EMAIL|LONG_NUMBER|LINK) =/.test(levelSource));
  check('the names: the case title and its contacts', L.reasonNames({ caseTitle: 'Rivera intervention', contactNames: ['Maria Lopez', ' ', null] }), ['Rivera intervention', 'Maria Lopez']);
  check('a contact\'s name is refused', L.reasonProblem('Maria prefers IOP near home', L.reasonNames({ caseTitle: 'R.', contactNames: ['Maria Lopez'] })), 'Leave out names ("maria" is a name on this case). Programs read this.');
  check('the hint says what to leave out', L.REASON_HINT, 'Leave out names, contact details, dates and money; the program reads this.');
  const rec = L.recommend(ratingsOf('323223')); // Detox, then Inpatient, with Sober Living
  // The reason is needed whenever the level is not (first step ?? level):
  // going straight to the level after a recommended detox is a different level.
  check('the first step needs no reason', L.overrideProblem(rec, 'Detox', ''), null);
  check('skipping the recommended detox for the level after it needs one', L.overrideProblem(rec, 'Inpatient', ''), L.REASON_PROBLEMS.missing);
  check('without a first step, the recommended level needs no reason', L.overrideProblem(L.recommend(ratingsOf('003000')), 'Inpatient', ''), null);
  check('followsRecommendation compares with (first step ?? level)', [L.followsRecommendation(rec, 'Detox'), L.followsRecommendation(rec, 'Inpatient'), L.followsRecommendation({ level: 'Inpatient', firstStep: null }, 'Inpatient')], [true, false, true]);
  check('a reason is screened with the case\'s names in the full check too', L.overrideProblem(rec, 'Inpatient', 'Rivera wants to stay near work', ['Rivera intervention']), 'Leave out names ("rivera" is a name on this case). Programs read this.');
  check('a different level needs one', L.overrideProblem(rec, 'IOP / PHP', ''), L.REASON_PROBLEMS.missing);
  check('the support level alone is a different level', L.overrideProblem(rec, 'Sober Living', ' '), L.REASON_PROBLEMS.missing);
  check('a different level with a reason', L.overrideProblem(rec, 'IOP / PHP', 'Family declined residential'), null);
  check('no level', L.overrideProblem(rec, null, ''), 'Choose a level of care');
  check('Interventionist is refused', L.overrideProblem(rec, 'Interventionist', 'x y z'), 'Choose a level of care');
  check('"Use recommended" picks the first step when there is one', [L.defaultChoice(rec), L.defaultChoice(L.recommend(ratingsOf('003000')))], ['Detox', 'Inpatient']);
  check('notes: 200 characters', [L.noteProblem('x'.repeat(200)), L.noteProblem('x'.repeat(201))], [null, 'Keep each note to 200 characters']);
  ok('the server uses the same note limit and words', migration.includes("'Keep each note to 200 characters'"));
}

// ─── (h) What is sent, and how it reads back ────────────────────────────────

const ALL_RATINGS = ratingsOf('323223');
const NOTES = { withdrawal: '  Daily fifth of vodka; shakes by noon  ', physical: '', emotional: 'Maria Lopez says panic attacks nightly', readiness: '', relapse: '', environment: 'Brother uses at home' };
{
  const draft = { ratings: ALL_RATINGS, notes: NOTES, imminentDanger: false, chosenLevel: 'Detox', overrideReason: 'left over from before' };
  const prepared = L.prepareAssessment(draft);
  check('the arguments, in the RPC\'s order', prepared.input, {
    ratings: [3, 2, 3, 2, 2, 3],
    notes: ['Daily fifth of vodka; shakes by noon', '', 'Maria Lopez says panic attacks nightly', '', '', 'Brother uses at home'],
    imminentDanger: false,
    rulesVersion: 2,
    recommendedLevel: 'Inpatient',
    recommendedFirstStep: 'Detox',
    recommendedSupport: 'Sober Living',
    chosenLevel: 'Detox',
    overrideReason: '',
  });
  check('a different level sends its trimmed reason', L.prepareAssessment({ ...draft, chosenLevel: 'IOP / PHP', overrideReason: '  Family declined residential ' }).input.overrideReason, 'Family declined residential');
  check('the safety question comes first', L.prepareAssessment({ ...draft, imminentDanger: null }), { problem: 'Answer the safety question first' });
  check('every area is rated', L.prepareAssessment({ ...draft, ratings: { ...ALL_RATINGS, relapse: undefined } }), { problem: 'Rate relapse or continued-use risk first' });
  check('a different level without a reason', L.prepareAssessment({ ...draft, chosenLevel: 'Therapist', overrideReason: '' }), { problem: L.REASON_PROBLEMS.missing });
  check('a long note', L.prepareAssessment({ ...draft, notes: { ...NOTES, relapse: 'x'.repeat(201) } }), { problem: 'Relapse or continued-use risk: keep each note to 200 characters' });

  const row = {
    id: 'A1000000-0000-4000-8000-000000000001', case_id: 'C1000000-0000-4000-8000-000000000001', org_id: 'o1',
    withdrawal_rating: 3, physical_rating: 2, emotional_rating: 3, readiness_rating: 2, relapse_rating: 2, environment_rating: 3,
    withdrawal_note: 'Daily fifth of vodka; shakes by noon', physical_note: '', emotional_note: 'Maria Lopez says panic attacks nightly', readiness_note: '', relapse_note: '', environment_note: 'Brother uses at home',
    imminent_danger: false, recommended_level: 'Inpatient', recommended_first_step: 'Detox', recommended_support: 'Sober Living',
    chosen_level: 'IOP / PHP', override_reason: 'Family declined residential; daily IOP near home', rules_version: 2,
    assessed_by: 'B1000000-0000-4000-8000-000000000001', assessed_at: '2026-11-04T18:30:00.000Z', created_at: '2026-11-04T18:30:00.000Z',
  };
  const read = L.assessmentFromRow(row);
  check('a saved row reads back', [read.id, read.caseId, read.ratings, read.recommendation, read.chosenLevel, read.assessedBy], [
    'a1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', ALL_RATINGS,
    { level: 'Inpatient', firstStep: 'Detox', support: 'Sober Living' }, 'IOP / PHP', 'b1000000-0000-4000-8000-000000000001']);
  check('a malformed row is skipped', [
    L.assessmentFromRow({ ...row, relapse_rating: 5 }), L.assessmentFromRow({ ...row, chosen_level: 'Interventionist' }),
    L.assessmentFromRow({ ...row, recommended_level: 'Detox' }), L.assessmentFromRow(null)], [null, null, null, null]);
  for (const column of L.ASSESSMENT_COLUMNS) ok(`the migration has ${column}`, new RegExp(`\\n  ${column} +`).test(migration));
  const older = L.assessmentFromRow({ ...row, id: 'a0', assessed_at: '2026-10-01T18:30:00.000Z' });
  check('the newest is current', L.currentAssessment([older, read]).id, read.id);
  check('ties go to the larger id, as the server orders them', L.currentAssessment([{ ...read, id: 'a2' }, { ...read, id: 'a3' }]).id, 'a3');
  check('none yet', L.currentAssessment([]), null);
}

// ─── (i) The packet ─────────────────────────────────────────────────────────

const partner = {
  id: 'p-fixture-a', name: 'Sarah Ellison', organization: 'Riverstone Recovery Center', type: 'Inpatient', types: ['Inpatient', 'Detox', 'IOP / PHP'],
  city: 'Bend', state: 'OR', regions: ['Nationwide'], phone: '(541) 555-0142', email: 'admissions@riverstonerecovery.com', website: '',
  monthlyCost: 30000, insuranceNetworks: { Aetna: ['In-network'] }, cashMin: 0, cashMax: 0, insurance: ['Aetna'],
  therapies: ['Trauma', 'Dual diagnosis', 'MAT'], populations: [], levels: ['Inpatient'], note: '', inbound: 0, outbound: 0, lastContact: '2026-07-20',
};
const profile = {
  id: 'm-fixture-1', clientLabel: 'Rivera family', levelOfCare: 'IOP / PHP', state: 'OR', insurance: 'Aetna', networkPreferences: ['In-network'],
  therapies: ['Trauma'], status: 'Matching', createdAt: '2026-07-24T00:00:00.000Z', updatedAt: '2026-07-24T00:00:00.000Z', caseId: 'c1',
};
const fit = { networkStatus: 'In-network', verifyBenefits: false, requiredNeeds: [], matchedNeeds: ['Trauma'], regionFit: true, sameState: true, paymentFit: true, locationPreference: 'No preference' };
{
  const assessment = L.assessmentFromRow({
    id: 'a1', case_id: 'c1', withdrawal_rating: 3, physical_rating: 2, emotional_rating: 3, readiness_rating: 2, relapse_rating: 2, environment_rating: 3,
    withdrawal_note: 'Daily fifth of vodka', physical_note: '', emotional_note: 'Maria Lopez says panic attacks nightly', readiness_note: '', relapse_note: '', environment_note: 'Brother uses',
    imminent_danger: true, recommended_level: 'Inpatient', recommended_first_step: 'Detox', recommended_support: 'Sober Living',
    chosen_level: 'IOP / PHP', override_reason: 'Family declined residential; daily IOP near home', rules_version: 2, assessed_by: null,
    assessed_at: new Date(2026, 10, 4, 12, 0, 0).toISOString(),
  });
  const section = L.levelOfCarePacketLines(assessment, profile.levelOfCare);
  check('the program copy\'s section', section, [
    'LEVEL-OF-CARE RATIONALE',
    '- Recommended: Detox, then Inpatient, with Sober Living',
    '- Chosen: IOP / PHP',
    '- Reason for a different level: Family declined residential; daily IOP near home',
    L.rationale(ALL_RATINGS).join(' '),
    'Assessed Nov 4, 2026 across six areas, following the widely used six-dimension framework. Decision support for the practitioner\'s clinical judgment, not a diagnosis.',
  ]);
  const program = buildPacket(profile, partner, buildFitReasons(profile, partner, fit, 'partner'), 'partner', [], section);
  ok('the program copy carries the rationale after the client criteria', program.indexOf('LEVEL-OF-CARE RATIONALE') > program.indexOf('CLIENT CRITERIA') && program.indexOf('LEVEL-OF-CARE RATIONALE') < program.indexOf('WHY THIS FITS'));
  ok('the program copy names the assessed date', program.includes('Assessed Nov 4, 2026'));
  for (const secret of ['Maria', 'Lopez', 'vodka', 'Brother', 'immediate danger', 'Daily fifth']) {
    ok(`the rationale section never carries a note or a flag: ${secret}`, !section.join('\n').includes(secret) && !program.includes(secret));
  }
  ok('the section names no client', !section.join('\n').includes('Rivera'));
  ok('the section never names the licensed criteria', !/ASAM/i.test(section.join('\n')));

  const family = buildPacket(profile, partner, buildFitReasons(profile, partner, fit, 'family'), 'family', [], section);
  ok('the family copy never carries the rationale, whatever is passed', !family.includes('RATIONALE') && !family.includes('Recommended:') && !family.includes('Reason for a different level'));
  ok('the family copy never shows a rating', !/\b[0-4] of 4\b/.test(family) && !/withdrawal|relapse|readiness|emotional|recovery environment/i.test(family));
  ok('the family copy keeps its plain "Level of care" line', family.includes('- Level of care: IOP / PHP'));
  check('the family copy is exactly the copy without an assessment', family, buildPacket(profile, partner, buildFitReasons(profile, partner, fit, 'family'), 'family'));
  check('no assessment, no section', L.levelOfCarePacketLines(null, 'Inpatient'), []);
  check('without a section the program copy is unchanged', buildPacket(profile, partner, buildFitReasons(profile, partner, fit, 'partner'), 'partner', [], []),
    buildPacket(profile, partner, buildFitReasons(profile, partner, fit, 'partner'), 'partner'));

  const followed = { ...assessment, chosenLevel: 'Detox', overrideReason: '' };
  const followedLines = L.levelOfCarePacketLines(followed, 'Detox');
  ok('following the recommendation: no reason line, no mismatch line', !followedLines.some((line) => line.startsWith('- Reason')) && !followedLines.some((line) => line.includes('This referral is for')));
  check('a referral at another level says so plainly', L.levelOfCarePacketLines(followed, 'Inpatient')[3], '- This referral is for Inpatient, which is not the level chosen in the assessment.');
  check('"Any level of care" is not a mismatch', L.levelOfCarePacketLines(followed, 'Any type').some((line) => line.includes('This referral is for')), false);
  const otherRules = { ...followed, recommendation: { level: 'Therapist', firstStep: null, support: null } };
  ok('a row saved under other rules keeps its words but no rebuilt rationale', !L.levelOfCarePacketLines(otherRules, 'Detox').some((line) => line.includes('(3 of 4)')));

  const app = readFileSync(path.join(repoRoot, 'App.tsx'), 'utf8');
  ok('the app passes the rationale for the program copy only', /const rationaleLines = audience === 'partner' \? levelOfCarePacketLines\(caseAssessments\.currentFor\(packetTarget\.match\.caseId\), packetTarget\.match\.levelOfCare\) : \[\];/.test(app));
  ok('and builds the copy with it', /audience, costLines, rationaleLines\)\);/.test(app));
}

// ─── (j) Matching reads only the chosen level ───────────────────────────────

{
  const matchingSource = readFileSync(path.join(repoRoot, 'src/lib/matching.ts'), 'utf8');
  ok('the ranker never reads assessments', !/level-of-care|assessment/i.test(matchingSource));
  for (const file of ['src/lib/placement-requests.ts', 'src/lib/placement-api.ts']) {
    ok(`${file} never reads assessments`, !/level-of-care|assessment/i.test(readFileSync(path.join(repoRoot, file), 'utf8')));
  }
  const placementMigration = readFileSync(path.join(repoRoot, 'supabase/migrations/20261104140000_placement_requests.sql'), 'utf8');
  ok('the placement payload allow-list is untouched (ten keys)', placementMigration.includes("payload - ARRAY['level_of_care', 'population', 'must_haves', 'needs', 'payment', 'insurance_carrier',"));
  // Its paste-order guard may name them (it only checks they exist first).
  const body = migration.replace(/--[^\n]*/g, '').replace(/to_regclass\('public\.placement_request[a-z_]*'\)/g, '').replace(/20261104140000_placement_requests\.sql/g, '');
  ok('this migration never touches placement requests', !/placement_request(?!_recipients SET org_id|s    SET org_id)/.test(body));

  // The chosen level is the match's level of care, exactly as if set by hand.
  const partners = [
    partner,
    { ...partner, id: 'p-iop', organization: 'Day Program', types: ['IOP / PHP'], type: 'IOP / PHP' },
    { ...partner, id: 'p-sl', organization: 'Sober House', types: ['Sober Living'], type: 'Sober Living' },
  ];
  const byHand = matching.rankPrograms({ ...profile, levelOfCare: 'IOP / PHP' }, partners, {});
  const fromAssessment = matching.rankPrograms({ ...profile, levelOfCare: L.defaultChoice(L.recommend(ratingsOf('020000'))) }, partners, {});
  check('the same ranking and scores as choosing the level by hand', fromAssessment.map((item) => [item.partner.id, item.total]), byHand.map((item) => [item.partner.id, item.total]));
  const app = readFileSync(path.join(repoRoot, 'App.tsx'), 'utf8');
  ok('the match memo still ranks through matching.ts alone', /const matches = useMemo\(\s*\(\) => rankPrograms\(draftMatchProfile, partners, scorecards, bedOptions\),\s*\[draftMatchProfile, partners, scorecards, bedOptions\],/.test(app));
  ok('"Find placement with this level" puts the chosen level on the match form (new or saved match)', (app.match(/if \(level\) setMatchType\(level\);/g) || []).length === 2 && /function startMatchForCase\(record: CaseRecord, level\?: PlacementLevel\)/.test(app));
  ok('the existing find-placement flow is reused, never duplicated', /onFindPlacement=\{\(level\) => startMatchForCase\(record, level\)\}/.test(app) && (app.match(/function startMatchForCase\(/g) || []).length === 1);
}

// ─── (k) The match note and the timeline wording ────────────────────────────

{
  const assessment = L.assessmentFromRow({
    id: 'a1', case_id: 'c1', withdrawal_rating: 3, physical_rating: 0, emotional_rating: 3, readiness_rating: 0, relapse_rating: 0, environment_rating: 0,
    imminent_danger: false, recommended_level: 'Inpatient', recommended_first_step: 'Detox', recommended_support: null,
    chosen_level: 'Detox', override_reason: '', rules_version: 2, assessed_by: null, assessed_at: new Date(2026, 10, 4, 9).toISOString(),
  });
  check('the line on the match', L.assessedLevelLine(assessment), 'Assessed: Detox · Nov 4, 2026');
  check('the same level: no note', L.matchLevelNote(assessment, 'Detox'), null);
  check('the next step on its path', L.matchLevelNote(assessment, 'Inpatient'), 'The assessment chose Detox for now; Inpatient is also on its recommended path (Detox, then Inpatient).');
  check('any level', L.matchLevelNote(assessment, 'Any type'), 'The assessment chose Detox. "Any level of care" ranks programs of every level.');
  ok('moved away: a gentle note, never a block', /That is fine if the plan changed; reassess/.test(L.matchLevelNote(assessment, 'Therapist')));
  check('no assessment: nothing', L.matchLevelNote(null, 'Therapist'), null);

  // The same words are asserted on the server (case_assessment_event_body).
  const bodies = [
    [{ level: 'Inpatient', firstStep: null, support: null }, 'Inpatient', 'Level-of-care assessment: recommended Inpatient'],
    [{ level: 'Inpatient', firstStep: 'Detox', support: 'Sober Living' }, 'Detox', 'Level-of-care assessment: recommended Detox, then Inpatient, with Sober Living'],
    [{ level: 'IOP / PHP', firstStep: null, support: null }, 'Therapist', 'Level-of-care assessment: recommended IOP / PHP; chosen Therapist'],
    [{ level: 'Inpatient', firstStep: 'Detox', support: null }, 'Inpatient', 'Level-of-care assessment: recommended Detox, then Inpatient; chosen Inpatient'],
  ];
  for (const [rec, chosen, body] of bodies) {
    check(`timeline: ${body}`, L.assessmentEventBody(rec, chosen), body);
    ok(`the server is tested with the same words: ${body}`, pgtap.includes(`'${body}'`));
  }
  for (const set of everyRatingSet()) {
    const rec = L.recommend(ratingsOf(set.join('')));
    for (const chosen of L.PLACEMENT_LEVELS) {
      if (/[0-9]/.test(L.assessmentEventBody(rec, chosen))) assert.fail('a timeline entry never carries a rating');
    }
  }
  checks += 1;
  check('dates', [L.formatAssessedDate(new Date(2026, 0, 31, 23).toISOString()), L.formatAssessedDate('not a date')], ['Jan 31, 2026', '']);
}

// ─── (l) The API ────────────────────────────────────────────────────────────

function query(result, seen) {
  const chain = {
    select: (columns) => { if (seen) seen.columns = columns; return chain; },
    eq: (column, value) => { if (seen) seen.eq = [column, value]; return chain; },
    order: () => chain,
    limit: () => Promise.resolve(result),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return chain;
}

{
  for (const code of ['PGRST205', '42P01', '42703']) {
    fake.from = () => query({ data: null, error: { code, message: 'missing' }, status: 404 });
    check(`a server without the migration hides the feature (${code})`, await api.fetchCaseAssessments('c1'), { available: false, assessments: [] });
  }
  for (const code of ['PGRST202', 'PGRST205', '42P01', '42703', '42883']) ok(`missing schema: ${code}`, L.isMissingAssessmentSchema(code));
  ok('a refusal is not a missing schema', !L.isMissingAssessmentSchema('42501') && !L.isMissingAssessmentSchema('22023'));

  const seen = {};
  const row = {
    id: 'a1', case_id: 'c1', withdrawal_rating: 0, physical_rating: 2, emotional_rating: 0, readiness_rating: 0, relapse_rating: 0, environment_rating: 0,
    imminent_danger: false, recommended_level: 'IOP / PHP', recommended_first_step: null, recommended_support: null, chosen_level: 'IOP / PHP',
    override_reason: '', rules_version: 2, assessed_by: 'u1', assessed_at: '2026-11-04T10:00:00Z',
  };
  fake.from = (table) => { seen.table = table; return query({ data: [{ ...row, id: 'a0', assessed_at: '2026-10-01T10:00:00Z' }, row, { bogus: true }], error: null, status: 200 }, seen); };
  const read = await api.fetchCaseAssessments('c1');
  check('reads one case\'s rows, newest first, skipping a malformed one', [seen.table, seen.eq, read.available, read.assessments.map((item) => item.id)], ['case_assessments', ['case_id', 'c1'], true, ['a1', 'a0']]);
  check('with the explicit column list', seen.columns, L.ASSESSMENT_COLUMNS.join(', '));
  fake.from = () => query({ data: null, error: { message: 'TypeError: Network request failed' }, status: 0 });
  await assert.rejects(api.fetchCaseAssessments('c1'), (error) => error instanceof errors.OfflineError);
  checks += 1;

  const prepared = L.prepareAssessment({ ratings: ratingsOf('020000'), notes: {}, imminentDanger: false, chosenLevel: 'IOP / PHP', overrideReason: '' });
  fake.rpc = (name, args) => {
    check('the RPC and its arguments', [name, Object.keys(args)], ['save_case_assessment', ['p_id', 'p_case_id', 'p_ratings', 'p_notes', 'p_imminent_danger', 'p_rules_version',
      'p_recommended_level', 'p_recommended_first_step', 'p_recommended_support', 'p_chosen_level', 'p_override_reason']]);
    check('the ratings in order', args.p_ratings, [0, 2, 0, 0, 0, 0]);
    return Promise.resolve({ data: { ...row, event_body: 'Level-of-care assessment: recommended IOP / PHP' }, error: null, status: 200 });
  };
  const id = api.newAssessmentId();
  const saved = await api.saveCaseAssessment(id, 'c1', prepared.input);
  check('the saved row and the timeline wording come back', [saved.assessment.id, saved.eventBody], ['a1', 'Level-of-care assessment: recommended IOP / PHP']);
  ok('the migration\'s signature takes the same arguments in the same order', /save_case_assessment\(\s*p_id uuid, p_case_id uuid, p_ratings integer\[\], p_notes text\[\], p_imminent_danger boolean,\s*p_rules_version integer, p_recommended_level text, p_recommended_first_step text,\s*p_recommended_support text, p_chosen_level text, p_override_reason text\)/.test(migration));

  fake.rpc = () => Promise.resolve({ data: null, error: { message: 'TypeError: Network request failed' }, status: 0 });
  await assert.rejects(api.saveCaseAssessment(id, 'c1', prepared.input), (error) => error instanceof errors.OfflineError);
  checks += 1;
  fake.rpc = () => Promise.resolve({ data: null, error: { code: '22023', message: L.REASON_PROBLEMS.missing }, status: 400 });
  await assert.rejects(api.saveCaseAssessment(id, 'c1', prepared.input),
    (error) => error instanceof errors.StoreError && !(error instanceof errors.OfflineError) && error.message === L.REASON_PROBLEMS.missing);
  checks += 1;
  fake.rpc = () => Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' }, status: 404 });
  await assert.rejects(api.saveCaseAssessment(id, 'c1', prepared.input), (error) => /server update/.test(error.message));
  checks += 1;
  fake.rpc = () => Promise.resolve({ data: { id: 'a1' }, error: null, status: 200 });
  await assert.rejects(api.saveCaseAssessment(id, 'c1', prepared.input), (error) => /could not be read back/.test(error.message));
  checks += 1;

  const apiSource = readFileSync(path.join(repoRoot, 'src/lib/level-of-care-api.ts'), 'utf8');
  ok('the API writes nothing but its own RPC', !/\.(insert|update|upsert|delete)\(/.test(apiSource) && !/match_profiles|placement_request/.test(apiSource));
}

// ─── (m) The screens ────────────────────────────────────────────────────────

{
  const sheet = readFileSync(path.join(repoRoot, 'src/lib/LevelOfCareSheet.tsx'), 'utf8');
  const card = readFileSync(path.join(repoRoot, 'src/lib/LevelOfCareCard.tsx'), 'utf8');
  const app = readFileSync(path.join(repoRoot, 'App.tsx'), 'utf8');
  for (const [file, source] of [['LevelOfCareSheet.tsx', sheet], ['LevelOfCareCard.tsx', card]]) {
    ok(`${file} presents no Modal of its own`, !/<Modal\b/.test(source) && !/\bModal\b,/.test(source));
    ok(`${file} never uses the licensed name`, !/ASAM/i.test(source));
  }
  ok('the core never uses the licensed name', !/ASAM/i.test(readFileSync(path.join(repoRoot, 'src/lib/level-of-care.ts'), 'utf8')));
  ok('the assessment swaps into the case file\'s own sheet', /if \(vobAnswerForm\) return VobAnswerModal\(activeCase\);\s*if \(assessmentCaseId === activeCase\.id\) return LevelOfCareModal\(activeCase\);/.test(app));
  const wrapper = app.slice(app.indexOf('function LevelOfCareModal(record: CaseRecord)'), app.indexOf('function CaseBenefitsModal(record: CaseRecord)'));
  check('one native Modal around the sheet, at the case sheet\'s place', (wrapper.match(/<Modal\b/g) || []).length, 1);
  ok('the Modal\'s back asks before dropping answers', /onRequestClose=\{\(\) => assessmentBackRef\.current\(\)\}/.test(wrapper));
  ok('the case file closes (it never presents) on "Find placement with this level"', /onFindPlacement=\{\(level\) => startMatchForCase\(record, level\)\}/.test(wrapper) && /if \(level\) setMatchType\(level\);\s*setTab\('match'\);\s*closeCase\(\);/.test(app));
  const body = (name, end) => app.slice(app.indexOf(name), app.indexOf(end, app.indexOf(name)));
  ok('opening a case, closing it, or switching accounts drops the sheet',
    body('function openCase(caseId: string)', 'loadCaseList(userId)').includes('setAssessmentCaseId(null);')
    && body('function closeCase()', '\n  }\n').includes('setAssessmentCaseId(null);')
    && body('const resetAccountState = useCallback', 'setPendingNav(null);').includes('setAssessmentCaseId(null);'));
  ok('decision support, said plainly, on the card and in the sheet', card.includes('Decision support, not a diagnosis. You can always choose a different level and say why.') && /Decision support, not a diagnosis\./.test(sheet));
  ok('the sheet credits the framework in its own words', sheet.includes('follow the widely used six-dimension framework'));
  ok('offline, the card says the assessment loads when online', card.includes("Assessment loads when you\\'re online."));
  ok('a retry of the same answers reuses the id; changed answers get a new one', /const id = attemptRef\.current\?\.signature === signature \? attemptRef\.current\.id : newAssessmentId\(\);\s*attemptRef\.current = \{ id, signature \};/.test(sheet));
  ok('an offline failure keeps the answers and offers Try again', /error instanceof OfflineError/.test(sheet) && /saveNotice \? 'Try again' : 'Save assessment'/.test(sheet));
  ok('the reason is required for a different level (the save checks it, against the case\'s names)', /prepareAssessment\(draft, names\)/.test(sheet) && /WHY A DIFFERENT LEVEL\? \(REQUIRED\)/.test(sheet));
  ok('the reason field screens and hints as the program reads it', /reasonProblem\(draft\.overrideReason, names\)/.test(sheet) && /\{reasonIssue \|\| REASON_HINT\}/.test(sheet));
  ok('the app hands the sheet the case\'s title and contact names', /names=\{reasonNames\(\{ caseTitle: record\.title, contactNames: caseContactNames\(record\.id\) \}\)\}/.test(app));
  ok('"Use recommended" offers only where the client goes now (first step ?? level)', /\[\{ level: defaultChoice\(recommendation\), label: /.test(sheet) && !/the recommended level after it/.test(sheet));
  ok('the card\'s Earlier line compares with (first step ?? level)', /followsRecommendation\(item\.recommendation, item\.chosenLevel\) \? '' : ` · chose \$\{item\.chosenLevel\}`/.test(card));
  ok('inline flags use the cumulative rules', /const inline = inlineFlags\(key, chosen\);/.test(sheet));
  ok('the safety question shows 911 / 988 at once', /draft\.imminentDanger \? renderFlag\(EMERGENCY_FLAG\) : null/.test(sheet));
  ok('the match shows the assessed level, still editable', /<AssessedLevelNote assessment=\{matchAssessment\} matchLevel=\{matchType as ReferralMatch\['levelOfCare'\]\} \/>/.test(app) && /onChange=\{setMatchType\}/.test(app));
  ok('the card hides on a server without the feature', /if \(!entry \|\| entry\.status === 'unavailable'\) return null;/.test(card));
  for (const text of [L.EMERGENCY_FLAG.text, ...L.FLAG_RULES.map((rule) => rule.text)]) ok('safety text is plain ASCII punctuation', /^[\x20-\x7E]+$/.test(text));
  const privacy = readFileSync(path.join(repoRoot, 'docs/privacy.html'), 'utf8');
  ok('the privacy policy describes assessment ratings with case files',
    privacy.indexOf('<strong>Level-of-care assessments.</strong>') > privacy.indexOf('<strong>Case files.</strong>')
    && /clinical-adjacent information about a client/.test(privacy) && /never added to placement requests/.test(privacy));
  const docs = readFileSync(path.join(repoRoot, 'docs/LEVEL_OF_CARE.md'), 'utf8');
  ok('the docs carry the licensing note and the deploy steps', /## Licensing/.test(docs) && /none of them is used here/.test(docs)
    && docs.includes("VALUES ('20261104150000', 'level_of_care');"));
}

// ─── (n) The migration follows the paste rules ──────────────────────────────

function topLevelStatements(sql) {
  const statements = [];
  let start = 0;
  let index = 0;
  let dollar = null;
  while (index < sql.length) {
    if (dollar) {
      if (sql.startsWith(dollar, index)) { index += dollar.length; dollar = null; } else index += 1;
      continue;
    }
    const rest = sql.slice(index);
    const tag = /^\$[A-Za-z_]*\$/.exec(rest);
    if (tag) { dollar = tag[0]; index += tag[0].length; continue; }
    if (sql[index] === '-' && sql[index + 1] === '-') { const end = sql.indexOf('\n', index); index = end < 0 ? sql.length : end + 1; continue; }
    if (sql[index] === "'") { index += 1; while (index < sql.length) { if (sql[index] === "'" && sql[index + 1] === "'") index += 2; else if (sql[index] === "'") { index += 1; break; } else index += 1; } continue; }
    if (sql[index] === ';') { statements.push(sql.slice(start, index + 1)); start = index + 1; }
    index += 1;
  }
  const tail = sql.slice(start).trim();
  return { statements, tail, unterminated: dollar };
}

{
  ok('ASCII only', /^[\x00-\x7F]*$/.test(migration));
  ok('no backslash anywhere', !migration.includes('\\'));
  const { statements, tail, unterminated } = topLevelStatements(migration);
  ok('every dollar quote is closed', unterminated === null);
  check('nothing after the last statement', tail, '');
  const longest = Math.max(...statements.map((statement) => statement.length));
  ok(`every top-level statement is under 3,700 characters (longest ${longest})`, longest < 3700);
  check('the whole file runs in one BEGIN/COMMIT', [statements[0].trim().endsWith('BEGIN;'), statements[statements.length - 1].trim().endsWith('COMMIT;')], [true, true]);
  ok('only one BEGIN and one COMMIT', statements.filter((statement) => /^\s*(--[^\n]*\n\s*)*BEGIN;\s*$/.test(statement)).length === 1 && statements.filter((statement) => /COMMIT;\s*$/.test(statement)).length === 1);
  ok('the table is revoked before its one grant',
    migration.indexOf('REVOKE ALL ON TABLE public.case_assessments FROM PUBLIC, anon, authenticated;') > 0
    && migration.indexOf('REVOKE ALL ON TABLE public.case_assessments FROM PUBLIC, anon, authenticated;') < migration.indexOf('GRANT SELECT ON TABLE public.case_assessments TO authenticated;'));
  ok('no write policy', !/CREATE POLICY[^;]*FOR (INSERT|UPDATE|DELETE|ALL)/.test(migration));
  const definers = [...migration.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)\(([^)]*)\)[\s\S]*?\$\$;\s*\n(REVOKE ALL ON FUNCTION public\.\1\([^)]*\) FROM PUBLIC, anon[^;]*;)/g)];
  const created = [...migration.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)\(/g)].map((match) => match[1]);
  check('every function is revoked from PUBLIC and anon right after it is made', definers.map((match) => match[1]).sort(), [...created].sort());
  const pinned = [...migration.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)\([\s\S]*?(SECURITY DEFINER)?\s*\nSET search_path/g)];
  ok('every function pins its search_path', pinned.length === created.length);
  ok('the writer is SECURITY DEFINER', /FUNCTION public\.save_case_assessment\([\s\S]*?LANGUAGE plpgsql SECURITY DEFINER\s*\nSET search_path = public/.test(migration));
  for (const name of ['referral_handoffs', 'referral_handoff_events', 'referral_sources', 'referral_intake_submissions', 'referral_intake_rate_limits', 'center_availability']) {
    ok(`no object named ${name}`, !migration.includes(name));
  }
  const recreated = created.filter((name) => !['level_of_care_recommendation', 'case_assessment_event_body', 'case_assessment_reason_problem',
    'case_assessment_problem', 'case_assessment_json', 'save_case_assessment'].includes(name));
  check('the only existing function re-created is the workspace-move helper', recreated, ['org_move_workspace_rows']);
  ok('no existing table is altered and nothing is dropped', !/ALTER TABLE (?!public\.case_assessments)/.test(migration) && !/DROP (TABLE|COLUMN|TRIGGER)/.test(migration));
  // The only functions dropped are this file's own earlier drafts, with
  // other signatures (so an older draft never leaves two of a function).
  check('only superseded drafts of this file\'s own functions are dropped, IF EXISTS',
    [...migration.matchAll(/DROP FUNCTION[^;]*;/g)].map((match) => match[0]),
    ['DROP FUNCTION IF EXISTS public.case_assessment_reason_problem(text);',
     'DROP FUNCTION IF EXISTS public.case_assessment_problem(integer[], text[], integer, text, text, text, text, text);']);
  const previous = readFileSync(path.join(repoRoot, 'supabase/migrations/20261104140000_placement_requests.sql'), 'utf8');
  const move = (sql) => sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.org_move_workspace_rows'), sql.indexOf('REVOKE ALL ON FUNCTION public.org_move_workspace_rows'));
  check('the move helper is the latest definition plus one line',
    move(migration).split('\n').filter((line) => !move(previous).split('\n').includes(line)),
    ['  UPDATE public.case_assessments      SET org_id = p_to WHERE org_id = p_from;']);
  check('and drops nothing from it', move(previous).split('\n').filter((line) => !move(migration).split('\n').includes(line)), []);
  ok('the case foreign key cascades on delete and follows a moved case', /FOREIGN KEY \(case_id, org_id\)\s*REFERENCES public\.cases \(id, org_id\) ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE/.test(migration));
  ok('a deleted teammate leaves their assessments unattributed', /assessed_by +uuid REFERENCES auth\.users\(id\) ON DELETE SET NULL/.test(migration));
  ok('the migration never names the licensed criteria', !/ASAM/i.test(migration));
}

console.log(`level of care: ${checks} checks ok`);
