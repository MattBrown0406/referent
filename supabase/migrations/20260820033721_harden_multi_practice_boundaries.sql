BEGIN;

-- Invite codes are credentials. Workspace members may see the member roster,
-- but only the owner who can create an invite may read active codes.
DROP POLICY IF EXISTS "org_invites: member read" ON public.org_invites;
CREATE POLICY "org_invites: owner read" ON public.org_invites
  FOR SELECT
  USING (
    org_id = public.current_org_id()
    AND public.current_org_role() = 'owner'
  );

-- Team workspaces are a Pro capability. Keep this gate server-side so a free
-- client cannot bypass the upgrade UI by calling the RPC directly.
CREATE OR REPLACE FUNCTION public.create_org_invite()
RETURNS TABLE (code text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid;
  v_code text;
  v_expires timestamptz := now() + interval '7 days';
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  SELECT org_id INTO v_org FROM public.org_members WHERE user_id = v_user AND role = 'owner';
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Only the workspace owner can create invites' USING ERRCODE = '42501';
  END IF;
  IF NOT public.org_has_entitlement('pro') THEN
    RAISE EXCEPTION 'Team workspace invites require the Pro plan' USING ERRCODE = '42501';
  END IF;

  v_code := lower(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 10));
  INSERT INTO public.org_invites (org_id, code, invited_by, expires_at)
  VALUES (v_org, v_code, v_user, v_expires);

  RETURN QUERY SELECT v_code, v_expires;
END
$$;
REVOKE ALL ON FUNCTION public.create_org_invite() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_org_invite() TO authenticated;

