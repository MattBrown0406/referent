import { assert, assertEquals, assertFalse, assertStringIncludes } from 'jsr:@std/assert@1';

import {
  daysAgo,
  DEFAULT_REPLY_TO,
  escapeHtml,
  isAuthorized,
  isTransientStatus,
  type Links,
  oneClickFrom,
  type OutboxRow,
  renderEmail,
  resendBody,
} from './email.ts';

const LINKS: Links = {
  appUrl: 'https://app.referralfit.com',
  portalUrl: 'https://portal.referralfit.com',
  functionUrl: 'https://ref.supabase.co/functions/v1/email-dispatch',
};
const TOKEN = 'a'.repeat(64);
const LINK = 'b'.repeat(64);
const NOW = new Date('2026-11-08T16:00:00Z');

function row(kind: OutboxRow['kind'], data: Record<string, unknown>): OutboxRow {
  return { id: '11111111-1111-1111-1111-111111111111', kind, email: 'p@example.test', data, unsubscribe_token: TOKEN };
}

Deno.test('authorization: the secret header or the service-role bearer, nothing else', () => {
  assert(isAuthorized(new Headers({ 'x-email-dispatch-secret': 's3cret' }), 's3cret', 'svc'));
  assert(isAuthorized(new Headers({ authorization: 'Bearer svc' }), 's3cret', 'svc'));
  assertFalse(isAuthorized(new Headers({ 'x-email-dispatch-secret': 'nope' }), 's3cret', 'svc'));
  assertFalse(isAuthorized(new Headers(), '', ''));
  assertFalse(isAuthorized(new Headers({ 'x-email-dispatch-secret': '' }), '', 'svc'));
});

Deno.test('one-click unsubscribe needs a 64-hex token and a known kind', () => {
  assertEquals(oneClickFrom(new URL(`https://x/?unsubscribe=${TOKEN}&kind=daily_summary`)), { token: TOKEN, kind: 'daily_summary' });
  assertEquals(oneClickFrom(new URL(`https://x/?unsubscribe=${TOKEN}&kind=everything`)), null);
  assertEquals(oneClickFrom(new URL('https://x/?unsubscribe=short&kind=daily_summary')), null);
  assertEquals(oneClickFrom(new URL('https://x/')), null);
});

Deno.test('answer email: counts and a link, no names', () => {
  const email = renderEmail(row('placement_response', { placement_request_id: 'r1', asked: 4, answered: 1 }), LINKS, NOW);
  assertEquals(email.subject, 'A program answered your placement request');
  assertStringIncludes(email.text, '1 of 4 programs have answered so far.');
  assertStringIncludes(email.html, 'href="https://app.referralfit.com"');
  assertStringIncludes(email.text, `Turn off answer emails: https://portal.referralfit.com/u#${TOKEN}:placement_response`);
  assertEquals(email.headers['List-Unsubscribe'], `<https://ref.supabase.co/functions/v1/email-dispatch?unsubscribe=${TOKEN}&kind=placement_response>`);
  assertEquals(email.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assertFalse(email.html.includes('<script'));
});

Deno.test('answer email without counts still reads well', () => {
  const email = renderEmail(row('placement_response', {}), LINKS, NOW);
  assertFalse(email.text.includes('of 0'));
  assertStringIncludes(email.text, 'Open ReferralFit to compare the answers side by side');
});

Deno.test('morning summary: only the lines that have something, singular and plural', () => {
  const email = renderEmail(row('daily_summary', { new_leads: 1, due_today: 2, overdue: 0, answers: 3, day: '2026-11-08' }), LINKS, NOW);
  assertEquals(email.subject, 'Today in ReferralFit: 6 things to look at');
  assertStringIncludes(email.text, '- 1 new lead waiting for a call');
  assertStringIncludes(email.text, '- 2 follow-ups due today');
  assertStringIncludes(email.text, '- 3 program answers to compare');
  assertFalse(email.text.includes('past due'));
  assertStringIncludes(email.text, 'Turn off the morning summary');
  const one = renderEmail(row('daily_summary', { overdue: 1 }), LINKS, NOW);
  assertEquals(one.subject, 'Today in ReferralFit: 1 thing to look at');
  assertStringIncludes(one.text, '- 1 follow-up past due');
});

Deno.test('bed check-in: the listing, its counts, the private link', () => {
  const email = renderEmail(row('bed_reminder', {
    listing_name: 'Juniper Ridge Recovery', beds_male: 3, beds_female: null, beds_updated_at: '2026-10-30T16:00:00Z', link_token: LINK,
  }), LINKS, NOW);
  assertEquals(email.subject, 'Are the open beds at Juniper Ridge Recovery still current?');
  assertStringIncludes(email.text, 'Juniper Ridge Recovery: Men: 3. Women: not set. Last confirmed 9 days ago.');
  assertStringIncludes(email.html, `href="https://portal.referralfit.com/b#${LINK}"`);
  assertStringIncludes(email.text, 'It works for 14 days.');
  const never = renderEmail(row('bed_reminder', { listing_name: 'Oaks', link_token: LINK }), LINKS, NOW);
  assertStringIncludes(never.text, 'Not confirmed yet.');
});

Deno.test('listing names are escaped in HTML and cleaned in the subject', () => {
  const email = renderEmail(row('bed_reminder', { listing_name: 'A <b>&</b> B\r\nBcc: x@y', link_token: LINK }), LINKS, NOW);
  assertFalse(email.subject.includes('\n'));
  assertFalse(email.html.includes('<b>&</b>'));
  assertStringIncludes(email.html, 'A &lt;b&gt;&amp;&lt;/b&gt; B Bcc: x@y');
});

Deno.test('escapeHtml covers quotes', () => {
  assertEquals(escapeHtml(`"'<>&`), '&quot;&#39;&lt;&gt;&amp;');
});

Deno.test('daysAgo', () => {
  assertEquals(daysAgo('2026-11-08T10:00:00Z', NOW), 'today');
  assertEquals(daysAgo('2026-11-07T10:00:00Z', NOW), 'yesterday');
  assertEquals(daysAgo('2026-10-29T10:00:00Z', NOW), '10 days ago');
  assertEquals(daysAgo(null, NOW), '');
  assertEquals(daysAgo('not a date', NOW), '');
});

Deno.test('Resend body: one recipient, both parts, unsubscribe headers, a kind tag', () => {
  const r = row('daily_summary', { due_today: 1 });
  const body = resendBody(r, renderEmail(r, LINKS, NOW), 'ReferralFit <notifications@referralfit.com>', 'help@referralfit.com');
  assertEquals(body.to, ['p@example.test']);
  assertEquals(body.reply_to, 'help@referralfit.com');
  assert(typeof body.html === 'string' && typeof body.text === 'string');
  assertEquals((body.headers as Record<string, string>)['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assertEquals(body.tags, [{ name: 'kind', value: 'daily_summary' }]);
  assertFalse('reply_to' in resendBody(r, renderEmail(r, LINKS, NOW), 'x'));
});

Deno.test('transient statuses', () => {
  for (const status of [429, 408, 500, 502, 503]) assert(isTransientStatus(status), String(status));
  for (const status of [400, 401, 403, 404, 422]) assertFalse(isTransientStatus(status), String(status));
});

Deno.test('replies go to Matt unless EMAIL_REPLY_TO says otherwise', () => {
  assertEquals(DEFAULT_REPLY_TO, 'matt@freedominterventions.com');
});
