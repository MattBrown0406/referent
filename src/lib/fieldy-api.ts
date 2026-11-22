// Recorders, connected (docs/DAY_REVIEW.md, Phase 2): signing in to Fieldy
// or Plaud, keeping the connection, and reading new recordings, on the
// phone, and Fieldy in the web app too ("Fieldy on the web"). The rules are
// in src/lib/fieldy.ts.
//
// Safety properties, for each recorder:
//   * the practitioner signs in to their own account in the system browser
//     sheet (ASWebAuthenticationSession), or in the web app on Fieldy's own
//     page; ReferralFit never sees the password;
//   * the refresh token is kept in this phone's keychain, for this account
//     only, never synced (THIS_DEVICE_ONLY keeps it out of iCloud Keychain
//     and backups), or in a browser for this account only (this browser, or
//     only this tab), removed at sign-out; it is never sent to ReferralFit's
//     server; every change to it (refresh, connect, disconnect) goes through
//     one queue (and, in a browser, one lock across tabs), so a rotated token
//     is never lost to two writes crossing;
//   * a recording's text is read from the recorder straight to the device,
//     and goes only into the day review: through ReferralFit's day-review
//     function, which neither stores nor logs it, to Anthropic on the
//     practitioner's own key; nothing is saved until they approve it;
//   * which recordings were reviewed is kept apart from the sign-in, so
//     reconnecting never reads them again, and is forgotten with the
//     account; it is kept on ReferralFit's server too (ids, times and
//     one-way fingerprints, never words: src/lib/recording-marks.ts), so the
//     phone and the web app never offer the same recording twice;
//   * disconnecting revokes the access at the recorder (Fieldy's revocation
//     endpoint, Plaud's logout tool) and forgets it here; deleting the
//     account does too.

import { encode } from 'base64-arraybuffer';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

import {
  authorizeUrl,
  base64Url,
  codeFromCallback,
  conversationsFrom,
  emailFrom,
  FIELDY,
  FieldyError,
  formBody,
  hasAnswer,
  listArguments,
  listPlan,
  logoutPlan,
  MCP_PROTOCOL_VERSION,
  notePlan,
  noteText,
  recordingArguments,
  RECORDERS,
  reviewPlan,
  rpcBody,
  rpcResult,
  startOfToday,
  toolPayload,
  toolsFrom,
  transcriptPlan,
  transcriptText,
  tokensFrom,
  userPlan,
  webRecorder,
  type FieldyConversation,
  type McpTool,
  type Recorder,
  type ReviewPlan,
  type TranscriptPlan,
} from './fieldy';

import { apartFromFailed, failedMark, firstRecordings, mergeFingerprints, planAroundFailed } from './day-review';
import {
  acrossTabs,
  browserRead,
  browserRemove,
  browserWrite,
  CONNECT_WINDOW_MS,
  dropPendingConnect,
  fieldyReturnWaiting,
  IS_WEB,
  noteTabRotation,
  removeBrowserItems,
  rotationId,
  savePendingConnect,
  tabCopyStale,
  tabRemove,
  takeFieldyReturn,
  takePendingConnect,
  type BrowserScope,
} from './fieldy-web';
import { confirmSent, noteUnsent, pendingRows, readUnsent, withServerMarks, type ReadState } from './recording-marks';
import { fetchServerMarks, sendServerMarks } from './recording-marks-api';

export { FieldyError, FIELDY, PLAUD, RECORDERS, type Recorder, type RecorderId } from './fieldy';

/** The iPhone (and Android) app: every recorder connects here. */
export const fieldySupported = Platform.OS === 'ios' || Platform.OS === 'android';

function pageOrigin(): string | null {
  if (!IS_WEB || typeof window === 'undefined') return null;
  try { return window.location.origin || null; } catch { return null; }
}

/**
 * This recorder as this device signs in to it: as it is on the phone; in the
 * web app, Fieldy with the web client and a return to this page (null for
 * Plaud, which refuses browser pages, and for Fieldy before the web client
 * is registered).
 */
export function recorderHere(recorder: Recorder): Recorder | null {
  if (fieldySupported) return recorder;
  return IS_WEB ? webRecorder(recorder, pageOrigin()) : null;
}

/**
 * What the web app offers for a recorder: 'ready' (Connect), 'soon' (Fieldy,
 * before the web client is registered), 'phone' (Plaud: the iPhone app only).
 */
export function recorderOnWeb(recorder: Recorder): 'ready' | 'soon' | 'phone' {
  if (recorder.id !== 'fieldy') return 'phone';
  return recorderHere(recorder) ? 'ready' : 'soon';
}

/** Any recorder can be read on this device (the Today card counts them). */
export const recordersHere = fieldySupported || (IS_WEB && RECORDERS.some((recorder) => recorderOnWeb(recorder) === 'ready'));

const KEYCHAIN = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const clean = (userId: string) => userId.toLowerCase().replace(/[^a-z0-9._-]/g, '');

// ─── The sign-in (one record per recorder and account) ─────────────────────

/**
 * `scope`: in a browser, where it is kept (this tab only, or this browser).
 * `line` / `gen`: a tab-only sign-in's line and generation (fieldy-web.ts
 * noteTabRotation), so a duplicated tab's copy is never sent once rotated.
 */
type Token = { refreshToken: string; email: string; connectedAt: string; scope?: BrowserScope; line?: string; gen?: string };

const TOKEN_PREFIX = (id: string) => `referralfit.${id}.v1.`;
const tokenKey = (recorder: Recorder, userId: string) => `${TOKEN_PREFIX(recorder.id)}${clean(userId)}`;

function tokenFrom(raw: string, scope?: BrowserScope): Token | null {
  try {
    const data = JSON.parse(raw) as Partial<Token> & { through?: unknown };
    if (typeof data.refreshToken !== 'string' || !data.refreshToken) return null;
    return {
      refreshToken: data.refreshToken,
      email: typeof data.email === 'string' ? data.email : '',
      connectedAt: typeof data.connectedAt === 'string' ? data.connectedAt : '',
      ...(scope ? { scope } : {}),
      ...(typeof data.line === 'string' && data.line ? { line: data.line } : {}),
      ...(typeof data.gen === 'string' && data.gen ? { gen: data.gen } : {}),
    };
  } catch {
    return null;
  }
}

