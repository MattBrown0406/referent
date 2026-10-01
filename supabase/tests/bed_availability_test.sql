-- Focused coverage for 20261001150000_bed_availability.sql.
-- Run after a local migration reset with: supabase test db
--
-- This file is never pasted into production.

BEGIN;
SELECT plan(48);

-- Actors
--   s1  platform admin
--   c1  center account that claims L1 (Inpatient)
--   c2  center account that claims L2 (Therapist: an individual professional)
--   p1  owner of practice P; imports L1, favorites L4; push on, bed_opened on
--   p2  member of practice P; push on, bed_opened off (the default)
--   q1  owner of practice Q; follows nothing; push on, bed_opened on
INSERT INTO auth.users (id, email)
VALUES
  ('a1000000-0000-0000-0000-0000000000bd', 'beds-admin@example.test'),
  ('c1000000-0000-0000-0000-0000000000bd', 'beds-center-one@example.test'),
  ('c2000000-0000-0000-0000-0000000000bd', 'beds-center-two@example.test'),
  ('b1000000-0000-0000-0000-0000000000bd', 'beds-p1@example.test'),
  ('b2000000-0000-0000-0000-0000000000bd', 'beds-p2@example.test'),
  ('b3000000-0000-0000-0000-0000000000bd', 'beds-q1@example.test');

INSERT INTO public.platform_admins (user_id) VALUES ('a1000000-0000-0000-0000-0000000000bd');

SELECT set_config('test.org_p', org_id::text, true) FROM public.org_members WHERE user_id = 'b1000000-0000-0000-0000-0000000000bd';
UPDATE public.org_members SET org_id = current_setting('test.org_p')::uuid, role = 'member'
 WHERE user_id = 'b2000000-0000-0000-0000-0000000000bd';

-- Listings
--   L1  Inpatient program, verified two months ago (claimed by c1 below)
--   L2  Therapist, an individual professional (claimed by c2 below)
--   L3  Detox program, beds never set (unknown)
--   L4  Sober Living program, set by the admin, then aged past the window
INSERT INTO public.global_partners (id, name, organization, types, city, state, phone, status, verified_at)
VALUES
  ('d1000000-0000-0000-0000-0000000000bd', 'Admissions', 'Juniper Ridge Recovery', ARRAY['Inpatient'], 'Bend', 'OR', '(541) 555-0400', 'active', now() - interval '60 days'),
  ('d2000000-0000-0000-0000-0000000000bd', 'Dr. Lee', 'Lee Counseling', ARRAY['Therapist'], 'Bend', 'OR', '(541) 555-0401', 'active', now()),
  ('d3000000-0000-0000-0000-0000000000bd', 'Intake', 'High Desert Detox', ARRAY['Detox'], 'Redmond', 'OR', '(541) 555-0402', 'active', now()),
  ('d4000000-0000-0000-0000-0000000000bd', 'Intake', 'Pine Street Sober Living', ARRAY['Sober Living'], 'Bend', 'OR', '(541) 555-0403', 'active', now());

SELECT set_config('test.l1_verified', verified_at::text, true)
  FROM public.global_partners WHERE id = 'd1000000-0000-0000-0000-0000000000bd';

-- ===========================================================================
-- A. Schema
-- ===========================================================================

SELECT has_column('public', 'global_partners', 'beds_male', 'global_partners.beds_male exists');
SELECT has_column('public', 'global_partners', 'beds_female', 'global_partners.beds_female exists');
SELECT has_column('public', 'global_partners', 'beds_updated_at', 'global_partners.beds_updated_at exists');
SELECT has_column('public', 'global_partners', 'beds_updated_by', 'global_partners.beds_updated_by exists');
SELECT has_table('public', 'listing_bed_updates', 'listing_bed_updates exists');
SELECT is(public.bed_stale_days(), 7, 'the staleness window is seven days');

-- ===========================================================================
-- B. Claims, an import, a favorite, and push opt-ins
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000bd', true);
SET LOCAL ROLE authenticated;
SELECT set_config('test.code_l1', code, true) FROM public.create_center_claim_code('d1000000-0000-0000-0000-0000000000bd');
SELECT set_config('test.code_l2', code, true) FROM public.create_center_claim_code('d2000000-0000-0000-0000-0000000000bd');

SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000bd', true);
SELECT public.claim_center_listing(current_setting('test.code_l1'));
SELECT set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-0000000000bd', true);
SELECT public.claim_center_listing(current_setting('test.code_l2'));

-- p1 imports L1 into practice P and favorites L4.
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000bd', true);
SELECT public.import_global_partner('d1000000-0000-0000-0000-0000000000bd', 'f1000000-0000-0000-0000-0000000000bd');
SELECT public.toggle_user_favorite('global_partner', 'd4000000-0000-0000-0000-0000000000bd');
SELECT public.register_push_token('ExponentPushToken[bdp1bdp1bdp1bdp1bdp1bd]', 'ios', -420);
INSERT INTO public.notification_preferences (user_id, push_enabled, bed_opened) VALUES ('b1000000-0000-0000-0000-0000000000bd', true, true);

SELECT set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-0000000000bd', true);
SELECT public.register_push_token('ExponentPushToken[bdp2bdp2bdp2bdp2bdp2bd]', 'ios', -420);
INSERT INTO public.notification_preferences (user_id, push_enabled) VALUES ('b2000000-0000-0000-0000-0000000000bd', true);

SELECT set_config('request.jwt.claim.sub', 'b3000000-0000-0000-0000-0000000000bd', true);
SELECT public.register_push_token('ExponentPushToken[bdq1bdq1bdq1bdq1bdq1bd]', 'ios', -420);
INSERT INTO public.notification_preferences (user_id, push_enabled, bed_opened) VALUES ('b3000000-0000-0000-0000-0000000000bd', true, true);

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('test.synced_before', (coalesce(global_synced_at::text, 'never') || '|' || array_to_string(local_overrides, ',')), true)
  FROM public.partners WHERE id = 'f1000000-0000-0000-0000-0000000000bd';

SELECT is(
  (SELECT bed_opened FROM public.notification_preferences WHERE user_id = 'b2000000-0000-0000-0000-0000000000bd'),
  false,
  'bed_opened defaults to off (opt-in)'
);

-- ===========================================================================
-- C. Who can set beds
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000bd', true);
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT (beds_male, beds_female, beds_stale)::text
     FROM public.set_listing_beds('d1000000-0000-0000-0000-0000000000bd', 3, 0, '  Dana Whitfield ', '(541) 555-0444')),
  '(3,0,f)',
  'the claimant sets its own listing''s beds and gets the fresh status back'
);

SELECT is(
  (SELECT (beds_male, beds_female, beds_updated_by::text, admissions_contact_name, admissions_contact_phone, beds_updated_at IS NOT NULL)::text
     FROM public.global_partners WHERE id = 'd1000000-0000-0000-0000-0000000000bd'),
  '(3,0,c1000000-0000-0000-0000-0000000000bd,"Dana Whitfield","(541) 555-0444",t)',
  'the counts, the stamp, and the trimmed admissions contact are stored on the listing'
);

SELECT is(
  (SELECT verified_at::text FROM public.global_partners WHERE id = 'd1000000-0000-0000-0000-0000000000bd'),
  current_setting('test.l1_verified'),
  'a bed update leaves verification exactly as it was'
);

SELECT throws_ok(
  $$ SELECT * FROM public.set_listing_beds('d4000000-0000-0000-0000-0000000000bd', 1, 1, '', '') $$,
  '42501',
  'Only the program that claimed this listing or a platform admin can update its beds',
  'a claimant cannot set another listing''s beds'
);

-- The column-level UPDATE grant (20260820033721) does not include the bed
-- columns, so a direct write fails on permission before the guard trigger
-- even runs. Either way: 42501.
SELECT throws_ok(
  $$ UPDATE public.global_partners SET beds_male = 9 WHERE id = 'd1000000-0000-0000-0000-0000000000bd' $$,
  '42501',
  NULL,
  'bed columns cannot be written around the RPC, even by the claimant'
);

SELECT set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-0000000000bd', true);

SELECT throws_ok(
  $$ SELECT * FROM public.set_listing_beds('d2000000-0000-0000-0000-0000000000bd', 1, 1, '', '') $$,
  '22023',
  'Only treatment programs carry bed counts',
  'an individual professional''s listing rejects bed updates from its claimant'
);

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000bd', true);

