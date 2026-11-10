-- Focused coverage for 20261109140000_family_assessment.sql: the family
-- assessment link, its storage, consent, emails and the practice logo.
-- Run after a local migration reset with: supabase test db
--
-- This file is never pasted into production.

BEGIN;
SELECT plan(105);

-- Actors
--   p1  owner of practice P (sends assessments)
--   p2  member of practice P
--   q1  owner of practice Q (another workspace)
INSERT INTO auth.users (id, email)
VALUES
  ('fa100000-0000-0000-0000-0000000000fa', 'assess-p1@example.test'),
  ('fa200000-0000-0000-0000-0000000000fa', 'assess-p2@example.test'),
  ('fa300000-0000-0000-0000-0000000000fa', 'assess-q1@example.test');
SELECT set_config('test.org_p', org_id::text, true) FROM public.org_members WHERE user_id = 'fa100000-0000-0000-0000-0000000000fa';
SELECT set_config('test.org_q', org_id::text, true) FROM public.org_members WHERE user_id = 'fa300000-0000-0000-0000-0000000000fa';
UPDATE public.org_members SET org_id = current_setting('test.org_p')::uuid, role = 'member', display_name = 'Teammate'
 WHERE user_id = 'fa200000-0000-0000-0000-0000000000fa';
UPDATE public.orgs SET name = 'Cascade Interventions' WHERE id = current_setting('test.org_p')::uuid;

SELECT set_config('request.jwt.claim.sub', 'fa100000-0000-0000-0000-0000000000fa', true);
SET LOCAL ROLE authenticated;
INSERT INTO public.cases (id, title) VALUES
  ('fac10000-0000-0000-0000-0000000000fa', 'Rivera family'),
  ('fac20000-0000-0000-0000-0000000000fa', 'Second family');
RESET ROLE;

-- ===========================================================================
-- A. Schema and grants
-- ===========================================================================

