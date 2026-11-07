-- Focused coverage for 20261106130000_referral_handoffs_fold_in.sql: the
-- referral-growth branch's leftovers are gone, and handoffs work on today's
-- schema (create, a program's steps, joining a team, the duplicate-partner
-- merge, deleting an account). Run after a local migration reset with:
-- supabase test db
--
-- This file is never pasted into production.

BEGIN;
SELECT plan(47);

-- Actors
--   t1  owner of team T (TA imports listing L1)
--   m1  member of team T
--   j1  solo practitioner J (JA imports L1 too), joins T
--   s1  solo practitioner S, deletes the account
INSERT INTO auth.users (id, email)
VALUES
  ('b1000000-0000-0000-0000-0000000000e9', 'handoff-t1@example.test'),
  ('b2000000-0000-0000-0000-0000000000e9', 'handoff-m1@example.test'),
  ('b3000000-0000-0000-0000-0000000000e9', 'handoff-j1@example.test'),
  ('b4000000-0000-0000-0000-0000000000e9', 'handoff-s1@example.test');
SELECT set_config('test.org_t', org_id::text, true) FROM public.org_members WHERE user_id = 'b1000000-0000-0000-0000-0000000000e9';
SELECT set_config('test.org_j', org_id::text, true) FROM public.org_members WHERE user_id = 'b3000000-0000-0000-0000-0000000000e9';
SELECT set_config('test.org_s', org_id::text, true) FROM public.org_members WHERE user_id = 'b4000000-0000-0000-0000-0000000000e9';
UPDATE public.org_members SET org_id = current_setting('test.org_t')::uuid, role = 'member', display_name = 'Morgan'
 WHERE user_id = 'b2000000-0000-0000-0000-0000000000e9';
UPDATE public.orgs SET name = 'Cascade Interventions' WHERE id = current_setting('test.org_t')::uuid;

INSERT INTO public.global_partners (id, name, organization, types, city, state, status, verified_at)
VALUES ('d1000000-0000-0000-0000-0000000000e9', 'Admissions', 'Juniper Ridge Recovery', ARRAY['Inpatient'], 'Bend', 'OR', 'active', now());

-- ===========================================================================
-- A. What the fold-in removed
-- ===========================================================================

SELECT ok(
  to_regclass('public.referral_sources') IS NULL AND to_regclass('public.referral_intake_submissions') IS NULL
  AND to_regclass('public.referral_intake_rate_limits') IS NULL AND to_regclass('public.center_availability') IS NULL,
  'referral links, the public form and program availability are gone'
);
SELECT ok(
  NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
               AND proname IN ('public_referral_intake_submit', 'public_referral_source_resolve', 'rotate_referral_source',
                               'guard_referral_source_update', 'get_center_availability', 'confirm_center_availability',
                               'save_voice_activity', 'is_org_case_or_partner_folder')),
  'and every function that served them, voice capture included'
);
SELECT is(
  (SELECT allowed_mime_types FROM storage.buckets WHERE id = 'case-documents'),
  ARRAY['image/jpeg', 'image/png', 'image/heic', 'image/webp', 'application/pdf']::text[],
  'case documents take images and PDFs again, no audio'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname LIKE 'case docs: org %' AND coalesce(qual, with_check) LIKE '%is_org_case_folder%'
     AND roles = '{authenticated}'),
  3,
  'the case document rules check case folders only, for signed-in users'
);

