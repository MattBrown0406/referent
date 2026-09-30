-- Focused coverage for 20260930120000_directory_submissions.sql.
-- Run after a local migration reset with: supabase test db

BEGIN;
SELECT plan(43);

-- Actors: e1 is the platform admin (and owns the seed workspace), e2 is an
-- ordinary practice that submits programs, e3 is another ordinary practice
-- that only browses the directory.
INSERT INTO auth.users (id, email)
VALUES
  ('e1000000-0000-0000-0000-00000000000e', 'admin@example.test'),
  ('e2000000-0000-0000-0000-00000000000e', 'submitter@example.test'),
  ('e3000000-0000-0000-0000-00000000000e', 'browser@example.test');

INSERT INTO public.platform_admins (user_id)
VALUES ('e1000000-0000-0000-0000-00000000000e');

UPDATE public.orgs SET name = 'Harbor Family Coaching'
 WHERE id = (SELECT org_id FROM public.org_members WHERE user_id = 'e2000000-0000-0000-0000-00000000000e');

CREATE TEMP VIEW submitter_org AS
  SELECT org_id FROM public.org_members WHERE user_id = 'e2000000-0000-0000-0000-00000000000e';
GRANT SELECT ON submitter_org TO authenticated;

-- ─── The completeness rule ──────────────────────────────────────────────────

