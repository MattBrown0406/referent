export class StoreError extends Error {
  queued: boolean;

  constructor(message: string, queued: boolean) {
    super(message);
    this.name = 'StoreError';
    this.queued = queued;
  }
}

// One or more queued offline changes were refused by the server and moved out
// of the live queue into this account's "rejected" list (store.ts
// listRejectedWrites / discardRejectedWrite / retryRejectedWrite). Later
// queued changes kept flowing; nothing was lost. `count` is how many were set
// aside by the flush that raised this.
export class RejectedWritesError extends StoreError {
  count: number;

  constructor(message: string, count: number) {
    super(message, false);
    this.name = 'RejectedWritesError';
    this.count = count;
  }
}

export const OFFLINE_MESSAGE = 'Offline: the server cannot be reached right now.';
const TIMED_OUT_MESSAGE = 'Offline: the server did not answer in time.';

// The server could not be reached, did not answer in time, or failed in
// passing (a 5xx or a gateway page). Nothing was refused: a write that raised
// this may or may not have landed, so the caller keeps its draft and offers
// Retry with the SAME ids (every server write the app retries is replay-safe).
// A read that raised this falls back to the saved copy. isNetworkError and
// isServerUnreachable both recognise it.
export class OfflineError extends StoreError {
  readonly offline = true;
  timedOut: boolean;

  constructor(message?: string, options: { timedOut?: boolean; cause?: unknown } = {}) {
    super(message ?? (options.timedOut ? TIMED_OUT_MESSAGE : OFFLINE_MESSAGE), false);
    this.name = 'OfflineError';
    this.timedOut = Boolean(options.timedOut);
    // The underlying failure, for debugging only (never shown to the user).
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

// Someone else already holds the case the user tried to take (take_case,
// cases.ts takeCase). NOT retryable: the case is theirs and nothing changed.
// `takenBy` is the holder's user id (lowercased) when the server named it.
export class LeadTakenError extends StoreError {
  takenBy: string | null;

  constructor(message: string, takenBy: string | null) {
    super(message, false);
    this.name = 'LeadTakenError';
    this.takenBy = typeof takenBy === 'string' && takenBy.trim() ? takenBy.trim().toLowerCase() : null;
  }
}

// ─── Failure classification ─────────────────────────────────────────────────
// Shared by every read and write path (store.ts, cases.ts, org.ts). Three
// questions, from narrow to broad:
//   isTimeoutError      — the client gave up waiting (supabase.ts deadline,
//                         an XHR timeout). The request may have reached the
//                         server, so a queued write that times out counts
//                         toward the transient caps (store.ts).
//   isNetworkError      — no usable answer from the network at all: offline,
//                         timed out, aborted, status 0.
//   isServerUnreachable — isNetworkError, or a passing server failure
//                         (isTransientServerError). Every READ falls back to
//                         the saved copy on this; every write treats it as
//                         "not refused" (queue, or keep the draft).

type ErrorShape = { name?: unknown; message?: unknown; hint?: unknown; status?: unknown; httpStatus?: unknown; code?: unknown };

function shape(error: unknown): ErrorShape {
  return (error && typeof error === 'object' ? error : { message: error }) as ErrorShape;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// A Postgres SQLSTATE or a PostgREST PGRSTxxx code: the request reached the
// database layer, whatever the message says.
function hasServerCode(value: ErrorShape): boolean {
  const code = str(value.code).trim().toUpperCase();
  return /^[0-9A-Z]{5}$/.test(code) || /^PGRST\d{3}$/.test(code);
}

function statusOf(value: ErrorShape): number | undefined {
  if (typeof value.httpStatus === 'number') return value.httpStatus;
  if (typeof value.status === 'number') return value.status;
  return undefined;
}

export function isTimeoutError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof OfflineError) return error.timedOut;
  if (error instanceof LeadTakenError) return false;
  const value = shape(error);
  if (hasServerCode(value)) return false;
  if (value.name === 'AbortError') return true;
  const text = `${str(value.message)} ${str(value.hint)}`.toLowerCase();
  return text.includes('aborterror') || text.includes('network request timed out') || text.includes('request was aborted');
}

export function isNetworkError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof OfflineError) return true;
  // The server answered (a teammate holds the case), whatever their name says.
  if (error instanceof LeadTakenError) return false;
  const value = shape(error);
  // supabase-js reports a token refresh that never reached the server this way
  // (status 0), so it must be classified before the status check below.
  if (value.name === 'AuthRetryableFetchError' || value.name === 'OfflineError') return true;
  if (isTimeoutError(error)) return true;
  // postgrest-js answers a fetch that threw with status 0 (no HTTP response).
  const status = statusOf(value);
  if (status === 0) return true;
  // A status or a database code means the request reached a server: queueing
  // it as "offline" would just fail again on flush.
  if (status !== undefined || hasServerCode(value)) return false;
  const message = str(value.message).trim();
  if (message.startsWith('<')) return false; // a gateway's HTML page: the server answered
  const text = `${message || String(error)} ${str(value.hint)}`.toLowerCase();
  return (
    text.includes('network request failed') ||
    text.includes('network request timed out') ||
    text.includes('failed to fetch') ||
    text.includes('networkerror') ||
    text.includes('fetch failed') ||
    text.includes('econnrefused') ||
    text.includes('econnreset') ||
    text.includes('enotfound') ||
    text.includes('etimedout') ||
    text.includes('timeout') ||
    text.includes('timed out') ||
    text.includes('network connection was lost') ||
    text.includes('offline') ||
    text.includes('internet')
  );
}

