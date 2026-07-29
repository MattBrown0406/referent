BEGIN;

CREATE OR REPLACE FUNCTION public.is_valid_insurance_networks(networks jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
DECLARE
  capabilities jsonb;
  status_count integer;
  distinct_status_count integer;
  allowed_count integer;
BEGIN
  IF networks IS NULL OR jsonb_typeof(networks) <> 'object' THEN
    RETURN false;
  END IF;

  FOR capabilities IN SELECT value FROM jsonb_each(networks)
  LOOP
    IF jsonb_typeof(capabilities) <> 'array' THEN
      RETURN false;
    END IF;

    SELECT
      count(*)::integer,
      count(DISTINCT status)::integer,
      count(*) FILTER (WHERE status IN ('In-network', 'Out-of-network'))::integer
    INTO status_count, distinct_status_count, allowed_count
    FROM jsonb_array_elements_text(capabilities) AS entries(status);

    IF status_count NOT BETWEEN 1 AND 2
       OR distinct_status_count <> status_count
       OR allowed_count <> status_count THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

ALTER TABLE public.partners
  DROP CONSTRAINT partners_insurance_networks_object,
  ADD CONSTRAINT partners_insurance_networks_valid
    CHECK (public.is_valid_insurance_networks(insurance_networks));

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
      jsonb_object_agg(
        plan,
        CASE
          WHEN TG_OP = 'UPDATE'
               AND OLD.insurance_networks ? plan
               AND public.is_valid_insurance_networks(jsonb_build_object(plan, OLD.insurance_networks -> plan))
            THEN OLD.insurance_networks -> plan
          ELSE jsonb_build_array('In-network')
        END
      ),
      '{}'::jsonb
    )
    INTO NEW.insurance_networks
    FROM unnest(NEW.insurance) AS plan
    WHERE plan <> 'Cash pay';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.is_valid_insurance_networks(jsonb) IS
  'Validates that each carrier maps to one or both supported network capability labels.';

COMMIT;
