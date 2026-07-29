#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/lib/store.ts', import.meta.url), 'utf8');
assert.match(source, /function sanitizeInsuranceNetworks\(value: unknown, insurance: string\[\]\)/);
assert.match(source, /insuranceNetworkStatuses\.has/);
const casesSource = await readFile(new URL('../src/lib/cases.ts', import.meta.url), 'utf8');
const authSessionSource = await readFile(new URL('../src/lib/auth-session.ts', import.meta.url), 'utf8');

const mustContain = [
  "const CACHE_KEY_PREFIX = 'referralfit-cache-v2:'",
  "const QUEUE_KEY_PREFIX = 'referralfit-write-queue-v2:'",
  'type CacheEnvelope = { version: 2; userId: string; snapshot: Snapshot }',
  'type QueueEnvelope = { version: 2; userId: string; ops: QueueOp[] }',
  'parsed.userId?.toLowerCase() !== userId',
  'envelope.userId?.toLowerCase() !== fence.userId',
  'await withQueueLock(async () =>',
  'await writeQueueUnlocked(fence.userId, [...ops, bindQueueOp(op, fence.userId)])',
  "throw persistenceError('offline queue', error)",
  "throw persistenceError('cache', error)",
  "owner_id: userId",
  ".eq('owner_id', userId)",
  'currentAuthSessionIdentity',
  'current.sessionId !== fence.sessionId',
];
for (const text of mustContain) assert.ok(source.includes(text), `missing store invariant: ${text}`);

// Global v1/legacy storage is documented but must never be read or merged.
assert.doesNotMatch(source, /AsyncStorage\.(?:getItem|setItem)\((?:CACHE_KEY|QUEUE_KEY|LEGACY_STORAGE_KEY)/);
assert.doesNotMatch(source, /readLegacySnapshot|importLegacySnapshot/);
assert.doesNotMatch(source, /void\s+requeue\(/);

const expectedSignatures = [
  /export async function hydrate\(expectedUserId: string\)/,
  /export async function flushWriteQueue\(expectedUserId: string\)/,
  /export async function pendingWriteCount\(expectedUserId: string\)/,
  /export async function persistCache\(snapshot: Snapshot, expectedUserId: string\)/,
  /export async function refreshSnapshot\(expectedUserId: string\)/,
  /export async function createPartner\(partner: Partner, expectedUserId: string\)/,
  /export async function assignMatchReferral\(referral: Referral, match: ReferralMatch, expectedUserId: string\)/,
  /export async function logContactActivity\(/,
];
for (const signature of expectedSignatures) assert.match(source, signature);

// Every AsyncStorage write is in a catch block that converts failure to StoreError.
const writes = [...source.matchAll(/await AsyncStorage\.setItem\([^;]+;/g)];
assert.equal(writes.length, 2, 'unexpected AsyncStorage write path added without durability audit');
for (const write of writes) {
  const following = source.slice(write.index, write.index + 240);
  assert.match(following, /catch \(error\) \{\s*throw persistenceError\(/);
}

assert.match(source, /follow_up\.complete_next/, 'complete + next-step must be one durable queue operation');
assert.match(source, /follow_up\.complete_outcome/, 'follow-up + outcome must be one durable queue operation');
assert.match(source, /complete_follow_up_with_next/, 'complete + next-step must use its transactional RPC');
assert.match(source, /complete_follow_up_with_outcome/, 'follow-up + outcome must use its transactional RPC');
assert.match(source, /contact\.log_activity/, 'case events and partner touches from one handoff must be one durable queue operation');
assert.match(source, /log_contact_activity/, 'contact activity must use its transactional RPC');
assert.match(source, /match_profile_id: null/, 'cyclic referral links must be cleared for dependency-safe base inserts');
assert.match(source, /referral_id: null/, 'cyclic match links must be cleared for dependency-safe base inserts');
assert.match(casesSource, /withStableCaseAccount/, 'case operations must reject account transitions');
assert.match(casesSource, /current\.sessionId === expected\.sessionId/, 'case operations must share the stable login-session fence');
assert.match(authSessionSource, /session_id/, 'session fence must survive token refresh but detect same-user re-login');
assert.match(casesSource, /save_case_document_with_event/, 'documents and timeline events must be transactional');
assert.match(casesSource, /Crypto\.randomUUID\(\)/, 'native IDs must use cryptographically secure UUIDs');
assert.doesNotMatch(casesSource, /Math\.random\(\)/, 'database IDs must not use Math.random');

console.log('store account-scope/durability source invariants: ok');