-- ===========================================================================
-- B. A handoff: created, its alias checked
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000e9', true);
SET LOCAL ROLE authenticated;
SELECT public.import_global_partner('d1000000-0000-0000-0000-0000000000e9', 'e1000000-0000-0000-0000-0000000000e9');
INSERT INTO public.referrals (id, owner_id, partner_id, direction, referred_on, client_label)
VALUES ('f1000000-0000-0000-0000-0000000000e9', 'b1000000-0000-0000-0000-0000000000e9', 'e1000000-0000-0000-0000-0000000000e9', 'outbound', '2026-11-01', 'Team client');
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', 'b3000000-0000-0000-0000-0000000000e9', true);
SET LOCAL ROLE authenticated;
SELECT public.import_global_partner('d1000000-0000-0000-0000-0000000000e9', 'e3000000-0000-0000-0000-0000000000e9');
INSERT INTO public.cases (id, title, status) VALUES ('c3000000-0000-0000-0000-0000000000e9', 'Lopez intervention', 'engaged');
INSERT INTO public.case_contacts (case_id, name, relationship, is_primary) VALUES ('c3000000-0000-0000-0000-0000000000e9', 'Maria Lopez', 'mother', true);
INSERT INTO public.referrals (id, owner_id, partner_id, direction, referred_on, client_label, case_id)
VALUES ('f3000000-0000-0000-0000-0000000000e9', 'b3000000-0000-0000-0000-0000000000e9', 'e3000000-0000-0000-0000-0000000000e9', 'outbound', '2026-11-01', 'Lopez family', 'c3000000-0000-0000-0000-0000000000e9');
SELECT throws_ok(
  $$ SELECT * FROM public.create_referral_handoff('f3000000-0000-0000-0000-0000000000e9', 'c3000000-0000-0000-0000-0000000000e9',
       'e3000000-0000-0000-0000-0000000000e9', 'Maria''s son', 'Juniper Ridge admissions', '') $$,
  '22023', NULL, 'an alias with a name from the case is refused: the program reads it'
);
SELECT throws_ok(
  $$ SELECT * FROM public.create_referral_handoff('f3000000-0000-0000-0000-0000000000e9', 'c3000000-0000-0000-0000-0000000000e9',
       'e3000000-0000-0000-0000-0000000000e9', 'DOB 3/14/1988', 'Juniper Ridge admissions', '') $$,
  '22023', NULL, 'so is a birth date'
);
SELECT set_config('test.j_token', token, true)
  FROM public.create_referral_handoff('f3000000-0000-0000-0000-0000000000e9', 'c3000000-0000-0000-0000-0000000000e9',
       'e3000000-0000-0000-0000-0000000000e9', 'Family A', 'Juniper Ridge admissions', 'admissions@juniper.example.org');
RESET ROLE;
SELECT set_config('test.j_handoff', id::text, true) FROM public.referral_handoffs WHERE referral_id = 'f3000000-0000-0000-0000-0000000000e9';
SELECT is(
  (SELECT kind || ':' || status || ':' || (owner_id = 'b3000000-0000-0000-0000-0000000000e9')::text FROM public.follow_ups
    WHERE referral_handoff_id = current_setting('test.j_handoff')::uuid),
  'referral_handshake:open:true',
  'creating a handoff works again: its reminder is a follow-up of the handoff kind'
);
SELECT is(length(current_setting('test.j_token')), 64, 'the program''s link carries a 64-character token, stored only as a hash');

-- ===========================================================================
-- C. The program's steps (the public Edge Function calls these, as the
--    service role: nobody is signed in)
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', '', true);

SELECT is(
  (SELECT client_alias || ':' || sender_practice_display || ':' || status || ':' || allowed_next_status
     FROM public.public_referral_handoff_resolve(current_setting('test.j_token'))),
  'Family A:' || (SELECT name FROM public.orgs WHERE id = current_setting('test.org_j')::uuid) || ':sent:received',
  'the program sees the alias, the practice, the status and the one next step'
);
SELECT is((SELECT count(*)::integer FROM public.public_referral_handoff_resolve('not-the-token')), 0, 'a wrong link shows nothing');
SELECT is(
  (SELECT status || ':' || version FROM public.public_referral_handoff_transition(current_setting('test.j_token'), 1, 'received')),
  'received:2', 'the program marks it received'
);
SELECT throws_ok($$ SELECT * FROM public.public_referral_handoff_transition(current_setting('test.j_token'), 1, 'contact_attempted') $$,
  '40001', NULL, 'a step from a stale page is refused');
SELECT throws_ok($$ SELECT * FROM public.public_referral_handoff_transition(current_setting('test.j_token'), 2, 'consult_scheduled') $$,
  '22023', NULL, 'steps cannot be skipped');
SELECT is(
  (SELECT string_agg(status || ':' || title, ',' ORDER BY created_at, status) FROM public.follow_ups
    WHERE referral_handoff_id = current_setting('test.j_handoff')::uuid),
  'done:Referral handoff: awaiting receipt,open:Referral handoff: contact the family',
  'the reminder moves on with the handoff'
);
SELECT throws_ok(
  $$ UPDATE public.referral_handoff_events SET to_status = 'closed' WHERE handoff_id = current_setting('test.j_handoff')::uuid $$,
  '42501', NULL, 'the history is never edited'
);
SELECT throws_ok(
  $$ UPDATE public.referral_handoff_events SET actor_id = 'b1000000-0000-0000-0000-0000000000e9' WHERE handoff_id = current_setting('test.j_handoff')::uuid $$,
  '42501', NULL, 'not even who did a step (only a deleted account''s id is cleared)'
);

