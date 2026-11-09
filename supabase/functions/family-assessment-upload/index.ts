// family-assessment-upload: a signed upload URL for one insurance card photo
// on a family assessment (docs/FAMILY_ASSESSMENT.md). The family's page (the
// portal's /f, signed out) sends its link token and which side; this checks
// the link (family_assessment_upload_path: an open assessment, front or
// back) and answers with a one-time URL for exactly
// <case id>/<assessment id>/card-<side> in the private assessment-files
// bucket. The page uploads straight to storage, then calls
// public_family_assessment_photo_done.
//
// Safety properties:
//   * no session: the 256-bit link token is the only key, checked by the
//     database (only its hash is stored);
//   * the path is chosen here from the assessment, never by the caller;
//   * the bucket is private, image types only, 10 MB (20261109140000);
//   * nothing about the request is logged.

import { createClient } from 'npm:@supabase/supabase-js@2.110.8';

import { requiredEnv } from '../_shared/webhooks.ts';
import { parseUploadRequest, UploadRequestError } from './upload.ts';

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

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'POST') return failure(405, 'method_not_allowed', 'Use POST.');

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return failure(400, 'bad_request', 'The request could not be read.');
  }
  let upload: ReturnType<typeof parseUploadRequest>;
  try {
    upload = parseUploadRequest(body);
  } catch (error) {
    return failure(400, 'bad_request', error instanceof UploadRequestError ? error.message : 'The request could not be read.');
  }

  let supabase;
  try {
    supabase = createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch {
    return failure(503, 'not_configured', 'Photo uploads are not set up yet.');
  }

  const { data: path, error } = await supabase.rpc('family_assessment_upload_path', { p_token: upload.token, p_side: upload.side });
  if (error) {
    console.error('family_assessment_upload_path failed', error.code || 'unknown');
    return failure(500, 'server_error', 'The photo could not be sent right now. Try again.');
  }
  if (typeof path !== 'string' || !path) return failure(404, 'not_active', 'This link is not active.');

  const { data: signed, error: signError } = await supabase.storage
    .from('assessment-files')
    .createSignedUploadUrl(path, { upsert: true });
  if (signError || !signed) {
    console.error('createSignedUploadUrl failed');
    return failure(500, 'server_error', 'The photo could not be sent right now. Try again.');
  }
  return reply({ path: signed.path, token: signed.token });
});
