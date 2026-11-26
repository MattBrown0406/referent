-- Focused coverage for 20261126120000_lead_first_call_push.sql.
-- Run after a local migration reset with: supabase test db
--
-- This file is never pasted into production.

BEGIN;
SELECT plan(23);

-- Actors
--   o1  owner of practice A       push on, a device
--   m1  member of practice A      push on, a device
--   q1  member of practice A      push on, NO new-lead pushes
--   x1  owner of practice B       push on, a device
INSERT INTO auth.users (id, email)
VALUES
  ('f1000000-0000-0000-0000-0000000000fc', 'fc-o1@example.test'),
  ('f2000000-0000-0000-0000-0000000000fc', 'fc-m1@example.test'),
  ('f3000000-0000-0000-0000-0000000000fc', 'fc-q1@example.test'),
  ('f9000000-0000-0000-0000-0000000000fc', 'fc-x1@example.test');

SELECT set_config('test.org_a', org_id::text, true) FROM public.org_members WHERE user_id = 'f1000000-0000-0000-0000-0000000000fc';
SELECT set_config('test.org_b', org_id::text, true) FROM public.org_members WHERE user_id = 'f9000000-0000-0000-0000-0000000000fc';
UPDATE public.org_members SET org_id = current_setting('test.org_a')::uuid, role = 'member'
 WHERE user_id IN ('f2000000-0000-0000-0000-0000000000fc', 'f3000000-0000-0000-0000-0000000000fc');
-- Practice B gives itself an hour.
UPDATE public.orgs SET lead_response_target_minutes = 60 WHERE id = current_setting('test.org_b')::uuid;

INSERT INTO public.notification_preferences (user_id, push_enabled, new_lead) VALUES
  ('f1000000-0000-0000-0000-0000000000fc', true, true),
  ('f2000000-0000-0000-0000-0000000000fc', true, true),
  ('f3000000-0000-0000-0000-0000000000fc', true, false),
  ('f9000000-0000-0000-0000-0000000000fc', true, true);
INSERT INTO public.push_tokens (expo_push_token, user_id, org_id, platform) VALUES
  ('ExponentPushToken[fcowner00001]', 'f1000000-0000-0000-0000-0000000000fc', current_setting('test.org_a')::uuid, 'ios'),
  ('ExponentPushToken[fcmember0001]', 'f2000000-0000-0000-0000-0000000000fc', current_setting('test.org_a')::uuid, 'ios'),
  ('ExponentPushToken[fcquiet00001]', 'f3000000-0000-0000-0000-0000000000fc', current_setting('test.org_a')::uuid, 'ios'),
  ('ExponentPushToken[fcother00001]', 'f9000000-0000-0000-0000-0000000000fc', current_setting('test.org_b')::uuid, 'ios');

-- ===========================================================================
-- A. Schema and access
-- ===========================================================================

SELECT has_table('public', 'lead_first_call_nudges', 'lead_first_call_nudges exists');
SELECT has_function('public', 'notify_missed_first_calls', ARRAY[]::text[], 'notify_missed_first_calls exists');
SELECT is(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.lead_first_call_nudges'::regclass),
  true,
  'the nudge ledger has row level security on'
);
SELECT is(
  has_table_privilege('authenticated', 'public.lead_first_call_nudges', 'SELECT')
    OR has_table_privilege('anon', 'public.lead_first_call_nudges', 'SELECT')
    OR has_table_privilege('authenticated', 'public.lead_first_call_nudges', 'INSERT'),
  false,
  'no client role can read or write the nudge ledger'
);
SELECT is(
  has_function_privilege('authenticated', 'public.notify_missed_first_calls()', 'EXECUTE')
    OR has_function_privilege('anon', 'public.notify_missed_first_calls()', 'EXECUTE')
    OR has_function_privilege('service_role', 'public.notify_missed_first_calls()', 'EXECUTE'),
  false,
  'only the scheduler (the database owner) runs the first-call pass'
);

-- ===========================================================================
-- B. Leads, as quick-add and the intake link leave them
-- ===========================================================================

