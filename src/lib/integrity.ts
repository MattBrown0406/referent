// ─── Program Integrity Watch: the pure rules ─────────────────────────────────
// Before anyone refers a family, the practitioner sees whether a program's
// credentials are on file, current and verified. Everything here is
// dependency-free (no React, Supabase or storage) so it runs in plain node
// (scripts/integrity-test.mjs). The database applies the same rules:
// public.program_credential_status, public.listing_credentials_verified,
// public.program_credential_problem and public.is_valid_proof_url in
// supabase/migrations/20261104130000_program_integrity.sql.
//
// DISPLAY ONLY. Nothing here is an input to src/lib/matching.ts: a program's
// credentials never change its score or its rank (the test checks it).
//
// Credentials are public business information about programs, not client
// data. Copy is plain and calm: it says what is on file and what to check,
// never that a program is bad.

export type CredentialKind = 'state_license' | 'accreditation' | 'legitscript' | 'npi';
export const CREDENTIAL_KINDS: CredentialKind[] = ['state_license', 'accreditation', 'legitscript', 'npi'];

export type Accreditor = 'joint_commission' | 'carf' | 'other';
export const ACCREDITORS: Accreditor[] = ['joint_commission', 'carf', 'other'];

// What is stored: the review of a credential.
export type CredentialReview = 'pending' | 'verified' | 'rejected';

// What is shown: the review on a given day.
export type CredentialStatus = 'missing' | 'pending' | 'verified' | 'expiring' | 'expired' | 'rejected';

// 'listing': on a shared directory listing, verified by ReferralFit.
// 'local': on one practice's own partner, checked by that practice.
export type CredentialScope = 'listing' | 'local';

export type ProgramCredential = {
  id: string;
  scope: CredentialScope;
  globalPartnerId: string | null;
  partnerId: string | null;
  kind: CredentialKind;
  accreditor: Accreditor | null;
  accreditorName: string;
  identifier: string;
  issuingState: string;
  expiresOn: string | null; // YYYY-MM-DD, the last day it is good
  proofUrl: string | null;
  note: string;
  review: CredentialReview;
  verifiedBy: string | null;
  verifiedAt: string | null;
  verificationNote: string;
  npiLookupName: string | null;
  npiCheckedAt: string | null;
  updatedBy: string | null;
  updatedAt: string;
};

// A credential that expires within this many days is "expiring".
export const EXPIRING_WITHIN_DAYS = 30;
export const MAX_CREDENTIALS_PER_PROGRAM = 20;
// The Today card looks at programs the practice referred to this recently.
export const WATCH_REFERRAL_WINDOW_DAYS = 365;

// ─── Dates (YYYY-MM-DD stamps, compared as whole days) ──────────────────────

const STAMP = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDateStamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = STAMP.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function dayIndex(stamp: string): number {
  const match = STAMP.exec(stamp);
  if (!match) return Number.NaN;
  return Math.round(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000);
}

export function daysBetween(from: string, to: string): number {
  return dayIndex(to) - dayIndex(from);
}

