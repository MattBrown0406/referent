-- Focused coverage for 20261001160000_outcomes_loop.sql.
-- Run after a local migration reset with: supabase test db
--
-- This file is never pasted into production.

BEGIN;
SELECT plan(44);

-- Actors
--   ad  platform admin
--   u1  owner of practice P
--   u2  member of practice P
--   q1  owner of practice Q (sees nothing of P)
--   n1..n4  owners of four other practices that refer to the same listing
INSERT INTO auth.users (id, email)
VALUES
  ('ad000000-0000-0000-0000-00000000c100', 'outcomes-admin@example.test'),
  ('a1000000-0000-0000-0000-00000000c100', 'outcomes-u1@example.test'),
  ('a2000000-0000-0000-0000-00000000c100', 'outcomes-u2@example.test'),
  ('b1000000-0000-0000-0000-00000000c100', 'outcomes-q1@example.test'),
  ('c1000000-0000-0000-0000-00000000c100', 'outcomes-n1@example.test'),
  ('c2000000-0000-0000-0000-00000000c100', 'outcomes-n2@example.test'),
  ('c3000000-0000-0000-0000-00000000c100', 'outcomes-n3@example.test'),
  ('c4000000-0000-0000-0000-00000000c100', 'outcomes-n4@example.test');

INSERT INTO public.platform_admins (user_id) VALUES ('ad000000-0000-0000-0000-00000000c100');

SELECT set_config('test.org_p', org_id::text, true) FROM public.org_members WHERE user_id = 'a1000000-0000-0000-0000-00000000c100';
SELECT set_config('test.org_q', org_id::text, true) FROM public.org_members WHERE user_id = 'b1000000-0000-0000-0000-00000000c100';
SELECT set_config('test.org_n1', org_id::text, true) FROM public.org_members WHERE user_id = 'c1000000-0000-0000-0000-00000000c100';
SELECT set_config('test.org_n2', org_id::text, true) FROM public.org_members WHERE user_id = 'c2000000-0000-0000-0000-00000000c100';
SELECT set_config('test.org_n3', org_id::text, true) FROM public.org_members WHERE user_id = 'c3000000-0000-0000-0000-00000000c100';
SELECT set_config('test.org_n4', org_id::text, true) FROM public.org_members WHERE user_id = 'c4000000-0000-0000-0000-00000000c100';
UPDATE public.org_members SET org_id = current_setting('test.org_p')::uuid, role = 'member'
 WHERE user_id = 'a2000000-0000-0000-0000-00000000c100';

-- One shared listing G1, linked from P and from n1..n4.
INSERT INTO public.global_partners (id, name, organization, types, city, state, phone, status, verified_at)
VALUES ('d1000000-0000-0000-0000-00000000c100', 'Admissions', 'Juniper Ridge Recovery', ARRAY['Inpatient'], 'Bend', 'OR', '(541) 555-0400', 'active', now());

