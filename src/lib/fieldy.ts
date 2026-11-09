// Recorders, connected (docs/DAY_REVIEW.md, Phase 2): the pure rules, for
// Fieldy and Plaud alike. The practitioner signs in to their own recorder
// account once (OAuth with PKCE, through the recorder's MCP server);
// ReferralFit then reads their new recordings and puts them into the day
// review, where nothing is saved until they approve it.
//
// ReferralFit registered itself once with each (dynamic client
// registration, 2026-11-08) as a native app with no secret: the client ids
// below are public. The sign-in and its tokens stay on the phone
// (src/lib/fieldy-api.ts). A recording's text goes only into the day
// review: through ReferralFit's day-review function, which neither stores
// nor logs it, to Anthropic on the practitioner's own key.
//
// No React, no network: scripts/fieldy-test.mjs covers this file.

export type RecorderId = 'fieldy' | 'plaud';

export type Recorder = {
  id: RecorderId;
  name: string;
  /** What one recording is called in the app ("conversation", "recording"). */
  noun: string;
  clientId: string;
  redirectUri: string;
  issuer: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** null: the recorder revokes through its MCP server's logout tool. */
  revokeUrl: string | null;
  /** null: the account is read through its MCP server's current-user tool. */
  userinfoUrl: string | null;
  mcpUrl: string;
  /** null: the recorder names no scopes; its MCP access is the whole grant. */
  scope: string | null;
  /** Ask the recorder to show its consent screen. */
  promptConsent: boolean;
};

export const FIELDY: Recorder = {
  id: 'fieldy',
  name: 'Fieldy',
  noun: 'conversation',
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
  promptConsent: true,
};

// Plaud's MCP server (mcp.plaud.ai, docs.plaud.ai/plaud-mcp-cli/mcp):
// list_files, get_note (the AI summary), get_transcript, get_current_user,
// logout. It names no scopes and has no revocation endpoint.
export const PLAUD: Recorder = {
  id: 'plaud',
  name: 'Plaud',
  noun: 'recording',
  clientId: 'eyJ2IjoyLCJuIjoiUmVmZXJyYWxGaXQiLCJoIjpbXSwiciI6IkQ2eGVJRjRxT3lBIn0.dJufrVA4MeLnBeCnK8G3QA',
  redirectUri: 'com.mattbrown.referralfit:/oauth/plaud',
  issuer: 'https://mcp.plaud.ai/',
  authorizeUrl: 'https://mcp.plaud.ai/authorize',
  tokenUrl: 'https://mcp.plaud.ai/token',
  revokeUrl: null,
  userinfoUrl: null,
  mcpUrl: 'https://mcp.plaud.ai/mcp',
  scope: null,
  promptConsent: false,
};

export const RECORDERS: Recorder[] = [FIELDY, PLAUD];

export class FieldyError extends Error {
  /** 'tool': the recorder answered with an error about the request itself (a recording it has no note for, say), not a lost connection. */
  constructor(message: string, readonly reason: 'cancelled' | 'disconnected' | 'unavailable' | 'denied' | 'tool' = 'unavailable') {
    super(message);
  }
}

// ─── Signing in ────────────────────────────────────────────────────────────

/** Standard base64 as base64url, without padding (PKCE, RFC 7636). */
export function base64Url(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The recorder's sign-in page for this app, with the PKCE challenge and a state to check on the way back. */
export function authorizeUrl(challenge: string, state: string, recorder: Recorder = FIELDY): string {
  const params: [string, string][] = [
    ['response_type', 'code'],
    ['client_id', recorder.clientId],
    ['redirect_uri', recorder.redirectUri],
    ...(recorder.scope ? [['scope', recorder.scope] as [string, string]] : []),
    ['state', state],
    ['code_challenge', challenge],
    ['code_challenge_method', 'S256'],
    ['resource', recorder.mcpUrl],
    // Show the consent screen, so the practitioner sees what is shared.
    ...(recorder.promptConsent ? [['prompt', 'consent'] as [string, string]] : []),
  ];
  return `${recorder.authorizeUrl}?${params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`;
}

function queryOf(url: string): Record<string, string> {
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1).split('#')[0] : '';
  const out: Record<string, string> = {};
  for (const part of query.split('&')) {
    if (!part) continue;
    const at = part.indexOf('=');
    const decode = (value: string) => {
      try { return decodeURIComponent(value.replace(/\+/g, ' ')); } catch { return value; }
    };
    out[decode(at < 0 ? part : part.slice(0, at))] = decode(at < 0 ? '' : part.slice(at + 1));
  }
  return out;
}

