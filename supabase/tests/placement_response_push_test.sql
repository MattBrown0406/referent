-- Focused coverage for 20261106120000_placement_response_push.sql: a push
-- when a program answers a placement request, and the scheduler reading
-- Vault. Run after a local migration reset with: supabase test db
--
-- This file is never pasted into production.

BEGIN;
SELECT plan(22);

-- p1 owns practice P and sends the request; p2 is a teammate; c1 is the
-- center that claimed listing L1 (answers in the portal); L2 is unclaimed
-- (the practitioner logs its answer).
INSERT INTO auth.users (id, email)
VALUES
  ('c1000000-0000-0000-0000-0000000000b8', 'push-c1@example.test'),
  ('b1000000-0000-0000-0000-0000000000b8', 'push-p1@example.test'),
  ('b2000000-0000-0000-0000-0000000000b8', 'push-p2@example.test');
SELECT set_config('test.org_p', org_id::text, true) FROM public.org_members WHERE user_id = 'b1000000-0000-0000-0000-0000000000b8';
UPDATE public.org_members SET org_id = current_setting('test.org_p')::uuid, role = 'member', display_name = 'Teammate'
 WHERE user_id = 'b2000000-0000-0000-0000-0000000000b8';

INSERT INTO public.global_partners (id, name, organization, types, city, state, status, verified_at)
VALUES
  ('d1000000-0000-0000-0000-0000000000b8', 'Admissions', 'Juniper Ridge Recovery', ARRAY['Inpatient'], 'Bend', 'OR', 'active', now()),
  ('d2000000-0000-0000-0000-0000000000b8', 'Intake', 'Unclaimed Oaks', ARRAY['Inpatient'], 'Bend', 'OR', 'active', now());
INSERT INTO public.center_members (user_id, global_partner_id)
VALUES ('c1000000-0000-0000-0000-0000000000b8', 'd1000000-0000-0000-0000-0000000000b8');

-- Push is on for p1 and p2, each with a device.
INSERT INTO public.notification_preferences (user_id, push_enabled)
VALUES ('b1000000-0000-0000-0000-0000000000b8', true), ('b2000000-0000-0000-0000-0000000000b8', true);
INSERT INTO public.push_tokens (expo_push_token, user_id, platform)
VALUES ('ExponentPushToken[pushtestp1aaaa]', 'b1000000-0000-0000-0000-0000000000b8', 'ios'),
       ('ExponentPushToken[pushtestp2bbbb]', 'b2000000-0000-0000-0000-0000000000b8', 'ios');

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT public.import_global_partner('d1000000-0000-0000-0000-0000000000b8', 'e1000000-0000-0000-0000-0000000000b8');
SELECT public.import_global_partner('d2000000-0000-0000-0000-0000000000b8', 'e2000000-0000-0000-0000-0000000000b8');
INSERT INTO public.match_profiles (id, client_label, level_of_care, state, insurance)
VALUES ('f2000000-0000-0000-0000-0000000000b8', 'Push family', 'Inpatient', 'OR', 'Aetna');
SELECT public.create_placement_request('91000000-0000-0000-0000-0000000000b8', 'f2000000-0000-0000-0000-0000000000b8', NULL,
  ARRAY['e1000000-0000-0000-0000-0000000000b8', 'e2000000-0000-0000-0000-0000000000b8']::uuid[], 24, 'this_week', NULL);
RESET ROLE;

SELECT set_config('test.portal_recipient', id::text, true) FROM public.placement_request_recipients
 WHERE request_id = '91000000-0000-0000-0000-0000000000b8' AND channel = 'portal';
SELECT set_config('test.manual_recipient', id::text, true) FROM public.placement_request_recipients
 WHERE request_id = '91000000-0000-0000-0000-0000000000b8' AND channel = 'manual';

SELECT is((SELECT count(*)::integer FROM public.notification_outbox WHERE kind = 'placement_response'), 0,
  'sending a request queues nothing');

-- The practitioner logs the unclaimed program's answer: no push to themselves.
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT public.log_manual_response(current_setting('test.manual_recipient')::uuid, 'yes', 'yes', NULL, NULL, NULL, NULL);
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.notification_outbox WHERE kind = 'placement_response'), 0,
  'an answer the practitioner logged sends no push');

