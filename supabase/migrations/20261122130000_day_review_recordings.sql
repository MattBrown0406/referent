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
--      failed on its own (and was last tried), when either was cleared, and
--      the fingerprints of items saved from it. Never a recording's words: a
--      fingerprint is a short one-way hash ("h:" and at most 12 base-36
--      characters), checked here.
--   2. Clients read their own rows only (RLS on auth.uid()); anon nothing.
--      Writes go only through day_review_mark_recordings(), which joins what
--      it is sent with what is there and never takes a reviewed mark away; a
--      clear newer than a failure's last time ends it (a stale copy from
--      another device does not bring it back). It writes only for the
--      account signed in, and refuses (42501) a call made for another.
--   3. Rows go with the account (ON DELETE CASCADE) and 14 days after the
--      first time they knew of (first_seen_at: the earliest time sent, never
--      moved later by a re-send), every day (pg_cron, where it is on) as
--      well as at each write. A mark already older than that is not kept
--      again.
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
  failing_cleared_at timestamptz,
  unreviewable_since timestamptz,
  unreviewable_tried_at timestamptz,
  unreviewable_cleared_at timestamptz,
  saved_at timestamptz,
  fingerprints text[] NOT NULL DEFAULT '{}'::text[]
    CHECK (cardinality(fingerprints) <= 200
      AND array_position(fingerprints, NULL) IS NULL
      AND array_to_string(fingerprints, ',') ~ '^(h:[0-9a-z]{1,12}(,h:[0-9a-z]{1,12})*)?$'),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, recorder, recording_id)
);
-- A copy made from an earlier draft of this file gets the later columns.
ALTER TABLE public.day_review_recordings
  ADD COLUMN IF NOT EXISTS failing_cleared_at timestamptz,
  ADD COLUMN IF NOT EXISTS unreviewable_cleared_at timestamptz,
  ADD COLUMN IF NOT EXISTS first_seen_at timestamptz NOT NULL DEFAULT now();
DROP INDEX IF EXISTS public.day_review_recordings_recent_idx;
CREATE INDEX IF NOT EXISTS day_review_recordings_age_idx
  ON public.day_review_recordings (first_seen_at);

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

-- One recording's row (as it is, or empty) with a mark joined in: reviewed
-- stays reviewed, at its earliest time; a failure lives on only when it is
-- newer than the latest clear (so a stale copy from another device never
-- brings back one that was cleared); fingerprints are joined. first_seen_at
-- is the earliest time ever sent: a re-send never makes a row younger.
CREATE OR REPLACE FUNCTION public.day_review_join_mark(r public.day_review_recordings, p_mark jsonb, p_prints text[])
RETURNS public.day_review_recordings
LANGUAGE plpgsql STABLE
SET search_path = public
AS $$
DECLARE
  v_rev timestamptz := day_review_at(p_mark->>'reviewed_at');
  v_fs timestamptz := day_review_at(p_mark->>'failing_since');
  v_fc timestamptz := day_review_at(p_mark->>'failing_cleared_at');
  v_us timestamptz := day_review_at(p_mark->>'unreviewable_since');
  v_ut timestamptz := day_review_at(p_mark->>'unreviewable_tried_at');
  v_uc timestamptz := day_review_at(p_mark->>'unreviewable_cleared_at');
  v_sa timestamptz := day_review_at(p_mark->>'saved_at');
