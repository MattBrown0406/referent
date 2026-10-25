import { decode } from 'base64-arraybuffer';
import type { Session } from '@supabase/supabase-js';

import { supabase } from './supabase';

// offline: true means the identity was read from the session persisted on this
// device because the server could not be reached to refresh an expired access
// token. It is valid ONLY for fencing this account's on-device cache and
// offline queue — never as proof of identity for a server write. Callers that
// see it must not attempt server work (store.ts queues instead).
export type AuthSessionIdentity = { userId: string; sessionId: string; offline?: boolean };

export type AuthSessionIdentityOptions = {
  // Fall back to the persisted session when the refresh fails for lack of a
  // connection (or takes too long). Off by default: server-backed callers keep
  // the strict behavior.
  allowOffline?: boolean;
  // How long to wait for supabase-js to refresh an expired token before
  // treating the device as offline. supabase-js itself retries for ~25 s.
  timeoutMs?: number;
};

const SESSION_LOOKUP_TIMEOUT_MS = 4000;
// After a refresh fails for lack of a connection, skip the server lookup for
// this long: every fence check would otherwise wait out the timeout again.
const OFFLINE_RECHECK_MS = 15000;
// supabase-js refreshes when the access token is within 90 s of expiry.
const EXPIRY_MARGIN_MS = 90 * 1000;

let networkDownUntil = 0;

function decodeJwtPayload(accessToken: string): Record<string, unknown> | null {
  try {
    const segment = accessToken.split('.')[1];
    if (!segment) return null;
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const bytes = new Uint8Array(decode(padded));
    const json = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
    const payload = JSON.parse(json) as unknown;
    return payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function jwtSessionId(accessToken: string): string | null {
  const sessionId = decodeJwtPayload(accessToken)?.session_id;
  return typeof sessionId === 'string' && sessionId ? sessionId : null;
}

// supabase-js's own retryable network failure (AuthRetryableFetchError, status
// 0), a plain fetch failure, or a request that missed its deadline
// (supabase.ts: an AbortError "Network request timed out").
export function isAuthNetworkError(error: unknown): boolean {
  if (!error) return false;
  const value = error as { name?: unknown; message?: unknown; status?: unknown };
  if (value.name === 'AuthRetryableFetchError' || value.name === 'AbortError') return true;
  const message = String(value.message ?? '').toLowerCase();
  return message.includes('network request failed') || message.includes('failed to fetch') || message.includes('fetch failed')
    || message.includes('network request timed out') || message.includes('aborterror');
}

type StoredSession = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_at?: unknown;
  user?: { id?: unknown } | null;
};

// The session supabase-js persisted on this device (SecureStore on native,
// localStorage on web), read without any network call. supabase-js removes it
// itself on sign-out and when the server rejects the refresh token, so a
// session that is still here after a failed refresh failed for lack of a
// connection, not because the login ended.
async function readPersistedSession(): Promise<StoredSession | null> {
  const auth = supabase.auth as unknown as {
    storage?: { getItem(key: string): Promise<string | null> | string | null };
    storageKey?: unknown;
  };
  if (!auth.storage || typeof auth.storage.getItem !== 'function' || typeof auth.storageKey !== 'string') return null;
  try {
    const raw = await auth.storage.getItem(auth.storageKey);
    if (!raw) return null;
    const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as StoredSession : null;
  } catch {
    return null;
  }
}

function identityFromStored(stored: StoredSession | null): { userId: string; sessionId: string } | null {
  if (!stored || typeof stored.access_token !== 'string' || !stored.access_token) return null;
  const payload = decodeJwtPayload(stored.access_token);
  const sessionId = typeof payload?.session_id === 'string' && payload.session_id ? payload.session_id : null;
  const sub = typeof payload?.sub === 'string' ? payload.sub.toLowerCase() : '';
  const userField = typeof stored.user?.id === 'string' ? stored.user.id.toLowerCase() : '';
  const userId = userField || sub;
  // A token minted for one user stored next to another user's profile is not
  // a session this device can vouch for.
  if (!sessionId || !userId || (sub && userField && sub !== userField)) return null;
  return { userId, sessionId };
}

function storedNeedsRefresh(stored: StoredSession | null, now = Date.now()): boolean {
  const expiresAt = typeof stored?.expires_at === 'number' ? stored.expires_at : Number(stored?.expires_at);
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt * 1000 - now < EXPIRY_MARGIN_MS;
}

const TIMED_OUT = Symbol('timed-out');

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function offlineIdentity(): Promise<AuthSessionIdentity | null> {
  const identity = identityFromStored(await readPersistedSession());
  return identity ? { ...identity, offline: true } : null;
}

// Supabase's session_id JWT claim is stable across access-token refreshes but
// changes for a genuine sign-out/re-login, including a new login to the same
// user UUID. That makes it the correct login-epoch fence for asynchronous work.
//
// With allowOffline, an expired access token that cannot be refreshed because
// there is no connection does not sign the account out of its own on-device
// data: the persisted session still names the user and the login, and the
// result is flagged offline. Without a connection supabase-js keeps retrying
// the refresh for ~25 s; this waits at most `timeoutMs` and then remembers the
// device is offline for a few seconds so every save is not delayed again.
export async function currentAuthSessionIdentity(options: AuthSessionIdentityOptions = {}): Promise<AuthSessionIdentity | null> {
  if (!options.allowOffline) {
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session?.user.id) return null;
    const sessionId = jwtSessionId(data.session.access_token);
    if (!sessionId) return null;
    return { userId: data.session.user.id.toLowerCase(), sessionId };
  }

  if (Date.now() < networkDownUntil) {
    const stored = await readPersistedSession();
    // A token that does not need a refresh is served by getSession() from
    // storage without any network call, so only an expiring one is offline.
    if (!stored) return null;
    if (storedNeedsRefresh(stored)) {
      const identity = identityFromStored(stored);
      return identity ? { ...identity, offline: true } : null;
    }
  }

  let outcome: Awaited<ReturnType<typeof supabase.auth.getSession>> | typeof TIMED_OUT;
  try {
    outcome = await withTimeout(supabase.auth.getSession(), options.timeoutMs ?? SESSION_LOOKUP_TIMEOUT_MS);
  } catch (error) {
    if (!isAuthNetworkError(error)) return null;
    networkDownUntil = Date.now() + OFFLINE_RECHECK_MS;
    return offlineIdentity();
  }
  if (outcome === TIMED_OUT || (outcome.error && isAuthNetworkError(outcome.error))) {
    networkDownUntil = Date.now() + OFFLINE_RECHECK_MS;
    return offlineIdentity();
  }
  if (outcome.error || !outcome.data.session?.user.id) return null;
  networkDownUntil = 0;
  const sessionId = jwtSessionId(outcome.data.session.access_token);
  if (!sessionId) return null;
  return { userId: outcome.data.session.user.id.toLowerCase(), sessionId, offline: false };
}

