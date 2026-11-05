// Program Integrity Watch, for the center portal. A small mirror of the
// app's rules (src/lib/integrity.ts) so this static SPA stays
// self-contained; scripts/integrity-test.mjs checks that the two agree. The
// server (supabase/migrations/20261104130000_program_integrity.sql) is the
// authority: it re-checks everything and resets any change by the program
// to pending ReferralFit review.

export type CredentialKind = 'state_license' | 'accreditation' | 'legitscript' | 'npi';
export type Accreditor = 'joint_commission' | 'carf' | 'other';
export type CredentialReview = 'pending' | 'verified' | 'rejected';
export type CredentialStatus = 'pending' | 'verified' | 'expiring' | 'expired' | 'rejected';

export const KINDS: { value: CredentialKind; label: string }[] = [
  { value: 'state_license', label: 'State license' },
  { value: 'accreditation', label: 'Accreditation' },
  { value: 'legitscript', label: 'LegitScript certification' },
  { value: 'npi', label: 'NPI' },
];

export const ACCREDITORS: { value: Accreditor; label: string }[] = [
  { value: 'joint_commission', label: 'The Joint Commission' },
  { value: 'carf', label: 'CARF' },
  { value: 'other', label: 'Another accrediting body' },
];

export type CredentialRow = {
  id: string;
  kind: CredentialKind;
  accreditor: Accreditor | null;
  accreditor_name: string;
  identifier: string;
  issuing_state: string;
  expires_on: string | null;
  proof_url: string | null;
  note: string;
  status: CredentialReview;
  verified_at: string | null;
  verification_note: string;
  updated_at: string;
};

export type CredentialForm = {
  kind: CredentialKind;
  accreditor: Accreditor;
  accreditorName: string;
  identifier: string;
  issuingState: string;
  expiresOn: string;
  proofUrl: string;
  note: string;
};

export const EXPIRING_WITHIN_DAYS = 30;

// The same pattern as public.is_valid_proof_url and integrity.ts.
export const PROOF_URL_PATTERN = '^https://[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?([.][A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*[.][A-Za-z]{2,63}(:[0-9]{1,5})?([/?#][A-Za-z0-9._~:/?#@!&()*+,;=%-]*)?$';
const PROOF_URL = new RegExp(PROOF_URL_PATTERN);

export function isValidProofUrl(url: string): boolean {
  return url.length <= 500 && PROOF_URL.test(url);
}

