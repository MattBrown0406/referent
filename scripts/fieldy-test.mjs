// Fieldy, connected (docs/DAY_REVIEW.md, Phase 2): the sign-in checks, the
// MCP answers, turning conversations into the day review's text, and the
// wiring that keeps tokens on the phone. Run with: node scripts/fieldy-test.mjs

// Clock labels below are written for one zone: the same answer on any machine.
process.env.TZ = 'UTC';

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'fieldy-test');
const require = createRequire(import.meta.url);
const ts = require(path.join(repoRoot, 'node_modules', 'typescript'));
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

function load(relSrc, outName) {
  const js = ts.transpileModule(read(relSrc), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const outPath = path.join(tmpDir, outName);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, js);
  return require(outPath);
}

let checks = 0;
const check = (fn, label) => {
  try { fn(); } catch (error) { console.error(`FAIL ${label || ''}`); throw error; }
  checks += 1;
};

const f = load('src/lib/fieldy.ts', 'fieldy.js');

// ─── Signing in ────────────────────────────────────────────────────────────
check(() => {
  assert.equal(f.base64Url('ab+c/d=='), 'ab-c_d');
  const url = f.authorizeUrl('CHALLENGE', 'STATE');
  assert.ok(url.startsWith('https://api.fieldy.ai/api/auth/oauth2/authorize?response_type=code&client_id='));
  for (const part of ['code_challenge=CHALLENGE', 'code_challenge_method=S256', 'state=STATE',
    `redirect_uri=${encodeURIComponent('com.mattbrown.referralfit:/oauth/fieldy')}`, `resource=${encodeURIComponent('https://api.fieldy.ai/mcp')}`,
    `scope=${encodeURIComponent('openid email offline_access conversations:read transcripts:read')}`]) {
    assert.ok(url.includes(part), part);
  }
  assert.ok(!url.includes('sharables'), 'only the scopes the review needs');
}, 'the sign-in link: PKCE S256, a state, the MCP resource, only the scopes needed');
check(() => {
  const back = 'com.mattbrown.referralfit:/oauth/fieldy?code=abc123&state=STATE&iss=https%3A%2F%2Fapi.fieldy.ai%2Fapi%2Fauth';
  assert.equal(f.codeFromCallback(back, 'STATE'), 'abc123');
  assert.throws(() => f.codeFromCallback(back, 'OTHER'), /did not match/);
  assert.throws(() => f.codeFromCallback('com.mattbrown.referralfit:/oauth/fieldy?code=abc&state=STATE&iss=https%3A%2F%2Fevil.example', 'STATE'), /did not come from Fieldy/);
  assert.throws(() => f.codeFromCallback('com.mattbrown.referralfit:/oauth/fieldy?error=access_denied&state=STATE', 'STATE'), (error) => error.reason === 'denied');
  assert.throws(() => f.codeFromCallback('https://evil.example/oauth/fieldy?code=abc&state=STATE', 'STATE'), /wrong place/);
}, 'the way back: same state, Fieldy as issuer, declined is said so');
check(() => {
  const tokens = f.tokensFrom({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }, 1_000_000);
  assert.deepEqual(tokens, { accessToken: 'a', refreshToken: 'r', expiresAt: 1_000_000 + 3_600_000 - 60_000 });
  assert.throws(() => f.tokensFrom({ access_token: 'a' }), /lasting access/, 'a refresh token is required');
  assert.throws(() => f.tokensFrom({ error: 'invalid_grant' }), (error) => error.reason === 'disconnected');
  assert.equal(f.formBody({ a: 'x y', b: 'c&d' }), 'a=x%20y&b=c%26d');
}, 'tokens');

// ─── MCP answers ───────────────────────────────────────────────────────────
check(() => {
  assert.deepEqual(f.rpcResult('{"jsonrpc":"2.0","id":3,"result":{"ok":1}}', 'application/json', 3), { ok: 1 });
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n\n';
  assert.deepEqual(f.rpcResult(sse, 'text/event-stream', 2), { tools: [] });
  assert.throws(() => f.rpcResult('{"jsonrpc":"2.0","id":2,"error":{"message":"x"}}', 'application/json', 2));
  assert.throws(() => f.rpcResult('<html>', 'text/html', 2));
  assert.equal(f.rpcBody(null, 'notifications/initialized'), '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}');
}, 'JSON and event-stream answers');
check(() => {
  const tools = [
    { name: 'search_conversations', inputSchema: { properties: { query: {}, startTime: {} }, required: ['query'] } },
    { name: 'get_conversation', inputSchema: { properties: { id: {} }, required: ['id'] } },
    { name: 'list_conversations', inputSchema: { properties: { startTime: {}, endTime: {}, pageSize: {}, cursor: {} } } },
    { name: 'get_transcriptions', inputSchema: { properties: { conversationId: {} } } },
    { name: 'create_sharable', inputSchema: { properties: { conversationId: {} } } },
  ];
  const plan = f.listPlan(tools);
  assert.deepEqual(plan, { name: 'list_conversations', start: 'startTime', end: 'endTime', size: 'pageSize', cursor: 'cursor', page: null, firstPage: 1 });
  assert.deepEqual(f.listArguments(plan, 'S', 'E', null), { startTime: 'S', endTime: 'E', pageSize: 50 });
  assert.deepEqual(f.listArguments(plan, 'S', 'E', 'C2'), { startTime: 'S', endTime: 'E', pageSize: 50, cursor: 'C2' });
  assert.deepEqual(f.transcriptPlan(tools), { name: 'get_transcriptions', id: 'conversationId' });
  assert.equal(f.listPlan([{ name: 'search_conversations', inputSchema: { properties: { query: {} }, required: ['query'] } }]), null,
    'a search that needs a question is not a list');
  assert.equal(f.listPlan([{ name: 'list_tasks' }]), null);
}, 'the tools are read from tools/list, not assumed');
check(() => {
  assert.deepEqual(f.toolPayload({ structuredContent: { conversations: [] } }), { conversations: [] });
  assert.deepEqual(f.toolPayload({ content: [{ type: 'text', text: '{"items":[1]}' }] }), { items: [1] });
  assert.deepEqual(f.toolPayload({ content: [{ type: 'text', text: 'plain words' }] }), { text: 'plain words' });
  assert.throws(() => f.toolPayload({ isError: true, content: [] }));
  const { conversations, nextCursor } = f.conversationsFrom({
    data: [
      { id: 'c1', title: 'Call with Sarah', summary: 'Sarah called about her son.', startTime: '2026-11-09T17:00:00Z', endTime: '2026-11-09T17:20:00Z' },
      { id: 'c2', title: '', summary: [{ title: 'Next steps', text: 'Send the packet' }], startTime: '2026-11-09T18:00:00Z' },
      { id: 'bad', startTime: 'yesterday' },
    ],
    nextCursor: 'NEXT',
  });
  assert.equal(conversations.length, 2, 'one without a real time is left out');
  assert.equal(conversations[1].summary, 'Next steps: Send the packet', 'a summary in sections');
  assert.equal(nextCursor, 'NEXT');
  assert.equal(f.transcriptText({ transcriptions: [{ speaker: 'A', text: 'Hi' }, { text: 'Bye' }] }), 'A: Hi\nBye');
}, 'reading what Fieldy sends back');

