// Packet generator fixture test — runs src/lib/packet.ts (plus its only
// runtime dependency, formatMoney from src/data.ts) in plain node with no
// build step. Prints the exact text a family/partner would receive.

import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'packet-test');
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

execFileSync('mkdir', ['-p', tmpDir]);

// packet.ts only uses formatMoney + stateOptions from data.ts, but data.ts is
// self-contained, so we can load the real thing. packet.ts imports '../data'
// — mirror that relative layout inside the temp dir (lib/packet.js → data.js).
transpileTo('src/data.ts', 'data.js');
transpileTo('src/lib/packet.ts', 'lib/packet.js');

const { buildFitReasons, buildPacket, labelLooksLikeFullName } = require(path.join(tmpDir, 'lib', 'packet.js'));

// ─── Fixtures ───────────────────────────────────────────────────────────────

const partnerA = {
  id: 'p-fixture-a',
  name: 'Sarah Ellison',
  organization: 'Riverstone Recovery Center',
  type: 'Inpatient',
  types: ['Inpatient', 'Detox'],
  city: 'Bend',
  state: 'OR',
  regions: ['Nationwide'],
  phone: '(541) 555-0142',
  email: 'admissions@riverstonerecovery.com',
  website: 'https://riverstonerecovery.com',
  cashMin: 18000,
  cashMax: 42000,
  insurance: ['Aetna', 'Cigna', 'UnitedHealthcare', 'Regence BlueCross BlueShield of Oregon'],
  therapies: ['Trauma', 'Dual diagnosis', 'MAT', 'Family systems'],
  populations: ['Adults'],
  levels: ['Inpatient', 'Detox'],
  note: '',
  inbound: 0,
  outbound: 0,
  lastContact: '2026-07-20',
};

const partnerB = {
  id: 'p-fixture-b',
  name: 'Marcus Webb',
  organization: 'High Desert Sober Living',
  type: 'Sober Living',
  city: 'Redmond',
  state: 'OR',
  regions: ['Central Oregon'],
  phone: '(541) 555-0198',
  email: 'marcus@highdesertsoberliving.org',
  website: '',
  cashMin: 1200,
  cashMax: 2400,
  insurance: [],
  therapies: ['Men only', 'Chronic relapse'],
  populations: ['Men'],
  levels: ['Sober Living'],
  note: '',
  inbound: 0,
  outbound: 0,
  lastContact: '2026-07-22',
};

const profileInsurance = {
  id: 'm-fixture-1',
  clientLabel: 'J.R. — Portland family',
  levelOfCare: 'Inpatient',
  state: 'OR',
  insurance: 'Aetna',
  networkPreferences: ['In-network'],
  therapies: ['Trauma', 'Dual diagnosis'],
  status: 'Matching',
  createdAt: '2026-07-24T00:00:00.000Z',
  updatedAt: '2026-07-24T00:00:00.000Z',
};

const profileCash = {
  id: 'm-fixture-2',
  clientLabel: 'K.M.',
  levelOfCare: 'Sober Living',
  state: 'OR',
  insurance: 'Cash pay',
  networkPreferences: ['In-network'],
  maxBudget: 2500,
  therapies: ['Men only'],
  status: 'Matching',
  createdAt: '2026-07-24T00:00:00.000Z',
  updatedAt: '2026-07-24T00:00:00.000Z',
};

// ─── 1. Family-audience packet (insurance fixture) ─────────────────────────

const fitA = { networkStatus: 'In-network', matchedTherapies: ['Trauma', 'Dual diagnosis'], regionFit: true, paymentFit: true };
const reasonsA = buildFitReasons(profileInsurance, partnerA, fitA);
console.log('═'.repeat(64));
console.log('PACKET 1 — audience: FAMILY (insurance / in-network fixture)');
console.log('═'.repeat(64));
console.log(buildPacket(profileInsurance, partnerA, reasonsA, 'family'));

// ─── 2. Partner-audience packet (same fixture) ─────────────────────────────

console.log('\n' + '═'.repeat(64));
console.log('PACKET 2 — audience: PARTNER (same match, partner ordering)');
console.log('═'.repeat(64));
console.log(buildPacket(profileInsurance, partnerA, reasonsA, 'partner'));

// ─── 3. Cash-pay packet with budget (family audience) ──────────────────────

const fitB = { networkStatus: null, matchedTherapies: ['Men only'], regionFit: true, paymentFit: true };
const reasonsB = buildFitReasons(profileCash, partnerB, fitB);
console.log('\n' + '═'.repeat(64));
console.log('PACKET 3 — audience: FAMILY (cash pay + budget fixture)');
console.log('═'.repeat(64));
console.log(buildPacket(profileCash, partnerB, reasonsB, 'family'));

// ─── De-identification heuristic spot checks ───────────────────────────────

console.log('\n' + '─'.repeat(64));
console.log('labelLooksLikeFullName checks:');
for (const label of ['J.R.', 'K.M. — Bend family', 'John Robinson', 'J.R. Portland', 'Sarah Ellison']) {
  console.log(`  "${label}" → ${labelLooksLikeFullName(label)}`);
}

unlinkSync(path.join(tmpDir, 'data.js'));
unlinkSync(path.join(tmpDir, 'lib', 'packet.js'));
