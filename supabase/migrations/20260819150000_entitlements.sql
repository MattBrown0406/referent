BEGIN;

-- Entitlements: subscription state per workspace (Phase 2 of the platform
-- buildout). Billing itself lives in RevenueCat (App Store / Play IAP); the
-- revenuecat-webhook edge function mirrors entitlement state into this table,
-- and every feature gate in the product reads it through
-- public.org_has_entitlement. 'manual' rows support comps, beta access, and
-- founder accounts without touching RevenueCat.
--
--   pro        — team workspace + full business analytics tier
--   directory  — the shared, verified placement directory (Phase 3)
--   benchmarks — cross-practice benchmarking analytics (Phase 5)

CREATE TABLE public.org_entitlements (
  org_id         uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  entitlement    text NOT NULL CHECK (entitlement IN ('pro','directory','benchmarks')),
  active         boolean NOT NULL DEFAULT false,
  source         text NOT NULL DEFAULT 'revenuecat' CHECK (source IN ('revenuecat','manual')),
  rc_app_user_id text NOT NULL DEFAULT '' CHECK (length(rc_app_user_id) <= 255),
  expires_at     timestamptz,                       -- NULL = does not expire (manual grants)
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, entitlement)
);

CREATE TRIGGER org_entitlements_updated_at BEFORE UPDATE ON public.org_entitlements
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.org_entitlements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org_entitlements: member read" ON public.org_entitlements
  FOR SELECT USING (org_id = public.current_org_id());
REVOKE ALL ON public.org_entitlements FROM anon, PUBLIC;
GRANT SELECT ON public.org_entitlements TO authenticated;
-- Writes happen only via the service role (webhook) or SQL (manual grants).

-- The single feature-gate predicate. SECURITY DEFINER so later phases can use
-- it inside RLS policies on shared tables (e.g. the global directory).
CREATE OR REPLACE FUNCTION public.org_has_entitlement(p_entitlement text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.org_entitlements
     WHERE org_id = public.current_org_id()
       AND entitlement = p_entitlement
       AND active
       AND (expires_at IS NULL OR expires_at > now())
  )
$$;
REVOKE ALL ON FUNCTION public.org_has_entitlement(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_has_entitlement(text) TO authenticated;

-- The webhook receipts ledger now also stores RevenueCat deliveries.
ALTER TABLE public.integration_webhook_events
  DROP CONSTRAINT integration_webhook_events_provider_check,
  ADD CONSTRAINT integration_webhook_events_provider_check
    CHECK (provider IN ('square','pandadoc','revenuecat'));

COMMIT;
