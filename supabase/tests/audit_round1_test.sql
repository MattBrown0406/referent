-- Focused coverage for 20261108170000_audit_round1.sql: the fixes from the
-- first bug audit of the 2026-11-08 migrations. Run after a local migration
-- reset with: supabase test db
--
-- This file is never pasted into production.

BEGIN;
SELECT plan(23);

INSERT INTO auth.users (id, email)
VALUES
  ('a1000000-0000-0000-0000-0000000000f1', 'admin-f1@example.test'),
  ('b1000000-0000-0000-0000-0000000000f1', 'solo-f1@example.test'),
  ('b2000000-0000-0000-0000-0000000000f1', 'owner-f1@example.test'),
  ('c1000000-0000-0000-0000-0000000000f1', 'center1-f1@example.test'),
  ('c2000000-0000-0000-0000-0000000000f1', 'center2-f1@example.test'),
  ('c3000000-0000-0000-0000-0000000000f1', 'center3-f1@example.test'),
  ('c4000000-0000-0000-0000-0000000000f1', 'center4-f1@example.test');
INSERT INTO public.platform_admins (user_id) VALUES ('a1000000-0000-0000-0000-0000000000f1');
SELECT set_config('test.w1', org_id::text, true) FROM public.org_members WHERE user_id = 'b1000000-0000-0000-0000-0000000000f1';
SELECT set_config('test.w2', org_id::text, true) FROM public.org_members WHERE user_id = 'b2000000-0000-0000-0000-0000000000f1';

INSERT INTO public.global_partners (id, name, organization, types, city, state, status, beds_updated_at)
VALUES
  ('d1000000-0000-0000-0000-0000000000f1', 'Intake', 'Program One', ARRAY['Inpatient'], 'Bend', 'OR', 'active', now()),
  ('d2000000-0000-0000-0000-0000000000f1', 'Intake', 'Keep Recovery', ARRAY['Inpatient'], 'Bend', 'OR', 'active', now()),
  ('d3000000-0000-0000-0000-0000000000f1', 'Intake', 'Drop Recovery', ARRAY['Inpatient'], 'Bend', 'OR', 'active', now()),
  ('d4000000-0000-0000-0000-0000000000f1', 'Intake', 'Archived Recovery', ARRAY['Inpatient'], 'Bend', 'OR', 'archived', now()),
  ('d5000000-0000-0000-0000-0000000000f1', 'Intake', 'Stale Beds', ARRAY['Detox'], 'Bend', 'OR', 'active', now() - interval '5 days 1 hour'),
  ('d6000000-0000-0000-0000-0000000000f1', 'Intake', 'Fresh Beds', ARRAY['Detox'], 'Bend', 'OR', 'active', now() - interval '4 days');
INSERT INTO public.global_partners (id, name, organization, types, city, state, status, owner_org_id)
VALUES ('e1000000-0000-0000-0000-0000000000f1', 'Solo Person', 'Solo Interventions', ARRAY['Interventionist'], 'Bend', 'OR', 'active',
        current_setting('test.w1')::uuid);
INSERT INTO public.center_members (user_id, global_partner_id)
VALUES ('c1000000-0000-0000-0000-0000000000f1', 'd1000000-0000-0000-0000-0000000000f1'),
       ('c3000000-0000-0000-0000-0000000000f1', 'd5000000-0000-0000-0000-0000000000f1'),
       ('c4000000-0000-0000-0000-0000000000f1', 'd6000000-0000-0000-0000-0000000000f1');

-- ===========================================================================
-- 1. Program referrals move with the workspace
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000f1', true);
SET LOCAL ROLE authenticated;
INSERT INTO public.cases (id, title) VALUES ('f1000000-0000-0000-0000-0000000000f1', 'Referred family');
RESET ROLE;
INSERT INTO public.program_referrals (id, from_global_partner_id, from_user_id, from_display, to_global_partner_id, to_org_id, to_display,
                                      case_id, family_label, consent_attested_at)
