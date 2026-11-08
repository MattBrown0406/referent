-- Focused coverage for 20261108130000_placement_answer_links.sql: answer
-- links for programs asked by hand. Run after a local migration reset with:
-- supabase test db
--
-- This file is never pasted into production.

BEGIN;
SELECT plan(57);

-- Actors
--   p1  owner of practice P, sends the requests (push on, one device)
--   p2  member of practice P
--   q1  owner of practice Q (another workspace)
--   c1  center account that claimed L1 (answers in the portal)
-- Listings: L1 claimed; L2 and L3 unclaimed (asked by hand).
INSERT INTO auth.users (id, email)
VALUES
  ('c1000000-0000-0000-0000-0000000000c9', 'links-c1@example.test'),
  ('b1000000-0000-0000-0000-0000000000c9', 'links-p1@example.test'),
  ('b2000000-0000-0000-0000-0000000000c9', 'links-p2@example.test'),
  ('b3000000-0000-0000-0000-0000000000c9', 'links-q1@example.test');
SELECT set_config('test.org_p', org_id::text, true) FROM public.org_members WHERE user_id = 'b1000000-0000-0000-0000-0000000000c9';
UPDATE public.org_members SET org_id = current_setting('test.org_p')::uuid, role = 'member', display_name = 'Teammate'
 WHERE user_id = 'b2000000-0000-0000-0000-0000000000c9';
UPDATE public.orgs SET name = 'Cascade Interventions' WHERE id = current_setting('test.org_p')::uuid;

INSERT INTO public.global_partners (id, name, organization, types, city, state, status, verified_at)
VALUES
  ('d1000000-0000-0000-0000-0000000000c9', 'Admissions', 'Juniper Ridge Recovery', ARRAY['Inpatient'], 'Bend', 'OR', 'active', now()),
  ('d2000000-0000-0000-0000-0000000000c9', 'Intake', 'Unclaimed Oaks', ARRAY['Inpatient'], 'Bend', 'OR', 'active', now()),
  ('d3000000-0000-0000-0000-0000000000c9', 'Intake', 'Unclaimed Pines', ARRAY['Inpatient'], 'Salem', 'OR', 'active', now());
INSERT INTO public.center_members (user_id, global_partner_id)
VALUES ('c1000000-0000-0000-0000-0000000000c9', 'd1000000-0000-0000-0000-0000000000c9');

INSERT INTO public.notification_preferences (user_id, push_enabled) VALUES ('b1000000-0000-0000-0000-0000000000c9', true);
INSERT INTO public.push_tokens (expo_push_token, user_id, platform)
VALUES ('ExponentPushToken[linkstestp1aaaa]', 'b1000000-0000-0000-0000-0000000000c9', 'ios');

-- Practice P asks L1, L2 and L3 (request R1) and, separately, L2 (R2) and
-- L3 (R3). The saved match carries a label and a budget no program may see.
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000c9', true);
SET LOCAL ROLE authenticated;
SELECT public.import_global_partner('d1000000-0000-0000-0000-0000000000c9', 'e1000000-0000-0000-0000-0000000000c9');
SELECT public.import_global_partner('d2000000-0000-0000-0000-0000000000c9', 'e2000000-0000-0000-0000-0000000000c9');
SELECT public.import_global_partner('d3000000-0000-0000-0000-0000000000c9', 'e3000000-0000-0000-0000-0000000000c9');
INSERT INTO public.match_profiles (id, client_label, level_of_care, state, insurance, max_budget)
VALUES ('f2000000-0000-0000-0000-0000000000c9', 'Linkfamily Rivera', 'Inpatient', 'OR', 'Aetna', 48765);
SELECT public.create_placement_request('91000000-0000-0000-0000-0000000000c9', 'f2000000-0000-0000-0000-0000000000c9', NULL,
  ARRAY['e1000000-0000-0000-0000-0000000000c9', 'e2000000-0000-0000-0000-0000000000c9', 'e3000000-0000-0000-0000-0000000000c9']::uuid[],
  24, 'this_week', NULL);