SELECT has_table('public', 'family_assessments', 'family_assessments exists');
SELECT has_table('public', 'family_assessment_links', 'family_assessment_links exists');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.family_assessments'::regclass), 'RLS is on for assessments');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.family_assessment_links'::regclass), 'RLS is on for links');
SELECT ok(
  has_table_privilege('authenticated', 'public.family_assessments', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.family_assessments', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.family_assessments', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.family_assessments', 'DELETE')
  AND NOT has_table_privilege('anon', 'public.family_assessments', 'SELECT'),
  'clients only read assessments; every write goes through a function'
);
SELECT ok(
  (SELECT bool_and(NOT has_table_privilege(role, 'public.family_assessment_links', priv))
     FROM unnest(ARRAY['anon', 'authenticated']) AS role,
          unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS priv),
  'no client role touches the links table'
);
SELECT is((SELECT public FROM storage.buckets WHERE id = 'org-logos'), true, 'logos are public');
SELECT is((SELECT public FROM storage.buckets WHERE id = 'assessment-files'), false, 'card photos are private');
SELECT ok(
  has_function_privilege('authenticated', 'public.family_assessment_send(uuid, text, text, boolean)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.family_assessment_send(uuid, text, text, boolean)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.family_assessment_revoke(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.family_assessment_delete(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.set_org_logo(text)', 'EXECUTE'),
  'only signed-in practitioners send, stop, delete and set a logo'
);
SELECT ok(
  has_function_privilege('anon', 'public.public_family_assessment_open(text)', 'EXECUTE')
  AND has_function_privilege('anon', 'public.public_family_assessment_save(text, jsonb, integer, integer)', 'EXECUTE')
  AND has_function_privilege('anon', 'public.public_family_assessment_submit(text, jsonb, boolean, text, text, text, integer)', 'EXECUTE'),
  'the family page works signed out'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.family_assessment_for_token(text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.family_assessment_for_token(text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.family_assessment_upload_path(text, text)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.family_assessment_upload_path(text, text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.family_assessment_photo_done(text, text, text)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.family_assessment_photo_done(text, text, text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.family_assessment_new_link(uuid, uuid)', 'EXECUTE')
  AND NOT has_table_privilege('authenticated', 'public.family_assessment_sends', 'SELECT'),
  'token lookup, upload paths, photos, links and the send log are service-side only'
);

-- ===========================================================================
-- B. Sending
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'fa100000-0000-0000-0000-0000000000fa', true);
SET LOCAL ROLE authenticated;
SELECT set_config('test.sent1', public.family_assessment_send('fac10000-0000-0000-0000-0000000000fa', 'Maria Lopez', 'Maria@Example.test', true)::text, true);
SELECT set_config('test.sent2', public.family_assessment_send('fac10000-0000-0000-0000-0000000000fa', '', '', false)::text, true);
RESET ROLE;
SELECT set_config('test.id', current_setting('test.sent1')::jsonb ->> 'id', true);
SELECT set_config('test.token1', current_setting('test.sent2')::jsonb ->> 'token', true);

SELECT ok(current_setting('test.token1') ~ '^[0-9a-f]{64}$', 'a link to copy is 64 hex characters');
SELECT is(current_setting('test.sent1')::jsonb ->> 'token', NULL, 'an emailed invite returns no token: its link is made when the email is prepared');
SELECT is(current_setting('test.sent2')::jsonb ->> 'id', current_setting('test.id'), 'a second link reuses the open assessment');
SELECT is((SELECT recipient_email FROM public.family_assessments WHERE id = current_setting('test.id')::uuid), 'maria@example.test',
  'the address is kept (lower case), and an empty one does not erase it');
SELECT is((SELECT count(*)::int FROM public.family_assessment_links WHERE assessment_id = current_setting('test.id')::uuid), 1,
  'only the copied link exists until the email is prepared');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.family_assessment_links WHERE token_hash = convert_to(current_setting('test.token1'), 'UTF8')),
  'only the hash of a token is stored');
SELECT is((SELECT count(*)::int FROM public.email_outbox
            WHERE user_id = 'fa100000-0000-0000-0000-0000000000fa' AND kind = 'family_assessment_invite'
              AND data ->> 'assessment_id' = current_setting('test.id') AND data ->> 'to' = 'maria@example.test'
              AND data ->> 'recipient_name' = 'Maria Lopez' AND NOT (data ? 'link_token')),
  1, 'the invite is queued with the address it was sent to, and no token');

SELECT set_config('request.jwt.claim.sub', 'fa300000-0000-0000-0000-0000000000fa', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.family_assessment_send('fac10000-0000-0000-0000-0000000000fa', 'X', '', false) $$,
  'P0002', NULL, 'another practice cannot send for this case');
SELECT is((SELECT count(*)::int FROM public.family_assessments WHERE case_id = 'fac10000-0000-0000-0000-0000000000fa'), 0,
  'another practice cannot read this case''s assessment');
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', 'fa200000-0000-0000-0000-0000000000fa', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::int FROM public.family_assessments WHERE case_id = 'fac10000-0000-0000-0000-0000000000fa'), 1,
  'a teammate reads it');
SELECT throws_ok($$ SELECT public.family_assessment_send('fac10000-0000-0000-0000-0000000000fa', 'X', 'not-an-email', false) $$,
  '22023', NULL, 'a bad address is refused');
SELECT throws_ok($$ SELECT public.family_assessment_send('fac10000-0000-0000-0000-0000000000fa', 'X', '', true) $$,
  '22023', NULL, 'email needs an address');
-- Ten links work at a time: ten more, and the first one goes.
SELECT public.family_assessment_send('fac10000-0000-0000-0000-0000000000fa', '', '', false) FROM generate_series(1, 10);
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.family_assessment_links WHERE assessment_id = current_setting('test.id')::uuid), 10, 'ten links at most');
SELECT is(public.public_family_assessment_open(current_setting('test.token1')), NULL, 'the oldest link stopped');