async function readToken(recorder: Recorder, userId: string): Promise<Token | null> {
  if (!userId || !recorderHere(recorder)) return null;
  try {
    if (IS_WEB) {
      const kept = browserRead(tokenKey(recorder, userId));
      const token = kept ? tokenFrom(kept.value, kept.scope) : null;
      // A copy from a duplicated tab that another tab has rotated since: dropped, never sent.
      if (token?.scope === 'tab' && tabCopyStale(token.line, token.gen)) {
        tabRemove(tokenKey(recorder, userId));
        return null;
      }
      return token;
    }
    const raw = await SecureStore.getItemAsync(tokenKey(recorder, userId));
    return raw ? tokenFrom(raw) : null;
  } catch {
    return null;
  }
}

// In a browser, the sign-ins removed in this tab (sign-out, a session that
// ended, another account): a refresh already on its way when they were
// removed never writes its rotated token back (it is revoked instead).
// Cleared when that account connects again.
const signedOut = new Set<string>();

function revokeInBackground(recorder: Recorder, refreshToken: string): void {
  const here = recorderHere(recorder);
  if (!here?.revokeUrl || !refreshToken) return;
  void postForm(here, here.revokeUrl, { token: refreshToken, token_type_hint: 'refresh_token', client_id: here.clientId }).catch(() => undefined);
}

async function writeToken(recorder: Recorder, userId: string, value: Token): Promise<void> {
  const { scope, ...kept } = value;
  if (IS_WEB) {
    const name = tokenKey(recorder, userId);
    if (signedOut.has(name)) {
      revokeInBackground(recorder, value.refreshToken);
      throw new FieldyError(`Connect ${recorder.name} first.`, 'disconnected');
    }
    // A tab-only sign-in: a new generation at every write, noted for the other tabs.
    const tab = scope === 'tab' ? { line: kept.line || rotationId(), gen: rotationId() } : null;
    const record = tab ? { ...kept, ...tab } : { ...kept, line: undefined, gen: undefined };
    // Once more on a failure: a rotated refresh token that is not kept would end the connection.
    try {
      browserWrite(name, JSON.stringify(record), scope ?? 'browser');
    } catch {
      browserWrite(name, JSON.stringify(record), scope ?? 'browser');
    }
    if (tab) noteTabRotation(tab.line, tab.gen);
    return;
  }
  // Once more on a failure: a rotated refresh token that is not kept would end the connection.
  try {
    await SecureStore.setItemAsync(tokenKey(recorder, userId), JSON.stringify(kept), KEYCHAIN);
  } catch {
    await SecureStore.setItemAsync(tokenKey(recorder, userId), JSON.stringify(kept), KEYCHAIN);
  }
}

async function deleteToken(recorder: Recorder, userId: string): Promise<void> {
  if (IS_WEB) { browserRemove(tokenKey(recorder, userId)); return; }
  await SecureStore.deleteItemAsync(tokenKey(recorder, userId)).catch(() => undefined);
}

// ─── What was reviewed (kept apart from the sign-in) ───────────────────────

// Reviewed recordings are remembered for 14 days; reads look back at most 7.
const REVIEWED_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const LOOK_BACK_MS = 7 * 24 * 60 * 60 * 1000;

// `failing`: recordings whose summary or transcript could not be read, and
// since when; one that fails again a day later is taken as having no text.
// `saved`: per recording, when, and the fingerprints of items saved from it
// (src/lib/day-review.ts signatureHash), so a recording read again does not
// offer them twice. `unreviewable`: recordings whose review failed when
// read on their own (incomplete, turned down, too slow), since when and when
// last tried: read alone, only when nothing else is new (day-review.ts
// apartFromFailed), the one tried least recently first ("<since> <last
// tried>"). `unsent`: changes the server has not confirmed yet, written with
// the change itself and sent again at the next read until it does;
// `synced`: false when all of it must be copied up once
// (src/lib/recording-marks.ts). The phone and the web app read both.

const READ_PREFIX = (id: string) => `referralfit.${id}.read.v1.`;
const readKey = (recorder: Recorder, userId: string) => `${READ_PREFIX(recorder.id)}${clean(userId)}`;

/** What this device keeps (never asks the server). */
async function readLocal(recorder: Recorder, userId: string): Promise<ReadState | null> {
  try {
    const raw = IS_WEB ? browserRead(readKey(recorder, userId))?.value ?? null : await SecureStore.getItemAsync(readKey(recorder, userId));
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<ReadState>;
    const times = (value: unknown) => {
      const out: Record<string, string> = {};
      for (const [id, at] of Object.entries(value && typeof value === 'object' ? value : {})) {
        if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) out[id] = at;
      }
      return out;
    };
    // "<since> <last tried>" (an older mark has its first time only).
    const marks = (value: unknown) => {
      const out: Record<string, string> = {};
      for (const [id, at] of Object.entries(value && typeof value === 'object' ? value : {})) {
        if (typeof at === 'string' && !Number.isNaN(Date.parse(at.split(' ')[0]))) out[id] = at;
      }
      return out;
    };
    const saved: Record<string, string> = {};
    for (const [id, value] of Object.entries(data.saved && typeof data.saved === 'object' ? data.saved : {})) {
      if (typeof value === 'string' && !Number.isNaN(Date.parse(value.split(' ')[0]))) saved[id] = value;
    }
    return {
      floor: typeof data.floor === 'string' && !Number.isNaN(Date.parse(data.floor)) ? data.floor : startOfToday(),
      reviewed: times(data.reviewed),
      failing: times(data.failing),
      saved,
      unreviewable: marks(data.unreviewable),
      unsent: readUnsent(data.unsent),
      // Kept before the server knew of it (an older app, or no table yet): copied up once.
      synced: data.synced === true,
    };
  } catch {
    return null;
  }
}

