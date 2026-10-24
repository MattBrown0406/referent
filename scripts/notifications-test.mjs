#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'notifications-test');
const require = createRequire(import.meta.url);
const ts = require(path.join(repoRoot, 'node_modules', 'typescript'));
mkdirSync(tmpDir, { recursive: true });

const source = readFileSync(path.join(repoRoot, 'src/lib/notifications.ts'), 'utf8');
const appSource = readFileSync(path.join(repoRoot, 'App.tsx'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
writeFileSync(path.join(tmpDir, 'notifications.js'), js);

const nativeState = {
  permission: { granted: false, canAskAgain: true, ios: { status: 0 } },
  requestCount: 0,
  cancelCount: 0,
  dismissCount: 0,
  scheduled: [],
  responseListener: null,
  lastResponse: null,
};
const notificationsStub = `
const state = global.__notificationTestState;
exports.IosAuthorizationStatus = { AUTHORIZED: 2, PROVISIONAL: 3, EPHEMERAL: 4 };
exports.AndroidImportance = { DEFAULT: 3 };
exports.SchedulableTriggerInputTypes = { DAILY: 'daily', DATE: 'date' };
exports.setNotificationHandler = () => undefined;
exports.setNotificationChannelAsync = async () => undefined;
exports.getPermissionsAsync = async () => state.permission;
exports.requestPermissionsAsync = async () => { state.requestCount += 1; return state.permission; };
exports.cancelAllScheduledNotificationsAsync = async () => { state.cancelCount += 1; state.scheduled = []; };
exports.dismissAllNotificationsAsync = async () => { state.dismissCount += 1; };
exports.scheduleNotificationAsync = async (request) => { state.scheduled.push(request); return String(state.scheduled.length); };
exports.addNotificationResponseReceivedListener = (listener) => { state.responseListener = listener; return { remove() {} }; };
exports.getLastNotificationResponseAsync = async () => state.lastResponse;
exports.clearLastNotificationResponseAsync = async () => { state.lastResponse = null; };
`;
writeFileSync(path.join(tmpDir, 'expo-notifications.js'), notificationsStub);
writeFileSync(path.join(tmpDir, 'react-native.js'), 'exports.Platform = { OS: "ios" };');

global.__notificationTestState = nativeState;
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'expo-notifications') return path.join(tmpDir, 'expo-notifications.js');
  if (request === 'react-native') return path.join(tmpDir, 'react-native.js');
  return originalResolve.call(this, request, ...args);
};

const notifications = require(path.join(tmpDir, 'notifications.js'));
const ios = require(path.join(tmpDir, 'expo-notifications.js')).IosAuthorizationStatus;

assert.equal(notifications.permissionAllowsNotifications({ granted: true, canAskAgain: false }), true);
for (const status of [ios.AUTHORIZED, ios.PROVISIONAL, ios.EPHEMERAL]) {
  assert.equal(notifications.permissionAllowsNotifications({ granted: false, canAskAgain: false, ios: { status } }), true);
}
assert.equal(notifications.permissionAllowsNotifications({ granted: false, canAskAgain: true, ios: { status: 0 } }), false);
assert.match(appSource, /notificationPromptKey/);
assert.match(appSource, /notificationScheduleKey/);
assert.match(appSource, /await activateReferralFitNotificationOwner\(userId\);[\s\S]{0,180}await hydrate\(userId\)/, 'account transition must invalidate and cancel old schedules before hydration');
assert.match(appSource, /notificationPermissionState === 'blocked'/, 'blocked users need an in-app Settings route');

nativeState.permission = { granted: false, canAskAgain: false, ios: { status: 0 } };
assert.equal(await notifications.getNotificationPermissionState(), 'blocked');
assert.equal(await notifications.requestNotificationPermission(), false);
assert.equal(nativeState.requestCount, 0, 'blocked permission must not be requested again');

nativeState.permission = { granted: false, canAskAgain: true, ios: { status: 0 } };
assert.equal(await notifications.getNotificationPermissionState(), 'askable');
await notifications.requestNotificationPermission();
assert.equal(nativeState.requestCount, 1, 'askable permission is requested only through the explicit request API');

const now = new Date(2026, 6, 24, 10, 0, 0);
const followUps = [
  { id: 'overdue', title: 'Overdue', dueOn: '2026-07-22', status: 'open', note: '' },
  { id: 'snoozed', title: 'Snoozed', dueOn: '2026-07-20', snoozedUntil: '2026-07-30', status: 'open', note: '' },
  { id: 'done', title: 'Done', dueOn: '2026-07-20', status: 'done', note: '' },
];
assert.deepEqual(notifications.followUpsDue(followUps, now).map((item) => item.id), ['overdue']);