-- The daily limits count every link made, however many still work.
INSERT INTO public.family_assessment_sends (user_id, email)
SELECT 'fa300000-0000-0000-0000-0000000000fa', '' FROM generate_series(1, 40);
INSERT INTO public.family_assessment_sends (user_id, email)
SELECT 'fa100000-0000-0000-0000-0000000000fa', 'busy@example.test' FROM generate_series(1, 3);
SELECT set_config('request.jwt.claim.sub', 'fa300000-0000-0000-0000-0000000000fa', true);
SET LOCAL ROLE authenticated;
INSERT INTO public.cases (id, title) VALUES ('fac30000-0000-0000-0000-0000000000fa', 'Q family');
SELECT throws_ok($$ SELECT public.family_assessment_send('fac30000-0000-0000-0000-0000000000fa', '', '', false) $$,
  '54000', NULL, 'more than 40 links a day is refused');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'fa100000-0000-0000-0000-0000000000fa', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.family_assessment_send('fac20000-0000-0000-0000-0000000000fa', 'B', 'busy@example.test', true) $$,
  '54000', NULL, 'a fourth invite to one address in a day is refused');
-- Use the newest link from here on.
SELECT set_config('test.token', public.family_assessment_send('fac10000-0000-0000-0000-0000000000fa', '', '', false) ->> 'token', true);
RESET ROLE;
DELETE FROM public.family_assessment_sends WHERE user_id = 'fa300000-0000-0000-0000-0000000000fa' OR email = 'busy@example.test';

-- ===========================================================================
-- C. The family's page
-- ===========================================================================

SET LOCAL ROLE anon;
SELECT is(public.public_family_assessment_open(current_setting('test.token')) ->> 'status', 'open', 'the link opens the assessment');
SELECT is(public.public_family_assessment_open(current_setting('test.token')) ->> 'practice_name', 'Cascade Interventions', 'in the practice''s name');
SELECT ok(public.public_family_assessment_open(current_setting('test.token')) ->> 'consent_text' LIKE '%Cascade Interventions may share this information%',
  'the consent names the practice');
SELECT is(public.public_family_assessment_open(current_setting('test.token')) ->> 'consent_version', '2026-11-08', 'and its version');
SELECT is(public.public_family_assessment_open(repeat('a', 64)), NULL, 'a wrong link opens nothing');
SELECT is(public.public_family_assessment_open('short'), NULL, 'a cut-off link opens nothing');
SELECT is((public.public_family_assessment_open(current_setting('test.token')) ->> 'revision')::int, 0, 'a new assessment is at revision 0');
SELECT is((public.public_family_assessment_save(current_setting('test.token'), '{"contactName": "Maria Lopez", "suicideIdeation": "no"}', 3, 0) ->> 'revision')::int,
  1, 'the family saves as they go, and each save is a new revision');
SELECT throws_ok(format($$ SELECT public.public_family_assessment_save(%L, '{"contactName": "Old tab"}', 2, 0) $$, current_setting('test.token')),
  'RFA02', NULL, 'a page with older answers cannot write over newer ones');
SELECT is((public.public_family_assessment_save(current_setting('test.token'), '{"suicideIdeation": "no", "contactName": "Maria Lopez"}', 3, 0) ->> 'revision')::int,
  1, 'the same answers from an older page are no conflict and no new revision (moving between sections)');
SELECT throws_ok(format($$ SELECT public.public_family_assessment_save(%L, '[1]', 1, 1) $$, current_setting('test.token')),
  '22023', NULL, 'answers must be an object');
SELECT throws_ok(format($$ SELECT public.public_family_assessment_save(%L, jsonb_build_object('x', repeat('y', 300000)), 1, 1) $$, current_setting('test.token')),
  '22023', NULL, 'answers that are too large are refused');
