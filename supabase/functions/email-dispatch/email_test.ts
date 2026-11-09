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
  logoUrl,
  renderEmail,
  resendBody,
  senderFor,
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

Deno.test('claim request email to ReferralFit: the listing, the match, no unsubscribe', () => {
  const email = renderEmail(row('claim_request', { listing_name: 'Juniper Ridge Recovery', city: 'Bend', state: 'OR', email_matches_website: false, waiting: 2 }), LINKS, NOW);
  assertEquals(email.subject, 'Claim request: Juniper Ridge Recovery');
  assertStringIncludes(email.text, 'Juniper Ridge Recovery (Bend, OR) asked to keep its ReferralFit listing current.');
  assertStringIncludes(email.text, 'does not match the program');
  assertStringIncludes(email.text, '2 claim requests are waiting.');
  assertEquals(email.headers, {});
  assertFalse(email.text.includes('/u#'));
  const match = renderEmail(row('claim_request', { listing_name: 'X', email_matches_website: true, waiting: 1 }), LINKS, NOW);
  assertStringIncludes(match.text, "matches the program's website");
  assertFalse(match.text.includes('waiting.'));
});

Deno.test('claim decision email: approved and declined', () => {
  const yes = renderEmail(row('claim_decision', { listing_name: 'Juniper Ridge Recovery', approved: true, decision_note: '' }), LINKS, NOW);
  assertEquals(yes.subject, 'You can now manage Juniper Ridge Recovery on ReferralFit');
  assertStringIncludes(yes.text, 'Open the program portal: https://portal.referralfit.com');
  assertEquals(yes.headers, {});
  const no = renderEmail(row('claim_decision', { listing_name: 'Juniper Ridge Recovery', approved: false, decision_note: 'Email us from your program address.' }), LINKS, NOW);
  assertEquals(no.subject, 'About your ReferralFit listing request');
  assertStringIncludes(no.text, 'Note from ReferralFit: Email us from your program address.');
  assertStringIncludes(no.text, 'Reply to this email');
});

Deno.test('one-click unsubscribe never accepts an account email kind', () => {
  assertEquals(oneClickFrom(new URL(`https://x/?unsubscribe=${TOKEN}&kind=claim_decision`)), null);
});

Deno.test('Resend failures: retry, configuration, final', async () => {
  const { classifyResendFailure } = await import('./email.ts');
  // A key reused with a different body is a failure to look at, never "sent".
  assertEquals(classifyResendFailure(409, { name: 'invalid_idempotent_request' }), 'final');
  assertEquals(classifyResendFailure(409, { name: 'concurrent_idempotent_requests' }), 'retry');
  assertEquals(classifyResendFailure(401, { name: 'missing_api_key' }), 'config');
  assertEquals(classifyResendFailure(403, { name: 'invalid_api_key' }), 'config');
  assertEquals(classifyResendFailure(422, { name: 'invalid_from_address' }), 'config');
  assertEquals(classifyResendFailure(422, { name: 'validation_error', message: 'The example.com domain is not verified' }), 'config');
  assertEquals(classifyResendFailure(422, { name: 'validation_error', message: 'The `to` domain has no MX record' }), 'final');
  assertEquals(classifyResendFailure(422, { name: 'validation_error', message: 'Invalid `to` field' }), 'final');
  assertEquals(classifyResendFailure(429, null), 'retry');
  assertEquals(classifyResendFailure(503, null), 'retry');
  assertEquals(classifyResendFailure(400, null), 'final');
});

Deno.test('a retry renders the same email under the same key; a sender change gets a new key', async () => {
  const { idempotencyKey, preparedAt } = await import('./email.ts');
  const prepared = row('bed_reminder', {
    listing_name: 'Oaks', link_token: LINK, beds_updated_at: '2026-11-01T12:00:00Z', prepared_at: '2026-11-08T15:00:00Z',
  });
  assertEquals(preparedAt(prepared).toISOString(), '2026-11-08T15:00:00.000Z');
  const first = renderEmail(prepared, LINKS, preparedAt(prepared));
  const later = renderEmail(prepared, LINKS, preparedAt(prepared));
  assertEquals(first.text, later.text);
  const key = await idempotencyKey(prepared, 'A <a@x.com>', 'r@x.com', LINKS);
  assertEquals(key, await idempotencyKey(prepared, 'A <a@x.com>', 'r@x.com', LINKS));
  assert(key.startsWith(`${prepared.id}-`) && key.length <= 256);
  assert(key !== await idempotencyKey(prepared, 'B <b@x.com>', 'r@x.com', LINKS));
  assert(key !== await idempotencyKey({ ...prepared, email: 'new@example.com' }, 'A <a@x.com>', 'r@x.com', LINKS));
  assert(preparedAt(row('daily_summary', {})).getTime() > Date.now() - 5000, 'an unprepared row renders as of now');
});

Deno.test('an unknown kind is never rendered as a bed check-in', () => {
  let threw = false;
  try {
    renderEmail({ ...row('bed_reminder', {}), kind: 'something_new' as never }, LINKS, NOW);
  } catch {
    threw = true;
  }
  assert(threw);
});


