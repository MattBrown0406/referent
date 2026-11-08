-- Focused coverage for 20261108120000_email_alerts.sql: the answer email,
-- the morning summary, the weekly bed check-in and its link, unsubscribe,
-- the app's settings, and the dispatcher's RPCs. Run after a local
-- migration reset with: supabase test db
--
-- This file is never pasted into production.

BEGIN;
SELECT plan(57);

-- p1 owns practice P and sends the request (push on, with a device); c1 is
-- the center that claimed program listing L1; c2 claimed L3, which is not a
-- program (no beds); L2 is unclaimed (the practitioner logs its answer).
INSERT INTO auth.users (id, email)
VALUES
  ('c1000000-0000-0000-0000-0000000000e8', 'mail-c1@example.test'),
  ('c2000000-0000-0000-0000-0000000000e8', 'mail-c2@example.test'),
  ('b1000000-0000-0000-0000-0000000000e8', 'mail-p1@example.test'),
  ('b2000000-0000-0000-0000-0000000000e8', 'mail-p2@example.test');
SELECT set_config('test.org_p', org_id::text, true) FROM public.org_members WHERE user_id = 'b1000000-0000-0000-0000-0000000000e8';

INSERT INTO public.global_partners (id, name, organization, types, city, state, status, verified_at)
VALUES
  ('d1000000-0000-0000-0000-0000000000e8', 'Admissions', 'Juniper Ridge Recovery', ARRAY['Inpatient'], 'Bend', 'OR', 'active', now()),
  ('d2000000-0000-0000-0000-0000000000e8', 'Intake', 'Unclaimed Oaks', ARRAY['Inpatient'], 'Bend', 'OR', 'active', now()),
  ('d3000000-0000-0000-0000-0000000000e8', 'Dana Price', '', ARRAY['Therapist'], 'Bend', 'OR', 'active', now());
INSERT INTO public.center_members (user_id, global_partner_id)
VALUES ('c1000000-0000-0000-0000-0000000000e8', 'd1000000-0000-0000-0000-0000000000e8'),
       ('c2000000-0000-0000-0000-0000000000e8', 'd3000000-0000-0000-0000-0000000000e8');

INSERT INTO public.notification_preferences (user_id, push_enabled) VALUES ('b1000000-0000-0000-0000-0000000000e8', true);
INSERT INTO public.push_tokens (expo_push_token, user_id, platform)
VALUES ('ExponentPushToken[mailtestp1aaaa]', 'b1000000-0000-0000-0000-0000000000e8', 'ios');

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000e8', true);
SET LOCAL ROLE authenticated;
SELECT public.import_global_partner('d1000000-0000-0000-0000-0000000000e8', 'e1000000-0000-0000-0000-0000000000e8');
SELECT public.import_global_partner('d2000000-0000-0000-0000-0000000000e8', 'e2000000-0000-0000-0000-0000000000e8');
INSERT INTO public.match_profiles (id, client_label, level_of_care, state, insurance)
VALUES ('f2000000-0000-0000-0000-0000000000e8', 'Mail family', 'Inpatient', 'OR', 'Aetna');
SELECT public.create_placement_request('91000000-0000-0000-0000-0000000000e8', 'f2000000-0000-0000-0000-0000000000e8', NULL,
  ARRAY['e1000000-0000-0000-0000-0000000000e8', 'e2000000-0000-0000-0000-0000000000e8']::uuid[], 24, 'this_week', NULL);
RESET ROLE;

SELECT set_config('test.portal_recipient', id::text, true) FROM public.placement_request_recipients
 WHERE request_id = '91000000-0000-0000-0000-0000000000e8' AND channel = 'portal';
SELECT set_config('test.manual_recipient', id::text, true) FROM public.placement_request_recipients
 WHERE request_id = '91000000-0000-0000-0000-0000000000e8' AND channel = 'manual';

-- ===========================================================================
-- A. The answer email
-- ===========================================================================

SELECT is((SELECT count(*)::integer FROM public.email_outbox), 0, 'sending a request queues no email');

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000e8', true);
SET LOCAL ROLE authenticated;
SELECT public.log_manual_response(current_setting('test.manual_recipient')::uuid, 'yes', 'yes', NULL, NULL, NULL, NULL);
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.email_outbox), 0, 'an answer the practitioner logged sends no email');

SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000e8', true);
SET LOCAL ROLE authenticated;
SELECT public.respond_to_placement_request(current_setting('test.portal_recipient')::uuid, 'yes', 'yes', NULL, NULL, NULL, NULL);
RESET ROLE;
SELECT is(
  (SELECT string_agg(user_id::text || ':' || kind || ':' || data::text, ',') FROM public.email_outbox),
  'b1000000-0000-0000-0000-0000000000e8:placement_response:{"placement_request_id": "91000000-0000-0000-0000-0000000000e8"}',
  'a portal answer queues one email for the sender, carrying only the request id'
);
SELECT ok((SELECT not_before > now() + interval '100 seconds' FROM public.email_outbox),
  'the email waits two minutes so answers arriving together make one email');
SELECT is((SELECT count(*)::integer FROM public.notification_outbox WHERE kind = 'placement_response'), 1,
  'the push is still queued as before');

SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000e8', true);
SET LOCAL ROLE authenticated;
SELECT public.respond_to_placement_request(current_setting('test.portal_recipient')::uuid, 'no', 'no', NULL, NULL, NULL, NULL);
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.email_outbox), 1, 'a changed answer before the send folds into the same email');

-- The push was just sent (its quiet time is on) but the email was sent long
-- ago: the email is news, the push is not.
UPDATE public.notification_outbox SET sent_at = now() WHERE kind = 'placement_response';
UPDATE public.email_outbox SET sent_at = now() - interval '20 minutes', created_at = now() - interval '20 minutes';
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000e8', true);
SET LOCAL ROLE authenticated;
SELECT public.respond_to_placement_request(current_setting('test.portal_recipient')::uuid, 'waitlist', 'maybe', NULL, NULL, NULL, NULL);
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.email_outbox WHERE sent_at IS NULL), 1,
  'a push held back by its quiet time does not hold back the email');
SELECT is((SELECT count(*)::integer FROM public.notification_outbox WHERE kind = 'placement_response' AND sent_at IS NULL), 0,
  'and the push keeps its own quiet time');

UPDATE public.email_outbox SET sent_at = now() WHERE sent_at IS NULL;
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000e8', true);
SET LOCAL ROLE authenticated;
SELECT public.respond_to_placement_request(current_setting('test.portal_recipient')::uuid, 'yes', 'maybe', NULL, NULL, NULL, NULL);
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.email_outbox WHERE sent_at IS NULL), 0,
  'a program editing within 15 minutes of the last email sends no more email');

-- ===========================================================================
-- B. The app's settings
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000e8', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT row(placement_response, daily_summary, bed_reminder)::text FROM public.get_email_preferences()), '(t,f,t)',
  'defaults: answers on, morning summary off, bed check-in on');
SELECT is((SELECT row(placement_response, daily_summary, bed_reminder)::text FROM public.set_email_preferences(false, true, -300)), '(f,t,t)',
  'set_email_preferences saves both choices');
SELECT is((SELECT row(placement_response, daily_summary, bed_reminder)::text FROM public.set_email_preferences(NULL, NULL, NULL)), '(f,t,t)',
  'a null argument keeps that choice');
SELECT throws_ok($$ SELECT * FROM public.set_email_preferences(NULL, NULL, 900) $$, '22023', NULL, 'an impossible time zone is refused');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT throws_ok($$ SELECT * FROM public.get_email_preferences() $$, '42501', NULL, 'signed out cannot read email settings');
RESET ROLE;

DELETE FROM public.email_outbox;
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000e8', true);
SET LOCAL ROLE authenticated;
SELECT public.respond_to_placement_request(current_setting('test.portal_recipient')::uuid, 'no', 'maybe', NULL, NULL, NULL, NULL);
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.email_outbox), 0, 'answer emails turned off: nothing queued');

