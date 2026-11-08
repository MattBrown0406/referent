-- Focused coverage for 20261108140000_program_referrals.sql (a treatment
-- program refers a family to an interventionist). Run after a local
-- migration reset with: supabase test db
--
-- This file is never pasted into production.

BEGIN;
SELECT plan(59);

-- Actors
--   c1  center account of the live program listing L1 (Juniper Ridge Recovery)
--   c2  center account of the archived program listing L2
--   c3  center account of another live program L3
--   p1  owner of practice P, whose profile I1 is live (Cascade Interventions)
--   p2  member of practice P
--   q1  owner of practice Q, profile I2, not taking program referrals
--   u1  a signed-in user who is not a program
--   I3  an interventionist listing no workspace has claimed
INSERT INTO auth.users (id, email)
VALUES
  ('c1000000-0000-0000-0000-0000000000b8', 'preferral-c1@example.test'),
  ('c2000000-0000-0000-0000-0000000000b8', 'preferral-c2@example.test'),
  ('c3000000-0000-0000-0000-0000000000b8', 'preferral-c3@example.test'),
  ('b1000000-0000-0000-0000-0000000000b8', 'preferral-p1@example.test'),
  ('b2000000-0000-0000-0000-0000000000b8', 'preferral-p2@example.test'),
  ('b3000000-0000-0000-0000-0000000000b8', 'preferral-q1@example.test'),
  ('b4000000-0000-0000-0000-0000000000b8', 'preferral-u1@example.test');

SELECT set_config('test.org_p', org_id::text, true) FROM public.org_members WHERE user_id = 'b1000000-0000-0000-0000-0000000000b8';
SELECT set_config('test.org_q', org_id::text, true) FROM public.org_members WHERE user_id = 'b3000000-0000-0000-0000-0000000000b8';
UPDATE public.org_members SET org_id = current_setting('test.org_p')::uuid, role = 'member', display_name = 'Mikayla'
 WHERE user_id = 'b2000000-0000-0000-0000-0000000000b8';
UPDATE public.orgs SET name = 'Cascade Interventions' WHERE id = current_setting('test.org_p')::uuid;
UPDATE public.orgs SET name = 'Harbor Family Services', accepts_program_referrals = false
 WHERE id = current_setting('test.org_q')::uuid;

INSERT INTO public.global_partners (id, name, organization, types, city, state, status, verified_at, owner_org_id)
VALUES
  ('d1000000-0000-0000-0000-0000000000b8', 'Admissions', 'Juniper Ridge Recovery', ARRAY['Inpatient'], 'Bend', 'OR', 'active', now(), NULL),
  ('d2000000-0000-0000-0000-0000000000b8', 'Intake', 'Closed Pines', ARRAY['Inpatient'], 'Salem', 'OR', 'archived', now(), NULL),
  ('d3000000-0000-0000-0000-0000000000b8', 'Intake', 'Second Program', ARRAY['Detox'], 'Eugene', 'OR', 'active', now(), NULL),
  ('d5000000-0000-0000-0000-0000000000b8', 'Dana Cole', 'Cascade Interventions', ARRAY['Interventionist'], 'Portland', 'OR', 'active', now(),
   current_setting('test.org_p')::uuid),
  ('d6000000-0000-0000-0000-0000000000b8', 'Quinn Hale', 'Harbor Family Services', ARRAY['Interventionist'], 'Seattle', 'WA', 'active', now(),
   current_setting('test.org_q')::uuid),
  ('d7000000-0000-0000-0000-0000000000b8', 'Sam Reyes', 'Unclaimed Cascade Recovery Coaching', ARRAY['Interventionist'], 'Portland', 'OR',
   'active', now(), NULL);
