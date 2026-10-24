-- Focused coverage for the round-11 sections (13 to 21) of
-- 20261024120000_directory_membership_hardening.sql.
-- Run after a local migration reset with: supabase test db
--
-- This file is never pasted into production. Function calls that a
-- missing fix could break run inside lives_ok / throws_ok, so a run
-- against the old schema reports each failure instead of aborting.

BEGIN;
SELECT plan(75);

-- Actors (suffix 11a1)
--   o1  owner of practice A ("Olivia Owner")
--   m1  member of practice A ("Maya Member")
--   m2  member of practice A ("Theo Teammate"), later joins practice B
--   s1  sole owner who deletes their account
--   j1  someone holding one of s1's invite codes
--   b1  owner of practice B
--   i1  sole owner whose intake link is flooded
--   ad  platform admin
INSERT INTO auth.users (id, email)
VALUES
  ('11000000-0000-0000-0000-0000000011a1', 'r11-owner@example.test'),
  ('12000000-0000-0000-0000-0000000011a1', 'r11-maya@example.test'),
  ('13000000-0000-0000-0000-0000000011a1', 'r11-theo@example.test'),
  ('14000000-0000-0000-0000-0000000011a1', 'r11-solo@example.test'),
  ('15000000-0000-0000-0000-0000000011a1', 'r11-joiner@example.test'),
  ('16000000-0000-0000-0000-0000000011a1', 'r11-other-owner@example.test'),
  ('17000000-0000-0000-0000-0000000011a1', 'r11-intake@example.test'),
  ('18000000-0000-0000-0000-0000000011a1', 'r11-admin@example.test');

INSERT INTO public.platform_admins (user_id) VALUES ('18000000-0000-0000-0000-0000000011a1');

SELECT set_config('test.org_a', org_id::text, true) FROM public.org_members WHERE user_id = '11000000-0000-0000-0000-0000000011a1';
SELECT set_config('test.org_b', org_id::text, true) FROM public.org_members WHERE user_id = '16000000-0000-0000-0000-0000000011a1';
SELECT set_config('test.org_s', org_id::text, true) FROM public.org_members WHERE user_id = '14000000-0000-0000-0000-0000000011a1';
SELECT set_config('test.org_i', org_id::text, true) FROM public.org_members WHERE user_id = '17000000-0000-0000-0000-0000000011a1';
UPDATE public.org_members SET display_name = 'Olivia Owner' WHERE user_id = '11000000-0000-0000-0000-0000000011a1';
UPDATE public.org_members SET org_id = current_setting('test.org_a')::uuid, role = 'member', display_name = 'Maya Member'
 WHERE user_id = '12000000-0000-0000-0000-0000000011a1';
UPDATE public.org_members SET org_id = current_setting('test.org_a')::uuid, role = 'member', display_name = 'Theo Teammate'
 WHERE user_id = '13000000-0000-0000-0000-0000000011a1';

-- ===========================================================================
-- 13. prepare_account_deletion: the preflight before files are removed
-- ===========================================================================