// ─── Into the day review ───────────────────────────────────────────────────
const at = (iso) => iso;
const conv = (id, start, summary, extra = {}) => ({ id, title: `Talk ${id}`, summary, startTime: at(start), endTime: at(start), ...extra });
check(() => {
  const now = Date.parse('2026-11-09T23:00:00Z');
  const plan = f.reviewPlan([
    conv('b', '2026-11-09T18:00:00Z', 'Promised to call Ana back tomorrow.'),
    conv('a', '2026-11-09T17:00:00Z', 'Sarah Miller called about her son Jake.'),
    conv('a', '2026-11-09T17:00:00Z', 'Sarah Miller called about her son Jake.'),
  ], now);
  assert.deepEqual(plan.blocks.map((block) => block.id), ['a', 'b'], 'oldest first, each once');
  assert.match(plan.text, /^\[From Fieldy, Nov 9, \d+:00 (AM|PM) · Talk a\]\nSarah Miller called/);
  assert.equal(plan.blocks[1].startTime, '2026-11-09T18:00:00Z', 'each block keeps its time, for the note it becomes');
  assert.deepEqual(plan.skipped, []);
  assert.equal(plan.later, 0);
  assert.equal(f.sourceFor('promised to call  Ana back', plan.blocks), plan.blocks[1].label, 'an item says which conversation it came from');
  assert.equal(f.sourceFor('not there at all', plan.blocks), '');
  const twice = f.reviewPlan([conv('x', '2026-11-09T17:00:00Z', 'Called Ana.'), conv('y', '2026-11-09T18:00:00Z', 'Called Ana.')], now);
  assert.equal(f.sourceFor('Called Ana', twice.blocks), '', 'a line in two conversations is not pinned on either');
  assert.equal(f.blocksFor('Called Ana', twice.blocks).length, 2);
  const sameMinute = f.reviewPlan([conv('m2', '2026-11-09T17:00:00Z', 'Second.'), conv('m1', '2026-11-09T17:00:00Z', 'First.')], now);
  assert.deepEqual(sameMinute.blocks.map((block) => block.id), ['m1', 'm2'], 'two at the same minute are both read');
}, 'conversations become review text, labeled');
check(() => {
  const now = Date.parse('2026-11-09T18:30:00Z');
  const plan = f.reviewPlan([
    conv('a', '2026-11-09T17:00:00Z', 'Summary of a.'),
    conv('b', '2026-11-09T18:00:00Z', '', { endTime: '2026-11-09T18:20:00Z' }),
    conv('c', '2026-11-09T18:25:00Z', 'Summary of c.'),
    conv('live', '2026-11-09T18:28:00Z', '', { endTime: '' }),
  ], now);
  assert.deepEqual(plan.blocks.map((block) => block.id), ['a', 'c'], 'one not summarized yet never holds back those after it');
  assert.equal(plan.later, 2, 'it waits, as does one still going on');
  assert.deepEqual(plan.skipped, []);
  const withTranscript = f.reviewPlan([conv('b', '2026-11-09T12:00:00Z', '')], now, { b: 'A: we talked' });
  assert.match(withTranscript.text, /A: we talked/, 'an old one with no summary is read from its transcript');
  const dayLater = f.reviewPlan([conv('none', '2026-11-08T12:00:00Z', '', { endTime: '2026-11-08T12:30:00Z' })], now);
  assert.deepEqual(dayLater.skipped, ['none'], 'no text a day after it ended: skipped, and said so');
  assert.equal(dayLater.later, 0);
}, 'a conversation not summarized yet waits; one never summarized is skipped');
check(() => {
  const now = Date.parse('2026-11-10T03:00:00Z');
  const long = 'x '.repeat(1200);
  const many = Array.from({ length: 10 }, (_, index) => conv(`c${index}`, `2026-11-09T1${index}:00:00Z`, long));
  const plan = f.reviewPlan(many, now);
  assert.ok(plan.text.length <= 12_000, 'within what the review reads');
  assert.ok(plan.blocks.length < 10 && plan.later === 10 - plan.blocks.length, 'the rest wait for the next read');
  const huge = f.reviewPlan([conv('h', '2026-11-09T10:00:00Z', `START ${'y '.repeat(5000)} I will send the packet Friday END`)], now);
  assert.ok(huge.blocks[0].text.length < 6_200, 'a long summary is shortened');
  assert.match(huge.text, /START/);
  assert.match(huge.text, /send the packet Friday END/, 'its end is kept (promises are often last)');
}, 'too much for one review: the rest wait');

