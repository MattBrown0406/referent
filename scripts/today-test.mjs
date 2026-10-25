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
eq('custom without a date falls back to the first date offered (tomorrow)', today.nextStepDate('custom', NOW), '2026-07-25');
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

// ─── 5. Today never depends on completed follow-ups being loaded ────────────
// store.ts loads OPEN follow-ups only (in full, paged) and leaves done/skipped
// rows on the server. Every Today surface must produce the same result from
// the open subset as from a list that also carries completed rows.
console.log('\n── Open-only follow-up load (store snapshot shape) ──');
const openOnly = followUps.filter((item) => item.status === 'open');
check('fixture includes a completed row to drop', openOnly.length < followUps.length);
const openSections = today.buildTodaySections(openOnly, due, NOW, contextFor);
eq('OVERDUE identical without completed rows', openSections.overdue.map((c) => c.id), sections.overdue.map((c) => c.id));
eq('TODAY identical without completed rows', openSections.today.map((c) => c.id), sections.today.map((c) => c.id));
eq('PARTNERS DUE identical without completed rows', openSections.partnersDue.map((c) => c.id), sections.partnersDue.map((c) => c.id));
eq('todayLoad identical without completed rows', notifications.todayLoad(openOnly, partners, NOW), load);
eq('followUpsDue identical without completed rows',
  notifications.followUpsDue(openOnly, NOW).map((f) => f.id), notifications.followUpsDue(followUps, NOW).map((f) => f.id));
const storeSource = readFileSync(path.join(repoRoot, 'src/lib/store.ts'), 'utf8');
check('store loads open follow-ups filtered by status, never by count',
  /from\('follow_ups'\)\.select\('\*'\)\.eq\('status', 'open'\)[^\n]*\.range\(from, to\)\)/.test(storeSource)
  && !/from\('follow_ups'\)\.select\('\*'\)\.eq\('status', 'open'\)[^\n]*\.limit\(/.test(storeSource));

// ─── 6. Today works from the saved copies on an offline launch ──────────────
// Call/Text on a case-linked card resolves the family's numbers from the
// in-memory contact list, which hydration seeds from the server or, with no
// signal, from the saved case list. The Today list itself and pull-to-refresh
// come from the snapshot cache and the shared refresh path.
console.log('\n── Offline launch (saved case list feeds Today) ──');
const appSource = readFileSync(path.join(repoRoot, 'App.tsx'), 'utf8');
check('case-card call/text reads the in-memory contact list, never the server',
  /const contacts = allCaseContacts\.filter\(\(item\) => item\.caseId === card\.caseId && item\.phone\.trim\(\)\)/.test(appSource)
  && !/function cardContactAction[\s\S]*?fetchCase[\s\S]*?function logCardContact/.test(appSource));
check('hydration seeds contacts through the cache-aware case loader',
  /const load = await loadCaseList\(userId\);[\s\S]{0,700}setAllCaseContacts\(activeContacts\)/.test(appSource));
check('the saved case list falls back only when the server is unreachable',
  /remote = await fetchCaseList\(\);\s*\} catch \(error\) \{\s*if \(!isNetworkError\(error\)\) throw error;/.test(storeSource));