VALUES ('f2000000-0000-0000-0000-0000000000f1', 'd1000000-0000-0000-0000-0000000000f1', 'c1000000-0000-0000-0000-0000000000f1', 'Program One',
        'e1000000-0000-0000-0000-0000000000f1', current_setting('test.w1')::uuid, 'Solo Interventions',
        'f1000000-0000-0000-0000-0000000000f1', 'Ana (mother)', now());
-- accept_org_invite runs the move with the composite keys deferred.
SET CONSTRAINTS ALL DEFERRED;
SELECT public.org_move_workspace_rows(current_setting('test.w1')::uuid, current_setting('test.w2')::uuid);
SET CONSTRAINTS ALL IMMEDIATE;
SELECT is((SELECT to_org_id::text FROM public.program_referrals WHERE id = 'f2000000-0000-0000-0000-0000000000f1'), current_setting('test.w2'),
  'a program referral moves with a practice that joins another');

-- ===========================================================================
-- 2. Merging listings; approving only on a live listing
-- ===========================================================================

INSERT INTO public.program_referrals (id, from_global_partner_id, from_user_id, from_display, to_global_partner_id, to_org_id, to_display,
                                      case_id, consent_attested_at)
VALUES ('f3000000-0000-0000-0000-0000000000f1', 'd3000000-0000-0000-0000-0000000000f1', NULL, 'Drop Recovery',
        'e1000000-0000-0000-0000-0000000000f1', current_setting('test.w2')::uuid, 'Solo Interventions', NULL, now());
INSERT INTO public.program_claim_requests (id, user_id, global_partner_id, contact_name)
VALUES ('f4000000-0000-0000-0000-0000000000f1', 'c2000000-0000-0000-0000-0000000000f1', 'd3000000-0000-0000-0000-0000000000f1', 'Sam');
SELECT set_config('test.drop_link', public.mint_bed_link('c2000000-0000-0000-0000-0000000000f1', 'd3000000-0000-0000-0000-0000000000f1'), true);
SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000f1', true);
SET LOCAL ROLE authenticated;
SELECT public.merge_global_partners('d2000000-0000-0000-0000-0000000000f1', 'd3000000-0000-0000-0000-0000000000f1');
RESET ROLE;
SELECT is((SELECT from_global_partner_id::text FROM public.program_referrals WHERE id = 'f3000000-0000-0000-0000-0000000000f1'),
  'd2000000-0000-0000-0000-0000000000f1', 'a merge moves the program''s referrals to the kept listing');
SELECT is((SELECT global_partner_id::text FROM public.program_claim_requests WHERE id = 'f4000000-0000-0000-0000-0000000000f1'),
  'd2000000-0000-0000-0000-0000000000f1', 'and its waiting claim requests');
SELECT is((SELECT count(*)::integer FROM public.listing_bed_links WHERE global_partner_id = 'd3000000-0000-0000-0000-0000000000f1'), 0,
  'and its bed check-in links');

INSERT INTO public.program_claim_requests (id, user_id, global_partner_id, contact_name)
VALUES ('f5000000-0000-0000-0000-0000000000f1', 'c2000000-0000-0000-0000-0000000000f1', 'd4000000-0000-0000-0000-0000000000f1', 'Sam')
ON CONFLICT DO NOTHING;
UPDATE public.program_claim_requests SET status = 'cancelled' WHERE id = 'f4000000-0000-0000-0000-0000000000f1';
INSERT INTO public.program_claim_requests (id, user_id, global_partner_id, contact_name)
VALUES ('f6000000-0000-0000-0000-0000000000f1', 'c2000000-0000-0000-0000-0000000000f1', 'd4000000-0000-0000-0000-0000000000f1', 'Sam');
SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000f1', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.decide_program_claim_request('f6000000-0000-0000-0000-0000000000f1', true, '') $$,
  '22023', 'This listing is no longer live in the directory. Decline this request.', 'a claim on an archived listing cannot be approved');