-- Practice P partners: X (check-ins), Y (scorecard fixture), W (no referrals), Z (linked to G1).
INSERT INTO public.partners (id, owner_id, org_id, name, organization, types, city, state, phone, global_partner_id)
VALUES
  ('e1000000-0000-0000-0000-00000000c100', 'a1000000-0000-0000-0000-00000000c100', current_setting('test.org_p')::uuid, 'Intake', 'Cascade Recovery', ARRAY['Inpatient'], 'Bend', 'OR', '(541) 555-0401', NULL),
  ('e2000000-0000-0000-0000-00000000c100', 'a1000000-0000-0000-0000-00000000c100', current_setting('test.org_p')::uuid, 'Intake', 'Deschutes Lodge', ARRAY['Inpatient'], 'Bend', 'OR', '(541) 555-0402', NULL),
  ('e4000000-0000-0000-0000-00000000c100', 'a1000000-0000-0000-0000-00000000c100', current_setting('test.org_p')::uuid, 'Intake', 'Quiet Pines', ARRAY['Sober Living'], 'Bend', 'OR', '(541) 555-0404', NULL),
  ('e3000000-0000-0000-0000-00000000c100', 'a1000000-0000-0000-0000-00000000c100', current_setting('test.org_p')::uuid, 'Admissions', 'Juniper Ridge Recovery', ARRAY['Inpatient'], 'Bend', 'OR', '(541) 555-0400', 'd1000000-0000-0000-0000-00000000c100'),
  ('f1000000-0000-0000-0000-00000000c100', 'c1000000-0000-0000-0000-00000000c100', current_setting('test.org_n1')::uuid, 'Admissions', 'Juniper Ridge Recovery', ARRAY['Inpatient'], 'Bend', 'OR', '(541) 555-0400', 'd1000000-0000-0000-0000-00000000c100'),
  ('f2000000-0000-0000-0000-00000000c100', 'c2000000-0000-0000-0000-00000000c100', current_setting('test.org_n2')::uuid, 'Admissions', 'Juniper Ridge Recovery', ARRAY['Inpatient'], 'Bend', 'OR', '(541) 555-0400', 'd1000000-0000-0000-0000-00000000c100'),
  ('f3000000-0000-0000-0000-00000000c100', 'c3000000-0000-0000-0000-00000000c100', current_setting('test.org_n3')::uuid, 'Admissions', 'Juniper Ridge Recovery', ARRAY['Inpatient'], 'Bend', 'OR', '(541) 555-0400', 'd1000000-0000-0000-0000-00000000c100'),
  ('f4000000-0000-0000-0000-00000000c100', 'c4000000-0000-0000-0000-00000000c100', current_setting('test.org_n4')::uuid, 'Admissions', 'Juniper Ridge Recovery', ARRAY['Inpatient'], 'Bend', 'OR', '(541) 555-0400', 'd1000000-0000-0000-0000-00000000c100');

-- A case in P assigned to u2; referral rC links to it.
INSERT INTO public.cases (id, owner_id, org_id, title, assigned_to)
VALUES ('a9000000-0000-0000-0000-00000000c100', 'a1000000-0000-0000-0000-00000000c100', current_setting('test.org_p')::uuid, 'Henderson family', 'a2000000-0000-0000-0000-00000000c100');

-- Check-in referrals on X (rA..rD). Dates are relative to today so the
-- "skip check-ins already in the past" rule is exercised for real.
INSERT INTO public.referrals (id, owner_id, org_id, partner_id, direction, referred_on, client_label, case_id)
VALUES
  ('aa000000-0000-0000-0000-00000000c100', 'a1000000-0000-0000-0000-00000000c100', current_setting('test.org_p')::uuid, 'e1000000-0000-0000-0000-00000000c100', 'outbound', CURRENT_DATE - 2, 'A.B.', NULL),
  ('ab000000-0000-0000-0000-00000000c100', 'a1000000-0000-0000-0000-00000000c100', current_setting('test.org_p')::uuid, 'e1000000-0000-0000-0000-00000000c100', 'outbound', CURRENT_DATE - 45, 'C.D.', NULL),
  ('ac000000-0000-0000-0000-00000000c100', 'a1000000-0000-0000-0000-00000000c100', current_setting('test.org_p')::uuid, 'e1000000-0000-0000-0000-00000000c100', 'outbound', CURRENT_DATE - 1, 'Henderson', 'a9000000-0000-0000-0000-00000000c100'),
  ('ad000000-0000-0000-0000-00000000c101', 'a1000000-0000-0000-0000-00000000c100', current_setting('test.org_p')::uuid, 'e1000000-0000-0000-0000-00000000c100', 'outbound', CURRENT_DATE - 3, 'E.F.', NULL);

