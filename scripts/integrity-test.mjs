// Program Integrity Watch: src/lib/integrity.ts and src/lib/npi.ts run in
// plain node, no build step (same transpile approach as family-cost-test).
//
//   (a) one credential's status: missing / pending / verified / expiring /
//       expired / rejected (the same table as the pgTAP test)
//   (b) one program: which credential speaks for a kind, the flags, the
//       chip, the license concern
//   (c) the directory badge rule
//   (d) the NPI check digit (Luhn with the 80840 prefix)
//   (e) proof links: https only; the app's pattern is the migration's
//   (f) the editor: dates, normalization, the server's own words
//   (g) the NPI Registry lookup, with fetch stubbed (never the real API):
//       organizations, people, not found, down, slow, aborted
//   (h) the lookup links: public search pages, https, one constants map
//   (i) Today's one card
//   (j) the Alert and the timeline note: calm, plain words
//   (k) the wire format matches the migration's columns
//   (l) the center portal's mirror agrees with the app
//   (m) matching integrity: credentials never change a score or the order
//   (n) the migration follows the paste rules

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'integrity-test');
const require = createRequire(import.meta.url);
const ts = require(path.join(repoRoot, 'node_modules', 'typescript'));

function transpileTo(relSrc, outName) {
  const source = readFileSync(path.join(repoRoot, relSrc), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const outPath = path.join(tmpDir, outName);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, js);
  return outPath;
}

mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
transpileTo('src/data.ts', 'data.js');
for (const name of ['beds', 'matching', 'integrity', 'npi', 'errors', 'paging', 'credentials']) transpileTo(`src/lib/${name}.ts`, `lib/${name}.js`);
transpileTo('portal/src/credential-rules.ts', 'portal/credential-rules.js');
// credentials.ts with its network edges stubbed: a fake Supabase client the
// tests drive, and a uuid.
writeFileSync(path.join(tmpDir, 'lib', 'supabase.js'), 'exports.supabase = globalThis.__credentialSupabase;');
writeFileSync(path.join(tmpDir, 'lib', 'cases.js'), "let n = 0; exports.newUuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;");
const fakeSupabase = { rpc: null, from: null };
// rpc() returns a builder, as supabase-js does: paged reads chain
// .order().range() before awaiting it.
globalThis.__credentialSupabase = {
  rpc: (name, args) => {
    const builder = {
      order: () => builder,
      range: () => builder,
      then: (resolve, reject) => Promise.resolve(fakeSupabase.rpc(name, args)).then(resolve, reject),
    };
    return builder;
  },
  from: (table) => fakeSupabase.from(table),
};

// The tests never reach the network: any real fetch fails loudly.
globalThis.fetch = () => { throw new Error('integrity-test: the real network must never be called'); };

const integrity = require(path.join(tmpDir, 'lib', 'integrity.js'));
const credentialsApi = require(path.join(tmpDir, 'lib', 'credentials.js'));
const npi = require(path.join(tmpDir, 'lib', 'npi.js'));
const matching = require(path.join(tmpDir, 'lib', 'matching.js'));
const portal = require(path.join(tmpDir, 'portal', 'credential-rules.js'));
const {
  credentialStatus, isVerifiedCurrent, bestCredential, programIntegrity, integrityHeadline, CHIP_LABELS, FLAG_LABELS,
  isValidNpi, normalizeNpi, isValidProofUrl, normalizeProofUrl, PROOF_URL_PATTERN, parseDateInput, normalizeCredentialDraft,
  emptyCredentialDraft, draftFromCredential, credentialFromRow, CREDENTIAL_COLUMNS, LOOKUP_SITES, lookupLink,
  lookupLinksForCredential, programLookupLinks, websiteDomain, credentialWatchItems, credentialWatchSubtitle,
  licenseConcernAlert, licenseOverrideNote, credentialTitle, statusLabel, expiryLine, formatStamp, addDaysToStamp,
  daysBetween, isDateStamp, US_STATE_NAMES, EXPIRING_WITHIN_DAYS,
} = integrity;

const migration = readFileSync(path.join(repoRoot, 'supabase/migrations/20261104130000_program_integrity.sql'), 'utf8');

let checks = 0;
function check(label, actual, expected) {
  assert.deepEqual(actual, expected, label);
  checks += 1;
}
function ok(label, value) {
  assert.ok(value, label);
  checks += 1;
}

const TODAY = '2026-11-04';
let nextId = 0;
function cred(fields = {}) {
  nextId += 1;
  return {
    id: `c${String(nextId).padStart(4, '0')}`,
    scope: 'listing',
    globalPartnerId: 'g1',
    partnerId: null,
    kind: 'state_license',
    accreditor: null,
    accreditorName: '',
    identifier: 'LIC-1',
    issuingState: 'OR',
    expiresOn: null,
    proofUrl: null,
    note: '',
    review: 'pending',
    verifiedBy: null,
    verifiedAt: null,
    verificationNote: '',
    npiLookupName: null,
    npiCheckedAt: null,
    updatedBy: null,
    updatedAt: '2026-11-01T00:00:00Z',
    ...fields,
  };
}

// ─── (a) One credential's status ────────────────────────────────────────────

check('missing: nothing on file', credentialStatus(null, TODAY), 'missing');
check('rejected wins over the dates', credentialStatus({ review: 'rejected', expiresOn: '2030-01-01' }, TODAY), 'rejected');
check('rejected wins over expired too', credentialStatus({ review: 'rejected', expiresOn: '2020-01-01' }, TODAY), 'rejected');
check('verified, expired yesterday', credentialStatus({ review: 'verified', expiresOn: '2026-11-03' }, TODAY), 'expired');
check('pending, expired yesterday', credentialStatus({ review: 'pending', expiresOn: '2026-11-03' }, TODAY), 'expired');
check('good through its last day: expires today is expiring', credentialStatus({ review: 'verified', expiresOn: TODAY }, TODAY), 'expiring');
check('pending, 30 days left: expiring', credentialStatus({ review: 'pending', expiresOn: '2026-12-04' }, TODAY), 'expiring');
check('verified, 31 days left: verified', credentialStatus({ review: 'verified', expiresOn: '2026-12-05' }, TODAY), 'verified');
check('verified, no date: verified', credentialStatus({ review: 'verified', expiresOn: null }, TODAY), 'verified');
check('pending, no date: pending', credentialStatus({ review: 'pending', expiresOn: null }, TODAY), 'pending');
check('the window is 30 days', EXPIRING_WITHIN_DAYS, 30);
check('a bad stored date is ignored (no date)', credentialStatus({ review: 'verified', expiresOn: '2026-02-30' }, TODAY), 'verified');
ok('verified and expiring is still current', isVerifiedCurrent({ review: 'verified', expiresOn: '2026-11-20' }, TODAY));
ok('verified and expired is not current', !isVerifiedCurrent({ review: 'verified', expiresOn: '2026-11-01' }, TODAY));
ok('pending is never "verified current"', !isVerifiedCurrent({ review: 'pending', expiresOn: null }, TODAY));
// Dates across a year end and a leap day.
check('days across a year end', daysBetween('2026-12-31', '2027-01-01'), 1);
check('days across a leap day', daysBetween('2028-02-28', '2028-03-01'), 2);
check('add days backwards across a leap year', addDaysToStamp('2029-03-01', -365), '2028-03-01');
ok('a real date stamp', isDateStamp('2028-02-29') && !isDateStamp('2027-02-29') && !isDateStamp('2026-13-01') && !isDateStamp(20261104));
check('stamps read plainly', formatStamp('2026-10-01'), 'Oct 1, 2026');

// The SQL function's CASE has the same branches in the same order.
{
  const fn = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION public.program_credential_status'));
  const body = fn.slice(0, fn.indexOf('$$;'));
  const order = ["'missing'", "'rejected'", "'expired'", "'expiring'", "'verified'", "'pending'"].map((word) => body.indexOf(word));
  ok('SQL status branches: missing, rejected, expired, expiring, verified, pending', order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])));
  ok('SQL expiring window is 30 days', body.includes('p_today + 30'));
}

// ─── (b) One program ────────────────────────────────────────────────────────

