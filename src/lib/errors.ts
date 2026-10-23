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

// Human-readable text for anything thrown or returned as an error. PostgREST
// and RPC failures arrive as plain objects ({ message, details, hint, code }),
// not Error instances, so `String(error)` would print "[object Object]".
export function describeError(error: unknown, fallback = 'Unknown error'): string {
  if (error === null || error === undefined) return fallback;
  if (typeof error === 'string') return error.trim() || fallback;
  if (typeof error !== 'object') return String(error);
  const value = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown; error_description?: unknown; error?: unknown };
  const text = (input: unknown) => (typeof input === 'string' ? input.trim() : '');
  const message = text(value.message) || text(value.error_description) || text(value.error);
  const parts: string[] = [];
  if (message) parts.push(message);
  const details = text(value.details);
  if (details && details !== message) parts.push(details);
  const hint = text(value.hint);
  if (hint && hint !== message && hint !== details) parts.push(`Hint: ${hint}`);
  let result = parts.join(' — ');
  const code = text(value.code);
  if (code) result = result ? `${result} (code ${code})` : `Error code ${code}`;
  if (result) return result;
  if (error instanceof Error && error.name) return error.name;
  try {
    const json = JSON.stringify(error);
    return json && json !== '{}' ? json : fallback;
  } catch {
    return fallback;
  }
}

// The PostgREST / Postgres code on an error object, when there is one.
export function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code ? code : undefined;
}