-- ===========================================================================
-- D. Joining a team: the handoff, its history and reminder move along
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000e9', true);
SET LOCAL ROLE authenticated;
SELECT set_config('test.invite', code, true) FROM public.create_org_invite();
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'b3000000-0000-0000-0000-0000000000e9', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$ SELECT public.accept_org_invite(current_setting('test.invite')) $$, 'a solo practitioner with a handoff joins the team');
SELECT lives_ok($$ SET CONSTRAINTS ALL IMMEDIATE $$, 'every deferred relationship is consistent after the join');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT is(
  (SELECT (h.org_id = current_setting('test.org_t')::uuid)::text || ':' || (h.partner_id = 'e1000000-0000-0000-0000-0000000000e9')::text
     FROM public.referral_handoffs h WHERE h.id = current_setting('test.j_handoff')::uuid),
  'true:true',
  'the handoff is the team''s now, pointed at the team''s copy of the program'
);
SELECT is(
  (SELECT count(*)::integer FROM public.referral_handoff_events
    WHERE handoff_id = current_setting('test.j_handoff')::uuid AND org_id = current_setting('test.org_t')::uuid),
  2, 'its whole history moved with it'
);
SELECT ok(
  NOT EXISTS (SELECT 1 FROM public.follow_ups WHERE referral_handoff_id = current_setting('test.j_handoff')::uuid
               AND org_id <> current_setting('test.org_t')::uuid),
  'and so did its reminders'
);
SELECT is(
  (SELECT status || ':' || version FROM public.public_referral_handoff_transition(current_setting('test.j_token'), 2, 'contact_attempted')),
  'contact_attempted:3', 'the program''s link still works after the move'
);

-- ===========================================================================
-- D2. Who moves a step: a teammate, a program signed in to the portal, a
--     creator who left. The reminder stays with the right person.
-- ===========================================================================

INSERT INTO auth.users (id, email)
VALUES ('c1000000-0000-0000-0000-0000000000e9', 'handoff-center@example.test'),
       ('a9000000-0000-0000-0000-0000000000e9', 'handoff-gone@example.test');

-- m1 (a teammate) marks j1's handoff in the app.
SELECT set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-0000000000e9', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT status || ':' || version FROM public.transition_referral_handoff(current_setting('test.j_handoff')::uuid, 3, 'family_reached')),
  'family_reached:4', 'a teammate marks a step on someone else''s handoff'
);
RESET ROLE;
SELECT is(
  (SELECT owner_id FROM public.follow_ups WHERE referral_handoff_id = current_setting('test.j_handoff')::uuid AND status = 'open'),
  'b3000000-0000-0000-0000-0000000000e9'::uuid, 'and the next reminder is still the creator''s'
);

-- The program's page in a browser signed in to the center portal: the
-- request carries the center account, which is in no part of the practice.
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000e9', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT status || ':' || version FROM public.public_referral_handoff_transition(current_setting('test.j_token'), 4, 'consult_scheduled')),
  'consult_scheduled:5', 'the program''s page works while its browser is signed in to the portal'
);
SELECT is(auth.uid(), 'c1000000-0000-0000-0000-0000000000e9'::uuid, 'and the request''s own identity is back after the step');
RESET ROLE;
SELECT ok(
  (SELECT owner_id = 'b3000000-0000-0000-0000-0000000000e9' FROM public.follow_ups
    WHERE referral_handoff_id = current_setting('test.j_handoff')::uuid AND status = 'open')
  AND NOT EXISTS (SELECT 1 FROM public.follow_ups WHERE referral_handoff_id = current_setting('test.j_handoff')::uuid
                   AND completed_by = 'c1000000-0000-0000-0000-0000000000e9'),
  'the reminder stays the creator''s, and the center account is written into no practice row'
);

-- A creator no longer in the workspace (a9 has a workspace of its own):
-- the next reminder goes to the workspace owner.
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000e9', true);
SET LOCAL ROLE authenticated;
SELECT set_config('test.t_token', token, true)
  FROM public.create_referral_handoff('f1000000-0000-0000-0000-0000000000e9', NULL, 'e1000000-0000-0000-0000-0000000000e9', 'Family D', 'Juniper Ridge', '');