{
  const lapsed = cred({ review: 'verified', expiresOn: '2026-10-01', verifiedAt: '2025-10-01T00:00:00Z' });
  const renewed = cred({ review: 'pending', expiresOn: '2027-10-01', identifier: 'LIC-2' });
  check('a pending renewal speaks for the license over the lapsed one', bestCredential([lapsed, renewed], ['state_license'], TODAY).credential.id, renewed.id);
  const verifiedSoon = cred({ review: 'verified', expiresOn: '2026-11-20', verifiedAt: '2026-01-01T00:00:00Z' });
  const pendingSoon = cred({ review: 'pending', expiresOn: '2026-11-25' });
  check('among expiring ones, the checked one speaks', bestCredential([pendingSoon, verifiedSoon], ['state_license'], TODAY).credential.id, verifiedSoon.id);
  const a = cred({ review: 'verified', expiresOn: '2027-01-01', verifiedAt: 'x' });
  const b = cred({ review: 'verified', expiresOn: '2028-01-01', verifiedAt: 'x' });
  check('among equals, the later expiration speaks', bestCredential([a, b], ['state_license'], TODAY).credential.id, b.id);
  check('no credential of the kind: missing', bestCredential([a], ['npi'], TODAY), { status: 'missing', credential: null });

  const none = programIntegrity([], TODAY);
  check('nothing on file: chip None on file', [none.chip, CHIP_LABELS[none.chip], none.badge, none.licenseConcern, none.flags], ['none', 'None on file', false, null, ['no_license']]);
  ok('nothing on file says so calmly', integrityHeadline(none).startsWith('No credentials on file yet'));

  const license = cred({ review: 'verified', expiresOn: '2027-06-30', verifiedAt: 'x' });
  const accreditation = cred({ kind: 'accreditation', accreditor: 'joint_commission', issuingState: '', identifier: 'JC-1', review: 'verified', expiresOn: '2028-01-01', verifiedAt: 'x' });
  const legit = cred({ kind: 'legitscript', issuingState: '', identifier: 'LS-1', review: 'verified', expiresOn: null, verifiedAt: 'x' });
  const all = programIntegrity([license, accreditation], TODAY);
  check('all verified: chip, badge, flags', [all.chip, all.badge, all.flags, all.licenseConcern], ['verified', true, ['all_verified'], null]);
  check('all verified label', FLAG_LABELS.all_verified, 'All verified');
  ok('all verified headline', integrityHeadline(all).startsWith('Credentials verified'));

  const noLicense = programIntegrity([accreditation, legit], TODAY);
  check('accredited but no license: needs review, "No license on file"', [noLicense.chip, noLicense.badge, noLicense.flags], ['needs_review', false, ['no_license']]);
  check('no license copy', integrityHeadline(noLicense), "We couldn't find a current state license on file. Check with the program before referring.");
  check('no license flag label', FLAG_LABELS.no_license, 'No license on file');

  const expiredLicense = cred({ review: 'verified', expiresOn: '2026-10-01', verifiedAt: 'x' });
  const expired = programIntegrity([expiredLicense, accreditation], TODAY);
  check('license expired: chip Expired, flag, concern', [expired.chip, expired.badge, expired.flags, expired.licenseConcern?.status], ['expired', false, ['license_expired'], 'expired']);
  check('license expired copy', integrityHeadline(expired), 'Its state license shows expired (Oct 1, 2026). Check with the program before referring.');
  check('license expired label', FLAG_LABELS.license_expired, 'License expired');

  const rejected = programIntegrity([cred({ review: 'rejected', verifiedAt: 'x', verificationNote: 'not found' }), accreditation], TODAY);
  check('license rejected: the coral concern chip, concern rejected', [rejected.chip, CHIP_LABELS[rejected.chip], rejected.licenseConcern?.status, rejected.flags], ['concern', 'Check license', 'rejected', ['license_rejected']]);
  const rejectedButRenewed = programIntegrity([cred({ review: 'rejected', verifiedAt: 'x' }), license, accreditation], TODAY);
  check('a verified license next to a rejected one: no concern', [rejectedButRenewed.licenseConcern, rejectedButRenewed.badge], [null, true]);

  // The concern looks at every license row: a lapsed license with its
  // renewal still waiting for ReferralFit is still a concern (the renewal
  // speaks for the kind, but it is not verified yet).
  const lapsedLicense = cred({ review: 'verified', expiresOn: '2026-10-01', verifiedAt: 'x' });
  const renewalLicense = cred({ review: 'pending', expiresOn: '2027-10-01', identifier: 'LIC-2' });
  const renewing = programIntegrity([lapsedLicense, renewalLicense, accreditation], TODAY);
  check('lapsed + pending renewal: the renewal speaks for the kind, and the concern stays', [renewing.license.status, renewing.licenseConcern?.status, renewing.licenseConcern?.credential.id, renewing.licenseConcern?.renewal?.id], ['pending', 'expired', lapsedLicense.id, renewalLicense.id]);
  check('lapsed + pending renewal: coral, never the amber "Needs review"', [renewing.chip, renewing.chip === 'needs_review'], ['expired', false]);
  check('lapsed + pending renewal: the words name the renewal', integrityHeadline(renewing), 'Its state license shows expired (Oct 1, 2026). Renewal pending ReferralFit review. Check with the program before referring.');
  check('the renewal line by who checks it', [integrity.renewalLine({ renewal: renewalLicense }), integrity.renewalLine({ renewal: { ...renewalLicense, scope: 'local' } }), integrity.renewalLine({ renewal: null })],
    ['Renewal pending ReferralFit review', 'Renewal on file, not checked yet', '']);
  const rejectedRenewal = programIntegrity([cred({ review: 'rejected', verifiedAt: 'x' }), cred({ review: 'pending', identifier: 'LIC-3' })], TODAY);
  check('rejected + pending: a concern, coral, with the renewal named', [rejectedRenewal.license.status, rejectedRenewal.licenseConcern?.status, rejectedRenewal.chip, Boolean(rejectedRenewal.licenseConcern?.renewal)], ['pending', 'rejected', 'concern', true]);
  const expiredAndRejected = programIntegrity([cred({ review: 'rejected', verifiedAt: 'x' }), cred({ review: 'verified', expiresOn: '2026-09-01', verifiedAt: 'x' })], TODAY);
  check('expired and rejected: expired speaks for the concern', [expiredAndRejected.licenseConcern?.status, expiredAndRejected.chip], ['expired', 'expired']);
  const verifiedExpiring = programIntegrity([lapsedLicense, cred({ review: 'verified', expiresOn: '2026-11-20', verifiedAt: 'x' })], TODAY);
  check('a verified license that is only expiring lifts the concern', verifiedExpiring.licenseConcern, null);
  const pendingOnlyRenewal = programIntegrity([renewalLicense], TODAY);
  check('a pending license alone is not a concern (nothing expired or rejected)', [pendingOnlyRenewal.licenseConcern, pendingOnlyRenewal.chip], [null, 'needs_review']);
  const expiredPending = programIntegrity([lapsedLicense, cred({ review: 'pending', expiresOn: '2026-10-15' })], TODAY);
  check('a pending row that has itself run out is not a renewal', [expiredPending.licenseConcern?.status, expiredPending.licenseConcern?.renewal], ['expired', null]);
  check('the concern helper agrees with programIntegrity', integrity.licenseConcernFor([lapsedLicense, renewalLicense], TODAY)?.renewal?.id, renewalLicense.id);
  check('every concern is coral (expired or concern), every time', [renewing, rejected, rejectedRenewal, expiredAndRejected].map((item) => ['expired', 'concern'].includes(item.chip)), [true, true, true, true]);

  const accExpiring = cred({ kind: 'accreditation', accreditor: 'carf', issuingState: '', identifier: 'CARF-1', review: 'verified', expiresOn: '2026-11-20', verifiedAt: 'x' });
  const soon = programIntegrity([license, accExpiring], TODAY);
  check('accreditation expiring: still the badge, flagged', [soon.chip, soon.badge, soon.flags], ['verified', true, ['accreditation_expiring']]);
  check('accreditation expiring label', FLAG_LABELS.accreditation_expiring, 'Accreditation expiring');

  const accExpired = cred({ kind: 'accreditation', accreditor: 'carf', issuingState: '', identifier: 'CARF-1', review: 'verified', expiresOn: '2026-10-20', verifiedAt: 'x' });
  const withLegit = programIntegrity([license, accExpired, legit], TODAY);
  check('an expired accreditation shows Expired even with the badge met by LegitScript', [withLegit.badge, withLegit.chip, withLegit.flags], [true, 'expired', ['accreditation_expired']]);

  const pendingOnly = programIntegrity([cred({ review: 'pending' })], TODAY);
  check('pending only: needs review, license pending', [pendingOnly.chip, pendingOnly.flags, pendingOnly.licenseConcern], ['needs_review', ['license_pending'], null]);
  const npiOnly = programIntegrity([cred({ kind: 'npi', identifier: '1234567893', issuingState: '', review: 'verified', verifiedAt: 'x' })], TODAY);
  check('an NPI alone is not enough', [npiOnly.chip, npiOnly.badge, npiOnly.flags], ['needs_review', false, ['no_license']]);
  check('chip labels', CHIP_LABELS, { verified: 'Verified', needs_review: 'Needs review', expired: 'Expired', concern: 'Check license', none: 'None on file' });
  const cardSource = readFileSync(path.join(repoRoot, 'src/lib/CredentialsCard.tsx'), 'utf8');
  ok('the concern chip is coral like expired, not amber', /concern: \{ icon: 'shield-outline', color: COLORS\.coral, background: COLORS\.coralPale \}/.test(cardSource));

  // A practice's own check counts in its own view (listing + local together).
  const listingPending = cred({ review: 'pending', expiresOn: '2027-06-30' });
  const localChecked = cred({ scope: 'local', globalPartnerId: null, partnerId: 'p1', review: 'verified', expiresOn: '2027-06-30', verifiedAt: 'x' });
  ok('the practice\'s own license check counts toward its view', programIntegrity([listingPending, localChecked, accreditation], TODAY).badge);
}