async function writeLocal(recorder: Recorder, userId: string, value: ReadState): Promise<void> {
  const cutoff = Date.now() - REVIEWED_KEEP_MS;
  const recent = (entries: Record<string, string>, limit = 2000) => Object.fromEntries(Object.entries(entries)
    .filter(([, at]) => Date.parse(at.split(' ')[0]) >= cutoff).slice(-limit));
  const raw = JSON.stringify({
    floor: value.floor, reviewed: recent(value.reviewed), failing: recent(value.failing), saved: recent(value.saved, 200),
    unreviewable: recent(value.unreviewable, 200), unsent: value.unsent, synced: value.synced,
  });
  // In a browser: ids, times and fingerprints only (no client data), kept in this browser.
  if (IS_WEB) browserWrite(readKey(recorder, userId), raw, 'browser');
  else await SecureStore.setItemAsync(readKey(recorder, userId), raw, KEYCHAIN);
}

// A new state has nothing the server lacks.
const emptyState = (now = new Date()): ReadState => ({ floor: startOfToday(now), reviewed: {}, failing: {}, saved: {}, unreviewable: {}, unsent: {}, synced: true });

// Accounts deleted in this session: what was reviewed is never written for them again.
const forgotten = new Set<string>();

const readQueue = (recorder: Recorder, userId: string) => `${slot(recorder, userId)}:read`;

/**
 * A change to what was reviewed, in its own queue (apart from the sign-in's;
 * across tabs in a browser). Written here first, with what the server still
 * needs in the same write (`noteUnsent`, called by `change`), then sent
 * (sendUnsent). A send cut off or not taken leaves the change in `unsent`,
 * sent again at the next read.
 */
function changeState(recorder: Recorder, userId: string, change: (state: ReadState) => void | boolean): Promise<void> {
  const key = readQueue(recorder, userId);
  return serial(key, () => acrossTabs(key, async () => {
    if (forgotten.has(slot(recorder, userId))) return false;
    const state = (await readLocal(recorder, userId)) ?? emptyState();
    // false: nothing changed, nothing to write.
    if (change(state) === false) return false;
    await writeLocal(recorder, userId, state);
    return Object.keys(state.unsent).length > 0 || !state.synced;
  })).then((pending) => {
    if (pending) void sendUnsent(recorder, userId).catch(() => undefined);
  });
}

/**
 * What the server has not confirmed, sent: read in the read queue, sent
 * outside it (a slow server never holds a change or a read back), then each
 * change the server took is taken off the list in the read queue again,
 * unless it changed meanwhile. One send at a time in this tab. The account
 * it started for is the one named in every call (the server refuses a call
 * for an account that is not the one signed in).
 */
function sendUnsent(recorder: Recorder, userId: string): Promise<void> {
  const key = readQueue(recorder, userId);
  return serial(`${slot(recorder, userId)}:send`, async () => {
    if (forgotten.has(slot(recorder, userId))) return;
    const pending = await serial(key, () => acrossTabs(key, async () => {
      const state = await readLocal(recorder, userId);
      return state && (Object.keys(state.unsent).length || !state.synced) ? pendingRows(state) : null;
    }));
    if (!pending || forgotten.has(slot(recorder, userId))) return;
    if (!(await sendServerMarks(recorder.id, userId, pending.rows).catch(() => false))) return;
    await serial(key, () => acrossTabs(key, async () => {
      if (forgotten.has(slot(recorder, userId))) return;
      const state = await readLocal(recorder, userId);
      if (state && confirmSent(state, pending.sent, pending.full)) await writeLocal(recorder, userId, state);
    }));
  });
}

/**
 * What was reviewed, for these recordings: this device's marks joined with
 * the server's. First, what the server has not confirmed is sent (every
 * change not taken yet, and the first time the server can be reached,
 * everything kept here: joined there, so nothing on the server is lost, and
 * nothing here is). The server's marks are kept here too, so a moment
 * without the server never offers them again. Without the server (no table
 * yet, offline): this device's marks, as before.
 */
async function reviewedState(recorder: Recorder, userId: string, ids: string[], now = new Date()): Promise<ReadState> {
  const local = (await readLocal(recorder, userId)) ?? emptyState(now);
  if (forgotten.has(slot(recorder, userId))) return local;
  if (Object.keys(local.unsent).length || !local.synced) await sendUnsent(recorder, userId).catch(() => undefined);
  const remote = ids.length ? await fetchServerMarks(recorder.id, userId, ids).catch(() => null) : null;
  const base = (await readLocal(recorder, userId)) ?? local;
  if (!remote || !remote.length) return base;
  const joined = withServerMarks(base, remote);
  await changeState(recorder, userId, (state) => {
    const next = withServerMarks(state, remote);
    if (JSON.stringify(next) === JSON.stringify(state)) return false;
    Object.assign(state, next);
    return true;
  }).catch(() => undefined);
  return joined;
}

// ─── One queue per recorder and account ────────────────────────────────────

const slot = (recorder: Recorder, userId: string) => `${recorder.id}:${userId}`;
const queues = new Map<string, Promise<unknown>>();

/** Runs `work` after everything queued before it for this recorder and account. */
function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  queues.set(key, next.catch(() => undefined));
  return next;
}

/** The sign-in's queue: in this tab, then (in a browser) across every tab. */
function signInQueue<T>(recorder: Recorder, userId: string, work: () => Promise<T>): Promise<T> {
  const key = slot(recorder, userId);
  return serial(key, () => acrossTabs(`${key}:sign-in`, work));
}

// The access token for this session only (an hour or so), never stored.
const access = new Map<string, { token: string; expiresAt: number }>();

export type RecorderStatus = { connected: boolean; email: string };

