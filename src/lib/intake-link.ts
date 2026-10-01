// The hosted intake link, built from the Supabase project URL. Pure: no
// network, no React. The function itself may not be deployed yet; the app
// only ever shows and shares the URL.

export function intakeLinkUrl(supabaseUrl: string, token: string): string {
  if (!token) return '';
  return `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/intake/${token}`;
}

export function intakeShareMessage(practiceName: string, url: string): string {
  return `Reach ${practiceName}: ${url}\n\nTell us how to reach you and we will call you back shortly. This form is not emergency care: if someone is in immediate danger, call 911.`;
}