SELECT ok(
  CASE WHEN to_regprocedure('public.prepare_account_deletion()') IS NULL THEN false ELSE
    (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.prepare_account_deletion()'))
    AND has_function_privilege('authenticated', 'public.prepare_account_deletion()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.prepare_account_deletion()', 'EXECUTE') END,
  'prepare_account_deletion exists, runs as definer, and only signed-in members can call it'
);

-- An owner with two colleagues: the same refusal delete_own_account gives.
SELECT set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-0000000011a1', true);
SET LOCAL ROLE authenticated;
SELECT set_config('test.invite_a', code, true) FROM public.create_org_invite();
SELECT throws_ok(
  $$ SELECT public.prepare_account_deletion() $$,
  '22023',
  'Your workspace still has 2 other member(s). Remove them from the Workspace screen first (each keeps their own workspace), or contact ReferralFit to transfer ownership, then delete your account.',
  'an owner with colleagues is refused before any file is touched'
);
SELECT throws_ok(
  $$ SELECT public.delete_own_account() $$,
  '22023',
  'Your workspace still has 2 other member(s). Remove them from the Workspace screen first (each keeps their own workspace), or contact ReferralFit to transfer ownership, then delete your account.',
  'the preflight refusal is exactly the one delete_own_account gives'
);
RESET ROLE;
SELECT is(
  (SELECT count(*)::integer FROM public.org_invites WHERE org_id = current_setting('test.org_a')::uuid AND accepted_at IS NULL),
  1,
  'a refused preflight leaves the practice''s invites alone'
);

-- A member: nothing to check, nothing changed.
SELECT set_config('request.jwt.claim.sub', '12000000-0000-0000-0000-0000000011a1', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$ SELECT public.prepare_account_deletion() $$, 'a member''s preflight passes');
RESET ROLE;
SELECT is(
  (SELECT count(*)::integer FROM public.org_invites WHERE org_id = current_setting('test.org_a')::uuid AND accepted_at IS NULL),
  1,
  'a member''s preflight never removes the practice''s invites'
);

SELECT set_config('request.jwt.claim.sub', '', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.prepare_account_deletion() $$, '28000', 'Authentication is required', 'no session, no preflight');
RESET ROLE;

-- A sole owner with two unused invites (and one already used).
SELECT set_config('request.jwt.claim.sub', '14000000-0000-0000-0000-0000000011a1', true);
SET LOCAL ROLE authenticated;
SELECT set_config('test.invite_s1', code, true) FROM public.create_org_invite();
SELECT set_config('test.invite_s2', code, true) FROM public.create_org_invite();
RESET ROLE;
INSERT INTO public.org_invites (org_id, code, invited_by, expires_at, accepted_by, accepted_at)
VALUES (current_setting('test.org_s')::uuid, 'r11usedinvite01', '14000000-0000-0000-0000-0000000011a1', now() + interval '1 day',
        '14000000-0000-0000-0000-0000000011a1', now());
SET LOCAL ROLE authenticated;
SELECT lives_ok($$ SELECT public.prepare_account_deletion() $$, 'a sole owner''s preflight passes');
RESET ROLE;
SELECT is(
  (SELECT count(*) FILTER (WHERE accepted_at IS NULL)::text || '|' || count(*) FILTER (WHERE accepted_at IS NOT NULL)::text
     FROM public.org_invites WHERE org_id = current_setting('test.org_s')::uuid),
  '0|1',
  'the sole owner''s unused invites are gone; the used one stays with the workspace'
);
SELECT set_config('request.jwt.claim.sub', '15000000-0000-0000-0000-0000000011a1', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.accept_org_invite(current_setting('test.invite_s1')) $$,
  'P0002', 'Invite code not found',
  'a colleague holding one of the old codes can no longer join mid-deletion'
);
SELECT set_config('request.jwt.claim.sub', '14000000-0000-0000-0000-0000000011a1', true);
SELECT lives_ok($$ SELECT public.delete_own_account() $$, 'the deletion that follows the preflight succeeds');
RESET ROLE;

-- ===========================================================================
-- 14. Closing a case skips its open follow-ups; the overdue push follows
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-0000000011a1', true);
SET LOCAL ROLE authenticated;
INSERT INTO public.cases (id, title) VALUES
  ('21000000-0000-0000-0000-0000000011a1', 'Closing family'),
  ('22000000-0000-0000-0000-0000000011a1', 'Open family'),
  ('23000000-0000-0000-0000-0000000011a1', 'Lost family');
INSERT INTO public.partners (id, owner_id, name, organization)
VALUES ('20100000-0000-0000-0000-0000000011a1', '11000000-0000-0000-0000-0000000011a1', 'Admissions', 'Cedar House');
INSERT INTO public.referrals (id, owner_id, partner_id, direction, referred_on, case_id)
VALUES ('20200000-0000-0000-0000-0000000011a1', '11000000-0000-0000-0000-0000000011a1', '20100000-0000-0000-0000-0000000011a1',
        'outbound', CURRENT_DATE - 10, '21000000-0000-0000-0000-0000000011a1');
INSERT INTO public.follow_ups (id, case_id, title, due_on, kind, waiting_on, assigned_to) VALUES
  ('21100000-0000-0000-0000-0000000011a1', '21000000-0000-0000-0000-0000000011a1', 'Call back', CURRENT_DATE - 3, 'follow_up', '', '13000000-0000-0000-0000-0000000011a1'),
  ('21200000-0000-0000-0000-0000000011a1', '21000000-0000-0000-0000-0000000011a1', 'Waiting on the wife', CURRENT_DATE, 'waiting_on', 'the wife', NULL),
  ('22100000-0000-0000-0000-0000000011a1', '22000000-0000-0000-0000-0000000011a1', 'Other family call', CURRENT_DATE, 'follow_up', '', NULL),
  ('23100000-0000-0000-0000-0000000011a1', '23000000-0000-0000-0000-0000000011a1', 'Consult', CURRENT_DATE, 'consult', '', NULL),
  ('23200000-0000-0000-0000-0000000011a1', '23000000-0000-0000-0000-0000000011a1', 'Send packet', CURRENT_DATE, 'follow_up', '', NULL);
INSERT INTO public.follow_ups (id, case_id, title, due_on, kind, status, completed_at)
VALUES ('21300000-0000-0000-0000-0000000011a1', '21000000-0000-0000-0000-0000000011a1', 'Done earlier', CURRENT_DATE - 5, 'follow_up', 'done', '2026-10-01T12:00:00Z');
INSERT INTO public.follow_ups (id, case_id, referral_id, title, due_on, kind, check_in_days)
VALUES ('21400000-0000-0000-0000-0000000011a1', '21000000-0000-0000-0000-0000000011a1', '20200000-0000-0000-0000-0000000011a1',
        '7-day check-in', CURRENT_DATE + 2, 'check_in', 7);

SELECT lives_ok(
  $$ SELECT public.update_case_with_event(
       '{"id":"21000000-0000-0000-0000-0000000011a1","status":"closed"}'::jsonb,
       '{"id":"21900000-0000-0000-0000-0000000011a1","kind":"status_change","body":"inquiry to closed"}'::jsonb) $$,
  'a case closes through update_case_with_event'
);
RESET ROLE;
SELECT is(
  (SELECT string_agg(title || '=' || status, ', ' ORDER BY title) FROM public.follow_ups WHERE case_id = '21000000-0000-0000-0000-0000000011a1'),
  '7-day check-in=open, Call back=skipped, Done earlier=done, Waiting on the wife=skipped',
  'closing a case skips its open follow-ups and keeps the placement check-in'
);
SELECT ok(
  (SELECT bool_and(completed_at IS NOT NULL AND completed_by = '11000000-0000-0000-0000-0000000011a1')
     FROM public.follow_ups WHERE id IN ('21100000-0000-0000-0000-0000000011a1', '21200000-0000-0000-0000-0000000011a1'))
  AND (SELECT completed_at = '2026-10-01T12:00:00Z'::timestamptz FROM public.follow_ups WHERE id = '21300000-0000-0000-0000-0000000011a1'),
  'each skip is stamped with the time and the member who closed the case; a finished step is untouched'
);
SELECT is(
  (SELECT status FROM public.follow_ups WHERE id = '22100000-0000-0000-0000-0000000011a1'),
  'open',
  'another case''s follow-ups are untouched'
);

SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$ SELECT public.complete_follow_up_with_case(
       '{"id":"23100000-0000-0000-0000-0000000011a1","status":"done","completed_at":"2026-10-24T15:00:00Z"}'::jsonb,
       '{"id":"23000000-0000-0000-0000-0000000011a1","status":"lost","apply_status":true}'::jsonb,
       '{"id":"23900000-0000-0000-0000-0000000011a1","kind":"system","body":"Consult done, the family went elsewhere"}'::jsonb) $$,
  'a case is marked lost while its consult is completed'
);
RESET ROLE;
SELECT is(
  (SELECT string_agg(title || '=' || status, ', ' ORDER BY title) FROM public.follow_ups WHERE case_id = '23000000-0000-0000-0000-0000000011a1'),
  'Consult=done, Send packet=skipped',
  'marking a case lost from a completed step skips the case''s other open follow-ups'
);

