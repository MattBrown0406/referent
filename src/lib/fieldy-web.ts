// Fieldy in the web app (docs/DAY_REVIEW.md, "Fieldy on the web"): what the
// browser keeps, and the trip to Fieldy's sign-in and back.
//
//   * Fieldy's sign-in pages send Cross-Origin-Opener-Policy: same-origin, so
//     a popup loses its link to this page and expo-web-browser's popup flow
//     reports it closed at once. The sign-in is a full-page trip instead: the
//     PKCE verifier and the state wait in this tab's sessionStorage, and the
//     return page (/oauth/fieldy) hands its address over before the app
//     draws, then leaves the address bar at "/" (captureFieldyReturn, called
//     from index.ts).
//   * The refresh token is kept per account in this browser (localStorage) or
//     only in this tab (sessionStorage), as the practitioner chooses, like
//     the Anthropic key; removed at sign-out and when another account signs
//     in here (removeBrowserRecorderSignIns).
//   * Changes to it are made one at a time across every tab of the web app
//     (Web Locks, as store.ts does for the offline queue): Fieldy rotates
//     refresh tokens, and two tabs refreshing the same one at once would
//     end the connection.
//
// Nothing here runs in the iPhone app.

import { WEB_RETURN_PATH } from './fieldy';
import { IS_WEB } from './web-layout';

export { IS_WEB };

type BrowserStore = { getItem(name: string): string | null; setItem(name: string, value: string): void; removeItem(name: string): void; key(index: number): string | null; readonly length: number };

export type BrowserScope = 'tab' | 'browser';

export function browserStore(kind: 'local' | 'session'): BrowserStore | null {
  if (!IS_WEB) return null;
  try {
    const scope = globalThis as unknown as { localStorage?: BrowserStore; sessionStorage?: BrowserStore };
    return (kind === 'local' ? scope.localStorage : scope.sessionStorage) ?? null;
  } catch {
    return null;
  }
}

const storeFor = (scope: BrowserScope) => browserStore(scope === 'tab' ? 'session' : 'local');

/** A kept value and where it is kept (this tab first: a tab-only sign-in is the newer choice). */
export function browserRead(name: string): { value: string; scope: BrowserScope } | null {
  try {
    const tab = browserStore('session')?.getItem(name);
    if (tab) return { value: tab, scope: 'tab' };
    const kept = browserStore('local')?.getItem(name);
    if (kept) return { value: kept, scope: 'browser' };
  } catch { /* storage refused */ }
  return null;
}

/** Kept in one place only: the other forgets it. Throws when the browser refuses to keep it. */
export function browserWrite(name: string, value: string, scope: BrowserScope): void {
  const store = storeFor(scope);
  if (!store) throw new Error('This browser does not let ReferralFit keep the sign-in (a private window can refuse). Try a normal window.');
  store.setItem(name, value);
  try { storeFor(scope === 'tab' ? 'browser' : 'tab')?.removeItem(name); } catch { /* nothing kept there */ }
}

export function browserRemove(name: string): void {
  for (const kind of ['local', 'session'] as const) {
    try { browserStore(kind)?.removeItem(name); } catch { /* nothing kept */ }
  }
}

// ─── A sign-in kept in one tab only, and a duplicated tab ──────────────────
//
// The browser's Duplicate Tab copies sessionStorage, so two tabs can hold the
// same "Only this tab" refresh token. Fieldy rotates it: the second tab to
// refresh would send one already used (refused, and it can end the first
// tab's sign-in too). So each tab-only sign-in has a line (one per connect,
// copied with the tab) and a generation (new at every write); the latest
// generation of each line is noted in the browser's storage (ids and a time
// only, never a token). A tab whose copy is not the latest one drops it and
// asks to connect again, never sending it.

const ROTATION_PREFIX = 'referralfit.tabRotation.v1.';
const ROTATION_KEEP_MS = 14 * 24 * 60 * 60 * 1000;

/** A new id for a line or a generation (not a secret). */
export function rotationId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** This tab-only sign-in's line is now at `gen`; notes older than two weeks go. False when it could not be noted. */
export function noteTabRotation(line: string, gen: string): boolean {
  const store = browserStore('local');
  if (!store || !line) return false;
  try {
    const cutoff = Date.now() - ROTATION_KEEP_MS;
    const old: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const name = store.key(index);
      if (!name?.startsWith(ROTATION_PREFIX)) continue;
      try {
        const at = (JSON.parse(store.getItem(name) || '{}') as { at?: unknown }).at;
        if (typeof at !== 'number' || at < cutoff) old.push(name);
      } catch { old.push(name); }
    }
    for (const name of old) store.removeItem(name);
    store.setItem(`${ROTATION_PREFIX}${line}`, JSON.stringify({ gen, at: Date.now() }));
    return true;
  } catch {
    return false; // storage refused: a duplicated tab is then not caught
  }
}

