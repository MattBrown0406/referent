BEGIN;

-- Shared, verified placement directory (Phase 3 of the platform buildout).
-- global_partners is the platform-curated master list of treatment programs.
-- It is not tenant data: platform admins maintain it, and workspaces with the
-- 'directory' entitlement can browse active listings and import them into
-- their own partner network (a tenant copy linked by global_partner_id, so
-- imported rows keep provenance without live coupling).

CREATE TABLE public.platform_admins (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;
CREATE POLICY "platform_admins: self read" ON public.platform_admins
  FOR SELECT USING (user_id = auth.uid());
REVOKE ALL ON public.platform_admins FROM anon, PUBLIC;
GRANT SELECT ON public.platform_admins TO authenticated;
-- Admin appointments happen via SQL only.

CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = auth.uid()) $$;
REVOKE ALL ON FUNCTION public.is_platform_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_platform_admin() TO authenticated;

CREATE TABLE public.global_partners (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  organization       text NOT NULL DEFAULT '' CHECK (length(organization) <= 200),
  types              text[] NOT NULL DEFAULT '{}',
  city               text NOT NULL DEFAULT '',
  state              text NOT NULL DEFAULT '',
  regions            text[] NOT NULL DEFAULT '{}',
  phone              text NOT NULL DEFAULT '',
  email              text NOT NULL DEFAULT '',
  website            text,
  monthly_cost       integer NOT NULL DEFAULT 0 CHECK (monthly_cost >= 0),
  insurance          text[] NOT NULL DEFAULT '{}',
  insurance_networks jsonb NOT NULL DEFAULT '{}'::jsonb
                     CHECK (public.is_valid_insurance_networks(insurance_networks)),
  therapies          text[] NOT NULL DEFAULT '{}',
  populations        text[] NOT NULL DEFAULT '{}',
  levels             text[] NOT NULL DEFAULT '{}',
  description        text NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('active','pending','archived')),
  verified_at        timestamptz,
  created_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX global_partners_status_state_idx ON public.global_partners (status, state);
CREATE TRIGGER global_partners_updated_at BEFORE UPDATE ON public.global_partners
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.global_partners ENABLE ROW LEVEL SECURITY;

-- Active listings are visible to workspaces on the directory plan; platform
-- admins see everything (including pending and archived).
CREATE POLICY "global_partners: entitled read" ON public.global_partners
  FOR SELECT USING (
    public.is_platform_admin()
    OR (status = 'active' AND public.org_has_entitlement('directory'))
  );
CREATE POLICY "global_partners: admin write" ON public.global_partners
  FOR INSERT WITH CHECK (public.is_platform_admin());
CREATE POLICY "global_partners: admin update" ON public.global_partners
  FOR UPDATE USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY "global_partners: admin delete" ON public.global_partners
  FOR DELETE USING (public.is_platform_admin());

REVOKE ALL ON public.global_partners FROM anon, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.global_partners TO authenticated;

-- Tenant partners can carry provenance back to the listing they came from.
ALTER TABLE public.partners
  ADD COLUMN global_partner_id uuid REFERENCES public.global_partners(id) ON DELETE SET NULL;
CREATE INDEX partners_global_partner_idx ON public.partners (org_id, global_partner_id)
  WHERE global_partner_id IS NOT NULL;

-- Import a directory listing into the caller's own partner network. Idempotent
-- per workspace: importing a listing that is already linked returns the
-- existing partner instead of duplicating it.
CREATE OR REPLACE FUNCTION public.import_global_partner(p_global_id uuid, p_partner_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_org_id uuid := public.current_org_id();
  v_existing uuid;
  v_listing public.global_partners%ROWTYPE;
BEGIN
  IF v_owner_id IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;

  -- RLS applies here (SECURITY INVOKER): without the directory entitlement or
  -- admin status, the listing is simply not visible.
  SELECT * INTO v_listing FROM public.global_partners
   WHERE id = p_global_id AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Directory listing not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT id INTO v_existing FROM public.partners
   WHERE org_id = v_org_id AND global_partner_id = p_global_id
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  INSERT INTO public.partners (
    id, owner_id, name, organization, types, city, state, regions,
    phone, email, website, monthly_cost, insurance, insurance_networks,
    therapies, populations, levels, note, global_partner_id
  ) VALUES (
    p_partner_id, v_owner_id, v_listing.name, v_listing.organization,
    v_listing.types, v_listing.city, v_listing.state, v_listing.regions,
    v_listing.phone, v_listing.email, v_listing.website, v_listing.monthly_cost,
    v_listing.insurance, v_listing.insurance_networks, v_listing.therapies,
    v_listing.populations, v_listing.levels, v_listing.description, p_global_id
  );

  RETURN p_partner_id;
END
$$;
REVOKE ALL ON FUNCTION public.import_global_partner(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_global_partner(uuid, uuid) TO authenticated;

COMMIT;
