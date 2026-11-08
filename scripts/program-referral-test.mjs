// Program referrals (a treatment program refers a family to an
// interventionist): the portal's rules (portal/src/program-referral-rules.ts)
// and the app's (src/lib/program-referral-rules.ts) run in plain node, no
// build step (same transpile approach as integrity-test).
//
//   (a) the referral form: the server's own rules, consent required
//   (b) what the program reads: milestones, "Entered treatment at X", times
//   (c) the track record: rates over shared referrals, never a destination
//   (d) the practice's side: rows, the sharing and accepting explanations
//   (e) ethics: matching never reads program referrals; no "returned" metric
//   (f) the wiring: portal, case file, Workspace; RPC names and arguments
//   (g) the migration follows the paste rules

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'program-referral-test');
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

const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');
const portal = require(transpileTo('portal/src/program-referral-rules.ts', 'portal/program-referral-rules.js'));
const app = require(transpileTo('src/lib/program-referral-rules.ts', 'lib/program-referral-rules.js'));
const migration = read('supabase/migrations/20261108140000_program_referrals.sql');

let checks = 0;
function check(label, actual, expected) {
  assert.deepEqual(actual, expected, label);
  checks += 1;
}
function ok(label, value) {
  assert.ok(value, label);
  checks += 1;
}

// ─── (a) the referral form ──────────────────────────────────────────────────
{
  const { validateReferral, emptyReferralForm } = portal;
  const good = { ...emptyReferralForm(), callerName: ' Maria ', phone: '(503) 555-0101', email: 'maria@example.test',
    relationship: 'mother', aboutFirstName: 'Alex', note: ' Called us. ', consent: true };
  check('a complete form becomes the RPC arguments', validateReferral(good), { payload: {
    p_caller_first_name: 'Maria', p_phone: '(503) 555-0101', p_email: 'maria@example.test', p_relationship: 'mother',
    p_about_first_name: 'Alex', p_urgency: 'none', p_note: 'Called us.', p_consent: true,
  } });
  check('danger is the immediate_danger urgency', validateReferral({ ...good, danger: true }).payload.p_urgency, 'immediate_danger');
  ok('consent is required', 'problem' in validateReferral({ ...good, consent: false }));
  ok('a name is required', 'problem' in validateReferral({ ...good, callerName: '  ' }));
  ok('a short phone is refused', 'problem' in validateReferral({ ...good, phone: '555-0101' }));
  ok('a 16-digit phone is refused', 'problem' in validateReferral({ ...good, phone: '1234567890123456' }));
  ok('a bad email is refused', 'problem' in validateReferral({ ...good, email: 'maria at example' }));
  ok('no email is fine', 'payload' in validateReferral({ ...good, email: '' }));
  ok('a long relationship is refused', 'problem' in validateReferral({ ...good, relationship: 'x'.repeat(61) }));
  ok('a long note is refused', 'problem' in validateReferral({ ...good, note: 'x'.repeat(1001) }));
  check('the consent line is Matt\'s wording', portal.CONSENT_TEXT,
    'The family asked us to share these details with this interventionist, and agreed we may be kept informed of their progress and placement.');
  ok('the safety line names 911 and 988', /911/.test(portal.SAFETY_TEXT) && /988/.test(portal.SAFETY_TEXT));
}

