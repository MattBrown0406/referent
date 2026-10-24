// Follow-up outreach fixture test — runs src/lib/outreach.ts in plain node
// (type imports only, so no stubs). Covers the timeline steps, the 48-hour
// rhythm (including a daylight-saving change), which step a send closes, the
// minimal draft request, the fallback drafts, and the composer URLs.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.TZ = 'America/Los_Angeles';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'outreach-test');
const require = createRequire(import.meta.url);
const ts = require(path.join(repoRoot, 'node_modules', 'typescript'));

mkdirSync(tmpDir, { recursive: true });
const source = readFileSync(path.join(repoRoot, 'src/lib/outreach.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
const outPath = path.join(tmpDir, 'outreach.js');
writeFileSync(outPath, js);
const outreach = require(outPath);

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS  ${name}`);
}

const CASE = { id: 'c1', title: 'Rivera family', status: 'inquiry', assignedTo: undefined };
const PARTNER = { id: 'p1', organization: 'Cedar Ridge', name: 'Dana Holt', type: 'Inpatient', types: ['Inpatient', 'Detox'], phone: '(541) 555-0199', email: 'dana@example.test' };
const caseTarget = outreach.caseTarget(CASE);
const partnerTarget = outreach.partnerTarget(PARTNER);

console.log('— the 48-hour rhythm —');

check('a send at 3:15 PM is due 3:15 PM two days later', () => {
  const sentAt = new Date(2026, 9, 21, 15, 15);
  assert.deepEqual(outreach.dueAfter(sentAt, 48), { dueOn: '2026-10-23', dueTime: '15:15' });
});

check('48 hours across the fall-back change keeps the clock time', () => {
  const sentAt = new Date(2026, 10, 1 - 1, 9, 30); // Sat Oct 31, 2026; DST ends Sun Nov 1
  assert.deepEqual(outreach.dueAfter(sentAt, 48), { dueOn: '2026-11-02', dueTime: '09:30' });
});

check('48 hours across the spring-forward change keeps the clock time', () => {
  const sentAt = new Date(2027, 2, 13, 22, 0); // Sat Mar 13, 2027; DST starts Sun Mar 14
  assert.deepEqual(outreach.dueAfter(sentAt, 48), { dueOn: '2027-03-15', dueTime: '22:00' });
});

check('a late-evening send rolls over the month', () => {
  assert.deepEqual(outreach.dueAfter(new Date(2026, 9, 30, 23, 50), 48), { dueOn: '2026-11-01', dueTime: '23:50' });
});

check('the next step after a send is a 48-hour follow-up on the same case', () => {
  const next = outreach.nextOutreachFollowUp({ id: 'f2', target: caseTarget, sentAt: new Date(2026, 9, 21, 15, 15) });
  assert.equal(next.caseId, 'c1');
  assert.equal(next.partnerId, undefined);
  assert.equal(next.kind, 'follow_up');
  assert.equal(next.title, 'Follow up — Rivera family');
  assert.equal(next.dueOn, '2026-10-23');
  assert.equal(next.dueTime, '15:15');
  assert.equal(next.status, 'open');
  assert.equal('assignedTo' in next, false, 'unassigned unless the replaced step had an owner');
});

check('a partner next step is a touch on the partner, named for the organization', () => {
  const next = outreach.nextOutreachFollowUp({ id: 'f3', target: partnerTarget, sentAt: new Date(2026, 9, 21, 8, 0), assignedTo: 'u2' });
  assert.equal(next.partnerId, 'p1');
  assert.equal(next.caseId, undefined);
  assert.equal(next.kind, 'touch');
  assert.equal(next.title, 'Follow up — Cedar Ridge');
  assert.equal(next.assignedTo, 'u2');
});

console.log('— the first step of a new timeline —');

check('a new partner gets a follow-up a day out', () => {
  const first = outreach.initialPartnerFollowUp('f1', PARTNER, new Date(2026, 9, 21, 10, 5));
  assert.equal(first.partnerId, 'p1');
  assert.equal(first.dueOn, '2026-10-22');
  assert.equal(first.dueTime, '10:05');
  assert.equal(first.kind, 'touch');
});

check('a partner with no organization is named for the person', () => {
  const first = outreach.initialPartnerFollowUp('f1', { ...PARTNER, organization: '—' }, new Date(2026, 9, 21, 10, 5));
  assert.equal(first.title, 'Follow up — Dana Holt');
});

check('a new inquiry keeps its first call; other open cases get 48 hours; closed and lost get none', () => {
  const now = new Date(2026, 9, 21, 12, 0);
  assert.equal(outreach.initialCaseFollowUp('f1', { ...CASE, status: 'inquiry' }, now), null);
  assert.equal(outreach.initialCaseFollowUp('f1', { ...CASE, status: 'closed' }, now), null);
  assert.equal(outreach.initialCaseFollowUp('f1', { ...CASE, status: 'lost' }, now), null);
  const engaged = outreach.initialCaseFollowUp('f1', { ...CASE, status: 'engaged' }, now);
  assert.equal(engaged.dueOn, '2026-10-23');
  assert.equal(engaged.kind, 'follow_up');
  assert.equal(engaged.caseId, 'c1');
});

console.log('— which step a send closes —');

const open = (overrides) => ({ id: 'x', title: 't', dueOn: '2026-10-21', status: 'open', note: '', kind: 'follow_up', ...overrides });

check('the step the outreach started from wins', () => {
  const followUps = [open({ id: 'a', caseId: 'c1', dueOn: '2026-10-20' }), open({ id: 'b', caseId: 'c1', dueOn: '2026-10-21' })];
  assert.equal(outreach.followUpToComplete(followUps, caseTarget, '2026-10-23', 'b').id, 'b');
});

check('otherwise the earliest open outreach step for the same case, due by the new date', () => {
  const followUps = [
    open({ id: 'later', caseId: 'c1', dueOn: '2026-10-30', kind: 'promised_call' }),
    open({ id: 'consult', caseId: 'c1', dueOn: '2026-10-19', kind: 'consult' }),
    open({ id: 'other-case', caseId: 'c2', dueOn: '2026-10-18' }),
    open({ id: 'first', caseId: 'c1', dueOn: '2026-10-20', kind: 'first_call' }),
    open({ id: 'done', caseId: 'c1', dueOn: '2026-10-17', status: 'done' }),
  ];
  assert.equal(outreach.followUpToComplete(followUps, caseTarget, '2026-10-23').id, 'first');
});

check('a promised call later than the new follow-up stays open', () => {
  const followUps = [open({ id: 'later', caseId: 'c1', dueOn: '2026-10-30', kind: 'promised_call' })];
  assert.equal(outreach.followUpToComplete(followUps, caseTarget, '2026-10-23'), null);
});

check('a stale started-from id falls back to the open steps', () => {
  const followUps = [open({ id: 'gone', caseId: 'c1', status: 'done' }), open({ id: 'live', caseId: 'c1', dueOn: '2026-10-22' })];
  assert.equal(outreach.followUpToComplete(followUps, caseTarget, '2026-10-23', 'gone').id, 'live');
});

check('a consult, waiting-on, check-in, or admit check is never closed by an outreach', () => {
  const followUps = [
    open({ id: 'consult', caseId: 'c1', dueOn: '2026-10-20', kind: 'consult' }),
    open({ id: 'waiting', caseId: 'c1', dueOn: '2026-10-20', kind: 'waiting_on' }),
    open({ id: 'checkin', caseId: 'c1', dueOn: '2026-10-20', kind: 'check_in' }),
    open({ id: 'admit', caseId: 'c1', partnerId: 'p1', referralId: 'r1', dueOn: '2026-10-20' }),
  ];
  for (const started of [undefined, 'consult', 'waiting', 'checkin', 'admit']) {
    assert.equal(outreach.followUpToComplete(followUps, caseTarget, '2026-10-23', started), null, `started from ${started}`);
  }
  assert.equal(outreach.followUpToComplete([...followUps, open({ id: 'step', caseId: 'c1', dueOn: '2026-10-22' })], caseTarget, '2026-10-23', 'consult').id, 'step');
});

check('a partner send never closes a case step that also names the partner', () => {
  const followUps = [
    open({ id: 'checkin', caseId: 'c1', partnerId: 'p1', kind: 'follow_up' }),
    open({ id: 'touch', partnerId: 'p1', kind: 'touch' }),
  ];
  assert.equal(outreach.followUpToComplete(followUps, partnerTarget, '2026-10-23').id, 'touch');
});

console.log('— history, channel, and what leaves the device —');

const events = [
  { id: 'e1', caseId: 'c1', kind: 'call', body: 'Called Ana', occurredAt: '2026-10-19T17:00:00.000Z' },
  { id: 'e2', caseId: 'c1', kind: 'note', body: 'Mom worried about fentanyl', occurredAt: '2026-10-20T17:00:00.000Z' },
  { id: 'e3', caseId: 'c1', kind: 'text', body: 'Texted Ana', occurredAt: '2026-10-20T18:00:00.000Z' },
  { id: 'e4', caseId: 'c2', kind: 'email', body: 'Other case', occurredAt: '2026-10-21T18:00:00.000Z' },
];

check('history counts only calls, texts, and emails for this case', () => {
  assert.deepEqual(outreach.outreachHistory(caseTarget, events, []), { count: 2, lastChannel: 'text', lastAt: '2026-10-20T18:00:00.000Z' });
});

const ana = { key: 'cc1', name: 'Ana Maria Rivera', relationship: 'mother', phone: '(541) 555-0142', email: 'ana@example.test', contactId: 'cc1' };

check('channel suggestions vary and respect what is on file', () => {
  const none = { count: 0, lastChannel: '', lastAt: '' };
  assert.equal(outreach.suggestedChannel(ana, none, 'first_call'), 'call');
  assert.equal(outreach.suggestedChannel(ana, { count: 1, lastChannel: 'call', lastAt: 'x' }), 'text');
  assert.equal(outreach.suggestedChannel(ana, { count: 2, lastChannel: 'text', lastAt: 'x' }), 'email');
  assert.equal(outreach.suggestedChannel({ ...ana, email: '' }, { count: 2, lastChannel: 'text', lastAt: 'x' }), 'call');
  assert.equal(outreach.suggestedChannel({ ...ana, phone: '' }, none), 'email');
});

check('the draft request carries first names and counts, never contact details or notes', () => {
  const body = outreach.buildDraftRequest({
    channel: 'text',
    target: caseTarget,
    recipient: ana,
    senderName: 'Matt Brown',
    practiceName: 'Freedom Interventions',
    history: outreach.outreachHistory(caseTarget, events, []),
    purposeKind: 'follow_up',
    instructions: '  I can talk Thursday  ',
    now: new Date('2026-10-22T19:00:00.000Z'),
  });
  assert.deepEqual(body, {
    channel: 'text',
    target: { kind: 'case', caseId: 'c1' },
    recipient: { firstName: 'Ana', relationship: 'mother', organization: '' },
    sender: { firstName: 'Matt', practiceName: 'Freedom Interventions' },
    situation: { stage: 'inquiry', partnerTypes: [], attempt: 3, lastChannel: 'text', daysSinceLastContact: 2, purpose: 'follow_up' },
    instructions: 'I can talk Thursday',
  });
  const serialized = JSON.stringify(body);
  for (const leaked of ['555', 'ana@example.test', 'Rivera', 'fentanyl', 'Brown']) {
    assert.equal(serialized.includes(leaked), false, `${leaked} must not leave the device`);
  }
});

check('a partner draft request names the organization and types only', () => {
  const body = outreach.buildDraftRequest({
    channel: 'email',
    target: partnerTarget,
    recipient: outreach.partnerRecipient(PARTNER),
    senderName: 'Matt',
    practiceName: '',
    history: { count: 0, lastChannel: '', lastAt: '' },
    instructions: '',
    now: new Date(),
  });
  assert.deepEqual(body.recipient, { firstName: 'Dana', relationship: '', organization: 'Cedar Ridge' });
  assert.deepEqual(body.situation.partnerTypes, ['Inpatient', 'Detox']);
  assert.equal(body.situation.stage, '');
  assert.equal(body.situation.purpose, 'none');
});

check('first names drop honorifics and trailing punctuation', () => {
  assert.equal(outreach.firstName('Dr. Jane Smith'), 'Jane');
  assert.equal(outreach.firstName('  ana,  '), 'ana');
  assert.equal(outreach.firstName('Rivera, Ana'), 'Ana', '"Last, First" sends the first name');
  assert.equal(outreach.firstName('Mrs. Rivera'), '', 'an honorific and one name is a surname: send nothing');
  assert.equal(outreach.firstName(''), '');
});

check('credentials after a comma are not a first name; "Last, First" still is', () => {
  assert.equal(outreach.firstName('Dana Holt, LCSW'), 'Dana');
  assert.equal(outreach.firstName('Jane Doe, PhD, LADC'), 'Jane');
  assert.equal(outreach.firstName('Dr. Dana Holt, Ph.D.'), 'Dana');
  assert.equal(outreach.firstName('John Smith, Jr.'), 'John');
  assert.equal(outreach.firstName('Dana, LMFT'), 'Dana');
  assert.equal(outreach.firstName('Holt, Dana, LCSW'), 'Dana');
  assert.equal(outreach.firstName('Smith Jr., John'), 'John');
  assert.equal(outreach.firstName('Smith, Dr. Jane'), 'Jane');
  assert.equal(outreach.firstName('RIVERA, ANA'), 'ANA', 'an all-caps "Last, First" still sends the first name, never the surname');
});

check('a name field holding contact details or someone else\'s name sends no name', () => {
  for (const name of ['ana@example.test', '(541) 555-0142', '+1 541 555 0142', '5415550142', "Jake's mom", 'Jake’s mother', '—', '  ']) {
    assert.equal(outreach.firstName(name), '', JSON.stringify(name));
  }
  assert.equal(outreach.firstName('jane.smith'), 'jane', 'a sign-up handle sends the first part only');
  for (const [name, given] of [['T.J. Miller', 'T.J.'], ['A.J.', 'A.J.'], ['J.R. Smith', 'J.R.'], ['jane_doe', 'jane']]) {
    assert.equal(outreach.firstName(name), given, `${name}: initials are the name, not a handle`);
  }
  assert.equal(outreach.firstName('“Ana” Rivera'), 'Ana');
  assert.equal(outreach.firstName('Mary Ann (sister)'), 'Mary');
  const body = outreach.buildDraftRequest({
    channel: 'text',
    target: caseTarget,
    recipient: { ...ana, name: 'ana.rivera@example.test' },
    senderName: 'matt.brown',
    practiceName: '',
    history: { count: 0, lastChannel: '', lastAt: '' },
    instructions: '',
    now: new Date(),
  });
  assert.equal(body.recipient.firstName, '');
  assert.equal(body.sender.firstName, 'matt');
  assert.equal(/@|rivera|brown/i.test(JSON.stringify(body)), false, 'no address and no surname leaves the device');
  const draft = outreach.templateDraft({ channel: 'text', target: partnerTarget, recipient: { ...outreach.partnerRecipient(PARTNER), name: 'Dana Holt, LCSW' }, senderName: 'Matt', practiceName: '', history: { count: 0, lastChannel: '', lastAt: '' } });
  assert.equal(draft.body.startsWith('Hi Dana,'), true, draft.body);
});

console.log('— without AI, and the composers —');

check('family fallback drafts are discreet', () => {
  for (const channel of ['text', 'email', 'call']) {
    const draft = outreach.templateDraft({ channel, target: caseTarget, recipient: ana, senderName: 'Matt', practiceName: 'Freedom Interventions', history: { count: 1, lastChannel: 'call', lastAt: 'x' } });
    const text = Object.values(draft).flat().join(' ').toLowerCase();
    for (const word of ['addiction', 'rehab', 'treatment', 'detox', 'intervention ', 'drinking']) {
      assert.equal(text.includes(word), false, `${channel} fallback must not say "${word}"`);
    }
    assert.equal(/\[|\{\{/.test(text), false, 'no placeholders');
    assert.equal(draft.channel, channel);
  }
});

check('partner fallback drafts never trade referrals', () => {
  const draft = outreach.templateDraft({ channel: 'email', target: partnerTarget, recipient: outreach.partnerRecipient(PARTNER), senderName: 'Matt', practiceName: 'Freedom Interventions', history: { count: 0, lastChannel: '', lastAt: '' } });
  assert.equal(/referral|send you|in exchange/i.test(draft.body), false);
});

check('sms and mailto URLs are encoded for each platform', () => {
  assert.equal(outreach.smsUrl('(541) 555-0142', 'Hi Ana & co?', 'ios'), 'sms:5415550142&body=Hi%20Ana%20%26%20co%3F');
  assert.equal(outreach.smsUrl('+1 541 555 0142', 'Hi', 'android'), 'sms:+15415550142?body=Hi');
  assert.equal(outreach.mailtoUrl(' ana@example.test ', 'Checking in', 'Line one\nLine two'), 'mailto:ana@example.test?subject=Checking%20in&body=Line%20one%0ALine%20two');
  // A body with every character that would end or split the query string
  // (& # % ? = + newlines) and an emoji comes back intact.
  const body = 'Rates & times: 50% off? #2 = A+B\n\nTalk soon 🙂 — Matt';
  for (const url of [outreach.smsUrl('5415550142', body, 'ios'), outreach.smsUrl('5415550142', body, 'android'), outreach.mailtoUrl('ana@example.test', 'Q&A #1 100%', body)]) {
    const query = url.slice(url.indexOf('body=') + 'body='.length);
    assert.equal(/[&#\s?]/.test(query.replace(/&subject=.*$/, '')), false, `raw separators leaked into ${url}`);
    assert.equal(decodeURIComponent(query), body);
  }
  assert.equal(new URL(outreach.mailtoUrl('ana@example.test', 'Q&A #1 100%', body)).searchParams.get('subject'), 'Q&A #1 100%');
});

check('channels need a usable number or address', () => {
  assert.equal(outreach.channelAvailable(ana, 'text'), true);
  assert.equal(outreach.channelAvailable({ ...ana, phone: '555' }, 'call'), false);
  assert.equal(outreach.channelAvailable({ ...ana, email: 'not-an-email' }, 'email'), false);
  assert.equal(outreach.channelAvailable(null, 'text'), false);
});

check('case recipients put the primary first and skip contacts with nothing on file', () => {
  const recipients = outreach.caseRecipients([
    { id: 'a', caseId: 'c1', name: 'Zed', relationship: 'uncle', phone: '5415550100', email: '', isPrimary: false, note: '' },
    { id: 'b', caseId: 'c1', name: 'Ana', relationship: 'mother', phone: '5415550142', email: '', isPrimary: true, note: '' },
    { id: 'c', caseId: 'c1', name: 'Nobody', relationship: '', phone: ' ', email: '', isPrimary: false, note: '' },
  ]);
  assert.deepEqual(recipients.map((item) => item.key), ['b', 'a']);
});

check('the event body says who and how', () => {
  assert.equal(outreach.outreachEventBody('text', ana), 'Texted Ana Maria Rivera (mother) (follow-up)');
  assert.equal(outreach.outreachEventBody('call', ana, 'voicemail'), 'Called Ana Maria Rivera (mother) — left a voicemail');
});

check('the timeline lists recent outreach, oldest first, then the open steps', () => {
  const entries = outreach.outreachTimeline(caseTarget, [open({ id: 'n1', caseId: 'c1', dueOn: '2026-10-23' }), open({ id: 'n0', caseId: 'c1', dueOn: '2026-10-22' })], events, [], 4);
  assert.deepEqual(entries.map((entry) => entry.id), ['e1', 'e3', 'n0', 'n1']);
});

check('sign-up placeholders never sign a draft, and a partner without an organization sends none', () => {
  assert.equal(outreach.senderOrBlank('Member'), '');
  assert.equal(outreach.practiceOrBlank('My Practice'), '');
  assert.equal(outreach.practiceOrBlank('Freedom Interventions'), 'Freedom Interventions');
  const body = outreach.buildDraftRequest({
    channel: 'text',
    target: outreach.partnerTarget({ ...PARTNER, organization: '—' }),
    recipient: outreach.partnerRecipient(PARTNER),
    senderName: 'Member',
    practiceName: 'My Practice',
    history: { count: 0, lastChannel: '', lastAt: '' },
    instructions: '',
    now: new Date(),
  });
  assert.deepEqual(body.sender, { firstName: '', practiceName: '' });
  assert.equal(body.recipient.organization, '', 'the contact\'s full name never stands in for the organization');
  const text = outreach.templateDraft({ channel: 'text', target: caseTarget, recipient: ana, senderName: 'Member', practiceName: 'My Practice', history: { count: 0, lastChannel: '', lastAt: '' } });
  assert.equal(/Member|My Practice|it's me|— me/.test(text.body), false);
  const signed = outreach.templateDraft({ channel: 'text', target: caseTarget, recipient: ana, senderName: 'Matt', practiceName: '', history: { count: 0, lastChannel: '', lastAt: '' } });
  assert.equal((signed.body.match(/Matt/g) || []).length, 1, 'signed once, not twice');
});

check('a pasted Anthropic key is cleaned, recognized, and masked', () => {
  const key = `sk-ant-api03-${'Ab9_-'.repeat(18)}xY7z`;
  assert.equal(outreach.normalizeAnthropicKey(`  "${key}"\n`), key);
  assert.equal(outreach.normalizeAnthropicKey(`“${key}”`), key);
  assert.equal(outreach.looksLikeAnthropicKey(key), true);
  assert.equal(outreach.looksLikeAnthropicKey('sk-ant-tooshort'), false);
  assert.equal(outreach.looksLikeAnthropicKey(`sk-proj-${'a'.repeat(40)}`), false);
  assert.equal(outreach.maskAnthropicKey(key), 'sk-ant-…xY7z');
  assert.equal(outreach.maskAnthropicKey(key).includes(key.slice(8, 20)), false, 'the mask never shows the middle of the key');
});

check('due labels read naturally', () => {
  const now = new Date(2026, 9, 21, 9, 0);
  assert.equal(outreach.describeDue('2026-10-21', '15:15', now), 'Today 3:15 PM');
  assert.equal(outreach.describeDue('2026-10-22', undefined, now), 'Tomorrow');
  assert.equal(outreach.describeDue('2026-10-24', '09:05', now), 'Sat, Oct 24 · 9:05 AM');
});

console.log(`\nAll ${passed} outreach checks passed.`);