-- Back on, an email queued, then turned off again: the waiting email goes.
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000e8', true);
SET LOCAL ROLE authenticated;
SELECT public.set_email_preferences(true, NULL, NULL);
RESET ROLE;
SELECT public.email_enqueue('b1000000-0000-0000-0000-0000000000e8', 'placement_response',
  jsonb_build_object('placement_request_id', '91000000-0000-0000-0000-0000000000e8'));
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000e8', true);
SET LOCAL ROLE authenticated;
SELECT public.set_email_preferences(false, NULL, NULL);
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.email_outbox), 0, 'turning answers off drops an answer email not yet sent');
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000e8', true);
SET LOCAL ROLE authenticated;
SELECT public.set_email_preferences(true, false, NULL);
RESET ROLE;

-- ===========================================================================
-- C. The dispatcher
-- ===========================================================================

SELECT public.email_enqueue('b1000000-0000-0000-0000-0000000000e8', 'placement_response',
  jsonb_build_object('placement_request_id', '91000000-0000-0000-0000-0000000000e8'), now() + interval '2 minutes');
SET LOCAL ROLE service_role;
SELECT is((SELECT count(*)::integer FROM public.email_outbox_claim(10)), 0, 'an email held for two minutes is not claimed yet');
RESET ROLE;
UPDATE public.email_outbox SET not_before = now() - interval '1 second';
SET LOCAL ROLE service_role;
CREATE TEMP TABLE claimed ON COMMIT DROP AS SELECT * FROM public.email_outbox_claim(10);
RESET ROLE;
SELECT is((SELECT email FROM claimed), 'mail-p1@example.test', 'the claim brings the address');
SELECT is((SELECT (data ->> 'asked') || '/' || (data ->> 'answered') FROM claimed), '2/2',
  'and fresh counts: programs asked and programs answered');
SELECT ok((SELECT unsubscribe_token ~ '^[0-9a-f]{64}$' FROM claimed), 'and the unsubscribe token');
SELECT ok((SELECT data::text NOT ILIKE '%juniper%' AND data::text NOT ILIKE '%mail family%' FROM claimed),
  'an answer email names no program and no client');
SET LOCAL ROLE service_role;
SELECT is((SELECT count(*)::integer FROM public.email_outbox_claim(10)), 0, 'a row claimed in the last five minutes is left alone');
SELECT public.email_outbox_record(jsonb_build_array(jsonb_build_object('id', (SELECT id FROM claimed), 'error', 'resend_503', 'retry', true)));
RESET ROLE;
SELECT is((SELECT coalesce(error, '') || '|' || coalesce(last_error, '') FROM public.email_outbox), '|resend_503',
  'a retryable failure stays waiting with its reason');
SET LOCAL ROLE service_role;
SELECT public.email_outbox_record(jsonb_build_array(jsonb_build_object('id', (SELECT id FROM claimed), 'provider_id', 're_123')));
RESET ROLE;
SELECT ok((SELECT sent_at IS NOT NULL AND provider_id = 're_123' AND last_error IS NULL FROM public.email_outbox), 'a send is recorded');

-- A request closed before its email went out: dropped at claim.
DELETE FROM public.email_outbox;
SELECT public.email_enqueue('b1000000-0000-0000-0000-0000000000e8', 'placement_response',
  jsonb_build_object('placement_request_id', '91000000-0000-0000-0000-0000000000e8'));
UPDATE public.placement_requests SET status = 'closed', closed_at = now() WHERE id = '91000000-0000-0000-0000-0000000000e8';
SET LOCAL ROLE service_role;
SELECT is((SELECT count(*)::integer FROM public.email_outbox_claim(10)), 0, 'a closed request sends no answer email');
RESET ROLE;
SELECT is((SELECT error FROM public.email_outbox), 'request_closed', 'and the row says why');

SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT * FROM public.email_outbox_claim(10) $$, '42501', NULL, 'a signed-in user cannot claim emails');
SELECT throws_ok($$ SELECT * FROM public.email_outbox $$, '42501', NULL, 'nor read the outbox');
SELECT throws_ok($$ SELECT * FROM public.email_preferences $$, '42501', NULL, 'nor read anyone''s email settings');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT throws_ok($$ SELECT * FROM public.listing_bed_links $$, '42501', NULL, 'the service role has no table grants either');
RESET ROLE;
SELECT is(public.email_dispatch_tick(), false, 'the tick does nothing without its Vault settings');

-- ===========================================================================
-- D. The morning summary
-- ===========================================================================

