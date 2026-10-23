#!/usr/bin/env node
// Behavioral tests for the offline data layer, run against the real
// src/lib/{store,auth-session,errors,paging,case-cache,account,directory,push}.ts
// (transpiled) over an in-memory PostgREST/auth fake. Imported by
// scripts/store-account-test.mjs so `npm test` runs it.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'offline-sync-test');
const require = createRequire(import.meta.url);
const ts = require(path.join(repoRoot, 'node_modules', 'typescript'));
mkdirSync(tmpDir, { recursive: true });

function transpile(rel, out, dir = tmpDir) {
  const js = ts.transpileModule(readFileSync(path.join(repoRoot, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true },
  }).outputText;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, out), js);
}

// ─── Shared fakes ───────────────────────────────────────────────────────────

const U = '11111111-1111-4111-8111-111111111111';
const TEAMMATE = '66666666-6666-4666-8666-666666666666';
const ORG = '22222222-2222-4222-8222-222222222222';
const STORAGE_KEY = 'sb-test-auth-token';

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims) => `${b64url({ alg: 'HS256' })}.${b64url(claims)}.sig`;
const nowS = () => Math.floor(Date.now() / 1000);
function makeSession(userId, sessionId, expiresAt) {
  return {
    access_token: jwt({ sub: userId, session_id: sessionId, exp: expiresAt }),
    refresh_token: 'refresh-1',
    expires_in: 3600,
    expires_at: expiresAt,
    token_type: 'bearer',
    user: { id: userId, aud: 'authenticated' },
  };
}

const NETWORK = () => ({ message: 'TypeError: Network request failed', details: '', hint: '', code: '' });
const RETRYABLE = () => Object.assign(new Error('Network request failed'), { name: 'AuthRetryableFetchError', status: 0, __isAuthError: true });

const state = {
  db: {},
  offline: false,
  failOn: null,
  log: [],
  rpcCalls: [],
  auth: 'online', // 'online' | 'offline-expired' | 'hang' | 'signed-out'
  getSessionCalls: 0,
  storage: new Map(),
  asyncStorage: new Map(),
  storageRemovals: [],
};
globalThis.__offlineSyncState = state;

function resetDb() {
  state.db = { partners: [], referrals: [], match_profiles: [], touches: [], partner_balances: [], follow_ups: [], partner_scorecard: [], placement_decisions: [], case_documents: [], global_partners: [], user_favorites: [], notification_preferences: [] };
  state.offline = false;
  state.failOn = null;
  state.log = [];
  state.rpcCalls = [];
}

writeFileSync(path.join(tmpDir, 'async-storage.js'), `
const s = globalThis.__offlineSyncState;
const api = {
  async getItem(k) { return s.asyncStorage.has(k) ? s.asyncStorage.get(k) : null; },
  async setItem(k, v) { s.asyncStorage.set(k, String(v)); },
  async removeItem(k) { s.asyncStorage.delete(k); },
  async multiRemove(keys) { keys.forEach((k) => s.asyncStorage.delete(k)); },
  async multiSet(pairs) { pairs.forEach(([k, v]) => s.asyncStorage.set(k, String(v))); },
  async getAllKeys() { return [...s.asyncStorage.keys()]; },
};
module.exports = api; module.exports.default = api; module.exports.__esModule = true;
`);

writeFileSync(path.join(tmpDir, 'supabase.js'), `
const s = globalThis.__offlineSyncState;
function query(table) {
  const b = { table, filters: [], op: 'select', payload: null, options: null, range: null, single: false, order: [], returning: false };
  const run = () => {
    if (s.offline) return { data: null, error: { message: 'TypeError: Network request failed', details: '', hint: '', code: '' } };
    const failure = s.failOn && s.failOn(b);
    if (failure) return { data: null, error: failure };
    s.log.push(b.op + ' ' + table);
    const rows = s.db[table] || (s.db[table] = []);
    if (b.op === 'select') {
      let result = rows.filter((row) => b.filters.every((f) => f(row)));
      for (const [col] of b.order.slice().reverse()) result = result.slice().sort((x, y) => String(x[col] ?? '').localeCompare(String(y[col] ?? '')));
      // PostgREST silently caps every response at max_rows (1000).
      result = b.range ? result.slice(b.range[0], Math.min(b.range[1] + 1, b.range[0] + 1000)) : result.slice(0, 1000);
      if (b.single) return { data: result[0] ?? null, error: null };
      return { data: result.map((row) => ({ ...row })), error: null };
    }
    if (b.op === 'insert' || b.op === 'upsert') {
      const index = rows.findIndex((row) => row.id === b.payload.id);
      if (index >= 0) {
        if (b.op === 'insert') return { data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' } };
        if (!(b.options && b.options.ignoreDuplicates)) rows[index] = { ...rows[index], ...b.payload, updated_at: new Date().toISOString() };
      } else {
        rows.push({ org_id: s.org, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...b.payload });
      }
      return { data: null, error: null };
    }
    if (b.op === 'update') {
      s.updates = s.updates || [];
      s.updates.push({ table, patch: { ...b.payload } });
      const matched = rows.filter((row) => b.filters.every((f) => f(row)));
      matched.forEach((row) => Object.assign(row, b.payload));
      // .update(...).select('id') returns the rows it changed (PostgREST return=representation).
      return { data: b.returning ? matched.map((row) => ({ id: row.id })) : null, error: null };
    }
    if (b.op === 'delete') {
      s.db[table] = rows.filter((row) => !b.filters.every((f) => f(row)));
      return { data: null, error: null };
    }
    return { data: null, error: null };
  };
  const api = {
    select() { if (b.op !== 'select') b.returning = true; return api; },
    order(col) { b.order.push([col]); return api; },
    eq(col, value) { b.filters.push((row) => row[col] === value); return api; },
    in(col, values) { b.filters.push((row) => values.includes(row[col])); return api; },
    range(from, to) { b.range = [from, to]; return api; },
    limit() { return api; },
    maybeSingle() { b.single = true; return api; },
    upsert(row, options) { b.op = 'upsert'; b.payload = row; b.options = options || null; return api; },
    insert(row) { b.op = 'insert'; b.payload = row; return api; },
    update(patch) { b.op = 'update'; b.payload = patch; return api; },
    delete() { b.op = 'delete'; return api; },
    then(resolve, reject) {
      // selectGate: answer one read of a table now but deliver it later (a refresh in flight).
      const gate = s.selectGate && b.op === 'select' && s.selectGate.table === table ? s.selectGate : null;
      if (gate) s.selectGate = null;
      return Promise.resolve().then(run).then(async (value) => { if (gate) await gate.promise; return value; }).then(resolve, reject);
    },
  };
  return api;
}
const storage = {
  async getItem(key) { return s.storage.has(key) ? s.storage.get(key) : null; },
  async setItem(key, value) { s.storage.set(key, value); },
  async removeItem(key) { s.storage.delete(key); },
};
exports.supabase = {
  from: query,
  async rpc(name, args) {
    if (s.offline) return { data: null, error: { message: 'TypeError: Network request failed', details: '', hint: '', code: '' } };
    const failure = s.failOn && s.failOn({ op: 'rpc', table: name, payload: args });
    if (failure) return { data: null, error: failure };
    s.rpcCalls.push({ name, args });
    if (name === 'current_org_id') return { data: s.org, error: null };
    s.log.push('rpc ' + name);
    if (name === 'assign_match_referral') {
      for (const [table, row] of [['referrals', args.p_referral], ['match_profiles', args.p_match]]) {
        const rows = s.db[table];
        const index = rows.findIndex((item) => item.id === row.id);
        if (index >= 0) rows[index] = { ...rows[index], ...row }; else rows.push({ org_id: s.org, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...row });
      }
    }
    if (name === 'record_outreach_sent') {
      s.db.follow_ups.push({ org_id: s.org, created_at: new Date().toISOString(), ...args.p_next });
    }
    if (s.rpcResults && s.rpcResults[name]) return s.rpcResults[name](args);
    return { data: null, error: null };
  },
  storage: { from: (bucket) => ({ async remove(paths) { s.removed = s.removed || []; s.removed.push({ bucket, paths }); return { data: null, error: null }; } }) },
  auth: {
    storage,
    storageKey: '${STORAGE_KEY}',
    async signOut() { s.signedOut = true; return { error: null }; },
    async _removeSession() { if (s.noRemoveSession) throw new Error('gone'); s.storage.delete('${STORAGE_KEY}'); s.authEvents = s.authEvents || []; s.authEvents.push('SIGNED_OUT'); },
    getSession() {
      s.getSessionCalls += 1;
      if (s.auth === 'hang') return new Promise(() => {});
      if (s.auth === 'signed-out') return Promise.resolve({ data: { session: null }, error: null });
      if (s.auth === 'offline-expired') {
        const err = Object.assign(new Error('Network request failed'), { name: 'AuthRetryableFetchError', status: 0 });
        return Promise.resolve({ data: { session: null }, error: err });
      }
      const raw = s.storage.get('${STORAGE_KEY}');
      return Promise.resolve({ data: { session: raw ? JSON.parse(raw) : null }, error: null });
    },
  },
};
`);
state.org = ORG;

