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

// ─── Wiring ────────────────────────────────────────────────────────────────
const api = read('src/lib/fieldy-api.ts');
const sheet = read('src/lib/DayReviewSheet.tsx');
const app = read('App.tsx');
const appJson = JSON.parse(read('app.json'));
check(() => {
  assert.match(api, /keychainAccessible: SecureStore\.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY/, 'the sign-in stays on this phone, never synced or backed up');
  assert.doesNotMatch(api, /supabase/, 'nothing about Fieldy goes to ReferralFit\'s server');
  assert.doesNotMatch(api, /console\.(log|error|warn)\([^)]*(token|refresh|summary|text)\b/i, 'no token or conversation is logged');
  assert.match(api, /refreshing\.set\(userId, refresh\)/, 'one refresh at a time (Fieldy rotates refresh tokens)');
  assert.match(api, /await writeStored\(userId, \{ \.\.\.stored, refreshToken: tokens\.refreshToken \}\)/, 'the new refresh token is kept at once');
  assert.match(api, /FIELDY\.revokeUrl/, 'disconnecting revokes the token at Fieldy');
  assert.match(api, /WebBrowser\.openAuthSessionAsync\(authorizeUrl\(challenge, state\), FIELDY\.redirectUri\)/);
}, 'the connection');
check(() => {
  assert.match(sheet, /commitFieldyRead\(userId, through\)/, 'a read moves on only once something from it is saved');
  assert.match(sheet, /sourceFor\(found\.evidence, blocks\)/);
  assert.ok(appJson.expo.scheme.includes('com.mattbrown.referralfit'), 'the app opens for Fieldy\'s return');
  assert.ok(appJson.expo.plugins.includes('expo-web-browser'));
  assert.match(app, /countNewFieldyConversations\(userId\)/, 'the Today card counts, it does not review');
  assert.match(app, /if \(target === 'day_review'\)/, 'the 6 PM reminder opens the review');
}, 'the review and the app');

console.log(`fieldy-test: ${checks} checks passed`);
