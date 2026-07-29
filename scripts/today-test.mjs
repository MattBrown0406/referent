// Today Command Center fixture test — runs src/lib/today.ts (and the real
// followUpsDue/todayLoad from src/lib/notifications.ts, with expo-notifications
// and react-native stubbed) in plain node, no build step. Prints a section
// layout, date math, and cadence/snooze checks.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'today-test');
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

// Stub native-only modules before requiring notifications.ts.
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'expo-notifications' || request === 'react-native') {
    return path.join(tmpDir, `${request.replace(/\//g, '_')}.js`);
  }
  return originalResolve.call(this, request, ...args);
};
writeFileSync(path.join(tmpDir, 'expo-notifications.js'), 'module.exports = {};');
writeFileSync(path.join(tmpDir, 'react-native.js'), 'module.exports = { Platform: { OS: "ios" } };');

const today = require(transpileTo('src/lib/today.ts', 'today.js'));
const notifications = require(transpileTo('src/lib/notifications.ts', 'notifications.js'));

let failures = 0;
function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ─── Fixtures ───────────────────────────────────────────────────────────────
// "Today" is fixed: Friday 2026-07-24 (local).
const NOW = new Date(2026, 6, 24, 10, 0, 0);
const STAMP = '2026-07-24';

function fu(overrides) {
  return {
    id: overrides.id || 'f-x',
    title: overrides.title || 'Item',
    dueOn: overrides.dueOn || STAMP,
    status: 'open',
    note: '',
    ...overrides,
  };
}
function partner(overrides) {
  return {
    id: 'p-1', name: 'Sarah Ellison', organization: 'Riverstone Recovery',
    type: 'Inpatient', city: 'Bend', state: 'OR', regions: [], phone: '(541) 555-0142',
    email: '', cashMin: 0, cashMax: 0, insurance: [], therapies: [], populations: [], levels: [],
    note: '', inbound: 0, outbound: 0, lastContact: '', ...overrides,
  };
}

const followUps = [
  fu({ id: 'f-overdue2', title: 'Check in — did they admit?', dueOn: '2026-07-22', kind: 'follow_up', partnerId: 'p-1', referralId: 'r-1' }),
  fu({ id: 'f-overdue5', title: 'Old promised call', dueOn: '2026-07-19', kind: 'promised_call' }),
  fu({ id: 'f-consult-timed', title: 'Consult — Henderson', dueOn: STAMP, kind: 'consult', dueTime: '14:00', caseId: 'c-1' }),
  fu({ id: 'f-consult-early', title: 'Consult — Alvarez', dueOn: STAMP, kind: 'consult', dueTime: '09:30', caseId: 'c-2' }),
  fu({ id: 'f-first-call', title: 'First call — Henderson family', dueOn: STAMP, kind: 'first_call', caseId: 'c-1' }),
  fu({ id: 'f-promised', title: 'Call back — Pastor Jim', dueOn: STAMP, kind: 'promised_call' }),
  fu({ id: 'f-waiting', title: 'Check — insurance verification', dueOn: STAMP, kind: 'waiting_on', waitingOn: 'insurance verification' }),
  fu({ id: 'f-followup', title: 'Follow up — Riverstone', dueOn: STAMP, kind: 'follow_up', partnerId: 'p-1' }),
  fu({ id: 'f-future', title: 'Not due yet', dueOn: '2026-07-28', kind: 'follow_up' }),
  fu({ id: 'f-snoozed-future', title: 'Snoozed away', dueOn: '2026-07-20', kind: 'follow_up', snoozedUntil: '2026-07-27' }),
  fu({ id: 'f-snoozed-today', title: 'Snoozed into today', dueOn: '2026-07-21', kind: 'follow_up', snoozedUntil: STAMP }),
  fu({ id: 'f-done', title: 'Already done', dueOn: STAMP, status: 'done' }),
];
const partners = [
  partner({ id: 'p-1', organization: 'Riverstone Recovery', lastContact: '2026-06-24', touchCadenceDays: 30 }), // 30 days since → due exactly today
  partner({ id: 'p-2', organization: 'Cascade Detox', name: 'Mike Rhee', lastContact: '2026-04-20', touchCadenceDays: 60 }), // 95 since → 35 past
  partner({ id: 'p-3', organization: 'No Cadence Co', lastContact: '2025-01-01' }), // no cadence → never due
  partner({ id: 'p-4', organization: 'Fresh Touch LLC', name: 'Ana', lastContact: '2026-07-20', touchCadenceDays: 30 }), // 4 since → not due
];

const caseTitles = { 'c-1': 'Henderson family — son Jake', 'c-2': 'Alvarez family' };
const contextFor = (followUp) => ({
  caseTitle: followUp.caseId ? caseTitles[followUp.caseId] : undefined,
  partnerName: followUp.partnerId ? 'Riverstone Recovery' : undefined,
  partnerPhone: followUp.partnerId ? '(541) 555-0142' : undefined,
  referralAwaitingAnswer: followUp.referralId === 'r-1',
});

// ─── 1. Section bucketing ───────────────────────────────────────────────────
console.log('\n── Section bucketing (today = 2026-07-24) ──');
const due = today.partnersDueToday(partners, NOW, {});
const sections = today.buildTodaySections(followUps, due, NOW, contextFor);

