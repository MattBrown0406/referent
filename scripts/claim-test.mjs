// Listing claims (migration 20261108150000_claim_requests.sql): the admin's
// Issue claim code button and claim-request queue in the app, and the
// portal's /claim link and "Find your program" request.
// Run with: node scripts/claim-test.mjs

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'claim-test');
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

// ─── App helpers ────────────────────────────────────────────────────────────
mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
writeFileSync(path.join(tmpDir, 'lib', 'supabase.js'), "Object.defineProperty(exports, 'supabase', { get: () => globalThis.__claimSupabase });");
transpileTo('src/lib/errors.ts', 'lib/errors.js');
const app = require(transpileTo('src/lib/claim-requests.ts', 'lib/claim-requests.js'));

check(() => assert.equal(app.claimLink('abc123def4567890'), 'https://portal.referralfit.com/claim#abc123def4567890'));
check(() => {
  const message = app.claimInviteMessage('Juniper Ridge Recovery', { code: 'abc123def4567890', expiresAt: '2026-12-07T20:00:00Z' });
  assert.match(message, /^Here is how to manage Juniper Ridge Recovery's listing on ReferralFit \(free\):/);
  assert.match(message, /1\. Open https:\/\/portal\.referralfit\.com\/claim#abc123def4567890/);
  assert.match(message, /Your claim code is already filled in/);
  assert.match(message, /Claim code: abc123def4567890 \(works until December 7, 2026\)/);
});
check(() => assert.doesNotMatch(app.claimInviteMessage('X', { code: 'abc123def4567890', expiresAt: 'nope' }), /works until/));
check(() => {
  const row = app.mapClaimRequest({
    id: 'r1', global_partner_id: 'g1', listing_name: 'Juniper Ridge Recovery', city: 'Bend', state: 'OR',
    website: 'juniperridge.example', listing_phone: '541-555-0100', listing_claimed: false,
    requester_email: 'a@juniperridge.example', email_matches_website: true, contact_name: 'Ana', contact_role: 'Admissions',
    contact_phone: '', note: '', created_at: '2026-11-08T10:00:00Z',
  });
  assert.equal(row.place, 'Bend, OR');
  assert.equal(row.emailMatchesWebsite, true);
  assert.equal(app.mapClaimRequest({}).listingName, 'A program');
  assert.equal(app.mapClaimRequest({ email_matches_website: 'yes' }).emailMatchesWebsite, false);
});
check(() => {
  const now = new Date('2026-11-08T12:00:00Z');
  assert.equal(app.requestedAgo('2026-11-08T11:59:30Z', now), 'just now');
  assert.equal(app.requestedAgo('2026-11-08T11:20:00Z', now), '40 minutes ago');
  assert.equal(app.requestedAgo('2026-11-08T11:00:00Z', now), '1 hour ago');
  assert.equal(app.requestedAgo('2026-11-06T12:00:00Z', now), '2 days ago');
});
check(() => {
  for (const code of ['PGRST202', '42883', '42P01']) assert.equal(app.isMissingClaimRequests({ code }), true);
  assert.equal(app.isMissingClaimRequests({ code: '42501' }), false);
});

globalThis.__claimSupabase = {
  rpc: async (name, args) => {
    if (globalThis.__claimMissing) return { data: null, error: { code: 'PGRST202', message: 'missing' } };
    if (name === 'create_center_claim_code') return { data: [{ code: 'abc123def4567890', expires_at: '2026-12-07T20:00:00Z' }], error: null };
    if (name === 'list_program_claim_requests') return { data: [{ id: 'r1', listing_name: 'Juniper' }], error: null };
    if (name === 'decide_program_claim_request') return { data: args.p_approve ? 'approved' : 'declined', error: null };
    return { data: null, error: { message: 'unexpected' } };
  },
};
const code = await app.issueClaimCode('g1');
check(() => assert.deepEqual(code, { code: 'abc123def4567890', expiresAt: '2026-12-07T20:00:00Z' }));
const list = await app.fetchProgramClaimRequests();
check(() => assert.equal(list.length, 1));
assert.equal(await app.decideProgramClaimRequest('r1', true, ''), 'approved'); checks += 1;
assert.equal(await app.decideProgramClaimRequest('r1', false, ''), 'declined'); checks += 1;
globalThis.__claimMissing = true;
assert.equal(await app.fetchProgramClaimRequests(), null, 'an older server hides the card'); checks += 1;
globalThis.__claimMissing = false;

// ─── App wiring ─────────────────────────────────────────────────────────────
const workspace = read('src/lib/WorkspaceScreen.tsx');
const directory = read('src/lib/GlobalDirectoryScreen.tsx');
const queue = read('src/lib/ClaimRequestQueue.tsx');
check(() => assert.match(workspace, /<Text style=\{styles\.cardLabel\}>Program claim requests<\/Text>/));
check(() => assert.match(workspace, /\{pendingClaims !== null \? \(/), 'the card shows only for admins on a server with the feature');
check(() => assert.match(workspace, /const claims = admin \? await fetchProgramClaimRequests\(\) : null;/), 'only admins load the queue');
check(() => assert.match(directory, /isPlatformAdmin && !listing\.claimed && !isIndividualProfessional\(listing\.types\)/),
  'the button shows only to admins, on unclaimed program listings');
check(() => assert.match(directory, /Issue claim code \(ReferralFit admin\)/));
check(() => assert.match(queue, /Alert\.alert\(\s*`Let this account manage \$\{item\.listingName\}\?`/), 'approving asks first');
check(() => assert.match(queue, /does not match the program's website\. Approve only if you confirmed it/), 'a mismatch is called out');

// ─── Portal ─────────────────────────────────────────────────────────────────
const rules = require(transpileTo('portal/src/claim-rules.ts', 'portal/claim-rules.js'));
check(() => assert.equal(rules.claimCodeFromLocation('/claim', '#ABC123def4567890'), 'abc123def4567890'));
check(() => assert.equal(rules.claimCodeFromLocation('/claim/', '#abc123def4567890'), 'abc123def4567890'));
check(() => assert.equal(rules.claimCodeFromLocation('/', '#abc123def4567890'), null), 'only on /claim');
check(() => assert.equal(rules.claimCodeFromLocation('/claim', '#short'), null));
check(() => assert.equal(rules.claimCodeFromLocation('/claim', '#abc 123'), null));
check(() => assert.deepEqual(rules.toMyClaimRequest({ id: 'r1', listing_name: 'J', status: 'pending', decision_note: '', created_at: 't' }),
  { id: 'r1', listingName: 'J', status: 'pending', decisionNote: '', createdAt: 't' }));
check(() => assert.equal(rules.toMyClaimRequest({ id: 'r1', status: 'weird' }), null));
check(() => assert.equal(rules.toMyClaimRequest(null), null));
check(() => assert.deepEqual(rules.toClaimableListing({ id: 'g1', listing_name: 'J', city: 'Bend', state: 'OR', website: 'j.example', claimed: true }),
  { id: 'g1', name: 'J', place: 'Bend, OR', website: 'j.example', claimed: true }));
check(() => assert.equal(rules.searchable(' j '), false));
check(() => assert.equal(rules.searchable('ju'), true));
check(() => assert.equal(rules.requestReady({ name: '  ' }), false));
check(() => assert.equal(rules.requestReady({ name: 'Ana' }), true));

const portalApp = read('portal/src/App.tsx');
const claimPage = read('portal/src/ClaimRequest.tsx');
check(() => assert.match(portalApp, /claimCodeFromLocation\(window\.location\.pathname, window\.location\.hash\)/), 'the /claim link fills the code in');
check(() => assert.match(portalApp, /window\.history\.replaceState\(null, '', '\/'\)/), 'and leaves the address bar');
check(() => assert.match(portalApp, /\{pendingClaimCode \? null : <ClaimRequest onError=\{setError\} onNotice=\{setNotice\} \/>\}/));
check(() => assert.match(claimPage, /supabase\.rpc\('request_program_claim'/));
check(() => assert.match(claimPage, /supabase\.rpc\('claimable_program_listings'/));

// ─── Server wiring ──────────────────────────────────────────────────────────
const migration = read('supabase/migrations/20261108150000_claim_requests.sql');
for (const fn of ['claimable_program_listings(text, text)', 'request_program_claim(uuid, text, text, text, text)', 'my_program_claim_request()',
  'cancel_program_claim_request()', 'list_program_claim_requests()', 'decide_program_claim_request(uuid, boolean, text)']) {
  check(() => assert.ok(migration.includes(`GRANT EXECUTE ON FUNCTION public.${fn} TO authenticated;`), fn));
  check(() => assert.ok(migration.includes(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon;`), `${fn} not anon`));
}
check(() => assert.match(migration, /IF auth\.uid\(\) IS NULL OR NOT public\.is_platform_admin\(\) THEN\s+RAISE EXCEPTION 'Only platform admins can review claim requests'/));
check(() => assert.match(migration, /IF v_admin IS NULL OR NOT public\.is_platform_admin\(\) THEN\s+RAISE EXCEPTION 'Only platform admins can decide claim requests'/));
check(() => assert.doesNotMatch(migration, /[^\x00-\x7f]/), 'ASCII only');

// ─── Audit round 1 (portal + app) ───────────────────────────────────────────
const referralRules = require(transpileTo('portal/src/program-referral-rules.ts', 'portal/program-referral-rules.js'));
check(() => {
  const href = referralRules.safeWebsiteHref;
  assert.equal(href('https://example.com/x'), 'https://example.com/x');
  assert.equal(href('example.com'), 'https://example.com/');
  assert.equal(href('www.example.com'), 'https://www.example.com/');
  assert.equal(href('HTTP://Example.com'), 'http://example.com/');
  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', 'mailto:a@b.c', '', '   ', null, undefined, 'http://']) {
    assert.equal(href(bad), null, String(bad));
  }
});
const emailRules = require(transpileTo('portal/src/email-rules.ts', 'portal/email-rules-audit.js'));
check(() => {
  const store = new Map();
  globalThis.window = { sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) } };
  const T = 'b'.repeat(64);
  assert.equal(emailRules.tokenForTab('k', `#${T}`, emailRules.bedTokenFrom), T, 'from the link');
  assert.equal(emailRules.tokenForTab('k', '', emailRules.bedTokenFrom), T, 'a reload keeps it for the tab');
  assert.equal(emailRules.tokenForTab('k', '#cut-off', emailRules.bedTokenFrom), null, 'a cut-off link never falls back');
  assert.equal(emailRules.tokenForTab('k', '', emailRules.bedTokenFrom), null, 'and forgets the old one');
  delete globalThis.window;
});
const portalApp2 = read('portal/src/App.tsx');
check(() => assert.match(portalApp2, /if \(hadSessionRef\.current\) \{ forgetClaimCode\(\); prefilledRef\.current = false; \}/), 'sign-out forgets the invite code');
check(() => assert.match(portalApp2, /if \(code === 'P0002' \|\| code === '22023'\) forgetClaimCode\(\);/), 'a refused code frees the search');
const answerPage = read('portal/src/AnswerLink.tsx');
check(() => assert.match(answerPage, /onPointerDown=\{markSeen\} onKeyDown=\{markSeen\}/), 'viewed on the first interaction');
check(() => assert.doesNotMatch(answerPage, /public_placement_answer_seen[\s\S]{0,80}useEffect/), 'never on load');
for (const sheet of ['src/lib/PlacementRequestSheet.tsx', 'src/lib/PlacementCompare.tsx']) {
  const source = read(sheet);
  check(() => assert.match(source, /let answerLink = cachedPlacementAnswerLink\([^)]*\);\s*if \(!answerLink && Platform\.OS !== 'web'\) \{/), `${sheet}: the web never waits before sending`);
  check(() => assert.match(source, /prefetchPlacementAnswerLinks\(/), `${sheet}: links are made ahead of time`);
}
for (const mod of ['src/lib/email-preferences.ts', 'src/lib/coaching.ts', 'src/lib/claim-requests.ts']) {
  check(() => assert.doesNotMatch(read(mod), /new StoreError\(error\.message/), `${mod}: no raw server errors`);
}

console.log(`claim-test: ${checks} checks passed`);
