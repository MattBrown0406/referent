// The family assessment's calls (docs/FAMILY_ASSESSMENT.md): the case's
// assessments (read under row-level security), sending a link (by email
// through Resend, or to copy and text), stopping one, deleting one with its
// card photos, short-lived links to the photos, and the practice logo.

import { describeError } from './errors';
import { assessmentFromRow, assessmentLink, type FamilyAssessment } from './family-assessment';
import { supabase } from './supabase';

export class AssessmentError extends Error {}

function fail(error: unknown, fallback: string): never {
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

export type SentLink = { id: string; link: string; expiresAt: string };

/**
 * A new private link for the case's assessment (the open one, or a new one).
 * With `email`, ReferralFit emails it to the family in the practice's name;
 * the link also comes back to copy or text.
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
  if (typeof result.id !== 'string' || typeof result.token !== 'string' || !/^[0-9a-f]{64}$/.test(result.token)) {
    throw new AssessmentError('The assessment could not be sent. Try again.');
  }
  return { id: result.id, link: assessmentLink(result.token), expiresAt: typeof result.expires_at === 'string' ? result.expires_at : '' };
}

export async function revokeFamilyAssessment(id: string): Promise<void> {
  const { error } = await supabase.rpc('family_assessment_revoke', { p_id: id });
  if (error) fail(error, 'The link could not be stopped.');
}

function cardPath(assessment: FamilyAssessment, side: 'front' | 'back'): string {
  return `${assessment.caseId}/${assessment.id}/card-${side}`;
}

/** Deletes the answers and the card photos for good. */
export async function deleteFamilyAssessment(assessment: FamilyAssessment): Promise<void> {
  const { error: removeError } = await supabase.storage
    .from('assessment-files')
    .remove([cardPath(assessment, 'front'), cardPath(assessment, 'back')]);
  if (removeError) fail(removeError, 'The card photos could not be deleted, so nothing was deleted. Try again.');
  const { error } = await supabase.rpc('family_assessment_delete', { p_id: assessment.id });
  if (error) fail(error, 'The assessment could not be deleted.');
}

/** Links to the card photos that work for five minutes. */
export async function cardPhotoUrls(assessment: FamilyAssessment): Promise<{ front: string | null; back: string | null }> {
  const sign = async (side: 'front' | 'back', present: boolean) => {
    if (!present) return null;
    const { data, error } = await supabase.storage.from('assessment-files').createSignedUrl(cardPath(assessment, side), 300);
    return error || !data?.signedUrl ? null : data.signedUrl;
  };
  const [front, back] = await Promise.all([sign('front', assessment.cardFront), sign('back', assessment.cardBack)]);
  return { front, back };
}

// ─── The practice logo (owner only) ─────────────────────────────────────────

export const LOGO_TYPES: Record<string, 'png' | 'jpg' | 'webp'> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** The logo's public address, for showing it. */
export function logoPublicUrl(path: string | null | undefined): string | null {
  return path ? supabase.storage.from('org-logos').getPublicUrl(path).data.publicUrl : null;
}

/**
 * Uploads a new logo (PNG, JPEG or WebP, up to 1 MB) into the practice's
 * folder and makes it the one families see; the old file is removed.
 */
export async function uploadPracticeLogo(orgId: string, bytes: ArrayBuffer, mimeType: string, previous: string | null): Promise<string> {
  const extension = LOGO_TYPES[mimeType];
  if (!extension) throw new AssessmentError('Choose a PNG, JPEG or WebP image.');
  if (bytes.byteLength > 1024 * 1024) throw new AssessmentError('Choose a logo smaller than 1 MB.');
  const path = `${orgId}/logo-${Date.now()}.${extension}`;
  const { error: uploadError } = await supabase.storage.from('org-logos').upload(path, bytes, { contentType: mimeType, upsert: false });
  if (uploadError) fail(uploadError, 'The logo could not be uploaded.');
  const { error } = await supabase.rpc('set_org_logo', { p_path: path });
  if (error) {
    await supabase.storage.from('org-logos').remove([path]);
    fail(error, 'The logo could not be saved.');
  }
  if (previous && previous !== path) await supabase.storage.from('org-logos').remove([previous]);
  return path;
}

export async function removePracticeLogo(previous: string | null): Promise<void> {
  const { error } = await supabase.rpc('set_org_logo', { p_path: null });
  if (error) fail(error, 'The logo could not be removed.');
  if (previous) await supabase.storage.from('org-logos').remove([previous]);
}