INSERT INTO public.center_members (user_id, global_partner_id)
VALUES
  ('c1000000-0000-0000-0000-0000000000b8', 'd1000000-0000-0000-0000-0000000000b8'),
  ('c2000000-0000-0000-0000-0000000000b8', 'd2000000-0000-0000-0000-0000000000b8'),
  ('c3000000-0000-0000-0000-0000000000b8', 'd3000000-0000-0000-0000-0000000000b8');

-- Practice P's members have push on with a device each.
INSERT INTO public.notification_preferences (user_id, push_enabled)
VALUES ('b1000000-0000-0000-0000-0000000000b8', true), ('b2000000-0000-0000-0000-0000000000b8', true);
INSERT INTO public.push_tokens (expo_push_token, user_id, platform)
VALUES ('ExponentPushToken[preferral00000001]', 'b1000000-0000-0000-0000-0000000000b8', 'ios'),
       ('ExponentPushToken[preferral00000002]', 'b2000000-0000-0000-0000-0000000000b8', 'ios');

-- Practice P's program partners: one with an organization, one with only a
-- person's name (the destination must never show it).
INSERT INTO public.partners (id, owner_id, name, organization, state)
VALUES ('e1000000-0000-0000-0000-0000000000b8', 'b1000000-0000-0000-0000-0000000000b8', 'Intake', 'Harbor Ridge Treatment', 'OR'),
       ('e2000000-0000-0000-0000-0000000000b8', 'b1000000-0000-0000-0000-0000000000b8', 'Pat Doe', '', 'OR');

-- ===========================================================================
-- A. Schema and grants
-- ===========================================================================

SELECT has_table('public', 'program_referrals', 'program_referrals exists');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.program_referrals'::regclass), 'RLS is on');
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.program_referrals', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.program_referrals', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.program_referrals', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.program_referrals', 'DELETE')
  AND NOT has_table_privilege('authenticated', 'public.program_referrals', 'TRUNCATE')
  AND NOT has_table_privilege('anon', 'public.program_referrals', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.program_referrals', 'INSERT')
  AND NOT has_table_privilege('service_role', 'public.program_referrals', 'TRUNCATE'),
  'no client role reads or writes the table directly, and nobody truncates it'
);
SELECT ok(
  (SELECT bool_and(p.prosecdef AND p.proconfig @> ARRAY['search_path=public'])
     FROM pg_proc p
    WHERE p.oid IN ('public.program_referral_targets(text, text)'::regprocedure,
                    'public.program_refer_family(uuid, text, text, text, text, text, text, text, boolean)'::regprocedure,
                    'public.list_program_referrals()'::regprocedure,
                    'public.program_referral_stats()'::regprocedure,
                    'public.case_program_referral(uuid)'::regprocedure,
                    'public.set_program_referral_sharing(uuid, boolean)'::regprocedure,
                    'public.program_referral_settings()'::regprocedure,
                    'public.set_accepts_program_referrals(boolean)'::regprocedure)),
  'every RPC is SECURITY DEFINER with a pinned search_path'
);
SELECT ok(
  (SELECT bool_and(has_function_privilege('authenticated', f, 'EXECUTE') AND NOT has_function_privilege('anon', f, 'EXECUTE'))
     FROM unnest(ARRAY['public.program_referral_targets(text, text)',
                       'public.program_refer_family(uuid, text, text, text, text, text, text, text, boolean)',
                       'public.list_program_referrals()', 'public.program_referral_stats()',
                       'public.case_program_referral(uuid)', 'public.set_program_referral_sharing(uuid, boolean)',
                       'public.program_referral_settings()', 'public.set_accepts_program_referrals(boolean)']) AS f),
  'signed-in users may call the RPCs; anon may not'
);
SELECT ok(
  (SELECT bool_and(NOT has_function_privilege('authenticated', f, 'EXECUTE') AND NOT has_function_privilege('anon', f, 'EXECUTE'))
     FROM unnest(ARRAY['public.program_referral_rows(uuid)', 'public.program_referral_lead(uuid, uuid, text, jsonb)',
                       'public.program_referral_milestones(uuid)', 'public.program_referral_destination(uuid)',
                       'public.program_referral_receive_status(uuid)', 'public.program_referral_caller_listing()',
                       'public.create_lead_internal(uuid, uuid, jsonb, text)']) AS f),
  'the helpers are not callable by clients'
);
SELECT ok(
  pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'cases_lead_channel_check')) LIKE '%program_referral%',
  'cases accept the program_referral lead channel'
);

