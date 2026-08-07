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
  { id: 'i2', caseId: 'c1', provider: 'pandadoc', recordType: 'document', externalId: 'doc1', status: 'document.sent', amountCents: null, currency: 'USD', externalUrl: '', metadata: {}, updatedAt: '2026-08-01T00:00:00Z' },
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
equal('integration attention', [result.pendingContracts, result.openInvoices, result.overdueInvoices], [1, 1, 1]);
equal('source ordering', result.sources.map((item) => [item.source, item.cases, item.collected]), [
  ['Website', 2, 500],
  ['Professional referral', 1, 2000],
]);
equal('average days to engaged', result.averageDaysToEngaged, 2.5);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