-- Overdue push at 9 AM local for o1, m1 and m2, all three with an overdue
-- step on the closed case. m2's ("Call back", assigned to Theo, three days
-- late) was open when the case closed, so the close skipped it: no push.
-- o1's is a placement check-in, kept open: a push. m1's was scheduled on
-- the case AFTER it closed (a lost lead's call back, a placed case's next
-- step): an ordinary open step, so a push, as on Today.
SELECT set_config('test.tz', ((((9 - extract(hour FROM now() AT TIME ZONE 'UTC')::integer + 36) % 24) - 12) * 60)::text, true);
INSERT INTO public.notification_preferences (user_id, push_enabled, tz_offset_minutes) VALUES
  ('11000000-0000-0000-0000-0000000011a1', true, current_setting('test.tz')::integer),
  ('12000000-0000-0000-0000-0000000011a1', true, current_setting('test.tz')::integer),
  ('13000000-0000-0000-0000-0000000011a1', true, current_setting('test.tz')::integer);
INSERT INTO public.push_tokens (expo_push_token, user_id, org_id, platform) VALUES
  ('ExponentPushToken[r11owner0001]', '11000000-0000-0000-0000-0000000011a1', current_setting('test.org_a')::uuid, 'ios'),
  ('ExponentPushToken[r11maya00001]', '12000000-0000-0000-0000-0000000011a1', current_setting('test.org_a')::uuid, 'ios'),
  ('ExponentPushToken[r11theo00001]', '13000000-0000-0000-0000-0000000011a1', current_setting('test.org_a')::uuid, 'ios');
INSERT INTO public.follow_ups (id, owner_id, case_id, referral_id, title, due_on, kind, check_in_days, assigned_to) VALUES
  ('21600000-0000-0000-0000-0000000011a1', '11000000-0000-0000-0000-0000000011a1', '21000000-0000-0000-0000-0000000011a1',
   '20200000-0000-0000-0000-0000000011a1', '30-day check-in', CURRENT_DATE - 5, 'check_in', 30, '11000000-0000-0000-0000-0000000011a1');
INSERT INTO public.follow_ups (id, owner_id, case_id, title, due_on, kind, assigned_to) VALUES
  ('21700000-0000-0000-0000-0000000011a1', '11000000-0000-0000-0000-0000000011a1', '21000000-0000-0000-0000-0000000011a1',
   'Call back after closing', CURRENT_DATE - 1, 'promised_call', '12000000-0000-0000-0000-0000000011a1');
SELECT is(
  (SELECT status || '|' || assigned_to::text FROM public.follow_ups WHERE id = '21100000-0000-0000-0000-0000000011a1'),
  'skipped|13000000-0000-0000-0000-0000000011a1',
  'Theo''s late step was skipped when the case closed'
);
SELECT public.notify_overdue_follow_ups();
SELECT is(
  (SELECT string_agg(user_id::text, ',' ORDER BY user_id) FROM public.notification_outbox WHERE kind = 'overdue_mine'),
  '11000000-0000-0000-0000-0000000011a1,12000000-0000-0000-0000-0000000011a1',
  'the overdue push counts a closed case''s check-in and a step scheduled after the close, not a step the close skipped'
);

-- Reopening puts back exactly the steps the close skipped, also across a
-- closed -> lost move; a step skipped by hand and a finished step stay.
SET LOCAL ROLE authenticated;
INSERT INTO public.cases (id, title) VALUES ('2b000000-0000-0000-0000-0000000011a1', 'Reopened family');
INSERT INTO public.follow_ups (id, case_id, title, due_on, kind, snoozed_until) VALUES
  ('2b100000-0000-0000-0000-0000000011a1', '2b000000-0000-0000-0000-0000000011a1', 'Consult Friday', CURRENT_DATE + 3, 'consult', NULL),
  ('2b200000-0000-0000-0000-0000000011a1', '2b000000-0000-0000-0000-0000000011a1', 'Promised call', CURRENT_DATE, 'promised_call', CURRENT_DATE + 1);
INSERT INTO public.follow_ups (id, case_id, title, due_on, kind, status, completed_at) VALUES
  ('2b300000-0000-0000-0000-0000000011a1', '2b000000-0000-0000-0000-0000000011a1', 'Skipped by hand', CURRENT_DATE, 'follow_up', 'skipped', '2026-10-02T12:00:00Z'),
  ('2b400000-0000-0000-0000-0000000011a1', '2b000000-0000-0000-0000-0000000011a1', 'Done earlier', CURRENT_DATE, 'follow_up', 'done', '2026-10-02T12:00:00Z');
SELECT lives_ok(
  $$ SELECT public.update_case_with_event('{"id":"2b000000-0000-0000-0000-0000000011a1","status":"closed"}'::jsonb,
       '{"id":"2b900000-0000-0000-0000-0000000011a1","kind":"status_change","body":"inquiry to closed"}'::jsonb) $$,
  'a case is closed by mistake'
);
INSERT INTO public.follow_ups (id, case_id, title, due_on, kind) VALUES
  ('2b500000-0000-0000-0000-0000000011a1', '2b000000-0000-0000-0000-0000000011a1', 'Added after closing', CURRENT_DATE + 2, 'follow_up');
