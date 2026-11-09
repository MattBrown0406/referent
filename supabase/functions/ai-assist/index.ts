// ai-assist: small AI helps for practitioners who added their own Anthropic
// key, each one checked before it reaches the app:
//
//   * explain_matches: the family's "why these programs", rewritten in
//     warmer words from the app's own ranking (explain.ts). It explains the
//     order; it cannot change it.
//   * level_of_care: a suggested rating for each of the six level-of-care
//     areas from a family assessment's answers, sent without names or
//     contact details (level.ts). The practitioner confirms every rating;
//     the app's own rules recommend the level.
//
// Bring your own key, exactly like AI drafts (draft-follow-up) and day
// review: the user's Anthropic key arrives in the request body
// (`anthropicKey`), never a header, is used for this one call, and is never
// stored, logged, or echoed back.
//
// Safety properties:
//   * every request must carry a signed-in user's access token, checked
//     against Supabase Auth before anything else happens;
//   * claim_ai_assist (service-role only) confirms workspace membership and
//     enforces a daily cap per kind before the model is called;
//   * the model sees only what the action sends (no names of people);
//   * neither the input nor the result is logged or stored here.

import Anthropic from 'npm:@anthropic-ai/sdk@1.1.0';
import { createClient } from 'npm:@supabase/supabase-js@2.110.8';

import { requiredEnv } from '../_shared/webhooks.ts';
import { AssistOutputError, AssistRequestError, parseApiKey, record } from './common.ts';
import {
  buildExplainPrompt,
  EXPLAIN_SYSTEM_PROMPT,
  explainSchema,
  parseExplainOutput,
  parseExplainRequest,
} from './explain.ts';
import { buildLevelPrompt, LEVEL_SYSTEM_PROMPT, levelSchema, parseLevelOutput, parseLevelRequest } from './level.ts';

// The same model as AI drafts and day review.
const MODEL = 'claude-opus-5-5';

// The phone stops waiting at AI_ASSIST_CLIENT_TIMEOUT_MS (src/lib/ai-assist-api.ts);
// the model call ends inside this, with no SDK retry that could not finish.
const DEADLINE_MS = 45_000;

type Action = {
  /** claim_ai_assist's kind. */
  kind: string;
  system: string;
  maxTokens: number;
  parse: (body: unknown) => { prompt: string; schema: Record<string, unknown>; check: (raw: string) => unknown };
};

const ACTIONS: Record<string, Action> = {
  explain_matches: {
    kind: 'explain_matches',
    system: EXPLAIN_SYSTEM_PROMPT,
    maxTokens: 8000,
    parse: (body) => {
      const request = parseExplainRequest(body);
      return { prompt: buildExplainPrompt(request), schema: explainSchema(), check: (raw) => parseExplainOutput(raw, request) };
    },
  },
  level_of_care: {
    kind: 'level_of_care',
    system: LEVEL_SYSTEM_PROMPT,
    maxTokens: 8000,
    parse: (body) => {
      const request = parseLevelRequest(body);
      return { prompt: buildLevelPrompt(request), schema: levelSchema(), check: (raw) => ({ ratings: parseLevelOutput(raw, request) }) };
    },
  },
};

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
// on. Only the status code is ever logged (never the key or the input).
function anthropicFailure(error: unknown, deadline: AbortSignal): Response {
  if (deadline.aborted || error instanceof Anthropic.APIUserAbortError || error instanceof Anthropic.APIConnectionTimeoutError) {
    return failure(504, 'timeout', 'Anthropic took too long to answer. Try again.');
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return failure(401, 'key_invalid', 'Anthropic did not accept your API key. Check it in Workspace and settings, AI drafts.');
  }
  if (error instanceof Anthropic.PermissionDeniedError || error instanceof Anthropic.NotFoundError) {
    return failure(403, 'key_forbidden', 'Your API key cannot use the Claude model ReferralFit uses. Check the key’s workspace in the Anthropic Console.');
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
    return failure(503, 'busy', 'This is unavailable right now. Try again in a minute.');
  }
  console.error('Anthropic request failed');
  return failure(502, 'upstream_error', 'This is unavailable right now.');
}

Deno.serve(async (request) => {
  // The deadline runs from when the request arrived, so a slow start or
  // sign-in check never leaves the phone waiting past its own timeout.
  const startedAt = Date.now();
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'POST') return failure(405, 'method_not_allowed', 'Use POST.');

  const token = bearerToken(request);
  if (!token) return failure(401, 'unauthorized', 'Sign in first.');

  let supabase: ReturnType<typeof serviceClient>;
  try {
    supabase = serviceClient();
  } catch {
    return failure(503, 'not_configured', 'This is not set up yet.');
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  const userId = userData?.user?.id;
  if (userError || !userId) return failure(401, 'unauthorized', 'Your session has expired. Sign in again.');

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return failure(400, 'bad_request', 'The request could not be read.');
  }

  const actionName = String(record(body).action ?? '');
  const action = Object.hasOwn(ACTIONS, actionName) ? ACTIONS[actionName] : null;
  if (!action) return failure(400, 'bad_request', 'Unknown request.');

  const apiKey = parseApiKey(record(body).anthropicKey);
  if (!apiKey) return failure(400, 'key_required', 'Add your Anthropic API key first. It starts with sk-ant-.');

  let job: ReturnType<Action['parse']>;
  try {
    job = action.parse(body);
  } catch (error) {
    const message = error instanceof AssistRequestError ? error.message : 'The request could not be read.';
    return failure(400, 'bad_request', message);
  }

  const { data: remaining, error: claimError } = await supabase.rpc('claim_ai_assist', { p_user_id: userId, p_kind: action.kind });
  if (claimError) {
    if (claimError.code === '54000') return failure(429, 'daily_limit', 'You have reached today’s limit for this. Try again tomorrow.');
    if (claimError.code === '42501') return failure(403, 'forbidden', 'Join a workspace first.');
    // Not set up yet (20261109130000_ai_assist.sql not applied): run without the cap.
    if (claimError.code !== 'PGRST202' && claimError.code !== '42883') {
      console.error('claim_ai_assist failed', claimError.code);
      return failure(500, 'server_error', 'This is unavailable right now.');
    }
  }

  const timeLeft = Math.max(1_000, DEADLINE_MS - (Date.now() - startedAt));
  const anthropic = new Anthropic({ apiKey, timeout: timeLeft, maxRetries: 0 });
  const deadline = AbortSignal.timeout(timeLeft);
  let response;
  try {
    response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: action.maxTokens, // thinking is always on for this model; leave it room
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: job.schema },
      },
      system: action.system,
      messages: [{ role: 'user', content: job.prompt }],
    }, { signal: deadline });
  } catch (error) {
    return anthropicFailure(error, deadline);
  }

  if (response.stop_reason === 'refusal') return failure(422, 'refused', 'This could not be done. The app’s own version is shown.');
  if (response.stop_reason === 'max_tokens') return failure(502, 'incomplete', 'The answer came back incomplete. Try again.');
  const text = response.content.map((block) => (block.type === 'text' ? block.text : '')).join('');

  try {
    const result = job.check(text);
    return reply({ result, remaining: typeof remaining === 'number' ? remaining : null });
  } catch (error) {
    const message = error instanceof AssistOutputError ? error.message : 'The answer came back unreadable.';
    return failure(502, 'bad_output', message);
  }
});
