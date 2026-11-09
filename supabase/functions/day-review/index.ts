// Day review: the practitioner pastes notes from their day (a recorder's
// summary, call notes) and gets back what belongs in ReferralFit: new leads,
// notes on cases and partners, follow-ups, referrals and new contacts. The
// app matches each item to a case or partner on the phone and saves nothing
// until the practitioner approves it. See docs/DAY_REVIEW.md.
//
// Bring your own key, exactly like AI drafts (draft-follow-up): the user's
// Anthropic key arrives in the request body (`anthropicKey`), never a header,
// is used for this one call, and is never stored, logged, or echoed back.
//
// Safety properties:
//   * every request must carry a signed-in user's access token, checked
//     against Supabase Auth before anything else happens;
//   * claim_day_review (service-role only) confirms workspace membership and
//     enforces a daily cap before the model is called;
//   * the model sees only the pasted notes and today's date, never the
//     workspace's cases, contacts or partners;
//   * neither the notes nor the result is logged or stored here.

import Anthropic from 'npm:@anthropic-ai/sdk@1.1.0';
import { createClient } from 'npm:@supabase/supabase-js@2.110.8';

import { requiredEnv } from '../_shared/webhooks.ts';
import {
  buildUserPrompt,
  outputSchema,
  parseApiKey,
  parseReviewOutput,
  parseReviewRequest,
  type ReviewRequest,
  ReviewOutputError,
  ReviewRequestError,
  SYSTEM_PROMPT,
} from './review.ts';

// The same model as AI drafts, at low effort: extraction, not writing.
const MODEL = 'claude-opus-5-5';

// The phone stops waiting after about a minute (DAY_REVIEW_CLIENT_TIMEOUT_MS
// in src/lib/day-review-api.ts); the Anthropic call ends inside this budget
// so the answer always reaches the app. There is no SDK retry: a second try
// could not finish in what is left, and the practitioner can tap again.
const REVIEW_DEADLINE_MS = 52_000;

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
// on. Only the status code is ever logged (never the key or the notes).
function anthropicFailure(error: unknown, deadline: AbortSignal): Response {
  if (deadline.aborted || error instanceof Anthropic.APIUserAbortError || error instanceof Anthropic.APIConnectionTimeoutError) {
    return failure(504, 'timeout', 'Anthropic took too long to answer. Try again, or paste a shorter part of the day.');
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return failure(401, 'key_invalid', 'Anthropic did not accept your API key. Check it in Workspace and settings, AI drafts.');
  }
  if (error instanceof Anthropic.PermissionDeniedError || error instanceof Anthropic.NotFoundError) {
    return failure(403, 'key_forbidden', 'Your API key cannot use the Claude model ReferralFit reviews with. Check the key’s workspace in the Anthropic Console.');
  }
  if (error instanceof Anthropic.RateLimitError) {
    return failure(429, 'key_rate_limited', 'Your Anthropic account is at its rate limit. Try again in a minute.');
  }
  if (error instanceof Anthropic.BadRequestError) {
    console.error('Anthropic rejected the request', error.status, (error.error as { error?: { type?: string } } | undefined)?.error?.type ?? '');
    return failure(400, 'key_rejected', 'Anthropic turned the request down. Check your account in the Anthropic Console, then try again.');
  }
  if (error instanceof Anthropic.APIError) {
    console.error('Anthropic request failed', error.status);
    return failure(503, 'busy', 'Review is unavailable right now. Try again in a minute.');
  }
  console.error('Anthropic request failed');
  return failure(502, 'upstream_error', 'Review is unavailable right now.');
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'POST') return failure(405, 'method_not_allowed', 'Use POST.');

  const token = bearerToken(request);
  if (!token) return failure(401, 'unauthorized', 'Sign in to review notes.');

  let supabase: ReturnType<typeof serviceClient>;
  try {
    supabase = serviceClient();
  } catch {
    return failure(503, 'not_configured', 'Review is not set up yet.');
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  const userId = userData?.user?.id;
  if (userError || !userId) return failure(401, 'unauthorized', 'Your session has expired. Sign in again.');

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return failure(400, 'bad_request', 'The notes could not be read.');
  }

  const apiKey = parseApiKey(body && typeof body === 'object' ? (body as { anthropicKey?: unknown }).anthropicKey : null);
  if (!apiKey) return failure(400, 'key_required', 'Add your Anthropic API key to review notes. It starts with sk-ant-.');

  let reviewRequest: ReviewRequest;
  try {
    reviewRequest = parseReviewRequest(body);
  } catch (error) {
    const message = error instanceof ReviewRequestError ? error.message : 'The notes could not be read.';
    return failure(400, 'bad_request', message);
  }

  const { data: remaining, error: claimError } = await supabase.rpc('claim_day_review', { p_user_id: userId });
  if (claimError) {
    if (claimError.code === '54000') {
      return failure(429, 'daily_limit', 'You have reached today’s review limit. Try again tomorrow.');
    }
    if (claimError.code === '42501') return failure(403, 'forbidden', 'Join a workspace before reviewing notes.');
    // Not set up yet (20261109120000 not applied): review without the cap.
    if (claimError.code !== 'PGRST202' && claimError.code !== '42883') {
      console.error('claim_day_review failed', claimError.code);
      return failure(500, 'server_error', 'Review is unavailable right now.');
    }
  }

  const anthropic = new Anthropic({ apiKey, timeout: REVIEW_DEADLINE_MS, maxRetries: 0 });
  let response;
  const deadline = AbortSignal.timeout(REVIEW_DEADLINE_MS);
  try {
    response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 16000, // thinking is always on for this model; leave it room
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: outputSchema() },
      },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(reviewRequest) }],
    }, { signal: deadline });
  } catch (error) {
    return anthropicFailure(error, deadline);
  }

  if (response.stop_reason === 'refusal') {
    return failure(422, 'refused', 'These notes could not be reviewed. Try a shorter part of the day, or add them by hand.');
  }
  if (response.stop_reason === 'max_tokens') {
    return failure(502, 'incomplete', 'The review came back incomplete. Paste a shorter part of the day.');
  }
  const text = response.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');

  try {
    const items = parseReviewOutput(text, reviewRequest);
    return reply({ items, remaining: typeof remaining === 'number' ? remaining : null });
  } catch (error) {
    const message = error instanceof ReviewOutputError ? error.message : 'The review came back unreadable.';
    return failure(502, 'bad_output', `${message} Try again.`);
  }
});