-- A solo owner may bring the data from their personal workspace when joining a
-- practice. A member leaving one practice for another must not take data that
-- the first practice owns merely because that member originally authored it.
CREATE OR REPLACE FUNCTION public.accept_org_invite(p_code text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_invite public.org_invites%ROWTYPE;
  v_old_org uuid;
  v_old_role text;
  v_display text;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_invite FROM public.org_invites
   WHERE code = lower(btrim(coalesce(p_code, '')))
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invite code not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_invite.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invite code was already used' USING ERRCODE = '22023';
  END IF;
  IF v_invite.expires_at < now() THEN
    RAISE EXCEPTION 'Invite code has expired' USING ERRCODE = '22023';
  END IF;

  SELECT org_id, role, display_name INTO v_old_org, v_old_role, v_display
    FROM public.org_members WHERE user_id = v_user;
  IF v_old_org IS NULL THEN
    RAISE EXCEPTION 'Workspace membership required' USING ERRCODE = '42501';
  END IF;
  IF v_old_org = v_invite.org_id THEN
    RAISE EXCEPTION 'You already belong to this workspace' USING ERRCODE = '22023';
  END IF;
  IF v_old_role = 'owner' AND EXISTS (
    SELECT 1 FROM public.org_members WHERE org_id = v_old_org AND user_id <> v_user
  ) THEN
    RAISE EXCEPTION 'Remove your workspace members before joining another practice' USING ERRCODE = '22023';
  END IF;

  SET CONSTRAINTS ALL DEFERRED;

  UPDATE public.org_members SET org_id = v_invite.org_id, role = 'member'
   WHERE user_id = v_user;

  IF v_old_role = 'owner' THEN
    -- This is a solo personal workspace, so its rows belong to the joining
    -- practitioner and may move with them.
    UPDATE public.partners           SET org_id = v_invite.org_id WHERE org_id = v_old_org;
    UPDATE public.touches            SET org_id = v_invite.org_id WHERE org_id = v_old_org;
    UPDATE public.referrals          SET org_id = v_invite.org_id WHERE org_id = v_old_org;
    UPDATE public.match_profiles     SET org_id = v_invite.org_id WHERE org_id = v_old_org;
    UPDATE public.follow_ups         SET org_id = v_invite.org_id WHERE org_id = v_old_org;
    UPDATE public.cases              SET org_id = v_invite.org_id WHERE org_id = v_old_org;
    UPDATE public.case_contacts      SET org_id = v_invite.org_id WHERE org_id = v_old_org;
    UPDATE public.case_events        SET org_id = v_invite.org_id WHERE org_id = v_old_org;
    UPDATE public.case_documents     SET org_id = v_invite.org_id WHERE org_id = v_old_org;
    UPDATE public.case_stage_history SET org_id = v_invite.org_id WHERE org_id = v_old_org;
    UPDATE public.case_integrations  SET org_id = v_invite.org_id WHERE org_id = v_old_org;
  END IF;

  UPDATE public.org_invites
     SET accepted_by = v_user, accepted_at = now()
   WHERE id = v_invite.id;

  DELETE FROM public.orgs o
   WHERE o.id = v_old_org
     AND v_old_role = 'owner'
     AND NOT EXISTS (SELECT 1 FROM public.org_members m WHERE m.org_id = o.id);
END
$$;
REVOKE ALL ON FUNCTION public.accept_org_invite(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_org_invite(text) TO authenticated;

-- case_integrations is directly writable by app users, so its attribution must
-- be pinned just like every other client-written row. Service-role webhooks have
-- no auth.uid() and remain able to write for the bound account.
DROP TRIGGER IF EXISTS case_integrations_set_org ON public.case_integrations;
CREATE TRIGGER case_integrations_set_org
BEFORE INSERT ON public.case_integrations
FOR EACH ROW EXECUTE FUNCTION public.set_row_org_from_owner();

-- Storage authorization follows the case's current workspace, not the current
-- workspace of the historical uploader named in the first path segment. This
-- preserves practice access and removes a departed member's access immediately.
CREATE OR REPLACE FUNCTION public.is_org_case_folder(p_case text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.cases c
     WHERE c.org_id = public.current_org_id()
       AND c.id::text = p_case
  )
$$;
REVOKE ALL ON FUNCTION public.is_org_case_folder(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_org_case_folder(text) TO authenticated;

DROP POLICY IF EXISTS "case docs: org read" ON storage.objects;
DROP POLICY IF EXISTS "case docs: org insert" ON storage.objects;
DROP POLICY IF EXISTS "case docs: org delete" ON storage.objects;

-- The former folder-owner helper encoded access in the uploader's current org,
-- which is unsafe after membership changes. No policy may keep using it.
DROP FUNCTION IF EXISTS public.is_org_colleague_folder(text);

CREATE POLICY "case docs: org read" ON storage.objects FOR SELECT
  USING (
    bucket_id = 'case-documents'
    AND public.is_org_case_folder((storage.foldername(name))[2])
  );
CREATE POLICY "case docs: org insert" ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'case-documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
    AND public.is_org_case_folder((storage.foldername(name))[2])
  );
CREATE POLICY "case docs: org delete" ON storage.objects FOR DELETE
  USING (
    bucket_id = 'case-documents'
    AND public.is_org_case_folder((storage.foldername(name))[2])
  );

-- Enforce the import flow's stated one-copy-per-workspace contract under
-- concurrent requests, then make the RPC return the winning row atomically.
CREATE UNIQUE INDEX IF NOT EXISTS partners_org_global_partner_unique
  ON public.partners (org_id, global_partner_id)
  WHERE global_partner_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.import_global_partner(p_global_id uuid, p_partner_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_org_id uuid := public.current_org_id();
  v_partner_id uuid;
  v_listing public.global_partners%ROWTYPE;
BEGIN
  IF v_owner_id IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_listing FROM public.global_partners
   WHERE id = p_global_id AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Directory listing not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.partners (
    id, owner_id, org_id, name, organization, types, city, state, regions,
    phone, email, website, monthly_cost, insurance, insurance_networks,
    therapies, populations, levels, note, global_partner_id
  ) VALUES (
    p_partner_id, v_owner_id, v_org_id, v_listing.name, v_listing.organization,
    v_listing.types, v_listing.city, v_listing.state, v_listing.regions,
    v_listing.phone, v_listing.email, v_listing.website, v_listing.monthly_cost,
    v_listing.insurance, v_listing.insurance_networks, v_listing.therapies,
    v_listing.populations, v_listing.levels, v_listing.description, p_global_id
  )
  ON CONFLICT (org_id, global_partner_id) WHERE global_partner_id IS NOT NULL
  DO UPDATE SET global_partner_id = EXCLUDED.global_partner_id
  RETURNING id INTO v_partner_id;

  RETURN v_partner_id;
END
$$;
REVOKE ALL ON FUNCTION public.import_global_partner(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_global_partner(uuid, uuid) TO authenticated;

-- A center edit changes the facts that were verified. Keep the active/pending
-- lifecycle admin-controlled, but clear the verification timestamp until an
-- admin reviews the new content.
CREATE OR REPLACE FUNCTION public.guard_global_partner_verification()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_platform_admin() AND auth.uid() IS NOT NULL THEN
    NEW.status := OLD.status;
    NEW.verified_at := NULL;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.guard_global_partner_verification() FROM PUBLIC, anon, authenticated;

-- Attribution must survive personnel changes and may never be reassigned by a
-- client. Workspace ownership lives in org_id; owner_id is a nullable audit
-- pointer only.
CREATE OR REPLACE FUNCTION public.guard_row_attribution()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF current_user IN ('authenticated','anon')
     AND auth.uid() IS NOT NULL
     AND NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    RAISE EXCEPTION 'Row attribution cannot be changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.guard_row_attribution() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'partners','touches','referrals','match_profiles','follow_ups','cases',
    'case_contacts','case_events','case_documents','case_stage_history','case_integrations'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_guard_attribution ON public.%I', v_table, v_table);
    EXECUTE format(
      'CREATE TRIGGER %I_guard_attribution BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_row_attribution()',
      v_table, v_table
    );
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN owner_id DROP NOT NULL', v_table);
  END LOOP;
END
$$;

ALTER TABLE public.partners DROP CONSTRAINT partners_owner_id_fkey,
  ADD CONSTRAINT partners_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.touches DROP CONSTRAINT touches_owner_id_fkey,
  ADD CONSTRAINT touches_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.referrals DROP CONSTRAINT referrals_owner_id_fkey,
  ADD CONSTRAINT referrals_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.match_profiles DROP CONSTRAINT match_profiles_owner_id_fkey,
  ADD CONSTRAINT match_profiles_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.follow_ups DROP CONSTRAINT follow_ups_owner_id_fkey,
  ADD CONSTRAINT follow_ups_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.cases DROP CONSTRAINT cases_owner_id_fkey,
  ADD CONSTRAINT cases_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.case_contacts DROP CONSTRAINT case_contacts_owner_id_fkey,
  ADD CONSTRAINT case_contacts_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.case_events DROP CONSTRAINT case_events_owner_id_fkey,
  ADD CONSTRAINT case_events_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.case_documents DROP CONSTRAINT case_documents_owner_id_fkey,
  ADD CONSTRAINT case_documents_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.case_stage_history DROP CONSTRAINT case_stage_history_owner_id_fkey,
  ADD CONSTRAINT case_stage_history_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.case_integrations DROP CONSTRAINT case_integrations_owner_id_fkey,
  ADD CONSTRAINT case_integrations_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- One bootstrap claim binds one account to one listing. Additional managers
-- require a future authenticated manager-invite flow, not reusable claim codes.
CREATE UNIQUE INDEX center_members_one_manager_per_listing
  ON public.center_members (global_partner_id);

CREATE OR REPLACE FUNCTION public.create_center_claim_code(p_global_partner_id uuid)
RETURNS TABLE (code text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_code text;
  v_expires timestamptz := now() + interval '30 days';
BEGIN
  IF v_user IS NULL OR NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Only platform admins can issue claim codes' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.global_partners WHERE id = p_global_partner_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Directory listing not found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM public.center_members WHERE global_partner_id = p_global_partner_id) THEN
    RAISE EXCEPTION 'Directory listing is already claimed' USING ERRCODE = '22023';
  END IF;

  UPDATE public.center_claim_codes AS c
     SET expires_at = now()
   WHERE c.global_partner_id = p_global_partner_id AND c.claimed_at IS NULL AND c.expires_at > now();
  v_code := lower(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 10));
  INSERT INTO public.center_claim_codes (global_partner_id, code, created_by, expires_at)
  VALUES (p_global_partner_id, v_code, v_user, v_expires);
  RETURN QUERY SELECT v_code, v_expires;
END
$$;

CREATE OR REPLACE FUNCTION public.claim_center_listing(p_code text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_claim public.center_claim_codes%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.center_members WHERE user_id = v_user) THEN
    RAISE EXCEPTION 'This account already manages a listing' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_claim FROM public.center_claim_codes
   WHERE code = lower(btrim(coalesce(p_code, '')))
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Claim code not found' USING ERRCODE = 'P0002'; END IF;
  IF v_claim.claimed_at IS NOT NULL THEN RAISE EXCEPTION 'Claim code was already used' USING ERRCODE = '22023'; END IF;
  IF v_claim.expires_at < now() THEN RAISE EXCEPTION 'Claim code has expired' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM public.center_members WHERE global_partner_id = v_claim.global_partner_id) THEN
    RAISE EXCEPTION 'Directory listing is already claimed' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.center_members (user_id, global_partner_id) VALUES (v_user, v_claim.global_partner_id);
  UPDATE public.center_claim_codes
     SET claimed_by = v_user, claimed_at = now()
   WHERE id = v_claim.id;
  UPDATE public.center_claim_codes
     SET expires_at = now()
   WHERE global_partner_id = v_claim.global_partner_id AND id <> v_claim.id AND claimed_at IS NULL;
  RETURN v_claim.global_partner_id;
END
$$;
REVOKE ALL ON FUNCTION public.create_center_claim_code(uuid), public.claim_center_listing(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_center_claim_code(uuid), public.claim_center_listing(text) TO authenticated;

-- Centers may edit operational listing facts but not audit, lifecycle, or
-- provenance fields. Platform administration continues through SQL/privileged
-- service tooling until a dedicated admin RPC/UI is added.
REVOKE UPDATE ON public.global_partners FROM authenticated;
GRANT UPDATE (
  name, organization, types, city, state, regions, phone, email, website,
  monthly_cost, insurance, insurance_networks, therapies, populations, levels,
  description
) ON public.global_partners TO authenticated;

CREATE OR REPLACE FUNCTION public.set_global_partner_verification(
  p_global_partner_id uuid,
  p_status text,
  p_verified_at timestamptz
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Only platform admins can verify listings' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('active','pending','archived') THEN
    RAISE EXCEPTION 'Invalid listing status' USING ERRCODE = '22023';
  END IF;
  UPDATE public.global_partners
     SET status = p_status, verified_at = p_verified_at
   WHERE id = p_global_partner_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Directory listing not found' USING ERRCODE = 'P0002'; END IF;
END
$$;
REVOKE ALL ON FUNCTION public.set_global_partner_verification(uuid,text,timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_global_partner_verification(uuid,text,timestamptz) TO authenticated;

-- Preserve manual grants separately from per-purchaser RevenueCat lifecycle.
CREATE TABLE public.org_revenuecat_grants (
  app_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  entitlement text NOT NULL CHECK (entitlement IN ('pro','directory','benchmarks')),
  product_id text NOT NULL CHECK (length(product_id) BETWEEN 1 AND 255),
  store text NOT NULL CHECK (length(store) BETWEEN 1 AND 50),
  environment text NOT NULL CHECK (environment IN ('PRODUCTION','SANDBOX')),
  active boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  last_event_at timestamptz NOT NULL,
  last_event_id text NOT NULL CHECK (length(last_event_id) BETWEEN 1 AND 255),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_user_id, entitlement, product_id)
);
CREATE INDEX org_revenuecat_grants_org_idx ON public.org_revenuecat_grants (org_id, entitlement, active);
CREATE TRIGGER org_revenuecat_grants_updated_at BEFORE UPDATE ON public.org_revenuecat_grants
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
ALTER TABLE public.org_revenuecat_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org_revenuecat_grants: member read" ON public.org_revenuecat_grants
  FOR SELECT USING (org_id = public.current_org_id());
REVOKE ALL ON public.org_revenuecat_grants FROM anon, PUBLIC;
GRANT SELECT ON public.org_revenuecat_grants TO authenticated;

CREATE OR REPLACE FUNCTION public.apply_revenuecat_grant_event(
  p_app_user_id uuid,
  p_entitlement text,
  p_product_id text,
  p_store text,
  p_environment text,
  p_active boolean,
  p_expires_at timestamptz,
  p_event_at timestamptz,
  p_event_id text
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.org_revenuecat_grants%ROWTYPE;
  v_org uuid;
BEGIN
  IF p_app_user_id IS NULL OR p_entitlement NOT IN ('pro','directory','benchmarks')
     OR p_event_at IS NULL OR btrim(coalesce(p_event_id,'')) = '' THEN
    RAISE EXCEPTION 'Invalid RevenueCat grant event' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing FROM public.org_revenuecat_grants
   WHERE app_user_id = p_app_user_id AND entitlement = p_entitlement AND product_id = p_product_id
   FOR UPDATE;
  IF FOUND THEN
    IF p_event_at < v_existing.last_event_at
       OR (p_event_at = v_existing.last_event_at AND p_event_id <= v_existing.last_event_id) THEN
      RETURN false;
    END IF;
    UPDATE public.org_revenuecat_grants
       SET active = p_active,
           expires_at = p_expires_at,
           store = p_store,
           environment = p_environment,
           last_event_at = p_event_at,
           last_event_id = p_event_id
     WHERE app_user_id = p_app_user_id AND entitlement = p_entitlement AND product_id = p_product_id;
    RETURN true;
  END IF;

  IF NOT p_active THEN RETURN false; END IF;
  SELECT org_id INTO v_org FROM public.org_members WHERE user_id = p_app_user_id;
  IF v_org IS NULL THEN RETURN false; END IF;
  INSERT INTO public.org_revenuecat_grants (
    app_user_id, org_id, entitlement, product_id, store, environment,
    active, expires_at, last_event_at, last_event_id
  ) VALUES (
    p_app_user_id, v_org, p_entitlement, p_product_id, p_store, p_environment,
    true, p_expires_at, p_event_at, p_event_id
  );
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.apply_revenuecat_grant_event(uuid,text,text,text,text,boolean,timestamptz,timestamptz,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_revenuecat_grant_event(uuid,text,text,text,text,boolean,timestamptz,timestamptz,text) TO service_role;

CREATE OR REPLACE FUNCTION public.org_has_entitlement(p_entitlement text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
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

CREATE OR REPLACE FUNCTION public.fetch_org_entitlements()
RETURNS TABLE (entitlement text, active boolean, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT allowed.entitlement,
         public.org_has_entitlement(allowed.entitlement),
         NULL::timestamptz
    FROM (VALUES ('pro'::text),('directory'::text),('benchmarks'::text)) AS allowed(entitlement)
$$;
REVOKE ALL ON FUNCTION public.fetch_org_entitlements() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fetch_org_entitlements() TO authenticated;

-- Cross-practice comparisons use at least five OTHER paid benchmark
-- workspaces, each with a meaningful activity floor.
CREATE OR REPLACE FUNCTION public.fetch_benchmarks()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.current_org_id();
  v_network jsonb;
  v_workspace jsonb;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000'; END IF;
  IF NOT public.org_has_entitlement('benchmarks') THEN
    RAISE EXCEPTION 'Benchmarks require the benchmarks plan' USING ERRCODE = '42501';
  END IF;

  WITH eligible_orgs AS (
    SELECT e.org_id
      FROM public.org_entitlements e
     WHERE e.entitlement = 'benchmarks' AND e.active
       AND (e.expires_at IS NULL OR e.expires_at > now())
       AND e.org_id <> v_org
    UNION
    SELECT g.org_id
      FROM public.org_revenuecat_grants g
     WHERE g.entitlement = 'benchmarks' AND g.active AND g.environment = 'PRODUCTION'
       AND (g.expires_at IS NULL OR g.expires_at > now())
       AND g.org_id <> v_org
  ), referral_stats AS (
    SELECT r.org_id,
           count(*) FILTER (WHERE admitted IS NOT NULL) AS decided,
           avg(CASE WHEN admitted THEN 1.0 ELSE 0.0 END) FILTER (WHERE admitted IS NOT NULL) AS admit_rate,
           count(family_experience) AS rated,
           avg(family_experience)::numeric AS family_experience
      FROM public.referrals r JOIN eligible_orgs e ON e.org_id = r.org_id
     WHERE direction = 'outbound' GROUP BY r.org_id
  ), case_stats AS (
    SELECT c.org_id,
           count(*) FILTER (WHERE status IN ('placed','aftercare')) AS placed,
           count(*) FILTER (WHERE status = 'lost') AS lost,
           count(quoted_amount) FILTER (WHERE quoted_amount > 0) AS quoted,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY quoted_amount)
             FILTER (WHERE quoted_amount > 0) AS median_quote
      FROM public.cases c JOIN eligible_orgs e ON e.org_id = c.org_id
     GROUP BY c.org_id
  ), qualified AS (
    SELECT
      (SELECT count(*) FROM referral_stats WHERE decided >= 5) AS admit_orgs,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY admit_rate) FROM referral_stats WHERE decided >= 5) AS admit_rate,
      (SELECT count(*) FROM referral_stats WHERE rated >= 3) AS rating_orgs,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY family_experience) FROM referral_stats WHERE rated >= 3) AS family_experience,
      (SELECT count(*) FROM case_stats WHERE placed + lost >= 5) AS placement_orgs,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY placed::numeric / (placed + lost)) FROM case_stats WHERE placed + lost >= 5) AS placement_rate,
      (SELECT count(*) FROM case_stats WHERE quoted >= 5) AS quote_orgs,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY median_quote) FROM case_stats WHERE quoted >= 5) AS median_quote
  )
  SELECT jsonb_build_object(
    'admit_rate', CASE WHEN admit_orgs >= 5 THEN round(admit_rate::numeric,3) END,
    'family_experience', CASE WHEN rating_orgs >= 5 THEN round(family_experience::numeric,2) END,
    'placement_rate', CASE WHEN placement_orgs >= 5 THEN round(placement_rate::numeric,3) END,
    'median_quote', CASE WHEN quote_orgs >= 5 THEN round(median_quote::numeric) END,
    'contributor_floor', 5
  ) INTO v_network FROM qualified;

  SELECT jsonb_build_object(
    'outbound_referrals', (SELECT count(*) FROM public.referrals WHERE org_id=v_org AND direction='outbound'),
    'admit_rate', (SELECT round(avg(CASE WHEN admitted THEN 1.0 ELSE 0.0 END)::numeric,3) FROM public.referrals WHERE org_id=v_org AND direction='outbound' AND admitted IS NOT NULL),
    'family_experience', (SELECT round(avg(family_experience)::numeric,2) FROM public.referrals WHERE org_id=v_org AND direction='outbound'),
    'cases_total', (SELECT count(*) FROM public.cases WHERE org_id=v_org),
    'placement_rate', (SELECT CASE WHEN count(*) FILTER (WHERE status IN ('placed','aftercare','lost')) > 0 THEN round((count(*) FILTER (WHERE status IN ('placed','aftercare')))::numeric / (count(*) FILTER (WHERE status IN ('placed','aftercare','lost'))),3) END FROM public.cases WHERE org_id=v_org),
    'median_quote', (SELECT round((percentile_cont(0.5) WITHIN GROUP (ORDER BY quoted_amount))::numeric) FROM public.cases WHERE org_id=v_org AND quoted_amount > 0)
  ) INTO v_workspace;
  RETURN jsonb_build_object('network',v_network,'workspace',v_workspace);
END
$$;
REVOKE ALL ON FUNCTION public.fetch_benchmarks() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fetch_benchmarks() TO authenticated;

-- Data API auto-exposure is disabled. Provider webhooks use service_role but
-- still need explicit table privileges before their RLS-bypassing key can act.
GRANT SELECT, INSERT, UPDATE ON public.integration_webhook_events TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.case_integrations TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.org_revenuecat_grants TO service_role;
GRANT SELECT ON public.org_members, public.org_entitlements TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'org_members'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.org_members;
  END IF;
END
$$;

COMMIT;