-- ===========================================================================
-- B. Finding an interventionist
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'b4000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT * FROM public.program_referral_targets('cascade', NULL) $$, '42501', NULL,
  'a user who is not a program cannot search');
SELECT throws_ok($$ SELECT * FROM public.list_program_referrals() $$, '42501', NULL, 'nor list referrals');
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT results_eq(
  $$ SELECT display_name, receive_status FROM public.program_referral_targets('cascade', NULL) $$,
  $$ VALUES ('Cascade Interventions'::text, 'ready'::text), ('Unclaimed Cascade Recovery Coaching'::text, 'not_on_referralfit'::text) $$,
  'a name search returns professionals, the ones who can receive first'
);
SELECT results_eq(
  $$ SELECT display_name, receive_status FROM public.program_referral_targets('', 'wa') $$,
  $$ VALUES ('Harbor Family Services'::text, 'not_taking'::text) $$,
  'a state search shows a practice that is not taking program referrals as such'
);
SELECT is(
  (SELECT count(*)::integer FROM public.program_referral_targets('', 'OR')
    WHERE display_name IN ('Juniper Ridge Recovery', 'Second Program', 'Closed Pines')),
  0,
  'programs (including the caller) are never offered as recipients'
);
SELECT is((SELECT count(*)::integer FROM public.program_referral_targets('c', NULL)), 0, 'a one-letter search returns nothing');

-- ===========================================================================
-- C. Referring a family
-- ===========================================================================

SELECT throws_ok(
  $$ SELECT public.program_refer_family('d5000000-0000-0000-0000-0000000000b8', 'Maria', '(503) 555-0101', '', 'mother',
                                        'Alex', 'none', '', false) $$,
  '22023', 'Confirm that the family asked you to share their details with this interventionist.',
  'no referral without the family''s consent'
);
SELECT throws_ok(
  $$ SELECT public.program_refer_family('d7000000-0000-0000-0000-0000000000b8', 'Maria', '(503) 555-0101', '', 'mother',
                                        'Alex', 'none', '', true) $$,
  'P0002', 'This interventionist is not on ReferralFit yet. Contact them directly.',
  'an unclaimed listing cannot receive'
);
SELECT throws_ok(
  $$ SELECT public.program_refer_family('d6000000-0000-0000-0000-0000000000b8', 'Maria', '(503) 555-0101', '', 'mother',
                                        'Alex', 'none', '', true) $$,
  '22023', 'This practice is not taking referrals through ReferralFit right now. Contact them directly.',
  'a practice that switched program referrals off is refused, neutrally'
);
SELECT throws_ok(
  $$ SELECT public.program_refer_family('d1000000-0000-0000-0000-0000000000b8', 'Maria', '(503) 555-0101', '', 'mother',
                                        'Alex', 'none', '', true) $$,
  'P0002', NULL,
  'a program cannot be referred to'
);
SELECT throws_ok(
  $$ SELECT public.program_refer_family('d5000000-0000-0000-0000-0000000000b8', 'Maria', '555-01', '', 'mother',
                                        'Alex', 'none', '', true) $$,
  '22023', 'A phone number with at least 10 digits is required',
  'the family''s details are checked like an intake lead'
);
SELECT lives_ok(
  $$ SELECT set_config('test.ref1', public.program_refer_family('d5000000-0000-0000-0000-0000000000b8', ' Maria ',
       '(503) 555-0101', 'maria@example.test', 'mother', 'Alex', 'none', 'Called us Tuesday; not ready for residential yet.', true)::text, true) $$,
  'a program refers a family to a practice on ReferralFit'
);
SELECT is(
  public.program_refer_family('d5000000-0000-0000-0000-0000000000b8', 'Maria', '503.555.0101', '', 'mother', 'Alex', 'none', '', true)::text,
  current_setting('test.ref1'),
  'a second tap for the same family returns the same referral'
);
RESET ROLE;