export async function recorderStatus(recorder: Recorder, userId: string): Promise<RecorderStatus> {
  const token = await readToken(recorder, userId);
  return { connected: Boolean(token), email: token?.email ?? '' };
}

// Every call gives up after a while, the answer's body included (the
// phone's fetch resolves on the headers, and a stream can stay open), so
// the review never waits for good.
const CALL_TIMEOUT_MS = 30_000;

type Answer = { status: number; ok: boolean; contentType: string; sessionId: string; text: string };

/**
 * One request, read to the end within CALL_TIMEOUT_MS. An event stream is
 * read only until `until` says the answer is in it (an MCP server may keep
 * the stream open after answering).
 */
async function request(url: string, init: RequestInit, until?: (text: string) => boolean): Promise<Answer> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, CALL_TIMEOUT_MS);
  });
  const work = (async (): Promise<Answer> => {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const contentType = response.headers.get('content-type') || '';
    const head = { status: response.status, ok: response.ok, contentType, sessionId: response.headers.get('mcp-session-id') || '' };
    const reader = until && /text\/event-stream/i.test(contentType) && typeof TextDecoder !== 'undefined' ? response.body?.getReader() : undefined;
    if (!reader) return { ...head, text: await response.text() };
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (value) text += decoder.decode(value, { stream: true });
      if (done) break;
      if (until!(text)) { reader.cancel().catch(() => undefined); break; }
    }
    return { ...head, text: text + decoder.decode() };
  })();
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    work.catch(() => undefined);
  }
}

async function postForm(recorder: Recorder, url: string, fields: Record<string, string>): Promise<unknown> {
  let answer: Answer;
  try {
    answer = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: formBody(fields),
    });
  } catch {
    throw new FieldyError(`${recorder.name} could not be reached. Check your connection and try again.`);
  }
  try {
    return JSON.parse(answer.text);
  } catch {
    return { error: `http_${answer.status}` };
  }
}

async function pkce(): Promise<{ verifier: string; challenge: string; state: string }> {
  const verifier = base64Url(encode(Crypto.getRandomBytes(32).buffer as ArrayBuffer));
  const challenge = base64Url(await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, { encoding: Crypto.CryptoEncoding.BASE64 }));
  const state = base64Url(encode(Crypto.getRandomBytes(16).buffer as ArrayBuffer));
  return { verifier, challenge, state };
}

/**
 * Connect a recorder: the practitioner signs in to their account in the
 * browser sheet and approves ReferralFit. Resolves with the account shown.
 * In the web app (Fieldy only) the page goes to Fieldy's sign-in and comes
 * back to /oauth/fieldy, where finishWebConnect completes it; `tabOnly`
 * keeps the sign-in in this tab only. The promise then never resolves with
 * a connection (the page has left); it answers 'cancelled' if the page is
 * still here a while later.
 */
export async function connectRecorder(recorder: Recorder, userId: string, options: { tabOnly?: boolean } = {}): Promise<RecorderStatus> {
  if (!userId) throw new FieldyError(`Sign in again, then connect ${recorder.name}.`);
  const here = recorderHere(recorder);
  if (!here) {
    throw new FieldyError(IS_WEB && recorder.id === 'fieldy'
      ? 'Fieldy connects in the browser soon. For now, connect it in the ReferralFit app on your iPhone.'
      : `${recorder.name} connects in the ReferralFit app on your iPhone.`);
  }
  const { verifier, challenge, state } = await pkce();
  if (IS_WEB) {
    try {
      savePendingConnect({ state, verifier, userId, redirectUri: here.redirectUri, scope: options.tabOnly ? 'tab' : 'browser', at: Date.now() });
    } catch (error) {
      throw new FieldyError(error instanceof Error ? error.message : `${recorder.name} could not connect in this browser.`);
    }
    window.location.assign(authorizeUrl(challenge, state, here));
    await new Promise((resolve) => setTimeout(resolve, 20_000));
    throw new FieldyError(`${recorder.name} was not connected.`, 'cancelled');
  }
  const result = await WebBrowser.openAuthSessionAsync(authorizeUrl(challenge, state, here), here.redirectUri);
  if (result.type !== 'success') throw new FieldyError(`${recorder.name} was not connected.`, 'cancelled');
  return finishConnect(here, userId, codeFromCallback(result.url, state, here), verifier);
}

// The code exchanged for tokens, kept for this account; the account named.
async function finishConnect(here: Recorder, userId: string, code: string, verifier: string, scope?: BrowserScope): Promise<RecorderStatus> {
  const tokens = tokensFrom(await postForm(here, here.tokenUrl, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: here.redirectUri,
    client_id: here.clientId,
    code_verifier: verifier,
    resource: here.mcpUrl,
  }), Date.now(), here.name);
  const key = slot(here, userId);
  await signInQueue(here, userId, async () => {
    // Connected again: this account's sign-in may be kept again.
    signedOut.delete(tokenKey(here, userId));
    await writeToken(here, userId, { refreshToken: tokens.refreshToken, email: '', connectedAt: new Date().toISOString(), ...(scope ? { scope } : {}) });
    access.set(key, { token: tokens.accessToken, expiresAt: tokens.expiresAt });
  });
  // The first time: reading starts today. A reconnect keeps what was reviewed.
  await serial(readQueue(here, userId), () => acrossTabs(readQueue(here, userId), async () => {
    if (!(await readLocal(here, userId))) await writeLocal(here, userId, emptyState());
  }));
  const email = await accountEmail(here, userId, tokens.accessToken);
  if (email) {
    await signInQueue(here, userId, async () => {
      const token = await readToken(here, userId);
      if (token) await writeToken(here, userId, { ...token, email });
    });
  }
  return { connected: true, email };
}

/**
 * In the web app, back from Fieldy's sign-in (/oauth/fieldy, captured by
 * index.ts): the sign-in this tab started for this account, finished. null
 * when there is no return waiting. Throws (and connects nothing) when the
 * return does not match: another account, another tab, too late, a state or
 * issuer that differs, or Fieldy saying no.
 */