SELECT is(public.public_family_assessment_open(current_setting('test.token')) -> 'answers' ->> 'contactName', 'Maria Lopez', 'and come back to them');
SELECT is((public.public_family_assessment_open(current_setting('test.token')) ->> 'step')::int, 3, 'on the step they left');
RESET ROLE;
SELECT is((SELECT status FROM public.family_assessments WHERE id = current_setting('test.id')::uuid), 'started', 'saving starts it');

SET LOCAL ROLE service_role;
SELECT set_config('test.prefix', public.family_assessment_upload_path(current_setting('test.token'), 'front'), true);
SELECT is(current_setting('test.prefix'),
  'fac10000-0000-0000-0000-0000000000fa/' || current_setting('test.id') || '/card-front', 'a card photo goes under the case and assessment');
SELECT is(public.family_assessment_upload_path(current_setting('test.token'), '../x'), NULL, 'only front or back');
SELECT throws_ok(format($$ SELECT public.family_assessment_photo_done(%L, 'front', %L) $$, current_setting('test.token'), current_setting('test.prefix') || '-' || repeat('a', 32)),
  'P0002', NULL, 'a photo that did not arrive is not recorded');
SELECT throws_ok(format($$ SELECT public.family_assessment_photo_done(%L, 'front', %L) $$, current_setting('test.token'), 'fac10000-0000-0000-0000-0000000000fa/other/card-front-' || repeat('a', 32)),
  '22023', NULL, 'only a name the upload function made for this assessment');
RESET ROLE;
INSERT INTO storage.objects (bucket_id, name)
VALUES ('assessment-files', current_setting('test.prefix') || '-' || repeat('a', 32)),
       ('assessment-files', current_setting('test.prefix') || '-' || repeat('b', 32));
SET LOCAL ROLE service_role;
SELECT is(public.family_assessment_photo_done(current_setting('test.token'), 'front', current_setting('test.prefix') || '-' || repeat('a', 32)), '',
  'an arrived photo is recorded');
SELECT is(public.family_assessment_photo_done(current_setting('test.token'), 'front', current_setting('test.prefix') || '-' || repeat('b', 32)),
  current_setting('test.prefix') || '-' || repeat('a', 32), 'a new photo replaces it, and the old one is named for removal');
RESET ROLE;
SELECT is((SELECT card_front_path FROM public.family_assessments WHERE id = current_setting('test.id')::uuid),
  current_setting('test.prefix') || '-' || repeat('b', 32), 'the practitioner sees the newest photo');
SET LOCAL ROLE anon;
SELECT is(public.public_family_assessment_open(current_setting('test.token')) ->> 'card_front', 'true', 'the page shows it arrived');
RESET ROLE;

-- Card photos: the practice's members read them; another practice does not.
SELECT set_config('request.jwt.claim.sub', 'fa200000-0000-0000-0000-0000000000fa', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'assessment-files'), 2, 'a teammate can open the card photos');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'fa300000-0000-0000-0000-0000000000fa', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'assessment-files'), 0, 'another practice cannot');
RESET ROLE;

-- An answer that suggests danger tells the practitioner before the family finishes, once.
SET LOCAL ROLE anon;
SELECT public.public_family_assessment_save(current_setting('test.token'), '{"contactName": "Maria Lopez", "suicideIdeation": "yes"}', 4, 1);
SELECT public.public_family_assessment_save(current_setting('test.token'), '{"contactName": "Maria Lopez", "suicideIdeation": "yes", "x": 1}', 4, 2);
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.email_outbox
            WHERE user_id = 'fa100000-0000-0000-0000-0000000000fa' AND kind = 'family_assessment_urgent'
              AND data ->> 'assessment_id' = current_setting('test.id')), 1,
  'a yes to suicidal thoughts emails the practitioner while the family is still filling it in, once');

-- ===========================================================================
-- D. Consent and submitting
-- ===========================================================================

