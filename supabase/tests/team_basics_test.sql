-- Focused coverage for 20261001140000_team_basics.sql.
-- Run after a local migration reset with: supabase test db
--
-- This file is never pasted into production.

BEGIN;
SELECT plan(51);

-- Actors
--   a1  owner of practice A         workspace A
--   a2  member of practice A        workspace A (moved in below)
--   b1  owner of practice B         workspace B
--   s1  platform admin              own workspace
INSERT INTO auth.users (id, email)
VALUES
  ('a1000000-0000-0000-0000-0000000000e5', 'team-a1@example.test'),
  ('a2000000-0000-0000-0000-0000000000e5', 'team-a2@example.test'),
  ('b1000000-0000-0000-0000-0000000000e5', 'team-b1@example.test'),
  ('51000000-0000-0000-0000-0000000000e5', 'team-admin@example.test');

INSERT INTO public.platform_admins (user_id) VALUES ('51000000-0000-0000-0000-0000000000e5');

SELECT set_config('test.org_a', org_id::text, true) FROM public.org_members WHERE user_id = 'a1000000-0000-0000-0000-0000000000e5';
SELECT set_config('test.org_b', org_id::text, true) FROM public.org_members WHERE user_id = 'b1000000-0000-0000-0000-0000000000e5';
UPDATE public.org_members SET org_id = current_setting('test.org_a')::uuid, role = 'member', display_name = 'Mikayla'
 WHERE user_id = 'a2000000-0000-0000-0000-0000000000e5';
UPDATE public.org_members SET display_name = 'Matt' WHERE user_id = 'a1000000-0000-0000-0000-0000000000e5';

-- ===========================================================================
-- A. Schema
-- ===========================================================================

SELECT has_column('public', 'cases', 'assigned_to', 'cases.assigned_to exists');
SELECT has_column('public', 'follow_ups', 'assigned_to', 'follow_ups.assigned_to exists');
SELECT has_column('public', 'case_events', 'actor_id', 'case_events.actor_id exists');
SELECT has_column('public', 'follow_ups', 'completed_by', 'follow_ups.completed_by exists');
SELECT has_table('public', 'push_tokens', 'push_tokens exists');
SELECT has_table('public', 'notification_preferences', 'notification_preferences exists');
SELECT has_table('public', 'notification_outbox', 'notification_outbox exists');

-- ===========================================================================
-- B. Assignment: visible to the org, invisible across orgs, members only
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000e5', true);
SET LOCAL ROLE authenticated;

INSERT INTO public.cases (id, title) VALUES ('a1100000-0000-0000-0000-0000000000e5', 'Henderson family');
INSERT INTO public.follow_ups (id, case_id, title, due_on, kind)
VALUES ('a1300000-0000-0000-0000-0000000000e5', 'a1100000-0000-0000-0000-0000000000e5', 'Call back', CURRENT_DATE, 'follow_up');

SELECT throws_ok(
  $$ UPDATE public.cases SET assigned_to = 'b1000000-0000-0000-0000-0000000000e5' WHERE id = 'a1100000-0000-0000-0000-0000000000e5' $$,
  '22023',
  'The assignee must be a member of this workspace',
  'a case cannot be assigned to someone outside the workspace'
);

SELECT lives_ok(
  $$ UPDATE public.follow_ups SET assigned_to = 'a2000000-0000-0000-0000-0000000000e5' WHERE id = 'a1300000-0000-0000-0000-0000000000e5' $$,
  'a follow-up can be assigned to a workspace member'
);

SELECT is(
  (SELECT (event_body, occurred_at IS NOT NULL)::text FROM public.assign_case('a1100000-0000-0000-0000-0000000000e5', 'a2000000-0000-0000-0000-0000000000e5', 'a1400000-0000-0000-0000-0000000000e5')),
  '("Assigned to Mikayla",t)',
  'assign_case assigns and names the teammate in the timeline entry'
);

SELECT is(
  (SELECT (assigned_to::text, actor_id::text)::text
     FROM public.cases c JOIN public.case_events e ON e.id = 'a1400000-0000-0000-0000-0000000000e5'
    WHERE c.id = 'a1100000-0000-0000-0000-0000000000e5'),
  ('a2000000-0000-0000-0000-0000000000e5', 'a1000000-0000-0000-0000-0000000000e5')::text,
  'the case carries the assignee and the entry carries the member who assigned'
);

