-- Focused coverage for 20261001120000_lead_capture.sql.
-- Run after a local migration reset with: supabase test db

BEGIN;
SELECT plan(51);

-- Two practices (personal workspaces via handle_new_user) and one colleague
-- who is re-homed into practice A as a plain member.
INSERT INTO auth.users (id, email)
VALUES
  ('1a000000-0000-0000-0000-00000000001a', 'lead-owner@example.test'),
  ('2b000000-0000-0000-0000-00000000002b', 'other-practice@example.test'),
  ('3c000000-0000-0000-0000-00000000003c', 'colleague@example.test');

UPDATE public.org_members
   SET org_id = (SELECT org_id FROM public.org_members WHERE user_id = '1a000000-0000-0000-0000-00000000001a'),
       role = 'member'
 WHERE user_id = '3c000000-0000-0000-0000-00000000003c';

SELECT set_config('test.org_a', (SELECT org_id::text FROM public.org_members WHERE user_id = '1a000000-0000-0000-0000-00000000001a'), true);
SELECT set_config('test.org_b', (SELECT org_id::text FROM public.org_members WHERE user_id = '2b000000-0000-0000-0000-00000000002b'), true);
SELECT set_config('test.token_a', (SELECT intake_token FROM public.orgs WHERE id = current_setting('test.org_a')::uuid), true);

-- ─── 1. Tokens and the target setting ───────────────────────────────────────

SELECT ok(
  (SELECT intake_token ~ '^[0-9a-f]{40}$' FROM public.orgs WHERE id = current_setting('test.org_a')::uuid),
  'every workspace gets a 40-character hex intake token'
);

SELECT isnt(
  (SELECT intake_token FROM public.orgs WHERE id = current_setting('test.org_a')::uuid),
  (SELECT intake_token FROM public.orgs WHERE id = current_setting('test.org_b')::uuid),
  'intake tokens are distinct per workspace'
);

SELECT is(
  (SELECT lead_response_target_minutes FROM public.orgs WHERE id = current_setting('test.org_a')::uuid),
  15,
  'the first-call target defaults to 15 minutes'
);

-- ─── 2. In-app quick-add: create_lead ───────────────────────────────────────

SELECT set_config('request.jwt.claim.sub', '1a000000-0000-0000-0000-00000000001a', true);
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$ SELECT public.create_lead('1a000000-0000-0000-0000-00000000001a', jsonb_build_object(
       'id', '1a100000-0000-0000-0000-00000000001a',
       'contact_id', '1a200000-0000-0000-0000-00000000001a',
       'follow_up_id', '1a300000-0000-0000-0000-00000000001a',
       'caller_name', '  Maria Lopez ',
       'phone', '(541) 555-0142',
       'email', 'maria@example.test',
       'about_relationship', 'son',
       'about_first_name', 'Jake',
       'lead_source', 'Website',
       'urgency', 'immediate_danger',
       'due_on', '2026-10-01',
       'due_time', '09:15')) $$,
  'create_lead accepts a minimal phone-first payload'
);

SELECT is(
  (SELECT title FROM public.cases WHERE id = '1a100000-0000-0000-0000-00000000001a'),
  'Maria Lopez ' || chr(8212) || ' son Jake',
  'the case title is caller, dash, relationship and first name'
);

SELECT is(
  (SELECT (status, lead_source, lead_channel, lead_urgency, org_id::text, owner_id::text)::text
     FROM public.cases WHERE id = '1a100000-0000-0000-0000-00000000001a'),
  ('inquiry', 'Website', 'app', 'immediate_danger', current_setting('test.org_a'), '1a000000-0000-0000-0000-00000000001a')::text,
  'the case is an inquiry in the caller''s workspace with channel, source and urgency recorded'
);

SELECT ok(
  (SELECT lead_captured_at IS NOT NULL AND first_touch_at IS NULL
     FROM public.cases WHERE id = '1a100000-0000-0000-0000-00000000001a'),
  'a new lead has lead_captured_at set and no first touch yet'
);

