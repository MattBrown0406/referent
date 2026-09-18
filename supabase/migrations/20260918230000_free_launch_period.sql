-- ReferralFit is free during launch: every workspace gets every feature.
--
-- Rather than deleting the plan gates (directory, benchmarks, team invites),
-- a single switch makes org_has_entitlement() answer yes for everyone. The
-- entitlement tables, RevenueCat mirror, and gate checks stay exactly as they
-- are, so ending the free period later is a one-line migration that flips
-- free_launch_period() to false — nothing else needs to change.
--
-- Tests that exercise the gates override free_launch_period() to false inside
-- their own transaction; see supabase/tests/free_launch_period_test.sql.

BEGIN;

CREATE OR REPLACE FUNCTION public.free_launch_period()
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$ SELECT true $$;
REVOKE ALL ON FUNCTION public.free_launch_period() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.free_launch_period() TO authenticated;

CREATE OR REPLACE FUNCTION public.org_has_entitlement(p_entitlement text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (
    public.free_launch_period()
    AND p_entitlement IN ('pro', 'directory', 'benchmarks')
    AND public.current_org_id() IS NOT NULL
  ) OR EXISTS (
    SELECT 1 FROM public.org_entitlements
     WHERE org_id = public.current_org_id()
       AND entitlement = p_entitlement AND active
       AND (expires_at IS NULL OR expires_at > now())
  ) OR EXISTS (
    SELECT 1 FROM public.org_revenuecat_grants
     WHERE org_id = public.current_org_id()
       AND entitlement = p_entitlement AND active
       AND environment = 'PRODUCTION'
       AND (expires_at IS NULL OR expires_at > now())
  )
$$;
REVOKE ALL ON FUNCTION public.org_has_entitlement(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_has_entitlement(text) TO authenticated;

COMMIT;