// ─── Plaud ─────────────────────────────────────────────────────────────────
check(() => {
  const url = f.authorizeUrl('CHALLENGE', 'STATE', f.PLAUD);
  assert.ok(url.startsWith('https://mcp.plaud.ai/authorize?response_type=code&client_id='));
  assert.ok(url.includes(`redirect_uri=${encodeURIComponent('com.mattbrown.referralfit:/oauth/plaud')}`));
  assert.ok(url.includes(`resource=${encodeURIComponent('https://mcp.plaud.ai/mcp')}`));
  assert.ok(!url.includes('scope=') && !url.includes('prompt='), 'Plaud names no scopes');
  const back = 'com.mattbrown.referralfit:/oauth/plaud?code=pc1&state=S&iss=https%3A%2F%2Fmcp.plaud.ai%2F';
  assert.equal(f.codeFromCallback(back, 'S', f.PLAUD), 'pc1');
  assert.throws(() => f.codeFromCallback(back, 'S', f.FIELDY), /wrong place/, 'a Plaud return is never taken for Fieldy\'s');
  assert.throws(() => f.codeFromCallback('com.mattbrown.referralfit:/oauth/plaud?code=x&state=S&iss=https%3A%2F%2Fapi.fieldy.ai%2Fapi%2Fauth', 'S', f.PLAUD), /did not come from Plaud/);
}, 'Plaud: the sign-in link and the way back');
check(() => {
  const tools = [
    { name: 'login' }, { name: 'logout' }, { name: 'get_current_user' },
    { name: 'list_files', inputSchema: { properties: { query: {}, date_from: {}, date_to: {}, page: {}, page_size: {} } } },
    { name: 'get_file', inputSchema: { properties: { file_id: {} }, required: ['file_id'] } },
    { name: 'get_note', inputSchema: { properties: { file_id: {} }, required: ['file_id'] } },
    { name: 'get_transcript', inputSchema: { properties: { file_id: {} }, required: ['file_id'] } },
  ];
  const plan = f.listPlan(tools);
  assert.deepEqual(plan, { name: 'list_files', start: 'date_from', end: 'date_to', size: 'page_size', cursor: null, page: 'page', firstPage: 1 });
  assert.deepEqual(f.listArguments(plan, '2026-11-09T07:00:00.000Z', '2026-11-09T23:00:00.000Z', null),
    { date_from: '2026-11-08', date_to: '2026-11-10', page_size: 50, page: 1 }, 'a date-only window is widened a day each way');
  assert.equal(f.listArguments(plan, '2026-11-09T07:00:00.000Z', '2026-11-09T23:00:00.000Z', null, 3).page, 3, 'pages by number');
  const fromZero = f.listPlan([{ name: 'list_files', inputSchema: { properties: { date_from: {}, page: { type: 'integer', minimum: 0 } } } }]);
  assert.equal(fromZero.firstPage, 0, 'the first page is 0 when the tool says so');
  assert.equal(f.listArguments(fromZero, '2026-11-09T07:00:00.000Z', '2026-11-09T23:00:00.000Z', null).page, 0);
  assert.deepEqual(f.notePlan(tools), { name: 'get_note', id: 'file_id' });
  assert.deepEqual(f.transcriptPlan(tools), { name: 'get_transcript', id: 'file_id' });
  assert.equal(f.userPlan(tools), 'get_current_user');
  assert.equal(f.logoutPlan(tools), 'logout');
  assert.equal(f.notePlan(f.listPlan ? [{ name: 'list_files', inputSchema: { properties: {} } }] : []), null);
}, 'Plaud: its tools are read from tools/list');
check(() => {
  const { conversations } = f.conversationsFrom({ files: [
    { id: 'p1', name: 'Call with Ana', start_at: '2026-11-09T17:00:00Z', duration: 600000, serial_number: 'x' },
    { id: 'p2', name: '', created_at: '2026-11-09T18:00:00Z' },
  ] });
  assert.equal(conversations[0].title, 'Call with Ana');
  assert.equal(conversations[0].endTime, '2026-11-09T17:10:00.000Z', 'its length is in milliseconds');
  assert.equal(conversations[1].startTime, '2026-11-09T18:00:00Z');
  assert.match(f.noteText({ note_list: ['## Summary\nAna asked about detox.', '## Next\nCall back Friday.'] }), /Ana asked about detox\.\n## Next/);
  assert.equal(f.noteText({ summary: 'Ana asked about detox.', action_items: ['Call back Friday'], key_topics: ['detox', 'insurance'] }),
    'Ana asked about detox.\nAction items:\nCall back Friday\nKey topics: detox\ninsurance');
  assert.equal(f.emailFrom({ user: { email: 'matt@example.test' } }), 'matt@example.test');
  assert.equal(f.emailFrom({ name: 'no email' }), '');
  assert.equal(f.noteText({ title: 'Recording 11-08 09:15' }), '', 'a title alone is not a note');
  assert.equal(f.noteText({ title: 'Call', summary: 'Ana asked.' }), 'Call\nAna asked.');
  assert.equal(f.transcriptText({ segments: [{ speaker: 'Speaker 1', content: 'I need detox' }, { speaker: 'Speaker 2' }] }), 'Speaker 1: I need detox',
    'words under "content"; a speaker with no words is left out');
  assert.equal(f.transcriptText({ segments: [{ speaker: 'A' }] }), '', 'no words, no transcript');
  assert.equal(f.transcriptText({ transcript: 'All of it.' }), 'All of it.');
  const epoch = f.conversationsFrom({ files: [{ id: 'e1', name: 'x', start_at: 1762707600, duration: 60000 }, { id: 'e2', start_at: 1762707600000 }, { id: 'e3', start_at: '2026-11-09 14:15:00' }] });
  assert.deepEqual(epoch.conversations.map((item) => item.startTime.slice(0, 13)), ['2025-11-09T17', '2025-11-09T17', '2026-11-09T14'], 'seconds, milliseconds, or a space for the T');
  assert.equal(epoch.unreadable, false);
  assert.equal(epoch.count, 3, 'every entry listed is counted, readable or not (paging goes by it)');
  assert.equal(f.conversationsFrom({ files: [{ id: 'u', start_at: { when: 'today' } }] }).unreadable, true, 'recordings none of which can be read are never "nothing new"');
  assert.equal(f.conversationsFrom({ files: [] }).unreadable, false);
  const plan = f.reviewPlan([{ ...conversations[0], summary: 'Ana asked about detox.' }], Date.parse('2026-11-09T23:00:00Z'), {}, 'Plaud');
  assert.match(plan.text, /^\[From Plaud, Nov 9, \d+:00 (AM|PM) · Call with Ana\]/);
}, 'Plaud: recordings, notes and the account');

check(() => {
  // Errors say which recorder, and an error about one request is not a lost connection.
  const plaudError = (() => { try { f.rpcResult(JSON.stringify({ jsonrpc: '2.0', id: 4, error: { message: 'no note' } }), 'application/json', 4, f.PLAUD); } catch (error) { return error; } })();
  assert.equal(plaudError.reason, 'tool');
  assert.match(plaudError.message, /^Plaud could not read your recordings/);
  const isError = (() => { try { f.toolPayload({ isError: true, content: [] }, f.PLAUD); } catch (error) { return error; } })();
  assert.equal(isError.reason, 'tool');
  assert.match(isError.message, /^Plaud/);
  const unreadable = (() => { try { f.rpcResult('not json', 'application/json', 1, f.PLAUD); } catch (error) { return error; } })();
  assert.equal(unreadable.reason, 'unavailable');
  assert.match(unreadable.message, /^Plaud sent an answer/);
  // An event stream is read until the answer is in, never longer.
  const head = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n';
  assert.equal(f.hasAnswer(head, 2), false);
  assert.equal(f.hasAnswer(`${head}data: {"jsonrpc":"2.0","id":2,"res`, 2), false, 'not until the event is whole');
  assert.equal(f.hasAnswer(`${head}data: {"jsonrpc":"2.0","id":2,"result":{}}\n\n`, 2), true);
  assert.equal(f.hasAnswer(`${head}data: {"jsonrpc":"2.0","id":2,"method":"sampling/createMessage"}\n\n`, 2), false, 'a server request with the same id is not the answer');
  assert.equal(f.hasAnswer('data: {"jsonrpc":"2.0","id":3,"result":{}}\r\r', 3), true, 'lines ending in a bare CR');
  assert.deepEqual(f.rpcResult('data: {"jsonrpc":"2.0","id":3,"result":{"ok":1}}\r\r', 'text/event-stream', 3), { ok: 1 });
  // A refresh without a new refresh token keeps the old one.
  assert.equal(f.tokensFrom({ access_token: 'A', expires_in: 3600 }, 0, 'Plaud', 'R-OLD').refreshToken, 'R-OLD');
  assert.throws(() => f.tokensFrom({ access_token: 'A' }, 0, 'Plaud'), /lasting access/, 'a first sign-in still needs one');
  // A malformed return is refused as a mismatch, not a crash.
  assert.throws(() => f.codeFromCallback('com.mattbrown.referralfit:/oauth/plaud?code=%E0%A4%A&state=%E0%A4%A', 'S', f.PLAUD), /did not match/);
}, 'recorder answers, errors and sign-in edges');
check(() => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  const noEnd = (start) => ({ id: start, title: '', summary: '', startTime: start, endTime: '' });
  const plan = f.reviewPlan([noEnd('2026-11-11T00:00:00Z'), noEnd('2026-11-10T00:00:00Z')], now);
  assert.deepEqual(plan.skipped, ['2026-11-10T00:00:00Z'], 'one with no end is given up two days after it started');
  assert.equal(plan.later, 1);
  assert.match(f.shortTime('2025-12-30T18:00:00Z', Date.parse('2026-01-02T12:00:00Z')), /2025/, 'another year is named');
  assert.doesNotMatch(f.shortTime('2026-11-09T18:00:00Z', now), /2026/);
  const blocks = f.reviewPlan([{ id: 'r', title: '', summary: 'Иван Петров звонил о сыне.', startTime: '2026-11-11T10:00:00Z', endTime: '2026-11-11T10:10:00Z' }], now).blocks;
  assert.equal(f.blocksFor('Иван Петров звонил', blocks).length, 1, 'a quote in any alphabet finds its recording');
}, 'recordings with no end, years, and any alphabet');

