-- Focused coverage for 20261001130000_matching_integrity.sql.
-- Run after a local migration reset with: supabase test db
--
-- This file is never pasted into production.

BEGIN;
SELECT plan(28);

-- Actors
--   a1  owner of practice A                       workspace A
--   b1  owner of practice B                       workspace B
--   s1  seed owner (platform admin)               workspace SEED (auto-publishes programs)
INSERT INTO auth.users (id, email)
VALUES
  ('a1000000-0000-0000-0000-0000000000d1', 'practice-a@example.test'),
  ('b1000000-0000-0000-0000-0000000000d1', 'practice-b@example.test'),
  ('51000000-0000-0000-0000-0000000000d1', 'seed-owner@example.test');

INSERT INTO public.platform_admins (user_id)
VALUES ('51000000-0000-0000-0000-0000000000d1');

SELECT set_config('test.org_a', org_id::text, true) FROM public.org_members WHERE user_id = 'a1000000-0000-0000-0000-0000000000d1';
SELECT set_config('test.org_b', org_id::text, true) FROM public.org_members WHERE user_id = 'b1000000-0000-0000-0000-0000000000d1';

-- ===========================================================================
-- A. Columns, defaults, and checks
-- ===========================================================================

SELECT has_column('public', 'partners', 'financial_relationship', 'partners.financial_relationship exists');
SELECT has_column('public', 'partners', 'financial_relationship_note', 'partners.financial_relationship_note exists');
SELECT col_default_is('public', 'partners', 'financial_relationship', 'none', 'the financial relationship defaults to none');
SELECT has_column('public', 'match_profiles', 'must_have_therapies', 'match_profiles.must_have_therapies exists');
SELECT has_column('public', 'match_profiles', 'population', 'match_profiles.population exists');
SELECT has_column('public', 'match_profiles', 'location_preference', 'match_profiles.location_preference exists');
SELECT has_table('public', 'placement_decisions', 'placement_decisions exists');

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000d1', true);
SET LOCAL ROLE authenticated;

INSERT INTO public.partners (id, name, organization, types, city, state, therapies, populations)
VALUES
  ('a1100000-0000-0000-0000-0000000000d1', 'Admissions', 'Cedar Program', ARRAY['Inpatient'], 'Bend', 'OR', ARRAY['Trauma', 'MAT'], ARRAY['Adults']),
  ('a1200000-0000-0000-0000-0000000000d1', 'Admissions', 'Juniper Program', ARRAY['Inpatient'], 'Bend', 'OR', ARRAY['Trauma'], ARRAY['Adults']);

SELECT throws_ok(
  $$ UPDATE public.partners SET financial_relationship = 'kickback' WHERE id = 'a1100000-0000-0000-0000-0000000000d1' $$,
  '23514',
  NULL,
  'the financial relationship is limited to the listed kinds'
);

SELECT lives_ok(
  $$ UPDATE public.partners SET financial_relationship = 'consulting_fee', financial_relationship_note = 'Quarterly staff training'
      WHERE id = 'a1100000-0000-0000-0000-0000000000d1' $$,
  'a listed kind with a short note is accepted'
);

SELECT throws_ok(
  $$ INSERT INTO public.match_profiles (id, client_label, population) VALUES ('a1300000-0000-0000-0000-0000000000d1', 'bad', 'Everyone') $$,
  '23514',
  NULL,
  'population is limited to Any, Men, Women, Adolescent'
);

-- ===========================================================================
-- B. save_match_with_case carries the new columns
-- ===========================================================================

INSERT INTO public.cases (id, title) VALUES ('a1400000-0000-0000-0000-0000000000d1', 'J.R. family');