// CMS: 10 digits, Luhn check digit over the number with the 80840 prefix.
export function isValidNpi(npi: string): boolean {
  if (!/^\d{10}$/.test(npi)) return false;
  const digits = `80840${npi}`;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function dayIndex(stamp: string): number {
  const [year, month, day] = stamp.split('-').map(Number);
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function todayStamp(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// public.program_credential_status, for a credential that is on file.
export function credentialStatus(review: CredentialReview, expiresOn: string | null, today: string): CredentialStatus {
  if (review === 'rejected') return 'rejected';
  if (expiresOn && /^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) {
    const left = dayIndex(expiresOn) - dayIndex(today);
    if (left < 0) return 'expired';
    if (left <= EXPIRING_WITHIN_DAYS) return 'expiring';
  }
  return review === 'verified' ? 'verified' : 'pending';
}

export const STATUS_LABELS: Record<CredentialStatus, string> = {
  verified: 'Verified by ReferralFit',
  pending: 'Pending ReferralFit review',
  expiring: 'Expires soon',
  expired: 'Expired',
  rejected: "ReferralFit couldn't confirm it",
};

export function credentialTitle(row: Pick<CredentialRow, 'kind' | 'accreditor' | 'accreditor_name' | 'issuing_state'>): string {
  if (row.kind === 'state_license') return row.issuing_state ? `State license (${row.issuing_state})` : 'State license';
  if (row.kind === 'accreditation') {
    if (row.accreditor === 'joint_commission') return 'Joint Commission accreditation';
    if (row.accreditor === 'carf') return 'CARF accreditation';
    return row.accreditor_name ? `${row.accreditor_name} accreditation` : 'Accreditation';
  }
  if (row.kind === 'legitscript') return 'LegitScript certification';
  return 'NPI';
}

export function emptyForm(state = ''): CredentialForm {
  return { kind: 'state_license', accreditor: 'joint_commission', accreditorName: '', identifier: '', issuingState: state.slice(0, 2).toUpperCase(), expiresOn: '', proofUrl: '', note: '' };
}

export function formFromRow(row: CredentialRow): CredentialForm {
  return {
    kind: row.kind,
    accreditor: row.accreditor || 'joint_commission',
    accreditorName: row.accreditor_name,
    identifier: row.identifier,
    issuingState: row.issuing_state,
    expiresOn: row.expires_on || '',
    proofUrl: row.proof_url || '',
    note: row.note,
  };
}

export type SavePayload = {
  p_kind: CredentialKind;
  p_accreditor: Accreditor | null;
  p_accreditor_name: string;
  p_identifier: string;
  p_issuing_state: string;
  p_expires_on: string | null;
  p_proof_url: string | null;
  p_note: string;
};

// The form as the server will store it, or the first thing wrong with it
// (the server's words where they overlap).
export function validateForm(form: CredentialForm): { payload: SavePayload } | { problem: string } {
  const accreditor = form.kind === 'accreditation' ? form.accreditor : null;
  const accreditorName = accreditor === 'other' ? form.accreditorName.trim() : '';
  if (accreditor === 'other' && !accreditorName) return { problem: 'Name the accrediting body' };
  const identifier = form.kind === 'npi' ? form.identifier.replace(/[\s-]/g, '') : form.identifier.trim();
  if (identifier.length > 64) return { problem: 'The number can be at most 64 characters' };
  const issuingState = form.kind === 'state_license' ? form.issuingState.trim().toUpperCase() : '';
  if (form.kind === 'state_license' && !identifier) return { problem: 'Add the license number' };
  if (form.kind === 'state_license' && !/^[A-Z]{2}$/.test(issuingState)) return { problem: 'Choose the state that issued the license' };
  if (form.kind === 'npi' && !isValidNpi(identifier)) return { problem: 'An NPI is 10 digits and its last digit must check out. Check the number.' };
  const expiresOn = form.kind === 'npi' ? null : form.expiresOn.trim() || null;
  if (expiresOn && (!/^\d{4}-\d{2}-\d{2}$/.test(expiresOn) || expiresOn < '2000-01-01' || expiresOn > '2100-12-31')) return { problem: 'Check the expiration date' };
  let proofUrl: string | null = form.proofUrl.trim() || null;
  if (proofUrl && /^http:\/\//i.test(proofUrl)) return { problem: 'Use the https:// address of the page (most issuers have one).' };
  if (proofUrl && !/^[a-z][a-z0-9+.-]*:/i.test(proofUrl)) proofUrl = `https://${proofUrl.replace(/^\/+/, '')}`;
  if (proofUrl && /^https:\/\//i.test(proofUrl)) proofUrl = `https://${proofUrl.slice(8)}`;
  if (proofUrl && !isValidProofUrl(proofUrl)) return { problem: 'The link must be a full https:// web address' };
  if ((form.kind === 'accreditation' || form.kind === 'legitscript') && !identifier && !proofUrl) {
    return { problem: 'Add the certificate number or a link to the public record' };
  }
  const note = form.note.trim();
  if (note.length > 1000) return { problem: 'The note can be at most 1,000 characters' };
  return {
    payload: {
      p_kind: form.kind,
      p_accreditor: accreditor,
      p_accreditor_name: accreditorName,
      p_identifier: identifier,
      p_issuing_state: issuingState,
      p_expires_on: expiresOn,
      p_proof_url: proofUrl,
      p_note: note,
    },
  };
}

export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// A server without the credentials migration.
export function isMissingSchema(code: string | undefined): boolean {
  return code === 'PGRST202' || code === 'PGRST205' || code === '42P01' || code === '42703' || code === '42883';
}