writeFileSync(path.join(tmpDir, 'cases.js'), `
exports.newUuid = () => require('node:crypto').randomUUID();
exports.fetchCaseList = async () => { const s = globalThis.__offlineSyncState; if (s.offline) throw { message: 'TypeError: Network request failed', code: '' }; return { cases: [], contacts: [] }; };
exports.fetchCaseFile = async () => ({ events: [], documents: [] });
`);

for (const [rel, out] of [
  ['src/lib/store.ts', 'store.js'],
  ['src/lib/auth-session.ts', 'auth-session.js'],
  ['src/lib/errors.ts', 'errors.js'],
  ['src/lib/paging.ts', 'paging.js'],
  ['src/lib/case-cache.ts', 'case-cache.js'],
]) transpile(rel, out);

const Module = require('node:module');
const originalResolve = Module._resolveFilename;
const stubs = new Map([['@react-native-async-storage/async-storage', path.join(tmpDir, 'async-storage.js')]]);
Module._resolveFilename = function (request, parent, ...rest) {
  if (stubs.has(request)) return stubs.get(request);
  return originalResolve.call(this, request, parent, ...rest);
};

const errors = require(path.join(tmpDir, 'errors.js'));
const auth = require(path.join(tmpDir, 'auth-session.js'));
const store = require(path.join(tmpDir, 'store.js'));

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    console.error(`FAIL  ${name}`);
    throw error;
  }
}

function signIn(expiresInSeconds = 3600) {
  state.storage.set(STORAGE_KEY, JSON.stringify(makeSession(U, 'sess-1', nowS() + expiresInSeconds)));
  state.auth = 'online';
  auth.resetAuthNetworkStateForTests();
}
// Offline with an expired access token: supabase-js still holds the session
// on the device but getSession() reports the failed refresh.
function goOfflineExpired() {
  state.storage.set(STORAGE_KEY, JSON.stringify(makeSession(U, 'sess-1', nowS() - 3600)));
  state.auth = 'offline-expired';
  state.offline = true;
  auth.resetAuthNetworkStateForTests();
}

const matchRow = (id, extra = {}) => ({ id, client_label: 'Family', level_of_care: 'Inpatient', state: 'OR', insurance: 'Cash pay', network_preferences: [], max_budget: null, therapies: [], status: 'Matching', assigned_partner_id: null, referral_id: null, case_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), org_id: ORG, ...extra });
const partner = (id, name, extra = {}) => ({ id, name, organization: 'Org', type: 'Inpatient', city: '', state: 'OR', regions: [], phone: '', email: '', cashMin: 0, cashMax: 0, insurance: [], therapies: [], populations: [], levels: [], note: '', inbound: 0, outbound: 0, lastContact: '2026-10-01', ...extra });
const followUp = (id, extra = {}) => ({ id, title: 'Call back', dueOn: '2026-10-23', status: 'open', note: '', ...extra });
const queueKey = `referralfit-write-queue-v2:${U}`;
const rejectedKey = `referralfit-rejected-writes-v1:${U}`;

async function freshAccount() {
  resetDb();
  state.asyncStorage.clear();
  signIn();
  await store.bindLocalWorkspace(U, ORG);
}

// ─── errors.ts ──────────────────────────────────────────────────────────────

await check('PostgREST plain-object errors are readable, never [object Object]', () => {
  const text = errors.describeError({ message: 'The assignee must be a member of this workspace', details: 'user 666 is not a member', hint: 'Pick a teammate', code: '22023' });
  assert.equal(text, 'The assignee must be a member of this workspace — user 666 is not a member — Hint: Pick a teammate (code 22023)');
  assert.equal(errors.describeError(new Error('boom')), 'boom');
  assert.equal(errors.describeError('plain'), 'plain');
  assert.equal(errors.describeError(null, 'fallback'), 'fallback');
  assert.equal(errors.describeError({ code: 'P0001' }), 'Error code P0001');
  assert.doesNotMatch(errors.describeError({}), /object Object/);
  assert.ok(new errors.RejectedWritesError('x', 2) instanceof errors.StoreError);
});

// ─── auth-session.ts ────────────────────────────────────────────────────────

await check('an online session is a server-backed identity', async () => {
  signIn();
  const identity = await auth.currentAuthSessionIdentity({ allowOffline: true });
  assert.deepEqual(identity, { userId: U, sessionId: 'sess-1', offline: false });
  assert.deepEqual(await auth.currentAuthSessionIdentity(), { userId: U, sessionId: 'sess-1' });
});

await check('an expired token offline keeps the account on its own data (offline identity), strict callers still get null', async () => {
  goOfflineExpired();
  const identity = await auth.currentAuthSessionIdentity({ allowOffline: true });
  assert.deepEqual(identity, { userId: U, sessionId: 'sess-1', offline: true });
  assert.equal(await auth.currentAuthSessionIdentity(), null, 'server-backed callers keep the strict behavior');
});