/**
 * The code from Fieldy's return to the app, checked: the same state this
 * sign-in sent, and (when Fieldy names it) Fieldy as the issuer.
 */
export function codeFromCallback(url: string, state: string, recorder: Recorder = FIELDY): string {
  const name = recorder.name;
  if (!url.startsWith(recorder.redirectUri)) throw new FieldyError(`${name} sent you back to the wrong place. Try connecting again.`);
  const query = queryOf(url);
  if (query.error) {
    throw query.error === 'access_denied'
      ? new FieldyError(`${name} was not connected: the request was declined.`, 'denied')
      : new FieldyError(`${name} could not connect right now. Try again.`);
  }
  if (!state || query.state !== state) throw new FieldyError('That sign-in did not match. Try connecting again.');
  if (query.iss && query.iss !== recorder.issuer) throw new FieldyError(`That sign-in did not come from ${name}. Try connecting again.`);
  if (!query.code) throw new FieldyError(`${name} did not finish the sign-in. Try again.`);
  return query.code;
}

export type FieldyTokens = { accessToken: string; refreshToken: string; expiresAt: number };

/**
 * A token answer, read defensively. A refresh token is required (without
 * one the connection would stop in an hour), except on a refresh, where a
 * server that does not rotate them sends none and `keep` stays in use.
 */
export function tokensFrom(json: unknown, now = Date.now(), name = 'Fieldy', keep = ''): FieldyTokens {
  const data = json && typeof json === 'object' ? json as Record<string, unknown> : {};
  if (typeof data.error === 'string') {
    throw data.error === 'invalid_grant'
      ? new FieldyError(`Your ${name} connection ended. Connect ${name} again.`, 'disconnected')
      : new FieldyError(`${name} could not connect right now. Try again.`);
  }
  const accessToken = typeof data.access_token === 'string' ? data.access_token : '';
  const refreshToken = typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : keep;
  if (!accessToken || !refreshToken) throw new FieldyError(`${name} did not give ReferralFit lasting access. Try connecting again.`);
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
function messagesIn(text: string, contentType: string): unknown[] | null {
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
    return messages;
  }
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return null;
  }
}

// A response (result or error), never a request from the server that happens to use the same id.
function answerTo(messages: unknown[], id: number): { result?: unknown; error?: unknown } | undefined {
  return messages.find((item) => item && typeof item === 'object' && (item as { id?: unknown }).id === id
    && ('result' in (item as object) || 'error' in (item as object))) as { result?: unknown; error?: unknown } | undefined;
}

/** An event stream read so far already holds the answer to `id` (the rest need not be waited for). */
export function hasAnswer(text: string, id: number): boolean {
  // Only whole events: an event ends with a blank line.
  const end = Math.max(text.lastIndexOf('\n\n'), text.lastIndexOf('\r\n\r\n'));
  if (end < 0) return false;
  return Boolean(answerTo(messagesIn(text.slice(0, end + 2), 'text/event-stream') ?? [], id));
}

