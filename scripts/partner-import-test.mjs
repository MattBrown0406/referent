// Partners from contacts and files, and program referrals in the referral
// history (migration 20261108180000_partner_import.sql): the pure rules in
// src/lib/partner-import.ts, the case card's ledger rule, and the wiring that
// keeps the address book private. Run with: node scripts/partner-import-test.mjs

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'partner-import-test');
const require = createRequire(import.meta.url);
const ts = require(path.join(repoRoot, 'node_modules', 'typescript'));
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

function load(relSrc, outName) {
  const js = ts.transpileModule(read(relSrc), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const outPath = path.join(tmpDir, outName);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, js);
  return require(outPath);
}

let checks = 0;
const check = (fn, label) => {
  try { fn(); } catch (error) { console.error(`FAIL ${label || ''}`); throw error; }
  checks += 1;
};

const rules = load('src/lib/partner-import.ts', 'partner-import.js');
const referralRules = load('src/lib/program-referral-rules.ts', 'program-referral-rules.js');

// ─── Cleaning ───────────────────────────────────────────────────────────────
check(() => assert.deepEqual(['Oregon', 'or', 'OR.', 'new york', 'Ontario', ''].map(rules.stateCode), ['OR', 'OR', 'OR', 'NY', '', '']), 'states');
check(() => assert.deepEqual(['+1 (503) 555-0199', '503.555.0199', '555-0199'].map(rules.phoneKey), ['5035550199', '5035550199', '']), 'phones');
check(() => assert.deepEqual(
  ['https://www.Oaks.org/about', 'intake@oaksrecovery.com', 'someone@gmail.com', 'javascript:alert(1)', 'oaks'].map(rules.domainKey),
  ['oaks.org', 'oaksrecovery.com', '', '', '']), 'domains (free mail never matches)');
check(() => assert.equal(rules.orgKey('The Oaks Recovery, Inc.'), rules.orgKey('oaks recovery')), 'org names compare loosely');
check(() => assert.deepEqual(
  ['https://oaks.org', 'oaks.org/intake', 'javascript:alert(1)', 'data:text/html,x', 'ftp://oaks.org'].map(rules.cleanWebsite),
  ['https://oaks.org', 'oaks.org/intake', '', '', '']), 'only http(s) or bare hosts are kept');
check(() => assert.deepEqual(['Jane@Harbor.TEST', 'mailto:a@b.co', 'not an email'].map(rules.cleanEmail), ['jane@harbor.test', 'a@b.co', '']), 'emails');
check(() => assert.equal(rules.cleanContact({ name: 'A\u0000B\n  C' }).name, 'A B C'), 'control characters and runs of space are flattened');

// ─── Types ─────────────────────────────────────────────────────────────────
const typeOf = (organization, hint = '', name = '') => rules.suggestTypes({ organization, hint, name });
check(() => assert.deepEqual(
  [typeOf('Cascade Interventions'), typeOf('Willow Detox'), typeOf('Harbor Sober Living'), typeOf('Bend IOP'), typeOf('', 'LMFT'),
   typeOf('Juniper Ridge Treatment Center'), typeOf('Acme Plumbing'), typeOf('Whatever', 'Sober Living')],
  [['Interventionist'], ['Detox'], ['Sober Living'], ['IOP / PHP'], ['Therapist'], ['Inpatient'], [], ['Sober Living']]), 'type suggestions');