SELECT ok(
  (SELECT summary LIKE '%immediate danger%' FROM public.cases WHERE id = '1a100000-0000-0000-0000-00000000001a'),
  'immediate danger is noted in the case summary'
);

SELECT is(
  (SELECT (name, relationship, phone, email, is_primary, case_id::text)::text
     FROM public.case_contacts WHERE id = '1a200000-0000-0000-0000-00000000001a'),
  ('Maria Lopez', 'son', '(541) 555-0142', 'maria@example.test', true, '1a100000-0000-0000-0000-00000000001a')::text,
  'the caller becomes the primary contact'
);

SELECT is(
  (SELECT (kind, status, due_on::text, due_time::text, case_id::text, title)::text
     FROM public.follow_ups WHERE id = '1a300000-0000-0000-0000-00000000001a'),
  ('first_call', 'open', '2026-10-01', '09:15:00', '1a100000-0000-0000-0000-00000000001a', 'First call ' || chr(8212) || ' Maria Lopez ' || chr(8212) || ' son Jake')::text,
  'a first-call follow-up is created, due on the requested day and time'
);

SELECT is(
  (SELECT count(*)::integer FROM public.case_events
    WHERE case_id = '1a100000-0000-0000-0000-00000000001a' AND kind = 'system'
      AND contact_id = '1a200000-0000-0000-0000-00000000001a'),
  1,
  'the timeline records how the lead arrived (a system entry, not a touch)'
);

SELECT throws_ok(
  $$ SELECT public.create_lead('1a000000-0000-0000-0000-00000000001a', jsonb_build_object('caller_name', '  ', 'phone', '5415550142')) $$,
  '22023',
  'The caller name is required (up to 120 characters)',
  'a blank caller name is rejected'
);

SELECT throws_ok(
  $$ SELECT public.create_lead('1a000000-0000-0000-0000-00000000001a', jsonb_build_object('caller_name', 'Short Phone', 'phone', '555-0142')) $$,
  '22023',
  'A phone number with at least 10 digits is required',
  'a phone number needs at least 10 digits'
);

SELECT throws_ok(
  $$ SELECT public.create_lead('1a000000-0000-0000-0000-00000000001a', jsonb_build_object('caller_name', 'Bad Email', 'phone', '5415550142', 'email', 'not-an-address')) $$,
  '22023',
  'The email address does not look right',
  'a malformed email is rejected'
);

SELECT throws_ok(
  $$ SELECT public.create_lead('1a000000-0000-0000-0000-00000000001a', jsonb_build_object('caller_name', 'Bad Urgency', 'phone', '5415550142', 'urgency', 'high')) $$,
  '22023',
  'Urgency must be none or immediate_danger',
  'urgency is a closed choice'
);

SELECT throws_ok(
  $$ SELECT public.create_lead('2b000000-0000-0000-0000-00000000002b', jsonb_build_object('caller_name', 'Spoof', 'phone', '5415550142')) $$,
  '42501',
  'Authenticated account changed before the lead was saved',
  'the expected-owner fence rejects a stale account'
);

SELECT is(
  (SELECT count(*)::integer FROM public.cases WHERE org_id = current_setting('test.org_a')::uuid),
  1,
  'rejected payloads leave no case behind'
);

-- ─── 3. first_touch_at: set once, by a real touch ───────────────────────────

INSERT INTO public.case_events (owner_id, case_id, kind, body, occurred_at)
VALUES ('1a000000-0000-0000-0000-00000000001a', '1a100000-0000-0000-0000-00000000001a', 'note', 'Read the intake', '2026-10-01 16:00:00+00');

SELECT ok(
  (SELECT first_touch_at IS NULL FROM public.cases WHERE id = '1a100000-0000-0000-0000-00000000001a'),
  'a note is not a touch'
);

