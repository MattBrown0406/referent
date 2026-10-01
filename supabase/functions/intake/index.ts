// Hosted intake link: GET serves a practice-branded form, POST creates the
// lead in that practice's workspace through create_lead_from_intake (service
// role). See docs/LEAD_CAPTURE.md for deployment.
//
// Safety properties:
//   * the token is validated by shape before any lookup and resolved on
//     every request, so a rotated link stops working at once;
//   * per-token and per-address fixed-window rate limits live in the
//     database (intake_rate_limit_hit); the address is only ever HMAC-hashed;
//   * a filled honeypot field is answered with the thank-you page and
//     creates nothing;
//   * no submitted value is ever rendered back, logged, or returned;
//   * the pages carry no scripts and a strict CSP.

import { createClient } from 'npm:@supabase/supabase-js@2.110.8';

import { bytesToHex, hmacSha256, requiredEnv } from '../_shared/webhooks.ts';
import {
  bucketNames,
  clientAddress,
  formPage,
  IP_LIMIT,
  parseSubmission,
  thankYouPage,
  TOKEN_LIMIT,
  tokenFromPath,
  tooManyPage,
  unavailablePage,
} from './intake.ts';

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: HTML_HEADERS });
}

function serviceClient() {
  return createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function practiceName(supabase: ReturnType<typeof serviceClient>, token: string): Promise<string | null> {
  const { data, error } = await supabase.from('orgs').select('name').eq('intake_token', token).maybeSingle();
  if (error) throw error;
  return data?.name ? String(data.name) : null;
}

async function rateLimitHit(
  supabase: ReturnType<typeof serviceClient>,
  bucket: string,
  limit: { perWindow: number; windowSeconds: number },
): Promise<boolean> {
  const { data, error } = await supabase.rpc('intake_rate_limit_hit', {
    p_bucket: bucket,
    p_limit: limit.perWindow,
    p_window_seconds: limit.windowSeconds,
  });
  if (error) throw error;
  return data === true;
}

async function withinLimits(supabase: ReturnType<typeof serviceClient>, token: string, headers: Headers): Promise<boolean> {
  const address = clientAddress(headers);
  // Keyed with the service key so the stored bucket cannot be reversed to an
  // address without it; no extra secret to provision.
  const addressHash = address ? bytesToHex(await hmacSha256(requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), address)).slice(0, 32) : '';
  const buckets = bucketNames(token, addressHash);
  const checks = [rateLimitHit(supabase, buckets.token, TOKEN_LIMIT)];
  if (buckets.ip) checks.push(rateLimitHit(supabase, buckets.ip, IP_LIMIT));
  return (await Promise.all(checks)).every(Boolean);
}

Deno.serve(async (request) => {
  const url = new URL(request.url);
  const token = tokenFromPath(url.pathname);
  if (!token) return html(unavailablePage(), 404);
  if (request.method !== 'GET' && request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, POST' } });
  }

  try {
    const supabase = serviceClient();
    const name = await practiceName(supabase, token);
    if (!name) return html(unavailablePage(), 404);
    const actionUrl = url.pathname;

    if (request.method === 'GET') return html(formPage(name, actionUrl));

    if (!(await withinLimits(supabase, token, request.headers))) return html(tooManyPage(), 429);

    const contentType = request.headers.get('content-type') || '';
    if (!contentType.startsWith('application/x-www-form-urlencoded') && !contentType.startsWith('multipart/form-data')) {
      return html(formPage(name, actionUrl, 'Please use the form on this page.'), 400);
    }
    const body = await request.formData();
    const form = new URLSearchParams();
    for (const [key, value] of body.entries()) {
      if (typeof value === 'string') form.set(key, value);
    }
    const parsed = parseSubmission(form);
    if (parsed.kind === 'honeypot') return html(thankYouPage(name));
    if (parsed.kind === 'invalid') return html(formPage(name, actionUrl, parsed.reason), 400);

    const { error } = await supabase.rpc('create_lead_from_intake', { p_token: token, p_lead: parsed.lead });
    if (error) {
      if (error.code === 'P0002') return html(unavailablePage(), 404);
      if (error.code === '22023') return html(formPage(name, actionUrl, 'Please check your name and phone number and try again.'), 400);
      throw error;
    }
    return html(thankYouPage(name));
  } catch (error) {
    console.error('intake failed', error instanceof Error ? error.message : String(error));
    return html(formPage('the practice', url.pathname, 'Something went wrong on our side. Please try again in a moment, or call the practice directly.'), 500);
  }
});
