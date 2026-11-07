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
  authLinkPath,
  authRedirectUrl,
  decideAuthLink,
  EMAIL_CONFIRM_REDIRECT,
  PASSWORD_RECOVERY_REDIRECT,
  friendlyAuthError,
  isPlausibleEmail,
  isRecoveryRedirect,
  jwtEmail,
  linkEmailAllowed,
  parseAuthRedirect,
  passwordProblem,
  retryWhileOffline,
} = require(path.join(tmpDir, 'auth-flows.js'));

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  → ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
}

// A link is used only for an email this device started the flow for.
{
  const token = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
  check('the link token\'s email is read (lower case)', jwtEmail(token({ sub: 'u1', email: 'Pat@Example.TEST' })), 'pat@example.test');
  check('a token without one reads as none', jwtEmail(token({ sub: 'u1' })), null);
  check('garbage reads as none', jwtEmail('not-a-token'), null);
  check('the email asked for is allowed', linkEmailAllowed('pat@example.test', ['pat@example.test']), true);
  check('another account is not', linkEmailAllowed('attacker@example.test', ['pat@example.test']), false);
  check('nor a link with no email at all', linkEmailAllowed(null, ['pat@example.test']), false);
  check('a flow started by an older build (no email recorded) is not checked', linkEmailAllowed('anyone@example.test', []), true);
  check('case and spacing do not matter', linkEmailAllowed(' PAT@example.test ', ['pat@example.test']), true);
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

// ─── The web app: links come back to its own origin ─────────────────────────
const WEB = 'https://app.referralfit.com';
check('web recovery redirect', authRedirectUrl('recovery', WEB), 'https://app.referralfit.com/auth/recovery');
check('web confirm redirect', authRedirectUrl('confirmed', 'http://localhost:3222'), 'http://localhost:3222/auth/confirmed');
check('phone redirect without an origin', authRedirectUrl('recovery', null), 'referralfit://auth/recovery');
check('a bad origin falls back to the app scheme', authRedirectUrl('confirmed', 'null'), 'referralfit://auth/confirmed');
check('an origin with a path is refused', authRedirectUrl('confirmed', 'https://app.referralfit.com/x'), 'referralfit://auth/confirmed');
check('a preview deployment sends people to the web app itself', authRedirectUrl('recovery', 'https://referralfit-web-git-x.vercel.app'), 'https://app.referralfit.com/auth/recovery');
check('web link path', authLinkPath('https://app.referralfit.com/auth/recovery#access_token=AT&refresh_token=RT', WEB), 'recovery');
check('web link path, any case and a trailing slash', authLinkPath('HTTPS://APP.REFERRALFIT.COM/auth/confirmed/?code=c', WEB), 'confirmed');
check('web link needs the origin', authLinkPath('https://app.referralfit.com/auth/recovery#access_token=AT', null), null);
check('a lookalike host is not the origin', authLinkPath('https://app.referralfit.com.example.net/auth/recovery#access_token=AT', WEB), null);
check('another path on the origin', authLinkPath('https://app.referralfit.com/cases#access_token=AT', WEB), null);
check('the scheme still works in a browser', authLinkPath('referralfit://auth/recovery#x=1', WEB), 'recovery');
check('web pkce code', parseAuthRedirect('https://app.referralfit.com/auth/recovery?code=abc', WEB), { kind: 'code', type: '', code: 'abc' });
check('web pkce code needs the origin', parseAuthRedirect('https://app.referralfit.com/auth/recovery?code=abc', null), null);
const started = { recovery: 1_000_000 };
check('web link accepted for a reset this browser started',
  decideAuthLink('https://app.referralfit.com/auth/recovery#access_token=AT&refresh_token=RT&type=recovery', started, 1_000_500, WEB).action, 'accept');
check('web link not started here',
  decideAuthLink('https://app.referralfit.com/auth/confirmed#access_token=AT&refresh_token=RT&type=signup', started, 1_000_500, WEB).action, 'not_started');
check('web link on another origin is ignored',
  decideAuthLink('https://evil.example/auth/recovery#access_token=AT&refresh_token=RT', started, 1_000_500, WEB).action, 'ignore');
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
  "emailRedirectTo: authRedirectUrl('confirmed', currentWebOrigin())",
  'supabase.auth.resend(',
  'supabase.auth.resetPasswordForEmail(',
  "redirectTo: authRedirectUrl('recovery', currentWebOrigin())",
  'friendlyAuthError(',
  'passwordProblem(password, confirmPassword)',
  'Free for your practice. Create an account in a minute.',
  'private to your workspace',
]) assert.ok(loginSource.includes(text), `LoginScreen missing: ${text}`);
assert.ok(!/console\.(log|warn|error)/.test(loginSource), 'LoginScreen must not log (passwords in scope)');
assert.ok(!/Accounts are set up for your practice by ReferralFit/.test(loginSource), 'stale invite-only footnote');
// Signing in to a never-confirmed address offers a new confirmation link: an
// expired one otherwise leaves no way in (signing up again says it exists).
assert.ok(loginSource.includes("authError.code === 'email_not_confirmed'"), 'sign-in must catch an unconfirmed address');
assert.ok(loginSource.includes("setNotice({ kind: 'confirmEmail', email: normalizeEmail(email), notConfirmed: true })"), 'sign-in must offer Resend for an unconfirmed address');

