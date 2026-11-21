-- Coverage for 20261120120000_nov20_audit.sql: emailed invites need a
-- confirmed account and stay under a ceiling; a new link after "Stop"
-- carries the answers on; failed invites are reported on the case.
-- Run after a local migration reset with: supabase test db
--
-- This file is never pasted into production.

BEGIN;
SELECT plan(15);

-- Actors
--   n1  owner of practice N, email confirmed
--   n2  owner of practice M, email NOT confirmed
INSERT INTO auth.users (id, email, email_confirmed_at)
VALUES
  ('ab100000-0000-0000-0000-0000000000ab', 'audit-n1@example.test', now()),
  ('ab200000-0000-0000-0000-0000000000ab', 'audit-n2@example.test', NULL);

SELECT set_config('request.jwt.claim.sub', 'ab200000-0000-0000-0000-0000000000ab', true);
SET LOCAL ROLE authenticated;
INSERT INTO public.cases (id, title) VALUES ('abc20000-0000-0000-0000-0000000000ab', 'Unconfirmed family');
SELECT throws_ok($$ SELECT public.family_assessment_send('abc20000-0000-0000-0000-0000000000ab', 'A', 'a@example.test', true) $$,
  '42501', NULL, 'an unconfirmed account cannot email an invite');
SELECT ok((public.family_assessment_send('abc20000-0000-0000-0000-0000000000ab', 'A', '', false) ->> 'token') ~ '^[0-9a-f]{64}$',
  'it can still text or copy a link');
RESET ROLE;

-- The ceiling for all practices together.
INSERT INTO public.family_assessment_sends (user_id, email)
SELECT 'ab200000-0000-0000-0000-0000000000ab', 'bulk' || g || '@example.test' FROM generate_series(1, 400) g;
SELECT set_config('request.jwt.claim.sub', 'ab100000-0000-0000-0000-0000000000ab', true);
SET LOCAL ROLE authenticated;
INSERT INTO public.cases (id, title) VALUES
  ('abc10000-0000-0000-0000-0000000000ab', 'Stopped family'),
  ('abc30000-0000-0000-0000-0000000000ab', 'Bounced family');
SELECT throws_ok($$ SELECT public.family_assessment_send('abc10000-0000-0000-0000-0000000000ab', 'B', 'b@example.test', true) $$,
  '54000', NULL, 'past 400 emailed invites a day across all practices, emails pause');
RESET ROLE;
DELETE FROM public.family_assessment_sends WHERE user_id = 'ab200000-0000-0000-0000-0000000000ab';

-- Stop part way, then a new link: the answers carry on.
SELECT set_config('request.jwt.claim.sub', 'ab100000-0000-0000-0000-0000000000ab', true);
SET LOCAL ROLE authenticated;
SELECT set_config('test.first', public.family_assessment_send('abc10000-0000-0000-0000-0000000000ab', 'Rosa', '', false) ->> 'id', true);
RESET ROLE;
UPDATE public.family_assessments
   SET answers = '{"relationship": "Mother"}'::jsonb, step = 3, status = 'started', started_at = now() - interval '1 hour', last_saved_at = now() - interval '5 minutes',
       urgent_notified_at = now() - interval '10 minutes'
 WHERE id = current_setting('test.first')::uuid;
SET LOCAL ROLE authenticated;
SELECT is(public.family_assessment_revoke(current_setting('test.first')::uuid), true, 'stopped');
SELECT set_config('test.second', public.family_assessment_send('abc10000-0000-0000-0000-0000000000ab', '', '', false) ->> 'id', true);
RESET ROLE;
SELECT isnt(current_setting('test.second'), current_setting('test.first'), 'a new assessment, not the stopped one reopened');
SELECT is((SELECT answers FROM public.family_assessments WHERE id = current_setting('test.second')::uuid), '{"relationship": "Mother"}'::jsonb,
  'its answers carry on');
SELECT is((SELECT status || ':' || step FROM public.family_assessments WHERE id = current_setting('test.second')::uuid), 'started:3',
  'in progress, at the same section');
SELECT ok((SELECT urgent_notified_at IS NOT NULL FROM public.family_assessments WHERE id = current_setting('test.second')::uuid),
  'an urgent answer already reported is not reported again');
SELECT is((SELECT status FROM public.family_assessments WHERE id = current_setting('test.first')::uuid), 'revoked', 'the stopped one stays stopped');
SELECT is((SELECT count(*)::int FROM public.family_assessment_links WHERE assessment_id = current_setting('test.first')::uuid), 0,
  'and none of its links work');

-- An invite that could not be delivered is reported on its case only.
SET LOCAL ROLE authenticated;
SELECT set_config('test.bounced', public.family_assessment_send('abc30000-0000-0000-0000-0000000000ab', 'Cy', 'cy@example.test', true) ->> 'id', true);
RESET ROLE;
UPDATE public.email_outbox SET error = 'rejected_address', claimed_at = now()
 WHERE kind = 'family_assessment_invite' AND data ->> 'assessment_id' = current_setting('test.bounced');
SET LOCAL ROLE authenticated;
SELECT is(public.family_assessment_invite_failures('abc30000-0000-0000-0000-0000000000ab'), ARRAY[current_setting('test.bounced')::uuid],
  'the case says the email did not go out');
SELECT is(public.family_assessment_invite_failures('abc10000-0000-0000-0000-0000000000ab'), '{}'::uuid[], 'another case says nothing');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'ab200000-0000-0000-0000-0000000000ab', true);
SET LOCAL ROLE authenticated;
SELECT is(public.family_assessment_invite_failures('abc30000-0000-0000-0000-0000000000ab'), '{}'::uuid[], 'another practice learns nothing');
RESET ROLE;

-- The owner sees (so can list and remove) the practice's own logo files, and no other practice's.
SELECT set_config('test.org_n', org_id::text, true) FROM public.org_members WHERE user_id = 'ab100000-0000-0000-0000-0000000000ab';
INSERT INTO storage.objects (bucket_id, name) VALUES ('org-logos', current_setting('test.org_n') || '/logo-1763600000000.png');
SELECT set_config('request.jwt.claim.sub', 'ab100000-0000-0000-0000-0000000000ab', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'org-logos'), 1, 'the owner sees the practice logo file');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'ab200000-0000-0000-0000-0000000000ab', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'org-logos'), 0, 'another practice does not');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
