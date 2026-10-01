// Push dispatcher: drains notification_outbox and sends through the Expo
// Push API. Triggered every minute by pg_cron (push_dispatch_tick, via
// pg_net) or by hand. See docs/NOTIFICATIONS.md for deployment.
//
// Safety properties:
//   * refuses every request that does not carry the shared secret header
//     (PUSH_DISPATCH_SECRET) or the service-role key as a bearer token;
//   * the service role holds no table grants: claiming, recording, and
//     pruning all go through service-role-only RPCs;
//   * the payload sent to Expo is exactly what the database queued (a
//     generic title and body plus ids); nothing is added or logged here;
//   * tokens Expo reports as DeviceNotRegistered are removed so they are
//     never tried again.

import { createClient } from 'npm:@supabase/supabase-js@2.110.8';

import { jsonResponse, requiredEnv } from '../_shared/webhooks.ts';
import {
  buildMessages,
  chunk,
  collectReceiptResults,
  collectSendResults,
  EXPO_RECEIPTS_URL,
  EXPO_SEND_URL,
  isAuthorized,
  type OutboxRow,
  RECEIPT_CHUNK,
  type Receipt,
  SEND_CHUNK,
  type Ticket,
} from './push.ts';

const MAX_ROWS_PER_RUN = 500;

function serviceClient() {
  return createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function expoHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'accept-encoding': 'gzip, deflate',
    'content-type': 'application/json',
  };
  // Optional: an Expo access token locks sending to this account.
  const accessToken = Deno.env.get('EXPO_ACCESS_TOKEN');
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  return headers;
}

async function expoPost<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, { method: 'POST', headers: expoHeaders(), body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Expo push API answered ${response.status}`);
  return await response.json() as T;
}

async function sendBatch(supabase: ReturnType<typeof serviceClient>, rows: OutboxRow[]): Promise<{ sent: number; failed: number; pruned: number }> {
  const entries = buildMessages(rows);
  const tickets: Ticket[] = [];
  for (const part of chunk(entries, SEND_CHUNK)) {
    try {
      const answer = await expoPost<{ data?: Ticket[] }>(EXPO_SEND_URL, part.map((entry) => entry.message));
      const got = Array.isArray(answer.data) ? answer.data : [];
      // Keep tickets aligned with messages even if Expo answered short.
      for (let index = 0; index < part.length; index += 1) {
        tickets.push(got[index] || { status: 'error', message: 'no_ticket' });
      }
    } catch (error) {
      for (let index = 0; index < part.length; index += 1) {
        tickets.push({ status: 'error', message: (error as Error).message || 'send_failed' });
      }
    }
  }
  const { results, deadTokens } = collectSendResults(entries, tickets);
  // Rows that had no device at all (claim returned them with an empty list).
  for (const row of rows) {
    if (!results.some((result) => result.id === row.id)) results.push({ id: row.id, tickets: [], error: 'no_device' });
  }
  const { error } = await supabase.rpc('push_outbox_record', { p_results: results, p_dead_tokens: deadTokens });
  if (error) throw error;
  return {
    sent: results.filter((result) => result.tickets.length > 0).length,
    failed: results.filter((result) => result.tickets.length === 0).length,
    pruned: deadTokens.length,
  };
}

async function drainOutbox(supabase: ReturnType<typeof serviceClient>): Promise<{ sent: number; failed: number; pruned: number }> {
  const totals = { sent: 0, failed: 0, pruned: 0 };
  let seen = 0;
  while (seen < MAX_ROWS_PER_RUN) {
    const { data, error } = await supabase.rpc('push_outbox_claim', { p_limit: SEND_CHUNK });
    if (error) throw error;
    const rows = (Array.isArray(data) ? data : []) as OutboxRow[];
    if (!rows.length) break;
    seen += rows.length;
    const batch = await sendBatch(supabase, rows);
    totals.sent += batch.sent;
    totals.failed += batch.failed;
    totals.pruned += batch.pruned;
  }
  return totals;
}

async function checkReceipts(supabase: ReturnType<typeof serviceClient>): Promise<{ checked: number; pruned: number }> {
  const { data, error } = await supabase.rpc('push_receipts_pending', { p_limit: RECEIPT_CHUNK });
  if (error) throw error;
  const rows = (Array.isArray(data) ? data : []) as { id: string; tickets: { token: string; id: string }[] }[];
  if (!rows.length) return { checked: 0, pruned: 0 };
  const ids = rows.flatMap((row) => (row.tickets || []).map((ticket) => ticket.id)).filter(Boolean);
  const receipts: Record<string, Receipt | undefined> = {};
  for (const part of chunk(ids, RECEIPT_CHUNK)) {
    try {
      const answer = await expoPost<{ data?: Record<string, Receipt> }>(EXPO_RECEIPTS_URL, { ids: part });
      Object.assign(receipts, answer.data || {});
    } catch {
      // Leave these rows unchecked; the next run tries again.
      return { checked: 0, pruned: 0 };
    }
  }
  const { results, deadTokens } = collectReceiptResults(rows, receipts);
  const { error: recordError } = await supabase.rpc('push_receipts_record', { p_results: results, p_dead_tokens: deadTokens });
  if (recordError) throw recordError;
  return { checked: results.length, pruned: deadTokens.length };
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);
  const secret = Deno.env.get('PUSH_DISPATCH_SECRET') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!isAuthorized(request.headers, secret, serviceRoleKey)) return jsonResponse({ error: 'unauthorized' }, 401);

  try {
    const supabase = serviceClient();
    const outbox = await drainOutbox(supabase);
    const receipts = await checkReceipts(supabase);
    return jsonResponse({ ok: true, ...outbox, receipts });
  } catch (error) {
    console.error('push-dispatch failed', (error as Error).message);
    return jsonResponse({ ok: false, error: 'dispatch_failed' }, 500);
  }
});