SELECT public.create_placement_request('92000000-0000-0000-0000-0000000000c9', 'f2000000-0000-0000-0000-0000000000c9', NULL,
  ARRAY['e2000000-0000-0000-0000-0000000000c9']::uuid[], 24, 'this_week', NULL);
SELECT public.create_placement_request('93000000-0000-0000-0000-0000000000c9', 'f2000000-0000-0000-0000-0000000000c9', NULL,
  ARRAY['e3000000-0000-0000-0000-0000000000c9']::uuid[], 24, 'this_week', NULL);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

SELECT set_config('test.portal', id::text, true) FROM public.placement_request_recipients
 WHERE request_id = '91000000-0000-0000-0000-0000000000c9' AND partner_id = 'e1000000-0000-0000-0000-0000000000c9';
SELECT set_config('test.oaks', id::text, true) FROM public.placement_request_recipients
 WHERE request_id = '91000000-0000-0000-0000-0000000000c9' AND partner_id = 'e2000000-0000-0000-0000-0000000000c9';
SELECT set_config('test.pines', id::text, true) FROM public.placement_request_recipients
 WHERE request_id = '91000000-0000-0000-0000-0000000000c9' AND partner_id = 'e3000000-0000-0000-0000-0000000000c9';
SELECT set_config('test.r2', id::text, true) FROM public.placement_request_recipients
 WHERE request_id = '92000000-0000-0000-0000-0000000000c9';
SELECT set_config('test.r3', id::text, true) FROM public.placement_request_recipients
 WHERE request_id = '93000000-0000-0000-0000-0000000000c9';

-- ===========================================================================
-- A. Schema and grants
-- ===========================================================================

SELECT has_table('public', 'placement_answer_links', 'placement_answer_links exists');
SELECT has_column('public', 'placement_request_recipients', 'answered_via', 'recipients record how an answer arrived');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.placement_answer_links'::regclass), 'RLS is on for the links');
SELECT ok(
  (SELECT bool_and(NOT has_table_privilege(role, 'public.placement_answer_links', priv))
     FROM unnest(ARRAY['anon', 'authenticated']) AS role,
          unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS priv),
  'no client role holds anything on the links table, whatever the default ACL granted'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.placement_answer_link(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.placement_answer_link(uuid)', 'EXECUTE'),
  'only signed-in users can make a link'
);
SELECT ok(
  has_function_privilege('anon', 'public.public_placement_answer_open(text)', 'EXECUTE')
  AND has_function_privilege('anon', 'public.public_placement_answer_respond(text, text, text, date, integer, text, text)', 'EXECUTE'),
  'the program''s page runs signed out'
);
SELECT ok(
  (SELECT bool_and(NOT has_function_privilege(role, f, 'EXECUTE'))
     FROM unnest(ARRAY['anon', 'authenticated']) AS role,
          unnest(ARRAY['public.placement_answer_link_recipient(text)', 'public.placement_answer_link_view(uuid)',
                       'public.placement_recipient_answered_via()']) AS f),
  'the helpers are not callable by any client'
);
SELECT ok(
  (SELECT bool_and(p.prosecdef AND p.proconfig @> ARRAY['search_path=public'])
     FROM pg_proc p
    WHERE p.oid IN ('public.placement_answer_link(uuid)'::regprocedure,
                    'public.placement_answer_link_recipient(text)'::regprocedure,
                    'public.placement_answer_link_view(uuid)'::regprocedure,
                    'public.public_placement_answer_open(text)'::regprocedure,
                    'public.public_placement_answer_respond(text, text, text, date, integer, text, text)'::regprocedure)),
  'every privileged function is SECURITY DEFINER with a pinned search_path'
);

-- ===========================================================================
-- B. Making a link
-- ===========================================================================

SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.placement_answer_link(current_setting('test.oaks')::uuid) $$,
  '28000', 'Authentication is required', 'nobody signed in makes no link'
);
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000c9', true);
SELECT set_config('test.t1', public.placement_answer_link(current_setting('test.oaks')::uuid), true);
SELECT ok(current_setting('test.t1') ~ '^[0-9a-f]{64}$', 'the sender gets a 64-character token');
SELECT throws_ok(
  $$ SELECT public.placement_answer_link(current_setting('test.portal')::uuid) $$,
  '22023', 'This program answers in ReferralFit', 'a program that answers in the portal gets no link'
);
SELECT set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-0000000000c9', true);
SELECT set_config('test.t2', public.placement_answer_link(current_setting('test.oaks')::uuid), true);
SELECT ok(current_setting('test.t2') ~ '^[0-9a-f]{64}$' AND current_setting('test.t2') <> current_setting('test.t1'),
  'a teammate can make one too, and every link is new');