SELECT throws_ok(
  $$ SELECT * FROM public.create_referral_handoff('f1000000-0000-0000-0000-0000000000e9', NULL, 'e1000000-0000-0000-0000-0000000000e9', 'Family E', 'Juniper Ridge', '') $$,
  '23505', NULL, 'a referral has one open handoff at a time'
);
INSERT INTO public.referrals (id, owner_id, partner_id, direction, referred_on, client_label)
VALUES ('f5000000-0000-0000-0000-0000000000e9', 'b1000000-0000-0000-0000-0000000000e9', 'e1000000-0000-0000-0000-0000000000e9', 'inbound', '2026-11-04', 'Inbound client');
SELECT throws_ok(
  $$ SELECT * FROM public.create_referral_handoff('f5000000-0000-0000-0000-0000000000e9', NULL, 'e1000000-0000-0000-0000-0000000000e9', 'Family F', 'Juniper Ridge', '') $$,
  '22023', NULL, 'and only one this practice sent out'
);
RESET ROLE;
UPDATE public.referral_handoffs SET owner_id = 'a9000000-0000-0000-0000-0000000000e9' WHERE referral_id = 'f1000000-0000-0000-0000-0000000000e9';
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT is(
  (SELECT f.owner_id FROM public.follow_ups f
    WHERE f.referral_handoff_id = (SELECT id FROM public.public_referral_handoff_transition(current_setting('test.t_token'), 1, 'received') AS t
                                    CROSS JOIN public.referral_handoffs h WHERE h.referral_id = 'f1000000-0000-0000-0000-0000000000e9')
      AND f.status = 'open'),
  'b1000000-0000-0000-0000-0000000000e9'::uuid,
  'a creator who left the team: the next reminder goes to the workspace owner'
);

-- The history goes only with its handoff.
SELECT throws_ok(
  $$ DELETE FROM public.referral_handoff_events WHERE handoff_id = current_setting('test.j_handoff')::uuid $$,
  '42501', NULL, 'the history is never deleted on its own'
);
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000e9', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$ DELETE FROM public.referrals WHERE id = 'f1000000-0000-0000-0000-0000000000e9' $$, 'deleting a referral with a handoff works');
RESET ROLE;
SELECT is(
  (SELECT count(*)::integer FROM public.referral_handoffs WHERE referral_id = 'f1000000-0000-0000-0000-0000000000e9'),
  0, 'and takes its handoff, history and link with it'
);
SELECT ok(
  pg_get_functiondef('public.org_move_workspace_rows(uuid, uuid)'::regprocedure) LIKE '%case_assessments%',
  'moving a workspace still moves its level-of-care assessments'
);

-- ===========================================================================
-- E. Deleting an account
-- ===========================================================================

-- A team member's: the handoff stays with the team; the next reminder goes
-- to the workspace owner.
SELECT set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-0000000000e9', true);
SET LOCAL ROLE authenticated;
INSERT INTO public.referrals (id, owner_id, partner_id, direction, referred_on, client_label)
VALUES ('f2000000-0000-0000-0000-0000000000e9', 'b2000000-0000-0000-0000-0000000000e9', 'e1000000-0000-0000-0000-0000000000e9', 'outbound', '2026-11-02', 'M client');
SELECT set_config('test.m_token', token, true)
  FROM public.create_referral_handoff('f2000000-0000-0000-0000-0000000000e9', NULL, 'e1000000-0000-0000-0000-0000000000e9', 'Family B', 'Juniper Ridge', '');
SELECT lives_ok($$ SELECT public.delete_own_account() $$, 'a team member who sent a handoff deletes their account');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT is(
  (SELECT (owner_id IS NULL)::text || ':' || status FROM public.referral_handoffs WHERE referral_id = 'f2000000-0000-0000-0000-0000000000e9'),
  'true:sent', 'their handoff stays with the team'
);
SELECT is(
  (SELECT status FROM public.public_referral_handoff_transition(current_setting('test.m_token'), 1, 'received')),
  'received', 'and the program can still answer it'
);
SELECT is(
  (SELECT f.owner_id FROM public.follow_ups f JOIN public.referral_handoffs h ON h.id = f.referral_handoff_id
    WHERE h.referral_id = 'f2000000-0000-0000-0000-0000000000e9' AND f.status = 'open'),
  'b1000000-0000-0000-0000-0000000000e9'::uuid,
  'the next reminder goes to the workspace owner'
);

