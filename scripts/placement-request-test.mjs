// Placement Request: src/lib/placement-requests.ts, src/lib/placement-api.ts
// (with Supabase stubbed) and the center portal's mirror run in plain node,
// no build step (the same transpile approach as integrity-test).
//
//   (a) the payload is de-identified: the shared fixture, and nothing from a
//       label, a budget or contact details can reach it
//   (b) the app's allow-list is the migration's (needs, levels, keys, note
//       patterns, admit windows, response windows, limits)
//   (c) the note: the server's rules and words
//   (d) the text / email summary for programs that answer by hand
//   (e) the order stays ranked; the other sorts are display only
//   (f) expiry and deadlines
//   (g) the manual-answer flow: checks, who may log, merging, Today
//   (h) the API: hides on a server without the migration, OfflineError on
//       a lost connection, the server's own words otherwise, replay-safe ids
//   (i) the center portal's mirror agrees with the app
//   (j) ethics: nothing reads answers into matching; nothing identifies the
//       client; the screens follow the one-sheet rule
//   (k) the migration follows the paste rules

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'placement-request-test');
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
for (const name of ['beds', 'matching', 'integrity', 'errors', 'placement-requests']) transpileTo(`src/lib/${name}.ts`, `lib/${name}.js`);
transpileTo('portal/src/placement-rules.ts', 'portal/placement-rules.js');

// placement-api.ts with its device and network edges stubbed: a fake
// Supabase client the tests drive, an in-memory AsyncStorage, and a uuid.
writeFileSync(path.join(tmpDir, 'lib', 'supabase.js'), 'exports.supabase = globalThis.__placementSupabase;');
writeFileSync(path.join(tmpDir, 'lib', 'cases.js'), "let n = 0; exports.newUuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;");
writeFileSync(path.join(tmpDir, 'lib', 'async-storage.js'), [
  'const store = new Map();',
  'exports.default = { getItem: async (k) => (store.has(k) ? store.get(k) : null), setItem: async (k, v) => { store.set(k, v); } };',
  'exports.__esModule = true;',
].join('\n'));
transpileTo('src/lib/placement-api.ts', 'lib/placement-api.js', (js) => js.replace(/require\("@react-native-async-storage\/async-storage"\)/, 'require("./async-storage")'));

// The tests never reach the network.
globalThis.fetch = () => { throw new Error('placement-request-test: the real network must never be called'); };

const fake = { from: null, rpc: null };
globalThis.__placementSupabase = {
  from: (table) => fake.from(table),
  rpc: (name, args) => fake.rpc(name, args),
};

const rules = require(path.join(tmpDir, 'lib', 'placement-requests.js'));
const api = require(path.join(tmpDir, 'lib', 'placement-api.js'));
const errors = require(path.join(tmpDir, 'lib', 'errors.js'));
const data = require(path.join(tmpDir, 'data.js'));
const portal = require(path.join(tmpDir, 'portal', 'placement-rules.js'));

const migration = readFileSync(path.join(repoRoot, 'supabase/migrations/20261104140000_placement_requests.sql'), 'utf8');
const pgtap = readFileSync(path.join(repoRoot, 'supabase/tests/placement_requests_test.sql'), 'utf8');

let checks = 0;
function check(label, actual, expected) {
  assert.deepEqual(actual, expected, label);
  checks += 1;
}
function ok(label, value) {
  assert.ok(value, label);
  checks += 1;
}

// ─── (a) The payload is de-identified ───────────────────────────────────────

// The pgTAP test asserts this exact JSON for the same fixture on the server.
const FIXTURE_JSON = '{"level_of_care":"Inpatient","population":"Women","must_haves":["Trauma","Women only"],"needs":["MAT","EMDR"],"payment":"insurance","insurance_carrier":"Aetna","home_state":"OR","location_preference":"Close to family","admit_window":"this_week","note":"Prefers a quiet setting"}';
ok('the pgTAP test asserts the same fixture JSON', pgtap.includes(FIXTURE_JSON));