SELECT lives_ok(
  $$ SELECT public.update_case_with_event('{"id":"2b000000-0000-0000-0000-0000000011a1","status":"lost"}'::jsonb,
       '{"id":"2b910000-0000-0000-0000-0000000011a1","kind":"status_change","body":"closed to lost"}'::jsonb) $$,
  'then moved to lost'
);
SELECT is(
  (SELECT string_agg(title || '=' || status, ', ' ORDER BY title) FROM public.follow_ups WHERE case_id = '2b000000-0000-0000-0000-0000000011a1'),
  'Added after closing=skipped, Consult Friday=skipped, Done earlier=done, Promised call=skipped, Skipped by hand=skipped',
  'closed, then lost: every open step is skipped'
);
SELECT lives_ok(
  $$ SELECT public.update_case_with_event('{"id":"2b000000-0000-0000-0000-0000000011a1","status":"consult"}'::jsonb,
       '{"id":"2b920000-0000-0000-0000-0000000011a1","kind":"status_change","body":"lost to consult"}'::jsonb) $$,
  'and reopened'
);
RESET ROLE;
SELECT is(
  (SELECT string_agg(title || '=' || status || '/' || (completed_at IS NULL)::text || '/' || (completed_by IS NULL)::text, ', ' ORDER BY title)
     FROM public.follow_ups WHERE case_id = '2b000000-0000-0000-0000-0000000011a1'),
  'Added after closing=open/true/true, Consult Friday=open/true/true, Done earlier=done/false/false, Promised call=open/true/true, Skipped by hand=skipped/false/false',
  'reopening puts back exactly the steps the close skipped, with no completion left on them'
);

-- ===========================================================================
-- 15. complete_follow_up_with_next: assignee carried, replays write once
-- ===========================================================================

SET LOCAL ROLE authenticated;
INSERT INTO public.cases (id, title) VALUES ('24000000-0000-0000-0000-0000000011a1', 'Next step family');
INSERT INTO public.follow_ups (id, case_id, title, due_on, kind, assigned_to) VALUES
  ('24100000-0000-0000-0000-0000000011a1', '24000000-0000-0000-0000-0000000011a1', 'First call', CURRENT_DATE, 'first_call', '12000000-0000-0000-0000-0000000011a1'),
  ('24300000-0000-0000-0000-0000000011a1', '24000000-0000-0000-0000-0000000011a1', 'Consult', CURRENT_DATE, 'consult', '12000000-0000-0000-0000-0000000011a1'),
  ('24500000-0000-0000-0000-0000000011a1', '24000000-0000-0000-0000-0000000011a1', 'Send packet', CURRENT_DATE, 'follow_up', '12000000-0000-0000-0000-0000000011a1');
INSERT INTO public.follow_ups (id, case_id, title, due_on, kind) VALUES
  ('24600000-0000-0000-0000-0000000011a1', '24000000-0000-0000-0000-0000000011a1', 'Call the program', CURRENT_DATE, 'follow_up');

SELECT lives_ok(
  $$ SELECT public.complete_follow_up_with_next(
       '{"id":"24100000-0000-0000-0000-0000000011a1","status":"done","completed_at":"2026-10-24T16:00:00Z"}'::jsonb,
       '{"id":"24200000-0000-0000-0000-0000000011a1","case_id":"24000000-0000-0000-0000-0000000011a1","title":"Consult","due_on":"2026-10-27","status":"open","kind":"consult"}'::jsonb,
       NULL) $$,
  'the owner completes a colleague''s step and sets the next one'
);
SELECT lives_ok(
  $$ SELECT public.complete_follow_up_with_next(
       '{"id":"24300000-0000-0000-0000-0000000011a1","status":"done","completed_at":"2026-10-24T16:00:00Z"}'::jsonb,
       '{"id":"24400000-0000-0000-0000-0000000011a1","case_id":"24000000-0000-0000-0000-0000000011a1","title":"Packet","due_on":"2026-10-27","status":"open","kind":"follow_up","assigned_to":"13000000-0000-0000-0000-0000000011a1"}'::jsonb,
       NULL) $$,
  'a next step can name its own assignee'
);
SELECT lives_ok(
  $$ SELECT public.complete_follow_up_with_next(
       '{"id":"24500000-0000-0000-0000-0000000011a1","status":"done","completed_at":"2026-10-24T16:00:00Z"}'::jsonb,
       '{"id":"24510000-0000-0000-0000-0000000011a1","case_id":"24000000-0000-0000-0000-0000000011a1","title":"Check in","due_on":"2026-10-27","status":"open","kind":"follow_up","assigned_to":"16000000-0000-0000-0000-0000000011a1"}'::jsonb,
       NULL) $$,
  'a next step naming someone outside the workspace is still saved'
);
RESET ROLE;
SELECT is(
  (SELECT string_agg(f.id::text || '=' || coalesce(m.display_name, 'unassigned'), ', ' ORDER BY f.id)
     FROM public.follow_ups f LEFT JOIN public.org_members m ON m.user_id = f.assigned_to
    WHERE f.id IN ('24200000-0000-0000-0000-0000000011a1', '24400000-0000-0000-0000-0000000011a1', '24510000-0000-0000-0000-0000000011a1')),
  '24200000-0000-0000-0000-0000000011a1=Maya Member, 24400000-0000-0000-0000-0000000011a1=Theo Teammate, 24510000-0000-0000-0000-0000000011a1=unassigned',
  'the next step keeps the completed step''s assignee, takes one the client names, and is unassigned for a non-member'
);

SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$ SELECT public.complete_follow_up_with_next(
       '{"id":"24600000-0000-0000-0000-0000000011a1","status":"done","completed_at":"2026-10-24T16:00:00Z"}'::jsonb,
       '{"id":"24700000-0000-0000-0000-0000000011a1","case_id":"24000000-0000-0000-0000-0000000011a1","title":"Call again","due_on":"2026-10-28","status":"open","kind":"follow_up"}'::jsonb,
       '{"id":"24790000-0000-0000-0000-0000000011a1","case_id":"24000000-0000-0000-0000-0000000011a1","kind":"system","body":"Completed: Call the program, set next: Call again"}'::jsonb) $$,
  'Done -> next'
);
SELECT lives_ok(
  $$ SELECT public.complete_follow_up_with_next(
       '{"id":"24600000-0000-0000-0000-0000000011a1","status":"done","completed_at":"2026-10-24T16:05:00Z"}'::jsonb,
       '{"id":"24800000-0000-0000-0000-0000000011a1","case_id":"24000000-0000-0000-0000-0000000011a1","title":"Call again","due_on":"2026-10-28","status":"open","kind":"follow_up"}'::jsonb,
       '{"id":"24890000-0000-0000-0000-0000000011a1","case_id":"24000000-0000-0000-0000-0000000011a1","kind":"system","body":"Completed: Call the program, set next: Call again"}'::jsonb) $$,
  'a second Done -> next queued after a crash (new ids) succeeds'
);
SELECT lives_ok(
  $$ SELECT public.complete_follow_up_with_next(
       '{"id":"24600000-0000-0000-0000-0000000011a1","status":"done","completed_at":"2026-10-24T16:00:00Z"}'::jsonb,
       '{"id":"24700000-0000-0000-0000-0000000011a1","case_id":"24000000-0000-0000-0000-0000000011a1","title":"Call again","due_on":"2026-10-28","status":"open","kind":"follow_up"}'::jsonb,
       '{"id":"24790000-0000-0000-0000-0000000011a1","case_id":"24000000-0000-0000-0000-0000000011a1","kind":"system","body":"Completed: Call the program, set next: Call again"}'::jsonb) $$,
  'a replay of the first call succeeds'
);
RESET ROLE;
SELECT is(
  (SELECT count(*) FILTER (WHERE title = 'Call again')::text || '|'
          || count(*) FILTER (WHERE id = '24800000-0000-0000-0000-0000000011a1')::text
     FROM public.follow_ups WHERE case_id = '24000000-0000-0000-0000-0000000011a1'),
  '1|0',
  'one next step: the crash duplicate is not inserted'
);
SELECT is(
  (SELECT count(*)::integer FROM public.case_events
    WHERE id IN ('24790000-0000-0000-0000-0000000011a1', '24890000-0000-0000-0000-0000000011a1')),
  1,
  'one timeline entry for the completion'
);
SELECT is(
  (SELECT completed_at FROM public.follow_ups WHERE id = '24600000-0000-0000-0000-0000000011a1'),
  '2026-10-24T16:00:00Z'::timestamptz,
  'the finished step keeps its first completion'
);

-- Maya finishes a step from her phone moments before the owner's "Done ->
-- next" on the same step arrives. The owner's next step is not a replay:
-- it is saved with its timeline entry, and the step keeps Maya's completion.
SET LOCAL ROLE authenticated;
INSERT INTO public.follow_ups (id, case_id, title, due_on, kind) VALUES
  ('24a00000-0000-0000-0000-0000000011a1', '24000000-0000-0000-0000-0000000011a1', 'Call the wife', CURRENT_DATE, 'follow_up');
SELECT set_config('request.jwt.claim.sub', '12000000-0000-0000-0000-0000000011a1', true);
UPDATE public.follow_ups SET status = 'done', completed_at = '2026-10-24T15:30:00Z' WHERE id = '24a00000-0000-0000-0000-0000000011a1';
SELECT set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-0000000011a1', true);
SELECT lives_ok(
  $$ SELECT public.complete_follow_up_with_next(
       '{"id":"24a00000-0000-0000-0000-0000000011a1","status":"done","completed_at":"2026-10-24T16:10:00Z"}'::jsonb,
       '{"id":"24b00000-0000-0000-0000-0000000011a1","case_id":"24000000-0000-0000-0000-0000000011a1","title":"Consult Monday","due_on":"2026-10-27","status":"open","kind":"consult"}'::jsonb,
       '{"id":"24b90000-0000-0000-0000-0000000011a1","case_id":"24000000-0000-0000-0000-0000000011a1","kind":"system","body":"Completed: Call the wife, set next: Consult Monday"}'::jsonb) $$,
  'Done -> next on a step a colleague just finished'
);
RESET ROLE;
SELECT is(
  (SELECT (f.completed_at = '2026-10-24T15:30:00Z'::timestamptz)::text || '|' || f.completed_by::text
          || '|' || (SELECT n.status FROM public.follow_ups n WHERE n.id = '24b00000-0000-0000-0000-0000000011a1')
          || '|' || (SELECT count(*) FROM public.case_events e WHERE e.id = '24b90000-0000-0000-0000-0000000011a1')::text
     FROM public.follow_ups f WHERE f.id = '24a00000-0000-0000-0000-0000000011a1'),
  'true|12000000-0000-0000-0000-0000000011a1|open|1',
  'the next step and its timeline entry are saved; the step keeps the colleague''s completion'
);

-- ===========================================================================
-- 16. take_case: take only an unassigned case
-- ===========================================================================

SELECT ok(
  CASE WHEN to_regprocedure('public.take_case(uuid,uuid)') IS NULL THEN false ELSE
    has_function_privilege('authenticated', 'public.take_case(uuid,uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.take_case(uuid,uuid)', 'EXECUTE') END,
  'take_case exists and only signed-in members can call it'
);

SET LOCAL ROLE authenticated;
INSERT INTO public.cases (id, title) VALUES ('25000000-0000-0000-0000-0000000011a1', 'New lead family');
SELECT set_config('request.jwt.claim.sub', '12000000-0000-0000-0000-0000000011a1', true);
SELECT lives_ok(
  $$ SELECT set_config('test.take1', event_body, true)
       FROM public.take_case('25000000-0000-0000-0000-0000000011a1', '25010000-0000-0000-0000-0000000011a1') $$,
  'Maya takes the unassigned lead'
);
SELECT is(current_setting('test.take1', true), 'Took this case', 'the timeline wording comes back');

SELECT set_config('request.jwt.claim.sub', '13000000-0000-0000-0000-0000000011a1', true);
SELECT throws_ok(
  $$ SELECT * FROM public.take_case('25000000-0000-0000-0000-0000000011a1', '25030000-0000-0000-0000-0000000011a1') $$,
  'P0001',
  'Already taken by Maya Member',
  'a colleague cannot take a lead Maya already has, and is told who has it'
);
DO $$
DECLARE
  v_hint text;
  v_detail text;
BEGIN
  PERFORM * FROM public.take_case('25000000-0000-0000-0000-0000000011a1', NULL);
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_detail = PG_EXCEPTION_DETAIL;
  PERFORM set_config('test.take_hint', coalesce(v_hint, '') || '|' || coalesce(v_detail, ''), true);
