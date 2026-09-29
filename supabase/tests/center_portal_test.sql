-- Focused coverage for 20260819210000_center_portal.sql.
-- Run after a local migration reset with: supabase test db

BEGIN;
-- Center-portal visibility is asserted with the plan gates as they behave once
-- the free launch period ends (a center account with a practice workspace
-- would otherwise also see every active listing, which is fine but not what
-- this suite measures). Rolled back with the rest of the transaction.
CREATE OR REPLACE FUNCTION public.free_launch_period()
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$ SELECT false $$;
SELECT plan(28);

INSERT INTO auth.users (id, email)
VALUES
  ('aa100000-0000-0000-0000-0000000000aa', 'admin@example.test'),
  ('aa200000-0000-0000-0000-0000000000aa', 'center@example.test'),
  ('aa300000-0000-0000-0000-0000000000aa', 'other-center@example.test'),
  ('aa400000-0000-0000-0000-0000000000aa', 'practice@example.test');

INSERT INTO public.platform_admins (user_id)
VALUES ('aa100000-0000-0000-0000-0000000000aa');

-- The practice workspace needs directory access to import a listing.
INSERT INTO public.org_entitlements (org_id, entitlement, active, source)
SELECT org_id, 'directory', true, 'manual'
  FROM public.org_members
 WHERE user_id = 'aa400000-0000-0000-0000-0000000000aa';

INSERT INTO public.global_partners (id, name, organization, status)
VALUES
  ('bb100000-0000-0000-0000-0000000000bb', 'Admissions', 'Claimable Program', 'pending'),
  ('bb200000-0000-0000-0000-0000000000bb', 'Admissions', 'Other Program', 'active');

-- ─── Claim code issuance ─────────────────────────────────────────────────────

SELECT set_config('request.jwt.claim.sub', 'aa200000-0000-0000-0000-0000000000aa', true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$ SELECT * FROM public.create_center_claim_code('bb100000-0000-0000-0000-0000000000bb') $$,
  '42501',
  'Only platform admins can issue claim codes',
  'non-admins cannot issue claim codes'
);

SELECT set_config('request.jwt.claim.sub', 'aa100000-0000-0000-0000-0000000000aa', true);

SELECT lives_ok(
  $$ SELECT set_config('test.claim_code', code, true)
     FROM public.create_center_claim_code('bb100000-0000-0000-0000-0000000000bb') $$,
  'an admin can issue a claim code for a listing'
);

-- ─── Claiming ────────────────────────────────────────────────────────────────

SELECT set_config('request.jwt.claim.sub', 'aa200000-0000-0000-0000-0000000000aa', true);

SELECT is(
  (SELECT public.claim_center_listing(current_setting('test.claim_code'))),
  'bb100000-0000-0000-0000-0000000000bb'::uuid,
  'a center account can claim its listing with the code'
);

SELECT throws_ok(
  $$ SELECT public.claim_center_listing(current_setting('test.claim_code')) $$,
  '22023',
  'This account already manages a listing',
  'one account manages at most one listing'
);

SELECT is(
  (SELECT count(*)::integer FROM public.global_partners),
  1,
  'a center reads its own listing (even while pending) and nothing else'
);

-- ─── Center edits ────────────────────────────────────────────────────────────

SELECT lives_ok(
  $$ UPDATE public.global_partners
     SET description = 'Family-first residential program', city = 'Bend', state = 'OR'
     WHERE id = 'bb100000-0000-0000-0000-0000000000bb' $$,
  'a center can edit its listing content'
);

SELECT throws_ok(
  $$ UPDATE public.global_partners
        SET status = 'active', verified_at = now()
      WHERE id = 'bb100000-0000-0000-0000-0000000000bb' $$,
  '42501',
  NULL,
  'centers have no column privilege to request verification changes'
);

SELECT is(
  (SELECT status || ':' || (verified_at IS NULL)::text
     FROM public.global_partners WHERE id = 'bb100000-0000-0000-0000-0000000000bb'),
  'pending:false',
  'claiming verifies the listing; a center edit keeps the admin-controlled status and re-attests verification'
);

