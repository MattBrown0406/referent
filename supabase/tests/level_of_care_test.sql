-- Focused coverage for 20261104150000_level_of_care.sql (Level-of-care
-- assessment). Run after a local migration reset with: supabase test db
--
-- This file is never pasted into production.

BEGIN;
SELECT plan(73);

-- Actors
--   p1  owner of practice P (cases C1, C2)
--   p2  member of practice P
--   q1  owner of practice Q (case C3)
--   j1  solo owner of workspace J (case C4), joins P
--   k1  solo owner of workspace K (case C5), deletes the account
INSERT INTO auth.users (id, email)
VALUES
  ('b1000000-0000-0000-0000-0000000000b8', 'loc-p1@example.test'),
  ('b2000000-0000-0000-0000-0000000000b8', 'loc-p2@example.test'),
  ('b3000000-0000-0000-0000-0000000000b8', 'loc-q1@example.test'),
  ('b4000000-0000-0000-0000-0000000000b8', 'loc-j1@example.test'),
  ('b5000000-0000-0000-0000-0000000000b8', 'loc-k1@example.test');

SELECT set_config('test.org_p', org_id::text, true) FROM public.org_members WHERE user_id = 'b1000000-0000-0000-0000-0000000000b8';
SELECT set_config('test.org_q', org_id::text, true) FROM public.org_members WHERE user_id = 'b3000000-0000-0000-0000-0000000000b8';
SELECT set_config('test.org_j', org_id::text, true) FROM public.org_members WHERE user_id = 'b4000000-0000-0000-0000-0000000000b8';
SELECT set_config('test.org_k', org_id::text, true) FROM public.org_members WHERE user_id = 'b5000000-0000-0000-0000-0000000000b8';
UPDATE public.org_members SET org_id = current_setting('test.org_p')::uuid, role = 'member', display_name = 'Mikayla'
 WHERE user_id = 'b2000000-0000-0000-0000-0000000000b8';

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
INSERT INTO public.cases (id, title, status) VALUES
  ('c1000000-0000-0000-0000-0000000000b8', 'Rivera intervention', 'inquiry'),
  ('c2000000-0000-0000-0000-0000000000b8', 'Short-lived case', 'inquiry');
INSERT INTO public.case_contacts (case_id, name, relationship, is_primary)
VALUES ('c1000000-0000-0000-0000-0000000000b8', 'Dolores Huerta', 'mother', true);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'b3000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
INSERT INTO public.cases (id, title, status) VALUES ('c3000000-0000-0000-0000-0000000000b8', 'Q case', 'inquiry');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

-- ===========================================================================
-- A. Schema and grants
-- ===========================================================================

SELECT has_table('public', 'case_assessments', 'case_assessments exists');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.case_assessments'::regclass), 'RLS is on');
SELECT ok(
  has_table_privilege('authenticated', 'public.case_assessments', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.case_assessments', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.case_assessments', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.case_assessments', 'DELETE')
  AND NOT has_table_privilege('authenticated', 'public.case_assessments', 'TRUNCATE')
  AND NOT has_table_privilege('authenticated', 'public.case_assessments', 'REFERENCES')
  AND NOT has_table_privilege('authenticated', 'public.case_assessments', 'TRIGGER'),
  'signed-in users hold SELECT only, whatever the default ACL granted'
);
SELECT ok(
  NOT has_table_privilege('anon', 'public.case_assessments', 'SELECT') AND NOT has_table_privilege('anon', 'public.case_assessments', 'INSERT')
  AND NOT has_table_privilege('anon', 'public.case_assessments', 'UPDATE') AND NOT has_table_privilege('anon', 'public.case_assessments', 'DELETE')
  AND NOT has_table_privilege('anon', 'public.case_assessments', 'TRUNCATE'),
  'anon holds nothing'
);
SELECT ok(
  (SELECT bool_and(p.prosecdef AND p.proconfig @> ARRAY['search_path=public'])
     FROM pg_proc p
    WHERE p.oid IN ('public.save_case_assessment(uuid, uuid, integer[], text[], boolean, integer, text, text, text, text, text)'::regprocedure,
                    'public.org_move_workspace_rows(uuid, uuid)'::regprocedure)),
  'the writer and the workspace helper are SECURITY DEFINER with a pinned search_path'
);
SELECT ok(
  (SELECT bool_and(p.proconfig IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(p.proconfig) AS c(v) WHERE c.v LIKE 'search_path=%'))
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND (p.proname LIKE 'case_assessment%' OR p.proname IN ('level_of_care_recommendation', 'save_case_assessment'))),
  'every new function pins its search_path'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND (p.proname LIKE 'case_assessment%' OR p.proname IN ('level_of_care_recommendation', 'save_case_assessment'))
       AND has_function_privilege('anon', p.oid, 'EXECUTE')),
  'anon can run none of the new functions'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.save_case_assessment(uuid, uuid, integer[], text[], boolean, integer, text, text, text, text, text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.level_of_care_recommendation(integer[], integer)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.case_assessment_problem(integer[], text[], integer, text, text, text, text, text, text[])', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.case_assessment_reason_problem(text, text[])', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.case_assessment_event_body(text, text, text, text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.case_assessment_json(public.case_assessments)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.org_move_workspace_rows(uuid, uuid)', 'EXECUTE'),
  'signed-in users can call the writer; the helpers stay internal'
);
SELECT is(
  (SELECT array_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') -> ' || pg_get_function_result(p.oid) ORDER BY p.proname)
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('org_move_workspace_rows', 'accept_org_invite', 'delete_own_account')),
  ARRAY['accept_org_invite(p_code text) -> void',
        'delete_own_account() -> void',
        'org_move_workspace_rows(p_from uuid, p_to uuid) -> void'],
  'the re-created workspace helper keeps its signature; accept_org_invite and delete_own_account (1.0.4) are untouched'
);