await check('after one failed refresh the fence does not ask the server again for a while', async () => {
  goOfflineExpired();
  state.getSessionCalls = 0;
  await auth.currentAuthSessionIdentity({ allowOffline: true });
  for (let i = 0; i < 5; i += 1) await auth.currentAuthSessionIdentity({ allowOffline: true });
  assert.equal(state.getSessionCalls, 1, 'later fence checks read the persisted session directly');
});

await check('a refresh that hangs (supabase-js retries ~25 s) is cut off by the timeout', async () => {
  goOfflineExpired();
  state.auth = 'hang';
  const started = Date.now();
  const identity = await auth.currentAuthSessionIdentity({ allowOffline: true, timeoutMs: 60 });
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(identity, { userId: U, sessionId: 'sess-1', offline: true });
  auth.resetAuthNetworkStateForTests();
  const launch = await auth.resolveLaunchSession(60);
  assert.equal(launch.offline, true, 'a cold offline launch keeps the persisted session instead of the sign-in screen');
  assert.equal(launch.session.user.id, U);
});

await check('a signed-out device has no identity and no fallback', async () => {
  state.storage.delete(STORAGE_KEY);
  state.auth = 'signed-out';
  auth.resetAuthNetworkStateForTests();
  assert.equal(await auth.currentAuthSessionIdentity({ allowOffline: true }), null);
  assert.equal(await auth.offlineSessionFallback(), null);
  assert.deepEqual(await auth.resolveLaunchSession(60), { session: null, offline: false });
  // A stored token minted for someone else is not trusted.
  state.storage.set(STORAGE_KEY, JSON.stringify({ ...makeSession(U, 'sess-1', nowS() - 10), user: { id: TEAMMATE } }));
  state.auth = 'offline-expired';
  assert.equal(await auth.currentAuthSessionIdentity({ allowOffline: true }), null);
});

// ─── store.ts: rejected queued ops no longer brick the device ──────────────

await check('a server-rejected queued op is set aside; hydrate still returns data and later ops keep flowing', async () => {
  await freshAccount();
  const F = '55555555-5555-4555-8555-555555555555';
  const P = '77777777-7777-4777-8777-777777777777';
  state.offline = true;
  await store.updateFollowUp(followUp(F, { assignedTo: TEAMMATE }), U);
  await store.createPartner(partner(P, 'Queued after the bad one'), U);
  assert.equal(await store.pendingWriteCount(U), 2);
  state.offline = false;
  state.failOn = (b) => (b.op === 'update' && b.table === 'follow_ups') ? { message: 'The assignee must be a member of this workspace', details: '', hint: '', code: '22023' } : null;

  const first = await store.hydrate(U);
  assert.equal(first.source, 'remote');
  assert.match(first.syncError, /could not be saved and was set aside/);
  assert.match(first.syncError, /The assignee must be a member of this workspace \(code 22023\)/);
  assert.doesNotMatch(first.syncError, /object Object/);
  assert.ok(state.db.partners.some((row) => row.id === P), 'the op behind the rejected one still reached the server');
  assert.equal(await store.pendingWriteCount(U), 0, 'the live queue drains');

  const second = await store.hydrate(U);
  assert.equal(second.source, 'remote');
  assert.equal(second.syncError, undefined, 'a set-aside change is reported once, not on every launch');

  const rejected = await store.listRejectedWrites(U);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].kind, 'follow_up.update');
  assert.equal(rejected[0].code, '22023');
  assert.match(rejected[0].summary, /Edit follow-up “Call back”/);
  assert.match(rejected[0].reason, /assignee must be a member/);
  assert.equal(await store.rejectedWriteCount(U), 1);
});

await check('flushWriteQueue raises RejectedWritesError once, then retry and discard work', async () => {
  await freshAccount();
  const F = '55555555-5555-4555-8555-555555555556';
  state.db.follow_ups.push({ id: F, title: 'Call back', due_on: '2026-10-23', status: 'open', org_id: ORG, created_at: new Date().toISOString() });
  state.offline = true;
  await store.updateFollowUp(followUp(F, { note: 'first' }), U);
  state.offline = false;
  state.failOn = (b) => (b.op === 'update' && b.table === 'follow_ups') ? { message: 'new row violates row-level security policy', code: '42501' } : null;
  await assert.rejects(store.flushWriteQueue(U), (error) => error instanceof errors.RejectedWritesError && error instanceof errors.StoreError && error.count === 1 && /row-level security/.test(error.message));
  assert.equal(await store.flushWriteQueue(U), 0, 'nothing left to raise');

  const [entry] = await store.listRejectedWrites(U);
  await assert.rejects(store.retryRejectedWrite(U, entry.id), errors.RejectedWritesError, 'still refused: back on the list');
  const [again] = await store.listRejectedWrites(U);
  assert.ok(again, 'a refused retry is listed again');
  state.failOn = null;
  assert.equal(await store.retryRejectedWrite(U, again.id), 1);
  assert.equal(state.db.follow_ups.find((row) => row.id === F).note, 'first');
  assert.equal(await store.rejectedWriteCount(U), 0);

  state.offline = true;
  await store.updateFollowUp(followUp(F, { note: 'second' }), U);
  state.offline = false;
  state.failOn = (b) => (b.op === 'update' && b.table === 'follow_ups') ? { message: 'nope', code: 'P0001' } : null;
  await assert.rejects(store.flushWriteQueue(U), errors.RejectedWritesError);
  const [toDiscard] = await store.listRejectedWrites(U);
  await store.discardRejectedWrite(U, toDiscard.id);
  assert.equal(await store.rejectedWriteCount(U), 0);
  await assert.rejects(store.retryRejectedWrite(U, toDiscard.id), /no longer waiting/);
});

await check('an op whose parent never arrives is capped and set aside, so the queue can reach 0', async () => {
  await freshAccount();
  const F = '88888888-8888-4888-8888-888888888888';
  state.offline = true;
  await store.createFollowUp(followUp(F, { partnerId: '99999999-9999-4999-8999-999999999999' }), U);
  state.offline = false;
  state.failOn = (b) => (b.op === 'upsert' && b.table === 'follow_ups') ? { message: 'insert or update on table "follow_ups" violates foreign key constraint', code: '23503' } : null;
  for (let attempt = 1; attempt < store.MAX_PARENT_WAIT_ATTEMPTS; attempt += 1) {
    assert.equal(await store.flushWriteQueue(U), 0);
    assert.equal(await store.pendingWriteCount(U), 1, `still waiting for its parent after ${attempt} attempts`);
  }
  await assert.rejects(store.flushWriteQueue(U), errors.RejectedWritesError);
  assert.equal(await store.pendingWriteCount(U), 0);
  const [entry] = await store.listRejectedWrites(U);
  assert.match(entry.reason, /depends on a record that was never saved or was deleted/);
  assert.equal(entry.code, '23503');

  // The 7-day bound: a first refusal more than a week ago is set aside on the next try.
  await store.discardRejectedWrite(U, entry.id);
  state.offline = true;
  await store.createFollowUp(followUp('88888888-8888-4888-8888-888888888889', { partnerId: '99999999-9999-4999-8999-999999999999' }), U);
  state.offline = false;
  assert.equal(await store.flushWriteQueue(U), 0);
  const envelope = JSON.parse(state.asyncStorage.get(queueKey));
  const keys = Object.keys(envelope.parentWaits || {});
  assert.equal(keys.length, 1, 'the wait is tracked durably with the queue');
  envelope.parentWaits[keys[0]].first = new Date(Date.now() - 8 * 86400000).toISOString();
  state.asyncStorage.set(queueKey, JSON.stringify(envelope));
  await assert.rejects(store.flushWriteQueue(U), errors.RejectedWritesError);
  assert.equal(await store.pendingWriteCount(U), 0);

  // A parent that is merely later in the queue still resolves in the same flush.
  state.failOn = null;
  const P = '12121212-1212-4121-8121-121212121212';
  state.failOn = (b) => (b.op === 'upsert' && b.table === 'follow_ups' && !state.db.partners.some((row) => row.id === P)) ? { message: 'violates foreign key constraint', code: '23503' } : null;
  state.offline = true;
  await store.createFollowUp(followUp('12121212-1212-4121-8121-121212121213', { partnerId: P }), U);
  await store.createPartner(partner(P, 'Parent'), U);
  state.offline = false;
  assert.equal(await store.flushWriteQueue(U), 2);
  assert.equal(await store.pendingWriteCount(U), 0);
});