SELECT set_config('test.final', '{"contactName": "Maria Lopez", "suicideIdeation": "yes", "immediateSafetyConcerns": "He keeps a gun in the truck."}', true);
SET LOCAL ROLE anon;
SELECT throws_ok(format($$ SELECT public.public_family_assessment_submit(%L, %L, false, 'Maria Lopez', '2026-11-08', 'Safari', 3) $$,
  current_setting('test.token'), current_setting('test.final')), '22023', NULL, 'the box must be checked');
SELECT throws_ok(format($$ SELECT public.public_family_assessment_submit(%L, %L, true, 'M', '2026-11-08', 'Safari', 3) $$,
  current_setting('test.token'), current_setting('test.final')), '22023', NULL, 'a full name signs');
SELECT throws_ok(format($$ SELECT public.public_family_assessment_submit(%L, %L, true, 'Maria Lopez', '2020-01-01', 'Safari', 3) $$,
  current_setting('test.token'), current_setting('test.final')), '22023', NULL, 'only the current consent can be signed');
SELECT throws_ok(format($$ SELECT public.public_family_assessment_submit(%L, %L, true, 'Maria Lopez', '2026-11-08', 'Safari', 2) $$,
  current_setting('test.token'), current_setting('test.final')), 'RFA02', NULL, 'a page with older answers cannot send');
SELECT is(public.public_family_assessment_submit(current_setting('test.token'), current_setting('test.final')::jsonb, true, '  Maria Lopez ', '2026-11-08', 'Safari', 3) ->> 'urgent',
  'true', 'it is sent, and marked urgent');
SELECT throws_ok(format($$ SELECT public.public_family_assessment_submit(%L, %L, true, 'Maria Lopez', '2026-11-08', 'Safari', 4) $$,
  current_setting('test.token'), current_setting('test.final')), 'RFA01', NULL, 'it is sent once');
SELECT throws_ok(format($$ SELECT public.public_family_assessment_save(%L, '{}', 1, 4) $$, current_setting('test.token')),
  'RFA01', NULL, 'and cannot be changed after');
SELECT is(public.public_family_assessment_open(current_setting('test.token')) ->> 'status', 'submitted', 'the link now says it was sent');
SELECT ok(NOT (public.public_family_assessment_open(current_setting('test.token')) ? 'answers'), 'and never shows the answers again');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT throws_ok(format($$ SELECT public.family_assessment_photo_done(%L, 'front', %L) $$, current_setting('test.token'), current_setting('test.prefix') || '-' || repeat('a', 32)),
  'P0002', NULL, 'a photo cannot be swapped after it was sent');
RESET ROLE;

SELECT is((SELECT consent_name FROM public.family_assessments WHERE id = current_setting('test.id')::uuid), 'Maria Lopez', 'the typed name is the signature');
SELECT ok((SELECT consent_text LIKE '%Cascade Interventions%' AND consent_at IS NOT NULL AND consent_client = 'Safari'
             FROM public.family_assessments WHERE id = current_setting('test.id')::uuid), 'the signed words, time and browser are kept');
SELECT is((SELECT urgent FROM public.family_assessments WHERE id = current_setting('test.id')::uuid),
  ARRAY['suicidal_thoughts', 'safety_concern'], 'the urgent answers are named');
SELECT is((SELECT count(*)::int FROM public.email_outbox
            WHERE user_id = 'fa100000-0000-0000-0000-0000000000fa' AND kind = 'family_assessment_submitted'
              AND data ->> 'assessment_id' = current_setting('test.id')), 1, 'the practitioner who sent it is told');

SELECT is(public.family_assessment_urgent('{"immediateSafetyConcerns": "None."}'), '{}'::text[], '"None." is not a concern');
SELECT is(public.family_assessment_urgent('{"immediateSafetyConcerns": "n/a"}'), '{}'::text[], '"n/a" is not a concern');
SELECT is(public.family_assessment_urgent(jsonb_build_object('immediateSafetyConcerns', chr(10) || ' No concerns at this time!')), '{}'::text[],
  'a new line before "No concerns at this time!" is not a concern either');
