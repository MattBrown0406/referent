// Recorders, connected (docs/DAY_REVIEW.md, Phase 2): signing in to Fieldy
// or Plaud, keeping the connection, and reading new recordings, all on the
// phone. The rules are in src/lib/fieldy.ts.
//
// Safety properties, for each recorder:
//   * the practitioner signs in to their own account in the system browser
//     sheet (ASWebAuthenticationSession); ReferralFit never sees the password;
//   * the refresh token is kept in this phone's keychain, for this account
//     only, never synced (THIS_DEVICE_ONLY keeps it out of iCloud Keychain
//     and backups), and never sent to ReferralFit's server;
//   * recordings are read straight from the recorder to the phone, and go
//     only into the day review, which sends their text to Anthropic on the
//     practitioner's own key and saves nothing until they approve it;
//   * disconnecting revokes the access at the recorder (Fieldy's revocation
//     endpoint, Plaud's logout tool) and forgets it here.

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
  listArguments,
  listPlan,
  logoutPlan,
  MCP_PROTOCOL_VERSION,
  notePlan,
  noteText,
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
} from './fieldy';

export { FieldyError, FIELDY, PLAUD, RECORDERS, type Recorder, type RecorderId } from './fieldy';

export const fieldySupported = Platform.OS === 'ios' || Platform.OS === 'android';

type Stored = { refreshToken: string; email: string; through: string | null; connectedAt: string };

function storageKey(recorder: Recorder, userId: string): string {
  return `referralfit.${recorder.id}.v1.${userId.toLowerCase().replace(/[^a-z0-9._-]/g, '')}`;
}

async function readStored(recorder: Recorder, userId: string): Promise<Stored | null> {
  if (!fieldySupported || !userId) return null;
  try {
    const raw = await SecureStore.getItemAsync(storageKey(recorder, userId));
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<Stored>;
    if (typeof data.refreshToken !== 'string' || !data.refreshToken) return null;
    return {
      refreshToken: data.refreshToken,
      email: typeof data.email === 'string' ? data.email : '',
      through: typeof data.through === 'string' && !Number.isNaN(Date.parse(data.through)) ? data.through : null,
      connectedAt: typeof data.connectedAt === 'string' ? data.connectedAt : '',
    };
  } catch {
    return null;
  }
}

async function writeStored(recorder: Recorder, userId: string, value: Stored): Promise<void> {
  await SecureStore.setItemAsync(storageKey(recorder, userId), JSON.stringify(value), {
    // After the first unlock, so a later background read can work; never synced or backed up.
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
}

const slot = (recorder: Recorder, userId: string) => `${recorder.id}:${userId}`;

// The access token for this session only (an hour or so), never stored.
const access = new Map<string, { token: string; expiresAt: number }>();
// One refresh at a time per recorder and account: refresh tokens rotate, so
// two at once would leave one of them holding a token that no longer works.
const refreshing = new Map<string, Promise<string>>();

export type RecorderStatus = { connected: boolean; email: string };

export async function recorderStatus(recorder: Recorder, userId: string): Promise<RecorderStatus> {
  const stored = await readStored(recorder, userId);
  return { connected: Boolean(stored), email: stored?.email ?? '' };
}

async function postForm(recorder: Recorder, url: string, fields: Record<string, string>): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: formBody(fields),
    });
  } catch {
    throw new FieldyError(`${recorder.name} could not be reached. Check your connection and try again.`);
  }
  return response.json().catch(() => ({ error: `http_${response.status}` }));
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
  const previous = await readStored(recorder, userId);
  await writeStored(recorder, userId, { refreshToken: tokens.refreshToken, email: '', through: previous?.through ?? null, connectedAt: new Date().toISOString() });
  access.set(slot(recorder, userId), { token: tokens.accessToken, expiresAt: tokens.expiresAt });
  const email = await accountEmail(recorder, userId, tokens.accessToken);
  if (email) {
    const stored = await readStored(recorder, userId);
    if (stored) await writeStored(recorder, userId, { ...stored, email });
  }
  return { connected: true, email };
}

