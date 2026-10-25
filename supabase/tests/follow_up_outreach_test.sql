-- Focused coverage for 20261023120000_follow_up_outreach.sql.
-- Run after a local migration reset with: supabase test db
--
-- This file is never pasted into production.

BEGIN;
SELECT plan(35);

-- Actors
--   a1  owner of practice A    workspace A
--   a2  member of practice A   workspace A (moved in below)
--   b1  owner of practice B    workspace B
INSERT INTO auth.users (id, email)
VALUES
  ('a1000000-0000-0000-0000-0000000000f7', 'outreach-a1@example.test'),
  ('a2000000-0000-0000-0000-0000000000f7', 'outreach-a2@example.test'),
  ('b1000000-0000-0000-0000-0000000000f7', 'outreach-b1@example.test');

SELECT set_config('test.org_a', org_id::text, true) FROM public.org_members WHERE user_id = 'a1000000-0000-0000-0000-0000000000f7';
SELECT set_config('test.org_b', org_id::text, true) FROM public.org_members WHERE user_id = 'b1000000-0000-0000-0000-0000000000f7';
UPDATE public.org_members SET org_id = current_setting('test.org_a')::uuid, role = 'member'
 WHERE user_id = 'a2000000-0000-0000-0000-0000000000f7';

-- Workspace A data, written as a1.
SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000f7', true);
SET LOCAL ROLE authenticated;
INSERT INTO public.cases (id, title, status) VALUES ('a1100000-0000-0000-0000-0000000000f7', 'Rivera family', 'inquiry');
INSERT INTO public.case_contacts (id, case_id, name, relationship, phone, email, is_primary)
VALUES ('a1200000-0000-0000-0000-0000000000f7', 'a1100000-0000-0000-0000-0000000000f7', 'Ana Rivera', 'mother', '5415550142', 'ana@example.test', true);
INSERT INTO public.follow_ups (id, case_id, title, due_on, kind)
VALUES ('a1300000-0000-0000-0000-0000000000f7', 'a1100000-0000-0000-0000-0000000000f7', 'First call', CURRENT_DATE, 'first_call');
INSERT INTO public.partners (id, name, organization, types, city, state, phone, email)
VALUES ('a1500000-0000-0000-0000-0000000000f7', 'Dana Holt', 'Cedar Ridge', ARRAY['Inpatient'], 'Bend', 'OR', '5415550199', 'dana@example.test');
RESET ROLE;

-- Workspace B data, written as b1.
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000f7', true);
SET LOCAL ROLE authenticated;
INSERT INTO public.cases (id, title, status) VALUES ('b1100000-0000-0000-0000-0000000000f7', 'Other practice family', 'inquiry');
INSERT INTO public.follow_ups (id, case_id, title, due_on, kind)
VALUES ('b1300000-0000-0000-0000-0000000000f7', 'b1100000-0000-0000-0000-0000000000f7', 'First call', CURRENT_DATE, 'first_call');
RESET ROLE;

-- ===========================================================================
-- A. Schema and privileges
-- ===========================================================================

