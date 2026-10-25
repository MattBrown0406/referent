-- ReferralFit - a daily cap on Anthropic key checks.
--
-- The draft-follow-up Edge Function's {action: "verify"} checks a user's own
-- Anthropic key with one model-list call. Drafts are capped per user per day
-- (claim_outreach_draft); key checks were not, so a signed-in account could
-- use the function to test any number of keys. This caps them per user, the
-- same way.
--
--   1. outreach_key_checks: one row per key check (who, when). The key itself
--      is never stored. No client access at all.
--   2. claim_outreach_key_check(): service-role only (the Edge Function).
--      Confirms workspace membership, enforces the cap, records the check.
--
-- The function tolerates this migration not being applied yet (it then checks
-- keys without the cap), so it can be pasted before or after the function is
-- deployed.

BEGIN;

CREATE TABLE IF NOT EXISTS public.outreach_key_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outreach_key_checks_user_recent_idx
  ON public.outreach_key_checks (user_id, created_at DESC);

ALTER TABLE public.outreach_key_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.outreach_key_checks FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.outreach_key_check_daily_limit()
RETURNS integer
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$ SELECT 20 $$;
REVOKE ALL ON FUNCTION public.outreach_key_check_daily_limit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.outreach_key_check_daily_limit() TO service_role;

CREATE OR REPLACE FUNCTION public.claim_outreach_key_check(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_used integer;
  v_limit integer := public.outreach_key_check_daily_limit();
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'A signed-in user is required' USING ERRCODE = '28000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.org_members WHERE user_id = p_user_id) THEN
    RAISE EXCEPTION 'Workspace membership required' USING ERRCODE = '42501';
  END IF;

  -- Serialize per user so two simultaneous checks cannot both slip under
  -- the cap.
  PERFORM pg_advisory_xact_lock(hashtext('outreach_key_checks'), hashtext(p_user_id::text));
  SELECT count(*) INTO v_used
    FROM public.outreach_key_checks
   WHERE user_id = p_user_id AND created_at > now() - interval '24 hours';
  IF v_used >= v_limit THEN
    RAISE EXCEPTION 'Daily key check limit reached' USING ERRCODE = '54000';
  END IF;

  INSERT INTO public.outreach_key_checks (user_id) VALUES (p_user_id);
  -- Only the last day matters; older rows are dropped as checks come in.
  DELETE FROM public.outreach_key_checks
   WHERE user_id = p_user_id AND created_at < now() - interval '2 days';
  RETURN v_limit - v_used - 1;
END
$$;
REVOKE ALL ON FUNCTION public.claim_outreach_key_check(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_outreach_key_check(uuid) TO service_role;

COMMIT;
