// The "directory-ready" rule: what a partner — a treatment program, an
// interventionist, or a therapist — needs before a practice can submit it to
// the shared directory for ReferralFit's review. Until then it is simply
// saved to the practice's own list — saving is never blocked.
//
// Pure functions, no React/Supabase imports — unit-testable in plain node
// (scripts/directory-submission-test.mjs).
//
// KEEP IN LOCKSTEP with supabase/migrations/20260930120000_directory_submissions.sql
// (directory_text_is_blank, directory_submission_field_labels,
// directory_missing_fields, directory_missing_fields_message). The server is
// the authority — suggest_global_listing refuses an incomplete partner — and
// this mirror only decides what the app shows. The field keys, their order,
// their labels, and each test below have a line-for-line twin there; the node
// test reads the migration and fails when the key/label list drifts.

// Every partner type can be submitted: treatment programs and individual
// professionals alike. (Only programs auto-publish from the seed workspace;
// that is a separate server rule, partner_is_directory_program.)
export const DIRECTORY_LISTABLE_TYPES: readonly string[] = ['Inpatient', 'IOP / PHP', 'Sober Living', 'Detox', 'Interventionist', 'Therapist'];

// Individual professionals, as opposed to programs.
export const INDIVIDUAL_PROFESSIONAL_TYPES: readonly string[] = ['Interventionist', 'Therapist'];

// The partner form's "Private pay only" choice is stored as this existing
// insurance entry, which the rest of the app already treats as "no plan".
export const PRIVATE_PAY_ONLY = 'Cash pay';

export type DirectorySubmissionFieldKey =
  | 'organization'
  | 'name'
  | 'types'
  | 'city'
  | 'state'
  | 'phone'
  | 'email'
  | 'website'
  | 'monthly_cost'
  | 'insurance';

export type DirectorySubmissionField = { key: DirectorySubmissionFieldKey; label: string };

// Required fields in display order, with the plain-language label used in
// "Add <label> to submit this partner to the shared directory."
export const DIRECTORY_SUBMISSION_FIELDS: readonly DirectorySubmissionField[] = [
  { key: 'organization', label: 'organization name' },
  { key: 'name', label: 'contact person' },
  { key: 'types', label: 'partner type' },
  { key: 'city', label: 'city' },
  { key: 'state', label: 'state' },
  { key: 'phone', label: '10-digit phone number' },
  { key: 'email', label: 'email' },
  { key: 'website', label: 'website' },
  { key: 'monthly_cost', label: 'cost' },
  { key: 'insurance', label: 'insurance or private pay' },
];

export type DirectorySubmissionInput = {
  organization?: string | null;
  name?: string | null;
  types?: readonly string[] | null;
  city?: string | null;
  state?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  monthlyCost?: number | null;
  insurance?: readonly string[] | null;
  insuranceNetworks?: Record<string, unknown> | null;
};

// Blank = nothing but whitespace and dashes. The partner form stores an em
// dash for an empty city or state, so '—' must not count as an answer.
// Same character set as the SQL btrim: space, tab, newline, CR, em dash, en
// dash, hyphen.
export function directoryTextIsBlank(value: string | null | undefined): boolean {
  return (value ?? '').replace(/^[ \t\n\r—–-]+|[ \t\n\r—–-]+$/g, '') === '';
}

export function hasDirectoryType(types: readonly string[] | null | undefined): boolean {
  return (types ?? []).some((type) => DIRECTORY_LISTABLE_TYPES.includes(type));
}

// True when every type is an individual professional (and there is at least
// one). Display-only: picks the wording for the cost field, which is one
// column (monthly_cost) for programs and professionals alike.
export function isIndividualProfessional(types: readonly string[] | null | undefined): boolean {
  const list = types ?? [];
  return list.length > 0 && list.every((type) => INDIVIDUAL_PROFESSIONAL_TYPES.includes(type));
}

// "Monthly cash cost" for a program, "Typical fee" for an interventionist or
// therapist.
export function directoryCostLabel(types: readonly string[] | null | undefined): string {
  return isIndividualProfessional(types) ? 'Typical fee' : 'Monthly cash cost';
}

const EMAIL_PATTERN = /^[^@ \t\n\r]+@[^@ \t\n\r]+\.[^@ \t\n\r]+$/;

// The missing required fields in display order; an empty list means the
// partner is directory-ready.
export function directoryMissingFields(input: DirectorySubmissionInput): DirectorySubmissionField[] {
  const networks = input.insuranceNetworks;
  const missing: Record<DirectorySubmissionFieldKey, boolean> = {
    organization: directoryTextIsBlank(input.organization),
    name: directoryTextIsBlank(input.name),
    // Unlike the seed auto-publish test, an untyped partner is not ready.
    types: !hasDirectoryType(input.types),
    city: directoryTextIsBlank(input.city),
    state: directoryTextIsBlank(input.state),
    phone: (input.phone ?? '').replace(/[^0-9]/g, '').length < 10,
    email: !EMAIL_PATTERN.test((input.email ?? '').replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '')),
    website: directoryTextIsBlank(input.website),
    monthly_cost: !(Number(input.monthlyCost ?? 0) > 0),
    insurance: !(
      (input.insurance ?? []).some((plan) => !directoryTextIsBlank(plan))
      || (networks != null && typeof networks === 'object' && !Array.isArray(networks) && Object.keys(networks).length > 0)
    ),
  };
  return DIRECTORY_SUBMISSION_FIELDS.filter((field) => missing[field.key]);
}

// "Add email and cost to submit this partner to the shared directory."
// Returns '' when nothing is missing. Same sentence the server
// raises from suggest_global_listing.
export function directoryMissingFieldsMessage(missing: readonly DirectorySubmissionField[]): string {
  const labels = missing.map((field) => field.label);
  if (labels.length === 0) return '';
  const list = labels.length === 1
    ? labels[0]
    : labels.length === 2
      ? `${labels[0]} and ${labels[1]}`
      : `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
  return `Add ${list} to submit this partner to the shared directory.`;
}
