// Pure helpers for the hosted intake link. No Deno APIs, no network: every
// function here is covered by intake_test.ts and runs under plain `deno test`.

export const INTAKE_TOKEN_PATTERN = /^[0-9a-f]{32,64}$/;

// Rate limits (fixed windows, enforced server-side in intake_rate_limit_hit).
export const TOKEN_LIMIT = { perWindow: 30, windowSeconds: 3600 };
export const IP_LIMIT = { perWindow: 6, windowSeconds: 3600 };

export const URGENCY_CHOICES = ['none', 'immediate_danger'] as const;
export type Urgency = (typeof URGENCY_CHOICES)[number];

export type IntakeLead = {
  caller_name: string;
  phone: string;
  email: string;
  about_relationship: string;
  about_first_name: string;
  urgency: Urgency;
  lead_source: 'Website';
  lead_source_detail: 'Intake link';
};

export type ParsedSubmission =
  | { kind: 'lead'; lead: IntakeLead }
  | { kind: 'honeypot' }
  | { kind: 'invalid'; reason: string };

// The token is the last path segment: /intake/<token> locally, and
// /functions/v1/intake/<token> as the public URL (Supabase strips the prefix,
// but tolerate either).
export function tokenFromPath(pathname: string): string | null {
  const segments = pathname.split('/').filter(Boolean);
  const index = segments.lastIndexOf('intake');
  const token = index >= 0 ? segments[index + 1] || '' : segments[segments.length - 1] || '';
  return INTAKE_TOKEN_PATTERN.test(token) ? token : null;
}

