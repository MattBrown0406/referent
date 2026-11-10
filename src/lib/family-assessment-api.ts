// The family assessment's calls (docs/FAMILY_ASSESSMENT.md): the case's
// assessments (read under row-level security), sending a link (by email
// through Resend, or to copy and text), stopping one, deleting one with its
// card photos, short-lived links to the photos, and the practice logo.

import { describeError } from './errors';
import { assessmentFromRow, assessmentLink, type FamilyAssessment } from './family-assessment';
import { supabase } from './supabase';

export class AssessmentError extends Error {}

// The app can reach a phone before the server change it needs (a table or a
// function PostgREST does not know yet): said plainly, never as a raw error.
const NOT_READY = new Set(['PGRST205', 'PGRST202', '42P01', '42883']);

function fail(error: unknown, fallback: string): never {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
  if (NOT_READY.has(code)) {
    // The detail stays findable (a half-applied server change reads the same).
    console.warn('family assessment: the server is not ready', code, fallback);
    throw new AssessmentError('Family assessments are not available yet. Try again a little later.');
  }
  throw new AssessmentError(describeError(error, fallback));
}

export async function listFamilyAssessments(caseId: string): Promise<FamilyAssessment[]> {
  const { data, error } = await supabase
    .from('family_assessments')
    .select('*')
    .eq('case_id', caseId)
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) fail(error, 'The family assessment could not be loaded.');
  return (data || []).map(assessmentFromRow).filter((item): item is FamilyAssessment => Boolean(item));
}

/** `link` is null for an email: its link is made when the email goes out. */
export type SentLink = { id: string; link: string | null; expiresAt: string };

/**
 * The case's assessment (the open one, or a new one) sent again. With
 * `sendEmail`, ReferralFit emails a new link to `email` in the practice's
 * name. Otherwise a new link comes back to copy or text (pass '' as the
 * email so the address on the assessment stays as it is).
 */
export async function sendFamilyAssessment(caseId: string, name: string, email: string, sendEmail: boolean): Promise<SentLink> {
  const { data, error } = await supabase.rpc('family_assessment_send', {
    p_case_id: caseId,
    p_name: name.trim(),
    p_email: email.trim(),
    p_send_email: sendEmail,
  });
  if (error) fail(error, 'The assessment could not be sent.');
  const result = (data || {}) as { id?: unknown; token?: unknown; expires_at?: unknown };
  const token = typeof result.token === 'string' && /^[0-9a-f]{64}$/.test(result.token) ? result.token : null;
  if (typeof result.id !== 'string' || (!sendEmail && !token)) {
    throw new AssessmentError('The assessment could not be sent. Try again.');
  }
  return { id: result.id, link: token ? assessmentLink(token) : null, expiresAt: typeof result.expires_at === 'string' ? result.expires_at : '' };
}

export async function revokeFamilyAssessment(id: string): Promise<void> {
  const { error } = await supabase.rpc('family_assessment_revoke', { p_id: id });
  if (error) fail(error, 'The link could not be stopped.');
}

/** Every file in an assessment's folder (its card photos, current and any left over). */
export async function assessmentFolderFiles(caseId: string, id: string): Promise<string[]> {
  const folder = `${caseId}/${id}`;
  const files: string[] = [];
  // Page by page: a listing stops at 100, and every photo must go.
  for (let offset = 0; offset < 10_000; offset += 100) {
    const { data, error } = await supabase.storage.from('assessment-files').list(folder, { limit: 100, offset });
    if (error) throw error;
    const page = data || [];
    files.push(...page.filter((item) => item.name && item.id).map((item) => `${folder}/${item.name}`));
    if (page.length < 100) break;
  }
  return files;
}

/**
 * Deletes the answers and the card photos for good: the links stop first
 * (so no photo can arrive while it is deleted), then the photos, then the row.
 */
export async function deleteFamilyAssessment(assessment: FamilyAssessment): Promise<void> {
  if (assessment.status === 'sent' || assessment.status === 'started') {
    const { error: stopError } = await supabase.rpc('family_assessment_revoke', { p_id: assessment.id });
    // P0002: already stopped, expired or finished; deleting goes on.
    if (stopError && stopError.code !== 'P0002') fail(stopError, 'The link could not be stopped, so nothing was deleted. Try again.');
  }
  try {
    const files = await assessmentFolderFiles(assessment.caseId, assessment.id);
    if (files.length) {
      const { error: removeError } = await supabase.storage.from('assessment-files').remove(files);
      if (removeError) throw removeError;
    }
  } catch (removeError) {
    fail(removeError, 'The card photos could not be deleted, so the answers were kept. Try again.');
  }
  const { error } = await supabase.rpc('family_assessment_delete', { p_id: assessment.id });
  if (error) fail(error, 'The assessment could not be deleted.');
}