SELECT throws_ok(
  $$ UPDATE public.global_partners SET created_at = now() - interval '1 year'
      WHERE id = 'bb100000-0000-0000-0000-0000000000bb' $$,
  '42501',
  NULL,
  'centers cannot rewrite listing audit provenance'
);

SELECT is(
  (SELECT count(*)::integer FROM public.global_partners
    WHERE id = 'bb200000-0000-0000-0000-0000000000bb'
      AND description = 'hijacked'),
  0,
  'sanity: the other listing is untouched'
);

SELECT is((SELECT public.center_listing_import_count()), 0, 'import count starts at zero');

-- ─── Insurance network status (portal "bill out-of-network") ─────────────────

SELECT lives_ok(
  $$ UPDATE public.global_partners
        SET insurance = ARRAY['Aetna', 'Cigna'],
            insurance_networks = '{"Aetna": ["In-network", "Out-of-network"], "Cigna": ["Out-of-network"]}'::jsonb
      WHERE id = 'bb100000-0000-0000-0000-0000000000bb' $$,
  'a center can record in-network and out-of-network billing per carrier'
);

SELECT is(
  (SELECT insurance_networks FROM public.global_partners WHERE id = 'bb100000-0000-0000-0000-0000000000bb'),
  '{"Aetna": ["In-network", "Out-of-network"], "Cigna": ["Out-of-network"]}'::jsonb,
  'the per-carrier network statuses persist as written'
);

SELECT throws_ok(
  $$ UPDATE public.global_partners
        SET insurance_networks = '{"Aetna": [], "Cigna": ["Out-of-network"]}'::jsonb
      WHERE id = 'bb100000-0000-0000-0000-0000000000bb' $$,
  '23514',
  NULL,
  'a carrier with no network status is rejected by the check constraint'
);

SELECT throws_ok(
  $$ UPDATE public.global_partners
        SET insurance_networks = '{"Aetna": ["Self-pay"], "Cigna": ["Out-of-network"]}'::jsonb
      WHERE id = 'bb100000-0000-0000-0000-0000000000bb' $$,
  '23514',
  NULL,
  'an unknown network status is rejected by the check constraint'
);

SELECT throws_ok(
  $$ UPDATE public.global_partners
        SET insurance_networks = '{"Aetna": ["Out-of-network", "Out-of-network"], "Cigna": ["Out-of-network"]}'::jsonb
      WHERE id = 'bb100000-0000-0000-0000-0000000000bb' $$,
  '23514',
  NULL,
  'a duplicated network status is rejected by the check constraint'
);

SELECT is(
  (SELECT insurance_networks FROM public.global_partners WHERE id = 'bb100000-0000-0000-0000-0000000000bb'),
  '{"Aetna": ["In-network", "Out-of-network"], "Cigna": ["Out-of-network"]}'::jsonb,
  'rejected payloads leave the saved network statuses untouched'
);

-- ─── Admin verification still works ──────────────────────────────────────────

SELECT set_config('request.jwt.claim.sub', 'aa100000-0000-0000-0000-0000000000aa', true);

SELECT lives_ok(
  $$ SELECT public.set_global_partner_verification(
       'bb100000-0000-0000-0000-0000000000bb', 'active', now()
     ) $$,
  'an admin can verify and activate a listing'
);

SELECT is(
  (SELECT status FROM public.global_partners WHERE id = 'bb100000-0000-0000-0000-0000000000bb'),
  'active',
  'admin verification persists'
);

SELECT set_config('request.jwt.claim.sub', 'aa200000-0000-0000-0000-0000000000aa', true);
UPDATE public.global_partners
   SET description = 'Updated after verification'
 WHERE id = 'bb100000-0000-0000-0000-0000000000bb';