SELECT has_table('public', 'outreach_drafts', 'outreach_drafts exists');
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.outreach_drafts'::regclass),
  'outreach_drafts has row level security on'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.outreach_drafts', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.outreach_drafts', 'INSERT')
  AND NOT has_table_privilege('anon', 'public.outreach_drafts', 'SELECT'),
  'clients cannot read or write outreach_drafts'
);
SELECT hasnt_column('public', 'outreach_drafts', 'body', 'drafted text is never stored');
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.claim_outreach_draft(uuid, text, uuid, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.claim_outreach_draft(uuid, text, uuid, uuid)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.claim_outreach_draft(uuid, text, uuid, uuid)', 'EXECUTE'),
  'claim_outreach_draft is service-role only'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.record_outreach_sent(uuid, uuid, jsonb, jsonb, jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.record_outreach_sent(uuid, uuid, jsonb, jsonb, jsonb)', 'EXECUTE'),
  'record_outreach_sent is for signed-in users only'
);

-- ===========================================================================
-- B. claim_outreach_draft: workspace fence and the daily cap
-- ===========================================================================

SET LOCAL ROLE service_role;

SELECT is(
  public.claim_outreach_draft('a1000000-0000-0000-0000-0000000000f7', 'text', 'a1100000-0000-0000-0000-0000000000f7', NULL),
  public.outreach_draft_daily_limit() - 1,
  'a first draft for an own case is allowed and reports what is left'
);
SELECT is(
  public.claim_outreach_draft('a2000000-0000-0000-0000-0000000000f7', 'email', NULL, 'a1500000-0000-0000-0000-0000000000f7'),
  public.outreach_draft_daily_limit() - 1,
  'a teammate can draft for a partner in the shared workspace, with a cap of their own'
);
SELECT throws_ok(
  $$ SELECT public.claim_outreach_draft('a1000000-0000-0000-0000-0000000000f7', 'text', 'b1100000-0000-0000-0000-0000000000f7', NULL) $$,
  'P0002', 'Case not found in this workspace',
  'a case in another workspace is refused'
);
SELECT throws_ok(
  $$ SELECT public.claim_outreach_draft('b1000000-0000-0000-0000-0000000000f7', 'call', NULL, 'a1500000-0000-0000-0000-0000000000f7') $$,
  'P0002', 'Partner not found in this workspace',
  'a partner in another workspace is refused'
);
SELECT throws_ok(
  $$ SELECT public.claim_outreach_draft('a1000000-0000-0000-0000-0000000000f7', 'fax', 'a1100000-0000-0000-0000-0000000000f7', NULL) $$,
  '22023', 'Unknown outreach channel',
  'only call, text, and email are drafted'
);
SELECT throws_ok(
  $$ SELECT public.claim_outreach_draft('a1000000-0000-0000-0000-0000000000f7', 'text', 'a1100000-0000-0000-0000-0000000000f7', 'a1500000-0000-0000-0000-0000000000f7') $$,
  '22023', 'A draft is for exactly one case or one partner',
  'a draft names one target, not two'
);
SELECT throws_ok(
  $$ SELECT public.claim_outreach_draft('c0000000-0000-0000-0000-0000000000f7', 'text', 'a1100000-0000-0000-0000-0000000000f7', NULL) $$,
  '42501', 'Workspace membership required',
  'a user with no workspace is refused'
);

RESET ROLE;
-- Fill a1's window to the cap (one draft already claimed above).
INSERT INTO public.outreach_drafts (org_id, user_id, channel, case_id)
SELECT current_setting('test.org_a')::uuid, 'a1000000-0000-0000-0000-0000000000f7', 'text', 'a1100000-0000-0000-0000-0000000000f7'
  FROM generate_series(1, public.outreach_draft_daily_limit() - 1);
SET LOCAL ROLE service_role;

SELECT throws_ok(
  $$ SELECT public.claim_outreach_draft('a1000000-0000-0000-0000-0000000000f7', 'text', 'a1100000-0000-0000-0000-0000000000f7', NULL) $$,
  '54000', 'Daily AI draft limit reached',
  'the cap stops the next draft'
);

RESET ROLE;
UPDATE public.outreach_drafts SET created_at = now() - interval '25 hours'
 WHERE user_id = 'a1000000-0000-0000-0000-0000000000f7';
SET LOCAL ROLE service_role;

SELECT is(
  public.claim_outreach_draft('a1000000-0000-0000-0000-0000000000f7', 'call', 'a1100000-0000-0000-0000-0000000000f7', NULL),
  public.outreach_draft_daily_limit() - 1,
  'the window is a rolling 24 hours'
);
RESET ROLE;

-- ===========================================================================
-- C. record_outreach_sent: complete + log + next, atomically
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000f7', true);
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$ SELECT public.record_outreach_sent(
       'a1000000-0000-0000-0000-0000000000f7',
       'a1300000-0000-0000-0000-0000000000f7',
       jsonb_build_object('id', 'a1310000-0000-0000-0000-0000000000f7', 'case_id', 'a1100000-0000-0000-0000-0000000000f7',
                          'title', 'Follow-up 2 — Rivera family', 'due_on', (CURRENT_DATE + 2)::text, 'due_time', '15:30'),
       jsonb_build_object('id', 'a1400000-0000-0000-0000-0000000000f7', 'case_id', 'a1100000-0000-0000-0000-0000000000f7',
                          'kind', 'text', 'body', 'Texted Ana Rivera (mother)', 'contact_id', 'a1200000-0000-0000-0000-0000000000f7'),
       NULL) $$,
  'a sent text records in one call'
);
SELECT is(
  (SELECT status FROM public.follow_ups WHERE id = 'a1300000-0000-0000-0000-0000000000f7'),
  'done',
  'the follow-up the text came from is done'
);
SELECT is(
  (SELECT (status, due_on - CURRENT_DATE, due_time::text, kind)::text FROM public.follow_ups WHERE id = 'a1310000-0000-0000-0000-0000000000f7'),
  '(open,2,15:30:00,follow_up)',
  'the next follow-up is open, two days out, at the sent time'
);
SELECT is(
  (SELECT (kind, contact_id::text)::text FROM public.case_events WHERE id = 'a1400000-0000-0000-0000-0000000000f7'),
  '(text,a1200000-0000-0000-0000-0000000000f7)',
  'the text is on the case timeline, tied to the contact'
);
SELECT ok(
  (SELECT first_touch_at IS NOT NULL FROM public.cases WHERE id = 'a1100000-0000-0000-0000-0000000000f7'),
  'the first text counts as the first touch on the lead'
);