SELECT set_config('request.jwt.claim.sub', 'b3000000-0000-0000-0000-0000000000c9', true);
SELECT throws_ok(
  $$ SELECT public.placement_answer_link(current_setting('test.oaks')::uuid) $$,
  'P0002', 'That program is not on this request', 'another workspace cannot make a link for this request'
);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

SELECT is((SELECT count(*)::integer FROM public.placement_answer_links WHERE recipient_id = current_setting('test.oaks')::uuid), 2,
  'two links for the program');
SELECT ok(
  (SELECT bool_and(token_hash IN (extensions.digest(current_setting('test.t1'), 'sha256'), extensions.digest(current_setting('test.t2'), 'sha256'))
                   AND token_hash <> convert_to(current_setting('test.t1'), 'UTF8'))
     FROM public.placement_answer_links WHERE recipient_id = current_setting('test.oaks')::uuid),
  'only each token''s sha256 is stored, never the token'
);

-- ===========================================================================
-- C. Opening the page (signed out)
-- ===========================================================================

SET LOCAL ROLE anon;
SELECT is(public.public_placement_answer_open(repeat('0', 64)), NULL::jsonb, 'a wrong token opens nothing');
SELECT is(public.public_placement_answer_open('not-a-token'), NULL::jsonb, 'a malformed token opens nothing');
SELECT is(public.public_placement_answer_open(NULL), NULL::jsonb, 'no token opens nothing');
SELECT set_config('test.view', public.public_placement_answer_open(current_setting('test.t2'))::text, true);
RESET ROLE;

SELECT is(
  (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(current_setting('test.view')::jsonb) AS k),
  ARRAY['answer', 'can_respond', 'payload', 'practice_name', 'program_name', 'request_status', 'respond_by', 'sent_at', 'status'],
  'the page gets exactly these fields'
);
SELECT is(current_setting('test.view')::jsonb ->> 'program_name', 'Unclaimed Oaks', 'it names the program asked');
SELECT is(current_setting('test.view')::jsonb ->> 'practice_name', 'Cascade Interventions', 'and the practice asking');
SELECT ok(
  current_setting('test.view') NOT ILIKE '%linkfamily%' AND current_setting('test.view') NOT ILIKE '%rivera%'
  AND current_setting('test.view') NOT LIKE '%48765%' AND current_setting('test.view') NOT ILIKE '%juniper%'
  AND current_setting('test.view') NOT ILIKE '%pines%'
  AND current_setting('test.view') NOT LIKE '%' || current_setting('test.oaks') || '%'
  AND current_setting('test.view') NOT LIKE '%91000000-0000-0000-0000-0000000000c9%'
  AND current_setting('test.view') NOT LIKE '%e2000000-0000-0000-0000-0000000000c9%'
  AND current_setting('test.view') NOT LIKE '%' || current_setting('test.org_p') || '%',
  'no label, budget, other program, rank or id reaches the page'
);
SELECT ok(
  ((current_setting('test.view')::jsonb -> 'payload') - ARRAY['level_of_care', 'population', 'must_haves', 'needs', 'payment',
     'insurance_carrier', 'home_state', 'location_preference', 'admit_window', 'note']::text[]) = '{}'::jsonb,
  'the summary is the allow-listed payload'
);
SELECT is(
  (SELECT ARRAY[v ->> 'status', v ->> 'can_respond', coalesce(v ->> 'answer', 'none'), v ->> 'request_status']
     FROM (SELECT current_setting('test.view')::jsonb AS v) s),
  ARRAY['sent', 'true', 'none', 'open'],
  'opened: still sent (opening reads only), can answer, no answer yet'
);
SET LOCAL ROLE anon;
SELECT is(public.public_placement_answer_seen(current_setting('test.t2')), true, 'the program''s first tap marks it seen');
SELECT is(public.public_placement_answer_seen(current_setting('test.t2')), false, 'once');
RESET ROLE;
SELECT ok(
  (SELECT status = 'viewed' AND viewed_at IS NOT NULL FROM public.placement_request_recipients WHERE id = current_setting('test.oaks')::uuid),
  'the program''s row reads viewed after its first interaction, never on page load (20261108170000)'
);