BEGIN
  IF v_us IS NULL THEN v_ut := NULL; END IF;
  IF cardinality(p_prints) = 0 THEN v_sa := NULL; END IF;
  r.first_seen_at := least(r.first_seen_at, now(), v_rev, v_fs, v_fc, v_us, v_ut, v_uc, v_sa);
  r.reviewed_at := least(r.reviewed_at, v_rev);
  r.failing_cleared_at := greatest(r.failing_cleared_at, v_fc);
  r.unreviewable_cleared_at := greatest(r.unreviewable_cleared_at, v_uc);
  IF r.reviewed_at IS NOT NULL THEN
    r.failing_since := NULL; r.unreviewable_since := NULL; r.unreviewable_tried_at := NULL;
    r.saved_at := NULL; r.fingerprints := '{}'::text[];
    RETURN r;
  END IF;
  r.failing_since := least(
    CASE WHEN r.failing_since > coalesce(r.failing_cleared_at, '-infinity') THEN r.failing_since END,
    CASE WHEN v_fs > coalesce(r.failing_cleared_at, '-infinity') THEN v_fs END);
  -- "Review failed": each side lives on only when its last try is after the clear.
  IF coalesce(r.unreviewable_tried_at, r.unreviewable_since) <= r.unreviewable_cleared_at THEN
    r.unreviewable_since := NULL; r.unreviewable_tried_at := NULL;
  END IF;
  IF coalesce(v_ut, v_us) <= r.unreviewable_cleared_at THEN v_us := NULL; v_ut := NULL; END IF;
  r.unreviewable_since := least(r.unreviewable_since, v_us);
  r.unreviewable_tried_at := CASE WHEN r.unreviewable_since IS NOT NULL
    THEN greatest(r.unreviewable_tried_at, r.unreviewable_since, v_ut) END;
  r.fingerprints := CASE WHEN v_sa < r.saved_at THEN day_review_join_fingerprints(p_prints, r.fingerprints)
    ELSE day_review_join_fingerprints(coalesce(r.fingerprints, '{}'::text[]), p_prints) END;
  r.saved_at := greatest(r.saved_at, v_sa);
  RETURN r;
END
$$;
REVOKE ALL ON FUNCTION public.day_review_join_mark(public.day_review_recordings, jsonb, text[]) FROM PUBLIC, anon, authenticated;

-- One recording's marks for one user, joined with what is there. Internal:
-- only day_review_mark_recordings() calls it, with auth.uid(). Answers true
-- when it was not reviewed before. A new row already past its 14 days is
-- not kept.
CREATE OR REPLACE FUNCTION public.day_review_mark_one(p_user uuid, p_recorder text, p_mark jsonb)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id text := p_mark->>'id';
  v_prints text[];
  r public.day_review_recordings%ROWTYPE;
  v_was timestamptz;