SELECT is(
  (SELECT event_body FROM public.assign_case('a1100000-0000-0000-0000-0000000000e5', 'a1000000-0000-0000-0000-0000000000e5', NULL)),
  'Took this case',
  'assigning a case to yourself reads as taking it'
);

SELECT is(
  (SELECT event_body FROM public.assign_case('a1100000-0000-0000-0000-0000000000e5', NULL, NULL)),
  'Unassigned',
  'clearing the assignee is recorded too'
);

-- The teammate sees the assignment; the other practice sees nothing.
SELECT set_config('request.jwt.claim.sub', 'a2000000-0000-0000-0000-0000000000e5', true);

SELECT is(
  (SELECT assigned_to::text FROM public.follow_ups WHERE id = 'a1300000-0000-0000-0000-0000000000e5'),
  'a2000000-0000-0000-0000-0000000000e5',
  'a teammate in the same workspace reads the assignment'
);

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000e5', true);

SELECT is(
  (SELECT count(*)::integer FROM public.follow_ups WHERE assigned_to = 'a2000000-0000-0000-0000-0000000000e5'),
  0,
  'another practice cannot see assignments that are not theirs'
);

SELECT throws_ok(
  $$ SELECT * FROM public.assign_case('a1100000-0000-0000-0000-0000000000e5', 'b1000000-0000-0000-0000-0000000000e5', NULL) $$,
  'P0002',
  'Case not found',
  'assign_case refuses a case outside the caller''s workspace'
);

-- ===========================================================================
-- C. Who did what: actor and completed_by are server-stamped
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000e5', true);

INSERT INTO public.case_events (id, case_id, kind, body, actor_id)
VALUES ('a1500000-0000-0000-0000-0000000000e5', 'a1100000-0000-0000-0000-0000000000e5', 'note', 'Spoof attempt', 'a2000000-0000-0000-0000-0000000000e5');

SELECT is(
  (SELECT actor_id::text FROM public.case_events WHERE id = 'a1500000-0000-0000-0000-0000000000e5'),
  'a1000000-0000-0000-0000-0000000000e5',
  'the actor is the signed-in member, whatever the client sent'
);

SELECT throws_ok(
  $$ UPDATE public.case_events SET actor_id = 'a2000000-0000-0000-0000-0000000000e5' WHERE id = 'a1500000-0000-0000-0000-0000000000e5' $$,
  '42501',
  'The actor of a timeline entry cannot be changed',
  'the actor of an entry cannot be rewritten'
);

SELECT set_config('request.jwt.claim.sub', 'a2000000-0000-0000-0000-0000000000e5', true);

UPDATE public.follow_ups SET status = 'done', completed_at = now(), completed_by = 'a1000000-0000-0000-0000-0000000000e5'
 WHERE id = 'a1300000-0000-0000-0000-0000000000e5';

SELECT is(
  (SELECT completed_by::text FROM public.follow_ups WHERE id = 'a1300000-0000-0000-0000-0000000000e5'),
  'a2000000-0000-0000-0000-0000000000e5',
  'completing a follow-up records the member who completed it'
);

UPDATE public.follow_ups SET status = 'open', completed_at = NULL WHERE id = 'a1300000-0000-0000-0000-0000000000e5';

SELECT is(
  (SELECT completed_by FROM public.follow_ups WHERE id = 'a1300000-0000-0000-0000-0000000000e5'),
  NULL,
  'reopening clears completed_by'
);

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

SELECT is(
  (SELECT count(*)::integer FROM public.case_events WHERE actor_id IS NULL AND owner_id IS NOT NULL),
  0,
  'every entry with an owner carries an actor (backfill and trigger)'
);

-- ===========================================================================
-- D. Push tokens: only through the RPCs, only your own
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000e5', true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$ INSERT INTO public.push_tokens (expo_push_token, user_id, platform)
     VALUES ('ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]', 'a1000000-0000-0000-0000-0000000000e5', 'ios') $$,
  '42501',
  NULL,
  'a client cannot insert push tokens directly'
);

SELECT lives_ok(
  $$ SELECT public.register_push_token('ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]', 'ios', -420) $$,
  'a member registers a device through the RPC'
);

SELECT throws_ok(
  $$ SELECT public.register_push_token('not-a-token', 'ios', NULL) $$,
  '23514',
  NULL,
  'a malformed token is refused'
);

INSERT INTO public.notification_preferences (user_id, push_enabled) VALUES ('a1000000-0000-0000-0000-0000000000e5', true);