// Which account it is, to show "Connected as …": the recorder's userinfo
// endpoint, or its MCP server's current-user tool. '' when it cannot say.
async function accountEmail(recorder: Recorder, userId: string, token: string): Promise<string> {
  try {
    if (recorder.userinfoUrl) {
      const response = await fetch(recorder.userinfoUrl, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
      return emailFrom(await response.json().catch(() => null));
    }
    const session = await openSession(recorder, userId);
    const name = userPlan(await tools(recorder, session));
    return name ? emailFrom(toolPayload(await session.call('tools/call', { name, arguments: {} }))) : '';
  } catch {
    return '';
  }
}

/** Disconnect: the access is revoked at the recorder (when it can be reached) and forgotten here. */
export async function disconnectRecorder(recorder: Recorder, userId: string): Promise<void> {
  const stored = await readStored(recorder, userId);
  if (stored) {
    try {
      if (recorder.revokeUrl) {
        await postForm(recorder, recorder.revokeUrl, { token: stored.refreshToken, token_type_hint: 'refresh_token', client_id: recorder.clientId });
      } else {
        const session = await openSession(recorder, userId);
        const name = logoutPlan(await tools(recorder, session));
        if (name) await session.call('tools/call', { name, arguments: {} });
      }
    } catch {
      // Unreachable: it is forgotten here all the same.
    }
  }
  access.delete(slot(recorder, userId));
  await SecureStore.deleteItemAsync(storageKey(recorder, userId)).catch(() => undefined);
}

async function accessToken(recorder: Recorder, userId: string): Promise<string> {
  const key = slot(recorder, userId);
  const current = access.get(key);
  if (current && current.expiresAt > Date.now()) return current.token;
  const running = refreshing.get(key);
  if (running) return running;
  const refresh = (async () => {
    const stored = await readStored(recorder, userId);
    if (!stored) throw new FieldyError(`Connect ${recorder.name} first.`, 'disconnected');
    let tokens;
    try {
      tokens = tokensFrom(await postForm(recorder, recorder.tokenUrl, {
        grant_type: 'refresh_token',
        refresh_token: stored.refreshToken,
        client_id: recorder.clientId,
        resource: recorder.mcpUrl,
      }), Date.now(), recorder.name);
    } catch (error) {
      if (error instanceof FieldyError && error.reason === 'disconnected') {
        // Revoked at the recorder, or too old: forget it, so the screen offers to connect again.
        await SecureStore.deleteItemAsync(storageKey(recorder, userId)).catch(() => undefined);
      }
      throw error;
    }
    // The new refresh token replaces the old one at once (the old one no longer works).
    await writeStored(recorder, userId, { ...stored, refreshToken: tokens.refreshToken });
    access.set(key, { token: tokens.accessToken, expiresAt: tokens.expiresAt });
    return tokens.accessToken;
  })();
  refreshing.set(key, refresh);
  try {
    return await refresh;
  } finally {
    refreshing.delete(key);
  }
}

// ─── The recorder's MCP server ─────────────────────────────────────────────

type Session = { call: (method: string, params?: Record<string, unknown>) => Promise<unknown> };

async function openSession(recorder: Recorder, userId: string): Promise<Session> {
  const token = await accessToken(recorder, userId);
  let sessionId = '';
  let next = 1;
  const post = async (body: string): Promise<Response> => {
    try {
      return await fetch(recorder.mcpUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': MCP_PROTOCOL_VERSION,
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        },
        body,
      });
    } catch {
      throw new FieldyError(`${recorder.name} could not be reached. Check your connection and try again.`);
    }
  };
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const id = next;
    next += 1;
    const response = await post(rpcBody(id, method, params));
    if (response.status === 401) {
      access.delete(slot(recorder, userId));
      throw new FieldyError(`Your ${recorder.name} connection needs a moment. Try again.`);
    }
    if (!response.ok) throw new FieldyError(`${recorder.name} could not read your ${recorder.noun}s right now. Try again.`);
    const header = response.headers.get('mcp-session-id');
    if (header) sessionId = header;
    return rpcResult(await response.text(), response.headers.get('content-type') || '', id);
  };
  await call('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'ReferralFit', version: '1' } });
  // A notification has no answer to wait for.
  await post(rpcBody(null, 'notifications/initialized')).catch(() => undefined);
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
  const found: FieldyConversation[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 6; page += 1) {
    const payload = toolPayload(await session.call('tools/call', { name: plan.name, arguments: listArguments(plan, since, until, cursor) }));
    const { conversations, nextCursor } = conversationsFrom(payload);
    found.push(...conversations);
    if (!nextCursor || nextCursor === cursor || !plan.cursor) break;
    cursor = nextCursor;
  }
  return found;
}

