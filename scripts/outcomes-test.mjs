// Outcomes loop: src/lib/outcomes.ts run in plain node, no build step.
//
//   (a) the check-in schedule: 7 / 30 / 90 days after admission, today kept,
//       past dates skipped, malformed dates produce nothing
//   (b) the scorecard math on the same fixture as
//       supabase/tests/outcomes_loop_test.sql section E
//   (c) the out-of-network flag reads the directory's insurance networks
//   (d) the app and the offline queue share record_placement_outcome

import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'outcomes-test');
const require = createRequire(import.meta.url);
const ts = require(path.join(repoRoot, 'node_modules', 'typescript'));

function transpileTo(relSrc, outName) {
  const source = readFileSync(path.join(repoRoot, relSrc), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const outPath = path.join(tmpDir, outName);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, js);
  return outPath;
}

mkdirSync(tmpDir, { recursive: true });
transpileTo('src/data.ts', 'data.js');
transpileTo('src/lib/outcomes.ts', 'lib/outcomes.js');

const o = require(path.join(tmpDir, 'lib', 'outcomes.js'));
const { CHECK_IN_OFFSETS_DAYS, checkInSchedule, summarizeOutcomes, median, billsOutOfNetwork, formatRate, formatDays, formatStars } = o;

// ─── (a) the check-in schedule ──────────────────────────────────────────────

assert.deepEqual([...CHECK_IN_OFFSETS_DAYS], [7, 30, 90]);
assert.deepEqual(checkInSchedule('2026-10-01', '2026-10-01'), [
  { days: 7, dueOn: '2026-10-08' },
  { days: 30, dueOn: '2026-10-31' },
  { days: 90, dueOn: '2026-12-30' },
]);
// Forty days back: the 7 and 30 day check-ins are already past.
assert.deepEqual(checkInSchedule('2026-08-22', '2026-10-01'), [{ days: 90, dueOn: '2026-11-20' }]);
// Exactly on the day still counts (the server rule is due_on < CURRENT_DATE).
assert.deepEqual(checkInSchedule('2026-09-24', '2026-10-01').map((item) => item.days), [7, 30, 90]);
assert.deepEqual(checkInSchedule('2026-09-23', '2026-10-01').map((item) => item.days), [30, 90]);
// Month and year boundaries.
assert.deepEqual(checkInSchedule('2026-12-28', '2026-12-28').map((item) => item.dueOn), ['2027-01-04', '2027-01-27', '2027-03-28']);
assert.deepEqual(checkInSchedule('', '2026-10-01'), []);
assert.deepEqual(checkInSchedule('not a date', '2026-10-01'), []);

// ─── (b) the scorecard math ─────────────────────────────────────────────────
// Mirrors outcomes_loop_test.sql section E: three admits (3, 10 and 5 days;
// one completed, one not, one still enrolled), one non-admit, one pending.

