// Fieldy, connected (docs/DAY_REVIEW.md, Phase 2): the pure rules. The
// practitioner signs in to their own Fieldy account once (OAuth with PKCE,
// as Fieldy's guide for apps used by other people says); ReferralFit then
// reads their new conversations through Fieldy's MCP server and puts them
// into the day review, where nothing is saved until they approve it.
//
// ReferralFit registered itself with Fieldy once (dynamic client
// registration, 2026-11-08) as a native app with no secret: the client id
// below is public. The sign-in, the tokens and the conversations stay on
// the phone (src/lib/fieldy-api.ts); ReferralFit's server never sees them.
//
// No React, no network: scripts/fieldy-test.mjs covers this file.

export const FIELDY = {
  clientId: 'RdoydnooybKJJtqRukAYFyhwkWhrXBwK',
  redirectUri: 'com.mattbrown.referralfit:/oauth/fieldy',
  issuer: 'https://api.fieldy.ai/api/auth',
  authorizeUrl: 'https://api.fieldy.ai/api/auth/oauth2/authorize',
  tokenUrl: 'https://api.fieldy.ai/api/auth/oauth2/token',
  revokeUrl: 'https://api.fieldy.ai/api/auth/oauth2/revoke',
  userinfoUrl: 'https://api.fieldy.ai/api/auth/oauth2/userinfo',
  mcpUrl: 'https://api.fieldy.ai/mcp',
  // Only what the day review needs: who it is (to show which account), a
  // refresh token (so it keeps working), and reading conversations.
  scope: 'openid email offline_access conversations:read transcripts:read',
} as const;

export class FieldyError extends Error {
  constructor(message: string, readonly reason: 'cancelled' | 'disconnected' | 'unavailable' | 'denied' = 'unavailable') {
    super(message);
  }
}

// ─── Signing in ────────────────────────────────────────────────────────────

/** Standard base64 as base64url, without padding (PKCE, RFC 7636). */
export function base64Url(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Fieldy's sign-in page for this app, with the PKCE challenge and a state to check on the way back. */
export function authorizeUrl(challenge: string, state: string): string {
  const params: [string, string][] = [
    ['response_type', 'code'],
    ['client_id', FIELDY.clientId],
    ['redirect_uri', FIELDY.redirectUri],
    ['scope', FIELDY.scope],
    ['state', state],
    ['code_challenge', challenge],
    ['code_challenge_method', 'S256'],
    ['resource', FIELDY.mcpUrl],
    // Ask Fieldy to show the consent screen, so the practitioner sees what is shared.
    ['prompt', 'consent'],
  ];
  return `${FIELDY.authorizeUrl}?${params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`;
}

function queryOf(url: string): Record<string, string> {
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1).split('#')[0] : '';
  const out: Record<string, string> = {};
  for (const part of query.split('&')) {
    if (!part) continue;
    const at = part.indexOf('=');
    const key = decodeURIComponent((at < 0 ? part : part.slice(0, at)).replace(/\+/g, ' '));
    out[key] = decodeURIComponent((at < 0 ? '' : part.slice(at + 1)).replace(/\+/g, ' '));
  }
  return out;
}

/**
 * The code from Fieldy's return to the app, checked: the same state this
 * sign-in sent, and (when Fieldy names it) Fieldy as the issuer.
 */
export function codeFromCallback(url: string, state: string): string {
  if (!url.startsWith(FIELDY.redirectUri)) throw new FieldyError('Fieldy sent you back to the wrong place. Try connecting again.');
  const query = queryOf(url);
  if (query.error) {
    throw query.error === 'access_denied'
      ? new FieldyError('Fieldy was not connected: the request was declined.', 'denied')
      : new FieldyError('Fieldy could not connect right now. Try again.');
  }
  if (!state || query.state !== state) throw new FieldyError('That sign-in did not match. Try connecting again.');
  if (query.iss && query.iss !== FIELDY.issuer) throw new FieldyError('That sign-in did not come from Fieldy. Try connecting again.');
  if (!query.code) throw new FieldyError('Fieldy did not finish the sign-in. Try again.');
  return query.code;
}