// Passing server trouble, not a verdict on the change: connection/pool and
// JWT problems in PostgREST, serialization failures and deadlocks (40),
// resource exhaustion (53), lock timeouts, cancelled/timed-out statements and
// restarts (57), system errors (58, XX), and any 5xx/408/429 or proxy page
// without a database code. These stay in the live queue and the flush stops,
// exactly as for a lost connection. A deterministic refusal (23xxx
// constraints, 42501 RLS, 22xxx invalid input, P0001 raises, PGRST 4xx
// validation) is set aside.
const TRANSIENT_SQLSTATE = /^(08|40|53|55P03|55006|57|58|XX|28000|28P01)/;
const TRANSIENT_PGRST = new Set(['PGRST000', 'PGRST001', 'PGRST002', 'PGRST003', 'PGRST301', 'PGRST303']);

export function isTransientServerError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; message?: unknown; httpStatus?: unknown; status?: unknown };
  const code = typeof value.code === 'string' ? value.code.trim().toUpperCase() : '';
  if (/^PGRST\d{3}$/.test(code)) return TRANSIENT_PGRST.has(code);
  if (/^[0-9A-Z]{5}$/.test(code)) return TRANSIENT_SQLSTATE.test(code);
  if (code) return false;
  const status = typeof value.httpStatus === 'number' ? value.httpStatus : typeof value.status === 'number' ? value.status : undefined;
  if (status !== undefined && (status >= 500 || status === 408 || status === 429)) return true;
  const message = String(value.message ?? '').trim().toLowerCase();
  return message.startsWith('<')
    || /bad gateway|gateway time-?out|service unavailable|temporarily unavailable|too many requests|upstream|cloudflare|timed out|\b(50[0-9]|52[0-9])\b/.test(message);
}

// THE read classifier: offline, timed out, status 0, or a passing server
// failure (5xx with an HTML or JSON body, PGRST connection codes, ...). Every
// read path falls back to the saved copy on this instead of showing an error.
export function isServerUnreachable(error: unknown): boolean {
  return isNetworkError(error) || isTransientServerError(error);
}

// The HTTP status rides along on a PostgREST / RPC error (httpStatus) so a 5xx
// with an HTML body from a proxy is recognisable as a passing failure. An
// Error's message is not enumerable: annotate it in place, don't copy it.
export function withHttpStatus(error: unknown, status: unknown): unknown {
  if (!error || typeof error !== 'object' || typeof status !== 'number') return error;
  if (error instanceof Error) return Object.assign(error, { httpStatus: status });
  return { ...(error as Record<string, unknown>), httpStatus: status };
}

// An unreachable-class failure as an OfflineError (anything else unchanged).
// An app-authored StoreError is converted only when it says it is offline
// ("Offline: …", as org.ts words it): its other messages are the app's own
// (e.g. "Could not durably save the offline queue") and must stay as they are.
export function asOfflineError(error: unknown): unknown {
  if (error instanceof OfflineError) return error;
  if (error instanceof StoreError) return /^offline\b/i.test(error.message) ? new OfflineError(error.message, { cause: error }) : error;
  if (!isServerUnreachable(error)) return error;
  return new OfflineError(undefined, { timedOut: isTimeoutError(error), cause: error });
}