export async function finishWebConnect(userId: string): Promise<{ recorder: Recorder; status: RecorderStatus } | null> {
  if (!IS_WEB || !userId || !fieldyReturnWaiting()) return null;
  const back = takeFieldyReturn();
  const pending = takePendingConnect();
  if (!back) return null;
  const here = recorderHere(FIELDY);
  if (!here || !pending || Date.now() - pending.at > CONNECT_WINDOW_MS || pending.at > Date.now() + 60_000) {
    throw new FieldyError('That Fieldy sign-in was not started in this tab, or took too long. Connect Fieldy again.');
  }
  if (pending.userId !== userId) {
    throw new FieldyError('That Fieldy sign-in was started for another ReferralFit account, so it was not connected. Connect Fieldy again.');
  }
  if (pending.redirectUri !== here.redirectUri) throw new FieldyError('Fieldy sent you back to the wrong place. Try connecting again.');
  const code = codeFromCallback(back, pending.state, here);
  const status = await finishConnect(here, userId, code, pending.verifier, pending.scope);
  return { recorder: FIELDY, status };
}

// Which account it is, to show "Connected as …": the recorder's userinfo
// endpoint, or its MCP server's current-user tool. '' when it cannot say.
async function accountEmail(recorder: Recorder, userId: string, token: string): Promise<string> {
  try {
    if (recorder.userinfoUrl) {
      const answer = await request(recorder.userinfoUrl, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
      return emailFrom(JSON.parse(answer.text));
    }
    const session = await openSession(recorder, userId, token);
    const name = userPlan(await tools(recorder, session));
    return name ? emailFrom(toolPayload(await session.call('tools/call', { name, arguments: {} }), recorder)) : '';
  } catch {
    return '';
  }
}

// A refresh token ended at the recorder: Fieldy's revocation endpoint, or
// Plaud's logout tool (called with the access token in hand, or one fetched
// with the refresh token in hand, never kept).
async function revokeToken(here: Recorder, userId: string, refreshToken: string, live: string): Promise<void> {
  if (here.revokeUrl) {
    await postForm(here, here.revokeUrl, { token: refreshToken, token_type_hint: 'refresh_token', client_id: here.clientId });
    return;
  }
  const token = live || tokensFrom(await postForm(here, here.tokenUrl, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: here.clientId,
    resource: here.mcpUrl,
  }), Date.now(), here.name, refreshToken).accessToken;
  const session = await openSession(here, userId, token);
  const name = logoutPlan(await tools(here, session));
  if (name) await session.call('tools/call', { name, arguments: {} });
}

// Forgotten here first, then revoked at the recorder (when it can be
// reached), so a slow or closed app never leaves the sign-in on the device.
// Read and forgotten in one step of the queue: a refresh on its way
// finishes first, and the newest token is the one revoked; one queued after
// finds nothing, so a disconnect is never undone by it.
async function revokeAndForget(recorder: Recorder, userId: string): Promise<void> {
  const here = recorderHere(recorder);
  if (!here) return;
  const key = slot(recorder, userId);
  const held = await signInQueue(recorder, userId, async () => {
    const token = await readToken(recorder, userId);
    const cached = access.get(key);
    access.delete(key);
    await deleteToken(recorder, userId);
    return { token, live: cached && cached.expiresAt > Date.now() ? cached.token : '' };
  });
  const { token } = held;
  if (!token) return;
  try {
    await revokeToken(here, userId, token.refreshToken, held.live);
  } catch {
    // Unreachable: it is forgotten here all the same.
  }
}

/** Disconnect: the access is revoked and forgotten; what was reviewed is kept, for a reconnect. */
export function disconnectRecorder(recorder: Recorder, userId: string): Promise<void> {
  return revokeAndForget(recorder, userId);
}

/** The account is deleted: every recorder is disconnected, and what was reviewed is forgotten too (the server's rows go with the account). */
export async function forgetRecorders(userId: string): Promise<void> {
  if (!(fieldySupported || IS_WEB) || !userId) return;
  await Promise.all(RECORDERS.map(async (recorder) => {
    // In the read queue, and never written again in this session: a read
    // still on its way cannot bring it back.
    forgotten.add(slot(recorder, userId));
    await serial(readQueue(recorder, userId), async () => {
      if (IS_WEB) browserRemove(readKey(recorder, userId));
      else await SecureStore.deleteItemAsync(readKey(recorder, userId));
    }).catch(() => undefined);
    await revokeAndForget(recorder, userId).catch(() => undefined);
  }));
}

/**
 * In the web app: every recorder sign-in kept in this browser leaves it,
 * except `keepUserId`'s (the account signed in here now), as the Anthropic
 * key does: at sign-out, a session that ended, or another account signing
 * in. Each one removed is revoked at the recorder in the background (best
 * effort; it is gone from the browser either way). What was reviewed stays
 * (ids, times and fingerprints: no client data), per account.
 */
export function removeBrowserRecorderSignIns(keepUserId?: string): void {
  if (!IS_WEB) return;
  const keep = new Set(keepUserId ? RECORDERS.map((recorder) => tokenKey(recorder, keepUserId)) : []);
  if (!keepUserId) dropPendingConnect();
  const removed = removeBrowserItems(RECORDERS.map((recorder) => TOKEN_PREFIX(recorder.id)), keep);
  // This tab's access tokens go too (the account kept refreshes its own once).
  if (removed.length) access.clear();
  for (const item of removed) {
    const recorder = RECORDERS.find((candidate) => item.name.startsWith(TOKEN_PREFIX(candidate.id)));
    if (!recorder) continue;
    // A refresh on its way in this tab never writes its rotated token back.
    signedOut.add(item.name);
    const token = tokenFrom(item.value);
    if (token) revokeInBackground(recorder, token.refreshToken);
    // One on its way in another tab: once it lets go of the sign-in's lock,
    // whatever it wrote back is removed and revoked too.
    const userId = item.name.slice(TOKEN_PREFIX(recorder.id).length);
    if (!userId) continue;
    void signInQueue(recorder, userId, async () => {
      if (!signedOut.has(item.name)) return;
      const left = browserRead(item.name);
      if (!left) return;
      browserRemove(item.name);
      const late = tokenFrom(left.value);
      if (late && late.refreshToken !== token?.refreshToken) revokeInBackground(recorder, late.refreshToken);
    }).catch(() => undefined);
  }
}