-- ===========================================================================
-- D. Answering (signed out)
-- ===========================================================================

SET LOCAL ROLE anon;
SELECT throws_ok(
  $$ SELECT public.public_placement_answer_respond(current_setting('test.t1'), NULL, 'yes', NULL, NULL, NULL, NULL) $$,
  '22023', 'Choose yes, no or waitlist for a bed', 'the answer is checked as in the portal'
);
SELECT throws_ok(
  $$ SELECT public.public_placement_answer_respond(current_setting('test.t1'), 'yes', 'yes', NULL, 0, NULL, NULL) $$,
  '22023', 'The daily rate is whole dollars, from 1 to 100,000', 'the rate is checked'
);
SELECT throws_ok(
  $$ SELECT public.public_placement_answer_respond(current_setting('test.t1'), 'yes', 'yes', CURRENT_DATE + 900, NULL, NULL, NULL) $$,
  '22023', 'Check the earliest admit date', 'the admit date is checked'
);
SELECT throws_ok(
  $$ SELECT public.public_placement_answer_respond(repeat('0', 64), 'yes', 'yes', NULL, NULL, NULL, NULL) $$,
  'P0002', 'This link is not active', 'a wrong token answers nothing'
);
SELECT set_config('test.answered', public.public_placement_answer_respond(current_setting('test.t1'), 'yes', 'yes', CURRENT_DATE + 2, 950,
  'In-network with Aetna', 'Young-adult cohort open.')::text, true);
RESET ROLE;

SELECT is(
  (SELECT ARRAY[a ->> 'bed_available', a ->> 'likely_accept', a ->> 'daily_rate', a ->> 'cost_note', a ->> 'note']
     FROM (SELECT current_setting('test.answered')::jsonb -> 'answer' AS a) s),
  ARRAY['yes', 'yes', '950', 'In-network with Aetna', 'Young-adult cohort open.'],
  'the answer comes back to the page'
);
SELECT is(current_setting('test.answered')::jsonb ->> 'status', 'responded', 'and reads responded');
SELECT ok(
  (SELECT status = 'responded' AND NOT entered_by_practice AND responded_by IS NULL AND answered_via = 'link'
          AND earliest_admit_on = CURRENT_DATE + 2
     FROM public.placement_request_recipients WHERE id = current_setting('test.oaks')::uuid),
  'it is stored as the program''s own answer, by link'
);
SELECT is(
  (SELECT string_agg(user_id::text || ':' || (data ->> 'placement_request_id'), ',') FROM public.notification_outbox WHERE kind = 'placement_response'),
  'b1000000-0000-0000-0000-0000000000c9:91000000-0000-0000-0000-0000000000c9',
  'the practitioner who sent the request gets the push, through the existing trigger'
);

-- The practice cannot log over it.
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000c9', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.log_manual_response(current_setting('test.oaks')::uuid, 'no', 'no', NULL, NULL, NULL, NULL) $$,
  '22023', 'The program already answered in ReferralFit', 'the practice cannot log over the program''s own answer'
);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

