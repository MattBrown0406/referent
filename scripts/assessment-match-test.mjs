// From a finished family assessment to the Match form (src/lib/assessment-match.ts,
// docs/FAMILY_ASSESSMENT.md "From answers to matches"). Run with:
// node scripts/assessment-match-test.mjs

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'assessment-match-test');
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
transpileTo('src/lib/assessment-match.ts', 'lib/assessment-match.js');
const { therapyOptions, insuranceProvidersForState } = require(path.join(tmpDir, 'data.js'));
const { matchFromAssessment, carrierFromText } = require(path.join(tmpDir, 'lib/assessment-match.js'));

const base = { needOptions: therapyOptions, insuranceOptions: insuranceProvidersForState('ANY') };
let checks = 0;
const check = (name, fn) => { fn(); checks += 1; };

check('an empty assessment fills nothing and says so', () => {
  const result = matchFromAssessment({ ...base, answers: {} });
  assert.equal(result.population, 'Any');
  assert.deepEqual(result.needs, []);
  assert.equal(result.insurance, 'Cash pay');
  assert.equal(result.levelOfCare, null);
  assert.deepEqual(result.used, []);
  assert.match(result.toCheck[0], /Nothing in the answers/);
});

check('population: under 18 is Adolescent, before gender', () => {
  assert.equal(matchFromAssessment({ ...base, answers: { age: '16', gender: 'male' } }).population, 'Adolescent');
  assert.equal(matchFromAssessment({ ...base, answers: { age: 34, gender: 'male' } }).population, 'Men');
  assert.equal(matchFromAssessment({ ...base, answers: { age: 34, gender: 'female' } }).population, 'Women');
  assert.equal(matchFromAssessment({ ...base, answers: { age: 34, gender: 'non-binary' } }).population, 'Any');
  assert.equal(matchFromAssessment({ ...base, answers: { age: 'abc', gender: 'other' } }).population, 'Any');
});

check('gender-specific care is only ever to check: Men only / Women only would hide co-ed programs', () => {
  const men = matchFromAssessment({ ...base, answers: { gender: 'male', treatmentPreferences: 'Gender-specific, near the beach' } });
  assert.deepEqual(men.needs, []);
  assert.ok(men.toCheck.some((line) => /add Men only if so/.test(line)));
  const women = matchFromAssessment({ ...base, answers: { gender: 'female', treatmentPreferences: 'women only please' } });
  assert.deepEqual(women.needs, []);
  assert.ok(women.toCheck.some((line) => /add Women only if so/.test(line)));
  const coed = matchFromAssessment({ ...base, answers: { gender: 'male', treatmentPreferences: 'Co-ed is fine, does not need to be gender-specific' } });
  assert.deepEqual(coed.needs, []);
  assert.ok(!coed.toCheck.some((line) => /gender-specific/.test(line)));
  const none = matchFromAssessment({ ...base, answers: { gender: 'male' } });
  assert.deepEqual(none.needs, []);
});

check('a preference the family says no to is never added', () => {
  for (const words of ['No faith-based or Christian programs', 'No wilderness programs', 'not interested in EMDR', 'He doesn’t want DBT', 'Anything but a faith based program', 'without equine therapy']) {
    const result = matchFromAssessment({ ...base, answers: { treatmentPreferences: words } });
    assert.deepEqual(result.needs, [], words);
  }
  const mixed = matchFromAssessment({ ...base, answers: { treatmentPreferences: 'EMDR yes. No wilderness' } });
  assert.deepEqual(mixed.needs, ['EMDR']);
  for (const words of ['Non-faith based program', 'Non spiritual approach please', 'He cannot stand wilderness programs']) {
    assert.deepEqual(matchFromAssessment({ ...base, answers: { treatmentPreferences: words } }).needs, [], words);
  }
  assert.deepEqual(matchFromAssessment({ ...base, answers: { treatmentPreferences: 'Faith based but no wilderness' } }).needs, ['Faith based']);
  assert.deepEqual(matchFromAssessment({ ...base, answers: { treatmentPreferences: 'Not sure but she did well with EMDR' } }).needs, ['EMDR']);
  assert.deepEqual(matchFromAssessment({ ...base, answers: { treatmentPreferences: 'He doesn’t need EMDR and DBT' } }).needs, []);
});

check('needs come from plain answers and are never MAT', () => {
  const result = matchFromAssessment({ ...base, answers: {
    traumaHistory: 'yes',
    psychiatricHistory: 'yes',
    chronicPain: 'yes',
    priorTreatment: 'yes',
    treatmentHistory: [{ programName: 'A' }, { programName: 'B' }],
    treatmentPreferences: 'Faith-based, with EMDR and a family program',
    primarySubstances: 'Fentanyl and alcohol',
  } });
  assert.deepEqual(result.needs, ['Trauma', 'Dual diagnosis', 'Chronic pain', 'Chronic relapse', 'Faith based', 'EMDR', 'Family systems']);
  assert.ok(!result.needs.includes('MAT'));
  assert.ok(result.toCheck.some((line) => /MAT/.test(line)));
  // "suspected" trauma or one earlier program adds nothing.
  const light = matchFromAssessment({ ...base, answers: { traumaHistory: 'suspected', treatmentHistory: [{ programName: 'A' }] } });
  assert.deepEqual(light.needs, []);
});