SELECT set_config('test.case1', case_id::text, true) FROM public.program_referrals WHERE id = current_setting('test.ref1')::uuid;
SELECT is(
  (SELECT count(*)::integer FROM public.program_referrals WHERE from_global_partner_id = 'd1000000-0000-0000-0000-0000000000b8'),
  1,
  'the second tap made no second referral'
);
SELECT ok(
  (SELECT org_id = current_setting('test.org_p')::uuid AND owner_id = 'b1000000-0000-0000-0000-0000000000b8'
          AND lead_channel = 'program_referral' AND lead_captured_at IS NOT NULL AND status = 'inquiry'
          AND lead_source = 'Professional referral' AND lead_source_detail = 'Juniper Ridge Recovery'
          AND position('Referred by Juniper Ridge Recovery through ReferralFit.' IN summary) > 0
          AND position('Their note: Called us Tuesday' IN summary) > 0
     FROM public.cases WHERE id = current_setting('test.case1')::uuid),
  'the lead lands in the practice as an ordinary lead, owned by its owner, with the program as its source'
);
SELECT is(
  (SELECT count(*)::integer FROM public.follow_ups
    WHERE case_id = current_setting('test.case1')::uuid AND kind = 'first_call' AND status = 'open'),
  1,
  'the lead has its first-call follow-up'
);
SELECT ok(
  (SELECT body = 'New lead referred by Juniper Ridge Recovery through ReferralFit' AND actor_id IS NULL
     FROM public.case_events WHERE case_id = current_setting('test.case1')::uuid AND kind = 'system'),
  'the timeline says who referred it, with no program account as its author'
);
SELECT is(
  (SELECT count(*)::integer FROM public.case_contacts
    WHERE case_id = current_setting('test.case1')::uuid AND is_primary AND name = 'Maria' AND email = 'maria@example.test'),
  1,
  'the family member is the case''s primary contact'
);
SELECT is(
  (SELECT array_agg(user_id::text ORDER BY user_id::text) FROM public.notification_outbox
    WHERE kind = 'new_lead' AND data ->> 'case_id' = current_setting('test.case1')),
  ARRAY['b1000000-0000-0000-0000-0000000000b8', 'b2000000-0000-0000-0000-0000000000b8'],
  'every member of the practice gets the new-lead push'
);
SELECT ok(
  (SELECT family_label = 'Maria (mother)' AND consent_attested_at IS NOT NULL AND share_progress
          AND from_user_id = 'c1000000-0000-0000-0000-0000000000b8' AND to_org_id = current_setting('test.org_p')::uuid
     FROM public.program_referrals WHERE id = current_setting('test.ref1')::uuid),
  'the referral records the label the program typed, the consent, and sharing on by default'
);

SELECT set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.program_refer_family('d5000000-0000-0000-0000-0000000000b8', 'Lee', '(503) 555-0199', '', '', '', 'none', '', true) $$,
  '42501', NULL,
  'a program whose listing is not live cannot refer'
);
RESET ROLE;

