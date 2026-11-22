-- Focused coverage for 20261122130000_day_review_recordings.sql.
-- Run after a local migration reset with: supabase test db
--
-- This file is never pasted into production.

BEGIN;
SELECT plan(33);

-- Times a few days back, by the hour (rows are kept 14 days, so fixed dates would age out).
CREATE FUNCTION pg_temp.at(h integer) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT to_char((date_trunc('hour', now()) - interval '3 days' + h * interval '1 hour') AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS"Z"')
$$;
GRANT EXECUTE ON FUNCTION pg_temp.at(integer) TO authenticated;

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
  ARRAY['failing_cleared_at', 'failing_since', 'fingerprints', 'first_seen_at', 'recorder', 'recording_id',
        'reviewed_at', 'saved_at', 'unreviewable_cleared_at', 'unreviewable_since', 'unreviewable_tried_at',
        'updated_at', 'user_id'],
  'ids, times and fingerprints only: never a recording''s words'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.day_review_mark_recordings(uuid, text, jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.day_review_mark_recordings(uuid, text, jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.day_review_mark_one(uuid, text, jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.day_review_mark_one(uuid, text, jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.day_review_recordings_prune()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.day_review_recordings_prune()', 'EXECUTE'),
  'only signed-in users mark, and only through the function that checks their own id'
);
SELECT ok(
  to_regprocedure('public.day_review_mark_recordings(text, jsonb)') IS NULL,
  'no form that takes no account id'
);

-- r1 marks a few recordings.
SELECT set_config('request.jwt.claim.sub', 'd1000000-0000-0000-0000-0000000000fa', true);
SET LOCAL ROLE authenticated;
SELECT is(
  public.day_review_mark_recordings('d1000000-0000-0000-0000-0000000000fa', 'fieldy', format('[
    {"id":"r1","saved_at":"%s","fingerprints":["h:a","h:b"]},
    {"id":"r2","failing_since":"%s"},
    {"id":"r3","unreviewable_since":"%s","unreviewable_tried_at":"%s"}
  ]', pg_temp.at(10), pg_temp.at(9), pg_temp.at(-15), pg_temp.at(-15))::jsonb),
  0,
  'nothing marked reviewed yet'
);
SELECT is(
  (SELECT count(*)::integer FROM public.day_review_recordings WHERE reviewed_at IS NOT NULL),
  0,
  'a mark without a reviewed time is not a review'
);
SELECT public.day_review_mark_recordings('d1000000-0000-0000-0000-0000000000fa', 'fieldy', format('[
  {"id":"r1","saved_at":"%s","fingerprints":["h:b","h:c"]},
  {"id":"r3","unreviewable_since":"%s","unreviewable_tried_at":"%s"}
]', pg_temp.at(11), pg_temp.at(9), pg_temp.at(12))::jsonb);
SELECT is(
  (SELECT fingerprints FROM public.day_review_recordings WHERE recording_id = 'r1'),
  ARRAY['h:a', 'h:b', 'h:c'],
  'fingerprints are joined, each once, never replaced'
);
SELECT is(
  (SELECT ARRAY[unreviewable_since, unreviewable_tried_at] FROM public.day_review_recordings WHERE recording_id = 'r3'),
  ARRAY[pg_temp.at(-15)::timestamptz, pg_temp.at(12)::timestamptz],
  'the first failure and the latest try are kept'
);
SELECT is(
  public.day_review_mark_recordings('d1000000-0000-0000-0000-0000000000fa', 'fieldy', format(
    '[{"id":"r1","reviewed_at":"%s"},{"id":"r2","failing_cleared_at":"%s"},{"id":"r3","unreviewable_cleared_at":"%s"}]',
    pg_temp.at(12), pg_temp.at(13), pg_temp.at(13))::jsonb),
  1,
  'one newly reviewed'
);
SELECT is(
  (SELECT array_agg(coalesce(failing_since, unreviewable_since) ORDER BY recording_id)
     FROM public.day_review_recordings WHERE recording_id IN ('r2', 'r3')),
  ARRAY[NULL::timestamptz, NULL::timestamptz],
  'a failure clock can be stopped, and a "review failed" mark ended'
);
-- Another device that never saw the clears sends its old copy.
SELECT public.day_review_mark_recordings('d1000000-0000-0000-0000-0000000000fa', 'fieldy', format(
  '[{"id":"r2","failing_since":"%s"},{"id":"r3","unreviewable_since":"%s","unreviewable_tried_at":"%s"}]',
  pg_temp.at(9), pg_temp.at(-15), pg_temp.at(12))::jsonb);
SELECT is(
  (SELECT array_agg(coalesce(failing_since, unreviewable_since) ORDER BY recording_id)
     FROM public.day_review_recordings WHERE recording_id IN ('r2', 'r3')),
  ARRAY[NULL::timestamptz, NULL::timestamptz],
  'a stale copy never brings a cleared mark back'
);
SELECT public.day_review_mark_recordings('d1000000-0000-0000-0000-0000000000fa', 'fieldy', format(
  '[{"id":"r2","failing_since":"%s"},{"id":"r3","unreviewable_since":"%s","unreviewable_tried_at":"%s"}]',
  pg_temp.at(14), pg_temp.at(-15), pg_temp.at(15))::jsonb);
SELECT is(
  (SELECT ARRAY[(SELECT failing_since FROM public.day_review_recordings WHERE recording_id = 'r2'),
                (SELECT unreviewable_tried_at FROM public.day_review_recordings WHERE recording_id = 'r3')]),
  ARRAY[pg_temp.at(14)::timestamptz, pg_temp.at(15)::timestamptz],
  'a failure newer than the clear is a new one, and kept'
);
SELECT public.day_review_mark_recordings('d1000000-0000-0000-0000-0000000000fa', 'fieldy', format(
  '[{"id":"r1","saved_at":"%s","fingerprints":["h:z"]},{"id":"r1","reviewed_at":"2099-01-01T00:00:00Z"},{"id":"r1","failing_cleared_at":"%s","unreviewable_cleared_at":"%s"}]',
  pg_temp.at(13), pg_temp.at(20), pg_temp.at(20))::jsonb);
SELECT is(
  (SELECT reviewed_at FROM public.day_review_recordings WHERE recording_id = 'r1'),
  pg_temp.at(12)::timestamptz,
  'a reviewed mark is never taken away, cleared or moved later'
);
SELECT is(
  (SELECT cardinality(fingerprints) FROM public.day_review_recordings WHERE recording_id = 'r1'),
  0,
  'a reviewed recording keeps no fingerprints'
);
SELECT is(
  (SELECT first_seen_at FROM public.day_review_recordings WHERE recording_id = 'r1'),
  pg_temp.at(10)::timestamptz,
  'a re-send never makes a row younger: its age is the earliest time it knew of'
);
SELECT public.day_review_mark_recordings('d1000000-0000-0000-0000-0000000000fa', 'fieldy', jsonb_build_array(
  jsonb_build_object('id', 'old', 'reviewed_at', to_char((now() - interval '20 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))));
SELECT is(
  (SELECT count(*)::integer FROM public.day_review_recordings WHERE recording_id = 'old'),
  0,
  'a mark already past its 14 days is not kept again'
);
SELECT throws_ok(
  $$ SELECT public.day_review_mark_recordings('d1000000-0000-0000-0000-0000000000fa', 'fieldy', '[{"id":"x","fingerprints":["Sarah wants a call back"]}]'::jsonb) $$,
  '22023', NULL,
  'words are refused: only fingerprints'
);
SELECT throws_ok(
  $$ SELECT public.day_review_mark_recordings('d1000000-0000-0000-0000-0000000000fa', 'otter', '[]'::jsonb) $$,
  '22023', NULL,
  'only known recorders'
);
SELECT throws_ok(
  $$ SELECT public.day_review_mark_recordings('d1000000-0000-0000-0000-0000000000fa', 'fieldy', (SELECT jsonb_agg(jsonb_build_object('id', 'i' || g)) FROM generate_series(1, 201) g)) $$,
  '22023', NULL,
  'at most 200 marks a call'
);
SELECT throws_ok(
  $$ INSERT INTO public.day_review_recordings (user_id, recorder, recording_id) VALUES ('d2000000-0000-0000-0000-0000000000fa', 'fieldy', 'forged') $$,
  '42501', NULL,
  'no direct writes'
);
SELECT throws_ok(
  $$ SELECT public.day_review_mark_recordings('d2000000-0000-0000-0000-0000000000fa', 'fieldy', '[{"id":"r9","reviewed_at":"2026-11-21T12:00:00Z"}]'::jsonb) $$,
  '42501', NULL,
  'marks started for another account are refused (an account switch mid-send)'
);

-- The newest 200 fingerprints are kept.
SELECT public.day_review_mark_recordings('d1000000-0000-0000-0000-0000000000fa', 'plaud', jsonb_build_array(jsonb_build_object('id', 'big', 'saved_at', pg_temp.at(10),
  'fingerprints', (SELECT jsonb_agg('h:' || g) FROM generate_series(1, 200) g))));
SELECT public.day_review_mark_recordings('d1000000-0000-0000-0000-0000000000fa', 'plaud', format('[{"id":"big","saved_at":"%s","fingerprints":["h:new","h:5"]}]', pg_temp.at(11))::jsonb);
SELECT is(
  (SELECT ARRAY[cardinality(fingerprints)::text, fingerprints[199], fingerprints[200], ('h:1' = ANY (fingerprints))::text]
     FROM public.day_review_recordings WHERE recording_id = 'big'),
  ARRAY['200', 'h:new', 'h:5', 'false'],
  'the newest 200, last; the oldest drops'
);

-- r2 sees none of r1's rows, and marks only its own.
SELECT set_config('request.jwt.claim.sub', 'd2000000-0000-0000-0000-0000000000fa', true);
SELECT is((SELECT count(*)::integer FROM public.day_review_recordings), 0, 'another account reads nothing of r1''s');
SELECT public.day_review_mark_recordings('d2000000-0000-0000-0000-0000000000fa', 'fieldy', format('[{"id":"r1","reviewed_at":"%s"}]', pg_temp.at(12))::jsonb);
SELECT is((SELECT count(*)::integer FROM public.day_review_recordings), 1, 'and its marks are its own rows');
SELECT throws_ok(
  $$ SELECT public.day_review_mark_recordings('d1000000-0000-0000-0000-0000000000fa', 'fieldy', '[{"id":"r1","failing_since":"2026-11-21T12:00:00Z"}]'::jsonb) $$,
  '42501', NULL,
  'nor can it write r1''s rows by naming r1'
);

SELECT set_config('request.jwt.claim.sub', '', true);
SELECT throws_ok(
  $$ SELECT public.day_review_mark_recordings('d1000000-0000-0000-0000-0000000000fa', 'fieldy', '[]'::jsonb) $$,
  '28000', NULL,
  'a mark needs a signed-in user'
);
RESET ROLE;

SELECT is(
  (SELECT count(*)::integer FROM public.day_review_recordings WHERE user_id = 'd1000000-0000-0000-0000-0000000000fa'),
  4,
  'r1 kept its own four rows'
);
SELECT is(
  (SELECT count(*)::integer FROM public.day_review_recordings WHERE user_id = 'd1000000-0000-0000-0000-0000000000fa' AND failing_since IS NOT NULL),
  1,
  'r2''s refused write changed nothing of r1''s'
);

-- Rows past their 14 days go every day, whether or not the account writes again.
UPDATE public.day_review_recordings SET first_seen_at = now() - interval '15 days', updated_at = now()
 WHERE user_id = 'd1000000-0000-0000-0000-0000000000fa' AND recording_id = 'r3';
SELECT is(public.day_review_recordings_prune(), 1, 'the daily prune removes a row past its 14 days');
SELECT is(
  (SELECT array_agg(recording_id ORDER BY recording_id) FROM public.day_review_recordings WHERE user_id = 'd1000000-0000-0000-0000-0000000000fa'),
  ARRAY['big', 'r1', 'r2'],
  'and only that one'
);
DELETE FROM auth.users WHERE id = 'd2000000-0000-0000-0000-0000000000fa';
SELECT is(
  (SELECT count(*)::integer FROM public.day_review_recordings WHERE user_id = 'd2000000-0000-0000-0000-0000000000fa'),
  0,
  'rows go with the account'
);

SELECT * FROM finish();
ROLLBACK;