// ─── (c) The directory badge rule ───────────────────────────────────────────

{
  const license = (fields) => cred({ review: 'verified', verifiedAt: 'x', expiresOn: '2027-06-30', ...fields });
  const acc = (fields) => cred({ kind: 'accreditation', accreditor: 'joint_commission', issuingState: '', identifier: 'JC', review: 'verified', verifiedAt: 'x', expiresOn: '2027-06-30', ...fields });
  const ls = (fields) => cred({ kind: 'legitscript', issuingState: '', identifier: 'LS', review: 'verified', verifiedAt: 'x', expiresOn: '2027-06-30', ...fields });
  const badge = (list, today = TODAY) => programIntegrity(list, today).badge;
  check('license + accreditation', badge([license(), acc()]), true);
  check('license + LegitScript', badge([license(), ls()]), true);
  check('license alone', badge([license()]), false);
  check('accreditation + LegitScript, no license', badge([acc(), ls()]), false);
  check('license pending', badge([license({ review: 'pending', verifiedAt: null }), acc()]), false);
  check('accreditation pending, LegitScript rejected', badge([license(), acc({ review: 'pending', verifiedAt: null }), ls({ review: 'rejected' })]), false);
  check('license expired', badge([license({ expiresOn: '2026-11-03' }), acc()]), false);
  check('license good through today', badge([license({ expiresOn: TODAY }), acc()]), true);
  check('accreditation expired, LegitScript current', badge([license(), acc({ expiresOn: '2026-01-01' }), ls()]), true);
  check('the same days as the pgTAP test', [badge([license(), ls({ expiresOn: '2027-01-31' })], '2026-11-04'), badge([license(), ls({ expiresOn: '2027-01-31' })], '2027-01-31'), badge([license(), ls({ expiresOn: '2027-01-31' })], '2027-02-01')], [true, true, false]);
  ok('the SQL badge needs a license AND (accreditation OR LegitScript)', /kind = 'state_license'[\s\S]*AND EXISTS[\s\S]*kind IN \('accreditation', 'legitscript'\)/.test(migration.slice(migration.indexOf('FUNCTION public.listing_credentials_verified'))));
}

// ─── (d) The NPI check digit ────────────────────────────────────────────────

for (const valid of ['1234567893', '1245319599', '1003000126', '1497758544']) ok(`valid NPI ${valid}`, isValidNpi(valid));
for (const invalid of ['1234567890', '1234567894', '123456789', '12345678930', '12345678a3', '', '0000000000']) ok(`invalid NPI ${JSON.stringify(invalid)}`, !isValidNpi(invalid));
check('spaces and dashes typed into an NPI are dropped', normalizeNpi(' 123-456 7893 '), '1234567893');
{
  // Every single-digit change of a valid NPI fails the check (Luhn catches them all).
  const base = '1234567893';
  let caught = 0;
  for (let index = 0; index < 10; index += 1) {
    for (let digit = 0; digit <= 9; digit += 1) {
      if (String(digit) === base[index]) continue;
      const changed = base.slice(0, index) + digit + base.slice(index + 1);
      if (!isValidNpi(changed)) caught += 1;
    }
  }
  check('every single-digit typo is caught', caught, 90);
}

// ─── (e) Proof links ────────────────────────────────────────────────────────

{
  const sqlPattern = /p_url ~ '([^']+)'/.exec(migration)?.[1];
  check('the app\'s proof-link pattern is the migration\'s', PROOF_URL_PATTERN, sqlPattern);
  check('the portal\'s proof-link pattern is the migration\'s', portal.PROOF_URL_PATTERN, sqlPattern);
  const good = [
    'https://www.jointcommission.org/en-us/about-us/recognizing-excellence/find-accredited-organizationsquality-report/?keyword=juniper',
    'https://carf.org/find-provider/',
    'https://example.org',
    'https://sub.domain.example.co.uk:8443/a/b?c=d&e=f#g',
    'https://www.legitscript.com/websites/?checker_keywords=juniper.example.org',
  ];
  const bad = [
    'http://example.org/x', 'https://localhost/x', 'https://user:pw@example.org/', 'https://exa mple.org/',
    'javascript:alert(1)', 'ftp://example.org', 'https://example', 'https://-bad.example.org', 'https://example.org/"><script>',
    `https://example.org/${'a'.repeat(500)}`, 'HTTPS://EXAMPLE.ORG', "https://example.org/it's",
  ];
  for (const url of good) ok(`valid proof link ${url}`, isValidProofUrl(url));
  for (const url of bad) ok(`refused proof link ${url.slice(0, 60)}`, !isValidProofUrl(url));
  check('a bare address gets https', normalizeProofUrl('  www.oha.example.gov/lookup?id=1 '), { url: 'https://www.oha.example.gov/lookup?id=1' });
  check('an upper-case scheme is fixed', normalizeProofUrl('HTTPS://carf.org/find-provider/'), { url: 'https://carf.org/find-provider/' });
  check('blank is no link', normalizeProofUrl('   '), { url: null });
  ok('http is refused with a hint', 'problem' in normalizeProofUrl('http://example.org') && normalizeProofUrl('http://example.org').problem.includes('https://'));
  ok('javascript: is refused', 'problem' in normalizeProofUrl('javascript:alert(1)'));
}

// ─── (f) The editor ─────────────────────────────────────────────────────────