function field(form: URLSearchParams, name: string, max: number): string {
  // Collapse whitespace and cut hard: nothing longer than the column limit
  // ever reaches the database, and control characters never do.
  const raw = form.get(name) || '';
  return raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function phoneDigits(value: string): string {
  return value.replace(/\D/g, '');
}

// Strict, plain validation. Reasons are generic on purpose: the response
// page never repeats what was typed.
export function parseSubmission(form: URLSearchParams): ParsedSubmission {
  // Honeypot: real people never see or fill this field.
  if ((form.get('company') || '').trim()) return { kind: 'honeypot' };

  const callerName = field(form, 'caller_name', 120);
  const phone = field(form, 'phone', 40);
  const email = field(form, 'email', 254);
  const relationship = field(form, 'about_relationship', 60);
  const firstName = field(form, 'about_first_name', 60);
  const urgencyRaw = field(form, 'urgency', 20);

  if (!callerName) return { kind: 'invalid', reason: 'Please add your name.' };
  const digits = phoneDigits(phone);
  if (digits.length < 10 || digits.length > 15) {
    return { kind: 'invalid', reason: 'Please add a phone number with area code so we can call you back.' };
  }
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { kind: 'invalid', reason: 'That email address does not look right. It is optional, so you can leave it blank.' };
  }
  const urgency: Urgency = urgencyRaw === 'immediate_danger' ? 'immediate_danger' : 'none';
  if (urgencyRaw && !URGENCY_CHOICES.includes(urgencyRaw as Urgency)) {
    return { kind: 'invalid', reason: 'Please choose one of the two options about safety.' };
  }

  return {
    kind: 'lead',
    lead: {
      caller_name: callerName,
      phone,
      email,
      about_relationship: relationship,
      about_first_name: firstName,
      urgency,
      lead_source: 'Website',
      lead_source_detail: 'Intake link',
    },
  };
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// First address in X-Forwarded-For (the client), else the Supabase-provided
// header, else empty. Only ever hashed, never stored.
export function clientAddress(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for') || '';
  const first = forwarded.split(',')[0].trim();
  if (first) return first;
  return (headers.get('cf-connecting-ip') || headers.get('x-real-ip') || '').trim();
}

export function bucketNames(token: string, addressHash: string): { token: string; ip: string | null } {
  return { token: `token:${token}`, ip: addressHash ? `ip:${addressHash}` : null };
}

// ─── Pages ──────────────────────────────────────────────────────────────────
// Mobile-first, no scripts, no external assets. Copy rules (Matt Brown):
// addiction is a medical disease; families act from love and fear; no shame.
// The form states who will call and that it is not emergency care. The
// 911/988 line is tied to the "someone is in danger right now" choice, not
// appended everywhere.

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #F6F4EE; color: #16352E; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { max-width: 520px; margin: 0 auto; padding: 24px 18px 48px; }
  h1 { font-size: 24px; line-height: 1.25; margin: 0 0 6px; }
  .lede { color: #38564F; margin: 0 0 20px; }
  label { display: block; font-size: 13px; font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase; color: #73827D; margin: 16px 0 6px; }
  input[type=text], input[type=tel], input[type=email] { width: 100%; min-height: 48px; padding: 10px 12px; border: 1px solid #DDE4DF; border-radius: 12px; background: #FFFFFF; font-size: 17px; color: #16352E; }
  .row { display: flex; gap: 10px; }
  .row > div { flex: 1; }
  fieldset { border: 0; padding: 0; margin: 18px 0 0; }
  legend { font-size: 13px; font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase; color: #73827D; margin-bottom: 6px; padding: 0; }
  .choice { display: flex; gap: 10px; align-items: flex-start; background: #FFFFFF; border: 1px solid #DDE4DF; border-radius: 12px; padding: 12px; margin-bottom: 8px; }
  .choice input { margin-top: 4px; width: 20px; height: 20px; }
  .choice span { flex: 1; }
  .danger { background: #F7E7E1; border: 1px solid #E9C5B8; border-radius: 12px; padding: 12px 14px; margin: 10px 0 0; color: #7D594B; }
  .danger strong { color: #B0603F; }
  button { width: 100%; min-height: 52px; margin-top: 22px; border: 0; border-radius: 14px; background: #1F5A49; color: #FFFFFF; font-size: 17px; font-weight: 800; }
  .note { font-size: 14px; color: #73827D; margin-top: 18px; }
  .hp { position: absolute; left: -9999px; top: -9999px; height: 0; width: 0; opacity: 0; }
  .card { background: #FFFFFF; border: 1px solid #DDE4DF; border-radius: 16px; padding: 18px; }
  .alert { background: #F7E7E1; border: 1px solid #E9C5B8; border-radius: 12px; padding: 12px 14px; color: #7D594B; margin-bottom: 14px; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

export function formPage(practiceName: string, actionUrl: string, errorMessage = ''): string {
  const practice = escapeHtml(practiceName);
  return page(`Reach ${practiceName}`, `
<h1>Reach ${practice}</h1>
<p class="lede">Tell us how to reach you and someone from ${practice} will call you back shortly. Addiction is a medical condition, and asking for help for someone you love is the right move. There is nothing to be ashamed of here.</p>
${errorMessage ? `<div class="alert" role="alert">${escapeHtml(errorMessage)}</div>` : ''}
<form method="post" action="${escapeHtml(actionUrl)}" autocomplete="on">
  <div class="card">
    <label for="caller_name">Your name</label>
    <input type="text" id="caller_name" name="caller_name" required maxlength="120" autocomplete="name">
    <label for="phone">Your phone number</label>
    <input type="tel" id="phone" name="phone" required maxlength="40" autocomplete="tel" inputmode="tel">
    <label for="email">Email (optional)</label>
    <input type="email" id="email" name="email" maxlength="254" autocomplete="email" inputmode="email">
    <div class="row">
      <div>
        <label for="about_relationship">They are your</label>
        <input type="text" id="about_relationship" name="about_relationship" maxlength="60" placeholder="son, wife, friend" autocomplete="off">
      </div>
      <div>
        <label for="about_first_name">Their first name</label>
        <input type="text" id="about_first_name" name="about_first_name" maxlength="60" autocomplete="off">
      </div>
    </div>
    <div class="hp" aria-hidden="true">
      <label for="company">Company</label>
      <input type="text" id="company" name="company" tabindex="-1" autocomplete="off">
    </div>
    <fieldset>
      <legend>Right now</legend>
      <label class="choice"><input type="radio" name="urgency" value="none" checked><span>Everyone is safe at the moment. I want to talk about next steps.</span></label>
      <label class="choice"><input type="radio" name="urgency" value="immediate_danger"><span>Someone is in danger right now.</span></label>
    </fieldset>
    <div class="danger">
      <strong>This form is not emergency medical care.</strong> If someone is in immediate danger or may have overdosed, call <strong>911</strong> now. If someone is thinking about suicide, call or text <strong>988</strong>. Then come back and send this so ${practice} can follow up.
    </div>
  </div>
  <button type="submit">Ask ${practice} to call me</button>
</form>
<p class="note">Only ${practice} receives what you enter here. Nothing is shared with anyone else.</p>
`);
}

export function thankYouPage(practiceName: string): string {
  const practice = escapeHtml(practiceName);
  return page(`Thank you`, `
<div class="card">
  <h1>Thank you. We will call you shortly.</h1>
  <p class="lede">Someone from ${practice} has your number and will reach out soon. You have done the hard part.</p>
  <div class="danger"><strong>If anything changes and someone is in immediate danger, call 911.</strong> For a suicidal crisis, call or text 988.</div>
</div>
`);
}

export function unavailablePage(): string {
  return page('Link not active', `
<div class="card">
  <h1>This link is not active.</h1>
  <p class="lede">The practice may have replaced it. Please reach them directly, or ask them for their current link.</p>
</div>
`);
}

export function tooManyPage(): string {
  return page('Please try again shortly', `
<div class="card">
  <h1>Please try again in a little while.</h1>
  <p class="lede">We received several requests from this connection just now. If you need to reach the practice right away, please call them directly.</p>
</div>
`);
}
