#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/lib/store.ts', import.meta.url), 'utf8');
assert.match(source, /function sanitizeInsuranceNetworks\(value: unknown, insurance: string\[\]\)/);
assert.match(source, /insuranceNetworkStatuses\.has/);
const casesSource = await readFile(new URL('../src/lib/cases.ts', import.meta.url), 'utf8');
const businessSource = await readFile(new URL('../src/lib/business.ts', import.meta.url), 'utf8');
const authSessionSource = await readFile(new URL('../src/lib/auth-session.ts', import.meta.url), 'utf8');

const mustContain = [
  "const CACHE_KEY_PREFIX = 'referralfit-cache-v2:'",
  "const QUEUE_KEY_PREFIX = 'referralfit-write-queue-v2:'",
  "const WORKSPACE_KEY_PREFIX = 'referralfit-workspace-v1:'",
  'type CacheEnvelope = { version: 2; userId: string; snapshot: Snapshot }',
  'type QueueEnvelope = { version: 2; userId: string; ops: QueueOp[] }',
  'parsed.userId?.toLowerCase() !== userId',
  'envelope.userId?.toLowerCase() !== fence.userId',
  'await withQueueLock(async () =>',
  'await writeQueueUnlocked(fence.userId, [...ops, bindQueueOp(op, fence.userId)])',
  "throw persistenceError('offline queue', error)",
  "throw persistenceError('cache', error)",
  "owner_id: userId",
  ".eq('org_id', orgId)",
  'execute: (userId: string, orgId: string)',
  'const orgId = await assertWorkspaceFence(fence)',
  'currentAuthSessionIdentity',
  'current.sessionId !== fence.sessionId',
];
for (const text of mustContain) assert.ok(source.includes(text), `missing store invariant: ${text}`);

// Workspace scoping: rows are shared by every org member, so reads, updates,
// and deletes filter on the bound workspace (org_id) — never on the row
// creator. owner_id survives only as insert-time attribution.
for (const [name, text] of [['store', source], ['cases', casesSource], ['business', businessSource]]) {
  assert.doesNotMatch(text, /\.eq\('owner_id'/, `${name}.ts must not scope reads or writes by owner_id`);
  assert.doesNotMatch(text, /\.or\([^)]*owner_id/, `${name}.ts must not scope searches by owner_id`);
}
assert.match(source, /\.update\(op\.patch\)\.eq\('id', op\.id\)\.eq\('org_id', orgId\)/, 'queued updates must target the bound workspace');
assert.match(source, /\.delete\(\)\.eq\('id', op\.id\)\.eq\('org_id', orgId\)/, 'queued deletes must target the bound workspace');
assert.match(casesSource, /from\('cases'\)\.select\('\*'\)\.eq\('org_id', orgId\)/, 'case files must load for the whole workspace');
assert.match(casesSource, /from\('case_contacts'\)\.select\('case_id'\)\.eq\('org_id', orgId\)/, 'case search must cover the whole workspace');
assert.match(businessSource, /from\('case_stage_history'\)\.select\('\*'\)\.eq\('org_id', orgId\)/, 'stage history must load for the whole workspace');
assert.match(businessSource, /from\('case_integrations'\)\.delete\(\)\.eq\('id', id\)\.eq\('org_id', orgId\)/, 'unlinking an external record must target the bound workspace');
assert.match(businessSource, /rpc\('current_org_id'\)/, 'business data must resolve the active workspace, not just the user');

// Global v1/legacy storage is documented but must never be read or merged.
assert.doesNotMatch(source, /AsyncStorage\.(?:getItem|setItem)\((?:CACHE_KEY|QUEUE_KEY|LEGACY_STORAGE_KEY)/);
assert.doesNotMatch(source, /readLegacySnapshot|importLegacySnapshot/);
assert.doesNotMatch(source, /void\s+requeue\(/);

const expectedSignatures = [
  /export async function hydrate\(expectedUserId: string\)/,
  /export async function flushWriteQueue\(expectedUserId: string\)/,
  /export async function pendingWriteCount\(expectedUserId: string\)/,
  /export async function prepareForWorkspaceChange\(expectedUserId: string\)/,
  /export async function bindLocalWorkspace\(expectedUserId: string, orgId: string\)/,
  /export async function persistCache\(snapshot: Snapshot, expectedUserId: string\)/,
  /export async function refreshSnapshot\(expectedUserId: string\)/,
  /export async function createPartner\(partner: Partner, expectedUserId: string\)/,
  /export async function deleteMatchProfile\(matchId: string, expectedUserId: string\)/,
  /export async function assignMatchReferral\(referral: Referral, match: ReferralMatch, expectedUserId: string\)/,
  /export async function logContactActivity\(/,
];
for (const signature of expectedSignatures) assert.match(source, signature);

assert.match(
  source,
  /prepareForWorkspaceChange[\s\S]*flushWriteQueue[\s\S]*readQueueUnlocked[\s\S]*AsyncStorage\.multiRemove/,
  'workspace changes must flush, verify, and clear account-local state before crossing a tenant boundary',
);

// Every AsyncStorage write is in a catch block that converts failure to StoreError.
const writes = [...source.matchAll(/await AsyncStorage\.setItem\([^;]+;/g)];
assert.equal(writes.length, 3, 'unexpected AsyncStorage write path added without durability audit');
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
assert.match(source, /match\.delete/, 'match removal must remain durable while offline');
assert.match(source, /referral_id: null/, 'cyclic match links must be cleared for dependency-safe base inserts');
assert.match(casesSource, /withStableCaseAccount/, 'case operations must reject account transitions');
assert.match(casesSource, /current\.sessionId === expected\.sessionId/, 'case operations must share the stable login-session fence');
assert.match(casesSource, /current\.orgId === expected\.orgId/, 'case operations must reject workspace transitions');
assert.match(authSessionSource, /session_id/, 'session fence must survive token refresh but detect same-user re-login');
assert.match(casesSource, /save_case_document_with_event/, 'documents and timeline events must be transactional');
assert.match(casesSource, /record_case_payment/, 'additional case payments must use the atomic idempotent RPC');
assert.match(casesSource, /update_case_details_with_event/, 'case detail edits must use a field-specific RPC');
assert.match(casesSource, /update_case_payment_with_event/, 'payment corrections must use a locked field-specific RPC');
assert.match(casesSource, /Crypto\.randomUUID\(\)/, 'native IDs must use cryptographically secure UUIDs');
assert.doesNotMatch(casesSource, /Math\.random\(\)/, 'database IDs must not use Math.random');

console.log('store account-scope/durability source invariants: ok');
