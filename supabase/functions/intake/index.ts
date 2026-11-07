// Hosted intake link: GET serves a practice-branded form, POST creates the
// lead in that practice's workspace through create_lead_from_intake (service
// role). See docs/LEAD_CAPTURE.md for deployment.
//
// Two front ends share one pipeline:
//   * the website form at https://referralfit.com/intake/<token>, which calls
//     this function from the family's browser and speaks JSON (GET
//     ?format=json, POST application/json) under CORS for referralfit.com
//     only (intake.ts: corsHeaders, wantsJson, formFromJson);
//   * the function's own HTML form, for links shared before the website form.
//
// Safety properties:
//   * the token is validated by shape before any lookup and resolved on
//     every request, so a rotated link stops working at once;
//   * per-token and per-address fixed-window rate limits live in the
//     database (intake_rate_limit_hit); the address is only ever HMAC-hashed.
//     Every POST is charged to a loose per-address bucket; the per-token
//     buckets are charged only for a submission that would create a lead, so
//     junk posts cannot lock a practice's link (admitPost in intake.ts). A
//     lead past the link's hourly budget is still kept, marked possible spam
//     and without a push; only a much higher hard cap refuses it;
//   * a filled honeypot field is answered like a success and creates nothing;
//   * no submitted value is ever rendered back, logged, or returned;
//   * the pages carry no scripts and a strict CSP; JSON answers name only an
//     allowed origin, never '*', and never allow credentials.

import { createClient } from 'npm:@supabase/supabase-js@2.110.8';

import { bytesToHex, hmacSha256, requiredEnv } from '../_shared/webhooks.ts';
import {
  admitPost,
  allowedOrigins,
  clientAddress,
  corsHeaders,
  formFromJson,
  formPage,
  intakeRpcLead,
  JSON_MESSAGES,
  jsonError,
  MAX_JSON_BYTES,
  type RateLimit,
  thankYouPage,
  tokenFromPath,
  tooManyPage,
  unavailablePage,
  wantsJson,
} from './intake.ts';

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

// referralfit.com and www, plus INTAKE_EXTRA_ORIGINS for local testing only.
const ORIGINS = allowedOrigins(Deno.env.get('INTAKE_EXTRA_ORIGINS'));

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: HTML_HEADERS });
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...cors } });
}

function serviceClient() {
  return createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// The service role holds no table grants here; every read and write goes
// through a service-role-only RPC.
async function practiceName(supabase: ReturnType<typeof serviceClient>, token: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('intake_practice_name', { p_token: token });
  if (error) throw error;
  return typeof data === 'string' && data ? data : null;
}

async function rateLimitHit(
  supabase: ReturnType<typeof serviceClient>,
  bucket: string,
  limit: RateLimit,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('intake_rate_limit_hit', {
    p_bucket: bucket,
    p_limit: limit.perWindow,
    p_window_seconds: limit.windowSeconds,
  });
  if (error) throw error;
  return data === true;
}

async function addressHashOf(headers: Headers): Promise<string> {
  const address = clientAddress(headers);
  // Keyed with the service key so the stored bucket cannot be reversed to an
  // address without it; no extra secret to provision.
  return address ? bytesToHex(await hmacSha256(requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), address)).slice(0, 32) : '';
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.startsWith('application/x-www-form-urlencoded') && !contentType.startsWith('multipart/form-data')) {
    return null;
  }
  const body = await request.formData();
  const form = new URLSearchParams();
  for (const [key, value] of body.entries()) {
    if (typeof value === 'string') form.set(key, value);
  }
  return form;
}

// The body, read only up to `max` bytes. null: larger than that.
async function readCappedText(request: Request, max: number): Promise<string | null> {
  if (Number(request.headers.get('content-length') || '0') > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function readJsonForm(request: Request): Promise<URLSearchParams | null> {
  const text = await readCappedText(request, MAX_JSON_BYTES);
  return text === null ? null : formFromJson(text);
}

// A failure's code and message for the log. supabase-js RPC errors are plain
// objects, which String() turns into "[object Object]". Never `details`, which
// can quote a row; nothing a family typed is logged.
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const { code, message } = error as { code?: unknown; message?: unknown };
    const text = [code, message].filter((part) => typeof part === 'string' && part).join(' ');
    if (text) return text;
  }
  return 'unknown error';
}

Deno.serve(async (request) => {
  const url = new URL(request.url);
  const cors = corsHeaders(request.headers.get('origin'), ORIGINS);

  // Preflight for the website form: answered before any lookup or body read.
  // A disallowed origin gets no Access-Control headers, so its JSON POST is
  // never sent.
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const asJson = wantsJson(request.method, url, request.headers.get('content-type'));
  const notFound = () =>
    asJson ? json(jsonError('not_found', JSON_MESSAGES.not_found), 404, cors) : html(unavailablePage(), 404);

  const token = tokenFromPath(url.pathname);
  if (!token) return notFound();
  if (request.method !== 'GET' && request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, POST, OPTIONS', ...cors } });
  }

  try {
    const supabase = serviceClient();
    const name = await practiceName(supabase, token);
    if (!name) return notFound();

    if (request.method === 'GET') return asJson ? json({ practice_name: name }, 200, cors) : html(formPage(name));

    const parsed = await admitPost(
      token,
      await addressHashOf(request.headers),
      () => (asJson ? readJsonForm(request) : readForm(request)),
      (bucket, limit) => rateLimitHit(supabase, bucket, limit),
    );
    if (parsed.kind === 'limited') {
      return asJson ? json(jsonError('rate_limited', JSON_MESSAGES.rate_limited), 429, cors) : html(tooManyPage(), 429);
    }
    if (parsed.kind === 'bad_content_type') {
      return asJson
        ? json(jsonError('invalid', JSON_MESSAGES.bad_request), 400, cors)
        : html(formPage(name, JSON_MESSAGES.bad_request), 400);
    }
    if (parsed.kind === 'honeypot') return asJson ? json({ ok: true }, 200, cors) : html(thankYouPage(name));
    if (parsed.kind === 'invalid') {
      return asJson ? json(jsonError('invalid', parsed.reason), 400, cors) : html(formPage(name, parsed.reason), 400);
    }

    const { error } = await supabase.rpc('create_lead_from_intake', { p_token: token, p_lead: intakeRpcLead(parsed) });
    if (error) {
      if (error.code === 'P0002') return notFound();
      if (error.code === '22023') {
        return asJson
          ? json(jsonError('invalid', JSON_MESSAGES.check_fields), 400, cors)
          : html(formPage(name, JSON_MESSAGES.check_fields), 400);
      }
      throw error;
    }
    return asJson ? json({ ok: true }, 200, cors) : html(thankYouPage(name));
  } catch (error) {
    console.error('intake failed', describeError(error));
    return asJson
      ? json(jsonError('server_error', JSON_MESSAGES.server_error), 500, cors)
      : html(formPage('the practice', JSON_MESSAGES.server_error), 500);
  }
});