// ─── Wiring ────────────────────────────────────────────────────────────────
const api = read('src/lib/fieldy-api.ts');
const sheet = read('src/lib/DayReviewSheet.tsx');
const app = read('App.tsx');
const appJson = JSON.parse(read('app.json'));
check(() => {
  assert.match(api, /keychainAccessible: SecureStore\.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY/, 'the sign-in stays on this phone, never synced or backed up');
  assert.doesNotMatch(api, /from '\.\/supabase'/, 'the sign-in never goes to ReferralFit\'s server (only recording-marks-api sends marks)');
  assert.doesNotMatch(api, /console\.(log|error|warn)\([^)]*(token|refresh|summary|text)\b/i, 'no token or conversation is logged');
  assert.match(api, /function serial<T>\(key: string, work: \(\) => Promise<T>\)/, 'every change to the sign-in goes through one queue (refresh tokens rotate)');
  assert.match(api, /const slot = \(recorder: Recorder, userId: string\) => `\$\{recorder\.id\}:\$\{userId\}`/, 'tokens are kept per recorder and per account');
  assert.match(api, /return signInQueue\(recorder, userId, async \(\) => \{[^]*await writeToken\(recorder, userId, \{ \.\.\.token, refreshToken: tokens\.refreshToken \}\)/, 'the new refresh token is kept at once, inside the queue');
  assert.match(api, /here\.revokeUrl[^]*logoutPlan/, 'disconnecting revokes the access at the recorder (Fieldy: revocation; Plaud: logout)');
  assert.match(api, /const held = await signInQueue\(recorder, userId, async \(\) => \{\s*const token = await readToken\(recorder, userId\);\s*const cached = access\.get\(key\);\s*access\.delete\(key\);\s*await deleteToken\(recorder, userId\)/,
    'a disconnect reads and forgets the newest token in one step, before anything goes over the network');
  assert.doesNotMatch(api.slice(api.indexOf('async function revokeAndForget'), api.indexOf('export function disconnectRecorder')), /accessToken\(recorder, userId\)/,
    'Plaud too: nothing is fetched before the sign-in is forgotten');
  assert.match(api, /const FAILING_GIVE_UP_MS = 24 \* 60 \* 60 \* 1000;/, 'a recording whose text keeps failing is given up after a day of failures, not at once');
  assert.match(api, /if \(now\.getTime\(\) - Date\.parse\(since\) < FAILING_GIVE_UP_MS\) continue;/);
  assert.match(api, /if \(later && !count\) break;/, 'a page past the end, empty or in words, ends the list');
  assert.match(api, /if \(later && error instanceof FieldyError && error\.reason === 'tool'\) break;/, 'so does an error on a page past the end');
  assert.match(api, /fromNote\.length < SHORT_NOTE && transcript/, 'a note too short to be one is checked against the transcript');
  assert.match(api, /const shortNoteOk = fromNote\.length >= SHORT_NOTE \|\| !transcript;/, 'and used only when there is no transcript to read');
  assert.doesNotMatch(api, /FAILING_GIVE_UP_MS\) \{ read\.push/, 'a failing recording is always tried again before it is given up');
  assert.match(api, /if \(!ownFault && !anyDetailRead\) continue;/, 'on a weak connection (every read failing) no recording is held to the one-day clock');
  assert.match(api, /error instanceof FieldyError && error\.reason === 'tool'/, 'a failure the recorder reports about the recording itself counts');
  assert.match(api, /export async function rememberSaved[^]*export async function savedFrom/, 'items saved from a recording are remembered with it');
  assert.match(api, /delete state\.saved\[id\];/, 'and forgotten once it is reviewed');
  assert.match(api, /\.sort\(\(a, b\) => Date\.parse\(a\.startTime\) - Date\.parse\(b\.startTime\)/, 'detail reads go oldest first');
  assert.match(api, /\[\.\.\.untried\.slice\(0, DETAIL_READS - 2\), \.\.\.retry\.slice\(0, 2\)/, 'two reads are kept for recordings that failed before');
  assert.match(api, /if \(forgotten\.has\(slot\(recorder, userId\)\)\) return false;\s*const state = \(await readLocal/, 'a deleted account\'s read state is never written again');
  assert.match(api, /await Promise\.all\(RECORDERS\.map\(async \(recorder\) =>/, 'deleting the account forgets every recorder at once');
  assert.match(api, /return await Promise\.race\(\[work, deadline\]\)/, 'the deadline covers the whole answer, body included');
  assert.match(api, /if \(until!\(text\)\) \{ reader\.cancel\(\)/, 'an event stream is read only until the answer is in');
  assert.match(api, /if \(reads >= DETAIL_READS \|\| Date\.now\(\) - started > DETAIL_TIME_MS\) continue;/, 'the cap never holds back recordings after it');
  assert.match(api, /const started = Date\.now\(\);\s*let reads = 0;/, 'the time budget starts at the detail reads');
  assert.match(api, /error\.reason === 'disconnected' \? 0 : null/, 'a connection that ended counts nothing');
  assert.match(api, /const READ_PREFIX = [^\n]*\.read\.v1\./, 'what was reviewed is kept apart from the sign-in');
  assert.match(api, /export async function forgetRecorders[^]*deleteItemAsync\(readKey\(recorder, userId\)\)/, 'deleting the account forgets what was reviewed too');
  assert.match(api, /export async function forgetRecorders[^]*browserRemove\(readKey\(recorder, userId\)\)/, 'in a browser too');
  assert.match(api, /signal: controller\.signal/, 'every call gives up after a while');
  assert.match(api, /never taken for "no text" at once/, 'a failed read is never taken for "no text" at once');
  assert.match(api, /WebBrowser\.openAuthSessionAsync\(authorizeUrl\(challenge, state, here\), here\.redirectUri\)/);
}, 'the connection');
check(() => {
  assert.doesNotMatch(sheet, /commitRecorderRead/);
  assert.match(sheet, /if \(results\[row\.key\]\?\.saved === true\) return true;\s*if \(row\.include\) return false;\s*return switchedOffRef\.current\.has\(row\.key\) \|\| row\.found\.verified/,
    'an item is decided when saved, switched off by the practitioner, or off for a reason the app gave; one off only because it could not be checked is not');
  assert.match(sheet, /switchedOffRef\.current = new Set\(\);\s*setSaved\(\{\}\);/, 'what was switched off in an earlier review is not this one\'s');
  assert.match(sheet, /phase === 'done' \? \(\s*<>\s*\{nextButton\}\s*<TouchableOpacity accessibilityRole="button" onPress=\{close\}/, 'the Done button asks about undecided recordings too');
  assert.match(sheet, /\.\.\.\(phase === 'done' \? \[\] : \[\{ text: 'Keep reviewing'/, 'with everything saved there is no "Keep reviewing" to go back to');
  assert.match(sheet, /\{ text: 'Read again next time', onPress: \(\) => finish\(holdAll\) \}/, 'an undecided item from no one recording holds them all when read again');
  assert.match(sheet, /for \(const fingerprint of before\) savedSignaturesRef\.current\.add\(fingerprint\);/, 'a recording read again knows what was saved from it');
  assert.doesNotMatch(sheet, /onPress=\{finish\}/, 'finish is never handed a press event');
  assert.match(sheet, /if \(!unsaved && read && undecided > 0\)/, 'closing asks about recordings with items never decided on');
  assert.doesNotMatch(sheet, /settleRecordings\(\{\}, built\)/, 'nothing is settled just because its items start switched off');
  assert.match(sheet, /return read\.blocks\.map\(\(block\) => block\.id\)/, 'every recording is considered, those with no items too');
  assert.match(sheet, /function finish\(hold = false\) \{\s*if \(!hold && phase !== 'finding' && phase !== 'saving'\) settleRecordings\(saved, rows\);/, 'closing the review settles what was set aside');
  assert.match(sheet, /if \(phase === 'finding' && \(!notes\.trim\(\) \|\| recorderText\)\) \{ finish\(\); return; \}/, 'a slow read can be stopped; typed or pasted notes are not thrown away without asking');
  assert.match(sheet, /if \(unmatchedUndecided\(results, current\)\) return \[\];/, 'an undecided item from no one recording holds them all, on Approve as on close');
  assert.match(sheet, /const signatures = laterSignatures\(row\);/, 'what is kept, in this review or a later one, is never a quote or a phone alone');
  assert.doesNotMatch(read('src/lib/day-review.ts'), /new_lead\|caller\|/, 'a phone alone never makes an item "saved"');
  assert.match(sheet, /\/\/ Kept before the review runs, so a retry after a failed one is still these recordings\./);
  assert.match(sheet, /\.concat\(skipped\);/, 'one with nothing found, or skipped, is done on reading');
  assert.match(sheet, /function markAllReviewed\(\)/, 'the practitioner can be done with them');
  assert.match(sheet, /onPress=\{\(\) => readRecorderAsking\(recorder\)\}/, 'reading a recorder asks before replacing typed notes');
  assert.match(sheet, /if \(keyMissing && status\.state !== 'on' && status\.state !== 'leaving'\) return null;/, 'a connected recorder can be disconnected without a key');
  assert.match(sheet, /blocksFor\(found\.evidence, blocks\)/);
  assert.match(read('src/lib/WorkspaceScreen.tsx'), /forgetRecorders\(userId\)/, 'deleting the account disconnects every recorder');
  assert.ok(appJson.expo.scheme.includes('com.mattbrown.referralfit'), 'the app opens for Fieldy\'s return');
  assert.ok(appJson.expo.plugins.includes('expo-web-browser'));
  assert.match(app, /countNewRecordings\(recorder, userId\)/, 'the Today card counts, it does not review');
  assert.match(app, /const key = await getAnthropicKey\(userId\)/, 'without a key nothing is counted, so no card and no reminder');
  assert.match(app, /counts\[index\] \?\? previous\[recorder\.id\]/, 'a count that could not be read keeps the last one');
  assert.match(app, /generation !== fieldyCountGenerationRef\.current\) return;/, 'a stale count never replaces a newer one');
  assert.match(app, /if \(target === 'day_review'\)/, 'the day review reminder opens the review');
  // The reminder never outlives what it is about.
  assert.ok(app.indexOf('await loadDayReviewReminder(userId);') > 0 && app.indexOf('await loadDayReviewReminder(userId);') < app.indexOf('await activateReferralFitNotificationOwner(userId);'), 'the picked time (or "off") is loaded before the account can schedule');
  assert.match(app, /if \(reviewed\) lowerRecordingsWaiting\(reviewed\.recorder, reviewed\.count\);\s+void refreshFieldyWaiting\(true\);/, 'recordings marked reviewed lower the count at once; the recount only confirms');
  assert.match(app, /onAnthropicKeyChange\(\(userId\) => \{ if \(userId === activeUserIdRef\.current\) void refreshFieldyWaiting\(true\); \}\)/, 'the key removed or added: counted again at once');
  assert.match(sheet, /\.then\(\(count\) => onRecordersChanged\?\.\(\{ recorder: recorder\.id, count \}\)\)/, 'the review says how many it marked');
  assert.equal((sheet.match(/markRecordingsReviewed\(/g) || []).length, 1, 'every mark goes through markReviewed');
  const api = read('src/lib/fieldy-api.ts');
  assert.match(api, /if \(!state\.reviewed\[id\]\) marked \+= 1;/, 'only recordings not marked before are counted');
  const keys = read('src/lib/outreach-api.ts');
  assert.equal((keys.match(/keyChanged\(userId\);/g) || []).length, 2, 'saving and removing the key both tell listeners');
}, 'the review and the app');

// ─── Fieldy on the web (2026-11-21) ────────────────────────────────────────
check(() => {
  assert.equal(f.FIELDY_WEB_CLIENT_ID, '', 'no web client until Matt approves the registration');
  assert.equal(f.webRecorder(f.FIELDY, 'https://app.referralfit.com'), null, 'so the web app cannot connect yet');
  const web = f.webRecorder(f.FIELDY, 'https://app.referralfit.com', 'WEBCLIENT');
  assert.equal(web.clientId, 'WEBCLIENT');
  assert.equal(web.redirectUri, 'https://app.referralfit.com/oauth/fieldy');
  assert.equal(web.id, 'fieldy', 'the same recorder: its marks are shared with the phone');
  assert.equal(f.webRecorder(f.FIELDY, 'http://localhost:8081', 'WEBCLIENT').redirectUri, 'http://localhost:8081/oauth/fieldy');
  assert.equal(f.webRecorder(f.FIELDY, 'https://evil.example', 'WEBCLIENT'), null, 'only registered origins');
  assert.equal(f.webRecorder(f.PLAUD, 'https://app.referralfit.com', 'WEBCLIENT'), null, 'Plaud stays phone-only');
  const url = f.authorizeUrl('C', 'S', web);
  assert.ok(url.includes(`redirect_uri=${encodeURIComponent('https://app.referralfit.com/oauth/fieldy')}`) && url.includes('client_id=WEBCLIENT'));
  const back = 'https://app.referralfit.com/oauth/fieldy?code=abc&state=S&iss=https%3A%2F%2Fapi.fieldy.ai%2Fapi%2Fauth';
  assert.equal(f.codeFromCallback(back, 'S', web), 'abc');
  assert.throws(() => f.codeFromCallback(back, 'OTHER', web), /did not match/);
  assert.throws(() => f.codeFromCallback('https://app.referralfit.com/oauth/fieldyx?code=abc&state=S', 'S', web), /wrong place/, 'never a longer path on the same start');
  assert.throws(() => f.codeFromCallback('https://app.referralfit.com/oauth/fieldy?code=abc&state=S&iss=https%3A%2F%2Fevil.example', 'S', web), /did not come from Fieldy/);
  assert.equal(f.codeFromCallback('com.mattbrown.referralfit:/oauth/fieldy?code=p&state=S', 'S'), 'p', 'the phone\'s return still reads');
}, 'the web client: empty until registered, its own return, state and issuer checked');

const m = load('src/lib/recording-marks.ts', 'recording-marks.js');
check(() => {
  const state = {
    floor: '2026-11-21T08:00:00.000Z', synced: false,
    reviewed: { done: '2026-11-21T10:00:00.000Z' },
    failing: { slow: '2026-11-21T09:00:00.000Z' },
    saved: { half: '2026-11-21T11:00:00.000Z h:aa h:bb not-a-fingerprint', done: '2026-11-21T09:00:00.000Z h:zz' },
    unreviewable: { bad: '2026-11-20T09:00:00.000Z 2026-11-21T09:30:00.000Z' },
    unsent: {},
  };
  const rows = m.rowsFor(state, m.idsIn(state));
  assert.deepEqual(rows.find((row) => row.id === 'done'), { id: 'done', reviewed_at: '2026-11-21T10:00:00.000Z' }, 'reviewed: only the time');
  assert.deepEqual(rows.find((row) => row.id === 'half').fingerprints, ['h:aa', 'h:bb'], 'only fingerprints ever leave: anything else is dropped');
  assert.deepEqual(rows.find((row) => row.id === 'bad'), { id: 'bad', unreviewable_since: '2026-11-20T09:00:00.000Z', unreviewable_tried_at: '2026-11-21T09:30:00.000Z' });
  assert.equal(m.rowsFor(state, ['slow'])[0].failing_since, '2026-11-21T09:00:00.000Z');
  assert.deepEqual(m.rowsFor(state, ['gone']), [], 'nothing kept, nothing cleared: nothing sent');
  // A clear travels as a time (a tombstone), from the unsent list.
  const cleared = { ...state, failing: {}, unreviewable: {}, unsent: { slow: { at: '2026-11-21T12:00:00.000Z', n: 'a', failingCleared: '2026-11-21T12:00:00.000Z' }, bad: { at: '2026-11-21T12:00:00.000Z', n: 'b', unreviewableCleared: '2026-11-21T12:00:00.000Z' } } };
  assert.deepEqual(m.rowsFor(cleared, ['slow', 'bad']), [{ id: 'slow', failing_cleared_at: '2026-11-21T12:00:00.000Z' }, { id: 'bad', unreviewable_cleared_at: '2026-11-21T12:00:00.000Z' }]);
  for (const row of [...rows, ...m.rowsFor(cleared, ['slow', 'bad'])]) {
    const keys = Object.keys(row);
    assert.ok(keys.every((key) => ['id', 'reviewed_at', 'failing_since', 'failing_cleared_at', 'unreviewable_since', 'unreviewable_tried_at', 'unreviewable_cleared_at', 'saved_at', 'fingerprints'].includes(key)), 'ids, times and fingerprints only');
  }
  // Joined with the server: nothing lost on either side.
  const joined = m.withServerMarks(state, [
    { recording_id: 'half', reviewed_at: '2026-11-21T12:00:00.000Z', failing_since: null, unreviewable_since: null, unreviewable_tried_at: null, saved_at: null, fingerprints: [] },
    { recording_id: 'phoneOnly', reviewed_at: '2026-11-21T07:00:00.000Z', failing_since: null, unreviewable_since: null, unreviewable_tried_at: null, saved_at: null, fingerprints: [] },
    { recording_id: 'done', reviewed_at: null, failing_since: null, unreviewable_since: null, unreviewable_tried_at: null, saved_at: '2026-11-21T08:00:00Z', fingerprints: ['h:x'], failing_cleared_at: '2026-11-21T23:00:00.000Z', unreviewable_cleared_at: '2026-11-21T23:00:00.000Z' },
    { recording_id: 'shared', reviewed_at: null, failing_since: null, unreviewable_since: null, unreviewable_tried_at: null, saved_at: '2026-11-21T12:00:00.000Z', fingerprints: ['h:web', 'Words never'] },
    { recording_id: 'bad', reviewed_at: null, failing_since: null, unreviewable_since: '2026-11-19T09:00:00.000Z', unreviewable_tried_at: '2026-11-21T08:00:00.000Z', saved_at: null, fingerprints: [] },
  ]);
  assert.equal(joined.reviewed.half, '2026-11-21T12:00:00.000Z', 'reviewed on another device: reviewed here');
  assert.equal(joined.saved.half, undefined, 'and its fingerprints are no longer needed');
  assert.equal(joined.reviewed.phoneOnly, '2026-11-21T07:00:00.000Z');
  assert.equal(joined.reviewed.done, '2026-11-21T10:00:00.000Z', 'a mark here is never lost to the server not having it, nor cleared');
  assert.deepEqual(joined.saved.shared.split(' ').slice(1), ['h:web'], 'words from the server are never taken as fingerprints');
  assert.equal(joined.unreviewable.bad, '2026-11-19T09:00:00.000Z 2026-11-21T09:30:00.000Z', 'the first failure, the latest try');
  assert.equal(state.reviewed.half, undefined, 'the state passed in is not changed');
  const both = m.withServerMarks({ ...state, saved: { r: '2026-11-21T10:00:00.000Z h:a h:b' } },
    [{ recording_id: 'r', reviewed_at: null, failing_since: null, unreviewable_since: null, unreviewable_tried_at: null, saved_at: '2026-11-21T11:00:00.000Z', fingerprints: ['h:b', 'h:c'] }]);
  assert.equal(both.saved.r, '2026-11-21T11:00:00.000Z h:a h:b h:c', 'fingerprints joined, each once, newest last');
}, 'what goes to the server, and how it is joined with what a device keeps');

check(() => {
  // Round 5, 2: a clear wins over any mark whose last time is not after it.
  const mark = (id, extra) => ({ recording_id: id, reviewed_at: null, failing_since: null, unreviewable_since: null, unreviewable_tried_at: null, saved_at: null, fingerprints: [], ...extra });
  const base = { floor: '2026-11-21T08:00:00.000Z', synced: true, reviewed: {}, failing: {}, saved: {}, unreviewable: {}, unsent: {} };
  // The single clear send failed: the clear is still unsent here; the server sends its stale mark back.
  const waiting = { ...base, unsent: { slow: { at: '2026-11-21T12:00:00.000Z', n: 'x', failingCleared: '2026-11-21T12:00:00.000Z' }, bad: { at: '2026-11-21T12:00:00.000Z', n: 'y', unreviewableCleared: '2026-11-21T12:00:00.000Z' } } };
  const back = m.withServerMarks(waiting, [mark('slow', { failing_since: '2026-11-21T09:00:00.000Z' }), mark('bad', { unreviewable_since: '2026-11-20T09:00:00.000Z', unreviewable_tried_at: '2026-11-21T11:00:00.000Z' })]);
  assert.equal(back.failing.slow, undefined, 'a failure cleared here does not come back from the server');
  assert.equal(back.unreviewable.bad, undefined, 'nor a "review failed" mark whose review came back');
  // The server's own clear ends a stale mark kept on this device (another device cleared it).
  const stale = { ...base, failing: { slow: '2026-11-21T09:00:00.000Z' }, unreviewable: { bad: '2026-11-20T09:00:00.000Z 2026-11-21T11:00:00.000Z' } };
  const ended = m.withServerMarks(stale, [mark('slow', { failing_cleared_at: '2026-11-21T12:00:00.000Z' }), mark('bad', { unreviewable_cleared_at: '2026-11-21T12:00:00.000Z' })]);
  assert.equal(ended.failing.slow, undefined);
  assert.equal(ended.unreviewable.bad, undefined);
  // A failure newer than the clear is a new one: it stays.
  const fresh = { ...base, failing: { slow: '2026-11-21T13:00:00.000Z' }, unreviewable: { bad: '2026-11-20T09:00:00.000Z 2026-11-21T13:00:00.000Z' } };
  const kept = m.withServerMarks(fresh, [mark('slow', { failing_since: '2026-11-21T09:00:00.000Z', failing_cleared_at: '2026-11-21T12:00:00.000Z' }), mark('bad', { unreviewable_cleared_at: '2026-11-21T12:00:00.000Z' })]);
  assert.equal(kept.failing.slow, '2026-11-21T13:00:00.000Z', 'the stale server time does not replace the new failure');
  assert.equal(kept.unreviewable.bad, '2026-11-20T09:00:00.000Z 2026-11-21T13:00:00.000Z');
  // A reviewed mark is never cleared.
  const reviewed = m.withServerMarks({ ...base, reviewed: { r: '2026-11-21T10:00:00.000Z' } }, [mark('r', { failing_cleared_at: '2026-11-21T12:00:00.000Z', unreviewable_cleared_at: '2026-11-21T12:00:00.000Z' })]);
  assert.equal(reviewed.reviewed.r, '2026-11-21T10:00:00.000Z');
}, 'round 5: a clear (here or on the server) outlives a stale copy of the mark it cleared');

check(() => {
  // Round 5, 1: what still needs sending is written with the change, and taken off only when the server confirms it.
  const s0 = { floor: '2026-11-21T08:00:00.000Z', synced: true, reviewed: { a: '2026-11-21T10:00:00.000Z' }, failing: {}, saved: {}, unreviewable: {}, unsent: {} };
  m.noteUnsent(s0, 'a', '2026-11-21T10:00:00.000Z');
  m.noteUnsent(s0, 'b', '2026-11-21T10:01:00.000Z', { failing: true });
  const first = m.pendingRows(s0);
  assert.deepEqual(first.rows, [{ id: 'a', reviewed_at: '2026-11-21T10:00:00.000Z' }, { id: 'b', failing_cleared_at: '2026-11-21T10:01:00.000Z' }]);
  assert.equal(first.full, false, 'synced: only the changes go');
  // Before the server answers, 'a' changes again (another save): it must not be taken off with the first answer.
  m.noteUnsent(s0, 'a', '2026-11-21T10:00:00.000Z');
  assert.ok(m.confirmSent(s0, first.sent, first.full));
  assert.deepEqual(Object.keys(s0.unsent), ['a'], 'b confirmed; a changed since, so sent again');
  const second = m.pendingRows(s0);
  m.confirmSent(s0, second.sent, second.full);
  assert.deepEqual(s0.unsent, {}, 'all confirmed');
  assert.equal(m.confirmSent(s0, second.sent, second.full), false, 'nothing left to confirm');
  // Two clears of one recording keep the later; a clear stays on the entry when marks change after it.
  m.noteUnsent(s0, 'c', '2026-11-21T11:00:00.000Z', { unreviewable: true });
  m.noteUnsent(s0, 'c', '2026-11-21T12:00:00.000Z');
  assert.equal(s0.unsent.c.unreviewableCleared, '2026-11-21T11:00:00.000Z');
  // Kept before the server knew of it: everything, with the unsent changes.
  const old = { ...s0, synced: false, failing: { f: '2026-11-21T09:00:00.000Z' } };
  const full = m.pendingRows(old);
  assert.equal(full.full, true);
  assert.deepEqual(full.rows.map((row) => row.id).sort(), ['a', 'c', 'f']);
  m.confirmSent(old, full.sent, full.full);
  assert.equal(old.synced, true);
  // Bounded: past MAX_UNSENT the oldest go, and everything is copied up once instead.
  const big = { ...s0, unsent: {}, synced: true };
  for (let i = 0; i < m.MAX_UNSENT + 5; i += 1) m.noteUnsent(big, `r${i}`, new Date(Date.parse('2026-11-21T00:00:00.000Z') + i * 1000).toISOString());
  assert.equal(Object.keys(big.unsent).length, m.MAX_UNSENT);
  assert.ok(!big.unsent.r0 && big.unsent[`r${m.MAX_UNSENT + 4}`], 'the oldest go');
  assert.equal(big.synced, false, 'and the full copy covers them');
  const bigFull = m.pendingRows(big);
  m.confirmSent(big, bigFull.sent, bigFull.full);
  assert.equal(big.synced, false, 'a full list may have dropped a change meanwhile: copied up again');
  assert.equal(Object.keys(big.unsent).length, 0);
  const again = m.pendingRows(big);
  m.confirmSent(big, again.sent, again.full);
  assert.equal(big.synced, true, 'then synced');
  // Older than KEEP_MS: dropped (the server would not keep it either).
  const aged = { ...s0, unsent: { gone: { at: '2026-10-01T00:00:00.000Z', n: 'z' } } };
  m.noteUnsent(aged, 'new', '2026-11-21T12:00:00.000Z');
  assert.deepEqual(Object.keys(aged.unsent), ['new']);
  // Read back from a device: anything unreadable dropped.
  assert.deepEqual(m.readUnsent({ ok: { at: '2026-11-21T12:00:00.000Z', n: 'q', failingCleared: 'nope' }, bad: { at: 'x', n: 'q' }, '': { at: '2026-11-21T12:00:00.000Z', n: 'q' } }), { ok: { at: '2026-11-21T12:00:00.000Z', n: 'q' } });
  assert.deepEqual(m.readUnsent(null), {});
}, 'round 5: unsent changes, written with the change, confirmed by the server, bounded');

check(() => {
  assert.equal(m.unionNewest(Array.from({ length: 200 }, (_, i) => `h:${i}`), ['h:n']).length, 200);
  assert.ok(m.FINGERPRINT.test('h:2gosa7pa2gv') && !m.FINGERPRINT.test('h:Sarah') && !m.FINGERPRINT.test('call Sarah'));
  assert.deepEqual(m.idGroups(['a', 'b', 'c'], 8).map((group) => group.length), [2, 1]);
  assert.deepEqual(m.inGroups([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  for (const code of ['PGRST202', 'PGRST205', '42P01', '42883', '42703']) assert.ok(m.notOnServerYet(code), code);
  assert.ok(!m.notOnServerYet('42501') && !m.notOnServerYet(undefined), 'a refusal is not "no table yet"');
  // The fingerprints the phone keeps are exactly the server's format.
  const dayRules = require(path.join(repoRoot, 'node_modules', '.cache', 'fieldy-test', 'recording-marks.js'));
  assert.ok(dayRules.FINGERPRINT.test('h:abc123'));
}, 'the marks\' formats and groups');

check(() => {
  const web = read('src/lib/fieldy-web.ts');
  const marksApi = read('src/lib/recording-marks-api.ts');
  const index = read('index.ts');
  // The trip to Fieldy and back.
  assert.match(web, /Cross-Origin-Opener-Policy: same-origin/, 'why the sign-in is a full-page trip, not a popup');
  assert.match(web, /browserStore\('session'\)\?\.setItem\(RETURN_KEY, window\.location\.href\);\s*window\.history\.replaceState\(null, '', '\/'\);/, 'the code leaves the address bar at once');
  assert.ok(index.indexOf('captureFieldyReturn();') > 0 && index.indexOf('captureFieldyReturn();') < index.indexOf('registerRootComponent('), 'before the app draws');
  assert.match(web, /store\?\.removeItem\(PENDING_KEY\);/, 'a started sign-in is used once');
  assert.match(api, /if \(pending\.userId !== userId\) \{\s*throw new FieldyError\('That Fieldy sign-in was started for another ReferralFit account/, 'never connected to another account');
  assert.match(api, /Date\.now\(\) - pending\.at > CONNECT_WINDOW_MS/, 'nor late');
  assert.match(api, /const code = codeFromCallback\(back, pending\.state, here\);/, 'state and issuer checked as on the phone');
  assert.match(api, /savePendingConnect\(\{ state, verifier, userId, redirectUri: here\.redirectUri, scope: options\.tabOnly \? 'tab' : 'browser', at: Date\.now\(\) \}\);/, 'the verifier waits in this tab only');
  // One change at a time across tabs.
  assert.match(web, /locks\.request\(`referralfit-\$\{name\}`, work\)/);
  assert.match(api, /function signInQueue<T>[^]*serial\(key, \(\) => acrossTabs\(`\$\{key\}:sign-in`, work\)\)/, 'the sign-in\'s queue holds across tabs');
  assert.match(api, /\/\/ Read inside the lock: another tab may have rotated it a moment ago\.\s*const token = await readToken\(recorder, userId\);/);
  assert.match(api, /if \(now && now\.refreshToken === token\.refreshToken\) await deleteToken\(recorder, userId\);/, 'a refused token never removes one another tab kept since');
  assert.match(api, /return serial\(key, \(\) => acrossTabs\(key, async \(\) => \{\s*if \(forgotten/, 'what was reviewed, too');
  // Leaving the browser.
  assert.match(api, /export function removeBrowserRecorderSignIns\(keepUserId\?: string\): void/);
  assert.match(app, /removeBrowserAnthropicKeys\(userId\);\s*\/\/[^\n]*\n\s*removeBrowserRecorderSignIns\(userId\);/, 'only the account signed in here keeps a Fieldy sign-in');
  assert.match(app, /removeBrowserAnthropicKeys\(\);\s*removeBrowserRecorderSignIns\(\);/, 'Sign out removes every one');
  assert.match(app, /void finishWebConnect\(userId\)\.then/, 'the return is finished once the account is known');
  // The server's copy of what was reviewed.
  assert.match(marksApi, /data\.session\?\.user\?\.id === userId/, 'marks go only to the account signed in now');
  assert.match(marksApi, /\.eq\('user_id', userId\)/);
  assert.match(marksApi, /supabase\.rpc\('day_review_mark_recordings', \{ p_user: userId, p_recorder: recorder, p_marks: group \}\)/, 'every write names the account it was started for');
  assert.doesNotMatch(marksApi, /refreshToken|accessToken|from '\.\/fieldy/, 'never a sign-in, nor anything read from a recorder');
  assert.match(marksApi, /import \{ inGroups, idGroups, notOnServerYet, type MarkRow, type ServerMark \} from '\.\/recording-marks';/, 'only the rows rowsFor makes');
  assert.match(api, /const emptyState = [^\n]*unsent: \{\}, synced: true \}\);/, 'a new state has nothing to copy up');
  assert.match(api, /synced: data\.synced === true,/, 'a state kept before the server knew of it is copied up once');
  assert.match(api, /return state && \(Object\.keys\(state\.unsent\)\.length \|\| !state\.synced\) \? pendingRows\(state\) : null;/, 'what the server lacks, read in the read queue');
  assert.match(api, /if \(!\(await sendServerMarks\(recorder\.id, userId, pending\.rows\)\.catch\(\(\) => false\)\)\) return;\s*await serial\(key, \(\) => acrossTabs\(key, async \(\) => \{[^]*confirmSent\(state, pending\.sent, pending\.full\)/, 'sent outside it, then confirmed in it (only what the server took)');
  assert.match(api, /if \(Object\.keys\(local\.unsent\)\.length \|\| !local\.synced\) await sendUnsent\(recorder, userId\)/, 'every read (and count) sends what is still unsent first');
  assert.match(api, /unsent: readUnsent\(data\.unsent\),/, 'the unsent list is kept with the marks');
  assert.match(api, /unreviewable: recent\(value\.unreviewable, 200\), unsent: value\.unsent, synced: value\.synced,/, 'in the same write as the change');
  assert.doesNotMatch(api, /toServer|sendInOrder/, 'no send that only lives in memory');
  for (const fn of ['markRecordingsReviewed', 'rememberReviewFailed', 'rememberSaved']) {
    assert.match(api, new RegExp(`export async function ${fn}[^]*?noteUnsent\\(state, id, at\\);[^]*?\\n\\}`), `${fn} notes what to send in the same write`);
  }
  assert.match(api, /noteUnsent\(current, id, at, \{ failing: true \}\);/, 'a failing recording read again: a clear, until the server has it');
  // Round 5, 3 and 4: the account named in every call; a refusal stops the send and waits.
  assert.match(marksApi, /if \(refused !== undefined && Date\.now\(\) - refused < REFUSED_WAIT_MS\) return false;/, 'a refused send is not tried again for a while');
  assert.match(marksApi, /if \(refusal\(error\)\) refusedAt\.set\(key, Date\.now\(\)\);\s*return false;/, 'it stops at the refusal');
  assert.match(marksApi, /export const REFUSED_WAIT_MS = 10 \* 60_000;/);
  assert.match(marksApi, /failing_cleared_at, unreviewable_since, unreviewable_tried_at, unreviewable_cleared_at/, 'the clears are read back too');
  const migration = read('supabase/migrations/20261122130000_day_review_recordings.sql');
  assert.match(migration, /IF p_user IS DISTINCT FROM v_user THEN\s*RAISE EXCEPTION '[^']+' USING ERRCODE = '42501';/, 'the server refuses marks for another account');
  assert.match(migration, /DROP FUNCTION IF EXISTS public\.day_review_mark_recordings\(text, jsonb\);/);
  assert.match(migration, /cron\.schedule\('referralfit-day-review-recordings-prune-daily', '50 3 \* \* \*', 'SELECT public\.day_review_recordings_prune\(\)'\)/, 'kept 14 days whether or not the account writes again');
  assert.match(migration, /r\.first_seen_at := least\(r\.first_seen_at, now\(\), v_rev/, 'a re-send never makes a row younger');
  assert.ok(/^[\x00-\x7f]*$/.test(migration), 'the migration is ASCII');
  assert.equal((migration.match(/^BEGIN;$/gm) || []).length, 1);
  assert.equal((migration.match(/^COMMIT;$/gm) || []).length, 1);
  assert.match(api, /const state = await reviewedState\(recorder, userId, listed\.map\(\(item\) => item\.id\), now\);/, 'reviewed on the other device: not offered here');
  assert.match(api, /const state = await reviewedState\(recorder, userId, ids\);\s*return ids\.flatMap/, 'items saved on the other device are known here');
  // The sheet in a browser.
  assert.match(sheet, /\$\{recorder\.name\} connects in the iPhone app\./, 'Plaud: a plain line');
  assert.match(sheet, /connects in the browser soon/, 'Fieldy before the web client is registered: no Connect button');
  assert.match(sheet, /Only this tab/, 'the sign-in kept in this tab only, if chosen');
  assert.match(app, /if \(!userId \|\| !recordersHere \|\| !aiKeysSupported\) return;/, 'the Today card counts Fieldy in a browser once connected');
}, 'Fieldy on the web: the trip, the tabs, sign-out, and the server\'s marks');

check(() => {
  // Round 5, B: a duplicated tab's copy of an "Only this tab" sign-in is never sent once another tab rotated it.
  writeFileSync(path.join(tmpDir, 'web-layout.js'), 'exports.IS_WEB = true;\n');
  const fake = () => {
    const items = new Map();
    return { getItem: (k) => (items.has(k) ? items.get(k) : null), setItem: (k, v) => items.set(k, String(v)), removeItem: (k) => items.delete(k), key: (i) => [...items.keys()][i] ?? null, get length() { return items.size; } };
  };
  globalThis.localStorage = fake();
  globalThis.sessionStorage = fake();
  try {
    const w = load('src/lib/fieldy-web.ts', 'fieldy-web.js');
    const line = w.rotationId();
    assert.ok(line && line !== w.rotationId(), 'ids differ');
    assert.equal(w.tabCopyStale(line, 'g1'), false, 'nothing noted yet: the copy is fine');
    w.noteTabRotation(line, 'g1');
    assert.equal(w.tabCopyStale(line, 'g1'), false, 'the latest generation');
    w.noteTabRotation(line, 'g2');
    assert.equal(w.tabCopyStale(line, 'g1'), true, 'a copy from before another tab rotated it: stale');
    assert.equal(w.tabCopyStale(w.rotationId(), 'g1'), false, 'another line (a separate connect) is not affected');
    assert.equal(w.tabCopyStale(undefined, undefined), false, 'an older record without a line is read as before');
    assert.ok(![...Array(localStorage.length).keys()].some((i) => /refresh|token/i.test(localStorage.getItem(localStorage.key(i)))), 'the note holds ids and a time, never a token');
    localStorage.setItem('referralfit.tabRotation.v1.old', JSON.stringify({ gen: 'x', at: Date.now() - 15 * 24 * 60 * 60 * 1000 }));
    w.noteTabRotation(line, 'g3');
    assert.equal(localStorage.getItem('referralfit.tabRotation.v1.old'), null, 'old notes go');
    sessionStorage.setItem('k', 'v');
    localStorage.setItem('k', 'v');
    w.tabRemove('k');
    assert.equal(sessionStorage.getItem('k'), null);
    assert.equal(localStorage.getItem('k'), 'v', 'only this tab\'s copy');
  } finally {
    delete globalThis.localStorage;
    delete globalThis.sessionStorage;
  }
  assert.match(api, /if \(token\?\.scope === 'tab' && tabCopyStale\(token\.line, token\.gen\)\) \{\s*tabRemove\(tokenKey\(recorder, userId\)\);\s*return null;/, 'a stale copy is dropped (connect again), never sent');
  assert.match(api, /const gen = rotationId\(\);\s*return noteTabRotation\(line, gen\) \? \{ line, gen \} : \{ line, gen: kept\.gen \|\| gen \};/, 'a new generation at every write, noted before the token is kept; a note that fails keeps the noted generation');
  assert.doesNotMatch(api, /if \(tab\) noteTabRotation\(tab\.line, tab\.gen\);/, 'never noted after the token (a failed note would make the fresh token look stale)');
  // Round 5, A: a refresh on its way at sign-out never writes its rotated token back.
  assert.match(api, /if \(signedOut\.has\(name\)\) \{\s*revokeInBackground\(recorder, value\.refreshToken\);\s*throw new FieldyError/, 'refused, and the rotated token revoked');
  assert.match(api, /\/\/ A refresh on its way in this tab never writes its rotated token back\.\s*signedOut\.add\(item\.name\);/);
  assert.match(api, /void signInQueue\(recorder, userId, async \(\) => \{\s*if \(!signedOut\.has\(item\.name\)\) return;\s*const left = browserRead\(item\.name\);/, 'and one in another tab is removed once it lets go of the lock');
  assert.match(api, /signedOut\.delete\(tokenKey\(here, userId\)\);\s*await writeToken\(here, userId, \{ refreshToken: tokens\.refreshToken/, 'cleared when the account connects again');
}, 'round 5: the web sign-in: a sign-out mid-refresh, and a duplicated tab');

console.log(`fieldy-test: ${checks} checks passed`);
