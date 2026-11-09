// Pure helpers for the email dispatcher: who may call it, what each email
// says, and which send failures are worth trying again. No network, no
// database (index.ts does those), so all of it is unit-tested.
//
// What an email may say (docs/EMAIL.md):
//   * an answer email and the morning summary carry counts only, never a
//     client, family, caller, case or program name (like push);
//   * the bed check-in names the program's own listing, to that program;
//   * the family assessment invite (docs/FAMILY_ASSESSMENT.md) goes to the
//     family a practitioner chose, in the practice's name, and says nothing
//     about the client; the "submitted" email to the practitioner carries no
//     name or answer;
//   * every preference email says why it was sent and links to a page that
//     turns that email off without a sign-in, plus RFC 8058 one-click
//     unsubscribe.

import { timingSafeEqual } from '../_shared/webhooks.ts';

// Emails a person chooses (and can turn off from any of them).
export type PreferenceKind = 'placement_response' | 'daily_summary' | 'bed_reminder';
// Account emails a person asked for by acting (a claim request and its
// answer, a family assessment sent and finished): no preference, no
// unsubscribe link (20261108150000, 20261109140000).
export type AccountKind = 'claim_request' | 'claim_decision' | 'family_assessment_invite' | 'family_assessment_submitted';
export type EmailKind = PreferenceKind | AccountKind;

export const EMAIL_KINDS: PreferenceKind[] = ['placement_response', 'daily_summary', 'bed_reminder'];

