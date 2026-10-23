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
const bodies = nativeState.scheduled.map((item) => item.content.body);
assert.equal(bodies.some((body) => body.includes('Account A')), false, 'superseded schedule must not survive replacement');
assert.equal(bodies.some((body) => body.includes('Account B')), true, 'latest schedule must be installed');

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
const reminderBodies = nativeState.scheduled.filter((item) => item.content.title === 'Follow-up due').map((item) => item.content.body).sort();
assert.deepEqual(reminderBodies, ['Mine', 'My case', 'Nobody'], 'every one of my follow-ups is scheduled despite 20 overdue partners');
assert.deepEqual(nativeState.scheduled.filter((item) => item.content.title === 'Consult in 30 minutes').map((item) => item.content.body), ['My consult · 15:00']);
assert.equal(nativeState.scheduled.length, 50, 'the cap still holds');
assert.ok(titles.lastIndexOf('Follow-up due') < titles.indexOf('ReferralFit'), 'cadence nags only fill what is left');
assert.equal(nativeState.scheduled.some((item) => /Teammate/.test(item.content.body)), false);

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
