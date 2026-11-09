// Fieldy, connected (docs/DAY_REVIEW.md, Phase 2): signing in, keeping the
// connection, and reading new conversations, all on the phone. The rules
// are in src/lib/fieldy.ts.
//
// Safety properties:
//   * the practitioner signs in to their own Fieldy account in the system
//     browser sheet (ASWebAuthenticationSession); ReferralFit never sees the
//     Fieldy password;
//   * the refresh token is kept in this phone's keychain, for this account
//     only, never synced (THIS_DEVICE_ONLY keeps it out of iCloud Keychain
//     and backups), and never sent to ReferralFit's server;
//   * conversations are read straight from Fieldy to the phone, and go only
//     into the day review, which sends their text to Anthropic on the
//     practitioner's own key and saves nothing until they approve it;
//   * disconnecting revokes the token at Fieldy and forgets it here.

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
  FIELDY,
  FieldyError,
  formBody,
  listArguments,
  listPlan,
  MCP_PROTOCOL_VERSION,
  reviewPlan,
  rpcBody,
  rpcResult,
  startOfToday,
  toolPayload,
  toolsFrom,
  transcriptPlan,
  transcriptText,
  tokensFrom,
  type FieldyConversation,
  type McpTool,
  type ReviewPlan,
} from './fieldy';

export { FieldyError } from './fieldy';

export const fieldySupported = Platform.OS === 'ios' || Platform.OS === 'android';

type Stored = { refreshToken: string; email: string; through: string | null; connectedAt: string };

function storageKey(userId: string): string {
  return `referralfit.fieldy.v1.${userId.toLowerCase().replace(/[^a-z0-9._-]/g, '')}`;
}

async function readStored(userId: string): Promise<Stored | null> {
  if (!fieldySupported || !userId) return null;
  try {
    const raw = await SecureStore.getItemAsync(storageKey(userId));
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

async function writeStored(userId: string, value: Stored): Promise<void> {
  await SecureStore.setItemAsync(storageKey(userId), JSON.stringify(value), {
    // After the first unlock, so a later background read can work; never synced or backed up.
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
}

// The access token for this session only (an hour), never stored.
const access = new Map<string, { token: string; expiresAt: number }>();
// One refresh at a time per account: Fieldy rotates refresh tokens, so two
// at once would leave one of them holding a token that no longer works.
const refreshing = new Map<string, Promise<string>>();

export type FieldyStatus = { connected: boolean; email: string };

export async function fieldyStatus(userId: string): Promise<FieldyStatus> {
  const stored = await readStored(userId);
  return { connected: Boolean(stored), email: stored?.email ?? '' };
}

async function postForm(url: string, fields: Record<string, string>): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: formBody(fields),
    });
  } catch {
    throw new FieldyError('Fieldy could not be reached. Check your connection and try again.');
  }
  return response.json().catch(() => ({ error: `http_${response.status}` }));
}

async function emailFor(accessToken: string): Promise<string> {
  try {
    const response = await fetch(FIELDY.userinfoUrl, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } });
    const data = await response.json().catch(() => null) as { email?: unknown } | null;
    return typeof data?.email === 'string' ? data.email.slice(0, 254) : '';
  } catch {
    return '';
  }
}

/**
 * Connect Fieldy: the practitioner signs in to their Fieldy account in the
 * browser sheet and approves ReferralFit. Resolves with the account shown.
 */
export async function connectFieldy(userId: string): Promise<FieldyStatus> {
  if (!fieldySupported) throw new FieldyError('Connect Fieldy in the ReferralFit app on your iPhone.');
  if (!userId) throw new FieldyError('Sign in again, then connect Fieldy.');
  const verifier = base64Url(encode(Crypto.getRandomBytes(32).buffer as ArrayBuffer));
  const challenge = base64Url(await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, { encoding: Crypto.CryptoEncoding.BASE64 }));
  const state = base64Url(encode(Crypto.getRandomBytes(16).buffer as ArrayBuffer));
  const result = await WebBrowser.openAuthSessionAsync(authorizeUrl(challenge, state), FIELDY.redirectUri);
  if (result.type !== 'success') throw new FieldyError('Fieldy was not connected.', 'cancelled');
  const code = codeFromCallback(result.url, state);
  const tokens = tokensFrom(await postForm(FIELDY.tokenUrl, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: FIELDY.redirectUri,
    client_id: FIELDY.clientId,
    code_verifier: verifier,
    resource: FIELDY.mcpUrl,
  }));
  const email = await emailFor(tokens.accessToken);
  const previous = await readStored(userId);
  await writeStored(userId, { refreshToken: tokens.refreshToken, email, through: previous?.through ?? null, connectedAt: new Date().toISOString() });
  access.set(userId, { token: tokens.accessToken, expiresAt: tokens.expiresAt });
  return { connected: true, email };
}

/** Disconnect: the token is revoked at Fieldy (when it can be reached) and forgotten here. */
export async function disconnectFieldy(userId: string): Promise<void> {
  const stored = await readStored(userId);
  access.delete(userId);
  if (stored) {
    await postForm(FIELDY.revokeUrl, { token: stored.refreshToken, token_type_hint: 'refresh_token', client_id: FIELDY.clientId }).catch(() => undefined);
  }
  await SecureStore.deleteItemAsync(storageKey(userId)).catch(() => undefined);
}