/** The result of JSON-RPC request `id`, from a JSON or event-stream answer. */
export function rpcResult(text: string, contentType: string, id: number, recorder: Pick<Recorder, 'name' | 'noun'> = FIELDY): unknown {
  const unreadable = () => new FieldyError(`${recorder.name} sent an answer ReferralFit could not read.`);
  const messages = messagesIn(text, contentType);
  if (!messages) throw unreadable();
  const message = answerTo(messages, id);
  if (!message) throw unreadable();
  if (message.error) throw new FieldyError(`${recorder.name} could not read your ${recorder.noun}s right now. Try again.`, 'tool');
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
const PAGE_KEYS = ['page', 'pageNumber', 'page_number'];
const ID_KEYS = ['conversationId', 'conversation_id', 'fileId', 'file_id', 'recordingId', 'recording_id', 'id'];

function keyIn(properties: Record<string, unknown>, keys: string[]): string | null {
  return keys.find((key) => Object.prototype.hasOwnProperty.call(properties, key)) ?? null;
}

export type ListPlan = { name: string; start: string | null; end: string | null; size: string | null; cursor: string | null; page: string | null };

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
      const required = (tool.inputSchema?.required || []).filter((key) => ![...START_KEYS, ...END_KEYS, ...SIZE_KEYS, ...CURSOR_KEYS, ...PAGE_KEYS].includes(key));
      if (!/conversation|file|recording/.test(name) || /transcript|share|sharable|update|delete|create|patch|note|upload|login|logout/.test(name)
        || required.length) return null;
      const start = keyIn(properties, START_KEYS);
      const end = keyIn(properties, END_KEYS);
      const score = (/list|recent|get_conversations|conversations$|files$|recordings$/.test(name) ? 4 : 0) + (start ? 2 : 0) + (end ? 1 : 0)
        - (/search/.test(name) ? 1 : 0) - (/(^|_)get_(conversation|file|recording)$|by_id/.test(name) ? 5 : 0);
      const cursor = keyIn(properties, CURSOR_KEYS);
      return { score, plan: { name: tool.name, start, end, size: keyIn(properties, SIZE_KEYS), cursor, page: cursor ? null : keyIn(properties, PAGE_KEYS) } };
    })
    .filter((item): item is { score: number; plan: ListPlan } => Boolean(item) && item!.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.plan ?? null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The list call's arguments. A window by date only (Plaud's date_from and
 * date_to, YYYY-MM-DD) is widened by a day each way: which day a time falls
 * on depends on the time zone, and anything before `since` is left out
 * afterwards (reviewPlan).
 */
export const LIST_PAGE_SIZE = 50;

export function listArguments(plan: ListPlan, since: string, until: string, cursor: string | null, page = 1): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const day = (iso: string, shift: number) => new Date(Date.parse(iso) + shift * DAY_MS).toISOString().slice(0, 10);
  if (plan.start) args[plan.start] = /date/i.test(plan.start) ? day(since, -1) : since;
  if (plan.end) args[plan.end] = /date/i.test(plan.end) ? day(until, 1) : until;
  if (plan.size) args[plan.size] = LIST_PAGE_SIZE;
  if (plan.cursor && cursor) args[plan.cursor] = cursor;
  if (plan.page) args[plan.page] = page;
  return args;
}

export type TranscriptPlan = { name: string; id: string; start?: string | null; end?: string | null };

// A tool for one recording: its id argument, and its time window when it
// asks for one (a transcript read by time). One that requires anything else
// is not used: it could return another recording's words.
function toolWithId(tools: McpTool[], pattern: RegExp): TranscriptPlan | null {
  for (const tool of tools) {
    if (!pattern.test(tool.name)) continue;
    const properties = tool.inputSchema?.properties || {};
    const id = keyIn(properties, ID_KEYS);
    if (!id) continue;
    const start = keyIn(properties, START_KEYS);
    const end = keyIn(properties, END_KEYS);
    const known = new Set([id, start, end].filter(Boolean) as string[]);
    if ((tool.inputSchema?.required || []).some((key) => !known.has(key))) continue;
    return start || end ? { name: tool.name, id, start, end } : { name: tool.name, id };
  }
  return null;
}