// The sections are rebuilt when the local day changes (midnight, or a return
// to the foreground), not only when data changes: an app left open overnight
// or reopened offline must move yesterday's "today" items to OVERDUE.
check('Today re-sorts when the local day changes',
  /\}, \[followUps, partners, cases, allCaseContacts, referrals, partnerSnoozes, leadSettings\.leadResponseTargetMinutes, todayStamp\]\);/.test(appSource)
  && /todayLoad\(followUps, partners\), \[followUps, partners, todayStamp\]\)/.test(appSource)
  && /AppState\.addEventListener\('change', \(state\) => \{\s*if \(state !== 'active'\) return;\s*sync\(\);\s*scheduleMidnight\(\);/.test(appSource)
  && /timer = setTimeout\(\(\) => \{ sync\(\); scheduleMidnight\(\); \}/.test(appSource));
check('Today has pull-to-refresh on its list',
  /function HomeScreen\(\) \{[\s\S]{0,900}<ScrollView[^>]*refreshControl=\{renderRefreshControl\(\)\}/.test(appSource));

// ─── 7. NEW LEADS ───────────────────────────────────────────────────────────
// A lead waits in NEW LEADS until it is touched: lead_captured_at set, no
// first_touch_at, still open, first-call follow-up still open. Its first
// call is shown there once, not again under TODAY/OVERDUE.
console.log('\n── NEW LEADS ──');
const minutesAgo = (minutes) => new Date(NOW.getTime() - minutes * 60000).toISOString();
const leadCase = (overrides) => ({
  id: overrides.id, title: overrides.title || overrides.id, status: overrides.status || 'inquiry',
  leadSource: overrides.leadSource || 'Unspecified', leadCapturedAt: overrides.leadCapturedAt,
  firstTouchAt: overrides.firstTouchAt, leadUrgency: overrides.leadUrgency,
});
const leadCases = [
  leadCase({ id: 'c-lead-1', title: 'Maria Lopez — son Jake', leadSource: 'Website', leadCapturedAt: minutesAgo(20) }),
  leadCase({ id: 'c-lead-2', title: 'Dan Ortiz — wife Elena', leadSource: 'Inbound call', leadCapturedAt: minutesAgo(5), leadUrgency: 'immediate_danger' }),
  leadCase({ id: 'c-lead-3', title: 'Oldest waiting', leadCapturedAt: minutesAgo(90) }),
  leadCase({ id: 'c-lead-touched', title: 'Already called', leadCapturedAt: minutesAgo(40), firstTouchAt: minutesAgo(30) }),
  leadCase({ id: 'c-lead-lost', title: 'Lost lead', status: 'lost', leadCapturedAt: minutesAgo(40) }),
  leadCase({ id: 'c-lead-done', title: 'First call done', leadCapturedAt: minutesAgo(40) }),
  leadCase({ id: 'c-plain', title: 'Not a lead' }),
];
const leadContacts = [
  { caseId: 'c-lead-1', name: 'Maria Lopez', relationship: 'mother', isPrimary: true },
  { caseId: 'c-lead-1', name: 'Jake', relationship: 'son', isPrimary: false },
  { caseId: 'c-lead-2', name: 'Dan Ortiz', relationship: '', isPrimary: false },
];
const leadFollowUps = [
  ...followUps,
  fu({ id: 'f-lead-1', title: 'First call — Maria Lopez — son Jake', dueOn: STAMP, kind: 'first_call', caseId: 'c-lead-1' }),
  fu({ id: 'f-lead-2', title: 'First call — Dan Ortiz — wife Elena', dueOn: STAMP, kind: 'first_call', caseId: 'c-lead-2' }),
  fu({ id: 'f-lead-3', title: 'First call — Oldest waiting', dueOn: '2026-07-22', kind: 'first_call', caseId: 'c-lead-3' }),
  fu({ id: 'f-lead-touched', title: 'First call — Already called', dueOn: STAMP, kind: 'first_call', caseId: 'c-lead-touched' }),
  fu({ id: 'f-lead-lost', title: 'First call — Lost lead', dueOn: STAMP, kind: 'first_call', caseId: 'c-lead-lost' }),
  fu({ id: 'f-lead-done', title: 'First call — First call done', dueOn: STAMP, kind: 'first_call', caseId: 'c-lead-done', status: 'done' }),
];
const leadCards = today.newLeadCards(leadCases, leadContacts, leadFollowUps, 15, NOW);
eq('NEW LEADS ids (immediate danger first, then longest waiting)', leadCards.map((c) => c.id), ['f-lead-2', 'f-lead-3', 'f-lead-1']);
eq('a lead card is backed by its first-call follow-up and linked to the case', [leadCards[2].kind, leadCards[2].followUp?.id, leadCards[2].caseId], ['first_call', 'f-lead-1', 'c-lead-1']);
eq('lead subtitle: primary contact with relationship, then the source', leadCards[2].subtitle, 'Maria Lopez (mother) · Website');
eq('lead info carries arrival, target, danger and contact', leadCards[1].lead, { arrivedAt: minutesAgo(90), targetMinutes: 15, leadSource: 'Unspecified', immediateDanger: false, contactName: '' });
check('touched, lost, done-first-call and non-lead cases are excluded', !leadCards.some((c) => ['f-lead-touched', 'f-lead-lost', 'f-lead-done'].includes(c.id)));
const leadSections = today.buildTodaySections(leadFollowUps, due, NOW, contextFor, leadCards);
eq('NEW LEADS is its own section', leadSections.newLeads.map((c) => c.id), ['f-lead-2', 'f-lead-3', 'f-lead-1']);
check('a lead first call is not repeated under TODAY', !leadSections.today.some((c) => c.id === 'f-lead-1' || c.id === 'f-lead-2'));
check('a lead first call is not repeated under OVERDUE even when its due date passed', !leadSections.overdue.some((c) => c.id === 'f-lead-3'));
check('a touched lead first call still shows under TODAY like any follow-up', leadSections.today.some((c) => c.id === 'f-lead-touched'));
eq('sections without leads are unchanged', [leadSections.overdue.length, leadSections.partnersDue.length], [sections.overdue.length + 0, sections.partnersDue.length]);
eq('minutesWaiting counts whole minutes and never goes negative', [today.minutesWaiting(minutesAgo(20), NOW), today.minutesWaiting(minutesAgo(-5), NOW)], [20, 0]);
eq('formatWaiting', [4, 59, 60, 75, 1439, 1500, 3000].map(today.formatWaiting), ['4m', '59m', '1h 0m', '1h 15m', '23h 59m', '1d 1h', '2d 2h']);
for (const c of leadCards) console.log(`    ${today.formatWaiting(today.minutesWaiting(c.lead.arrivedAt, NOW)).padEnd(7)} ${c.lead.immediateDanger ? '⚠ ' : '  '}${c.title}  — ${c.subtitle}`);

// A snoozed lead leaves NEW LEADS until its snooze date, and does not show
// under TODAY or OVERDUE meanwhile; once the date comes it is back in NEW LEADS.
{
  const snoozedLeadFollowUps = leadFollowUps.map((item) => (item.id === 'f-lead-1' ? { ...item, snoozedUntil: '2026-07-25' } : item));
  const snoozedCards = today.newLeadCards(leadCases, leadContacts, snoozedLeadFollowUps, 15, NOW);
  eq('a snoozed lead is not in NEW LEADS', snoozedCards.map((c) => c.id), ['f-lead-2', 'f-lead-3']);
  const snoozedSections = today.buildTodaySections(snoozedLeadFollowUps, due, NOW, contextFor, snoozedCards);
  check('nor under TODAY or OVERDUE while snoozed', !snoozedSections.today.concat(snoozedSections.overdue).some((c) => c.id === 'f-lead-1'));
  const nextDay = new Date(2026, 6, 25, 9, 0, 0);
  check('it comes back to NEW LEADS on the snooze date', today.newLeadCards(leadCases, leadContacts, snoozedLeadFollowUps, 15, nextDay).some((c) => c.id === 'f-lead-1'));
  check('a snooze that already passed changes nothing', today.newLeadCards(leadCases, leadContacts, leadFollowUps.map((item) => (item.id === 'f-lead-1' ? { ...item, snoozedUntil: '2026-07-20' } : item)), 15, NOW).some((c) => c.id === 'f-lead-1'));
}

// ─── Closed and lost cases leave Today ──────────────────────────────────────
// Closing a case (or losing a lead) skips the steps open on it then, as the
// server's close trigger does; a placement check-in stays. A step scheduled
// on the case afterwards (a check-in's Next step, a call back for a lost lead)
// is open and shows like any other: the case's status is not a filter.
console.log('\n── Closed and lost cases ──');
{
  const AT = '2026-07-24T17:00:00.000Z';
  const caseFollowUps = [
    fu({ id: 'x-closed', title: 'Closed case call', caseId: 'c-closed', snoozedUntil: '2026-07-26' }),
    fu({ id: 'x-lost-overdue', title: 'Lost case overdue', caseId: 'c-lost', dueOn: '2026-07-20' }),
    fu({ id: 'x-check-in', title: 'Check-in', caseId: 'c-closed', kind: 'check_in', referralId: 'r-9' }),
    fu({ id: 'x-done', title: 'Already done', caseId: 'c-closed', status: 'done' }),
    fu({ id: 'x-open', title: 'Open case call', caseId: 'c-open' }),
    fu({ id: 'x-partner', title: 'Partner only', partnerId: 'p-1' }),
  ];
  const closed = today.skipFollowUpsOnCaseClose(caseFollowUps, 'c-closed', 'engaged', 'closed', AT);
  eq('closing skips that case’s open steps only (check-in, done, other cases untouched)',
    closed.map((item) => `${item.id}:${item.status}`),
    ['x-closed:skipped', 'x-lost-overdue:open', 'x-check-in:open', 'x-done:done', 'x-open:open', 'x-partner:open']);
  eq('a skip is stamped like the server’s (completed now, snooze cleared)',
    [closed[0].completedAt, closed[0].snoozedUntil], [AT, undefined]);
  check('losing a lead skips its steps too', today.skipFollowUpsOnCaseClose(caseFollowUps, 'c-lost', 'inquiry', 'lost', AT)[1].status === 'skipped');
  check('any other status change returns the same list', today.skipFollowUpsOnCaseClose(caseFollowUps, 'c-closed', 'engaged', 'placed', AT) === caseFollowUps);
  check('a case already closed is not re-closed', today.skipFollowUpsOnCaseClose(caseFollowUps, 'c-closed', 'closed', 'closed', AT) === caseFollowUps);
  check('nothing open to skip returns the same list', today.skipFollowUpsOnCaseClose(caseFollowUps, 'c-none', 'engaged', 'closed', AT) === caseFollowUps);
  const sections = today.buildTodaySections(closed, [], NOW, contextFor, []);
  eq('TODAY after closing: the check-in, the open case, the partner item', sections.today.map((c) => c.id).sort(), ['x-check-in', 'x-open', 'x-partner']);
  // A step scheduled on the case after it closed (its 30-day check-in's Next
  // step, a call back for a lost lead) is not hidden by the case's status.
  const afterClose = [fu({ id: 'x-next', title: 'Follow up — alumni call', caseId: 'c-closed', kind: 'follow_up' }), ...closed];
  check('a step scheduled after the close shows on Today', today.buildTodaySections(afterClose, [], NOW, contextFor, []).today.some((c) => c.id === 'x-next'));
  check('App no longer filters Today by case status',
    /buildTodaySections\(followUps, partnersDueToday\(partners, now, partnerSnoozes\), now, followUpContext, leads\);/.test(appSource)
    && !/inactiveCaseIds/.test(appSource));
  const statusBody = appSource.slice(appSource.indexOf('function changeCaseStatus('), appSource.indexOf('function saveCasePayment('));
  check('a status change to closed or lost skips the case’s steps on this device (and rolls back with it)',
    /const nextFollowUps = skipFollowUpsOnCaseClose\(followUps, record\.id, record\.status, status, changedAt\);/.test(statusBody)
    && /followUps: nextFollowUps, scorecards \},\s*\{ partners, referrals, referralMatches, touches, followUps, scorecards \}/.test(statusBody)
    && /if \(nextFollowUps !== followUps\) setFollowUps\(followUps\);/.test(statusBody));
  const closeLoopBody = appSource.slice(appSource.indexOf('function closeLoopWithStatus('), appSource.indexOf('function confirmNextStep('));
  check('closing the loop into closed or lost skips the other steps too',
    /const nextFollowUps = skipFollowUpsOnCaseClose\(\s*followUps\.map\(\(item\) => item\.id === followUp\.id \? completed : item\),\s*record\.id, record\.status, updatedCase\.status, now,\s*\);/.test(closeLoopBody));
}

// ─── The admit question follows the referral, not the packet ────────────────
// An outbound referral with no admit answer yet asks "did they admit?" when
// its check is done, whether it went out by packet or by Assign & refer.
check('admit question gated on direction Outbound and admitted == null',
  /referralAwaitingAnswer: Boolean\(referral && referral\.direction === 'Outbound' && referral\.admitted == null\)/.test(appSource)
  && !/referralAwaitingAnswer: Boolean\(referral\?\.packetSentAt/.test(appSource));
check('Today context lookups use Maps, not a find per card',
  /function followUpContext\(followUp: FollowUp\) \{\s*const partner = followUp\.partnerId \? partnerById\.get\(followUp\.partnerId\)/.test(appSource));
check('Done → Next step keeps the assignee', /caseId: followUp\.caseId,[\s\S]{0,200}assignedTo: followUp\.assignedTo,[\s\S]{0,40}kind: stepForm\.kind/.test(appSource));

// ─── Mine / Everyone (team basics) ──────────────────────────────────────────
const scopeFollowUps = [
  fu({ id: 's-mine', title: 'Mine', assignedTo: 'U1' }),
  fu({ id: 's-theirs', title: 'Theirs', assignedTo: 'u2' }),
  fu({ id: 's-nobody', title: 'Nobody' }),
  fu({ id: 's-case-theirs', title: 'Case theirs', caseId: 'c-assigned-u2' }),
  fu({ id: 's-case-mine', title: 'Case mine', caseId: 'c-assigned-u1' }),
  fu({ id: 's-override', title: 'Mine despite case', caseId: 'c-assigned-u2', assignedTo: 'u1' }),
  fu({ id: 's-old-theirs', title: 'Old theirs', dueOn: '2026-07-20', assignedTo: 'u2' }),
];
const scopeSections = today.buildTodaySections(scopeFollowUps, due, NOW, contextFor);
const scopeCaseAssignee = (caseId) => ({ 'c-assigned-u2': 'u2', 'c-assigned-u1': 'U1' })[caseId];
eq('defaultTodayScope: Everyone solo, Mine with staff', [today.defaultTodayScope(1), today.defaultTodayScope(2), today.defaultTodayScope(0)], ['everyone', 'mine', 'everyone']);
eq('cardAssignee: own assignee first, then the case assignee, lowercased', scopeSections.today.map((c) => today.cardAssignee(c, scopeCaseAssignee)), ['u1', 'u2', 'u1', 'u1', undefined, 'u2']);
const everyone = today.filterTodaySections(scopeSections, 'everyone', 'u1', scopeCaseAssignee);
check('Everyone is the unfiltered sections', everyone === scopeSections);
const mine = today.filterTodaySections(scopeSections, 'mine', 'U1', scopeCaseAssignee);
eq('Mine keeps my items and unowned ones, drops a teammate\'s and a case assigned to them', mine.today.map((c) => c.id), ['s-case-mine', 's-mine', 's-override', 's-nobody']);
eq('Mine filters OVERDUE the same way', mine.overdue.map((c) => c.id), []);
eq('partner cadence cards are nobody\'s and always show', mine.partnersDue.length, scopeSections.partnersDue.length);
check('the original sections are untouched', scopeSections.today.length === 6);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
