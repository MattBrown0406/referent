// npm audit gate with a documented allowlist for advisories that have no
// patched release. Fails (exit 1) on any high/critical advisory that is not
// explicitly allowlisted, so new advisories still block CI.
//
// Review the allowlist whenever it triggers: remove entries as soon as a
// patched version ships upstream.

import { execSync } from 'node:child_process';

const ALLOWLIST = new Map([
  // image-size (transitive: expo → @expo/metro → metro). DoS via crafted
  // ICNS/JXL/HEIF images; no patched version exists (vulnerable <= 2.0.2,
  // first_patched_version: null as of 2026-08-19). Dev/build-time bundler
  // dependency only — it does not ship in the app binary.
  ['GHSA-w3rx-r6r6-pgpr', 'image-size ICNS infinite loop — no patched release'],
  ['GHSA-5p2g-fcmc-qvqq', 'image-size JXL/HEIF infinite loops — no patched release'],
]);

let report;
try {
  report = JSON.parse(execSync('npm audit --json', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
} catch (error) {
  // npm audit exits non-zero when vulnerabilities exist; the JSON is still on stdout.
  if (!error.stdout) throw error;
  report = JSON.parse(error.stdout);
}

const failures = [];
const allowed = [];
for (const [name, vulnerability] of Object.entries(report.vulnerabilities || {})) {
  if (!['high', 'critical'].includes(vulnerability.severity)) continue;
  const advisories = (vulnerability.via || []).filter((via) => typeof via === 'object');
  if (advisories.length === 0) continue; // transitive rollup; the root advisory is reported on its own package
  for (const advisory of advisories) {
    const ghsa = (advisory.url || '').split('/').pop() || '';
    if (ALLOWLIST.has(ghsa)) {
      allowed.push(`${name}: ${ghsa} (${ALLOWLIST.get(ghsa)})`);
    } else {
      failures.push(`${name} [${vulnerability.severity}]: ${advisory.title} — ${advisory.url}`);
    }
  }
}

for (const entry of [...new Set(allowed)]) console.log(`ALLOWLISTED  ${entry}`);
if (failures.length) {
  for (const entry of [...new Set(failures)]) console.error(`BLOCKING     ${entry}`);
  console.error(`\n${failures.length} high/critical advisories are not allowlisted.`);
  process.exit(1);
}
console.log('Audit gate passed.');