export function isPreferenceKind(kind: EmailKind): kind is PreferenceKind {
  return (EMAIL_KINDS as string[]).includes(kind);
}

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
  // The project URL, for a practice's logo in the public org-logos bucket.
  storageUrl?: string;
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
// Replies go to Matt (Matt, 2026-11-08); EMAIL_REPLY_TO overrides.
export const DEFAULT_REPLY_TO = 'matt@freedominterventions.com';
export const RESEND_URL = 'https://api.resend.com/emails';

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export function isAuthorized(headers: Headers, secret: string, serviceRoleKey: string): boolean {
  const given = headers.get('x-email-dispatch-secret') || '';
  if (secret && given && timingSafeEqual(given, secret)) return true;
  const bearer = (headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return Boolean(serviceRoleKey && bearer && timingSafeEqual(bearer, serviceRoleKey));
}

/** The one-click unsubscribe in a request URL, or null when it is not one. */
export function oneClickFrom(url: URL): { token: string; kind: PreferenceKind } | null {
  const token = url.searchParams.get('unsubscribe') || '';
  const kind = url.searchParams.get('kind') || '';
  if (!TOKEN_PATTERN.test(token) || !EMAIL_KINDS.includes(kind as PreferenceKind)) return null;
  return { token, kind: kind as PreferenceKind };
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
  // A practice's own email (the family assessment invite): its name, and its logo when it has one.
  brand?: { name: string; logoUrl: string | null };
  subject: string;
  preheader: string;
  heading: string;
  paragraphs: string[];
  bullets?: string[];
  button: { label: string; url: string };
  afterButton?: string;
  why: string;
  // The "turn off" link's label; absent for account emails (no unsubscribe).
  offLabel?: string;
};

const LOGO_PATH = /^[0-9a-f-]{36}\/logo-[0-9]{10,16}\.(png|jpg|webp)$/;
const EMAIL_PATTERN = /^[^@\s"<>,;]+@[^@\s"<>,;]+\.[^@\s"<>,;]+$/;

/** A practice's logo, from the public org-logos bucket, or null. */
export function logoUrl(path: unknown, links: Links): string | null {
  if (typeof path !== 'string' || !LOGO_PATH.test(path) || !links.storageUrl) return null;
  return `${links.storageUrl.replace(/\/+$/, '')}/storage/v1/object/public/org-logos/${path}`;
}

/** "November 12, 2026" for an ISO date, or ''. */
function longDate(iso: unknown): string {
  if (typeof iso !== 'string') return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
}

function content(row: OutboxRow, links: Links, now: Date): Content {
  const data = row.data || {};
  if (row.kind === 'family_assessment_invite') {
    const practice = plain(data.practice_name, 80) || 'Your practitioner';
    const name = plain(data.recipient_name, 60).split(' ')[0];
    const token = plain(data.link_token, 64);
    if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('family assessment invite without a link');
    const until = longDate(data.expires_at);
    return {
      brand: { name: practice, logoUrl: logoUrl(data.logo_path, links) },
      subject: `${practice}: your private family assessment`,
      preheader: 'A private form to help plan care. Your answers save as you go.',
      heading: `${practice} sent you a family assessment`,
      paragraphs: [
        name ? `Hi ${name},` : '',
        `${practice} asked you to fill out a confidential assessment about your loved one. Your answers help them understand what is happening and find the right care.`,
        'It takes about 30 to 45 minutes. Your answers save as you go, so you can stop and come back with this same link.',
        'If anyone may be in danger right now, call 911. For a mental health crisis, call or text 988.',
      ].filter(Boolean),
      button: { label: 'Open the assessment', url: `${links.portalUrl}/f#${token}` },
      afterButton: `This link is private to you${until ? ` and works until ${until}` : ''}. Please do not forward this email.`,
      why: `You get this because ${practice} sent it to you through ReferralFit. Reply to this email to reach ${practice}.`,
    };
  }
  if (row.kind === 'family_assessment_submitted') {
    const urgent = data.urgent === true;
    return urgent
      ? {
        subject: 'A family assessment needs your attention today',
        preheader: 'Some answers mention safety concerns.',
        heading: 'A family assessment needs your attention today',
        paragraphs: [
          'A family finished the assessment you sent, and some answers mention safety concerns. Open the case in ReferralFit and reach out today.',
          'If someone may be in danger, call 911. For a mental health crisis, the family can call or text 988.',
        ],
        button: { label: 'Open ReferralFit', url: links.appUrl },
        why: 'You get this because you sent a family assessment in ReferralFit. Names and answers never appear in email.',
      }
      : {
        subject: 'A family finished their assessment',
        preheader: 'Open the case to read the answers.',
        heading: 'A family finished their assessment',
        paragraphs: ['A family finished the assessment you sent. Open the case in ReferralFit to read the answers and rate the level of care.'],
        button: { label: 'Open ReferralFit', url: links.appUrl },
        why: 'You get this because you sent a family assessment in ReferralFit. Names and answers never appear in email.',
      };
  }
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
  if (row.kind === 'claim_request') {
    const listing = plain(data.listing_name) || 'A program';
    const place = [plain(data.city, 60), plain(data.state, 4)].filter(Boolean).join(', ');
    const waiting = count(data.waiting);
    return {
      subject: `Claim request: ${listing}`,
      preheader: 'A program asked to manage its listing.',
      heading: 'A program asked to manage its listing',
      paragraphs: [
        place ? `${listing} (${place}) asked to keep its ReferralFit listing current.` : `${listing} asked to keep its ReferralFit listing current.`,
        data.email_matches_website === true
          ? "The requester's email address matches the program's website."
          : "The requester's email address does not match the program's website. Check before approving, for example by calling the program's main number.",
        waiting > 1 ? `${waiting} claim requests are waiting.` : '',
      ].filter(Boolean),
      button: { label: 'Review in ReferralFit', url: links.appUrl },
      afterButton: 'In the app: Workspace and settings, Program claim requests.',
      why: 'You get this because you review claim requests for ReferralFit.',
    };
  }
  if (row.kind === 'claim_decision') {
    const listing = plain(data.listing_name) || 'your program';
    const note = plain(data.decision_note, 500);
    const approved = data.approved === true;
    return approved
      ? {
        subject: `You can now manage ${listing} on ReferralFit`,
        preheader: 'Your request was approved.',
        heading: 'Your request was approved',
        paragraphs: [
          `You now manage ${listing} in the ReferralFit program portal.`,
          'Keep your open beds, levels of care, insurance and admissions contacts current, answer placement requests from interventionists, and refer families to them. It is free.',
          ...(note ? [`Note from ReferralFit: ${note}`] : []),
        ],
        button: { label: 'Open the program portal', url: links.portalUrl },
        why: 'You get this because you asked to manage a listing on ReferralFit. Questions? Reply to this email.',
      }
      : {
        subject: 'About your ReferralFit listing request',
        preheader: `We could not approve your request to manage ${listing}.`,
        heading: 'We could not approve your request',
        paragraphs: [
          `We could not confirm your request to manage ${listing}.`,
          ...(note ? [`Note from ReferralFit: ${note}`] : []),
          'Reply to this email and we will help you get set up.',
        ],
        button: { label: 'Open the program portal', url: links.portalUrl },
        why: 'You get this because you asked to manage a listing on ReferralFit.',
      };
  }
  if (row.kind !== 'bed_reminder') {
    // A kind this function does not know (a newer database): never send it
    // as a bed check-in; the dispatcher records render_failed instead.
    throw new Error(`unknown email kind: ${String(row.kind)}`);
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
    why: 'You get this because your program claimed its listing on ReferralFit. We send it only when your beds have not been confirmed in the last 5 days, at most every 5 days.',
    offLabel: 'Turn off bed check-in emails',
  };
}

const GREEN = '#1F5A49';
const INK = '#16352E';
const SOFT = '#38564F';

function html(c: Content, offUrl: string | null): string {
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
    + (c.brand
      ? `<tr><td style="padding:28px 28px 8px;font-size:17px;font-weight:800;color:${INK}">${
        c.brand.logoUrl ? `<img src="${escapeHtml(c.brand.logoUrl)}" alt="" height="48" style="display:block;height:48px;max-width:220px;margin:0 0 10px;border:0">` : ''
      }${escapeHtml(c.brand.name)}</td></tr>`
      : `<tr><td style="padding:28px 28px 8px;font-size:15px;font-weight:800;color:${GREEN}">ReferralFit</td></tr>`)
    + `<tr><td style="padding:8px 28px 28px">`
    + `<h1 style="margin:0 0 14px;font-size:22px;line-height:1.3;color:${INK}">${escapeHtml(c.heading)}</h1>`
    + paragraphs + bullets
    + `<a href="${escapeHtml(c.button.url)}" style="display:inline-block;background:${GREEN};color:#FFFFFF;text-decoration:none;font-weight:700;font-size:16px;padding:13px 22px;border-radius:12px">${
      escapeHtml(c.button.label)
    }</a>`
    + after
    + `</td></tr>`
    + `<tr><td style="padding:18px 28px 26px;border-top:1px solid #DDE4DF;font-size:13px;line-height:1.5;color:${SOFT}">${escapeHtml(c.why)}<br>`
    + (offUrl && c.offLabel ? `<a href="${escapeHtml(offUrl)}" style="color:${GREEN}">${escapeHtml(c.offLabel)}</a> &middot; ` : '')
    + (c.brand ? `Sent for ${escapeHtml(c.brand.name)} by ` : '')
    + `<a href="https://referralfit.com" style="color:${GREEN}">referralfit.com</a></td></tr>`
    + `</table></td></tr></table></body></html>`;
}

function text(c: Content, offUrl: string | null): string {
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
    ...(offUrl && c.offLabel ? [`${c.offLabel}: ${offUrl}`] : []),
  ].join('\n');
}

export function renderEmail(row: OutboxRow, links: Links, now = new Date()): RenderedEmail {
  const c = content(row, links, now);
  const off = isPreferenceKind(row.kind) ? unsubscribeLinks(row, links) : null;
  return {
    subject: plain(c.subject, 160),
    html: html(c, off ? off.page : null),
    text: text(c, off ? off.page : null),
    headers: off
      ? { 'List-Unsubscribe': `<${off.oneClick}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
      : {},
  };
}

/** When the row was first prepared (its counts and links are from then), or now. */
export function preparedAt(row: OutboxRow): Date {
  const raw = (row.data as Record<string, unknown> | null | undefined)?.prepared_at;
  const at = typeof raw === 'string' ? new Date(raw) : null;
  return at && !Number.isNaN(at.getTime()) ? at : new Date();
}

/**
 * Resend's Idempotency-Key: the outbox id plus a short hash of what the
 * sender settings put in the body. A retry of the same row with the same
 * settings replays the first result; after a sender fix it is a new send.
 */
export async function idempotencyKey(row: OutboxRow, from: string, replyTo: string | undefined, links: Links): Promise<string> {
  const basis = [from, replyTo || '', row.email, links.appUrl, links.portalUrl, links.functionUrl].join('\n');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(basis)));
  const hex = Array.from(digest.slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${row.id}-${hex}`;
}

/**
 * Who an email is from and where replies go. A practice's own email (the
 * family assessment invite) is from "<practice> via ReferralFit" at the
 * same address, and replies go to the practitioner who sent it. Anything
 * unusable falls back to the defaults, so one row's sender can never stop
 * the queue.
 */
export function senderFor(row: OutboxRow, from: string, replyTo: string | undefined): { from: string; replyTo?: string } {
  if (row.kind !== 'family_assessment_invite') return { from, replyTo };
  const address = /<([^<>]+)>\s*$/.exec(from)?.[1] || from;
  const practice = plain(row.data?.practice_name, 60).replace(/[^A-Za-z0-9 .&'-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const reply = typeof row.data?.reply_to === 'string' ? row.data.reply_to.trim().toLowerCase() : '';
  return {
    from: practice ? `${practice} via ReferralFit <${address}>` : from,
    replyTo: EMAIL_PATTERN.test(reply) && reply.length <= 254 ? reply : replyTo,
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

/**
 * What a failed Resend response means for the email (body = Resend's JSON
 * error, when it sent one):
 *   retry  - rate limits, server errors, 409 concurrent_idempotent_requests;
 *   config - the account or sender is wrong (401/403, an invalid from or
 *            reply-to, an unverified sending domain): no email can go out,
 *            so the run stops;
 *   final  - this email cannot be sent (an invalid recipient, or 409
 *            invalid_idempotent_request: the key was used with a different
 *            body, which a retry of the same prepared row never sends, so it
 *            is recorded as a failure to look at, never as sent).
 * A retry of a prepared row renders the same body (prepared_at) under a key
 * that changes with the sender settings (idempotencyKey), so Resend answers
 * a repeat with the first result instead of a 409.
 */
export type FailureKind = 'retry' | 'config' | 'final';

export function classifyResendFailure(status: number, body: unknown): FailureKind {
  const name = body && typeof body === 'object' && typeof (body as { name?: unknown }).name === 'string'
    ? (body as { name: string }).name
    : '';
  const message = body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string'
    ? (body as { message: string }).message.toLowerCase()
    : '';
  if (status === 409) return name === 'concurrent_idempotent_requests' ? 'retry' : 'final';
  if (status === 401 || status === 403) return 'config';
  if (status === 422 && (name === 'invalid_from_address' || /\b(from|reply_to|reply-to)\b|domain is not verified/.test(message))) return 'config';
  if (isTransientStatus(status)) return 'retry';
  return 'final';
}

export type SendResult = { id: string; provider_id?: string; error?: string; retry?: boolean };
