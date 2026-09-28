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
  assert.doesNotMatch(text, /fetchCaseData|CaseFileData|fetchCaseContacts/, `${name} must not load every case's timeline up front`);
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

// The case list and every case contact load workspace-wide (each case card
// shows the family's primary name and phone without opening the file).
// Timelines and documents load per case, on open, never for the whole workspace.
const appSource = await readFile(new URL('../App.tsx', import.meta.url), 'utf8');
assert.match(casesSource, /export async function fetchCaseList\(\): Promise<CaseList>/);
assert.match(casesSource, /from\('case_contacts'\)\.select\('\*'\)\.eq\('org_id', orgId\)\.order\('created_at'/, 'case contacts must load for the whole workspace, not per case');
assert.doesNotMatch(casesSource, /from\('case_contacts'\)\.select\('\*'\)\.eq\('org_id', orgId\)\.eq\('case_id'/, 'case contacts must not be lazy per case');
assert.match(appSource, /const \[allCaseContacts, setAllCaseContacts\] = useState<CaseContact\[\]>\(\[\]\)/, 'App must keep the workspace-wide contact list');
assert.match(appSource, /const primary = allCaseContacts\.find\(\(item\) => item\.caseId === record\.id && item\.isPrimary\)/, 'case cards must read the primary contact from the workspace-wide list');
assert.match(appSource, /setAllCaseContacts\(activeContacts\)/, 'hydration must store the workspace-wide contacts');
assert.match(appSource, /setAllCaseContacts\(caseLoad\.list\.contacts\)/, 'foreground refresh must store the workspace-wide contacts');
assert.match(casesSource, /export async function fetchCaseFile\(caseId: string\): Promise<CaseFile>/);
assert.match(casesSource, /from\('case_events'\)\.select\('\*'\)\.eq\('org_id', orgId\)\.eq\('case_id', caseId\)/, 'case events must be scoped to one case');
assert.doesNotMatch(casesSource, /from\('case_events'\)\.select\('\*'\)\.eq\('org_id', orgId\)\.order/, 'case events must never load for the whole workspace');

// ─── Offline case files: saved copies, never re-uploaded ────────────────────
// The case list + every contact and the files the user opened are cached
// under the same account key and workspace binding as the snapshot, so an
// interventionist with no signal still has the family's numbers and the
// timeline. Case writes stay online-only (cases.ts), so nothing cached here
// may ever be treated as an unsynced local row.
const caseCacheSource = await readFile(new URL('../src/lib/case-cache.ts', import.meta.url), 'utf8');
for (const text of [
  "const CASE_LIST_KEY_PREFIX = 'referralfit-case-list-v1:'",
  "const CASE_FILE_INDEX_KEY_PREFIX = 'referralfit-case-file-index-v1:'",
  "const CASE_FILE_KEY_PREFIX = 'referralfit-case-file-v1:'",
  'export async function loadCaseList(expectedUserId: string): Promise<CaseListLoad>',
  'export async function loadCaseFile(expectedUserId: string, caseId: string): Promise<CaseFileLoad>',
  'export async function persistCaseList(list: CaseList, expectedUserId: string)',
  'export async function persistCaseFile(caseId: string, file: CaseFile, expectedUserId: string)',
]) assert.ok(source.includes(text), `missing case cache invariant: ${text}`);
// Cache fallback only for a lost connection; server and session errors surface.
assert.match(source, /remote = await fetchCaseList\(\);\s*\} catch \(error\) \{\s*if \(!isNetworkError\(error\)\) throw error;/, 'the case list must fall back to the saved copy only on a network error');
assert.match(source, /remote = await fetchCaseFile\(caseId\);\s*\} catch \(error\) \{\s*if \(!isNetworkError\(error\)\) throw error;/, 'a case file must fall back to the saved copy only on a network error');
// Same account fence and workspace wipe as the snapshot cache.
assert.match(source, /export async function persistCaseList\([^)]*\)[^{]*\{[\s\S]{0,200}await assertWorkspaceFence\(fence\);[\s\S]{0,200}writeCaseListCacheUnlocked\(/, 'saving the case list must verify the bound workspace like persistCache');
assert.match(source, /export async function persistCaseFile\([^)]*\)[^{]*\{[\s\S]{0,200}await assertWorkspaceFence\(fence\);[\s\S]{0,200}writeCaseFileCacheUnlocked\(/, 'saving a case file must verify the bound workspace like persistCache');
assert.match(source, /async function caseCacheKeys\(userId: string\)/);
assert.match(source, /AsyncStorage\.getAllKeys\(\)/, 'a workspace wipe must find every saved case file, even ones the index lost');
for (const wipe of source.match(/AsyncStorage\.multiRemove\(\[[\s\S]*?\]\)/g) || []) {
  if (!wipe.includes('CACHE_KEY_PREFIX')) continue; // eviction removes individual saved files only
  assert.ok(wipe.includes('...await caseCacheKeys(fence.userId)'), `snapshot cache wipe must also wipe the case cache: ${wipe}`);
}
assert.match(source, /if \(envelope\.version !== 2 \|\| envelope\.userId\?\.toLowerCase\(\) !== fence\.userId\) return null;/);
assert.match(caseCacheSource, /value\.userId\.toLowerCase\(\) === userId\.toLowerCase\(\)/, 'saved case copies must be validated against the account that reads them');
// Never merged, never queued, never read from a case table by store.ts.
assert.doesNotMatch(source, /from\('(?:cases|case_contacts|case_events|case_documents)'\)/, 'store.ts must not read or write case tables itself');
assert.doesNotMatch(source, /kind: 'case(?:s|_contact|_event|_document)?\.(?:insert|update|delete)'/, 'no queued write may target a case table');
assert.doesNotMatch(source, /'case\.(?:insert|update|delete)'/, 'no queued write may target a case table');
const mergeStart = source.indexOf('async function mergeUnsyncedLocal(');
const mergeEnd = source.indexOf('\n}\n', mergeStart);
const mergeBody = source.slice(mergeStart, mergeEnd);
assert.ok(mergeStart > 0 && mergeEnd > mergeStart);
assert.doesNotMatch(mergeBody, /case/i, 'mergeUnsyncedLocal must not touch case data (cases have no offline insert path)');
assert.doesNotMatch(mergeBody, /CaseList|CaseFile|CachedCase/, 'mergeUnsyncedLocal must not see the case cache');
for (const call of source.match(/mergeUnsyncedLocal\((?!remote: Snapshot)[^)]*\)/g) || []) {
  assert.equal(call, 'mergeUnsyncedLocal(remote, latestLocal)', `merge input must be the Snapshot cache only: ${call}`);
}
const snapshotType = source.slice(source.indexOf('export type Snapshot = {'), source.indexOf('};', source.indexOf('export type Snapshot = {')));
assert.doesNotMatch(snapshotType, /case/i, 'cases must stay out of the merged Snapshot');
// An offline launch must reach the caches at all: the server-side workspace
// lookup that opens hydration falls back to the binding last verified on this
// device, and only for a lost connection.
assert.match(source, /export async function readBoundWorkspace\(expectedUserId: string\): Promise<string \| null>/);
assert.match(source, /return stored && isUuid\(stored\) \? stored\.toLowerCase\(\) : null;/);
assert.match(appSource, /orgId = await fetchCurrentOrgId\(\);\s*\} catch \(error\) \{\s*if \(!isNetworkError\(error\)\) throw error;\s*const bound = await readBoundWorkspace\(userId\);\s*if \(!bound\) throw error;\s*orgId = bound;/, 'hydration must survive an offline workspace lookup using the last verified binding');
// The App renders the saved copy instead of a blocking alert whenever one exists.
assert.match(appSource, /const load = await loadCaseList\(userId\);[\s\S]{0,400}Alert\.alert\('Case files unavailable'/, 'hydration must load the case list through the cache-aware loader');
assert.match(appSource, /setCaseListSource\(caseListLoad\)/);
assert.match(appSource, /loadCaseFile\(userId, caseId\)[\s\S]{0,600}source: 'unavailable'/, 'opening a case must use the cache-aware loader and mark a missing copy');
assert.match(appSource, /renderSavedCopyNotice\(caseFileSource, 'case file'\)/, 'a cached case file must say it is a saved copy');
assert.match(appSource, /renderSavedCopyNotice\(caseListSource, 'case list'\)/, 'a cached case list must say it is a saved copy');
assert.match(appSource, /Showing saved copy from \$\{relativeActivity\(copy\.savedAt\)/);
assert.match(appSource, /Opening a document needs a connection\./);
assert.match(appSource, /if \(isNetworkError\(error\)\) \{\s*Alert\.alert\('Connection needed'/, 'opening a document offline must explain the signed-link requirement');
// The saved copies follow what is on screen, but a cache-sourced copy is never written back.
assert.match(appSource, /if \(!caseListSource \|\| caseListSource\.source !== 'remote'\) return;\s*void persistCaseList\(\{ cases, contacts: allCaseContacts \}, caseListSource\.userId\)/);
assert.match(appSource, /if \(!activeCaseId \|\| !caseFileSource \|\| caseFileSource\.source !== 'remote'\) return;\s*void persistCaseFile\(activeCaseId, \{ events: caseEvents, documents: caseDocuments \}, caseFileSource\.userId\)/);
// Today's call/text from a case card reads the in-memory contact list, which
// the cached case list now feeds on an offline launch.
assert.match(appSource, /const contacts = allCaseContacts\.filter\(\(item\) => item\.caseId === card\.caseId && item\.phone\.trim\(\)\)/);

// ─── Pull-to-refresh + debounced foreground refresh ─────────────────────────
for (const screen of ['HomeScreen', 'CasesScreen', 'DirectoryScreen', 'ReferralsScreen']) {
  const start = appSource.indexOf(`function ${screen}() {`);
  assert.ok(start > 0, `${screen} missing`);
  const firstScrollView = appSource.indexOf('<ScrollView', start);
  const tagEnd = appSource.indexOf('>', firstScrollView);
  const openingTag = appSource.slice(firstScrollView, tagEnd);
  assert.ok(openingTag.includes('refreshControl={renderRefreshControl()}'), `${screen} list must support pull-to-refresh: ${openingTag}`);
}
assert.match(appSource, /<RefreshControl refreshing=\{pullRefreshing\} onRefresh=\{\(\) => \{ void pullToRefresh\(\); \}\}/);
assert.match(appSource, /const outcome = await refreshFromServer\('pull'\);\s*if \(outcome === 'offline'\) setRefreshNotice\(/, 'a pull with no connection must leave an inline notice, not an alert');
assert.match(appSource, /\} finally \{\s*setPullRefreshing\(false\);/, 'the spinner must stop on every outcome');
assert.match(appSource, /const FOREGROUND_REFRESH_MIN_INTERVAL_MS = 30_000;/);
assert.match(appSource, /if \(trigger === 'foreground' && Date\.now\(\) - lastServerRefreshAtRef\.current < FOREGROUND_REFRESH_MIN_INTERVAL_MS\) return 'ok';/, 'foreground refresh must be debounced');
assert.match(appSource, /if \(refreshInFlightRef\.current\) return refreshInFlightRef\.current;/, 'concurrent refreshes must coalesce');
// Unconditional and in order: flush, then snapshot, then cases, then the open file.
assert.match(appSource, /await flushWriteQueue\(userId\);[\s\S]{0,300}const refreshed = await refreshSnapshot\(userId\);[\s\S]{0,400}const caseLoad = await loadCaseList\(userId\);[\s\S]{0,1200}const fileLoad = await loadCaseFile\(userId, activeCaseId\);/, 'refresh must keep flush → snapshot → cases → open file');
assert.doesNotMatch(appSource, /if \(flushed > 0\) \{\s*refreshed = await refreshSnapshot/, 'foreground refresh must no longer depend on a flushed write');
assert.match(appSource, /await refreshFromServer\('foreground'\);/);
assert.match(appSource, /if \(stillCurrent\(\) && !isNetworkError\(error\)\) Alert\.alert\('Sync issue'/, 'a foreground return with no connection must not alert');

// Bounds + LRU eviction of saved case files, run against the real helpers.
{
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'store-account-test');
  const require = createRequire(import.meta.url);
  const ts = require(path.join(repoRoot, 'node_modules', 'typescript'));
  mkdirSync(tmpDir, { recursive: true });
  const js = ts.transpileModule(caseCacheSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true },
  }).outputText;
  writeFileSync(path.join(tmpDir, 'case-cache.js'), js);
  const cache = require(path.join(tmpDir, 'case-cache.js'));
  assert.equal(cache.MAX_CACHED_CASE_FILES, 25);
  assert.equal(cache.MAX_CACHED_EVENTS_PER_FILE, 200);

  let index = [];
  let evictedAll = [];
  for (let n = 0; n < 30; n += 1) {
    const next = cache.touchCaseFileIndex(index, `case-${n}`, `2026-09-28T00:00:${String(n).padStart(2, '0')}Z`);
    index = next.entries;
    evictedAll.push(...next.evicted);
  }
  assert.equal(index.length, 25, 'the index must never exceed the bound');
  assert.deepEqual(evictedAll, ['case-0', 'case-1', 'case-2', 'case-3', 'case-4'], 'the least recently saved files are evicted first');
  const bumped = cache.touchCaseFileIndex(index, 'case-5', '2026-09-28T01:00:00Z');
  assert.deepEqual(bumped.evicted, [], 're-saving a cached file must not evict anything');
  assert.equal(bumped.entries[bumped.entries.length - 1].caseId, 'case-5', 're-saving moves the file to most recent');
  assert.equal(bumped.entries.filter((entry) => entry.caseId === 'case-5').length, 1);
  const afterBump = cache.touchCaseFileIndex(bumped.entries, 'case-99', '2026-09-28T02:00:00Z');
  assert.deepEqual(afterBump.evicted, ['case-6'], 'the bumped file is no longer the eviction candidate');
  assert.deepEqual(cache.touchCaseFileIndex([], 'only', 'now', 0).entries.map((entry) => entry.caseId), ['only'], 'a zero limit still keeps the file just saved');

  const events = Array.from({ length: 250 }, (_, i) => ({ id: `e-${i}`, caseId: 'c', kind: 'note', body: '', occurredAt: `2026-01-01T00:00:00.${String(i).padStart(3, '0')}Z` }));
  const bounded = cache.boundCaseFile({ events, documents: [{ id: 'd' }] });
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.file.events.length, 200);
  assert.equal(bounded.file.events[0].id, 'e-249', 'the newest entries are kept');
  assert.equal(bounded.file.events[199].id, 'e-50');
  assert.deepEqual(bounded.file.documents, [{ id: 'd' }], 'document metadata is never truncated');
  assert.equal(cache.boundCaseFile({ events: events.slice(0, 200), documents: [] }).truncated, false);

  const user = 'ab5c6f7e-1111-4222-8333-444455556666';
  const file = cache.makeCaseFileEnvelope(user, 'c1', { events, documents: [] }, '2026-09-28T00:00:00Z');
  assert.equal(file.truncated, true);
  assert.equal(file.events.length, 200);
  const parsedFile = cache.parseCachedCaseFile(JSON.parse(JSON.stringify(file)), user.toUpperCase(), 'C1');
  assert.ok(parsedFile && parsedFile.truncated && parsedFile.file.events.length === 200, 'a saved file round-trips with its bound flag');
  assert.equal(cache.parseCachedCaseFile(file, 'ffffffff-1111-4222-8333-444455556666', 'c1'), null, 'another account must not read a saved file');
  assert.equal(cache.parseCachedCaseFile(file, user, 'c2'), null, 'a saved file is bound to its case id');
  assert.equal(cache.parseCachedCaseFile({ ...file, version: 2 }, user, 'c1'), null, 'unknown versions are ignored');
  const list = cache.makeCaseListEnvelope(user, { cases: [{ id: 'c1' }], contacts: [{ id: 'k1', caseId: 'c1' }] }, '2026-09-28T00:00:00Z');
  const parsedList = cache.parseCachedCaseList(JSON.parse(JSON.stringify(list)), user);
  assert.deepEqual(parsedList, { savedAt: '2026-09-28T00:00:00Z', list: { cases: [{ id: 'c1' }], contacts: [{ id: 'k1', caseId: 'c1' }] } });
  assert.equal(cache.parseCachedCaseList({ ...list, userId: 'someone-else' }, user), null);
  assert.equal(cache.parseCachedCaseList({ ...list, contacts: 'nope' }, user), null, 'a list without contacts is not a usable copy');
  assert.deepEqual(cache.parseCaseFileIndex({ version: 1, userId: user, entries: [{ caseId: 'c1', savedAt: 'x' }, { bogus: true }, null] }, user), [{ caseId: 'c1', savedAt: 'x' }], 'a damaged index keeps only valid entries');
  assert.deepEqual(cache.parseCaseFileIndex('garbage', user), []);
}

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
const writes = [...source.matchAll(/await AsyncStorage\.(?:setItem|multiSet)\([^;]+;/g)];
assert.equal(writes.length, 5, 'unexpected AsyncStorage write path added without durability audit');
for (const write of writes) {
  const following = source.slice(write.index, write.index + 520);
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

// Seed-org auto-publish (20260928120000_auto_publish_admin_directory.sql):
// the partner write paths must stay plain inserts/updates so the database
// triggers see them, and the snapshot refresh must select every column so the
// new global_partner_id link is picked up without a client change.
const seedMigration = await readFile(
  new URL('../supabase/migrations/20260928120000_auto_publish_admin_directory.sql', import.meta.url),
  'utf8',
);
for (const trigger of ['partners_seed_publish_insert', 'partners_seed_publish_update', 'partners_seed_publish_delete']) {
  assert.match(seedMigration, new RegExp(`CREATE TRIGGER ${trigger}\\b`), `seed auto-publish migration must define ${trigger}`);
}
assert.match(seedMigration, /FUNCTION public\.publish_partner_to_global\(p_partner_id uuid\)/, 'seed auto-publish migration must define the publish function');
assert.doesNotMatch(source, /global_listing_status/, 'partner write paths must not filter on or depend on global_listing_status');
assert.match(source, /supabase\.from\('partners'\)\.select\('\*'\)/, 'snapshot refresh must select every partners column so directory links sync');

console.log('store account-scope/durability source invariants: ok');
