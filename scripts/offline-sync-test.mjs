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
  async setItem(k, v) { if (s.asyncWriteLog) s.asyncWriteLog.push(k); s.asyncStorage.set(k, String(v)); },
  async removeItem(k) { s.asyncStorage.delete(k); },
  async multiRemove(keys) { keys.forEach((k) => s.asyncStorage.delete(k)); },
  async multiSet(pairs) { pairs.forEach(([k, v]) => { if (s.asyncWriteLog) s.asyncWriteLog.push(k); s.asyncStorage.set(k, String(v)); }); },
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
    // selectOverride: answer a read with synthetic rows (e.g. an endless list).
    const override = b.op === 'select' && s.selectOverride ? s.selectOverride(b) : null;
    if (override) return override;
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
    async signOut() { s.signedOut = true; return { error: s.signOutError || null }; },
    async _removeSession() {
      if (s.noRemoveSession) throw new Error('gone');
      s.storage.delete('${STORAGE_KEY}');
      s.authEvents = s.authEvents || [];
      s.authEvents.push('SIGNED_OUT');
      for (const listener of s.authListeners || []) listener('SIGNED_OUT', null);
    },
    onAuthStateChange(callback) { (s.authListeners = s.authListeners || []).push(callback); return { data: { subscription: { unsubscribe() {} } } }; },
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
exports.fetchCaseList = async () => { const s = globalThis.__offlineSyncState; if (s.caseReadFailure) throw s.caseReadFailure; if (s.offline) throw { message: 'TypeError: Network request failed', code: '' }; return s.caseList || { cases: [], contacts: [] }; };
exports.fetchCaseFile = async () => { const s = globalThis.__offlineSyncState; if (s.caseReadFailure) throw s.caseReadFailure; return { events: [], documents: [] }; };
`);

for (const [rel, out] of [
  ['src/lib/store.ts', 'store.js'],
  ['src/lib/auth-session.ts', 'auth-session.js'],
  ['src/lib/errors.ts', 'errors.js'],
  ['src/lib/paging.ts', 'paging.js'],
  ['src/lib/case-cache.ts', 'case-cache.js'],
  ['src/lib/org.ts', 'org.js'],
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
const org = require(path.join(tmpDir, 'org.js'));

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
  // Saving the device's own copy asks the server nothing (round 11): the
  // binding is the fence, and a workspace change is adopted only by
  // bindLocalWorkspace, which wipes the copy under the same lock.
  state.offline = false;
  state.org = '33333333-3333-4333-8333-333333333399';
  state.rpcCalls = [];
  await store.persistCache(relaunch.snapshot, U);
  assert.deepEqual(state.rpcCalls, [], 'no server round trip inside the cache lock');
  assert.equal(await store.bindLocalWorkspace(U, state.org), true);
  assert.equal(state.asyncStorage.has(`referralfit-cache-v2:${U}`), false, 'the new workspace never reads the old copy');
  state.org = ORG;
});

await check('a server outage (5xx) queues the change AND saves its copy, so a relaunch shows it', async () => {
  await freshAccount();
  await store.hydrate(U);
  const T = '77777777-7777-4777-8777-77777777777a';
  const P = '77777777-7777-4777-8777-77777777777b';
  state.db.partners.push({ id: P, name: 'Hope House', organization: 'Org', types: ['Inpatient'], created_at: new Date().toISOString(), org_id: ORG });
  // The gateway answers every request with an HTML 503 page.
  state.failOn = () => ({ message: '<html><body>503 Service Unavailable</body></html>', code: '' });
  const touch = { id: T, partnerId: P, kind: 'call', note: 'Logged during the outage', occurredAt: new Date().toISOString() };
  await store.createTouch(touch, U);
  assert.equal(await store.pendingWriteCount(U), 1, 'the touch is queued');
  // Before: the cache fence treated the 503 as a refusal and the save failed.
  await store.persistCache({ partners: [], referrals: [], referralMatches: [], touches: [touch], followUps: [], scorecards: {} }, U);
  const relaunch = await store.hydrate(U);
  assert.equal(relaunch.source, 'cache');
  assert.deepEqual(relaunch.snapshot.touches.map((row) => row.id), [T], 'the queued touch is on screen after a relaunch, not missing (and redone)');
  // Saving the copy needs no answer from the server at all.
  let asked = 0;
  state.failOn = (b) => { if (b.op === 'rpc') asked += 1; return null; };
  await store.persistCache(relaunch.snapshot, U);
  assert.equal(asked, 0, 'persistCache makes no current_org_id round trips');
  state.failOn = null;
  await store.hydrate(U);
  assert.equal(state.db.touches.filter((row) => row.id === T).length, 1, 'the touch lands once when the server recovers');
});

await check('scorecards carry how many referrals the family-experience average covers', async () => {
  await freshAccount();
  const P = '77777777-7777-4777-8777-77777777777d';
  const Q = '77777777-7777-4777-8777-77777777777e';
  const referral = (id, partnerId, direction, familyExperience) => ({ id, partner_id: partnerId, direction, referred_on: '2026-10-01', client_label: '', outcome: 'Placed', note: '', admitted: true, admitted_on: null, family_experience: familyExperience, outcome_note: '', packet_sent_at: null, match_profile_id: null, case_id: null, org_id: ORG });
  state.db.referrals.push(
    referral('88888888-8888-4888-8888-000000000001', P, 'outbound', 5),
    referral('88888888-8888-4888-8888-000000000002', P, 'outbound', null),
    referral('88888888-8888-4888-8888-000000000003', P, 'outbound', null),
    referral('88888888-8888-4888-8888-000000000004', P, 'inbound', 2), // a referral they sent us is never counted
  );
  state.db.partner_scorecard.push(
    { partner_id: P, referrals_sent: 3, admits: 3, non_admits: 0, avg_family_experience: 5, last_referral_on: '2026-10-01' },
    { partner_id: Q, referrals_sent: 0, admits: 0, non_admits: 0, avg_family_experience: null, last_referral_on: null },
  );
  const { snapshot } = await store.hydrate(U);
  assert.equal(snapshot.scorecards[P].ratedCases, 1, 'one rated outbound referral, not three decided ones');
  assert.equal(snapshot.scorecards[Q].ratedCases, 0);
});

await check('a server outage reads as offline at launch, so the saved copy opens; a refusal does not', async () => {
  await freshAccount();
  assert.equal(await org.fetchCurrentOrgId(), ORG);
  for (const failure of [
    { message: '<html><body>503 Service Unavailable</body></html>', code: '' },
    { message: 'upstream connect error or disconnect/reset before headers', code: '' },
    { message: 'Could not connect to the database', code: 'PGRST000' },
  ]) {
    state.failOn = (b) => (b.op === 'rpc' && b.table === 'current_org_id' ? failure : null);
    const error = await org.fetchCurrentOrgId().catch((caught) => caught);
    assert.ok(store.isNetworkError(error), `${failure.message} falls back like no signal (the launch reads the bound workspace)`);
  }
  state.failOn = null;
  state.offline = true;
  assert.ok(store.isNetworkError(await org.fetchCurrentOrgId().catch((caught) => caught)));
  state.offline = false;
  state.failOn = (b) => (b.op === 'rpc' && b.table === 'current_org_id' ? { message: 'permission denied for function current_org_id', code: '42501' } : null);
  const refused = await org.fetchCurrentOrgId().catch((caught) => caught);
  assert.ok(refused instanceof errors.StoreError && !store.isNetworkError(refused), 'a real refusal still surfaces');
  assert.match(refused.message, /permission denied/);
  state.failOn = null;
});

await check('after account deletion nothing of the account stays on the device, even a copy saved mid-deletion', async () => {
  await freshAccount();
  await store.hydrate(U);
  const P = '77777777-7777-4777-8777-77777777777c';
  await store.prepareForWorkspaceChange(U);
  // A refresh or save that finished while the deletion ran writes copies back.
  await store.persistCache({ partners: [partner(P, 'Client-adjacent program')], referrals: [], referralMatches: [], touches: [], followUps: [], scorecards: {} }, U);
  await store.persistCaseList({ cases: [], contacts: [] }, U);
  assert.ok([...state.asyncStorage.keys()].some((key) => key.startsWith('referralfit-cache-v2:')));
  await store.forgetWorkspaceBinding(U);
  assert.deepEqual([...state.asyncStorage.keys()].filter((key) => key.toLowerCase().includes(U)), [], 'cache, case copies, queue, rejected list and binding are all gone');
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

await check('a "transient" failure is set aside after 25 tries over 2 hours, or 5 tries over 72 hours', async () => {
  await freshAccount();
  state.offline = true;
  await store.createPartner(partner('13131313-1313-4131-8131-131313131313', 'Stuck'), U);
  state.offline = false;
  state.failOn = (b) => (b.op === 'upsert') ? { message: 'internal error', code: 'XX000' } : null;
  assert.equal(await store.flushWriteQueue(U), 0);
  const envelope = JSON.parse(state.asyncStorage.get(queueKey));
  const [key] = Object.keys(envelope.transientWaits);
  envelope.transientWaits[key] = { first: new Date(Date.now() - 3 * 3600000).toISOString(), attempts: store.MAX_TRANSIENT_ATTEMPTS - 1 };
  state.asyncStorage.set(queueKey, JSON.stringify(envelope));
  await assert.rejects(store.flushWriteQueue(U), errors.RejectedWritesError);
  const [entry] = await store.listRejectedWrites(U);
  assert.match(entry.reason, /kept failing/);

  // A rarely opened app: 5 tries spanning 3 days is enough.
  await freshAccount();
  state.offline = true;
  await store.createPartner(partner('13131313-1313-4131-8131-131313131314', 'Rarely opened'), U);
  state.offline = false;
  state.failOn = (b) => (b.op === 'upsert') ? { message: 'Service Unavailable', httpStatus: 503 } : null;
  assert.equal(await store.flushWriteQueue(U), 0);
  const rare = JSON.parse(state.asyncStorage.get(queueKey));
  const [rareKey] = Object.keys(rare.transientWaits);
  rare.transientWaits[rareKey] = { first: new Date(Date.now() - 73 * 3600000).toISOString(), attempts: store.LONG_TRANSIENT_ATTEMPTS - 1 };
  state.asyncStorage.set(queueKey, JSON.stringify(rare));
  await assert.rejects(store.flushWriteQueue(U), errors.RejectedWritesError);
  // A few failures within minutes never set anything aside.
  await freshAccount();
  state.offline = true;
  await store.createPartner(partner('13131313-1313-4131-8131-131313131315', 'Blip'), U);
  state.offline = false;
  state.failOn = (b) => (b.op === 'upsert') ? { message: 'Service Unavailable', httpStatus: 503 } : null;
  for (let i = 0; i < 30; i += 1) assert.equal(await store.flushWriteQueue(U), 0);
  assert.equal(await store.rejectedWriteCount(U), 0, '30 quick failures are still a blip');
  state.failOn = null;
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

// ─── Round 3: retried inserts land before later edits ───────────────────────

await check('an offline edit of a refused insert joins it; retry lands the insert, then the edit', async () => {
  await freshAccount();
  await store.hydrate(U);
  const X = 'abababab-abab-4bab-8bab-abababababab';
  goOfflineExpired();
  await store.createPartner(partner(X, 'Hope House'), U);
  await store.persistCache(snapOf({ partners: [partner(X, 'Hope House')] }), U);
  signIn();
  state.offline = false;
  let refuse = true;
  state.failOn = (b) => (refuse && b.table === 'partners' && b.op === 'upsert') ? { message: 'violates check constraint', code: '23514' } : null;
  await assert.rejects(store.flushWriteQueue(U), errors.RejectedWritesError);
  goOfflineExpired();
  await store.updatePartner(partner(X, 'Hope House', { note: 'call Tues' }), U);
  assert.equal(await store.pendingWriteCount(U), 0, 'the offline edit joins the refused insert, not the live queue');
  const [entry] = await store.listRejectedWrites(U);
  assert.equal(entry.heldChanges, 1);
  refuse = false;
  await store.retryRejectedWrite(U, entry.id); // offline: requeued in order
  signIn();
  state.offline = false;
  state.failOn = null;
  assert.equal(await store.flushWriteQueue(U), 2);
  assert.equal(state.db.partners.find((row) => row.id === X)?.note, 'call Tues');
});

await check('an edit left in the queue by an interrupted flush cannot hold its retried insert behind it', async () => {
  await freshAccount();
  await store.hydrate(U);
  const F = 'fafafafa-fafa-4afa-8afa-fafafafafafa';
  state.offline = true;
  await store.createFollowUp(followUp(F, { title: 'Call the family' }), U);
  await store.persistCache(snapOf({ followUps: [followUp(F, { title: 'Call the family' })] }), U);
  await store.createPartner(partner('dadadada-dada-4ada-8ada-dadadadadada', 'Unrelated program'), U);
  await store.updateFollowUp(followUp(F, { title: 'Call the family', note: 'ask about insurance' }), U);
  state.offline = false;
  let refuse = true;
  let partnerTries = 0;
  state.failOn = (b) => {
    if (refuse && b.table === 'follow_ups' && b.op === 'upsert') return { message: 'The assignee must be a member of this workspace', code: '22023' };
    // The connection drops on the next op (the workspace is no longer
    // re-verified before every op, so the drop is simulated on the op itself).
    if (b.table === 'partners' && b.op === 'upsert' && ++partnerTries === 1) return { message: 'TypeError: Network request failed', code: '' };
    return null;
  };
  await assert.rejects(store.flushWriteQueue(U), errors.RejectedWritesError);
  assert.deepEqual(JSON.parse(state.asyncStorage.get(queueKey)).ops.map((op) => op.kind), ['partner.insert', 'follow_up.update']);
  refuse = false;
  const [entry] = await store.listRejectedWrites(U);
  await store.retryRejectedWrite(U, entry.id);
  assert.equal(state.db.follow_ups.find((row) => row.id === F)?.note, 'ask about insurance');
  assert.equal(await store.pendingWriteCount(U), 0);
  assert.equal(await store.rejectedWriteCount(U), 0);
  // And with the edit ahead of its insert in the queue, the insert still runs first.
  await freshAccount();
  const G = 'fbfbfbfb-fbfb-4bfb-8bfb-fbfbfbfbfbfb';
  state.offline = true;
  await store.updateFollowUp(followUp(G, { note: 'edit first' }), U);
  await store.createFollowUp(followUp(G), U);
  state.offline = false;
  assert.equal(await store.flushWriteQueue(U), 2);
  assert.equal(state.db.follow_ups.find((row) => row.id === G)?.note, 'edit first');
});

// ─── Round 3: a failed join leaves the device bound ─────────────────────────

await check('a join that fails after the pre-join sync leaves the device saving normally', async () => {
  await freshAccount();
  const P = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
  state.db.partners.push({ id: P, name: 'Hope House', organization: '', types: ['Inpatient'], org_id: ORG, created_at: new Date().toISOString() });
  const { snapshot } = await store.hydrate(U);
  await store.prepareForWorkspaceChange(U);
  // acceptWorkspaceInvite fails here (bad code); nothing re-binds.
  await store.updatePartner({ ...snapshot.partners[0], note: 'a' }, U);
  assert.equal(state.db.partners.find((row) => row.id === P).note, 'a', 'online saves still work');
  await store.persistCache(snapshot, U);
  state.offline = true;
  await store.updatePartner({ ...snapshot.partners[0], note: 'offline note' }, U);
  assert.equal(await store.pendingWriteCount(U), 1);
  state.offline = false;
  assert.equal(await store.bindLocalWorkspace(U, ORG), false, 'same workspace: nothing wiped');
  await store.hydrate(U);
  assert.equal(state.db.partners.find((row) => row.id === P).note, 'offline note');

  // A binding that is merely missing never wipes queued edits.
  state.offline = true;
  await store.updatePartner({ ...snapshot.partners[0], note: 'queued while unbound' }, U);
  state.offline = false;
  state.asyncStorage.delete(`referralfit-workspace-v1:${U}`);
  assert.equal(await store.bindLocalWorkspace(U, ORG), true);
  assert.equal(await store.pendingWriteCount(U), 1, 'the queued edit survives');
  await store.flushWriteQueue(U);
  assert.equal(state.db.partners.find((row) => row.id === P).note, 'queued while unbound');
  // A positively different workspace still wipes everything.
  state.offline = true;
  await store.updatePartner({ ...snapshot.partners[0], note: 'old workspace' }, U);
  state.offline = false;
  assert.equal(await store.bindLocalWorkspace(U, '33333333-3333-4333-8333-333333333397'), true);
  assert.equal(await store.pendingWriteCount(U), 0);
});

// ─── Round 3: queued edits are not reverted by a refresh ────────────────────

await check('a completion held by a passing server failure stays done through a refresh', async () => {
  await freshAccount();
  const F = 'efefefef-efef-4fef-8fef-efefefefefef';
  state.db.follow_ups.push({ id: F, title: 'Call mom', due_on: '2026-10-23', status: 'open', org_id: ORG, created_at: new Date().toISOString(), kind: 'follow_up' });
  let snap = (await store.hydrate(U)).snapshot;
  state.failOn = (b) => (b.op === 'rpc' && b.table === 'complete_follow_up_with_next') ? { message: 'canceling statement due to statement timeout', code: '57014' } : null;
  const N1 = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
  const done = followUp(F, { title: 'Call mom', status: 'done', completedAt: new Date().toISOString() });
  await store.completeFollowUpWithNext(done, followUp(N1, { title: 'Call mom again', dueOn: '2026-10-26' }), null, U);
  await store.persistCache({ ...snap, followUps: [done, followUp(N1, { title: 'Call mom again', dueOn: '2026-10-26' })] }, U);
  assert.equal(await store.pendingWriteCount(U), 1);
  assert.equal(await store.flushWriteQueue(U), 0);
  snap = await store.refreshSnapshot(U);
  assert.equal(snap.followUps.find((row) => row.id === F)?.status, 'done', 'the queued completion is still shown');
  assert.ok(snap.followUps.some((row) => row.id === N1));
  state.failOn = null;
  await store.flushWriteQueue(U);
  assert.deepEqual(state.rpcCalls.filter((call) => call.name === 'complete_follow_up_with_next').map((call) => call.args.p_next.id), [N1], 'sent once');

  // A pending match deletion keeps the match hidden; a pending edit shows the device's copy.
  await freshAccount();
  const M = '3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c';
  const P = '3d3d3d3d-3d3d-4d3d-8d3d-3d3d3d3d3d3d';
  state.db.match_profiles.push(matchRow(M));
  state.db.partners.push({ id: P, name: 'Shared', organization: '', types: ['Inpatient'], note: 'server', org_id: ORG, created_at: new Date().toISOString() });
  snap = (await store.hydrate(U)).snapshot;
  state.offline = true;
  await store.deleteMatchProfile(M, U);
  const edited = { ...snap.partners[0], note: 'device' };
  await store.updatePartner(edited, U);
  await store.persistCache({ ...snap, referralMatches: [], partners: [edited] }, U);
  state.offline = false;
  state.failOn = (b) => (b.op !== 'select' && b.op !== 'rpc') ? { message: 'Service Unavailable', httpStatus: 503 } : null;
  snap = await store.refreshSnapshot(U);
  assert.equal(snap.referralMatches.length, 0, 'deleted on this device: stays hidden');
  assert.equal(snap.partners[0].note, 'device');
  state.failOn = null;
});

// ─── Round 4: held edits keep every change, in order ───────────────────────

await check('repeated equal edits (on → off → on) held behind a refusal all survive, and retry ends at the last', async () => {
  await freshAccount();
  await store.hydrate(U);
  const X = 'abababab-abab-4bab-8bab-abababababa1';
  const base = partner(X, 'Hope House', { favorite: false });
  await store.createPartner(base, U);
  await store.persistCache(snapOf({ partners: [base] }), U);
  state.offline = true;
  for (const favorite of [true, false, true]) {
    const next = partner(X, 'Hope House', { favorite });
    await store.updatePartner(next, U);
    state.offline = false;
    await store.persistCache(snapOf({ partners: [next] }), U);
    state.offline = true;
  }
  const queued = JSON.parse(state.asyncStorage.get(queueKey)).ops;
  assert.equal(new Set(queued.map((op) => op.opId)).size, 3, 'every queued op has its own opId');
  state.offline = false;
  let refuse = true;
  state.failOn = (b) => (refuse && b.table === 'partners' && b.op === 'update') ? { message: 'violates check constraint', code: '23514' } : null;
  await assert.rejects(store.flushWriteQueue(U), errors.RejectedWritesError);
  const entry = JSON.parse(state.asyncStorage.get(rejectedKey)).entries[0];
  assert.deepEqual(entry.ops.map((op) => op.patch.favorite), [true, false, true]);
  // A crash between the two durable writes leaves an op in both places: it is
  // recognised by its opId and never listed twice.
  const envelope = JSON.parse(state.asyncStorage.get(queueKey) || '{"version":2,"userId":"","ops":[]}');
  state.asyncStorage.set(queueKey, JSON.stringify({ version: 2, userId: U, ops: [...(envelope.ops || []), entry.ops[2]] }));
  await store.flushWriteQueue(U).catch(() => undefined);
  assert.equal(JSON.parse(state.asyncStorage.get(rejectedKey)).entries[0].ops.length, 3);
  refuse = false;
  const [item] = await store.listRejectedWrites(U);
  await store.retryRejectedWrite(U, item.id);
  assert.equal(state.db.partners.find((row) => row.id === X).favorite, true, 'the user’s last edit wins');
});

for (const mode of ['offline', 'online']) {
  await check(`a new edit (${mode}) never jumps ahead of an older queued edit of the same refused row`, async () => {
    await freshAccount();
    await store.hydrate(U);
    const X = 'abababab-abab-4bab-8bab-abababababa2';
    const F = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdc2';
    const base = partner(X, 'Hope House', { note: 'v0' });
    await store.createPartner(base, U);
    await store.persistCache(snapOf({ partners: [base] }), U);
    state.offline = true;
    let next = partner(X, 'Hope House', { note: 'v1' });
    await store.updatePartner(next, U);
    state.offline = false; await store.persistCache(snapOf({ partners: [next] }), U); state.offline = true;
    await store.createFollowUp(followUp(F), U);
    next = partner(X, 'Hope House', { note: 'v2' });
    await store.updatePartner(next, U);
    state.offline = false; await store.persistCache(snapOf({ partners: [next] }), U);
    let refuse = true;
    let blip = true;
    state.failOn = (b) => {
      if (refuse && b.table === 'partners' && b.op === 'update') return { message: 'violates check constraint', code: '23514' };
      if (blip && b.table === 'follow_ups' && b.op === 'upsert') return { message: 'Service Unavailable', httpStatus: 503 };
      return null;
    };
    await assert.rejects(store.flushWriteQueue(U), errors.RejectedWritesError); // stops at the 503, before v2
    if (mode === 'offline') goOfflineExpired();
    await store.updatePartner(partner(X, 'Hope House', { note: 'v3' }), U);
    assert.deepEqual(JSON.parse(state.asyncStorage.get(rejectedKey)).entries[0].ops.map((op) => op.patch.note), ['v1'], 'v3 waits behind v2, not ahead of it');
    if (mode === 'offline') { signIn(); state.offline = false; }
    blip = false;
    await store.flushWriteQueue(U).catch(() => undefined);
    assert.deepEqual(JSON.parse(state.asyncStorage.get(rejectedKey)).entries[0].ops.map((op) => op.patch.note), ['v1', 'v2', 'v3']);
    refuse = false;
    const [item] = await store.listRejectedWrites(U);
    await store.retryRejectedWrite(U, item.id);
    assert.equal(state.db.partners.find((row) => row.id === X).note, 'v3');
  });
}

await check('an assignment (which upserts its match) waits behind an earlier refused edit of that match', async () => {
  await freshAccount();
  const M = '4e4e4e4e-4e4e-4e4e-8e4e-4e4e4e4e4e4e';
  const P = '4f4f4f4f-4f4f-4f4f-8f4f-4f4f4f4f4f4f';
  const R = '4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d';
  state.db.match_profiles.push(matchRow(M));
  state.db.partners.push({ id: P, name: 'Program', organization: '', types: ['Inpatient'], created_at: new Date().toISOString(), org_id: ORG });
  const { snapshot } = await store.hydrate(U);
  const match = snapshot.referralMatches[0];
  state.offline = true;
  await store.updateMatchProfile({ ...match, clientLabel: 'Renamed' }, U);
  state.offline = false;
  state.failOn = (b) => (b.table === 'match_profiles' && b.op === 'update') ? { message: 'violates check constraint', code: '23514' } : null;
  await assert.rejects(store.flushWriteQueue(U), errors.RejectedWritesError);
  state.rpcCalls = [];
  await store.assignMatchReferral(
    { id: R, partnerId: P, direction: 'Outbound', date: '2026-10-23', clientLabel: 'Family', outcome: 'Pending', note: '' },
    { ...match, clientLabel: 'Renamed', status: 'Referred', assignedPartnerId: P, referralId: R },
    U,
  );
  assert.equal(state.rpcCalls.some((call) => call.name === 'assign_match_referral'), false, 'held: FIFO per row');
  const [item] = await store.listRejectedWrites(U);
  assert.equal(item.heldChanges, 1);
  state.failOn = null;
  state.log = [];
  await store.retryRejectedWrite(U, item.id);
  assert.deepEqual(state.log.filter((line) => /match_profiles|assign_match/.test(line)), ['update match_profiles', 'rpc assign_match_referral'], 'the edit, then the assignment');
  const row = state.db.match_profiles.find((item2) => item2.id === M);
  assert.equal(row.client_label, 'Renamed');
  assert.equal(row.assigned_partner_id, P, 'the edit, then the assignment');
});

// ─── Round 5: queues left by 1.0.4 (1), and changes that span two rows ──────

await check('a 1.0.4 (1) queue (ops with no opId) flushes, and its repeated equal edits all survive a refusal', async () => {
  await freshAccount();
  const X = 'a5a5a5a5-a5a5-4a5a-8a5a-a5a5a5a5a5a5';
  state.db.partners.push({ id: X, name: 'Hope House', organization: 'Org', favorite: false, org_id: ORG, created_at: new Date().toISOString() });
  // 1.0.4 (1) queued full-row patches and no opId: favorite on, off, on gives
  // a first and third op that are byte-identical.
  const legacy = (favorite) => ({ kind: 'partner.update', id: X, patch: { name: 'Hope House', organization: 'Org', note: '', favorite } });
  const legacyQueue = JSON.stringify({ version: 2, userId: U, ops: [legacy(true), legacy(false), legacy(true)] });
  state.asyncStorage.set(queueKey, legacyQueue);
  assert.equal(await store.flushWriteQueue(U), 3, 'an upgraded tester’s queue still flushes');
  assert.equal(state.db.partners.find((row) => row.id === X).favorite, true);

  state.asyncStorage.set(queueKey, legacyQueue);
  let refuse = true;
  state.failOn = (b) => (refuse && b.table === 'partners' && b.op === 'update') ? { message: 'violates check constraint', code: '23514' } : null;
  await assert.rejects(store.flushWriteQueue(U), errors.RejectedWritesError);
  const entry = JSON.parse(state.asyncStorage.get(rejectedKey)).entries[0];
  assert.deepEqual(entry.ops.map((op) => op.patch.favorite), [true, false, true], 'the third edit is not mistaken for the first');
  assert.equal(new Set(entry.ops.map((op) => op.opId)).size, 3, 'each old op gets its own opId before it can be set aside');
  // A crash between the two durable writes is still recognised (by opId).
  const envelope = JSON.parse(state.asyncStorage.get(queueKey) || '{"ops":[]}');
  state.asyncStorage.set(queueKey, JSON.stringify({ version: 2, userId: U, ops: [...(envelope.ops || []), entry.ops[2]] }));
  await store.flushWriteQueue(U).catch(() => undefined);
  assert.equal(JSON.parse(state.asyncStorage.get(rejectedKey)).entries[0].ops.length, 3);
  refuse = false;
  const [item] = await store.listRejectedWrites(U);
  await store.retryRejectedWrite(U, item.id);
  assert.equal(state.db.partners.find((row) => row.id === X).favorite, true, 'the user’s last edit wins');
});

for (const mode of ['offline', 'online']) {
  await check(`a new change (${mode}) held by a refusal through one row queues behind an older edit of its other row`, async () => {
    await freshAccount();
    const P = '5a5a5a5a-5a5a-45a5-85a5-5a5a5a5a5a5a';
    const R = '5b5b5b5b-5b5b-45b5-85b5-5b5b5b5b5b5b';
    const M = '5c5c5c5c-5c5c-45c5-85c5-5c5c5c5c5c5c';
    const T = '5d5d5d5d-5d5d-45d5-85d5-5d5d5d5d5d5d';
    const F = '5e5e5e5e-5e5e-45e5-85e5-5e5e5e5e5e5e';
    state.db.partners.push({ id: P, name: 'Program', organization: '', types: ['Inpatient'], created_at: new Date().toISOString(), org_id: ORG });
    state.db.referrals.push({ id: R, partner_id: P, direction: 'outbound', referred_on: '2026-10-20', client_label: 'Family', outcome: 'Pending', note: '', packet_sent_at: null, match_profile_id: null, created_at: new Date().toISOString(), org_id: ORG });
    state.db.match_profiles.push(matchRow(M, { assigned_partner_id: P, referral_id: R }));
    const { snapshot } = await store.hydrate(U);
    const match = snapshot.referralMatches.find((item) => item.id === M);
    const referral = snapshot.referrals.find((item) => item.id === R);
    state.offline = true;
    await store.updateMatchProfile({ ...match, clientLabel: 'Renamed' }, U);
    state.offline = false;
    let refuseMatch = true;
    let blip = false;
    state.rpcResults = {
      finalize_match_packet: (args) => {
        Object.assign(state.db.referrals.find((row) => row.id === args.p_referral.id), args.p_referral);
        return { data: null, error: null };
      },
    };
    state.failOn = (b) => {
      if (refuseMatch && b.table === 'match_profiles' && b.op === 'update') return { message: 'violates check constraint', code: '23514' };
      if (blip && b.table === 'referrals' && b.op === 'update') return { message: 'Service Unavailable', httpStatus: 503 };
      return null;
    };
    try {
      await assert.rejects(store.flushWriteQueue(U), errors.RejectedWritesError); // the match edit is set aside
      state.offline = true;
      await store.updateReferralPacketStamp(R, '2026-10-21T10:00:00.000Z', M, U); // an older stamp, queued
      if (mode === 'offline') goOfflineExpired(); else { state.offline = false; blip = true; }
      const sentAt = '2026-10-22T10:00:00.000Z';
      await store.finalizeMatchPacket(
        { ...referral, packetSentAt: sentAt, matchProfileId: M },
        { ...match, clientLabel: 'Renamed', status: 'Referred' },
        { id: T, partnerId: P, kind: 'email', note: 'Packet sent', occurredAt: sentAt },
        followUp(F, { referralId: R }),
        null,
        U,
      );
      const listed = () => JSON.parse(state.asyncStorage.get(rejectedKey)).entries[0].ops.map((op) => op.kind);
      assert.deepEqual(listed(), ['match.update'], 'the packet waits behind the older stamp of its referral, not inside the refused group ahead of it');
      if (mode === 'offline') signIn();
      state.offline = false;
      blip = false;
      await store.flushWriteQueue(U).catch(() => undefined);
      assert.deepEqual(listed(), ['match.update', 'packet.finalize']);
      refuseMatch = false;
      const [item] = await store.listRejectedWrites(U);
      await store.retryRejectedWrite(U, item.id);
      assert.equal(state.db.referrals.find((row) => row.id === R).packet_sent_at, sentAt, 'the newer packet is not overwritten by the older stamp');
    } finally {
      state.rpcResults = null;
    }
  });
}

await check('a flush cut off after an upsert waits keeps it ahead of a later edit of the row it creates', async () => {
  await freshAccount();
  await store.hydrate(U);
  const P = '6a6a6a6a-6a6a-46a6-86a6-6a6a6a6a6a6a';
  const R = '6b6b6b6b-6b6b-46b6-86b6-6b6b6b6b6b6b';
  const M = '6c6c6c6c-6c6c-46c6-86c6-6c6c6c6c6c6c';
  const T = '6d6d6d6d-6d6d-46d6-86d6-6d6d6d6d6d6d';
  const F = '6e6e6e6e-6e6e-46e6-86e6-6e6e6e6e6e6e';
  const match = { id: M, clientLabel: 'Family', levelOfCare: 'Inpatient', state: 'OR', insurance: 'Cash pay', networkPreferences: [], therapies: [], status: 'Referred', assignedPartnerId: P, referralId: R };
  state.offline = true;
  // The packet (which upserts referral, match, touch and follow-up) is queued
  // ahead of its program's insert, so its first try finds the program missing.
  await store.finalizeMatchPacket(
    { id: R, partnerId: P, direction: 'Outbound', date: '2026-10-23', clientLabel: 'Family', outcome: 'Pending', note: '' },
    match, { id: T, partnerId: P, kind: 'email', note: '', occurredAt: new Date().toISOString() }, followUp(F, { referralId: R }), null, U,
  );
  await store.createPartner(partner('6f6f6f6f-6f6f-46f6-86f6-6f6f6f6f6f6f', 'Unrelated'), U);
  await store.updateMatchProfile({ ...match, clientLabel: 'Renamed' }, U);
  await store.createPartner(partner(P, 'Program, later in the queue'), U);
  state.offline = false;
  let orgCalls = 0;
  state.rpcResults = {
    finalize_match_packet: (args) => {
      if (!state.db.partners.some((row) => row.id === P)) return { data: null, error: { message: 'violates foreign key constraint', code: '23503' } };
      state.db.referrals.push({ org_id: ORG, ...args.p_referral });
      state.db.match_profiles.push({ org_id: ORG, ...args.p_match });
      return { data: null, error: null };
    },
  };
  // The connection drops right after the packet's first try.
  state.failOn = (b) => (b.op === 'rpc' && b.table === 'current_org_id' && ++orgCalls === 2) ? { message: 'TypeError: Network request failed', code: '' } : null;
  try {
    assert.equal(await store.flushWriteQueue(U), 0);
    assert.deepEqual(JSON.parse(state.asyncStorage.get(queueKey)).ops.map((op) => op.kind), ['packet.finalize', 'partner.insert', 'match.update', 'partner.insert'], 'the waiting packet keeps its place');
    assert.equal(await store.flushWriteQueue(U), 4, 'the program, then the packet, then the edit of its match');
    assert.equal(state.db.match_profiles.find((row) => row.id === M).client_label, 'Renamed');
    assert.deepEqual(await store.syncStatus(U), { pending: 0, waiting: 0, rejected: 0 });
  } finally {
    state.rpcResults = null;
  }
});

// ─── Round 11: request deadlines, one read classifier, crash-safe copies ────

const cacheKey = `referralfit-cache-v2:${U}`;
const unreadableKey = `referralfit-unreadable-writes-v1:${U}`;
const uuid = () => globalThis.crypto.randomUUID();
const TIMEOUT = () => ({ message: 'AbortError: Network request timed out', details: 'AbortError: Network request timed out\n    at fetch (http://localhost:8081/index.bundle:10:20)', hint: 'Request was aborted (timeout or manual cancellation)', code: '' });
const GATEWAY_502 = () => ({ message: '<html><head><title>502 Bad Gateway</title></head><body><center>cloudflare</center></body></html>', code: '' });
// The pre-round-11 retry-bookkeeping key (FNV of the op's JSON), as builds up to now saved it.
function legacyWaitKey(text) {
  const hex = [];
  for (let pass = 0; pass < 4; pass += 1) {
    let h = 0x811c9dc5 ^ (pass * 0x01000193);
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    hex.push(h.toString(16).padStart(8, '0'));
  }
  const raw = hex.join('');
  const variant = ((parseInt(raw[16], 16) & 0x3) | 0x8).toString(16) + raw.slice(17, 20);
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-${variant}-${raw.slice(20, 32)}`;
}

