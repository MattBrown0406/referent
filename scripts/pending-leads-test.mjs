#!/usr/bin/env node
// Unsaved leads kept on the device (src/lib/pending-leads.ts): what is
// stored, what is read back, what is retried quietly and with which ids,
// and the App.tsx / store.ts wiring that keeps a lead until the server has it.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'pending-leads-test');
const require = createRequire(import.meta.url);
const ts = require(path.join(repoRoot, 'node_modules', 'typescript'));
mkdirSync(tmpDir, { recursive: true });

const source = readFileSync(path.join(repoRoot, 'src/lib/pending-leads.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
writeFileSync(path.join(tmpDir, 'pending-leads.js'), js);
const pending = require(path.join(tmpDir, 'pending-leads.js'));
const appSource = readFileSync(path.join(repoRoot, 'App.tsx'), 'utf8');
const storeSource = readFileSync(path.join(repoRoot, 'src/lib/store.ts'), 'utf8');

assert.doesNotMatch(js, /require\("(react|react-native|@react-native-async-storage\/async-storage)"\)/, 'the module is pure (type imports only)');

const USER = 'AAAAAAAA-1111-4111-8111-111111111111';
const ORG = 'bbbbbbbb-2222-4222-8222-222222222222';
const id = (n) => `0000000${n}-0000-4000-8000-00000000000${n}`;
function lead(n, overrides = {}) {
  return {
    ids: { caseId: id(n), contactId: id(n + 1), followUpId: id(n + 2) },
    draft: { callerName: `Caller ${n}`, phone: '5550102000', email: '', aboutRelationship: 'son', aboutFirstName: 'Jake', leadSource: 'Inbound call', urgency: 'none' },
    message: 'The lead did not reach the server (no connection).',
    retryable: true,
    orgId: ORG,
    capturedAt: `2026-11-26T1${n}:00:00.000Z`,
    dueOn: '2026-11-26',
    dueTime: '14:25',
    ...overrides,
  };
}

// ─── Key ────────────────────────────────────────────────────────────────────
assert.equal(pending.pendingLeadsKey(USER), `referralfit-pending-leads-v1:${USER.toLowerCase()}`, 'one key per account, lowercased');
assert.match(storeSource, /const PENDING_LEADS_KEY_PREFIX = 'referralfit-pending-leads-v1:';/, 'store.ts uses the same prefix');
assert.equal(pending.PENDING_LEADS_KEY_PREFIX, 'referralfit-pending-leads-v1:');

// ─── Round trip ─────────────────────────────────────────────────────────────
const a = lead(1);
const b = lead(4, { retryable: false, message: 'The lead was not saved: phone is invalid', dueTime: null });
const raw = pending.serializePendingLeads([a, b]);
assert.deepEqual(pending.parsePendingLeads(raw), [a, b], 'what is written is what is read back');
assert.deepEqual(JSON.parse(raw).version, 1);
assert.equal(JSON.parse(raw).entries.length, 2, '{ entries } so store.ts counts each as one unsent change');

// ─── Damaged storage never loses the readable leads ─────────────────────────
assert.deepEqual(pending.parsePendingLeads(null), []);
assert.deepEqual(pending.parsePendingLeads('not json'), []);
assert.deepEqual(pending.parsePendingLeads('{"entries": 3}'), []);
const mixed = JSON.stringify({ version: 1, entries: [a, { ids: { caseId: 'nope' } }, null, { ...a }, b] });
assert.deepEqual(pending.parsePendingLeads(mixed).map((item) => item.ids.caseId), [a.ids.caseId, b.ids.caseId], 'a bad entry is dropped, a duplicate appears once, the rest survive');
const odd = pending.parsePendingLeads(JSON.stringify({ entries: [{ ...a, draft: { ...a.draft, urgency: 'whatever' }, dueOn: 'tomorrow', dueTime: '2pm', retryable: 'yes' }] }))[0];
assert.equal(odd.draft.urgency, 'none', 'an unknown urgency is read as none');
assert.equal(odd.dueOn, '', 'a bad due day is dropped (the retry uses today)');
assert.equal(odd.dueTime, null);
assert.equal(odd.retryable, true, 'only an explicit false means refused');

// ─── Merge ──────────────────────────────────────────────────────────────────
const updatedA = { ...a, message: 'newer message' };
assert.deepEqual(pending.mergePendingLeads([updatedA], [b, a]).map((item) => [item.ids.caseId, item.message]), [[a.ids.caseId, 'newer message'], [b.ids.caseId, b.message]], 'one per lead, the on-screen copy wins, oldest first');

// ─── Quiet retries ──────────────────────────────────────────────────────────
const otherOrg = lead(7, { orgId: 'cccccccc-3333-4333-8333-333333333333' });
assert.deepEqual(
  pending.leadsToRetryQuietly([a, b, otherOrg], ORG.toUpperCase(), null).map((item) => item.ids.caseId),
  [a.ids.caseId],
  'only connection failures, only in the workspace they were taken in',
);
assert.deepEqual(pending.leadsToRetryQuietly([a], ORG, a), [], 'never the lead open in the sheet');
const input = pending.pendingLeadInput(a, '2026-11-27');
assert.deepEqual([input.caseId, input.contactId, input.followUpId], [a.ids.caseId, a.ids.contactId, a.ids.followUpId], 'the SAME ids every time: create_lead treats a repeat as success, so no duplicate lead');
assert.deepEqual([input.dueOn, input.dueTime], ['2026-11-26', '14:25'], 'the original first-call clock');
assert.deepEqual([pending.pendingLeadInput({ ...a, dueOn: '' }, '2026-11-27').dueOn, pending.pendingLeadInput({ ...a, dueOn: '' }, '2026-11-27').dueTime], ['2026-11-27', null], 'no stored day: today, untimed');
assert.equal(pending.pendingLeadLabel(a), 'Caller 1 — about Jake');
assert.equal(pending.pendingLeadLabel({ ...a, draft: { ...a.draft, aboutFirstName: ' ' } }), 'Caller 1');

// ─── App.tsx wiring ─────────────────────────────────────────────────────────
const leadBody = appSource.slice(appSource.indexOf('function saveNewLead(draft: NewLeadDraft)'), appSource.indexOf('function openNewLeadSheet()'));
assert.match(leadBody, /void writePendingLeadCopy\(leadUserId, pendingCopy\);\s*void settleOptimisticWrite\(/, 'the lead is on the device before the save is sent');
assert.match(leadBody, /\)\.then\(\(saved\) => \{\s*inFlightPendingLeadsRef\.current\.delete\(ids\.caseId\);[\s\S]{0,300}void persistPendingLeads\(leadUserId\);/, 'the device copy is rewritten (removed when saved) once the server answers');
assert.match(leadBody, /const capturedAt = retrying\?\.capturedAt \?\? nowIso;/, 'a retry keeps when the lead was taken');
assert.match(appSource, /async function loadPendingLeads\(userId: string\)[\s\S]{0,600}pendingLeadsLoadedForRef\.current = userId;[\s\S]{0,200}mergePendingLeads\(leadRetriesRef\.current, stored\)/, 'launch reads the stored leads back into the waiting list');
assert.match(appSource, /activeOrgIdRef\.current = orgId;[\s\S]{0,300}await loadPendingLeads\(userId\);/, 'they are read once the workspace is known, at launch');
assert.match(appSource, /if \(!userId \|\| pendingLeadsLoadedForRef\.current !== userId \|\| activeUserIdRef\.current !== userId\) return;/, 'nothing is written before the stored leads are read (an empty screen never wipes them)');
assert.match(appSource, /pendingLeadsLoadedForRef\.current = null;\s*leadRetriesRef\.current = \[\];/, 'an account change stops writes for the old account and keeps its copy');
const retryBody = appSource.slice(appSource.indexOf('async function retryPendingLeadsQuietly()'), appSource.indexOf('// When to try:'));
assert.match(retryBody, /await createLead\(pendingLeadInput\(lead, localDateStamp\(\)\), userId\);/, 'a quiet retry sends the kept ids through create_lead');
assert.match(retryBody, /if \(!waiting\.length \|\| mutationActiveRef\.current\) return;/, 'never while another save holds the slot');
assert.match(retryBody, /mutationActiveRef\.current = token;[\s\S]*if \(mutationActiveRef\.current === token\) mutationActiveRef\.current = null;/, 'a quiet retry holds the one save slot while it runs');
assert.match(retryBody, /if \(isRetryable\(error\)\) break;/, 'still offline: stop and wait for the next try');
assert.match(retryBody, /retryable: false, message: leadRetryMessage\(false, error\)/, 'a refusal stays visible with its reason');
assert.match(appSource, /AppState\.addEventListener\('change', \(state\) => \{\s*if \(state === 'active'\) void retryPendingLeadsQuietly\(\);/, 'retried on return to the foreground');
assert.match(appSource, /if \(!offline\) void retryPendingLeadsQuietly\(\);/, 'retried when the connection comes back');
assert.match(appSource, /if \(AppState\.currentState === 'active'\) void retryPendingLeadsQuietly\(\);\s*\}, 30000\);/, 'and every 30 seconds while one waits');
assert.match(appSource, /⏳ LEADS NOT SAVED YET/, 'Today shows each unsaved lead');

// ─── store.ts: account data like the write queue ────────────────────────────
assert.match(storeSource, /const ACCOUNT_DATA_PREFIXES = \[[\s\S]{0,300}PENDING_LEADS_KEY_PREFIX,\s*\];/, 'the web wipe removes them with the rest of the account');
assert.match(storeSource, /\[QUEUE_KEY_PREFIX, REJECTED_KEY_PREFIX, UNREADABLE_KEY_PREFIX, PENDING_LEADS_KEY_PREFIX\]\.some/, '...and counts them as unsent');
assert.match(storeSource, /pendingLeadCount = storedChangeCount\(await AsyncStorage\.getItem\(accountStorageKey\(PENDING_LEADS_KEY_PREFIX, fence\.userId\)\)\);/, 'joining another workspace is refused while a lead is unsaved');
const forget = storeSource.slice(storeSource.indexOf('export async function forgetWorkspaceBinding('), storeSource.indexOf('export async function forgetWorkspaceBinding(') + 900);
assert.match(forget, /accountStorageKey\(PENDING_LEADS_KEY_PREFIX, fence\.userId\)/, 'a deleted account leaves none behind');

console.log('pending lead storage/retry checks: ok');
