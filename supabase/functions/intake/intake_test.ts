import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';

import {
  admitPost,
  bucketNames,
  clientAddress,
  escapeHtml,
  formPage,
  IP_LIMIT,
  IP_POST_LIMIT,
  parseSubmission,
  postBucketName,
  type RateLimit,
  thankYouPage,
  TOKEN_LIMIT,
  tokenFromPath,
} from './intake.ts';

const TOKEN = 'a'.repeat(40);

Deno.test('tokenFromPath reads the last segment after intake, local and public shapes', () => {
  assertEquals(tokenFromPath(`/intake/${TOKEN}`), TOKEN);
  assertEquals(tokenFromPath(`/functions/v1/intake/${TOKEN}`), TOKEN);
  assertEquals(tokenFromPath(`/functions/v1/intake/${TOKEN}/`), TOKEN);
  assertEquals(tokenFromPath('/intake'), null);
  assertEquals(tokenFromPath('/intake/not-a-token'), null);
  assertEquals(tokenFromPath('/intake/ABCDEF0123456789ABCDEF0123456789'), null, 'uppercase is not a token');
  assertEquals(tokenFromPath(`/intake/${'f'.repeat(31)}`), null, 'too short');
});

Deno.test('parseSubmission accepts a plain submission and normalizes whitespace', () => {
  const form = new URLSearchParams({
    caller_name: '  Maria   Lopez ',
    phone: '(541) 555-0142',
    email: 'maria@example.test',
    about_relationship: 'son',
    about_first_name: 'Jake',
    urgency: 'immediate_danger',
  });
  const parsed = parseSubmission(form);
  assertEquals(parsed.kind, 'lead');
  if (parsed.kind !== 'lead') return;
  assertEquals(parsed.lead, {
    caller_name: 'Maria Lopez',
    phone: '(541) 555-0142',
    email: 'maria@example.test',
    about_relationship: 'son',
    about_first_name: 'Jake',
    urgency: 'immediate_danger',
    lead_source: 'Website',
    lead_source_detail: 'Intake link',
  });
});

Deno.test('parseSubmission defaults urgency to none and email to blank', () => {
  const parsed = parseSubmission(new URLSearchParams({ caller_name: 'Dan', phone: '5415550177' }));
  assertEquals(parsed.kind, 'lead');
  if (parsed.kind !== 'lead') return;
  assertEquals(parsed.lead.urgency, 'none');
  assertEquals(parsed.lead.email, '');
  assertEquals(parsed.lead.about_relationship, '');
});

Deno.test('parseSubmission rejects a missing name, a short phone, a bad email, and an unknown urgency', () => {
  assertEquals(parseSubmission(new URLSearchParams({ caller_name: '   ', phone: '5415550177' })).kind, 'invalid');
  assertEquals(parseSubmission(new URLSearchParams({ caller_name: 'Dan', phone: '555-0177' })).kind, 'invalid');
  assertEquals(parseSubmission(new URLSearchParams({ caller_name: 'Dan', phone: '5415550177', email: 'nope' })).kind, 'invalid');
  assertEquals(parseSubmission(new URLSearchParams({ caller_name: 'Dan', phone: '5415550177', urgency: 'high' })).kind, 'invalid');
  const tooLong = parseSubmission(new URLSearchParams({ caller_name: 'x'.repeat(500), phone: '5415550177' }));
  assertEquals(tooLong.kind, 'lead');
  if (tooLong.kind === 'lead') assertEquals(tooLong.lead.caller_name.length, 120, 'names are cut to the column limit');
});

Deno.test('parseSubmission treats a filled honeypot as a bot, before any validation', () => {
  const parsed = parseSubmission(new URLSearchParams({ company: 'Acme', caller_name: '', phone: '' }));
  assertEquals(parsed.kind, 'honeypot');
});

Deno.test('parseSubmission strips control characters', () => {
  const parsed = parseSubmission(new URLSearchParams({ caller_name: 'Ma\u0000ria\nLopez', phone: '541\t555\u00010142' }));
  assertEquals(parsed.kind, 'lead');
  if (parsed.kind !== 'lead') return;
  assertEquals(parsed.lead.caller_name, 'Ma ria Lopez');
  assertEquals(parsed.lead.phone, '541 555 0142');
});

Deno.test('escapeHtml neutralizes markup', () => {
  assertEquals(escapeHtml(`<b onclick="x">Tom & Jerry's</b>`), '&lt;b onclick=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/b&gt;');
});

Deno.test('formPage brands the practice, escapes it, and carries the required language', () => {
  const html = formPage('Freedom <Interventions>', `/intake/${TOKEN}`);
  assertStringIncludes(html, 'Freedom &lt;Interventions&gt; will call you back');
  assert(!html.includes('<Interventions>'), 'the practice name is escaped');
  assertStringIncludes(html, 'not emergency medical care');
  assertStringIncludes(html, 'call <strong>911</strong>');
  assertStringIncludes(html, 'text <strong>988</strong>');
  assertStringIncludes(html, 'name="company"', 'honeypot field present');
  assertStringIncludes(html, 'name="urgency" value="immediate_danger"');
  assert(!html.includes('<script'), 'no scripts on the hosted form');
  assertStringIncludes(html, 'name="robots" content="noindex');
});

