-- Focused coverage for 20261024130000_outreach_key_check_cap.sql.
-- Run after a local migration reset with: supabase test db
--
-- This file is never pasted into production.

BEGIN;
SELECT plan(9);

-- k1 has a workspace (created on sign-up); k2's membership is removed below.
INSERT INTO auth.users (id, email)
VALUES
  ('c1000000-0000-0000-0000-0000000000f8', 'keycheck-k1@example.test'),
  ('c2000000-0000-0000-0000-0000000000f8', 'keycheck-k2@example.test');
DELETE FROM public.org_members WHERE user_id = 'c2000000-0000-0000-0000-0000000000f8';

SELECT has_table('public', 'outreach_key_checks', 'outreach_key_checks exists');
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.outreach_key_checks'::regclass),
  'outreach_key_checks has row level security on'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.outreach_key_checks', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.outreach_key_checks', 'INSERT')
  AND NOT has_table_privilege('anon', 'public.outreach_key_checks', 'SELECT'),
  'clients cannot read or write outreach_key_checks'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.claim_outreach_key_check(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.claim_outreach_key_check(uuid)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.claim_outreach_key_check(uuid)', 'EXECUTE'),
  'claim_outreach_key_check is service-role only'
);

SELECT is(
  public.claim_outreach_key_check('c1000000-0000-0000-0000-0000000000f8'),
  19,
  'the first check of the day leaves 19'
);
SELECT throws_ok(
  $$ SELECT public.claim_outreach_key_check('c2000000-0000-0000-0000-0000000000f8') $$,
  '42501', NULL,
  'a user with no workspace cannot check keys'
);
SELECT throws_ok(
  $$ SELECT public.claim_outreach_key_check(NULL) $$,
  '28000', NULL,
  'a check needs a user'
);

-- Use up the rest of the day's checks; the 21st is refused.
SELECT public.claim_outreach_key_check('c1000000-0000-0000-0000-0000000000f8') FROM generate_series(1, 19);
SELECT throws_ok(
  $$ SELECT public.claim_outreach_key_check('c1000000-0000-0000-0000-0000000000f8') $$,
  '54000', NULL,
  'the 21st check in a day is refused'
);

-- Checks older than a day no longer count.
UPDATE public.outreach_key_checks SET created_at = now() - interval '25 hours'
 WHERE user_id = 'c1000000-0000-0000-0000-0000000000f8';
SELECT is(
  public.claim_outreach_key_check('c1000000-0000-0000-0000-0000000000f8'),
  19,
  'yesterday''s checks do not count against today'
);

SELECT * FROM finish();
ROLLBACK;
