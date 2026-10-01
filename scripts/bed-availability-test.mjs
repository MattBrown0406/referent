// Bed availability: src/lib/beds.ts and its hook into src/lib/matching.ts,
// run in plain node (no build step), plus source invariants that keep the
// client and 20261001150000_bed_availability.sql in step.
//
//   (a) the seven-day window is one number, declared once per side
//   (b) staleness flips at exactly seven days; the server flag wins when present
//   (c) labels: counts, Full, Unconfirmed, nothing when never confirmed
//   (d) matching: a confirmed 0 hides; unknown / unconfirmed never hides and
//       sorts below a confirmed open bed among equal fit; scores never move;
//       with the filter off nothing changes
//   (e) the push kind exists on both sides, default off

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'bed-availability-test');
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
transpileTo('src/lib/beds.ts', 'lib/beds.js');
transpileTo('src/lib/matching.ts', 'lib/matching.js');

const beds = require(path.join(tmpDir, 'lib', 'beds.js'));
const matching = require(path.join(tmpDir, 'lib', 'matching.js'));

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-10-01T18:00:00Z');
const iso = (msAgo) => new Date(now.getTime() - msAgo).toISOString();

// ─── (a) one window, declared once per side ─────────────────────────────────

const migration = readFileSync(path.join(repoRoot, 'supabase/migrations/20261001150000_bed_availability.sql'), 'utf8');
const sqlDays = migration.match(/FUNCTION public\.bed_stale_days\(\)[\s\S]*?AS \$\$ SELECT (\d+) \$\$;/);
assert.ok(sqlDays, 'the migration must define bed_stale_days() as a single literal');
assert.equal(beds.BED_STALE_DAYS, Number(sqlDays[1]), 'BED_STALE_DAYS must equal bed_stale_days()');
assert.equal(beds.BED_STALE_DAYS, 7);
assert.deepEqual(beds.BED_PROGRAM_TYPES, ['Inpatient', 'IOP / PHP', 'Sober Living', 'Detox']);
assert.match(migration, /ARRAY\['Inpatient', 'IOP \/ PHP', 'Sober Living', 'Detox'\]::text\[\]/, 'listing_carries_beds must name the same four program types');

// ─── (b) staleness ──────────────────────────────────────────────────────────

assert.equal(beds.bedsAreStale({ bedsUpdatedAt: iso(7 * DAY - 1000) }, now), false, 'just under seven days is current');
assert.equal(beds.bedsAreStale({ bedsUpdatedAt: iso(7 * DAY + 1000) }, now), true, 'just over seven days is unconfirmed');
assert.equal(beds.bedsAreStale({ bedsUpdatedAt: null }, now), true, 'never confirmed is unconfirmed');
assert.equal(beds.bedsAreStale({ bedsUpdatedAt: iso(30 * DAY), bedsStale: false }, now), false, 'the server flag wins over the mirror');
assert.equal(beds.bedsAreStale({ bedsUpdatedAt: iso(1000), bedsStale: true }, now), true, 'the server flag wins over the mirror (stale)');

// ─── (c) labels ─────────────────────────────────────────────────────────────

const fresh = (bedsMale, bedsFemale, msAgo = 2 * 60 * 60 * 1000) => ({ bedsMale, bedsFemale, bedsUpdatedAt: iso(msAgo), bedsStale: false });
assert.equal(beds.bedsLine(fresh(3, 1), now), 'Beds today: 3 men, 1 woman, updated 2h ago');
assert.equal(beds.bedsLine(fresh(1, 2), now), 'Beds today: 1 man, 2 women, updated 2h ago');
assert.equal(beds.bedsLine(fresh(0, 0), now), 'Beds today: Full, updated 2h ago');
assert.equal(beds.bedsLine(fresh(3, null), now), 'Beds today: 3 men, updated 2h ago', 'a gender never set is left out, not shown as 0');
assert.equal(beds.bedsLine(fresh(0, 2, 40 * 60 * 1000), now), 'Beds today: 0 men, 2 women, updated 40m ago');
assert.equal(beds.bedsLine({ bedsMale: 3, bedsFemale: 1, bedsUpdatedAt: iso(9 * DAY), bedsStale: true }, now), 'Beds today: Unconfirmed', 'a stale count never shows a number');
assert.equal(beds.bedsLine({ bedsMale: 3, bedsFemale: 1, bedsUpdatedAt: iso(9 * DAY) }, now), 'Beds today: Unconfirmed', 'the mirror agrees without the server flag');
assert.equal(beds.bedsLine({ bedsMale: null, bedsFemale: null, bedsUpdatedAt: null }, now), '', 'never confirmed says nothing');
assert.equal(beds.bedsLine(undefined, now), '', 'no linked listing says nothing');
assert.equal(beds.bedStatus(fresh(0, null), now), 'full', 'the only known gender at 0 reads as full');
assert.equal(beds.bedStatus({ bedsMale: null, bedsFemale: null, bedsUpdatedAt: iso(1000), bedsStale: false }, now), 'unknown', 'confirmed with both genders unset is still unknown');