-- A solo practitioner's: the workspace goes, with its handoffs and history.
SELECT set_config('request.jwt.claim.sub', 'b4000000-0000-0000-0000-0000000000e9', true);
SET LOCAL ROLE authenticated;
INSERT INTO public.partners (id, owner_id, name, organization, state) VALUES ('e4000000-0000-0000-0000-0000000000e9', 'b4000000-0000-0000-0000-0000000000e9', 'Intake', 'Solo Program', 'OR');
INSERT INTO public.referrals (id, owner_id, partner_id, direction, referred_on, client_label)
VALUES ('f4000000-0000-0000-0000-0000000000e9', 'b4000000-0000-0000-0000-0000000000e9', 'e4000000-0000-0000-0000-0000000000e9', 'outbound', '2026-11-03', 'S client');
SELECT * FROM public.create_referral_handoff('f4000000-0000-0000-0000-0000000000e9', NULL, 'e4000000-0000-0000-0000-0000000000e9', 'Family C', 'Solo Program', '');
SELECT lives_ok($$ SELECT public.delete_own_account() $$, 'a solo practitioner with a handoff deletes their account');
RESET ROLE;
SELECT is(
  (SELECT count(*)::integer FROM public.referral_handoffs WHERE org_id = current_setting('test.org_s')::uuid)
  + (SELECT count(*)::integer FROM public.referral_handoff_events WHERE org_id = current_setting('test.org_s')::uuid),
  0, 'the workspace''s handoffs and their history are gone with it'
);

-- ===========================================================================
-- F. Grants and keys
-- ===========================================================================

SELECT ok(
  has_function_privilege('authenticated', 'public.create_referral_handoff(uuid, uuid, uuid, text, text, text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.transition_referral_handoff(uuid, integer, text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.revoke_referral_handoff(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.apply_referral_handoff_transition(uuid, integer, text, text, uuid)', 'EXECUTE'),
  'a practice creates, advances and revokes its own; the shared step runs only inside them'
);
SELECT ok(
  has_function_privilege('anon', 'public.public_referral_handoff_resolve(text)', 'EXECUTE')
  AND has_function_privilege('anon', 'public.public_referral_handoff_transition(text, integer, text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.apply_referral_handoff_transition(uuid, integer, text, text, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.create_referral_handoff(uuid, uuid, uuid, text, text, text)', 'EXECUTE')
  AND NOT has_table_privilege('anon', 'public.referral_handoffs', 'SELECT'),
  'the signed-out page holds the token calls only: nothing else about handoffs'
);
SET LOCAL ROLE anon;
SELECT is((SELECT count(*)::integer FROM public.public_referral_handoff_resolve('0000')), 0, 'signed out, a wrong token shows nothing');
SELECT is((SELECT status FROM public.public_referral_handoff_resolve(current_setting('test.j_token'))), 'consult_scheduled', 'and the right one shows the status');
RESET ROLE;
SELECT ok(
  has_table_privilege('authenticated', 'public.referral_handoffs', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.referral_handoffs', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.referral_handoffs', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.referral_handoff_events', 'DELETE')
  AND NOT has_table_privilege('authenticated', 'public.referral_handoff_events', 'TRUNCATE'),
  'clients read handoffs; every change goes through the functions'
);
SELECT is(
  (SELECT string_agg(conname || ':' || condeferrable::text, ',' ORDER BY conname) FROM pg_constraint
    WHERE conrelid IN ('public.referral_handoffs'::regclass, 'public.referral_handoff_events'::regclass) AND contype = 'f'
      AND conname <> 'referral_handoff_events_actor_id_fkey'),
  'referral_handoff_events_handoff_org_fk:true,referral_handoffs_case_org_fk:true,referral_handoffs_org_id_fkey:false,referral_handoffs_owner_id_fkey:false,referral_handoffs_partner_org_fk:true,referral_handoffs_referral_org_fk:true',
  'the workspace keys defer like the other tables'' (a join moves them together)'
);
SELECT ok(
  pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'follow_ups_kind_check')) LIKE '%referral_handshake%'
  AND pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'follow_ups_kind_check')) LIKE '%check_in%',
  'the follow-up kinds keep check-ins and have the handoff''s again'
);

SELECT * FROM finish();
ROLLBACK;
