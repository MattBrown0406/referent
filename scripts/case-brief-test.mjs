// The case brief for programs (src/lib/case-brief.ts, docs/FAMILY_ASSESSMENT.md
// "Case brief for programs"): built from the assessment's choices only, so it
// never carries names, contact details, dates, numbers or the family's own
// words. Run with: node scripts/case-brief-test.mjs

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'case-brief-test');
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

transpileTo('src/lib/assessment-schema.ts', 'lib/assessment-schema.js');
transpileTo('src/lib/identifying-text.ts', 'lib/identifying-text.js');
transpileTo('src/lib/case-brief.ts', 'lib/case-brief.js');
const { caseBriefLines, caseBriefText, shareBriefProblem, assessmentNames, BRIEF_HEADER } = require(path.join(tmpDir, 'lib/case-brief.js'));

let checks = 0;
const check = (name, fn) => { try { fn(); checks += 1; } catch (error) { console.error(`FAILED: ${name}`); throw error; } };

const full = {
  contactName: 'Dana Whitfield', contactEmail: 'dana@example.com', contactPhone: '503-555-0100',
  fullName: 'Eli Whitfield', age: '27', dateOfBirth: '1999-04-02', gender: 'male', veteranStatus: 'yes',
  insuranceProvider: 'Aetna PPO', insurancePolicyNumber: 'W123456789', insuranceGroupNumber: 'G-555', budgetForTreatment: '20000-30000',
  primarySubstances: 'Fentanyl, he buys from Mike on 5th street',
  substancesUsed: [
    { substance: 'Fentanyl', frequency: 'daily-multiple', routeOfAdministration: 'Smoking', currentlyUsing: true, lastUsed: 'Today' },
    { substance: 'Alcohol', frequency: 'weekly', routeOfAdministration: 'Oral (swallowing)' },
    { substance: 'Other' },
  ],
  polysubstanceUse: 'yes', ivDrugUse: 'past', overdoseHistory: 'yes', naloxoneReversals: 3, overdoseDetails: 'At the Shell station on Main',
  durationOfUse: '5-10-years', longestSobrietyPeriod: 'months',
  physicalWithdrawalSymptoms: ['Sweating', 'Tremors/shaking'], seizureHistory: 'no', hospitalizedDetox: 'yes',
  healthIssues: 'yes', healthIssuesList: 'Hep C, treated at St. Vincent', chronicPain: 'no', prescribedMedications: 'yes',
  mentalHealthSigns: 'yes', psychiatricHistory: 'yes', psychiatricDetails: 'Bipolar, Providence 2021', traumaHistory: 'suspected',
  suicideIdeation: 'no', suicideAttemptsHistory: 'yes',
  stageOfChange: 'contemplation', acknowledgesProblem: 'partial', willingnessToChange: '6',
  priorTreatment: 'yes', treatmentHistory: [
    { programName: 'Hazelden', programType: 'residential', successfulCompletion: true },
    { programName: 'Serenity Detox', programType: 'detox' },
  ],
  stableLiving: 'yes', peopleUsingInHome: 'no', supportNetwork: 'weak', legalIssues: 'yes', legalIssuesDetails: 'DUI court 12/3',
  familyMembersParticipating: [{ name: 'Rosa Whitfield', relationship: 'Grandmother' }],
  treatmentPreferences: 'Near Portland, men only', urgencyLevel: 'urgent', additionalInformation: 'Call Dana after 5',
};

check('nothing to say: no brief', () => {
  assert.deepEqual(caseBriefLines({ answers: {} }), []);
  assert.equal(caseBriefText({ answers: {} }), '');
});