SELECT is(
  public.directory_missing_fields(NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ARRAY['organization', 'name', 'types', 'city', 'state', 'phone', 'email', 'website', 'monthly_cost', 'insurance'],
  'an empty program is missing every required field, in display order'
);

SELECT is(
  public.directory_missing_fields(
    'Cedar Ridge Recovery', 'Dana Whitfield', ARRAY['Inpatient'], 'Bend', 'OR',
    '(541) 555-0142', 'dana@cedarridge.example', 'https://cedarridge.example', 32000, ARRAY['Aetna'], '{"Aetna":["In-network"]}'::jsonb),
  '{}'::text[],
  'a fully populated program is directory-ready'
);

SELECT is(
  public.directory_missing_fields(
    'Cedar Ridge Recovery', 'Dana Whitfield', ARRAY['Inpatient'], '—', ' - ',
    '555-0142', 'dana-at-cedarridge', 'https://cedarridge.example', 32000, ARRAY['Aetna'], '{}'::jsonb),
  ARRAY['city', 'state', 'phone', 'email'],
  'placeholder dashes, a short phone, and a malformed email all count as missing'
);

SELECT ok(
  public.directory_missing_fields(
    'Cedar Ridge Recovery', 'Dana Whitfield', ARRAY['Detox'], 'Bend', 'OR',
    '5415550142', 'dana@cedarridge.example', 'cedarridge.example', 32000, ARRAY['Cash pay'], '{}'::jsonb) = '{}'::text[]
  AND public.directory_missing_fields(
    'Cedar Ridge Recovery', 'Dana Whitfield', ARRAY['Detox'], 'Bend', 'OR',
    '5415550142', 'dana@cedarridge.example', 'cedarridge.example', 32000, '{}'::text[], '{"Cigna":["Out-of-network"]}'::jsonb) = '{}'::text[]
  AND public.directory_missing_fields(
    'Cedar Ridge Recovery', 'Dana Whitfield', ARRAY['Detox'], 'Bend', 'OR',
    '5415550142', 'dana@cedarridge.example', 'cedarridge.example', 32000, ARRAY[' '], '{}'::jsonb) = ARRAY['insurance'],
  'private pay or a network entry answers the insurance question; a blank entry does not'
);

SELECT ok(
  public.directory_missing_fields(
    'Solo Practice', 'Pat Lee', ARRAY['Interventionist', 'Therapist'], 'Bend', 'OR',
    '5415550143', 'pat@solo.example', 'solo.example', 9000, ARRAY['Cash pay'], '{}'::jsonb) = ARRAY['types']
  AND public.directory_missing_fields(
    'Untyped Program', 'Pat Lee', '{}'::text[], 'Bend', 'OR',
    '5415550143', 'pat@solo.example', 'solo.example', 9000, ARRAY['Cash pay'], '{}'::jsonb) = ARRAY['types']
  AND public.directory_missing_fields(
    'Mixed Program', 'Pat Lee', ARRAY['Therapist', 'Sober Living'], 'Bend', 'OR',
    '5415550143', 'pat@solo.example', 'solo.example', 9000, ARRAY['Cash pay'], '{}'::jsonb) = '{}'::text[],
  'a program type is required: individual professionals and untyped partners are not ready'
);

SELECT is(
  public.directory_missing_fields_message(ARRAY['email', 'monthly_cost']),
  'Add email and monthly cost to submit this program to the shared directory.',
  'two missing fields read as a plain sentence'
);

SELECT is(
  public.directory_missing_fields_message(ARRAY['city', 'state', 'website']),
  'Add city, state, and website to submit this program to the shared directory.',
  'three or more missing fields are listed with commas'
);

SELECT is(
  (SELECT array_agg(field) FROM public.directory_submission_field_labels()),
  public.directory_missing_fields(NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  'every required field has a label, in the same order'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.suggest_global_listing(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.list_pending_global_listings()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.review_global_listing(uuid, boolean, text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.list_pending_global_listings()', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.review_global_listing(uuid, boolean, text)', 'EXECUTE'),
  'the submission and review RPCs are closed to anon and open to signed-in callers'
);

-- ─── Submitter: saving is never blocked, submitting is ──────────────────────

SELECT set_config('request.jwt.claim.sub', 'e2000000-0000-0000-0000-00000000000e', true);
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$ INSERT INTO public.partners (id, name, organization, types, city, state, phone, email, website, monthly_cost, insurance)
     VALUES ('ee200000-0000-0000-0000-000000000001', 'Front Desk', 'Halfway There House', ARRAY['Sober Living'], DEFAULT, DEFAULT, '(541) 555-0101', DEFAULT, DEFAULT, DEFAULT, DEFAULT),
            ('ee200000-0000-0000-0000-000000000002', 'Dana Whitfield', 'Cedar Ridge Recovery', ARRAY['Inpatient', 'Detox'], 'Bend', 'OR', '(541) 555-0142', 'dana@cedarridge.example', 'https://www.cedarridge.example', 32000, ARRAY['Aetna']),
            ('ee200000-0000-0000-0000-000000000003', 'Pat Lee', 'Lee Intervention Services', ARRAY['Interventionist'], 'Bend', 'OR', '(541) 555-0143', 'pat@leeintervention.example', 'https://leeintervention.example', 9000, ARRAY['Cash pay']),
            ('ee200000-0000-0000-0000-000000000004', 'Admissions', 'Juniper Flats Treatment', ARRAY['IOP / PHP'], 'Redmond', 'OR', '(541) 555-0144', 'admissions@juniperflats.example', 'https://juniperflats.example', 14000, ARRAY['Cash pay']) $$,
  'an incomplete program saves to the practice''s own list like any other partner'
);

SELECT throws_ok(
  $$ SELECT public.suggest_global_listing('ee200000-0000-0000-0000-000000000001') $$,
  '22023',
  'Add city, state, email, website, monthly cost, and insurance or private pay to submit this program to the shared directory.',
  'an incomplete program is refused with the missing fields spelled out'
);

SELECT ok(
  (SELECT global_partner_id IS NULL FROM public.partners WHERE id = 'ee200000-0000-0000-0000-000000000001')
  AND NOT EXISTS (SELECT 1 FROM public.global_partners WHERE phone_digits = '5415550101'),
  'the refused program stays private and no listing is created'
);

SELECT throws_ok(
  $$ SELECT public.suggest_global_listing('ee200000-0000-0000-0000-000000000003') $$,
  '22023',
  'Add program type to submit this program to the shared directory.',
  'an Interventionist-only partner cannot be submitted even when every other field is filled'
);

SELECT lives_ok(
  $$ SELECT public.suggest_global_listing('ee200000-0000-0000-0000-000000000002') $$,
  'a complete program is accepted for review'
);

SELECT ok(
  (SELECT g.status = 'pending' AND g.verified_at IS NULL
          AND g.suggested_by_org_id = (SELECT org_id FROM submitter_org)
          AND p.global_listing_status = 'pending'
     FROM public.partners p
     JOIN public.global_partners g ON g.id = p.global_partner_id
    WHERE p.id = 'ee200000-0000-0000-0000-000000000002'),
  'the submission lands pending, attributed to the practice, and the partner row shows it'
);

SELECT throws_ok(
  $$ SELECT * FROM public.list_pending_global_listings() $$,
  '42501',
  'Platform admin required',
  'a practice cannot read the review queue'
);

SELECT throws_ok(
  $$ SELECT public.review_global_listing(
       (SELECT global_partner_id FROM public.partners WHERE id = 'ee200000-0000-0000-0000-000000000002'), true) $$,
  '42501',
  'Platform admin required',
  'a practice cannot approve its own submission'
);

SELECT is(
  (SELECT global_listing_status FROM public.partners WHERE id = 'ee200000-0000-0000-0000-000000000002'),
  'pending',
  'the submission is still pending after the refused attempt'
);

SELECT ok(public.is_platform_admin() IS FALSE, 'the app''s admin check answers no for a practice');

-- ─── Another practice: pending listings are not in the directory ────────────

SELECT set_config('request.jwt.claim.sub', 'e3000000-0000-0000-0000-00000000000e', true);

SELECT is(
  (SELECT count(*)::integer FROM public.search_global_partners('Cedar Ridge Recovery')),
  0,
  'a pending submission is invisible to other workspaces'
);

-- ─── Admin: queue and approval ──────────────────────────────────────────────

SELECT set_config('request.jwt.claim.sub', 'e1000000-0000-0000-0000-00000000000e', true);

SELECT ok(public.is_platform_admin(), 'the app''s admin check answers yes for the platform admin');

SELECT is(
  (SELECT count(*)::integer FROM public.list_pending_global_listings()),
  1,
  'the admin queue lists the pending submission'
);

SELECT ok(
  (SELECT q.organization = 'Cedar Ridge Recovery' AND q.name = 'Dana Whitfield'
          AND q.phone = '(541) 555-0142' AND q.email = 'dana@cedarridge.example'
          AND q.website = 'https://www.cedarridge.example' AND q.city = 'Bend' AND q.state = 'OR'
          AND q.types = ARRAY['Inpatient', 'Detox'] AND q.monthly_cost = 32000 AND q.insurance = ARRAY['Aetna']
          AND q.submitted_by_practice = 'Harbor Family Coaching' AND q.submitted_by_member = 'submitter'
          AND q.submitted_at IS NOT NULL AND q.missing_fields = '{}'::text[]
     FROM public.list_pending_global_listings() q),
  'the queue row carries every field the reviewer needs, plus who submitted it and when'
);

SELECT is(
  public.review_global_listing(
    (SELECT id FROM public.global_partners WHERE phone_digits = '5415550142'), true, 'internal remark'),
  'active',
  'the admin approves the submission'
);

SELECT ok(
  (SELECT status = 'active' AND verified_at IS NOT NULL
          AND reviewed_by = 'e1000000-0000-0000-0000-00000000000e' AND reviewed_at IS NOT NULL
          AND review_note = ''
     FROM public.global_partners WHERE phone_digits = '5415550142'),
  'approval makes the listing active and verified, records the reviewer, and keeps no note on a public row'
);

SELECT is(
  (SELECT count(*)::integer FROM public.list_pending_global_listings()),
  0,
  'an approved submission leaves the queue'
);

SELECT throws_ok(
  $$ SELECT public.review_global_listing(
       (SELECT id FROM public.global_partners WHERE phone_digits = '5415550142'), false, 'too late') $$,
  '22023',
  'This submission was already reviewed',
  'a reviewed submission cannot be reviewed twice'
);

SELECT throws_ok(
  $$ SELECT public.review_global_listing('ee900000-0000-0000-0000-000000000009', true) $$,
  'P0002',
  'Directory listing not found',
  'reviewing an unknown listing fails cleanly'
);

-- ─── Approved: the submitter and everyone else see it ───────────────────────

SELECT set_config('request.jwt.claim.sub', 'e2000000-0000-0000-0000-00000000000e', true);

SELECT ok(
  (SELECT global_partner_id IS NOT NULL AND global_listing_status = 'active' AND directory_rejected_at IS NULL
     FROM public.partners WHERE id = 'ee200000-0000-0000-0000-000000000002'),
  'the submitter''s partner row follows the approval through the propagation trigger'
);

SELECT set_config('request.jwt.claim.sub', 'e3000000-0000-0000-0000-00000000000e', true);

SELECT ok(
  (SELECT count(*) = 1 AND bool_and(verified_current)
     FROM public.search_global_partners('Cedar Ridge Recovery')),
  'another workspace now finds the approved program in the directory, verified'
);

-- ─── Decline: the private partner stays, with the note ──────────────────────

SELECT set_config('request.jwt.claim.sub', 'e2000000-0000-0000-0000-00000000000e', true);

SELECT lives_ok(
  $$ SELECT public.suggest_global_listing('ee200000-0000-0000-0000-000000000004') $$,
  'the practice submits a second complete program'
);

SELECT set_config('request.jwt.claim.sub', 'e1000000-0000-0000-0000-00000000000e', true);

SELECT is(
  public.review_global_listing((SELECT id FROM public.global_partners WHERE phone_digits = '5415550144'), false, '  Please confirm the admissions phone number.  '),
  'archived',
  'the admin declines the submission with a note'
);

SELECT ok(
  (SELECT status = 'archived' AND verified_at IS NULL
          AND reviewed_by = 'e1000000-0000-0000-0000-00000000000e' AND reviewed_at IS NOT NULL
          AND review_note = 'Please confirm the admissions phone number.'
     FROM public.global_partners WHERE phone_digits = '5415550144'),
  'the declined listing is archived with the reviewer and the trimmed note kept for audit'
);

SELECT is(
  (SELECT count(*)::integer FROM public.list_pending_global_listings()),
  0,
  'a declined submission leaves the queue'
);

SELECT set_config('request.jwt.claim.sub', 'e2000000-0000-0000-0000-00000000000e', true);

SELECT ok(
  (SELECT organization = 'Juniper Flats Treatment' AND phone = '(541) 555-0144' AND monthly_cost = 14000
          AND global_partner_id IS NULL AND local_overrides = '{}'::text[]
          AND directory_rejected_at IS NOT NULL
          AND directory_review_note = 'Please confirm the admissions phone number.'
     FROM public.partners WHERE id = 'ee200000-0000-0000-0000-000000000004'),
  'the submitter''s private partner is intact, unlinked, and carries the reviewer''s note'
);

SELECT lives_ok(
  $$ UPDATE public.partners SET note = 'Confirmed the admissions line with the front office.'
      WHERE id = 'ee200000-0000-0000-0000-000000000004' $$,
  'the submitter can keep editing the declined program'
);

SELECT isnt(
  public.suggest_global_listing('ee200000-0000-0000-0000-000000000004'),
  -- The practice can still read its own declined listing ("suggester read own").
  (SELECT id FROM public.global_partners WHERE phone_digits = '5415550144' AND status = 'archived'),
  'resubmitting creates a fresh listing instead of resurrecting the declined one'
);

SELECT ok(
  (SELECT global_listing_status = 'pending' AND directory_rejected_at IS NULL AND directory_review_note = ''
     FROM public.partners WHERE id = 'ee200000-0000-0000-0000-000000000004'),
  'resubmitting clears the earlier decline from the partner row'
);

SELECT set_config('request.jwt.claim.sub', 'e3000000-0000-0000-0000-00000000000e', true);

SELECT is(
  (SELECT count(*)::integer FROM public.search_global_partners('Juniper Flats Treatment')),
  0,
  'neither the declined listing nor the resubmission shows in the directory'
);

SELECT set_config('request.jwt.claim.sub', 'e1000000-0000-0000-0000-00000000000e', true);

SELECT ok(
  (SELECT count(*) = 2 AND count(*) FILTER (WHERE status = 'archived') = 1 AND count(*) FILTER (WHERE status = 'pending') = 1
     FROM public.global_partners WHERE phone_digits = '5415550144'),
  'the declined listing stays archived alongside the new pending one'
);

-- ─── Seed workspace: auto-publish is untouched by the completeness rule ─────

SELECT lives_ok(
  $$ INSERT INTO public.partners (id, name, organization, types, phone)
     VALUES ('ee100000-0000-0000-0000-000000000001', 'Admissions', 'Seed Published Program', ARRAY['Inpatient'], '(541) 555-0190'),
            ('ee100000-0000-0000-0000-000000000002', 'Sam Ortiz', 'Ortiz Counseling', ARRAY['Therapist'], '(541) 555-0191') $$,
  'the seed workspace adds a sparse program and an individual professional'
);

SELECT ok(
  (SELECT g.status = 'active' AND g.verified_at IS NOT NULL AND p.global_listing_status = 'active'
     FROM public.partners p
     JOIN public.global_partners g ON g.id = p.global_partner_id
    WHERE p.id = 'ee100000-0000-0000-0000-000000000001'),
  'a seed-workspace program still auto-publishes as active and verified without the required fields'
);

SELECT ok(
  (SELECT global_partner_id IS NULL FROM public.partners WHERE id = 'ee100000-0000-0000-0000-000000000002')
  AND (SELECT count(*) = 1 FROM public.list_pending_global_listings()),
  'seed auto-publish never enters the review queue, and individual professionals still stay private'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
