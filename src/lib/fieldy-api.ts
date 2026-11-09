// Recorders, connected (docs/DAY_REVIEW.md, Phase 2): signing in to Fieldy
// or Plaud, keeping the connection, and reading new recordings, on the
// phone. The rules are in src/lib/fieldy.ts.
//
// Safety properties, for each recorder:
//   * the practitioner signs in to their own account in the system browser
//     sheet (ASWebAuthenticationSession); ReferralFit never sees the password;
//   * the refresh token is kept in this phone's keychain, for this account
//     only, never synced (THIS_DEVICE_ONLY keeps it out of iCloud Keychain
//     and backups), and never sent to ReferralFit's server; every change to
//     it (refresh, connect, disconnect) goes through one queue, so a
//     rotated token is never lost to two writes crossing;
//   * a recording's text is read from the recorder straight to the phone,
//     and goes only into the day review: through ReferralFit's day-review
//     function, which neither stores nor logs it, to Anthropic on the
//     practitioner's own key; nothing is saved until they approve it;
//   * which recordings were reviewed is kept apart from the sign-in, so
//     reconnecting never reads them again, and is forgotten with the account;
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
  type FieldyConversation,
  type McpTool,
  type Recorder,
  type ReviewPlan,
  type TranscriptPlan,
} from './fieldy';

export { FieldyError, FIELDY, PLAUD, RECORDERS, type Recorder, type RecorderId } from './fieldy';

export const fieldySupported = Platform.OS === 'ios' || Platform.OS === 'android';

const KEYCHAIN = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const clean = (userId: string) => userId.toLowerCase().replace(/[^a-z0-9._-]/g, '');

// ─── The sign-in (one record per recorder and account) ─────────────────────

type Token = { refreshToken: string; email: string; connectedAt: string };

const tokenKey = (recorder: Recorder, userId: string) => `referralfit.${recorder.id}.v1.${clean(userId)}`;

async function readToken(recorder: Recorder, userId: string): Promise<Token | null> {
  if (!fieldySupported || !userId) return null;
  try {
    const raw = await SecureStore.getItemAsync(tokenKey(recorder, userId));
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<Token> & { through?: unknown };
    if (typeof data.refreshToken !== 'string' || !data.refreshToken) return null;
    return {
      refreshToken: data.refreshToken,
      email: typeof data.email === 'string' ? data.email : '',
      connectedAt: typeof data.connectedAt === 'string' ? data.connectedAt : '',
    };
  } catch {
    return null;
  }
}

async function writeToken(recorder: Recorder, userId: string, value: Token): Promise<void> {
  // Once more on a failure: a rotated refresh token that is not kept would end the connection.
  try {
    await SecureStore.setItemAsync(tokenKey(recorder, userId), JSON.stringify(value), KEYCHAIN);
  } catch {
    await SecureStore.setItemAsync(tokenKey(recorder, userId), JSON.stringify(value), KEYCHAIN);
  }
}

// ─── What was reviewed (kept apart from the sign-in) ───────────────────────

// Reviewed recordings are remembered for 14 days; reads look back at most 7.
const REVIEWED_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const LOOK_BACK_MS = 7 * 24 * 60 * 60 * 1000;

// `failing`: recordings whose summary or transcript could not be read, and
// since when; one that keeps failing for a day is taken as having no text.
type ReadState = { floor: string; reviewed: Record<string, string>; failing: Record<string, string> };

const readKey = (recorder: Recorder, userId: string) => `referralfit.${recorder.id}.read.v1.${clean(userId)}`;

async function readState(recorder: Recorder, userId: string): Promise<ReadState | null> {
  try {
    const raw = await SecureStore.getItemAsync(readKey(recorder, userId));
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<ReadState>;
    const times = (value: unknown) => {
      const out: Record<string, string> = {};
      for (const [id, at] of Object.entries(value && typeof value === 'object' ? value : {})) {
        if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) out[id] = at;
      }
      return out;
    };
    return {
      floor: typeof data.floor === 'string' && !Number.isNaN(Date.parse(data.floor)) ? data.floor : startOfToday(),
      reviewed: times(data.reviewed),
      failing: times(data.failing),
    };
  } catch {
    return null;
  }
}

async function writeState(recorder: Recorder, userId: string, value: ReadState): Promise<void> {
  const cutoff = Date.now() - REVIEWED_KEEP_MS;
  const recent = (entries: Record<string, string>) => Object.fromEntries(Object.entries(entries).filter(([, at]) => Date.parse(at) >= cutoff).slice(-2000));
  await SecureStore.setItemAsync(readKey(recorder, userId), JSON.stringify({ floor: value.floor, reviewed: recent(value.reviewed), failing: recent(value.failing) }), KEYCHAIN);
}