/** Links to the card photos that work for five minutes. */
export async function cardPhotoUrls(assessment: FamilyAssessment): Promise<{ front: string | null; back: string | null }> {
  const sign = async (path: string) => {
    if (!path) return null;
    const { data, error } = await supabase.storage.from('assessment-files').createSignedUrl(path, 300);
    return error || !data?.signedUrl ? null : data.signedUrl;
  };
  const [front, back] = await Promise.all([sign(assessment.cardFrontPath), sign(assessment.cardBackPath)]);
  return { front, back };
}

// ─── The practice logo (owner only) ─────────────────────────────────────────

export const LOGO_TYPES: Record<string, 'png' | 'jpg' | 'webp'> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** The logo's public address, for showing it. */
export function logoPublicUrl(path: string | null | undefined): string | null {
  return path ? supabase.storage.from('org-logos').getPublicUrl(path).data.publicUrl : null;
}

/** A logo's type from its name when the picker gives none. */
export function logoTypeFor(mimeType: string | null | undefined, name: string | null | undefined): string {
  if (mimeType && LOGO_TYPES[mimeType]) return mimeType;
  if (mimeType) return '';
  const extension = /[.]([a-z0-9]+)(?:[?#].*)?$/i.exec(name || '')?.[1]?.toLowerCase();
  return extension === 'png' ? 'image/png' : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : extension === 'webp' ? 'image/webp' : '';
}

// Logo files to keep besides the new one: the one before it, so invites
// already delivered (they show the logo by its address) keep showing one.
async function removeOlderLogos(orgId: string, keep: string[]): Promise<void> {
  const { data, error } = await supabase.storage.from('org-logos').list(orgId, { limit: 100 });
  if (error) return;
  const old = (data || []).map((item) => `${orgId}/${item.name}`).filter((path) => isLogoFile(path) && !keep.includes(path));
  if (old.length) await supabase.storage.from('org-logos').remove(old);
}

function isLogoFile(path: string): boolean {
  return /\/logo-[0-9]{10,16}[.](png|jpg|webp)$/.test(path);
}

/**
 * Uploads a new logo (PNG, JPEG or WebP, up to 1 MB) into the practice's
 * folder and makes it the one families see. The one before it stays (for
 * invites already delivered); older ones are removed.
 */
export async function uploadPracticeLogo(orgId: string, bytes: ArrayBuffer, mimeType: string, previous: string | null): Promise<string> {
  const extension = LOGO_TYPES[mimeType];
  if (!extension) throw new AssessmentError('Choose a PNG, JPEG or WebP image.');
  if (bytes.byteLength > 1024 * 1024) {
    const size = (bytes.byteLength / (1024 * 1024)).toFixed(1);
    throw new AssessmentError(`That image is ${size} MB. Choose a logo file under 1 MB: the PNG or JPEG from your website works best.`);
  }
  // Room first: the practice keeps at most a few logo files.
  await removeOlderLogos(orgId, [previous || '']);
  const path = `${orgId}/logo-${Date.now()}.${extension}`;
  const { error: uploadError } = await supabase.storage.from('org-logos').upload(path, bytes, { contentType: mimeType, upsert: false });
  if (uploadError) fail(uploadError, 'The logo could not be uploaded.');
  const { error } = await supabase.rpc('set_org_logo', { p_path: path });
  if (error) {
    await supabase.storage.from('org-logos').remove([path]);
    fail(error, 'The logo could not be saved.');
  }
  await removeOlderLogos(orgId, [path, previous || '']);
  return path;
}

/** No logo: families see the practice's name alone. The files are removed. */
export async function removePracticeLogo(orgId: string): Promise<void> {
  const { error } = await supabase.rpc('set_org_logo', { p_path: null });
  if (error) fail(error, 'The logo could not be removed.');
  await removeOlderLogos(orgId, []);
}