SELECT lives_ok(
  $$ SELECT public.save_match_with_case('a1000000-0000-0000-0000-0000000000d1', jsonb_build_object(
       'id', 'a1500000-0000-0000-0000-0000000000d1',
       'client_label', 'J.R.',
       'level_of_care', 'Inpatient',
       'state', 'OR',
       'insurance', 'Cash pay',
       'network_preferences', jsonb_build_array('In-network'),
       'therapies', jsonb_build_array('Trauma', 'MAT'),
       'must_have_therapies', jsonb_build_array('MAT'),
       'population', 'Women',
       'location_preference', 'Close to family',
       'status', 'Matching'
     ), 'a1400000-0000-0000-0000-0000000000d1') $$,
  'save_match_with_case accepts the new fields'
);

SELECT is(
  (SELECT population || '|' || location_preference || '|' || array_to_string(must_have_therapies, ',')
     FROM public.match_profiles WHERE id = 'a1500000-0000-0000-0000-0000000000d1'),
  'Women|Close to family|MAT',
  'population, location preference and must-haves are persisted through the case RPC'
);

SELECT lives_ok(
  $$ SELECT public.save_match_with_case('a1000000-0000-0000-0000-0000000000d1', jsonb_build_object(
       'id', 'a1600000-0000-0000-0000-0000000000d1', 'client_label', 'K.M.', 'level_of_care', 'Any type', 'state', 'OR',
       'insurance', 'Cash pay', 'therapies', jsonb_build_array('MAT'), 'status', 'Matching'
     ), 'a1400000-0000-0000-0000-0000000000d1') $$,
  'a profile without the new fields still saves'
);

SELECT is(
  (SELECT population || '|' || location_preference || '|' || coalesce(array_to_string(must_have_therapies, ','), '<null>')
     FROM public.match_profiles WHERE id = 'a1600000-0000-0000-0000-0000000000d1'),
  'Any|No preference|<null>',
  'missing fields fall back to Any / No preference / NULL must-haves (the app applies the MAT default)'
);

-- ===========================================================================
-- C. placement_decisions: reason rule, org scoping, append-only
-- ===========================================================================

SELECT lives_ok(
  $$ INSERT INTO public.placement_decisions (id, match_profile_id, case_id, chosen_partner_id, chosen_rank, candidates, weights)
     VALUES ('a1700000-0000-0000-0000-0000000000d1', 'a1500000-0000-0000-0000-0000000000d1', 'a1400000-0000-0000-0000-0000000000d1',
             'a1100000-0000-0000-0000-0000000000d1', 1,
             jsonb_build_array(jsonb_build_object('partnerId', 'a1100000-0000-0000-0000-0000000000d1', 'rank', 1, 'total', 92.5)),
             jsonb_build_object('clinical', 50, 'cost', 25, 'location', 10, 'trackRecord', 15)) $$,
  'the top-ranked pick needs no reason'
);

SELECT is(
  (SELECT org_id::text FROM public.placement_decisions WHERE id = 'a1700000-0000-0000-0000-0000000000d1'),
  current_setting('test.org_a'),
  'the record is stamped with the author workspace'
);

SELECT throws_ok(
  $$ INSERT INTO public.placement_decisions (id, match_profile_id, chosen_partner_id, chosen_rank)
     VALUES ('a1800000-0000-0000-0000-0000000000d1', 'a1500000-0000-0000-0000-0000000000d1', 'a1200000-0000-0000-0000-0000000000d1', 2) $$,
  '23514',
  NULL,
  'a pick below the top is rejected without a reason'
);

SELECT lives_ok(
  $$ INSERT INTO public.placement_decisions (id, match_profile_id, chosen_partner_id, chosen_rank, reason, reason_note)
     VALUES ('a1800000-0000-0000-0000-0000000000d1', 'a1500000-0000-0000-0000-0000000000d1', 'a1200000-0000-0000-0000-0000000000d1', 2, 'bed_availability', '') $$,
  'a pick below the top with a reason is recorded'
);

SELECT throws_ok(
  $$ INSERT INTO public.placement_decisions (id, match_profile_id, chosen_partner_id, chosen_rank, reason)
     VALUES ('a1900000-0000-0000-0000-0000000000d1', 'a1500000-0000-0000-0000-0000000000d1', 'a1200000-0000-0000-0000-0000000000d1', 3, 'because') $$,
  '23514',
  NULL,
  'the reason is limited to the listed choices'
);