/** The arguments for one recording's tool call. */
export function recordingArguments(plan: TranscriptPlan, item: FieldyConversation, now = Date.now()): Record<string, unknown> {
  const args: Record<string, unknown> = { [plan.id]: item.id };
  if (plan.start) args[plan.start] = item.startTime;
  if (plan.end) args[plan.end] = item.endTime || new Date(now).toISOString();
  return args;
}

/** The tool that reads one recording's transcript, for one the recorder has not summarized. */
export function transcriptPlan(tools: McpTool[]): TranscriptPlan | null {
  return toolWithId(tools, /transcript/i);
}

/** The tool that reads one recording's AI summary, when the list gives none (Plaud's get_note). */
export function notePlan(tools: McpTool[]): TranscriptPlan | null {
  return toolWithId(tools, /(^|_)(get_)?(note|notes|summary)$/i);
}

/** The tool that names the signed-in account (Plaud's get_current_user). */
export function userPlan(tools: McpTool[]): string | null {
  return tools.find((tool) => /current_user|whoami|get_user|^me$|user_info/i.test(tool.name) && !(tool.inputSchema?.required || []).length)?.name ?? null;
}

/** The tool that signs out and revokes this app's access (Plaud's logout). */
export function logoutPlan(tools: McpTool[]): string | null {
  return tools.find((tool) => /^(logout|sign_out|revoke)$/i.test(tool.name))?.name ?? null;
}

/** An account's email from a current-user answer, or ''. */
export function emailFrom(payload: unknown): string {
  const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const inner = data.user && typeof data.user === 'object' ? data.user as Record<string, unknown> : data;
  const value = [inner.email, data.email, inner.mail].find((item) => typeof item === 'string' && /@/.test(item)) as string | undefined;
  return (value || '').slice(0, 254);
}

/** A note answer as text: the summary, action items and key topics, however they come. */
export function noteText(payload: unknown, depth = 0): string {
  if (typeof payload === 'string') return payload.trim();
  if (depth > 3 || !payload || typeof payload !== 'object') return '';
  if (Array.isArray(payload)) return payload.map((item) => noteText(item, depth + 1)).filter(Boolean).join('\n');
  const data = payload as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['summary', 'content', 'markdown', 'text', 'note', 'notes', 'note_list', 'noteList', 'action_items', 'actionItems', 'key_topics', 'keyTopics']) {
    if (data[key] === undefined) continue;
    const text = noteText(data[key], depth + 1);
    if (text) parts.push(/action/i.test(key) ? `Action items:\n${text}` : /topic/i.test(key) ? `Key topics: ${text}` : text);
  }
  // A title alone is not a note (the recording's transcript is read instead).
  if (!parts.length) return '';
  const title = typeof data.title === 'string' ? data.title.trim() : '';
  return [title, ...parts].filter(Boolean).join('\n').trim();
}