-- c1 unassigned, 20 min old: past the 15 min target.
-- c2 unassigned, 5 min old: not yet.
-- c3 its first call assigned to m1, 30 min old.
-- c4 30 min old but already called (first touch).
-- c5 30 min old but its first call is done.
-- c6 two days old: before the 24-hour window.
-- c7 30 min old, arrived as possible spam.
-- c8 30 min old, closed.
-- c9 practice B, 30 min old: inside B's 60 min target.
-- c10 30 min old, first call snoozed to tomorrow.
INSERT INTO public.cases (id, owner_id, org_id, title, status, lead_captured_at, first_touch_at, summary) VALUES
  ('c1000000-0000-0000-0000-0000000000fc', 'f1000000-0000-0000-0000-0000000000fc', current_setting('test.org_a')::uuid, 'Lead one', 'inquiry', now() - interval '20 minutes', NULL, ''),
  ('c2000000-0000-0000-0000-0000000000fc', 'f1000000-0000-0000-0000-0000000000fc', current_setting('test.org_a')::uuid, 'Lead two', 'inquiry', now() - interval '5 minutes', NULL, ''),
  ('c3000000-0000-0000-0000-0000000000fc', 'f1000000-0000-0000-0000-0000000000fc', current_setting('test.org_a')::uuid, 'Lead three', 'inquiry', now() - interval '30 minutes', NULL, ''),
  ('c4000000-0000-0000-0000-0000000000fc', 'f1000000-0000-0000-0000-0000000000fc', current_setting('test.org_a')::uuid, 'Lead four', 'inquiry', now() - interval '30 minutes', now() - interval '25 minutes', ''),
  ('c5000000-0000-0000-0000-0000000000fc', 'f1000000-0000-0000-0000-0000000000fc', current_setting('test.org_a')::uuid, 'Lead five', 'inquiry', now() - interval '30 minutes', NULL, ''),
  ('c6000000-0000-0000-0000-0000000000fc', 'f1000000-0000-0000-0000-0000000000fc', current_setting('test.org_a')::uuid, 'Lead six', 'inquiry', now() - interval '2 days', NULL, ''),
  ('c7000000-0000-0000-0000-0000000000fc', 'f1000000-0000-0000-0000-0000000000fc', current_setting('test.org_a')::uuid, 'Lead seven', 'inquiry', now() - interval '30 minutes', NULL, 'Possible spam: this intake link received an unusual number of requests in the last hour, so no push was sent.'),
  ('c8000000-0000-0000-0000-0000000000fc', 'f1000000-0000-0000-0000-0000000000fc', current_setting('test.org_a')::uuid, 'Lead eight', 'closed', now() - interval '30 minutes', NULL, ''),
  ('c9000000-0000-0000-0000-0000000000fc', 'f9000000-0000-0000-0000-0000000000fc', current_setting('test.org_b')::uuid, 'Lead nine', 'inquiry', now() - interval '30 minutes', NULL, ''),
  ('ca000000-0000-0000-0000-0000000000fc', 'f1000000-0000-0000-0000-0000000000fc', current_setting('test.org_a')::uuid, 'Lead ten', 'inquiry', now() - interval '30 minutes', NULL, '');

INSERT INTO public.follow_ups (id, owner_id, org_id, case_id, title, due_on, kind, status, assigned_to, snoozed_until) VALUES
  ('d1000000-0000-0000-0000-0000000000fc', 'f1000000-0000-0000-0000-0000000000fc', current_setting('test.org_a')::uuid, 'c1000000-0000-0000-0000-0000000000fc', 'First call', CURRENT_DATE, 'first_call', 'open', NULL, NULL),
  ('d2000000-0000-0000-0000-0000000000fc', 'f1000000-0000-0000-0000-0000000000fc', current_setting('test.org_a')::uuid, 'c2000000-0000-0000-0000-0000000000fc', 'First call', CURRENT_DATE, 'first_call', 'open', NULL, NULL),
  ('d3000000-0000-0000-0000-0000000000fc', 'f1000000-0000-0000-0000-0000000000fc', current_setting('test.org_a')::uuid, 'c3000000-0000-0000-0000-0000000000fc', 'First call', CURRENT_DATE, 'first_call', 'open', 'f2000000-0000-0000-0000-0000000000fc', NULL),
  ('d4000000-0000-0000-0000-0000000000fc', 'f1000000-0000-0000-0000-0000000000fc', current_setting('test.org_a')::uuid, 'c4000000-0000-0000-0000-0000000000fc', 'First call', CURRENT_DATE, 'first_call', 'open', NULL, NULL),
  ('d5000000-0000-0000-0000-0000000000fc', 'f1000000-0000-0000-0000-0000000000fc', current_setting('test.org_a')::uuid, 'c5000000-0000-0000-0000-0000000000fc', 'First call', CURRENT_DATE, 'first_call', 'done', NULL, NULL),
  ('d6000000-0000-0000-0000-0000000000fc', 'f1000000-0000-0000-0000-0000000000fc', current_setting('test.org_a')::uuid, 'c6000000-0000-0000-0000-0000000000fc', 'First call', CURRENT_DATE - 2, 'first_call', 'open', NULL, NULL),
  ('d7000000-0000-0000-0000-0000000000fc', 'f1000000-0000-0000-0000-0000000000fc', current_setting('test.org_a')::uuid, 'c7000000-0000-0000-0000-0000000000fc', 'First call', CURRENT_DATE, 'first_call', 'open', NULL, NULL),
  ('d8000000-0000-0000-0000-0000000000fc', 'f1000000-0000-0000-0000-0000000000fc', current_setting('test.org_a')::uuid, 'c8000000-0000-0000-0000-0000000000fc', 'First call', CURRENT_DATE, 'first_call', 'open', NULL, NULL),
  ('d9000000-0000-0000-0000-0000000000fc', 'f9000000-0000-0000-0000-0000000000fc', current_setting('test.org_b')::uuid, 'c9000000-0000-0000-0000-0000000000fc', 'First call', CURRENT_DATE, 'first_call', 'open', NULL, NULL),
  ('da000000-0000-0000-0000-0000000000fc', 'f1000000-0000-0000-0000-0000000000fc', current_setting('test.org_a')::uuid, 'ca000000-0000-0000-0000-0000000000fc', 'First call', CURRENT_DATE, 'first_call', 'open', NULL, CURRENT_DATE + 1);

