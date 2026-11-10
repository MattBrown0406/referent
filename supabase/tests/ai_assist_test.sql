-- Focused coverage for 20261109130000_ai_assist.sql.
-- Run after a local migration reset with: supabase test db
--
-- This file is never pasted into production.

BEGIN;
SELECT plan(11);

-- a1 has a workspace (created on sign-up); a2's membership is removed below.
INSERT INTO auth.users (id, email)
VALUES
  ('a1000000-0000-0000-0000-0000000000a5', 'aiassist-a1@example.test'),
  ('a2000000-0000-0000-0000-0000000000a5', 'aiassist-a2@example.test');
DELETE FROM public.org_members WHERE user_id = 'a2000000-0000-0000-0000-0000000000a5';

SELECT has_table('public', 'ai_assist_runs', 'ai_assist_runs exists');
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ai_assist_runs'::regclass),
  'ai_assist_runs has row level security on'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.ai_assist_runs', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.ai_assist_runs', 'INSERT')
  AND NOT has_table_privilege('anon', 'public.ai_assist_runs', 'SELECT'),
  'clients cannot read or write ai_assist_runs'
);
SELECT is(
  (SELECT array_agg(column_name::text ORDER BY column_name) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ai_assist_runs'),
  ARRAY['created_at', 'id', 'kind', 'user_id'],
  'a run records who, which kind and when, never the input or the result'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.claim_ai_assist(uuid, text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.claim_ai_assist(uuid, text)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.claim_ai_assist(uuid, text)', 'EXECUTE'),
  'claim_ai_assist is service-role only'
);

SELECT is(
  public.claim_ai_assist('a1000000-0000-0000-0000-0000000000a5', 'explain_matches'),
  99,
  'the first explanation of the day leaves 99'
);
SELECT throws_ok(
  $$ SELECT public.claim_ai_assist('a1000000-0000-0000-0000-0000000000a5', 'write_my_novel') $$,
  '22023', NULL,
  'an unknown kind is refused'
);
SELECT throws_ok(
  $$ SELECT public.claim_ai_assist('a2000000-0000-0000-0000-0000000000a5', 'explain_matches') $$,
  '42501', NULL,
  'a user with no workspace cannot use it'
);

-- Each kind has its own cap: use up level_of_care (60); explanations still work.
SELECT public.claim_ai_assist('a1000000-0000-0000-0000-0000000000a5', 'level_of_care') FROM generate_series(1, 60);
SELECT throws_ok(
  $$ SELECT public.claim_ai_assist('a1000000-0000-0000-0000-0000000000a5', 'level_of_care') $$,
  '54000', NULL,
  'the 61st level-of-care suggestion in a day is refused'
);
SELECT is(
  public.claim_ai_assist('a1000000-0000-0000-0000-0000000000a5', 'explain_matches'),
  98,
  'another kind is counted on its own'
);

-- Calls older than a day no longer count.
UPDATE public.ai_assist_runs SET created_at = now() - interval '25 hours'
 WHERE user_id = 'a1000000-0000-0000-0000-0000000000a5' AND kind = 'level_of_care';
SELECT is(
  public.claim_ai_assist('a1000000-0000-0000-0000-0000000000a5', 'level_of_care'),
  59,
  'yesterday''s calls do not count against today'
);

SELECT * FROM finish();
ROLLBACK;