-- The program changes its answer: a decline, by the other link.
SET LOCAL ROLE anon;
SELECT set_config('test.declined', public.public_placement_answer_respond(current_setting('test.t2'), 'no', 'no', NULL, NULL, NULL, NULL)::text, true);
RESET ROLE;
SELECT is(current_setting('test.declined')::jsonb ->> 'status', 'declined', 'likely to accept no is a decline');
SELECT ok(
  (SELECT status = 'declined' AND daily_rate IS NULL AND cost_note = '' AND answered_via = 'link'
     FROM public.placement_request_recipients WHERE id = current_setting('test.oaks')::uuid),
  'the change replaces the whole answer'
);

-- A link answer replaces one the practice logged by hand.
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000c9', true);
SET LOCAL ROLE authenticated;
SELECT public.log_manual_response(current_setting('test.pines')::uuid, 'waitlist', 'maybe', NULL, NULL, NULL, 'From a call');
SELECT set_config('test.tp', public.placement_answer_link(current_setting('test.pines')::uuid), true);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT is((SELECT answered_via FROM public.placement_request_recipients WHERE id = current_setting('test.pines')::uuid), 'practice',
  'an answer logged by hand reads practice');
SET LOCAL ROLE anon;
SELECT set_config('test.pview', public.public_placement_answer_open(current_setting('test.tp'))::text, true);
RESET ROLE;
SELECT is(
  (SELECT ARRAY[v ->> 'status', coalesce(v ->> 'answer', 'none')] FROM (SELECT current_setting('test.pview')::jsonb AS v) s),
  ARRAY['sent', 'none'],
  'the program does not see the answer the practice logged: it reads unanswered'
);
SET LOCAL ROLE anon;
SELECT public.public_placement_answer_respond(current_setting('test.tp'), 'yes', 'maybe', NULL, 1100, NULL, NULL);
RESET ROLE;
SELECT ok(
  (SELECT status = 'responded' AND bed_available = 'yes' AND daily_rate = 1100 AND note = '' AND NOT entered_by_practice
          AND responded_by IS NULL AND answered_via = 'link'
     FROM public.placement_request_recipients WHERE id = current_setting('test.pines')::uuid),
  'the program''s own answer replaces the one the practice logged'
);

-- A portal answer reads portal.
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000c9', true);
SET LOCAL ROLE authenticated;
SELECT public.respond_to_placement_request(current_setting('test.portal')::uuid, 'yes', 'yes', NULL, NULL, NULL, NULL);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT is((SELECT answered_via FROM public.placement_request_recipients WHERE id = current_setting('test.portal')::uuid), 'portal',
  'an answer from the center portal reads portal');

-- ===========================================================================
-- E. Newest five links; closed and expired requests
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000c9', true);
SET LOCAL ROLE authenticated;
SELECT set_config('test.r3a', public.placement_answer_link(current_setting('test.r3')::uuid), true);
SELECT public.placement_answer_link(current_setting('test.r3')::uuid) FROM generate_series(1, 4);
SELECT set_config('test.r3f', public.placement_answer_link(current_setting('test.r3')::uuid), true);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT is((SELECT count(*)::integer FROM public.placement_answer_links WHERE recipient_id = current_setting('test.r3')::uuid), 5,
  'a program keeps its five newest links');
SET LOCAL ROLE anon;
SELECT is(public.public_placement_answer_open(current_setting('test.r3a')), NULL::jsonb, 'the sixth link retires the oldest');
SELECT ok(public.public_placement_answer_open(current_setting('test.r3f')) IS NOT NULL, 'the newest works');
RESET ROLE;