// ─── store.ts: offline with an expired token ────────────────────────────────

await check('offline with an expired token: saves queue instantly, the cache saves, relaunch reads it', async () => {
  await freshAccount();
  await store.hydrate(U);
  goOfflineExpired();
  const P = '77777777-7777-4777-8777-777777777778';
  const started = Date.now();
  state.log = [];
  await store.createPartner(partner(P, 'Offline partner'), U);
  await store.persistCache({ partners: [partner(P, 'Offline partner')], referrals: [], referralMatches: [], touches: [], followUps: [], scorecards: {} }, U);
  assert.equal(await store.pendingWriteCount(U), 1);
  assert.equal(await store.isOfflineSession(U), true);
  const relaunch = await store.hydrate(U);
  assert.ok(Date.now() - started < 1500, 'nothing waited on a token refresh');
  assert.equal(relaunch.source, 'cache');
  assert.deepEqual(relaunch.snapshot.partners.map((row) => row.id), [P], 'the offline edit reached the saved copy');
  assert.equal(await store.refreshSnapshot(U), null);
  assert.equal(await store.flushWriteQueue(U), 0);
  assert.deepEqual(state.log, [], 'no server request was attempted under an offline identity');
  const caseLoad = await store.loadCaseList(U).catch((error) => error);
  assert.ok(store.isNetworkError(caseLoad), 'no saved case list offline reads as a lost connection, not a sign-in error');

  // Back online: the queued partner flushes and the saved copy keeps it.
  signIn();
  state.offline = false;
  const online = await store.hydrate(U);
  assert.equal(online.source, 'remote');
  assert.ok(online.snapshot.partners.some((row) => row.id === P));
  assert.equal(await store.pendingWriteCount(U), 0);
});

await check('persistCache with no connection (valid token) uses the verified binding', async () => {
  await freshAccount();
  await store.hydrate(U);
  state.offline = true;
  const P = '77777777-7777-4777-8777-777777777779';
  await store.createPartner(partner(P, 'New'), U);
  await store.persistCache({ partners: [partner(P, 'New')], referrals: [], referralMatches: [], touches: [], followUps: [], scorecards: {} }, U);
  const relaunch = await store.hydrate(U);
  assert.equal(relaunch.source, 'cache');
  assert.equal(relaunch.snapshot.partners.length, 1);
  // A workspace the server reports differently still refuses the save.
  state.offline = false;
  state.org = '33333333-3333-4333-8333-333333333399';
  await assert.rejects(store.persistCache(relaunch.snapshot, U), /active workspace changed/);
  state.org = ORG;
});

// ─── store.ts: a teammate's deletion is not undone ──────────────────────────

await check('a row deleted on the server is dropped from the cache, never re-queued', async () => {
  await freshAccount();
  const M = '33333333-3333-4333-8333-333333333333';
  state.db.match_profiles.push(matchRow(M));
  const T = '44444444-4444-4444-8444-444444444440';
  state.db.partners.push({ id: T, name: 'Gone', organization: '', types: ['Inpatient'], created_at: new Date().toISOString(), org_id: ORG });
  await store.hydrate(U);
  state.db.match_profiles = [];
  state.db.partners = [];
  const snap = await store.refreshSnapshot(U);
  assert.equal(snap.referralMatches.length, 0);
  assert.equal(snap.partners.length, 0);
  assert.equal(await store.pendingWriteCount(U), 0);
  await store.flushWriteQueue(U);
  assert.equal(state.db.match_profiles.length, 0, 'not resurrected on the server');
});

await check('a cache-only row survives while its creating op is queued or rejected, and goes after discard', async () => {
  await freshAccount();
  await store.hydrate(U);
  const P = '44444444-4444-4444-8444-444444444441';
  const R = '44444444-4444-4444-8444-444444444442';
  state.offline = true;
  await store.createPartner(partner(P, 'Not synced yet'), U);
  await store.recordOutreachSent(null, followUp(R, { title: 'Next step' }), null, { id: '44444444-4444-4444-8444-444444444443', partnerId: P, kind: 'text', note: '', occurredAt: new Date().toISOString() }, U);
  await store.persistCache({
    partners: [partner(P, 'Not synced yet')], referrals: [], referralMatches: [],
    touches: [{ id: '44444444-4444-4444-8444-444444444443', partnerId: P, kind: 'text', note: '', occurredAt: new Date().toISOString() }],
    followUps: [followUp(R, { title: 'Next step' })], scorecards: {},
  }, U);
  state.offline = false;
  // Refresh without a flush (the queue still holds both creating ops).
  let snap = await store.refreshSnapshot(U);
  assert.ok(snap.partners.some((row) => row.id === P), 'queued partner insert keeps its row');
  assert.ok(snap.followUps.some((row) => row.id === R), 'queued outreach.sent keeps its next step');
  assert.equal(snap.touches.length, 1, 'queued outreach.sent keeps its touch');

  // The partner insert is refused: still visible while it awaits a decision,
  // and the outreach that logged a touch for it is held with it.
  state.failOn = (b) => (b.op === 'upsert' && b.table === 'partners') ? { message: 'name too long', code: '23514' } : null;
  await assert.rejects(store.flushWriteQueue(U), errors.RejectedWritesError);
  assert.equal(state.rpcCalls.some((call) => call.name === 'record_outreach_sent'), false, 'a touch for the refused partner waits with it');
  const [held] = await store.listRejectedWrites(U);
  assert.equal(held.heldChanges, 1);
  assert.equal(held.status, 'rejected');
  state.failOn = null;
  snap = await store.refreshSnapshot(U);
  assert.ok(snap.partners.some((row) => row.id === P), 'a rejected insert keeps its row until discarded');
  const [entry] = await store.listRejectedWrites(U);
  await store.discardRejectedWrite(U, entry.id);
  snap = await store.refreshSnapshot(U);
  assert.equal(snap.partners.some((row) => row.id === P), false, 'discarded: the row goes with it');
});