-- A replay from the offline queue changes nothing and does not fail.
SELECT lives_ok(
  $$ SELECT public.record_outreach_sent(
       'a1000000-0000-0000-0000-0000000000f7',
       'a1300000-0000-0000-0000-0000000000f7',
       jsonb_build_object('id', 'a1310000-0000-0000-0000-0000000000f7', 'case_id', 'a1100000-0000-0000-0000-0000000000f7',
                          'title', 'Changed on replay', 'due_on', (CURRENT_DATE + 9)::text),
       jsonb_build_object('id', 'a1400000-0000-0000-0000-0000000000f7', 'case_id', 'a1100000-0000-0000-0000-0000000000f7',
                          'kind', 'text', 'body', 'Changed on replay'),
       NULL) $$,
  'a replay is accepted'
);
SELECT is(
  (SELECT count(*)::int FROM public.follow_ups WHERE case_id = 'a1100000-0000-0000-0000-0000000000f7' AND status = 'open'),
  1,
  'a replay creates no second follow-up'
);
SELECT is(
  (SELECT (title, due_on - CURRENT_DATE)::text FROM public.follow_ups WHERE id = 'a1310000-0000-0000-0000-0000000000f7'),
  '("Follow-up 2 — Rivera family",2)',
  'a replay does not rewrite the next follow-up'
);

-- A partner email: touch + next, no follow-up to complete; a teammate is the assignee.
SELECT lives_ok(
  $$ SELECT public.record_outreach_sent(
       'a1000000-0000-0000-0000-0000000000f7',
       NULL,
       jsonb_build_object('id', 'a1610000-0000-0000-0000-0000000000f7', 'partner_id', 'a1500000-0000-0000-0000-0000000000f7',
                          'title', 'Follow up — Cedar Ridge', 'due_on', (CURRENT_DATE + 2)::text,
                          'assigned_to', 'a2000000-0000-0000-0000-0000000000f7'),
       NULL,
       jsonb_build_object('id', 'a1600000-0000-0000-0000-0000000000f7', 'partner_id', 'a1500000-0000-0000-0000-0000000000f7',
                          'kind', 'email', 'note', 'Follow up — Cedar Ridge')) $$,
  'a sent partner email records in one call'
);
SELECT is(
  (SELECT (kind, (SELECT last_contact_at IS NOT NULL FROM public.partners WHERE id = 'a1500000-0000-0000-0000-0000000000f7'))::text
     FROM public.touches WHERE id = 'a1600000-0000-0000-0000-0000000000f7'),
  '(email,t)',
  'the email is a partner touch and resets the stay-in-touch clock'
);
SELECT is(
  (SELECT assigned_to::text FROM public.follow_ups WHERE id = 'a1610000-0000-0000-0000-0000000000f7'),
  'a2000000-0000-0000-0000-0000000000f7',
  'the next follow-up keeps its assignee'
);