// ─── CSV ───────────────────────────────────────────────────────────────────
check(() => assert.deepEqual(rules.parseCsv('﻿a,"b, c","say ""hi"""\r\n\r\n1,2,3\n'), [['a', 'b, c', 'say "hi"'], ['1', '2', '3']]), 'RFC 4180');
check(() => assert.deepEqual(rules.parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']]), 'semicolon sheets');
check(() => assert.deepEqual(rules.parseCsv('a,"line one\nline two"\n'), [['a', 'line one\nline two']]), 'a quoted newline stays in the field');
const google = [
  'First Name,Middle Name,Last Name,Organization Name,Organization Title,E-mail 1 - Label,E-mail 1 - Value,Phone 1 - Label,Phone 1 - Value,Address 1 - City,Address 1 - Region,Website 1 - Value',
  'Dana,,Cole,Cascade Interventions,Interventionist,* Work,dana@cascade.test,Mobile,(503) 555-0101,Portland,Oregon,https://cascade.test',
  ',,,,,,,,,,,',
  'Pat,,,,,,,,,,,',
].join('\n');
const fromGoogle = rules.contactsFromCsv(google);
check(() => assert.equal(fromGoogle.length, 2), 'blank rows dropped; a first name alone is kept');
check(() => assert.deepEqual(fromGoogle[0], {
  name: 'Dana Cole', organization: 'Cascade Interventions', email: 'dana@cascade.test', phone: '(503) 555-0101', city: 'Portland',
  state: 'OR', website: 'https://cascade.test', note: '', hint: 'Interventionist',
}), 'Google Contacts columns (labels ignored, values read)');
const outlook = 'First Name,Last Name,Company,Job Title,Business Phone,Business City,Business State,E-mail Address,Web Page,Notes\nSam,Reyes,Willow Detox,Admissions,503-555-0110,Eugene,OR,sam@willow.test,willow.test,Met in Bend';
check(() => assert.deepEqual(rules.contactsFromCsv(outlook)[0], {
  name: 'Sam Reyes', organization: 'Willow Detox', email: 'sam@willow.test', phone: '503-555-0110', city: 'Eugene', state: 'OR',
  website: 'willow.test', note: 'Met in Bend', hint: 'Admissions',
}), 'Outlook columns');
check(() => assert.deepEqual(rules.contactsFromCsv('Program,Type,Phone\nOaks Ranch,Inpatient,5035550120')[0].hint, 'Inpatient'), 'a hand-made sheet with a Type column');
check(() => assert.deepEqual(rules.contactsFromCsv('just one line'), []), 'no header and rows: nothing');

// ─── vCard ─────────────────────────────────────────────────────────────────
const vcf = [
  'BEGIN:VCARD', 'VERSION:3.0', 'N:Hale;Quinn;;;', 'FN:Quinn Hale', 'ORG:Harbor Family Services;Intake',
  'TITLE:Family therapist', 'item1.EMAIL;type=INTERNET;type=HOME:quinn@home.test', 'EMAIL;type=INTERNET;type=WORK:quinn@harbor.test',
  'TEL;type=CELL:(206) 555-0130', 'ADR;type=WORK:;;1 Main St;Seattle;WA;98101;USA', 'URL:https://harbor.test',
  'NOTE:Long note that is fol', ' ded across lines\\, with a comma', 'END:VCARD',
  'BEGIN:VCARD', 'VERSION:2.1', 'FN;ENCODING=QUOTED-PRINTABLE:=4A=6F', 'ORG:Oaks', 'END:VCARD',
  'BEGIN:VCARD', 'VERSION:4.0', 'END:VCARD',
].join('\r\n');
const fromVcf = rules.contactsFromVcard(vcf);
check(() => assert.equal(fromVcf.length, 2), 'an empty card is dropped');
check(() => assert.deepEqual(fromVcf[0], {
  name: 'Quinn Hale', organization: 'Harbor Family Services', email: 'quinn@harbor.test', phone: '(206) 555-0130', city: 'Seattle',
  state: 'WA', website: 'https://harbor.test', note: 'Long note that is folded across lines, with a comma', hint: 'Family therapist',
}), 'vCard: the work email wins, folded lines join, escapes read');
check(() => assert.deepEqual([fromVcf[1].name, fromVcf[1].organization], ['', 'Oaks']), 'a quoted-printable name is skipped, never misread');
check(() => assert.equal(rules.contactsFromFile('people.csv', 'BEGIN:VCARD\nFN:A\nEND:VCARD').length, 1), 'content beats the extension');

// ─── iOS picker ───────────────────────────────────────────────────────────
check(() => assert.deepEqual(rules.contactFromPicker({
  name: 'Dana Cole', company: 'Cascade Interventions', jobTitle: 'Founder',
  emails: [{ email: 'dana@home.test', label: 'home' }, { email: 'dana@cascade.test', label: 'work' }],
  phoneNumbers: [{ number: '(503) 555-0101', label: 'mobile', isPrimary: true }],
  addresses: [{ city: 'Bend', region: 'Oregon', label: 'home' }, { city: 'Portland', region: 'OR', label: 'work' }],
  urlAddresses: [{ url: 'cascade.test' }],
}), {
  name: 'Dana Cole', organization: 'Cascade Interventions', email: 'dana@cascade.test', phone: '(503) 555-0101', city: 'Portland',
  state: 'OR', website: 'cascade.test', note: '', hint: 'Founder',
}), 'the picked contact: primary or work details first');
check(() => assert.equal(rules.contactFromPicker(null), null), 'a cancelled picker');
check(() => assert.equal(rules.contactFromPicker({ emails: [{ email: 'x@y.test' }] }), null), 'a contact with no name or company is not a partner');

// ─── Matching and review rows ─────────────────────────────────────────────
const listings = [
  { id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'Admissions', organization: 'Willow Detox', types: ['Detox'], city: 'Eugene', state: 'OR', phone: '541-555-0100', email: '', website: 'https://www.willow.test' },
  { id: 'aaaaaaaa-0000-0000-0000-000000000002', name: 'Intake', organization: 'The Oaks Ranch, LLC', types: ['Inpatient'], city: 'Bend', state: 'OR', phone: '5415550111', email: '', website: '' },
  { id: 'aaaaaaaa-0000-0000-0000-000000000003', name: 'Dana Cole', organization: 'Cascade Interventions', types: ['Interventionist'], city: 'Portland', state: 'OR', phone: '', email: 'dana@cascade.test', website: '' },
];
const index = rules.directoryIndex(listings);
const c = (fields) => rules.cleanContact(fields);
check(() => assert.equal(rules.matchListing(c({ organization: 'Willow', email: 'sam@willow.test' }), index)?.id, listings[0].id), 'by work-email domain');
check(() => assert.equal(rules.matchListing(c({ organization: 'Ranch', phone: '+1 (541) 555-0111' }), index)?.id, listings[1].id), 'by phone');
check(() => assert.equal(rules.matchListing(c({ organization: 'Oaks Ranch' }), index)?.id, listings[1].id), 'by organization name');
check(() => assert.equal(rules.matchListing(c({ organization: 'Someone', email: 'x@gmail.com' }), index), null), 'a free-mail address never matches a listing');

const network = [
  { id: 'p-1', name: 'Intake', organization: 'Harbor Therapy', email: 'intake@harbor.test', phone: '', globalPartnerId: undefined },
  { id: 'p-2', name: 'Dana Cole', organization: 'Cascade Interventions', email: '', phone: '', globalPartnerId: listings[2].id },
];
const contacts = [
  c({ name: 'Sam Reyes', organization: 'Willow Detox', email: 'sam@willow.test' }),
  c({ name: 'New Person', organization: 'Fresh Start Counseling', email: 'new@fresh.test', hint: 'LPC' }),
  c({ name: 'Intake', organization: 'Harbor Therapy', email: 'INTAKE@harbor.test' }),
  c({ name: 'Dana', organization: 'Cascade', email: 'dana@cascade.test' }),
  c({ name: 'Sam Reyes', organization: 'Willow Detox', email: 'sam@willow.test' }),
  c({ name: 'Plain', organization: 'Acme' }),
];
const review = rules.addCandidates([], contacts, index, network);
check(() => assert.equal(review.candidates.length, 5), 'the same contact twice is one row');
const [willow, fresh, harbor, dana, acme] = review.candidates;
check(() => assert.deepEqual([willow.match?.id, willow.useListing, willow.types, willow.include], [listings[0].id, true, ['Detox'], true]), 'a Directory match adds the listing, typed from it');
check(() => assert.deepEqual([fresh.match, fresh.types, fresh.include], [null, ['Therapist'], true]), 'an own contact gets a suggested type');
check(() => assert.deepEqual([harbor.existingPartnerId, harbor.include], ['p-1', false]), 'already a partner by email: shown, not sent');
check(() => assert.deepEqual([dana.existingPartnerId, dana.include], ['p-2', false]), 'already a partner by its Directory link');
check(() => assert.equal(rules.isReady(acme), false), 'no type yet: not sent');
const rows = rules.importRows(review.candidates.map((row) => (row.key === acme.key ? { ...row, types: ['Detox'] } : row)));
check(() => assert.deepEqual(rows, [
  { global_id: listings[0].id },
  { name: 'New Person', organization: 'Fresh Start Counseling', types: ['Therapist'], email: 'new@fresh.test', phone: '', city: '', state: '', website: '', note: '' },
  { name: 'Plain', organization: 'Acme', types: ['Detox'], email: '', phone: '', city: '', state: '', website: '', note: '' },
]), 'only ready rows are sent: a listing id, or the contact as cleaned');
check(() => {
  const own = rules.importRows([{ ...willow, useListing: false }]);
  assert.equal(own[0].organization, 'Willow Detox');
  assert.ok(!('global_id' in own[0]));
}, 'switching the listing off sends the contact itself');
check(() => {
  const many = Array.from({ length: rules.MAX_IMPORT_ROWS + 5 }, (_, i) => c({ name: `P${i}`, organization: `Org ${i}` }));
  const result = rules.addCandidates([], many, null, []);
  assert.equal(result.candidates.length, rules.MAX_IMPORT_ROWS);
  assert.equal(result.truncated, true);
}, 'at most 500 rows');
check(() => assert.equal(rules.addCandidates(review.candidates, [contacts[0]], index, network).added, 0), 'picking a contact already listed adds nothing');
check(() => assert.deepEqual(
  [rules.importSummary({ added: 3, linked: 2, skipped: 1 }), rules.importSummary({ added: 1, linked: 0, skipped: 0 }), rules.importSummary({ added: 0, linked: 0, skipped: 2 })],
  ['Added 3 partners and 2 from the Directory. 1 was already in your network or could not be added.', 'Added 1 partner.',
   'Nothing new was added. 2 were already in your network or could not be added.']), 'the outcome line');

// ─── The case card's referral-history rule ────────────────────────────────
const base = { id: 'r', fromDisplay: 'Oaks', shareProgress: true, createdAt: '2026-11-08T03:00:00Z' };
check(() => assert.deepEqual(
  [referralRules.ledgerAction({ ...base, inNetwork: true, logged: true, canLog: true }),
   referralRules.ledgerAction({ ...base, inNetwork: true, logged: false, canLog: true }),
   referralRules.ledgerAction({ ...base, inNetwork: false, logged: false, canLog: true }),
   referralRules.ledgerAction({ ...base, inNetwork: false, logged: false, canLog: false })],
  ['none', 'log', 'add_and_log', 'none']), 'logged, log, add and log, or nothing');
check(() => assert.deepEqual(
  [referralRules.caseProgramReferralFromRow({ id: 'r', from_display: 'Oaks', share_progress: true, created_at: 'x' })].map((r) => [r.inNetwork, r.logged, r.canLog]),
  [[false, false, false]]), 'an older server offers nothing');
check(() => assert.match(referralRules.localDateOf('2026-11-08T12:00:00Z'), /^2026-11-0[78]$/), 'the referral date is the device\'s local date');

// ─── Wiring: the address book stays private ───────────────────────────────
const api = read('src/lib/partner-import-api.ts');
const sheet = read('src/lib/PartnerImportSheet.tsx');
const app = read('App.tsx');
const appJson = JSON.parse(read('app.json'));
const migration = read('supabase/migrations/20261108180000_partner_import.sql');
const matching = read('src/lib/matching.ts');
check(() => assert.match(api, /requireOptionalNativeModule\('ExpoContacts'\)/), 'an older binary without the module shows no Contacts option');
check(() => assert.match(api, /presentContactPickerAsync\(\)/), 'contacts come only from iOS\'s picker');
check(() => assert.doesNotMatch(api + sheet + app, /getContactsAsync|requestPermissionsAsync|getPermissionsAsync|Contact\.getAll|presentAccessPicker/),
  'the app never reads the address book or asks for access to it');
check(() => assert.match(api, /input\.click\(\);\s*\}\);/), 'the web file chooser opens inside the tap');
check(() => assert.match(sheet, /importPartners\(importRows\(candidates\), userId\)/), 'only reviewed rows are sent');
check(() => assert.match(sheet, /const endOverlay = beginOverlay\(\);/), 'nothing presents over the iOS picker');
check(() => assert.match(app, /\|\| showGlobalDirectory \|\| showPartnerImport/), 'the import sheet counts as an open sheet');
check(() => assert.match(app, /onLedgerChanged=\{\(\) => \{ void refreshFromServerRef\.current\?\.\('pull'\)/), 'the case card reloads the network after logging');
check(() => {
  const plugin = appJson.expo.plugins.find((entry) => Array.isArray(entry) && entry[0] === 'expo-contacts');
  assert.ok(plugin && /only the contacts you pick/.test(plugin[1].contactsPermission));
}, 'the iOS usage text says only picked contacts are used');
check(() => assert.doesNotMatch(migration, /[^\x00-\x7f]/), 'migration: ASCII only');
check(() => assert.doesNotMatch(migration, /\\/), 'migration: no backslashes');
check(() => assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.import_partners\(jsonb\) TO authenticated;/));
check(() => assert.match(migration, /REVOKE ALL ON FUNCTION public\.import_partner_row\(uuid, uuid, jsonb\) FROM PUBLIC, anon, authenticated;/));
check(() => assert.match(migration, /v_directory := public\.is_platform_admin\(\) OR public\.org_has_entitlement\('directory'\);/), 'Directory rows only for a workspace with the Directory');
check(() => assert.doesNotMatch(matching, /\.(inbound|outbound)\b/), 'matching never reads referral counts');

console.log(`partner-import-test: ${checks} checks passed`);