// ─── store.ts: ordering and column-level patches ────────────────────────────

await check('an online save never jumps ahead of older queued changes', async () => {
  await freshAccount();
  await store.hydrate(U);
  const P = '44444444-4444-4444-8444-444444444444';
  await store.createPartner(partner(P, 'Original'), U);
  state.offline = true;
  await store.updatePartner(partner(P, 'Original', { phone: '555-0100' }), U);
  state.offline = false;
  await store.updatePartner(partner(P, 'Original', { phone: '555-0100', note: 'NEW NOTE' }), U);
  const row = state.db.partners.find((item) => item.id === P);
  assert.equal(row.note, 'NEW NOTE');
  assert.equal(row.phone, '555-0100');
  await store.flushWriteQueue(U);
  assert.equal(state.db.partners.find((item) => item.id === P).note, 'NEW NOTE', 'no stale replay after the newer save');
  assert.equal(await store.pendingWriteCount(U), 0);
});

await check('a queued match insert replayed after an online assignment does not undo it', async () => {
  await freshAccount();
  await store.hydrate(U);
  const M = '45454545-4545-4545-8545-454545454545';
  const P = '45454545-4545-4545-8545-454545454546';
  const R = '45454545-4545-4545-8545-454545454547';
  state.db.partners.push({ id: P, name: 'Program', organization: '', types: ['Inpatient'], created_at: new Date().toISOString(), org_id: ORG });
  const match = { id: M, clientLabel: 'Family', levelOfCare: 'Inpatient', state: 'OR', insurance: 'Cash pay', networkPreferences: [], therapies: [], status: 'Matching', createdAt: '', updatedAt: '' };
  state.offline = true;
  await store.createMatchProfile(match, U);
  state.offline = false;
  await store.assignMatchReferral(
    { id: R, partnerId: P, direction: 'Outbound', date: '2026-10-23', clientLabel: 'Family', outcome: 'Pending', note: '' },
    { ...match, status: 'Referred', assignedPartnerId: P, referralId: R },
    U,
  );
  assert.equal(state.db.match_profiles.find((row) => row.id === M).assigned_partner_id, P);
  // The same stale insert replayed (e.g. the app was killed before the queue was rewritten).
  state.offline = true;
  await store.createMatchProfile(match, U);
  state.offline = false;
  await store.flushWriteQueue(U);
  assert.equal(state.db.match_profiles.find((row) => row.id === M).assigned_partner_id, P, 'insert-once never overwrites');
});

await check('an edit sends only the columns that changed, so a teammate’s edit survives', async () => {
  await freshAccount();
  const P = '46464646-4646-4646-8646-464646464646';
  state.db.partners.push({ id: P, name: 'Shared', organization: 'Org', types: ['Inpatient'], phone: '111', note: '', city: '', state: 'OR', regions: [], email: '', insurance: [], therapies: [], populations: [], levels: [], created_at: new Date().toISOString(), org_id: ORG });
  const { snapshot } = await store.hydrate(U);
  const cached = snapshot.partners.find((row) => row.id === P);
  state.db.partners.find((row) => row.id === P).phone = '999'; // teammate, on another device
  state.updates = [];
  await store.updatePartner({ ...cached, note: 'my note' }, U);
  assert.deepEqual(state.updates.map((update) => Object.keys(update.patch)), [['note']]);
  const row = state.db.partners.find((item) => item.id === P);
  assert.equal(row.phone, '999', 'the teammate’s phone number is not reverted');
  assert.equal(row.note, 'my note');
  state.updates = [];
  await store.updatePartner(cached, U);
  assert.deepEqual(state.updates, [], 'no change, no write');
});

// ─── store.ts: dates ─────────────────────────────────────────────────────────

await check('last contact is the local calendar day of the timestamptz', async () => {
  const previousTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    await freshAccount();
    const evening = new Date(2026, 9, 20, 18, 30).toISOString(); // Oct 20, 6:30 PM local = Oct 21 UTC
    assert.match(evening, /^2026-10-21T01:30/);
    state.db.partners.push({ id: '47474747-4747-4747-8747-474747474747', name: 'Eve', organization: '', types: ['Inpatient'], last_contact_at: evening, created_at: evening, org_id: ORG });
    const { snapshot } = await store.hydrate(U);
    assert.equal(snapshot.partners[0].lastContact, '2026-10-20');
  } finally {
    if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz;
  }
});

// ─── store.ts: workspace boundaries ─────────────────────────────────────────

await check('workspace changes handle the rejected list', async () => {
  await freshAccount();
  state.offline = true;
  await store.updateFollowUp(followUp('48484848-4848-4848-8848-484848484848', { note: 'x' }), U);
  state.offline = false;
  state.failOn = (b) => (b.op === 'update') ? { message: 'refused', code: 'P0001' } : null;
  await assert.rejects(store.flushWriteQueue(U), errors.RejectedWritesError);
  state.failOn = null;
  await assert.rejects(store.prepareForWorkspaceChange(U), /could not be saved\. Retry or discard it before joining another workspace/);
  assert.ok(state.asyncStorage.has(rejectedKey));
  await store.prepareForWorkspaceChange(U, { discardRejected: true });
  assert.equal(state.asyncStorage.has(rejectedKey), false, 'account deletion wipes the rejected list with the caches');

  await freshAccount();
  state.offline = true;
  await store.updateFollowUp(followUp('48484848-4848-4848-8848-484848484849', { note: 'x' }), U);
  state.offline = false;
  state.failOn = (b) => (b.op === 'update') ? { message: 'refused', code: 'P0001' } : null;
  await assert.rejects(store.flushWriteQueue(U), errors.RejectedWritesError);
  state.failOn = null;
  assert.equal(await store.bindLocalWorkspace(U, '33333333-3333-4333-8333-333333333398'), true);
  assert.equal(state.asyncStorage.has(rejectedKey), false, 'a different workspace never inherits refused changes');

  goOfflineExpired();
  await assert.rejects(store.prepareForWorkspaceChange(U), /Connect to the internet/);
  signIn();
  state.offline = false;
});

// ─── Round 2: related changes stay together ─────────────────────────────────

const snapOf = (extra = {}) => ({ partners: [], referrals: [], referralMatches: [], touches: [], followUps: [], scorecards: {}, ...extra });

await check('an edit to a row whose insert was set aside waits with it and lands on retry', async () => {
  await freshAccount();
  const F = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0';
  state.offline = true;
  const created = followUp(F, { assignedTo: TEAMMATE, title: 'Call the family' });
  await store.createFollowUp(created, U);
  await store.persistCache(snapOf({ followUps: [created] }), U);
  state.offline = false;
  let calls = 0;
  state.failOn = (b) => (b.table === 'follow_ups' && b.op === 'upsert' && calls++ === 0) ? { message: 'The assignee must be a member of this workspace', code: '22023' } : null;
  const hydrated = await store.hydrate(U);
  assert.ok(hydrated.syncError);
  assert.ok(hydrated.snapshot.followUps.some((row) => row.id === F), 'still shown while it awaits a decision');
  const done = { ...created, status: 'done', completedAt: new Date().toISOString() };
  state.updates = [];
  await store.updateFollowUp(done, U); // online, but its insert is set aside
  assert.deepEqual(state.updates, [], 'the edit is not sent ahead of its insert (it would match nothing)');
  const [entry] = await store.listRejectedWrites(U);
  assert.equal(entry.heldChanges, 1, 'the edit is held with the refused insert');
  assert.equal(await store.pendingWriteCount(U), 0);
  await store.retryRejectedWrite(U, entry.id);
  assert.equal(state.db.follow_ups.find((row) => row.id === F).status, 'done', 'insert, then the edit');
});

