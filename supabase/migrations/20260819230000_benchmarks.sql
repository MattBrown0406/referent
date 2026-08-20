BEGIN;

-- Cross-practice benchmarks (Phase 5 of the platform buildout).
--
-- One SECURITY DEFINER read path computes anonymized, aggregate-only network
-- metrics and the caller's own workspace values side by side. Privacy rules:
--   * gated by the 'benchmarks' entitlement;
--   * network metrics are medians of per-workspace values — no row-level or
--     per-workspace data ever crosses tenants;
--   * k-anonymity: each network metric requires at least 3 qualifying
--     workspaces (and a minimum activity floor per workspace to qualify),
--     otherwise that metric returns NULL;
--   * client labels, notes, and any PHI-adjacent fields are never touched —
--     only counts, rates, ratings, and dollar quotes.

CREATE OR REPLACE FUNCTION public.fetch_benchmarks()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.current_org_id();
  v_network jsonb;
  v_workspace jsonb;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF NOT public.org_has_entitlement('benchmarks') THEN
    RAISE EXCEPTION 'Benchmarks require the benchmarks plan' USING ERRCODE = '42501';
  END IF;

  WITH referral_stats AS (
    SELECT org_id,
           count(*) FILTER (WHERE admitted IS NOT NULL) AS decided,
           avg(CASE WHEN admitted THEN 1.0 ELSE 0.0 END)
             FILTER (WHERE admitted IS NOT NULL) AS admit_rate,
           count(family_experience) AS rated,
           avg(family_experience)::numeric AS family_experience
      FROM public.referrals
     WHERE direction = 'outbound'
     GROUP BY org_id
  ),
  case_stats AS (
    SELECT org_id,
           count(*) FILTER (WHERE status IN ('placed','aftercare')) AS placed,
           count(*) FILTER (WHERE status = 'lost') AS lost,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY quoted_amount)
             FILTER (WHERE quoted_amount IS NOT NULL AND quoted_amount > 0) AS median_quote
      FROM public.cases
     GROUP BY org_id
  ),
  qualified AS (
    SELECT
      (SELECT count(*) FROM referral_stats WHERE decided >= 5) AS admit_orgs,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY admit_rate)
         FROM referral_stats WHERE decided >= 5) AS admit_rate,
      (SELECT count(*) FROM referral_stats WHERE rated >= 3) AS rating_orgs,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY family_experience)
         FROM referral_stats WHERE rated >= 3) AS family_experience,
      (SELECT count(*) FROM case_stats WHERE placed + lost >= 5) AS placement_orgs,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY placed::numeric / (placed + lost))
         FROM case_stats WHERE placed + lost >= 5) AS placement_rate,
      (SELECT count(*) FROM case_stats WHERE median_quote IS NOT NULL) AS quote_orgs,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY median_quote)
         FROM case_stats WHERE median_quote IS NOT NULL) AS median_quote
  )
  SELECT jsonb_build_object(
    'admit_rate',        CASE WHEN admit_orgs     >= 3 THEN round(admit_rate::numeric, 3) END,
    'family_experience', CASE WHEN rating_orgs    >= 3 THEN round(family_experience::numeric, 2) END,
    'placement_rate',    CASE WHEN placement_orgs >= 3 THEN round(placement_rate::numeric, 3) END,
    'median_quote',      CASE WHEN quote_orgs     >= 3 THEN round(median_quote::numeric) END,
    'contributor_floor', 3
  )
  INTO v_network
  FROM qualified;

  SELECT jsonb_build_object(
    'outbound_referrals', (SELECT count(*) FROM public.referrals
                            WHERE org_id = v_org AND direction = 'outbound'),
    'admit_rate', (SELECT round(avg(CASE WHEN admitted THEN 1.0 ELSE 0.0 END)::numeric, 3)
                     FROM public.referrals
                    WHERE org_id = v_org AND direction = 'outbound' AND admitted IS NOT NULL),
    'family_experience', (SELECT round(avg(family_experience)::numeric, 2)
                            FROM public.referrals
                           WHERE org_id = v_org AND direction = 'outbound'),
    'cases_total', (SELECT count(*) FROM public.cases WHERE org_id = v_org),
    'placement_rate', (SELECT CASE WHEN count(*) FILTER (WHERE status IN ('placed','aftercare','lost')) > 0
                              THEN round((count(*) FILTER (WHERE status IN ('placed','aftercare')))::numeric
                                   / (count(*) FILTER (WHERE status IN ('placed','aftercare','lost'))), 3)
                              END
                         FROM public.cases WHERE org_id = v_org),
    'median_quote', (SELECT round((percentile_cont(0.5) WITHIN GROUP (ORDER BY quoted_amount))::numeric)
                       FROM public.cases
                      WHERE org_id = v_org AND quoted_amount IS NOT NULL AND quoted_amount > 0)
  )
  INTO v_workspace;

  RETURN jsonb_build_object('network', v_network, 'workspace', v_workspace);
END
$$;

REVOKE ALL ON FUNCTION public.fetch_benchmarks() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fetch_benchmarks() TO authenticated;

COMMIT;