-- Scorecard fixture on Y: three admits (3, 10 and 5 days to admit; one
-- completed, one not, one still enrolled), one non-admit, one pending.
INSERT INTO public.referrals (id, owner_id, org_id, partner_id, direction, referred_on, client_label, admitted, admitted_on, family_experience, completed, still_enrolled)
VALUES
  ('b1000000-0000-0000-0000-00000000c101', 'a1000000-0000-0000-0000-00000000c100', current_setting('test.org_p')::uuid, 'e2000000-0000-0000-0000-00000000c100', 'outbound', DATE '2026-08-01', 'r1', true, DATE '2026-08-04', 5, true, false),
  ('b2000000-0000-0000-0000-00000000c101', 'a1000000-0000-0000-0000-00000000c100', current_setting('test.org_p')::uuid, 'e2000000-0000-0000-0000-00000000c100', 'outbound', DATE '2026-08-01', 'r2', true, DATE '2026-08-11', 3, false, false),
  ('b3000000-0000-0000-0000-00000000c101', 'a1000000-0000-0000-0000-00000000c100', current_setting('test.org_p')::uuid, 'e2000000-0000-0000-0000-00000000c100', 'outbound', DATE '2026-08-01', 'r3', true, DATE '2026-08-06', NULL, NULL, true),
  ('b4000000-0000-0000-0000-00000000c101', 'a1000000-0000-0000-0000-00000000c100', current_setting('test.org_p')::uuid, 'e2000000-0000-0000-0000-00000000c100', 'outbound', DATE '2026-08-01', 'r4', false, NULL, NULL, NULL, NULL),
  ('b5000000-0000-0000-0000-00000000c101', 'a1000000-0000-0000-0000-00000000c100', current_setting('test.org_p')::uuid, 'e2000000-0000-0000-0000-00000000c100', 'outbound', DATE '2026-08-01', 'r5', NULL, NULL, NULL, NULL, NULL);

-- Network fixture: decided placements on G1 from P (two) and n1..n3 (one
-- each). n4 is added later to cross the five-workspace floor.
INSERT INTO public.referrals (id, owner_id, org_id, partner_id, direction, referred_on, client_label, admitted, admitted_on, completed)
VALUES
  ('c1000000-0000-0000-0000-00000000c101', 'a1000000-0000-0000-0000-00000000c100', current_setting('test.org_p')::uuid, 'e3000000-0000-0000-0000-00000000c100', 'outbound', CURRENT_DATE - 60, 'p1', true, CURRENT_DATE - 58, true),
  ('c2000000-0000-0000-0000-00000000c101', 'a1000000-0000-0000-0000-00000000c100', current_setting('test.org_p')::uuid, 'e3000000-0000-0000-0000-00000000c100', 'outbound', CURRENT_DATE - 50, 'p2', true, CURRENT_DATE - 48, true),
  ('c3000000-0000-0000-0000-00000000c101', 'c1000000-0000-0000-0000-00000000c100', current_setting('test.org_n1')::uuid, 'f1000000-0000-0000-0000-00000000c100', 'outbound', CURRENT_DATE - 60, 'n1', true, CURRENT_DATE - 56, true),
  ('c4000000-0000-0000-0000-00000000c101', 'c2000000-0000-0000-0000-00000000c100', current_setting('test.org_n2')::uuid, 'f2000000-0000-0000-0000-00000000c100', 'outbound', CURRENT_DATE - 60, 'n2', true, CURRENT_DATE - 54, false),
  ('c5000000-0000-0000-0000-00000000c101', 'c3000000-0000-0000-0000-00000000c100', current_setting('test.org_n3')::uuid, 'f3000000-0000-0000-0000-00000000c100', 'outbound', CURRENT_DATE - 60, 'n3', true, CURRENT_DATE - 52, true);

-- ===========================================================================
-- A. Schema
-- ===========================================================================

SELECT has_column('public', 'referrals', 'completed', 'referrals.completed exists');
SELECT has_column('public', 'referrals', 'completed_on', 'referrals.completed_on exists');
SELECT has_column('public', 'referrals', 'still_enrolled', 'referrals.still_enrolled exists');
SELECT has_column('public', 'referrals', 'last_check_in_at', 'referrals.last_check_in_at exists');
SELECT has_column('public', 'follow_ups', 'check_in_days', 'follow_ups.check_in_days exists');
SELECT has_function('public', 'record_placement_outcome', ARRAY['uuid', 'jsonb', 'jsonb'], 'record_placement_outcome exists');
SELECT has_column('public', 'partner_scorecard', 'completion_rate', 'partner_scorecard.completion_rate exists');

SELECT throws_ok(
  $$ INSERT INTO public.follow_ups (owner_id, org_id, title, due_on, kind)
     VALUES ('a1000000-0000-0000-0000-00000000c100', current_setting('test.org_p')::uuid, 'x', CURRENT_DATE, 'bogus') $$,
  '23514', NULL,
  'an unknown follow-up kind is still rejected'
);
SELECT throws_ok(
  $$ INSERT INTO public.follow_ups (owner_id, org_id, title, due_on, kind, check_in_days)
     VALUES ('a1000000-0000-0000-0000-00000000c100', current_setting('test.org_p')::uuid, 'x', CURRENT_DATE, 'check_in', 12) $$,
  '23514', NULL,
  'check_in_days is 7, 30 or 90'
);