async function accessToken(recorder: Recorder, userId: string): Promise<string> {
  const here = recorderHere(recorder);
  if (!here) throw new FieldyError(`Connect ${recorder.name} first.`, 'disconnected');
  const key = slot(recorder, userId);
  const current = access.get(key);
  if (current && current.expiresAt > Date.now()) return current.token;
  return signInQueue(recorder, userId, async () => {
    // Another call in the queue may have refreshed already.
    const fresh = access.get(key);
    if (fresh && fresh.expiresAt > Date.now()) return fresh.token;
    // Read inside the lock: another tab may have rotated it a moment ago.
    const token = await readToken(recorder, userId);
    if (!token) throw new FieldyError(`Connect ${recorder.name} first.`, 'disconnected');
    let tokens;
    try {
      // A server that does not rotate refresh tokens sends none back: the one kept stays.
      tokens = tokensFrom(await postForm(here, here.tokenUrl, {
        grant_type: 'refresh_token',
        refresh_token: token.refreshToken,
        client_id: here.clientId,
        resource: here.mcpUrl,
      }), Date.now(), recorder.name, token.refreshToken);
    } catch (error) {
      if (error instanceof FieldyError && error.reason === 'disconnected') {
        // Revoked at the recorder, or too old: the sign-in is forgotten so the
        // screen offers to connect again; what was reviewed is kept. Only the
        // token that was refused: one another tab kept meanwhile stays.
        const now = await readToken(recorder, userId);
        if (now && now.refreshToken === token.refreshToken) await deleteToken(recorder, userId);
      }
      throw error;
    }
    // The new refresh token replaces the old one at once (the old one no longer works).
    await writeToken(recorder, userId, { ...token, refreshToken: tokens.refreshToken });
    access.set(key, { token: tokens.accessToken, expiresAt: tokens.expiresAt });
    return tokens.accessToken;
  });
}

// ─── The recorder's MCP server ─────────────────────────────────────────────

type Session = { call: (method: string, params?: Record<string, unknown>) => Promise<unknown> };

async function openSession(recorder: Recorder, userId: string, given?: string): Promise<Session> {
  const token = given ?? await accessToken(recorder, userId);
  let sessionId = '';
  let protocol = MCP_PROTOCOL_VERSION;
  let next = 1;
  const post = async (body: string, id: number | null): Promise<Answer> => {
    try {
      return await request(recorder.mcpUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': protocol,
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        },
        body,
      }, id === null ? undefined : (text) => hasAnswer(text, id));
    } catch {
      throw new FieldyError(`${recorder.name} could not be reached. Check your connection and try again.`);
    }
  };
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const id = next;
    next += 1;
    const answer = await post(rpcBody(id, method, params), id);
    if (answer.status === 401) {
      if (!given) access.delete(slot(recorder, userId));
      throw new FieldyError(`Your ${recorder.name} connection needs a moment. Try again.`);
    }
    if (!answer.ok) throw new FieldyError(`${recorder.name} could not read your ${recorder.noun}s right now. Try again.`);
    if (answer.sessionId) sessionId = answer.sessionId;
    return rpcResult(answer.text, answer.contentType, id, recorder);
  };
  const init = await call('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'ReferralFit', version: '1' } });
  // The version the server agreed to is the one every later request names.
  const agreed = (init as { protocolVersion?: unknown } | null)?.protocolVersion;
  if (typeof agreed === 'string' && agreed) protocol = agreed;
  // A notification has no answer to wait for.
  await post(rpcBody(null, 'notifications/initialized'), null).catch(() => undefined);
  return { call };
}

const toolNamesLogged = new Set<string>();

async function tools(recorder: Recorder, session: Session): Promise<McpTool[]> {
  const list = toolsFrom(await session.call('tools/list'));
  if (__DEV__ && !toolNamesLogged.has(recorder.id)) {
    // Tool names and their argument names only, never anyone's data: to check the plan against the recorder's tools.
    toolNamesLogged.add(recorder.id);
    console.log(`${recorder.name} MCP tools`, list.map((tool) => `${tool.name}(${Object.keys(tool.inputSchema?.properties || {}).join(', ')})`).join(' | '));
  }
  return list;
}

async function listConversations(recorder: Recorder, session: Session, toolList: McpTool[], since: string, until: string): Promise<FieldyConversation[]> {
  const plan = listPlan(toolList);
  if (!plan) throw new FieldyError(`${recorder.name} did not offer a way to list your ${recorder.noun}s. Paste the summary instead.`);
  const found = new Map<string, FieldyConversation>();
  let cursor: string | null = null;
  for (let page = plan.firstPage; page < plan.firstPage + 10; page += 1) {
    const later = page > plan.firstPage;
    let payload: unknown;
    try {
      payload = toolPayload(await session.call('tools/call', { name: plan.name, arguments: listArguments(plan, since, until, cursor, page) }), recorder);
    } catch (error) {
      // A page past the end answered with an error: the list has ended.
      if (later && error instanceof FieldyError && error.reason === 'tool') break;
      throw error;
    }
    const { conversations, nextCursor, text, unreadable, count } = conversationsFrom(payload);
    // A page past the end, empty or in words ("No files found"): the list has ended.
    if (later && !count) break;
    // An answer in words, or a list none of whose recordings could be read:
    // never taken for "nothing new".
    if ((!conversations.length && text) || unreadable) {
      throw new FieldyError(`${recorder.name} answered in a way ReferralFit could not read. Paste the summary instead.`);
    }
    const before = found.size;
    for (const item of conversations) found.set(item.id, item);
    if (plan.cursor) {
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    } else if (plan.page) {
      // Pages by number: until an empty page, or one with nothing new (a
      // server that ignores the page number sends the same one again).
      if (!count || found.size === before) break;
    } else {
      break;
    }
  }
  return [...found.values()];
}