SELECT is(public.family_assessment_urgent('{"immediateSafetyConcerns": "None that I''m aware of"}'), '{}'::text[], 'nor "None that I''m aware of"');
SELECT is(public.family_assessment_urgent(jsonb_build_object('suicideIdeation', chr(9) || 'yes', 'immediateSafetyConcerns', 'crisis' || chr(10))),
  ARRAY['suicidal_thoughts', 'safety_concern'], 'spaces, tabs and new lines are trimmed as the app trims them');
SELECT is(public.family_assessment_urgent('{"homicidalIdeation": "yes", "urgencyLevel": "crisis", "suicideIdeation": "unknown"}'),
  ARRAY['homicidal_thoughts', 'crisis'], 'threats and a crisis are urgent; "unknown" is not');

-- ===========================================================================
-- E. The emails
-- ===========================================================================

SELECT is((SELECT email FROM public.email_outbox_prepare(
            (SELECT o.id FROM public.email_outbox o WHERE o.kind = 'family_assessment_submitted' AND o.data ->> 'assessment_id' = current_setting('test.id')))),
  'assess-p1@example.test', 'the finished email goes to the practitioner');
SELECT is((SELECT data ->> 'urgent' FROM public.email_outbox_prepare(
            (SELECT o.id FROM public.email_outbox o WHERE o.kind = 'family_assessment_submitted' AND o.data ->> 'assessment_id' = current_setting('test.id')))),
  'true', 'and says it needs attention, without names');
SELECT is((SELECT count(*)::int FROM public.email_outbox_prepare(
            (SELECT o.id FROM public.email_outbox o WHERE o.kind = 'family_assessment_urgent' AND o.data ->> 'assessment_id' = current_setting('test.id')))),
  0, 'the in-progress alert is skipped once the finished email says it');
-- The invite queued earlier: the assessment is now submitted, so it no longer goes out.
SELECT is((SELECT count(*)::int FROM public.email_outbox_prepare(
            (SELECT o.id FROM public.email_outbox o WHERE o.kind = 'family_assessment_invite' AND o.data ->> 'assessment_id' = current_setting('test.id')))),
  0, 'an invite for a sent assessment is not emailed');
SELECT ok((SELECT error = 'not_open' AND NOT (data ? 'to') AND NOT (data ? 'recipient_name') FROM public.email_outbox
            WHERE kind = 'family_assessment_invite' AND data ->> 'assessment_id' = current_setting('test.id')), 'and the family''s address leaves the outbox');

-- A fresh invite on the second case: to the family, replies to the practitioner, its link made now.
SELECT set_config('request.jwt.claim.sub', 'fa100000-0000-0000-0000-0000000000fa', true);
SET LOCAL ROLE authenticated;
SELECT set_config('test.id2', public.family_assessment_send('fac20000-0000-0000-0000-0000000000fa', 'Ana Rivera', 'ana@example.test', true) ->> 'id', true);
SELECT set_config('test.share2', public.family_assessment_send('fac20000-0000-0000-0000-0000000000fa', '', '', false) ->> 'token', true);
RESET ROLE;
SELECT set_config('test.invite2', (SELECT o.id::text FROM public.email_outbox o WHERE o.kind = 'family_assessment_invite' AND o.data ->> 'assessment_id' = current_setting('test.id2')), true);
SELECT is((SELECT email FROM public.email_outbox_prepare(current_setting('test.invite2')::uuid)), 'ana@example.test', 'the invite goes to the family''s address');
SELECT ok((SELECT data ->> 'reply_to' = 'assess-p1@example.test' AND data ->> 'practice_name' = 'Cascade Interventions' AND data ->> 'recipient_name' = 'Ana Rivera'
             FROM public.email_outbox_prepare(current_setting('test.invite2')::uuid)),
  'in the practice''s name, with replies to the practitioner');