-- ===========================================================================
-- B. The rules are the app's
-- ===========================================================================

-- The same digest is asserted in scripts/level-of-care-test.mjs over
-- recommend() in src/lib/level-of-care.ts: every one of the 15,625 rating
-- sets gets the same level, first step and support on the server.
SELECT is(
  (SELECT md5(string_agg(format('%s%s%s%s%s%s:%s|%s|%s', w, p, m, r, u, e, z.x ->> 'level', coalesce(z.x ->> 'first_step', '-'),
                                coalesce(z.x ->> 'support', '-')), chr(10) ORDER BY w, p, m, r, u, e))
     FROM generate_series(0, 4) AS w, generate_series(0, 4) AS p, generate_series(0, 4) AS m,
          generate_series(0, 4) AS r, generate_series(0, 4) AS u, generate_series(0, 4) AS e,
          LATERAL (SELECT public.level_of_care_recommendation(ARRAY[w, p, m, r, u, e], 2) AS x) AS z),
  'a000c8832bb2cf95d732b8cdcf0eae3f',
  'the server''s rules give the app''s recommendation for all 15,625 rating sets'
);
SELECT is(
  ARRAY[
    public.level_of_care_recommendation(ARRAY[0, 0, 0, 0, 0, 0], 2),
    public.level_of_care_recommendation(ARRAY[3, 1, 1, 1, 1, 1], 2),
    public.level_of_care_recommendation(ARRAY[0, 0, 0, 0, 0, 3], 2),
    public.level_of_care_recommendation(ARRAY[0, 0, 0, 3, 3, 0], 2),
    public.level_of_care_recommendation(ARRAY[0, 0, 0, 4, 0, 0], 2),
    public.level_of_care_recommendation(ARRAY[3, 2, 3, 2, 2, 3], 2)],
  ARRAY[
    '{"level":"Therapist","first_step":null,"support":null}'::jsonb,
    '{"level":"IOP / PHP","first_step":"Detox","support":null}'::jsonb,
    '{"level":"Therapist","first_step":null,"support":"Sober Living"}'::jsonb,
    '{"level":"Inpatient","first_step":null,"support":null}'::jsonb,
    '{"level":"IOP / PHP","first_step":null,"support":null}'::jsonb,
    '{"level":"Inpatient","first_step":"Detox","support":"Sober Living"}'::jsonb],
  'named cases: detox first, stepping down to IOP / PHP; sober living as support; two serious risks together; low readiness alone'
);
-- Version 2 (Matt's decisions, 2026-11-05): withdrawal 2 is at least
-- IOP / PHP; after detox the level is never lower than IOP / PHP; four or
-- more of areas 2-6 at 2+ are Inpatient (three are not); physical 4 and
-- emotional 4 stay Inpatient, with no emergency first step.
SELECT is(
  ARRAY[
    public.level_of_care_recommendation(ARRAY[2, 0, 0, 0, 0, 0], 2),
    public.level_of_care_recommendation(ARRAY[4, 0, 0, 0, 0, 0], 2),
    public.level_of_care_recommendation(ARRAY[0, 2, 2, 2, 2, 0], 2),
    public.level_of_care_recommendation(ARRAY[0, 2, 2, 2, 1, 0], 2),
    public.level_of_care_recommendation(ARRAY[0, 0, 2, 2, 2, 2], 2),
    public.level_of_care_recommendation(ARRAY[3, 2, 2, 2, 2, 3], 2),
    public.level_of_care_recommendation(ARRAY[0, 4, 0, 0, 0, 0], 2),
    public.level_of_care_recommendation(ARRAY[0, 0, 4, 0, 0, 0], 2)],
  ARRAY[
    '{"level":"IOP / PHP","first_step":null,"support":null}'::jsonb,
    '{"level":"IOP / PHP","first_step":"Detox","support":null}'::jsonb,
    '{"level":"Inpatient","first_step":null,"support":null}'::jsonb,
    '{"level":"IOP / PHP","first_step":null,"support":null}'::jsonb,
    '{"level":"Inpatient","first_step":null,"support":null}'::jsonb,
    '{"level":"Inpatient","first_step":"Detox","support":"Sober Living"}'::jsonb,
    '{"level":"Inpatient","first_step":null,"support":null}'::jsonb,
    '{"level":"Inpatient","first_step":null,"support":null}'::jsonb],
  'version 2: withdrawal oversight, the step down after detox, several moderate risks together, severe physical or emotional needs'
);
SELECT is(
  ARRAY[public.level_of_care_recommendation(ARRAY[0, 0, 0, 0, 0, 0], 1), public.level_of_care_recommendation(ARRAY[0, 0, 0, 0, 0, 0], 3),
        public.level_of_care_recommendation(ARRAY[0, 0, 0, 0, 0, 0], NULL)],
  ARRAY[NULL, NULL, NULL]::jsonb[],
  'only the current rules version (2) gives a recommendation: not the old version 1, nor an unknown one'
);
SELECT is(
  ARRAY[
    public.case_assessment_event_body('Inpatient', NULL, NULL, 'Inpatient'),
    public.case_assessment_event_body('Inpatient', 'Detox', 'Sober Living', 'Detox'),
    public.case_assessment_event_body('IOP / PHP', NULL, NULL, 'Therapist'),
    public.case_assessment_event_body('Inpatient', 'Detox', NULL, 'Inpatient')],
  ARRAY[
    'Level-of-care assessment: recommended Inpatient',
    'Level-of-care assessment: recommended Detox, then Inpatient, with Sober Living',
    'Level-of-care assessment: recommended IOP / PHP; chosen Therapist',
    'Level-of-care assessment: recommended Detox, then Inpatient; chosen Inpatient'],
  'the timeline wording is the app''s: levels only; "chosen" whenever the choice is not where the recommendation starts'
);
-- The app's reason fixtures: 3 to 200 characters, one line, then the
-- shared identifying-details check (identifying_text_problem), its words.
SELECT is(
  ARRAY[
    coalesce(public.case_assessment_reason_problem('', NULL), 'ok'),
    coalesce(public.case_assessment_reason_problem('  ok ', NULL), 'ok'),
    coalesce(public.case_assessment_reason_problem(repeat('x', 201), NULL), 'ok'),
    coalesce(public.case_assessment_reason_problem('Family declined residential' || chr(10) || 'wants IOP', NULL), 'ok'),
    coalesce(public.case_assessment_reason_problem('Call mom at jane@example.com', NULL), 'ok'),
    coalesce(public.case_assessment_reason_problem('Reach her at 541-555-0142', NULL), 'ok'),
    coalesce(public.case_assessment_reason_problem('See www.example.org for the plan', NULL), 'ok'),
    coalesce(public.case_assessment_reason_problem('Family declined residential; daily IOP near home', NULL), 'ok'),
    coalesce(public.case_assessment_reason_problem('2 prior residential stays in 12 months', NULL), 'ok'),
    coalesce(public.case_assessment_reason_problem('Family can pay 40,000 for a private program', NULL), 'ok'),
    coalesce(public.case_assessment_reason_problem('DOB 3/14/1985, too young for this level', NULL), 'ok'),
    coalesce(public.case_assessment_reason_problem('Rivera wants to stay near work', ARRAY['Rivera intervention']), 'ok'),
    coalesce(public.case_assessment_reason_problem('Mother prefers weekly sessions', ARRAY['Rivera intervention', 'Mother']), 'ok')],
  ARRAY[
    'Say why you chose a different level. The reason goes in the program''s packet.',
    'Say why you chose a different level. The reason goes in the program''s packet.',
    'Keep the reason to 200 characters',
    'Keep the reason to one line',
    'Leave out email addresses. Programs read this.',
    'Leave out phone and ID numbers. Programs read this.',
    'Leave out links and web addresses. Programs read this.',
    'ok',
    'ok',
    'Leave money out. Programs read this.',
    'Leave out dates such as a birth date. Programs read this.',
    'Leave out names ("rivera" is a name on this case). Programs read this.',
    'ok'],
  'the override reason: one line, then the shared identifying-details check against the case''s names'
);

-- ===========================================================================
-- C. Everything is checked on the server
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.save_case_assessment(gen_random_uuid(), 'c1000000-0000-0000-0000-0000000000b8', ARRAY[1, 1, 1, 1, 1], NULL, false, 2,
       'Therapist', NULL, NULL, 'Therapist', '') $$,
  '22023', 'Rate all six areas from 0 to 4', 'five ratings are refused');