const riveraMatch = {
  id: 'f2000000-0000-0000-0000-0000000000a7',
  clientLabel: 'Rivera family',
  levelOfCare: 'Inpatient',
  state: 'or',
  insurance: 'Aetna',
  networkPreferences: ['In-network'],
  maxBudget: 48765,
  therapies: ['Trauma', 'MAT', 'Women only', 'EMDR', 'Bogus', 'Trauma'],
  mustHaveTherapies: ['Trauma'],
  population: 'Women',
  locationPreference: 'Close to family',
  status: 'Matching',
  createdAt: '2026-11-04T10:00:00Z',
  updatedAt: '2026-11-04T10:00:00Z',
  caseId: 'f1000000-0000-0000-0000-0000000000a7',
};
{
  const prepared = rules.preparePlacementRequest({ criteria: riveraMatch, admitWindow: 'this_week', note: '  Prefers a quiet setting  ', identifiers: [riveraMatch.clientLabel, 'Rivera intervention'] });
  check('the fixture builds the server\'s payload exactly', prepared.payload, JSON.parse(FIXTURE_JSON));
  check('the note is sent trimmed', prepared.note, 'Prefers a quiet setting');
  check('exactly the ten allowed keys', Object.keys(prepared.payload).sort(), [...rules.PAYLOAD_KEYS].sort());
  const text = JSON.stringify(prepared.payload).toLowerCase();
  ok('no label, case title or budget in the payload', !text.includes('rivera') && !text.includes('48765'));
}
check(
  'self-pay never carries an amount; MAT is a must-have by default; Any location is no state',
  rules.buildPlacementPayload({ levelOfCare: 'Detox', population: 'Any', therapies: ['MAT', 'CBT'], mustHaveTherapies: undefined, insurance: 'Cash pay', state: 'ANY', locationPreference: 'No preference' }, 'asap', ''),
  { level_of_care: 'Detox', population: 'Any', must_haves: ['MAT'], needs: ['CBT'], payment: 'self_pay', insurance_carrier: null, home_state: null, location_preference: 'No preference', admit_window: 'asap', note: null },
);
{
  // The same unknown-value cases as the pgTAP test.
  const odd = rules.buildPlacementPayload({ levelOfCare: 'Somewhere', population: 'Kids', therapies: ['Adolescent'], mustHaveTherapies: [], insurance: 'Aetna ID W123456789', state: 'Oregon', locationPreference: 'Downtown' }, 'flexible', '');
  check('unknown values are dropped: a carrier with an id in it is not shared',
    [odd.level_of_care, odd.population, odd.insurance_carrier, odd.payment, odd.home_state, odd.location_preference],
    ['Any type', 'Adolescent', null, 'insurance', null, 'No preference']);
  const banner = rules.buildPlacementPayload({ levelOfCare: 'Banner|Aetna', population: 'Any', therapies: ['Men only'], insurance: 'Banner|Aetna', state: 'AZ', locationPreference: '' }, 'asap', '');
  check('an older profile\'s population need sets the population; real carrier names pass', [banner.population, banner.insurance_carrier], ['Men', 'Banner|Aetna']);
}
{
  // A match stuffed with everything that must never reach a program.
  const stuffed = {
    ...riveraMatch,
    clientLabel: 'Jane Q. Rivera (DOB 1990-04-12)',
    maxBudget: 98765,
    insurance: 'Aetna member W998877665',
    therapies: ['Trauma', 'jane.rivera@example.com', '(541) 555-0199', 'Jane Rivera'],
    mustHaveTherapies: ['Jane Rivera'],
    population: 'Women; call Jane',
    state: '12 Elm St, Bend OR',
    locationPreference: 'Near 12 Elm St',
    email: 'jane.rivera@example.com',
    phone: '5415550199',
  };
  const payload = rules.buildPlacementPayload(stuffed, 'asap', '');
  const text = JSON.stringify(payload).toLowerCase();
  ok('nothing from a label, budget, member id, email, phone or address reaches the payload',
    ['jane', 'rivera', '98765', 'w998877665', 'example.com', '555', 'elm'].every((needle) => !text.includes(needle)));
  check('only allowed needs survive', [payload.must_haves, payload.needs], [[], ['Trauma']]);
}
{
  // The input type carries no label or budget: the builder cannot read them.
  const source = readFileSync(path.join(repoRoot, 'src/lib/placement-requests.ts'), 'utf8');
  const builder = source.slice(source.indexOf('export function buildPlacementPayload'), source.indexOf('export type PreparedRequest'));
  ok('the payload builder never reads the label, the budget or the case', !/clientLabel|maxBudget|caseId|networkPreferences/.test(builder));
  ok('the criteria type picks only the matching fields', /export type PayloadCriteria = Pick<ReferralMatch,\s*'levelOfCare' \| 'population' \| 'therapies' \| 'mustHaveTherapies' \| 'insurance' \| 'state' \| 'locationPreference'\s*>/.test(source));
}

// ─── (b) The app's allow-list is the migration's ────────────────────────────