// For the launch gate (App.tsx): the session to treat as signed in when
// supabase-js reports none. Returns the persisted session only when
// supabase-js still holds it on the device — i.e. the refresh failed for lack
// of a connection, not because the user signed out or the login was revoked
// (supabase-js deletes the stored session in both of those cases). Its access
// token may be expired; supabase-js refreshes it once the device is online.
export async function offlineSessionFallback(): Promise<Session | null> {
  const stored = await readPersistedSession();
  if (!stored || typeof stored.refresh_token !== 'string' || !stored.refresh_token) return null;
  if (!identityFromStored(stored)) return null;
  if (!stored.user || typeof stored.user.id !== 'string') return null;
  return stored as unknown as Session;
}

// Launch-time session lookup that never strands an offline user on the
// sign-in screen and never waits out supabase-js's ~25 s refresh retry.
export async function resolveLaunchSession(timeoutMs = SESSION_LOOKUP_TIMEOUT_MS): Promise<{ session: Session | null; offline: boolean }> {
  try {
    const outcome = await withTimeout(supabase.auth.getSession(), timeoutMs);
    if (outcome !== TIMED_OUT && outcome.data.session) {
      networkDownUntil = 0;
      return { session: outcome.data.session, offline: false };
    }
    if (outcome !== TIMED_OUT && outcome.error && !isAuthNetworkError(outcome.error)) return { session: null, offline: false };
  } catch (error) {
    if (!isAuthNetworkError(error)) return { session: null, offline: false };
  }
  const fallback = await offlineSessionFallback();
  if (fallback) networkDownUntil = Date.now() + OFFLINE_RECHECK_MS;
  return { session: fallback, offline: Boolean(fallback) };
}

// Sign this device out without the server. supabase-js's signOut() (both the
// global and the 'local' scope) first loads — i.e. refreshes — the session;
// with an expired token and no connection that fails with
// AuthRetryableFetchError and the persisted session stays, so the user cannot
// sign out offline. This removes the persisted session itself (the storage
// adapter in supabase.ts deletes every SecureStore chunk of the key) and emits
// SIGNED_OUT. The refresh token is not revoked on the server; it simply
// leaves the device. Call it only after signOut() failed for lack of a
// connection (isAuthNetworkError).
export async function forceLocalSignOut(): Promise<void> {
  networkDownUntil = 0;
  const auth = supabase.auth as unknown as {
    _removeSession?: () => Promise<void>;
    storage?: { removeItem(key: string): Promise<void> | void };
    storageKey?: unknown;
  };
  let removedByClient = false;
  if (typeof auth._removeSession === 'function') {
    try {
      // supabase-js's own teardown: clears the stored session, the cached
      // refresh failure, and guards against an in-flight refresh re-saving
      // it, then notifies onAuthStateChange subscribers.
      await auth._removeSession();
      removedByClient = true;
    } catch {
      removedByClient = false;
    }
  }
  if (auth.storage && typeof auth.storage.removeItem === 'function' && typeof auth.storageKey === 'string') {
    for (const suffix of ['', '-code-verifier', '-user']) {
      try {
        await auth.storage.removeItem(`${auth.storageKey}${suffix}`);
      } catch {
        // Already gone, or the store is unavailable; nothing else to do.
      }
    }
  }
  if (await readPersistedSession()) {
    throw new Error('The saved sign-in could not be removed from this device.');
  }
}

// Test hook: forget a remembered network failure.
export function resetAuthNetworkStateForTests(): void {
  networkDownUntil = 0;
}