// At most this many summaries or transcripts are read one by one in a
// review (Plaud's list gives none), and only for so long; the rest wait for
// the next read, and never hold back recordings whose summary is in the list.
const DETAIL_READS = 8;
const DETAIL_TIME_MS = 60_000;
// A recording the recorder has not summarized is read from its transcript
// only once it ended this long ago (the summary is written after it ends).
const SUMMARY_WAIT_MS = 90 * 60 * 1000;

export type RecorderRead = ReviewPlan & { recorder: Recorder };

// The window a read looks in: since the first connect (the start of that
// day), at most the last 7 days.
function windowStart(state: ReadState, now: Date): string {
  return new Date(Math.max(Date.parse(state.floor), now.getTime() - LOOK_BACK_MS)).toISOString();
}

// Those listed in the window that were not reviewed on this device or, by
// the server's marks, on another (the phone, the web app).
async function unreviewed(recorder: Recorder, userId: string, session: Session, toolList: McpTool[], now: Date): Promise<{ fresh: FieldyConversation[]; state: ReadState }> {
  const local = (await readLocal(recorder, userId)) ?? emptyState(now);
  const since = windowStart(local, now);
  const listed = (await listConversations(recorder, session, toolList, since, now.toISOString()))
    .filter((item) => Date.parse(item.startTime) >= Date.parse(since));
  const state = await reviewedState(recorder, userId, listed.map((item) => item.id), now);
  return { fresh: listed.filter((item) => !state.reviewed[item.id]), state };
}

// One recording's text, by a tool ('' when it has none). Throws when the
// recorder could not be reached or answered with an error.
async function detail(recorder: Recorder, session: Session, plan: TranscriptPlan, item: FieldyConversation, now: number,
  read: (payload: unknown) => string): Promise<string> {
  return read(toolPayload(await session.call('tools/call', { name: plan.name, arguments: recordingArguments(plan, item, now) }), recorder));
}

// A note this short may be the recorder saying it has none ("No note has
// been generated"): the transcript is read too, and used when it has words.
const SHORT_NOTE = 120;
// A recording whose summary and transcript keep failing for itself (the
// recorder answers with an error, or it is too slow while other reads work)
// is taken as having no text after a day of failures; until then it waits,
// behind those not failing. A weak connection never counts.
const FAILING_GIVE_UP_MS = 24 * 60 * 60 * 1000;

/**
 * The recordings not reviewed yet, ready for the day review. Nothing is
 * marked reviewed here: markRecordingsReviewed does that, one recording at
 * a time, once its items are saved or set aside.
 */
export async function readNewRecordings(recorder: Recorder, userId: string, now = new Date()): Promise<RecorderRead> {
  if (!(await readToken(recorder, userId))) throw new FieldyError(`Connect ${recorder.name} first.`, 'disconnected');
  const session = await openSession(recorder, userId);
  const toolList = await tools(recorder, session);
  const { fresh, state } = await unreviewed(recorder, userId, session, toolList, now);
  // A recording without a summary in the list: its summary (Plaud's note),
  // else, once it ended a while ago, its transcript. A few per review, and
  // only for so long; those not failing first.
  const note = notePlan(toolList);
  const transcript = transcriptPlan(toolList);
  const texts: Record<string, string> = {};
  const read: FieldyConversation[] = fresh.filter((item) => item.summary);
  // Oldest first (the list may come newest first), those not failing before those failing.
  const needed = fresh.filter((item) => !item.summary)
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime) || a.id.localeCompare(b.id));
  // Two of the reads are kept for recordings that failed before, so new ones never keep them waiting for good.
  const untried = needed.filter((item) => !state.failing[item.id]);
  const retry = needed.filter((item) => state.failing[item.id]);
  const order = [...untried.slice(0, DETAIL_READS - 2), ...retry.slice(0, 2), ...untried.slice(DETAIL_READS - 2), ...retry.slice(2)];
  const failing: Record<string, string> = {};
  const recovered: string[] = [];
  const started = Date.now();
  let reads = 0;
  // A detail read that worked: the connection was fine, so another item's
  // failure in this read is that item's own.
  let anyDetailRead = false;
  // Items whose read failed, decided after the loop: a failure is only held
  // against an item (its one-day clock started or run on) when the recorder
  // answered with an error about it, or when other reads in this same review
  // worked. On poor signal every read fails; the items then simply wait, and
  // no clock starts, so they are never given up for a weak connection.
  const failedItems: { item: FieldyConversation; ownFault: boolean }[] = [];
  const isOwnFault = (error: unknown) => error instanceof FieldyError && error.reason === 'tool';
  for (const item of order) {
    if (reads >= DETAIL_READS || Date.now() - started > DETAIL_TIME_MS) continue;
    reads += 1;
    let failed = false;
    let ownFault = false;
    let fromNote = '';
    let fromTranscript = '';
    if (note) {
      try {
        fromNote = await detail(recorder, session, note, item, now.getTime(), noteText);
        anyDetailRead = true;
      } catch (error) {
        failed = true;
        ownFault = ownFault || isOwnFault(error);
      }
    }
    const ended = Date.parse(item.endTime || item.startTime);
    if (fromNote.length < SHORT_NOTE && transcript && !Number.isNaN(ended) && now.getTime() - ended >= SUMMARY_WAIT_MS) {
      try {
        fromTranscript = await detail(recorder, session, transcript, item, now.getTime(), (payload) => transcriptText(payload, item.id));
        anyDetailRead = true;
      } catch (error) {
        failed = true;
        ownFault = ownFault || isOwnFault(error);
      }
    }
    // A short note ("No note has been generated…") is used only when there
    // is no transcript to read; with an empty transcript it is no text.
    const shortNoteOk = fromNote.length >= SHORT_NOTE || !transcript;
    const text = fromTranscript && fromNote.length < SHORT_NOTE ? fromTranscript : shortNoteOk ? fromNote || fromTranscript : '';
    if (text) {
      texts[item.id] = text;
      if (state.failing[item.id]) recovered.push(item.id);
      read.push(item);
      continue;
    }
    if (failed) {
      failedItems.push({ item, ownFault });
      continue;
    }
    // Read, and no text: reviewPlan waits for it, or skips it a day after it ended.
    read.push(item);
  }
  for (const { item, ownFault } of failedItems) {
    // Not read this time (never taken for "no text" at once): tried again
    // next time. Given up only when it fails again, for itself, a day after
    // it first did; a weak connection neither starts nor runs that clock.
    if (!ownFault && !anyDetailRead) continue;
    const since = state.failing[item.id] ?? now.toISOString();
    failing[item.id] = since;
    if (now.getTime() - Date.parse(since) < FAILING_GIVE_UP_MS) continue;
    read.push(item);
  }
  if (Object.keys(failing).length || recovered.length) {
    const at = new Date().toISOString();
    await changeState(recorder, userId, (current) => {
      for (const [id, since] of Object.entries(failing)) {
        current.failing[id] = since;
        noteUnsent(current, id, at);
      }
      // Read again: its failure clock stops, here and (a clear, until the server has it) on the server.
      for (const id of recovered) {
        delete current.failing[id];
        noteUnsent(current, id, at, { failing: true });
      }
    }).catch(() => undefined);
  }
  // A few recordings per review, so it rarely finds more than it can list.
  // One whose review failed on its own is set aside before the review is
  // planned (it takes no room in it), and read alone, the one tried least
  // recently first, only when nothing else can be read.
  const { others, apart } = apartFromFailed(read, state.unreviewable);
  const plan = firstRecordings(planAroundFailed(reviewPlan(others, now.getTime(), texts, recorder.name), apart,
    (index) => reviewPlan([apart[index]], now.getTime(), texts, recorder.name)));
  return { ...plan, later: plan.later + (fresh.length - read.length), recorder };
}

