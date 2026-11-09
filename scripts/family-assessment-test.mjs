// The family assessment (docs/FAMILY_ASSESSMENT.md): the shared question
// schema and its rules, the family page's link rules, the practitioner's
// side, the identity-free answers sent for an AI suggestion, and the wiring
// that keeps the copies and the database in step.
// Run with: node scripts/family-assessment-test.mjs

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'family-assessment-test');
const require = createRequire(import.meta.url);
const ts = require(path.join(repoRoot, 'node_modules', 'typescript'));
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

function load(relSrc, outName) {
  const js = ts.transpileModule(read(relSrc), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const outPath = path.join(tmpDir, outName);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, js);
  return require(outPath);
}

let checks = 0;
const check = (fn, label) => {
  try { fn(); } catch (error) { console.error(`FAIL ${label || ''}`); throw error; }
  checks += 1;
};

const schema = load('src/lib/assessment-schema.ts', 'app/assessment-schema.js');
const app = load('src/lib/family-assessment.ts', 'app/family-assessment.js');
load('portal/src/assessment-schema.ts', 'portal/assessment-schema.js');
const link = load('portal/src/assessment-link-rules.ts', 'portal/assessment-link-rules.js');

// ─── One question list, two copies ─────────────────────────────────────────
check(() => assert.equal(read('portal/src/assessment-schema.ts'), read('src/lib/assessment-schema.ts')), 'the portal and app copies are identical');

