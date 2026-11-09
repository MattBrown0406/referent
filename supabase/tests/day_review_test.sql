-- Focused coverage for 20261109120000_day_review.sql.
-- Run after a local migration reset with: supabase test db
--
-- This file is never pasted into production.

BEGIN;
SELECT plan(10);

-- r1 has a workspace (created on sign-up); r2's membership is removed below.
INSERT INTO auth.users (id, email)
VALUES
  ('d1000000-0000-0000-0000-0000000000f9', 'dayreview-r1@example.test'),
  ('d2000000-0000-0000-0000-0000000000f9', 'dayreview-r2@example.test');
DELETE FROM public.org_members WHERE user_id = 'd2000000-0000-0000-0000-0000000000f9';

SELECT has_table('public', 'day_review_runs', 'day_review_runs exists');
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.day_review_runs'::regclass),
  'day_review_runs has row level security on'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.day_review_runs', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.day_review_runs', 'INSERT')
  AND NOT has_table_privilege('anon', 'public.day_review_runs', 'SELECT'),
  'clients cannot read or write day_review_runs'
);
SELECT is(
  (SELECT array_agg(column_name::text ORDER BY column_name) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'day_review_runs'),
  ARRAY['created_at', 'id', 'user_id'],
  'a run records who and when, never the notes or the result'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.claim_day_review(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.claim_day_review(uuid)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.claim_day_review(uuid)', 'EXECUTE'),
  'claim_day_review is service-role only'
);

SELECT is(
  public.claim_day_review('d1000000-0000-0000-0000-0000000000f9'),
  59,
  'the first review of the day leaves 59'
);
SELECT throws_ok(
  $$ SELECT public.claim_day_review('d2000000-0000-0000-0000-0000000000f9') $$,
  '42501', NULL,
  'a user with no workspace cannot review'
);
SELECT throws_ok(
  $$ SELECT public.claim_day_review(NULL) $$,
  '28000', NULL,
  'a review needs a user'
);

-- Use up the rest of the day's reviews; the 61st is refused.
SELECT public.claim_day_review('d1000000-0000-0000-0000-0000000000f9') FROM generate_series(1, 59);
SELECT throws_ok(
  $$ SELECT public.claim_day_review('d1000000-0000-0000-0000-0000000000f9') $$,
  '54000', NULL,
  'the 61st review in a day is refused'
);

-- Reviews older than a day no longer count.
UPDATE public.day_review_runs SET created_at = now() - interval '25 hours'
 WHERE user_id = 'd1000000-0000-0000-0000-0000000000f9';
SELECT is(
  public.claim_day_review('d1000000-0000-0000-0000-0000000000f9'),
  59,
  'yesterday''s reviews do not count against today'
);

SELECT * FROM finish();
ROLLBACK;