// ─── (b) what the program reads ─────────────────────────────────────────────
{
  const { milestoneText, durationText, MILESTONE_LABELS, RECEIVE_STATUS_TEXT, placeText } = portal;
  check('entered treatment names the program', milestoneText({ milestone: 'entered_treatment', placed_with: 'Harbor Ridge Treatment' }),
    'Entered treatment at Harbor Ridge Treatment');
  check('without a recorded program it says entered treatment', milestoneText({ milestone: 'entered_treatment', placed_with: null }), 'Entered treatment');
  check('not shared reads plainly', milestoneText({ milestone: 'not_shared', placed_with: null }), 'Progress not shared');
  check('a destination never shows on another milestone', milestoneText({ milestone: 'consult', placed_with: 'Somewhere' }), 'Consult');
  check('every server milestone has a label', Object.keys(MILESTONE_LABELS).sort(),
    ['closed', 'consult', 'entered_treatment', 'family_reached', 'intervention', 'not_proceeding', 'not_shared', 'received']);
  for (const name of Object.keys(MILESTONE_LABELS)) ok(`the migration can return ${name}`, migration.includes(`'${name}'`));
  check('durations', [0, 1, 45, 60, 190, 1440, 1500, 3000, null].map(durationText),
    ['under a minute', '1 min', '45 min', '1 h', '3 h 10 min', '1 d', '1 d 1 h', '2 d 2 h', '']);
  check('receive statuses', Object.keys(RECEIVE_STATUS_TEXT).sort(), ['not_on_referralfit', 'not_taking', 'ready']);
  check('place text', [placeText({ city: 'Bend', state: 'OR' }), placeText({ city: '', state: 'OR' }), placeText({ city: null, state: null })],
    ['Bend, OR', 'OR', '']);
}

// ─── (c) the track record ───────────────────────────────────────────────────
{
  const { statsLine, rateText } = portal;
  check('rates', [rateText(1, 2), rateText(0, 3), rateText(2, 0)], ['50% (1 of 2)', '0% (0 of 3)', '-']);
  check('one interventionist\'s line', statsLine({
    to_global_partner_id: 'x', to_display: 'Cascade Interventions', sent: 4, shared: 2, reached_within_24h: 1,
    median_minutes_to_reach: 780, consult_or_intervention: 1, entered_treatment: 1, last_referred_at: '2026-11-08T00:00:00Z',
  }), { name: 'Cascade Interventions', sent: '4', reached: '50% (1 of 2)', median: '13 h', consult: '50% (1 of 2)',
        treatment: '50% (1 of 2)', note: '2 not shared or closed' });
  const ui = read('portal/src/ProgramReferrals.tsx');
  const headers = [...ui.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map((match) => match[1]);
  check('the track record\'s columns', headers, ['Interventionist', 'Referred', 'Reached within 24 hours', 'Median time to first contact',
    'Consult or intervention', 'Entered treatment (anywhere)']);
  ok('no column counts where clients went', !headers.some((header) => /placed|returned|to us|your program/i.test(header)));
  ok('the page says destinations are not counted', /does not count where clients were placed/.test(ui));
  const stats = /FUNCTION public\.program_referral_stats\(\)\s*RETURNS TABLE \(([^)]*)\)/.exec(migration);
  ok('the stats function returns no destination', stats && !/placed|destination|return/i.test(stats[1]));
}

// ─── (d) the practice's side ────────────────────────────────────────────────
{
  const { caseProgramReferralFromRow, programReferralSettingsFromRow, sharingExplanation, acceptsExplanation, isMissingProgramReferralSchema } = app;
  check('a referral row', caseProgramReferralFromRow([{ id: 'r1', from_display: ' Juniper Ridge Recovery ', share_progress: false, created_at: 't' }]),
    { id: 'r1', fromDisplay: 'Juniper Ridge Recovery', shareProgress: false, createdAt: 't' });
  check('no row means no card', [caseProgramReferralFromRow([]), caseProgramReferralFromRow(null)], [null, null]);
  check('settings', programReferralSettingsFromRow([{ accepts: false, can_change: true, has_profile: true }]),
    { accepts: false, canChange: true, hasProfile: true });
  const on = sharingExplanation('Juniper Ridge Recovery', true);
  ok('sharing on: milestones and the program entered', /milestones/.test(on) && /the program they entered/.test(on));
  ok('sharing on: never names, notes, contacts, insurance or cost', /Never names, notes, contacts, insurance, or cost/.test(on));
  ok('sharing off: only that it referred', /only that it referred/.test(sharingExplanation('Juniper', false)));
  ok('no profile: explains the directory profile', /directory profile/.test(acceptsExplanation({ accepts: true, canChange: true, hasProfile: false })));
  ok('accepting: never affects ranking', /never affect how anyone is ranked/.test(acceptsExplanation({ accepts: true, canChange: true, hasProfile: true })));
  ok('missing schema codes', ['PGRST202', 'PGRST205', '42P01', '42703', '42883'].every((code) => isMissingProgramReferralSchema({ code }))
    && !isMissingProgramReferralSchema({ code: '42501' }));
}

