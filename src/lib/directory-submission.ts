// The "directory-ready" rule: what a program needs before a practice can
// submit it to the shared directory for ReferralFit's review. Until then it
// is simply saved to the practice's own list — saving is never blocked.
//
// Pure functions, no React/Supabase imports — unit-testable in plain node
// (scripts/directory-submission-test.mjs).
//
// KEEP IN LOCKSTEP with supabase/migrations/20260930120000_directory_submissions.sql
// (directory_text_is_blank, directory_submission_field_labels,
// directory_missing_fields, directory_missing_fields_message). The server is
// the authority — suggest_global_listing refuses an incomplete program — and
// this mirror only decides what the app shows. The field keys, their order,
// their labels, and each test below have a line-for-line twin there; the node
// test reads the migration and fails when the key/label list drifts.

// Program types the shared directory lists. Interventionists and therapists
// are individual professionals and are not submitted as programs.
export const DIRECTORY_PROGRAM_TYPES: readonly string[] = ['Inpatient', 'IOP / PHP', 'Sober Living', 'Detox'];

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
// "Add <label> to submit this program to the shared directory."
export const DIRECTORY_SUBMISSION_FIELDS: readonly DirectorySubmissionField[] = [
  { key: 'organization', label: 'program name' },
  { key: 'name', label: 'contact person' },
  { key: 'types', label: 'program type' },
  { key: 'city', label: 'city' },
  { key: 'state', label: 'state' },
  { key: 'phone', label: '10-digit phone number' },
  { key: 'email', label: 'email' },
  { key: 'website', label: 'website' },
  { key: 'monthly_cost', label: 'monthly cost' },
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

export function isDirectoryProgram(types: readonly string[] | null | undefined): boolean {
  return (types ?? []).some((type) => DIRECTORY_PROGRAM_TYPES.includes(type));
}

const EMAIL_PATTERN = /^[^@ \t\n\r]+@[^@ \t\n\r]+\.[^@ \t\n\r]+$/;

// The missing required fields in display order; an empty list means the
// program is directory-ready.
export function directoryMissingFields(input: DirectorySubmissionInput): DirectorySubmissionField[] {
  const networks = input.insuranceNetworks;
  const missing: Record<DirectorySubmissionFieldKey, boolean> = {
    organization: directoryTextIsBlank(input.organization),
    name: directoryTextIsBlank(input.name),
    // Unlike the seed auto-publish test, an untyped partner is not ready.
    types: !isDirectoryProgram(input.types),
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

// "Add monthly cost and email to submit this program to the shared
// directory." Returns '' when nothing is missing. Same sentence the server
// raises from suggest_global_listing.
export function directoryMissingFieldsMessage(missing: readonly DirectorySubmissionField[]): string {
  const labels = missing.map((field) => field.label);
  if (labels.length === 0) return '';
  const list = labels.length === 1
    ? labels[0]
    : labels.length === 2
      ? `${labels[0]} and ${labels[1]}`
      : `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
  return `Add ${list} to submit this program to the shared directory.`;
}