INSERT INTO public.case_events (owner_id, case_id, kind, body, contact_id, occurred_at)
VALUES ('1a000000-0000-0000-0000-00000000001a', '1a100000-0000-0000-0000-00000000001a', 'call', 'Called Maria', '1a200000-0000-0000-0000-00000000001a', '2026-10-01 16:10:00+00');

SELECT is(
  (SELECT first_touch_at FROM public.cases WHERE id = '1a100000-0000-0000-0000-00000000001a'),
  '2026-10-01 16:10:00+00'::timestamptz,
  'the first logged call stamps first_touch_at'
);

INSERT INTO public.case_events (owner_id, case_id, kind, body, occurred_at)
VALUES ('1a000000-0000-0000-0000-00000000001a', '1a100000-0000-0000-0000-00000000001a', 'text', 'Backdated text', '2026-10-01 16:05:00+00');
INSERT INTO public.case_events (owner_id, case_id, kind, body, occurred_at)
VALUES ('1a000000-0000-0000-0000-00000000001a', '1a100000-0000-0000-0000-00000000001a', 'call', 'Second call', '2026-10-01 17:00:00+00');

SELECT is(
  (SELECT first_touch_at FROM public.cases WHERE id = '1a100000-0000-0000-0000-00000000001a'),
  '2026-10-01 16:10:00+00'::timestamptz,
  'first_touch_at is set once: later and backdated touches never move it'
);

-- ─── 4. Intake link path: service role only ─────────────────────────────────

SELECT throws_ok(
  $$ SELECT public.create_lead_from_intake(current_setting('test.token_a'), jsonb_build_object('caller_name', 'Web Caller', 'phone', '5415550199')) $$,
  '42501',
  NULL,
  'a signed-in user cannot call the intake RPC'
);

SELECT throws_ok(
  $$ SELECT count(*) FROM public.intake_rate_limits $$,
  '42501',
  NULL,
  'rate-limit buckets are not readable by signed-in users'
);

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SET LOCAL ROLE service_role;

SELECT lives_ok(
  $$ SELECT set_config('test.intake_case', public.create_lead_from_intake(current_setting('test.token_a'), jsonb_build_object(
       'caller_name', 'Dan Ortiz', 'phone', '541-555-0177', 'about_relationship', 'wife', 'about_first_name', 'Elena',
       'lead_source', 'Website', 'lead_source_detail', 'Intake link', 'urgency', 'none'))::text, true) $$,
  'the intake link creates a lead with the service role'
);

SELECT is(
  (SELECT (org_id::text, owner_id::text, lead_channel, status, lead_source)::text FROM public.cases WHERE id = current_setting('test.intake_case')::uuid),
  (current_setting('test.org_a'), '1a000000-0000-0000-0000-00000000001a', 'intake_link', 'inquiry', 'Website')::text,
  'an intake lead lands in the token''s workspace, attributed to its owner'
);

SELECT is(
  (SELECT count(*)::integer FROM public.follow_ups WHERE case_id = current_setting('test.intake_case')::uuid AND kind = 'first_call' AND status = 'open'),
  1,
  'an intake lead gets its first-call follow-up'
);

SELECT ok(
  (SELECT due_on = CURRENT_DATE FROM public.follow_ups WHERE case_id = current_setting('test.intake_case')::uuid),
  'without a device date the first call is due today'
);

SELECT throws_ok(
  $$ SELECT public.create_lead_from_intake('0000000000000000000000000000000000000000', jsonb_build_object('caller_name', 'Nobody', 'phone', '5415550100')) $$,
  'P0002',
  'Unknown intake link',
  'an unknown token is refused'
);

SELECT throws_ok(
  $$ SELECT public.create_lead_from_intake('not a token', jsonb_build_object('caller_name', 'Nobody', 'phone', '5415550100')) $$,
  'P0002',
  'Unknown intake link',
  'a malformed token is refused before any lookup'
);