-- ===========================================================================
-- B. Recording an admission creates the check-ins once
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-00000000c100', true);
SET LOCAL ROLE authenticated;

SELECT is(
  public.record_placement_outcome(
    'aa000000-0000-0000-0000-00000000c100',
    jsonb_build_object('admitted', true, 'admitted_on', CURRENT_DATE::text, 'outcome', 'Placed', 'family_experience', 4, 'outcome_note', 'Went well')),
  3,
  'an admission dated today creates three check-ins'
);

SELECT is(
  (SELECT string_agg(check_in_days::text || ':' || (due_on - CURRENT_DATE)::text, ',' ORDER BY check_in_days)
     FROM public.follow_ups WHERE referral_id = 'aa000000-0000-0000-0000-00000000c100' AND kind = 'check_in'),
  '7:7,30:30,90:90',
  'the check-ins fall 7, 30 and 90 days after admission'
);

SELECT is(
  (SELECT title FROM public.follow_ups WHERE referral_id = 'aa000000-0000-0000-0000-00000000c100' AND check_in_days = 7),
  '7-day check-in: A.B.',
  'a check-in is titled by its day and the client label'
);

SELECT is(
  (SELECT bool_and(assigned_to = 'a1000000-0000-0000-0000-00000000c100' AND org_id = current_setting('test.org_p')::uuid
                   AND status = 'open' AND partner_id = 'e1000000-0000-0000-0000-00000000c100' AND case_id IS NULL)
     FROM public.follow_ups WHERE referral_id = 'aa000000-0000-0000-0000-00000000c100' AND kind = 'check_in'),
  true,
  'check-ins are open, in the workspace, on the partner, and assigned to the referral author'
);

SELECT is(
  (SELECT (admitted, admitted_on = CURRENT_DATE, outcome, family_experience, outcome_note)::text
     FROM public.referrals WHERE id = 'aa000000-0000-0000-0000-00000000c100'),
  '(t,t,Placed,4,"Went well")',
  'the outcome fields land on the referral'
);

SELECT is(
  public.record_placement_outcome(
    'aa000000-0000-0000-0000-00000000c100',
    jsonb_build_object('admitted', true, 'admitted_on', CURRENT_DATE::text, 'family_experience', 5)),
  0,
  'recording the same admission again creates nothing new'
);

SELECT is(public.schedule_placement_check_ins('aa000000-0000-0000-0000-00000000c100'), 0, 'scheduling directly is idempotent too');

SELECT is(
  (SELECT count(*)::integer FROM public.follow_ups WHERE referral_id = 'aa000000-0000-0000-0000-00000000c100' AND kind = 'check_in'),
  3,
  'still exactly three check-ins'
);

SELECT is(
  public.record_placement_outcome(
    'ab000000-0000-0000-0000-00000000c100',
    jsonb_build_object('admitted', true, 'admitted_on', (CURRENT_DATE - 40)::text, 'outcome', 'Placed')),
  1,
  'an admission forty days back only gets the 90-day check-in'
);

SELECT is(
  (SELECT string_agg(check_in_days::text || ':' || (due_on - CURRENT_DATE)::text, ',' ORDER BY check_in_days)
     FROM public.follow_ups WHERE referral_id = 'ab000000-0000-0000-0000-00000000c100' AND kind = 'check_in'),
  '90:50',
  'the 7 and 30 day check-ins in the past are skipped'
);

SELECT is(
  public.record_placement_outcome(
    'ac000000-0000-0000-0000-00000000c100',
    jsonb_build_object('admitted', true, 'admitted_on', CURRENT_DATE::text, 'outcome', 'Placed')),
  3,
  'a case-linked admission creates three check-ins'
);

SELECT is(
  (SELECT bool_and(assigned_to = 'a2000000-0000-0000-0000-00000000c100' AND case_id = 'a9000000-0000-0000-0000-00000000c100')
     FROM public.follow_ups WHERE referral_id = 'ac000000-0000-0000-0000-00000000c100' AND kind = 'check_in'),
  true,
  'check-ins for a case go to the case assignee and carry the case'
);

