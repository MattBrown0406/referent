-- ReferralFit - ai-assist: reading the insurance card (2026-11-21).
--
-- The ai-assist Edge Function's new read_card help reads a family
-- assessment's insurance card photos into the case's Benefits, on the
-- practitioner's own Anthropic key (docs/FAMILY_ASSESSMENT.md, "Reading the
-- card"). This adds the kind to the daily cap: 30 readings a day per user.
-- The user pays for each call, so the cap is only an abuse guard.
--
-- The function tolerates this migration not being applied yet: the older
-- claim_ai_assist refuses an unknown kind ('22023') and the function then
-- reads the card without the cap. Safe to re-run.

BEGIN;

-- The run log may now name the new kind (still who, which kind and when;
-- never the photos or what was read).
ALTER TABLE public.ai_assist_runs DROP CONSTRAINT IF EXISTS ai_assist_runs_kind_check;
ALTER TABLE public.ai_assist_runs ADD CONSTRAINT ai_assist_runs_kind_check
  CHECK (kind IN ('explain_matches', 'level_of_care', 'read_card'));

CREATE OR REPLACE FUNCTION public.ai_assist_daily_limit(p_kind text)
RETURNS integer
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE p_kind
    WHEN 'explain_matches' THEN 100
    WHEN 'level_of_care' THEN 60
    WHEN 'read_card' THEN 30
    ELSE 0
  END
$$;
REVOKE ALL ON FUNCTION public.ai_assist_daily_limit(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_assist_daily_limit(text) TO service_role;

COMMIT;