SELECT throws_ok(
  $$ SELECT public.save_case_assessment(gen_random_uuid(), 'c1000000-0000-0000-0000-0000000000b8', ARRAY[1, 1, 1, 1, 1, 5], NULL, false, 2,
       'Therapist', NULL, NULL, 'Therapist', '') $$,
  '22023', 'Rate all six areas from 0 to 4', 'a rating of 5 is refused');
SELECT throws_ok(
  $$ SELECT public.save_case_assessment(gen_random_uuid(), 'c1000000-0000-0000-0000-0000000000b8', ARRAY[1, 1, 1, 1, 1, NULL], NULL, false, 2,
       'Therapist', NULL, NULL, 'Therapist', '') $$,
  '22023', 'Rate all six areas from 0 to 4', 'an unrated area is refused');
SELECT throws_ok(
  $$ SELECT public.save_case_assessment(gen_random_uuid(), 'c1000000-0000-0000-0000-0000000000b8', ARRAY[0, 0, 0, 0, 0, 0], ARRAY['', '', '', '', ''], false, 2,
       'Therapist', NULL, NULL, 'Therapist', '') $$,
  '22023', 'Notes come one per area, six in all', 'notes come six at a time');
SELECT throws_ok(
  format($f$ SELECT public.save_case_assessment(gen_random_uuid(), 'c1000000-0000-0000-0000-0000000000b8', ARRAY[0, 0, 0, 0, 0, 0],
       ARRAY['', '', %L, '', '', ''], false, 2, 'Therapist', NULL, NULL, 'Therapist', '') $f$, repeat('n', 201)),
  '22023', 'Keep each note to 200 characters', 'a note over 200 characters is refused');