SELECT is(public.decide_program_claim_request('f6000000-0000-0000-0000-0000000000f1', false, ''), 'declined', 'it can be declined');
RESET ROLE;

-- ===========================================================================
-- 3. The morning summary keeps to 7 AM in the member's zone
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-0000000000f1', true);
SET LOCAL ROLE authenticated;
SELECT is(public.set_email_timezone('America/New_York', -300), true, 'the app reports its zone');
RESET ROLE;
SELECT is((SELECT tz_name FROM public.email_preferences WHERE user_id = 'b2000000-0000-0000-0000-0000000000f1'), 'America/New_York',
  'the zone name is kept');
SELECT set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-0000000000f1', true);
SET LOCAL ROLE authenticated;
SELECT public.set_email_timezone('Mars/Olympus_Mons', -300);
RESET ROLE;
SELECT is((SELECT tz_name FROM public.email_preferences WHERE user_id = 'b2000000-0000-0000-0000-0000000000f1'), 'America/New_York',
  'an unknown zone name is ignored');
SELECT is(extract(hour FROM public.email_local_now('Etc/GMT+5', 600))::integer,
          extract(hour FROM (now() AT TIME ZONE 'UTC') - interval '5 hours')::integer,
  'a zone name wins over the stored offset');

-- Something waiting for the member: a follow-up past due on the moved case.
SELECT set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-0000000000f1', true);
SET LOCAL ROLE authenticated;
INSERT INTO public.follow_ups (id, case_id, title, due_on, kind)
VALUES ('f8000000-0000-0000-0000-0000000000f1', 'f1000000-0000-0000-0000-0000000000f1', 'Call back', CURRENT_DATE - 3, 'follow_up');
RESET ROLE;
-- A zone where it is 7 AM now, with an offset that says otherwise.
UPDATE public.email_preferences
   SET daily_summary = true, tz_offset_minutes = 0,
       tz_name = CASE WHEN extract(hour FROM (now() AT TIME ZONE 'UTC'))::integer - 7 BETWEEN -11 AND 12
                      THEN CASE WHEN extract(hour FROM (now() AT TIME ZONE 'UTC'))::integer - 7 >= 0
                                THEN 'Etc/GMT+' || (extract(hour FROM (now() AT TIME ZONE 'UTC'))::integer - 7)
                                ELSE 'Etc/GMT-' || (7 - extract(hour FROM (now() AT TIME ZONE 'UTC'))::integer) END
                      ELSE 'Etc/GMT-' || (31 - extract(hour FROM (now() AT TIME ZONE 'UTC'))::integer) END
 WHERE user_id = 'b2000000-0000-0000-0000-0000000000f1';
UPDATE public.email_preferences SET tz_offset_minutes = 60 WHERE user_id = 'b2000000-0000-0000-0000-0000000000f1'
   AND extract(hour FROM (now() AT TIME ZONE 'UTC')) = 7;
SELECT is(public.notify_daily_summaries(), 1, 'the summary goes out at 7 AM in the member''s zone');

-- ===========================================================================
-- 4. The bed check-in a day before counts go stale
-- ===========================================================================

DELETE FROM public.email_outbox;
SELECT public.notify_bed_reminders();
SELECT is((SELECT string_agg(u.email, ',' ORDER BY u.email) FROM public.email_outbox o JOIN auth.users u ON u.id = o.user_id WHERE o.kind = 'bed_reminder'),
  'center3-f1@example.test', 'after 5 days without a confirmation, not after 4 (and not for the fresh count of Program One)');
UPDATE public.email_outbox SET error = 'expired' WHERE kind = 'bed_reminder';
SELECT is(public.notify_bed_reminders(), 1, 'a check-in that never went out does not hold the next one back');
SELECT is(public.notify_bed_reminders(), 0, 'one waiting at a time');