assert.equal(beds.relativeTime(iso(10 * 1000), now), 'just now');
assert.equal(beds.relativeTime(iso(35 * 60 * 1000), now), '35m ago');
assert.equal(beds.relativeTime(iso(2 * 60 * 60 * 1000), now), '2h ago');
assert.equal(beds.relativeTime(iso(3 * DAY), now), '3d ago');

assert.equal(beds.bedsCadenceLine({ bedsCadenceDays: null }), '', 'fewer than three updates: no badge');
assert.equal(beds.bedsCadenceLine({ bedsCadenceDays: 1 }), 'Usually updates beds within 1 day');
assert.equal(beds.bedsCadenceLine({ bedsCadenceDays: 3 }), 'Usually updates beds within 3 days');

assert.equal(beds.bedForFromPopulation('Men'), 'men');
assert.equal(beds.bedForFromPopulation('Women'), 'women');
assert.equal(beds.bedForFromPopulation('Any'), 'any');
assert.equal(beds.bedForFromPopulation('Adolescent'), 'any', 'no third population count: adolescents ask for any bed');

// bedAvailable: the hard-filter answer
assert.equal(beds.bedAvailable(fresh(3, 0), 'men', now), true);
assert.equal(beds.bedAvailable(fresh(3, 0), 'women', now), false, 'confirmed 0 for the asked gender hides');
assert.equal(beds.bedAvailable(fresh(3, null), 'women', now), null, 'asked gender never set is unknown');
assert.equal(beds.bedAvailable(fresh(0, 0), 'any', now), false, 'full hides for anyone');
assert.equal(beds.bedAvailable(fresh(0, null), 'any', now), null, 'one zero and one unknown is unknown for anyone');
assert.equal(beds.bedAvailable(fresh(0, 2), 'any', now), true);
assert.equal(beds.bedAvailable({ bedsMale: 0, bedsFemale: 0, bedsUpdatedAt: iso(9 * DAY), bedsStale: true }, 'men', now), null, 'a stale 0 does not hide');
assert.equal(beds.bedAvailable(undefined, 'men', now), null);

// ─── (d) matching ───────────────────────────────────────────────────────────

let seq = 0;
function partner(overrides = {}) {
  seq += 1;
  return {
    id: `p${seq}`,
    name: `Contact ${seq}`,
    organization: `Program ${seq}`,
    type: 'Inpatient',
    types: ['Inpatient'],
    city: 'Bend',
    state: 'OR',
    regions: [],
    phone: '',
    email: '',
    monthlyCost: 10000,
    cashMin: 0,
    cashMax: 10000,
    insurance: ['Aetna'],
    insuranceNetworks: { Aetna: ['In-network'] },
    therapies: ['Trauma'],
    populations: ['Adults'],
    levels: [],
    note: '',
    inbound: 0,
    outbound: 0,
    lastContact: '',
    ...overrides,
  };
}

const profile = {
  id: 'match-1',
  levelOfCare: 'Inpatient',
  state: 'OR',
  insurance: 'Aetna',
  networkPreferences: ['In-network'],
  therapies: ['Trauma'],
  mustHaveTherapies: [],
  population: 'Men',
  locationPreference: 'No preference',
};

const open = partner({ globalPartnerId: 'g-open' });
const full = partner({ globalPartnerId: 'g-full' });
const unknown = partner({ globalPartnerId: 'g-unknown' });
const unlinked = partner();
const stale = partner({ globalPartnerId: 'g-stale' });
const partners = [full, stale, unlinked, unknown, open];

const bedRows = {
  'g-open': fresh(3, 1),
  'g-full': fresh(0, 2),
  'g-unknown': { bedsMale: null, bedsFemale: null, bedsUpdatedAt: null },
  'g-stale': { bedsMale: 5, bedsFemale: 5, bedsUpdatedAt: iso(9 * DAY), bedsStale: true },
};

const baseline = matching.rankPrograms(profile, partners, {});
assert.equal(baseline.length, 5, 'with no filter every program is eligible');
assert.ok(baseline.every((score) => score.bedAvailability === null), 'with no filter bedAvailability is null everywhere');

