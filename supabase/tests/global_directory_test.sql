-- Focused coverage for 20260819180000_global_directory.sql.
-- Run after a local migration reset with: supabase test db

BEGIN;
SELECT plan(12);

INSERT INTO auth.users (id, email)
VALUES
  ('f1000000-0000-0000-0000-00000000000f', 'curator@example.test'),
  ('f2000000-0000-0000-0000-00000000000f', 'subscriber@example.test'),
  ('f3000000-0000-0000-0000-00000000000f', 'free-user@example.test');

INSERT INTO public.platform_admins (user_id)
VALUES ('f1000000-0000-0000-0000-00000000000f');

INSERT INTO public.org_entitlements (org_id, entitlement, active, source)
SELECT org_id, 'directory', true, 'manual'
  FROM public.org_members
 WHERE user_id = 'f2000000-0000-0000-0000-00000000000f';

-- ─── Curation ────────────────────────────────────────────────────────────────

SELECT set_config('request.jwt.claim.sub', 'f1000000-0000-0000-0000-00000000000f', true);
SET LOCAL ROLE authenticated;

SELECT ok(public.is_platform_admin(), 'the curator is recognized as a platform admin');

SELECT lives_ok(
  $$ INSERT INTO public.global_partners (id, name, organization, types, city, state, levels, status, verified_at)
     VALUES ('11110000-0000-0000-0000-000000000001', 'Admissions Team', 'Cascade Recovery Center', ARRAY['Inpatient'], 'Bend', 'OR', ARRAY['Residential'], 'active', now()),
            ('11110000-0000-0000-0000-000000000002', 'Front Desk', 'Pending Program', ARRAY['Inpatient'], 'Salem', 'OR', ARRAY['Detox'], 'pending', NULL) $$,
  'a platform admin can create directory listings'
);

SELECT is(
  (SELECT count(*)::integer FROM public.global_partners),
  2,
  'admins see listings in every status'
);

-- ─── Entitled subscriber ─────────────────────────────────────────────────────

SELECT set_config('request.jwt.claim.sub', 'f2000000-0000-0000-0000-00000000000f', true);

SELECT ok(NOT public.is_platform_admin(), 'a subscriber is not a platform admin');

SELECT is(
  (SELECT count(*)::integer FROM public.global_partners),
  1,
  'a directory subscriber sees only active listings'
);

SELECT throws_ok(
  $$ INSERT INTO public.global_partners (name, organization) VALUES ('Rogue', 'Rogue Org') $$,
  '42501',
  NULL,
  'subscribers cannot write to the shared directory'
);

SELECT lives_ok(
  $$ SELECT public.import_global_partner(
       '11110000-0000-0000-0000-000000000001'::uuid,
       '22220000-0000-0000-0000-000000000001'::uuid
     ) $$,
  'a subscriber can import an active listing into their network'
);

SELECT is(
  (SELECT organization || ':' || (global_partner_id IS NOT NULL)::text
     FROM public.partners WHERE id = '22220000-0000-0000-0000-000000000001'),
  'Cascade Recovery Center:true',
  'the import copies the listing into a linked tenant partner'
);

SELECT is(
  (SELECT public.import_global_partner(
     '11110000-0000-0000-0000-000000000001'::uuid,
     '22220000-0000-0000-0000-000000000009'::uuid
   )),
  '22220000-0000-0000-0000-000000000001'::uuid,
  'a repeat import returns the existing partner instead of duplicating'
);

SELECT throws_ok(
  $$ SELECT public.import_global_partner(
       '11110000-0000-0000-0000-000000000002'::uuid,
       '22220000-0000-0000-0000-000000000002'::uuid
     ) $$,
  'P0002',
  'Directory listing not found',
  'pending listings cannot be imported'
);

-- ─── Free tier ───────────────────────────────────────────────────────────────

SELECT set_config('request.jwt.claim.sub', 'f3000000-0000-0000-0000-00000000000f', true);

SELECT is(
  (SELECT count(*)::integer FROM public.global_partners),
  0,
  'without the directory entitlement no listings are visible'
);

SELECT throws_ok(
  $$ SELECT public.import_global_partner(
       '11110000-0000-0000-0000-000000000001'::uuid,
       '22220000-0000-0000-0000-000000000003'::uuid
     ) $$,
  'P0002',
  'Directory listing not found',
  'without the entitlement the import RPC finds nothing'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