// ─── Human-readable text ────────────────────────────────────────────────────

const MAX_DESCRIPTION_LENGTH = 300;

function looksLikeHtml(text: string): boolean {
  return text.startsWith('<') || /<\/?(?:html|head|body|title|!doctype)\b/i.test(text);
}

// JS engine stack frames (V8/Hermes "    at fn (file:1:2)", JSC "fn@file:1:2")
// and the "Caused by:" blocks postgrest-js appends to a failed fetch.
function looksLikeStack(text: string): boolean {
  return /(^|\n)\s*at\s+[^\n]*(?::\d+|\bnative\b|address at)/.test(text)
    || /\S@\S*:\d+(?::\d+)?/.test(text)
    || /\bCaused by:/.test(text);
}

// The lines of a message before any stack trace.
function withoutStack(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    if (looksLikeStack(line) || /^\s*Caused by:/.test(line)) break;
    kept.push(line);
  }
  return kept.join(' ').replace(/\s+/g, ' ').trim();
}

function serverPageMessage(status: number | undefined, page: string): string {
  const fromPage = /\b(5\d\d|4\d\d)\b/.exec(page.replace(/<[^>]*>/g, ' '))?.[1];
  const code = status && status > 0 ? String(status) : fromPage;
  return `The server is having a temporary problem${code ? ` (HTTP ${code})` : ''}. Try again in a moment.`;
}

function clip(text: string): string {
  return text.length > MAX_DESCRIPTION_LENGTH ? `${text.slice(0, MAX_DESCRIPTION_LENGTH - 1).trimEnd()}…` : text;
}

// Human-readable text for anything thrown or returned as an error. PostgREST
// and RPC failures arrive as plain objects ({ message, details, hint, code }),
// not Error instances, so `String(error)` would print "[object Object]". Never
// returns HTML (a gateway's error page) or a stack trace (postgrest-js puts a
// failed fetch's stack in `details`): those become plain sentences.
export function describeError(error: unknown, fallback = 'Unknown error'): string {
  if (error === null || error === undefined) return fallback;
  if (typeof error === 'string') {
    const trimmed = error.trim();
    if (!trimmed) return fallback;
    return clip(looksLikeHtml(trimmed) ? serverPageMessage(undefined, trimmed) : withoutStack(trimmed) || fallback);
  }
  if (typeof error !== 'object') return String(error);
  const value = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown; error_description?: unknown; error?: unknown };
  const text = (input: unknown) => (typeof input === 'string' ? input.trim() : '');
  const rawMessage = text(value.message) || text(value.error_description) || text(value.error);
  const status = statusOf(shape(error));
  if (looksLikeHtml(rawMessage) || (!rawMessage && looksLikeHtml(text(value.details)))) {
    return serverPageMessage(status, rawMessage || text(value.details));
  }
  // An app-authored StoreError (OfflineError included) already reads well.
  if (!(error instanceof StoreError) && !text(value.code)) {
    // Worded to stay recognisable to isNetworkError ("Offline:") after a
    // caller wraps it in a StoreError.
    if (isTimeoutError(error)) return `${TIMED_OUT_MESSAGE} Check your connection and try again.`;
    if (isNetworkError(error)) return `${OFFLINE_MESSAGE} Check your connection and try again.`;
  }
  const message = withoutStack(rawMessage);
  const parts: string[] = [];
  if (message) parts.push(message);
  const details = text(value.details);
  if (details && details !== message && !looksLikeStack(details) && !looksLikeHtml(details)) parts.push(withoutStack(details));
  const hint = text(value.hint);
  if (hint && hint !== message && hint !== details && !looksLikeStack(hint) && !looksLikeHtml(hint)) parts.push(`Hint: ${withoutStack(hint)}`);
  let result = parts.filter(Boolean).join(' — ');
  const code = text(value.code);
  if (code) result = result ? `${result} (code ${code})` : `Error code ${code}`;
  if (result) return clip(result);
  if (error instanceof Error && error.name) return error.name;
  try {
    const json = JSON.stringify(error);
    return json && json !== '{}' ? clip(json) : fallback;
  } catch {
    return fallback;
  }
}

// The PostgREST / Postgres code on an error object, when there is one.
export function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code ? code : undefined;
}