const emptyState = (now = new Date()): ReadState => ({ floor: startOfToday(now), reviewed: {}, failing: {} });

/** A change to what was reviewed, in its own queue (apart from the sign-in's). */
function changeState(recorder: Recorder, userId: string, change: (state: ReadState) => void): Promise<void> {
  return serial(`${slot(recorder, userId)}:read`, async () => {
    const state = (await readState(recorder, userId)) ?? emptyState();
    change(state);
    await writeState(recorder, userId, state);
  });
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

/**
 * Connect a recorder: the practitioner signs in to their account in the
 * browser sheet and approves ReferralFit. Resolves with the account shown.
 */
export async function connectRecorder(recorder: Recorder, userId: string): Promise<RecorderStatus> {
  if (!fieldySupported) throw new FieldyError(`Connect ${recorder.name} in the ReferralFit app on your iPhone.`);
  if (!userId) throw new FieldyError(`Sign in again, then connect ${recorder.name}.`);
  const verifier = base64Url(encode(Crypto.getRandomBytes(32).buffer as ArrayBuffer));
  const challenge = base64Url(await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, { encoding: Crypto.CryptoEncoding.BASE64 }));
  const state = base64Url(encode(Crypto.getRandomBytes(16).buffer as ArrayBuffer));
  const result = await WebBrowser.openAuthSessionAsync(authorizeUrl(challenge, state, recorder), recorder.redirectUri);
  if (result.type !== 'success') throw new FieldyError(`${recorder.name} was not connected.`, 'cancelled');
  const code = codeFromCallback(result.url, state, recorder);
  const tokens = tokensFrom(await postForm(recorder, recorder.tokenUrl, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: recorder.redirectUri,
    client_id: recorder.clientId,
    code_verifier: verifier,
    resource: recorder.mcpUrl,
  }), Date.now(), recorder.name);
  const key = slot(recorder, userId);
  await serial(key, async () => {
    await writeToken(recorder, userId, { refreshToken: tokens.refreshToken, email: '', connectedAt: new Date().toISOString() });
    access.set(key, { token: tokens.accessToken, expiresAt: tokens.expiresAt });
    // The first time: reading starts today. A reconnect keeps what was reviewed.
    if (!(await readState(recorder, userId))) await writeState(recorder, userId, emptyState());
  });
  const email = await accountEmail(recorder, userId, tokens.accessToken);
  if (email) {
    await serial(key, async () => {
      const token = await readToken(recorder, userId);
      if (token) await writeToken(recorder, userId, { ...token, email });
    });
  }
  return { connected: true, email };
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

// Forgotten here first, then revoked at the recorder (when it can be
// reached), so a slow or closed app never leaves the sign-in on the phone.
// Read and forgotten in one step of the queue: a refresh on its way
// finishes first, and the newest token is the one revoked; one queued after
// finds nothing, so a disconnect is never undone by it. Plaud's logout is a
// tool on its MCP server: it is called with the access token in hand, or
// one fetched with the refresh token in hand (never kept).
async function revokeAndForget(recorder: Recorder, userId: string): Promise<void> {
  const key = slot(recorder, userId);
  const held = await serial(key, async () => {
    const token = await readToken(recorder, userId);
    const cached = access.get(key);
    access.delete(key);
    await SecureStore.deleteItemAsync(tokenKey(recorder, userId)).catch(() => undefined);
    return { token, live: cached && cached.expiresAt > Date.now() ? cached.token : '' };
  });
  const { token } = held;
  if (!token) return;
  try {
    if (recorder.revokeUrl) {
      await postForm(recorder, recorder.revokeUrl, { token: token.refreshToken, token_type_hint: 'refresh_token', client_id: recorder.clientId });
      return;
    }
    const live = held.live || tokensFrom(await postForm(recorder, recorder.tokenUrl, {
      grant_type: 'refresh_token',
      refresh_token: token.refreshToken,
      client_id: recorder.clientId,
      resource: recorder.mcpUrl,
    }), Date.now(), recorder.name, token.refreshToken).accessToken;
    const session = await openSession(recorder, userId, live);
    const name = logoutPlan(await tools(recorder, session));
    if (name) await session.call('tools/call', { name, arguments: {} });
  } catch {
    // Unreachable: it is forgotten here all the same.
  }
}

/** Disconnect: the access is revoked and forgotten; what was reviewed is kept, for a reconnect. */
export function disconnectRecorder(recorder: Recorder, userId: string): Promise<void> {
  return revokeAndForget(recorder, userId);
}