END
$$;
SELECT is(
  current_setting('test.take_hint', true),
  'already_taken|12000000-0000-0000-0000-0000000011a1',
  'the refusal carries a stable hint and the current assignee''s id'
);

SELECT set_config('request.jwt.claim.sub', '12000000-0000-0000-0000-0000000011a1', true);
SELECT lives_ok(
  $$ SELECT set_config('test.take2', event_body, true)
       FROM public.take_case('25000000-0000-0000-0000-0000000011a1', '25020000-0000-0000-0000-0000000011a1') $$,
  'taking a case you already have succeeds'
);
SELECT lives_ok(
  $$ SELECT set_config('test.take3', event_body, true)
       FROM public.take_case('25000000-0000-0000-0000-0000000011a1', '25010000-0000-0000-0000-0000000011a1') $$,
  'a replay of the original take succeeds'
);
SELECT is(
  current_setting('test.take2', true) || '|' || current_setting('test.take3', true),
  '|Took this case',
  'a second take writes nothing (empty wording); the replay returns its own entry''s wording'
);
SELECT throws_ok(
  $$ SELECT * FROM public.take_case('25900000-0000-0000-0000-0000000011a1', NULL) $$,
  'P0002', 'Case not found',
  'an unknown case is not found'
);
RESET ROLE;
SELECT is(
  (SELECT c.assigned_to::text || '|' || (SELECT string_agg(e.id::text || ':' || e.actor_id::text, ',') FROM public.case_events e
                                          WHERE e.case_id = c.id AND e.body = 'Took this case')
     FROM public.cases c WHERE c.id = '25000000-0000-0000-0000-0000000011a1'),
  '12000000-0000-0000-0000-0000000011a1|25010000-0000-0000-0000-0000000011a1:12000000-0000-0000-0000-0000000011a1',
  'the lead stays Maya''s with exactly one "Took this case" entry, by her'
);

-- ===========================================================================
-- 18. Replay-safe lead and case creation
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-0000000011a1', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$ SELECT set_config('test.lead1', public.create_lead('11000000-0000-0000-0000-0000000011a1'::uuid,
       '{"id":"26000000-0000-0000-0000-0000000011a1","contact_id":"26100000-0000-0000-0000-0000000011a1","follow_up_id":"26200000-0000-0000-0000-0000000011a1","caller_name":"Rosa Diaz","phone":"(541) 555-0190","about_relationship":"son","about_first_name":"Leo"}'::jsonb)::text, true) $$,
  'a quick-add lead is created'
);
SELECT lives_ok(
  $$ SELECT set_config('test.lead2', public.create_lead('11000000-0000-0000-0000-0000000011a1'::uuid,
       '{"id":"26000000-0000-0000-0000-0000000011a1","contact_id":"26100000-0000-0000-0000-0000000011a1","follow_up_id":"26200000-0000-0000-0000-0000000011a1","caller_name":"Rosa Diaz","phone":"(541) 555-0190","about_relationship":"son","about_first_name":"Leo"}'::jsonb)::text, true) $$,
  'a retry after a timeout (the first call had committed) succeeds'
);
SELECT is(current_setting('test.lead2', true), '26000000-0000-0000-0000-0000000011a1', 'the retry returns the same case');
SELECT lives_ok(
  $$ SELECT public.create_case_bundle('11000000-0000-0000-0000-0000000011a1'::uuid,
       '{"id":"27000000-0000-0000-0000-0000000011a1","title":"Bundle family"}'::jsonb,
       '{"id":"27100000-0000-0000-0000-0000000011a1","name":"Ana","is_primary":true}'::jsonb,
       '{"id":"27200000-0000-0000-0000-0000000011a1","title":"First call","due_on":"2026-10-25"}'::jsonb) $$,
  'a case is created with its contact and first step'
);
SELECT lives_ok(
  $$ SELECT public.create_case_bundle('11000000-0000-0000-0000-0000000011a1'::uuid,
       '{"id":"27000000-0000-0000-0000-0000000011a1","title":"Bundle family"}'::jsonb,
       '{"id":"27100000-0000-0000-0000-0000000011a1","name":"Ana","is_primary":true}'::jsonb,
       '{"id":"27200000-0000-0000-0000-0000000011a1","title":"First call","due_on":"2026-10-25"}'::jsonb) $$,
  'a retry of the same case creation succeeds'
);
RESET ROLE;
SELECT is(
  (SELECT string_agg(k || '=' || n::text, ',' ORDER BY k) FROM (
     SELECT 'cases' AS k, count(*) AS n FROM public.cases WHERE id IN ('26000000-0000-0000-0000-0000000011a1', '27000000-0000-0000-0000-0000000011a1')
     UNION ALL SELECT 'contacts', count(*) FROM public.case_contacts WHERE case_id IN ('26000000-0000-0000-0000-0000000011a1', '27000000-0000-0000-0000-0000000011a1')
     UNION ALL SELECT 'events', count(*) FROM public.case_events WHERE case_id IN ('26000000-0000-0000-0000-0000000011a1', '27000000-0000-0000-0000-0000000011a1')
     UNION ALL SELECT 'follow_ups', count(*) FROM public.follow_ups WHERE case_id IN ('26000000-0000-0000-0000-0000000011a1', '27000000-0000-0000-0000-0000000011a1')
   ) AS t),
  'cases=2,contacts=2,events=1,follow_ups=2',
  'the retries wrote nothing: one case, contact and first step each, one lead timeline entry'
);

SELECT set_config('request.jwt.claim.sub', '16000000-0000-0000-0000-0000000011a1', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.create_lead('16000000-0000-0000-0000-0000000011a1'::uuid,
       '{"id":"26000000-0000-0000-0000-0000000011a1","caller_name":"Someone Else","phone":"(541) 555-0191"}'::jsonb) $$,
  '23505', NULL,
  'another workspace''s case id still fails'
);
SELECT throws_ok(
  $$ SELECT public.create_case_bundle('16000000-0000-0000-0000-0000000011a1'::uuid,
       '{"id":"27000000-0000-0000-0000-0000000011a1","title":"Other practice"}'::jsonb, NULL, NULL) $$,
  '23505', NULL,
  'and so does another workspace''s id for a case bundle'
);
RESET ROLE;