-- ===========================================================================
-- 5 + 8. Folding, fixed content, re-checked recipients, late summaries
-- ===========================================================================

DELETE FROM public.email_outbox;
SELECT public.email_enqueue('b2000000-0000-0000-0000-0000000000f1', 'daily_summary', '{"due_today": 1, "day": "x"}'::jsonb);
UPDATE public.email_outbox SET claimed_at = now();
SELECT public.email_enqueue('b2000000-0000-0000-0000-0000000000f1', 'daily_summary', '{"due_today": 1, "day": "x"}'::jsonb);
SELECT is((SELECT count(*)::integer FROM public.email_outbox WHERE kind = 'daily_summary'), 2,
  'an email already being sent is not folded into');

DELETE FROM public.email_outbox;
SELECT public.email_enqueue('c3000000-0000-0000-0000-0000000000f1', 'bed_reminder', jsonb_build_object('global_partner_id', 'd5000000-0000-0000-0000-0000000000f1'));
SET LOCAL ROLE service_role;
CREATE TEMP TABLE first_try ON COMMIT DROP AS SELECT * FROM public.email_outbox_claim(10);
SELECT is(public.email_outbox_release(ARRAY(SELECT id FROM first_try)), 1, 'released without trying');
RESET ROLE;
SELECT is((SELECT claimed_at IS NULL AND attempts = 0 FROM public.email_outbox), true, 'back to waiting, no attempt spent');
SET LOCAL ROLE service_role;
CREATE TEMP TABLE second_try ON COMMIT DROP AS SELECT * FROM public.email_outbox_claim(10);
RESET ROLE;
SELECT is((SELECT data ->> 'link_token' FROM second_try), (SELECT data ->> 'link_token' FROM first_try),
  'a retry sends the same email (the same private link)');
SELECT is((SELECT count(*)::integer FROM public.listing_bed_links WHERE user_id = 'c3000000-0000-0000-0000-0000000000f1'), 1,
  'and mints no second link');

DELETE FROM public.email_outbox;
INSERT INTO public.email_outbox (user_id, kind, data, created_at, not_before)
VALUES ('b2000000-0000-0000-0000-0000000000f1', 'daily_summary', '{"due_today": 1}', now() - interval '4 hours', now() - interval '4 hours'),
       ('b1000000-0000-0000-0000-0000000000f1', 'claim_request', '{"claim_request_id": "f4000000-0000-0000-0000-0000000000f1"}', now(), now());
UPDATE public.program_claim_requests SET status = 'pending' WHERE id = 'f4000000-0000-0000-0000-0000000000f1';
SET LOCAL ROLE service_role;
SELECT is((SELECT count(*)::integer FROM public.email_outbox_claim(10)), 0, 'neither goes out');
RESET ROLE;
SELECT is((SELECT string_agg(kind || ':' || error, ',' ORDER BY kind) FROM public.email_outbox),
  'claim_request:not_admin,daily_summary:expired', 'a late summary expires; a claim alert goes only to a current admin');

-- ===========================================================================
-- 7. Entered treatment counts outbound records only
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-0000000000f1', true);
SET LOCAL ROLE authenticated;
SELECT public.import_global_partner('d2000000-0000-0000-0000-0000000000f1', 'f7000000-0000-0000-0000-0000000000f1');
INSERT INTO public.referrals (partner_id, direction, case_id, admitted)
VALUES ('f7000000-0000-0000-0000-0000000000f1', 'inbound', 'f1000000-0000-0000-0000-0000000000f1', true);
RESET ROLE;
SELECT is((SELECT entered_treatment FROM public.program_referral_milestones('f1000000-0000-0000-0000-0000000000f1')), false,
  'an inbound record never counts as entering treatment');

-- ===========================================================================
-- 9. Helpers clients never call
-- ===========================================================================

SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.listing_is_program(ARRAY['Inpatient']) $$, '42501', NULL, 'clients cannot run the listing helper');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