-- Guards.
SELECT throws_ok(
  $$ SELECT public.record_outreach_sent('a2000000-0000-0000-0000-0000000000f7', NULL,
       jsonb_build_object('id', gen_random_uuid(), 'case_id', 'a1100000-0000-0000-0000-0000000000f7', 'title', 'x', 'due_on', CURRENT_DATE::text),
       jsonb_build_object('id', gen_random_uuid(), 'case_id', 'a1100000-0000-0000-0000-0000000000f7', 'kind', 'call'), NULL) $$,
  '42501', 'Authenticated account changed',
  'a write for another account is refused'
);
SELECT throws_ok(
  $$ SELECT public.record_outreach_sent('a1000000-0000-0000-0000-0000000000f7', NULL,
       jsonb_build_object('id', gen_random_uuid(), 'case_id', 'a1100000-0000-0000-0000-0000000000f7', 'title', 'x', 'due_on', CURRENT_DATE::text),
       NULL, NULL) $$,
  '22023', 'A case event or partner touch is required',
  'an outreach is always logged'
);
SELECT throws_ok(
  $$ SELECT public.record_outreach_sent('a1000000-0000-0000-0000-0000000000f7', NULL,
       jsonb_build_object('id', gen_random_uuid(), 'case_id', 'a1100000-0000-0000-0000-0000000000f7', 'title', 'x', 'due_on', CURRENT_DATE::text),
       jsonb_build_object('id', gen_random_uuid(), 'case_id', 'a1100000-0000-0000-0000-0000000000f7', 'kind', 'note'), NULL) $$,
  '22023', 'Outreach events are calls, texts, or emails',
  'only calls, texts, and emails are outreach'
);
SELECT throws_ok(
  $$ SELECT public.record_outreach_sent('a1000000-0000-0000-0000-0000000000f7', NULL,
       jsonb_build_object('id', gen_random_uuid(), 'case_id', 'a1100000-0000-0000-0000-0000000000f7', 'title', '  ', 'due_on', CURRENT_DATE::text),
       jsonb_build_object('id', gen_random_uuid(), 'case_id', 'a1100000-0000-0000-0000-0000000000f7', 'kind', 'call'), NULL) $$,
  '22023', 'The next follow-up needs a title and a due date',
  'the next follow-up needs a title'
);

-- Only an open outreach step is closed: a consult named as the step stays open,
-- and an assignee who has left the workspace becomes unassigned.
INSERT INTO public.follow_ups (id, case_id, title, due_on, kind)
VALUES ('a1330000-0000-0000-0000-0000000000f7', 'a1100000-0000-0000-0000-0000000000f7', 'Consult', CURRENT_DATE, 'consult');
SELECT lives_ok(
  $$ SELECT public.record_outreach_sent('a1000000-0000-0000-0000-0000000000f7',
       'a1330000-0000-0000-0000-0000000000f7',
       jsonb_build_object('id', 'a1340000-0000-0000-0000-0000000000f7', 'case_id', 'a1100000-0000-0000-0000-0000000000f7',
                          'title', 'Follow up - Rivera family', 'due_on', (CURRENT_DATE + 2)::text,
                          'assigned_to', 'b1000000-0000-0000-0000-0000000000f7'),
       jsonb_build_object('id', 'a1420000-0000-0000-0000-0000000000f7', 'case_id', 'a1100000-0000-0000-0000-0000000000f7', 'kind', 'text'),
       NULL) $$,
  'a send named against a consult still records'
);
SELECT is(
  (SELECT status FROM public.follow_ups WHERE id = 'a1330000-0000-0000-0000-0000000000f7'),
  'open',
  'the consult is not closed by an outreach'
);
SELECT is(
  (SELECT assigned_to FROM public.follow_ups WHERE id = 'a1340000-0000-0000-0000-0000000000f7'),
  NULL,
  'an assignee outside the workspace becomes unassigned instead of failing the write'
);

-- Another workspace's follow-up is never completed, even by id.
SELECT lives_ok(
  $$ SELECT public.record_outreach_sent('a1000000-0000-0000-0000-0000000000f7',
       'b1300000-0000-0000-0000-0000000000f7',
       jsonb_build_object('id', 'a1320000-0000-0000-0000-0000000000f7', 'case_id', 'a1100000-0000-0000-0000-0000000000f7',
                          'title', 'Follow-up 3 — Rivera family', 'due_on', (CURRENT_DATE + 2)::text),
       jsonb_build_object('id', 'a1410000-0000-0000-0000-0000000000f7', 'case_id', 'a1100000-0000-0000-0000-0000000000f7', 'kind', 'call'),
       NULL) $$,
  'naming a follow-up from another workspace does not fail the log'
);
RESET ROLE;
SELECT is(
  (SELECT status FROM public.follow_ups WHERE id = 'b1300000-0000-0000-0000-0000000000f7'),
  'open',
  'the other workspace''s follow-up is untouched'
);

SELECT * FROM finish();
ROLLBACK;