-- The center answers in the portal.
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT public.respond_to_placement_request(current_setting('test.portal_recipient')::uuid, 'yes', 'yes', NULL, NULL, NULL, NULL);
RESET ROLE;
SELECT is(
  (SELECT string_agg(user_id::text || ':' || title || ':' || (data ->> 'placement_request_id'), ',') FROM public.notification_outbox WHERE kind = 'placement_response'),
  'b1000000-0000-0000-0000-0000000000b8:A program answered:91000000-0000-0000-0000-0000000000b8',
  'a portal answer queues one push, for the practitioner who sent the request only'
);
SELECT ok(
  (SELECT body NOT ILIKE '%juniper%' AND body NOT ILIKE '%push family%' AND data::text NOT ILIKE '%juniper%'
          AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(data) AS k) = ARRAY['kind', 'placement_request_id', 'user_id']
     FROM public.notification_outbox WHERE kind = 'placement_response'),
  'the push names no program and no client; its data is the request id'
);

-- A changed answer before the next send folds into the same push.
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT public.respond_to_placement_request(current_setting('test.portal_recipient')::uuid, 'no', 'no', NULL, NULL, NULL, NULL);
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.notification_outbox WHERE kind = 'placement_response'), 1,
  'a changed answer before the send is the same one push');

-- Sent a minute ago: the program editing again within 15 minutes waits.
UPDATE public.notification_outbox SET sent_at = now() WHERE kind = 'placement_response';
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT public.respond_to_placement_request(current_setting('test.portal_recipient')::uuid, 'waitlist', 'no', NULL, NULL, NULL, NULL);
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.notification_outbox WHERE kind = 'placement_response' AND sent_at IS NULL), 0,
  'a program editing its answer within 15 minutes of the last push sends nothing more');

-- Queued long ago but sent a minute ago: still within the quiet time.
UPDATE public.notification_outbox SET created_at = now() - interval '20 minutes', sent_at = now() - interval '1 minute'
 WHERE kind = 'placement_response';
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT public.respond_to_placement_request(current_setting('test.portal_recipient')::uuid, 'no', 'maybe', NULL, NULL, NULL, NULL);
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.notification_outbox WHERE kind = 'placement_response' AND sent_at IS NULL), 0,
  'the quiet time counts from the last push sent, not queued');

-- Later than that, a changed answer is news again.
UPDATE public.notification_outbox SET created_at = now() - interval '20 minutes', sent_at = now() - interval '20 minutes'
 WHERE kind = 'placement_response';
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT public.respond_to_placement_request(current_setting('test.portal_recipient')::uuid, 'yes', 'maybe', NULL, NULL, NULL, NULL);
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.notification_outbox WHERE kind = 'placement_response' AND sent_at IS NULL), 1,
  'a changed answer after the quiet time queues a new push');

-- The same answer saved again is not news.
UPDATE public.notification_outbox SET sent_at = now() - interval '20 minutes', created_at = now() - interval '20 minutes' WHERE kind = 'placement_response';
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT public.respond_to_placement_request(current_setting('test.portal_recipient')::uuid, 'yes', 'maybe', NULL, NULL, NULL, NULL);
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.notification_outbox WHERE kind = 'placement_response' AND sent_at IS NULL), 0,
  'saving the same answer again sends nothing');

-- Turned off: nothing.
DELETE FROM public.notification_outbox WHERE kind = 'placement_response';
UPDATE public.notification_preferences SET placement_response = false WHERE user_id = 'b1000000-0000-0000-0000-0000000000b8';
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT public.respond_to_placement_request(current_setting('test.portal_recipient')::uuid, 'waitlist', 'maybe', NULL, NULL, NULL, NULL);
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.notification_outbox WHERE kind = 'placement_response'), 0,
  'the practitioner who turned it off gets nothing');
UPDATE public.notification_preferences SET placement_response = true WHERE user_id = 'b1000000-0000-0000-0000-0000000000b8';

-- The practitioner answering as the program themselves: no push to them.
UPDATE public.placement_request_recipients SET responded_by = 'b1000000-0000-0000-0000-0000000000b8', bed_available = 'no'
 WHERE id = current_setting('test.portal_recipient')::uuid;
SELECT is((SELECT count(*)::integer FROM public.notification_outbox WHERE kind = 'placement_response'), 0,
  'an answer the sender gave themselves sends no push');
UPDATE public.placement_request_recipients SET responded_by = 'c1000000-0000-0000-0000-0000000000b8'
 WHERE id = current_setting('test.portal_recipient')::uuid;

