-- ReferralFit - day review: a daily cap.
--
-- The day-review Edge Function reads notes the practitioner pasted (a
-- recorder's summary, call notes) with their own Anthropic key and returns
-- what belongs in ReferralFit for them to approve (docs/DAY_REVIEW.md). The
-- user pays for the call, so the cap is only an abuse guard, as for AI
-- drafts and key checks.
--
--   1. day_review_runs: one row per review (who, when). Neither the notes nor
--      the result is ever stored. No client access at all.
--   2. claim_day_review(): service-role only (the Edge Function). Confirms
--      workspace membership, enforces the cap, records the run, and returns
--      how many are left today.
--
-- The function tolerates this migration not being applied yet (it then
-- reviews without the cap), so it can be pasted before or after the function
-- is deployed. Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS public.day_review_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS day_review_runs_user_recent_idx
  ON public.day_review_runs (user_id, created_at DESC);

ALTER TABLE public.day_review_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.day_review_runs FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.day_review_daily_limit()
RETURNS integer
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$ SELECT 60 $$;
REVOKE ALL ON FUNCTION public.day_review_daily_limit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.day_review_daily_limit() TO service_role;

CREATE OR REPLACE FUNCTION public.claim_day_review(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_used integer;
  v_limit integer := public.day_review_daily_limit();
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'A signed-in user is required' USING ERRCODE = '28000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.org_members WHERE user_id = p_user_id) THEN
    RAISE EXCEPTION 'Workspace membership required' USING ERRCODE = '42501';
  END IF;

  -- Serialize per user so two simultaneous reviews cannot both slip under
  -- the cap.
  PERFORM pg_advisory_xact_lock(hashtext('day_review_runs'), hashtext(p_user_id::text));
  SELECT count(*) INTO v_used
    FROM public.day_review_runs
   WHERE user_id = p_user_id AND created_at > now() - interval '24 hours';
  IF v_used >= v_limit THEN
    RAISE EXCEPTION 'Daily review limit reached' USING ERRCODE = '54000';
  END IF;

  INSERT INTO public.day_review_runs (user_id) VALUES (p_user_id);
  -- Only the last day matters; older rows are dropped as reviews come in.
  DELETE FROM public.day_review_runs
   WHERE user_id = p_user_id AND created_at < now() - interval '2 days';
  RETURN v_limit - v_used - 1;
END
$$;
REVOKE ALL ON FUNCTION public.claim_day_review(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_day_review(uuid) TO service_role;

COMMIT;
