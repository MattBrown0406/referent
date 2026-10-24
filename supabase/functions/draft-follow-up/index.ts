// AI follow-up drafts: a text, an email, or a call script for one case
// contact or referral partner. The app shows the draft for editing and the
// practitioner sends it from their own Messages / Mail / dialer; nothing is
// sent from here. See docs/FOLLOW_UP_OUTREACH.md for deployment.
//
// Bring your own key: ReferralFit is free, so each practitioner adds their
// own Anthropic API key in the app. It lives in their phone's keychain and
// arrives here in the request body (`anthropicKey`) on each request — not a
// header, so no request log can record it.
//
// Safety properties:
//   * every request must carry a signed-in user's access token; it is checked
//     against Supabase Auth before anything else happens;
//   * the Anthropic key is format-checked, used for this one call, and never
//     stored, logged, or echoed back;
//   * claim_outreach_draft (service-role only) confirms the case or partner
//     is in the caller's own workspace and enforces the daily cap before the
//     model is called;
//   * the model sees only the minimal fields parseDraftRequest keeps (first
//     names, relationship, stage, attempt count, the practitioner's note) —
//     never phone numbers, email addresses, case titles, or timeline notes;
//   * neither the request nor the draft is logged or stored.
//
// POST { action: "verify" } checks a key (a free model-list call) without
// drafting anything; any other body is a draft request.

import Anthropic from 'npm:@anthropic-ai/sdk@1.1.0';
import { createClient } from 'npm:@supabase/supabase-js@2.110.8';

import { requiredEnv } from '../_shared/webhooks.ts';
import {
  buildUserPrompt,
  type DraftRequest,
  DraftOutputError,
  DraftRequestError,
  outputSchema,
  parseApiKey,
  parseDraftOutput,
  parseDraftRequest,
  SYSTEM_PROMPT,
} from './draft.ts';

const MODEL = 'claude-opus-5-5';

// The phone gives up on a request after about a minute (iOS's default; the
// app also stops waiting at DRAFT_CLIENT_TIMEOUT_MS in outreach-api.ts). Every
// Anthropic call, retries and any retry-after wait included, ends inside
// these budgets so the answer always reaches the app instead of a timeout it
// reads as "no connection" while the cap is spent and the user is billed.
const DRAFT_DEADLINE_MS = 48_000;
const VERIFY_DEADLINE_MS = 20_000;

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function failure(status: number, code: string, message: string): Response {
  return reply({ error: { code, message } }, status);
}