SELECT is(public.public_family_assessment_open((SELECT data ->> 'link_token' FROM public.email_outbox WHERE id = current_setting('test.invite2')::uuid)) ->> 'status',
  'open', 'the link in the invite, made when it was prepared, works');
SELECT is((SELECT count(*)::int FROM public.family_assessment_links WHERE assessment_id = current_setting('test.id2')::uuid), 2,
  'preparing it again makes no second link');
SELECT public.email_outbox_record(jsonb_build_array(jsonb_build_object('id', current_setting('test.invite2'), 'provider_id', 'p1')));
SELECT ok((SELECT NOT (data ? 'link_token') AND NOT (data ? 'to') AND NOT (data ? 'reply_to') FROM public.email_outbox WHERE id = current_setting('test.invite2')::uuid),
  'once sent, no token, address or reply-to stays on the outbox');

-- A mistyped address, then corrected: the earlier links stop, and the invite to the mistyped address never goes.
SELECT set_config('request.jwt.claim.sub', 'fa100000-0000-0000-0000-0000000000fa', true);
SET LOCAL ROLE authenticated;
SELECT public.family_assessment_send('fac20000-0000-0000-0000-0000000000fa', '', 'anna@example.test', true);
SELECT public.family_assessment_send('fac20000-0000-0000-0000-0000000000fa', '', 'ana.r@example.test', true);
RESET ROLE;
SELECT is(public.public_family_assessment_open(current_setting('test.share2')), NULL, 'a corrected address stops the earlier links');
SELECT is((SELECT count(*)::int FROM public.email_outbox_prepare(
            (SELECT o.id FROM public.email_outbox o WHERE o.kind = 'family_assessment_invite' AND o.data ->> 'to' = 'anna@example.test'))),
  0, 'an invite to an address corrected since does not go out');
SELECT is((SELECT email FROM public.email_outbox_prepare(
            (SELECT o.id FROM public.email_outbox o WHERE o.kind = 'family_assessment_invite' AND o.data ->> 'to' = 'ana.r@example.test'))),
  'ana.r@example.test', 'the invite to the corrected address does');

-- An expired assessment sent again: its old links stay stopped.
SELECT set_config('request.jwt.claim.sub', 'fa100000-0000-0000-0000-0000000000fa', true);
SET LOCAL ROLE authenticated;
SELECT set_config('test.share3', public.family_assessment_send('fac20000-0000-0000-0000-0000000000fa', '', '', false) ->> 'token', true);
RESET ROLE;
UPDATE public.family_assessments SET expires_at = now() - interval '1 day' WHERE id = current_setting('test.id2')::uuid;
SET LOCAL ROLE authenticated;
SELECT public.family_assessment_send('fac20000-0000-0000-0000-0000000000fa', '', '', false);
RESET ROLE;
SELECT is(public.public_family_assessment_open(current_setting('test.share3')), NULL, 'sending an expired assessment again does not bring its old links back');
-- The invite to ana.r@ was prepared above; sending the expired assessment again retired its link.
SELECT is((SELECT count(*)::int FROM public.email_outbox_prepare(
            (SELECT o.id FROM public.email_outbox o WHERE o.kind = 'family_assessment_invite' AND o.data ->> 'to' = 'ana.r@example.test'))),
  0, 'a retried invite whose link was retired meanwhile is not sent with a dead link');
SELECT is((SELECT error FROM public.email_outbox WHERE kind = 'family_assessment_invite' AND data ->> 'to' IS NULL AND error = 'link_retired' LIMIT 1),
  'link_retired', 'and says why');