SELECT is(
  public.record_placement_outcome(
    'ad000000-0000-0000-0000-00000000c101',
    jsonb_build_object('admitted', false, 'outcome_note', 'Chose another program')),
  0,
  'a non-admission creates no check-ins'
);

SELECT is(
  (SELECT (admitted, (SELECT count(*) FROM public.follow_ups WHERE referral_id = 'ad000000-0000-0000-0000-00000000c101'))::text
     FROM public.referrals WHERE id = 'ad000000-0000-0000-0000-00000000c101'),
  '(f,0)',
  'the non-admission is recorded and nothing is scheduled'
);

-- ===========================================================================
-- C. Completing a check-in updates the referral
-- ===========================================================================

SELECT set_config('test.ci7', id::text, true)
  FROM public.follow_ups WHERE referral_id = 'aa000000-0000-0000-0000-00000000c100' AND check_in_days = 7;

SELECT is(
  public.record_placement_outcome(
    'aa000000-0000-0000-0000-00000000c100',
    jsonb_build_object('still_enrolled', true, 'completed', false, 'family_experience', 5, 'check_in', true),
    jsonb_build_object('id', current_setting('test.ci7'), 'status', 'done', 'completed_at', now()::text, 'note', 'Settling in')),
  0,
  'completing the 7-day check-in creates nothing new'
);

SELECT is(
  (SELECT (status, completed_at IS NOT NULL, note)::text FROM public.follow_ups WHERE id = current_setting('test.ci7')::uuid),
  '(done,t,"Settling in")',
  'the check-in is done with its note'
);

SELECT is(
  (SELECT (still_enrolled, completed, completed_on, family_experience, last_check_in_at IS NOT NULL)::text
     FROM public.referrals WHERE id = 'aa000000-0000-0000-0000-00000000c100'),
  '(t,f,,5,t)',
  'the referral carries still enrolled, the rating and the check-in stamp'
);

SELECT set_config('test.ci30', id::text, true)
  FROM public.follow_ups WHERE referral_id = 'aa000000-0000-0000-0000-00000000c100' AND check_in_days = 30;

SELECT lives_ok(
  $$ SELECT public.record_placement_outcome(
       'aa000000-0000-0000-0000-00000000c100',
       jsonb_build_object('still_enrolled', false, 'completed', true, 'completed_on', CURRENT_DATE::text, 'check_in', true),
       jsonb_build_object('id', current_setting('test.ci30'), 'status', 'done', 'completed_at', now()::text)) $$,
  'the 30-day check-in records a completion'
);

SELECT is(
  (SELECT (still_enrolled, completed, completed_on = CURRENT_DATE)::text FROM public.referrals WHERE id = 'aa000000-0000-0000-0000-00000000c100'),
  '(f,t,t)',
  'completion and its date land on the referral'
);

-- ===========================================================================
-- D. Workspace scoping
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-00000000c100', true);

SELECT throws_ok(
  $$ SELECT public.record_placement_outcome('aa000000-0000-0000-0000-00000000c100', jsonb_build_object('admitted', true)) $$,
  'P0002', 'Referral not found in this workspace',
  'another practice cannot record an outcome on a referral that is not theirs'
);

SELECT throws_ok(
  $$ SELECT public.record_placement_outcome('aa000000-0000-0000-0000-00000000c100', jsonb_build_object('admitted', true),
       jsonb_build_object('id', current_setting('test.ci7'), 'status', 'done')) $$,
  'P0002', 'Follow-up not found in this workspace',
  'another practice cannot complete a check-in that is not theirs'
);

SELECT throws_ok(
  $$ SELECT public.schedule_placement_check_ins('aa000000-0000-0000-0000-00000000c100') $$,
  'P0002', 'Referral not found in this workspace',
  'another practice cannot schedule check-ins on a referral that is not theirs'
);

SELECT is(
  (SELECT count(*)::integer FROM public.follow_ups WHERE kind = 'check_in'),
  0,
  'another practice sees none of the check-ins'
);