DELETE FROM public.email_outbox;
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000e8', true);
SET LOCAL ROLE authenticated;
INSERT INTO public.cases (id, title) VALUES ('a1100000-0000-0000-0000-0000000000e8', 'Summary family');
INSERT INTO public.follow_ups (id, case_id, title, due_on, kind)
VALUES ('a1300000-0000-0000-0000-0000000000e8', 'a1100000-0000-0000-0000-0000000000e8', 'Call back', CURRENT_DATE, 'follow_up'),
       ('a1400000-0000-0000-0000-0000000000e8', 'a1100000-0000-0000-0000-0000000000e8', 'Late call', CURRENT_DATE - 2, 'follow_up'),
       ('a1500000-0000-0000-0000-0000000000e8', 'a1100000-0000-0000-0000-0000000000e8', 'Next week', CURRENT_DATE + 7, 'follow_up');
RESET ROLE;
INSERT INTO public.cases (id, title, org_id, lead_captured_at)
VALUES ('a1200000-0000-0000-0000-0000000000e8', 'New caller', current_setting('test.org_p')::uuid, now());
SELECT is(public.email_daily_summary_counts('b1000000-0000-0000-0000-0000000000e8', CURRENT_DATE) - 'answers',
  jsonb_build_object('new_leads', 1, 'due_today', 1, 'overdue', 1), 'the summary counts leads, due today and past due');
SELECT ok(public.email_daily_summary_counts('b1000000-0000-0000-0000-0000000000e8', CURRENT_DATE)::text NOT ILIKE '%family%'
          AND public.email_daily_summary_counts('b1000000-0000-0000-0000-0000000000e8', CURRENT_DATE)::text NOT ILIKE '%caller%',
  'the summary is counts only');
SELECT is((public.email_daily_summary_counts('b2000000-0000-0000-0000-0000000000e8', CURRENT_DATE) ->> 'due_today')::integer, 0,
  'another practice''s follow-ups are not counted');

-- 7 AM for p1 now; p2 opted in too but has nothing due.
UPDATE public.email_preferences
   SET daily_summary = true,
       tz_offset_minutes = ((7 - extract(hour FROM (now() AT TIME ZONE 'UTC'))::integer + 24) % 24) * 60 - (CASE WHEN ((7 - extract(hour FROM (now() AT TIME ZONE 'UTC'))::integer + 24) % 24) > 14 THEN 1440 ELSE 0 END)
 WHERE user_id = 'b1000000-0000-0000-0000-0000000000e8';
INSERT INTO public.email_preferences (user_id, daily_summary, tz_offset_minutes)
SELECT 'b2000000-0000-0000-0000-0000000000e8', true, tz_offset_minutes FROM public.email_preferences WHERE user_id = 'b1000000-0000-0000-0000-0000000000e8';
SELECT is(public.notify_daily_summaries(), 1, 'at 7 AM local, one summary for the member with something due');
SELECT is((SELECT user_id::text FROM public.email_outbox WHERE kind = 'daily_summary'), 'b1000000-0000-0000-0000-0000000000e8',
  'nothing for a member with nothing due');
SELECT is(public.notify_daily_summaries(), 0, 'one summary a day');
UPDATE public.email_preferences SET daily_summary_sent_on = NULL,
       tz_offset_minutes = CASE WHEN tz_offset_minutes <= 600 THEN tz_offset_minutes + 180 ELSE tz_offset_minutes - 180 END
 WHERE user_id = 'b1000000-0000-0000-0000-0000000000e8';
SELECT is(public.notify_daily_summaries(), 0, 'not at another hour');

-- ===========================================================================
-- E. The weekly bed check-in and its link
-- ===========================================================================

SELECT is(public.notify_bed_reminders(), 1, 'a claimed program with beds never confirmed gets a check-in');
SELECT is((SELECT user_id::text FROM public.email_outbox WHERE kind = 'bed_reminder'), 'c1000000-0000-0000-0000-0000000000e8',
  'to its center account, not to the non-program listing''s');
SELECT is(public.notify_bed_reminders(), 0, 'at most one a week');