async function accessToken(userId: string): Promise<string> {
  const current = access.get(userId);
  if (current && current.expiresAt > Date.now()) return current.token;
  const running = refreshing.get(userId);
  if (running) return running;
  const refresh = (async () => {
    const stored = await readStored(userId);
    if (!stored) throw new FieldyError('Connect Fieldy first.', 'disconnected');
    let tokens;
    try {
      tokens = tokensFrom(await postForm(FIELDY.tokenUrl, {
        grant_type: 'refresh_token',
        refresh_token: stored.refreshToken,
        client_id: FIELDY.clientId,
        resource: FIELDY.mcpUrl,
      }));
    } catch (error) {
      if (error instanceof FieldyError && error.reason === 'disconnected') {
        // Revoked at Fieldy, or too old: forget it, so the screen offers to connect again.
        await SecureStore.deleteItemAsync(storageKey(userId)).catch(() => undefined);
      }
      throw error;
    }
    // The new refresh token replaces the old one at once (the old one no longer works).
    await writeStored(userId, { ...stored, refreshToken: tokens.refreshToken });
    access.set(userId, { token: tokens.accessToken, expiresAt: tokens.expiresAt });
    return tokens.accessToken;
  })();
  refreshing.set(userId, refresh);
  try {
    return await refresh;
  } finally {
    refreshing.delete(userId);
  }
}

// ─── Fieldy's MCP server ───────────────────────────────────────────────────

type Session = { call: (method: string, params?: Record<string, unknown>) => Promise<unknown> };

async function openSession(userId: string): Promise<Session> {
  const token = await accessToken(userId);
  let sessionId = '';
  let next = 1;
  const post = async (body: string): Promise<Response> => {
    try {
      return await fetch(FIELDY.mcpUrl, {
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
      throw new FieldyError('Fieldy could not be reached. Check your connection and try again.');
    }
  };
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const id = next;
    next += 1;
    const response = await post(rpcBody(id, method, params));
    if (response.status === 401) {
      access.delete(userId);
      throw new FieldyError('Your Fieldy connection needs a moment. Try again.');
    }
    if (!response.ok) throw new FieldyError('Fieldy could not read your conversations right now. Try again.');
    const header = response.headers.get('mcp-session-id');
    if (header) sessionId = header;
    return rpcResult(await response.text(), response.headers.get('content-type') || '', id);
  };
  await call('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'ReferralFit', version: '1' } });
  // A notification has no answer to wait for.
  await post(rpcBody(null, 'notifications/initialized')).catch(() => undefined);
  return { call };
}

let toolNamesLogged = false;

async function tools(session: Session): Promise<McpTool[]> {
  const list = toolsFrom(await session.call('tools/list'));
  if (__DEV__ && !toolNamesLogged) {
    // Tool names and their argument names only, never anyone's data: to check the plan against Fieldy's tools.
    toolNamesLogged = true;
    console.log('Fieldy MCP tools', list.map((tool) => `${tool.name}(${Object.keys(tool.inputSchema?.properties || {}).join(', ')})`).join(' | '));
  }
  return list;
}

async function listConversations(session: Session, toolList: McpTool[], since: string, until: string): Promise<FieldyConversation[]> {
  const plan = listPlan(toolList);
  if (!plan) throw new FieldyError('Fieldy did not offer a way to list conversations. Paste the summary instead.');
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

export type FieldyRead = ReviewPlan & { since: string };

/**
 * The conversations since the last read (the first time, since the start of
 * today), ready for the day review. Nothing moves on until commitFieldyRead:
 * conversations read but not reviewed are read again next time.
 */
export async function readNewFieldyConversations(userId: string, now = new Date()): Promise<FieldyRead> {
  const stored = await readStored(userId);
  if (!stored) throw new FieldyError('Connect Fieldy first.', 'disconnected');
  const since = stored.through ?? startOfToday(now);
  const session = await openSession(userId);
  const toolList = await tools(session);
  const conversations = await listConversations(session, toolList, since, now.toISOString());
  // A conversation Fieldy has not summarized but that ended a while ago: its transcript instead (a few at most).
  const transcripts: Record<string, string> = {};
  const transcript = transcriptPlan(toolList);
  if (transcript) {
    const unsummarized = conversations
      .filter((item) => !item.summary && Date.parse(item.startTime) > Date.parse(since) && now.getTime() - Date.parse(item.endTime || item.startTime) >= 90 * 60 * 1000)
      .slice(0, 3);
    for (const item of unsummarized) {
      try {
        const text = transcriptText(toolPayload(await session.call('tools/call', { name: transcript.name, arguments: { [transcript.id]: item.id } })));
        if (text) transcripts[item.id] = text;
      } catch {
        // Left out this time; the summary may be there next time.
      }
    }
  }
  return { ...reviewPlan(conversations, since, now.getTime(), transcripts), since };
}

/** The read was reviewed: the next one starts after it. */
export async function commitFieldyRead(userId: string, through: string | null): Promise<void> {
  if (!through) return;
  const stored = await readStored(userId);
  if (!stored) return;
  if (stored.through && Date.parse(stored.through) >= Date.parse(through)) return;
  await writeStored(userId, { ...stored, through });
}

/**
 * How many new conversations are waiting, for the Today card and the evening
 * reminder: counted only, never reviewed (the review runs when the
 * practitioner opens it, on their own key). 0 when Fieldy is not connected
 * or cannot be reached.
 */
export async function countNewFieldyConversations(userId: string, now = new Date()): Promise<number> {
  try {
    const stored = await readStored(userId);
    if (!stored) return 0;
    const since = stored.through ?? startOfToday(now);
    const session = await openSession(userId);
    const conversations = await listConversations(session, await tools(session), since, now.toISOString());
    const after = Date.parse(since);
    return new Set(conversations.filter((item) => Date.parse(item.startTime) > after).map((item) => item.id)).size;
  } catch {
    return 0;
  }
}