-- ===========================================================================
-- D. Milestones the program sees
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (SELECT milestone = 'received' AND shared AND reached_at IS NULL AND NOT consult AND NOT entered_treatment AND placed_with IS NULL
     FROM public.list_program_referrals() WHERE id = current_setting('test.ref1')::uuid),
  'a new referral reads received'
);
SELECT is(
  (SELECT array_agg(k ORDER BY k) FROM (SELECT jsonb_object_keys(to_jsonb(l)) AS k FROM public.list_program_referrals() l LIMIT 13) x),
  ARRAY['consult', 'created_at', 'entered_treatment', 'family_label', 'id', 'intervention', 'milestone', 'minutes_to_reach',
        'placed_with', 'reached_at', 'shared', 'to_display', 'to_global_partner_id'],
  'the program''s list carries milestones only: no case, title, contact, note, insurance or cost'
);
RESET ROLE;

UPDATE public.cases SET first_touch_at = created_at + interval '30 minutes' WHERE id = current_setting('test.case1')::uuid;
SET LOCAL ROLE authenticated;
SELECT ok(
  (SELECT milestone = 'family_reached' AND minutes_to_reach = 30 FROM public.list_program_referrals()
    WHERE id = current_setting('test.ref1')::uuid),
  'a first call reads family reached, with the time it took'
);
RESET ROLE;

UPDATE public.cases SET status = 'consult' WHERE id = current_setting('test.case1')::uuid;
SET LOCAL ROLE authenticated;
SELECT is((SELECT milestone FROM public.list_program_referrals() WHERE id = current_setting('test.ref1')::uuid), 'consult', 'a consult reads consult');
RESET ROLE;

UPDATE public.cases SET status = 'intervention' WHERE id = current_setting('test.case1')::uuid;
SET LOCAL ROLE authenticated;
SELECT ok(
  (SELECT milestone = 'intervention' AND consult AND intervention AND NOT entered_treatment AND placed_with IS NULL
     FROM public.list_program_referrals() WHERE id = current_setting('test.ref1')::uuid),
  'an intervention reads intervention, and the consult before it still counts'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', '', true);
INSERT INTO public.referrals (owner_id, partner_id, direction, case_id, admitted, admitted_on)
VALUES ('b1000000-0000-0000-0000-0000000000b8', 'e1000000-0000-0000-0000-0000000000b8', 'outbound',
        current_setting('test.case1')::uuid, true, CURRENT_DATE);
UPDATE public.cases SET status = 'placed' WHERE id = current_setting('test.case1')::uuid;
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (SELECT milestone = 'entered_treatment' AND entered_treatment AND placed_with = 'Harbor Ridge Treatment'
     FROM public.list_program_referrals() WHERE id = current_setting('test.ref1')::uuid),
  'an admission reads entered treatment, with the program the client entered'
);
RESET ROLE;

UPDATE public.cases SET status = 'closed' WHERE id = current_setting('test.case1')::uuid;
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT milestone FROM public.list_program_referrals() WHERE id = current_setting('test.ref1')::uuid),
  'entered_treatment',
  'closing the case after an admission still reads entered treatment'
);

-- Three more referrals: one lost, one whose case is removed, one admitted to
-- a partner known only by a person's name.
SELECT set_config('test.ref2', public.program_refer_family('d5000000-0000-0000-0000-0000000000b8', 'Lee', '(503) 555-0102', '', 'father',
  '', 'none', '', true)::text, true);
SELECT set_config('test.ref3', public.program_refer_family('d5000000-0000-0000-0000-0000000000b8', 'Kim', '(503) 555-0103', '', 'sister',
  '', 'none', '', true)::text, true);
SELECT set_config('test.ref4', public.program_refer_family('d5000000-0000-0000-0000-0000000000b8', 'Ari', '(503) 555-0104', '', 'spouse',
  '', 'immediate_danger', '', true)::text, true);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', '', true);
UPDATE public.cases c SET first_touch_at = c.created_at + interval '60 minutes', status = 'lost'
  FROM public.program_referrals pr WHERE pr.id = current_setting('test.ref2')::uuid AND c.id = pr.case_id;