-- Left the workspace: nothing. (x1 has a workspace of their own, not P.)
INSERT INTO auth.users (id, email) VALUES ('a9000000-0000-0000-0000-0000000000b8', 'push-x1@example.test');
UPDATE public.placement_requests SET created_by = 'a9000000-0000-0000-0000-0000000000b8'
 WHERE id = '91000000-0000-0000-0000-0000000000b8';
INSERT INTO public.notification_preferences (user_id, push_enabled) VALUES ('a9000000-0000-0000-0000-0000000000b8', true);
INSERT INTO public.push_tokens (expo_push_token, user_id, platform)
VALUES ('ExponentPushToken[pushtestx1dddd]', 'a9000000-0000-0000-0000-0000000000b8', 'ios');
UPDATE public.placement_request_recipients SET bed_available = 'yes'
 WHERE id = current_setting('test.portal_recipient')::uuid;
SELECT is((SELECT count(*)::integer FROM public.notification_outbox WHERE kind = 'placement_response'), 0,
  'a sender who left the workspace gets nothing');
UPDATE public.placement_requests SET created_by = 'b1000000-0000-0000-0000-0000000000b8'
 WHERE id = '91000000-0000-0000-0000-0000000000b8';

-- Closed before the push went out: it is dropped, and later answers send nothing.
UPDATE public.placement_request_recipients SET bed_available = 'waitlist'
 WHERE id = current_setting('test.portal_recipient')::uuid;
SELECT is((SELECT count(*)::integer FROM public.notification_outbox WHERE kind = 'placement_response' AND sent_at IS NULL), 1,
  '(a push is waiting)');
-- Two more like it: one being sent right now, one whose send stalled
-- 10 minutes ago (its claim has lapsed; it would be sent again).
INSERT INTO public.notification_outbox (user_id, kind, title, body, data, claimed_at)
SELECT user_id, kind, title, body, data || jsonb_build_object('copy', n), now() - make_interval(mins => m)
  FROM public.notification_outbox, (VALUES (1, 0), (2, 10)) AS v(n, m)
 WHERE kind = 'placement_response' AND claimed_at IS NULL;
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000b8', true);
SET LOCAL ROLE authenticated;
SELECT public.close_placement_request('91000000-0000-0000-0000-0000000000b8');
RESET ROLE;
SELECT is((SELECT string_agg(coalesce(data ->> 'copy', 'queued'), ',') FROM public.notification_outbox WHERE kind = 'placement_response'), '1',
  'closing the request drops the pushes not yet sent, a stalled send too; one being sent right now is left to the sender');
DELETE FROM public.notification_outbox WHERE kind = 'placement_response';
UPDATE public.placement_request_recipients SET bed_available = 'yes'
 WHERE id = current_setting('test.portal_recipient')::uuid;
SELECT is((SELECT count(*)::integer FROM public.notification_outbox WHERE kind = 'placement_response'), 0,
  'and an answer changed after closing sends nothing');
SELECT ok(
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'placement_requests_deleted_drop_pushes' AND tgrelid = 'public.placement_requests'::regclass),
  'deleting a request drops its unsent pushes too'
);

-- ===========================================================================
-- Schema and grants
-- ===========================================================================

SELECT ok(
  (SELECT column_default = 'true' AND is_nullable = 'NO' FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'notification_preferences' AND column_name = 'placement_response'),
  'placement_response is on by default and never null'
);
SELECT ok(
  pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'notification_outbox_kind_check')) LIKE '%placement_response%'
  AND pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'notification_outbox_kind_check')) LIKE '%bed_opened%',
  'the outbox takes the new kind and keeps the old ones'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.placement_answer_notify()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.placement_answer_notify()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.push_dispatch_setting(text)', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.push_dispatch_setting(text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.notify_enqueue(uuid, text, jsonb)', 'EXECUTE'),
  'no client can run the trigger, read the scheduler secret or queue a push'
);
SELECT is(
  (SELECT tgenabled::text FROM pg_trigger WHERE tgname = 'placement_request_recipients_answer_notify'),
  'O',
  'the answer trigger is on'
);

-- The scheduler: nothing set means nothing posted.
SELECT is(public.push_dispatch_setting('referralfit_push_dispatch_secret_not_there'), '', 'a missing Vault secret reads as empty');
SELECT is(public.push_dispatch_tick(), false, 'without an address and a secret the tick posts nothing');

SELECT * FROM finish();
ROLLBACK;