{
  check('date: ISO', parseDateInput('2027-06-30'), { stamp: '2027-06-30' });
  check('date: US style', parseDateInput('6/30/2027'), { stamp: '2027-06-30' });
  check('date: blank is none', parseDateInput('  '), { stamp: null });
  ok('date: not a date', 'problem' in parseDateInput('June 30'));
  ok('date: not a real day', 'problem' in parseDateInput('2027-02-30'));
  ok('date: out of range', 'problem' in parseDateInput('1999-12-31'));

  const draft = (fields) => ({ ...emptyCredentialDraft('state_license', 'or'), ...fields });
  check('a license: state from the program, upper-cased, trimmed', normalizeCredentialDraft(draft({ identifier: ' LIC-1 ', expiresOn: '2027-06-30', proofUrl: 'oha.example.gov/x' })), {
    fields: { kind: 'state_license', accreditor: null, accreditorName: '', identifier: 'LIC-1', issuingState: 'OR', expiresOn: '2027-06-30', proofUrl: 'https://oha.example.gov/x', note: '' },
  });
  const problem = (fields) => normalizeCredentialDraft(draft(fields)).problem;
  const sqlProblem = migration.slice(migration.indexOf('FUNCTION public.program_credential_problem'), migration.indexOf('REVOKE ALL ON FUNCTION public.program_credential_problem'));
  const cases = [
    [{ identifier: '' }, 'Add the license number'],
    [{ identifier: 'X', issuingState: 'ZZ' }, 'Choose the state that issued the license'],
    [{ kind: 'npi', identifier: '1234567890' }, 'An NPI is 10 digits and its last digit must check out. Check the number.'],
    [{ kind: 'npi', identifier: '1234567893', expiresOn: '2030-01-01' }, 'An NPI does not expire. Leave the date blank.'],
    [{ kind: 'accreditation', accreditor: 'other', accreditorName: ' ', identifier: 'A' }, 'Name the accrediting body'],
    [{ kind: 'legitscript', identifier: '', issuingState: '' }, 'Add the certificate number or a link to the public record'],
    [{ identifier: 'X', proofUrl: 'https://localhost/x' }, 'The link must be a full https:// web address'],
    [{ identifier: 'X'.repeat(65) }, 'The number can be at most 64 characters'],
    [{ identifier: 'X', note: 'n'.repeat(1001) }, 'The note can be at most 1,000 characters'],
  ];
  for (const [fields, message] of cases) {
    check(`editor: ${message}`, problem(fields), message);
    ok(`the server says the same: ${message}`, sqlProblem.includes(`'${message}'`));
  }
  check('an accreditation keeps only its body', normalizeCredentialDraft(draft({ kind: 'accreditation', accreditor: 'carf', accreditorName: 'stray', identifier: 'C-1', issuingState: 'OR' })).fields,
    { kind: 'accreditation', accreditor: 'carf', accreditorName: '', identifier: 'C-1', issuingState: '', expiresOn: null, proofUrl: null, note: '' });
  check('an NPI keeps its digits only', normalizeCredentialDraft(draft({ kind: 'npi', identifier: '1234-567-893', issuingState: 'OR' })).fields.identifier, '1234567893');
  check('LegitScript with only a link is fine', normalizeCredentialDraft(draft({ kind: 'legitscript', identifier: '', proofUrl: 'https://www.legitscript.com/websites/?checker_keywords=x.org' })).fields.proofUrl, 'https://www.legitscript.com/websites/?checker_keywords=x.org');
  const stored = cred({ kind: 'accreditation', accreditor: 'other', accreditorName: 'COA', identifier: 'COA-1', issuingState: '', expiresOn: '2027-01-01', proofUrl: 'https://coanet.org/x', note: 'n' });
  check('a stored credential round-trips through the editor', normalizeCredentialDraft(draftFromCredential(stored)).fields,
    { kind: 'accreditation', accreditor: 'other', accreditorName: 'COA', identifier: 'COA-1', issuingState: '', expiresOn: '2027-01-01', proofUrl: 'https://coanet.org/x', note: 'n' });
  ok('every state the editor accepts is two capital letters (the server rule)', Object.keys(US_STATE_NAMES).every((code) => /^[A-Z]{2}$/.test(code)));
}

// ─── (g) The NPI Registry lookup, fetch stubbed ─────────────────────────────

function respond(body, { ok: isOk = true, status = 200 } = {}) {
  return async () => ({ ok: isOk, status, json: async () => body });
}

{
  let calledWith = null;
  const orgBody = {
    result_count: 1,
    results: [{
      number: '1234567893',
      enumeration_type: 'NPI-2',
      basic: { organization_name: '  JUNIPER RIDGE   RECOVERY LLC ', status: 'A' },
      other_names: [{ type: 'Doing Business As', organization_name: 'Juniper Ridge' }, { organization_name: 'JUNIPER RIDGE RECOVERY LLC' }],
      addresses: [{ address_purpose: 'MAILING', city: 'PORTLAND', state: 'OR' }, { address_purpose: 'LOCATION', city: 'BEND', state: 'OR' }],
      taxonomies: [{ desc: 'Clinic/Center', primary: false }, { desc: 'Substance Abuse Rehabilitation Facility', primary: true }],
    }],
  };
  const fetchOrg = async (url, init) => { calledWith = { url, init }; return { ok: true, status: 200, json: async () => orgBody }; };
  const result = await npi.lookupNpi('1234-567-893', fetchOrg, { now: () => new Date('2026-11-04T12:00:00Z') });
  check('the documented API, with the number', calledWith.url, 'https://npiregistry.cms.hhs.gov/api/?version=2.1&number=1234567893');
  ok('a GET with an abort signal', calledWith.init.method === 'GET' && calledWith.init.signal && typeof calledWith.init.signal.aborted === 'boolean');
  check('an organization: name, other names, location, taxonomy', result, {
    ok: true, npi: '1234567893', name: 'JUNIPER RIDGE RECOVERY LLC', otherNames: ['Juniper Ridge'], kind: 'organization',
    place: 'BEND, OR', specialty: 'Substance Abuse Rehabilitation Facility', active: true, checkedAt: '2026-11-04T12:00:00.000Z',
  });

  const person = await npi.lookupNpi('1245319599', respond({ result_count: 1, results: [{ number: 1245319599, enumeration_type: 'NPI-1', basic: { first_name: 'DANA', last_name: 'LEE', credential: 'LCSW' } }] }));
  check('an individual: "First Last, Credential"', [person.ok, person.name, person.kind, person.place], [true, 'DANA LEE, LCSW', 'individual', '']);

  let fetched = false;
  const invalid = await npi.lookupNpi('1234567890', async () => { fetched = true; return { ok: true, status: 200, json: async () => ({}) }; });
  check('a bad check digit never reaches the registry', [invalid, fetched], [{ ok: false, reason: 'invalid', message: npi.NPI_LOOKUP_MESSAGES.invalid }, false]);
  check('no such NPI', (await npi.lookupNpi('1234567893', respond({ result_count: 0, results: [] }))).reason, 'not_found');
  check('the registry\'s error shape', (await npi.lookupNpi('1234567893', respond({ Errors: [{ description: 'Field number must be 10 digits' }] }))).reason, 'not_found');
  check('the registry is down (HTTP 503)', (await npi.lookupNpi('1234567893', respond(null, { ok: false, status: 503 }))).reason, 'unavailable');
  check('a body that is not JSON', (await npi.lookupNpi('1234567893', async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }))).reason, 'unavailable');
  check('a network failure', (await npi.lookupNpi('1234567893', async () => { throw new TypeError('Network request failed'); })).reason, 'unavailable');
  check('an unexpected shape', (await npi.lookupNpi('1234567893', respond({ hello: 'world' }))).reason, 'unavailable');

  // Slow: a fetch that never settles (and ignores the abort) still ends at the deadline.
  let signal = null;
  const started = Date.now();
  const slow = await npi.lookupNpi('1234567893', (_url, init) => { signal = init.signal; return new Promise(() => {}); }, { timeoutMs: 40 });
  check('a registry that never answers times out', slow.reason, 'timeout');
  ok('...at the deadline, not later', Date.now() - started < 2000);
  ok('...and the request is aborted', signal.aborted === true);
  const slowBody = await npi.lookupNpi('1234567893', async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }), { timeoutMs: 40 });
  check('a body that never arrives times out too', slowBody.reason, 'timeout');
  // A fetch that honours the abort (rejects with AbortError) is a timeout, not "down".
  const aborting = await npi.lookupNpi('1234567893', (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
  }), { timeoutMs: 30 });
  check('an aborted request reads as a timeout', aborting.reason, 'timeout');
  ok('the messages are calm and say what to do', Object.values(npi.NPI_LOOKUP_MESSAGES).every((message) => !/error|fail|fraud|danger/i.test(message)));
  check('the default deadline is 8 seconds', npi.NPI_LOOKUP_TIMEOUT_MS, 8000);
  // Registry text is cleaned before it is shown or stored.
  const dirty = npi.parseNppesResponse('1234567893', { results: [{ number: '1234567893', enumeration_type: 'NPI-2', basic: { organization_name: `A\u0000B\nC ${'x'.repeat(300)}` } }] });
  ok('control characters are dropped and the name is capped at 200', dirty.ok && !/[\u0000-\u001f]/.test(dirty.name) && dirty.name.length === 200);
  const credentialsSource = readFileSync(path.join(repoRoot, 'src/lib/credentials.ts'), 'utf8');
  ok('the app passes the device fetch (no key, nothing else)', /lookupNpiWith\(npi, deviceFetch\)/.test(credentialsSource));
}

// ─── (h) Lookup links ───────────────────────────────────────────────────────