Deno.test('formPage shows a generic error without echoing input', () => {
  const html = formPage('Practice', '/intake/x', 'Please add your name.');
  assertStringIncludes(html, 'role="alert">Please add your name.');
  assert(!/<input type="(?:text|tel|email)"[^>]*\svalue=/.test(html), 'no text field is pre-filled from the submission');
});

Deno.test('thankYouPage says who will call and never includes submitted data', () => {
  const html = thankYouPage('Freedom Interventions');
  assertStringIncludes(html, 'We will call you shortly');
  assertStringIncludes(html, 'Freedom Interventions has your number');
});

Deno.test('clientAddress prefers the first forwarded address', () => {
  assertEquals(clientAddress(new Headers({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' })), '203.0.113.9');
  assertEquals(clientAddress(new Headers({ 'x-real-ip': '198.51.100.4' })), '198.51.100.4');
  assertEquals(clientAddress(new Headers()), '');
});

Deno.test('bucketNames keys the token and the hashed address, skipping an unknown address', () => {
  assertEquals(bucketNames(TOKEN, 'abc'), { token: `token:${TOKEN}`, ip: 'ip:abc' });
  assertEquals(bucketNames(TOKEN, ''), { token: `token:${TOKEN}`, ip: null });
});

// Records every bucket charged, in order; buckets listed in `full` refuse.
function recorder(full: string[] = []) {
  const hits: string[] = [];
  const hit = (bucket: string, _limit: RateLimit) => {
    hits.push(bucket);
    return Promise.resolve(!full.includes(bucket));
  };
  return { hits, hit };
}

const VALID = new URLSearchParams({ caller_name: 'Dan', phone: '5415550177' });

Deno.test('admitPost: junk posts never touch the practice token bucket', async () => {
  for (const form of [
    new URLSearchParams({ company: 'Acme', caller_name: 'Bot', phone: '5415550177' }),
    new URLSearchParams({ caller_name: '', phone: '' }),
  ]) {
    const { hits, hit } = recorder();
    const decision = await admitPost(TOKEN, 'abc', () => Promise.resolve(form), hit);
    assert(decision.kind === 'honeypot' || decision.kind === 'invalid');
    assertEquals(hits, ['ip-post:abc'], 'only the loose per-address bucket is charged');
  }
});

Deno.test('admitPost: a non-form post is charged to the address only', async () => {
  const { hits, hit } = recorder();
  const decision = await admitPost(TOKEN, 'abc', () => Promise.resolve(null), hit);
  assertEquals(decision.kind, 'bad_content_type');
  assertEquals(hits, ['ip-post:abc']);
});

Deno.test('admitPost: a real lead is charged address-post, address-lead, then token, in that order', async () => {
  const { hits, hit } = recorder();
  const decision = await admitPost(TOKEN, 'abc', () => Promise.resolve(VALID), hit);
  assertEquals(decision.kind, 'lead');
  assertEquals(hits, ['ip-post:abc', 'ip:abc', `token:${TOKEN}`]);
});

Deno.test('admitPost: a full address bucket stops before the form is read', async () => {
  const { hits, hit } = recorder(['ip-post:abc']);
  let read = false;
  const decision = await admitPost(TOKEN, 'abc', () => { read = true; return Promise.resolve(VALID); }, hit);
  assertEquals(decision.kind, 'limited');
  assertEquals(read, false);
  assertEquals(hits, ['ip-post:abc']);
});

Deno.test('admitPost: an address over its lead limit does not spend the token bucket', async () => {
  const { hits, hit } = recorder(['ip:abc']);
  const decision = await admitPost(TOKEN, 'abc', () => Promise.resolve(VALID), hit);
  assertEquals(decision.kind, 'limited');
  assertEquals(hits, ['ip-post:abc', 'ip:abc']);
});

Deno.test('admitPost: a full token bucket refuses the lead', async () => {
  const { hit } = recorder([`token:${TOKEN}`]);
  assertEquals((await admitPost(TOKEN, 'abc', () => Promise.resolve(VALID), hit)).kind, 'limited');
});

Deno.test('admitPost: without a client address only the token bucket applies, and only to leads', async () => {
  const junk = recorder();
  await admitPost(TOKEN, '', () => Promise.resolve(new URLSearchParams({ company: 'x' })), junk.hit);
  assertEquals(junk.hits, []);
  const lead = recorder();
  await admitPost(TOKEN, '', () => Promise.resolve(VALID), lead.hit);
  assertEquals(lead.hits, [`token:${TOKEN}`]);
});

Deno.test('the per-address all-posts limit is looser than the per-address lead limit', () => {
  assertEquals(postBucketName('abc'), 'ip-post:abc');
  assertEquals(postBucketName(''), null);
  assert(IP_POST_LIMIT.perWindow > IP_LIMIT.perWindow);
  assertEquals(TOKEN_LIMIT, { perWindow: 30, windowSeconds: 3600 });
});