-- ===========================================================================
-- 19. A VOB answer completes that program's waiting-on steps
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-0000000011a1', true);
SET LOCAL ROLE authenticated;
INSERT INTO public.cases (id, title) VALUES
  ('28000000-0000-0000-0000-0000000011a1', 'Insurance family'),
  ('28600000-0000-0000-0000-0000000011a1', 'Second insurance family');
SELECT id FROM public.request_vob('{"id":"28100000-0000-0000-0000-0000000011a1","case_id":"28000000-0000-0000-0000-0000000011a1","program_name":"Hazelden Springbrook","follow_up_id":"28200000-0000-0000-0000-0000000011a1","event_id":"28300000-0000-0000-0000-0000000011a1"}'::jsonb);
-- "Still waiting": the chase is done and a new waiting-on step follows.
SELECT public.complete_follow_up_with_next(
  '{"id":"28200000-0000-0000-0000-0000000011a1","status":"done","completed_at":"2026-10-24T17:00:00Z"}'::jsonb,
  '{"id":"28400000-0000-0000-0000-0000000011a1","case_id":"28000000-0000-0000-0000-0000000011a1","title":"Check - Hazelden Springbrook","due_on":"2026-10-27","status":"open","kind":"waiting_on","waiting_on":"Hazelden Springbrook"}'::jsonb,
  NULL);
INSERT INTO public.follow_ups (id, case_id, title, due_on, kind, waiting_on) VALUES
  ('28500000-0000-0000-0000-0000000011a1', '28000000-0000-0000-0000-0000000011a1', 'Check - the wife', CURRENT_DATE, 'waiting_on', 'The wife'),
  ('28700000-0000-0000-0000-0000000011a1', '28600000-0000-0000-0000-0000000011a1', 'Check - Hazelden', CURRENT_DATE, 'waiting_on', 'Hazelden Springbrook');
SELECT lives_ok(
  $$ SELECT * FROM public.update_vob_status('28100000-0000-0000-0000-0000000011a1', '{"status":"in_network"}'::jsonb, '28800000-0000-0000-0000-0000000011a1') $$,
  'the program answers: in-network'
);
RESET ROLE;
SELECT is(
  (SELECT string_agg(id::text || '=' || status, ', ' ORDER BY id) FROM public.follow_ups
    WHERE id IN ('28200000-0000-0000-0000-0000000011a1', '28400000-0000-0000-0000-0000000011a1',
                 '28500000-0000-0000-0000-0000000011a1', '28700000-0000-0000-0000-0000000011a1')),
  '28200000-0000-0000-0000-0000000011a1=done, 28400000-0000-0000-0000-0000000011a1=done, 28500000-0000-0000-0000-0000000011a1=open, 28700000-0000-0000-0000-0000000011a1=open',
  'the answer completes the open waiting-on step for that program on that case, and nothing else'
);
SELECT ok(
  (SELECT completed_at IS NOT NULL AND completed_by = '11000000-0000-0000-0000-0000000011a1'
     FROM public.follow_ups WHERE id = '28400000-0000-0000-0000-0000000011a1'),
  'the follow-on step is stamped as completed by the member who recorded the answer'
);

-- ===========================================================================
-- 20. Realtime, codes, and the bed push throttle
-- ===========================================================================

SELECT is(
  (SELECT (pubinsert, pubupdate, pubdelete, pubtruncate)::text FROM pg_publication WHERE pubname = 'supabase_realtime'),
  '(t,t,f,f)',
  'realtime publishes inserts and updates only: no deleted membership row reaches another workspace'
);
SELECT is(
  (SELECT string_agg(schemaname || '.' || tablename, ',') FROM pg_publication_tables WHERE pubname = 'supabase_realtime'),
  'public.org_members',
  'org_members is the only table in the realtime publication'
);

SET LOCAL ROLE authenticated;
SELECT set_config('test.code_a', code, true) FROM public.create_org_invite();
RESET ROLE;
INSERT INTO public.global_partners (id, name, organization, types, phone, status)
VALUES ('29100000-0000-0000-0000-0000000011a1', 'Intake', 'Claimable Recovery', ARRAY['Inpatient'], '(541) 555-0193', 'active');
SELECT set_config('request.jwt.claim.sub', '18000000-0000-0000-0000-0000000011a1', true);
SET LOCAL ROLE authenticated;
SELECT set_config('test.code_c', code, true) FROM public.create_center_claim_code('29100000-0000-0000-0000-0000000011a1');
RESET ROLE;
SELECT ok(
  current_setting('test.code_a') ~ '^[0-9a-f]{16}$' AND current_setting('test.code_c') ~ '^[0-9a-f]{16}$',
  'invite and claim codes are 16 hex characters'
);

INSERT INTO public.global_partners (id, name, organization, types, phone, status)
VALUES ('29000000-0000-0000-0000-0000000011a1', 'Admissions', 'Throttle Ridge Recovery', ARRAY['Inpatient'], '(541) 555-0192', 'active');
SELECT set_config('request.jwt.claim.sub', '16000000-0000-0000-0000-0000000011a1', true);
SET LOCAL ROLE authenticated;
SELECT public.import_global_partner('29000000-0000-0000-0000-0000000011a1', '29200000-0000-0000-0000-0000000011a1');
SELECT public.register_push_token('ExponentPushToken[r11bowner001]', 'ios', -420);
INSERT INTO public.notification_preferences (user_id, push_enabled, bed_opened) VALUES ('16000000-0000-0000-0000-0000000011a1', true, true);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT is(public.notify_bed_followers('29000000-0000-0000-0000-0000000011a1', NULL), 1, 'a bed opening reaches the follower');
UPDATE public.notification_outbox SET sent_at = now() WHERE kind = 'bed_opened';
SELECT is(public.notify_bed_followers('29000000-0000-0000-0000-0000000011a1', NULL), 0,
  'the same listing opening again within six hours queues nothing');
