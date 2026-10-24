// Business-dashboard fixture checks. The Supabase-facing dependencies are
// stubbed so the real metric code runs in plain Node without credentials.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'business-test');
const require = createRequire(import.meta.url);
const ts = require(path.join(repoRoot, 'node_modules', 'typescript'));
mkdirSync(tmpDir, { recursive: true });

const source = readFileSync(path.join(repoRoot, 'src/lib/business.ts'), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true },
}).outputText;
writeFileSync(path.join(tmpDir, 'business.js'), output);
// paging.ts is real code (it only depends on ./errors); business.ts pages
// every list read through it.
const pagingOutput = ts.transpileModule(readFileSync(path.join(repoRoot, 'src/lib/paging.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true },
}).outputText;
writeFileSync(path.join(tmpDir, 'paging.js'), pagingOutput);
// outcomes.ts is real code too (pure; it only imports types from ../data).
const outcomesOutput = ts.transpileModule(readFileSync(path.join(repoRoot, 'src/lib/outcomes.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true },
}).outputText;
writeFileSync(path.join(tmpDir, 'outcomes.js'), outcomesOutput);
// insurance.ts is pure too (types from ../data only); business.ts takes the
// VOB turnaround median from it.
const insuranceOutput = ts.transpileModule(readFileSync(path.join(repoRoot, 'src/lib/insurance.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true },
}).outputText;
writeFileSync(path.join(tmpDir, 'insurance.js'), insuranceOutput);
writeFileSync(path.join(tmpDir, 'errors.js'), 'exports.StoreError = class StoreError extends Error {};');
writeFileSync(path.join(tmpDir, 'auth-session.js'), 'exports.currentAuthSessionIdentity = async () => null;');
writeFileSync(path.join(tmpDir, 'supabase.js'), 'exports.supabase = {};');

const business = require(path.join(tmpDir, 'business.js'));
let failures = 0;
function equal(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const makeCase = (overrides) => ({
  id: overrides.id,
  title: overrides.id,
  status: overrides.status || 'inquiry',
  summary: '',
  leadSource: overrides.leadSource || 'Unspecified',
  leadSourceDetail: '',
  lostReason: '',
  stageChangedAt: overrides.createdAt,
  paymentStatus: 'none',
  quotedAmount: overrides.quotedAmount ?? null,
  paidAmount: overrides.paidAmount || 0,
  createdAt: overrides.createdAt,
  updatedAt: overrides.createdAt,
});

const cases = [
  // Deliberately stale manual totals: the linked Square invoice below must win.
  makeCase({ id: 'c1', status: 'engaged', leadSource: 'Website', quotedAmount: 9000, paidAmount: 9000, createdAt: '2026-07-01T12:00:00Z' }),
  makeCase({ id: 'c2', status: 'placed', leadSource: 'Professional referral', quotedAmount: 2000, paidAmount: 2000, createdAt: '2026-07-10T12:00:00Z' }),
  makeCase({ id: 'c3', status: 'lost', leadSource: 'Website', createdAt: '2026-07-20T12:00:00Z' }),
];
const stages = [
  { id: 's1', caseId: 'c1', status: 'inquiry', enteredAt: '2026-07-01T12:00:00Z', exitedAt: '2026-07-02T12:00:00Z' },
  { id: 's2', caseId: 'c1', status: 'consult', enteredAt: '2026-07-02T12:00:00Z', exitedAt: '2026-07-04T12:00:00Z' },
  { id: 's3', caseId: 'c1', status: 'engaged', enteredAt: '2026-07-04T12:00:00Z' },
  { id: 's4', caseId: 'c2', status: 'placed', enteredAt: '2026-07-12T12:00:00Z' },
  { id: 's5', caseId: 'c3', status: 'lost', enteredAt: '2026-07-21T12:00:00Z' },
];
const integrations = [
  { id: 'i1', caseId: 'c1', provider: 'square', recordType: 'invoice', externalId: 'inv1', status: 'partially_paid', amountCents: 100000, paidAmountCents: 50000, currency: 'USD', dueOn: '2026-08-01', externalUrl: '', metadata: {}, updatedAt: '2026-08-01T00:00:00Z' },
  { id: 'i2', caseId: 'c1', provider: 'pandadoc', recordType: 'document', externalId: 'doc1', status: 'document.sent', amountCents: 350000, currency: 'USD', externalUrl: '', metadata: {}, updatedAt: '2026-08-01T00:00:00Z' },
  // Older still-open proposal for the same case must not be double-counted.
  { id: 'i2-old', caseId: 'c1', provider: 'pandadoc', recordType: 'document', externalId: 'doc0', status: 'document.viewed', amountCents: 250000, currency: 'USD', externalUrl: '', metadata: {}, updatedAt: '2026-07-31T00:00:00Z' },
  { id: 'i3', caseId: 'c2', provider: 'square', recordType: 'invoice', externalId: 'inv2', status: 'paid', amountCents: 200000, currency: 'USD', externalUrl: '', metadata: {}, updatedAt: '2026-08-01T00:00:00Z' },
];
const referrals = [
  { id: 'r1', partnerId: 'p1', direction: 'Outbound', clientLabel: 'A.B.', date: '2026-07-10', outcome: 'Placed', note: '' },
  { id: 'r2', partnerId: 'p2', direction: 'Outbound', clientLabel: 'C.D.', date: '2026-07-20', outcome: 'Pending', note: '' },
];

const result = business.computeBusinessDashboard(cases, referrals, { stages, integrations }, 90, new Date(2026, 7, 6, 12));
equal('case and revenue snapshot', {
  cases: result.casesCreated,
  active: result.activeCases,
  quoted: result.quotedRevenue,
  collected: result.collectedRevenue,
  outstanding: result.outstandingRevenue,
}, { cases: 3, active: 2, quoted: 3000, collected: 2500, outstanding: 500 });
equal('funnel values', result.funnel.map((item) => item.value), [3, 2, 2, 1]);
equal('placement and referral rates', [result.placementRate, result.referralPlacementRate], [1 / 3, 1 / 2]);
equal('integration attention', [result.pendingContracts, result.pendingContractRevenue, result.openInvoices, result.overdueInvoices], [1, 3500, 1, 1]);
equal('US currency parsing', [
  business.parseOptionalPositiveUsdCents(''),
  business.parseOptionalPositiveUsdCents('1500.00'),
  business.parseOptionalPositiveUsdCents('$1,500.50'),
  business.parseOptionalPositiveUsdCents('-100'),
  business.parseOptionalPositiveUsdCents('1500,50'),
], [null, 150000, 150050, undefined, undefined]);
equal('source ordering', result.sources.map((item) => [item.source, item.cases, item.collected]), [
  ['Website', 2, 500],
  ['Professional referral', 1, 2000],
]);
equal('average days to engaged', result.averageDaysToEngaged, 2.5);

// ─── The same external record linked by two teammates ──────────────────────
// case_integrations is unique per owner, so a teammate can link the same
// Square invoice or PandaDoc document to the same case. Webhooks sync only
// the connecting owner's row; the teammate's copy goes stale. Each record
// counts once per case, and the synced copy speaks for it.
const syncedIntegrations = integrations.map((item) => (item.id === 'i1' ? { ...item, lastSyncedAt: '2026-08-01T00:00:00Z' } : item));
const teammateCopies = [
  // Same invoice, same case, linked later by a teammate and never synced.
  { id: 'i1-teammate', caseId: 'c1', provider: 'square', recordType: 'invoice', externalId: ' inv1 ', status: 'unpaid', amountCents: 100000, paidAmountCents: 0, currency: 'USD', dueOn: '2026-08-01', externalUrl: '', metadata: {}, updatedAt: '2026-08-03T00:00:00Z' },
  // Same paid invoice on c2, linked twice.
  { id: 'i3-teammate', caseId: 'c2', provider: 'square', recordType: 'invoice', externalId: 'inv2', status: 'paid', amountCents: 200000, currency: 'USD', externalUrl: '', metadata: {}, updatedAt: '2026-07-30T00:00:00Z' },
  // Same open proposal on c1, linked twice.
  { id: 'i2-teammate', caseId: 'c1', provider: 'pandadoc', recordType: 'document', externalId: 'doc1', status: 'document.sent', amountCents: 350000, currency: 'USD', externalUrl: '', metadata: {}, updatedAt: '2026-07-30T00:00:00Z' },
  // A contract on c2 the provider says is completed; the teammate's stale
  // copy still reads "sent" (and was edited more recently) and must not
  // count as pending.
  { id: 'i4', caseId: 'c2', provider: 'pandadoc', recordType: 'document', externalId: 'doc9', status: 'document.completed', amountCents: 500000, currency: 'USD', externalUrl: '', metadata: {}, lastSyncedAt: '2026-08-02T00:00:00Z', updatedAt: '2026-08-02T00:00:00Z' },
  { id: 'i4-teammate', caseId: 'c2', provider: 'pandadoc', recordType: 'document', externalId: 'doc9', status: 'document.sent', amountCents: 500000, currency: 'USD', externalUrl: '', metadata: {}, updatedAt: '2026-08-04T00:00:00Z' },
];
const duplicated = business.computeBusinessDashboard(cases, referrals, { stages, integrations: [...syncedIntegrations, ...teammateCopies] }, 90, new Date(2026, 7, 6, 12));
equal('a record linked twice counts once: revenue', {
  quoted: duplicated.quotedRevenue,
  collected: duplicated.collectedRevenue,
  outstanding: duplicated.outstandingRevenue,
}, { quoted: 3000, collected: 2500, outstanding: 500 });
equal('a record linked twice counts once: invoices and contracts', [duplicated.pendingContracts, duplicated.pendingContractRevenue, duplicated.openInvoices, duplicated.overdueInvoices], [1, 3500, 1, 1]);
equal('a record linked twice counts once: per source', duplicated.sources.map((item) => [item.source, item.quoted, item.collected]), [
  ['Website', 1000, 500],
  ['Professional referral', 2000, 2000],
]);
const pick = (rows) => business.uniqueIntegrations(rows).map((item) => item.id);
const row = (overrides) => ({ caseId: 'c1', provider: 'square', recordType: 'invoice', externalId: 'inv1', status: 'unpaid', amountCents: null, currency: 'USD', externalUrl: '', metadata: {}, updatedAt: '2026-08-01T00:00:00Z', ...overrides });
equal('the synced copy wins over a more recently edited one', pick([row({ id: 'b', updatedAt: '2026-08-09T00:00:00Z', amountCents: 100 }), row({ id: 'a', lastSyncedAt: '2026-08-01T00:00:00Z' })]), ['a']);
equal('then a copy with an amount', pick([row({ id: 'a', updatedAt: '2026-08-09T00:00:00Z' }), row({ id: 'b', amountCents: 100 })]), ['b']);
equal('then the most recent edit, then the lower id', [
  pick([row({ id: 'a' }), row({ id: 'b', updatedAt: '2026-08-02T00:00:00Z' })]),
  pick([row({ id: 'b' }), row({ id: 'a' })]),
], [['b'], ['a']]);
equal('distinct records, cases, record types and providers all stay', pick([
  row({ id: '1' }),
  row({ id: '2', externalId: 'inv2' }),
  row({ id: '3', caseId: 'c2' }),
  row({ id: '4', recordType: 'payment' }),
  row({ id: '5', provider: 'pandadoc', recordType: 'document' }),
]), ['1', '2', '3', '4', '5']);

// ─── A canceled invoice is not quoted revenue ──────────────────────────────
// The family was invoiced $15,000 by mistake, the invoice was canceled and a
// corrected $12,000 one sent. The case's quote is $12,000, not $27,000.
{
  const reissued = [
    { id: 'x1', caseId: 'c2', provider: 'square', recordType: 'invoice', externalId: 'inv-wrong', status: 'CANCELED', amountCents: 1500000, paidAmountCents: null, currency: 'USD', dueOn: '2026-07-15', externalUrl: '', metadata: {}, updatedAt: '2026-07-14T00:00:00Z' },
    { id: 'x2', caseId: 'c2', provider: 'square', recordType: 'invoice', externalId: 'inv-right', status: 'unpaid', amountCents: 1200000, paidAmountCents: 0, currency: 'USD', dueOn: '2026-09-15', externalUrl: '', metadata: {}, updatedAt: '2026-07-15T00:00:00Z' },
  ];
  const canceled = business.computeBusinessDashboard([cases[1]], [], { stages, integrations: reissued }, 90, new Date(2026, 7, 6, 12));
  equal('a canceled invoice counts toward neither quoted, collected nor outstanding', [canceled.quotedRevenue, canceled.collectedRevenue, canceled.outstandingRevenue, canceled.sources[0].quoted, canceled.openInvoices], [12000, 0, 12000, 12000, 1]);
  // A refund still shows what was billed, with nothing collected or owed.
  const refunded = business.computeBusinessDashboard([cases[1]], [], { stages, integrations: [{ ...reissued[1], status: 'refunded', paidAmountCents: 1200000 }] }, 90, new Date(2026, 7, 6, 12));
  equal('a refunded invoice is quoted, not collected, not outstanding', [refunded.quotedRevenue, refunded.collectedRevenue, refunded.outstandingRevenue], [12000, 0, 0]);
}

// ─── Speed to lead ──────────────────────────────────────────────────────────
// A lead is a case with leadCapturedAt; its clock stops at firstTouchAt. The
// fixture mirrors supabase/tests/lead_capture_test.sql section 7.
const lead = (overrides) => ({
  ...makeCase({ id: overrides.id, leadSource: overrides.leadSource, createdAt: overrides.leadCapturedAt }),
  leadCapturedAt: overrides.leadCapturedAt,
  firstTouchAt: overrides.firstTouchAt,
});
const leadCases = [
  lead({ id: 'l1', leadSource: 'Website', leadCapturedAt: '2026-08-01T10:00:00Z', firstTouchAt: '2026-08-01T10:05:00Z' }), // 5 min
  lead({ id: 'l2', leadSource: 'Website', leadCapturedAt: '2026-08-01T10:00:00Z', firstTouchAt: '2026-08-01T10:10:00Z' }), // 10 min
  lead({ id: 'l3', leadSource: 'Inbound call', leadCapturedAt: '2026-08-01T10:00:00Z', firstTouchAt: '2026-08-01T10:30:00Z' }), // 30 min
  lead({ id: 'l4', leadSource: 'Inbound call', leadCapturedAt: '2026-08-01T10:00:00Z' }), // never answered
  lead({ id: 'l5', leadSource: 'Website', leadCapturedAt: '2025-01-01T10:00:00Z', firstTouchAt: '2025-01-01T10:01:00Z' }), // 1 min, outside 90 days
  makeCase({ id: 'n1', leadSource: 'Website', createdAt: '2026-08-02T10:00:00Z' }), // a case, not a lead
];
const leadNow = new Date(2026, 7, 6, 12);
equal('median helper', [business.median([]), business.median([3, 1, 2]), business.median([1, 2, 3, 4])], [null, 2, 2.5]);
equal('speed to lead, 90 days, 15-minute target', business.computeSpeedToLead(leadCases, 90, 15, leadNow), {
  leads: 4, answered: 3, medianMinutes: 10, withinTarget: 2, withinTargetRate: 0.5, targetMinutes: 15,
});
equal('speed to lead, all time', business.computeSpeedToLead(leadCases, 'all', 15, leadNow), {
  leads: 5, answered: 4, medianMinutes: 7.5, withinTarget: 3, withinTargetRate: 0.6, targetMinutes: 15,
});
equal('a tighter target counts fewer leads as answered in time', business.computeSpeedToLead(leadCases, 90, 5, leadNow).withinTarget, 1);
equal('no leads means no rate and no median', business.computeSpeedToLead([leadCases[5]], 90, 15, leadNow), {
  leads: 0, answered: 0, medianMinutes: null, withinTarget: 0, withinTargetRate: null, targetMinutes: 15,
});
const leadResult = business.computeBusinessDashboard(leadCases, [], { stages: [], integrations: [] }, 90, leadNow, 15);
equal('dashboard carries speed to lead', leadResult.speedToLead, business.computeSpeedToLead(leadCases, 90, 15, leadNow));
equal('per-source lead counts', leadResult.sources.map((item) => [item.source, item.cases, item.leads, item.leadsWithinTarget]), [
  ['Website', 3, 2, 2],
  ['Inbound call', 2, 2, 0],
]);
equal('the dashboard target defaults to 15 minutes', business.computeBusinessDashboard(leadCases, [], { stages: [], integrations: [] }, 90, leadNow).speedToLead.targetMinutes, 15);

equal('whole-dollar fields read what people type, and refuse what they would misread', [
  business.parseWholeDollars(''),
  business.parseWholeDollars('1500'),
  business.parseWholeDollars('$1,500'),
  business.parseWholeDollars('1,500.00'),
  business.parseWholeDollars('0'),
  business.parseWholeDollars('1500.50'),
  business.parseWholeDollars('4,50'),
  business.parseWholeDollars('abc'),
], [null, 1500, 1500, 1500, 0, undefined, undefined, undefined]);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
