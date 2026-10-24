// The hosted intake link, built from the Supabase project URL. Pure: no
// network, no React. The function itself may not be deployed yet; the app
// only ever shows and shares the URL.

// Hidden for this release (Matt, round 11): the Workspace intake card (copy,
// share, make a new link) and the Business dashboard's "share your intake
// link" footnote are not shown. Everything behind them stays in place; set
// this to true to bring the link back once the hosted intake page ships.
export const INTAKE_LINK_ENABLED = false;

export function intakeLinkUrl(supabaseUrl: string, token: string): string {
  if (!token) return '';
  return `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/intake/${token}`;
}

export function intakeShareMessage(practiceName: string, url: string): string {
  return `Reach ${practiceName}: ${url}\n\nTell us how to reach you and we will call you back shortly. This form is not emergency care: if someone is in immediate danger, call 911.`;
}