SELECT is(
  (SELECT status || ':' || (verified_at IS NULL)::text
     FROM public.global_partners WHERE id = 'bb100000-0000-0000-0000-0000000000bb'),
  'active:false',
  'a center content edit preserves admin-controlled status and keeps the claimed listing verified'
);

-- ─── Network status propagates to linked tenant partners ─────────────────────

SELECT set_config('request.jwt.claim.sub', 'aa400000-0000-0000-0000-0000000000aa', true);

SELECT lives_ok(
  $$ SELECT public.import_global_partner(
       'bb100000-0000-0000-0000-0000000000bb'::uuid,
       'cc100000-0000-0000-0000-0000000000cc'::uuid
     ) $$,
  'a practice imports the active listing into its workspace'
);

SELECT is(
  (SELECT insurance_networks FROM public.partners WHERE id = 'cc100000-0000-0000-0000-0000000000cc'),
  '{"Aetna": ["In-network", "Out-of-network"], "Cigna": ["Out-of-network"]}'::jsonb,
  'the import copies the listing network statuses into the tenant partner'
);

SELECT set_config('request.jwt.claim.sub', 'aa200000-0000-0000-0000-0000000000aa', true);

SELECT lives_ok(
  $$ UPDATE public.global_partners
        SET insurance_networks = '{"Aetna": ["Out-of-network"], "Cigna": ["Out-of-network"]}'::jsonb
      WHERE id = 'bb100000-0000-0000-0000-0000000000bb' $$,
  'the center switches every carrier to out-of-network only'
);

-- Tenant partners are only visible from inside their own workspace.
SELECT set_config('request.jwt.claim.sub', 'aa400000-0000-0000-0000-0000000000aa', true);

SELECT is(
  (SELECT insurance_networks FROM public.partners WHERE id = 'cc100000-0000-0000-0000-0000000000cc'),
  '{"Aetna": ["Out-of-network"], "Cigna": ["Out-of-network"]}'::jsonb,
  'the center edit propagates network statuses to a linked partner with no local override'
);

SELECT ok(
  (SELECT NOT ('insurance_networks' = ANY (local_overrides))
     FROM public.partners WHERE id = 'cc100000-0000-0000-0000-0000000000cc'),
  'propagation does not mark the synced field as a local override'
);

-- A practice that hand-edited its copy keeps its own network statuses.
UPDATE public.partners
   SET insurance_networks = '{"Aetna": ["In-network"], "Cigna": ["Out-of-network"]}'::jsonb
 WHERE id = 'cc100000-0000-0000-0000-0000000000cc';

SELECT set_config('request.jwt.claim.sub', 'aa200000-0000-0000-0000-0000000000aa', true);
UPDATE public.global_partners
   SET insurance_networks = '{"Aetna": ["In-network", "Out-of-network"], "Cigna": ["In-network", "Out-of-network"]}'::jsonb
 WHERE id = 'bb100000-0000-0000-0000-0000000000bb';

SELECT set_config('request.jwt.claim.sub', 'aa400000-0000-0000-0000-0000000000aa', true);
SELECT is(
  (SELECT insurance_networks FROM public.partners WHERE id = 'cc100000-0000-0000-0000-0000000000cc'),
  '{"Aetna": ["In-network"], "Cigna": ["Out-of-network"]}'::jsonb,
  'a locally overridden network status is not clobbered by a later center edit'
);

-- ─── Second claim code cannot rebind a claimed account ───────────────────────

SELECT set_config('request.jwt.claim.sub', 'aa100000-0000-0000-0000-0000000000aa', true);
SELECT throws_ok(
  $$ SELECT * FROM public.create_center_claim_code('bb100000-0000-0000-0000-0000000000bb') $$,
  '22023',
  'Directory listing is already claimed',
  'an admin cannot issue another bootstrap code for a claimed listing'
);
SELECT lives_ok(
  $$ SELECT set_config('test.claim_code_2', code, true)
     FROM public.create_center_claim_code('bb200000-0000-0000-0000-0000000000bb') $$,
  'admin issues a second code for the other listing'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