UPDATE public.program_referrals SET case_id = NULL WHERE id = current_setting('test.ref3')::uuid;
INSERT INTO public.referrals (owner_id, partner_id, direction, case_id, admitted, admitted_on)
SELECT 'b1000000-0000-0000-0000-0000000000b8', 'e2000000-0000-0000-0000-0000000000b8', 'outbound', pr.case_id, true, CURRENT_DATE
  FROM public.program_referrals pr WHERE pr.id = current_setting('test.ref4')::uuid;
UPDATE public.cases c SET first_touch_at = c.created_at + interval '1500 minutes', status = 'placed'
  FROM public.program_referrals pr WHERE pr.id = current_setting('test.ref4')::uuid AND c.id = pr.case_id;

SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT milestone FROM public.list_program_referrals() WHERE id = current_setting('test.ref2')::uuid),
  'not_proceeding', 'a lost case reads not proceeding');
SELECT ok(
  (SELECT milestone = 'closed' AND NOT shared AND placed_with IS NULL FROM public.list_program_referrals()
    WHERE id = current_setting('test.ref3')::uuid),
  'a referral whose case was removed reads closed, with nothing else'
);
SELECT is(
  (SELECT placed_with FROM public.list_program_referrals() WHERE id = current_setting('test.ref4')::uuid),
  'a treatment program',
  'a destination known only by a person''s name never shows that name'
);
RESET ROLE;
SELECT ok(
  (SELECT lead_urgency = 'immediate_danger' AND summary LIKE 'Caller reported immediate danger%'
     FROM public.cases c JOIN public.program_referrals pr ON pr.case_id = c.id WHERE pr.id = current_setting('test.ref4')::uuid),
  'urgency carries over to the lead'
);

-- ===========================================================================
-- E. The practice's switch for one referral
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'b3000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  format('SELECT public.set_program_referral_sharing(%L, false)', current_setting('test.ref1')),
  'P0002', NULL,
  'another practice cannot change the sharing'
);
SELECT is((SELECT count(*)::integer FROM public.case_program_referral(current_setting('test.case1')::uuid)), 0,
  'nor see the referral behind the case');
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (SELECT from_display = 'Juniper Ridge Recovery' AND share_progress
     FROM public.case_program_referral(current_setting('test.case1')::uuid)),
  'a member of the practice sees which program referred the case'
);
SELECT is(public.set_program_referral_sharing(current_setting('test.ref1')::uuid, false), false, 'a member turns sharing off');
RESET ROLE;
SELECT is(
  (SELECT count(*)::integer FROM public.case_events
    WHERE case_id = current_setting('test.case1')::uuid AND body = 'Stopped sharing progress with Juniper Ridge Recovery'
      AND actor_id = 'b2000000-0000-0000-0000-0000000000b8'),
  1,
  'the change is on the case timeline'
);

SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (SELECT milestone = 'not_shared' AND NOT shared AND reached_at IS NULL AND minutes_to_reach IS NULL AND consult IS NULL
          AND entered_treatment IS NULL AND placed_with IS NULL
     FROM public.list_program_referrals() WHERE id = current_setting('test.ref1')::uuid),
  'with sharing off the program sees only that it sent the referral: no milestone, no destination'
);

-- ===========================================================================
-- F. The program's track record
-- ===========================================================================

-- Sent 4: ref1 (sharing off), ref2 (lost, reached in 60 min), ref3 (case
-- removed), ref4 (admitted, reached in 1500 min). Shared: ref2 and ref4.
SELECT results_eq(
  $$ SELECT to_display, sent, shared, reached_within_24h, median_minutes_to_reach, consult_or_intervention, entered_treatment
       FROM public.program_referral_stats() $$,
  $$ VALUES ('Cascade Interventions'::text, 4, 2, 1, 780, 1, 1) $$,
  'the track record counts only shared referrals for its rates'
);
SELECT is(
  (SELECT array_agg(k ORDER BY k) FROM (SELECT jsonb_object_keys(to_jsonb(s)) AS k FROM public.program_referral_stats() s) x),
  ARRAY['consult_or_intervention', 'entered_treatment', 'last_referred_at', 'median_minutes_to_reach', 'reached_within_24h',
        'sent', 'shared', 'to_display', 'to_global_partner_id'],
  'the track record has no destination column: no count of where clients went'
);
SELECT ok(
  NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proargnames) AS a
               WHERE p.oid = 'public.program_referral_stats()'::regprocedure AND (a LIKE '%placed%' OR a LIKE '%return%')),
  'nor any placed or returned measure'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', 'c3000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.list_program_referrals()), 0, 'another program sees none of these referrals');