SELECT throws_ok(
  $$ SELECT public.save_case_assessment(gen_random_uuid(), 'c1000000-0000-0000-0000-0000000000b8', ARRAY[0, 0, 0, 0, 0, 0], NULL, false, 2,
       'Therapist', NULL, NULL, 'Interventionist', 'An interventionist is not a level of care') $$,
  '22023', 'Choose a level of care', 'Interventionist is not a level of care');
SELECT throws_ok(
  $$ SELECT public.save_case_assessment(gen_random_uuid(), 'c1000000-0000-0000-0000-0000000000b8', ARRAY[0, 0, 0, 0, 0, 0], NULL, false, 1,
       'Therapist', NULL, NULL, 'Therapist', '') $$,
  '22023', 'This version of the app uses recommendation rules the server does not have. Update the app, then save again.',
  'an app on the old rules (version 1) cannot save: the server accepts only version 2');
SELECT throws_ok(
  $$ SELECT public.save_case_assessment(gen_random_uuid(), 'c1000000-0000-0000-0000-0000000000b8', ARRAY[0, 3, 0, 0, 0, 0], NULL, false, 2,
       'Therapist', NULL, NULL, 'Therapist', '') $$,
  '22023', 'The recommendation on this phone does not match the server''s rules. Update the app, then save again.',
  'a recommendation the rules do not give is refused (physical 3 is Inpatient)');
SELECT throws_ok(
  $$ SELECT public.save_case_assessment(gen_random_uuid(), 'c1000000-0000-0000-0000-0000000000b8', ARRAY[3, 0, 0, 0, 0, 0], NULL, false, 2,
       'IOP / PHP', NULL, NULL, 'IOP / PHP', '') $$,
  '22023', 'The recommendation on this phone does not match the server''s rules. Update the app, then save again.',
  'a first step the app left out is refused');
SELECT throws_ok(
  $$ SELECT public.save_case_assessment(gen_random_uuid(), 'c1000000-0000-0000-0000-0000000000b8', ARRAY[3, 0, 0, 0, 0, 0], NULL, false, 2,
       'Therapist', 'Detox', NULL, 'Detox', '') $$,
  '22023', 'The recommendation on this phone does not match the server''s rules. Update the app, then save again.',
  'a version 1 recommendation is refused (after detox, version 2 steps down no lower than IOP / PHP)');
SELECT throws_ok(
  $$ SELECT public.save_case_assessment(gen_random_uuid(), 'c1000000-0000-0000-0000-0000000000b8', ARRAY[0, 3, 0, 0, 0, 0], NULL, false, 2,
       'Inpatient', NULL, NULL, 'IOP / PHP', '  ') $$,
  '22023', 'Say why you chose a different level. The reason goes in the program''s packet.',
  'a different level needs a reason');
SELECT throws_ok(
  $$ SELECT public.save_case_assessment(gen_random_uuid(), 'c1000000-0000-0000-0000-0000000000b8', ARRAY[0, 3, 0, 0, 0, 0], NULL, false, 2,
       'Inpatient', NULL, NULL, 'IOP / PHP', 'Call mom at jane@example.com') $$,
  '22023', 'Leave out email addresses. Programs read this.',
  'the reason is screened like the app screens it');