-- ===========================================================================
-- C. The first-call pass
-- ===========================================================================

SELECT is(public.notify_missed_first_calls(), 3, 'three pushes: the unassigned lead to both members who want them, the assigned one to its assignee');

SELECT is(
  (SELECT string_agg(user_id::text, ',' ORDER BY user_id)
     FROM public.notification_outbox
    WHERE kind = 'new_lead' AND data ->> 'reason' = 'first_call_due' AND data ->> 'case_id' = 'c1000000-0000-0000-0000-0000000000fc'),
  'f1000000-0000-0000-0000-0000000000fc,f2000000-0000-0000-0000-0000000000fc',
  'a lead nobody has taken reaches every member of the practice who wants new-lead pushes (the owner included)'
);
SELECT is(
  (SELECT string_agg(user_id::text, ',' ORDER BY user_id)
     FROM public.notification_outbox
    WHERE kind = 'new_lead' AND data ->> 'reason' = 'first_call_due' AND data ->> 'case_id' = 'c3000000-0000-0000-0000-0000000000fc'),
  'f2000000-0000-0000-0000-0000000000fc',
  'a lead with an assignee reaches only that member'
);
SELECT is(
  (SELECT count(*)::integer FROM public.notification_outbox
    WHERE data ->> 'reason' = 'first_call_due'
      AND data ->> 'case_id' IN ('c2000000-0000-0000-0000-0000000000fc', 'c4000000-0000-0000-0000-0000000000fc',
                                 'c5000000-0000-0000-0000-0000000000fc', 'c6000000-0000-0000-0000-0000000000fc',
                                 'c7000000-0000-0000-0000-0000000000fc', 'c8000000-0000-0000-0000-0000000000fc',
                                 'c9000000-0000-0000-0000-0000000000fc', 'ca000000-0000-0000-0000-0000000000fc')),
  0,
  'nothing before the target, after a first touch, for a done or snoozed first call, an old, possible-spam or closed lead, or inside a longer practice target'
);
SELECT is(
  (SELECT count(*)::integer FROM public.notification_outbox WHERE data ->> 'reason' = 'first_call_due' AND user_id = 'f3000000-0000-0000-0000-0000000000fc'),
  0,
  'a member who turned new-lead pushes off gets none'
);
SELECT is(
  (SELECT count(*)::integer FROM public.notification_outbox WHERE data ->> 'reason' = 'first_call_due' AND user_id = 'f9000000-0000-0000-0000-0000000000fc'),
  0,
  'another practice never hears about these leads'
);
SELECT is(
  (SELECT (min(title), min(body))::text FROM public.notification_outbox WHERE data ->> 'reason' = 'first_call_due'),
  ('New lead waiting', 'A new lead is waiting for its first call.')::text,
  'the push uses the generic new-lead copy, with no name in it'
);
SELECT is(
  (SELECT count(*)::integer FROM public.notification_outbox o
    WHERE data ->> 'reason' = 'first_call_due' AND (o.title || o.body) ~* 'lead one|lead three'),
  0,
  'no case title reaches a lock screen'
);
SELECT is(
  (SELECT (data ->> 'follow_up_id') FROM public.notification_outbox WHERE data ->> 'reason' = 'first_call_due' AND data ->> 'case_id' = 'c3000000-0000-0000-0000-0000000000fc'),
  'd3000000-0000-0000-0000-0000000000fc',
  'the push names the step (ids only) so the app opens the case'
);
SELECT is(
  (SELECT string_agg(case_id::text || ':' || recipients, ',' ORDER BY case_id) FROM public.lead_first_call_nudges),
  'c1000000-0000-0000-0000-0000000000fc:2,c3000000-0000-0000-0000-0000000000fc:1',
  'each nudged lead is recorded once, with how many it reached'
);

