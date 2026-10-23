// AI follow-up drafts: a text, an email, or a call script for one case
// contact or referral partner. The app shows the draft for editing and the
// practitioner sends it from their own Messages / Mail / dialer; nothing is
// sent from here. See docs/FOLLOW_UP_OUTREACH.md for deployment.
//
// Safety properties:
//   * every request must carry a signed-in user's access token; it is checked
//     against Supabase Auth before anything else happens;
//   * claim_outreach_draft (service-role only) confirms the case or partner
//     is in the caller's own workspace and enforces the daily cap before the
//     model is called;
//   * the model sees only the minimal fields parseDraftRequest keeps (first
//     names, relationship, stage, attempt count, the practitioner's note) —
//     never phone numbers, email addresses, case titles, or timeline notes;
//   * neither the request nor the draft is logged or stored.

import Anthropic from 'npm:@anthropic-ai/sdk@1.1.0';
import { createClient } from 'npm:@supabase/supabase-js@2.110.8';

import { requiredEnv } from '../_shared/webhooks.ts';
import {
  buildUserPrompt,
  type DraftRequest,
  DraftOutputError,
  DraftRequestError,
  outputSchema,
  parseDraftOutput,
  parseDraftRequest,
  SYSTEM_PROMPT,
} from './draft.ts';

const MODEL = 'claude-opus-5-5';

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

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'POST') return failure(405, 'method_not_allowed', 'Use POST.');

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return failure(503, 'not_configured', 'AI drafting is not set up yet.');

  const token = bearerToken(request);
  if (!token) return failure(401, 'unauthorized', 'Sign in to draft follow-ups.');

  let supabase: ReturnType<typeof serviceClient>;
  try {
    supabase = serviceClient();
  } catch {
    return failure(503, 'not_configured', 'AI drafting is not set up yet.');
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  const userId = userData?.user?.id;
  if (userError || !userId) return failure(401, 'unauthorized', 'Your session has expired. Sign in again.');

  let draftRequest: DraftRequest;
  try {
    draftRequest = parseDraftRequest(await request.json());
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

  const anthropic = new Anthropic({ apiKey, timeout: 45_000, maxRetries: 1 });
  let response;
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
    });
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      return failure(503, 'busy', 'Drafting is busy right now. Try again in a minute.');
    }
    if (error instanceof Anthropic.APIConnectionTimeoutError) {
      return failure(504, 'timeout', 'The draft took too long. Try again.');
    }
    if (error instanceof Anthropic.APIError) {
      console.error('Anthropic request failed', error.status);
      return failure(502, 'upstream_error', 'Drafting is unavailable right now.');
    }
    console.error('Anthropic request failed');
    return failure(502, 'upstream_error', 'Drafting is unavailable right now.');
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