function serviceClient() {
  return createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

// What went wrong on the Anthropic side, in words the practitioner can act
// on. Errors are told apart by the SDK's typed classes, most specific first;
// only the status code is ever logged (never the key or the request).
function anthropicFailure(error: unknown, deadline: AbortSignal): Response {
  if (deadline.aborted || error instanceof Anthropic.APIUserAbortError || error instanceof Anthropic.APIConnectionTimeoutError) {
    return failure(504, 'timeout', 'Anthropic took too long to answer. Try again.');
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return failure(401, 'key_invalid', 'Anthropic did not accept this API key. Check it, or create a new key in the Anthropic Console.');
  }
  if (error instanceof Anthropic.PermissionDeniedError || error instanceof Anthropic.NotFoundError) {
    return failure(403, 'key_forbidden', 'This API key cannot use the Claude model ReferralFit drafts with. Check the key’s workspace in the Anthropic Console.');
  }
  if (error instanceof Anthropic.RateLimitError) {
    return failure(429, 'key_rate_limited', 'Your Anthropic account is at its rate limit. Try again in a minute.');
  }
  if (error instanceof Anthropic.BadRequestError) {
    // Usually the account (no credit), but a request-shape problem looks the
    // same from here, so it is logged — status and error type only.
    console.error('Anthropic rejected the request', error.status, (error.error as { error?: { type?: string } } | undefined)?.error?.type ?? '');
    return failure(400, 'key_rejected', 'Anthropic turned the request down. Check your account in the Anthropic Console, then try again.');
  }
  if (error instanceof Anthropic.APIError) {
    console.error('Anthropic request failed', error.status);
    return failure(503, 'busy', 'Drafting is unavailable right now. Try again in a minute.');
  }
  console.error('Anthropic request failed');
  return failure(502, 'upstream_error', 'Drafting is unavailable right now.');
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'POST') return failure(405, 'method_not_allowed', 'Use POST.');

  const token = bearerToken(request);
  if (!token) return failure(401, 'unauthorized', 'Sign in to draft follow-ups.');

  let supabase: ReturnType<typeof serviceClient>;
  try {
    supabase = serviceClient();
  } catch {
    return failure(503, 'not_configured', 'Drafting is not set up yet.');
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  const userId = userData?.user?.id;
  if (userError || !userId) return failure(401, 'unauthorized', 'Your session has expired. Sign in again.');

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return failure(400, 'bad_request', 'The draft request was not readable.');
  }

  const apiKey = parseApiKey(body && typeof body === 'object' ? (body as { anthropicKey?: unknown }).anthropicKey : null);
  if (!apiKey) {
    return failure(400, 'key_required', 'Add your Anthropic API key to use AI drafts. It starts with sk-ant-.');
  }

  const anthropic = new Anthropic({ apiKey, timeout: 45_000, maxRetries: 1 });

  // Key check: one free model-list call, no draft, under its own daily cap
  // (so this function is never a way to test other people's keys in bulk).
  if (body && typeof body === 'object' && (body as { action?: unknown }).action === 'verify') {
    const { error: checkError } = await supabase.rpc('claim_outreach_key_check', { p_user_id: userId });
    if (checkError) {
      if (checkError.code === '54000') {
        return failure(429, 'check_limit', 'You have checked keys too many times today. Try again tomorrow.');
      }
      if (checkError.code === '42501') return failure(403, 'forbidden', 'Join a workspace before adding a key.');
      // Not set up yet (20261024130000 not applied): check without the cap.
      if (checkError.code !== 'PGRST202' && checkError.code !== '42883') {
        console.error('claim_outreach_key_check failed', checkError.code);
        return failure(500, 'server_error', 'Key checks are unavailable right now.');
      }
    }
    const deadline = AbortSignal.timeout(VERIFY_DEADLINE_MS);
    try {
      await anthropic.models.list({ limit: 1 }, { signal: deadline });
      return reply({ ok: true });
    } catch (error) {
      return anthropicFailure(error, deadline);
    }
  }

  let draftRequest: DraftRequest;
  try {
    draftRequest = parseDraftRequest(body);
  } catch (error) {
    const message = error instanceof DraftRequestError ? error.message : 'The draft request was not readable.';
    return failure(400, 'bad_request', message);
  }

  const { data: remaining, error: claimError } = await supabase.rpc('claim_outreach_draft', {
    p_user_id: userId,
    p_channel: draftRequest.channel,
    p_case_id: draftRequest.target.kind === 'case' ? draftRequest.target.caseId : null,
    p_partner_id: draftRequest.target.kind === 'partner' ? draftRequest.target.partnerId : null,
  });
  if (claimError) {
    if (claimError.code === '54000') {
      return failure(429, 'daily_limit', 'You have reached today’s AI draft limit. Write this one yourself, or try again tomorrow.');
    }
    if (claimError.code === 'P0002') return failure(404, 'not_found', 'That case or partner is not in your workspace.');
    if (claimError.code === '42501') return failure(403, 'forbidden', 'Join a workspace before drafting follow-ups.');
    console.error('claim_outreach_draft failed', claimError.code);
    return failure(500, 'server_error', 'Drafting is unavailable right now.');
  }

  let response;
  const deadline = AbortSignal.timeout(DRAFT_DEADLINE_MS);
  try {
    response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 8000, // thinking is always on for this model; leave it room
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: outputSchema(draftRequest.channel) },
      },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(draftRequest) }],
    }, { signal: deadline });
  } catch (error) {
    return anthropicFailure(error, deadline);
  }

  if (response.stop_reason === 'refusal') {
    return failure(422, 'refused', 'This one could not be drafted. Try rewording your note, or write it yourself.');
  }
  if (response.stop_reason === 'max_tokens') {
    return failure(502, 'incomplete', 'The draft came back incomplete. Try again.');
  }
  const text = response.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');

  try {
    const draft = parseDraftOutput(draftRequest.channel, text);
    return reply({ draft, remaining: typeof remaining === 'number' ? remaining : null });
  } catch (error) {
    const message = error instanceof DraftOutputError ? error.message : 'The draft came back unreadable.';
    return failure(502, 'bad_output', `${message} Try again.`);
  }
});