// ─── (e) ethics ─────────────────────────────────────────────────────────────
{
  const matchingSource = read('src/lib/matching.ts');
  ok('matching.ts never reads program referrals', !/program[_-]?referral|programReferral|ProgramReferral|referred_by|lead_channel/i.test(matchingSource));
  ok('the migration never touches matching or ranking objects', !/match_profiles|rank_programs|fit_score|track_record/i.test(migration.replace(/--[^\n]*\n/g, '\n')));
  ok('the header explains patient-brokering', /EKRA/.test(migration) && /Anti-Kickback/.test(migration));
  const doc = read('docs/PROGRAM_REFERRALS.md');
  ok('the doc explains why there is no returned-referrals scoreboard', /EKRA/.test(doc) && /Anti-Kickback/.test(doc) && /scoreboard/i.test(doc));
}

// ─── (f) wiring ─────────────────────────────────────────────────────────────
{
  const portalApp = read('portal/src/App.tsx');
  ok('the portal shows referrals after placement requests',
    portalApp.indexOf('<PlacementRequests') > 0 && portalApp.indexOf('<ProgramReferrals') > portalApp.indexOf('<PlacementRequests'));
  ok('the case file shows the referral card', /<ProgramReferralCard caseId=\{record\.id\} \/>/.test(read('App.tsx')));
  ok('Workspace shows the settings card', /<ProgramReferralSettingsCard visible=\{visible\} \/>/.test(read('src/lib/WorkspaceScreen.tsx')));
  const ui = read('portal/src/ProgramReferrals.tsx');
  for (const name of ['program_referral_targets', 'program_refer_family', 'list_program_referrals', 'program_referral_stats']) {
    ok(`the portal calls ${name}, which the migration defines`, ui.includes(`'${name}'`) && migration.includes(`FUNCTION public.${name}(`));
  }
  const api = read('src/lib/program-referrals.ts');
  for (const name of ['case_program_referral', 'set_program_referral_sharing', 'program_referral_settings', 'set_accepts_program_referrals']) {
    ok(`the app calls ${name}, which the migration defines`, api.includes(`'${name}'`) && migration.includes(`FUNCTION public.${name}(`));
  }
  const refer = /FUNCTION public\.program_refer_family\(([^)]*)\)/.exec(migration)[1];
  const params = [...refer.matchAll(/(p_[a-z_]+)/g)].map((match) => match[1]);
  const payload = Object.keys(portal.validateReferral({ ...portal.emptyReferralForm(), callerName: 'A', phone: '5035550101', consent: true }).payload);
  check('the form sends every argument the RPC takes, plus the listing', [...payload, 'p_to_global_id'].sort(), [...params].sort());
}

// ─── (g) the migration follows the paste rules ──────────────────────────────
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
  return { statements, tail: sql.slice(start).trim(), unterminated: dollar };
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
  ok('the table is revoked from clients', migration.includes('REVOKE ALL ON TABLE public.program_referrals FROM PUBLIC, anon, authenticated;'));
  const created = [...migration.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)\(/g)].map((match) => match[1]);
  const revoked = [...migration.matchAll(/REVOKE ALL ON FUNCTION public\.([a-z_]+)\([^)]*\) FROM PUBLIC, anon/g)].map((match) => match[1]);
  check('every function is revoked from PUBLIC and anon', [...new Set(revoked)].sort(), [...new Set(created)].sort());
  ok('it does not redefine push, email or bed functions',
    !/FUNCTION public\.(notify_enqueue|placement_answer_notify|set_listing_beds|email_[a-z_]+)\(/.test(migration));
}

console.log(`program referrals: ${checks} checks ok`);
