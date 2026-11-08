-- Focused coverage for 20261108160000_listing_coaching.sql: hourly coaching
-- on an interventionist's profile. Run after a local migration reset with:
-- supabase test db
--
-- This file is never pasted into production.

BEGIN;
SELECT plan(16);

-- o1 owns workspace W and its interventionist profile L1; m1 is a member of
-- W; o2 owns another workspace; a1 is a platform admin; L2 is a program.
INSERT INTO auth.users (id, email)
VALUES
  ('b1000000-0000-0000-0000-0000000000d7', 'owner-d7@example.test'),
  ('b2000000-0000-0000-0000-0000000000d7', 'member-d7@example.test'),
  ('b3000000-0000-0000-0000-0000000000d7', 'other-d7@example.test'),
  ('a1000000-0000-0000-0000-0000000000d7', 'admin-d7@example.test');
INSERT INTO public.platform_admins (user_id) VALUES ('a1000000-0000-0000-0000-0000000000d7');
SELECT set_config('test.org_w', org_id::text, true) FROM public.org_members WHERE user_id = 'b1000000-0000-0000-0000-0000000000d7';
UPDATE public.org_members SET org_id = current_setting('test.org_w')::uuid, role = 'member', display_name = 'Member'
 WHERE user_id = 'b2000000-0000-0000-0000-0000000000d7';
INSERT INTO public.global_partners (id, name, organization, types, city, state, status, verified_at, owner_org_id)
VALUES
  ('d1000000-0000-0000-0000-0000000000d7', 'Matt Example', 'Example Interventions', ARRAY['Interventionist'], 'Bend', 'OR', 'active',
   '2026-01-01T00:00:00Z', current_setting('test.org_w')::uuid),
  ('d2000000-0000-0000-0000-0000000000d7', 'Admissions', 'Example Recovery', ARRAY['Inpatient'], 'Bend', 'OR', 'active', now(), NULL),
  ('d3000000-0000-0000-0000-0000000000d7', 'Pat Pending', 'Pending Coaching', ARRAY['Therapist'], 'Bend', 'OR', 'pending', NULL, NULL);
UPDATE public.global_partners SET coaching_offered = true, coaching_hourly_rate = 90 WHERE id = 'd3000000-0000-0000-0000-0000000000d7';

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000d7', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT row(coaching_offered, coaching_hourly_rate, coaching_note)::text
             FROM public.set_listing_coaching('d1000000-0000-0000-0000-0000000000d7', true, 150, '  By Zoom or phone, for families  ')),
  '(t,150,"By Zoom or phone, for families")', 'the owner offers hourly coaching with a rate and a note');
SELECT throws_ok($$ SELECT * FROM public.set_listing_coaching('d1000000-0000-0000-0000-0000000000d7', true, NULL, '') $$,
  '22023', NULL, 'offering coaching needs a rate');
SELECT throws_ok($$ SELECT * FROM public.set_listing_coaching('d1000000-0000-0000-0000-0000000000d7', true, 0, '') $$,
  '22023', NULL, 'the rate is at least $1');
SELECT throws_ok($$ SELECT * FROM public.set_listing_coaching('d1000000-0000-0000-0000-0000000000d7', true, 6000, '') $$,
  '22023', NULL, 'and at most $5,000');
SELECT throws_ok($$ UPDATE public.global_partners SET coaching_hourly_rate = 1 WHERE id = 'd1000000-0000-0000-0000-0000000000d7' $$,
  '42501', NULL, 'nobody writes the columns directly');
SELECT is((SELECT row(coaching_offered, coaching_hourly_rate)::text
             FROM public.set_listing_coaching('d1000000-0000-0000-0000-0000000000d7', false, NULL, '')),
  '(f,150)', 'turning it off keeps the last rate for next time');
SELECT lives_ok($$ SELECT * FROM public.set_listing_coaching('d1000000-0000-0000-0000-0000000000d7', true, 175, 'Families and professionals') $$,
  'and back on with a new rate');
RESET ROLE;
SELECT is((SELECT verified_at FROM public.global_partners WHERE id = 'd1000000-0000-0000-0000-0000000000d7'), '2026-01-01T00:00:00Z'::timestamptz,
  'coaching changes leave verification as it is');

SELECT set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-0000000000d7', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT * FROM public.set_listing_coaching('d1000000-0000-0000-0000-0000000000d7', true, 1, '') $$,
  '42501', NULL, 'a member who is not the owner cannot change it');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'b3000000-0000-0000-0000-0000000000d7', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT * FROM public.set_listing_coaching('d1000000-0000-0000-0000-0000000000d7', true, 1, '') $$,
  '42501', NULL, 'nor can another workspace');
SELECT is((SELECT coaching_hourly_rate || ':' || coaching_note FROM public.fetch_listing_coaching(ARRAY['d1000000-0000-0000-0000-0000000000d7']::uuid[])),
  '175:Families and professionals', 'any signed-in reader sees the coaching');
SELECT is((SELECT count(*)::integer FROM public.fetch_listing_coaching(ARRAY['d3000000-0000-0000-0000-0000000000d7']::uuid[])), 0,
  'a listing that is not live shows nothing');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT throws_ok($$ SELECT * FROM public.fetch_listing_coaching(ARRAY['d1000000-0000-0000-0000-0000000000d7']::uuid[]) $$,
  '42501', NULL, 'signed out reads nothing');
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000d7', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT * FROM public.set_listing_coaching('d2000000-0000-0000-0000-0000000000d7', true, 100, '') $$,
  '22023', NULL, 'programs do not list hourly coaching');
SELECT lives_ok($$ SELECT * FROM public.set_listing_coaching('d1000000-0000-0000-0000-0000000000d7', true, 200, '') $$,
  'a platform admin can set it on a profile');
SELECT throws_ok($$ SELECT * FROM public.set_listing_coaching('00000000-0000-0000-0000-000000000000', true, 100, '') $$,
  'P0002', NULL, 'an unknown listing');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