// supabase.ts: the real module, with its React Native / Expo / supabase-js imports stubbed.
{
  const supaDir = path.join(tmpDir, 'supabase-real');
  transpile('src/lib/supabase.ts', 'supabase.js', supaDir);
  writeFileSync(path.join(supaDir, 'stub-secure-store.js'), 'module.exports = { getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} };');
  writeFileSync(path.join(supaDir, 'stub-react-native.js'), "module.exports = { Platform: { OS: 'ios' } };");
  writeFileSync(path.join(supaDir, 'stub-supabase-js.js'), 'exports.createClient = (url, key, options) => { globalThis.__offlineSyncState.createdClient = { url, key, options }; return { auth: {} }; };');
  const supaStubs = { 'expo-secure-store': 'stub-secure-store.js', 'react-native': 'stub-react-native.js', '@supabase/supabase-js': 'stub-supabase-js.js' };
  for (const [name, file] of Object.entries(supaStubs)) stubs.set(name, path.join(supaDir, file));
  const supa = require(path.join(supaDir, 'supabase.js'));
  for (const name of Object.keys(supaStubs)) stubs.delete(name);
  const abortable = (input, init) => new Promise((resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
  });
  const answersAfter = (ms) => (input, init) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('done'), ms);
    init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })); });
  });

  await check('every Supabase request gets a deadline: a request that never answers fails fast as a timeout', async () => {
    assert.equal(typeof state.createdClient?.options?.global?.fetch, 'function', 'createClient must get the deadline-enforcing fetch');
    assert.equal(supa.REQUEST_TIMEOUT_MS, 15000);
    let seen;
    const timed = supa.withRequestTimeout((input, init) => { seen = init.signal; return new Promise(() => {}); }, { timeoutMs: 40 });
    const started = Date.now();
    const error = await timed('https://x.supabase.co/rest/v1/partners?select=*', { method: 'GET' }).catch((caught) => caught);
    assert.ok(Date.now() - started < 1000, 'settles at the deadline even if the fetch ignores the abort');
    assert.equal(error.name, 'AbortError');
    assert.equal(error.message, 'Network request timed out');
    assert.equal(seen.aborted, true, 'the underlying request is aborted');
    assert.ok(errors.isTimeoutError(error) && store.isNetworkError(error) && store.isServerUnreachable(error));
  });

  await check('a caller signal still cancels on its own; a quick answer passes straight through', async () => {
    const controller = new AbortController();
    const pending = supa.withRequestTimeout(abortable, { timeoutMs: 5000 })('https://x.supabase.co/rest/v1/partners', { signal: controller.signal });
    controller.abort();
    const error = await pending.catch((caught) => caught);
    assert.equal(error.message, 'Aborted', "the caller's own abort is rethrown as is, not as a timeout");
    assert.equal(await supa.withRequestTimeout(async () => 'response', { timeoutMs: 50 })('https://x.supabase.co/rest/v1/partners'), 'response');
  });

  await check('Edge Functions keep the caller deadline (the 56 s draft call); storage transfers get a longer one', async () => {
    const options = { timeoutMs: 20, storageTransferTimeoutMs: 400, functionTimeoutMs: 30 };
    const caller = new AbortController(); // functions-js makes one for `timeout: 56_000`
    let passed;
    const fn = supa.withRequestTimeout((input, init) => { passed = init.signal; return answersAfter(80)(input, init); }, options);
    assert.equal(await fn('https://x.supabase.co/functions/v1/draft-follow-up', { method: 'POST', signal: caller.signal }), 'done', 'nothing shorter is imposed on a function call that has its own deadline');
    assert.equal(passed, caller.signal, "the caller's signal is passed through unchanged");
    assert.equal(supa.requestDeadlineMs('https://x.supabase.co/functions/v1/draft-follow-up', true), null);
    await assert.rejects(supa.withRequestTimeout(answersAfter(80), options)('https://x.supabase.co/functions/v1/other', { method: 'POST' }), /timed out/, 'a function call with no deadline of its own gets one');
    assert.equal(await supa.withRequestTimeout(answersAfter(80), options)('https://x.supabase.co/storage/v1/object/case-documents/u/c/d.pdf', { method: 'POST' }), 'done', 'an upload gets the transfer deadline');
    await assert.rejects(supa.withRequestTimeout(answersAfter(80), options)('https://x.supabase.co/storage/v1/object/sign/case-documents/u/c/d.pdf', { method: 'POST' }), /timed out/, 'signing a link is an ordinary request');
    assert.ok(supa.requestDeadlineMs('https://x.supabase.co/storage/v1/object/case-documents/a.pdf', false) >= 60000);
    assert.equal(supa.requestDeadlineMs('https://x.supabase.co/auth/v1/token?grant_type=refresh_token', false), supa.REQUEST_TIMEOUT_MS);
  });

  await check('through postgrest-js: a hung GET fails once at the deadline (no retries), reads as offline, and never shows a stack', async () => {
    const { PostgrestClient } = require(path.join(repoRoot, 'node_modules', '@supabase', 'postgrest-js', 'dist', 'index.cjs'));
    let calls = 0;
    const client = new PostgrestClient('https://x.supabase.co/rest/v1', { fetch: supa.withRequestTimeout((input, init) => { calls += 1; return abortable(input, init); }, { timeoutMs: 40 }) });
    const started = Date.now();
    const result = await client.from('partners').select('*');
    assert.ok(Date.now() - started < 1000, 'no 1 s / 2 s / 4 s retries after the deadline');
    assert.equal(calls, 1);
    assert.equal(result.status, 0);
    assert.ok(store.isNetworkError(result.error) && errors.isTimeoutError(result.error));
    const failing = new PostgrestClient('https://x.supabase.co/rest/v1', { fetch: async () => { throw new TypeError('Network request failed'); } });
    const rpc = await failing.rpc('current_org_id');
    assert.match(rpc.error.details, /\n\s+at /, 'postgrest-js puts the stack in details');
    const text = errors.describeError(rpc.error);
    assert.doesNotMatch(text, /\n|\bat\s+\S+.*:\d+/);
    assert.match(text, /^Offline:/);
  });
}

