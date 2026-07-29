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

console.log('notification permission/scheduling/deep-link regression checks: ok');