// ─── Email templates (pasted into production by hand) ───────────────────────
const configToml = readFileSync(path.join(repoRoot, 'supabase/config.toml'), 'utf8');
for (const name of ['confirmation', 'recovery']) {
  const template = readFileSync(path.join(repoRoot, `supabase/templates/${name}.html`), 'utf8');
  assert.ok(configToml.includes(`[auth.email.template.${name}]`) && configToml.includes(`content_path = "./supabase/templates/${name}.html"`), `config.toml must use templates/${name}.html`);
  // The link must stay Supabase's own verify URL, which carries redirect_to
  // back to the app or the web page that asked (auth-flows.ts).
  assert.ok(template.includes('href="{{ .ConfirmationURL }}"'), `${name}.html must link to {{ .ConfirmationURL }}`);
  assert.ok(!/<img|<script|<link|url\(|src=/i.test(template), `${name}.html must load nothing from outside the email`);
  assert.ok(/same device|where you (signed up|asked)/.test(template), `${name}.html must say to open the link where the flow started`);
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[^\x00-\x7F]/.test(template), `${name}.html must be ASCII (entities for anything else) so a paste cannot mangle it`);
}

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
  'parseAuthRedirect(url, webOrigin)',
  'clearAuthLinkFromAddressBar();',
  'decideAuthLink(url, await readAuthFlowStarts(), Date.now(), webOrigin)',
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

// A link opened while iOS wakes the app: its first request can fail on a
// stale connection without reaching the server. The app retries a request
// that failed for lack of a connection, and only that.
{
  const run = async (outcomes, options = {}) => {
    const calls = [];
    const waits = [];
    let clock = 0;
    const result = await retryWhileOffline(
      async () => { calls.push(clock); return outcomes[Math.min(calls.length - 1, outcomes.length - 1)]; },
      (outcome) => outcome === 'offline',
      { sleep: async (ms) => { waits.push(ms); clock += ms; }, now: () => clock, ...options },
    );
    return { result, calls: calls.length, waits };
  };
  check('a request that goes through is not repeated', await run(['ok']), { result: 'ok', calls: 1, waits: [] });
  check('a dropped first request is tried again after a moment', await run(['offline', 'ok']), { result: 'ok', calls: 2, waits: [500] });
  check('it keeps trying with longer waits', await run(['offline', 'offline', 'offline', 'ok']), { result: 'ok', calls: 4, waits: [500, 1500, 3000] });
  check('then gives up and returns the last answer', await run(['offline']), { result: 'offline', calls: 4, waits: [500, 1500, 3000] });
  check('an answer from the server (expired, refused) is never retried', await run(['expired', 'ok']), { result: 'expired', calls: 1, waits: [] });
  check('retrying stops when the screen goes away', await run(['offline', 'ok'], { keepGoing: () => false }), { result: 'offline', calls: 1, waits: [] });
  check('and within its time budget', await run(['offline', 'offline', 'ok'], { budgetMs: 1000 }), { result: 'offline', calls: 2, waits: [500] });
}
{
  const appSource = readFileSync(path.join(repoRoot, 'App.tsx'), 'utf8');
  const handler = appSource.slice(appSource.indexOf('async function handleAuthUrl('), appSource.indexOf('Linking.getInitialURL()'));
  const effect = appSource.slice(appSource.indexOf('const whenActive = () =>'), appSource.indexOf('Linking.getInitialURL()'));
  check('the handler waits for the app to be in front before any request',
    handler.indexOf('await whenActive();') > 0 && handler.indexOf('await whenActive();') < handler.indexOf('checkLinkToken(redirect.accessToken)')
      && handler.indexOf('await whenActive();') < handler.indexOf('supabase.auth.exchangeCodeForSession('), true);
  check('waiting for the app is capped', /const timer = setTimeout\(finish, 2000\);/.test(effect), true);
  check('the link check is retried while offline',
    /await retryWhileOffline\(\s*\(\) => checkLinkToken\(redirect\.accessToken\),\s*\(outcome\) => !outcome\.ok && outcome\.reason === 'unreachable',/.test(handler), true);
  check('still offline: Try again, not a new email',
    /if \(checked\.reason === 'unreachable'\) \{\s*offerRetry\(url, decision\.path\);\s*return;/.test(handler), true);
  check('signing in with the tokens is retried while offline',
    /await retryWhileOffline\(\s*\(\) => supabase\.auth\.setSession\(\{ access_token: redirect\.accessToken, refresh_token: redirect\.refreshToken \}\),\s*\(outcome\) => isAuthNetworkError\(outcome\.error\),/.test(handler), true);
  check('a dropped connection is not called an expired link',
    /if \(redirect\.kind === 'tokens' && isAuthNetworkError\(result\.error\)\) \{\s*offerRetry\(url, decision\.path\);\s*return;\s*\}\s*Alert\.alert\('That link has expired'/.test(handler), true);
  check('a code is exchanged once (its verifier is gone after a failure)',
    /: await supabase\.auth\.exchangeCodeForSession\(redirect\.code\);/.test(handler), true);
  check('Try again reopens the same link', /\{ text: 'Try again', onPress: \(\) => openAuthUrl\(url, \{ retry: true \}\) \}/.test(effect), true);
  check('a link delivered twice at launch is handled once',
    /if \(!url \|\| \(seenAuthUrls\.has\(url\) && !retry\)\) return;\s*seenAuthUrls\.add\(url\);\s*void handleAuthUrl\(url\);/.test(effect), true);
  check('both deliveries go through that gate',
    appSource.includes("Linking.getInitialURL().then((url) => { openAuthUrl(url); })") && appSource.includes("Linking.addEventListener('url', ({ url }) => { openAuthUrl(url); })"), true);
}

if (failures) {
  console.error(`self-serve-accounts-test: ${failures} failure(s)`);
  process.exit(1);
}
console.log('self-serve-accounts-test: all checks passed');