eq('OVERDUE ids (most-overdue first — days counted from ORIGINAL due date, like the view)',
  sections.overdue.map((c) => c.id), ['f-overdue5', 'f-snoozed-today', 'f-overdue2']);
eq('OVERDUE days', sections.overdue.map((c) => c.daysOverdue), [5, 3, 2]);
eq('TODAY ids (timed consults first by time, then kind order)',
  sections.today.map((c) => c.id),
  ['f-consult-early', 'f-consult-timed', 'f-first-call', 'f-promised', 'f-waiting', 'f-followup']);
eq('PARTNERS DUE ids (most-past-cadence first)', sections.partnersDue.map((c) => c.id), ['cadence-p-2', 'cadence-p-1']);
check('future item excluded', !sections.today.some((c) => c.id === 'f-future') && !sections.overdue.some((c) => c.id === 'f-future'));
check('snoozed-to-future excluded everywhere', !sections.today.concat(sections.overdue).some((c) => c.id === 'f-snoozed-future'));
check('done item excluded', !sections.today.concat(sections.overdue).some((c) => c.id === 'f-done'));

console.log('\n  OVERDUE:');
for (const c of sections.overdue) console.log(`    ${c.daysOverdue}d  ${c.title}${c.context.caseTitle ? `  (${c.context.caseTitle})` : ''}`);
console.log('  TODAY:');
for (const c of sections.today) console.log(`    ${c.dueTime ? c.dueTime + '  ' : ''}${c.kind.padEnd(13)} ${c.title}${c.subtitle ? `  — ${c.subtitle}` : ''}`);
console.log('  PARTNERS DUE:');
for (const c of sections.partnersDue) console.log(`    ${c.title} — ${c.subtitle}`);

// Card subtitles
const waiting = sections.today.find((c) => c.id === 'f-waiting');
check('waiting_on card shows the text', waiting.subtitle.includes('Waiting on: insurance verification'), waiting.subtitle);
const consult = sections.today.find((c) => c.id === 'f-consult-timed');
check('consult card shows formatted time + case', consult.subtitle.includes('due 2:00 PM') && consult.subtitle.includes('Henderson'), consult.subtitle);

// ─── 2. Next-step date math ─────────────────────────────────────────────────
console.log('\n── Next-step date math ──');
eq('today', today.nextStepDate('today', NOW), '2026-07-24');
eq('tomorrow', today.nextStepDate('tomorrow', NOW), '2026-07-25');
eq('in 3 days', today.nextStepDate('in3days', NOW), '2026-07-27');
eq('next week (+7)', today.nextStepDate('nextweek', NOW), '2026-07-31');
eq('custom', today.nextStepDate('custom', NOW, '2026-08-14'), '2026-08-14');
eq('custom without a date falls back to today', today.nextStepDate('custom', NOW), '2026-07-24');
eq('snooze +1', today.snoozeDate('plus1', NOW), '2026-07-25');
eq('snooze +2', today.snoozeDate('plus2', NOW), '2026-07-26');
eq('snooze next week', today.snoozeDate('nextweek', NOW), '2026-07-31');
// Month-boundary sanity
eq('tomorrow across month end', today.nextStepDate('tomorrow', new Date(2026, 6, 31)), '2026-08-01');

// ─── 3. Cadence computation incl. local snooze ─────────────────────────────
console.log('\n── Cadence due + local snooze ──');
const duePlain = today.partnersDueToday(partners, NOW, {});
eq('due today or past (overdueBy >= 0)', duePlain.map((d) => d.partnerId), ['p-2', 'p-1']);
eq('days since / past-cadence', duePlain.map((d) => [d.daysSince, d.overdueBy]), [[95, 35], [30, 0]]);
const dueSnoozed = today.partnersDueToday(partners, NOW, { 'p-2': '2026-07-30' });
eq('snoozed partner hidden until its date', dueSnoozed.map((d) => d.partnerId), ['p-1']);
const dueSnoozeExpired = today.partnersDueToday(partners, NOW, { 'p-2': '2026-07-24' });
eq('snooze expiring today reappears', dueSnoozeExpired.map((d) => d.partnerId), ['p-2', 'p-1']);
const pruned = today.prunePartnerSnoozes({ 'p-1': '2026-07-20', 'p-2': '2026-07-30' }, NOW);
eq('prune drops past snoozes, keeps future', pruned, { 'p-2': '2026-07-30' });
const afterTouch = today.partnersDueToday(
  partners.map((p) => (p.id === 'p-2' ? { ...p, lastContact: '2026-07-24' } : p)), NOW, { 'p-2': '2026-07-30' });
eq('a logged touch self-heals the card even while snoozed', afterTouch.map((d) => d.partnerId), ['p-1']);

// Cadence card shape
const cadenceCard = sections.partnersDue[0];
check('cadence card is virtual with no followUp', Boolean(cadenceCard.virtual) && !cadenceCard.followUp);
check('cadence card never joins OVERDUE (daysOverdue 0)', cadenceCard.daysOverdue === 0);

// ─── 4. todayLoad (the briefing + header count) ─────────────────────────────
console.log('\n── todayLoad (briefing count) ──');
const load = notifications.todayLoad(followUps, partners, NOW);
eq('actions = snooze-aware due follow-ups + cadence due', load, { actions: 11, overdueCount: 3 });

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