/** Another tab with a copy of this tab-only sign-in has rotated it since: this copy no longer works. */
export function tabCopyStale(line: string | undefined, gen: string | undefined): boolean {
  if (!line) return false;
  try {
    const raw = browserStore('local')?.getItem(`${ROTATION_PREFIX}${line}`);
    if (!raw) return false;
    const noted = (JSON.parse(raw) as { gen?: unknown }).gen;
    return typeof noted === 'string' && noted !== gen;
  } catch {
    return false;
  }
}

/** This tab's own copy only (sessionStorage), removed. */
export function tabRemove(name: string): void {
  try { browserStore('session')?.removeItem(name); } catch { /* nothing kept */ }
}

// ─── One change at a time, across tabs ─────────────────────────────────────

type WebLocks = { request: <R>(name: string, callback: () => Promise<R>) => Promise<R> };

/** Runs `work` holding the browser-wide lock `name` (every tab waits its turn). Plain on the phone. */
export function acrossTabs<T>(name: string, work: () => Promise<T>): Promise<T> {
  const locks = IS_WEB && typeof navigator !== 'undefined' ? (navigator as unknown as { locks?: WebLocks }).locks : undefined;
  if (!locks || typeof locks.request !== 'function') return work();
  return locks.request(`referralfit-${name}`, work);
}

// ─── The trip to Fieldy and back ───────────────────────────────────────────

const PENDING_KEY = 'referralfit.fieldyConnect.v1';
const RETURN_KEY = 'referralfit.fieldyReturn.v1';
/** A sign-in not finished within this long is not finished at all. */
export const CONNECT_WINDOW_MS = 15 * 60_000;

export type PendingConnect = { state: string; verifier: string; userId: string; redirectUri: string; scope: BrowserScope; at: number };

export function savePendingConnect(value: PendingConnect): void {
  const store = browserStore('session');
  if (!store) throw new Error('This browser does not let ReferralFit keep the sign-in (a private window can refuse). Try a normal window.');
  store.setItem(PENDING_KEY, JSON.stringify(value));
}

/** The sign-in this tab started, taken (it is used once), or null. */
export function takePendingConnect(): PendingConnect | null {
  const store = browserStore('session');
  try {
    const raw = store?.getItem(PENDING_KEY);
    store?.removeItem(PENDING_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<PendingConnect>;
    if (typeof data.state !== 'string' || typeof data.verifier !== 'string' || typeof data.userId !== 'string'
      || typeof data.redirectUri !== 'string' || typeof data.at !== 'number') return null;
    return { state: data.state, verifier: data.verifier, userId: data.userId, redirectUri: data.redirectUri, scope: data.scope === 'tab' ? 'tab' : 'browser', at: data.at };
  } catch {
    return null;
  }
}

/**
 * On the return page (/oauth/fieldy?code=…&state=…): its address is kept
 * for this tab and the address bar goes back to "/" at once, so the code
 * never stays in the history, a bookmark or a shared link. Called before the
 * app draws; the app finishes the sign-in once it knows who is signed in.
 */
export function captureFieldyReturn(): void {
  if (!IS_WEB || typeof window === 'undefined') return;
  try {
    if (window.location.pathname !== WEB_RETURN_PATH) return;
    browserStore('session')?.setItem(RETURN_KEY, window.location.href);
    window.history.replaceState(null, '', '/');
  } catch { /* nothing to finish */ }
}

/** The return page's address, taken (used once), or null. */
export function takeFieldyReturn(): string | null {
  const store = browserStore('session');
  try {
    const url = store?.getItem(RETURN_KEY) ?? null;
    store?.removeItem(RETURN_KEY);
    return url;
  } catch {
    return null;
  }
}

/** There is a return waiting to be finished in this tab. */
export function fieldyReturnWaiting(): boolean {
  try { return Boolean(browserStore('session')?.getItem(RETURN_KEY)); } catch { return false; }
}

// ─── Leaving the browser ───────────────────────────────────────────────────

/**
 * Every recorder sign-in kept in this browser (this tab and the browser's
 * storage) whose name starts with one of `prefixes`, except `keep` names:
 * removed, and handed back (the caller revokes them at the recorder).
 */
export function removeBrowserItems(prefixes: string[], keep: Set<string>): { name: string; value: string }[] {
  const removed: { name: string; value: string }[] = [];
  for (const kind of ['local', 'session'] as const) {
    const store = browserStore(kind);
    if (!store) continue;
    try {
      const names: string[] = [];
      for (let index = 0; index < store.length; index += 1) {
        const name = store.key(index);
        if (name && prefixes.some((prefix) => name.startsWith(prefix)) && !keep.has(name)) names.push(name);
      }
      for (const name of names) {
        const value = store.getItem(name);
        store.removeItem(name);
        if (value) removed.push({ name, value });
      }
    } catch { /* storage refused: nothing was kept */ }
  }
  return removed;
}

/** A sign-in started here and not finished, and its return if it came: dropped (sign-out). */
export function dropPendingConnect(): void {
  try {
    browserStore('session')?.removeItem(PENDING_KEY);
    browserStore('session')?.removeItem(RETURN_KEY);
  } catch { /* nothing kept */ }
}
