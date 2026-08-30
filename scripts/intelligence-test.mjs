// Deterministic relationship-intelligence fixture checks. The production
// TypeScript is transpiled so this runs in plain Node without native modules.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'intelligence-test');
const require = createRequire(import.meta.url);
const ts = require(path.join(repoRoot, 'node_modules', 'typescript'));
mkdirSync(tmpDir, { recursive: true });

const source = readFileSync(path.join(repoRoot, 'src/lib/intelligence.ts'), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true },
}).outputText;
writeFileSync(path.join(tmpDir, 'intelligence.js'), output);
const { recommendRelationshipActions } = require(path.join(tmpDir, 'intelligence.js'));

let failures = 0;
function check(label, condition, detail = '') {
  const pass = Boolean(condition);
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}
function equal(label, actual, expected) {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const partner = (id, overrides = {}) => ({
  id,
  name: `Contact ${id}`,
  organization: `Organization ${id}`,
  type: 'Therapist',
  city: 'Portland',
  state: 'OR',
  regions: ['Pacific Northwest'],
  phone: '',
  email: '',
  cashMin: 0,
  cashMax: 0,
  insurance: [],
  therapies: [],
  populations: [],
  levels: [],
  note: '',
  inbound: 0,
  outbound: 0,
  lastContact: '',
  ...overrides,
});
const referral = (id, partnerId, direction, date, overrides = {}) => ({
  id, partnerId, direction, date, clientLabel: id, outcome: 'Introduced', note: '', ...overrides,
});
const followUp = (id, overrides = {}) => ({
  id, title: id, dueOn: '2026-08-30', status: 'open', note: '', ...overrides,
});
const caseRecord = (id, summary) => ({
  id, title: id, status: 'inquiry', summary, leadSource: 'Website', leadSourceDetail: '', lostReason: '',
  stageChangedAt: '2026-08-01T12:00:00Z', paymentStatus: 'none', quotedAmount: null, paidAmount: 0,
  createdAt: '2026-08-01T12:00:00Z', updatedAt: '2026-08-01T12:00:00Z',
});

const input = {
  asOf: '2026-08-30',
  partners: [
    partner('p-cold', { name: 'Avery', organization: 'Northstar', inbound: 5, outbound: 0, lastContact: '2026-01-01', touchCadenceDays: 30 }),
    partner('p-wait', { name: 'Blair', organization: 'Harbor House', lastContact: '2026-08-20', touchCadenceDays: 30 }),
    partner('p-cadence', { name: 'Casey', organization: 'Oak Center', lastContact: '2026-06-01', touchCadenceDays: 45 }),
    partner('p-former', { name: 'Devon', organization: 'Clear Path', inbound: 1, outbound: 4, lastContact: '2025-12-01', touchCadenceDays: 180 }),
    partner('p-tie-a', { lastContact: '2026-07-01', touchCadenceDays: 60 }),
    partner('p-tie-b', { lastContact: '2026-07-01', touchCadenceDays: 60 }),
  ],
  referrals: [
    referral('r-cold-1', 'p-cold', 'Inbound', '2025-12-01'),
    referral('r-cold-2', 'p-cold', 'Inbound', '2026-01-15'),
    referral('r-wait', 'p-wait', 'Outbound', '2026-08-20', { outcome: 'Pending' }),
  ],
  touches: [
    { id: 't-cadence', partnerId: 'p-cadence', kind: 'call', note: '', occurredAt: '2026-06-15T15:00:00Z' },
  ],
  followUps: [
    followUp('f-handoff', { partnerId: 'p-wait', referralId: 'r-wait', kind: 'referral_handshake', dueOn: '2026-08-28' }),
    followUp('f-wait', { partnerId: 'p-wait', referralId: 'r-wait', kind: 'waiting_on', waitingOn: 'admissions decision', dueOn: '2026-08-28' }),
  ],
  scorecards: {
    'p-former': { partnerId: 'p-former', referralsSent: 8, admits: 6, nonAdmits: 1, avgFamilyExperience: 4.8, lastReferralOn: '2025-11-15' },
  },
  cases: [
    caseRecord('c-gap-1', 'Family needs Detox placement in Nevada.'),
    caseRecord('c-gap-2', 'Seeking a Detox program in NV for stabilization.'),
    caseRecord('c-one-off', 'Looking for an Inpatient program in Utah.'),
  ],
};

const first = recommendRelationshipActions(input);
const second = recommendRelationshipActions(input);

equal('same input produces byte-for-byte deterministic output', first, second);
check('returns no more than five recommendations', first.length <= 5, `count ${first.length}`);
equal('priority order is stable and capped', first.map((item) => item.partnerId || 'network-gap'), [
  'p-wait', 'p-cold', 'p-former', 'p-cadence', 'network-gap',
]);

equal('open referral handoff is explicit and explainable', first[0].evidenceCodes, [
  'OPEN_REFERRAL_HANDOFF', 'OPEN_WAITING_ON',
]);
check('handoff recommendation is high urgency', first[0].urgency === 'high' && first[0].score >= 90);

const cold = first.find((item) => item.partnerId === 'p-cold');
equal('cold prior referrer combines supporting evidence', cold.evidenceCodes, [
  'PRIOR_INBOUND_REFERRER_COLD', 'RELATIONSHIP_CADENCE_OVERDUE', 'UNRECIPROCATED_INBOUND_VALUE',
]);
check('balance language suggests gratitude/value rather than an exchange',
  /thank|gratitude|value/i.test(`${cold.reason} ${cold.action}`)
    && !/owe|repay|quid pro quo|referral fee|paid rank/i.test(`${cold.title} ${cold.reason} ${cold.action}`));

const former = first.find((item) => item.partnerId === 'p-former');
check('former high-value relationship is recognized from scorecard history', former.evidenceCodes.includes('FORMER_HIGH_VALUE_RELATIONSHIP'));

const cadence = first.find((item) => item.partnerId === 'p-cadence');
check('latest touch, not stale partner field, drives cadence explanation', /76 days/.test(cadence.reason), cadence.reason);

const gap = first.find((item) => !item.partnerId);
equal('repeated case demand supports a specialty/region network gap', gap.evidenceCodes, ['NETWORK_SPECIALTY_GAP', 'NETWORK_REGION_GAP']);
check('gap explains the supporting demand count', /2 open cases/.test(gap.reason), gap.reason);
check('one-off case demand does not create an unsupported gap', !first.some((item) => /Utah|Inpatient/.test(item.title)));

const noSupportedGap = recommendRelationshipActions({
  ...input,
  partners: [partner('covered-detox', { type: 'Detox', state: 'NV' })],
  cases: [caseRecord('only-one', 'Family needs Sober Living in Arizona.')],
});
check('covered or single-case demand does not produce a network-gap claim',
  !noSupportedGap.some((item) => item.evidenceCodes.includes('NETWORK_SPECIALTY_GAP') || item.evidenceCodes.includes('NETWORK_REGION_GAP')));

for (const item of first) {
  check(`recommendation has complete explanation fields (${item.partnerId || 'gap'})`,
    Boolean(item.title && item.reason && item.action && item.urgency && Number.isFinite(item.score) && item.evidenceCodes.length));
  check(`score is bounded (${item.partnerId || 'gap'})`, item.score >= 0 && item.score <= 100, String(item.score));
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
