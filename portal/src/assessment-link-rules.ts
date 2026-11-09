// The family assessment page's pure rules (src/FamilyAssessment.tsx):
// reading the link and what the server sends back. No React, no network,
// so scripts/family-assessment-test.mjs covers it.

import type { Answers } from './assessment-schema';

/** The token in a /f#<token> link, or null when it is cut off or wrong. */
export function assessmentTokenFrom(hash: string): string | null {
  const token = hash.replace(/^#/, '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(token) ? token : null;
}

export type OpenAssessment = {
  status: 'open';
  practiceName: string;
  logoPath: string | null;
  recipientName: string;
  answers: Answers;
  step: number;
  cardFront: boolean;
  cardBack: boolean;
  consentVersion: string;
  consentText: string;
  expiresAt: string;
  lastSavedAt: string | null;
};

export type SubmittedAssessment = {
  status: 'submitted';
  practiceName: string;
  logoPath: string | null;
  submittedAt: string;
};

export type AssessmentView = OpenAssessment | SubmittedAssessment;

const LOGO_PATH = /^[0-9a-f-]{36}\/logo-[0-9]{10,16}\.(png|jpg|webp)$/;

function str(value: unknown, max = 6000): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** public_family_assessment_open's answer, read defensively; null for anything else. */
export function assessmentViewFromJson(value: unknown): AssessmentView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const practiceName = str(data.practice_name, 120).trim() || 'Your practitioner';
  const logoPath = LOGO_PATH.test(str(data.logo_path, 200)) ? str(data.logo_path, 200) : null;
  if (data.status === 'submitted') {
    return { status: 'submitted', practiceName, logoPath, submittedAt: str(data.submitted_at, 40) };
  }
  if (data.status !== 'open') return null;
  const answers = data.answers && typeof data.answers === 'object' && !Array.isArray(data.answers) ? data.answers as Answers : {};
  const step = Number(data.step);
  const consentText = str(data.consent_text);
  const consentVersion = str(data.consent_version, 40);
  if (!consentText || !consentVersion) return null;
  return {
    status: 'open',
    practiceName,
    logoPath,
    recipientName: str(data.recipient_name, 120),
    answers,
    step: Number.isInteger(step) && step >= 0 && step <= 40 ? step : 0,
    cardFront: data.card_front === true,
    cardBack: data.card_back === true,
    consentVersion,
    consentText,
    expiresAt: str(data.expires_at, 40),
    lastSavedAt: typeof data.last_saved_at === 'string' ? data.last_saved_at : null,
  };
}

/** What the save status line says. */
export function savedLine(state: 'idle' | 'saving' | 'saved' | 'failed', savedAt: Date | null): string {
  if (state === 'saving') return 'Saving…';
  if (state === 'failed') return 'Not saved yet. Check your connection; we will keep trying.';
  if (savedAt) return `Saved ${savedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  return '';
}

/** A card photo the page can send: an image of at most 10 MB. '' when it can, or why not. */
export function photoProblem(file: { type: string; size: number }): string {
  if (!/^image\/(jpeg|png|heic|webp)$/.test(file.type)) return 'Please choose a photo (JPG, PNG, HEIC or WebP).';
  if (file.size > 10 * 1024 * 1024) return 'That photo is larger than 10 MB. Please choose a smaller one.';
  if (file.size <= 0) return 'That photo is empty. Please choose another.';
  return '';
}

/** "December 8, 2026" for an ISO time, or ''. */
export function longDate(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
}