const referral = (overrides) => ({
  id: overrides.id, partnerId: 'y', direction: 'Outbound', date: '2026-08-01', clientLabel: overrides.id, outcome: 'Pending', note: '', ...overrides,
});
const fixture = [
  referral({ id: 'r1', admitted: true, admittedOn: '2026-08-04', familyExperience: 5, completed: true, stillEnrolled: false }),
  referral({ id: 'r2', admitted: true, admittedOn: '2026-08-11', familyExperience: 3, completed: false, stillEnrolled: false }),
  referral({ id: 'r3', admitted: true, admittedOn: '2026-08-06', completed: null, stillEnrolled: true }),
  referral({ id: 'r4', admitted: false }),
  referral({ id: 'r5' }),
];
assert.deepEqual(summarizeOutcomes(fixture), {
  placements: 3, decidedPlacements: 2, completed: 1, completionRate: 0.5, medianDaysToAdmit: 5,
  averageFamilyExperience: 4, rated: 2, stillEnrolled: 1,
});
assert.deepEqual(summarizeOutcomes([]), {
  placements: 0, decidedPlacements: 0, completed: 0, completionRate: null, medianDaysToAdmit: null,
  averageFamilyExperience: null, rated: 0, stillEnrolled: 0,
});
// Inbound referrals never count; an admission dated before the referral is ignored for the median.
assert.equal(summarizeOutcomes([referral({ id: 'in', direction: 'Inbound', admitted: true, admittedOn: '2026-08-02', completed: true })]).placements, 0);
assert.equal(summarizeOutcomes([referral({ id: 'bad', admitted: true, admittedOn: '2026-07-01' })]).medianDaysToAdmit, null);
// Even counts take the middle pair: 2, 4, 10 and 20 days out -> (4 + 10) / 2.
assert.equal(summarizeOutcomes([
  referral({ id: 'a', admitted: true, admittedOn: '2026-08-03' }),
  referral({ id: 'b', admitted: true, admittedOn: '2026-08-05' }),
  referral({ id: 'c', admitted: true, admittedOn: '2026-08-11' }),
  referral({ id: 'd', admitted: true, admittedOn: '2026-08-21' }),
]).medianDaysToAdmit, 7);
assert.deepEqual([median([]), median([3, 1, 2]), median([1, 2, 3, 4])], [null, 2, 2.5]);
// A completed placement is not "still enrolled" even if the flag was left on.
assert.equal(summarizeOutcomes([referral({ id: 'x', admitted: true, completed: true, stillEnrolled: true })]).stillEnrolled, 0);

// ─── (c) the out-of-network flag ────────────────────────────────────────────

assert.equal(billsOutOfNetwork({}), null, 'no directory data: unknown');
assert.equal(billsOutOfNetwork({ insuranceNetworks: {} }), null);
assert.equal(billsOutOfNetwork({ insuranceNetworks: { Aetna: ['In-network'] } }), false);
assert.equal(billsOutOfNetwork({ insuranceNetworks: { Aetna: ['In-network'], Cigna: ['In-network', 'Out-of-network'] } }), true);

// Formatting is plain and never invents a number.
assert.deepEqual([formatRate(null), formatRate(0.5), formatRate(0.6667)], ['—', '50%', '67%']);
assert.deepEqual([formatDays(null), formatDays(1), formatDays(5), formatDays(7.5)], ['—', '1 day', '5 days', '7.5 days']);
assert.deepEqual([formatStars(null), formatStars(4), formatStars(4.25)], ['—', '4.0★', '4.3★']);

// ─── (d) one server path ────────────────────────────────────────────────────

const storeSource = readFileSync(path.join(repoRoot, 'src/lib/store.ts'), 'utf8');
const appSource = readFileSync(path.join(repoRoot, 'App.tsx'), 'utf8');
assert.match(storeSource, /rpc\('record_placement_outcome'/, 'the store must record outcomes through record_placement_outcome');
assert.equal((storeSource.match(/rpc\('record_placement_outcome'/g) || []).length, 2, 'the live write and the queue replay both call the RPC');
assert.match(storeSource, /kind: 'referral\.record_outcome'/, 'the outcome write must be queueable offline');
assert.match(appSource, /recordPlacementOutcome\(referralId, patch, completed, activeUserId\)/, 'the outcome sheet saves through the store');
assert.doesNotMatch(appSource, /completeFollowUpWithOutcome\(/, 'the old two-table path is no longer used by the app');
assert.match(appSource, /card\.kind === 'check_in' && card\.referralId/, 'Done on a check-in opens the check-in sheet');
// Nothing family-facing: no rating link, page, or message.
assert.doesNotMatch(appSource, /rate your experience|rating link|RatingLink/i);

console.log('outcomes loop: ok');
unlinkSync(path.join(tmpDir, 'data.js'));
unlinkSync(path.join(tmpDir, 'lib', 'outcomes.js'));
