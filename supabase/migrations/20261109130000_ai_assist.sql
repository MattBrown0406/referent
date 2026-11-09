-- ReferralFit - ai-assist: a daily cap per kind of help.
--
-- The ai-assist Edge Function runs small AI helps with the practitioner's
-- own Anthropic key: the family's "why these programs" (explain_matches)
-- and a suggested level of care from a family assessment (level_of_care).
-- The user pays for the call, so the cap is only an abuse guard, as for AI
-- drafts and day review.
--
--   1. ai_assist_runs: one row per call (who, which kind, when). Neither the
--      input nor the result is ever stored. No client access at all.
--   2. claim_ai_assist(): service-role only (the Edge Function). Confirms
--      workspace membership, enforces the cap for that kind, records the
--      run, and returns how many are left today.
--
-- The function tolerates this migration not being applied yet (it then
-- runs without the cap), so it can be pasted before or after the function
-- is deployed. Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ai_assist_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('explain_matches', 'level_of_care')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_assist_runs_user_kind_recent_idx
  ON public.ai_assist_runs (user_id, kind, created_at DESC);

ALTER TABLE public.ai_assist_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_assist_runs FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ai_assist_daily_limit(p_kind text)
RETURNS integer
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE p_kind
    WHEN 'explain_matches' THEN 100
    WHEN 'level_of_care' THEN 60
    ELSE 0
  END
$$;
REVOKE ALL ON FUNCTION public.ai_assist_daily_limit(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_assist_daily_limit(text) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_ai_assist(p_user_id uuid, p_kind text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_used integer;
  v_limit integer := public.ai_assist_daily_limit(p_kind);
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'A signed-in user is required' USING ERRCODE = '28000';
  END IF;
  IF v_limit <= 0 THEN
    RAISE EXCEPTION 'Unknown kind of help' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.org_members WHERE user_id = p_user_id) THEN
    RAISE EXCEPTION 'Workspace membership required' USING ERRCODE = '42501';
  END IF;

  -- Serialize per user and kind so two simultaneous calls cannot both slip
  -- under the cap.
  PERFORM pg_advisory_xact_lock(hashtext('ai_assist_runs'), hashtext(p_user_id::text || ':' || p_kind));
  SELECT count(*) INTO v_used
    FROM public.ai_assist_runs
   WHERE user_id = p_user_id AND kind = p_kind AND created_at > now() - interval '24 hours';
  IF v_used >= v_limit THEN
    RAISE EXCEPTION 'Daily limit reached' USING ERRCODE = '54000';
  END IF;

  INSERT INTO public.ai_assist_runs (user_id, kind) VALUES (p_user_id, p_kind);
  -- Only the last day matters; older rows are dropped as calls come in.
  DELETE FROM public.ai_assist_runs
   WHERE user_id = p_user_id AND created_at < now() - interval '2 days';
  RETURN v_limit - v_used - 1;
END
$$;
REVOKE ALL ON FUNCTION public.claim_ai_assist(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_assist(uuid, text) TO service_role;

COMMIT;
