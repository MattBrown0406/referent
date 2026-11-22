-- ReferralFit - day review: which recordings were reviewed, on the server
-- (2026-11-21).
--
-- Fieldy now connects in the web app as well as on the phone
-- (docs/DAY_REVIEW.md, "Fieldy on the web"). Each device kept on its own
-- which recordings it had reviewed, so the phone and the browser could offer
-- the same recording twice. This keeps those marks per account on the
-- server, where both read them.
--
--   1. day_review_recordings: one row per (user, recorder, recording id):
--      when it was reviewed, when reading it started failing, when its review
--      failed on its own (and was last tried), and the fingerprints of items
--      saved from it. Never a recording's words: a fingerprint is a short
--      one-way hash ("h:" and at most 12 base-36 characters), checked here.
--      Rows go with the account (ON DELETE CASCADE) and after 14 days.
--   2. Clients read their own rows only (RLS on auth.uid()); anon nothing.
--      Writes go only through day_review_mark_recordings(), which joins what
--      it is sent with what is there and never takes a reviewed mark away.
--
-- The app keeps working without this migration (each device keeps its own
-- marks, as before) and copies them up once it is applied. Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS public.day_review_recordings (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recorder text NOT NULL CHECK (recorder IN ('fieldy', 'plaud')),
  recording_id text NOT NULL CHECK (length(recording_id) BETWEEN 1 AND 200),
  reviewed_at timestamptz,
  failing_since timestamptz,
  unreviewable_since timestamptz,
  unreviewable_tried_at timestamptz,
  saved_at timestamptz,
  fingerprints text[] NOT NULL DEFAULT '{}'::text[]
    CHECK (cardinality(fingerprints) <= 200
      AND array_position(fingerprints, NULL) IS NULL
      AND array_to_string(fingerprints, ',') ~ '^(h:[0-9a-z]{1,12}(,h:[0-9a-z]{1,12})*)?$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, recorder, recording_id)
);
CREATE INDEX IF NOT EXISTS day_review_recordings_recent_idx
  ON public.day_review_recordings (user_id, updated_at);

ALTER TABLE public.day_review_recordings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.day_review_recordings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.day_review_recordings TO authenticated;

DROP POLICY IF EXISTS "Own reviewed recordings" ON public.day_review_recordings;
CREATE POLICY "Own reviewed recordings" ON public.day_review_recordings
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Two fingerprint lists joined: the old ones not sent again, then the new,
-- each once, the newest 200 kept (as the app's mergeFingerprints).
CREATE OR REPLACE FUNCTION public.day_review_join_fingerprints(p_old text[], p_new text[])
RETURNS text[]
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  WITH listed AS (
    SELECT f, o FROM unnest(coalesce(p_old, '{}'::text[])) WITH ORDINALITY AS a(f, o)
     WHERE f IS NOT NULL AND NOT (f = ANY (coalesce(p_new, '{}'::text[])))
    UNION ALL
    SELECT f, o + 1000000 FROM unnest(coalesce(p_new, '{}'::text[])) WITH ORDINALITY AS b(f, o)
     WHERE f IS NOT NULL
  ), once AS (
    SELECT f, min(o) AS o FROM listed GROUP BY f
  ), newest AS (
    SELECT f, o FROM once ORDER BY o DESC LIMIT 200
  )
  SELECT coalesce(array_agg(f ORDER BY o), '{}'::text[]) FROM newest
$$;
REVOKE ALL ON FUNCTION public.day_review_join_fingerprints(text[], text[]) FROM PUBLIC, anon, authenticated;

-- A time the app sent, never later than now; NULL when none was sent.
CREATE OR REPLACE FUNCTION public.day_review_at(p_value text)
RETURNS timestamptz
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $$ SELECT CASE WHEN p_value IS NULL THEN NULL ELSE least(p_value::timestamptz, now()) END $$;
REVOKE ALL ON FUNCTION public.day_review_at(text) FROM PUBLIC, anon, authenticated;

-- One recording's marks for one user, joined with what is there (never a
-- reviewed mark taken away). Internal: only day_review_mark_recordings()
-- calls it, with auth.uid(). Answers true when it was not reviewed before.
CREATE OR REPLACE FUNCTION public.day_review_mark_one(p_user uuid, p_recorder text, p_mark jsonb)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id text := p_mark->>'id';
  v_prints text[];
  v_was timestamptz;
  v_at timestamptz;
  v_now timestamptz := now();
BEGIN
  IF jsonb_typeof(p_mark) IS DISTINCT FROM 'object' OR v_id IS NULL OR length(v_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Unreadable mark' USING ERRCODE = '22023';
  END IF;
  v_prints := CASE WHEN jsonb_typeof(p_mark->'fingerprints') = 'array'
    THEN ARRAY(SELECT jsonb_array_elements_text(p_mark->'fingerprints')) ELSE '{}'::text[] END;
  IF cardinality(v_prints) > 200 OR EXISTS (SELECT 1 FROM unnest(v_prints) f WHERE f !~ '^h:[0-9a-z]{1,12}$') THEN
    RAISE EXCEPTION 'Not a fingerprint' USING ERRCODE = '22023';
  END IF;
  v_at := public.day_review_at(p_mark->>'reviewed_at');
  SELECT reviewed_at INTO v_was FROM day_review_recordings
   WHERE user_id = p_user AND recorder = p_recorder AND recording_id = v_id;
  INSERT INTO day_review_recordings AS r (user_id, recorder, recording_id, reviewed_at, failing_since,
    unreviewable_since, unreviewable_tried_at, saved_at, fingerprints, updated_at)
  VALUES (p_user, p_recorder, v_id, v_at,
    CASE WHEN v_at IS NULL THEN public.day_review_at(p_mark->>'failing_since') END,
    CASE WHEN v_at IS NULL THEN public.day_review_at(p_mark->>'unreviewable_since') END,
    CASE WHEN v_at IS NULL THEN public.day_review_at(p_mark->>'unreviewable_tried_at') END,
    CASE WHEN v_at IS NULL THEN public.day_review_at(p_mark->>'saved_at') END,
    CASE WHEN v_at IS NULL THEN public.day_review_join_fingerprints('{}'::text[], v_prints) ELSE '{}'::text[] END, v_now)
  ON CONFLICT (user_id, recorder, recording_id) DO UPDATE SET
    reviewed_at = least(r.reviewed_at, EXCLUDED.reviewed_at),
    failing_since = CASE WHEN coalesce(r.reviewed_at, EXCLUDED.reviewed_at) IS NOT NULL
      OR (p_mark->>'clear_failing')::boolean IS TRUE THEN NULL ELSE least(r.failing_since, EXCLUDED.failing_since) END,
    unreviewable_since = CASE WHEN coalesce(r.reviewed_at, EXCLUDED.reviewed_at) IS NOT NULL
      OR (p_mark->>'clear_unreviewable')::boolean IS TRUE THEN NULL ELSE least(r.unreviewable_since, EXCLUDED.unreviewable_since) END,
    unreviewable_tried_at = CASE WHEN coalesce(r.reviewed_at, EXCLUDED.reviewed_at) IS NOT NULL
      OR (p_mark->>'clear_unreviewable')::boolean IS TRUE THEN NULL ELSE greatest(r.unreviewable_tried_at, EXCLUDED.unreviewable_tried_at) END,
    saved_at = CASE WHEN coalesce(r.reviewed_at, EXCLUDED.reviewed_at) IS NOT NULL THEN NULL ELSE greatest(r.saved_at, EXCLUDED.saved_at) END,
    fingerprints = CASE WHEN coalesce(r.reviewed_at, EXCLUDED.reviewed_at) IS NOT NULL THEN '{}'::text[]
      WHEN EXCLUDED.saved_at < r.saved_at THEN public.day_review_join_fingerprints(EXCLUDED.fingerprints, r.fingerprints)
      ELSE public.day_review_join_fingerprints(r.fingerprints, EXCLUDED.fingerprints) END,
    updated_at = v_now;
  RETURN v_was IS NULL AND v_at IS NOT NULL;
END
$$;
REVOKE ALL ON FUNCTION public.day_review_mark_one(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;

-- What the app calls. p_marks: a JSON array (at most 200) of
--   {"id", "reviewed_at"?, "failing_since"?, "clear_failing"?,
--    "unreviewable_since"?, "unreviewable_tried_at"?, "clear_unreviewable"?,
--    "saved_at"?, "fingerprints"?: [..]}
-- Answers how many it marked reviewed that were not before. Rows older than
-- 14 days go first; at most 6,000 rows per account.
CREATE OR REPLACE FUNCTION public.day_review_mark_recordings(p_recorder text, p_marks jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_mark jsonb;
  v_new integer := 0;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF p_recorder IS NULL OR p_recorder NOT IN ('fieldy', 'plaud') OR jsonb_typeof(p_marks) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_marks) > 200 THEN
    RAISE EXCEPTION 'Unreadable marks' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('day_review_recordings'), hashtext(v_user::text));
  DELETE FROM day_review_recordings WHERE user_id = v_user AND updated_at < now() - interval '14 days';
  IF (SELECT count(*) FROM day_review_recordings WHERE user_id = v_user) + jsonb_array_length(p_marks) > 6000 THEN
    RAISE EXCEPTION 'Too many recordings kept' USING ERRCODE = '54000';
  END IF;
  FOR v_mark IN SELECT value FROM jsonb_array_elements(p_marks) LOOP
    IF public.day_review_mark_one(v_user, p_recorder, v_mark) THEN v_new := v_new + 1; END IF;
  END LOOP;
  RETURN v_new;
END
$$;
REVOKE ALL ON FUNCTION public.day_review_mark_recordings(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.day_review_mark_recordings(text, jsonb) TO authenticated;

COMMIT;
