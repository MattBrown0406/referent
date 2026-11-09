// Fieldy, connected (docs/DAY_REVIEW.md, Phase 2): the sign-in checks, the
// MCP answers, turning conversations into the day review's text, and the
// wiring that keeps tokens on the phone. Run with: node scripts/fieldy-test.mjs

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
  assert.deepEqual(plan, { name: 'list_conversations', start: 'startTime', end: 'endTime', size: 'pageSize', cursor: 'cursor', page: null });
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
  assert.deepEqual(plan, { name: 'list_files', start: 'date_from', end: 'date_to', size: 'page_size', cursor: null, page: 'page' });
  assert.deepEqual(f.listArguments(plan, '2026-11-09T07:00:00.000Z', '2026-11-09T23:00:00.000Z', null),
    { date_from: '2026-11-08', date_to: '2026-11-10', page_size: 50, page: 1 }, 'a date-only window is widened a day each way');
  assert.equal(f.listArguments(plan, '2026-11-09T07:00:00.000Z', '2026-11-09T23:00:00.000Z', null, 3).page, 3, 'pages by number');
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
  assert.doesNotMatch(api, /supabase/, 'nothing about Fieldy goes to ReferralFit\'s server');
  assert.doesNotMatch(api, /console\.(log|error|warn)\([^)]*(token|refresh|summary|text)\b/i, 'no token or conversation is logged');
  assert.match(api, /function serial<T>\(key: string, work: \(\) => Promise<T>\)/, 'every change to the sign-in goes through one queue (refresh tokens rotate)');
  assert.match(api, /const slot = \(recorder: Recorder, userId: string\) => `\$\{recorder\.id\}:\$\{userId\}`/, 'tokens are kept per recorder and per account');
  assert.match(api, /return serial\(key, async \(\) => \{[^]*await writeToken\(recorder, userId, \{ \.\.\.token, refreshToken: tokens\.refreshToken \}\)/, 'the new refresh token is kept at once, inside the queue');
  assert.match(api, /recorder\.revokeUrl[^]*logoutPlan/, 'disconnecting revokes the access at the recorder (Fieldy: revocation; Plaud: logout)');
  assert.match(api, /const token = await serial\(key, async \(\) => \{\s*const current = await readToken\(recorder, userId\);\s*access\.delete\(key\);\s*await SecureStore\.deleteItemAsync\(tokenKey\(recorder, userId\)\)/,
    'a disconnect reads and forgets the newest token in one step, before revoking it');
  assert.match(api, /await Promise\.all\(RECORDERS\.map\(async \(recorder\) =>/, 'deleting the account forgets every recorder at once');
  assert.match(api, /return await Promise\.race\(\[work, deadline\]\)/, 'the deadline covers the whole answer, body included');
  assert.match(api, /if \(until!\(text\)\) \{ reader\.cancel\(\)/, 'an event stream is read only until the answer is in');
  assert.match(api, /if \(reads >= DETAIL_READS \|\| Date\.now\(\) - started > DETAIL_TIME_MS\) continue;/, 'the cap never holds back recordings after it');
  assert.match(api, /error instanceof FieldyError && error\.reason === 'tool'\) return ''/, 'a recording the recorder has no note for is "no text"');
  assert.match(api, /error\.reason === 'disconnected' \? 0 : null/, 'a connection that ended counts nothing');
  assert.match(api, /const readKey = [^\n]*\.read\.v1\./, 'what was reviewed is kept apart from the sign-in');
  assert.match(api, /export async function forgetRecorders[^]*deleteItemAsync\(readKey\(recorder, userId\)\)/, 'deleting the account forgets what was reviewed too');
  assert.match(api, /signal: controller\.signal/, 'every call gives up after a while');
  assert.match(api, /Could not be reached this time[^]*continue;/, 'a failed read is never taken for "no text"');
  assert.match(api, /WebBrowser\.openAuthSessionAsync\(authorizeUrl\(challenge, state, recorder\), recorder\.redirectUri\)/);
}, 'the connection');
check(() => {
  assert.doesNotMatch(sheet, /commitRecorderRead/);
  assert.match(sheet, /results\[row\.key\]\?\.saved === true \|\| !row\.include/, 'a recording is done once every item from it is saved or set aside');
  assert.match(sheet, /function finish\(\) \{\s*if \(phase !== 'finding' && phase !== 'saving'\) settleRecordings\(saved, rows\);/, 'closing the review settles what was set aside');
  assert.match(sheet, /if \(phase === 'finding'\) \{ finish\(\); return; \}/, 'a slow read can be stopped');
  assert.match(sheet, /if \(current\.some\(\(row\) => !\(read\.rowIds\.get\(row\.key\)\?\.length\) && !settled\(row\)\)\) return;/, 'an item from no one recording holds them all');
  assert.match(sheet, /\/\/ Kept before the review runs, so a retry after a failed one is still these recordings\./);
  assert.match(sheet, /\.concat\(skipped\);/, 'one with nothing found, or skipped, is done on reading');
  assert.match(sheet, /function markAllReviewed\(\)/, 'the practitioner can be done with them');
  assert.match(sheet, /if \(keyMissing && status\.state !== 'on' && status\.state !== 'leaving'\) return null;/, 'a connected recorder can be disconnected without a key');
  assert.match(sheet, /blocksFor\(found\.evidence, blocks\)/);
  assert.match(read('src/lib/WorkspaceScreen.tsx'), /forgetRecorders\(userId\)/, 'deleting the account disconnects every recorder');
  assert.ok(appJson.expo.scheme.includes('com.mattbrown.referralfit'), 'the app opens for Fieldy\'s return');
  assert.ok(appJson.expo.plugins.includes('expo-web-browser'));
  assert.match(app, /countNewRecordings\(recorder, userId\)/, 'the Today card counts, it does not review');
  assert.match(app, /const key = await getAnthropicKey\(userId\)/, 'without a key nothing is counted, so no card and no reminder');
  assert.match(app, /counts\[index\] \?\? previous\[recorder\.id\]/, 'a count that could not be read keeps the last one');
  assert.match(app, /generation !== fieldyCountGenerationRef\.current\) return;/, 'a stale count never replaces a newer one');
  assert.match(app, /if \(target === 'day_review'\)/, 'the 6 PM reminder opens the review');
}, 'the review and the app');

console.log(`fieldy-test: ${checks} checks passed`);