SELECT throws_ok(
  $$ SELECT public.save_case_assessment(gen_random_uuid(), 'c1000000-0000-0000-0000-0000000000b8', ARRAY[0, 3, 0, 0, 0, 0], NULL, false, 2,
       'Inpatient', NULL, NULL, 'IOP / PHP', 'Rivera works nights and needs evening groups') $$,
  '22023', 'Leave out names ("rivera" is a name on this case). Programs read this.',
  'a reason naming the case (its title) is refused');
SELECT throws_ok(
  $$ SELECT public.save_case_assessment(gen_random_uuid(), 'c1000000-0000-0000-0000-0000000000b8', ARRAY[0, 3, 0, 0, 0, 0], NULL, false, 2,
       'Inpatient', NULL, NULL, 'IOP / PHP', 'Dolores can drive to daily IOP') $$,
  '22023', 'Leave out names ("dolores" is a name on this case). Programs read this.',
  'a reason naming one of the case''s contacts is refused');
SELECT throws_ok(
  $$ SELECT public.save_case_assessment(gen_random_uuid(), 'c1000000-0000-0000-0000-0000000000b8', ARRAY[3, 3, 0, 0, 0, 0], NULL, false, 2,
       'Inpatient', 'Detox', NULL, 'Inpatient', '') $$,
  '22023', 'Say why you chose a different level. The reason goes in the program''s packet.',
  'skipping the detox first step (choosing the level after it) needs a reason');
SELECT throws_ok(
  $$ SELECT public.save_case_assessment(gen_random_uuid(), 'c1000000-0000-0000-0000-0000000000b8', ARRAY[0, 0, 0, 0, 0, 3], NULL, false, 2,
       'Therapist', NULL, 'Sober Living', 'Sober Living', '') $$,
  '22023', 'Say why you chose a different level. The reason goes in the program''s packet.',
  'the support level alone is a different level (treatment was recommended)');
SELECT throws_ok(
  $$ SELECT public.save_case_assessment(gen_random_uuid(), 'c3000000-0000-0000-0000-0000000000b8', ARRAY[0, 0, 0, 0, 0, 0], NULL, false, 2,
       'Therapist', NULL, NULL, 'Therapist', '') $$,
  'P0002', 'Case not found', 'another workspace''s case cannot be assessed (the org fence)');
SELECT throws_ok(
  $$ SELECT public.save_case_assessment(NULL, 'c1000000-0000-0000-0000-0000000000b8', ARRAY[0, 0, 0, 0, 0, 0], NULL, false, 2,
       'Therapist', NULL, NULL, 'Therapist', '') $$,
  '22023', 'An assessment id is required', 'the app makes the id');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.save_case_assessment(gen_random_uuid(), 'c1000000-0000-0000-0000-0000000000b8', ARRAY[0, 0, 0, 0, 0, 0], NULL, false, 2,
       'Therapist', NULL, NULL, 'Therapist', '') $$,
  '28000', 'Authentication is required', 'nobody signed in, nothing saved');
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.case_assessments), 0, 'nothing refused was saved');

-- ===========================================================================
-- D. Saving, the timeline, replay
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT set_config('test.saved', public.save_case_assessment('a1000000-0000-0000-0000-0000000000b8', 'c1000000-0000-0000-0000-0000000000b8',
  ARRAY[3, 2, 3, 2, 2, 3], ARRAY['  Daily fifth of vodka  ', '', 'Panic attacks nightly', '', '', 'Brother uses at home'], false, 2,
  'Inpatient', 'Detox', 'Sober Living', 'Detox', 'not needed when following the recommendation')::text, true);