SELECT throws_ok(
  $$ SELECT public.create_lead_from_intake(current_setting('test.token_a'), jsonb_build_object('caller_name', 'No Phone', 'phone', '')) $$,
  '22023',
  'A phone number with at least 10 digits is required',
  'the intake path validates like the app path'
);

SELECT is(
  (SELECT array_agg(public.intake_rate_limit_hit('test:bucket', 2, 3600)) FROM generate_series(1, 3)),
  ARRAY[true, true, false],
  'the rate limiter allows p_limit hits per window and refuses the next'
);

-- ─── 5. RLS: leads stay inside the workspace ────────────────────────────────

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '2b000000-0000-0000-0000-00000000002b', true);
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT count(*)::integer FROM public.cases WHERE org_id = current_setting('test.org_a')::uuid),
  0,
  'another practice cannot read the leads'
);

SELECT is(
  (SELECT count(*)::integer FROM public.case_contacts WHERE case_id = '1a100000-0000-0000-0000-00000000001a'),
  0,
  'another practice cannot read the lead contacts'
);

SELECT is(
  (SELECT count(*)::integer FROM public.follow_ups WHERE case_id = '1a100000-0000-0000-0000-00000000001a'),
  0,
  'another practice cannot read the first-call follow-ups'
);

SELECT is(
  (SELECT leads FROM public.lead_capture_metrics() WHERE lead_source = '*'),
  0,
  'the metric function only counts the caller''s own leads'
);

SELECT is(
  (SELECT intake_token FROM public.orgs WHERE id = current_setting('test.org_a')::uuid),
  NULL,
  'another practice cannot read the intake token'
);

-- ─── 6. Token rotation ──────────────────────────────────────────────────────

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '3c000000-0000-0000-0000-00000000003c', true);
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT intake_token FROM public.orgs WHERE id = current_setting('test.org_a')::uuid),
  current_setting('test.token_a'),
  'a workspace member can read the intake token (to share the link)'
);

SELECT throws_ok(
  $$ SELECT public.rotate_intake_token() $$,
  '42501',
  'Only the workspace owner can make a new intake link',
  'a member cannot rotate the token'
);

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '1a000000-0000-0000-0000-00000000001a', true);
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$ SELECT set_config('test.token_a2', public.rotate_intake_token(), true) $$,
  'the owner can make a new link'
);

SELECT ok(
  current_setting('test.token_a2') ~ '^[0-9a-f]{40}$' AND current_setting('test.token_a2') <> current_setting('test.token_a'),
  'rotation issues a fresh token'
);

SELECT is(
  (SELECT intake_token FROM public.orgs WHERE id = current_setting('test.org_a')::uuid),
  current_setting('test.token_a2'),
  'the new token is stored on the workspace'
);

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SET LOCAL ROLE service_role;

SELECT throws_ok(
  $$ SELECT public.create_lead_from_intake(current_setting('test.token_a'), jsonb_build_object('caller_name', 'Late Caller', 'phone', '5415550111')) $$,
  'P0002',
  'Unknown intake link',
  'the old link stops working immediately'
);

SELECT lives_ok(
  $$ SELECT public.create_lead_from_intake(current_setting('test.token_a2'), jsonb_build_object(
       'id', '1a400000-0000-0000-0000-00000000001a', 'caller_name', 'Late Caller', 'phone', '5415550111', 'lead_source', 'Website')) $$,
  'the new link works'
);

-- ─── 7. Metrics on a pinned fixture ─────────────────────────────────────────

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '1a000000-0000-0000-0000-00000000001a', true);
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$ SELECT public.create_lead('1a000000-0000-0000-0000-00000000001a', jsonb_build_object('id', '1a500000-0000-0000-0000-00000000001a', 'caller_name', 'Call Lead One', 'phone', '5415550121', 'lead_source', 'Inbound call'));
     SELECT public.create_lead('1a000000-0000-0000-0000-00000000001a', jsonb_build_object('id', '1a600000-0000-0000-0000-00000000001a', 'caller_name', 'Call Lead Two', 'phone', '5415550122', 'lead_source', 'Inbound call')); $$,
  'two more leads for the fixture'
);