/** What a tool call returned: its structured content, else the JSON in its text, else the text itself. */
export function toolPayload(result: unknown, recorder: Pick<Recorder, 'name' | 'noun'> = FIELDY): unknown {
  const data = result && typeof result === 'object' ? result as { structuredContent?: unknown; content?: unknown; isError?: unknown } : {};
  if (data.isError === true) throw new FieldyError(`${recorder.name} could not read your ${recorder.noun}s right now. Try again.`, 'tool');
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

// A time as ISO 8601: a string ("2026-11-09 14:15:00" read as "2026-11-09T14:15:00"),
// or seconds or milliseconds since 1970. '' when it is neither.
function timeOf(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const at = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isNaN(at.getTime()) ? '' : at.toISOString();
  }
  const text = str(value, 40).replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2');
  if (/^\d{9,13}$/.test(text)) return timeOf(Number(text));
  return text && !Number.isNaN(Date.parse(text)) ? text : '';
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

// When a recording ended: its end time, or its start plus its length
// (Plaud's duration is in milliseconds, Fieldy's durationSeconds in seconds).
// '' when the recording gives neither: it may still be going on.
function endOf(item: Record<string, unknown>, start: string): string {
  const end = timeOf(item.endTime ?? item.end_time ?? item.endAt ?? item.end_at);
  if (end) return end;
  const at = Date.parse(start);
  if (Number.isNaN(at)) return '';
  const seconds = Number(item.durationSeconds ?? item.duration_seconds);
  const millis = Number(item.duration);
  const length = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Number.isFinite(millis) && millis > 0 ? millis : 0;
  return length ? new Date(at + length).toISOString() : '';
}

/**
 * The recordings in a list answer, wherever the list is (an array, or under
 * conversations, files, items or data). `text`: the answer was words, not a
 * list (the caller says it could not be read, never "nothing new").
 */
export function conversationsFrom(payload: unknown): { conversations: FieldyConversation[]; nextCursor: string | null; text: string; unreadable: boolean } {
  const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const list = Array.isArray(payload) ? payload
    : [data.conversations, data.files, data.recordings, data.items, data.data, data.results].find(Array.isArray) as unknown[] | undefined;
  const entries = (list || []).filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
  const conversations = entries
    .map((item) => {
      const startTime = timeOf(item.startTime ?? item.start_time ?? item.startAt ?? item.start_at ?? item.createdAt ?? item.created_at);
      return {
        id: str(item.id ?? item.conversationId ?? item.conversation_id ?? item.file_id ?? item.fileId, 200),
        title: str(item.title ?? item.name, 300),
        summary: summaryOf(item),
        startTime,
        endTime: endOf(item, startTime),
      };
    })
    .filter((item) => item.id && !Number.isNaN(Date.parse(item.startTime)));
  const cursor = [data.nextCursor, data.next_cursor, data.cursor, (data.pagination as Record<string, unknown> | undefined)?.nextCursor]
    .find((value) => typeof value === 'string' && value) as string | undefined;
  // Recordings listed, none of them readable (an id or time in a shape not known): never "nothing new".
  return { conversations, nextCursor: cursor ?? null, text: typeof data.text === 'string' && !list ? data.text : '', unreadable: entries.length > 0 && !conversations.length };
}

/** A transcript answer as text: its segments' "Speaker: words" (only this recording's, when they say), or its text. */
export function transcriptText(payload: unknown, recordingId = ''): string {
  const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const list = Array.isArray(payload) ? payload
    : [data.transcripts, data.transcriptions, data.segments, data.items, data.data, data.source_list].find(Array.isArray) as unknown[] | undefined;
  if (list) {
    return list
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .filter((item) => {
        const owner = item.conversationId ?? item.conversation_id ?? item.fileId ?? item.file_id;
        return !recordingId || typeof owner !== 'string' || owner === recordingId;
      })
      .map((item) => {
        // The words, however they come; a line with a speaker and no words is left out.
        const said = str(item.text, 4000) || str(item.content, 4000) || str(item.transcript, 4000)
          || (Array.isArray(item.words) ? item.words.map((word) => (typeof word === 'string' ? word : str((word as Record<string, unknown> | null)?.word ?? (word as Record<string, unknown> | null)?.text, 80))).join(' ').trim() : str(item.words, 4000));
        if (!said) return '';
        const speaker = str(item.speaker ?? item.speaker_name ?? item.speakerName, 60);
        return speaker ? `${speaker}: ${said}` : said;
      })
      .filter(Boolean)
      .join('\n');
  }
  return str(data.text) || str(data.transcript) || str(data.content);
}

// ─── Into the day review ───────────────────────────────────────────────────

/** "Nov 9, 2:15 PM" in the phone's time; with the year when it is not this year ("Dec 30, 2026, …" read in January). */
export function shortTime(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const otherYear = at.getFullYear() !== new Date(now).getFullYear();
  return at.toLocaleString('en-US', { month: 'short', day: 'numeric', ...(otherYear ? { year: 'numeric' } : {}), hour: 'numeric', minute: '2-digit' });
}

export type FieldyBlock = { id: string; label: string; text: string; startTime: string };

// The day review reads at most 12,000 characters (LIMITS.textMax in
// supabase/functions/day-review/review.ts); a recording that does not fit
// waits for the next read.
const REVIEW_MAX = 11_500;
// A long summary keeps its beginning and its end (promises are often last).
const SUMMARY_MAX = 6_000;
// The recorder writes the summary after a recording ends. One with no text
// yet waits; after a day with none it is skipped, and the review says so.
const NO_TEXT_GIVE_UP_MS = 24 * 60 * 60 * 1000;

export type ReviewPlan = {
  text: string;
  blocks: FieldyBlock[];
  /** Recordings with no summary or transcript a day after they ended: marked reviewed, and said so. */
  skipped: string[];
  /** Recordings left for the next read (no room, still going on, or no summary yet). */
  later: number;
};

function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 3) / 2);
  return `${text.slice(0, half).trimEnd()}\n…\n${text.slice(-half).trimStart()}`;
}

