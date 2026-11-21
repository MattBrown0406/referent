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
//   * read_card: the insurance card photos of a family assessment, read
//     into the case's Benefits (read_card.ts). The photos are downloaded
//     with the CALLER's own session, so storage row-level security decides
//     access (never the service role); only the carrier, plan name, last
//     four of the member ID and a short note come back, for the
//     practitioner to check before anything is saved.
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
//   * the model sees only what the action sends (no names of people; the
//     card photos for read_card, which the practitioner chose to send);
//   * neither the input nor the result is logged or stored here.

import Anthropic from 'npm:@anthropic-ai/sdk@1.1.0';
import { createClient } from 'npm:@supabase/supabase-js@2.110.8';

import { requiredEnv } from '../_shared/webhooks.ts';
import { AssistFailure, AssistOutputError, AssistRequestError, parseApiKey, record } from './common.ts';
import {
  buildExplainPrompt,
  EXPLAIN_SYSTEM_PROMPT,
  explainSchema,
  parseExplainOutput,
  parseExplainRequest,
} from './explain.ts';
import { buildLevelPrompt, LEVEL_SYSTEM_PROMPT, levelSchema, parseLevelOutput, parseLevelRequest } from './level.ts';
import {
  CARD_SYSTEM_PROMPT,
  cardPrompt,
  cardSchema,
  type CardAssessmentRow,
  type CardStore,
  loadCardFiles,
  parseCardOutput,
  parseCardRequest,
} from './read_card.ts';

// The same model as AI drafts and day review.
const MODEL = 'claude-opus-5-5';

// The phone stops waiting at AI_ASSIST_CLIENT_TIMEOUT_MS (src/lib/ai-assist-api.ts);
// the model call ends inside this, with no SDK retry that could not finish.
const DEADLINE_MS = 45_000;

type Job = {
  /** The user turn: text, or content blocks (read_card's photos). */
  prompt: string | Record<string, unknown>[];
  schema: Record<string, unknown>;
  check: (raw: string) => unknown;
};

type Action = {
  /** claim_ai_assist's kind. */
  kind: string;
  system: string;
  maxTokens: number;
  /** What the phone shows when the model declines. */
  refused?: string;
  /** Runs before the daily cap is claimed, so a refusal here costs nothing. */
  parse: (body: unknown, caller: { token: string }) => Job | Promise<Job>;
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
  read_card: {
    kind: 'read_card',
    system: CARD_SYSTEM_PROMPT,
    maxTokens: 8000,
    refused: 'The card could not be read. Type the details into Benefits from the photo instead.',
    parse: async (body, caller) => {
      const request = parseCardRequest(body);
      const { files, skipped } = await loadCardFiles(callerCardStore(caller.token), request);
      return { prompt: cardPrompt(request, files), schema: cardSchema(request), check: (raw) => parseCardOutput(raw, request, skipped) };
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

// The project's public (anon) key: with the caller's access token on top,
// every read below runs as that user, under row-level security.
function publicKey(): string {
  const anon = Deno.env.get('SUPABASE_ANON_KEY');
  if (anon) return anon;
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}') as Record<string, unknown>;
    const key = keys.default ?? Object.values(keys)[0];
    if (typeof key === 'string' && key) return key;
  } catch {
    // fall through
  }
  throw new AssistFailure(503, 'not_configured', 'This is not set up yet.');
}

// The insurance card photos, read as the caller: the assessment row through
// its RLS (members of the case's practice) and the files through the
// assessment-files storage policy. Never the service role. All the reads of
// one request share 20 seconds, so the model keeps most of the deadline.
const CARD_READ_MS = 20_000;
const CARD_SHRINK = { width: 2000, height: 2000, resize: 'contain' as const, quality: 80 };

function callerCardStore(token: string): CardStore {
  const client = createClient(requiredEnv('SUPABASE_URL'), publicKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const signal = AbortSignal.timeout(CARD_READ_MS);
  return {
    async assessment(id) {
      const { data, error } = await client
        .from('family_assessments')
        .select('id, case_id, card_front_path, card_back_path')
        .eq('id', id)
        .abortSignal(signal)
        .maybeSingle();
      if (error) return { row: null, failed: true };
      return { row: (data as CardAssessmentRow | null) ?? null, failed: false };
    },
    async download(path, shrink) {
      const { data, error } = await client.storage
        .from('assessment-files')
        .download(path, shrink ? { transform: CARD_SHRINK } : {}, { signal });
      if (error || !data) {
        // Storage answers 400/404 for a file that is gone or not the caller's to read.
        const status = (error as { status?: number } | null)?.status;
        return { bytes: null, missing: status === 400 || status === 404 };
      }
      return { bytes: new Uint8Array(await data.arrayBuffer()), missing: false };
    },
  };
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

  let job: Job;
  try {
    job = await action.parse(body, { token });
  } catch (error) {
    if (error instanceof AssistFailure) return failure(error.status, error.code, error.message);
    if (error instanceof AssistRequestError) return failure(400, 'bad_request', error.message);
    if (action.kind === 'read_card') {
      console.error('read_card: the photos could not be loaded');
      return failure(503, 'busy', 'The card photos could not be loaded. Try again in a minute.');
    }
    return failure(400, 'bad_request', 'The request could not be read.');
  }

  const { data: remaining, error: claimError } = await supabase.rpc('claim_ai_assist', { p_user_id: userId, p_kind: action.kind });
  if (claimError) {
    if (claimError.code === '54000') return failure(429, 'daily_limit', 'You have reached today’s limit for this. Try again tomorrow.');
    if (claimError.code === '42501') return failure(403, 'forbidden', 'Join a workspace first.');
    // Not set up yet: 20261109130000_ai_assist.sql not applied (no function),
    // or a kind added later whose migration is not applied yet (22023,
    // "Unknown kind of help": 20261121120000_read_card.sql). Run without the cap.
    if (claimError.code !== 'PGRST202' && claimError.code !== '42883' && claimError.code !== '22023') {
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
      messages: [{ role: 'user', content: job.prompt as string | Anthropic.Beta.Messages.BetaContentBlockParam[] }],
    }, { signal: deadline });
  } catch (error) {
    return anthropicFailure(error, deadline);
  }

  if (response.stop_reason === 'refusal') return failure(422, 'refused', action.refused ?? 'This could not be done. The app’s own version is shown.');
  if (response.stop_reason === 'max_tokens') return failure(502, 'incomplete', 'The answer came back incomplete. Try again.');
  const text = response.content.map((block) => (block.type === 'text' ? block.text : '')).join('');

  try {
    const result = job.check(text);
    return reply({ result, remaining: typeof remaining === 'number' ? remaining : null });
  } catch (error) {
    if (error instanceof AssistFailure) return failure(error.status, error.code, error.message);
    const message = error instanceof AssistOutputError ? error.message : 'The answer came back unreadable.';
    return failure(502, 'bad_output', message);
  }
});
