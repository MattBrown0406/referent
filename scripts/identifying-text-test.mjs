// identifyingTextProblem against the shared case list
// (scripts/fixtures/identifying-text-cases.json), which the SQL twin
// public.identifying_text_problem is tested against too.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'identifying-text-test');
mkdirSync(tmpDir, { recursive: true });
const source = readFileSync(path.join(repoRoot, 'src/lib/identifying-text.ts'), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
writeFileSync(path.join(tmpDir, 'identifying-text.js'), output);
const require = createRequire(import.meta.url);
const { identifyingTextProblem, nameWords } = require(path.join(tmpDir, 'identifying-text.js'));

const fixture = JSON.parse(readFileSync(path.join(repoRoot, 'scripts/fixtures/identifying-text-cases.json'), 'utf8'));
let passed = 0;
for (const { text, expect } of fixture.cases) {
  const problem = identifyingTextProblem(text, fixture.names);
  if (expect === null) assert.equal(problem, null, `allowed: ${JSON.stringify(text)} (got ${problem})`);
  else assert.ok(problem && problem.toLowerCase().includes(expect), `refused as ${expect}: ${JSON.stringify(text)} (got ${problem})`);
  passed += 1;
}
assert.deepEqual(nameWords(['Rivera family — son Jake']).sort(), ['jake', 'rivera']);
passed += 1;
// A case title's ordinary words are never a name; the name in it still is.
assert.deepEqual(nameWords(['Rivera intervention', "Lopez family's first call", 'New inquiry - detox follow-up']).sort(), ['lopez', 'rivera']);
passed += 1;
// The pgTAP twin (supabase/tests/identifying_text_test.sql) runs every case
// of the fixture against public.identifying_text_problem, with the same
// names list. Hidden characters are labelled <U+XXXX> there.
const pgtap = readFileSync(path.join(repoRoot, 'supabase/tests/identifying_text_test.sql'), 'utf8');
const sqlText = (value) => value.replace(/'/g, "''");
assert.ok(pgtap.includes(`(ARRAY[${fixture.names.map((name) => `'${sqlText(name)}'`).join(', ')}])::text`), 'the pgTAP test uses the fixture\'s names list');
passed += 1;
for (const { text, expect } of fixture.cases) {
  // eslint-disable-next-line no-control-regex
  const label = text.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, (char) => `<U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`);
  const name = expect === null ? `allowed: ${label}` : `refused as ${expect}: ${label}`;
  assert.ok(pgtap.includes(`'${sqlText(name)}');`), `the pgTAP test runs the fixture case ${JSON.stringify(text)}`);
  passed += 1;
}
console.log(`All ${passed} identifying-text checks passed.`);