SELECT is((SELECT count(*)::integer FROM public.program_referral_stats()), 0, 'nor their track record');
RESET ROLE;

-- ===========================================================================
-- G. The practice's switch for program referrals
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT results_eq($$ SELECT accepts, can_change, has_profile FROM public.program_referral_settings() $$,
  $$ VALUES (true, true, true) $$, 'the owner sees the switch on and may change it');
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT results_eq($$ SELECT accepts, can_change FROM public.program_referral_settings() $$,
  $$ VALUES (true, false) $$, 'a member sees it but may not change it');
SELECT throws_ok($$ SELECT public.set_accepts_program_referrals(false) $$, '42501', NULL, 'a member cannot switch it off');
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT is(public.set_accepts_program_referrals(false), false, 'the owner switches program referrals off');
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.program_refer_family('d5000000-0000-0000-0000-0000000000b8', 'Bo', '(503) 555-0105', '', '', '', 'none', '', true) $$,
  '22023', 'This practice is not taking referrals through ReferralFit right now. Contact them directly.',
  'then programs are refused, neutrally'
);
RESET ROLE;

-- ===========================================================================
-- H. The cap: 30 referrals per program in any 24 hours
-- ===========================================================================

UPDATE public.orgs SET accepts_program_referrals = true WHERE id = current_setting('test.org_p')::uuid;
INSERT INTO public.program_referrals (from_global_partner_id, from_display, to_org_id, to_display, consent_attested_at)
SELECT 'd1000000-0000-0000-0000-0000000000b8', 'Juniper Ridge Recovery', current_setting('test.org_p')::uuid, 'Cascade Interventions', now()
  FROM generate_series(1, 26);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.program_refer_family('d5000000-0000-0000-0000-0000000000b8', 'Bo', '(503) 555-0105', '', '', '', 'none', '', true) $$,
  '22023', 'Your program sent 30 referrals in the last 24 hours. Try again later, or call the practice directly.',
  'the 31st referral in a day is refused'
);
RESET ROLE;

-- ===========================================================================
-- I. Existing lead paths are unchanged
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', '', true);
SELECT throws_ok(
  $$ SELECT public.create_lead_internal(current_setting('test.org_p')::uuid, 'b1000000-0000-0000-0000-0000000000b8',
       '{"caller_name": "X", "phone": "5035550111"}'::jsonb, 'web') $$,
  '22023', 'Unknown lead channel',
  'an unknown channel is still refused'
);
SELECT set_config('test.intake_case', public.create_lead_internal(current_setting('test.org_p')::uuid,
  'b1000000-0000-0000-0000-0000000000b8', '{"caller_name": "Intake Person", "phone": "5035550112"}'::jsonb, 'intake_link')::text, true);
SELECT ok(
  (SELECT body = 'New lead arrived through the intake link'
     FROM public.case_events WHERE case_id = current_setting('test.intake_case')::uuid AND kind = 'system'),
  'the intake link''s lead reads as before'
);
SELECT is(
  (SELECT count(*)::integer FROM public.program_referrals WHERE case_id IS NOT NULL AND to_org_id = current_setting('test.org_q')::uuid),
  0,
  'nothing reached the practice that switched referrals off'
);

SELECT * FROM finish();
ROLLBACK;