check('a full assessment reads as a short brief, in order', () => {
  const text = caseBriefText({ answers: full, planCarrier: 'Aetna', rated: { chosenLevel: 'Inpatient', recommended: 'Inpatient' } });
  const lines = text.split('\n');
  assert.equal(lines[0], BRIEF_HEADER);
  const labels = lines.filter((line) => line.startsWith('- ')).map((line) => line.slice(2).split(':')[0]);
  assert.deepEqual(labels, ['Client', 'Substances', 'Use', 'Withdrawal', 'Medical', 'Mental health', 'Safety', 'Readiness', 'Earlier treatment', 'Home', 'Payment', 'Level of care', 'Urgency']);
  assert.match(text, /- Client: age 27; male; veteran/);
  assert.match(text, /- Substances: Fentanyl \(multiple\/day, smoking, current\); Alcohol \(weekly, oral\)/);
  assert.match(text, /IV use in the past; has overdosed before/);
  assert.match(text, /- Earlier treatment: 2 programs \(residential, detox\); 1 completed/);
  assert.match(text, /- Payment: insurance: Aetna/);
  assert.match(text, /- Level of care: Inpatient \(rated by the practitioner; recommended: Inpatient\)/);
  assert.match(text, /- Urgency: Urgent/);
});

check('it never carries what identifies anyone', () => {
  const text = caseBriefText({ answers: full, planCarrier: 'Aetna' });
  for (const word of ['Dana', 'Eli', 'Whitfield', 'Rosa', 'Mike', 'example.com', '555', '1999', 'W123456789', 'G-555', 'Hazelden', 'Serenity', 'Shell', 'St. Vincent', 'Providence', 'Portland', '$', '20,000', '30000', 'Today', '12/3']) {
    assert.ok(!text.includes(word), `the brief must not contain ${word}`);
  }
  // And the shared rules agree: nothing in it is refused.
  assert.equal(shareBriefProblem(text, assessmentNames(full)), null);
});

check('payment without a plan: no numbers, never the budget', () => {
  assert.match(caseBriefText({ answers: { insuranceProvider: 'Aetna PPO' } }), /- Payment: insurance \(plan to confirm\)/);
  assert.match(caseBriefText({ answers: { stateMedicaid: 'yes' } }), /- Payment: State Medicaid/);
  const cash = caseBriefText({ answers: { budgetForTreatment: '20000-30000' } });
  assert.match(cash, /- Payment: self-pay/);
  assert.ok(!/\d/.test(cash.split('\n').find((line) => line.startsWith('- Payment'))));
});

check('ages over 89 are grouped; safety answers are named plainly', () => {
  assert.match(caseBriefText({ answers: { age: 93 } }), /age 90 or older/);
  const safety = caseBriefText({ answers: { suicideIdeation: 'yes', homicidalIdeation: 'yes', violenceHistory: 'yes' } });
  assert.match(safety, /- Safety: current suicidal thoughts reported; homicidal thoughts or threats reported; history of violence or aggression/);
});

check('an edited brief is checked line by line against the case names', () => {
  const base = caseBriefText({ answers: { age: 27, gender: 'male' } });
  assert.equal(shareBriefProblem(base, ['Whitfield intervention']), null);
  assert.match(shareBriefProblem(`${base}\nMom Dana is the contact`, ['Dana Whitfield']), /names/);
  assert.match(shareBriefProblem(`${base}\nCall 503-555-0100`, []), /phone/);
  assert.match(shareBriefProblem(`${base}\nEmail dana@example.com`, []), /email/);
});

check('assessmentNames lists the family’s typed names', () => {
  assert.deepEqual(assessmentNames(full), ['Eli Whitfield', 'Dana Whitfield', 'Rosa Whitfield']);
  assert.deepEqual(assessmentNames({}), []);
});

check('the app offers it on the finished assessment and in the program’s packet', () => {
  const sheet = read('src/lib/FamilyAssessmentSheet.tsx');
  assert.match(sheet, /Case brief for programs/);
  assert.match(sheet, /shareBriefProblem\(body,/);
  const app = read('App.tsx');
  assert.match(app, /async function addCaseBriefToPacket\(\)/);
  assert.match(app, /packetAudience === 'partner' && packetTarget\.match\.caseId/);
});

console.log(`case-brief: ${checks} checks passed`);
