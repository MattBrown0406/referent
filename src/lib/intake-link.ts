// The intake link a practice shares. Pure: no network, no React.
//
// It opens the form on the ReferralFit website, which calls the intake Edge
// Function from the family's own browser (referralfit-web src/lib/intake.ts,
// docs/LEAD_CAPTURE.md). That page talks to the production project only, so
// a development build pointed at a local Supabase stack shares the function's
// own HTML form instead, which works against any project.

// On since the website form went live (2026-11-07). Turning it off hides the
// Workspace intake card (copy, share, make a new link) and the Business
// dashboard's "share your intake link" footnote; everything behind them stays.
export const INTAKE_LINK_ENABLED = true;

export const INTAKE_PAGE_BASE = 'https://referralfit.com/intake';

// A hosted Supabase project (https://<ref>.supabase.co); anything else is a
// local stack or a tunnel to one.
const HOSTED_SUPABASE = /^https:\/\/[a-z0-9]+\.supabase\.co$/;

export function intakeLinkUrl(supabaseUrl: string, token: string): string {
  if (!token) return '';
  const project = supabaseUrl.replace(/\/+$/, '');
  if (HOSTED_SUPABASE.test(project)) return `${INTAKE_PAGE_BASE}/${token}`;
  return `${project}/functions/v1/intake/${token}`;
}

export function intakeShareMessage(practiceName: string, url: string): string {
  return `Reach ${practiceName}: ${url}\n\nTell us how to reach you and we will call you back shortly. This form is not emergency care: if someone is in immediate danger, call 911.`;
}
