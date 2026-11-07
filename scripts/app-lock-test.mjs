// "Lock with Face ID" and the app-switcher cover (modules/app-lock, iOS only):
// source invariants. The behaviour itself was checked on an iOS simulator
// (docs/APP_LOCK.md); these keep the parts that make it safe from drifting.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(repoRoot, file), 'utf8');

const swift = read('modules/app-lock/ios/AppLockModule.swift');
const config = JSON.parse(read('modules/app-lock/expo-module.config.json'));
const lockJs = read('src/lib/app-lock.ts');
const workspace = read('src/lib/WorkspaceScreen.tsx');
const entry = read('index.ts');
const appJson = JSON.parse(read('app.json'));

// The module is the one autolinking finds, and iOS has the Face ID text
// (without it iOS ends the app the first time Face ID is asked for).
assert.deepEqual(config.apple.modules, ['AppLockModule'], 'expo-module.config.json names the Swift module');
const secureStore = appJson.expo.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-secure-store');
assert.ok(secureStore && typeof secureStore[1].faceIDPermission === 'string' && secureStore[1].faceIDPermission.includes('Face ID'),
  'app.json sets NSFaceIDUsageDescription (expo-secure-store faceIDPermission false would delete it)');

// The cover: its own window, above every sheet and alert, up before the
// snapshot, and before anything draws when the lock is on.
for (const text of [
  'UIApplication.willResignActiveNotification',
  'UIApplication.didEnterBackgroundNotification',
  'UIApplication.willEnterForegroundNotification',
  'UIApplication.didBecomeActiveNotification',
  // React Native's Alert.alert windows sit at .alert + 1.
  'cover.windowLevel = .alert + 2',
  'AppLockWindow(windowScene: scene)',
  'override var canBecomeKey: Bool { false }',
  'view.accessibilityViewIsModal = true',
  // VoiceOver: the app's own windows are hidden while locked, restored after.
  'other.accessibilityElementsHidden = true',
  'entry.window?.accessibilityElementsHidden = false',
]) assert.ok(swift.includes(text), `AppLockModule.swift missing: ${text}`);
assert.ok(/@objc private func willResignActive\(\) \{[\s\S]{0,120}show\(\)/.test(swift), 'the cover goes up on willResignActive, before the snapshot');
assert.ok(/if Self\.enabled \{\s*lock\(\)/.test(swift), 'a launch with the lock on starts locked and covered');
assert.ok(/private func lock\(\) \{\s*locked = true\s*endEditing\(\)\s*show\(\)/.test(swift), 'locking ends typing and puts the cover up');
assert.ok((swift.match(/locked = true/g) || []).length === 1, 'every lock goes through lock()');
assert.ok(swift.includes('#selector(UIResponder.resignFirstResponder)'), 'the field behind the lock gives up the keyboard');
assert.ok(/@objc private func keyboardWillShow\(\) \{\s*if locked, !authenticating \{ endEditing\(\) \}/.test(swift), 'and a field that takes focus while locked gives it up again, except during Face ID');

// The lock: Face ID or the passcode; time away by uptime; one automatic
// prompt per return; never a lock that nothing can open.
assert.ok(swift.includes('.deviceOwnerAuthentication,') && !/evaluatePolicy\(\.deviceOwnerAuthenticationWithBiometrics/.test(swift),
  'unlock accepts the passcode as well as Face ID');
assert.ok(swift.includes('clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)') && !swift.includes('ProcessInfo.processInfo.systemUptime') && !swift.includes('Date()'),
  'time away is measured by a monotonic clock that counts while the phone sleeps (uptime stops), not the wall clock');
assert.ok(swift.includes('private var promptedThisVisit = false') && swift.includes('promptedThisVisit = false'), 'one automatic prompt per return');
assert.ok(/if authenticating \{ return \}/.test(swift), 'Face ID\'s own sheet does not re-trigger the lock');
assert.ok(/if ok \|\| error == "passcodeNotSet" \{[\s\S]{0,260}Self\.save\(enabled: false/.test(swift), 'no passcode: the lock turns itself off instead of shutting the person out');
assert.ok(/if !self\.locked, UIApplication\.shared\.applicationState == \.active \{ self\.hide\(\) \}/.test(swift),
  'the privacy cover Face ID raised comes down after turning the lock on');
assert.ok(/self\.locked = false[\s\S]{0,200}if UIApplication\.shared\.applicationState == \.active \{ self\.hide\(\) \}/.test(swift),
  'an unlock answered after the person left keeps the cover up for the app switcher');
assert.ok(/AsyncFunction\("enable"\)[\s\S]{0,200}authenticate\(reason: reason\)[\s\S]{0,120}if ok \{ AppLockController\.save\(enabled: true/.test(swift),
  'the lock is switched on only after Face ID or the passcode succeeded');

// JavaScript: iOS only, started before the first render, and the setting is
// hidden wherever there is no lock (the web app).
assert.ok(lockJs.includes("Platform.OS === 'ios' ? requireOptionalNativeModule<AppLockNative>('AppLock') : null"), 'the module is iOS only and optional');
assert.ok(entry.indexOf('startAppLock();') > 0 && entry.indexOf('startAppLock();') < entry.indexOf('registerRootComponent('), 'index.ts starts the lock before the app renders');
assert.ok(workspace.includes('{lock ? (') && workspace.includes('Privacy on this phone'), 'the Workspace card shows only where there is a lock');
assert.ok(/if \(!visible\) return undefined;\s*setLock\(appLockStatus\(\)\);[\s\S]{0,200}if \(state === 'active'\) setLock\(appLockStatus\(\)\);/.test(workspace),
  'the card reads the lock again on opening and on every return (a passcode set or removed in Settings)');
assert.ok(/async function toggleLock\(on: boolean\) \{[\s\S]{0,400}await enableAppLock\(/.test(workspace), 'turning it on goes through enableAppLock (Face ID first)');
assert.deepEqual(
  [...lockJs.matchAll(/\{ seconds: (\d+), label: '([^']+)' \}/g)].map((match) => [Number(match[1]), match[2]]),
  [[0, 'Every time'], [60, 'After 1 minute'], [300, 'After 5 minutes']],
  'the three lock-again choices',
);

console.log('app-lock-test: all checks passed');