check('every used line names the answer it came from', () => {
  const result = matchFromAssessment({ ...base, answers: { gender: 'male', traumaHistory: 'yes' } });
  assert.deepEqual(result.used, ['Men: gender Male', 'Trauma: a history of trauma']);
});

check('payment: the plan on the case wins, then the typed carrier', () => {
  const plan = matchFromAssessment({ ...base, planCarrier: 'Cigna', answers: { insuranceProvider: 'Aetna', budgetForTreatment: '20000-30000' } });
  assert.equal(plan.insurance, 'Cigna');
  const typed = matchFromAssessment({ ...base, answers: { insuranceProvider: 'BCBS of Texas PPO' } });
  assert.equal(typed.insurance, 'Blue Cross');
  const unknown = matchFromAssessment({ ...base, answers: { insuranceProvider: 'Local Mutual' } });
  assert.equal(unknown.insurance, 'Cash pay');
  assert.ok(unknown.toCheck.some((line) => /Local Mutual/.test(line)));
});

check('the family budget is for the whole stay: to check, never a monthly cap', () => {
  const cash = matchFromAssessment({ ...base, answers: { budgetForTreatment: '20000-30000' } });
  assert.equal('budget' in cash, false);
  assert.equal(cash.insurance, 'Cash pay');
  assert.ok(cash.toCheck.some((line) => /\$20,000 - \$30,000 for the whole stay/.test(line)));
  assert.ok(!matchFromAssessment({ ...base, answers: { budgetForTreatment: 'not-applicable' } }).toCheck.some((line) => /whole stay/.test(line)));
  const medicaid = matchFromAssessment({ ...base, answers: { stateMedicaid: 'yes' } });
  assert.ok(medicaid.toCheck.some((line) => /Medicaid/.test(line)));
  // An insured family whose plan the form does not list stays as it was, never Cash pay with a cap.
  const unlisted = matchFromAssessment({ ...base, answers: { insuranceProvider: 'Highmark', budgetForTreatment: '20000-30000' } });
  assert.equal(unlisted.insurance, 'Cash pay');
  assert.ok(unlisted.toCheck.some((line) => /Highmark/.test(line)));
});

check('a plan on Benefits that Match does not list is named to check', () => {
  const listed = matchFromAssessment({ ...base, planCarrier: 'Aetna', answers: {} });
  assert.ok(!listed.toCheck.some((line) => /plan on Benefits/.test(line)));
  const near = matchFromAssessment({ ...base, planCarrier: 'BCBS of Texas', answers: {} });
  assert.equal(near.insurance, 'BCBS of Texas');
  assert.ok(near.toCheck.some((line) => /choose Blue Cross if that is the plan/.test(line)));
  const far = matchFromAssessment({ ...base, planCarrier: 'Local Mutual', answers: {} });
  assert.ok(far.toCheck.some((line) => /choose the closest plan/.test(line)));
});

check('carrierFromText prefers the form’s own longest name, then common spellings', () => {
  const options = insuranceProvidersForState('OH');
  assert.equal(carrierFromText('Aetna Better Health of Ohio', options), 'Aetna Better Health of Ohio');
  assert.equal(carrierFromText('aetna', options), 'Aetna');
  assert.equal(carrierFromText('UHC choice plus', options), 'UnitedHealthcare');
  assert.equal(carrierFromText('', options), null);
  assert.equal(carrierFromText('Cash pay', options), null);
});

check('the level is only the rated one', () => {
  const rated = matchFromAssessment({ ...base, ratedLevel: 'Inpatient', answers: {} });
  assert.equal(rated.levelOfCare, 'Inpatient');
  assert.ok(rated.used.some((line) => /level-of-care rating/.test(line)));
  const seizures = matchFromAssessment({ ...base, answers: { seizureHistory: 'yes' } });
  assert.equal(seizures.levelOfCare, null);
  assert.ok(seizures.toCheck.some((line) => /detox/.test(line)));
});

check('the app wires it to the finished assessment and the Match form', () => {
  const app = read('App.tsx');
  assert.match(app, /onMatch=\{\(answers\) => startMatchFromAssessment\(record, answers\)\}/);
  assert.match(app, /function startMatchFromAssessment\(record: CaseRecord, answers: Answers\)/);
  assert.match(app, /setMatchFromAnswers\(null\);/);
  const sheet = read('src/lib/FamilyAssessmentSheet.tsx');
  assert.match(sheet, /See matches from these answers/);
});

console.log(`assessment-match: ${checks} checks passed`);