// ─── The questions ─────────────────────────────────────────────────────────
const { SECTIONS } = schema;
check(() => {
  assert.equal(SECTIONS.length, 12, 'twelve sections, as the form it is modeled on');
  assert.deepEqual(SECTIONS.map((section) => section.id), ['contact', 'demographics', 'substance_history', 'dsm', 'medical_withdrawal', 'mental_health',
    'readiness', 'relapse_treatment', 'recovery_environment', 'family_system', 'family_history', 'consequences_planning']);
  const ids = SECTIONS.flatMap((section) => section.fields.map((field) => field.id));
  assert.equal(new Set(ids).size, ids.length, 'field ids are unique');
  assert.ok(!ids.includes('familySignature'), 'the signature is the consent step, not a field');
}, 'sections');
check(() => {
  const required = SECTIONS.flatMap((section) => section.fields.filter((field) => field.required).map((field) => field.id));
  assert.deepEqual(required, ['contactName', 'contactRelationship', 'contactEmail', 'contactPhone', 'fullName', 'age', 'primarySubstances']);
}, 'the few required questions');
check(() => {
  const dsm = SECTIONS.find((section) => section.id === 'dsm').fields[0];
  assert.equal(dsm.criteria.length, 11);
  assert.deepEqual(schema.DSM_IDS.length, 11);
}, 'the eleven DSM-5 criteria');
check(() => {
  for (const section of SECTIONS) {
    for (const field of section.fields) {
      if (field.kind === 'choice' && field.values) assert.equal(field.values.length, field.options.length, field.id);
      if (field.showIf) assert.ok(SECTIONS.some((s) => s.fields.some((f) => f.id === field.showIf.field)), `${field.id} shows on a real field`);
    }
  }
}, 'choices and conditions are well formed');
check(() => {
  const visible = JSON.stringify(SECTIONS) + JSON.stringify(Object.values(schema.NOTES).map((note) => (typeof note === 'function' ? note('P') : note)));
  assert.doesNotMatch(visible, /\bMatt\b|Freedom Interventions|\bI'm recommending\b/, 'written for any practice');
  assert.doesNotMatch(visible, /ASAM/, 'never the licensed name, as everywhere in the app');
  assert.match(schema.NOTES.mentalHealthWarning, /call or text 988/);
  assert.match(schema.CRISIS_TEXT, /call 911 now[^]*988/);
  assert.match(schema.CRISIS_SHORT, /911[^]*988/);
}, 'any practice, with 911 and 988');

// ─── Rules ─────────────────────────────────────────────────────────────────
const field = (id) => SECTIONS.flatMap((section) => section.fields).find((item) => item.id === id);
check(() => {
  assert.equal(schema.fieldVisible(field('overdoseDetails'), {}), false);
  assert.equal(schema.fieldVisible(field('overdoseDetails'), { overdoseHistory: 'yes' }), true);
  assert.equal(schema.fieldVisible(field('enablingDetails'), { familyEnabling: 'some' }), true, 'either of two answers');
  assert.equal(schema.fieldVisible(field('enablingDetails'), { familyEnabling: 'no' }), false);
}, 'conditions');
check(() => {
  const contact = SECTIONS[0];
  assert.match(schema.sectionProblem(contact, {}), /^Please answer: Your Full Name, Relationship to Individual, Email Address, Phone Number\.$/);
  const filled = { contactName: 'Lena', contactRelationship: 'parent', contactEmail: 'lena@', contactPhone: '503' };
  assert.equal(schema.sectionProblem(contact, filled), 'Please check the email address.');
  assert.equal(schema.sectionProblem(contact, { ...filled, contactEmail: 'lena@example.com' }), '');
  assert.equal(schema.sectionProblem(SECTIONS[6], {}), '', 'most sections need nothing');
}, 'moving on');
check(() => {
  assert.equal(schema.dsmCount({ dsmBehaviors: { tolerance: true, withdrawal: true, cravings: false, made_up: true } }), 2);
  assert.equal(schema.dsmCount({ dsmBehaviors: 'x' }), 0);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 11].map(schema.dsmSeverity), ['none', 'none', 'mild', 'mild', 'moderate', 'moderate', 'severe', 'severe']);
}, 'DSM-5 count and severity');
check(() => {
  assert.deepEqual(schema.safetyFlags({}), []);
  assert.deepEqual(schema.safetyFlags({ suicideIdeation: 'yes', homicidalIdeation: 'yes', urgencyLevel: 'crisis', immediateSafetyConcerns: 'He has a gun.' }),
    ['suicidal_thoughts', 'homicidal_thoughts', 'crisis', 'safety_concern']);
  for (const none of ['None.', 'n/a', 'N/A!', 'no concerns', 'none at this time', '---', '  ', '\n None.', 'None that I\'m aware of', 'No concerns at this time!', 'none\nat this time', 'Not\u00a0right now']) {
    assert.deepEqual(schema.safetyFlags({ immediateSafetyConcerns: none }), [], `"${none}" is not a concern`);
  }
  assert.deepEqual(schema.safetyFlags({ suicideIdeation: 'unknown', urgencyLevel: 'urgent' }), []);
  assert.equal(schema.withdrawalWarning({ deliriumTremensHistory: 'yes' }), true);
  assert.equal(schema.withdrawalWarning({ seizureHistory: 'no' }), false);
}, 'safety flags');
check(() => {
  const sql = read('supabase/migrations/20261109140000_family_assessment.sql');
  const ts = read('src/lib/assessment-schema.ts');
  const words = /const NO_CONCERN = \/(.+)\/;/.exec(ts)[1].replaceAll('\\/', '/');
  assert.ok(sql.includes(`!~ '${words}'`), 'the database uses the same "no concern" words');
  assert.ok(sql.includes(`'[[:space:]]+', ' ', 'g'), '[^a-z0-9/ -]+', '', 'g'), ' +', ' ', 'g')`), 'and compares them the same way (normalizeConcern)');
  assert.match(ts, /replace\(\/\\s\+\/g, ' '\)\.replace\(\/\[\^a-z0-9\/ -\]\+\/g, ''\)\.replace\(\/ \+\/g, ' '\)/);
  for (const [key, flag] of [['suicideIdeation', 'suicidal_thoughts'], ['homicidalIdeation', 'homicidal_thoughts'], ['urgencyLevel', 'crisis']]) {
    assert.match(sql, new RegExp(`p_answers ->> '${key}'[^]*?THEN '${flag}'`), `${flag} in the database`);
  }
}, 'the database flags danger the same way');
check(() => {
  const answers = {
    contactRelationship: 'spouse', overdoseHistory: 'yes', naloxoneReversals: '2', currentMentalHealthSymptoms: ['Anxiety/panic attacks', 'Memory problems'],
    substancesUsed: [{ substance: 'Fentanyl', frequency: 'daily-multiple', currentlyUsing: true }, {}],
    dsmBehaviors: { tolerance: true },
  };
  assert.deepEqual(schema.sectionAnswerLines(SECTIONS[0], answers), [{ label: 'Relationship to Individual', value: 'Spouse/Partner' }]);
  const substance = schema.sectionAnswerLines(SECTIONS[2], answers);
  assert.deepEqual(substance.find((line) => line.label === 'Detailed Substance History'), { label: 'Detailed Substance History', value: '1) Substance: Fentanyl; Frequency: Multiple/day; Current: Yes' });
  assert.deepEqual(substance.find((line) => line.label === 'History of Overdose?'), { label: 'History of Overdose?', value: 'Yes' });
  assert.ok(substance.some((line) => line.label === '# of Narcan/Naloxone Reversals'));
  assert.deepEqual(schema.sectionAnswerLines(SECTIONS[3], answers), [{ label: 'DSM-5 Substance Use Disorder Criteria', value: '10. Tolerance (needing more for same effect)' }]);
  assert.equal(schema.sectionAnswerLines(SECTIONS[5], answers)[0].value, 'Anxiety/panic attacks, Memory problems');
}, 'answers read back in words');

