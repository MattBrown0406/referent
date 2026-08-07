import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [packageJson, packageLock] = await Promise.all([
  readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../package-lock.json', import.meta.url), 'utf8').then(JSON.parse),
]);

const expected = {
  expo: '57.0.8',
  expoFileSystem: '57.0.1',
  expoModulesCore: '57.0.7',
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

console.log(
  `Native Expo compatibility: PASS (expo ${expected.expo}, expo-file-system ${expected.expoFileSystem}, expo-modules-core ${expected.expoModulesCore})`,
);
