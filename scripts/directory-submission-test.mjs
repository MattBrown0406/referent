// Directory-submission completeness rule — runs the real
// src/lib/directory-submission.ts in plain node (transpiled on the fly with
// the repo's typescript package, same pattern as scripts/phone-test.mjs).
//
// The rule lives twice: in SQL (the authority, enforced by
// suggest_global_listing) and in TypeScript (what the app shows). The
// fixtures below are the same cases supabase/tests/directory_submissions_test.sql
// asserts, and the last section reads the migration itself so the two
// key/label lists cannot drift apart silently.

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'directory-submission-test');
const require = createRequire(import.meta.url);
const ts = require(path.join(repoRoot, 'node_modules', 'typescript'));

const source = readFileSync(path.join(repoRoot, 'src/lib/directory-submission.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
mkdirSync(tmpDir, { recursive: true });
writeFileSync(path.join(tmpDir, 'directory-submission.js'), js);

const {
  DIRECTORY_LISTABLE_TYPES,
  DIRECTORY_SUBMISSION_FIELDS,
  PRIVATE_PAY_ONLY,
  directoryMissingFields,
  directoryMissingFieldsMessage,
  directoryCostLabel,
  directoryTextIsBlank,
  hasDirectoryType,
  isIndividualProfessional,
} = require(path.join(tmpDir, 'directory-submission.js'));

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const pass = a === e;
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}  → ${a}${pass ? '' : ` (expected ${e})`}`);
}
const keys = (input) => directoryMissingFields(input).map((field) => field.key);

const complete = {
  organization: 'Cedar Ridge Recovery',
  name: 'Dana Whitfield',
  types: ['Inpatient'],
  city: 'Bend',
  state: 'OR',
  phone: '(541) 555-0142',
  email: 'dana@cedarridge.example',
  website: 'https://cedarridge.example',
  monthlyCost: 32000,
  insurance: ['Aetna'],
  insuranceNetworks: { Aetna: ['In-network'] },
};

console.log('— directoryMissingFields (mirrors public.directory_missing_fields) —');
check('empty program is missing everything, in display order', keys({}),
  ['organization', 'name', 'types', 'city', 'state', 'phone', 'email', 'website', 'monthly_cost', 'insurance']);
check('null values behave like missing ones', keys({
  organization: null, name: null, types: null, city: null, state: null, phone: null,
  email: null, website: null, monthlyCost: null, insurance: null, insuranceNetworks: null,
}).length, 10);
check('fully populated program is directory-ready', keys(complete), []);
check('placeholder dashes, short phone, malformed email', keys({
  ...complete, city: '—', state: ' - ', phone: '555-0142', email: 'dana-at-cedarridge', insuranceNetworks: {},
}), ['city', 'state', 'phone', 'email']);
check('private pay answers the insurance question', keys({
  ...complete, types: ['Detox'], insurance: [PRIVATE_PAY_ONLY], insuranceNetworks: {},
}), []);
check('a network entry alone answers the insurance question', keys({
  ...complete, insurance: [], insuranceNetworks: { Cigna: ['Out-of-network'] },
}), []);
check('a blank insurance entry does not', keys({ ...complete, insurance: [' '], insuranceNetworks: {} }), ['insurance']);
check('no insurance answer at all', keys({ ...complete, insurance: [], insuranceNetworks: {} }), ['insurance']);
check('a complete Interventionist is directory-ready', keys({ ...complete, types: ['Interventionist'], insurance: [PRIVATE_PAY_ONLY], insuranceNetworks: {} }), []);
check('a complete Therapist is directory-ready', keys({ ...complete, types: ['Therapist'] }), []);
check('untyped partner → partner type missing', keys({ ...complete, types: [] }), ['types']);
check('unrecognised type → partner type missing', keys({ ...complete, types: ['Wizard'] }), ['types']);
check('mixed types with one program type are fine', keys({ ...complete, types: ['Therapist', 'Sober Living'] }), []);
check('monthly cost must be greater than zero', keys({ ...complete, monthlyCost: 0 }), ['monthly_cost']);
check('phone with country code and punctuation', keys({ ...complete, phone: '+1 (541) 555-0142' }), []);
check('email is trimmed before the check', keys({ ...complete, email: '  dana@cedarridge.example ' }), []);
check('email with a space inside is refused', keys({ ...complete, email: 'dana @cedarridge.example' }), ['email']);
check('email needs a dot in the domain', keys({ ...complete, email: 'dana@cedarridge' }), ['email']);
check('whitespace-only website', keys({ ...complete, website: '   ' }), ['website']);

console.log('\n— helpers —');
check("directoryTextIsBlank('—')", directoryTextIsBlank('—'), true);
check("directoryTextIsBlank(' - ')", directoryTextIsBlank(' - '), true);
check("directoryTextIsBlank('Winston-Salem')", directoryTextIsBlank('Winston-Salem'), false);
check('directoryTextIsBlank(undefined)', directoryTextIsBlank(undefined), true);
check("hasDirectoryType(['IOP / PHP'])", hasDirectoryType(['IOP / PHP']), true);
check("hasDirectoryType(['Therapist'])", hasDirectoryType(['Therapist']), true);
check('hasDirectoryType(undefined)', hasDirectoryType(undefined), false);
check("isIndividualProfessional(['Interventionist', 'Therapist'])", isIndividualProfessional(['Interventionist', 'Therapist']), true);
check("isIndividualProfessional(['Therapist', 'Sober Living'])", isIndividualProfessional(['Therapist', 'Sober Living']), false);
check('isIndividualProfessional([])', isIndividualProfessional([]), false);
check("directoryCostLabel(['Interventionist'])", directoryCostLabel(['Interventionist']), 'Typical fee');
check("directoryCostLabel(['Inpatient'])", directoryCostLabel(['Inpatient']), 'Monthly cash cost');
check("directoryCostLabel(['Therapist', 'IOP / PHP'])", directoryCostLabel(['Therapist', 'IOP / PHP']), 'Monthly cash cost');

console.log('\n— directoryMissingFieldsMessage (mirrors public.directory_missing_fields_message) —');
const pick = (...wanted) => DIRECTORY_SUBMISSION_FIELDS.filter((field) => wanted.includes(field.key));
check('nothing missing', directoryMissingFieldsMessage([]), '');
check('one field', directoryMissingFieldsMessage(pick('types')),
  'Add partner type to submit this partner to the shared directory.');
check('two fields', directoryMissingFieldsMessage(pick('email', 'monthly_cost')),
  'Add email and cost to submit this partner to the shared directory.');
check('three fields', directoryMissingFieldsMessage(pick('city', 'state', 'website')),
  'Add city, state, and website to submit this partner to the shared directory.');
check('the sparse-program sentence the server raises',
  directoryMissingFieldsMessage(directoryMissingFields({
    organization: 'Halfway There House', name: 'Front Desk', types: ['Sober Living'], phone: '(541) 555-0101',
  })),
  'Add city, state, email, website, cost, and insurance or private pay to submit this partner to the shared directory.');

console.log('\n— lockstep with the SQL definition —');
// Latest migration that defines directory_submission_field_labels().
const migrationsDir = path.join(repoRoot, 'supabase', 'migrations');
const marker = 'CREATE OR REPLACE FUNCTION public.directory_submission_field_labels()';
const defining = readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort()
  .filter((file) => readFileSync(path.join(migrationsDir, file), 'utf8').includes(marker));
check('a migration defines directory_submission_field_labels()', defining.length > 0, true);
if (defining.length > 0) {
  const sql = readFileSync(path.join(migrationsDir, defining[defining.length - 1]), 'utf8');
  const start = sql.lastIndexOf(marker);
  const body = sql.slice(start, sql.indexOf('$$;', start));
  const sqlFields = [...body.matchAll(/\('([a-z_]+)',\s*'([^']+)'\)/g)].map((match) => ({ key: match[1], label: match[2] }));
  check(`keys and labels match ${defining[defining.length - 1]}`, sqlFields, DIRECTORY_SUBMISSION_FIELDS);
  const typeList = `ARRAY[${DIRECTORY_LISTABLE_TYPES.map((type) => `'${type}'`).join(', ')}]::text[]`;
  check('the SQL type list matches DIRECTORY_LISTABLE_TYPES', sql.includes(typeList), true);
}

console.log(failures === 0 ? '\nAll directory-submission checks passed.' : `\n${failures} directory-submission check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