await check('one read classifier: offline, timed out, status 0 and passing 5xx pages all mean "use the saved copy"', () => {
  for (const offline of [
    { name: 'AbortError', message: 'Aborted' },
    TIMEOUT(),
    { message: 'TypeError: Network request timed out' },
    NETWORK(),
    { message: 'FetchError: socket hang up', httpStatus: 0 },
    { message: 'whatever', status: 0 },
  ]) assert.ok(store.isNetworkError(offline) && store.isServerUnreachable(offline), JSON.stringify(offline));
  for (const passing of [
    GATEWAY_502(),
    { message: 'An invalid response was received from the upstream server', httpStatus: 502 },
    { message: 'Could not connect to the database', code: 'PGRST000' },
    { message: 'Service Unavailable', httpStatus: 503 },
  ]) assert.ok(store.isServerUnreachable(passing), JSON.stringify(passing));
  assert.equal(store.isNetworkError({ message: 'Timed out acquiring connection from connection pool.', code: 'PGRST003' }), false, 'a PostgREST code reached the server');
  assert.equal(store.isServerUnreachable({ message: 'permission denied for table cases', code: '42501' }), false);
  assert.equal(store.isServerUnreachable({ message: 'A lead needs a caller name.', code: 'P0001' }), false);
  const offline = new errors.OfflineError();
  assert.ok(offline instanceof errors.StoreError && store.isNetworkError(offline) && store.isServerUnreachable(offline));
});

