BEGIN;

ALTER TABLE public.partners
  ADD COLUMN monthly_cost integer NOT NULL DEFAULT 0,
  ADD COLUMN insurance_networks jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.partners
  ADD CONSTRAINT partners_monthly_cost_nonnegative
    CHECK (monthly_cost >= 0),
  ADD CONSTRAINT partners_insurance_networks_object
    CHECK (jsonb_typeof(insurance_networks) = 'object');

UPDATE public.partners
SET
  monthly_cost = CASE
    WHEN cash_max > 0 THEN cash_max
    WHEN cash_min > 0 THEN cash_min
    ELSE 0
  END,
  insurance_networks = COALESCE(
    (
      SELECT jsonb_object_agg(plan, jsonb_build_array('In-network'))
      FROM unnest(insurance) AS plan
      WHERE plan <> 'Cash pay'
    ),
    '{}'::jsonb
  );

CREATE OR REPLACE FUNCTION public.sync_partner_payment_compatibility()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.monthly_cost = 0)
     OR (TG_OP = 'UPDATE'
         AND NEW.monthly_cost IS NOT DISTINCT FROM OLD.monthly_cost
         AND (NEW.cash_min IS DISTINCT FROM OLD.cash_min OR NEW.cash_max IS DISTINCT FROM OLD.cash_max)) THEN
    NEW.monthly_cost := CASE
      WHEN NEW.cash_max > 0 THEN NEW.cash_max
      WHEN NEW.cash_min > 0 THEN NEW.cash_min
      ELSE 0
    END;
  END IF;

  IF (TG_OP = 'INSERT' AND NEW.insurance_networks = '{}'::jsonb)
     OR (TG_OP = 'UPDATE'
         AND NEW.insurance_networks IS NOT DISTINCT FROM OLD.insurance_networks
         AND NEW.insurance IS DISTINCT FROM OLD.insurance) THEN
    SELECT COALESCE(
      jsonb_object_agg(plan, jsonb_build_array('In-network')),
      '{}'::jsonb
    )
    INTO NEW.insurance_networks
    FROM unnest(NEW.insurance) AS plan
    WHERE plan <> 'Cash pay';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER partners_sync_payment_compatibility
BEFORE INSERT OR UPDATE OF cash_min, cash_max, insurance, monthly_cost, insurance_networks
ON public.partners
FOR EACH ROW
EXECUTE FUNCTION public.sync_partner_payment_compatibility();

COMMENT ON COLUMN public.partners.monthly_cost IS
  'Single estimated monthly cash-pay cost; replaces the legacy cash_min/cash_max UI.';
COMMENT ON COLUMN public.partners.insurance_networks IS
  'Per-carrier network capabilities. Keys are carrier names; values contain In-network and/or Out-of-network.';

COMMIT;