/** The account is deleted: every recorder is disconnected, and what was reviewed is forgotten too. */
export async function forgetRecorders(userId: string): Promise<void> {
  if (!fieldySupported || !userId) return;
  await Promise.all(RECORDERS.map(async (recorder) => {
    await SecureStore.deleteItemAsync(readKey(recorder, userId)).catch(() => undefined);
    await revokeAndForget(recorder, userId).catch(() => undefined);
  }));
}

async function accessToken(recorder: Recorder, userId: string): Promise<string> {
  const key = slot(recorder, userId);
  const current = access.get(key);
  if (current && current.expiresAt > Date.now()) return current.token;
  return serial(key, async () => {
    // Another call in the queue may have refreshed already.
    const fresh = access.get(key);
    if (fresh && fresh.expiresAt > Date.now()) return fresh.token;
    const token = await readToken(recorder, userId);
    if (!token) throw new FieldyError(`Connect ${recorder.name} first.`, 'disconnected');
    let tokens;
    try {
      // A server that does not rotate refresh tokens sends none back: the one kept stays.
      tokens = tokensFrom(await postForm(recorder, recorder.tokenUrl, {
        grant_type: 'refresh_token',
        refresh_token: token.refreshToken,
        client_id: recorder.clientId,
        resource: recorder.mcpUrl,
      }), Date.now(), recorder.name, token.refreshToken);
    } catch (error) {
      if (error instanceof FieldyError && error.reason === 'disconnected') {
        // Revoked at the recorder, or too old: the sign-in is forgotten so the
        // screen offers to connect again; what was reviewed is kept.
        await SecureStore.deleteItemAsync(tokenKey(recorder, userId)).catch(() => undefined);
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

async function unreviewed(recorder: Recorder, userId: string, session: Session, toolList: McpTool[], now: Date): Promise<{ fresh: FieldyConversation[]; state: ReadState }> {
  const state = (await readState(recorder, userId)) ?? emptyState(now);
  const since = windowStart(state, now);
  const listed = await listConversations(recorder, session, toolList, since, now.toISOString());
  return { fresh: listed.filter((item) => Date.parse(item.startTime) >= Date.parse(since) && !state.reviewed[item.id]), state };
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
// A recording whose summary and transcript keep failing (an error, or too
// slow) is taken as having no text after a day of failures; until then it
// waits, behind those not failing.
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
  const needed = fresh.filter((item) => !item.summary);
  const order = [...needed.filter((item) => !state.failing[item.id]), ...needed.filter((item) => state.failing[item.id])];
  const failing: Record<string, string> = {};
  const recovered: string[] = [];
  const started = Date.now();
  let reads = 0;
  for (const item of order) {
    if (reads >= DETAIL_READS || Date.now() - started > DETAIL_TIME_MS) continue;
    reads += 1;
    let failed = false;
    let fromNote = '';
    let fromTranscript = '';
    if (note) {
      try { fromNote = await detail(recorder, session, note, item, now.getTime(), noteText); } catch { failed = true; }
    }
    const ended = Date.parse(item.endTime || item.startTime);
    if (fromNote.length < SHORT_NOTE && transcript && !Number.isNaN(ended) && now.getTime() - ended >= SUMMARY_WAIT_MS) {
      try {
        fromTranscript = await detail(recorder, session, transcript, item, now.getTime(), (payload) => transcriptText(payload, item.id));
      } catch {
        failed = true;
      }
    }
    const text = fromNote.length < SHORT_NOTE && fromTranscript ? fromTranscript : fromNote || fromTranscript;
    if (text) {
      texts[item.id] = text;
      if (state.failing[item.id]) recovered.push(item.id);
      read.push(item);
      continue;
    }
    if (failed) {
      // Not read this time (never taken for "no text" at once): tried again
      // next time, until it has failed for a day.
      const since = state.failing[item.id] ?? now.toISOString();
      failing[item.id] = since;
      if (now.getTime() - Date.parse(since) < FAILING_GIVE_UP_MS) continue;
    }
    // Read, and no text (or failing for a day): reviewPlan waits for it, or skips it a day after it ended.
    read.push(item);
  }
  if (Object.keys(failing).length || recovered.length) {
    await changeState(recorder, userId, (current) => {
      Object.assign(current.failing, failing);
      for (const id of recovered) delete current.failing[id];
    }).catch(() => undefined);
  }
  const plan = reviewPlan(read, now.getTime(), texts, recorder.name);
  return { ...plan, later: plan.later + (fresh.length - read.length), recorder };
}

/** These recordings are done: their items were saved or set aside, or there was nothing in them. */
export async function markRecordingsReviewed(recorder: Recorder, userId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const at = new Date().toISOString();
  await changeState(recorder, userId, (state) => {
    for (const id of ids) {
      state.reviewed[id] = at;
      delete state.failing[id];
    }
  });
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
