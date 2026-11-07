// Referral handoffs: src/lib/handoffs.ts in plain node (Supabase stubbed),
// the portal's /h page, and the source shapes that keep the link private.
// The database side is supabase/tests/referral_handoffs_test.sql.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'handoff-test');
const require = createRequire(import.meta.url);
const ts = require(path.join(repoRoot, 'node_modules', 'typescript'));
const read = (file) => readFileSync(path.join(repoRoot, file), 'utf8');

mkdirSync(tmpDir, { recursive: true });
const transpile = (file, out) => writeFileSync(path.join(tmpDir, out), ts.transpileModule(read(file), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText);
transpile('src/lib/handoffs.ts', 'handoffs.js');
transpile('src/lib/identifying-text.ts', 'identifying-text.js');
transpile('src/lib/errors.ts', 'errors.js');
const calls = [];
globalThis.__handoffRpc = async () => ({ data: null, error: null, status: 200 });
writeFileSync(path.join(tmpDir, 'supabase.js'), `
exports.supabase = { rpc: (name, args) => { globalThis.__handoffCalls.push({ name, args }); return globalThis.__handoffRpc(name, args); } };
`);
globalThis.__handoffCalls = calls;
const handoffs = require(path.join(tmpDir, 'handoffs.js'));

let checks = 0;
const check = (label, actual, expected) => { assert.deepEqual(actual, expected, label); checks += 1; };

// ─── Steps ──────────────────────────────────────────────────────────────────
check('six steps, in order', handoffs.HANDOFF_STEPS.map((step) => step.status),
  ['sent', 'received', 'contact_attempted', 'family_reached', 'consult_scheduled', 'closed']);
check('each step has one next step', ['sent', 'received', 'contact_attempted', 'family_reached', 'consult_scheduled', 'closed'].map(handoffs.nextHandoffStatus),
  ['received', 'contact_attempted', 'family_reached', 'consult_scheduled', 'closed', null]);
check('open means not closed and not revoked', [
  handoffs.isHandoffOpen({ status: 'received', revokedAt: null }),
  handoffs.isHandoffOpen({ status: 'closed', revokedAt: null }),
  handoffs.isHandoffOpen({ status: 'sent', revokedAt: '2026-11-06T00:00:00Z' }),
], [true, false, false]);

// ─── The link keeps its token out of server logs ────────────────────────────
const token = 'a'.repeat(64);
check('the token rides in the fragment of the portal page', handoffs.handoffLink(token), `https://portal.referralfit.com/h#${token}`);

// ─── What the program reads: the alias ──────────────────────────────────────
const names = ['Nguyen intervention', 'Linh Nguyen'];
check('a neutral alias passes', handoffs.handoffAliasProblem('Family A', names, 'Nguyen family'), null);
assert.match(handoffs.handoffAliasProblem("Linh's brother", names, 'Nguyen family') || '', /Leave out names/); checks += 1;
assert.match(handoffs.handoffAliasProblem('The Nguyen kids', names, null) || '', /Leave out names/); checks += 1;
assert.match(handoffs.handoffAliasProblem('DOB 3/14/1988', [], null) || '', /dates/); checks += 1;
assert.match(handoffs.handoffAliasProblem('call 541-555-0100', [], null) || '', /phone and ID numbers/); checks += 1;
assert.match(handoffs.handoffAliasProblem('  ', [], null) || '', /Add an alias/); checks += 1;
assert.match(handoffs.handoffAliasProblem('x'.repeat(81), [], null) || '', /80 characters/); checks += 1;
check('the recipient is required; an email is optional but checked', [
  handoffs.recipientProblem('Cedar Ridge', ''),
  handoffs.recipientProblem('Cedar Ridge', 'admissions@cedar.example.org'),
  Boolean(handoffs.recipientProblem('', '')),
  Boolean(handoffs.recipientProblem('Cedar Ridge', 'not an email')),
], [null, null, true, true]);

// ─── The API ────────────────────────────────────────────────────────────────
globalThis.__handoffRpc = async () => ({ data: [{ handoff_id: 'h1', token, status: 'sent', version: 1 }], error: null, status: 200 });
const created = await handoffs.createHandoff({ referralId: 'r1', caseId: null, partnerId: 'p1', clientAlias: ' Family A ', recipientDisplay: ' Cedar ', recipientEmail: '' });
check('create returns the link once, built from the token', created, { handoffId: 'h1', link: `https://portal.referralfit.com/h#${token}` });
check('and sends trimmed values', calls.at(-1), { name: 'create_referral_handoff', args: { p_referral_id: 'r1', p_case_id: null, p_partner_id: 'p1', p_client_alias: 'Family A', p_recipient_display: 'Cedar', p_recipient_email: '' } });
globalThis.__handoffRpc = async () => ({ data: [{ handoff_id: 'h1', token: 'short' }], error: null, status: 200 });
await assert.rejects(handoffs.createHandoff({ referralId: 'r1', caseId: null, partnerId: 'p1', clientAlias: 'A', recipientDisplay: 'C', recipientEmail: '' }), /link could not be read/); checks += 1;
globalThis.__handoffRpc = async () => ({ data: null, error: { code: '40001', message: 'Handoff version conflict' }, status: 409 });
await assert.rejects(handoffs.advanceHandoff({ id: 'h1', status: 'sent', version: 1 }), /changed meanwhile/); checks += 1;
globalThis.__handoffRpc = async () => ({ data: [{ status: 'received', version: 2 }], error: null, status: 200 });
check('the practitioner steps it forward with the version they saw', await handoffs.advanceHandoff({ id: 'h1', status: 'sent', version: 1 }), { status: 'received', version: 2 });
check('to the next step only', calls.at(-1), { name: 'transition_referral_handoff', args: { p_handoff_id: 'h1', p_expected_version: 1, p_next_status: 'received' } });
await assert.rejects(handoffs.advanceHandoff({ id: 'h1', status: 'closed', version: 6 }), /already closed/); checks += 1;
globalThis.__handoffRpc = async () => ({ data: null, error: { message: 'TypeError: Network request failed' }, status: 0 });
await assert.rejects(handoffs.revokeHandoff('h1'), (error) => error.name === 'OfflineError'); checks += 1;

// ─── The portal page ────────────────────────────────────────────────────────
const portal = read('portal/src/Handoff.tsx');
const portalMain = read('portal/src/main.tsx');
assert.ok(portal.includes("export function handoffTokenFrom(hash: string): string | null {") && portal.includes('/^[0-9a-f]{64}$/.test(token)'), 'the page reads the token from the fragment, 64 hex characters only'); checks += 1;
assert.ok(portal.includes("window.history.replaceState(null, '', window.location.pathname)"), 'and clears it from the address bar'); checks += 1;
assert.ok(portal.includes("supabase.rpc('public_referral_handoff_resolve', { p_token: token })") && portal.includes("supabase.rpc('public_referral_handoff_transition', {"), 'it calls the two token-checked functions, nothing else'); checks += 1;
assert.ok(!/from\('referral_handoffs'\)/.test(portal), 'it never reads the handoff table'); checks += 1;
assert.ok(portalMain.includes('const isHandoff = /^\\/h\\/?$/.test(window.location.pathname);'), 'the portal serves /h signed out'); checks += 1;
check('the portal and the app list the same steps', [...portal.matchAll(/\{ status: '([a-z_]+)', label: '([^']+)'/g)].map((match) => [match[1], match[2]]),
  handoffs.HANDOFF_STEPS.map((step) => [step.status, step.label]));
const portalVercel = JSON.parse(read('portal/vercel.json'));
check('the portal is not indexed, framed or leaking a Referer', ['X-Robots-Tag', 'X-Frame-Options', 'Referrer-Policy'].map((key) => portalVercel.headers[0].headers.find((header) => header.key === key)?.value),
  ['noindex, nofollow', 'DENY', 'no-referrer']);

// ─── The app ────────────────────────────────────────────────────────────────
const app = read('App.tsx');
const sheet = read('src/lib/HandoffsSheet.tsx');
assert.ok(app.includes("item.kind !== 'check_in' && item.kind !== 'referral_handshake'"), 'a handoff reminder is never taken for the referral\'s admit check'); checks += 1;
assert.ok(app.includes("followUp.kind !== 'referral_handshake'),"), 'and Done on it does not ask whether the family was admitted'); checks += 1;
assert.ok(/if \(card\.kind === 'referral_handshake'\) \{\s*setShowHandoffs\(true\);/.test(app), 'Done on a handoff reminder opens Handoffs'); checks += 1;
assert.ok(sheet.includes("handoffAliasProblem(alias, caseNamesFor(chosen.caseId), chosen.clientLabel || null)"), 'the alias is checked against the case and the client label before sending'); checks += 1;
assert.ok(read('src/lib/store.ts').includes("| 'check_in' | 'referral_handshake';"), 'the follow-up kinds include the handoff\'s'); checks += 1;

console.log(`handoff-test: ${checks} checks passed`);
