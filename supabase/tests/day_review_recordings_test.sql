-- Focused coverage for 20261122130000_day_review_recordings.sql.
-- Run after a local migration reset with: supabase test db
--
-- This file is never pasted into production.

BEGIN;
SELECT plan(23);

INSERT INTO auth.users (id, email)
VALUES
  ('d1000000-0000-0000-0000-0000000000fa', 'recordings-r1@example.test'),
  ('d2000000-0000-0000-0000-0000000000fa', 'recordings-r2@example.test');

SELECT has_table('public', 'day_review_recordings', 'day_review_recordings exists');
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.day_review_recordings'::regclass),
  'row level security is on'
);
SELECT ok(
  has_table_privilege('authenticated', 'public.day_review_recordings', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.day_review_recordings', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.day_review_recordings', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.day_review_recordings', 'DELETE')
  AND NOT has_table_privilege('authenticated', 'public.day_review_recordings', 'TRUNCATE')
  AND NOT has_table_privilege('anon', 'public.day_review_recordings', 'SELECT'),
  'clients read only; writes go through the function; anon nothing'
);
SELECT is(
  (SELECT array_agg(column_name::text ORDER BY column_name) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'day_review_recordings'),
  ARRAY['failing_since', 'fingerprints', 'recorder', 'recording_id', 'reviewed_at', 'saved_at',
        'unreviewable_since', 'unreviewable_tried_at', 'updated_at', 'user_id'],
  'ids, times and fingerprints only: never a recording''s words'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.day_review_mark_recordings(text, jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.day_review_mark_recordings(text, jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.day_review_mark_one(uuid, text, jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.day_review_mark_one(uuid, text, jsonb)', 'EXECUTE'),
  'only signed-in users mark, and only through the function that uses their own id'
);

-- r1 marks a few recordings.
SELECT set_config('request.jwt.claim.sub', 'd1000000-0000-0000-0000-0000000000fa', true);
SET LOCAL ROLE authenticated;
SELECT is(
  public.day_review_mark_recordings('fieldy', '[
    {"id":"r1","saved_at":"2026-11-21T10:00:00Z","fingerprints":["h:a","h:b"]},
    {"id":"r2","failing_since":"2026-11-21T09:00:00Z"},
    {"id":"r3","unreviewable_since":"2026-11-20T09:00:00Z","unreviewable_tried_at":"2026-11-20T09:00:00Z"}
  ]'::jsonb),
  0,
  'nothing marked reviewed yet'
);
SELECT is(
  (SELECT count(*)::integer FROM public.day_review_recordings WHERE reviewed_at IS NOT NULL),
  0,
  'a mark without a reviewed time is not a review'
);
SELECT public.day_review_mark_recordings('fieldy', '[
  {"id":"r1","saved_at":"2026-11-21T11:00:00Z","fingerprints":["h:b","h:c"]},
  {"id":"r3","unreviewable_since":"2026-11-21T09:00:00Z","unreviewable_tried_at":"2026-11-21T12:00:00Z"}
]'::jsonb);
SELECT is(
  (SELECT fingerprints FROM public.day_review_recordings WHERE recording_id = 'r1'),
  ARRAY['h:a', 'h:b', 'h:c'],
  'fingerprints are joined, each once, never replaced'
);
SELECT is(
  (SELECT ARRAY[unreviewable_since, unreviewable_tried_at] FROM public.day_review_recordings WHERE recording_id = 'r3'),
  ARRAY['2026-11-20T09:00:00Z'::timestamptz, '2026-11-21T12:00:00Z'::timestamptz],
  'the first failure and the latest try are kept'
);
SELECT is(
  public.day_review_mark_recordings('fieldy', '[{"id":"r1","reviewed_at":"2026-11-21T12:00:00Z"},{"id":"r2","clear_failing":true},{"id":"r3","clear_unreviewable":true}]'::jsonb),
  1,
  'one newly reviewed'
);
SELECT is(
  (SELECT ARRAY[failing_since, unreviewable_since] FROM public.day_review_recordings WHERE recording_id IN ('r2', 'r3') ORDER BY recording_id LIMIT 1),
  ARRAY[NULL::timestamptz, NULL::timestamptz],
  'a failure clock can be stopped'
);
SELECT public.day_review_mark_recordings('fieldy', '[{"id":"r1","saved_at":"2026-11-21T13:00:00Z","fingerprints":["h:z"]},{"id":"r1","reviewed_at":"2099-01-01T00:00:00Z"}]'::jsonb);
SELECT is(
  (SELECT reviewed_at FROM public.day_review_recordings WHERE recording_id = 'r1'),
  '2026-11-21T12:00:00Z'::timestamptz,
  'a reviewed mark is never taken away or moved later'
);
SELECT is(
  (SELECT cardinality(fingerprints) FROM public.day_review_recordings WHERE recording_id = 'r1'),
  0,
  'a reviewed recording keeps no fingerprints'
);
SELECT throws_ok(
  $$ SELECT public.day_review_mark_recordings('fieldy', '[{"id":"x","fingerprints":["Sarah wants a call back"]}]'::jsonb) $$,
  '22023', NULL,
  'words are refused: only fingerprints'
);
SELECT throws_ok(
  $$ SELECT public.day_review_mark_recordings('otter', '[]'::jsonb) $$,
  '22023', NULL,
  'only known recorders'
);
SELECT throws_ok(
  $$ SELECT public.day_review_mark_recordings('fieldy', (SELECT jsonb_agg(jsonb_build_object('id', 'i' || g)) FROM generate_series(1, 201) g)) $$,
  '22023', NULL,
  'at most 200 marks a call'
);
SELECT throws_ok(
  $$ INSERT INTO public.day_review_recordings (user_id, recorder, recording_id) VALUES ('d2000000-0000-0000-0000-0000000000fa', 'fieldy', 'forged') $$,
  '42501', NULL,
  'no direct writes'
);

-- The newest 200 fingerprints are kept.
SELECT public.day_review_mark_recordings('plaud', jsonb_build_array(jsonb_build_object('id', 'big', 'saved_at', '2026-11-21T10:00:00Z',
  'fingerprints', (SELECT jsonb_agg('h:' || g) FROM generate_series(1, 200) g))));
SELECT public.day_review_mark_recordings('plaud', '[{"id":"big","saved_at":"2026-11-21T11:00:00Z","fingerprints":["h:new","h:5"]}]'::jsonb);
SELECT is(
  (SELECT ARRAY[cardinality(fingerprints)::text, fingerprints[199], fingerprints[200], ('h:1' = ANY (fingerprints))::text]
     FROM public.day_review_recordings WHERE recording_id = 'big'),
  ARRAY['200', 'h:new', 'h:5', 'false'],
  'the newest 200, last; the oldest drops'
);

-- r2 sees none of r1's rows, and marks only its own.
SELECT set_config('request.jwt.claim.sub', 'd2000000-0000-0000-0000-0000000000fa', true);
SELECT is((SELECT count(*)::integer FROM public.day_review_recordings), 0, 'another account reads nothing of r1''s');
SELECT public.day_review_mark_recordings('fieldy', '[{"id":"r1","reviewed_at":"2026-11-21T12:00:00Z"}]'::jsonb);
SELECT is((SELECT count(*)::integer FROM public.day_review_recordings), 1, 'and its marks are its own rows');

SELECT set_config('request.jwt.claim.sub', '', true);
SELECT throws_ok(
  $$ SELECT public.day_review_mark_recordings('fieldy', '[]'::jsonb) $$,
  '28000', NULL,
  'a mark needs a signed-in user'
);
RESET ROLE;

SELECT is(
  (SELECT count(*)::integer FROM public.day_review_recordings WHERE user_id = 'd1000000-0000-0000-0000-0000000000fa'),
  4,
  'r1 kept its own four rows'
);
DELETE FROM auth.users WHERE id = 'd2000000-0000-0000-0000-0000000000fa';
SELECT is(
  (SELECT count(*)::integer FROM public.day_review_recordings WHERE user_id = 'd2000000-0000-0000-0000-0000000000fa'),
  0,
  'rows go with the account'
);

SELECT * FROM finish();
ROLLBACK;
