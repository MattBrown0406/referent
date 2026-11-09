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
  assert.deepEqual(plan, { name: 'list_conversations', start: 'startTime', end: 'endTime', size: 'pageSize', cursor: 'cursor' });
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
    conv('old', '2026-11-09T08:00:00Z', 'Before the last read.'),
    conv('a', '2026-11-09T17:00:00Z', 'Sarah Miller called about her son Jake.'),
  ], '2026-11-09T09:00:00Z', now);
  assert.deepEqual(plan.blocks.map((block) => block.id), ['a', 'b'], 'oldest first, each once, only after the last read');
  assert.match(plan.text, /^\[From Fieldy, Nov 9, \d+:00 (AM|PM) · Talk a\]\nSarah Miller called/);
  assert.equal(plan.through, '2026-11-09T18:00:00Z');
  assert.equal(plan.later, 0);
  assert.equal(f.sourceFor('promised to call  Ana back', plan.blocks), plan.blocks[1].label, 'an item says which conversation it came from');
  assert.equal(f.sourceFor('not there at all', plan.blocks), '');
}, 'conversations become review text, labeled');
check(() => {
  const now = Date.parse('2026-11-09T18:30:00Z');
  const plan = f.reviewPlan([
    conv('a', '2026-11-09T17:00:00Z', 'Summary of a.'),
    conv('b', '2026-11-09T18:00:00Z', '', { endTime: '2026-11-09T18:20:00Z' }),
    conv('c', '2026-11-09T18:25:00Z', 'Summary of c.'),
  ], '2026-11-09T09:00:00Z', now);
  assert.deepEqual(plan.blocks.map((block) => block.id), ['a']);
  assert.equal(plan.through, '2026-11-09T17:00:00Z', 'the read stops before a conversation Fieldy has not summarized yet');
  assert.equal(plan.later, 2);
  const withTranscript = f.reviewPlan([conv('b', '2026-11-09T12:00:00Z', '')], '2026-11-09T09:00:00Z', now, { b: 'A: we talked' });
  assert.match(withTranscript.text, /A: we talked/, 'an old one with no summary is read from its transcript');
}, 'a conversation not summarized yet waits');
check(() => {
  const now = Date.parse('2026-11-10T03:00:00Z');
  const long = 'x '.repeat(1200);
  const many = Array.from({ length: 10 }, (_, index) => conv(`c${index}`, `2026-11-09T1${index}:00:00Z`, long));
  const plan = f.reviewPlan(many, '2026-11-09T00:00:00Z', now);
  assert.ok(plan.text.length <= 12_000, 'within what the review reads');
  assert.ok(plan.blocks.length < 10 && plan.later === 10 - plan.blocks.length, 'the rest wait for the next read');
  assert.equal(plan.through, plan.blocks[plan.blocks.length - 1] && many[plan.blocks.length - 1].startTime);
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
  assert.deepEqual(plan, { name: 'list_files', start: 'date_from', end: 'date_to', size: 'page_size', cursor: null });
  assert.deepEqual(f.listArguments(plan, '2026-11-09T07:00:00.000Z', '2026-11-09T23:00:00.000Z', null),
    { date_from: '2026-11-08', date_to: '2026-11-10', page_size: 50 }, 'a date-only window is widened a day each way');
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
  const plan = f.reviewPlan([{ ...conversations[0], summary: 'Ana asked about detox.' }], '2026-11-09T00:00:00Z', Date.parse('2026-11-09T23:00:00Z'), {}, 'Plaud');
  assert.match(plan.text, /^\[From Plaud, Nov 9, \d+:00 (AM|PM) · Call with Ana\]/);
}, 'Plaud: recordings, notes and the account');

// ─── Wiring ────────────────────────────────────────────────────────────────
const api = read('src/lib/fieldy-api.ts');
const sheet = read('src/lib/DayReviewSheet.tsx');
const app = read('App.tsx');
const appJson = JSON.parse(read('app.json'));
check(() => {
  assert.match(api, /keychainAccessible: SecureStore\.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY/, 'the sign-in stays on this phone, never synced or backed up');
  assert.doesNotMatch(api, /supabase/, 'nothing about Fieldy goes to ReferralFit\'s server');
  assert.doesNotMatch(api, /console\.(log|error|warn)\([^)]*(token|refresh|summary|text)\b/i, 'no token or conversation is logged');
  assert.match(api, /refreshing\.set\(key, refresh\)/, 'one refresh at a time per recorder and account (refresh tokens rotate)');
  assert.match(api, /const slot = \(recorder: Recorder, userId: string\) => `\$\{recorder\.id\}:\$\{userId\}`/, 'tokens are kept per recorder and per account');
  assert.match(api, /await writeStored\(recorder, userId, \{ \.\.\.stored, refreshToken: tokens\.refreshToken \}\)/, 'the new refresh token is kept at once');
  assert.match(api, /recorder\.revokeUrl[^]*logoutPlan/, 'disconnecting revokes the access at the recorder (Fieldy: revocation; Plaud: logout)');
  assert.match(api, /WebBrowser\.openAuthSessionAsync\(authorizeUrl\(challenge, state, recorder\), recorder\.redirectUri\)/);
}, 'the connection');
check(() => {
  assert.match(sheet, /commitRecorderRead\(recorder, userId, through\)/, 'a read moves on only once something from it is saved');
  assert.match(sheet, /sourceFor\(found\.evidence, blocks\)/);
  assert.ok(appJson.expo.scheme.includes('com.mattbrown.referralfit'), 'the app opens for Fieldy\'s return');
  assert.ok(appJson.expo.plugins.includes('expo-web-browser'));
  assert.match(app, /countNewRecordings\(recorder, userId\)/, 'the Today card counts, it does not review');
  assert.match(app, /if \(target === 'day_review'\)/, 'the 6 PM reminder opens the review');
}, 'the review and the app');

console.log(`fieldy-test: ${checks} checks passed`);
