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
//   * each send carries the outbox id (plus a hash of the sender settings)
//     as Resend's Idempotency-Key, and a retry renders the same body from the
//     row's prepared data and prepared_at, so a retry after an unknown
//     outcome never sends the same email twice.

import { createClient } from 'npm:@supabase/supabase-js@2.110.8';

import { jsonResponse, requiredEnv } from '../_shared/webhooks.ts';
import {
  DEFAULT_APP_URL,
  DEFAULT_FROM,
  DEFAULT_PORTAL_URL,
  DEFAULT_REPLY_TO,
  classifyResendFailure,
  idempotencyKey,
  isAuthorized,
  type Links,
  oneClickFrom,
  type OutboxRow,
  preparedAt,
  type RenderedEmail,
  renderEmail,
  RESEND_URL,
  resendBody,
  senderFor,
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
    storageUrl: (Deno.env.get('EMAIL_STORAGE_URL') || requiredEnv('SUPABASE_URL')).replace(/\/+$/, ''),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type SendOutcome = SendResult & { config?: boolean; charge?: boolean };

async function post(row: OutboxRow, email: RenderedEmail, apiKey: string, from: string, replyTo: string | undefined, target: Links): Promise<SendOutcome> {
  try {
    const key = await idempotencyKey(row, from, replyTo, target);
    const response = await fetch(Deno.env.get('EMAIL_RESEND_URL_FOR_TESTS') || RESEND_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(resendBody(row, email, from, replyTo)),
    });
    if (response.ok) {
      const answer = await response.json().catch(() => ({})) as { id?: string };
      return { id: row.id, provider_id: answer.id || '' };
    }
    const failure = await response.json().catch(() => null);
    const kind = classifyResendFailure(response.status, failure);
    // A 401/403 refuses the whole account (no attempt is spent while it is
    // fixed); a 422 about the sender might be this one email, so it spends one.
    return {
      id: row.id,
      error: `resend_${response.status}`,
      retry: kind !== 'final',
      config: kind === 'config',
      charge: kind === 'config' && response.status === 422,
    };
  } catch {
    return { id: row.id, error: 'network', retry: true };
  }
}

async function sendOne(row: OutboxRow, apiKey: string, defaultFrom: string, defaultReplyTo: string | undefined, target: Links): Promise<SendOutcome> {
  const { from, replyTo } = senderFor(row, defaultFrom, defaultReplyTo);
  let email: RenderedEmail;
  try {
    email = renderEmail(row, target, preparedAt(row));
  } catch {
    return { id: row.id, error: 'render_failed', retry: false };
  }
  // A practice's invite needs the practitioner to reply to: without one a
  // family's reply (it may carry health details) would go to someone else.
  if (row.kind === 'family_assessment_invite' && !replyTo) return { id: row.id, error: 'no_reply_to', retry: false };
  const sent = await post(row, email, apiKey, from, replyTo, target);
  // Resend refused a practice's own sender name (a 422 about the sender):
  // send that one email from ReferralFit's own name instead, still replying
  // to the practitioner. A second refusal is about the account or the
  // reply-to, and is handled as any sender refusal (the run stops and the
  // email waits), never by changing who replies reach.
  if (sent.charge && from !== defaultFrom) return post(row, email, apiKey, defaultFrom, replyTo, target);
  return sent;
}

async function record(supabase: ReturnType<typeof serviceClient>, result: SendResult): Promise<void> {
  const { error } = await supabase.rpc('email_outbox_record', { p_results: [result] });
  if (error) throw error;
}

// A configuration error stopped the run: the row tried waits 15 minutes (so
// the queue rotates and no single row holds it) and spends its attempt only
// for a 422 about the sender; the rows not tried go back to waiting without
// spending one. A bad key delays mail; it never uses up the attempts.
async function release(supabase: ReturnType<typeof serviceClient>, untried: string[], tried: string, reason: string, charge: boolean): Promise<void> {
  const { error } = await supabase.rpc('email_outbox_release', { p_ids: untried, p_tried: tried, p_error: reason, p_charge: charge });
  if (error) console.error('email-dispatch: release failed', error.code || 'unknown');
}

async function drain(supabase: ReturnType<typeof serviceClient>): Promise<{ sent: number; failed: number; retrying: number; stopped?: string }> {
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
    for (let index = 0; index < rows.length; index += 1) {
      if (index) await sleep(SEND_SPACING_MS);
      const result = await sendOne(rows[index], apiKey, from, replyTo, target);
      if (result.config) {
        // The account or sender is wrong: nothing can go out. Stop, and keep
        // the claimed rows waiting.
        console.error('email-dispatch: Resend refused the account or sender', result.error);
        await release(supabase, rows.slice(index + 1).map((row) => row.id), rows[index].id, result.error || 'config', Boolean(result.charge));
        return { ...totals, stopped: result.error };
      }
      // Recorded one by one, so a crash mid-batch never resends what went out.
      await record(supabase, { id: result.id, provider_id: result.provider_id, error: result.error, retry: result.retry });
      if (!result.error) totals.sent += 1;
      else if (result.retry) totals.retrying += 1;
      else totals.failed += 1;
    }
    if (rows.length < CLAIM_SIZE) break;
  }
  return totals;
}

Deno.serve(async (request) => {
  const url = new URL(request.url);
  if (request.method === 'GET') {
    // A mail client that opens the List-Unsubscribe address in a browser:
    // send it to the email settings page, which changes nothing on its own.
    const link = oneClickFrom(url);
    if (!link) return jsonResponse({ error: 'not_found' }, 404);
    return new Response(null, { status: 303, headers: { location: `${links().portalUrl}/u#${link.token}:${link.kind}` } });
  }
  if (request.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);

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
