// Pure helpers for the email dispatcher: who may call it, what each email
// says, and which send failures are worth trying again. No network, no
// database (index.ts does those), so all of it is unit-tested.
//
// What an email may say (docs/EMAIL.md):
//   * an answer email and the morning summary carry counts only, never a
//     client, family, caller, case or program name (like push);
//   * the bed check-in names the program's own listing, to that program;
//   * every email says why it was sent and links to a page that turns that
//     email off without a sign-in, plus RFC 8058 one-click unsubscribe.

import { timingSafeEqual } from '../_shared/webhooks.ts';

export type EmailKind = 'placement_response' | 'daily_summary' | 'bed_reminder';

export const EMAIL_KINDS: EmailKind[] = ['placement_response', 'daily_summary', 'bed_reminder'];

export type OutboxRow = {
  id: string;
  kind: EmailKind;
  email: string;
  data: Record<string, unknown>;
  unsubscribe_token: string;
};

export type Links = {
  appUrl: string;
  portalUrl: string;
  // The dispatcher's own URL, for one-click unsubscribe (a POST from the mail client).
  functionUrl: string;
};

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
};

export const DEFAULT_APP_URL = 'https://app.referralfit.com';
export const DEFAULT_PORTAL_URL = 'https://portal.referralfit.com';
export const DEFAULT_FROM = 'ReferralFit <notifications@referralfit.com>';
export const RESEND_URL = 'https://api.resend.com/emails';

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export function isAuthorized(headers: Headers, secret: string, serviceRoleKey: string): boolean {
  const given = headers.get('x-email-dispatch-secret') || '';
  if (secret && given && timingSafeEqual(given, secret)) return true;
  const bearer = (headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return Boolean(serviceRoleKey && bearer && timingSafeEqual(bearer, serviceRoleKey));
}

/** The one-click unsubscribe in a request URL, or null when it is not one. */
export function oneClickFrom(url: URL): { token: string; kind: EmailKind } | null {
  const token = url.searchParams.get('unsubscribe') || '';
  const kind = url.searchParams.get('kind') || '';
  if (!TOKEN_PATTERN.test(token) || !EMAIL_KINDS.includes(kind as EmailKind)) return null;
  return { token, kind: kind as EmailKind };
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Text that came from the database, made safe for a subject or a line. */
function plain(value: unknown, max = 120): string {
  const text = typeof value === 'string' ? value : '';
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function count(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function bedCount(value: unknown): string {
  return value === null || value === undefined || value === '' ? 'not set' : String(count(value));
}

/** "today", "yesterday", "9 days ago", or "" for a missing date. */
export function daysAgo(iso: unknown, now: Date): string {
  if (typeof iso !== 'string' || !iso) return '';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const days = Math.floor((now.getTime() - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

export function unsubscribeLinks(row: OutboxRow, links: Links): { page: string; oneClick: string } {
  const query = new URLSearchParams({ unsubscribe: row.unsubscribe_token, kind: row.kind });
  return {
    page: `${links.portalUrl}/u#${row.unsubscribe_token}:${row.kind}`,
    oneClick: `${links.functionUrl}?${query.toString()}`,
  };
}

type Content = {
  subject: string;
  preheader: string;
  heading: string;
  paragraphs: string[];
  bullets?: string[];
  button: { label: string; url: string };
  afterButton?: string;
  why: string;
  offLabel: string;
};

function content(row: OutboxRow, links: Links, now: Date): Content {
  const data = row.data || {};
  if (row.kind === 'placement_response') {
    const asked = count(data.asked);
    const answered = count(data.answered);
    const progress = asked > 0 ? `${answered} of ${plural(asked, 'program', 'programs')} have answered so far.` : '';
    return {
      subject: 'A program answered your placement request',
      preheader: progress || 'Open ReferralFit to compare the answers.',
      heading: 'A program answered your placement request',
      paragraphs: [progress, 'Open ReferralFit to compare the answers side by side: who can admit, how soon, and the daily rate.'].filter(Boolean),
      button: { label: 'Compare answers', url: links.appUrl },
      why: 'You get this because you asked programs about a placement in ReferralFit. Program names and client details stay in the app.',
      offLabel: 'Turn off answer emails',
    };
  }
  if (row.kind === 'daily_summary') {
    const lines = [
      [count(data.new_leads), 'new lead waiting for a call', 'new leads waiting for a call'],
      [count(data.due_today), 'follow-up due today', 'follow-ups due today'],
      [count(data.overdue), 'follow-up past due', 'follow-ups past due'],
      [count(data.answers), 'program answer to compare', 'program answers to compare'],
    ] as const;
    const bullets = lines.filter(([n]) => n > 0).map(([n, one, many]) => plural(n, one, many));
    const total = lines.reduce((sum, [n]) => sum + n, 0);
    return {
      subject: `Today in ReferralFit: ${plural(total, 'thing', 'things')} to look at`,
      preheader: bullets.join(', '),
      heading: 'Good morning',
      paragraphs: ['Here is what is waiting for you today.'],
      bullets,
      button: { label: 'Open Today', url: links.appUrl },
      why: 'You get this because you turned on the morning summary in ReferralFit. Names and case details never appear in email.',
      offLabel: 'Turn off the morning summary',
    };
  }
  const listing = plain(data.listing_name) || 'your program';
  const confirmed = daysAgo(data.beds_updated_at, now);
  const status = `Men: ${bedCount(data.beds_male)}. Women: ${bedCount(data.beds_female)}.`
    + (confirmed ? ` Last confirmed ${confirmed}.` : ' Not confirmed yet.');
  const token = plain(data.link_token, 64);
  return {
    subject: `Are the open beds at ${listing} still current?`,
    preheader: status,
    heading: `Are your open beds still current?`,
    paragraphs: [
      `${listing}: ${status}`,
      'Practices using ReferralFit see your open beds when they look for a placement. A count confirmed in the last 7 days shows as a number; after that it shows as unconfirmed.',
    ],
    button: { label: 'Confirm or update beds', url: `${links.portalUrl}/b#${token}` },
    afterButton: 'The button opens a private page for your program. It works for 14 days.',
    why: 'You get this because your program claimed its listing on ReferralFit. We send it at most once a week, and only when your beds have not been confirmed in the last 6 days.',
    offLabel: 'Turn off bed check-in emails',
  };
}

const GREEN = '#1F5A49';
const INK = '#16352E';
const SOFT = '#38564F';

function html(c: Content, offUrl: string): string {
  const paragraphs = c.paragraphs
    .map((p) => `<p style="margin:0 0 14px;font-size:16px;line-height:1.55;color:${INK}">${escapeHtml(p)}</p>`)
    .join('');
  const bullets = c.bullets?.length
    ? `<ul style="margin:0 0 18px;padding-left:20px;font-size:16px;line-height:1.6;color:${INK}">${
      c.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')
    }</ul>`
    : '';
  const after = c.afterButton
    ? `<p style="margin:14px 0 0;font-size:13px;line-height:1.5;color:${SOFT}">${escapeHtml(c.afterButton)}</p>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${
    escapeHtml(c.subject)
  }</title></head><body style="margin:0;padding:0;background:#EDF4EF">`
    + `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(c.preheader)}</div>`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EDF4EF"><tr><td align="center" style="padding:28px 16px">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">`
    + `<tr><td style="padding:28px 28px 8px;font-size:15px;font-weight:800;color:${GREEN}">ReferralFit</td></tr>`
    + `<tr><td style="padding:8px 28px 28px">`
    + `<h1 style="margin:0 0 14px;font-size:22px;line-height:1.3;color:${INK}">${escapeHtml(c.heading)}</h1>`
    + paragraphs + bullets
    + `<a href="${escapeHtml(c.button.url)}" style="display:inline-block;background:${GREEN};color:#FFFFFF;text-decoration:none;font-weight:700;font-size:16px;padding:13px 22px;border-radius:12px">${
      escapeHtml(c.button.label)
    }</a>`
    + after
    + `</td></tr>`
    + `<tr><td style="padding:18px 28px 26px;border-top:1px solid #DDE4DF;font-size:13px;line-height:1.5;color:${SOFT}">${escapeHtml(c.why)}<br>`
    + `<a href="${escapeHtml(offUrl)}" style="color:${GREEN}">${escapeHtml(c.offLabel)}</a> &middot; <a href="https://referralfit.com" style="color:${GREEN}">referralfit.com</a></td></tr>`
    + `</table></td></tr></table></body></html>`;
}

function text(c: Content, offUrl: string): string {
  return [
    c.heading,
    '',
    ...c.paragraphs.flatMap((p) => [p, '']),
    ...(c.bullets?.length ? [...c.bullets.map((b) => `- ${b}`), ''] : []),
    `${c.button.label}: ${c.button.url}`,
    ...(c.afterButton ? [c.afterButton] : []),
    '',
    '--',
    c.why,
    `${c.offLabel}: ${offUrl}`,
  ].join('\n');
}

export function renderEmail(row: OutboxRow, links: Links, now = new Date()): RenderedEmail {
  const c = content(row, links, now);
  const off = unsubscribeLinks(row, links);
  return {
    subject: plain(c.subject, 160),
    html: html(c, off.page),
    text: text(c, off.page),
    headers: {
      'List-Unsubscribe': `<${off.oneClick}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

/** The request body for Resend's POST /emails. */
export function resendBody(row: OutboxRow, email: RenderedEmail, from: string, replyTo?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    from,
    to: [row.email],
    subject: email.subject,
    html: email.html,
    text: email.text,
    headers: email.headers,
    tags: [{ name: 'kind', value: row.kind }],
  };
  if (replyTo) body.reply_to = replyTo;
  return body;
}

/** A failed send worth trying again later: rate limits, server errors, network. */
export function isTransientStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

export type SendResult = { id: string; provider_id?: string; error?: string; retry?: boolean };
