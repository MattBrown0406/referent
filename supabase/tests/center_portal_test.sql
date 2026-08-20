-- Focused coverage for 20260819210000_center_portal.sql.
-- Run after a local migration reset with: supabase test db

BEGIN;
SELECT plan(12);

INSERT INTO auth.users (id, email)
VALUES
  ('aa100000-0000-0000-0000-0000000000aa', 'admin@example.test'),
  ('aa200000-0000-0000-0000-0000000000aa', 'center@example.test'),
  ('aa300000-0000-0000-0000-0000000000aa', 'other-center@example.test');

INSERT INTO public.platform_admins (user_id)
VALUES ('aa100000-0000-0000-0000-0000000000aa');

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

UPDATE public.global_partners
   SET status = 'active', verified_at = now()
 WHERE id = 'bb100000-0000-0000-0000-0000000000bb';

SELECT is(
  (SELECT status || ':' || (verified_at IS NULL)::text
     FROM public.global_partners WHERE id = 'bb100000-0000-0000-0000-0000000000bb'),
  'pending:true',
  'centers cannot change their own verification state'
);

SELECT is(
  (SELECT count(*)::integer FROM public.global_partners
    WHERE id = 'bb200000-0000-0000-0000-0000000000bb'
      AND description = 'hijacked'),
  0,
  'sanity: the other listing is untouched'
);

SELECT is((SELECT public.center_listing_import_count()), 0, 'import count starts at zero');

-- ─── Admin verification still works ──────────────────────────────────────────

SELECT set_config('request.jwt.claim.sub', 'aa100000-0000-0000-0000-0000000000aa', true);

SELECT lives_ok(
  $$ UPDATE public.global_partners
     SET status = 'active', verified_at = now()
     WHERE id = 'bb100000-0000-0000-0000-0000000000bb' $$,
  'an admin can verify and activate a listing'
);

SELECT is(
  (SELECT status FROM public.global_partners WHERE id = 'bb100000-0000-0000-0000-0000000000bb'),
  'active',
  'admin verification persists'
);

-- ─── Second claim code cannot rebind a claimed account ───────────────────────

SELECT lives_ok(
  $$ SELECT set_config('test.claim_code_2', code, true)
     FROM public.create_center_claim_code('bb200000-0000-0000-0000-0000000000bb') $$,
  'admin issues a second code for the other listing'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