{
  check('the four public search pages and the NPI Registry, all https', Object.values(LOOKUP_SITES).map((site) => site.url.startsWith('https://')), [true, true, true, true, true]);
  check('the labels the practitioner taps', Object.values(LOOKUP_SITES).map((site) => site.label), ['Check on LegitScript', 'Joint Commission accreditation search', 'CARF provider search', 'State license lookup', 'NPI Registry']);
  check('LegitScript checks the program\'s domain', lookupLink('legitscript', { website: 'https://www.Juniper-Ridge.org/about' }).url, 'https://www.legitscript.com/websites/?checker_keywords=juniper-ridge.org');
  check('LegitScript without a website opens the checker', lookupLink('legitscript', {}).url, 'https://www.legitscript.com/websites/');
  check('a state license search names the state', lookupLink('stateLicense', { state: 'or' }).url, 'https://www.google.com/search?q=Oregon%20substance%20use%20treatment%20facility%20license%20lookup');
  check('without a state: FindTreatment.gov', lookupLink('stateLicense', {}).url, 'https://findtreatment.gov/');
  check('an NPI opens its registry page', lookupLink('npiRegistry', { npi: '1234567893' }).url, 'https://npiregistry.cms.hhs.gov/provider-view/1234567893');
  check('a bad NPI opens the registry search', lookupLink('npiRegistry', { npi: '1234567890' }).url, 'https://npiregistry.cms.hhs.gov/search');
  check('a JC accreditation links Quality Check', lookupLinksForCredential({ kind: 'accreditation', accreditor: 'joint_commission' }).map((link) => link.site), ['jointCommission']);
  check('a CARF accreditation links CARF', lookupLinksForCredential({ kind: 'accreditation', accreditor: 'carf' }).map((link) => link.site), ['carf']);
  check('another body links both', lookupLinksForCredential({ kind: 'accreditation', accreditor: 'other' }).map((link) => link.site), ['jointCommission', 'carf']);
  check('the program\'s four searches', programLookupLinks({ state: 'OR', website: 'juniper.org' }).map((link) => link.label), ['State license lookup', 'Joint Commission accreditation search', 'CARF provider search', 'Check on LegitScript']);
  check('domains', [websiteDomain('juniper.org'), websiteDomain('http://user@www.x.org:8080/p'), websiteDomain('')], ['juniper.org', 'x.org', '']);
  // Never scraped: no module fetches these sites.
  for (const file of ['src/lib/integrity.ts', 'src/lib/npi.ts', 'src/lib/credentials.ts', 'src/lib/CredentialsCard.tsx', 'src/lib/CredentialReviewQueue.tsx']) {
    const source = readFileSync(path.join(repoRoot, file), 'utf8');
    ok(`${file} never fetches LegitScript, Quality Check or CARF`, !/fetch\([^)]*(legitscript|qualitycheck|carf)/i.test(source));
  }
  const card = readFileSync(path.join(repoRoot, 'src/lib/CredentialsCard.tsx'), 'utf8');
  ok('the card opens links in the browser', card.includes('Linking.openURL(url)'));
  ok('the card presents no Modal', !/<Modal\b/.test(card) && !/\bModal\b,/.test(card));
}

// ─── (i) Today's one card ───────────────────────────────────────────────────

{
  const partners = [
    { id: 'p-exp', organization: 'Expired House', name: '' },
    { id: 'p-soon', organization: 'Soon Lodge', name: '' },
    { id: 'p-acc', organization: 'Accred Ranch', name: '' },
    { id: 'p-ok', organization: 'Fine Place', name: '' },
    { id: 'p-old', organization: 'Old Referral', name: '' },
    { id: 'p-in', organization: 'Inbound Only', name: '' },
    { id: 'p-renewed', organization: 'Renewed Hall', name: '' },
    { id: 'p-rejected', organization: 'Unconfirmed Oaks', name: '' },
    { id: 'p-none', organization: 'Never Referred', name: '' },
  ];
  const lic = (expiresOn, review = 'verified') => cred({ review, verifiedAt: review === 'pending' ? null : 'x', expiresOn });
  const acc = (expiresOn) => cred({ kind: 'accreditation', accreditor: 'carf', issuingState: '', identifier: 'C', review: 'verified', verifiedAt: 'x', expiresOn });
  const byPartner = {
    'p-exp': [lic('2026-10-01'), acc('2026-11-10')],
    'p-soon': [lic('2026-11-20')],
    'p-acc': [lic('2028-01-01'), acc('2026-09-30')],
    'p-ok': [lic('2028-01-01'), acc('2028-01-01')],
    'p-old': [lic('2026-10-01')],
    'p-in': [lic('2026-10-01')],
    'p-renewed': [lic('2026-10-01'), lic('2027-10-01', 'pending')],
    'p-rejected': [cred({ review: 'rejected', verifiedAt: 'x' })],
    'p-none': [lic('2026-10-01')],
  };
  const referrals = [
    { partnerId: 'p-exp', direction: 'Outbound', date: '2026-06-01' },
    { partnerId: 'p-soon', direction: 'Outbound', date: '2026-10-01' },
    { partnerId: 'p-acc', direction: 'Outbound', date: '2025-11-04' },
    { partnerId: 'p-ok', direction: 'Outbound', date: '2026-10-01' },
    { partnerId: 'p-old', direction: 'Outbound', date: '2025-11-03' },
    { partnerId: 'p-in', direction: 'Inbound', date: '2026-10-01' },
    { partnerId: 'p-renewed', direction: 'Outbound', date: '2026-10-01' },
    { partnerId: 'p-rejected', direction: 'Outbound', date: '2026-10-02' },
  ];
  const items = credentialWatchItems({ partners, referrals, integrityFor: (id) => programIntegrity(byPartner[id] || [], TODAY), today: TODAY });
  check('one card: referred-to programs with a license concern or an expired or expiring license or accreditation, the concerns first', items.map((item) => [item.name, item.worst, item.lines]), [
    ['Unconfirmed Oaks', 'expired', ['state license could not be confirmed']],
    ['Accred Ranch', 'expired', ['accreditation expired Sep 30, 2026']],
    ['Expired House', 'expired', ['state license expired Oct 1, 2026', 'accreditation expires Nov 10, 2026']],
    ['Renewed Hall', 'expired', ['state license expired Oct 1, 2026 (renewal pending ReferralFit review)']],
    ['Soon Lodge', 'expiring', ['state license expires Nov 20, 2026']],
  ]);
  check('nothing to show without credentials', credentialWatchItems({ partners, referrals, integrityFor: () => null, today: TODAY }), []);
  check('the card says how many, plainly', credentialWatchSubtitle(items), "5 programs you referred to in the last 12 months. Check with them for the renewal, then add it in the program's Credentials.");
  check('one program', credentialWatchSubtitle(items.slice(0, 1)).startsWith('1 program you referred to'), true);
  const app = readFileSync(path.join(repoRoot, 'App.tsx'), 'utf8');
  ok('Today renders one card for the list, not one per item', (app.match(/credentialWatchSubtitle\(credentialWatch\)/g) || []).length === 1 && app.includes('CREDENTIALS TO CHECK'));
}

// ─── (j) The Alert and the timeline note ────────────────────────────────────