export function addDaysToStamp(stamp: string, days: number): string {
  const date = new Date((dayIndex(stamp) + days) * 86_400_000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

// The device's local date (the day the practitioner is living in).
export function localTodayStamp(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Oct 1, 2026"
export function formatStamp(stamp: string): string {
  if (!isDateStamp(stamp)) return stamp;
  const [year, month, day] = stamp.split('-').map(Number);
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

// What a person types for an expiration date: 2026-10-01, 10/1/2026 or
// 10-01-2026. Blank is null (no date). Anything else is not a date.
export function parseDateInput(input: string): { stamp: string | null } | { problem: string } {
  const value = input.trim();
  if (!value) return { stamp: null };
  let stamp = '';
  if (STAMP.test(value)) stamp = value;
  else {
    const us = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(value);
    if (us) stamp = `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  }
  if (!isDateStamp(stamp)) return { problem: 'Enter the expiration date as YYYY-MM-DD (for example 2027-06-30).' };
  if (stamp < '2000-01-01' || stamp > '2100-12-31') return { problem: 'Check the expiration date' };
  return { stamp };
}

// ─── One credential ─────────────────────────────────────────────────────────

// The same rule as public.program_credential_status. Good through its
// expiration date: expiring that day, expired the day after.
export function credentialStatus(credential: Pick<ProgramCredential, 'review' | 'expiresOn'> | null | undefined, today: string): CredentialStatus {
  if (!credential) return 'missing';
  if (credential.review === 'rejected') return 'rejected';
  if (credential.expiresOn && isDateStamp(credential.expiresOn)) {
    const left = daysBetween(today, credential.expiresOn);
    if (left < 0) return 'expired';
    if (left <= EXPIRING_WITHIN_DAYS) return 'expiring';
  }
  return credential.review === 'verified' ? 'verified' : 'pending';
}

// Checked, and not past its expiration date (expiring still counts).
export function isVerifiedCurrent(credential: Pick<ProgramCredential, 'review' | 'expiresOn'>, today: string): boolean {
  if (credential.review !== 'verified') return false;
  const status = credentialStatus(credential, today);
  return status === 'verified' || status === 'expiring';
}

const STATUS_RANK: Record<Exclude<CredentialStatus, 'missing'>, number> = {
  verified: 0,
  expiring: 1,
  pending: 2,
  expired: 3,
  rejected: 4,
};

export type KindSummary = { status: CredentialStatus; credential: ProgramCredential | null };

// The credential that speaks for a kind when a program has several (a
// renewed license next to the lapsed one, two accreditations): the best
// status wins, then a checked one, then the later expiration date, then the
// most recently updated.
export function bestCredential(credentials: ProgramCredential[], kinds: CredentialKind[], today: string): KindSummary {
  let best: ProgramCredential | null = null;
  let bestStatus: Exclude<CredentialStatus, 'missing'> = 'rejected';
  for (const credential of credentials) {
    if (!kinds.includes(credential.kind)) continue;
    const status = credentialStatus(credential, today) as Exclude<CredentialStatus, 'missing'>;
    if (!best || compareCandidates(credential, status, best, bestStatus) < 0) {
      best = credential;
      bestStatus = status;
    }
  }
  return best ? { status: bestStatus, credential: best } : { status: 'missing', credential: null };
}

function compareCandidates(a: ProgramCredential, aStatus: Exclude<CredentialStatus, 'missing'>, b: ProgramCredential, bStatus: Exclude<CredentialStatus, 'missing'>): number {
  if (STATUS_RANK[aStatus] !== STATUS_RANK[bStatus]) return STATUS_RANK[aStatus] - STATUS_RANK[bStatus];
  const aChecked = a.review === 'verified' ? 0 : 1;
  const bChecked = b.review === 'verified' ? 0 : 1;
  if (aChecked !== bChecked) return aChecked - bChecked;
  // No expiration date sorts as the latest one.
  const aExpires = a.expiresOn || '9999-12-31';
  const bExpires = b.expiresOn || '9999-12-31';
  if (aExpires !== bExpires) return aExpires > bExpires ? -1 : 1;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ─── One program ────────────────────────────────────────────────────────────

export type IntegrityChip = 'verified' | 'needs_review' | 'expired' | 'none';

export type IntegrityFlag =
  | 'all_verified'
  | 'no_license'
  | 'license_pending'
  | 'license_expiring'
  | 'license_expired'
  | 'license_rejected'
  | 'accreditation_pending'
  | 'accreditation_expiring'
  | 'accreditation_expired'
  | 'accreditation_rejected'
  | 'legitscript_pending'
  | 'legitscript_expiring'
  | 'legitscript_expired'
  | 'legitscript_rejected'
  | 'npi_pending'
  | 'npi_rejected';

// A state license that should give the practitioner pause before a referral.
export type LicenseConcern = { status: 'expired' | 'rejected'; credential: ProgramCredential };

export type ProgramIntegrity = {
  onFile: number;
  license: KindSummary;
  accreditation: KindSummary;
  legitscript: KindSummary;
  npi: KindSummary;
  // "Credentials verified": a state license verified and current, AND an
  // accreditation or LegitScript certification verified and current. The
  // same rule as public.listing_credentials_verified.
  badge: boolean;
  chip: IntegrityChip;
  licenseConcern: LicenseConcern | null;
  flags: IntegrityFlag[];
};

// For a partner linked to a listing, pass the listing's credentials and the
// practice's own together: a check the practice recorded counts for its own
// view. The Directory's badge uses the listing's alone.
export function programIntegrity(credentials: ProgramCredential[], today: string): ProgramIntegrity {
  const license = bestCredential(credentials, ['state_license'], today);
  const accreditation = bestCredential(credentials, ['accreditation'], today);
  const legitscript = bestCredential(credentials, ['legitscript'], today);
  const npi = bestCredential(credentials, ['npi'], today);
  const verifiedCurrent = (kinds: CredentialKind[]) => credentials.some((item) => kinds.includes(item.kind) && isVerifiedCurrent(item, today));
  const badge = verifiedCurrent(['state_license']) && verifiedCurrent(['accreditation', 'legitscript']);

  const flags: IntegrityFlag[] = [];
  if (license.status === 'missing') flags.push('no_license');
  else if (license.status !== 'verified') flags.push(`license_${license.status}` as IntegrityFlag);
  for (const [prefix, summary] of [['accreditation', accreditation], ['legitscript', legitscript], ['npi', npi]] as const) {
    if (summary.status !== 'missing' && summary.status !== 'verified') flags.push(`${prefix}_${summary.status}` as IntegrityFlag);
  }
  if (!flags.length && credentials.length > 0) flags.push('all_verified');

  const anyExpired = [license, accreditation, legitscript].some((summary) => summary.status === 'expired');
  const chip: IntegrityChip = credentials.length === 0 ? 'none' : anyExpired ? 'expired' : badge ? 'verified' : 'needs_review';
  const licenseConcern = license.credential && (license.status === 'expired' || license.status === 'rejected')
    ? { status: license.status, credential: license.credential }
    : null;
  return { onFile: credentials.length, license, accreditation, legitscript, npi, badge, chip, licenseConcern, flags };
}

export const CHIP_LABELS: Record<IntegrityChip, string> = {
  verified: 'Verified',
  needs_review: 'Needs review',
  expired: 'Expired',
  none: 'None on file',
};

export const FLAG_LABELS: Record<IntegrityFlag, string> = {
  all_verified: 'All verified',
  no_license: 'No license on file',
  license_pending: 'License not checked yet',
  license_expiring: 'License expiring soon',
  license_expired: 'License expired',
  license_rejected: 'License could not be confirmed',
  accreditation_pending: 'Accreditation not checked yet',
  accreditation_expiring: 'Accreditation expiring',
  accreditation_expired: 'Accreditation expired',
  accreditation_rejected: 'Accreditation could not be confirmed',
  legitscript_pending: 'LegitScript not checked yet',
  legitscript_expiring: 'LegitScript expiring',
  legitscript_expired: 'LegitScript expired',
  legitscript_rejected: 'LegitScript could not be confirmed',
  npi_pending: 'NPI not checked yet',
  npi_rejected: 'NPI could not be confirmed',
};

// One calm sentence for the top of the Credentials card.
export function integrityHeadline(integrity: ProgramIntegrity): string {
  if (integrity.onFile === 0) {
    return 'No credentials on file yet. Ask the program for its state license and accreditation, or look them up below.';
  }
  if (integrity.licenseConcern?.status === 'expired') {
    const expired = integrity.licenseConcern.credential.expiresOn;
    return `Its state license shows expired${expired ? ` (${formatStamp(expired)})` : ''}. Check with the program before referring.`;
  }
  if (integrity.licenseConcern?.status === 'rejected') {
    return 'Its state license could not be confirmed. Check with the program before referring.';
  }
  if (integrity.license.status === 'missing') {
    return "We couldn't find a current state license on file. Check with the program before referring.";
  }
  if (integrity.chip === 'expired') {
    return 'A credential on file has expired. Check with the program for the renewal.';
  }
  if (integrity.license.status === 'expiring' && integrity.license.credential?.expiresOn) {
    return `Its state license expires ${formatStamp(integrity.license.credential.expiresOn)}. Worth confirming the renewal.`;
  }
  if (integrity.badge && integrity.flags.includes('all_verified')) {
    return 'Credentials verified: a current state license and accreditation or LegitScript, checked.';
  }
  if (integrity.badge) {
    return 'Credentials verified: a current state license and accreditation or LegitScript, checked. Some details below still need a look.';
  }
  return 'Some credentials are on file but not checked yet.';
}

// ─── Labels ─────────────────────────────────────────────────────────────────

export const KIND_LABELS: Record<CredentialKind, string> = {
  state_license: 'State license',
  accreditation: 'Accreditation',
  legitscript: 'LegitScript',
  npi: 'NPI',
};

export const ACCREDITOR_LABELS: Record<Accreditor, string> = {
  joint_commission: 'The Joint Commission',
  carf: 'CARF',
  other: 'Other',
};

export function credentialTitle(credential: Pick<ProgramCredential, 'kind' | 'accreditor' | 'accreditorName' | 'issuingState'>): string {
  switch (credential.kind) {
    case 'state_license':
      return credential.issuingState ? `State license (${credential.issuingState})` : 'State license';
    case 'accreditation':
      if (credential.accreditor === 'joint_commission') return 'Joint Commission accreditation';
      if (credential.accreditor === 'carf') return 'CARF accreditation';
      return credential.accreditorName ? `${credential.accreditorName} accreditation` : 'Accreditation';
    case 'legitscript':
      return 'LegitScript certification';
    default:
      return 'NPI';
  }
}

export function statusLabel(status: CredentialStatus, scope: CredentialScope): string {
  switch (status) {
    case 'verified':
      return scope === 'listing' ? 'Verified by ReferralFit' : 'Checked by your practice';
    case 'pending':
      return scope === 'listing' ? 'Pending ReferralFit review' : 'Not checked yet';
    case 'expiring':
      return 'Expires soon';
    case 'expired':
      return 'Expired';
    case 'rejected':
      return scope === 'listing' ? "ReferralFit couldn't confirm it" : "Couldn't confirm it";
    default:
      return 'Missing';
  }
}

export function expiryLine(credential: Pick<ProgramCredential, 'kind' | 'expiresOn'>, today: string): string {
  if (credential.kind === 'npi') return 'NPIs do not expire';
  if (!credential.expiresOn || !isDateStamp(credential.expiresOn)) return 'No expiration date on file';
  const left = daysBetween(today, credential.expiresOn);
  if (left < 0) return `Expired ${formatStamp(credential.expiresOn)}`;
  if (left === 0) return `Expires today (${formatStamp(credential.expiresOn)})`;
  if (left <= EXPIRING_WITHIN_DAYS) return `Expires ${formatStamp(credential.expiresOn)} (in ${left} ${left === 1 ? 'day' : 'days'})`;
  return `Expires ${formatStamp(credential.expiresOn)}`;
}

// ─── Proof links ────────────────────────────────────────────────────────────

// The same pattern as public.is_valid_proof_url (the test compares them):
// https only, a public host name with a dot, an optional port, then a path,
// query or fragment of ordinary URL characters. No user:password@ part.
export const PROOF_URL_PATTERN = '^https://[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?([.][A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*[.][A-Za-z]{2,63}(:[0-9]{1,5})?([/?#][A-Za-z0-9._~:/?#@!&()*+,;=%-]*)?$';
const PROOF_URL = new RegExp(PROOF_URL_PATTERN);
export const MAX_PROOF_URL_LENGTH = 500;

export function isValidProofUrl(url: unknown): url is string {
  return typeof url === 'string' && url.length <= MAX_PROOF_URL_LENGTH && PROOF_URL.test(url);
}

// What a person pastes: trimmed; "www.example.org/x" gets https:// in
// front; an http:// address is refused (ask for the https one); blank is
// null.
export function normalizeProofUrl(input: string): { url: string | null } | { problem: string } {
  let value = input.trim();
  if (!value) return { url: null };
  if (/^http:\/\//i.test(value)) return { problem: 'Use the https:// address of the page (most issuers have one).' };
  if (/^https:\/\//i.test(value)) value = `https://${value.slice(8)}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = `https://${value.replace(/^\/+/, '')}`;
  if (!isValidProofUrl(value)) return { problem: 'The link must be a full https:// web address' };
  return { url: value };
}

// ─── NPI check digit ────────────────────────────────────────────────────────

// Spaces and dashes typed into an NPI are dropped.
export function normalizeNpi(input: string): string {
  return input.replace(/[\s-]/g, '');
}

// 10 digits, the last being the Luhn check digit of the number with the
// 80840 prefix (CMS). The same rule as public.is_valid_npi.
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

// ─── The editor ─────────────────────────────────────────────────────────────

export type CredentialDraft = {
  kind: CredentialKind;
  accreditor: Accreditor | null;
  accreditorName: string;
  identifier: string;
  issuingState: string;
  expiresOn: string; // as typed
  proofUrl: string; // as typed
  note: string;
};

export type CredentialFields = {
  kind: CredentialKind;
  accreditor: Accreditor | null;
  accreditorName: string;
  identifier: string;
  issuingState: string;
  expiresOn: string | null;
  proofUrl: string | null;
  note: string;
};

export function emptyCredentialDraft(kind: CredentialKind = 'state_license', state = ''): CredentialDraft {
  return {
    kind,
    accreditor: kind === 'accreditation' ? 'joint_commission' : null,
    accreditorName: '',
    identifier: '',
    issuingState: kind === 'state_license' ? state.trim().toUpperCase().slice(0, 2) : '',
    expiresOn: '',
    proofUrl: '',
    note: '',
  };
}

export function draftFromCredential(credential: ProgramCredential): CredentialDraft {
  return {
    kind: credential.kind,
    accreditor: credential.accreditor,
    accreditorName: credential.accreditorName,
    identifier: credential.identifier,
    issuingState: credential.issuingState,
    expiresOn: credential.expiresOn || '',
    proofUrl: credential.proofUrl || '',
    note: credential.note,
  };
}

// The draft as the server will store it, or the first thing wrong with it,
// in the server's words where the two overlap (public.program_credential_problem).
export function normalizeCredentialDraft(draft: CredentialDraft): { fields: CredentialFields } | { problem: string } {
  if (!CREDENTIAL_KINDS.includes(draft.kind)) return { problem: 'Choose what kind of credential this is' };
  const accreditor = draft.kind === 'accreditation' ? draft.accreditor : null;
  if (draft.kind === 'accreditation' && (!accreditor || !ACCREDITORS.includes(accreditor))) return { problem: 'Choose who accredits the program' };
  const accreditorName = accreditor === 'other' ? draft.accreditorName.trim() : '';
  if (accreditor === 'other' && !accreditorName) return { problem: 'Name the accrediting body' };
  if (accreditorName.length > 120) return { problem: 'The accrediting body name can be at most 120 characters' };
  const identifier = draft.kind === 'npi' ? normalizeNpi(draft.identifier) : draft.identifier.trim();
  if (identifier.length > 64) return { problem: 'The number can be at most 64 characters' };
  const issuingState = draft.kind === 'state_license' ? draft.issuingState.trim().toUpperCase() : '';
  if (draft.kind === 'state_license' && !identifier) return { problem: 'Add the license number' };
  if (draft.kind === 'state_license' && !US_STATE_NAMES[issuingState]) return { problem: 'Choose the state that issued the license' };
  if (draft.kind === 'npi' && !isValidNpi(identifier)) return { problem: 'An NPI is 10 digits and its last digit must check out. Check the number.' };
  const date = parseDateInput(draft.kind === 'npi' ? '' : draft.expiresOn);
  if ('problem' in date) return date;
  if (draft.kind === 'npi' && draft.expiresOn.trim()) return { problem: 'An NPI does not expire. Leave the date blank.' };
  const proof = normalizeProofUrl(draft.proofUrl);
  if ('problem' in proof) return proof;
  if ((draft.kind === 'accreditation' || draft.kind === 'legitscript') && !identifier && !proof.url) {
    return { problem: 'Add the certificate number or a link to the public record' };
  }
  const note = draft.note.trim();
  if (note.length > 1000) return { problem: 'The note can be at most 1,000 characters' };
  return { fields: { kind: draft.kind, accreditor, accreditorName, identifier, issuingState, expiresOn: date.stamp, proofUrl: proof.url, note } };
}

// ─── Wire format (src/lib/credentials.ts reads with it) ─────────────────────

export const CREDENTIAL_COLUMNS = [
  'id', 'global_partner_id', 'org_id', 'partner_id', 'kind', 'accreditor', 'accreditor_name', 'identifier',
  'issuing_state', 'expires_on', 'proof_url', 'note', 'status', 'verified_by', 'verified_at', 'verification_note',
  'npi_lookup_name', 'npi_checked_at', 'updated_by', 'updated_at',
] as const;

export type CredentialRow = Partial<Record<(typeof CREDENTIAL_COLUMNS)[number], string | null>>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optional(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

// A row from the table (or an RPC returning one). Null for anything that is
// not a credential this app version understands.
export function credentialFromRow(row: CredentialRow | null | undefined): ProgramCredential | null {
  if (!row || typeof row.id !== 'string') return null;
  const kind = row.kind as CredentialKind;
  if (!CREDENTIAL_KINDS.includes(kind)) return null;
  const review: CredentialReview = row.status === 'verified' || row.status === 'rejected' ? row.status : 'pending';
  const accreditor = ACCREDITORS.includes(row.accreditor as Accreditor) ? (row.accreditor as Accreditor) : null;
  const globalPartnerId = optional(row.global_partner_id);
  return {
    id: row.id.toLowerCase(),
    scope: globalPartnerId ? 'listing' : 'local',
    globalPartnerId: globalPartnerId ? globalPartnerId.toLowerCase() : null,
    partnerId: optional(row.partner_id)?.toLowerCase() ?? null,
    kind,
    accreditor,
    accreditorName: str(row.accreditor_name),
    identifier: str(row.identifier),
    issuingState: str(row.issuing_state),
    expiresOn: isDateStamp(row.expires_on) ? row.expires_on : null,
    proofUrl: optional(row.proof_url),
    note: str(row.note),
    review,
    verifiedBy: optional(row.verified_by)?.toLowerCase() ?? null,
    verifiedAt: optional(row.verified_at),
    verificationNote: str(row.verification_note),
    npiLookupName: optional(row.npi_lookup_name),
    npiCheckedAt: optional(row.npi_checked_at),
    updatedBy: optional(row.updated_by)?.toLowerCase() ?? null,
    updatedAt: str(row.updated_at),
  };
}

// ─── Lookup links: people check by hand; ReferralFit never scrapes ──────────
// LegitScript, The Joint Commission and CARF do not allow automated lookups
// of their directories, so the app only opens their public search pages in
// the browser (Linking.openURL) for the practitioner or admin to check.
// Where each address comes from:
export const LOOKUP_SITES = {
  // LegitScript's public certification checker: the page LegitScript's own
  // certification seals link to (legitscript.com/websites/?checker_keywords=<domain>).
  legitscript: { label: 'Check on LegitScript', url: 'https://www.legitscript.com/websites/' },
  // The Joint Commission's public search of US accredited organizations
  // (qualitycheck.org now redirects to the international JCI list instead;
  // checked 2026-11-04).
  jointCommission: { label: 'Joint Commission accreditation search', url: 'https://www.jointcommission.org/en-us/about-us/recognizing-excellence/find-accredited-organizations' },
  // CARF International's public "Find a provider" search on carf.org.
  carf: { label: 'CARF provider search', url: 'https://carf.org/find-provider/' },
  // There is no national registry of state treatment licenses: each state's
  // licensing agency runs its own lookup. With a state this opens a web
  // search for that state's lookup page; without one, SAMHSA's
  // FindTreatment.gov, which lists facilities licensed, certified or
  // otherwise approved by their state.
  stateLicense: { label: 'State license lookup', url: 'https://findtreatment.gov/' },
  // The CMS NPPES NPI Registry's public search (the same data as the API
  // the NPI check reads: npiregistry.cms.hhs.gov/api).
  npiRegistry: { label: 'NPI Registry', url: 'https://npiregistry.cms.hhs.gov/search' },
} as const;

export type LookupSite = keyof typeof LOOKUP_SITES;
export type LookupLink = { site: LookupSite; label: string; url: string };

// "https://www.hope-house.org/about" -> "hope-house.org"
export function websiteDomain(website: string | null | undefined): string {
  const value = (website || '').trim().toLowerCase();
  if (!value) return '';
  const host = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0].split('@').pop() || '';
  return host.replace(/:\d+$/, '').replace(/^www\./, '');
}

export function lookupLink(site: LookupSite, context: { state?: string; website?: string | null; npi?: string } = {}): LookupLink {
  const base = LOOKUP_SITES[site];
  let url: string = base.url;
  if (site === 'legitscript') {
    const domain = websiteDomain(context.website);
    if (domain) url = `${base.url}?checker_keywords=${encodeURIComponent(domain)}`;
  } else if (site === 'stateLicense') {
    const stateName = context.state ? US_STATE_NAMES[context.state.trim().toUpperCase()] : undefined;
    if (stateName) url = `https://www.google.com/search?q=${encodeURIComponent(`${stateName} substance use treatment facility license lookup`)}`;
  } else if (site === 'npiRegistry' && context.npi && isValidNpi(context.npi)) {
    url = `https://npiregistry.cms.hhs.gov/provider-view/${context.npi}`;
  }
  return { site, label: base.label, url };
}

// The links that fit one credential.
export function lookupLinksForCredential(credential: Pick<ProgramCredential, 'kind' | 'accreditor' | 'issuingState' | 'identifier'>, website?: string | null): LookupLink[] {
  switch (credential.kind) {
    case 'state_license':
      return [lookupLink('stateLicense', { state: credential.issuingState })];
    case 'accreditation':
      if (credential.accreditor === 'joint_commission') return [lookupLink('jointCommission')];
      if (credential.accreditor === 'carf') return [lookupLink('carf')];
      return [lookupLink('jointCommission'), lookupLink('carf')];
    case 'legitscript':
      return [lookupLink('legitscript', { website })];
    default:
      return [lookupLink('npiRegistry', { npi: credential.identifier })];
  }
}

// The four searches for a program with nothing (or little) on file.
export function programLookupLinks(program: { state?: string; website?: string | null }): LookupLink[] {
  return [
    lookupLink('stateLicense', { state: program.state }),
    lookupLink('jointCommission'),
    lookupLink('carf'),
    lookupLink('legitscript', { website: program.website }),
  ];
}

// ─── Before a referral ──────────────────────────────────────────────────────

// The Alert before Assign & refer or Send packet to a program whose state
// license shows expired or could not be confirmed.
export function licenseConcernAlert(programName: string, concern: LicenseConcern, action: 'refer' | 'packet'): { title: string; message: string; proceed: string } {
  const name = programName.trim() || 'This program';
  const what = concern.status === 'expired'
    ? `Its state license shows expired${concern.credential.expiresOn ? ` (${formatStamp(concern.credential.expiresOn)})` : ''}.`
    : 'Its state license could not be confirmed.';
  return {
    title: 'Check the license first',
    message: `${name}: ${what} Check with the program before referring. ${action === 'packet' ? 'Send the packet anyway?' : 'Refer anyway?'}`,
    proceed: action === 'packet' ? 'Send anyway' : 'Refer anyway',
  };
}

// The line kept on the case timeline (or the referral's note) when the
// practitioner went ahead anyway.
export function licenseOverrideNote(programName: string, concern: LicenseConcern, action: 'refer' | 'packet' = 'refer'): string {
  const name = programName.trim() || 'the program';
  const what = concern.status === 'expired'
    ? `showed expired${concern.credential.expiresOn ? ` (${formatStamp(concern.credential.expiresOn)})` : ''}`
    : 'could not be confirmed';
  return `${action === 'packet' ? 'Sent anyway' : 'Referred anyway'}: the state license for ${name} ${what}, and the practitioner confirmed going ahead.`;
}

// ─── Today: one card for the programs the practice refers to ────────────────

export type CredentialWatchItem = {
  partnerId: string;
  name: string;
  worst: 'expired' | 'expiring';
  // "state license expired Oct 1, 2026", "accreditation expires Nov 20, 2026"
  lines: string[];
  soonest: string; // the earliest date involved, for ordering
};

export type CredentialWatchInput = {
  partners: { id: string; organization: string; name: string }[];
  referrals: { partnerId: string; direction: string; date: string }[];
  integrityFor: (partnerId: string) => ProgramIntegrity | null;
  today: string;
};

// Every partner the practice referred a client to in the last 12 months
// whose state license or accreditation has expired or expires within 30
// days. One card lists them all.
export function credentialWatchItems(input: CredentialWatchInput): CredentialWatchItem[] {
  const since = addDaysToStamp(input.today, -WATCH_REFERRAL_WINDOW_DAYS);
  const referred = new Set(
    input.referrals
      .filter((referral) => referral.direction === 'Outbound' && referral.date >= since && referral.date <= input.today)
      .map((referral) => referral.partnerId),
  );
  const items: CredentialWatchItem[] = [];
  for (const partner of input.partners) {
    if (!referred.has(partner.id)) continue;
    const integrity = input.integrityFor(partner.id);
    if (!integrity) continue;
    const lines: string[] = [];
    let worst: 'expired' | 'expiring' | null = null;
    let soonest = '';
    for (const [label, summary] of [['state license', integrity.license], ['accreditation', integrity.accreditation]] as const) {
      if ((summary.status !== 'expired' && summary.status !== 'expiring') || !summary.credential?.expiresOn) continue;
      const date = summary.credential.expiresOn;
      lines.push(summary.status === 'expired' ? `${label} expired ${formatStamp(date)}` : `${label} expires ${formatStamp(date)}`);
      if (summary.status === 'expired') worst = 'expired';
      else if (!worst) worst = 'expiring';
      if (!soonest || date < soonest) soonest = date;
    }
    if (!worst) continue;
    items.push({ partnerId: partner.id, name: partner.organization || partner.name, worst, lines, soonest });
  }
  return items.sort((a, b) => (a.worst !== b.worst ? (a.worst === 'expired' ? -1 : 1) : a.soonest !== b.soonest ? (a.soonest < b.soonest ? -1 : 1) : a.name.localeCompare(b.name)));
}

export function credentialWatchSubtitle(items: CredentialWatchItem[]): string {
  const count = items.length;
  return `${count} ${count === 1 ? 'program' : 'programs'} you referred to in the last 12 months. Check with ${count === 1 ? 'it' : 'them'} for the renewal, then add it in the program's Credentials.`;
}

// ─── States ─────────────────────────────────────────────────────────────────

export const US_STATE_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  PR: 'Puerto Rico', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
  UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  GU: 'Guam', VI: 'U.S. Virgin Islands',
};
