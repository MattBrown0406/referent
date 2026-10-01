// Pure helpers for the push dispatcher. No Deno APIs, no network: every
// function here is covered by push_test.ts and runs under plain `deno test`.
//
// Expo Push API shapes (https://docs.expo.dev/push-notifications/sending-notifications/):
//   send:     POST /--/api/v2/push/send      body: ExpoMessage[]   -> { data: Ticket[] }
//   receipts: POST /--/api/v2/push/getReceipts body: { ids }      -> { data: { [id]: Receipt } }

export const EXPO_SEND_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
// Expo accepts up to 100 messages per send request and 1000 ids per receipts request.
export const SEND_CHUNK = 100;
export const RECEIPT_CHUNK = 1000;
export const ANDROID_CHANNEL = 'referralfit';

export type OutboxRow = {
  id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  tokens: { token: string; platform: string }[];
};

export type ExpoMessage = {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound: 'default';
  priority: 'high';
  channelId?: string;
};

export type Ticket =
  | { status: 'ok'; id: string }
  | { status: 'error'; message?: string; details?: { error?: string } };

export type Receipt =
  | { status: 'ok' }
  | { status: 'error'; message?: string; details?: { error?: string } };

export type OutboxResult = { id: string; tickets: { token: string; id: string }[]; error: string };
export type ReceiptResult = { id: string; error: string };

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

// One Expo message per (row, device). The payload is exactly what the
// database queued: a generic title and body and the ids the app deep-links
// from. Nothing is added here.
export function buildMessages(rows: OutboxRow[]): { rowId: string; token: string; message: ExpoMessage }[] {
  const out: { rowId: string; token: string; message: ExpoMessage }[] = [];
  for (const row of rows) {
    for (const device of row.tokens || []) {
      if (!device?.token) continue;
      const message: ExpoMessage = {
        to: device.token,
        title: row.title,
        body: row.body,
        data: row.data || {},
        sound: 'default',
        priority: 'high',
      };
      if (device.platform === 'android') message.channelId = ANDROID_CHANNEL;
      out.push({ rowId: row.id, token: device.token, message });
    }
  }
  return out;
}

export function isDeviceNotRegistered(item: { status: string; details?: { error?: string } }): boolean {
  return item.status === 'error' && item.details?.error === 'DeviceNotRegistered';
}

// Fold Expo's tickets (one per message, same order) back onto outbox rows.
// A row counts as sent when at least one device accepted it; tokens Expo
// says are gone are returned for pruning.
export function collectSendResults(
  sent: { rowId: string; token: string }[],
  tickets: Ticket[],
): { results: OutboxResult[]; deadTokens: string[] } {
  const byRow = new Map<string, OutboxResult>();
  const deadTokens = new Set<string>();
  sent.forEach((entry, index) => {
    const ticket = tickets[index];
    const result = byRow.get(entry.rowId) || { id: entry.rowId, tickets: [], error: '' };
    if (ticket && ticket.status === 'ok' && typeof ticket.id === 'string') {
      result.tickets.push({ token: entry.token, id: ticket.id });
    } else {
      const reason = ticket && ticket.status === 'error'
        ? (ticket.details?.error || ticket.message || 'error')
        : 'no_ticket';
      if (ticket && isDeviceNotRegistered(ticket)) deadTokens.add(entry.token);
      if (!result.error) result.error = reason;
    }
    byRow.set(entry.rowId, result);
  });
  const results = [...byRow.values()].map((result) => ({ ...result, error: result.tickets.length ? '' : result.error }));
  return { results, deadTokens: [...deadTokens] };
}

// Receipts arrive keyed by ticket id. A row's error is the first receipt
// error on any of its tickets (empty when every device confirmed).
export function collectReceiptResults(
  rows: { id: string; tickets: { token: string; id: string }[] }[],
  receipts: Record<string, Receipt | undefined>,
): { results: ReceiptResult[]; deadTokens: string[] } {
  const deadTokens = new Set<string>();
  const results = rows.map((row) => {
    let error = '';
    for (const ticket of row.tickets || []) {
      const receipt = receipts[ticket.id];
      if (!receipt || receipt.status !== 'error') continue;
      if (isDeviceNotRegistered(receipt)) deadTokens.add(ticket.token);
      if (!error) error = receipt.details?.error || receipt.message || 'error';
    }
    return { id: row.id, error };
  });
  return { results, deadTokens: [...deadTokens] };
}

// Constant-time comparison for the shared-secret header.
export function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided || !expected) return false;
  const left = new TextEncoder().encode(provided);
  const right = new TextEncoder().encode(expected);
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) difference |= (left[index] || 0) ^ (right[index] || 0);
  return difference === 0;
}

// The function is callable only with the shared secret header set in the
// cron job, or with the project's service-role key as a bearer token (the
// manual fallback). Anything else is refused before any database call.
export function isAuthorized(headers: Headers, secret: string, serviceRoleKey: string): boolean {
  if (secretMatches(headers.get('x-push-dispatch-secret'), secret)) return true;
  const bearer = (headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return secretMatches(bearer, serviceRoleKey);
}
