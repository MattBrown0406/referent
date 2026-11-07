// A large practice (thousands of partners, cases and referrals): the source
// shapes that keep it correct and quick. Behaviour is covered elsewhere (the
// touch window in offline-sync-test, the dashboard's timing in business-test,
// skipped reminder re-applies in notifications-test); these keep the rest from
// drifting back.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(repoRoot, file), 'utf8');
const app = read('App.tsx');
const store = read('src/lib/store.ts');
const cases = read('src/lib/cases.ts');
const directory = read('src/lib/directory.ts');
const credentials = read('src/lib/credentials.ts');

// PostgREST cuts every response at 1000 rows, set-returning functions too:
// a list function is paged or asked in small chunks, never read in one call.
assert.match(cases, /fetchAllPages<PlanRow>\(\s*\(from, to\) => supabase\.rpc\('partners_for_plan'[^)]*\)\s*\.order\('organization'\)\.order\('partner_id'\)\.range\(from, to\)/,
  'partners_for_plan is paged in its own order (past 1,000 partners, "takes this plan" lost the rest)');
assert.match(directory, /const LISTING_BEDS_CHUNK = 500;[\s\S]{0,700}rpc\('fetch_listing_beds', \{ p_ids: unique\.slice\(start, start \+ LISTING_BEDS_CHUNK\) \}\)/,
  'fetch_listing_beds is asked in chunks of 500 listings');
assert.match(credentials, /fetchAllPages<unknown>\(\(from, to\) => supabase\.rpc\('fetch_listing_credentials', \{ p_ids: chunk \}\)\.order\('id'\)\.range\(from, to\)\)/,
  'fetch_listing_credentials is paged within each chunk');

// Launch: a returning user sees the saved copy first; the server copy
// replaces it only if nothing was saved meanwhile.
assert.match(app, /await readLaunchCopy\(userId\)[\s\S]{0,900}setLoaded\(true\);[\s\S]{0,600}await hydrate\(userId\);[\s\S]{0,200}if \(changedMeanwhile\(\)\) lastServerRefreshAtRef\.current = 0;\s*else applySnapshot\(result\.snapshot\);/,
  'the saved copy shows before hydrate, and a newer screen is not overwritten');
assert.match(app, /if \(!changedMeanwhile\(\)\) \{\s*setCases\(activeCaseList\);/, 'the case list read at launch does not overwrite a newer screen either');
assert.match(store, /export async function readLaunchCopy\(expectedUserId: string\)[\s\S]{0,200}readCacheWithPending\(fence\)/, 'the launch copy carries the changes still pending on this device');

// Touches: a year at most, on the server read and in the saved copy.
assert.match(store, /supabase\.from\('touches'\)\.select\('\*'\)\.gte\('occurred_at', windowStart\)/, 'touches load for the window only');
assert.match(store, /const localTouches = local\.touches\.filter\(\(touch\) => inTouchWindow\(touch\.occurredAt, windowStart\)/, 'the saved copy keeps the same window');
// Cache reads after a write come from memory, not a re-parse of the whole copy.
assert.match(store, /if \(lastCacheWrite && lastCacheWrite\.userId === fence\.userId\) return lastCacheWrite\.snapshot;/, 'readCacheUnlocked serves the last write');

// Long lists render what is on screen, or a page and "Show more".
assert.match(app, /function DirectoryScreen\(\)[\s\S]{0,4500}<FlatList\s+data=\{directoryPartners\}/, 'the Directory is a FlatList');
assert.match(app, /closedCases\.slice\(0, closedCaseLimit\)/, 'closed cases show a page at a time');
assert.match(app, /filteredReferrals\.slice\(0, referralRowLimit\)/, 'referral history shows a page at a time');
for (const section of ['overdue', 'today', 'partnersDue']) {
  assert.match(app, new RegExp(`todaySections\\.${section}\\.slice\\(0, todayRowLimits\\.${section}\\)`), `Today's ${section} shows a page at a time`);
}
assert.match(app, /suggestions\.filter\(\(item, index\) => index < vobRowLimit \|\| item\.partnerId === vobForm\.partnerId\)/, 'the VOB program list shows a page, plus the chosen one');
assert.match(app, /<FlatList\s+horizontal\s+data=\{partners\.slice\(\)\.sort\(/, 'the referral form partner picker is virtualized');

// Lookups by id, not a scan of the whole list per row.
assert.ok(!/allCaseContacts\.find\(\(item\) => item\.caseId === record\.id/.test(app), 'case cards find their contact by map');
assert.ok(!/planStatuses\[key\]\?\.find\(/.test(app) && !/directoryPlanStatuses\?\.find\(/.test(app), 'plan answers are looked up by partner');
assert.match(app, /const planStatusIndex = useMemo\(/);
assert.match(app, /const primaryContactByCase = useMemo\(/);

console.log('large-practice-test: all checks passed');