await check('a refused partner insert holds the follow-up for it and that follow-up’s completion', async () => {
  await freshAccount();
  const P = '56565656-5656-4565-8565-565656565656';
  const F = '78787878-7878-4787-8787-787878787878';
  state.offline = true;
  const p = partner(P, 'New program');
  const f = followUp(F, { partnerId: P });
  await store.createPartner(p, U);
  await store.createFollowUp(f, U);
  await store.persistCache(snapOf({ partners: [p], followUps: [f] }), U);
  await store.updateFollowUp({ ...f, status: 'done', completedAt: new Date().toISOString() }, U);
  state.offline = false;
  let refuse = true;
  state.failOn = (b) => {
    if (b.table === 'partners' && b.op === 'upsert' && refuse) return { message: 'violates check constraint', code: '23514' };
    if (b.table === 'follow_ups' && b.op === 'upsert' && !state.db.partners.some((row) => row.id === P)) return { message: 'violates foreign key constraint', code: '23503' };
    return null;
  };
  await assert.rejects(store.flushWriteQueue(U), errors.RejectedWritesError);
  const [entry] = await store.listRejectedWrites(U);
  assert.equal(entry.kind, 'partner.insert');
  assert.equal(entry.heldChanges, 2, 'the follow-up insert and its completion wait with the partner');
  assert.equal(await store.pendingWriteCount(U), 0);
  refuse = false;
  await store.retryRejectedWrite(U, entry.id);
  assert.equal(state.db.follow_ups.find((row) => row.id === F)?.status, 'done', 'completed offline, saved completed');
});

await check('an edit queued behind an insert waiting on its parent stays behind it', async () => {
  await freshAccount();
  const P = '57575757-5757-4575-8575-575757575757';
  const F = '79797979-7979-4797-8797-797979797979';
  state.offline = true;
  const f = followUp(F, { partnerId: P });
  await store.createFollowUp(f, U); // queued before its partner (e.g. created from an older screen)
  await store.persistCache(snapOf({ followUps: [f] }), U);
  await store.updateFollowUp({ ...f, status: 'done' }, U);
  await store.createPartner(partner(P, 'Parent later in the queue'), U);
  state.offline = false;
  state.failOn = (b) => (b.table === 'follow_ups' && b.op === 'upsert' && !state.db.partners.some((row) => row.id === P)) ? { message: 'violates foreign key constraint', code: '23503' } : null;
  assert.equal(await store.flushWriteQueue(U), 3);
  assert.equal(state.db.follow_ups.find((row) => row.id === F).status, 'done');
});

await check('a queued update that matches no row waits like a missing parent; online it is refused at once', async () => {
  await freshAccount();
  const F = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a70';
  state.offline = true;
  await store.updateFollowUp(followUp(F, { note: 'edit of a row a teammate deleted' }), U);
  state.offline = false;
  for (let attempt = 1; attempt < store.MAX_PARENT_WAIT_ATTEMPTS; attempt += 1) assert.equal(await store.flushWriteQueue(U), 0);
  assert.equal(await store.waitingWriteCount(U), 1);
  await assert.rejects(store.flushWriteQueue(U), errors.RejectedWritesError);
  const [entry] = await store.listRejectedWrites(U);
  assert.match(entry.reason, /never saved or was deleted/);
  await store.discardRejectedWrite(U, entry.id);
  await assert.rejects(store.updateFollowUp(followUp(F, { note: 'again, online' }), U), /no longer on the server/);
  assert.equal(await store.pendingWriteCount(U), 0);
});

// ─── Round 2: passing server failures never park the queue ──────────────────

await check('transient server failures keep the queue intact; deterministic refusals are set aside', async () => {
  const transients = [
    { message: 'Timed out acquiring connection from connection pool.', code: 'PGRST003', details: '', hint: '' },
    { message: 'Database client error. Retrying the connection.', code: 'PGRST001', details: '', hint: '' },
    { message: '<html><head><title>502 Bad Gateway</title></head></html>' },
    { message: 'error code: 520' },
    { message: 'deadlock detected', code: '40P01', details: '', hint: '' },
    { message: 'could not serialize access', code: '40001' },
    { message: 'too many connections', code: '53300' },
    { message: 'canceling statement due to statement timeout', code: '57014' },
    { message: 'terminating connection due to administrator command', code: '57P01' },
  ];
  for (const transient of transients) {
    await freshAccount();
    state.offline = true;
    await store.createPartner(partner('12121212-1212-4121-8121-121212121212', 'Queued partner'), U);
    await store.createFollowUp(followUp('34343434-3434-4343-8343-343434343434', { partnerId: '12121212-1212-4121-8121-121212121212' }), U);
    state.offline = false;
    state.failOn = (b) => (b.op !== 'select' && b.op !== 'rpc') ? transient : null;
    assert.equal(await store.flushWriteQueue(U), 0, `${transient.code || transient.message}: no throw`);
    assert.equal(await store.pendingWriteCount(U), 2, `${transient.code || transient.message}: nothing leaves the live queue`);
    assert.equal(await store.rejectedWriteCount(U), 0, `${transient.code || transient.message}: nothing set aside`);
    // An online save during the blip queues behind instead of failing.
    await store.createFollowUp(followUp('34343434-3434-4343-8343-343434343435'), U);
    assert.equal(await store.pendingWriteCount(U), 3);
    state.failOn = null;
    assert.equal(await store.flushWriteQueue(U), 3, `${transient.code || transient.message}: all land once the server is healthy`);
  }
  assert.equal(store.isTransientServerError({ message: 'x', code: '23514' }), false);
  assert.equal(store.isTransientServerError({ message: 'x', code: '42501' }), false);
  assert.equal(store.isTransientServerError({ message: 'x', code: '22P02' }), false);
  assert.equal(store.isTransientServerError({ message: 'x', code: 'P0001' }), false);
  assert.equal(store.isTransientServerError({ message: 'x', code: 'PGRST204' }), false);
  assert.equal(store.isTransientServerError({ message: 'Internal Server Error', httpStatus: 503 }), true);
});

