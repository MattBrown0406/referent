// Pure helpers for the self-serve account flows (sign-up, email confirmation,
// password reset). No React Native imports so scripts/self-serve-accounts-test.mjs
// can run this file in plain node.

// app.json "scheme" is referralfit. Supabase Auth → URL Configuration must
// allow-list these exact URLs (see docs/SELF_SERVE_ACCOUNTS.md).
export const APP_SCHEME = 'referralfit';
export const PASSWORD_RECOVERY_REDIRECT = `${APP_SCHEME}://auth/recovery`;
export const EMAIL_CONFIRM_REDIRECT = `${APP_SCHEME}://auth/confirmed`;

export const MIN_PASSWORD_LENGTH = 8;
export const PASSWORD_REQUIREMENTS = `At least ${MIN_PASSWORD_LENGTH} characters.`;

export type AuthMode = 'signIn' | 'signUp' | 'forgot';

export type AuthRedirect =
  | { kind: 'tokens'; type: string; accessToken: string; refreshToken: string }
  | { kind: 'code'; type: string; code: string }
  | { kind: 'error'; code: string; description: string };

// Supabase redirects back to the app with either an implicit-flow fragment
// (#access_token=…&refresh_token=…&type=recovery) or a PKCE query (?code=…).
// Error redirects carry error_code / error_description. Anything that is not
// one of our auth deep links returns null so ordinary URLs are ignored.
export function parseAuthRedirect(url: string | null | undefined): AuthRedirect | null {
  if (!url || typeof url !== 'string') return null;
  const hashIndex = url.indexOf('#');
  const queryIndex = url.indexOf('?');
  const fragment = hashIndex >= 0 ? url.slice(hashIndex + 1) : '';
  const query = queryIndex >= 0 ? url.slice(queryIndex + 1, hashIndex >= 0 && hashIndex > queryIndex ? hashIndex : undefined) : '';
  const params = new Map<string, string>();
  for (const part of [query, fragment]) {
    if (!part) continue;
    for (const pair of part.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const key = decodeURIComponent(eq >= 0 ? pair.slice(0, eq) : pair);
      const value = decodeURIComponent((eq >= 0 ? pair.slice(eq + 1) : '').replace(/\+/g, ' '));
      if (key && !params.has(key)) params.set(key, value);
    }
  }
  const type = params.get('type') || '';
  const errorCode = params.get('error_code') || params.get('error');
  if (errorCode) {
    return { kind: 'error', code: errorCode, description: params.get('error_description') || 'The link could not be used.' };
  }
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (accessToken && refreshToken) {
    return { kind: 'tokens', type, accessToken, refreshToken };
  }
  const code = params.get('code');
  if (code && url.startsWith(`${APP_SCHEME}://`)) {
    return { kind: 'code', type, code };
  }
  return null;
}

export function isRecoveryRedirect(redirect: AuthRedirect | null): boolean {
  return !!redirect && redirect.kind !== 'error' && redirect.type === 'recovery';
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isPlausibleEmail(value: string): boolean {
  const email = normalizeEmail(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

// Returns the first problem with a new password, or null when acceptable.
export function passwordProblem(password: string, confirm: string): string | null {
  if (!password) return 'Choose a password.';
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password !== confirm) return 'The passwords do not match.';
  return null;
}

// Map Supabase Auth error messages to plain language. Never includes the
// password or the raw request.
export function friendlyAuthError(message: string | undefined | null, mode: AuthMode): string {
  const raw = (message || '').trim();
  const lower = raw.toLowerCase();
  if (!raw) return 'Something went wrong. Try again.';
  if (lower.includes('invalid login credentials')) {
    return 'Those credentials did not match. Check the email and password, or use “Forgot password?”.';
  }
  if (lower.includes('email not confirmed')) {
    return 'Confirm your email first. Check your inbox for the confirmation link, then sign in.';
  }
  if (lower.includes('already registered') || lower.includes('already been registered') || lower.includes('already exists')) {
    return 'An account with this email already exists. Sign in instead, or use “Forgot password?” to reset it.';
  }
  if (lower.includes('signups not allowed') || lower.includes('signup is disabled') || lower.includes('sign ups are disabled')) {
    return 'New sign-ups are currently turned off. Contact ReferralFit and we will set up your account.';
  }
  if (lower.includes('password') && (lower.includes('weak') || lower.includes('at least') || lower.includes('should contain') || lower.includes('too short'))) {
    return `That password is too weak. ${PASSWORD_REQUIREMENTS}`;
  }
  if (lower.includes('same password') || lower.includes('different from the old password')) {
    return 'Choose a password you have not used for this account before.';
  }
  if (lower.includes('rate limit') || lower.includes('too many requests') || lower.includes('over_email_send_rate_limit')) {
    return 'Too many attempts. Wait a few minutes and try again.';
  }
  if (lower.includes('invalid email') || lower.includes('unable to validate email') || lower.includes('is invalid')) {
    return 'Enter a valid email address.';
  }
  if (lower.includes('network') || lower.includes('fetch')) {
    return 'The network request failed. Check your connection and try again.';
  }
  if (mode === 'forgot' && lower.includes('not found')) {
    return 'If an account exists for that email, a reset link is on its way.';
  }
  return raw;
}
