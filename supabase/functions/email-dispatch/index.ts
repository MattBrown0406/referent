// Email dispatcher: drains email_outbox and sends through Resend. Triggered
// every minute by pg_cron (email_dispatch_tick, via pg_net) or by hand. See
// docs/EMAIL.md for deployment.
//
// Safety properties:
//   * draining refuses every request without the shared secret header
//     (EMAIL_DISPATCH_SECRET) or the service-role key as a bearer token;
//   * the one exception is RFC 8058 one-click unsubscribe (a POST from the
//     mail client with ?unsubscribe=<64 hex>&kind=<kind>), which can only
//     turn that one email off for the token's owner;
//   * the service role holds no table grants: claiming and recording go
//     through service-role-only RPCs, which fill in the address and counts;
//   * nothing about a recipient or an email's content is logged here;
//   * each send carries the outbox id as Resend's Idempotency-Key, so a
//     retry after an unknown outcome never sends the same email twice.

import { createClient } from 'npm:@supabase/supabase-js@2.110.8';

import { jsonResponse, requiredEnv } from '../_shared/webhooks.ts';
import {
  DEFAULT_APP_URL,
  DEFAULT_FROM,
  DEFAULT_PORTAL_URL,
  DEFAULT_REPLY_TO,
  isAuthorized,
  isTransientStatus,
  type Links,
  oneClickFrom,
  type OutboxRow,
  renderEmail,
  RESEND_URL,
  resendBody,
  type SendResult,
} from './email.ts';

const CLAIM_SIZE = 20;
const MAX_ROWS_PER_RUN = 60;
// Resend allows a few requests a second per account; stay well under it.
const SEND_SPACING_MS = 550;

function serviceClient() {
  return createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function links(): Links {
  return {
    appUrl: (Deno.env.get('EMAIL_APP_URL') || DEFAULT_APP_URL).replace(/\/+$/, ''),
    portalUrl: (Deno.env.get('EMAIL_PORTAL_URL') || DEFAULT_PORTAL_URL).replace(/\/+$/, ''),
    // The public address mail clients POST to; SUPABASE_URL is it in production.
    functionUrl: (Deno.env.get('EMAIL_FUNCTION_URL') || `${requiredEnv('SUPABASE_URL').replace(/\/+$/, '')}/functions/v1/email-dispatch`)
      .replace(/\/+$/, ''),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendOne(row: OutboxRow, apiKey: string, from: string, replyTo: string | undefined, target: Links): Promise<SendResult> {
  let email;
  try {
    email = renderEmail(row, target);
  } catch {
    return { id: row.id, error: 'render_failed', retry: false };
  }
  try {
    const response = await fetch(Deno.env.get('EMAIL_RESEND_URL_FOR_TESTS') || RESEND_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': row.id,
      },
      body: JSON.stringify(resendBody(row, email, from, replyTo)),
    });
    if (response.ok) {
      const answer = await response.json().catch(() => ({})) as { id?: string };
      return { id: row.id, provider_id: answer.id || '' };
    }
    await response.body?.cancel().catch(() => undefined);
    return { id: row.id, error: `resend_${response.status}`, retry: isTransientStatus(response.status) };
  } catch {
    return { id: row.id, error: 'network', retry: true };
  }
}

async function drain(supabase: ReturnType<typeof serviceClient>): Promise<{ sent: number; failed: number; retrying: number }> {
  const apiKey = requiredEnv('RESEND_API_KEY');
  const from = Deno.env.get('EMAIL_FROM') || DEFAULT_FROM;
  const replyTo = Deno.env.get('EMAIL_REPLY_TO') || DEFAULT_REPLY_TO;
  const target = links();
  const totals = { sent: 0, failed: 0, retrying: 0 };
  let seen = 0;
  while (seen < MAX_ROWS_PER_RUN) {
    const { data, error } = await supabase.rpc('email_outbox_claim', { p_limit: CLAIM_SIZE });
    if (error) throw error;
    const rows = (Array.isArray(data) ? data : []) as OutboxRow[];
    if (!rows.length) break;
    seen += rows.length;
    const results: SendResult[] = [];
    for (const row of rows) {
      if (results.length) await sleep(SEND_SPACING_MS);
      const result = await sendOne(row, apiKey, from, replyTo, target);
      results.push(result);
      if (!result.error) totals.sent += 1;
      else if (result.retry) totals.retrying += 1;
      else totals.failed += 1;
    }
    const { error: recordError } = await supabase.rpc('email_outbox_record', { p_results: results });
    if (recordError) throw recordError;
    if (rows.length < CLAIM_SIZE) break;
  }
  return totals;
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);
  const url = new URL(request.url);

  // RFC 8058 one-click unsubscribe from the mail client: no secret, only
  // this token's owner, only this kind, only off.
  const oneClick = oneClickFrom(url);
  if (oneClick) {
    try {
      const { error } = await serviceClient().rpc('public_email_set_preference', {
        p_token: oneClick.token,
        p_kind: oneClick.kind,
        p_value: false,
      });
      if (error && error.code !== 'P0002') throw error;
      // An unknown token answers the same, so the endpoint reveals nothing.
      return jsonResponse({ ok: true });
    } catch {
      console.error('email unsubscribe failed');
      return jsonResponse({ ok: false }, 500);
    }
  }
  if (url.searchParams.has('unsubscribe')) return jsonResponse({ error: 'bad_request' }, 400);

  const secret = Deno.env.get('EMAIL_DISPATCH_SECRET') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!isAuthorized(request.headers, secret, serviceRoleKey)) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!Deno.env.get('RESEND_API_KEY')) {
    // Leave every email waiting until the key is set.
    console.error('email-dispatch: RESEND_API_KEY is not set');
    return jsonResponse({ ok: false, error: 'not_configured' }, 503);
  }

  try {
    const totals = await drain(serviceClient());
    return jsonResponse({ ok: true, ...totals });
  } catch (error) {
    console.error('email-dispatch failed', (error as { code?: string }).code || 'unknown');
    return jsonResponse({ ok: false, error: 'dispatch_failed' }, 500);
  }
});
