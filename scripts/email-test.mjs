// Email alerts (migration 20261108120000_email_alerts.sql, docs/EMAIL.md):
// the app's "Email me about..." settings, the portal's signed-out /b and /u
// pages, and the wiring around them. Run with: node scripts/email-test.mjs

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'email-test');
const require = createRequire(import.meta.url);
const ts = require(path.join(repoRoot, 'node_modules', 'typescript'));
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

function transpileTo(relSrc, outName) {
  const js = ts.transpileModule(read(relSrc), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const outPath = path.join(tmpDir, outName);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, js);
  return outPath;
}

let checks = 0;
const check = (fn, name) => { fn(); checks += 1; void name; };

// ─── App: src/lib/email-preferences.ts ──────────────────────────────────────
mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
writeFileSync(path.join(tmpDir, 'lib', 'supabase.js'), "Object.defineProperty(exports, 'supabase', { get: () => globalThis.__emailSupabase });");
transpileTo('src/lib/errors.ts', 'lib/errors.js');
const prefs = require(transpileTo('src/lib/email-preferences.ts', 'lib/email-preferences.js'));

check(() => assert.deepEqual(prefs.DEFAULT_EMAIL_PREFERENCES, { placementResponse: true, dailySummary: false }), 'defaults match the server');
check(() => assert.deepEqual(prefs.mapEmailPreferences(null), { placementResponse: true, dailySummary: false }), 'no row = defaults');
check(() => assert.deepEqual(prefs.mapEmailPreferences({ placement_response: false, daily_summary: true }), { placementResponse: false, dailySummary: true }), 'row mapped');
check(() => assert.deepEqual(prefs.mapEmailPreferences({ placement_response: 'yes' }), { placementResponse: true, dailySummary: false }), 'junk reads as defaults');
check(() => {
  const now = new Date('2026-11-08T15:00:00Z');
  const args = prefs.emailPreferenceArgs('dailySummary', true, now);
  assert.equal(args.p_placement_response, null);
  assert.equal(args.p_daily_summary, true);
  assert.equal(args.p_tz_offset_minutes, -now.getTimezoneOffset());
}, 'one change at a time, with the device time zone');
check(() => {
  for (const code of ['PGRST202', '42883', '42P01']) assert.equal(prefs.isMissingEmailFeature({ code }), true, code);
  for (const code of ['42501', '22023', undefined]) assert.equal(prefs.isMissingEmailFeature({ code }), false, String(code));
}, 'only a missing function or table reads as an older server');
check(() => {
  const text = prefs.EMAIL_PREFERENCE_ROWS.map((row) => `${row.label} ${row.description}`).join(' ');
  assert.match(text, /Counts only/);
  assert.match(text, /Program names and client details stay in the app/);
}, 'the switches say what email never carries');

// Fetch and save against a fake client.
const calls = [];
globalThis.__emailSupabase = {
  rpc: async (name, args) => {
    calls.push({ name, args });
    if (globalThis.__emailMissing) return { data: null, error: { code: 'PGRST202', message: 'not found' } };
    if (name === 'get_email_preferences') return { data: [{ placement_response: true, daily_summary: false, bed_reminder: true }], error: null };
    return { data: [{ placement_response: true, daily_summary: Boolean(args.p_daily_summary), bed_reminder: true }], error: null };
  },
};
check(() => {}, 'fake client ready');
const state = await prefs.fetchEmailPreferences();
check(() => assert.deepEqual(state, { available: true, preferences: { placementResponse: true, dailySummary: false } }), 'fetch');
const saved = await prefs.saveEmailPreference('dailySummary', true);
check(() => assert.equal(saved.dailySummary, true), 'save returns the server row');
check(() => assert.equal(calls.at(-1).name, 'set_email_preferences'), 'save calls set_email_preferences');
globalThis.__emailMissing = true;
const older = await prefs.fetchEmailPreferences();
check(() => assert.equal(older.available, false), 'an older server reads as unavailable');
globalThis.__emailMissing = false;

// The card is on every platform (email is not phone-only).
const workspace = read('src/lib/WorkspaceScreen.tsx');
check(() => assert.match(workspace, /<Text style=\{styles\.cardLabel\}>Email me about\.\.\.<\/Text>/), 'the card exists');
check(() => {
  const start = workspace.indexOf('<Text style={styles.cardLabel}>Email me about...</Text>');
  const card = workspace.slice(start, workspace.indexOf('Privacy on this phone', start));
  assert.doesNotMatch(card, /Platform\.OS/);
}, 'the email card is not hidden on the web');