await check('a "transient" failure that lasts over a day and 25 tries is set aside', async () => {
  await freshAccount();
  state.offline = true;
  await store.createPartner(partner('13131313-1313-4131-8131-131313131313', 'Stuck'), U);
  state.offline = false;
  state.failOn = (b) => (b.op === 'upsert') ? { message: 'internal error', code: 'XX000' } : null;
  assert.equal(await store.flushWriteQueue(U), 0);
  const envelope = JSON.parse(state.asyncStorage.get(queueKey));
  const [key] = Object.keys(envelope.transientWaits);
  envelope.transientWaits[key] = { first: new Date(Date.now() - 2 * 86400000).toISOString(), attempts: store.MAX_TRANSIENT_ATTEMPTS - 1 };
  state.asyncStorage.set(queueKey, JSON.stringify(envelope));
  await assert.rejects(store.flushWriteQueue(U), errors.RejectedWritesError);
  const [entry] = await store.listRejectedWrites(U);
  assert.match(entry.reason, /kept failing/);
});

// ─── Round 2: a change waiting on a missing parent does not hold up others ──

await check('a waiting op does not make unrelated online saves queue, and can be discarded', async () => {
  await freshAccount();
  const GONE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const P2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const W = 'cccccccc-cccc-4ccc-8ccc-cccccccccccd';
  state.offline = true;
  await store.createTouch({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', partnerId: GONE, kind: 'call', note: '', occurredAt: new Date().toISOString() }, U);
  const waitingFollowUp = followUp(W, { partnerId: GONE });
  await store.createFollowUp(waitingFollowUp, U);
  state.offline = false;
  state.failOn = (b) => (b.payload && b.payload.partner_id === GONE) ? { message: 'violates foreign key constraint', code: '23503' } : null;
  await store.createPartner(partner(P2, 'Online save'), U);
  assert.ok(state.db.partners.some((row) => row.id === P2), 'an unrelated save goes straight to the server');
  assert.deepEqual(await store.syncStatus(U), { pending: 0, waiting: 2, rejected: 0 }, 'nothing is "to sync": the device is online');
  // A change to the waiting follow-up queues behind it.
  await store.updateFollowUp({ ...waitingFollowUp, note: 'more' }, U);
  assert.deepEqual(await store.syncStatus(U), { pending: 0, waiting: 2, rejected: 0 });
  const waiting = await store.listWaitingWrites(U);
  assert.equal(waiting.length, 2);
  assert.ok(waiting.every((item) => item.status === 'waiting'));
  const followUpGroup = waiting.find((item) => item.kind === 'follow_up.insert');
  assert.equal(followUpGroup.heldChanges, 1, 'its later edit is held with it');
  await assert.rejects(store.prepareForWorkspaceChange(U), /waiting for a record that never reached the server/);
  await store.discardWaitingWrite(U, followUpGroup.id);
  assert.equal(await store.pendingWriteCount(U), 1, 'the follow-up and its edit are gone; the touch still waits');
  await store.prepareForWorkspaceChange(U, { discardRejected: true });
  assert.equal(state.asyncStorage.has(queueKey), false, 'an explicit discard lets the workspace change proceed');
});

// ─── Round 2: a row saved during a refresh stays on screen ──────────────────

await check('a row saved online while a refresh is in flight is kept by the merge', async () => {
  await freshAccount();
  const P0 = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
  state.db.partners.push({ id: P0, name: 'Existing', organization: 'Org', types: ['Inpatient'], created_at: new Date().toISOString(), org_id: ORG });
  const base = await store.refreshSnapshot(U);
  let release;
  state.selectGate = { table: 'touches', promise: new Promise((resolve) => { release = resolve; }) };
  const refreshing = store.refreshSnapshot(U);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const touch = { id: '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a', partnerId: P0, kind: 'call', note: 'Spoke with intake', occurredAt: new Date().toISOString() };
  await store.createTouch(touch, U);
  await store.persistCache({ ...base, touches: [touch, ...base.touches] }, U);
  release();
  const refreshed = await refreshing;
  assert.ok(refreshed.touches.some((row) => row.id === touch.id), 'the server has it, so it stays');
});

// ─── Round 2: sign out with no connection ───────────────────────────────────

await check('forceLocalSignOut removes the persisted session offline', async () => {
  goOfflineExpired();
  state.authEvents = [];
  await auth.forceLocalSignOut();
  assert.equal(state.storage.has(STORAGE_KEY), false);
  assert.deepEqual(state.authEvents, ['SIGNED_OUT'], 'subscribers hear SIGNED_OUT');
  assert.equal(await auth.currentAuthSessionIdentity({ allowOffline: true }), null, 'no offline identity survives it');
  // Without the private teardown hook it still clears storage itself.
  goOfflineExpired();
  state.noRemoveSession = true;
  await auth.forceLocalSignOut();
  assert.equal(state.storage.has(STORAGE_KEY), false);
  state.noRemoveSession = false;
  signIn();
  state.offline = false;
});

// ─── account.ts: every document is removed, past the 1,000-row cap ──────────

{
  const accountDir = path.join(tmpDir, 'account');
  transpile('src/lib/account.ts', 'account.js', accountDir);
  writeFileSync(path.join(accountDir, 'errors.js'), "module.exports = require('../errors.js');");
  writeFileSync(path.join(accountDir, 'paging.js'), "module.exports = require('../paging.js');");
  writeFileSync(path.join(accountDir, 'supabase.js'), "module.exports = require('../supabase.js');");
  writeFileSync(path.join(accountDir, 'org.js'), `exports.fetchCurrentOrgId = async () => '${ORG}';`);
  writeFileSync(path.join(accountDir, 'store.js'), `
const { RejectedWritesError } = require('../errors.js');
const s = globalThis.__offlineSyncState;
exports.prepareForWorkspaceChange = async (userId, options) => {
  s.prepared.push({ userId, options });
  if (s.refuseFirstPrepare && s.prepared.length === 1) throw new RejectedWritesError('1 queued change could not be saved', 1);
};
exports.rejectedWriteCount = async () => (s.refuseFirstPrepare ? 1 : 0);
exports.waitingWriteCount = async () => (s.waitingOnPrepare ? 1 : 0);
`);
  const account = require(path.join(accountDir, 'account.js'));
  await check('account deletion removes every case document, paged', async () => {
    resetDb();
    signIn();
    for (let i = 0; i < 2350; i += 1) {
      state.db.case_documents.push({ id: `doc-${String(i).padStart(5, '0')}`, storage_path: `${U}/case/${i}.jpg`, org_id: ORG });
    }
    state.removed = [];
    state.prepared = [];
    state.refuseFirstPrepare = false;
    await account.deleteOwnAccount({ userId: U, removeWorkspaceFiles: true });
    const removed = state.removed.flatMap((call) => call.paths);
    assert.equal(removed.length, 2350, 'no document left behind in storage');
    assert.equal(new Set(removed).size, 2350);
    assert.ok(state.removed.every((call) => call.bucket === 'case-documents' && call.paths.length <= 100));
    assert.deepEqual(state.prepared, [{ userId: U, options: undefined }]);
  });
  await check('account deletion is not blocked by changes the server already refused', async () => {
    state.removed = [];
    state.prepared = [];
    state.refuseFirstPrepare = true;
    await account.deleteOwnAccount({ userId: U, removeWorkspaceFiles: false });
    assert.deepEqual(state.prepared, [{ userId: U, options: undefined }, { userId: U, options: { discardRejected: true } }]);
    state.refuseFirstPrepare = false;
  });
  await check('account deletion is not blocked by changes waiting on a record that never arrives', async () => {
    state.prepared = [];
    state.waitingOnPrepare = true;
    const real = require(path.join(accountDir, 'store.js'));
    const original = real.prepareForWorkspaceChange;
    real.prepareForWorkspaceChange = async (userId, options) => {
      state.prepared.push({ userId, options });
      if (!options) throw new errors.StoreError('1 change on this device is waiting for a record that never reached the server.', true);
    };
    await account.deleteOwnAccount({ userId: U, removeWorkspaceFiles: false });
    assert.deepEqual(state.prepared.map((call) => call.options), [undefined, { discardRejected: true }]);
    real.prepareForWorkspaceChange = original;
    state.waitingOnPrepare = false;
  });
}

// ─── directory.ts: reads past the 1,000-row cap ─────────────────────────────

{
  const directoryDir = path.join(tmpDir, 'directory');
  transpile('src/lib/directory.ts', 'directory.js', directoryDir);
  for (const name of ['errors', 'paging', 'supabase', 'auth-session', 'cases']) {
    writeFileSync(path.join(directoryDir, `${name}.js`), `module.exports = require('../${name}.js');`);
  }
  writeFileSync(path.join(directoryDir, 'beds.js'), 'exports.mapListingBeds = () => ({});');
  const directory = require(path.join(directoryDir, 'directory.js'));
  await check('the directory and its state filter load every active listing', async () => {
    resetDb();
    signIn();
    const states = ['WA', 'OR', 'CA', 'AZ'];
    for (let i = 0; i < 1500; i += 1) {
      state.db.global_partners.push({ id: `g-${String(i).padStart(5, '0')}`, name: `Program ${i}`, organization: `Org ${String(1500 - i).padStart(5, '0')}`, types: ['Inpatient'], state: states[i % 4], status: 'active', regions: [], insurance: [], therapies: [], populations: [], levels: [] });
    }
    state.db.global_partners.push({ id: 'g-archived', name: 'Old', organization: '', state: 'NV', status: 'archived' });
    const listings = await directory.fetchGlobalDirectory();
    assert.equal(listings.length, 1500);
    assert.equal(listings[0].state, 'AZ', 'still shown by state, then organization');
    assert.ok(listings.every((item, index) => index === 0 || listings[index - 1].state.localeCompare(item.state) <= 0));
    assert.deepEqual(await directory.fetchGlobalDirectoryStates(), ['AZ', 'CA', 'OR', 'WA']);
    for (let i = 0; i < 1200; i += 1) state.db.user_favorites.push({ target_type: 'global_partner', target_id: `g-${i}`, position: i });
    assert.equal((await directory.fetchFavoriteIds('global_partner')).size, 1200);
  });
}

// ─── push.ts: unregister works after a restart or an offline launch ────────

{
  const pushDir = path.join(tmpDir, 'push');
  transpile('src/lib/push.ts', 'push.js', pushDir);
  for (const name of ['errors', 'supabase', 'auth-session']) {
    writeFileSync(path.join(pushDir, `${name}.js`), `module.exports = require('../${name}.js');`);
  }
  writeFileSync(path.join(pushDir, 'notifications.js'), "exports.getNotificationPermissionState = async () => 'authorized'; exports.requestNotificationPermission = async () => true;");
  writeFileSync(path.join(pushDir, 'expo-notifications.js'), "exports.getExpoPushTokenAsync = async () => ({ data: 'ExponentPushToken[device-1]' });");
  writeFileSync(path.join(pushDir, 'react-native.js'), "exports.Platform = { OS: 'ios' };");
  stubs.set('expo-notifications', path.join(pushDir, 'expo-notifications.js'));
  stubs.set('react-native', path.join(pushDir, 'react-native.js'));
  const pushPath = path.join(pushDir, 'push.js');
  const freshPush = () => { delete require.cache[pushPath]; return require(pushPath); };

  await check('sign-out unregisters the device after an app restart', async () => {
    resetDb();
    state.asyncStorage.clear();
    signIn();
    let push = freshPush();
    assert.deepEqual(await push.registerThisDevice(U), { ok: true, token: 'ExponentPushToken[device-1]' });
    push = freshPush(); // app restarted (e.g. launched offline): nothing in memory
    state.rpcCalls = [];
    await push.unregisterThisDevice();
    assert.deepEqual(state.rpcCalls.map((call) => [call.name, call.args?.p_token]), [['unregister_push_token', 'ExponentPushToken[device-1]']]);
    assert.equal(state.asyncStorage.has(`referralfit-push-registration-v1:${U}`), false);
  });

  await check('an unregister that cannot reach the server is retried at the next sign-in', async () => {
    resetDb();
    state.asyncStorage.clear();
    signIn();
    let push = freshPush();
    await push.registerThisDevice(U);
    goOfflineExpired();
    push = freshPush();
    state.rpcCalls = [];
    await push.unregisterThisDevice(U);
    assert.equal(state.rpcCalls.length, 0, 'no server call under an offline session');
    assert.match(state.asyncStorage.get(`referralfit-push-registration-v1:${U}`), /"pendingUnregister":true/);
    signIn();
    state.offline = false;
    push = freshPush();
    state.db.notification_preferences.push({ user_id: U, push_enabled: false, new_lead: true, assigned_to_me: true, overdue_mine: true, directory_decision: true, directory_submission: false, bed_opened: false });
    await push.refreshPushRegistration(U);
    assert.ok(state.rpcCalls.some((call) => call.name === 'unregister_push_token' && call.args.p_token === 'ExponentPushToken[device-1]'));
    assert.equal(state.asyncStorage.has(`referralfit-push-registration-v1:${U}`), false);
  });
  await check('another account’s pending unregister is finished at any sign-in on the device', async () => {
    resetDb();
    state.asyncStorage.clear();
    signIn();
    let push = freshPush();
    await push.registerThisDevice(U);
    goOfflineExpired();
    push = freshPush();
    await push.unregisterThisDevice(U); // signed out offline: pending
    // A different account signs in on the same device, push off for them.
    const B = '99999999-9999-4999-8999-999999999990';
    state.storage.set(STORAGE_KEY, JSON.stringify(makeSession(B, 'sess-b', nowS() + 3600)));
    state.auth = 'online';
    state.offline = false;
    auth.resetAuthNetworkStateForTests();
    state.db.notification_preferences.push({ user_id: B, push_enabled: false, new_lead: true, assigned_to_me: true, overdue_mine: true, directory_decision: true, directory_submission: false, bed_opened: false });
    state.rpcCalls = [];
    push = freshPush();
    await push.refreshPushRegistration(B);
    assert.deepEqual(state.rpcCalls.map((call) => [call.name, call.args.p_token]), [
      ['register_push_token', 'ExponentPushToken[device-1]'],
      ['unregister_push_token', 'ExponentPushToken[device-1]'],
    ], 'claimed from the old account, then released');
    assert.equal(state.asyncStorage.has(`referralfit-push-registration-v1:${U}`), false);
    signIn();
  });
}

Module._resolveFilename = originalResolve;
console.log(`offline sync behavior (${passed} checks): ok`);
