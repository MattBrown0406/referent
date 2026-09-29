#!/usr/bin/env node
// Self-serve account flows: runs the real src/lib/auth-flows.ts in plain node
// (transpiled on the fly with the repo's typescript package, same pattern as
// scripts/phone-test.mjs) and checks the source invariants that wire the
// sign-up / reset / delete-account flows through the screens.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'self-serve-accounts-test');
const require = createRequire(import.meta.url);
const ts = require(path.join(repoRoot, 'node_modules', 'typescript'));

const flowsSource = readFileSync(path.join(repoRoot, 'src/lib/auth-flows.ts'), 'utf8');
const js = ts.transpileModule(flowsSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
mkdirSync(tmpDir, { recursive: true });
writeFileSync(path.join(tmpDir, 'auth-flows.js'), js);

const {
  APP_SCHEME,
  EMAIL_CONFIRM_REDIRECT,
  PASSWORD_RECOVERY_REDIRECT,
  friendlyAuthError,
  isPlausibleEmail,
  isRecoveryRedirect,
  parseAuthRedirect,
  passwordProblem,
} = require(path.join(tmpDir, 'auth-flows.js'));

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  → ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
}

// ─── Deep-link scheme matches app.json ───────────────────────────────────────
const appJson = JSON.parse(readFileSync(path.join(repoRoot, 'app.json'), 'utf8'));
check('app.json scheme matches APP_SCHEME', appJson.expo.scheme, APP_SCHEME);
check('recovery redirect uses the app scheme', PASSWORD_RECOVERY_REDIRECT, 'referralfit://auth/recovery');
check('confirm redirect uses the app scheme', EMAIL_CONFIRM_REDIRECT, 'referralfit://auth/confirmed');

// ─── parseAuthRedirect ───────────────────────────────────────────────────────
check('implicit recovery fragment', parseAuthRedirect('referralfit://auth/recovery#access_token=AT&expires_in=3600&refresh_token=RT&token_type=bearer&type=recovery'),
  { kind: 'tokens', type: 'recovery', accessToken: 'AT', refreshToken: 'RT' });
check('signup confirmation fragment', parseAuthRedirect('referralfit://auth/confirmed#access_token=AT&refresh_token=RT&type=signup'),
  { kind: 'tokens', type: 'signup', accessToken: 'AT', refreshToken: 'RT' });
check('pkce code query', parseAuthRedirect('referralfit://auth/recovery?code=abc-123&type=recovery'),
  { kind: 'code', type: 'recovery', code: 'abc-123' });
check('query and fragment together', parseAuthRedirect('referralfit://auth/recovery?type=recovery#access_token=AT&refresh_token=RT'),
  { kind: 'tokens', type: 'recovery', accessToken: 'AT', refreshToken: 'RT' });
check('error redirect', parseAuthRedirect('referralfit://auth/recovery#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired'),
  { kind: 'error', code: 'otp_expired', description: 'Email link is invalid or has expired' });
check('missing refresh token is ignored', parseAuthRedirect('referralfit://auth/recovery#access_token=AT'), null);
check('foreign url with code is ignored', parseAuthRedirect('https://example.com/?code=abc'), null);
check('plain launch url', parseAuthRedirect('referralfit://'), null);
check('null url', parseAuthRedirect(null), null);
check('isRecoveryRedirect true for recovery tokens', isRecoveryRedirect({ kind: 'tokens', type: 'recovery', accessToken: 'a', refreshToken: 'b' }), true);
check('isRecoveryRedirect false for signup', isRecoveryRedirect({ kind: 'tokens', type: 'signup', accessToken: 'a', refreshToken: 'b' }), false);
check('isRecoveryRedirect false for error', isRecoveryRedirect({ kind: 'error', code: 'x', description: 'y' }), false);

// ─── Validation ──────────────────────────────────────────────────────────────
check('plausible email', isPlausibleEmail('  Matt@FreedomInterventions.com '), true);
check('implausible email', isPlausibleEmail('matt@'), false);
check('empty password', passwordProblem('', ''), 'Choose a password.');
check('short password', passwordProblem('abc1234', 'abc1234'), 'Use at least 8 characters.');
check('mismatch', passwordProblem('abcd1234', 'abcd1235'), 'The passwords do not match.');
check('acceptable password', passwordProblem('abcd1234', 'abcd1234'), null);

// ─── Error mapping never echoes secrets and covers the common cases ──────────
check('already registered', friendlyAuthError('User already registered', 'signUp'),
  'An account with this email already exists. Sign in instead, or use “Forgot password?” to reset it.');
check('weak password', friendlyAuthError('Password should be at least 6 characters', 'signUp'), 'That password is too weak. At least 8 characters.');
check('invalid credentials', friendlyAuthError('Invalid login credentials', 'signIn'),
  'Those credentials did not match. Check the email and password, or use “Forgot password?”.');
check('email not confirmed', friendlyAuthError('Email not confirmed', 'signIn'),
  'Confirm your email first. Check your inbox for the confirmation link, then sign in.');
check('signups disabled', friendlyAuthError('Signups not allowed for this instance', 'signUp'),
  'New sign-ups are currently turned off. Contact ReferralFit and we will set up your account.');