/**
 * These recordings are done: their items were saved or set aside, or there was
 * nothing in them. Answers how many were not marked before, so the count of
 * recordings waiting can drop at once, without asking the recorder again.
 */
export async function markRecordingsReviewed(recorder: Recorder, userId: string, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const at = new Date().toISOString();
  let marked = 0;
  await changeState(recorder, userId, (state) => {
    marked = 0;
    for (const id of new Set(ids)) {
      if (!state.reviewed[id]) marked += 1;
      state.reviewed[id] = at;
      delete state.failing[id];
      delete state.saved[id];
      delete state.unreviewable[id];
      noteUnsent(state, id, at);
    }
  });
  return marked;
}

/**
 * This recording's review failed when it was read on its own (incomplete,
 * turned down, too slow): from now on it is read alone, and only when
 * nothing else is new, so it never holds newer recordings back. Kept until
 * it is marked reviewed ("Done with this", or a review of it settles).
 */
export async function rememberReviewFailed(recorder: Recorder, userId: string, id: string): Promise<void> {
  const at = new Date().toISOString();
  await changeState(recorder, userId, (state) => {
    // Since the first failure; tried again now (with several, the one tried least recently goes next).
    state.unreviewable[id] = failedMark(state.unreviewable[id], at);
    noteUnsent(state, id, at);
  });
}

/**
 * A review of these recordings came back: one whose review had failed on
 * its own is an ordinary recording again (a slow moment is not held against
 * it for good).
 */
export async function reviewCameBack(recorder: Recorder, userId: string, ids: string[]): Promise<void> {
  const at = new Date().toISOString();
  await changeState(recorder, userId, (state) => {
    let changed = false;
    for (const id of ids) {
      if (!state.unreviewable[id]) continue;
      // Cleared here, and on the server (a clear, until the server has it).
      delete state.unreviewable[id];
      noteUnsent(state, id, at, { unreviewable: true });
      changed = true;
    }
    return changed;
  });
}

/** Fingerprints of items saved from these recordings, kept until each is reviewed. */
export async function rememberSaved(recorder: Recorder, userId: string, byRecording: Record<string, string[]>): Promise<void> {
  const ids = Object.keys(byRecording).filter((id) => byRecording[id].length);
  if (!ids.length) return;
  const at = new Date().toISOString();
  await changeState(recorder, userId, (state) => {
    for (const id of ids) {
      const before = state.saved[id]?.split(' ').slice(1) ?? [];
      // The newest 200 are kept: a long day's last saves are never the ones dropped.
      state.saved[id] = [at, ...mergeFingerprints(before, byRecording[id])].join(' ');
      noteUnsent(state, id, at);
    }
  });
}

/** The fingerprints of items saved earlier from these recordings (on this device or, by the server, another). */
export async function savedFrom(recorder: Recorder, userId: string, ids: string[]): Promise<string[]> {
  const state = await reviewedState(recorder, userId, ids);
  return ids.flatMap((id) => state.saved[id]?.split(' ').slice(1) ?? []);
}

/**
 * How many recordings are waiting, for the Today card and the evening
 * reminder: counted only, never reviewed (the review runs when the
 * practitioner opens it, on their own key). 0 when not connected; null when
 * the recorder could not be reached (the count stays as it was).
 */
export async function countNewRecordings(recorder: Recorder, userId: string, now = new Date()): Promise<number | null> {
  if (!(await readToken(recorder, userId))) return 0;
  try {
    const session = await openSession(recorder, userId);
    const { fresh } = await unreviewed(recorder, userId, session, await tools(recorder, session), now);
    return new Set(fresh.map((item) => item.id)).size;
  } catch (error) {
    // The connection ended (the sign-in is forgotten): nothing waits. Otherwise the count stays as it was.
    return error instanceof FieldyError && error.reason === 'disconnected' ? 0 : null;
  }
}