export type FieldyTokens = { accessToken: string; refreshToken: string; expiresAt: number };

/** Fieldy's token answer, read defensively. A refresh token is required: without one the connection would stop in an hour. */
export function tokensFrom(json: unknown, now = Date.now()): FieldyTokens {
  const data = json && typeof json === 'object' ? json as Record<string, unknown> : {};
  if (typeof data.error === 'string') {
    throw data.error === 'invalid_grant'
      ? new FieldyError('Your Fieldy connection ended. Connect Fieldy again.', 'disconnected')
      : new FieldyError('Fieldy could not connect right now. Try again.');
  }
  const accessToken = typeof data.access_token === 'string' ? data.access_token : '';
  const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : '';
  if (!accessToken || !refreshToken) throw new FieldyError('Fieldy did not give ReferralFit lasting access. Try connecting again.');
  const seconds = Number(data.expires_in);
  // A minute early, so a call never starts with a token about to end.
  const expiresAt = now + (Number.isFinite(seconds) && seconds > 120 ? seconds : 3600) * 1000 - 60_000;
  return { accessToken, refreshToken, expiresAt };
}

/** application/x-www-form-urlencoded. */
export function formBody(fields: Record<string, string>): string {
  return Object.entries(fields).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
}

// ─── MCP (JSON-RPC over HTTP) ──────────────────────────────────────────────

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export function rpcBody(id: number | null, method: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify(id === null ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params });
}

/**
 * The result of JSON-RPC message `id` from an MCP answer: plain JSON, or a
 * server-sent event stream whose data lines carry the messages.
 */
export function rpcResult(text: string, contentType: string, id: number): unknown {
  const messages: unknown[] = [];
  if (/text\/event-stream/i.test(contentType)) {
    let data: string[] = [];
    const flushEvent = () => {
      if (!data.length) return;
      try { messages.push(JSON.parse(data.join('\n'))); } catch { /* not a message */ }
      data = [];
    };
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      else if (!line.trim()) flushEvent();
    }
    flushEvent();
  } else {
    try {
      const parsed = JSON.parse(text);
      messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      throw new FieldyError('Fieldy sent an answer ReferralFit could not read.');
    }
  }
  const message = messages.find((item) => item && typeof item === 'object' && (item as { id?: unknown }).id === id) as
    { result?: unknown; error?: { message?: unknown } } | undefined;
  if (!message) throw new FieldyError('Fieldy sent an answer ReferralFit could not read.');
  if (message.error) throw new FieldyError('Fieldy could not read your conversations right now. Try again.');
  return message.result;
}

export type McpTool = { name: string; description?: string; inputSchema?: { properties?: Record<string, unknown>; required?: string[] } };

export function toolsFrom(result: unknown): McpTool[] {
  const list = result && typeof result === 'object' ? (result as { tools?: unknown }).tools : null;
  return Array.isArray(list)
    ? list.filter((tool): tool is McpTool => Boolean(tool) && typeof (tool as McpTool).name === 'string')
    : [];
}

const START_KEYS = ['startTime', 'start_time', 'startDate', 'start_date', 'from', 'since', 'after', 'start', 'dateFrom', 'date_from'];
const END_KEYS = ['endTime', 'end_time', 'endDate', 'end_date', 'to', 'until', 'before', 'end', 'dateTo', 'date_to'];
const SIZE_KEYS = ['pageSize', 'page_size', 'limit', 'maxResults', 'max_results', 'count'];
const CURSOR_KEYS = ['cursor', 'pageToken', 'page_token', 'nextCursor'];
const ID_KEYS = ['conversationId', 'conversation_id', 'id'];

function keyIn(properties: Record<string, unknown>, keys: string[]): string | null {
  return keys.find((key) => Object.prototype.hasOwnProperty.call(properties, key)) ?? null;
}

export type ListPlan = { name: string; start: string | null; end: string | null; size: string | null; cursor: string | null };

/**
 * The tool that lists conversations in a time window. Fieldy's MCP tools
 * mirror its Public API (GET /conversations?startTime&endTime&pageSize&
 * cursor); the names are read from tools/list, not assumed.
 */
