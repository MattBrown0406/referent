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
console.log(`All ${passed} identifying-text checks passed.`);