// At most this many summaries or transcripts are read one by one in a
// review (Plaud's list gives none); the rest wait for the next read.
const DETAIL_READS = 8;
// A recording the recorder has not summarized is read from its transcript
// only once it ended this long ago (the summary is written after it ends).
const SUMMARY_WAIT_MS = 90 * 60 * 1000;

export type RecorderRead = ReviewPlan & { since: string; recorder: Recorder };

/**
 * The recordings since the last read (the first time, since the start of
 * today), ready for the day review. Nothing moves on until commitRecorderRead:
 * recordings read but not reviewed are read again next time.
 */
export async function readNewRecordings(recorder: Recorder, userId: string, now = new Date()): Promise<RecorderRead> {
  const stored = await readStored(recorder, userId);
  if (!stored) throw new FieldyError(`Connect ${recorder.name} first.`, 'disconnected');
  const since = stored.through ?? startOfToday(now);
  const session = await openSession(recorder, userId);
  const toolList = await tools(recorder, session);
  const listed = await listConversations(recorder, session, toolList, since, now.toISOString());
  const after = Date.parse(since);
  const fresh = listed
    .filter((item) => Date.parse(item.startTime) > after)
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime) || a.id.localeCompare(b.id));
  // A recording without a summary in the list: its summary (Plaud's note),
  // else, once it ended a while ago, its transcript. A few per review.
  const note = notePlan(toolList);
  const transcript = transcriptPlan(toolList);
  const texts: Record<string, string> = {};
  const read: FieldyConversation[] = [];
  let reads = 0;
  for (const item of fresh) {
    if (item.summary) { read.push(item); continue; }
    if (reads >= DETAIL_READS) break;
    reads += 1;
    try {
      if (note) {
        const text = noteText(toolPayload(await session.call('tools/call', { name: note.name, arguments: { [note.id]: item.id } })));
        if (text) texts[item.id] = text;
      }
      if (!texts[item.id] && transcript && now.getTime() - Date.parse(item.endTime || item.startTime) >= SUMMARY_WAIT_MS) {
        const text = transcriptText(toolPayload(await session.call('tools/call', { name: transcript.name, arguments: { [transcript.id]: item.id } })));
        if (text) texts[item.id] = text;
      }
    } catch {
      // Left out this time; it is read again next time.
    }
    read.push(item);
  }
  const plan = reviewPlan(read, since, now.getTime(), texts, recorder.name);
  return { ...plan, later: plan.later + (fresh.length - read.length), since, recorder };
}

/** The read was reviewed: the next one starts after it. */
export async function commitRecorderRead(recorder: Recorder, userId: string, through: string | null): Promise<void> {
  if (!through) return;
  const stored = await readStored(recorder, userId);
  if (!stored) return;
  if (stored.through && Date.parse(stored.through) >= Date.parse(through)) return;
  await writeStored(recorder, userId, { ...stored, through });
}

/**
 * How many new recordings are waiting, for the Today card and the evening
 * reminder: counted only, never reviewed (the review runs when the
 * practitioner opens it, on their own key). 0 when the recorder is not
 * connected or cannot be reached.
 */
export async function countNewRecordings(recorder: Recorder, userId: string, now = new Date()): Promise<number> {
  try {
    const stored = await readStored(recorder, userId);
    if (!stored) return 0;
    const since = stored.through ?? startOfToday(now);
    const session = await openSession(recorder, userId);
    const conversations = await listConversations(recorder, session, await tools(recorder, session), since, now.toISOString());
    const after = Date.parse(since);
    return new Set(conversations.filter((item) => Date.parse(item.startTime) > after).map((item) => item.id)).size;
  } catch {
    return 0;
  }
}

// ─── Fieldy, by name (as Phase 2 first shipped) ────────────────────────────

export const fieldyStatus = (userId: string) => recorderStatus(FIELDY, userId);
export const connectFieldy = (userId: string) => connectRecorder(FIELDY, userId);
export const disconnectFieldy = (userId: string) => disconnectRecorder(FIELDY, userId);
export const commitFieldyRead = (userId: string, through: string | null) => commitRecorderRead(FIELDY, userId, through);