const off = matching.rankPrograms(profile, partners, {}, { bedFor: null, beds: bedRows });
assert.deepEqual(off.map((score) => score.partner.id), baseline.map((score) => score.partner.id), 'a bedFor of null changes nothing');

const forMen = matching.rankPrograms(profile, partners, {}, { bedFor: 'men', beds: bedRows });
assert.deepEqual(forMen.map((score) => score.partner.id).includes(full.id), false, 'a confirmed 0 for men is hidden');
assert.equal(forMen.length, 4, 'unknown, unlinked, and stale programs are all still shown');
assert.equal(forMen[0].partner.id, open.id, 'the confirmed open bed sorts first among equal fit');
assert.ok(forMen.slice(1).every((score) => score.bedAvailability === null), 'the rest are unknown, never false');
assert.deepEqual(
  forMen.slice(1).map((score) => score.partner.id),
  baseline.filter((score) => score.partner.id !== full.id && score.partner.id !== open.id).map((score) => score.partner.id),
  'among the unknowns the usual tie rotation still decides',
);
for (const score of forMen) {
  const before = baseline.find((item) => item.partner.id === score.partner.id);
  assert.equal(score.total, before.total, 'the fit score never moves because of beds');
  assert.deepEqual(score.components, before.components, 'no component moves because of beds');
}

const fullScore = matching.scoreProgram(profile, full, undefined, matching.trackRecordPrior({}), { bedFor: 'men', beds: bedRows });
assert.equal(fullScore.eligible, false);
assert.deepEqual(fullScore.failedRequirements, ['bed'], 'the only failed requirement is the bed');
assert.equal(fullScore.bedAvailability, false);
assert.equal(fullScore.total, baseline.find((item) => item.partner.id === full.id).total, 'hidden, not demoted: the score is intact');

const forWomen = matching.rankPrograms(profile, partners, {}, { bedFor: 'women', beds: bedRows });
assert.equal(forWomen.length, 5, 'for women nobody is confirmed 0, so nobody is hidden');
assert.deepEqual(forWomen.slice(0, 2).map((score) => score.partner.id).sort(), [open.id, full.id].sort(), 'both confirmed open beds for women lead');

const forAny = matching.rankPrograms(profile, partners, {}, { bedFor: 'any', beds: { ...bedRows, 'g-full': fresh(0, 0) } });
assert.equal(forAny.some((score) => score.partner.id === full.id), false, 'a program full for everyone is hidden for anyone');

// A better-scoring unknown still outranks a worse-scoring confirmed bed: the
// tie-break only applies among equal fit.
const better = partner({ globalPartnerId: 'g-unknown-better', therapies: ['Trauma', 'CBT'] });
const worse = partner({ globalPartnerId: 'g-open-worse', therapies: [] });
const graded = matching.rankPrograms(
  { ...profile, therapies: ['Trauma', 'CBT'] },
  [worse, better],
  {},
  { bedFor: 'men', beds: { 'g-open-worse': fresh(2, 0), 'g-unknown-better': { bedsMale: null, bedsFemale: null, bedsUpdatedAt: null } } },
);
assert.deepEqual(graded.map((score) => score.partner.id), [better.id, worse.id], 'fit still outranks a confirmed bed');

// ─── (e) the push kind on both sides ────────────────────────────────────────

const pushSource = readFileSync(path.join(repoRoot, 'src/lib/push.ts'), 'utf8');
assert.match(pushSource, /bed_opened: 'bedOpened'/, 'push.ts maps the bed_opened kind');
assert.match(pushSource, /bedOpened: false,/, 'bed_opened defaults to off in the app');
assert.match(migration, /bed_opened boolean NOT NULL DEFAULT false/, 'bed_opened defaults to off on the server');
assert.match(migration, /WHEN 'bed_opened' THEN 'A program you follow has a bed open today\.'/, 'the push copy is generic');
assert.match(migration, /'directory_submission', 'bed_opened'\)\)/, 'the outbox accepts the kind');

const notificationsSource = readFileSync(path.join(repoRoot, 'src/lib/notifications.ts'), 'utf8');
assert.match(notificationsSource, /case 'bed_opened':/, 'a bed_opened tap has a target');

const directorySource = readFileSync(path.join(repoRoot, 'src/lib/directory.ts'), 'utf8');
assert.match(directorySource, /supabase\.rpc\('set_listing_beds'/, 'bed writes go through the RPC');
assert.match(directorySource, /p_bed_for: params\.bedFor \?\? null/, 'search passes the bed filter');

console.log('bed availability: ok');
