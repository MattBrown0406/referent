#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
assert.match(casesSource, /from\('case_contacts'\)\.select\('id, case_id'\)\.eq\('org_id', orgId\)/, 'case search must cover the whole workspace (id is selected so the hits page deterministically)');
assert.match(businessSource, /from\('case_stage_history'\)\.select\('\*'\)\.eq\('org_id', orgId\)/, 'stage history must load for the whole workspace');
assert.match(businessSource, /from\('case_integrations'\)\.delete\(\)\.eq\('id', id\)\.eq\('org_id', orgId\)/, 'unlinking an external record must target the bound workspace');
assert.match(businessSource, /rpc\('current_org_id'\)/, 'business data must resolve the active workspace, not just the user');

// ─── Paging: PostgREST silently truncates any response at max_rows ──────────
// Every list read in the data layer must go through fetchAllPages with
// .range(from, to), so a practice never loses rows past the server cap.
const pagingSource = await readFile(new URL('../src/lib/paging.ts', import.meta.url), 'utf8');
const configToml = await readFile(new URL('../supabase/config.toml', import.meta.url), 'utf8');
const maxRows = Number(/^max_rows\s*=\s*(\d+)/m.exec(configToml)?.[1]);
const pageSize = Number(/export const PAGE_SIZE = (\d+);/.exec(pagingSource)?.[1]);
assert.ok(Number.isFinite(maxRows) && maxRows > 0, 'supabase/config.toml must declare max_rows');
assert.ok(Number.isFinite(pageSize) && pageSize > 0 && pageSize <= maxRows, `PAGE_SIZE (${pageSize}) must not exceed max_rows (${maxRows}) or the loop stops early`);
assert.match(pagingSource, /export const MAX_PAGES = \d+;/, 'paging needs a hard safety ceiling');
assert.match(pagingSource, /throw new StoreError\(/, 'exceeding the paging ceiling must fail loudly, never truncate silently');

const listReadPattern = /supabase\s*\.from\('([^']+)'\)\s*\.select\(/g;
for (const [name, text] of [['store', source], ['cases', casesSource], ['business', businessSource]]) {
  const reads = [...text.matchAll(listReadPattern)];
  assert.ok(reads.length > 0, `${name}.ts should contain list reads`);
  for (const read of reads) {
    const lineStart = text.lastIndexOf('\n', read.index) + 1;
    const lineEnd = text.indexOf('\n', read.index);
    const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    if (/\.(?:single|maybeSingle)\(\)/.test(line)) continue; // single-row read
    assert.ok(
      line.includes('fetchAllPages') && /\.range\(from, to\)/.test(line),
      `${name}.ts reads ${read[1]} without paging (would truncate at max_rows): ${line.trim()}`,
    );
    assert.doesNotMatch(line, /\.limit\(/, `${name}.ts must not cap a paged read of ${read[1]}`);
  }
}
for (const [name, text] of [['store', source], ['cases', casesSource], ['business', businessSource], ['App', await readFile(new URL('../App.tsx', import.meta.url), 'utf8')]]) {
  assert.doesNotMatch(text, /fetchCaseData|CaseFileData/, `${name} must not load every case's timeline up front`);
}

// Today is built from OPEN follow-ups only. They load in full, filtered by
// status and never by count; completed rows are not part of the snapshot.
assert.match(
  source,
  /fetchAllPages<FollowUpRow>\(\(from, to\) => supabase\.from\('follow_ups'\)\.select\('\*'\)\.eq\('status', 'open'\)[^\n]*\.range\(from, to\)\)/,
  'open follow-ups must load in full through the pager',
);
assert.doesNotMatch(source, /from\('follow_ups'\)\.select\('\*'\)\.order\('due_on'/, 'the due_on-ordered unfiltered follow-up read is what truncated the newest open items');
// A partially loaded follow-up list must never re-insert rows the client
// merely has not loaded: only open cached rows are candidates, and each is
// verified against the server by id before an insert is queued.
assert.match(source, /async function mergeUnsyncedLocal\(remote: Snapshot, local: Snapshot \| null\)/);
assert.match(source, /local\.followUps\.filter\(\(row\) => row\.id && row\.status === 'open' && !remoteFollowUpIds\.has\(row\.id\)\)/, 'only open cached follow-ups may be merge candidates');
assert.match(source, /from\('follow_ups'\)\.select\('\*'\)\.in\('id', chunk\)/, 'merge candidates must be verified against the server by id');
assert.match(source, /openCandidates\.filter\(\(row\) => !serverById\.has\(row\.id\)\)/, 'only ids unknown to the server may be queued as inserts');

// Case timelines load per case, on open, never for the whole workspace.
assert.match(casesSource, /export async function fetchCases\(\): Promise<CaseRecord\[\]>/);
assert.match(casesSource, /export async function fetchCaseFile\(caseId: string\): Promise<CaseFile>/);
assert.match(casesSource, /from\('case_events'\)\.select\('\*'\)\.eq\('org_id', orgId\)\.eq\('case_id', caseId\)/, 'case events must be scoped to one case');
assert.doesNotMatch(casesSource, /from\('case_events'\)\.select\('\*'\)\.eq\('org_id', orgId\)\.order/, 'case events must never load for the whole workspace');

// fetchAllPages behavior, run against a fake query builder.
{
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'store-account-test');
  const require = createRequire(import.meta.url);
  const ts = require(path.join(repoRoot, 'node_modules', 'typescript'));
  mkdirSync(tmpDir, { recursive: true });
  for (const [rel, out] of [['src/lib/errors.ts', 'errors.js'], ['src/lib/paging.ts', 'paging.js']]) {
    const js = ts.transpileModule(await readFile(path.join(repoRoot, rel), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true },
    }).outputText;
    writeFileSync(path.join(tmpDir, out), js);
  }
  const { fetchAllPages, PAGE_SIZE } = require(path.join(tmpDir, 'paging.js'));
  const { StoreError } = require(path.join(tmpDir, 'errors.js'));
  const table = (count) => Array.from({ length: count }, (_, index) => ({ id: `row-${index}` }));
  const serve = (rows, calls) => async (from, to) => { calls.push([from, to]); return { data: rows.slice(from, to + 1), error: null }; };

  let calls = [];
  let rows = await fetchAllPages(serve(table(2350), calls));
  assert.equal(rows.length, 2350, 'every row past the first page must be returned');
  assert.deepEqual(calls, [[0, 999], [1000, 1999], [2000, 2999]], 'pages must be contiguous inclusive ranges of PAGE_SIZE');
  assert.equal(PAGE_SIZE, 1000);

  calls = [];
  rows = await fetchAllPages(serve(table(1000), calls));
  assert.equal(rows.length, 1000, 'an exact multiple of the page size must not lose rows');
  assert.deepEqual(calls, [[0, 999], [1000, 1999]], 'a full page must be followed by one more (empty) page');

  calls = [];
  rows = await fetchAllPages(serve(table(0), calls));
  assert.deepEqual(rows, []);
  assert.deepEqual(calls, [[0, 999]]);

  calls = [];
  rows = await fetchAllPages(serve(table(7), calls), { pageSize: 3 });
  assert.deepEqual(rows.map((row) => row.id), table(7).map((row) => row.id));
  assert.deepEqual(calls, [[0, 2], [3, 5], [6, 8]]);

  // A row that shifts across a page boundary (concurrent insert) is not doubled.
  const shifted = table(5);
  // Page 2 re-serves row-2 (an insert landed ahead of it between requests).
  const shiftedServe = async (from) => ({ data: from === 0 ? shifted.slice(0, 3) : from === 3 ? shifted.slice(2, 5) : [], error: null });
  rows = await fetchAllPages(shiftedServe, { pageSize: 3 });
  assert.deepEqual(rows.map((row) => row.id), ['row-0', 'row-1', 'row-2', 'row-3', 'row-4']);

  // Rows without an id (views) can supply their own key.
  rows = await fetchAllPages(serve([{ partner_id: 'a' }, { partner_id: 'b' }], []), { keyOf: (row) => row.partner_id });
  assert.equal(rows.length, 2);

  // PostgREST errors are rethrown as-is so network classification still works.
  const failure = { message: 'TypeError: Network request failed', code: '' };
  await assert.rejects(fetchAllPages(async () => ({ data: null, error: failure })), (error) => error === failure);

  // The ceiling fails loudly instead of looping or truncating.
  calls = [];
  await assert.rejects(
    fetchAllPages(async (from, to) => { calls.push([from, to]); return { data: table(2), error: null }; }, { pageSize: 2, maxPages: 4 }),
    (error) => error instanceof StoreError && /more than 8 rows/.test(error.message),
  );
  assert.equal(calls.length, 4, 'the ceiling must stop the loop after maxPages requests');
}

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