BEGIN
  IF jsonb_typeof(p_mark) IS DISTINCT FROM 'object' OR v_id IS NULL OR length(v_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Unreadable mark' USING ERRCODE = '22023';
  END IF;
  v_prints := CASE WHEN jsonb_typeof(p_mark->'fingerprints') = 'array'
    THEN ARRAY(SELECT jsonb_array_elements_text(p_mark->'fingerprints')) ELSE '{}'::text[] END;
  IF cardinality(v_prints) > 200 OR EXISTS (SELECT 1 FROM unnest(v_prints) f WHERE f !~ '^h:[0-9a-z]{1,12}$') THEN
    RAISE EXCEPTION 'Not a fingerprint' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO r FROM day_review_recordings
   WHERE user_id = p_user AND recorder = p_recorder AND recording_id = v_id FOR UPDATE;
  IF NOT FOUND THEN
    r.user_id := p_user; r.recorder := p_recorder; r.recording_id := v_id; r.fingerprints := '{}'::text[];
  END IF;
  v_was := r.reviewed_at;
  r := day_review_join_mark(r, p_mark, v_prints);
  IF r.first_seen_at < now() - interval '14 days' THEN
    DELETE FROM day_review_recordings WHERE user_id = p_user AND recorder = p_recorder AND recording_id = v_id;
    RETURN false;
  END IF;
  r.updated_at := now();
  INSERT INTO day_review_recordings AS t (user_id, recorder, recording_id, reviewed_at, failing_since,
    failing_cleared_at, unreviewable_since, unreviewable_tried_at, unreviewable_cleared_at, saved_at,
    fingerprints, first_seen_at, updated_at)
  VALUES (r.user_id, r.recorder, r.recording_id, r.reviewed_at, r.failing_since, r.failing_cleared_at,
    r.unreviewable_since, r.unreviewable_tried_at, r.unreviewable_cleared_at, r.saved_at, r.fingerprints,
    r.first_seen_at, r.updated_at)
  ON CONFLICT (user_id, recorder, recording_id) DO UPDATE SET
    reviewed_at = EXCLUDED.reviewed_at, failing_since = EXCLUDED.failing_since,
    failing_cleared_at = EXCLUDED.failing_cleared_at, unreviewable_since = EXCLUDED.unreviewable_since,
    unreviewable_tried_at = EXCLUDED.unreviewable_tried_at, unreviewable_cleared_at = EXCLUDED.unreviewable_cleared_at,
    saved_at = EXCLUDED.saved_at, fingerprints = EXCLUDED.fingerprints,
    first_seen_at = EXCLUDED.first_seen_at, updated_at = EXCLUDED.updated_at;
  RETURN v_was IS NULL AND r.reviewed_at IS NOT NULL;
END
$$;
REVOKE ALL ON FUNCTION public.day_review_mark_one(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;

-- An earlier draft took no account id.
DROP FUNCTION IF EXISTS public.day_review_mark_recordings(text, jsonb);

-- What the app calls, naming the account it was started for (p_user): refused
-- (42501) when that is not the account signed in. p_marks: a JSON array (at
-- most 200) of
--   {"id", "reviewed_at"?, "failing_since"?, "failing_cleared_at"?,
--    "unreviewable_since"?, "unreviewable_tried_at"?,
--    "unreviewable_cleared_at"?, "saved_at"?, "fingerprints"?: [..]}
-- Answers how many it marked reviewed that were not before. Rows past their
-- 14 days go first; at most 6,000 rows per account.
CREATE OR REPLACE FUNCTION public.day_review_mark_recordings(p_user uuid, p_recorder text, p_marks jsonb)
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
  IF p_user IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'These marks are for another account' USING ERRCODE = '42501';
  END IF;
  IF p_recorder IS NULL OR p_recorder NOT IN ('fieldy', 'plaud') OR jsonb_typeof(p_marks) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_marks) > 200 THEN
    RAISE EXCEPTION 'Unreadable marks' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('day_review_recordings'), hashtext(v_user::text));
  DELETE FROM day_review_recordings WHERE user_id = v_user AND first_seen_at < now() - interval '14 days';
  IF (SELECT count(*) FROM day_review_recordings WHERE user_id = v_user) + jsonb_array_length(p_marks) > 6000 THEN
    RAISE EXCEPTION 'Too many recordings kept' USING ERRCODE = '54000';
  END IF;
  FOR v_mark IN SELECT value FROM jsonb_array_elements(p_marks) LOOP
    IF public.day_review_mark_one(v_user, p_recorder, v_mark) THEN v_new := v_new + 1; END IF;
  END LOOP;
  RETURN v_new;
END
$$;
REVOKE ALL ON FUNCTION public.day_review_mark_recordings(uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.day_review_mark_recordings(uuid, text, jsonb) TO authenticated;

-- Every account's rows past their 14 days, whether or not it writes again.
CREATE OR REPLACE FUNCTION public.day_review_recordings_prune()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM day_review_recordings WHERE first_seen_at < now() - interval '14 days';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;
REVOKE ALL ON FUNCTION public.day_review_recordings_prune() FROM PUBLIC, anon, authenticated, service_role;

-- Daily, where pg_cron is on (harmless elsewhere; re-run replaces the job).
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'referralfit-day-review-recordings-prune-daily') THEN
      PERFORM cron.unschedule('referralfit-day-review-recordings-prune-daily');
    END IF;
    PERFORM cron.schedule('referralfit-day-review-recordings-prune-daily', '50 3 * * *', 'SELECT public.day_review_recordings_prune()');
  END IF;
END
$do$;

COMMIT;
