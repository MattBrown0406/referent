// Insurance workflow: src/lib/insurance.ts run in plain node, no build step.
//
//   (a) the plan classification mirrors partners_for_plan(): explicit entry
//       wins, listed-only counts as in-network, anything else is unknown
//   (b) the honest label: "per program" until a VOB on the case says otherwise,
//       and the partner's data is never touched
//   (c) the member id keeps the last four only
//   (d) the chase follow-up lands on the next business day
//   (e) the Business median: same fixture as insurance_workflow_test.sql G
//   (f) the dashboard carries the VOB tile through computeBusinessDashboard

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'insurance-test');
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
transpileTo('src/lib/insurance.ts', 'lib/insurance.js');

const ins = require(path.join(tmpDir, 'lib', 'insurance.js'));
const {
  planNetworkStatusForPartner, planStatusLine, latestAnsweredVob, sortPlanStatuses,
  memberIdLast4, nextBusinessDay, summarizeVobTurnaround, formatTurnaroundDays,
  vobStatusLabel, isVobAnswered, VOB_STATUSES, vobChaseTitle,
} = ins;

// ─── (a) classification ─────────────────────────────────────────────────────

const X = { insurance: ['Aetna', 'Cigna'], insuranceNetworks: { Aetna: ['In-network'], Cigna: ['Out-of-network'] } };
const Y = { insurance: ['Aetna', 'Cigna'], insuranceNetworks: { Cigna: ['In-network'] } };
const V = { insurance: [], insuranceNetworks: {} };
const both = { insurance: ['Aetna'], insuranceNetworks: { Aetna: ['In-network', 'Out-of-network'] } };

assert.equal(planNetworkStatusForPartner(X, 'Aetna'), 'in_network', 'explicit in-network entry');
assert.equal(planNetworkStatusForPartner(X, 'Cigna'), 'out_of_network', 'explicit out-of-network entry');
assert.equal(planNetworkStatusForPartner(X, 'Blue Cross'), 'unknown', 'a plan nobody lists is unknown, never out-of-network');
assert.equal(planNetworkStatusForPartner(Y, 'Aetna'), 'in_network', 'listed under insurance with no networks entry counts as in-network');
assert.equal(planNetworkStatusForPartner(V, 'Aetna'), 'unknown', 'no insurance data at all is unknown');
assert.equal(planNetworkStatusForPartner(both, 'Aetna'), 'in_network', 'in-network wins when both are listed');
assert.equal(planNetworkStatusForPartner(X, ' Aetna '), 'in_network', 'whitespace is trimmed, as the server does');
assert.equal(planNetworkStatusForPartner(X, 'Cash pay'), 'unknown', 'cash pay is not a plan');
assert.equal(planNetworkStatusForPartner({ insurance: ['Aetna'] }, 'Aetna'), 'in_network', 'older cached partners without the networks map still read');

assert.deepEqual(
  sortPlanStatuses([
    { partnerId: 'c', organization: 'Zed', networkStatus: 'unknown', source: 'none', sameState: true },
    { partnerId: 'a', organization: 'Bee', networkStatus: 'in_network', source: 'partner', sameState: false },
    { partnerId: 'b', organization: 'Ant', networkStatus: 'in_network', source: 'listing', sameState: true },
    { partnerId: 'd', organization: 'Oak', networkStatus: 'out_of_network', source: 'partner', sameState: null },
  ]).map((item) => item.partnerId),
  ['b', 'a', 'd', 'c'],
  'in-network first, same state before other states, then by name',
);

// ─── (b) the honest label ───────────────────────────────────────────────────

const noVob = [];
assert.deepEqual(planStatusLine('in_network', noVob, 'p1'), { text: 'In-network · per program', confirmed: false });
assert.deepEqual(planStatusLine('out_of_network', noVob, 'p1'), { text: 'Out-of-network · per program', confirmed: false });
assert.deepEqual(planStatusLine('unknown', noVob, 'p1'), { text: 'Not listed · per program', confirmed: false });

const caseVobs = [
  { partnerId: 'p1', status: 'requested', answeredAt: undefined },
  { partnerId: 'p1', status: 'out_of_network', answeredAt: '2026-09-20T10:00:00Z' },
  { partnerId: 'p1', status: 'in_network', answeredAt: '2026-09-28T10:00:00Z' },
  { partnerId: 'p2', status: 'not_accepted', answeredAt: '2026-09-29T10:00:00Z' },
];
assert.equal(latestAnsweredVob(caseVobs, 'p1').status, 'in_network', 'the latest answered VOB wins');
assert.deepEqual(planStatusLine('out_of_network', caseVobs, 'p1'), { text: 'in-network · confirmed by VOB', confirmed: true }, 'a VOB answer on the case upgrades the label');
assert.deepEqual(planStatusLine('in_network', caseVobs, 'p2'), { text: 'not accepted · confirmed by VOB', confirmed: true });
assert.deepEqual(planStatusLine('in_network', caseVobs, 'p3'), { text: 'In-network · per program', confirmed: false }, 'another partner is untouched');
assert.deepEqual(planStatusLine('in_network', [{ partnerId: 'p1', status: 'pending', answeredAt: undefined }], 'p1'), { text: 'In-network · per program', confirmed: false }, 'an open request confirms nothing');
// The partner's own data is never rewritten: the classification input is untouched.
const before = JSON.stringify(X);
planStatusLine(planNetworkStatusForPartner(X, 'Aetna'), caseVobs, 'p1');
assert.equal(JSON.stringify(X), before, 'a VOB never changes the partner record');

