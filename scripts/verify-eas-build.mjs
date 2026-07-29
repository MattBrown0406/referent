#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const [file, expectedSha] = process.argv.slice(2);
if (!file || !expectedSha) {
  console.error('usage: verify-eas-build.mjs <build-list.json> <merged-sha>');
  process.exit(2);
}

const builds = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(builds) || builds.length !== 1) {
  throw new Error(`Expected exactly one matching EAS build; found ${Array.isArray(builds) ? builds.length : 'invalid JSON'}.`);
}
const build = builds[0];
const expected = {
  status: 'FINISHED',
  platform: 'IOS',
  distribution: 'STORE',
  buildProfile: 'production',
  appVersion: '1.0.1',
  appBuildVersion: '10',
  gitCommitHash: expectedSha,
};
for (const [key, value] of Object.entries(expected)) {
  if (build[key] !== value) throw new Error(`EAS build ${key} mismatch: expected ${value}, got ${build[key]}.`);
}
if (typeof build.id !== 'string' || !build.id) throw new Error('EAS build ID is missing.');
process.stdout.write(build.id);
