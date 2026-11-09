// family-assessment-upload: insurance card photos on a family assessment
// (docs/FAMILY_ASSESSMENT.md), for the family's page (the portal's /f,
// signed out), in two steps:
//   * sign: the link token and a side. This checks the link
//     (family_assessment_upload_path: an open assessment, front or back) and
//     answers with a one-time URL for a new name,
//     <case id>/<assessment id>/card-<side>-<32 hex>, in the private
//     assessment-files bucket. The page uploads straight to storage.
//   * done: the name it uploaded to. family_assessment_photo_done records it
//     (only while the assessment is open), and the photo it replaced is
//     removed here. An upload that finishes after the assessment was sent is
//     never recorded, so the photo the practitioner has never changes.
//
// Safety properties:
//   * no session: the 256-bit link token is the only key, checked by the
//     database (only its hash is stored);
//   * the path is chosen here from the assessment, never by the caller;
//   * the bucket is private, image types only, 10 MB (20261109140000);
//   * nothing about the request is logged.

import { createClient } from 'npm:@supabase/supabase-js@2.110.8';

import { requiredEnv } from '../_shared/webhooks.ts';
import { parseUploadRequest, uploadName, UploadRequestError } from './upload.ts';

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

  if (upload.action === 'done') {
    const { data: replaced, error } = await supabase.rpc('family_assessment_photo_done', {
      p_token: upload.token, p_side: upload.side, p_path: upload.path,
    });
    if (error) {
      if (error.code === 'P0002' || error.code === '22023') {
        // Not recorded (sent, stopped, deleted, or not this assessment's):
        // an upload that did land is removed, unless it is the photo some
        // assessment already shows. The name was checked (parseUploadRequest).
        const { data: recorded, error: checkError } = await supabase.rpc('family_assessment_photo_recorded', { p_path: upload.path });
        if (!checkError && recorded === false) {
          const { error: removeError } = await supabase.storage.from('assessment-files').remove([upload.path]);
          if (removeError) console.error('removing an unrecorded card photo failed');
        }
        return error.code === 'P0002'
          ? failure(404, 'not_active', error.message || 'This link is not active.')
          : failure(400, 'bad_request', 'The photo could not be matched. Choose it again.');
      }
      console.error('family_assessment_photo_done failed', error.code || 'unknown');
      return failure(500, 'server_error', 'The photo could not be saved right now. Try again.');
    }
    // The photo this one replaced, and any other upload of this side that
    // never got recorded (a tab closed between upload and done): nobody
    // sees them any more.
    const folder = upload.path.slice(0, upload.path.lastIndexOf('/'));
    const { data: listed } = await supabase.storage.from('assessment-files').list(folder, { limit: 100 });
    const stale = new Set((listed || [])
      .map((item) => `${folder}/${item.name}`)
      .filter((path) => path !== upload.path && path.startsWith(`${folder}/card-${upload.side}-`)));
    if (typeof replaced === 'string' && replaced) stale.add(replaced);
    if (stale.size) {
      const { error: removeError } = await supabase.storage.from('assessment-files').remove([...stale]);
      if (removeError) console.error('removing replaced card photos failed');
    }
    return reply({ done: true });
  }

  const { data: prefix, error } = await supabase.rpc('family_assessment_upload_path', { p_token: upload.token, p_side: upload.side });
  if (error) {
    console.error('family_assessment_upload_path failed', error.code || 'unknown');
    return failure(500, 'server_error', 'The photo could not be sent right now. Try again.');
  }
  if (typeof prefix !== 'string' || !prefix) return failure(404, 'not_active', 'This link is not active.');

  const { data: signed, error: signError } = await supabase.storage
    .from('assessment-files')
    .createSignedUploadUrl(uploadName(prefix));
  if (signError || !signed) {
    console.error('createSignedUploadUrl failed');
    return failure(500, 'server_error', 'The photo could not be sent right now. Try again.');
  }
  return reply({ path: signed.path, token: signed.token });
});
