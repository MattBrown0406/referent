import { asOfflineError, withHttpStatus } from './errors';
import {
  caseProgramReferralFromRow,
  isMissingProgramReferralSchema,
  programReferralSettingsFromRow,
  type CaseProgramReferral,
  type ProgramReferralSettings,
} from './program-referral-rules';
import { supabase } from './supabase';

// ─── Program referrals: the receiving practice's side ──────────────────────
// Migration 20261108140000_program_referrals.sql, docs/PROGRAM_REFERRALS.md.
// A treatment program on ReferralFit refers a family (with the family's
// consent) to this practice; it arrives as an ordinary lead. The case file
// shows which program referred it and the practice's switch for sharing
// progress with that program. While sharing is on, the program sees
// milestones and, if the client enters treatment, the program they entered;
// never anything else from the case.
//
// Online only, never cached. Against a server without the migration
// (PGRST202 unknown function, 42P01 / PGRST205 unknown table, 42703 unknown
// column, 42883) the reads report available: false and the app shows
// nothing. Matching (matching.ts) never reads any of this.

export {
  SHARED_MILESTONES,
  acceptsExplanation,
  caseProgramReferralFromRow,
  isMissingProgramReferralSchema,
  programReferralSettingsFromRow,
  sharingExplanation,
  type CaseProgramReferral,
  type ProgramReferralSettings,
} from './program-referral-rules';

function failure(error: unknown, status: number | undefined, fallback: string): Error {
  const annotated = withHttpStatus(error, status);
  const offline = asOfflineError(annotated);
  if (offline instanceof Error && offline !== annotated) return offline;
  const message = (error as { message?: unknown } | null)?.message;
  return new Error(typeof message === 'string' && message ? message : fallback);
}

export async function fetchCaseProgramReferral(caseId: string): Promise<{ available: boolean; referral: CaseProgramReferral | null }> {
  const { data, error, status } = await supabase.rpc('case_program_referral', { p_case_id: caseId });
  if (error) {
    if (isMissingProgramReferralSchema(error)) return { available: false, referral: null };
    throw failure(error, status, 'The referral could not be loaded.');
  }
  return { available: true, referral: caseProgramReferralFromRow(data) };
}

export async function setProgramReferralSharing(referralId: string, share: boolean): Promise<boolean> {
  const { data, error, status } = await supabase.rpc('set_program_referral_sharing', { p_referral_id: referralId, p_share: share });
  if (error) throw failure(error, status, 'Sharing could not be changed.');
  return data !== false;
}

export async function fetchProgramReferralSettings(): Promise<{ available: boolean; settings: ProgramReferralSettings | null }> {
  const { data, error, status } = await supabase.rpc('program_referral_settings');
  if (error) {
    if (isMissingProgramReferralSchema(error)) return { available: false, settings: null };
    throw failure(error, status, 'Program referral settings could not be loaded.');
  }
  return { available: true, settings: programReferralSettingsFromRow(data) };
}

export async function setAcceptsProgramReferrals(accepts: boolean): Promise<boolean> {
  const { data, error, status } = await supabase.rpc('set_accepts_program_referrals', { p_accepts: accepts });
  if (error) throw failure(error, status, 'The setting could not be changed.');
  return data !== false;
}