/**
 * The recordings not reviewed yet as review text, oldest first: each under
 * its own header ("[From Fieldy, Nov 9, 2:15 PM · Call with Sarah]"), so an
 * item found in it can say where it came from. `texts` holds the summary or
 * transcript of those whose list entry has none. `conversations` are the
 * ones not reviewed yet; which were reviewed is kept per recording
 * (src/lib/fieldy-api.ts), so two at the same minute, or one that waited,
 * are never passed over.
 */
export function reviewPlan(conversations: FieldyConversation[], now = Date.now(), texts: Record<string, string> = {}, recorderName = 'Fieldy'): ReviewPlan {
  const fresh = [...new Map(conversations.map((item) => [item.id, item])).values()]
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime) || a.id.localeCompare(b.id));
  const blocks: FieldyBlock[] = [];
  const skipped: string[] = [];
  let length = 0;
  let later = 0;
  for (const item of fresh) {
    const body = clipMiddle((item.summary || texts[item.id] || '').trim(), SUMMARY_MAX);
    if (!body) {
      // Given up a day after it ended; one with no end (still going on, or
      // its length unknown), a day after that.
      const ended = item.endTime ? Date.parse(item.endTime) : Date.parse(item.startTime) + NO_TEXT_GIVE_UP_MS;
      if (!Number.isNaN(ended) && now - ended >= NO_TEXT_GIVE_UP_MS) skipped.push(item.id);
      else later += 1;
      continue;
    }
    const label = `From ${recorderName}, ${shortTime(item.startTime, now)}${item.title ? ` · ${item.title.slice(0, 80)}` : ''}`;
    const text = `[${label}]\n${body}`;
    if (length + text.length + 2 > REVIEW_MAX) { later += 1; continue; }
    blocks.push({ id: item.id, label, text, startTime: item.startTime });
    length += text.length + 2;
  }
  return { text: blocks.map((block) => block.text).join('\n\n').slice(0, 12_000), blocks, skipped, later };
}

// Any alphabet, accents dropped, as the review compares quotes.
const loose = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The recordings a found item's quote came from (more than one when the same words are in several). */
export function blocksFor(quote: string, blocks: FieldyBlock[]): FieldyBlock[] {
  const words = loose(quote);
  return words ? blocks.filter((block) => loose(block.text).includes(words)) : [];
}

/** Which recording a found item came from: its label, or '' when it is in none, or in more than one. */
export function sourceFor(quote: string, blocks: FieldyBlock[]): string {
  const found = blocksFor(quote, blocks);
  return found.length === 1 ? found[0].label : '';
}

/** Where a Fieldy read starts the first time: the start of today, on the phone's clock. */
export function startOfToday(now = new Date()): string {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}