SELECT throws_ok(
  $$ INSERT INTO public.notification_preferences (user_id, push_enabled) VALUES ('a2000000-0000-0000-0000-0000000000e5', true) $$,
  '42501',
  NULL,
  'a member cannot write another member''s preferences'
);

SELECT throws_ok(
  $$ SELECT count(*) FROM public.notification_outbox $$,
  '42501',
  NULL,
  'no client role can read the outbox'
);

SELECT set_config('request.jwt.claim.sub', 'a2000000-0000-0000-0000-0000000000e5', true);

SELECT is(
  (SELECT count(*)::integer FROM public.push_tokens),
  0,
  'a member sees no one else''s device tokens'
);

SELECT lives_ok(
  $$ SELECT public.register_push_token('ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]', 'ios', -420) $$,
  'registering the same device under another account moves it'
);

SELECT is(
  (SELECT user_id::text FROM public.push_tokens WHERE expo_push_token = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]'),
  'a2000000-0000-0000-0000-0000000000e5',
  'the token now belongs to the account that registered it last'
);

SELECT lives_ok(
  $$ SELECT public.unregister_push_token('ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]') $$,
  'sign-out unregisters the device'
);

SELECT is((SELECT count(*)::integer FROM public.push_tokens), 0, 'the token is gone after unregistering');

-- Both practice A members and the admin end up with push on and a device.
SELECT public.register_push_token('ExponentPushToken[a2a2a2a2a2a2a2a2a2a2a2]', 'ios', -420);
INSERT INTO public.notification_preferences (user_id, push_enabled) VALUES ('a2000000-0000-0000-0000-0000000000e5', true);
SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000e5', true);
SELECT public.register_push_token('ExponentPushToken[a1a1a1a1a1a1a1a1a1a1a1]', 'ios', -420);
SELECT set_config('request.jwt.claim.sub', '51000000-0000-0000-0000-0000000000e5', true);
SELECT public.register_push_token('ExponentPushToken[s1s1s1s1s1s1s1s1s1s1s1]', 'android', -420);
INSERT INTO public.notification_preferences (user_id, push_enabled, directory_submission) VALUES ('51000000-0000-0000-0000-0000000000e5', true, true);
-- b1 asks for the admin kind but is not an admin.
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000e5', true);
SELECT public.register_push_token('ExponentPushToken[b1b1b1b1b1b1b1b1b1b1b1]', 'ios', -420);
INSERT INTO public.notification_preferences (user_id, push_enabled, directory_submission) VALUES ('b1000000-0000-0000-0000-0000000000e5', true, true);

-- ===========================================================================
-- E. Outbox: one row per trigger case, nothing private in title or body
-- ===========================================================================

-- A new lead from a1: a2 hears about it, a1 (who added it) does not.
SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000e5', true);

SELECT lives_ok(
  $$ SELECT public.create_lead('a1000000-0000-0000-0000-0000000000e5', jsonb_build_object(
       'id', 'a1600000-0000-0000-0000-0000000000e5',
       'caller_name', 'Maria Lopez', 'phone', '(541) 555-0142', 'about_relationship', 'son', 'about_first_name', 'Jake',
       'lead_source', 'Website', 'urgency', 'none')) $$,
  'a lead is added in the app'
);

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

SELECT is(
  (SELECT (count(*) FILTER (WHERE user_id = 'a2000000-0000-0000-0000-0000000000e5'), count(*) FILTER (WHERE user_id = 'a1000000-0000-0000-0000-0000000000e5'))::text
     FROM public.notification_outbox WHERE kind = 'new_lead'),
  '(1,0)',
  'a new lead is queued for the teammate, not for the member who added it'
);

SELECT is(
  (SELECT (title, body, data ->> 'case_id')::text FROM public.notification_outbox WHERE kind = 'new_lead'),
  ('New lead waiting', 'A new lead is waiting for its first call.', 'a1600000-0000-0000-0000-0000000000e5')::text,
  'the new-lead push is generic and carries only the case id'
);

-- Assigning the lead's first call to a2 (by a1): assigned_to_me for a2.
SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000e5', true);
SET LOCAL ROLE authenticated;
UPDATE public.follow_ups SET assigned_to = 'a2000000-0000-0000-0000-0000000000e5' WHERE case_id = 'a1600000-0000-0000-0000-0000000000e5';
-- Assigning to yourself queues nothing.
UPDATE public.cases SET assigned_to = 'a1000000-0000-0000-0000-0000000000e5' WHERE id = 'a1600000-0000-0000-0000-0000000000e5';
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