await check('describeError never shows a gateway page or a stack trace', () => {
  const page = errors.describeError({ ...GATEWAY_502(), httpStatus: 502 });
  assert.doesNotMatch(page, /[<>]/);
  assert.match(page, /temporary problem \(HTTP 502\)/);
  assert.match(errors.describeError(GATEWAY_502()), /HTTP 502/, 'the status is read from the page when the response had none');
  assert.doesNotMatch(errors.describeError('<!DOCTYPE html><html><body>Bad gateway</body></html>'), /</);
  const stacked = errors.describeError({ ...NETWORK(), details: 'TypeError: Network request failed\n    at fetch (http://localhost:8081/index.bundle:1:2)\n    at anonymous (address at index.android.bundle:1:9)' });
  assert.doesNotMatch(stacked, /index\.bundle|\bat fetch|\n/);
  const timedOut = errors.describeError(TIMEOUT());
  assert.doesNotMatch(timedOut, /\bat fetch|aborted \(timeout/);
  assert.match(timedOut, /did not answer in time/);
  assert.equal(errors.describeError({ message: 'boom', details: 'fetch@http://localhost:8081/index.bundle:12:34\nanonymous@[native code]', code: 'XX000' }), 'boom (code XX000)');
  assert.ok(errors.describeError({ message: 'x'.repeat(5000) }).length <= 300);
  assert.equal(errors.describeError({ message: 'at least one therapy is required', code: '23514' }), 'at least one therapy is required (code 23514)', 'ordinary wording is untouched');
});

await check('a queued change that keeps timing out counts toward the caps and is set aside, never blocking the queue forever', async () => {
  await freshAccount();
  const P = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
  state.offline = true;
  await store.createPartner(partner(P, 'Slow to save'), U);
  state.offline = false;
  state.failOn = (b) => ((b.op === 'upsert' || b.op === 'insert') && b.table === 'partners') ? TIMEOUT() : null;
  assert.equal(await store.flushWriteQueue(U), 0);
  const envelope = JSON.parse(state.asyncStorage.get(queueKey));
  const [op] = envelope.ops;
  assert.deepEqual(Object.keys(envelope.transientWaits || {}), [op.opId], "the timeout is counted, under the op's own id");
  assert.equal(envelope.transientWaits[op.opId].attempts, 1);
  envelope.transientWaits[op.opId] = { first: new Date(Date.now() - 3 * 3600000).toISOString(), attempts: store.MAX_TRANSIENT_ATTEMPTS - 1 };
  state.asyncStorage.set(queueKey, JSON.stringify(envelope));
  await assert.rejects(store.flushWriteQueue(U), errors.RejectedWritesError);
  const [entry] = await store.listRejectedWrites(U);
  assert.match(entry.reason, /kept timing out/);
  assert.equal(await store.pendingWriteCount(U), 0, 'the queue head is free again');
  // An online save that times out is queued, not reported as refused.
  await store.createPartner(partner('c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c2', 'Timed out online'), U);
  assert.equal(await store.pendingWriteCount(U), 1);
  state.failOn = null;
});

await check('reads fall back to the saved copy on a gateway page or a timeout, not an error', async () => {
  await freshAccount();
  const P = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1';
  state.db.partners.push({ id: P, name: 'Hope House', organization: 'Org', types: ['Inpatient'], created_at: new Date().toISOString(), org_id: ORG });
  await store.hydrate(U);
  for (const failure of [GATEWAY_502(), TIMEOUT(), { message: 'An invalid response was received from the upstream server', code: '' }]) {
    state.failOn = (b) => (b.op === 'select' ? failure : null);
    assert.equal(await store.refreshSnapshot(U), null, `${failure.message.slice(0, 30)}: the screen keeps its copy, no "Sync issue"`);
    const launch = await store.hydrate(U);
    assert.equal(launch.source, 'cache');
    assert.deepEqual(launch.snapshot.partners.map((row) => row.id), [P]);
  }
  // No saved copy at all: an empty workspace, never an error carrying a gateway page.
  state.asyncStorage.delete(cacheKey);
  state.failOn = () => GATEWAY_502();
  assert.equal((await store.hydrate(U)).source, 'cache');
  state.failOn = null;
});

await check('the case list and an open case file fall back to their saved copies on a gateway page or a timeout', async () => {
  await freshAccount();
  await store.hydrate(U);
  const caseId = 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2';
  await store.persistCaseList({ cases: [{ id: caseId, title: 'Family', status: 'inquiry' }], contacts: [] }, U);
  await store.persistCaseFile(caseId, { events: [{ id: 'e1', caseId, kind: 'note', body: 'hi', occurredAt: new Date().toISOString() }], documents: [] }, U);
  for (const makeFailure of [GATEWAY_502, TIMEOUT, () => new errors.OfflineError()]) {
    const failure = makeFailure();
    state.caseReadFailure = failure;
    const list = await store.loadCaseList(U);
    assert.equal(list.source, 'cache', String(failure.message));
    assert.deepEqual(list.list.cases.map((row) => row.id), [caseId]);
    assert.equal((await store.loadCaseFile(U, caseId)).source, 'cache');
  }
  state.caseReadFailure = { message: 'permission denied for table cases', code: '42501' };
  await assert.rejects(store.loadCaseList(U), (error) => /permission denied/.test(error.message), 'a refusal still surfaces');
  state.caseReadFailure = null;
});

await check('a change made durable in the queue but killed before its saved copy still shows after an offline relaunch', async () => {
  await freshAccount();
  const P = 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5';
  const F = 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e6';
  const M = 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e7';
  state.db.partners.push({ id: P, name: 'Hope House', organization: 'Org', types: ['Inpatient'], note: 'old note', created_at: new Date().toISOString(), org_id: ORG });
  state.db.partner_balances.push({ partner_id: P, inbound: 3, outbound: 2 });
  state.db.follow_ups.push({ id: F, title: 'Call mom', due_on: '2026-10-23', status: 'open', kind: 'follow_up', org_id: ORG, created_at: new Date().toISOString() });
  state.db.match_profiles.push(matchRow(M));
  const { snapshot } = await store.hydrate(U);
  const cached = snapshot.partners.find((row) => row.id === P);
  goOfflineExpired();
  // Each save reaches the durable queue; the app is killed before
  // persistCache writes the saved copy (so persistCache is never called).
  await store.updatePartner({ ...cached, note: 'new note' }, U);
  const Q = 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e8';
  await store.createPartner(partner(Q, 'Added offline'), U);
  const N = 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e9';
  const T = 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5ea';
  await store.recordOutreachSent(F, followUp(N, { title: 'Call mom again', dueOn: '2026-10-26' }), null, { id: T, partnerId: P, kind: 'text', note: '', occurredAt: new Date().toISOString() }, U);
  await store.deleteMatchProfile(M, U);
  assert.equal(await store.pendingWriteCount(U), 4);
  const relaunch = await store.hydrate(U);
  assert.equal(relaunch.source, 'cache');
  const shown = relaunch.snapshot;
  const hope = shown.partners.find((row) => row.id === P);
  assert.equal(hope.note, 'new note', 'the queued edit is on screen, so it is not redone');
  assert.deepEqual([hope.inbound, hope.outbound], [3, 2], 'fields the edit did not touch are left alone');
  assert.ok(shown.partners.some((row) => row.id === Q && row.name === 'Added offline'), 'the queued new partner is on screen');
  assert.equal(shown.followUps.find((row) => row.id === F)?.status, 'done', 'the step the outreach closed is closed');
  assert.ok(shown.followUps.some((row) => row.id === N), 'its next step is there');
  assert.ok(shown.touches.some((row) => row.id === T));
  assert.equal(shown.referralMatches.some((row) => row.id === M), false, 'the queued removal hides the match');
  // A saved copy that already has the changes comes back as it was.
  await store.persistCache(shown, U);
  const again = (await store.hydrate(U)).snapshot;
  assert.deepEqual(JSON.parse(JSON.stringify(again)), JSON.parse(JSON.stringify(shown)), 'applying the queue twice changes nothing');
  // Back online: everything lands once.
  signIn();
  state.offline = false;
  assert.equal((await store.hydrate(U)).source, 'remote');
  assert.equal(state.db.partners.filter((row) => row.id === Q).length, 1);
  assert.equal(state.db.partners.find((row) => row.id === P).note, 'new note');
  assert.equal(await store.pendingWriteCount(U), 0);
});

await check('a queued change missing from the saved copy stays on screen when the flush stops but the server can be read', async () => {
  await freshAccount();
  await store.hydrate(U);
  const Q = 'e6e6e6e6-e6e6-4e6e-8e6e-e6e6e6e6e6e6';
  state.offline = true;
  await store.createPartner(partner(Q, 'Queued, copy lost'), U); // killed before persistCache
  state.offline = false;
  state.failOn = (b) => (b.op !== 'select' && b.op !== 'rpc') ? { message: 'Service Unavailable', httpStatus: 503 } : null;
  const launch = await store.hydrate(U);
  assert.equal(launch.source, 'remote');
  assert.ok(launch.snapshot.partners.some((row) => row.id === Q), 'kept on screen (and in the copy) while its write waits');
  assert.ok((await store.refreshSnapshot(U)).partners.some((row) => row.id === Q));
  state.failOn = null;
});

await check('an op this build does not know (OTA rollback) is set aside as unreadable; everything else keeps working', async () => {
  await freshAccount();
  await store.hydrate(U);
  const P = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1';
  const unknown = { kind: 'outreach.scheduled', opId: uuid(), followUpId: 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f2', sendAt: '2026-10-25T15:00:00Z' };
  const known = { kind: 'partner.insert', opId: uuid(), row: { id: P, name: 'Known', organization: 'Org', types: ['Inpatient'], owner_id: U } };
  state.asyncStorage.set(queueKey, JSON.stringify({ version: 2, userId: U, ops: [unknown, known] }));
  assert.equal(await store.pendingWriteCount(U), 1, 'the queue still reads');
  const listed = await store.listRejectedWrites(U);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, 'unreadable');
  assert.equal(listed[0].kind, 'outreach.scheduled');
  assert.deepEqual(await store.syncStatus(U), { pending: 1, waiting: 0, rejected: 1 }, 'it is in the review banner');
  // Saves keep working (every one used to fail reading the queue).
  const Q = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f3';
  await store.createPartner(partner(Q, 'Saved after the rollback'), U);
  assert.ok(state.db.partners.some((row) => row.id === P) && state.db.partners.some((row) => row.id === Q));
  assert.equal(await store.pendingWriteCount(U), 0);
  // The raw op is kept, never sent; it can only be discarded here.
  assert.deepEqual(JSON.parse(state.asyncStorage.get(unreadableKey)).entries.map((entry) => entry.raw), [unknown]);
  await assert.rejects(store.retryRejectedWrite(U, listed[0].id), /different version of ReferralFit/);
  await assert.rejects(store.prepareForWorkspaceChange(U), /could not be saved/);
  await store.discardRejectedWrite(U, listed[0].id);
  assert.deepEqual(await store.listRejectedWrites(U), []);
});

await check('a damaged queue or rejected list no longer blocks every save', async () => {
  await freshAccount();
  await store.hydrate(U);
  state.asyncStorage.set(queueKey, `{"version":2,"userId":"${U}","ops":[{"kind":"partner.insert"`); // a torn write
  const badEntry = { id: 'bad', ops: [{ kind: 'mystery.op', opId: uuid() }], reason: 'x', rejectedAt: new Date().toISOString() };
  const goodEntry = { id: 'good', ops: [{ kind: 'partner.update', opId: uuid(), id: 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2', patch: { note: 'x' } }], reason: 'refused', rejectedAt: new Date().toISOString() };
  state.asyncStorage.set(rejectedKey, JSON.stringify({ version: 1, userId: U, entries: [badEntry, goodEntry] }));
  assert.equal(await store.pendingWriteCount(U), 0);
  const listed = await store.listRejectedWrites(U);
  assert.deepEqual(listed.map((item) => item.status).sort(), ['rejected', 'unreadable', 'unreadable']);
  await store.createPartner(partner('f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f3', 'Still saves'), U);
  assert.ok(state.db.partners.some((row) => row.name === 'Still saves'));
  await store.discardAllRejectedWrites(U);
  assert.deepEqual(await store.listRejectedWrites(U), []);
});

await check('a quarantined change comes back once the app can read it again', async () => {
  await freshAccount();
  await store.hydrate(U);
  const P = 'f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3';
  const op = { kind: 'partner.insert', opId: uuid(), row: { id: P, name: 'Back again', organization: 'Org', types: ['Inpatient'], owner_id: U } };
  state.asyncStorage.set(unreadableKey, JSON.stringify({ version: 1, userId: U, entries: [{ id: uuid(), source: 'queue', raw: op, reason: 'x', quarantinedAt: new Date().toISOString() }] }));
  assert.equal(await store.flushWriteQueue(U), 1);
  assert.ok(state.db.partners.some((row) => row.id === P));
  assert.deepEqual(await store.listRejectedWrites(U), []);
});

await check('1,000 queued changes flush in reasonable time: no per-op hashing, workspace check or queue rewrite', async () => {
  await freshAccount();
  await store.hydrate(U);
  const ops = Array.from({ length: 1000 }, (_, i) => ({ kind: 'partner.insert', opId: uuid(), row: { id: `${String(i).padStart(8, '0')}-1000-4000-8000-000000000000`, name: `Program ${i}`, organization: 'Org', types: ['Inpatient'], note: 'x'.repeat(200), owner_id: U } }));
  state.asyncStorage.set(queueKey, JSON.stringify({ version: 2, userId: U, ops }));
  state.rpcCalls = [];
  state.asyncWriteLog = [];
  const started = Date.now();
  const flushed = await store.flushWriteQueue(U);
  const elapsed = Date.now() - started;
  const verifications = state.rpcCalls.filter((call) => call.name === 'current_org_id').length;
  const queueWrites = state.asyncWriteLog.filter((key) => key === queueKey).length;
  state.asyncWriteLog = null;
  console.log(`  1,000 queued changes flushed in ${elapsed} ms: ${verifications} workspace checks, ${queueWrites} queue writes`);
  assert.equal(flushed, 1000);
  assert.ok(verifications <= Math.ceil(1000 / store.WORKSPACE_REVERIFY_OPS) + 5, `workspace re-verified ${verifications} times`);
  assert.ok(queueWrites <= Math.ceil(1000 / store.QUEUE_PERSIST_EVERY_OPS) + 5, `queue rewritten ${queueWrites} times`);
  assert.ok(elapsed < 3000, `took ${elapsed} ms`);
  assert.equal(await store.pendingWriteCount(U), 0);
  assert.equal(state.db.partners.length, 1000);
});

await check('a flush cut off between queue writes replays what already landed, exactly once', async () => {
  await freshAccount();
  await store.hydrate(U);
  const ops = Array.from({ length: 50 }, (_, i) => ({ kind: 'partner.insert', opId: uuid(), row: { id: `${String(i).padStart(8, '0')}-2000-4000-8000-000000000000`, name: `P${i}`, organization: 'Org', types: ['Inpatient'], owner_id: U } }));
  state.asyncStorage.set(queueKey, JSON.stringify({ version: 2, userId: U, ops }));
  let inserts = 0;
  state.failOn = (b) => {
    // The session ends right after the 31st insert lands (the app is gone).
    if (b.op === 'upsert' && b.table === 'partners' && ++inserts === 31) setTimeout(() => {}, 0), state.storage.set(STORAGE_KEY, JSON.stringify(makeSession(U, 'sess-2', nowS() + 3600)));
    return null;
  };
  await assert.rejects(store.flushWriteQueue(U), /session changed/);
  const onDisk = JSON.parse(state.asyncStorage.get(queueKey)).ops.length;
  assert.ok(onDisk >= 50 - 31 && onDisk < 50, `progress was saved part way (${onDisk} left on disk)`);
  state.failOn = null;
  await store.flushWriteQueue(U);
  assert.equal(state.db.partners.length, 50, 'every change landed once');
  assert.equal(await store.pendingWriteCount(U), 0);
  signIn();
});

await check('waits saved under the old content-hash keys keep their attempt count, now under the op id', async () => {
  await freshAccount();
  const op = { kind: 'partner.insert', opId: uuid(), row: { id: 'f4f4f4f4-f4f4-4f4f-8f4f-f4f4f4f4f4f4', name: 'Waiting', organization: 'Org', types: ['Inpatient'], owner_id: U } };
  const legacy = { first: new Date(Date.now() - 3 * 3600000).toISOString(), attempts: store.MAX_TRANSIENT_ATTEMPTS - 1 };
  state.asyncStorage.set(queueKey, JSON.stringify({ version: 2, userId: U, ops: [op], transientWaits: { [legacyWaitKey(JSON.stringify(op))]: legacy } }));
  assert.deepEqual(await store.syncStatus(U), { pending: 1, waiting: 0, rejected: 0 });
  assert.deepEqual(JSON.parse(state.asyncStorage.get(queueKey)).transientWaits, { [op.opId]: legacy }, 'moved to the op id');
  state.failOn = (b) => (b.op === 'upsert') ? { message: 'internal error', code: 'XX000' } : null;
  await assert.rejects(store.flushWriteQueue(U), errors.RejectedWritesError, 'the 25th try is the 25th, not the 1st');
  state.failOn = null;
});

await check('a list past the paging ceiling opens the saved copy with a notice instead of "Could not load account"', async () => {
  await freshAccount();
  const P = 'a7a7a7a7-a7a7-4a7a-8a7a-a7a7a7a7a7a7';
  state.db.partners.push({ id: P, name: 'Hope House', organization: 'Org', types: ['Inpatient'], created_at: new Date().toISOString(), org_id: ORG });
  await store.hydrate(U);
  let touchPages = 0;
  const stamp = new Date().toISOString();
  state.selectOverride = (b) => {
    if (b.table !== 'touches' || !b.range) return null;
    touchPages += 1;
    return { data: Array.from({ length: b.range[1] - b.range[0] + 1 }, (_, i) => ({ id: `t-${b.range[0] + i}`, partner_id: P, kind: 'call', note: '', occurred_at: stamp })), error: null };
  };
  const launch = await store.hydrate(U);
  state.selectOverride = null;
  assert.equal(launch.source, 'cache');
  assert.deepEqual(launch.snapshot.partners.map((row) => row.id), [P]);
  assert.match(launch.notice, /more than 100000 rows/);
  assert.equal(launch.syncError, undefined, 'not reported as an unsynced change');
  assert.equal(touchPages, store.TOUCH_MAX_PAGES, 'touches have their own, higher ceiling');
  assert.equal(store.TOUCH_MAX_PAGES, 100);
});

await check('the snapshot a refresh just saved is not written again by persistCache', async () => {
  await freshAccount();
  state.db.partners.push({ id: 'a8a8a8a8-a8a8-4a8a-8a8a-a8a8a8a8a8a8', name: 'Hope', organization: 'Org', types: ['Inpatient'], created_at: new Date().toISOString(), org_id: ORG });
  await store.hydrate(U);
  const refreshed = await store.refreshSnapshot(U);
  state.asyncWriteLog = [];
  await store.persistCache(refreshed, U); // what App.tsx's syncDerived does right after a refresh
  assert.deepEqual(state.asyncWriteLog.filter((key) => key === cacheKey), [], 'no second write of the same copy');
  await store.persistCache({ ...refreshed, partners: [] }, U);
  assert.equal(state.asyncWriteLog.filter((key) => key === cacheKey).length, 1, 'a changed copy is written');
  state.asyncWriteLog = null;
});

// cases.ts: the real module over the same fakes.
{
  const casesDir = path.join(tmpDir, 'cases-real');
  transpile('src/lib/cases.ts', 'cases.js', casesDir);
  transpile('src/lib/phone.ts', 'phone.js', casesDir);
  transpile('src/lib/insurance.ts', 'insurance.js', casesDir);
  for (const name of ['errors', 'auth-session', 'paging', 'supabase']) writeFileSync(path.join(casesDir, `${name}.js`), `module.exports = require('../${name}.js');`);
  writeFileSync(path.join(casesDir, 'stub-expo-crypto.js'), "exports.randomUUID = () => require('node:crypto').randomUUID();");
  writeFileSync(path.join(casesDir, 'stub-expo-file-system.js'), "exports.readAsStringAsync = async () => '';");
  stubs.set('expo-crypto', path.join(casesDir, 'stub-expo-crypto.js'));
  stubs.set('expo-file-system/legacy', path.join(casesDir, 'stub-expo-file-system.js'));
  const cases = require(path.join(casesDir, 'cases.js'));
  stubs.delete('expo-crypto');
  stubs.delete('expo-file-system/legacy');
  const lead = (extra = {}) => ({
    caseId: uuid(), contactId: uuid(), followUpId: uuid(), callerName: 'Dana', phone: '5035550100', email: '',
    aboutRelationship: 'son', aboutFirstName: 'Sam', leadSource: 'Referral', urgency: 'none', dueOn: '2026-10-24', dueTime: null, ...extra,
  });

  await check('a new lead that cannot reach the server is an OfflineError (keep the draft, retry the same ids), never "rejected"', async () => {
    await freshAccount();
    for (const [label, failure] of [['lost connection', NETWORK()], ['gateway page', GATEWAY_502()], ['timeout', TIMEOUT()]]) {
      state.failOn = (b) => (b.op === 'rpc' && b.table === 'create_lead') ? failure : null;
      const input = lead();
      const error = await cases.createLead(input, U).catch((caught) => caught);
      assert.ok(error instanceof errors.OfflineError, `${label}: ${error && error.message}`);
      assert.ok(error instanceof errors.StoreError && store.isServerUnreachable(error));
      assert.equal(error.timedOut, label === 'timeout');
      assert.doesNotMatch(error.message, /[<>]|\bat\s+\S+:\d|Account changed/);
      state.failOn = null;
      state.rpcCalls = [];
      await cases.createLead(input, U); // Retry: the same ids again
      assert.deepEqual(state.rpcCalls.filter((call) => call.name === 'create_lead').map((call) => [call.args.p_lead.id, call.args.p_lead.contact_id, call.args.p_lead.follow_up_id]), [[input.caseId, input.contactId, input.followUpId]]);
    }
  });

  await check('with no connection at all, or an expired token offline, a lead is an OfflineError, not "Account changed"', async () => {
    await freshAccount();
    state.offline = true;
    const error = await cases.createLead(lead(), U).catch((caught) => caught);
    assert.ok(error instanceof errors.OfflineError, error && error.message);
    goOfflineExpired();
    state.rpcCalls = [];
    const expired = await cases.createLead(lead(), U).catch((caught) => caught);
    assert.ok(expired instanceof errors.OfflineError, expired && expired.message);
    assert.deepEqual(state.rpcCalls, [], 'nothing is sent under a session the device cannot refresh');
    signIn();
    state.offline = false;
  });

  await check("a refused lead or case is a plain StoreError in the server's words", async () => {
    await freshAccount();
    state.failOn = (b) => (b.op === 'rpc' && b.table === 'create_lead') ? { message: 'A lead needs a caller name.', details: '', hint: '', code: 'P0001' } : null;
    const error = await cases.createLead(lead({ callerName: '' }), U).catch((caught) => caught);
    assert.ok(error instanceof errors.StoreError && !(error instanceof errors.OfflineError));
    assert.equal(error.message, 'A lead needs a caller name.');
    state.failOn = null;
  });

  await check('a new case bundle follows the same contract', async () => {
    await freshAccount();
    const record = { id: uuid(), title: 'Family', status: 'inquiry', summary: '', leadSource: 'Referral', leadSourceDetail: '', lostReason: '', stageChangedAt: '', paymentStatus: 'none', quotedAmount: null, paidAmount: 0, createdAt: '', updatedAt: '' };
    state.failOn = (b) => (b.op === 'rpc' && b.table === 'create_case_bundle') ? TIMEOUT() : null;
    const error = await cases.createCaseBundle(record, null, null, U).catch((caught) => caught);
    assert.ok(error instanceof errors.OfflineError && error.timedOut, error && error.message);
    state.failOn = (b) => (b.op === 'rpc' && b.table === 'create_case_bundle') ? { message: 'duplicate key value violates unique constraint', code: '23505' } : null;
    const refused = await cases.createCaseBundle(record, null, null, U).catch((caught) => caught);
    assert.ok(refused instanceof errors.StoreError && !(refused instanceof errors.OfflineError));
    state.failOn = null;
  });

  await check('taking a lead: assigns the caller, a replay is a quiet success, a teammate\'s lead is LeadTakenError', async () => {
    await freshAccount();
    const C = uuid();
    const E = uuid();
    try {
      state.rpcResults = { take_case: (args) => ({ data: [{ event_body: args.p_event_id === E ? 'Took this case' : '', occurred_at: '2026-10-24T17:00:00Z' }], error: null }) };
      assert.deepEqual(await cases.takeCase(C, E), { eventBody: 'Took this case', occurredAt: '2026-10-24T17:00:00Z' });
      assert.deepEqual(state.rpcCalls.filter((call) => call.name === 'take_case').map((call) => call.args), [{ p_case_id: C, p_event_id: E }]);
      assert.equal((await cases.takeCase(C, uuid())).eventBody, '', 'already yours / a replay: nothing written, no timeline row');
      state.rpcResults = null;
      state.failOn = (b) => (b.op === 'rpc' && b.table === 'take_case')
        ? { message: 'Already taken by Jo Smith', details: TEAMMATE.toUpperCase(), hint: 'already_taken', code: 'P0001' } : null;
      const taken = await cases.takeCase(C, uuid()).catch((caught) => caught);
      assert.ok(taken instanceof errors.LeadTakenError && taken instanceof errors.StoreError, taken && taken.message);
      assert.equal(taken.message, 'Already taken by Jo Smith');
      assert.equal(taken.takenBy, TEAMMATE);
      assert.ok(!(taken instanceof errors.OfflineError) && !store.isServerUnreachable(taken), 'not retryable');
      state.failOn = (b) => (b.op === 'rpc' && b.table === 'take_case') ? NETWORK() : null;
      assert.ok(await cases.takeCase(C, uuid()).catch((caught) => caught) instanceof errors.OfflineError);
      state.failOn = (b) => (b.op === 'rpc' && b.table === 'take_case') ? { message: 'Case not found', details: '', hint: '', code: 'P0002' } : null;
      const missing = await cases.takeCase(C, uuid()).catch((caught) => caught);
      assert.ok(missing instanceof errors.StoreError && !(missing instanceof errors.LeadTakenError) && /Case not found/.test(missing.message));
    } finally {
      state.failOn = null;
      state.rpcResults = null;
    }
  });

  await check('taking a lead before take_case is deployed reads the holder, then assigns through assign_case', async () => {
    await freshAccount();
    const notDeployed = { message: 'Could not find the function public.take_case(p_case_id, p_event_id) in the schema cache', details: '', hint: 'Perhaps you meant to call the function public.assign_case', code: 'PGRST202' };
    const [free, mine, theirs] = [uuid(), uuid(), uuid()];
    state.db.cases = [
      { id: free, org_id: ORG, assigned_to: null },
      { id: mine, org_id: ORG, assigned_to: U.toUpperCase() },
      { id: theirs, org_id: ORG, assigned_to: TEAMMATE },
    ];
    try {
      state.failOn = (b) => (b.op === 'rpc' && b.table === 'take_case') ? notDeployed : null;
      state.rpcResults = { assign_case: (args) => ({ data: [{ event_body: `Assigned to Dana (${args.p_assigned_to === U})`, occurred_at: '2026-10-24T17:05:00Z' }], error: null }) };
      const E = uuid();
      assert.deepEqual(await cases.takeCase(free, E), { eventBody: 'Assigned to Dana (true)', occurredAt: '2026-10-24T17:05:00Z' });
      assert.deepEqual(state.rpcCalls.filter((call) => call.name === 'assign_case').map((call) => call.args), [{ p_case_id: free, p_assigned_to: U, p_event_id: E }]);
      state.rpcCalls = [];
      assert.equal((await cases.takeCase(mine, uuid())).eventBody, '', 'already yours: nothing written');
      const taken = await cases.takeCase(theirs, uuid()).catch((caught) => caught);
      assert.ok(taken instanceof errors.LeadTakenError && taken.takenBy === TEAMMATE, taken && taken.message);
      assert.equal(taken.message, 'Already taken by a teammate');
      assert.deepEqual(state.rpcCalls.filter((call) => call.name === 'assign_case'), [], 'never reassigns a held case');
      state.failOn = (b) => (b.op === 'rpc' && b.table === 'take_case') ? { ...notDeployed, code: '42883', message: 'function public.take_case(uuid, uuid) does not exist' } : null;
      assert.equal((await cases.takeCase(mine, uuid())).eventBody, '', 'undefined_function falls back the same way');
    } finally {
      state.failOn = null;
      state.rpcResults = null;
      state.db.cases = [];
    }
  });

  await check('case reads that hit a gateway page or a timeout read as offline, so the saved copy opens', async () => {
    await freshAccount();
    state.failOn = (b) => (b.op === 'rpc' && b.table === 'current_org_id') ? GATEWAY_502() : null;
    assert.ok(await cases.fetchCaseList().catch((caught) => caught) instanceof errors.OfflineError);
    state.failOn = (b) => (b.op === 'select' && b.table === 'cases') ? TIMEOUT() : null;
    assert.ok(await cases.fetchCaseList().catch((caught) => caught) instanceof errors.OfflineError);
    state.failOn = (b) => (b.op === 'select' && b.table === 'cases') ? { message: 'permission denied for table cases', code: '42501' } : null;
    const refused = await cases.fetchCaseList().catch((caught) => caught);
    assert.ok(refused instanceof errors.StoreError && !(refused instanceof errors.OfflineError) && /permission denied/.test(refused.message));
    state.failOn = null;
    assert.deepEqual(await cases.fetchCaseList(), { cases: [], contacts: [] });
  });
}

// ─── account.ts: every document is removed, past the 1,000-row cap ──────────

{
  const accountDir = path.join(tmpDir, 'account');
  transpile('src/lib/account.ts', 'account.js', accountDir);
  writeFileSync(path.join(accountDir, 'errors.js'), "module.exports = require('../errors.js');");
  writeFileSync(path.join(accountDir, 'paging.js'), "module.exports = require('../paging.js');");
  writeFileSync(path.join(accountDir, 'supabase.js'), "module.exports = require('../supabase.js');");
  writeFileSync(path.join(accountDir, 'org.js'), `exports.fetchCurrentOrgId = async () => '${ORG}';`);
  writeFileSync(path.join(accountDir, 'auth-session.js'), 'exports.forceLocalSignOut = async () => { globalThis.__offlineSyncState.forcedSignOut = (globalThis.__offlineSyncState.forcedSignOut || 0) + 1; };');
  writeFileSync(path.join(accountDir, 'store.js'), `
const { RejectedWritesError } = require('../errors.js');
const s = globalThis.__offlineSyncState;
exports.prepareForWorkspaceChange = async (userId, options) => {
  s.prepared.push({ userId, options });
  if (s.refuseFirstPrepare && s.prepared.length === 1) throw new RejectedWritesError('1 queued change could not be saved', 1);
};
exports.rejectedWriteCount = async () => (s.refuseFirstPrepare ? 1 : 0);
exports.waitingWriteCount = async () => (s.waitingOnPrepare ? 1 : 0);
exports.forgetWorkspaceBinding = async (userId) => { s.forgotBinding = userId; };
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
  await check('account deletion removes the local session even when signOut fails offline', async () => {
    state.prepared = [];
    state.forcedSignOut = 0;
    state.signOutError = { name: 'AuthRetryableFetchError', message: 'Network request failed' };
    await account.deleteOwnAccount({ userId: U, removeWorkspaceFiles: false });
    assert.equal(state.forcedSignOut, 1);
    assert.equal(state.forgotBinding, U, 'the workspace binding goes with the account');
    state.signOutError = null;
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
  // ─── Round 3: push registrations survive a sign-out we did not start ───────

  await check('a revoked-session sign-out marks the device registration for unregister', async () => {
    resetDb();
    state.asyncStorage.clear();
    signIn();
    state.authListeners = [];
    const push = freshPush();
    await push.registerThisDevice(U);
    for (const listener of state.authListeners || []) listener('SIGNED_OUT', null); // e.g. refresh token revoked
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(state.asyncStorage.get(`referralfit-push-registration-v1:${U}`), /"pendingUnregister":true/);
    state.authListeners = [];
  });
}

Module._resolveFilename = originalResolve;
console.log(`offline sync behavior (${passed} checks): ok`);