UPDATE public.notification_outbox SET created_at = now() - interval '7 hours' WHERE kind = 'bed_opened';
SELECT is(public.notify_bed_followers('29000000-0000-0000-0000-0000000011a1', NULL), 1,
  'six hours later an opening notifies again');

-- ===========================================================================
-- 21. Intake: a flooded link still keeps a family's lead, with no push
-- ===========================================================================

SELECT set_config('test.intake_token', intake_token, true) FROM public.orgs WHERE id = current_setting('test.org_i')::uuid;
SELECT set_config('request.jwt.claim.sub', '17000000-0000-0000-0000-0000000011a1', true);
SET LOCAL ROLE authenticated;
SELECT public.register_push_token('ExponentPushToken[r11intake001]', 'ios', -420);
INSERT INTO public.notification_preferences (user_id, push_enabled) VALUES ('17000000-0000-0000-0000-0000000011a1', true);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

SET LOCAL ROLE service_role;
SELECT lives_ok(
  $$ SELECT set_config('test.spam_case', public.create_lead_from_intake(current_setting('test.intake_token'),
       '{"caller_name":"Flood Sender","phone":"5415550100","urgency":"immediate_danger","lead_source":"Website","lead_source_detail":"Intake link","suspected_spam":true}'::jsonb)::text, true) $$,
  'a lead past the link''s hourly budget is still created'
);
SELECT lives_ok(
  $$ SELECT set_config('test.real_case', public.create_lead_from_intake(current_setting('test.intake_token'),
       '{"caller_name":"Real Family","phone":"5415550101","urgency":"none","lead_source":"Website","lead_source_detail":"Intake link"}'::jsonb)::text, true) $$,
  'a normal intake lead is created'
);
RESET ROLE;
SELECT ok(
  (SELECT summary LIKE 'Caller reported immediate danger when this lead arrived.%'
          AND summary LIKE '%Possible spam%' AND lead_urgency = 'immediate_danger' AND lead_channel = 'intake_link'
     FROM public.cases WHERE id = nullif(current_setting('test.spam_case', true), '')::uuid),
  'the flooded lead is marked possible spam and keeps its immediate-danger flag'
);
SELECT is(
  (SELECT count(*) FILTER (WHERE data ->> 'case_id' = current_setting('test.spam_case', true))::text || '|'
          || count(*) FILTER (WHERE data ->> 'case_id' = current_setting('test.real_case', true))::text
     FROM public.notification_outbox WHERE kind = 'new_lead' AND user_id = '17000000-0000-0000-0000-0000000011a1'),
  '0|1',
  'the possible-spam lead queues no push; a normal one still does'
);
SELECT ok(
  (SELECT summary NOT LIKE '%spam%' FROM public.cases WHERE id = nullif(current_setting('test.real_case', true), '')::uuid)
  AND coalesce(current_setting('referralfit.lead_push', true), '') = '',
  'a normal lead carries no spam note, and the push switch is back to its default'
);

-- ===========================================================================
-- 17. Leaving a workspace drops your favorites there
-- ===========================================================================

INSERT INTO public.global_partners (id, name, organization, types, phone, status)
VALUES ('2a000000-0000-0000-0000-0000000011a1', 'Admissions', 'Favorite Pines Recovery', ARRAY['Inpatient'], '(541) 555-0194', 'active');
SELECT set_config('request.jwt.claim.sub', '12000000-0000-0000-0000-0000000011a1', true);
SET LOCAL ROLE authenticated;
SELECT public.toggle_user_favorite('global_partner', '2a000000-0000-0000-0000-0000000011a1');
SELECT set_config('request.jwt.claim.sub', '13000000-0000-0000-0000-0000000011a1', true);
SELECT public.toggle_user_favorite('global_partner', '2a000000-0000-0000-0000-0000000011a1');

SELECT set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-0000000011a1', true);
SELECT lives_ok($$ SELECT public.remove_org_member('12000000-0000-0000-0000-0000000011a1') $$, 'the owner removes Maya');
SELECT set_config('request.jwt.claim.sub', '16000000-0000-0000-0000-0000000011a1', true);
SELECT set_config('test.invite_b', code, true) FROM public.create_org_invite();
SELECT set_config('request.jwt.claim.sub', '13000000-0000-0000-0000-0000000011a1', true);
SELECT lives_ok($$ SELECT public.accept_org_invite(current_setting('test.invite_b')) $$, 'Theo leaves for practice B');
RESET ROLE;

SELECT is(
  (SELECT count(*)::integer FROM public.user_favorites WHERE org_id = current_setting('test.org_a')::uuid),
  0,
  'neither departed member leaves a favorite behind in practice A'
);

SELECT set_config('request.jwt.claim.sub', '12000000-0000-0000-0000-0000000011a1', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$ SELECT set_config('test.fav_m1', public.toggle_user_favorite('global_partner', '2a000000-0000-0000-0000-0000000011a1')::text, true) $$,
  'the removed member can favorite the same listing in their own workspace'
);
SELECT set_config('request.jwt.claim.sub', '13000000-0000-0000-0000-0000000011a1', true);
SELECT lives_ok(
  $$ SELECT set_config('test.fav_m2', public.toggle_user_favorite('global_partner', '2a000000-0000-0000-0000-0000000011a1')::text, true) $$,
  'the member who joined practice B can favorite it there'
);
RESET ROLE;
SELECT is(
  current_setting('test.fav_m1', true) || '|' || current_setting('test.fav_m2', true),
  'true|true',
  'both toggles add the favorite (no duplicate-key error)'
);
SELECT ok(
  NOT EXISTS (SELECT 1 FROM public.user_favorites
               WHERE org_id = current_setting('test.org_a')::uuid AND target_id = '2a000000-0000-0000-0000-0000000011a1')
  AND (SELECT count(DISTINCT org_id)::integer FROM public.user_favorites WHERE target_id = '2a000000-0000-0000-0000-0000000011a1') = 2,
  'practice A no longer follows the listing through a departed member; each member follows it from their new workspace'
);

SELECT * FROM finish();
ROLLBACK;
