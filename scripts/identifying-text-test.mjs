// identifyingTextProblem against the shared case list
// (scripts/fixtures/identifying-text-cases.json), which the SQL twin
// public.identifying_text_problem is tested against too
// (supabase/tests/identifying_text_test.sql).
//
//   node scripts/identifying-text-test.mjs          run the checks
//   node scripts/identifying-text-test.mjs --write  rewrite the pgTAP file's
//                                                   fixture section (and its
//                                                   plan) from the fixture
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'identifying-text-test');
mkdirSync(tmpDir, { recursive: true });
const sourcePath = path.join(repoRoot, 'src/lib/identifying-text.ts');
const source = readFileSync(sourcePath, 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
writeFileSync(path.join(tmpDir, 'identifying-text.js'), output);
const require = createRequire(import.meta.url);
const { identifyingTextProblem, nameWords, labelInitials, IDENTIFYING_TEXT_RULES_VERSION } = require(path.join(tmpDir, 'identifying-text.js'));

const fixture = JSON.parse(readFileSync(path.join(repoRoot, 'scripts/fixtures/identifying-text-cases.json'), 'utf8'));
const pgtapPath = path.join(repoRoot, 'supabase/tests/identifying_text_test.sql');
const migrationPath = path.join(repoRoot, 'supabase/migrations/20261104140000_placement_requests.sql');

// ─── The pgTAP twin of each fixture case ────────────────────────────────────
// One line per case. Invisible characters (controls, format characters,
// separators, combining marks) are written with chr() in the SQL, and as
// <U+XXXX> in the test's name, so the file can be read.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Mn}\u3164\uffa0]/u;
function sqlString(value) {
  if (value === null) return 'NULL';
  const parts = [];
  let run = '';
  for (const char of value) {
    if (INVISIBLE.test(char)) {
      if (run) parts.push(`'${run.replace(/'/g, "''")}'`);
      run = '';
      parts.push(`chr(${char.codePointAt(0)})`);
    } else {
      run += char;
    }
  }
  if (run || !parts.length) parts.push(`'${run.replace(/'/g, "''")}'`);
  return parts.join(' || ');
}
function shown(value) {
  return Array.from(value, (char) => (INVISIBLE.test(char) ? `<U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>` : char)).join('');
}
const nameMessage = (word) => `Leave out names ("${word}" is a name on this case). Programs read this.`;
function pgtapLine(item) {
  const names = item.names ? `ARRAY[${item.names.map(sqlString).join(', ')}]::text[]` : "current_setting('test.names')::text[]";
  const label = 'label' in item ? sqlString(item.label) : "current_setting('test.label')";
  const call = `public.identifying_text_problem(${sqlString(item.text)}, ${names}, ${label})`;
  const what = shown(item.text)
    + (item.names ? ` [names: ${item.names.length ? shown(item.names.join(' | ')) : 'none'}]` : '')
    + ('label' in item ? ` [label: ${item.label === null ? 'none' : shown(item.label)}]` : '');
  if (item.expect === null) return `SELECT is(${call}, NULL, ${sqlString(`allowed: ${what}`)});`;
  if (item.expect === 'name') return `SELECT is(${call}, ${sqlString(nameMessage(item.word))}, ${sqlString(`refused as name (${item.word}): ${what}`)});`;
  return `SELECT ok(coalesce(lower(${call}) LIKE '%${item.expect}%', false), ${sqlString(`refused as ${item.expect}: ${what}`)});`;
}
const BEGIN_MARK = '-- BEGIN fixture cases (node scripts/identifying-text-test.mjs --write; do not edit by hand)';
const END_MARK = '-- END fixture cases';
const setupLines = [
  `SELECT set_config('test.names', (ARRAY[${fixture.names.map(sqlString).join(', ')}])::text, true);`,
  `SELECT set_config('test.label', ${sqlString(fixture.label)}, true);`,
];
const TEST_STATEMENT = /^SELECT (is|ok|isnt|throws_ok|lives_ok|results_eq|set_eq)\(/gm;

if (process.argv.includes('--write')) {
  let pgtap = readFileSync(pgtapPath, 'utf8');
  const start = pgtap.indexOf(BEGIN_MARK);
  const end = pgtap.indexOf(END_MARK);
  assert.ok(start >= 0 && end > start, 'the pgTAP file has the fixture markers');
  pgtap = `${pgtap.slice(0, start)}${[BEGIN_MARK, ...setupLines, '', ...fixture.cases.map(pgtapLine)].join('\n')}\n${pgtap.slice(end)}`;
  const count = (pgtap.match(TEST_STATEMENT) || []).length;
  pgtap = pgtap.replace(/SELECT plan\(\d+\);/, `SELECT plan(${count});`);
  writeFileSync(pgtapPath, pgtap);
  console.log(`Wrote ${fixture.cases.length} fixture cases into the pgTAP file (plan ${count}).`);
  process.exit(0);
}

let passed = 0;
function check(label, actual, expected) {
  assert.deepEqual(actual, expected, label);
  passed += 1;
}

// ─── The shared cases ───────────────────────────────────────────────────────
for (const item of fixture.cases) {
  const names = item.names ?? fixture.names;
  const label = 'label' in item ? item.label : fixture.label;
  const problem = identifyingTextProblem(item.text, names, label);
  if (item.expect === null) assert.equal(problem, null, `allowed: ${JSON.stringify(item.text)} (got ${problem})`);
  else if (item.expect === 'name') assert.equal(problem, nameMessage(item.word), `refused as name (${item.word}): ${JSON.stringify(item.text)} (got ${problem})`);
  else assert.ok(problem && problem.toLowerCase().includes(item.expect), `refused as ${item.expect}: ${JSON.stringify(item.text)} (got ${problem})`);
  passed += 1;
}
check('every name refusal says which word', fixture.cases.filter((item) => item.expect === 'name').every((item) => typeof item.word === 'string' && item.word), true);
check('the fixture covers every kind of refusal and the label', ['hidden', 'email', 'link', 'money', 'date', 'number', 'name', null].every((kind) => fixture.cases.some((item) => item.expect === kind))
  && fixture.cases.some((item) => item.expect === 'name' && labelInitials(fixture.label).includes(item.word)), true);

// ─── Name words, label initials ─────────────────────────────────────────────
check('name words: letters only, no relationship words', nameWords(['Rivera family — son Jake']), ['jake', 'rivera']);
check('a case title\'s ordinary words are never a name; the name in it still is', nameWords(['Rivera intervention', "Lopez family's first call", 'New inquiry - detox follow-up']), ['lopez', 'rivera']);
check('accents are folded; two-letter names count; relationship words never', nameWords(['José Núñez', 'Al', 'Mom and Dad']), ['al', 'jose', 'nunez']);
check('everyday words, state codes, care shorthand and ordinal endings are never two-letter names', nameWords(['Rivera - TX', 'AA follow-up', 'Lopez 3rd call', 'Ed', 'Li', 'Dr. Ng']), ['li', 'lopez', 'ng', 'rivera']);
check('the label\'s initials: dotted initials collapse, a tag with a letter counts', labelInitials('J.R. 34M'), ['34m', 'jr']);
check('the label\'s initials: never an ordinary or everyday word, never a number alone', [labelInitials('Client A'), labelInitials('Case 2024-117'), labelInitials('IN'), labelInitials(null), labelInitials('TX 34')], [[], [], [], [], ['tx']]);
check('initials count for the label only', [identifyingTextProblem('JR prefers mornings', ['J.R.']), identifyingTextProblem('JR prefers mornings', [], 'J.R.')], [null, nameMessage('jr')]);
check('the alphabetically first name is the one quoted', identifyingTextProblem('Rivera and Lopez and JR asked', ['Rivera intervention', 'Maria Lopez'], 'J.R.'), nameMessage('jr'));
check('the rules version', IDENTIFYING_TEXT_RULES_VERSION, 2);

// Every word of the app's relationship lists is never a name, as typed and
// as saved (cases.ts CALLER_RELATIONSHIP; the server's
// lead_caller_relationship has the same lists).
{
  const casesSource = readFileSync(path.join(repoRoot, 'src/lib/cases.ts'), 'utf8');
  const block = /const CALLER_RELATIONSHIP[^=]*= \[([\s\S]*?)\n\];/.exec(casesSource)[1];
  const phrases = [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  check('the relationship lists were read', phrases.length > 40 && phrases.includes('best friend') && phrases.includes('referring professional'), true);
  check('every relationship word, typed or saved, is never a name', nameWords([...phrases, 'family member']), []);
  const sqlSource = readFileSync(path.join(repoRoot, 'supabase/migrations/20261024120000_directory_membership_hardening.sql'), 'utf8');
  const sqlBlock = /CREATE OR REPLACE FUNCTION public\.lead_caller_relationship[\s\S]*?\$\$;/.exec(sqlSource)[0];
  const sqlPhrases = [...sqlBlock.matchAll(/'([a-z ]+)'/g)].map((match) => match[1]).filter((phrase) => phrase.trim());
  check('and so is every word of the server\'s lead_caller_relationship', nameWords(sqlPhrases), []);
}

// ─── The SQL twin's lists and rules ─────────────────────────────────────────
{
  const migration = readFileSync(migrationPath, 'utf8');
  const tsList = (name) => {
    const body = new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`).exec(source)[1].replace(/\/\/.*$/gm, '');
    return [...body.matchAll(/'([^']*)'|"([^"]*)"/g)].map((match) => match[1] ?? match[2]);
  };
  const sqlList = (fn) => {
    const body = new RegExp(`FUNCTION public\\.${fn}\\(\\)[\\s\\S]*?SELECT ARRAY\\[([\\s\\S]*?)\\]::text\\[\\]`).exec(migration)[1];
    return [...body.matchAll(/'((?:[^']|'')*)'/g)].map((match) => match[1].replace(/''/g, "'"));
  };
  check('never a name: the same words in the same order on both sides', sqlList('identifying_ordinary_words'), tsList('NEVER_A_NAME'));
  check('everyday two-letter words: the same on both sides', sqlList('identifying_everyday_two'), tsList('EVERYDAY_TWO'));
  check('abbreviations: the same on both sides', sqlList('identifying_abbreviations'), tsList('ABBREVIATIONS'));
  for (const message of ['Remove line breaks and hidden characters.', 'Leave out email addresses. Programs read this.', 'Leave out links and web addresses. Programs read this.',
    'Leave money out. Programs read this.', 'Leave out dates such as a birth date. Programs read this.', 'Leave out phone and ID numbers. Programs read this.']) {
    check(`the server says it the same way: ${message}`, source.includes(`'${message}'`) && migration.includes(`'${message}'`), true);
  }
  check('the name message, on both sides', source.includes('`Leave out names ("${found}" is a name on this case). Programs read this.`')
    && migration.includes(`'Leave out names ("' || v_found || '" is a name on this case). Programs read this.'`), true);
  check('the server\'s check takes the label, and the older (text, text[]) one is dropped first',
    migration.includes('DROP FUNCTION IF EXISTS public.identifying_text_problem(text, text[]);')
    && migration.includes('CREATE OR REPLACE FUNCTION public.identifying_text_problem(p_text text, p_names text[], p_label text DEFAULT NULL)'), true);
  check('the server screens a placement note against the label as the label', migration.includes("public.placement_note_problem(btrim(coalesce(p_note, '')), public.identifying_case_names(v_case, p_org), v_label)"), true);
  // Every pattern reads whole characters, as Postgres does: the u flag on
  // each regex literal and each new RegExp.
  const code = source.replace(/(^|\s)\/\/.*$/gm, '$1');
  const literalFlags = [...code.matchAll(/(?<=[(\s=,])\/(?![/*])((?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\n\\[])+)\/([a-z]*)/g)].map((match) => match[2]);
  const constructedFlags = [...code.matchAll(/new RegExp\(`[^`]*`, '([a-z]*)'\)/g)].map((match) => match[1]);
  check(`the twin's patterns read whole characters (the u flag on all ${literalFlags.length + constructedFlags.length})`,
    literalFlags.length >= 15 && constructedFlags.length >= 8 && [...literalFlags, ...constructedFlags].every((flags) => flags.includes('u'))
    && (code.match(/new RegExp\(/g) || []).length === constructedFlags.length, true);
}

// ─── The pgTAP twin ─────────────────────────────────────────────────────────
{
  const pgtap = readFileSync(pgtapPath, 'utf8');
  for (const line of setupLines) check(`the pgTAP test uses the fixture's ${line.includes('test.label') ? 'label' : 'names list'}`, pgtap.includes(line), true);
  for (const item of fixture.cases) {
    assert.ok(pgtap.includes(pgtapLine(item)), `the pgTAP test runs the fixture case ${JSON.stringify(item.text)} as written (node scripts/identifying-text-test.mjs --write)`);
    passed += 1;
  }
  const count = (pgtap.match(TEST_STATEMENT) || []).length;
  check(`the pgTAP plan counts its ${count} tests`, pgtap.includes(`SELECT plan(${count});`), true);
}

console.log(`All ${passed} identifying-text checks passed.`);