SELECT is(
  (SELECT concat_ws(':', withdrawal_rating, physical_rating, emotional_rating, readiness_rating, relapse_rating, environment_rating,
                    withdrawal_note, emotional_note, environment_note, imminent_danger::text, recommended_level, recommended_first_step,
                    recommended_support, chosen_level, '[' || override_reason || ']', rules_version, assessed_by,
                    (org_id = current_setting('test.org_p')::uuid)::text)
     FROM public.case_assessments WHERE id = 'a1000000-0000-0000-0000-0000000000b8'),
  '3:2:3:2:2:3:Daily fifth of vodka:Panic attacks nightly:Brother uses at home:false:Inpatient:Detox:Sober Living:Detox:[]:2:b1000000-0000-0000-0000-0000000000b8:true',
  'saved: six ratings, trimmed notes, the recommendation, the chosen first step (no reason kept), who, and the workspace'
);
SELECT is(
  (SELECT current_setting('test.saved')::jsonb ->> 'event_body'),
  'Level-of-care assessment: recommended Detox, then Inpatient, with Sober Living',
  'the RPC returns the row with the timeline wording (detox first, as recommended: nothing chosen differently)'
);
SELECT is(
  (SELECT (current_setting('test.saved')::jsonb ->> 'id') || ':' || (current_setting('test.saved')::jsonb ->> 'case_id') || ':'
          || (current_setting('test.saved')::jsonb ->> 'emotional_rating')),
  'a1000000-0000-0000-0000-0000000000b8:c1000000-0000-0000-0000-0000000000b8:3',
  'the returned row is the saved row'
);
SELECT is(
  (SELECT kind || ':' || body || ':' || actor_id::text FROM public.case_events WHERE id = 'a1000000-0000-0000-0000-0000000000b8'),
  'system:Level-of-care assessment: recommended Detox, then Inpatient, with Sober Living:b1000000-0000-0000-0000-0000000000b8',
  'the timeline entry (same id) names the levels and who assessed'
);
SELECT ok(
  (SELECT body !~ '[0-9]' AND body NOT LIKE '%vodka%' AND body NOT LIKE '%Rivera%' FROM public.case_events WHERE id = 'a1000000-0000-0000-0000-0000000000b8'),
  'no rating, note or name on the timeline'
);
SELECT is(
  (public.save_case_assessment('a1000000-0000-0000-0000-0000000000b8', 'c1000000-0000-0000-0000-0000000000b8',
     ARRAY[0, 0, 0, 0, 0, 0], NULL, false, 2, 'Therapist', NULL, NULL, 'Therapist', '') ->> 'chosen_level'),
  'Detox',
  'a retry with the same id returns the saved row and changes nothing'
);
SELECT is(
  (SELECT count(*)::integer FROM public.case_assessments WHERE id = 'a1000000-0000-0000-0000-0000000000b8')
    + (SELECT count(*)::integer FROM public.case_events WHERE id = 'a1000000-0000-0000-0000-0000000000b8'),
  2,
  'one row and one timeline entry after the retry'
);
-- A reassessment: a different level, with a reason.
SELECT lives_ok(
  $$ SELECT public.save_case_assessment('a2000000-0000-0000-0000-0000000000b8', 'c1000000-0000-0000-0000-0000000000b8',
       ARRAY[0, 2, 0, 0, 0, 0], NULL, false, 2, 'IOP / PHP', '', '', 'Therapist', '  Family prefers weekly sessions near home  ') $$,
  'a case can be reassessed, choosing a different level with a reason'
);
SELECT is(
  (SELECT chosen_level || ':' || override_reason || ':' || coalesce(recommended_first_step, 'none') || ':' || coalesce(recommended_support, 'none')
     FROM public.case_assessments WHERE id = 'a2000000-0000-0000-0000-0000000000b8'),
  'Therapist:Family prefers weekly sessions near home:none:none',
  'the reason is kept, trimmed; empty first step and support are none'
);
SELECT is(
  (SELECT body FROM public.case_events WHERE id = 'a2000000-0000-0000-0000-0000000000b8'),
  'Level-of-care assessment: recommended IOP / PHP; chosen Therapist',
  'the reassessment''s timeline entry'
);
SELECT is(
  (SELECT (v ->> 'override_reason') || '|' || (v ->> 'event_body')
     FROM public.save_case_assessment('a7000000-0000-0000-0000-0000000000b8', 'c2000000-0000-0000-0000-0000000000b8',
            ARRAY[3, 3, 0, 0, 0, 0], NULL, false, 2, 'Inpatient', 'Detox', NULL, 'Inpatient', 'Detoxed last week at another program') AS v),
  'Detoxed last week at another program|Level-of-care assessment: recommended Detox, then Inpatient; chosen Inpatient',
  'starting after the detox step, with a reason: kept, and the timeline says what was chosen'
);
RESET ROLE;
UPDATE public.case_assessments SET assessed_at = now() - interval '30 days' WHERE id = 'a1000000-0000-0000-0000-0000000000b8';
SELECT is(
  (SELECT id FROM public.case_assessments WHERE case_id = 'c1000000-0000-0000-0000-0000000000b8' ORDER BY assessed_at DESC, id DESC LIMIT 1),
  'a2000000-0000-0000-0000-0000000000b8'::uuid,
  'the newest assessment is current'
);
SELECT throws_ok(
  $$ INSERT INTO public.case_assessments (id, org_id, case_id, withdrawal_rating, physical_rating, emotional_rating, readiness_rating,
       relapse_rating, environment_rating, recommended_level, chosen_level, override_reason, rules_version)
     VALUES (gen_random_uuid(), current_setting('test.org_p')::uuid, 'c1000000-0000-0000-0000-0000000000b8', 0, 0, 0, 0, 0, 0,
       'Therapist', 'Inpatient', '', 2) $$,
  '23514', NULL,
  'even a privileged writer cannot store a different level without a reason'
);
SELECT throws_ok(
  $$ INSERT INTO public.case_assessments (id, org_id, case_id, withdrawal_rating, physical_rating, emotional_rating, readiness_rating,
       relapse_rating, environment_rating, recommended_level, recommended_first_step, chosen_level, override_reason, rules_version)
     VALUES (gen_random_uuid(), current_setting('test.org_p')::uuid, 'c1000000-0000-0000-0000-0000000000b8', 3, 3, 0, 0, 0, 0,
       'Inpatient', 'Detox', 'Inpatient', '', 2) $$,
  '23514', NULL,
  'nor skip the detox first step without a reason'
);
SELECT throws_ok(
  $$ INSERT INTO public.case_assessments (id, org_id, case_id, withdrawal_rating, physical_rating, emotional_rating, readiness_rating,
       relapse_rating, environment_rating, recommended_level, chosen_level, override_reason, rules_version)
     VALUES (gen_random_uuid(), current_setting('test.org_q')::uuid, 'c1000000-0000-0000-0000-0000000000b8', 0, 0, 0, 0, 0, 0,
       'Therapist', 'Therapist', '', 2) $$,
  '23503', NULL,
  'an assessment cannot point at another workspace''s case'
);