assert.deepEqual(VOB_STATUSES, ['requested', 'pending', 'in_network', 'out_of_network', 'not_accepted']);
assert.deepEqual(VOB_STATUSES.map(isVobAnswered), [false, false, true, true, true]);
assert.deepEqual(VOB_STATUSES.map(vobStatusLabel), ['requested', 'pending with the program', 'in-network', 'out-of-network', 'not accepted'], 'labels mirror vob_status_label()');
assert.equal(vobChaseTitle('Cascade Recovery'), 'Check on VOB: Cascade Recovery', 'the chase title mirrors request_vob()');

// ─── (c) the member id keeps the last four only ─────────────────────────────

assert.equal(memberIdLast4('W123456789'), '6789');
assert.equal(memberIdLast4('12 34-56'), '3456', 'separators are dropped before taking the last four');
assert.equal(memberIdLast4('12'), '12', 'fewer than four is left for the form to reject');
assert.equal(memberIdLast4(''), '');
assert.equal(memberIdLast4('ABCD'), 'ABCD');

// ─── (d) the next business day ──────────────────────────────────────────────

assert.equal(nextBusinessDay('2026-10-01'), '2026-10-02', 'Thursday to Friday');
assert.equal(nextBusinessDay('2026-10-02'), '2026-10-05', 'Friday to Monday');
assert.equal(nextBusinessDay('2026-10-03'), '2026-10-05', 'Saturday to Monday');
assert.equal(nextBusinessDay('2026-10-04'), '2026-10-05', 'Sunday to Monday');
assert.equal(nextBusinessDay('2026-12-31'), '2027-01-01', 'year boundary');
assert.equal(nextBusinessDay('not a date'), '');

// ─── (e) the Business median ────────────────────────────────────────────────
// Same shape as insurance_workflow_test.sql section G: answered in 1, 2 and
// 4 days inside 30 days, one answered in 10 days requested 100 days ago, one
// still open from 5 days ago, two more open today.

const now = new Date('2026-10-01T12:00:00Z');
const daysAgo = (days) => new Date(now.getTime() - days * 86400000).toISOString();
const rows = [
  { requestedAt: daysAgo(20), answeredAt: daysAgo(19) },
  { requestedAt: daysAgo(15), answeredAt: daysAgo(13) },
  { requestedAt: daysAgo(10), answeredAt: daysAgo(6) },
  { requestedAt: daysAgo(100), answeredAt: daysAgo(90) },
  { requestedAt: daysAgo(5), answeredAt: undefined },
  { requestedAt: daysAgo(0), answeredAt: undefined },
  { requestedAt: daysAgo(0), answeredAt: undefined },
];
const since = (days) => now.getTime() - days * 86400000;
assert.deepEqual(summarizeVobTurnaround(rows, since(30)), { requested: 6, answered: 3, medianDays: 2 }, '30 days');
assert.deepEqual(summarizeVobTurnaround(rows, since(90)), { requested: 6, answered: 3, medianDays: 2 }, '90 days');
assert.deepEqual(summarizeVobTurnaround(rows, since(365)), { requested: 7, answered: 4, medianDays: 3 }, '365 days');
assert.deepEqual(summarizeVobTurnaround(rows, 0), { requested: 7, answered: 4, medianDays: 3 }, 'all time');
assert.deepEqual(summarizeVobTurnaround([], since(30)), { requested: 0, answered: 0, medianDays: null }, 'nothing yet');
assert.deepEqual(summarizeVobTurnaround([{ requestedAt: daysAgo(1), answeredAt: daysAgo(2) }], 0), { requested: 1, answered: 0, medianDays: null }, 'an answer before the request is ignored, not negative');
assert.deepEqual(summarizeVobTurnaround([{ requestedAt: 'garbage', answeredAt: daysAgo(2) }], 0), { requested: 0, answered: 0, medianDays: null }, 'malformed rows are skipped');
assert.equal(summarizeVobTurnaround([{ requestedAt: daysAgo(1), answeredAt: daysAgo(0.5) }], 0).medianDays, 0.5, 'half days keep one decimal');
assert.deepEqual([null, 0.5, 1, 2.5].map(formatTurnaroundDays), ['—', 'same day', '1 day', '2.5 days']);

// ─── (f) through computeBusinessDashboard ───────────────────────────────────

transpileTo('src/lib/outcomes.ts', 'lib/outcomes.js');
transpileTo('src/lib/paging.ts', 'lib/paging.js');
transpileTo('src/lib/business.ts', 'lib/business.js');
writeFileSync(path.join(tmpDir, 'lib', 'errors.js'), 'exports.StoreError = class StoreError extends Error {};');
writeFileSync(path.join(tmpDir, 'lib', 'auth-session.js'), 'exports.currentAuthSessionIdentity = async () => null;');
writeFileSync(path.join(tmpDir, 'lib', 'supabase.js'), 'exports.supabase = {};');
const business = require(path.join(tmpDir, 'lib', 'business.js'));
const dashboard = business.computeBusinessDashboard([], [], { stages: [], integrations: [], vobs: rows }, 30, now);
assert.deepEqual(dashboard.vob, { requested: 6, answered: 3, medianDays: 2 }, 'the dashboard carries the 30-day VOB tile');
assert.deepEqual(business.computeBusinessDashboard([], [], { stages: [], integrations: [] }, 'all', now).vob, { requested: 0, answered: 0, medianDays: null }, 'older callers without vobs still work');

console.log('insurance workflow: ok');
