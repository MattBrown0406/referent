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
assert.match(app, /await readLaunchCopy\(userId\)[\s\S]{0,900}setLoaded\(true\);[\s\S]{0,1400}await hydrate\(userId\);[\s\S]{0,200}if \(changedMeanwhile\(\)\) \{\s*lastServerRefreshAtRef\.current = 0;\s*skippedServerCopy = true;\s*\} else \{[\s\S]{0,260}applySnapshot\(result\.snapshot, !showingSaved \|\| currentMatchFormRef\.current === appliedMatchFormRef\.current\);/,
  'the saved copy shows before hydrate, a newer screen is not overwritten, and the Match form keeps only what was typed');
assert.match(app, /const applyMatchToForm = useCallback\(\(match: ReferralMatch \| null\) => \{\s*appliedMatchFormRef\.current = matchFormSignature\(matchFormValuesFor\(match\)\);/,
  'loading a profile into the form records what was loaded');
assert.match(app, /currentMatchFormRef\.current = matchFormSignature\(\[\s*selectedMatchId, matchClientLabel, matchType, matchState, matchInsurance, matchNetworkPreferences,\s*matchBudget, matchTherapies, matchMustHave, matchPopulation, matchLocationPreference,\s*\]\);/,
  'and the form on screen is compared field for field, in the same order');
assert.match(app, /if \(changedMeanwhile\(\)\) \{\s*skippedServerCopy = true;\s*\} else if \(caseListLoad \|\| !showingSaved\) \{/,
  'a failed case-list read leaves the saved list on screen');
assert.match(app, /afterSheetCloses\(open, \{ ifScreenBusy: 'wait', maxWaits: 1000 \}\)/, 'launch prompts wait for a long-open sheet instead of being dropped');
assert.match(app, /setLoaded\(true\);\s*\/\/ The saved copy shows its waiting changes[\s\S]{0,300}const savedStatus = await syncStatus\(userId\)[\s\S]{0,200}setQueuedWrites\(savedStatus\.pending\);\s*setRejectedWrites\(savedStatus\.waiting \+ savedStatus\.rejected\);/,
  'the badge and banner count the saved copy\'s waiting changes at once');
assert.match(app, /if \(skippedServerCopy \|\| changedMeanwhile\(\)\) \{\s*lastServerRefreshAtRef\.current = 0;\s*scheduleCatchUpRefresh\(\);\s*\} else if \(result\.source === 'remote'\) \{/,
  'a server copy left unshown is read again soon, and never marked as fresh');
assert.ok((app.match(/scheduleCatchUpRefresh\(\);/g) || []).length === 3, 'launch and both skips in refreshFromServer catch up');
assert.match(app, /if \(\(mutationActiveRef\.current \|\| refreshInFlightRef\.current\) && waits < 20\)[\s\S]{0,120}catchUpTriesRef\.current \+= 1;\s*void refreshFromServerRef\.current\?\.\('pull'\)/,
  'the catch-up waits for the save to finish');
assert.match(app, /const scheduleFrom = \(changedMeanwhile\(\) \|\| !caseListLoad\) && latestSnapshotRef\.current\s*\? \{ \.\.\.latestSnapshotRef\.current, cases: latestCasesRef\.current \}/,
  'reminders scheduled at launch come from the screen when something was saved meanwhile');
for (const prompt of ["Alert.alert('Case files unavailable'", "Alert.alert('Notifications unavailable'", "Alert.alert('Could not load account'", 'setWelcomeVisible(true)', 'setNotifPrePromptVisible(true)']) {
  assert.ok(app.includes(`whenScreenClear(() => ${prompt}`), `launch waits for open sheets before: ${prompt}`);
}
assert.match(app, /suggestions\.length > shownSuggestions\.length \? ShowMoreButton\(suggestions\.length - shownSuggestions\.length, 'programs'/,
  'the VOB list counts what it hides, not the limit');
assert.match(app, /setClosedCaseLimit\(LIST_ROWS_SHOWN\);\s*setReferralRowLimit\(LIST_ROWS_SHOWN\);\s*setTodayRowLimits\(/, 'show-more limits reset with the account');

assert.match(store, /export async function readLaunchCopy\(expectedUserId: string\)[\s\S]{0,500}return cached \? overlayPendingOps\(cached, pendingOps\) : null;/,
  'the launch copy carries the changes still pending on this device, and needs a saved copy to show');

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