-- ===========================================================================
-- E. Who reads what
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.case_assessments WHERE case_id = 'c1000000-0000-0000-0000-0000000000b8'), 2,
  'a teammate in the case''s workspace reads its assessments');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'b3000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.case_assessments), 0, 'another practice reads none');
SELECT throws_ok(
  $$ SELECT public.save_case_assessment('a1000000-0000-0000-0000-0000000000b8', 'c3000000-0000-0000-0000-0000000000b8',
       ARRAY[0, 0, 0, 0, 0, 0], NULL, false, 2, 'Therapist', NULL, NULL, 'Therapist', '') $$,
  'P0002', 'Assessment not found', 'another practice cannot replay (or read through) an assessment id');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT throws_ok($$ SELECT count(*) FROM public.case_assessments $$, '42501', NULL, 'anon cannot read the table at all');
RESET ROLE;

-- ===========================================================================
-- F. Production-grant emulation
-- ===========================================================================

-- Production's default ACL grants ALL on new tables. Even with every
-- privilege granted, RLS keeps anon out and refuses every client write.
GRANT ALL ON TABLE public.case_assessments TO anon, authenticated;
SET LOCAL ROLE anon;
SELECT is((SELECT count(*)::integer FROM public.case_assessments), 0, 'production grants: anon still reads no rows');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ INSERT INTO public.case_assessments (id, org_id, case_id, withdrawal_rating, physical_rating, emotional_rating, readiness_rating,
       relapse_rating, environment_rating, recommended_level, chosen_level, rules_version)
     VALUES (gen_random_uuid(), current_setting('test.org_p')::uuid, 'c1000000-0000-0000-0000-0000000000b8', 0, 0, 0, 0, 0, 0,
       'Therapist', 'Therapist', 2) $$,
  '42501', NULL,
  'production grants: a direct insert is refused by RLS'
);
UPDATE public.case_assessments SET chosen_level = 'Inpatient', override_reason = 'changed directly' WHERE id = 'a2000000-0000-0000-0000-0000000000b8';
DELETE FROM public.case_assessments WHERE id = 'a1000000-0000-0000-0000-0000000000b8';
RESET ROLE;
SELECT is(
  (SELECT count(*)::integer FROM public.case_assessments WHERE case_id = 'c1000000-0000-0000-0000-0000000000b8')::text || ':'
    || (SELECT chosen_level FROM public.case_assessments WHERE id = 'a2000000-0000-0000-0000-0000000000b8'),
  '2:Therapist',
  'production grants: direct updates and deletes change nothing'
);
REVOKE ALL ON TABLE public.case_assessments FROM anon, authenticated;
GRANT SELECT ON TABLE public.case_assessments TO authenticated;

-- ===========================================================================
-- G. Deleting a case
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$ SELECT public.save_case_assessment('a3000000-0000-0000-0000-0000000000b8', 'c2000000-0000-0000-0000-0000000000b8',
       ARRAY[0, 0, 0, 0, 4, 0], NULL, true, 2, 'Inpatient', NULL, NULL, 'Inpatient', '') $$,
  'an assessment of the short-lived case (immediate danger reported)'
);
SELECT is((SELECT imminent_danger FROM public.case_assessments WHERE id = 'a3000000-0000-0000-0000-0000000000b8'), true, 'immediate danger is kept');
SELECT lives_ok($$ DELETE FROM public.cases WHERE id = 'c2000000-0000-0000-0000-0000000000b8' $$, 'the case can still be deleted');
RESET ROLE;
SELECT is(
  (SELECT count(*)::integer FROM public.case_assessments WHERE case_id = 'c2000000-0000-0000-0000-0000000000b8')
    + (SELECT count(*)::integer FROM public.case_events WHERE id = 'a3000000-0000-0000-0000-0000000000b8'),
  0,
  'deleting a case deletes its assessments and their timeline entry'
);
SELECT is((SELECT count(*)::integer FROM public.case_assessments WHERE case_id = 'c1000000-0000-0000-0000-0000000000b8'), 2,
  'other cases keep theirs');