UPDATE public.placement_decisions SET reason = 'other' WHERE id = 'a1800000-0000-0000-0000-0000000000d1';
DELETE FROM public.placement_decisions WHERE id = 'a1700000-0000-0000-0000-0000000000d1';

SELECT is(
  (SELECT count(*)::integer || '|' || (SELECT reason FROM public.placement_decisions WHERE id = 'a1800000-0000-0000-0000-0000000000d1')
     FROM public.placement_decisions),
  '2|bed_availability',
  'the record is append-only: the author can neither update nor delete it'
);

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000d1', true);
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT count(*)::integer FROM public.placement_decisions),
  0,
  'another workspace sees none of the records'
);

SELECT throws_ok(
  $$ INSERT INTO public.placement_decisions (id, match_profile_id, chosen_rank)
     VALUES ('b1100000-0000-0000-0000-0000000000d1', 'a1500000-0000-0000-0000-0000000000d1', 1) $$,
  '23503',
  NULL,
  'another workspace cannot record a decision against a match profile it does not own'
);

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SET LOCAL ROLE anon;

SELECT throws_ok(
  $$ SELECT count(*) FROM public.placement_decisions $$,
  '42501',
  NULL,
  'anon has no access to placement records'
);

RESET ROLE;

-- ===========================================================================
-- D. The financial relationship is never published
-- ===========================================================================

SELECT ok(
  NOT (public.partner_never_published_fields() && public.global_partner_synced_fields())
  AND NOT (public.partner_never_published_fields() && public.seed_partner_pushed_fields())
  AND NOT (public.partner_never_published_fields() && public.org_directory_profile_fields())
  AND 'financial_relationship' = ANY (public.partner_never_published_fields())
  AND 'financial_relationship_note' = ANY (public.partner_never_published_fields()),
  'no synced, pushed, or profile field list carries the financial relationship'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'global_partners'
       AND column_name = ANY (public.partner_never_published_fields())
  ),
  'global_partners has no column that could hold a financial relationship'
);

-- A seed program with a relationship set auto-publishes; the listing carries nothing of it.
SELECT set_config('request.jwt.claim.sub', '51000000-0000-0000-0000-0000000000d1', true);
SET LOCAL ROLE authenticated;

INSERT INTO public.partners (id, name, organization, types, city, state, phone, website, financial_relationship, financial_relationship_note)
VALUES ('51100000-0000-0000-0000-0000000000d1', 'Admissions', 'Seed Ranch Recovery', ARRAY['Inpatient'], 'Bend', 'OR',
        '(541) 555-0900', 'https://www.seedranch.example', 'marketing_agreement', 'SECRETNOTE marketing agreement 2026');

SELECT ok(
  (SELECT g.status = 'active'
     FROM public.partners p JOIN public.global_partners g ON g.id = p.global_partner_id
    WHERE p.id = '51100000-0000-0000-0000-0000000000d1'),
  'the seed program is published'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.global_partners g
     WHERE to_jsonb(g)::text LIKE '%SECRETNOTE%' OR to_jsonb(g)::text LIKE '%marketing_agreement%'
  ),
  'nothing of the financial relationship reaches the published listing'
);

UPDATE public.partners SET financial_relationship_note = 'SECRETNOTE v2', phone = '(541) 555-0901' WHERE id = '51100000-0000-0000-0000-0000000000d1';

SELECT ok(
  (SELECT g.phone_digits = '5415550901' FROM public.partners p JOIN public.global_partners g ON g.id = p.global_partner_id WHERE p.id = '51100000-0000-0000-0000-0000000000d1')
  AND NOT EXISTS (SELECT 1 FROM public.global_partners g WHERE to_jsonb(g)::text LIKE '%SECRETNOTE%'),
  'a later seed edit still pushes public fields and still never the relationship'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