SELECT throws_ok(
  $$ SELECT * FROM public.set_listing_beds('d1000000-0000-0000-0000-0000000000bd', 1, 1, '', '') $$,
  '42501',
  'Only the program that claimed this listing or a platform admin can update its beds',
  'a tenant that imported the listing cannot set its beds'
);

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000bd', true);

SELECT is(
  (SELECT (beds_male, beds_female)::text FROM public.set_listing_beds('d4000000-0000-0000-0000-0000000000bd', 0, 2, 'Front desk', '')),
  '(0,2)',
  'a platform admin sets any program''s beds'
);

SELECT throws_ok(
  $$ SELECT * FROM public.set_listing_beds('d2000000-0000-0000-0000-0000000000bd', 1, 1, '', '') $$,
  '22023',
  'Only treatment programs carry bed counts',
  'an individual professional''s listing rejects bed updates from an admin too'
);

SELECT throws_ok(
  $$ SELECT * FROM public.set_listing_beds('d1000000-0000-0000-0000-0000000000bd', -1, 0, '', '') $$,
  '22023',
  'Bed counts must be between 0 and 999',
  'a negative count is refused'
);

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

SELECT throws_ok(
  $$ SELECT * FROM public.set_listing_beds('d1000000-0000-0000-0000-0000000000bd', 1, 1, '', '') $$,
  '28000',
  'Authentication is required',
  'nobody signed in cannot set beds'
);

-- ===========================================================================
-- D. Beds never reach tenant copies
-- ===========================================================================

SELECT hasnt_column('public', 'partners', 'beds_male', 'partners has no beds_male');
SELECT hasnt_column('public', 'partners', 'beds_female', 'partners has no beds_female');

SELECT is(
  (SELECT coalesce(global_synced_at::text, 'never') || '|' || array_to_string(local_overrides, ',') FROM public.partners WHERE id = 'f1000000-0000-0000-0000-0000000000bd'),
  current_setting('test.synced_before'),
  'a bed update does not touch the imported copy'
);

-- By contrast an ordinary content edit by the claimant still works and still
-- propagates (the existing behaviour from 20260928170000).
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000bd', true);
SELECT lives_ok(
  $$ UPDATE public.global_partners SET city = 'Sisters' WHERE id = 'd1000000-0000-0000-0000-0000000000bd' $$,
  'the claimant still edits every other column directly'
);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

SELECT ok(
  (SELECT prosrc NOT LIKE '%beds%' FROM pg_proc WHERE proname = 'propagate_global_partner_changes')
  AND (SELECT prosrc NOT LIKE '%beds%' FROM pg_proc WHERE proname = 'guard_global_partner_verification'),
  'neither propagation nor the verification guard knows about bed columns'
);

SELECT ok(
  NOT (ARRAY['beds_male', 'beds_female', 'beds_updated_at', 'beds_updated_by', 'admissions_contact_name', 'admissions_contact_phone'] && public.global_partner_synced_fields())
  AND NOT (ARRAY['beds_male', 'beds_female', 'beds_updated_at', 'beds_updated_by', 'admissions_contact_name', 'admissions_contact_phone'] && public.seed_partner_pushed_fields())
  AND NOT (ARRAY['beds_male', 'beds_female', 'beds_updated_at', 'beds_updated_by', 'admissions_contact_name', 'admissions_contact_phone'] && public.org_directory_profile_fields()),
  'no synced, pushed, or profile field list carries a bed column'
);

-- ===========================================================================
-- E. Staleness flips at seven days
-- ===========================================================================

SELECT is(
  public.listing_beds_stale('2026-01-08 12:00:00+00', '2026-01-15 11:59:59+00'),
  false,
  'a count confirmed just under seven days ago is current'
);
SELECT is(
  public.listing_beds_stale('2026-01-08 12:00:00+00', '2026-01-15 12:00:01+00'),
  true,
  'a count confirmed just over seven days ago is unconfirmed'
);
SELECT is(public.listing_beds_stale(NULL), true, 'a count never confirmed is unconfirmed');