SELECT is(public.notify_missed_first_calls(), 0, 'the next minute sends nothing again for the same leads');

-- c2 crosses its target: the next pass picks it up, alone.
UPDATE public.cases SET lead_captured_at = now() - interval '16 minutes' WHERE id = 'c2000000-0000-0000-0000-0000000000fc';
SELECT is(public.notify_missed_first_calls(), 2, 'a lead is nudged the minute it passes the target');

-- A lead nudged when nobody wanted pushes is still nudged only once.
UPDATE public.notification_preferences SET push_enabled = false;
UPDATE public.cases SET lead_captured_at = now() - interval '16 minutes' WHERE id = 'ca000000-0000-0000-0000-0000000000fc';
UPDATE public.follow_ups SET snoozed_until = NULL WHERE id = 'da000000-0000-0000-0000-0000000000fc';
SELECT is(public.notify_missed_first_calls(), 0, 'with every push off nothing is queued');
SELECT is(
  (SELECT recipients FROM public.lead_first_call_nudges WHERE case_id = 'ca000000-0000-0000-0000-0000000000fc'),
  0,
  '...and the lead is marked, so turning push on later does not send a stale nudge'
);
UPDATE public.notification_preferences SET push_enabled = true;

-- ===========================================================================
-- D. The 9 AM overdue push counts a step nobody has taken
-- ===========================================================================

-- An overdue unassigned step on an unassigned case in practice A, and an
-- overdue step assigned to o1. Everyone is at 9 AM local.
DELETE FROM public.notification_outbox;
UPDATE public.notification_preferences
   SET tz_offset_minutes = ((((9 - extract(hour FROM now() AT TIME ZONE 'UTC')::integer + 36) % 24) - 12) * 60),
       overdue_notified_on = NULL;
UPDATE public.follow_ups SET status = 'done' WHERE org_id IN (current_setting('test.org_a')::uuid, current_setting('test.org_b')::uuid);
INSERT INTO public.follow_ups (id, owner_id, org_id, case_id, title, due_on, kind, assigned_to) VALUES
  ('e1000000-0000-0000-0000-0000000000fc', 'f1000000-0000-0000-0000-0000000000fc', current_setting('test.org_a')::uuid, 'c1000000-0000-0000-0000-0000000000fc', 'Late first call', CURRENT_DATE - 1, 'first_call', NULL);

SELECT is(public.notify_overdue_follow_ups(), 3, 'an overdue step nobody has taken reaches every member of its practice');
SELECT is(
  (SELECT string_agg(user_id::text, ',' ORDER BY user_id) FROM public.notification_outbox WHERE kind = 'overdue_mine'),
  'f1000000-0000-0000-0000-0000000000fc,f2000000-0000-0000-0000-0000000000fc,f3000000-0000-0000-0000-0000000000fc',
  '...and never a member of another practice'
);

-- Taken by m1: from then on it is m1's alone.
DELETE FROM public.notification_outbox;
UPDATE public.notification_preferences SET overdue_notified_on = NULL;
UPDATE public.follow_ups SET assigned_to = 'f2000000-0000-0000-0000-0000000000fc' WHERE id = 'e1000000-0000-0000-0000-0000000000fc';
SELECT is(public.notify_overdue_follow_ups(), 1, 'once someone has the step, only they are reminded');
SELECT is(
  (SELECT user_id::text FROM public.notification_outbox WHERE kind = 'overdue_mine'),
  'f2000000-0000-0000-0000-0000000000fc',
  'the assignee gets it'
);

SELECT * FROM finish();
ROLLBACK;