export function listPlan(tools: McpTool[]): ListPlan | null {
  const scored = tools
    .map((tool) => {
      const name = tool.name.toLowerCase();
      const properties = tool.inputSchema?.properties || {};
      const required = (tool.inputSchema?.required || []).filter((key) => ![...START_KEYS, ...END_KEYS, ...SIZE_KEYS, ...CURSOR_KEYS].includes(key));
      if (!/conversation/.test(name) || /transcript|share|sharable|update|delete|create|patch/.test(name) || required.length) return null;
      const start = keyIn(properties, START_KEYS);
      const end = keyIn(properties, END_KEYS);
      const score = (/list|recent|get_conversations|conversations$/.test(name) ? 4 : 0) + (start ? 2 : 0) + (end ? 1 : 0) - (/search/.test(name) ? 1 : 0)
        - (/(^|_)get_conversation$|by_id/.test(name) ? 5 : 0);
      return { score, plan: { name: tool.name, start, end, size: keyIn(properties, SIZE_KEYS), cursor: keyIn(properties, CURSOR_KEYS) } };
    })
    .filter((item): item is { score: number; plan: ListPlan } => Boolean(item) && item!.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.plan ?? null;
}

export function listArguments(plan: ListPlan, since: string, until: string, cursor: string | null): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (plan.start) args[plan.start] = since;
  if (plan.end) args[plan.end] = until;
  if (plan.size) args[plan.size] = 50;
  if (plan.cursor && cursor) args[plan.cursor] = cursor;
  return args;
}

export type TranscriptPlan = { name: string; id: string };

/** The tool that reads one conversation's transcript, for a conversation Fieldy has not summarized. */
export function transcriptPlan(tools: McpTool[]): TranscriptPlan | null {
  for (const tool of tools) {
    if (!/transcript/i.test(tool.name)) continue;
    const id = keyIn(tool.inputSchema?.properties || {}, ID_KEYS);
    if (id) return { name: tool.name, id };
  }
  return null;
}

/** What a tool call returned: its structured content, else the JSON in its text, else the text itself. */
export function toolPayload(result: unknown): unknown {
  const data = result && typeof result === 'object' ? result as { structuredContent?: unknown; content?: unknown; isError?: unknown } : {};
  if (data.isError === true) throw new FieldyError('Fieldy could not read your conversations right now. Try again.');
  if (data.structuredContent !== undefined && data.structuredContent !== null) return data.structuredContent;
  const parts = Array.isArray(data.content) ? data.content : [];
  const text = parts
    .map((part) => (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' ? String((part as { text?: unknown }).text ?? '') : ''))
    .join('\n')
    .trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { text }; }
}

export type FieldyConversation = { id: string; title: string; summary: string; startTime: string; endTime: string };

function str(value: unknown, max = 20_000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function summaryOf(item: Record<string, unknown>): string {
  for (const key of ['summary', 'shortSummary', 'short_summary', 'overview', 'description']) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    // A summary that is a list of sections or points.
    if (Array.isArray(value)) {
      const joined = value.map((part) => (typeof part === 'string' ? part : part && typeof part === 'object'
        ? [str((part as Record<string, unknown>).title), str((part as Record<string, unknown>).text ?? (part as Record<string, unknown>).content)].filter(Boolean).join(': ')
        : '')).filter(Boolean).join('\n');
      if (joined.trim()) return joined.trim();
    }
  }
  return '';
}

/** The conversations in a list answer, wherever the list is (an array, or under conversations, items or data). */
export function conversationsFrom(payload: unknown): { conversations: FieldyConversation[]; nextCursor: string | null; text: string } {
  const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const list = Array.isArray(payload) ? payload
    : [data.conversations, data.items, data.data, data.results].find(Array.isArray) as unknown[] | undefined;
  const conversations = (list || [])
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      id: str(item.id ?? item.conversationId ?? item.conversation_id, 200),
      title: str(item.title, 300),
      summary: summaryOf(item),
      startTime: str(item.startTime ?? item.start_time ?? item.createdAt ?? item.created_at, 40),
      endTime: str(item.endTime ?? item.end_time ?? item.startTime ?? item.start_time, 40),
    }))
    .filter((item) => item.id && !Number.isNaN(Date.parse(item.startTime)));
  const cursor = [data.nextCursor, data.next_cursor, data.cursor, (data.pagination as Record<string, unknown> | undefined)?.nextCursor]
    .find((value) => typeof value === 'string' && value) as string | undefined;
  return { conversations, nextCursor: cursor ?? null, text: typeof data.text === 'string' && !list ? data.text : '' };
}