const ASSESSMENT = {
  assessment_id: '22222222-2222-2222-2222-222222222222',
  link_token: LINK,
  practice_name: 'Okafor Family Interventions',
  logo_path: '33333333-3333-3333-3333-333333333333/logo-1731000000000.png',
  reply_to: 'Grace@Okafor.example.test',
  recipient_name: 'Maria Lopez',
  expires_at: '2026-12-08T16:00:00Z',
};

Deno.test('the family assessment invite: the practice\'s name and logo, the private link, nothing about the client', () => {
  const links = { ...LINKS, storageUrl: 'https://ref.supabase.co' };
  const email = renderEmail(row('family_assessment_invite', ASSESSMENT), links, NOW);
  assertEquals(email.subject, 'Okafor Family Interventions: your private family assessment');
  assertStringIncludes(email.text, `https://portal.referralfit.com/f#${LINK}`);
  assertStringIncludes(email.text, 'Hi Maria,');
  assertStringIncludes(email.text, 'call 911');
  assertStringIncludes(email.text, 'call or text 988');
  assertStringIncludes(email.text, 'works until December 8, 2026');
  assertStringIncludes(email.html, 'https://ref.supabase.co/storage/v1/object/public/org-logos/33333333-3333-3333-3333-333333333333/logo-1731000000000.png');
  assertStringIncludes(email.html, 'Sent for Okafor Family Interventions by');
  assertEquals(email.headers, {}, 'no unsubscribe: the family asked for nothing else');
  assertFalse(email.text.includes('Lopez'), 'only a first name');
});

Deno.test('the invite never goes out without a link, and a bad logo path is left out', () => {
  let threw = false;
  try { renderEmail(row('family_assessment_invite', { ...ASSESSMENT, link_token: 'short' }), LINKS, NOW); } catch { threw = true; }
  assert(threw);
  assertEquals(logoUrl('../../secret.png', { ...LINKS, storageUrl: 'https://ref.supabase.co' }), null);
  assertEquals(logoUrl(ASSESSMENT.logo_path, LINKS), null, 'no project URL, no logo');
  const email = renderEmail(row('family_assessment_invite', { ...ASSESSMENT, logo_path: 'x' }), { ...LINKS, storageUrl: 'https://ref.supabase.co' }, NOW);
  assertFalse(email.html.includes('<img'));
});

Deno.test('the invite is from the practice via ReferralFit, and replies reach the practitioner', () => {
  const sender = senderFor(row('family_assessment_invite', ASSESSMENT), 'ReferralFit <notifications@referralfit.com>', DEFAULT_REPLY_TO);
  assertEquals(sender, { from: 'Okafor Family Interventions via ReferralFit <notifications@referralfit.com>', replyTo: 'grace@okafor.example.test' });
  const odd = senderFor(row('family_assessment_invite', { ...ASSESSMENT, practice_name: 'Evil <x@y.z>, "Inc"', reply_to: 'not an email' }), 'ReferralFit <notifications@referralfit.com>', DEFAULT_REPLY_TO);
  assertEquals(odd.from, 'Evil x y.z Inc via ReferralFit <notifications@referralfit.com>');
  assertEquals(odd.replyTo, DEFAULT_REPLY_TO, 'an unusable reply-to falls back');
  assertEquals(senderFor(row('daily_summary', {}), 'ReferralFit <n@r.com>', 'm@r.com'), { from: 'ReferralFit <n@r.com>', replyTo: 'm@r.com' });
  const body = resendBody(row('family_assessment_invite', ASSESSMENT), renderEmail(row('family_assessment_invite', ASSESSMENT), LINKS, NOW), sender.from, sender.replyTo);
  assertEquals(body.reply_to, 'grace@okafor.example.test');
});

Deno.test('a finished assessment: to the practitioner, no names or answers; urgent says so', () => {
  const plainEmail = renderEmail(row('family_assessment_submitted', { assessment_id: ASSESSMENT.assessment_id, urgent: false }), LINKS, NOW);
  assertEquals(plainEmail.subject, 'A family finished their assessment');
  const urgent = renderEmail(row('family_assessment_submitted', { assessment_id: ASSESSMENT.assessment_id, urgent: true }), LINKS, NOW);
  assertEquals(urgent.subject, 'A family assessment needs your attention today');
  assertStringIncludes(urgent.text, 'safety concerns');
  assertEquals(urgent.headers, {});
});

Deno.test('an urgent answer before the family finishes: to the practitioner, no names or answers', () => {
  const email = renderEmail(row('family_assessment_urgent', { assessment_id: ASSESSMENT.assessment_id, urgent: true }), LINKS, NOW);
  assertEquals(email.subject, 'A family assessment needs your attention today');
  assertStringIncludes(email.text, 'still filling out');
  assertStringIncludes(email.text, '988');
  assertEquals(email.headers, {});
  assertEquals(senderFor(row('family_assessment_urgent', {}), 'ReferralFit <n@r.com>', 'm@r.com'), { from: 'ReferralFit <n@r.com>', replyTo: 'm@r.com' });
});