SELECT is(
  (SELECT count(*)::integer FROM public.referrals WHERE still_enrolled IS NOT NULL),
  0,
  'another practice sees none of the outcomes'
);

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SET LOCAL ROLE anon;

SELECT throws_ok(
  $$ SELECT public.record_placement_outcome('aa000000-0000-0000-0000-00000000c100', jsonb_build_object('admitted', true)) $$,
  '42501', NULL,
  'anonymous callers cannot execute record_placement_outcome'
);

SELECT throws_ok(
  $$ SELECT public.schedule_placement_check_ins('aa000000-0000-0000-0000-00000000c100') $$,
  '42501', NULL,
  'anonymous callers cannot execute schedule_placement_check_ins'
);

RESET ROLE;

-- ===========================================================================
-- E. Scorecard math
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-00000000c100', true);
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT (referrals_sent, admits, non_admits, avg_family_experience, completed, decided_placements, completion_rate, median_days_to_admit, still_enrolled)::text
     FROM public.partner_scorecard WHERE partner_id = 'e2000000-0000-0000-0000-00000000c100'),
  '(5,3,1,4.00,1,2,0.5000,5,1)',
  'completion rate is completed over decided placements; median days to admit is the middle admit'
);

SELECT is(
  (SELECT (referrals_sent, admits, completed, decided_placements, completion_rate, median_days_to_admit, still_enrolled)::text
     FROM public.partner_scorecard WHERE partner_id = 'e4000000-0000-0000-0000-00000000c100'),
  '(0,0,0,0,,,0)',
  'a partner with no referrals has no rates and zero counts'
);

SELECT is(
  (SELECT count(*)::integer FROM public.partner_scorecard WHERE partner_id IN ('f1000000-0000-0000-0000-00000000c100', 'f2000000-0000-0000-0000-00000000c100')),
  0,
  'the scorecard never shows another practice''s partners'
);

-- ===========================================================================
-- F. Network aggregates honour the five-workspace rule
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'ad000000-0000-0000-0000-00000000c100', true);

SELECT lives_ok($$ SELECT public.refresh_global_partner_stats() $$, 'a platform admin refreshes the network stats');

SELECT is(
  (SELECT (completion_rate, median_days_to_admit, disclosed)::text
     FROM public.fetch_global_partner_stats(ARRAY['d1000000-0000-0000-0000-00000000c100'::uuid])),
  '(0.8000,4.0,t)',
  'admins see completion and median days to admit from four workspaces'
);

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-00000000c100', true);

SELECT is(
  (SELECT (completion_rate IS NULL, median_days_to_admit IS NULL, admit_rate IS NULL)::text
     FROM public.fetch_global_partner_stats(ARRAY['d1000000-0000-0000-0000-00000000c100'::uuid])),
  '(t,t,t)',
  'with four referring workspaces (and five decided placements) a practice sees no rates'
);

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

INSERT INTO public.referrals (id, owner_id, org_id, partner_id, direction, referred_on, client_label, admitted, admitted_on, completed)
VALUES ('c6000000-0000-0000-0000-00000000c101', 'c4000000-0000-0000-0000-00000000c100', current_setting('test.org_n4')::uuid, 'f4000000-0000-0000-0000-00000000c100', 'outbound', CURRENT_DATE - 60, 'n4', true, CURRENT_DATE - 50, false);

SELECT set_config('request.jwt.claim.sub', 'ad000000-0000-0000-0000-00000000c100', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$ SELECT public.refresh_global_partner_stats() $$, 'the admin refreshes after a fifth workspace refers');

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-00000000c100', true);

SELECT is(
  (SELECT (completion_rate, median_days_to_admit, disclosed)::text
     FROM public.fetch_global_partner_stats(ARRAY['d1000000-0000-0000-0000-00000000c100'::uuid])),
  '(0.6667,5.0,t)',
  'at five workspaces a practice sees the network completion rate and median days to admit'
);

SELECT is(
  (SELECT (admit_rate, family_experience IS NULL)::text
     FROM public.fetch_global_partner_stats(ARRAY['d1000000-0000-0000-0000-00000000c100'::uuid])),
  '(1.0000,t)',
  'the existing admit-rate and family-experience floors are unchanged'
);

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

SELECT * FROM finish();
ROLLBACK;
