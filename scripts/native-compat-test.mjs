import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [packageJson, packageLock] = await Promise.all([
  readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../package-lock.json', import.meta.url), 'utf8').then(JSON.parse),
]);

const expected = {
  expo: '57.0.8',
  expoCrypto: '57.0.1',
  expoFileSystem: '57.0.1',
  expoFont: '57.0.1',
  expoModulesCore: '57.0.7',
  expoSecureStore: '57.0.1',
  expoSms: '57.0.1',
  expoMailComposer: '57.0.1',
  // The version expo 57.0.8 bundles (bundledNativeModules.json). Later 57.0.x
  // prebuilds link symbols expo-modules-core 57.0.7 lacks (a launch crash).
  expoContacts: '57.0.2',
};

assert.equal(
  packageJson.dependencies.expo,
  expected.expo,
  'Expo must be upgraded intentionally together with its native modules.',
);
assert.equal(
  packageJson.dependencies['expo-file-system'],
  expected.expoFileSystem,
  'expo-file-system must remain exactly pinned; a patch-level float caused the build 16 launch crash.',
);
assert.equal(
  packageLock.packages[''].dependencies['expo-file-system'],
  expected.expoFileSystem,
  'The root lockfile dependency must match the exact expo-file-system pin.',
);
assert.equal(
  packageLock.packages['node_modules/expo-file-system'].version,
  expected.expoFileSystem,
  'The installed expo-file-system version must match the known-compatible pin.',
);
assert.equal(
  packageLock.packages['node_modules/expo-modules-core'].version,
  expected.expoModulesCore,
  'expo-modules-core must be upgraded intentionally with the native Expo dependency set.',
);

for (const [packageName, expectedVersion] of [
  ['expo-crypto', expected.expoCrypto],
  ['expo-font', expected.expoFont],
  ['expo-secure-store', expected.expoSecureStore],
  // Follow-up outreach: the Messages / Mail compose sheets. Same native cohort.
  ['expo-sms', expected.expoSms],
  ['expo-mail-composer', expected.expoMailComposer],
  // Partner import: iOS's contact picker only (no address book access).
  ['expo-contacts', expected.expoContacts],
]) {
  assert.equal(
    packageJson.dependencies[packageName],
    expectedVersion,
    `${packageName} must remain exactly pinned after the iOS launch-time symbol mismatch.`,
  );
  assert.equal(
    packageLock.packages[`node_modules/${packageName}`].version,
    expectedVersion,
    `${packageName} lockfile version must match the known-compatible native pin.`,
  );
}

// Every prebuilt Expo module must be the version this expo release bundles:
// a newer prebuild can reference expo-modules-core symbols the pinned core
// does not have, and iOS kills the app at launch (expo-contacts 57.0.8 did).
const bundled = JSON.parse(await readFile(new URL('../node_modules/expo/bundledNativeModules.json', import.meta.url), 'utf8'));
for (const name of ['expo-contacts']) {
  const range = bundled[name] || '';
  const base = range.replace(/^[~^]/, '');
  assert.equal(packageJson.dependencies[name], base, `${name} must be the version expo bundles (${range}), not a later prebuild`);
}

console.log(
  `Native Expo compatibility: PASS (expo ${expected.expo}; crypto/font/file-system/secure-store 57.0.1; expo-modules-core ${expected.expoModulesCore})`,
);