{
  const allowed = /v_allowed text\[\] := ARRAY\[([^\]]+)\]/.exec(migration)[1].match(/'([^']+)'/g).map((item) => item.slice(1, -1));
  check('the needs the server allows are the app\'s needs list', allowed, data.therapyOptions);
  const levels = /IF v_level NOT IN \(([^)]+)\)/.exec(migration)[1].match(/'([^']+)'/g).map((item) => item.slice(1, -1));
  check('the levels the server allows are the app\'s', levels, data.partnerTypes);
  const keys = /payload - ARRAY\[([^\]]+)\]::text\[\]/.exec(migration)[1].match(/'([^']+)'/g).map((item) => item.slice(1, -1));
  check('the CHECK\'s keys are the app\'s payload keys', keys, [...rules.PAYLOAD_KEYS]);
  const windows = /IF v_window NOT IN \(([^)]+)\)/.exec(migration)[1].match(/'([^']+)'/g).map((item) => item.slice(1, -1));
  check('the admit windows are the app\'s', windows, rules.ADMIT_WINDOWS.map((option) => option.value));
  ok('the response windows are 4, 24 and 48 hours on both sides', /p_respond_hours NOT IN \(4, 24, 48\)/.test(migration) && rules.RESPONSE_WINDOW_HOURS.join(',') === '4,24,48');
  ok('at most 8 programs and 20 requests a day on both sides',
    migration.includes('cardinality(v_ids) > 8') && migration.includes(">= 20 THEN") && rules.MAX_RECIPIENTS === 8 && rules.MAX_REQUESTS_PER_DAY === 20);
  ok('the note patterns are the server\'s', migration.includes("p_note ~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}'")
    && migration.includes("p_note ~ '[0-9]([ ().-]*[0-9]){6,}'") && migration.includes("p_note ~* '(https?:|www[.])'"));
  for (const message of Object.values(rules.NOTE_PROBLEMS)) ok(`the note message is the server's: ${message}`, migration.includes(message.replace(/'/g, "''")));
  for (const message of Object.values(rules.ANSWER_PROBLEMS)) ok(`the answer message is the server's: ${message}`, migration.includes(message));
  for (const column of [...rules.REQUEST_COLUMNS, ...rules.RECIPIENT_COLUMNS]) {
    ok(`the app reads a column the migration makes: ${column}`, new RegExp(`\\n  ${column} +[a-z]`).test(migration));
  }
}

// ─── (c) The note ───────────────────────────────────────────────────────────

check('the note rules (the same table as the pgTAP test)', [
  rules.placementNoteProblem('Prefers a quiet setting, 30 days sober before', ['Rivera family']),
  rules.placementNoteProblem('Call mom at jane.rivera@example.com'),
  rules.placementNoteProblem('Call (541) 555-0199 after 5'),
  rules.placementNoteProblem('Born 1990-04-12'),
  rules.placementNoteProblem('See www.example.org'),
  rules.placementNoteProblem('Family can pay $30,000'),
  rules.placementNoteProblem('The rivera FAMILY prefers women staff', ['Rivera family', null]),
  rules.placementNoteProblem('a'.repeat(301)),
], [null, rules.NOTE_PROBLEMS.email, rules.NOTE_PROBLEMS.number, rules.NOTE_PROBLEMS.number, rules.NOTE_PROBLEMS.link, rules.NOTE_PROBLEMS.money, rules.NOTE_PROBLEMS.label, rules.NOTE_PROBLEMS.tooLong]);
check('a two-letter label never blocks a note', rules.placementNoteProblem('JD prefers mornings', ['JD']), null);
check('a note naming the case title is refused', 'problem' in rules.preparePlacementRequest({ criteria: riveraMatch, admitWindow: 'asap', note: 'See the Rivera intervention notes', identifiers: [riveraMatch.clientLabel, 'Rivera intervention'] }), true);
check('the admit window is required', rules.preparePlacementRequest({ criteria: riveraMatch, admitWindow: null, note: '', identifiers: [] }), { problem: 'Choose when the client could be admitted' });
ok('the note warning says what to leave out', /names/.test(rules.NOTE_WARNING) && /phone/.test(rules.NOTE_WARNING) && /money/.test(rules.NOTE_WARNING));

// ─── (d) The summary programs read, by text or email ───────────────────────

const fixturePayload = JSON.parse(FIXTURE_JSON);
check('the summary, line by line', rules.placementSummaryLines(fixturePayload), [
  { label: 'Level of care', value: 'Inpatient' },
  { label: 'Client', value: 'Adult woman' },
  { label: 'Must have', value: 'Trauma, Women only' },
  { label: 'Would like', value: 'MAT, EMDR' },
  { label: 'Payment', value: 'Aetna insurance' },
  { label: 'Location', value: 'Close to family, in Oregon' },
  { label: 'Admission', value: 'Within a week' },
  { label: 'Note from the practice', value: 'Prefers a quiet setting' },
]);
check('self-pay reads plainly, with no amount', rules.placementSummaryLines({ ...fixturePayload, payment: 'self_pay', insurance_carrier: null }).find((line) => line.label === 'Payment').value, 'Self-pay');
check('away from home names the home state', rules.locationLine({ home_state: 'OR', location_preference: 'Away from home' }), 'Away from home (the family lives in Oregon)');
{
  const message = rules.placementRequestMessage({ payload: fixturePayload, programName: 'Juniper Ridge Recovery', practiceName: 'Cascade Interventions', senderName: 'Matt Brown', respondBy: '2026-11-05T23:00:00Z' });
  ok('the text greets the program and names the practice and the sender\'s first name only', message.text.startsWith('Hi Juniper Ridge Recovery admissions, this is Matt with Cascade Interventions.') && !message.text.includes('Brown'));
  ok('the text carries every summary line', rules.placementSummaryLines(fixturePayload).every((line) => message.text.includes(`- ${line.label}: ${line.value}`)));
  ok('the text asks the four questions', /bed \(yes, no or waitlist\)/.test(message.text) && /likely accept/.test(message.text) && /earliest admit date/.test(message.text) && /daily rate or cost/.test(message.text));
  const all = `${message.text} ${message.subject} ${message.body}`.toLowerCase();
  ok('no label, budget or contact details in the text or the email', !all.includes('rivera') && !all.includes('48765') && !all.includes('@') && !/[0-9]{3}[ -)]*[0-9]{3}[ -]*[0-9]{4}/.test(all));
  ok('the email has a calm subject', message.subject === 'Placement request: do you have a bed?');
  const unnamed = rules.placementRequestMessage({ payload: fixturePayload, programName: 'Cedar House', practiceName: 'My Practice', senderName: '', respondBy: '' });
  ok('an unnamed workspace never shows as "My Practice"', !unnamed.text.includes('My Practice') && unnamed.text.includes('this is a ReferralFit practice'));
}
ok('programs read the warm opening line', rules.PROGRAM_INTRO.startsWith('A practice is looking for placement'));

// ─── (e) The order stays ranked ─────────────────────────────────────────────

function recipientRow(fields) {
  return {
    id: `r${fields.rank}`, request_id: 'q1', partner_id: `p${fields.rank}`, global_partner_id: null, channel: 'manual',
    program_name: `Program ${fields.rank}`, status: 'sent', viewed_at: null, bed_available: null, likely_accept: null,
    earliest_admit_on: null, daily_rate: null, cost_note: '', note: '', responded_at: null, entered_by_practice: false, ...fields,
  };
}
const requestRow = {
  id: 'q1', org_id: 'o1', created_by: 'u1', match_profile_id: 'm1', case_id: null, payload: JSON.parse(FIXTURE_JSON),
  respond_by: '2026-11-05T12:00:00Z', status: 'open', closed_at: null, created_at: '2026-11-04T12:00:00Z',
};
const view = rules.viewFromJson({
  request: requestRow,
  recipients: [
    recipientRow({ rank: 3, status: 'responded', bed_available: 'yes', likely_accept: 'yes', earliest_admit_on: '2026-11-06', daily_rate: 1200, responded_at: '2026-11-04T15:00:00Z' }),
    recipientRow({ rank: 1, status: 'viewed', viewed_at: '2026-11-04T13:00:00Z', channel: 'portal' }),
    recipientRow({ rank: 4, status: 'declined', bed_available: 'no', likely_accept: 'no', responded_at: '2026-11-04T14:00:00Z' }),
    recipientRow({ rank: 2, status: 'responded', bed_available: 'waitlist', likely_accept: 'maybe', earliest_admit_on: '2026-11-09', daily_rate: 650, responded_at: '2026-11-04T16:00:00Z' }),
    recipientRow({ rank: 5, status: 'responded', bed_available: 'yes', likely_accept: 'yes', responded_at: '2026-11-04T17:00:00Z' }),
  ],
});
check('the comparison reads in the practice\'s ranked order', view.recipients.map((item) => item.rank), [1, 2, 3, 4, 5]);
{
  const before = view.recipients.map((item) => item.rank);
  check('by earliest admit: dated answers first, then undated, then waiting, then declined', rules.sortRecipients(view.recipients, 'admit').map((item) => item.rank), [3, 2, 5, 1, 4]);
  check('by daily rate: lowest first, unknown after, waiting, declined', rules.sortRecipients(view.recipients, 'cost').map((item) => item.rank), [2, 3, 5, 1, 4]);
  check('ranked is ranked whatever the answers', rules.sortRecipients(rules.sortRecipients(view.recipients, 'cost'), 'ranked').map((item) => item.rank), [1, 2, 3, 4, 5]);
  check('sorting never reorders the list it was given', view.recipients.map((item) => item.rank), before);
}
{
  // Answering never moves a program: the best answer at rank 5 stays 5th.
  const better = rules.withRecipient(view, { ...view.recipients[0], status: 'responded', bedAvailable: 'yes', likelyAccept: 'yes', respondedAt: '2026-11-04T18:00:00Z' });
  check('an answer never changes a program\'s place', better.recipients.map((item) => `${item.rank}:${item.id}`), view.recipients.map((item) => `${item.rank}:${item.id}`));
}

// ─── (f) Expiry and deadlines ───────────────────────────────────────────────

{
  const before = new Date('2026-11-05T11:59:00Z');
  const after = new Date('2026-11-05T12:01:00Z');
  check('expired is computed from the deadline (the same table as the pgTAP test)', [
    rules.effectiveRecipientStatus('sent', requestRow.respond_by, after),
    rules.effectiveRecipientStatus('viewed', requestRow.respond_by, after),
    rules.effectiveRecipientStatus('viewed', requestRow.respond_by, before),
    rules.effectiveRecipientStatus('responded', requestRow.respond_by, after),
    rules.effectiveRecipientStatus('declined', requestRow.respond_by, after),
  ], ['expired', 'expired', 'viewed', 'responded', 'declined']);
  check('programs answer until the deadline', [rules.acceptingAnswers(view.request, before), rules.acceptingAnswers(view.request, after)], [true, false]);
  check('a closed request takes no answers, whatever the time', rules.acceptingAnswers({ ...view.request, status: 'closed' }, before), false);
  check('time left', [
    rules.timeLeftLabel(requestRow.respond_by, new Date('2026-11-05T11:15:00Z')),
    rules.timeLeftLabel(requestRow.respond_by, new Date('2026-11-04T18:00:00Z')),
    rules.timeLeftLabel(requestRow.respond_by, after),
  ], ['45 min left', '18 h left', 'Deadline passed']);
  check('progress counts answers and declines', rules.requestProgress(view, before), { answered: 4, total: 5, accepting: true, label: '4 of 5 programs answered' });
  check('the status line after the deadline', rules.requestStatusLine(view, after), 'Deadline passed');
  check('a cancelled request says so', rules.requestStatusLine({ ...view, request: { ...view.request, status: 'cancelled' } }, before), 'Cancelled');
}

// ─── (g) The manual-answer flow ─────────────────────────────────────────────

{
  const sentOn = rules.sentOnStamp(view.request);
  check('the day sent is the server\'s (UTC)', sentOn, '2026-11-04');
  const draft = { ...rules.emptyAnswerDraft() };
  check('a bed answer first', rules.normalizeAnswerDraft(draft, sentOn), { problem: rules.ANSWER_PROBLEMS.bed });
  check('then likely to accept', rules.normalizeAnswerDraft({ ...draft, bed: 'yes' }, sentOn), { problem: rules.ANSWER_PROBLEMS.likely });
  check('an admit date within the year', rules.normalizeAnswerDraft({ ...draft, bed: 'yes', likely: 'yes', admitOn: '2028-01-01' }, sentOn), { problem: rules.ANSWER_PROBLEMS.admitOn });
  check('a real date', rules.normalizeAnswerDraft({ ...draft, bed: 'yes', likely: 'yes', admitOn: '2026-02-30' }, sentOn), { problem: rules.ANSWER_PROBLEMS.admitOn });
  check('a daily rate in whole dollars', rules.normalizeAnswerDraft({ ...draft, bed: 'yes', likely: 'yes', dailyRate: '95.50' }, sentOn), { problem: rules.ANSWER_PROBLEMS.dailyRate });
  check('the cost note fits', rules.normalizeAnswerDraft({ ...draft, bed: 'yes', likely: 'yes', costNote: 'x'.repeat(201) }, sentOn), { problem: rules.ANSWER_PROBLEMS.costNote });
  check('a phone answer, normalized', rules.normalizeAnswerDraft({ bed: 'waitlist', likely: 'maybe', admitOn: '11/9/2026', dailyRate: '$1,050', costNote: ' Most PPOs ', note: ' Spoke with intake ' }, sentOn),
    { fields: { bedAvailable: 'waitlist', likelyAccept: 'maybe', earliestAdmitOn: '2026-11-09', dailyRate: 1050, costNote: 'Most PPOs', note: 'Spoke with intake' } });

  const portalAnswered = { respondedAt: '2026-11-04T15:00:00Z', enteredByPractice: false };
  check('who may log by hand (the server\'s rule)', [
    rules.canLogAnswer({ status: 'open' }, { respondedAt: null, enteredByPractice: false }),
    rules.canLogAnswer({ status: 'closed' }, { respondedAt: null, enteredByPractice: false }),
    rules.canLogAnswer({ status: 'cancelled' }, { respondedAt: null, enteredByPractice: false }),
    rules.canLogAnswer({ status: 'open' }, portalAnswered),
    rules.canLogAnswer({ status: 'open' }, { respondedAt: '2026-11-04T15:00:00Z', enteredByPractice: true }),
  ], [true, true, false, false, true]);

  // The server answers the log with the program's row: it merges in place.
  const logged = rules.recipientFromRow(recipientRow({ rank: 1, status: 'responded', bed_available: 'waitlist', likely_accept: 'maybe', earliest_admit_on: '2026-11-09', daily_rate: 1050, responded_at: '2026-11-04T19:00:00Z', entered_by_practice: true }));
  const merged = rules.withRecipient(view, logged);
  check('the logged answer lands on its row, in place', merged.recipients.map((item) => `${item.rank}:${item.status}`), ['1:responded', '2:responded', '3:responded', '4:declined', '5:responded']);
  check('progress moves to 5 of 5', rules.requestProgress(merged, new Date('2026-11-05T10:00:00Z')).label, '5 of 5 programs answered');
  check('the answer in one line', rules.answerLine(logged), 'Waitlist · Maybe · Earliest admit Nov 9, 2026');
  check('a quoted rate, with the stay it implies', rules.quotedRateLine(1050), '$1,050/day quoted · about $31,500 for 30 days, before insurance');

  // Today: new answers since the last look; the practitioner's own requests under "Mine".
  const now = new Date('2026-11-05T10:00:00Z');
  const labelFor = () => 'Rivera family';
  const first = rules.placementTodayItems({ requests: [merged], seen: {}, now, userId: 'U1', scope: 'mine', labelFor });
  check('Today: one card line, every answer new before the first look', first.map((item) => [item.title, item.newAnswers]), [['Placement request: 5 of 5 programs answered', 5]]);
  ok('the card line says the time left and the new answers', first[0].detail === 'Rivera family · 2 h left · 5 new answers');
  const seen = { q1: rules.seenMarker(merged, new Date('2026-11-04T19:30:00Z')) };
  check('after a look, nothing is new', rules.placementTodayItems({ requests: [merged], seen, now, userId: 'u1', scope: 'mine', labelFor })[0].newAnswers, 0);
  const later = rules.withRecipient(merged, { ...merged.recipients[1], respondedAt: '2026-11-05T09:00:00Z' });
  check('an answer that arrives later is new again', rules.placementTodayItems({ requests: [later], seen, now, userId: 'u1', scope: 'mine', labelFor })[0].newAnswers, 1);
  check('past the deadline with nothing new, the card goes away', rules.placementTodayItems({ requests: [merged], seen, now: new Date('2026-11-05T13:00:00Z'), userId: 'u1', scope: 'mine', labelFor }), []);
  check('a teammate\'s request shows under Everyone, not Mine', [
    rules.placementTodayItems({ requests: [merged], seen, now, userId: 'u2', scope: 'mine', labelFor }).length,
    rules.placementTodayItems({ requests: [merged], seen, now, userId: 'u2', scope: 'everyone', labelFor }).length,
  ], [0, 1]);
  check('a closed request never shows on Today', rules.placementTodayItems({ requests: [{ ...merged, request: { ...merged.request, status: 'closed' } }], seen: {}, now, userId: 'u1', scope: 'everyone', labelFor }), []);
  check('the newest request for a saved match', rules.latestRequestForMatch([merged, { ...merged, request: { ...merged.request, id: 'q0', createdAt: '2026-11-01T00:00:00Z' } }], 'M1').request.id, 'q1');
}

// ─── (h) The API ────────────────────────────────────────────────────────────

function query(result) {
  const chain = {
    select: () => chain, order: () => chain, limit: () => Promise.resolve(result), in: () => chain,
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return chain;
}

{
  fake.from = () => query({ data: null, error: { code: 'PGRST205', message: 'Could not find the table' }, status: 404 });
  check('a server without the migration hides the feature (unknown table)', await api.fetchPlacementRequests(), { available: false, requests: [] });
  fake.from = () => query({ data: null, error: { code: '42P01', message: 'relation does not exist' }, status: 404 });
  check('the same for 42P01', (await api.fetchPlacementRequests()).available, false);
  fake.rpc = () => Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' }, status: 404 });
  check('the channel check hides too (unknown function)', await api.fetchPlacementChannels(['p1']), null);
  fake.rpc = () => Promise.resolve({ data: null, error: { code: '42883', message: 'function does not exist' }, status: 404 });
  check('and for 42883', await api.fetchPlacementChannels(['p1']), null);
  for (const code of ['PGRST202', 'PGRST205', '42P01', '42703', '42883']) ok(`missing schema: ${code}`, rules.isMissingPlacementSchema(code) && portal.isMissingSchema(code));
  ok('a refusal is not a missing schema', !rules.isMissingPlacementSchema('42501') && !rules.isMissingPlacementSchema('22023'));

  fake.from = (table) => (table === 'placement_requests'
    ? query({ data: [requestRow], error: null, status: 200 })
    : query({ data: [recipientRow({ rank: 2 }), recipientRow({ rank: 1 })], error: null, status: 200 }));
  const read = await api.fetchPlacementRequests();
  check('requests come back with their programs in rank order', [read.available, read.requests[0].recipients.map((item) => item.rank)], [true, [1, 2]]);

  fake.rpc = (name, args) => {
    check('create sends the saved match, the ranked ids, and no criteria of its own', [name, args.p_match_profile_id, args.p_partner_ids, args.p_criteria, args.p_respond_hours, args.p_note],
      ['create_placement_request', 'm1', ['p1', 'p2'], null, 24, 'Prefers a quiet setting']);
    ok('nothing identifying rides along', !JSON.stringify(args).toLowerCase().includes('rivera') && !('p_client_label' in args) && !('p_budget' in args));
    return Promise.resolve({ data: { request: requestRow, recipients: [recipientRow({ rank: 1 }), recipientRow({ rank: 2 })] }, error: null, status: 200 });
  };
  const id = api.newPlacementRequestId();
  const created = await api.createPlacementRequest({ id, matchProfileId: 'm1', partnerIds: ['p1', 'p2'], respondHours: 24, admitWindow: 'this_week', note: 'Prefers a quiet setting' });
  check('the created request reads back', [created.request.id, created.recipients.length], ['q1', 2]);

  fake.rpc = () => Promise.resolve({ data: null, error: { message: 'TypeError: Network request failed' }, status: 0 });
  await assert.rejects(api.createPlacementRequest({ id, matchProfileId: 'm1', partnerIds: ['p1'], respondHours: 4, admitWindow: 'asap', note: '' }), (error) => error instanceof errors.OfflineError);
  checks += 1;
  await assert.rejects(api.logManualAnswer('r1', { bedAvailable: 'yes', likelyAccept: 'yes', earliestAdmitOn: null, dailyRate: null, costNote: '', note: '' }), (error) => error instanceof errors.OfflineError);
  checks += 1;
  await assert.rejects(api.cancelPlacementRequest('q1'), (error) => error instanceof errors.OfflineError);
  checks += 1;
  fake.rpc = () => Promise.resolve({ data: null, error: { code: '22023', message: 'A request can go to at most 8 programs' }, status: 400 });
  await assert.rejects(api.createPlacementRequest({ id, matchProfileId: 'm1', partnerIds: ['p1'], respondHours: 4, admitWindow: 'asap', note: '' }),
    (error) => error instanceof errors.StoreError && !(error instanceof errors.OfflineError) && error.message === 'A request can go to at most 8 programs');
  checks += 1;
  fake.rpc = () => Promise.resolve({ data: null, error: { code: '22023', message: 'The program already answered in ReferralFit' }, status: 400 });
  await assert.rejects(api.logManualAnswer('r1', { bedAvailable: 'yes', likelyAccept: 'yes', earliestAdmitOn: null, dailyRate: null, costNote: '', note: '' }),
    (error) => error.message === 'The program already answered in ReferralFit');
  checks += 1;

  const sheet = readFileSync(path.join(repoRoot, 'src/lib/PlacementRequestSheet.tsx'), 'utf8');
  ok('one id per request, reused on retry (a retry is a no-op on the server)', /const id = requestIdRef\.current \|\| newPlacementRequestId\(\);\s*requestIdRef\.current = id;/.test(sheet));
  ok('a changed choice of programs is a new request', /requestIdRef\.current = null; \/\/ a different request now/.test(sheet));
}

// ─── (i) The center portal's mirror agrees ──────────────────────────────────

{
  const payloads = [fixturePayload];
  for (const state of data.stateOptions.map((item) => item.code).concat([null])) {
    for (const location of ['No preference', 'Close to family', 'Away from home']) {
      payloads.push({ ...fixturePayload, home_state: state, location_preference: location });
    }
  }
  payloads.push({ ...fixturePayload, payment: 'self_pay', insurance_carrier: null, note: null, must_haves: [], needs: [], level_of_care: 'Any type', population: 'Any' });
  payloads.push({ ...fixturePayload, payment: 'insurance', insurance_carrier: null, population: 'Adolescent', admit_window: 'two_weeks' });
  for (const payload of payloads) {
    assert.deepEqual(portal.summaryLines(portal.payloadFromJson(payload)), rules.placementSummaryLines(rules.payloadFromJson(payload)));
  }
  checks += 1;
  ok(`the portal shows programs the same summary the practice reviewed (${payloads.length} payloads)`, true);
  check('the portal reads a stored payload the same way', portal.payloadFromJson({ ...fixturePayload, client_label: 'x', admit_window: 'later' }), rules.payloadFromJson({ ...fixturePayload, client_label: 'x', admit_window: 'later' }));
  check('the portal opens with the same warm line', portal.PROGRAM_INTRO, rules.PROGRAM_INTRO);
  const forms = [
    { bed: '', likely: '', admitOn: '', dailyRate: '', costNote: '', note: '' },
    { bed: 'yes', likely: '', admitOn: '', dailyRate: '', costNote: '', note: '' },
    { bed: 'yes', likely: 'yes', admitOn: '2028-01-01', dailyRate: '', costNote: '', note: '' },
    { bed: 'yes', likely: 'yes', admitOn: '2026-11-02', dailyRate: '', costNote: '', note: '' },
    { bed: 'yes', likely: 'yes', admitOn: '2026-11-03', dailyRate: '0', costNote: '', note: '' },
    { bed: 'no', likely: 'no', admitOn: '', dailyRate: '100001', costNote: '', note: '' },
    { bed: 'waitlist', likely: 'maybe', admitOn: '11/9/2026', dailyRate: '$1,050', costNote: 'x'.repeat(201), note: '' },
    { bed: 'waitlist', likely: 'maybe', admitOn: '', dailyRate: '', costNote: '', note: 'y'.repeat(301) },
    { bed: 'waitlist', likely: 'maybe', admitOn: '11/9/2026', dailyRate: '$1,050', costNote: ' Most PPOs ', note: ' Call us ' },
  ];
  for (const form of forms) {
    const app = rules.normalizeAnswerDraft({ ...form, bed: form.bed || null, likely: form.likely || null }, '2026-11-04');
    const site = portal.validateAnswer(form, '2026-11-04');
    if ('problem' in app) check(`the portal refuses what the app refuses: ${app.problem}`, site.problem, app.problem);
    else check('the portal sends what the app would', site.payload, {
      p_bed_available: app.fields.bedAvailable, p_likely_accept: app.fields.likelyAccept, p_earliest_admit_on: app.fields.earliestAdmitOn,
      p_daily_rate: app.fields.dailyRate, p_cost_note: app.fields.costNote, p_note: app.fields.note,
    });
  }
  check('the portal says why a request is closed', [
    portal.closedReason({ can_respond: true, request_status: 'open' }),
    portal.closedReason({ can_respond: false, request_status: 'open' }),
    portal.closedReason({ can_respond: false, request_status: 'cancelled' }),
    portal.closedReason({ can_respond: false, request_status: 'closed' }),
  ], ['', 'Closed: the time to answer has passed.', 'Closed: the practice no longer needs this placement.', 'Closed: the practice found a placement.']);
  const inbox = readFileSync(path.join(repoRoot, 'portal/src/PlacementRequests.tsx'), 'utf8');
  ok('opening a request in the portal marks it viewed', /rpc\('mark_placement_request_viewed'/.test(inbox));
  ok('the portal answers through the RPC only', /rpc\('respond_to_placement_request'/.test(inbox) && !/from\('placement_/.test(inbox));
  ok('the portal hides on a server without the feature', /isMissingSchema\(error\.code\)\) \{ setAvailable\(false\)/.test(inbox));
  const portalApp = readFileSync(path.join(repoRoot, 'portal/src/App.tsx'), 'utf8');
  ok('a claimed center sees the inbox', /<PlacementRequests onNotice=\{setNotice\} onError=\{setError\} \/>/.test(portalApp));
}

// ─── (j) Ethics and the one-sheet rule ──────────────────────────────────────

{
  const matchingSource = readFileSync(path.join(repoRoot, 'src/lib/matching.ts'), 'utf8');
  ok('the ranker never reads placement requests', !/placement-request|placement-api|placement_request/i.test(matchingSource));
  const rulesSource = readFileSync(path.join(repoRoot, 'src/lib/placement-requests.ts'), 'utf8');
  ok('the placement rules never import the ranker', !/from '\.\/matching'/.test(rulesSource));
  const apiSource = readFileSync(path.join(repoRoot, 'src/lib/placement-api.ts'), 'utf8');
  ok('the API writes nothing but its own RPCs', !/\.(insert|update|upsert|delete)\(/.test(apiSource) && !/match_profiles|scorecard|placement_decisions/.test(apiSource));
  ok('the API never sends criteria of its own (the server reads the saved match)', /p_criteria: null/.test(apiSource));
  const app = readFileSync(path.join(repoRoot, 'App.tsx'), 'utf8');
  ok('the match memo still ranks through matching.ts alone', /const matches = useMemo\(\s*\(\) => rankPrograms\(draftMatchProfile, partners, scorecards, bedOptions\),\s*\[draftMatchProfile, partners, scorecards, bedOptions\],/.test(app));
  ok('both placement sheets count as open sheets', /\|\| placementSheet \|\| placementCompareId,\s*\);/.test(app));
  ok('the answers screen opens after the send sheet has closed', /setPlacementSheet\(null\);\s*afterSheetCloses\(\(\) => setPlacementCompareId\(requestId\)\);/.test(app));
  ok('Choose this program hands off to the existing flows', /void openMatchedReferral\(partner\.id\);/.test(app) && /void openPacketComposer\(partner, shown \?\? scoreProgram\(/.test(app));
  ok('the hand-off waits for the answers screen to close', /setPendingPlacementChoice\(null\);\s*afterSheetCloses\(\(\) => \{/.test(app));
  ok('the Ask button saves the match first and opens only on a clear screen', /async function openPlacementSheet\(\) \{\s*const openings = screenOpenings\(\);\s*const saved = await currentOrSavedMatch\(\);\s*if \(!saved\) return;\s*if \(anySheetOpenRef\.current \|\| overlayOpen\(\) \|\| screenOpenings\(\) !== openings\) return;/.test(app));
  ok('the feature hides unless the server has it', (app.match(/placementAvailable/g) || []).length >= 4 && /const placementAvailable = placement\.state\.status === 'ready';/.test(app));
  for (const file of ['src/lib/PlacementRequestSheet.tsx', 'src/lib/PlacementCompare.tsx']) {
    const source = readFileSync(path.join(repoRoot, file), 'utf8');
    check(`${file}: one native Modal`, (source.match(/<Modal\b/g) || []).length, 1);
    ok(`${file}: Messages and Mail are released when it closes`, source.includes('releaseComposeOverlay();'));
  }
  const compare = readFileSync(path.join(repoRoot, 'src/lib/PlacementCompare.tsx'), 'utf8');
  ok('the comparison says answers never change the ranking', /Answers never change it; sorting only reorders this list\./.test(compare));
  ok('the comparison reads online and says so offline', compare.includes("Answers load when you're online"));
  ok('programs never see the practice\'s own log, their rank, or who else was asked', migration.includes('NOT r.entered_by_practice') && migration.includes('where this one ranked'));
  const docs = readFileSync(path.join(repoRoot, 'docs/PLACEMENT_REQUESTS.md'), 'utf8');
  ok('the docs state the three ethics rules', /never change ranking or scores/i.test(docs) && /cannot pay to be asked/i.test(docs) && /Nothing identifies the client/i.test(docs));
}

// ─── (k) The migration follows the paste rules ──────────────────────────────

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
  for (const table of ['placement_requests', 'placement_request_recipients']) {
    ok(`${table} is revoked before its one grant`,
      migration.indexOf(`REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon, authenticated;`) > 0
      && migration.indexOf(`REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon, authenticated;`) < migration.indexOf(`GRANT SELECT ON TABLE public.${table} TO authenticated;`));
  }
  ok('no write policy on either table', !/CREATE POLICY[^;]*FOR (INSERT|UPDATE|DELETE|ALL)/.test(migration));
  const definers = [...migration.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)\(([^)]*)\)[\s\S]*?\$\$;\s*\n(REVOKE ALL ON FUNCTION public\.\1\([^)]*\) FROM PUBLIC, anon[^;]*;)/g)];
  const created = [...migration.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)\(/g)].map((match) => match[1]);
  check('every function is revoked from PUBLIC and anon right after it is made', definers.map((match) => match[1]).sort(), [...created].sort());
  const pinned = [...migration.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)\([\s\S]*?(SECURITY DEFINER)?\s*\nSET search_path/g)];
  ok('every function pins its search_path', pinned.length === created.length);
  for (const name of ['referral_handoffs', 'referral_handoff_events', 'referral_sources', 'referral_intake_submissions', 'referral_intake_rate_limits', 'center_availability']) {
    ok(`no object named ${name}`, !migration.includes(name));
  }
  // Purely additive: only new objects, plus the two internal workspace
  // helpers re-created from their latest definitions (same signatures).
  const recreated = created.filter((name) => !name.startsWith('placement_') && !['create_placement_request', 'cancel_placement_request', 'close_placement_request',
    'log_manual_response', 'list_center_placement_requests', 'mark_placement_request_viewed', 'respond_to_placement_request'].includes(name));
  check('the only existing functions re-created are the two workspace-move helpers', recreated.sort(), ['org_merge_linked_partner_copies', 'org_move_workspace_rows']);
  ok('no existing table is altered and nothing is dropped', !/ALTER TABLE (?!public\.placement_request)/.test(migration) && !/DROP (TABLE|FUNCTION|COLUMN|TRIGGER)/.test(migration));
  const previous = readFileSync(path.join(repoRoot, 'supabase/migrations/20261104130000_program_integrity.sql'), 'utf8');
  const merge = (sql) => sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.org_merge_linked_partner_copies'), sql.indexOf('REVOKE ALL ON FUNCTION public.org_merge_linked_partner_copies'));
  check('the merge helper is the latest definition plus one line',
    merge(migration).split('\n').filter((line) => !merge(previous).split('\n').includes(line)),
    ['    UPDATE public.placement_request_recipients SET partner_id = v_pair.keep_id WHERE org_id = p_from AND partner_id = v_pair.dup_id;']);
  const hardening = readFileSync(path.join(repoRoot, 'supabase/migrations/20261024120000_directory_membership_hardening.sql'), 'utf8');
  const move = (sql) => sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.org_move_workspace_rows'), sql.indexOf('REVOKE ALL ON FUNCTION public.org_move_workspace_rows'));
  check('the move helper is the latest definition plus two lines',
    move(migration).split('\n').filter((line) => !move(hardening).split('\n').includes(line)),
    ['  UPDATE public.placement_requests    SET org_id = p_to WHERE org_id = p_from;',
     '  UPDATE public.placement_request_recipients SET org_id = p_to WHERE org_id = p_from;']);
}

console.log(`placement requests: ${checks} checks ok`);
