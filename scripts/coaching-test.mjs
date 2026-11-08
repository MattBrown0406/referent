// Hourly coaching on interventionist profiles (migration
// 20261108160000_listing_coaching.sql): the app's helpers and card, the
// Directory line, the portal's referral search, and that matching never
// reads it. Run with: node scripts/coaching-test.mjs

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'coaching-test');
const require = createRequire(import.meta.url);
const ts = require(path.join(repoRoot, 'node_modules', 'typescript'));
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

function transpileTo(relSrc, outName) {
  const js = ts.transpileModule(read(relSrc), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const outPath = path.join(tmpDir, outName);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, js);
  return outPath;
}

let checks = 0;
const check = (fn) => { fn(); checks += 1; };

mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
writeFileSync(path.join(tmpDir, 'lib', 'supabase.js'), "Object.defineProperty(exports, 'supabase', { get: () => globalThis.__coachingSupabase });");
transpileTo('src/lib/errors.ts', 'lib/errors.js');
const app = require(transpileTo('src/lib/coaching.ts', 'lib/coaching.js'));

check(() => assert.deepEqual(app.mapCoaching({ coaching_offered: true, coaching_hourly_rate: 150, coaching_note: 'Zoom' }), { offered: true, hourlyRate: 150, note: 'Zoom' }));
check(() => assert.equal(app.mapCoaching({ coaching_offered: true, coaching_hourly_rate: null }).offered, false), 'offered without a rate reads off');
check(() => assert.deepEqual(app.mapCoaching(null), { offered: false, hourlyRate: null, note: '' }));
check(() => assert.equal(app.coachingLine({ offered: true, hourlyRate: 150, note: 'By Zoom or phone' }), 'Hourly coaching: $150/hour · By Zoom or phone'));
check(() => assert.equal(app.coachingLine({ offered: true, hourlyRate: 1250, note: '  ' }), 'Hourly coaching: $1,250/hour'));
check(() => assert.equal(app.coachingLine({ offered: false, hourlyRate: 150, note: '' }), ''));
check(() => assert.equal(app.coachingLine(undefined), ''));
check(() => {
  assert.equal(app.parseCoachingRate('150'), 150);
  assert.equal(app.parseCoachingRate('$1,250'), 1250);
  assert.equal(app.parseCoachingRate(' 75 '), 75);
  for (const bad of ['', '0', '5001', '12.50', 'abc', '-5', '99999']) assert.equal(app.parseCoachingRate(bad), null, bad);
});
check(() => {
  for (const code of ['PGRST202', '42883', '42703']) assert.equal(app.isMissingCoaching({ code }), true);
  assert.equal(app.isMissingCoaching({ code: '42501' }), false);
});

globalThis.__coachingSupabase = {
  rpc: async (name, args) => {
    if (name === 'fetch_listing_coaching') {
      return { data: args.p_ids.map((id, index) => ({ global_partner_id: id, coaching_offered: index === 0, coaching_hourly_rate: 150, coaching_note: '' })), error: null };
    }
    if (name === 'set_listing_coaching') return { data: [{ coaching_offered: args.p_offered, coaching_hourly_rate: args.p_hourly_rate, coaching_note: args.p_note }], error: null };
    return { data: null, error: { message: 'unexpected' } };
  },
};
const fetched = await app.fetchListingCoaching(['a', 'b', 'a']);
check(() => assert.deepEqual(Object.keys(fetched), ['a']), 'only listings that offer coaching come back, each once');
const saved = await app.saveListingCoaching('a', true, 150, '  note  ');
check(() => assert.deepEqual(saved, { offered: true, hourlyRate: 150, note: 'note' }));

// Portal mirror.
const portal = require(transpileTo('portal/src/coaching-rules.ts', 'portal/coaching-rules.js'));
check(() => assert.deepEqual(portal.coachingById([
  { global_partner_id: 'a', coaching_offered: true, coaching_hourly_rate: 150, coaching_note: ' Zoom ' },
  { global_partner_id: 'b', coaching_offered: false, coaching_hourly_rate: 150 },
  { global_partner_id: 'c', coaching_offered: true, coaching_hourly_rate: null },
]), { a: { hourlyRate: 150, note: 'Zoom' } }));
check(() => assert.equal(portal.coachingLine({ hourlyRate: 150, note: 'Zoom' }), app.coachingLine({ offered: true, hourlyRate: 150, note: 'Zoom' })),
  'the portal and the app say it the same way');
check(() => assert.deepEqual(portal.coachingById(null), {}));

// Wiring.
const workspace = read('src/lib/WorkspaceScreen.tsx');
const directory = read('src/lib/GlobalDirectoryScreen.tsx');
const card = read('src/lib/CoachingCard.tsx');
const referrals = read('portal/src/ProgramReferrals.tsx');
const matching = read('src/lib/matching.ts');
const migration = read('supabase/migrations/20261108160000_listing_coaching.sql');
check(() => assert.match(workspace, /isIndividualProfessional\(directoryProfile\.profile\.types\) \? \(\s*<CoachingCard listingId=\{directoryProfile\.profile\.id\} canEdit=\{directoryProfile\.canEdit\} \/>/),
  'only an interventionist or therapist profile shows the card');
check(() => assert.match(directory, /isIndividualProfessional\(listing\.types\) && !coachingAskedRef\.current\.has\(listing\.id\)/), 'the Directory asks only for professionals');
check(() => assert.match(directory, /coachingLine\(coaching\[listing\.id\]\)/));
check(() => assert.match(card, /saveListingCoaching\(listingId, offered, offered \? parsedRate : null, note\)/));
check(() => assert.match(referrals, /supabase\.rpc\('fetch_listing_coaching'/), 'programs see it when they refer a family');
check(() => assert.doesNotMatch(matching, /coaching/i), 'matching never reads coaching');
check(() => assert.match(migration, /REVOKE UPDATE \(coaching_offered, coaching_hourly_rate, coaching_note\) ON public\.global_partners FROM PUBLIC, anon, authenticated;/));
check(() => assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.set_listing_coaching\(uuid, boolean, integer, text\) TO authenticated;/));
check(() => assert.doesNotMatch(migration, /[^\x00-\x7f]/), 'ASCII only');

console.log(`coaching-test: ${checks} checks passed`);