-- Age L4 past the window. The superuser has no auth.uid(), so the guard
-- lets this through (a test-only shortcut; production has no such path).
UPDATE public.global_partners SET beds_updated_at = now() - interval '8 days' WHERE id = 'd4000000-0000-0000-0000-0000000000bd';

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000bd', true);
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT string_agg(left(global_partner_id::text, 2) || ':' || program::text || ':' || beds_stale::text, ',' ORDER BY global_partner_id)
     FROM public.fetch_listing_beds(ARRAY['d1000000-0000-0000-0000-0000000000bd', 'd2000000-0000-0000-0000-0000000000bd', 'd3000000-0000-0000-0000-0000000000bd', 'd4000000-0000-0000-0000-0000000000bd']::uuid[])),
  'd1:true:false,d2:false:true,d3:true:true,d4:true:true',
  'fetch_listing_beds reports program-ness and staleness: fresh, professional, never set, aged'
);

-- ===========================================================================
-- F. Search: the bed filter keeps unknown, drops confirmed 0 and stale
-- ===========================================================================

SELECT is(
  (SELECT (beds_male, beds_female, beds_stale, admissions_contact_name)::text
     FROM public.search_global_partners(p_types => ARRAY['Inpatient'])
    WHERE id = 'd1000000-0000-0000-0000-0000000000bd'),
  '(3,0,f,"Dana Whitfield")',
  'search returns the bed columns with beds_stale computed server-side'
);

SELECT is(
  (SELECT array_agg(left(id::text, 2) ORDER BY id)
     FROM public.search_global_partners(p_types => ARRAY['Inpatient', 'IOP / PHP', 'Sober Living', 'Detox'], p_bed_for => 'men')),
  ARRAY['d1', 'd3'],
  'men: a confirmed open bed and an unknown stay; a stale count is dropped'
);

SELECT is(
  (SELECT array_agg(left(id::text, 2) ORDER BY id)
     FROM public.search_global_partners(p_types => ARRAY['Inpatient', 'IOP / PHP', 'Sober Living', 'Detox'], p_bed_for => 'women')),
  ARRAY['d3'],
  'women: a confirmed 0 and a stale count are dropped; unknown stays'
);

SELECT is(
  (SELECT count(*)::integer FROM public.search_global_partners(p_types => ARRAY['Inpatient', 'IOP / PHP', 'Sober Living', 'Detox'])),
  3,
  'with no bed filter every program is listed'
);

SELECT is(
  (SELECT count(*)::integer FROM public.search_global_partners()),
  4,
  'positional callers and professionals are unaffected'
);

-- ===========================================================================
-- G. History: admins and claimants only; cadence badge
-- ===========================================================================

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

SELECT is(
  (SELECT (count(*), count(*) FILTER (WHERE global_partner_id = 'd1000000-0000-0000-0000-0000000000bd'), count(*) FILTER (WHERE updated_by = 'a1000000-0000-0000-0000-0000000000bd'))::text
     FROM public.listing_bed_updates),
  '(2,1,1)',
  'every successful set writes one history row with who set it'
);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000bd', true);
SELECT is(
  (SELECT (count(*), min(left(global_partner_id::text, 2)))::text FROM public.listing_bed_updates),
  '(1,d1)',
  'a claimant reads only its own listing''s history'
);

SELECT set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-0000000000bd', true);
SELECT is((SELECT count(*)::integer FROM public.listing_bed_updates), 0, 'another claimant sees none of it');

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000bd', true);
SELECT is((SELECT count(*)::integer FROM public.listing_bed_updates), 0, 'a tenant that imported the listing sees no history');

SELECT throws_ok(
  $$ INSERT INTO public.listing_bed_updates (global_partner_id, beds_male, beds_female) VALUES ('d1000000-0000-0000-0000-0000000000bd', 1, 1) $$,
  '42501',
  NULL,
  'no client role writes history directly'
);

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000bd', true);
SELECT is((SELECT count(*)::integer FROM public.listing_bed_updates), 2, 'a platform admin reads every listing''s history');