const partner = (id, name) => ({
  id, name, organization: name, type: 'Other', city: '', state: '', regions: [], phone: '', email: '',
  cashMin: 0, cashMax: 0, insurance: [], therapies: [], populations: [], levels: [], note: '',
  inbound: 0, outbound: 0, lastContact: '2020-01-01', touchCadenceDays: 30,
});
nativeState.permission = { granted: true, canAskAgain: false, ios: { status: ios.AUTHORIZED } };
nativeState.scheduled = [];
await notifications.activateReferralFitNotificationOwner('user-a');
const first = notifications.rescheduleNotifications({ partners: [partner('a', 'Account A')], referrals: [], referralMatches: [], followUps: [] }, 'user-a');
await notifications.activateReferralFitNotificationOwner('user-b');
const second = notifications.rescheduleNotifications({ partners: [partner('b', 'Account B')], referrals: [], referralMatches: [], followUps: [] }, 'user-b');
await Promise.all([first, second]);
const scheduledPartners = nativeState.scheduled.map((item) => item.content.data.partnerId).filter(Boolean);
assert.equal(scheduledPartners.includes('a'), false, 'superseded schedule must not survive replacement');
assert.equal(scheduledPartners.includes('b'), true, 'latest schedule must be installed');
assert.equal(nativeState.scheduled.some((item) => /Account [AB]/.test(`${item.content.title} ${item.content.body}`)), false, 'a partner name never reaches the lock screen');

await notifications.cancelReferralFitNotifications();
assert.equal(nativeState.scheduled.length, 0, 'sign-out cancellation removes app schedules');
assert.ok(nativeState.dismissCount > 0, 'account transitions dismiss delivered account notifications');

const targets = [];
await notifications.activateReferralFitNotificationOwner('user-b');
const unsubscribe = notifications.subscribeToNotificationResponses((target, partnerId) => targets.push([target, partnerId]));
nativeState.responseListener({ notification: { request: { identifier: 'tap-stale', content: { data: { target: 'directory', partnerId: 'a', ownerId: 'user-a' } } } } });
nativeState.responseListener({ notification: { request: { identifier: 'tap-1', content: { data: { target: 'directory', partnerId: 'b', ownerId: 'user-b' } } } } });
nativeState.responseListener({ notification: { request: { identifier: 'tap-1', content: { data: { target: 'directory', partnerId: 'b', ownerId: 'user-b' } } } } });
assert.deepEqual(targets, [['directory', 'b']], 'notification partner deep-link is delivered once');
unsubscribe();

// Server-sent pushes carry { kind, user_id, ...ids } and nothing else; a tap
// is honored only for the account it was addressed to.
const remote = [];
const unsubscribeRemote = notifications.subscribeToNotificationResponses((target, partnerId, caseId) => remote.push([target, partnerId, caseId]));
nativeState.responseListener({ notification: { request: { identifier: 'push-stale', content: { data: { kind: 'new_lead', user_id: 'user-a', case_id: 'c1' } } } } });
nativeState.responseListener({ notification: { request: { identifier: 'push-1', content: { data: { kind: 'assigned_to_me', user_id: 'USER-B', case_id: 'c1', follow_up_id: 'f1' } } } } });
nativeState.responseListener({ notification: { request: { identifier: 'push-1', content: { data: { kind: 'assigned_to_me', user_id: 'user-b', case_id: 'c1' } } } } });
nativeState.responseListener({ notification: { request: { identifier: 'push-2', content: { data: { kind: 'directory_decision', user_id: 'user-b', global_partner_id: 'g1' } } } } });
nativeState.responseListener({ notification: { request: { identifier: 'push-3', content: { data: { kind: 'overdue_mine', user_id: 'user-b' } } } } });
nativeState.responseListener({ notification: { request: { identifier: 'push-4', content: { data: { kind: 'something_else', user_id: 'user-b' } } } } });
assert.deepEqual(remote, [['case', undefined, 'c1'], ['workspace', undefined, undefined], ['home', undefined, undefined]], 'server-sent pushes deep-link once, only for the addressed account');
assert.deepEqual(notifications.remotePushTarget({ kind: 'new_lead' }), { target: 'home' }, 'a lead push without a case id lands on Today');
unsubscribeRemote();

