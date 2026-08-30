import { createClient } from 'npm:@supabase/supabase-js@2.110.8';

type Json = Record<string, unknown>;
type SupabaseError = { code?: string } | null;

const MAX_BODY_BYTES = 32 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9 ().-]{7,40}$/;
const TOKEN_RE = /^[0-9a-f]{64}$/i;
const HANDOFF_STATES = new Set([
  'sent',
  'received',
  'contact_attempted',
  'family_reached',
  'consult_scheduled',
  'closed',
]);

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing required environment setting: ${name}`);
  return value;
}

function allowedOrigins(): Set<string> {
  return new Set(requiredEnv('PUBLIC_REFERRALS_ALLOWED_ORIGINS').split(',').map((value) => value.trim()).filter(Boolean));
}

function corsHeaders(origin: string): HeadersInit {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-request-id',
    'access-control-max-age': '600',
    'vary': 'Origin',
  };
}

function response(origin: string, body: Json, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function objectValue(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function readLimitedJson(request: Request): Promise<Json> {
  const length = Number(request.headers.get('content-length') || '0');
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new Error('body_too_large');
  if (!request.body) throw new Error('invalid_body');

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error('body_too_large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return objectValue(JSON.parse(new TextDecoder().decode(bytes)));
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return request.headers.get('cf-connecting-ip')?.trim() || forwarded || 'unavailable';
}

async function ipHash(ip: string, sourceId: string): Promise<string> {
  const pepper = requiredEnv('REFERRAL_RATE_LIMIT_PEPPER');
  const bytes = new TextEncoder().encode(`${pepper}\u0000${sourceId}\u0000${ip}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function safeLog(action: string, status: number, error: SupabaseError = null): void {
  console.error('public-referrals request failed', {
    action: action.slice(0, 40),
    status,
    code: error?.code || 'request_error',
  });
}

Deno.serve(async (request) => {
  let origin = '';
  let action = '';
  try {
    origin = request.headers.get('origin') || '';
    if (!origin || !allowedOrigins().has(origin)) {
      return new Response(JSON.stringify({ error: 'Request denied' }), {
        status: 403,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== 'POST') return response(origin, { error: 'Request failed' }, 405);
    if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
      return response(origin, { error: 'Request failed' }, 415);
    }

    const body = await readLimitedJson(request);
    action = stringValue(body.action);
    const supabase = createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    if (action === 'intake.resolve') {
      const sourceId = stringValue(body.sourceId);
      if (!UUID_RE.test(sourceId)) return response(origin, { error: 'Link unavailable' }, 404);
      const { data, error } = await supabase.rpc('public_referral_source_resolve', { p_source_id: sourceId });
      if (error || !Array.isArray(data) || data.length !== 1) {
        if (error) safeLog(action, 404, error);
        return response(origin, { error: 'Link unavailable' }, 404);
      }
      const source = objectValue(data[0]);
      return response(origin, {
        sourceId: source.source_id,
        practiceDisplay: source.practice_display,
        sourceDisplay: source.source_display,
      });
    }

    if (action === 'intake.submit') {
      const sourceId = stringValue(body.sourceId);
      const idempotencyKey = stringValue(body.idempotencyKey);
      const firstName = stringValue(body.firstName);
      const lastName = stringValue(body.lastName);
      const phone = stringValue(body.phone);
      const email = stringValue(body.email).toLowerCase();
      const honeypot = stringValue(body.website);
      const callbackConsent = body.callbackConsent === true;
      const privacyConsent = body.privacyConsent === true;

      if (honeypot || !UUID_RE.test(sourceId) || !UUID_RE.test(idempotencyKey)
        || firstName.length < 1 || firstName.length > 80 || lastName.length < 1 || lastName.length > 80
        || phone.length > 40 || email.length > 254 || (!phone && !email)
        || (phone.length > 0 && !PHONE_RE.test(phone)) || (email.length > 0 && !EMAIL_RE.test(email))
        || !callbackConsent || !privacyConsent) {
        return response(origin, { error: 'Submission could not be accepted' }, 400);
      }
      const { error } = await supabase.rpc('public_referral_intake_submit', {
        p_source_id: sourceId,
        p_idempotency_key: idempotencyKey,
        p_first_name: firstName,
        p_last_name: lastName,
        p_phone: phone,
        p_email: email,
        p_callback_consent: callbackConsent,
        p_privacy_consent: privacyConsent,
        p_ip_hash: await ipHash(clientIp(request), sourceId),
      });
      if (error) {
        const status = error.code === 'P0001' ? 429 : error.code === 'P0002' ? 404 : 400;
        safeLog(action, status, error);
        return response(origin, { error: 'Submission could not be accepted' }, status);
      }
      return response(origin, { accepted: true, message: 'Thank you. Your request has been received.' }, 202);
    }

    if (action === 'handoff.resolve') {
      const token = stringValue(body.token);
      if (!TOKEN_RE.test(token)) return response(origin, { error: 'Handoff unavailable' }, 404);
      const { data, error } = await supabase.rpc('public_referral_handoff_resolve', { p_token: token });
      if (error || !Array.isArray(data) || data.length !== 1) {
        if (error) safeLog(action, 404, error);
        return response(origin, { error: 'Handoff unavailable' }, 404);
      }
      const handoff = objectValue(data[0]);
      return response(origin, {
        clientAlias: handoff.client_alias,
        senderPracticeDisplay: handoff.sender_practice_display,
        recipientDisplay: handoff.recipient_display,
        status: handoff.status,
        version: handoff.version,
        allowedNextStatus: handoff.allowed_next_status,
      });
    }

    if (action === 'handoff.transition') {
      const token = stringValue(body.token);
      const nextStatus = stringValue(body.nextStatus);
      const expectedVersion = body.expectedVersion;
      if (!TOKEN_RE.test(token) || !HANDOFF_STATES.has(nextStatus)
        || typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
        return response(origin, { error: 'Transition could not be applied' }, 400);
      }
      const { data, error } = await supabase.rpc('public_referral_handoff_transition', {
        p_token: token,
        p_expected_version: expectedVersion,
        p_next_status: nextStatus,
      });
      if (error) {
        const status = error.code === '40001' ? 409 : error.code === 'P0002' ? 404 : error.code === '42501' ? 403 : 400;
        safeLog(action, status, error);
        return response(origin, { error: 'Transition could not be applied' }, status);
      }
      const result = objectValue(Array.isArray(data) ? data[0] : data);
      return response(origin, { status: result.status, version: result.version });
    }

    return response(origin, { error: 'Request failed' }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const status = message === 'body_too_large' ? 413 : 400;
    safeLog(action, status);
    return response(origin, { error: 'Request failed' }, status);
  }
});