SELECT is(public.listing_bed_cadence_days('d4000000-0000-0000-0000-0000000000bd'), NULL, 'fewer than three updates earn no cadence badge');

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
-- Three fixed updates for L3: gaps of 3 and 4 days, mean 3.5, badge 4.
INSERT INTO public.listing_bed_updates (global_partner_id, updated_at, beds_male, beds_female, updated_by)
VALUES
  ('d3000000-0000-0000-0000-0000000000bd', now() - interval '10 days', 1, 1, 'a1000000-0000-0000-0000-0000000000bd'),
  ('d3000000-0000-0000-0000-0000000000bd', now() - interval '7 days', 2, 1, 'a1000000-0000-0000-0000-0000000000bd'),
  ('d3000000-0000-0000-0000-0000000000bd', now() - interval '3 days', 0, 1, 'a1000000-0000-0000-0000-0000000000bd');

SELECT is(public.listing_bed_cadence_days('d3000000-0000-0000-0000-0000000000bd'), 4, 'the cadence badge is the ceiling of the mean gap between recent updates');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000bd', true);
SELECT is(
  (SELECT beds_cadence_days FROM public.search_global_partners(p_types => ARRAY['Detox']) WHERE id = 'd3000000-0000-0000-0000-0000000000bd'),
  4,
  'search carries the cadence badge for the directory card'
);

-- ===========================================================================
-- H. Push: bed_opened only on 0 / unknown -> open, only to opted-in followers
-- ===========================================================================

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

-- The first L1 write (men unknown -> 3) and the admin's L4 write (women
-- unknown -> 2) already happened. p1 follows both (import, favorite); p2 is
-- in the same practice but opted out; q1 opted in but follows nothing.
SELECT is(
  (SELECT (count(*), count(*) FILTER (WHERE user_id = 'b1000000-0000-0000-0000-0000000000bd'),
           count(*) FILTER (WHERE data ->> 'global_partner_id' = 'd1000000-0000-0000-0000-0000000000bd'),
           count(*) FILTER (WHERE data ->> 'global_partner_id' = 'd4000000-0000-0000-0000-0000000000bd'))::text
     FROM public.notification_outbox WHERE kind = 'bed_opened'),
  '(2,2,1,1)',
  'a bed opening reaches the opted-in follower through an import and through a favorite, and nobody else'
);

SELECT is(
  (SELECT (title, body, data - 'user_id' - 'kind' - 'global_partner_id' = '{}'::jsonb)::text
     FROM public.notification_outbox WHERE kind = 'bed_opened' AND data ->> 'global_partner_id' = 'd1000000-0000-0000-0000-0000000000bd'),
  '("A bed opened","A program you follow has a bed open today.",t)',
  'the push is generic: no program name, no count, only the listing id'
);

-- Mark both sent so dedup of unsent duplicates cannot mask the next checks.
UPDATE public.notification_outbox SET sent_at = now() WHERE kind = 'bed_opened';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000bd', true);
SELECT public.set_listing_beds('d1000000-0000-0000-0000-0000000000bd', 4, 0, 'Dana Whitfield', '(541) 555-0444');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

SELECT is(
  (SELECT count(*)::integer FROM public.notification_outbox WHERE kind = 'bed_opened'),
  2,
  'open -> still open queues nothing'
);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000bd', true);
SELECT public.set_listing_beds('d1000000-0000-0000-0000-0000000000bd', 4, 1, 'Dana Whitfield', '(541) 555-0444');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

SELECT is(
  (SELECT (count(*), count(*) FILTER (WHERE sent_at IS NULL AND user_id = 'b1000000-0000-0000-0000-0000000000bd'))::text
     FROM public.notification_outbox WHERE kind = 'bed_opened'),
  '(3,1)',
  'women 0 -> 1 queues one more push for the opted-in follower'
);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000bd', true);
SELECT public.set_listing_beds('d1000000-0000-0000-0000-0000000000bd', 0, 0, 'Dana Whitfield', '(541) 555-0444');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

SELECT is(
  (SELECT (count(*) FILTER (WHERE kind = 'bed_opened'))::text || '|' || (SELECT (beds_male, beds_female)::text FROM public.global_partners WHERE id = 'd1000000-0000-0000-0000-0000000000bd')
     FROM public.notification_outbox),
  '3|(0,0)',
  'going full queues nothing and is stored as a confirmed 0 / 0'
);

SELECT is(
  (SELECT count(*)::integer FROM public.listing_bed_updates WHERE global_partner_id = 'd1000000-0000-0000-0000-0000000000bd'),
  4,
  'every write, including going full, is in the history'
);

SELECT * FROM finish();
ROLLBACK;