// ─── Reminders follow Today's Mine rule ─────────────────────────────────────
// Assigned to me, or to nobody (and its case assigned to me or to nobody).
const ME = 'aaaaaaaa-1111-4111-8111-111111111111';
const MATE = 'bbbbbbbb-2222-4222-8222-222222222222';
const stamp = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
const mineFollowUps = [
  { id: 'f-mine', title: 'Mine', dueOn: stamp(tomorrow), status: 'open', note: '', assignedTo: ME },
  { id: 'f-mate', title: 'Teammate', dueOn: stamp(tomorrow), status: 'open', note: '', assignedTo: MATE },
  { id: 'f-nobody', title: 'Nobody', dueOn: stamp(tomorrow), status: 'open', note: '' },
  { id: 'f-mate-case', title: 'Teammate case', dueOn: stamp(tomorrow), status: 'open', note: '', caseId: 'c-mate' },
  { id: 'f-my-case', title: 'My case', dueOn: stamp(tomorrow), status: 'open', note: '', caseId: 'c-me' },
  { id: 'f-mate-consult', title: 'Teammate consult', kind: 'consult', dueTime: '15:00', dueOn: stamp(tomorrow), status: 'open', note: '', assignedTo: MATE },
  { id: 'f-my-consult', title: 'My consult', kind: 'consult', dueTime: '15:00', dueOn: stamp(tomorrow), status: 'open', note: '', assignedTo: ME.toUpperCase() },
];
const mineCases = [{ id: 'c-mate', assignedTo: MATE }, { id: 'c-me', assignedTo: ME }];
assert.equal(notifications.followUpIsMine(mineFollowUps[0], ME, () => undefined), true);
assert.equal(notifications.followUpIsMine(mineFollowUps[1], ME, () => undefined), false);
assert.equal(notifications.followUpIsMine(mineFollowUps[3], ME, (id) => (id === 'c-mate' ? MATE : undefined)), false);
assert.deepEqual(
  notifications.reminderFollowUps({ partners: [], referrals: [], referralMatches: [], followUps: mineFollowUps, cases: mineCases }, ME).map((item) => item.id),
  ['f-mine', 'f-nobody', 'f-my-case', 'f-my-consult'],
  'a teammate’s follow-ups and consults never remind this user',
);
assert.equal(
  notifications.reminderFollowUps({ partners: [], referrals: [], referralMatches: [], followUps: mineFollowUps, cases: mineCases, scope: 'everyone' }, ME).length,
  mineFollowUps.length,
  "scope 'everyone' keeps every open follow-up",
);

// The user's own reminders are scheduled before partner cadence nags, so a
// long list of partners past cadence cannot use up every slot.
nativeState.scheduled = [];
await notifications.activateReferralFitNotificationOwner(ME);
const coldPartners = Array.from({ length: 20 }, (_, index) => partner(`cold-${index}`, `Cold ${index}`));
await notifications.rescheduleNotifications({ partners: coldPartners, referrals: [], referralMatches: [], followUps: mineFollowUps, cases: mineCases }, ME);
const titles = nativeState.scheduled.map((item) => item.content.title);
const reminderBodies = nativeState.scheduled.filter((item) => item.content.title === 'Follow-up due').map((item) => item.content.body);
assert.deepEqual(reminderBodies, [notifications.GENERIC_FOLLOW_UP_BODY, notifications.GENERIC_FOLLOW_UP_BODY, notifications.GENERIC_FOLLOW_UP_BODY], 'every one of my follow-ups is scheduled despite 20 overdue partners');
assert.deepEqual(nativeState.scheduled.filter((item) => item.content.title === 'Consult in 30 minutes').map((item) => item.content.body), ['Consult at 3:00 PM'], 'a consult says only when');
assert.equal(nativeState.scheduled.length, 50, 'the cap still holds');
assert.ok(titles.lastIndexOf('Follow-up due') < titles.indexOf('ReferralFit'), 'cadence nags only fill what is left');
assert.equal(nativeState.scheduled.some((item) => /Teammate/.test(item.content.body)), false);