DELETE FROM public.email_outbox WHERE kind = 'daily_summary';
SET LOCAL ROLE service_role;
CREATE TEMP TABLE bed_claim ON COMMIT DROP AS SELECT * FROM public.email_outbox_claim(10);
RESET ROLE;
SELECT is((SELECT email || ':' || (data ->> 'listing_name') FROM bed_claim), 'mail-c1@example.test:Juniper Ridge Recovery',
  'the check-in names the program''s own listing, to the program');
SELECT ok((SELECT (data ->> 'link_token') ~ '^[0-9a-f]{64}$' FROM bed_claim), 'with a fresh private link');
SELECT set_config('test.bed_token', (SELECT data ->> 'link_token' FROM bed_claim), true);

SET LOCAL ROLE anon;
SELECT is((SELECT listing_name || ':' || coalesce(beds_male::text, 'unknown') FROM public.public_bed_link_open(current_setting('test.bed_token'))),
  'Juniper Ridge Recovery:unknown', 'signed out, the link opens the listing''s beds');
SELECT is((SELECT count(*)::integer FROM public.public_bed_link_open(repeat('0', 64))), 0, 'a made-up token opens nothing');
SELECT is((SELECT beds_male || '/' || beds_female FROM public.public_bed_link_save(current_setting('test.bed_token'), 3, 1, 'Ana', '541-555-0100')),
  '3/1', 'and saves new counts');
SELECT throws_ok($$ SELECT * FROM public.public_bed_link_save(repeat('0', 64), 1, 1, '', '') $$, 'P0002', 'This link is not active',
  'a made-up token saves nothing');
SELECT throws_ok(format($$ SELECT * FROM public.public_bed_link_save(%L, 1000, 1, '', '') $$, current_setting('test.bed_token')), '22023', NULL,
  'counts are checked as in the portal');
RESET ROLE;
SELECT ok((SELECT beds_updated_by = 'c1000000-0000-0000-0000-0000000000e8' AND admissions_contact_name = 'Ana'
             FROM public.global_partners WHERE id = 'd1000000-0000-0000-0000-0000000000e8'),
  'the save is the program''s own, with its admissions contact');
SELECT is((SELECT count(*)::integer FROM public.listing_bed_updates
            WHERE global_partner_id = 'd1000000-0000-0000-0000-0000000000e8' AND updated_by = 'c1000000-0000-0000-0000-0000000000e8'), 1,
  'and goes in the audit trail');

DELETE FROM public.email_outbox WHERE kind = 'bed_reminder';
SELECT is(public.notify_bed_reminders(), 0, 'beds confirmed just now: no check-in');

DELETE FROM public.center_members WHERE user_id = 'c1000000-0000-0000-0000-0000000000e8';
SET LOCAL ROLE anon;
SELECT is((SELECT count(*)::integer FROM public.public_bed_link_open(current_setting('test.bed_token'))), 0,
  'the link stops working once the account no longer keeps that listing');
RESET ROLE;

-- ===========================================================================
-- F. Unsubscribe, signed out
-- ===========================================================================

SELECT set_config('test.unsub', (SELECT unsubscribe_token FROM public.email_preferences WHERE user_id = 'b1000000-0000-0000-0000-0000000000e8'), true);
SET LOCAL ROLE anon;
SELECT is((SELECT row(is_practice, is_program, placement_response, daily_summary)::text FROM public.public_email_preferences(current_setting('test.unsub'))),
  '(t,f,t,t)', 'the unsubscribe page reads the member''s choices');
SELECT is(public.public_email_set_preference(current_setting('test.unsub'), 'daily_summary', false), false, 'and turns one off');
SELECT throws_ok($$ SELECT public.public_email_set_preference(repeat('0', 64), 'daily_summary', false) $$, 'P0002', NULL,
  'a made-up token changes nothing');
SELECT throws_ok(format($$ SELECT public.public_email_set_preference(%L, 'everything', false) $$, current_setting('test.unsub')), '22023', NULL,
  'an unknown email kind is refused');
RESET ROLE;
SELECT is((SELECT daily_summary FROM public.email_preferences WHERE user_id = 'b1000000-0000-0000-0000-0000000000e8'), false,
  'the choice is saved');

SELECT * FROM finish();
ROLLBACK;
