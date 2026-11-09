// Calling the ai-assist Edge Function with the practitioner's own Anthropic
// key (supabase/functions/ai-assist). Each help sends only what it needs,
// and the function checks the answer before it comes back.

import { supabase } from './supabase';
import type { Rewrite, RewriteFacts } from './match-explanation';

export type AssistFailureReason =
  | 'offline' // no connection; try again later
  | 'key' // no key, or Anthropic refused this one: set it up again
  | 'limit' // the daily cap
  | 'refused' // the model declined
  | 'checked' // the answer did not keep to the facts; the app's own version stands
  | 'unavailable'; // anything else, usually passing

export class AssistUnavailableError extends Error {
  constructor(message: string, readonly reason: AssistFailureReason) {
    super(message);
  }
}

type FunctionErrorBody = { error?: { code?: string; message?: string } };

async function functionErrorBody(error: unknown): Promise<FunctionErrorBody> {
  const context = (error as { context?: unknown }).context;
  if (context && typeof (context as Response).json === 'function') {
    try {
      return await (context as Response).clone().json() as FunctionErrorBody;
    } catch {
      return {};
    }
  }
  return {};
}

const OFFLINE_MESSAGE = 'No connection. Try again when you are back online.';
const KEY_CODES = ['key_required', 'key_invalid', 'key_forbidden'];
// The function answers within about 45 seconds; stop waiting just after.
const AI_ASSIST_CLIENT_TIMEOUT_MS = 50_000;

async function invokeAssist(action: string, payload: Record<string, unknown>, apiKey: string): Promise<unknown> {
  let result: Awaited<ReturnType<typeof supabase.functions.invoke>>;
  try {
    result = await supabase.functions.invoke('ai-assist', {
      body: { action, ...payload, anthropicKey: apiKey },
      timeout: AI_ASSIST_CLIENT_TIMEOUT_MS,
    });
  } catch {
    throw new AssistUnavailableError(OFFLINE_MESSAGE, 'offline');
  }
  if (result.error) {
    const name = (result.error as { name?: string }).name || '';
    const cause = (result.error as { context?: { name?: unknown } }).context;
    if (name === 'FunctionsFetchError' && cause?.name === 'AbortError') {
      throw new AssistUnavailableError('That took too long. Try again.', 'unavailable');
    }
    if (name === 'FunctionsFetchError' || name === 'FunctionsRelayError') throw new AssistUnavailableError(OFFLINE_MESSAGE, 'offline');
    const payloadBody = await functionErrorBody(result.error);
    const code = payloadBody.error?.code || '';
    const message = payloadBody.error?.message || 'This is unavailable right now.';
    if (KEY_CODES.includes(code)) throw new AssistUnavailableError(message, 'key');
    if (code === 'daily_limit') throw new AssistUnavailableError(message, 'limit');
    if (code === 'refused') throw new AssistUnavailableError(message, 'refused');
    if (code === 'bad_output') throw new AssistUnavailableError(`${message} Your own version is unchanged.`, 'checked');
    throw new AssistUnavailableError(message, 'unavailable');
  }
  const data = result.data as { result?: unknown } | null;
  if (!data || !data.result || typeof data.result !== 'object') {
    throw new AssistUnavailableError('The answer came back unreadable. Try again.', 'unavailable');
  }
  return data.result;
}

/** Reads the function's rewrite defensively; anything malformed is dropped. */
export function readRewrite(value: unknown): Rewrite | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as { intro?: unknown; programs?: unknown };
  if (typeof input.intro !== 'string' || !Array.isArray(input.programs)) return null;
  const programs = input.programs.map((item) => {
    const entry = (item && typeof item === 'object' ? item : {}) as { rank?: unknown; text?: unknown };
    return { rank: Number(entry.rank), text: typeof entry.text === 'string' ? entry.text.trim() : '' };
  });
  if (programs.some((item) => !Number.isInteger(item.rank) || !item.text)) return null;
  return { intro: input.intro.trim(), programs };
}

/**
 * The family's explanation in warmer words. Sends only the facts
 * (rewriteFacts): program names, why each fits, why each comes first. No
 * names of people, no cautions or disclosures.
 */
export async function requestExplanationRewrite(facts: RewriteFacts, apiKey: string): Promise<Rewrite> {
  const rewrite = readRewrite(await invokeAssist('explain_matches', { facts }, apiKey));
  if (!rewrite) throw new AssistUnavailableError('The answer came back unreadable. Try again.', 'unavailable');
  return rewrite;
}