/** A transcript answer as text: its segments' "Speaker: words", or its text. */
export function transcriptText(payload: unknown): string {
  const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const list = Array.isArray(payload) ? payload
    : [data.transcripts, data.transcriptions, data.segments, data.items, data.data].find(Array.isArray) as unknown[] | undefined;
  if (list) {
    return list
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => [str(item.speaker, 60), str(item.text, 4000)].filter(Boolean).join(': '))
      .filter(Boolean)
      .join('\n');
  }
  return str(data.text);
}

// ─── Into the day review ───────────────────────────────────────────────────

/** "Nov 9, 2:15 PM" in the phone's time. */
export function shortTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export type FieldyBlock = { id: string; label: string; text: string };

// The day review reads at most 12,000 characters (LIMITS.textMax in
// supabase/functions/day-review/review.ts); a conversation that does not fit
// waits for the next read.
const REVIEW_MAX = 11_500;
const SUMMARY_MAX = 2_500;
// Fieldy writes the summary after a conversation ends; one that ended this
// recently without one is left for the next read, not read half done.
const SUMMARY_WAIT_MS = 90 * 60 * 1000;

export type ReviewPlan = {
  text: string;
  blocks: FieldyBlock[];
  /** Read up to here: the next read starts after it. Null when nothing was read. */
  through: string | null;
  /** Conversations left for the next read (no room, or no summary yet). */
  later: number;
};

/**
 * The conversations since `since` as review text, oldest first: each
 * under its own header ("[Fieldy · Nov 9, 2:15 PM · Call with Sarah]"), so
 * an item found in it can say where it came from. `transcripts` holds the
 * text for conversations without a summary.
 */
export function reviewPlan(conversations: FieldyConversation[], since: string, now = Date.now(), transcripts: Record<string, string> = {}): ReviewPlan {
  const after = Date.parse(since);
  const fresh = conversations
    .filter((item) => Date.parse(item.startTime) > after)
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime) || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  const blocks: FieldyBlock[] = [];
  let length = 0;
  let through: string | null = null;
  let later = 0;
  for (let index = 0; index < fresh.length; index += 1) {
    const item = fresh[index];
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const body = (item.summary || transcripts[item.id] || '').slice(0, SUMMARY_MAX).trim();
    const ended = Date.parse(item.endTime || item.startTime);
    if (!body && now - ended < SUMMARY_WAIT_MS) {
      // Not summarized yet: stop here, so the next read starts with it.
      later = fresh.length - index;
      break;
    }
    if (!body) { through = item.startTime; continue; }
    const label = `From Fieldy, ${shortTime(item.startTime)}${item.title ? ` · ${item.title.slice(0, 80)}` : ''}`;
    const text = `[${label}]\n${body}`;
    if (blocks.length && length + text.length + 2 > REVIEW_MAX) {
      later = fresh.length - index;
      break;
    }
    blocks.push({ id: item.id, label, text: text.slice(0, REVIEW_MAX) });
    length += text.length + 2;
    through = item.startTime;
  }
  return { text: blocks.map((block) => block.text).join('\n\n').slice(0, 12_000), blocks, through, later };
}

const loose = (value: string) => value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Which conversation a found item's quote came from: its label, or '' when it is not found in one. */
export function sourceFor(quote: string, blocks: FieldyBlock[]): string {
  const words = loose(quote);
  if (!words) return '';
  return blocks.find((block) => loose(block.text).includes(words))?.label ?? '';
}

/** Where a Fieldy read starts the first time: the start of today, on the phone's clock. */
export function startOfToday(now = new Date()): string {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}