check('rate limit', friendlyAuthError('Email rate limit exceeded', 'forgot'), 'Too many attempts. Wait a few minutes and try again.');
check('invalid email', friendlyAuthError('Unable to validate email address: invalid format', 'signUp'), 'Enter a valid email address.');
check('unknown message passes through', friendlyAuthError('Something unusual', 'signIn'), 'Something unusual');
check('empty message', friendlyAuthError('', 'signIn'), 'Something went wrong. Try again.');

// ─── Source invariants ───────────────────────────────────────────────────────
const loginSource = readFileSync(path.join(repoRoot, 'src/lib/LoginScreen.tsx'), 'utf8');
for (const text of [
  'supabase.auth.signInWithPassword(',
  'supabase.auth.signUp(',
  'data: { practice_name: practice, display_name: name }',
  'emailRedirectTo: EMAIL_CONFIRM_REDIRECT',
  'supabase.auth.resend(',
  'supabase.auth.resetPasswordForEmail(',
  'redirectTo: PASSWORD_RECOVERY_REDIRECT',
  'friendlyAuthError(',
  'passwordProblem(password, confirmPassword)',
  'Free for your practice. Create an account in a minute.',
  'private to your workspace',
]) assert.ok(loginSource.includes(text), `LoginScreen missing: ${text}`);
assert.ok(!/console\.(log|warn|error)/.test(loginSource), 'LoginScreen must not log (passwords in scope)');
assert.ok(!/Accounts are set up for your practice by ReferralFit/.test(loginSource), 'stale invite-only footnote');

const resetSource = readFileSync(path.join(repoRoot, 'src/lib/ResetPasswordScreen.tsx'), 'utf8');
assert.ok(resetSource.includes('supabase.auth.updateUser({ password })'), 'ResetPasswordScreen must set the new password');
assert.ok(!/console\.(log|warn|error)/.test(resetSource), 'ResetPasswordScreen must not log');

const accountSource = readFileSync(path.join(repoRoot, 'src/lib/account.ts'), 'utf8');
for (const text of [
  "supabase.rpc('delete_own_account')",
  'await prepareForWorkspaceChange(userId)',
  "supabase.auth.signOut({ scope: 'local' })",
  'if (removeWorkspaceFiles) {',
]) assert.ok(accountSource.includes(text), `account.ts missing: ${text}`);
// Cache wipe and file cleanup must happen before the RPC deletes the user.
assert.ok(accountSource.indexOf('prepareForWorkspaceChange(userId)') < accountSource.indexOf("rpc('delete_own_account')"), 'wipe caches before the RPC');
assert.ok(accountSource.indexOf('removeWorkspaceCaseFiles()') < accountSource.indexOf("rpc('delete_own_account')"), 'remove files before the RPC');
assert.ok(accountSource.indexOf("rpc('delete_own_account')") < accountSource.indexOf("signOut({ scope: 'local' })"), 'sign out after the RPC');

const workspaceSource = readFileSync(path.join(repoRoot, 'src/lib/WorkspaceScreen.tsx'), 'utf8');
for (const text of [
  "import { deleteOwnAccount } from './account';",
  'deleteOwnAccount({ userId, removeWorkspaceFiles: soloOwner })',
  'onAccountDeleted();',
  "Alert.alert('Delete your account?'",
  "Alert.alert('Delete permanently?'",
  'Remove your team first',
]) assert.ok(workspaceSource.includes(text), `WorkspaceScreen missing: ${text}`);

const appSource = readFileSync(path.join(repoRoot, 'App.tsx'), 'utf8');
for (const text of [
  "if (event === 'PASSWORD_RECOVERY') setPasswordRecovery(true);",
  'Linking.getInitialURL()',
  "Linking.addEventListener('url'",
  'parseAuthRedirect(url)',
  'supabase.auth.setSession({ access_token: redirect.accessToken, refresh_token: redirect.refreshToken })',
  'supabase.auth.exchangeCodeForSession(redirect.code)',
  '<ResetPasswordScreen email=',
  'onAccountDeleted={() => {',
  'resetAccountState();',
]) assert.ok(appSource.includes(text), `App.tsx missing: ${text}`);

const migration = readFileSync(path.join(repoRoot, 'supabase/migrations/20260929174333_self_serve_accounts.sql'), 'utf8');
for (const text of [
  'CREATE OR REPLACE FUNCTION public.delete_own_account()',
  "v_meta->>'practice_name'",
  "v_meta->>'display_name'",
  'DELETE FROM auth.users WHERE id = v_user;',
  'GRANT EXECUTE ON FUNCTION public.delete_own_account() TO authenticated;',
]) assert.ok(migration.includes(text), `migration missing: ${text}`);

const appReview = readFileSync(path.join(repoRoot, 'APP_REVIEW.md'), 'utf8');
assert.ok(!/there is no self-serve sign-up/.test(appReview), 'APP_REVIEW.md still claims there is no sign-up');
assert.ok(appReview.includes('5.1.1(v)'), 'APP_REVIEW.md must document account deletion');

if (failures) {
  console.error(`self-serve-accounts-test: ${failures} failure(s)`);
  process.exit(1);
}
console.log('self-serve-accounts-test: all checks passed');