-- ===========================================================================
-- H. A solo practitioner joins: their assessments move with them
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'b4000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
INSERT INTO public.cases (id, title, status) VALUES ('c4000000-0000-0000-0000-0000000000b8', 'Solo case', 'inquiry');
SELECT public.save_case_assessment('a4000000-0000-0000-0000-0000000000b8', 'c4000000-0000-0000-0000-0000000000b8',
  ARRAY[0, 0, 2, 0, 0, 0], NULL, false, 2, 'IOP / PHP', NULL, NULL, 'IOP / PHP', '');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT set_config('test.invite', code, true) FROM public.create_org_invite();
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'b4000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$ SELECT public.accept_org_invite(current_setting('test.invite')) $$, 'a solo practitioner with an assessed case joins the practice');
SELECT lives_ok($$ SET CONSTRAINTS ALL IMMEDIATE $$, 'every deferred relationship is consistent after the join');
RESET ROLE;
SELECT is(
  (SELECT (a.org_id = current_setting('test.org_p')::uuid)::text || ':' || (c.org_id = a.org_id)::text
     FROM public.case_assessments a JOIN public.cases c ON c.id = a.case_id
    WHERE a.id = 'a4000000-0000-0000-0000-0000000000b8'),
  'true:true',
  'the assessment moved to the team with its case'
);
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.case_assessments WHERE id = 'a4000000-0000-0000-0000-0000000000b8'), 1,
  'the team now reads it');
SELECT is((SELECT body FROM public.case_events WHERE id = 'a4000000-0000-0000-0000-0000000000b8'),
  'Level-of-care assessment: recommended IOP / PHP', 'and its timeline entry');
RESET ROLE;

-- ===========================================================================
-- I. Accounts going away
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'b5000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
INSERT INTO public.cases (id, title, status) VALUES ('c5000000-0000-0000-0000-0000000000b8', 'K case', 'inquiry');
SELECT public.save_case_assessment('a5000000-0000-0000-0000-0000000000b8', 'c5000000-0000-0000-0000-0000000000b8',
  ARRAY[3, 0, 0, 0, 0, 0], NULL, false, 2, 'IOP / PHP', 'Detox', NULL, 'Detox', '');
SELECT lives_ok($$ SELECT public.delete_own_account() $$, 'a solo practice with an assessment can delete its account');
RESET ROLE;
SELECT is(
  (SELECT count(*)::integer FROM public.case_assessments WHERE id = 'a5000000-0000-0000-0000-0000000000b8')
    + (SELECT count(*)::integer FROM public.orgs WHERE id = current_setting('test.org_k')::uuid),
  0,
  'its assessments go with its workspace'
);

-- A teammate who assessed a case leaves: the assessment stays with the
-- practice, unattributed.
SELECT set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT public.save_case_assessment('a6000000-0000-0000-0000-0000000000b8', 'c1000000-0000-0000-0000-0000000000b8',
  ARRAY[0, 0, 0, 0, 0, 4], NULL, false, 2, 'Inpatient', NULL, 'Sober Living', 'Inpatient', '');
SELECT lives_ok($$ SELECT public.delete_own_account() $$, 'a member who assessed a case can delete their account');
RESET ROLE;
SELECT is(
  (SELECT coalesce(assessed_by::text, 'none') || ':' || (org_id = current_setting('test.org_p')::uuid)::text
     FROM public.case_assessments WHERE id = 'a6000000-0000-0000-0000-0000000000b8'),
  'none:true',
  'their assessment stays with the practice, unattributed'
);

-- ===========================================================================
-- J. The paste-order guard
-- ===========================================================================

-- As pasted (the local reset records each statement): without
-- 20261104140000's tables the file stops at once.
SELECT throws_ok(
  format('DO $t$ BEGIN ALTER TABLE public.placement_requests RENAME TO placement_requests_gone; EXECUTE %L; END $t$',
         (SELECT x FROM supabase_migrations.schema_migrations m, unnest(m.statements) AS x
           WHERE m.version = '20261104150000' AND x LIKE '%DO $$%Paste 20261104140000_placement_requests.sql first%')),
  'P0001', 'Paste 20261104140000_placement_requests.sql first: the placement request tables or the identifying-details check are missing.',
  'pasted without the placement request migration, this file stops before changing anything'
);
SELECT lives_ok(
  (SELECT x FROM supabase_migrations.schema_migrations m, unnest(m.statements) AS x
    WHERE m.version = '20261104150000' AND x LIKE '%DO $$%Paste 20261104140000_placement_requests.sql first%'),
  'with the placement request migration in place, the guard passes'
);

SELECT * FROM finish();
ROLLBACK;