// ─── The family page's link ────────────────────────────────────────────────
const TOKEN = 'ab'.repeat(32);
check(() => {
  assert.equal(link.assessmentTokenFrom(`#${TOKEN.toUpperCase()}`), TOKEN);
  assert.equal(link.assessmentTokenFrom(`#${TOKEN.slice(2)}`), null);
  assert.equal(link.assessmentTokenFrom(''), null);
}, 'the token in the link');
check(() => {
  const open = link.assessmentViewFromJson({
    status: 'open', practice_name: 'Bend Family Interventions', logo_path: '11111111-1111-1111-1111-111111111111/logo-1731000000000.png',
    recipient_name: 'Lena', answers: { contactName: 'Lena' }, step: 3, card_front: true, card_back: false,
    consent_version: '2026-11-08', consent_text: 'I agree', expires_at: '2026-12-08T00:00:00Z', last_saved_at: null,
  });
  assert.equal(open.status, 'open');
  assert.equal(open.step, 3);
  assert.equal(open.cardFront, true);
  assert.equal(link.assessmentViewFromJson({ ...open, status: 'open', consent_text: '' }), null, 'never without the consent');
  assert.equal(link.assessmentViewFromJson({ status: 'open', practice_name: 'X', logo_path: '../../x', consent_text: 'a', consent_version: 'v' }).logoPath, null);
  const sent = link.assessmentViewFromJson({ status: 'submitted', practice_name: 'X', submitted_at: '2026-11-08T00:00:00Z', answers: { secret: 1 } });
  assert.deepEqual(Object.keys(sent).sort(), ['logoPath', 'practiceName', 'status', 'submittedAt'], 'a sent assessment carries no answers');
  assert.equal(link.assessmentViewFromJson(null), null);
  assert.equal(link.assessmentViewFromJson({ status: 'weird' }), null);
}, 'what the server sends back');
check(() => {
  assert.equal(link.photoProblem({ type: 'image/jpeg', size: 1000 }), '');
  assert.match(link.photoProblem({ type: 'application/pdf', size: 1000 }), /photo/);
  assert.match(link.photoProblem({ type: 'image/png', size: 11 * 1024 * 1024 }), /10 MB/);
  assert.equal(link.savedLine('saving', null), 'Saving…');
  assert.match(link.savedLine('failed', null), /Not saved yet/);
  assert.equal(link.photoContentType({ type: '', name: 'IMG_0001.HEIC' }), 'image/heic', 'a HEIC photo some browsers give no type');
  assert.equal(link.photoContentType({ type: 'image/heif' }), 'image/heif');
  assert.equal(link.photoContentType({ type: 'image/gif' }), '');
}, 'photos and saving');
check(() => {
  assert.equal(link.saveOutcome(null), 'saved');
  assert.equal(link.saveOutcome({ code: 'RFA02' }), 'changed_elsewhere');
  assert.equal(link.saveOutcome({ code: 'RFA01' }), 'already_sent');
  assert.equal(link.saveOutcome({ code: '22023' }), 'too_long', 'too long is not "already sent": the page stays open');
  assert.equal(link.saveOutcome({ code: 'P0002' }), 'link_stopped');
  assert.equal(link.saveOutcome({ code: 'PGRST301' }), 'retry');
  const sql = read('supabase/migrations/20261109140000_family_assessment.sql');
  assert.match(sql, /ERRCODE = 'RFA01'/);
  assert.match(sql, /ERRCODE = 'RFA02'/);
  assert.equal(link.sameAnswers({ a: 1, b: [{ x: 'y' }] }, { b: [{ x: 'y' }], a: 1 }), true, 'key order does not matter');
  assert.equal(link.sameAnswers({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(link.sameAnswers({ a: [1, 2] }, { a: [2, 1] }), false);
  assert.equal(link.assessmentViewFromJson({ status: 'open', practice_name: 'X', consent_text: 'a', consent_version: 'v', revision: 7 }).revision, 7);
}, 'saving with a revision');

// ─── The practitioner's side ───────────────────────────────────────────────
const row = {
  id: 'a1', case_id: 'c1', status: 'submitted', recipient_name: 'Lena Ortiz', recipient_email: 'lena@example.com',
  answers: {
    contactName: 'Lena Ortiz', contactEmail: 'lena@example.com', contactPhone: '503-555-0166', contactRelationship: 'parent',
    fullName: 'Marco Ortiz', dateOfBirth: '2002-04-01', insurancePolicyNumber: 'XYZ123456789', age: '24',
    primarySubstances: 'Fentanyl', seizureHistory: 'yes', suicideIdeation: 'yes', acknowledgesProblem: 'full-denial',
    familyMembersParticipating: [{ name: 'Rosa Ortiz', relationship: 'Aunt', willingToParticipate: true }],
    treatmentHistory: [{ programName: 'Cedar House', programType: 'detox' }], priorTreatment: 'yes',
    dsmBehaviors: { tolerance: true, withdrawal: true, cravings: true, time_spent: true, larger_amounts: true, desire_cut_down: true },
  },
  step: 12, card_front_at: '2026-11-08T01:00:00Z', card_back_at: null, urgent: ['suicidal_thoughts', 'made_up'],
  card_front_path: `${'1'.repeat(8)}-1111-1111-1111-${'1'.repeat(12)}/${'2'.repeat(8)}-2222-2222-2222-${'2'.repeat(12)}/card-front-${'a'.repeat(32)}`,
  card_back_path: '../../somewhere-else',
  consent_name: 'Lena Ortiz', consent_version: '2026-11-08', consent_text: 'I agree', consent_at: '2026-11-08T02:00:00Z',
  created_at: '2026-11-07T00:00:00Z', submitted_at: '2026-11-08T18:00:00Z', expires_at: '2026-12-07T00:00:00Z',
};
check(() => {
  const assessment = app.assessmentFromRow(row);
  assert.equal(assessment.cardFront, true);
  assert.equal(assessment.cardBack, false, 'a card path that is not one the upload function makes is ignored');
  assert.equal(assessment.cardBackPath, '');
  assert.deepEqual(assessment.urgent, ['suicidal_thoughts'], 'unknown flags are dropped');
  assert.equal(app.assessmentFromRow({ ...row, status: 'weird' }), null);
  assert.match(app.statusLine(assessment), /^Finished Nov 8 · needs attention today$/);
  assert.equal(app.isOpen(assessment), false);
}, 'reading a row');
check(() => {
  const now = new Date('2026-11-10T00:00:00Z');
  const sent = app.assessmentFromRow({ ...row, status: 'sent', urgent: [], emailed_at: '2026-11-08T00:00:00Z', expires_at: '2026-12-08T00:00:00Z' });
  assert.match(app.statusLine(sent, now), /^Sent to Lena Ortiz Nov \d+ · not started yet$/);
  const started = { ...sent, status: 'started', step: 5, lastSavedAt: '2026-11-09T00:00:00Z' };
  assert.match(app.statusLine(started, now), /^In progress to Lena Ortiz · section 5 of 12 · saved Nov \d+ · needs attention today$/,
    'danger in answers saved so far shows before the family finishes');
  assert.match(app.statusLine({ ...started, answers: { suicideIdeation: 'no' } }, now), /saved Nov \d+$/);
  assert.match(app.statusLine({ ...sent, expiresAt: '2026-11-09T00:00:00Z' }, now), /^The link expired Nov \d+\. Send a new one\.$/);
  assert.equal(app.currentAssessment([sent, { ...sent, id: 'newer', createdAt: '2026-11-09T00:00:00Z' }]).id, 'newer');
}, 'where it stands');
check(() => {
  const assessment = app.assessmentFromRow(row);
  const alerts = app.assessmentAlerts(assessment);
  assert.deepEqual(alerts.map((alert) => alert.severity), ['urgent', 'medical']);
  assert.match(app.dsmLine(assessment.answers), /^6 of 11 DSM-5 criteria checked by the family: Severe\. Not a diagnosis\.$/);
  assert.match(app.linkMessage('Bend Family Interventions', 'https://portal.referralfit.com/f#x'), /^Bend Family Interventions would like you[^]*private link: https:\/\/portal\.referralfit\.com\/f#x\n[^]*988/);
  assert.equal(app.assessmentLink(TOKEN), `https://portal.referralfit.com/f#${TOKEN}`);
}, 'alerts and messages');
check(() => {
  const all = new Set(SECTIONS.flatMap((section) => section.fields.map((field) => field.id)));
  for (const [key, ids] of Object.entries(app.DIMENSION_FIELDS)) {
    for (const id of ids) assert.ok(all.has(id), `${key}: ${id} is a question`);
  }
  const hints = app.dimensionHints(row.answers);
  assert.ok(hints.withdrawal.includes('History of seizures during withdrawal?: Yes'));
  assert.ok(hints.readiness.includes('Does your loved one acknowledge they have a problem?: Complete denial'));
  assert.ok(hints.relapse.some((line) => /DSM-5/.test(line)));
  assert.deepEqual(Object.keys(hints), ['withdrawal', 'physical', 'emotional', 'readiness', 'relapse', 'environment']);
}, 'the family\'s answers under each level-of-care area');
check(() => {
  const facts = JSON.stringify(app.levelOfCareFacts(row.answers));
  for (const secret of ['Lena Ortiz', 'lena@example.com', '503-555-0166', 'Marco Ortiz', '2002-04-01', 'XYZ123456789', 'Rosa Ortiz', 'Cedar House']) {
    assert.ok(!facts.includes(secret), `${secret} is not sent`);
  }
  assert.match(facts, /Primary Substance\(s\) of Concern: Fentanyl/);
  assert.match(facts, /Relationship to Individual: Parent/, 'who is asking, not who they are');
  assert.match(facts, /Relationship: Aunt/);
  assert.match(facts, /Age: 24/);
}, 'the AI suggestion never gets who anyone is');

// ─── The level-of-care scale on the server matches the app ──────────────────
check(() => {
  const server = read('supabase/functions/ai-assist/level.ts');
  const appScale = read('src/lib/level-of-care.ts');
  const descriptors = [...appScale.matchAll(/descriptor: '([^']+)'/g)].map((match) => match[1]);
  assert.equal(descriptors.length, 30);
  for (const text of descriptors) assert.ok(server.includes(JSON.stringify(text)), `server scale: ${text.slice(0, 40)}`);
}, 'the AI rates on the app\'s own words');

// ─── Wiring ────────────────────────────────────────────────────────────────
const appTsx = read('App.tsx');
const sheet = read('src/lib/FamilyAssessmentSheet.tsx');
const page = read('portal/src/FamilyAssessment.tsx');
const upload = read('supabase/functions/family-assessment-upload/index.ts');
check(() => {
  assert.match(appTsx, /if \(familyAssessmentCaseId === activeCase\.id\) return FamilyAssessmentModal\(activeCase\);/);
  assert.ok(appTsx.indexOf('if (assessmentCaseId === activeCase.id) return LevelOfCareModal') < appTsx.indexOf('if (familyAssessmentCaseId === activeCase.id)'),
    'the level-of-care sheet opens over the assessment, and closing it comes back');
  assert.match(appTsx, /seed=\{levelOfCareSeed\}/);
  assert.ok((appTsx.match(/setFamilyAssessmentCaseId\(null\);\n\s+setLevelOfCareSeed\(null\);/g) || []).length >= 3, 'cleared on sign-out, when a case opens and when it closes');
}, 'the case file');
check(() => {
  assert.match(sheet, /requestLevelSuggestion\(levelOfCareFacts\(assessment\.answers\), key\)/, 'only identity-free answers go to the AI');
  assert.match(sheet, /'Suggest ratings with AI\?'/, 'and only after the practitioner agrees');
  assert.match(sheet, /This cannot be undone/, 'deleting asks first');
  for (const file of ['src/lib/FamilyAssessmentSheet.tsx', 'src/lib/family-assessment.ts', 'portal/src/FamilyAssessment.tsx', 'supabase/functions/ai-assist/level.ts']) {
    assert.doesNotMatch(read(file), /ASAM/, `${file} never uses the licensed name`);
  }
}, 'the assessment sheet');
check(() => {
  assert.match(read('portal/src/main.tsx'), /isFamilyAssessment \? <FamilyAssessment \/>/);
  assert.match(page, /window\.history\.replaceState\(null, '', window\.location\.pathname\)/, 'the token leaves the address bar');
  assert.match(page, /\{flags\.length \? <CrisisLine urgent \/> : null\}/, '911 and 988 the moment an answer suggests danger');
  assert.match(page, /href="tel:911"[^]*href="tel:988"[^]*href="sms:988"/, 'one tap to call 911, or to call or text 988');
  assert.match(page, /p_revision: revisionRef\.current/, 'every save says which revision it is from');
  assert.match(page, /keepalive: true/, 'answers are saved as the page goes away');
  assert.match(page, /pruneHidden\(answersRef\.current\)/, 'answers to hidden questions are not sent');
  assert.match(page, /withdrawalWarning\(answers\) \? <div className="fa-warning" role="alert">\{WITHDRAWAL_TEXT\}/, 'the withdrawal warning shows where it was asked');
  assert.match(page, /p_consent_version: open\.consentVersion/);
  assert.doesNotMatch(page, /localStorage/, 'answers never stay in the browser');
}, 'the family page');
check(() => {
  assert.match(upload, /createSignedUploadUrl\(uploadName\(prefix\)\)/, 'every upload gets a new name, never overwriting one');
  assert.doesNotMatch(upload, /createSignedUploadUrl\(upload\.|upsert: true/, 'the name is never the caller\'s, and nothing is replaced in place');
  assert.match(upload, /rpc\('family_assessment_photo_done', \{\s+p_token: upload\.token, p_side: upload\.side, p_path: upload\.path,/, 'the database checks the name before it is recorded');
  assert.doesNotMatch(upload, /console\.(log|error)\([^)]*(token|body|upload)\b/, 'never logs the token');
  assert.match(read('supabase/config.toml'), /\[functions\.family-assessment-upload\]\nverify_jwt = false/);
  assert.match(read('.github/workflows/quality.yml'), /supabase\/functions\/family-assessment-upload\//);
}, 'the upload function');
check(() => {
  const email = read('supabase/functions/email-dispatch/email.ts');
  assert.match(email, /'family_assessment_invite' \| 'family_assessment_submitted'/);
  assert.match(read('supabase/migrations/20261109140000_family_assessment.sql'), /'family_assessment_invite', 'family_assessment_submitted', 'family_assessment_urgent'\)\)/);
}, 'the emails');

console.log(`family-assessment-test: ${checks} checks passed`);