// ─── Portal: email-rules.ts ─────────────────────────────────────────────────
const rules = require(transpileTo('portal/src/email-rules.ts', 'portal/email-rules.js'));
const T = 'a'.repeat(64);
check(() => assert.equal(rules.bedTokenFrom(`#${T}`), T), 'a /b token');
check(() => assert.equal(rules.bedTokenFrom(`#${T.toUpperCase()}`), T), 'upper case is folded');
check(() => assert.equal(rules.bedTokenFrom('#short'), null), 'a short token is no token');
check(() => assert.equal(rules.bedTokenFrom(''), null), 'no fragment');
check(() => assert.deepEqual(rules.preferenceLinkFrom(`#${T}:daily_summary`), { token: T, kind: 'daily_summary' }), 'a /u link with its kind');
check(() => assert.deepEqual(rules.preferenceLinkFrom(`#${T}:everything`), { token: T, kind: null }), 'an unknown kind is dropped, not trusted');
check(() => assert.deepEqual(rules.preferenceLinkFrom(`#${T}`), { token: T, kind: null }), 'a /u link without a kind');
check(() => assert.equal(rules.preferenceLinkFrom('#nope:daily_summary'), null), 'a bad /u token');
check(() => assert.deepEqual(rules.kindsFor(true, false), ['placement_response', 'daily_summary']), 'practices manage two emails');
check(() => assert.deepEqual(rules.kindsFor(false, true), ['bed_reminder']), 'programs manage one');
check(() => assert.deepEqual(rules.kindsFor(false, false), []), 'nobody, nothing');
check(() => {
  assert.equal(rules.stepCount(null, 1), 1);
  assert.equal(rules.stepCount(null, -1), null);
  assert.equal(rules.stepCount(0, -1), 0);
  assert.equal(rules.stepCount(999, 1), 999);
  assert.equal(rules.stepCount(3, 1), 4);
}, 'the stepper stays within 0..999');
check(() => {
  const now = new Date('2026-11-08T16:00:00Z');
  assert.equal(rules.bedsLine(3, 1, '2026-11-08T10:00:00Z', false, now), '3 beds for men, 1 bed for women, confirmed today.');
  assert.equal(rules.bedsLine(0, 0, '2026-11-07T10:00:00Z', false, now), 'Full, confirmed yesterday.');
  assert.match(rules.bedsLine(2, null, '2026-10-29T10:00:00Z', true, now), /^2 beds for men, women: not set, last confirmed 10 days ago\. Practices now see Unconfirmed/);
  assert.match(rules.bedsLine(null, null, null, false, now), /^Not set yet/);
}, 'the beds line');

// ─── Portal pages: signed out, token out of the address bar, no change on open ──
const main = read('portal/src/main.tsx');
const bedPage = read('portal/src/BedCheckIn.tsx');
const prefPage = read('portal/src/EmailPreferences.tsx');
check(() => assert.match(main, /const isBedCheckIn = \/\^\\\/b\\\/\?\$\/\.test\(window\.location\.pathname\);/), 'the portal serves /b');
check(() => assert.match(main, /const isEmailPreferences = \/\^\\\/u\\\/\?\$\/\.test\(window\.location\.pathname\);/), 'the portal serves /u');
for (const [name, page] of [['BedCheckIn', bedPage], ['EmailPreferences', prefPage]]) {
  check(() => assert.match(page, /import \{ signedOutSupabase as supabase \} from '\.\/supabase';/), `${name} is signed out`);
  check(() => assert.match(page, /window\.history\.replaceState\(null, '', window\.location\.pathname\)/), `${name} clears the token from the address bar`);
}
check(() => {
  const effect = prefPage.slice(prefPage.indexOf('useEffect('), prefPage.indexOf('async function set('));
  assert.doesNotMatch(effect, /public_email_set_preference/);
}, 'opening /u changes nothing (mail scanners open links)');
check(() => {
  const effect = bedPage.slice(bedPage.indexOf('useEffect('), bedPage.indexOf('async function save('));
  assert.doesNotMatch(effect, /public_bed_link_save/);
}, 'opening /b saves nothing');

// ─── Server and function wiring ─────────────────────────────────────────────
const migration = read('supabase/migrations/20261108120000_email_alerts.sql');
const config = read('supabase/config.toml');
const workflow = read('.github/workflows/quality.yml');
check(() => assert.match(config, /\[functions\.email-dispatch\]\nverify_jwt = false/), 'the function checks its own secret');
check(() => assert.match(workflow, /supabase\/functions\/email-dispatch\/index\.ts/), 'CI type-checks the function');
check(() => assert.match(workflow, /supabase\/functions\/email-dispatch\//), 'CI tests the function');
for (const fn of ['public_bed_link_open(text)', 'public_bed_link_save(text, integer, integer, text, text)', 'public_email_preferences(text)']) {
  check(() => assert.ok(migration.includes(`GRANT EXECUTE ON FUNCTION public.${fn} TO anon, authenticated;`), fn), `${fn} is open to the signed-out pages`);
}
for (const fn of ['email_outbox_claim(integer)', 'email_outbox_record(jsonb)']) {
  check(() => assert.ok(migration.includes(`GRANT EXECUTE ON FUNCTION public.${fn} TO service_role;`), fn), `${fn} is the dispatcher's only`);
}
check(() => assert.doesNotMatch(migration, /[^\x00-\x7f]/), 'the migration is ASCII (transit-safe)');

console.log(`email-test: ${checks} checks passed`);