-- R2: a link, then the practice cancels the request.
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000c9', true);
SET LOCAL ROLE authenticated;
SELECT set_config('test.t_r2', public.placement_answer_link(current_setting('test.r2')::uuid), true);
SELECT public.cancel_placement_request('92000000-0000-0000-0000-0000000000c9');
SELECT throws_ok(
  $$ SELECT public.placement_answer_link(current_setting('test.r2')::uuid) $$,
  '22023', 'This request is closed', 'no new link once the request is cancelled'
);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SET LOCAL ROLE anon;
SELECT is(
  (SELECT ARRAY[v ->> 'request_status', v ->> 'can_respond'] FROM (SELECT public.public_placement_answer_open(current_setting('test.t_r2')) AS v) s),
  ARRAY['cancelled', 'false'],
  'the page says the request is closed'
);
SELECT is(
  (SELECT (v -> 'payload') = '{}'::jsonb AND v ->> 'practice_name' = '' FROM (SELECT public.public_placement_answer_open(current_setting('test.t_r2')) AS v) s),
  true,
  'a closed request shows only its status: no summary, no practice name (20261108170000)'
);
SELECT throws_ok(
  $$ SELECT public.public_placement_answer_respond(current_setting('test.t_r2'), 'yes', 'yes', NULL, NULL, NULL, NULL) $$,
  '22023', 'This request is closed. The practice is no longer waiting for answers.', 'a cancelled request takes no answer'
);
RESET ROLE;

-- R3: the deadline passes.
UPDATE public.placement_requests SET created_at = now() - interval '2 days', respond_by = now() - interval '1 day'
 WHERE id = '93000000-0000-0000-0000-0000000000c9';
SET LOCAL ROLE anon;
SELECT is(
  (SELECT ARRAY[v ->> 'status', v ->> 'can_respond', v ->> 'request_status']
     FROM (SELECT public.public_placement_answer_open(current_setting('test.r3f')) AS v) s),
  ARRAY['expired', 'false', 'open'],
  'past the deadline the page reads expired'
);
SELECT throws_ok(
  $$ SELECT public.public_placement_answer_respond(current_setting('test.r3f'), 'yes', 'yes', NULL, NULL, NULL, NULL) $$,
  '22023', 'The time to answer this request has passed', 'past the deadline no answer is taken'
);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000c9', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.placement_answer_link(current_setting('test.r3')::uuid) $$,
  '22023', 'The time to answer this request has passed', 'and no new link is made'
);
-- The practice can still log a late phone answer (unchanged rule).
SELECT lives_ok(
  $$ SELECT public.log_manual_response(current_setting('test.r3')::uuid, 'yes', 'yes', NULL, NULL, NULL, NULL) $$,
  'the practice can still log a late answer by hand'
);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

-- ===========================================================================
-- F. Cleanup follows the request
-- ===========================================================================

SELECT ok(
  (SELECT count(*) FROM public.placement_answer_links l
     JOIN public.placement_request_recipients r ON r.id = l.recipient_id
    WHERE r.request_id = '93000000-0000-0000-0000-0000000000c9') = 5,
  'the links are there before the request is deleted'
);
DELETE FROM public.placement_requests WHERE id = '93000000-0000-0000-0000-0000000000c9';
SELECT is((SELECT count(*)::integer FROM public.placement_answer_links WHERE recipient_id = current_setting('test.r3')::uuid), 0,
  'deleting a request deletes its links');
SELECT ok(
  NOT EXISTS (SELECT 1 FROM public.placement_request_recipients
               WHERE request_id IN ('91000000-0000-0000-0000-0000000000c9', '92000000-0000-0000-0000-0000000000c9')
                 AND channel = 'portal' AND answered_via = 'link'),
  'no portal program ever reads as answered by link'
);
SELECT ok(
  NOT EXISTS (SELECT 1 FROM public.placement_request_recipients
               WHERE request_id IN ('91000000-0000-0000-0000-0000000000c9', '92000000-0000-0000-0000-0000000000c9')
                 AND (responded_at IS NULL) <> (answered_via IS NULL)),
  'every answer says how it arrived, and only answers do'
);

SELECT * FROM finish();
ROLLBACK;