-- ===========================================================================
-- F. Stopping and deleting
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'fa300000-0000-0000-0000-0000000000fa', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(format($$ SELECT public.family_assessment_revoke(%L) $$, current_setting('test.id2')), 'P0002', NULL, 'another practice cannot stop it');
SELECT throws_ok(format($$ SELECT public.family_assessment_delete(%L) $$, current_setting('test.id2')), 'P0002', NULL, 'or delete it');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'fa200000-0000-0000-0000-0000000000fa', true);
SET LOCAL ROLE authenticated;
SELECT is(public.family_assessment_revoke(current_setting('test.id2')::uuid), true, 'a teammate stops it');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.family_assessment_links WHERE assessment_id = current_setting('test.id2')::uuid), 0, 'its links stop');
SELECT public.email_enqueue('fa100000-0000-0000-0000-0000000000fa', 'family_assessment_urgent', jsonb_build_object('assessment_id', current_setting('test.id2')));
SELECT is((SELECT email FROM public.email_outbox_prepare(
            (SELECT o.id FROM public.email_outbox o WHERE o.kind = 'family_assessment_urgent' AND o.data ->> 'assessment_id' = current_setting('test.id2')))),
  'assess-p1@example.test', 'stopping the link does not cancel an alert that someone may be in danger');
SELECT set_config('request.jwt.claim.sub', 'fa100000-0000-0000-0000-0000000000fa', true);
SET LOCAL ROLE authenticated;
SELECT is(public.family_assessment_delete(current_setting('test.id2')::uuid), true, 'the practice deletes it');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.family_assessments WHERE id = current_setting('test.id2')::uuid), 0, 'and it is gone');
SELECT is((SELECT count(*)::int FROM public.email_outbox WHERE data ->> 'assessment_id' = current_setting('test.id2') AND sent_at IS NULL AND error IS NULL), 0,
  'and none of its emails will go out');

-- ===========================================================================
-- G. The practice's logo
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'fa200000-0000-0000-0000-0000000000fa', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.set_org_logo(NULL) $$, '42501', NULL, 'only the owner changes the logo');
RESET ROLE;
SELECT set_config('test.logo', current_setting('test.org_p') || '/logo-1731000000000.png', true);
SELECT set_config('request.jwt.claim.sub', 'fa100000-0000-0000-0000-0000000000fa', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(format($$ SELECT public.set_org_logo(%L) $$, current_setting('test.org_q') || '/logo-1731000000000.png'),
  '22023', NULL, 'only a logo in the practice''s own folder');
SELECT throws_ok(format($$ SELECT public.set_org_logo(%L) $$, current_setting('test.logo')), 'P0002', NULL, 'the file must be uploaded first');
INSERT INTO storage.objects (bucket_id, name, owner_id)
VALUES ('org-logos', current_setting('test.logo'), 'fa100000-0000-0000-0000-0000000000fa');
SELECT is(public.set_org_logo(current_setting('test.logo')), current_setting('test.logo'), 'the owner sets the logo');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'fa300000-0000-0000-0000-0000000000fa', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(format($$ INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('org-logos', %L, 'fa300000-0000-0000-0000-0000000000fa') $$,
  current_setting('test.org_p') || '/logo-1731000000001.png'), '42501', NULL, 'another practice cannot upload into this practice''s folder');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'fa100000-0000-0000-0000-0000000000fa', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(format($$ INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('org-logos', %L, 'fa100000-0000-0000-0000-0000000000fa') $$,
  current_setting('test.org_p') || '/anything.svg'), '42501', NULL, 'a logo file is named as the app names it');
INSERT INTO storage.objects (bucket_id, name, owner_id)
SELECT 'org-logos', current_setting('test.org_p') || '/logo-173100000000' || n || '.png', 'fa100000-0000-0000-0000-0000000000fa'
  FROM generate_series(2, 5) n;
SELECT throws_ok(format($$ INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('org-logos', %L, 'fa100000-0000-0000-0000-0000000000fa') $$,
  current_setting('test.org_p') || '/logo-1731000000009.png'), '42501', NULL, 'at most five logo files');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT is(public.public_family_assessment_open(current_setting('test.token')) ->> 'logo_path', current_setting('test.logo'), 'the family sees the logo');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