SELECT is(
  (SELECT (count(*), min(user_id::text), min(body))::text FROM public.notification_outbox WHERE kind = 'assigned_to_me'),
  ('1', 'a2000000-0000-0000-0000-0000000000e5', 'A follow-up was assigned to you.')::text,
  'an assignment to someone else queues one generic push for that member only'
);

SELECT is(
  (SELECT count(*)::integer FROM public.notification_outbox
    WHERE title ILIKE '%Maria%' OR body ILIKE '%Maria%' OR title ILIKE '%Lopez%' OR body ILIKE '%Lopez%'
       OR title ILIKE '%Jake%' OR body ILIKE '%Jake%' OR data::text ILIKE '%Maria%' OR data::text ILIKE '%Jake%'),
  0,
  'no caller, family, or case detail appears in any queued push'
);

-- Directory: a pending submission from practice A reaches the admin only.
INSERT INTO public.global_partners (id, name, organization, types, city, state, status, suggested_by_org_id)
VALUES ('a1700000-0000-0000-0000-0000000000e5', 'Admissions', 'Cedar Program', ARRAY['Inpatient'], 'Bend', 'OR', 'pending', current_setting('test.org_a')::uuid);

SELECT is(
  (SELECT (count(*), min(user_id::text))::text FROM public.notification_outbox WHERE kind = 'directory_submission'),
  ('1', '51000000-0000-0000-0000-0000000000e5')::text,
  'a new submission is queued for the platform admin'
);

SELECT is(
  (SELECT count(*)::integer FROM public.notification_outbox WHERE kind = 'directory_submission' AND user_id = 'b1000000-0000-0000-0000-0000000000e5'),
  0,
  'the admin-only kind never reaches a non-admin who asked for it'
);

UPDATE public.global_partners SET status = 'active', verified_at = now() WHERE id = 'a1700000-0000-0000-0000-0000000000e5';

SELECT is(
  (SELECT (count(*), count(*) FILTER (WHERE user_id IN ('a1000000-0000-0000-0000-0000000000e5', 'a2000000-0000-0000-0000-0000000000e5')), min(body), min(data ->> 'decision'))::text
     FROM public.notification_outbox WHERE kind = 'directory_decision'),
  ('2', '2', 'There is a directory decision on one of your submissions.', 'approved')::text,
  'a decision is queued for every member of the submitting practice, with no listing name'
);

-- Overdue reminder at 9 AM local: a2 has one past-due follow-up of her own.
INSERT INTO public.follow_ups (id, owner_id, org_id, case_id, title, due_on, kind, assigned_to)
VALUES ('a1800000-0000-0000-0000-0000000000e5', 'a2000000-0000-0000-0000-0000000000e5', current_setting('test.org_a')::uuid,
        'a1100000-0000-0000-0000-0000000000e5', 'Late call', CURRENT_DATE - 2, 'follow_up', 'a2000000-0000-0000-0000-0000000000e5');
-- Pretend it is 9 AM everywhere for a2 by setting her offset so local hour = 9.
UPDATE public.notification_preferences
   SET tz_offset_minutes = ((9 - extract(hour FROM (now() AT TIME ZONE 'UTC'))::integer + 24) % 24) * 60 - (CASE WHEN ((9 - extract(hour FROM (now() AT TIME ZONE 'UTC'))::integer + 24) % 24) > 14 THEN 1440 ELSE 0 END)
 WHERE user_id = 'a2000000-0000-0000-0000-0000000000e5';
-- a1 is explicitly not at 9 AM: offset places him two hours later.
UPDATE public.notification_preferences
   SET tz_offset_minutes = ((11 - extract(hour FROM (now() AT TIME ZONE 'UTC'))::integer + 24) % 24) * 60 - (CASE WHEN ((11 - extract(hour FROM (now() AT TIME ZONE 'UTC'))::integer + 24) % 24) > 14 THEN 1440 ELSE 0 END)
 WHERE user_id = 'a1000000-0000-0000-0000-0000000000e5';

SELECT is(public.notify_overdue_follow_ups(), 1, 'the hourly pass queues one overdue reminder at 9 AM local');
SELECT is(public.notify_overdue_follow_ups(), 0, 'the same day never queues a second reminder');