{
  const expiredConcern = { status: 'expired', credential: cred({ expiresOn: '2026-10-01' }), renewal: null };
  const alert = licenseConcernAlert('Juniper Ridge', expiredConcern, 'refer');
  check('the refer Alert', alert, {
    title: 'Check the license first',
    message: 'Juniper Ridge: Its state license shows expired (Oct 1, 2026). Check with the program before referring. Refer anyway?',
    proceed: 'Refer anyway',
  });
  check('the packet Alert asks about the packet', licenseConcernAlert('Juniper Ridge', expiredConcern, 'packet').proceed, 'Send anyway');
  ok('a rejected license is "could not be confirmed"', licenseConcernAlert('X', { status: 'rejected', credential: cred({ review: 'rejected' }), renewal: null }, 'refer').message.includes('could not be confirmed'));
  check('the timeline note', licenseOverrideNote('Juniper Ridge', expiredConcern), 'Referred anyway: the state license for Juniper Ridge showed expired (Oct 1, 2026), and the practitioner confirmed going ahead.');
  const renewingConcern = { ...expiredConcern, renewal: cred({ review: 'pending', expiresOn: '2027-10-01' }) };
  check('the Refer anyway? prompt names a renewal waiting for ReferralFit', licenseConcernAlert('Juniper Ridge', renewingConcern, 'refer').message,
    'Juniper Ridge: Its state license shows expired (Oct 1, 2026). Renewal pending ReferralFit review. Check with the program before referring. Refer anyway?');
  check('and the timeline note says so too', licenseOverrideNote('Juniper Ridge', renewingConcern), 'Referred anyway: the state license for Juniper Ridge showed expired (Oct 1, 2026) (renewal pending ReferralFit review), and the practitioner confirmed going ahead.');
  check('the packet note', licenseOverrideNote('Juniper Ridge', expiredConcern, 'packet').startsWith('Sent anyway:'), true);
  const words = [alert.message, licenseOverrideNote('J', expiredConcern), integrityHeadline(programIntegrity([], TODAY)), ...Object.values(FLAG_LABELS)].join(' ');
  ok('calm words: never fraud, scam, danger, warning or illegal', !/fraud|scam|danger|warning|illegal|bad actor/i.test(words));
  check('titles', [credentialTitle({ kind: 'state_license', issuingState: 'OR' }), credentialTitle({ kind: 'accreditation', accreditor: 'joint_commission' }), credentialTitle({ kind: 'accreditation', accreditor: 'other', accreditorName: 'COA' }), credentialTitle({ kind: 'npi' })],
    ['State license (OR)', 'Joint Commission accreditation', 'COA accreditation', 'NPI']);
  check('status words by who checks', [statusLabel('verified', 'listing'), statusLabel('verified', 'local'), statusLabel('pending', 'listing'), statusLabel('pending', 'local')],
    ['Verified by ReferralFit', 'Checked by your practice', 'Pending ReferralFit review', 'Not checked yet']);
  check('expiry lines', [expiryLine({ kind: 'npi', expiresOn: null }, TODAY), expiryLine({ kind: 'state_license', expiresOn: '2026-11-05' }, TODAY), expiryLine({ kind: 'state_license', expiresOn: '2026-10-01' }, TODAY)],
    ['NPIs do not expire', 'Expires Nov 5, 2026 (in 1 day)', 'Expired Oct 1, 2026']);
  const app = readFileSync(path.join(repoRoot, 'App.tsx'), 'utf8');
  ok('Assign & refer and Send packet both ask first (Alert, not a Modal)', /confirmLicenseConcern\(chosenPartner, 'refer'/.test(app) && (app.match(/confirmLicenseConcern\(partner, 'packet'/g) || []).length === 2 && /Alert\.alert\(prompt\.title, prompt\.message/.test(app));
  ok('the composer opens only after the Alert has gone (afterSheetCloses)', (app.match(/confirmLicenseConcern\(partner, 'packet', \(concern\) => afterSheetCloses\(/g) || []).length === 2);
}

// ─── (k) The wire format ────────────────────────────────────────────────────

{
  const table = migration.slice(migration.indexOf('CREATE TABLE IF NOT EXISTS public.program_credentials'), migration.indexOf('CONSTRAINT program_credentials_one_owner'));
  const columns = [...table.matchAll(/^\s{2}([a-z_]+)\s+(uuid|text|date|timestamptz)/gm)].map((match) => match[1]);
  ok('every column the app reads exists in the table', CREDENTIAL_COLUMNS.every((column) => columns.includes(column)));
  const row = {
    id: 'F1000000-0000-0000-0000-000000C7ED01', global_partner_id: 'D1000000-0000-0000-0000-000000C7ED01', org_id: null, partner_id: null,
    kind: 'accreditation', accreditor: 'carf', accreditor_name: '', identifier: 'C-1', issuing_state: '', expires_on: '2027-01-01',
    proof_url: 'https://carf.org/x', note: '', status: 'verified', verified_by: 'A1', verified_at: '2026-11-01T00:00:00Z', verification_note: 'ok',
    npi_lookup_name: null, npi_checked_at: null, updated_by: null, updated_at: '2026-11-01T00:00:00Z',
  };
  const mapped = credentialFromRow(row);
  check('a listing row maps', [mapped.id, mapped.scope, mapped.globalPartnerId, mapped.accreditor, mapped.review, mapped.verifiedBy], ['f1000000-0000-0000-0000-000000c7ed01', 'listing', 'd1000000-0000-0000-0000-000000c7ed01', 'carf', 'verified', 'a1']);
  check('a local row maps', credentialFromRow({ ...row, global_partner_id: null, org_id: 'o', partner_id: 'P1' }).scope, 'local');
  check('an unknown kind is skipped', credentialFromRow({ ...row, kind: 'dea' }), null);
  check('an unknown review reads as pending', credentialFromRow({ ...row, status: 'weird' }).review, 'pending');
  check('a bad date reads as none', credentialFromRow({ ...row, expires_on: 'soon' }).expiresOn, null);
}

// ─── (l) The portal's mirror agrees ─────────────────────────────────────────

{
  for (const [review, expiresOn] of [['pending', null], ['verified', null], ['rejected', '2030-01-01'], ['verified', '2026-11-03'], ['pending', TODAY], ['verified', '2026-12-04'], ['verified', '2026-12-05']]) {
    check(`portal status ${review} ${expiresOn}`, portal.credentialStatus(review, expiresOn, TODAY), credentialStatus({ review, expiresOn }, TODAY));
  }
  for (const value of ['1234567893', '1245319599', '1234567890', '123', 'abcdefghij']) check(`portal NPI ${value}`, portal.isValidNpi(value), isValidNpi(value));
  const forms = [
    { kind: 'state_license', identifier: 'L', issuingState: 'or', expiresOn: '2027-06-30', proofUrl: 'oha.example.gov/x' },
    { kind: 'state_license', identifier: '', issuingState: 'OR' },
    { kind: 'npi', identifier: '1234 567 893' },
    { kind: 'npi', identifier: '1234567890' },
    { kind: 'accreditation', accreditor: 'other', accreditorName: '', identifier: 'A' },
    { kind: 'legitscript', identifier: '', proofUrl: '' },
    { kind: 'legitscript', identifier: 'LS', proofUrl: 'http://x.org' },
  ];
  for (const form of forms) {
    const full = { ...portal.emptyForm(), accreditorName: '', note: '', expiresOn: '', proofUrl: '', ...form };
    const app = normalizeCredentialDraft({ ...emptyCredentialDraft(form.kind), ...full, accreditor: form.kind === 'accreditation' ? full.accreditor : null });
    const site = portal.validateForm(full);
    if ('problem' in app) check(`portal refuses what the app refuses: ${app.problem}`, site.problem, app.problem);
    else check(`portal sends what the app sends (${form.kind})`, site.payload, {
      p_kind: app.fields.kind, p_accreditor: app.fields.accreditor, p_accreditor_name: app.fields.accreditorName, p_identifier: app.fields.identifier,
      p_issuing_state: app.fields.issuingState, p_expires_on: app.fields.expiresOn, p_proof_url: app.fields.proofUrl, p_note: app.fields.note,
    });
  }
  const portalUi = readFileSync(path.join(repoRoot, 'portal/src/Credentials.tsx'), 'utf8');
  ok('the portal says "pending ReferralFit review" after a change', portalUi.includes('pending ReferralFit review'));
}

// ─── (l2) Notes, NPI hints, removals, workspaces ────────────────────────────

{
  // A listing's notes never reach a practitioner: whatever an older server
  // still sends on the rows is dropped, and only fetch_listing_credential_notes
  // (claimant or platform admin) returns them.
  const row = (fields) => ({
    id: 'C1', global_partner_id: 'G1', org_id: null, partner_id: null, kind: 'state_license', accreditor: null, accreditor_name: '',
    identifier: 'L', issuing_state: 'OR', expires_on: null, proof_url: null, note: 'Call our intake director', status: 'rejected',
    verified_by: null, verified_at: '2026-11-01T00:00:00Z', verification_note: 'Number not found', npi_lookup_name: null, npi_checked_at: null,
    updated_by: null, updated_at: '2026-11-01T00:00:00Z', ...fields,
  });
  fakeSupabase.rpc = async (name) => (name === 'fetch_listing_credentials' ? { data: [row({}), row({ id: 'C2', note: null, verification_note: null })], error: null, status: 200 } : { data: null, error: { code: 'X' }, status: 400 });
  const read = await credentialsApi.fetchListingCredentials(['g1']);
  check('listing rows reach the app without their notes, even from an older server', read.byListing.g1.map((item) => [item.note, item.verificationNote]), [['', ''], ['', '']]);
  const local = credentialsApi.withoutListingNotes(credentialFromRow(row({ global_partner_id: null, partner_id: 'P1' })));
  check('a practice\'s own row keeps its notes', [local.note, local.verificationNote], ['Call our intake director', 'Number not found']);

  let asked = null;
  fakeSupabase.rpc = async (name, args) => { asked = { name, args }; return { data: [{ id: 'C1', note: 'n1', verification_note: 'v1' }, { id: 'C2', note: null, verification_note: null }], error: null, status: 200 }; };
  check('the notes call: ReferralFit\'s and the claimant\'s own', await credentialsApi.fetchListingCredentialNotes('G1'), { c1: { note: 'n1', verificationNote: 'v1' }, c2: { note: '', verificationNote: '' } });
  check('it asks for one listing by id', asked, { name: 'fetch_listing_credential_notes', args: { p_global_partner_id: 'g1' } });
  fakeSupabase.rpc = async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' }, status: 404 });
  check('an older server without the call: no notes, no failure', await credentialsApi.fetchListingCredentialNotes('G1'), null);

  // A claimant removing a credential ReferralFit could not confirm: the
  // server keeps it (42501) and its words are shown calmly.
  const KEPT = 'ReferralFit could not confirm this credential, so it stays on record. Add an updated one and we will review it.';
  fakeSupabase.rpc = async () => ({ data: null, error: { code: '42501', message: KEPT }, status: 403 });
  await assert.rejects(credentialsApi.deleteCredential('C1'), (error) => error instanceof credentialsApi.CredentialKeptError && error.message === KEPT);
  checks += 1;
  check('the kept credential is information, under a calm title', credentialsApi.CREDENTIAL_KEPT_TITLE, 'Kept on record');
  check('the portal says the same when the server sends no words', portal.KEPT_ON_RECORD_FALLBACK, KEPT);

  // Editing a credential ReferralFit could not confirm into another kind,
  // accreditor or state: the server's way forward (22023), said calmly.
  const CORRECT_ONLY = 'ReferralFit could not confirm this credential. Correct its number, date or link, or add a new credential.';
  check('the app and the portal have the server\'s sentence', [credentialsApi.CREDENTIAL_CORRECT_ONLY, portal.CORRECT_ONLY_MESSAGE], [CORRECT_ONLY, CORRECT_ONLY]);
  const integrityMigration = readFileSync(path.join(repoRoot, 'supabase/migrations/20261104130000_program_integrity.sql'), 'utf8');
  ok('the migration refuses with that sentence when a rejection sticks', integrityMigration.includes(`RAISE EXCEPTION '${CORRECT_ONLY}'`)
    && /IF v_sticks AND \(n\.kind, n\.accreditor, n\.accreditor_name, n\.issuing_state\)\s*IS DISTINCT FROM \(p_old\.kind, p_old\.accreditor, p_old\.accreditor_name, p_old\.issuing_state\) THEN/.test(integrityMigration));
  const fields = { kind: 'state_license', accreditor: null, accreditorName: '', identifier: 'OR-1', issuingState: 'WA', expiresOn: null, proofUrl: null, note: '' };
  fakeSupabase.rpc = async () => ({ data: null, error: { code: '22023', message: CORRECT_ONLY }, status: 400 });
  await assert.rejects(credentialsApi.saveCredential({ globalPartnerId: 'G1' }, fields, 'C1'), (error) => error instanceof credentialsApi.CredentialKeptError && error.message === CORRECT_ONLY);
  checks += 1;
  fakeSupabase.rpc = async () => ({ data: null, error: { code: '22023', message: 'Add the license number' }, status: 400 });
  await assert.rejects(credentialsApi.saveCredential({ globalPartnerId: 'G1' }, fields, 'C1'),
    (error) => !(error instanceof credentialsApi.CredentialKeptError) && error.message === 'Add the license number');
  checks += 1;
  check('the portal tells the kept sentence apart from other refusals', [
    portal.keptCredentialMessage({ code: '22023', message: CORRECT_ONLY }), portal.keptCredentialMessage({ code: '22023', message: 'Add the license number' }),
    portal.keptCredentialMessage({ code: '42501', message: CORRECT_ONLY }), portal.keptCredentialMessage(null),
  ], [CORRECT_ONLY, null, null, null]);

  // NPI Registry hints on a listing's credential: platform admins only.
  check('who keeps an NPI Registry hint', [
    credentialsApi.mayKeepNpiHint('local', false), credentialsApi.mayKeepNpiHint('local', true),
    credentialsApi.mayKeepNpiHint('listing', false), credentialsApi.mayKeepNpiHint('listing', true),
  ], [true, true, false, true]);

  const card = readFileSync(path.join(repoRoot, 'src/lib/CredentialsCard.tsx'), 'utf8');
  ok('both NPI hint paths ask mayKeepNpiHint (the card\'s and the editor\'s)', (card.match(/mayKeepNpiHint\(/g) || []).length === 2 && !/result\.ok && \(credential\.scope === 'local'/.test(card));
  ok('the card never renders a row\'s own note or verification note for a listing', !/credential\.note \?/.test(card) && !/credential\.verificationNote \?/.test(card) && /credential\.scope === 'listing' \? listingNote\(credential\) : credential/.test(card));
  ok('ReferralFit\'s notes come from fetch_listing_credential_notes, only with canEditListing', /if \(!canEditListing \|\| !listingId\) \{\s*setNotes\(\(current\) => \(current\.status === 'idle' && !Object\.keys\(current\.byId\)\.length \? current : \{ status: 'idle', byId: \{\} \}\)\);\s*return;\s*\}/.test(card) && card.includes('fetchListingCredentialNotes(listingId)'));
  ok('a listing\'s credential is edited only once its notes have loaded (the note is never wiped)', /credential\.scope === 'listing' && notes\.status !== 'ready'/.test(card));
  ok('a kept credential is shown calmly, not as a failure', /error instanceof CredentialKeptError\) Alert\.alert\(CREDENTIAL_KEPT_TITLE, error\.message\)/.test(card));
  ok('in the editor too: the way forward in calm words, not as an alert', /const calm = error instanceof CredentialKeptError;/.test(card)
    && card.includes("accessibilityRole={current.calm ? undefined : 'alert'}") && card.includes('style={current.calm ? styles.calmNote : styles.problem}'));
  ok('the notes are read in order: an older read never lands over a newer one', /const read = \+\+notesReadRef\.current;/.test(card)
    && /if \(!mountedRef\.current \|\| notesReadRef\.current !== read\) return;/.test(card) && /if \(mountedRef\.current && notesReadRef\.current === read\) setNotes/.test(card));

  // The portal: the claimant's own notes come back from their own call.
  const rows = [{ id: 'C1', note: null, verification_note: null }, { id: 'C2', note: 'old row note', verification_note: '' }];
  check('the portal puts the notes back on the claimant\'s rows', portal.withListingNotes(rows, portal.notesFromRows([{ id: 'c1', note: 'mine', verification_note: 'fix the number' }])).map((item) => [item.note, item.verification_note]),
    [['mine', 'fix the number'], ['old row note', '']]);
  check('a row with no notes edits as an empty note', portal.formFromRow({ ...rows[0], kind: 'npi', accreditor: null, accreditor_name: '', identifier: '1234567893', issuing_state: '', expires_on: null, proof_url: null, status: 'pending', verified_at: null, updated_at: '' }).note, '');
  check('after a save: pending, or still not confirmed for an edited rejected one', [portal.savedNotice('pending').includes('pending ReferralFit review'), portal.savedNotice('rejected').includes('not confirmed')], [true, true]);
  const portalUi = readFileSync(path.join(repoRoot, 'portal/src/Credentials.tsx'), 'utf8');
  ok('the portal labels the note for ReferralFit only', portalUi.includes('Note for ReferralFit (only ReferralFit sees this)'));
  ok('the portal reads the notes with their own call', portalUi.includes("rpc('fetch_listing_credential_notes', { p_global_partner_id: listingId })"));
  ok('the portal shows a kept credential as information, not an error', /error\.code === '42501'\) \{ setInfo\(/.test(portalUi));
  ok('and the way forward for an edit it will not take, in the form', /const kept = keptCredentialMessage\(error\);\s*if \(kept\) \{ setFormInfo\(kept\); return; \}/.test(portalUi)
    && portalUi.includes('{formInfo ? <p className="help" role="status">{formInfo}</p> : null}'));
  const queue = readFileSync(path.join(repoRoot, 'src/lib/CredentialReviewQueue.tsx'), 'utf8');
  ok('the review queue says who reads a rejection note', queue.includes("'The program sees this note; practitioners do not'") && queue.includes('{REJECTION_NOTE_LABEL}'));

  // A failed read after a workspace change never shows the last workspace's rows.
  ok('the index belongs to one account and one workspace', /export function credentialScopeKey\(userId: string \| undefined, workspaceKey: string \| number\): string \{\s*return `\$\{userId \|\| ''\}\|\$\{workspaceKey\}`;/.test(card));
  ok('the hook drops the last workspace\'s rows (scope-held state, not only on a user change)', /const state = held\.scope === scope \? held\.state : INITIAL_STATE;/.test(card)
    && /current\.scope === readScope && current\.state\.status === 'ready'/.test(card));
  const app = readFileSync(path.join(repoRoot, 'App.tsx'), 'utf8');
  ok('App scopes credentials, placement requests and assessments to the workspace', app.includes('useCredentialIndex(session?.user?.id, linkedListingIds, credentialsNonce, workspaceEpoch)')
    && app.includes('usePlacementRequests(session?.user?.id, credentialsNonce, workspaceEpoch)')
    && /useCaseAssessments\(session\?\.user\?\.id, credentialsNonce, \[[^\]]+\], workspaceEpoch\)/.test(app));
}

// ─── (m) Matching integrity ─────────────────────────────────────────────────

{
  const base = {
    name: 'Intake', type: 'Inpatient', types: ['Inpatient'], city: 'Bend', state: 'OR', regions: ['Nationwide'], phone: '', email: '',
    cashMin: 0, cashMax: 0, insurance: ['Aetna'], therapies: ['Trauma', 'MAT'], populations: ['Adults'], levels: ['Inpatient'],
    note: '', inbound: 0, outbound: 0, lastContact: '2026-10-01',
  };
  const partners = [0, 1, 2, 3, 4, 5, 6].map((i) => ({
    ...base,
    id: `p${i}`,
    organization: `Program ${i}`,
    monthlyCost: 9000 + 4000 * i,
    insuranceNetworks: { Aetna: i % 2 ? ['Out-of-network'] : ['In-network'] },
    therapies: i % 3 ? ['Trauma', 'MAT'] : ['MAT'],
    globalPartnerId: `g${i}`,
  }));
  const profile = {
    id: 'm-1', clientLabel: 'J.R.', levelOfCare: 'Inpatient', state: 'OR', insurance: 'Aetna', networkPreferences: ['In-network', 'Out-of-network'],
    therapies: ['Trauma'], status: 'Matching', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
  };
  const snapshot = JSON.stringify(partners);
  const before = matching.rankPrograms(profile, partners, {});
  // Credentials that run against the ranking: the top programs get the worst.
  const credentialsFor = (partner, rank) => (rank < 3
    ? [cred({ globalPartnerId: partner.globalPartnerId, review: 'rejected', verifiedAt: 'x' })]
    : [cred({ globalPartnerId: partner.globalPartnerId, review: 'verified', verifiedAt: 'x', expiresOn: '2028-01-01' }),
      cred({ globalPartnerId: partner.globalPartnerId, kind: 'legitscript', issuingState: '', identifier: 'LS', review: 'verified', verifiedAt: 'x' })]);
  const chips = before.map((score, rank) => programIntegrity(credentialsFor(score.partner, rank), TODAY).chip);
  const after = matching.rankPrograms(profile, partners, {});
  check('the order and every score are identical after the chips are worked out', after.map((score) => [score.partner.id, score.total, score.components]), before.map((score) => [score.partner.id, score.total, score.components]));
  check('working out credentials never touches the partners', JSON.stringify(partners), snapshot);
  ok('the fixture puts unverified programs above verified ones, so credentials cannot be an input', chips.slice(0, 3).every((chip) => chip !== 'verified') && chips.slice(3).every((chip) => chip === 'verified'));
  const matchingSource = readFileSync(path.join(repoRoot, 'src/lib/matching.ts'), 'utf8');
  ok('matching.ts never reads credentials', !/integrity|credential|licen[cs]e|legitscript|accredit/i.test(matchingSource));
  const app = readFileSync(path.join(repoRoot, 'App.tsx'), 'utf8');
  ok('App ranks with the same inputs as before', app.includes('() => rankPrograms(draftMatchProfile, partners, scorecards, bedOptions),'));
  check('the weights are unchanged', matching.scoringWeights(), { clinical: 50, cost: 25, location: 10, trackRecord: 15, priorCases: 5 });
  const directory = readFileSync(path.join(repoRoot, 'src/lib/GlobalDirectoryScreen.tsx'), 'utf8');
  ok('the directory search sends no credential filter', !/searchGlobalDirectory\([^)]*credential/i.test(directory));
}

// ─── (n) The migration follows the paste rules ──────────────────────────────

// Top-level statements, split on semicolons outside quotes, comments and
// dollar-quoted bodies; each chunk includes its leading comment.
function topLevelStatements(sql) {
  const statements = [];
  let start = 0;
  let index = 0;
  let dollar = null;
  while (index < sql.length) {
    if (dollar) {
      if (sql.startsWith(dollar, index)) { index += dollar.length; dollar = null; } else index += 1;
      continue;
    }
    const rest = sql.slice(index);
    const tag = /^\$[A-Za-z_]*\$/.exec(rest);
    if (tag) { dollar = tag[0]; index += tag[0].length; continue; }
    if (sql[index] === '-' && sql[index + 1] === '-') { const end = sql.indexOf('\n', index); index = end < 0 ? sql.length : end + 1; continue; }
    if (sql[index] === "'") { index += 1; while (index < sql.length) { if (sql[index] === "'" && sql[index + 1] === "'") index += 2; else if (sql[index] === "'") { index += 1; break; } else index += 1; } continue; }
    if (sql[index] === ';') { statements.push(sql.slice(start, index + 1)); start = index + 1; }
    index += 1;
  }
  const tail = sql.slice(start).trim();
  return { statements, tail, unterminated: dollar };
}

{
  ok('ASCII only', /^[\x00-\x7F]*$/.test(migration));
  ok('no backslash anywhere', !migration.includes('\\'));
  const { statements, tail, unterminated } = topLevelStatements(migration);
  ok('every dollar quote is closed', unterminated === null);
  check('nothing after the last statement', tail, '');
  const longest = Math.max(...statements.map((statement) => statement.length));
  ok(`every top-level statement is under 3,700 characters (longest ${longest})`, longest < 3700);
  check('the whole file runs in one BEGIN/COMMIT', [statements[0].trim().endsWith('BEGIN;'), statements[statements.length - 1].trim().endsWith('COMMIT;')], [true, true]);
  ok('only one BEGIN and one COMMIT', statements.filter((statement) => /^\s*(--[^\n]*\n\s*)*BEGIN;\s*$/.test(statement)).length === 1 && statements.filter((statement) => /COMMIT;\s*$/.test(statement)).length === 1);
  ok('the new table is revoked before its one grant', migration.indexOf('REVOKE ALL ON TABLE public.program_credentials FROM PUBLIC, anon, authenticated;') < migration.indexOf('GRANT SELECT ON TABLE public.program_credentials TO authenticated;'));
  const definers = [...migration.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)\(([^)]*)\)[\s\S]*?\$\$;\s*\n(REVOKE ALL ON FUNCTION public\.\1\([^)]*\) FROM PUBLIC, anon[^;]*;)/g)];
  const created = [...migration.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)\(/g)].map((match) => match[1]);
  check('every function is revoked from PUBLIC and anon right after it is made', definers.map((match) => match[1]).sort(), [...created].sort());
  const securityDefiners = [...migration.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)\([\s\S]*?(SECURITY DEFINER)?\s*\nSET search_path/g)];
  ok('every function pins its search_path', securityDefiners.length === created.length);
  for (const name of ['referral_handoffs', 'referral_handoff_events', 'referral_sources', 'referral_intake_submissions', 'referral_intake_rate_limits', 'center_availability']) {
    ok(`no object named ${name}`, !migration.includes(name));
  }
}

console.log(`program integrity: ${checks} checks ok`);