// Lock-screen privacy: no follow-up title (they carry family names), partner
// name, or organization in any title or body. Counts and times only.
{
  const named = [
    ...mineFollowUps.map((item) => item.title),
    ...coldPartners.map((item) => item.name),
    'Henderson', 'Riverstone',
  ];
  nativeState.scheduled = [];
  const henderson = { id: 'f-henderson', title: 'Call back — Henderson family', dueOn: stamp(tomorrow), status: 'open', note: '', partnerId: 'riverstone', assignedTo: ME };
  const riverstone = { ...partner('riverstone', 'Riverstone Recovery'), organization: 'Riverstone Recovery', touchCadenceDays: 30 };
  await notifications.rescheduleNotifications({ partners: [...coldPartners.slice(0, 3), riverstone], referrals: [], referralMatches: [], followUps: [...mineFollowUps, henderson], cases: mineCases }, ME);
  assert.ok(nativeState.scheduled.length > 5);
  for (const item of nativeState.scheduled) {
    const text = `${item.content.title} ${item.content.body}`;
    for (const name of named) assert.equal(text.includes(name), false, `"${text}" must not name "${name}"`);
  }
  assert.ok(nativeState.scheduled.some((item) => item.content.body.startsWith('Time to reach out to a referral partner')), 'cadence nags are generic');
  const source = readFileSync(path.join(repoRoot, 'src/lib/notifications.ts'), 'utf8');
  assert.doesNotMatch(source, /body: `\$\{followUp\.title\}|\$\{partner\.(name|organization)\}|followUpBody/, 'no notification body is built from a title or a partner name');
}

// Closing a case (or losing a lead) skips the steps open on it then, so they
// stop reminding; a placement check-in on it still reminds. A step scheduled
// on the case after it closed is open and reminds like any other: the case's
// status is not a filter. todayLoad (the header count) agrees.
{
  nativeState.scheduled = [];
  const closedCases = [{ id: 'c-closed', status: 'closed' }, { id: 'c-lost', status: 'lost' }, { id: 'c-open', status: 'engaged' }];
  const closedFollowUps = [
    { id: 'f-closed', title: 'Closed', dueOn: stamp(tomorrow), status: 'skipped', note: '', caseId: 'c-closed', assignedTo: ME },
    { id: 'f-lost-consult', title: 'Lost consult', kind: 'consult', dueTime: '15:00', dueOn: stamp(tomorrow), status: 'skipped', note: '', caseId: 'c-lost', assignedTo: ME },
    { id: 'f-check-in', title: 'Check-in', kind: 'check_in', dueOn: stamp(tomorrow), status: 'open', note: '', caseId: 'c-closed', referralId: 'r1', assignedTo: ME },
    { id: 'f-call-back', title: 'Call back — lost lead', kind: 'promised_call', dueOn: stamp(tomorrow), status: 'open', note: '', caseId: 'c-lost', assignedTo: ME },
    { id: 'f-open', title: 'Open case', dueOn: stamp(tomorrow), status: 'open', note: '', caseId: 'c-open', assignedTo: ME },
  ];
  const input = { partners: [], referrals: [], referralMatches: [], followUps: closedFollowUps, cases: closedCases };
  assert.deepEqual(notifications.reminderFollowUps(input, ME).map((item) => item.id), ['f-check-in', 'f-call-back', 'f-open'], 'skipped steps drop out; check-ins and steps scheduled after the close stay');
  assert.deepEqual(notifications.reminderFollowUps({ ...input, scope: 'everyone' }, ME).map((item) => item.id), ['f-check-in', 'f-call-back', 'f-open'], 'in every scope');
  await notifications.rescheduleNotifications(input, ME);
  assert.equal(nativeState.scheduled.filter((item) => item.content.title === 'Follow-up due').length, 3);
  assert.equal(nativeState.scheduled.filter((item) => item.content.title === 'Consult in 30 minutes').length, 0, 'no consult alert for a skipped consult');
  const dueNow = closedFollowUps.map((item) => ({ ...item, dueOn: stamp(new Date()) }));
  assert.equal(notifications.todayLoad(dueNow, [], new Date()).actions, 3, 'the header count skips skipped steps, not a case by its status');
}

// Overdue follow-ups collapse into ONE summary at 9:00 instead of each firing
// at once; future ones keep their own reminder; cadence nags still come last.
{
  nativeState.scheduled = [];
  await notifications.activateReferralFitNotificationOwner(ME);
  const longAgo = new Date();
  longAgo.setDate(longAgo.getDate() - 5);
  const overdue = Array.from({ length: 30 }, (_, index) => ({ id: `od-${index}`, title: `Overdue ${index}`, dueOn: stamp(longAgo), status: 'open', note: '', assignedTo: ME }));
  const future = { id: 'later', title: 'Later', dueOn: stamp(tomorrow), status: 'open', note: '', assignedTo: ME };
  await notifications.rescheduleNotifications({ partners: coldPartners.slice(0, 2), referrals: [], referralMatches: [], followUps: [...overdue, future], cases: [] }, ME);
  const summaries = nativeState.scheduled.filter((item) => item.content.title === 'Follow-ups due');
  assert.equal(summaries.length, 1, 'one summary for every overdue follow-up');
  assert.equal(summaries[0].content.body, '30 overdue follow-ups');
  const nine = summaries[0].trigger.date;
  assert.equal(nine.getHours(), 9);
  assert.equal(nativeState.scheduled.filter((item) => item.content.title === 'Follow-up due').map((item) => item.content.body).join(), notifications.GENERIC_FOLLOW_UP_BODY, 'a future follow-up keeps its own reminder');
  const order = nativeState.scheduled.map((item) => item.content.title);
  assert.ok(order.indexOf('ReferralFit') > order.indexOf('Follow-up due'), 'cadence nags after the user’s own items');
  assert.equal(nativeState.scheduled.length, 1 + 1 + 1 + 2 * 3, 'briefing + summary + future + nags');

  nativeState.scheduled = [];
  await notifications.rescheduleNotifications({ partners: [], referrals: [], referralMatches: [], followUps: [overdue[0]], cases: [] }, ME);
  assert.deepEqual(nativeState.scheduled.filter((item) => /^Follow-up/.test(item.content.title)).map((item) => [item.content.title, item.content.body]), [['Follow-up due', notifications.GENERIC_FOLLOW_UP_BODY]], 'a single overdue item reads as one generic reminder');
}

// A tap that launches the app (cold start) arrives before any account is
// active. It is held and delivered once that same account becomes active.
{
  await notifications.cancelReferralFitNotifications(); // no owner, as at launch
  const coldTargets = [];
  nativeState.lastResponse = { notification: { request: { identifier: 'cold-1', content: { data: { kind: 'assigned_to_me', user_id: ME, case_id: 'case-cold' } } } } };
  const unsubscribeCold = notifications.subscribeToNotificationResponses((target, partnerId, caseId) => coldTargets.push([target, partnerId, caseId]));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(coldTargets, [], 'nothing is opened before the account is known');
  assert.equal(nativeState.lastResponse, null, 'the OS copy is cleared once it is held in memory');
  // A local reminder tapped for another account is never delivered.
  nativeState.responseListener({ notification: { request: { identifier: 'cold-other', content: { data: { target: 'directory', partnerId: 'p-other', ownerId: MATE } } } } });
  await notifications.activateReferralFitNotificationOwner(ME);
  assert.deepEqual(coldTargets, [['case', undefined, 'case-cold']], 'delivered once the same account is active, and only for it');
  await notifications.activateReferralFitNotificationOwner(ME);
  assert.equal(coldTargets.length, 1, 'never delivered twice');
  unsubscribeCold();

  // A held tap for one account is not delivered to a different account.
  await notifications.cancelReferralFitNotifications();
  const wrongTargets = [];
  const unsubscribeWrong = notifications.subscribeToNotificationResponses((target, partnerId, caseId) => wrongTargets.push([target, partnerId, caseId]));
  nativeState.responseListener({ notification: { request: { identifier: 'cold-2', content: { data: { target: 'directory', partnerId: 'p-1', ownerId: MATE } } } } });
  await notifications.activateReferralFitNotificationOwner(ME);
  assert.deepEqual(wrongTargets, []);
  unsubscribeWrong();
}

// ─── Cadence counts calendar days in the device's time zone ────────────────
{
  const previousTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    const at = new Date(2026, 9, 23, 10, 0, 0); // Oct 23, 10:00 local
    const contacted = { ...partner('tz', 'TZ'), lastContact: '2026-10-20', touchCadenceDays: 3 };
    // 3 days since Oct 20: cadence reached today, not yet past it.
    assert.deepEqual(notifications.partnersGoingCold([contacted], at), [], 'a YYYY-MM-DD stamp is a local day, not UTC midnight');
    assert.equal(notifications.todayLoad([], [contacted], at).actions, 1, 'cadence reached today counts, like Today');
    assert.equal(notifications.todayLoad([], [{ ...contacted, touchCadenceDays: 4 }], at).actions, 0, 'one day before cadence is not due');
    assert.deepEqual(notifications.partnersGoingCold([{ ...contacted, touchCadenceDays: 2 }], at).map((entry) => [entry.daysSince, entry.overdueBy]), [[3, 1]]);
  } finally {
    if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz;
  }
}

console.log('notification permission/scheduling/deep-link regression checks: ok');