SELECT is(
  (SELECT (user_id::text, title, body)::text FROM public.notification_outbox WHERE kind = 'overdue_mine'),
  ('a2000000-0000-0000-0000-0000000000e5', 'Follow-ups past due', 'Some of your follow-ups are past due. Open ReferralFit to catch up.')::text,
  'the overdue reminder names no follow-up and goes to its owner'
);

-- Push off: nothing is queued for a member who turned it off.
UPDATE public.notification_preferences SET push_enabled = false WHERE user_id = 'a2000000-0000-0000-0000-0000000000e5';
SELECT set_config('test.assigned_before', (SELECT count(*)::text FROM public.notification_outbox WHERE kind = 'assigned_to_me'), true);
SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000e5', true);
SET LOCAL ROLE authenticated;
UPDATE public.follow_ups SET assigned_to = NULL WHERE id = 'a1300000-0000-0000-0000-0000000000e5';
UPDATE public.follow_ups SET assigned_to = 'a2000000-0000-0000-0000-0000000000e5' WHERE id = 'a1300000-0000-0000-0000-0000000000e5';
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

SELECT is(
  (SELECT count(*)::integer FROM public.notification_outbox WHERE kind = 'assigned_to_me'),
  current_setting('test.assigned_before')::integer,
  'a member with push off is never queued'
);

-- ===========================================================================
-- F. Dispatch RPCs: service role only; claim, record, prune dead tokens
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000e5', true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$ SELECT * FROM public.push_outbox_claim(10) $$,
  '42501',
  NULL,
  'a signed-in member cannot claim the outbox'
);

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('request.jwt.claim.sub', '', true);
SET LOCAL ROLE service_role;

SELECT set_config('test.claimed', (SELECT count(*)::text FROM public.push_outbox_claim(100)), true);

RESET ROLE;
SELECT is(
  current_setting('test.claimed')::integer,
  (SELECT count(*)::integer FROM public.notification_outbox WHERE claimed_at IS NOT NULL),
  'the dispatcher claims every pending row with a device'
);
SET LOCAL ROLE service_role;

SELECT is(
  (SELECT count(*)::integer FROM public.push_outbox_claim(100)),
  0,
  'a second claim within five minutes returns nothing'
);

RESET ROLE;
SELECT is(
  (SELECT count(*)::integer FROM public.notification_outbox WHERE kind = 'overdue_mine' AND error = 'no_device'),
  0,
  'rows for members with a device are not marked no_device'
);
-- The dispatcher gets ids from push_outbox_claim; here the superuser builds
-- the same result payload (service_role cannot read the table).
SELECT set_config('test.record_payload',
  (SELECT jsonb_agg(jsonb_build_object('id', o.id, 'tickets', jsonb_build_array(jsonb_build_object('token', 'ExponentPushToken[a2a2a2a2a2a2a2a2a2a2a2]', 'id', 'ticket-1'))))::text
     FROM public.notification_outbox o WHERE o.kind = 'new_lead'), true);
SET LOCAL ROLE service_role;

SELECT lives_ok(
  $$ SELECT public.push_outbox_record(current_setting('test.record_payload')::jsonb, ARRAY['ExponentPushToken[b1b1b1b1b1b1b1b1b1b1b1]']) $$,
  'the dispatcher records tickets and prunes a dead token'
);

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

SELECT is(
  (SELECT (sent_at IS NOT NULL, tickets -> 0 ->> 'id')::text FROM public.notification_outbox WHERE kind = 'new_lead'),
  '(t,ticket-1)',
  'a recorded send is marked sent with its ticket'
);

SELECT is(
  (SELECT count(*)::integer FROM public.push_tokens WHERE expo_push_token = 'ExponentPushToken[b1b1b1b1b1b1b1b1b1b1b1]'),
  0,
  'a token Expo reported as unregistered is removed'
);

-- Leaving the practice releases assignments.
UPDATE public.org_members SET org_id = current_setting('test.org_b')::uuid WHERE user_id = 'a2000000-0000-0000-0000-0000000000e5';

SELECT is(
  (SELECT count(*)::integer FROM public.follow_ups WHERE org_id = current_setting('test.org_a')::uuid AND assigned_to = 'a2000000-0000-0000-0000-0000000000e5'),
  0,
  'a member who leaves no longer holds assignments in the workspace they left'
);

SELECT * FROM finish();
ROLLBACK;