RESET ROLE;
-- Pin arrival and first-touch times (target is 15 minutes = 900 seconds).
UPDATE public.cases SET lead_captured_at = '2026-10-01 10:00:00+00', first_touch_at = '2026-10-01 10:05:00+00' WHERE id = '1a100000-0000-0000-0000-00000000001a'; -- Website, 300s
UPDATE public.cases SET lead_captured_at = '2026-10-01 10:00:00+00', first_touch_at = '2026-10-01 10:10:00+00' WHERE id = current_setting('test.intake_case')::uuid; -- Website, 600s
UPDATE public.cases SET lead_captured_at = '2026-10-01 10:00:00+00', first_touch_at = '2026-10-01 10:30:00+00' WHERE id = '1a500000-0000-0000-0000-00000000001a'; -- Inbound call, 1800s
UPDATE public.cases SET lead_captured_at = '2026-10-01 10:00:00+00', first_touch_at = NULL WHERE id = '1a600000-0000-0000-0000-00000000001a'; -- Inbound call, untouched
UPDATE public.cases SET lead_captured_at = '2025-01-01 10:00:00+00', first_touch_at = '2025-01-01 10:01:00+00' WHERE id = '1a400000-0000-0000-0000-00000000001a'; -- Website, 60s, old

SELECT set_config('request.jwt.claim.sub', '1a000000-0000-0000-0000-00000000001a', true);
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT (leads, touched, within_target, median_seconds)::text FROM public.lead_capture_metrics() WHERE lead_source = '*'),
  (5, 4, 3, 450.0::numeric)::text,
  'all time: 5 leads, 4 touched, 3 within 15 minutes, median 450 seconds'
);

SELECT is(
  (SELECT (leads, touched, within_target, median_seconds)::text FROM public.lead_capture_metrics('2026-09-01 00:00:00+00') WHERE lead_source = '*'),
  (4, 3, 2, 600.0::numeric)::text,
  'since September: the old lead drops out and the median moves to 600 seconds'
);

SELECT is(
  (SELECT array_agg(lead_source ORDER BY lead_source) FROM public.lead_capture_metrics('2026-09-01 00:00:00+00') WHERE lead_source <> '*'),
  ARRAY['Inbound call', 'Website'],
  'one row per lead source'
);

SELECT is(
  (SELECT (leads, touched, within_target, median_seconds)::text FROM public.lead_capture_metrics('2026-09-01 00:00:00+00') WHERE lead_source = 'Inbound call'),
  (2, 1, 0, 1800.0::numeric)::text,
  'Inbound call: 2 leads, 1 touched after the target, median 1800 seconds'
);

SELECT is(
  (SELECT (leads, touched, within_target, median_seconds)::text FROM public.lead_capture_metrics('2026-09-01 00:00:00+00') WHERE lead_source = 'Website'),
  (2, 2, 2, 450.0::numeric)::text,
  'Website: both leads answered inside the target'
);

SELECT lives_ok(
  $$ UPDATE public.orgs SET lead_response_target_minutes = 5 WHERE id = current_setting('test.org_a')::uuid $$,
  'the owner can change the first-call target'
);

SELECT is(
  (SELECT within_target FROM public.lead_capture_metrics('2026-09-01 00:00:00+00') WHERE lead_source = '*'),
  1,
  'within_target follows the workspace target (5 minutes keeps only the 300-second lead)'
);

SELECT throws_ok(
  $$ UPDATE public.orgs SET lead_response_target_minutes = 0 WHERE id = current_setting('test.org_a')::uuid $$,
  '23514',
  NULL,
  'the target must be between 1 and 1440 minutes'
);

SELECT * FROM finish();
ROLLBACK;
