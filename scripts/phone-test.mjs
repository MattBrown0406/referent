// Phone normalization/matching fixture test — runs the real src/lib/phone.ts
// in plain node (transpiled on the fly with the repo's typescript package,
// same pattern as scripts/packet-test.mjs). Prints PASS/FAIL per fixture.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'phone-test');
const require = createRequire(import.meta.url);
const ts = require(path.join(repoRoot, 'node_modules', 'typescript'));

const source = readFileSync(path.join(repoRoot, 'src/lib/phone.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
mkdirSync(tmpDir, { recursive: true });
writeFileSync(path.join(tmpDir, 'phone.js'), js);

const { normalizePhone, phoneDigits, phoneMatchesQuery, phoneSearchSuffix } = require(path.join(tmpDir, 'phone.js'));

let failures = 0;
function check(label, actual, expected) {
  const pass = actual === expected;
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}  → ${JSON.stringify(actual)}${pass ? '' : ` (expected ${JSON.stringify(expected)})`}`);
}

console.log('— normalizePhone (mirrors the phone_e164 generated column) —');
check("'(541) 555-0142'", normalizePhone('(541) 555-0142'), '5415550142');
check("'+1 541.555.0142'", normalizePhone('+1 541.555.0142'), '+15415550142');
check("'  541-555-0142 x9'", normalizePhone('  541-555-0142 x9'), '54155501429');

console.log('\n— matching (last-N-digits semantics) —');
// Stored as '+15415550142' (masked here the way the brief masks it).
const stored = '+15415550142';
check("full local '(541) 555-0142' matches stored '+154****0142'", phoneMatchesQuery('(541) 555-0142', stored), true);
check("last-4 query '0142' matches", phoneMatchesQuery('0142', stored), true);
check("last-7 query '5550142' matches", phoneMatchesQuery('5550142', stored), true);
check("with + typed '+1 (541) 555-0142' matches", phoneMatchesQuery('+1 (541) 555-0142', stored), true);
check('unrelated number (503) 555-8899 → no match', phoneMatchesQuery('(503) 555-8899', stored), false);
check('unrelated last-4 8899 → no match', phoneMatchesQuery('8899', stored), false);
check('3-digit query too short → no match', phoneMatchesQuery('142', stored), false);
check('empty query → no match', phoneMatchesQuery('', stored), false);
check('letters-only query → no match', phoneMatchesQuery('mom', stored), false);

console.log('\n— phoneDigits —');
check("phoneDigits('+1 (541) 555-0142')", phoneDigits('+1 (541) 555-0142'), '15415550142');

console.log('\n— server suffix clause —');
check("phoneSearchSuffix('(541) 555-0142')", phoneSearchSuffix('(541) 555-0142'), '%5415550142');
check("phoneSearchSuffix('0142')", phoneSearchSuffix('0142'), '%0142');
check("phoneSearchSuffix('mom')", phoneSearchSuffix('mom'), null);
check("phoneSearchSuffix('142')", phoneSearchSuffix('142'), null);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
