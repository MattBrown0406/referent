-- Two defects in 20260907120000_directory_platform_upgrade.sql surfaced by
-- supabase/tests/directory_platform_upgrade_test.sql:
--
-- 1. track_partner_local_overrides() built its change list with
--    `v_changed || 'name'`. With a text[] on the left Postgres resolves the
--    untyped literal as an array literal, so the first edit to any
--    directory-linked partner failed with `malformed array literal`.
--    Use array_append so the literal is a text element.
--
-- 2. suggest_global_listing() linked a second partner to a listing the same
--    workspace already had linked, violating the one-copy-per-workspace
--    contract enforced by partners_org_global_partner_unique. Return the
--    existing listing without re-linking in that case so the caller still
--    learns which listing the partner matched.

BEGIN;

CREATE OR REPLACE FUNCTION public.track_partner_local_overrides()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_field text;
  v_changed text[] := '{}';
BEGIN
  IF NEW.global_partner_id IS NULL OR current_setting('referralfit.syncing', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW.name IS DISTINCT FROM OLD.name THEN v_changed := array_append(v_changed, 'name'); END IF;
  IF NEW.organization IS DISTINCT FROM OLD.organization THEN v_changed := array_append(v_changed, 'organization'); END IF;
  IF NEW.types IS DISTINCT FROM OLD.types THEN v_changed := array_append(v_changed, 'types'); END IF;
  IF NEW.city IS DISTINCT FROM OLD.city THEN v_changed := array_append(v_changed, 'city'); END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN v_changed := array_append(v_changed, 'state'); END IF;
  IF NEW.regions IS DISTINCT FROM OLD.regions THEN v_changed := array_append(v_changed, 'regions'); END IF;
  IF NEW.phone IS DISTINCT FROM OLD.phone THEN v_changed := array_append(v_changed, 'phone'); END IF;
  IF NEW.email IS DISTINCT FROM OLD.email THEN v_changed := array_append(v_changed, 'email'); END IF;
  IF NEW.website IS DISTINCT FROM OLD.website THEN v_changed := array_append(v_changed, 'website'); END IF;
  IF NEW.monthly_cost IS DISTINCT FROM OLD.monthly_cost THEN v_changed := array_append(v_changed, 'monthly_cost'); END IF;
  IF NEW.insurance IS DISTINCT FROM OLD.insurance THEN v_changed := array_append(v_changed, 'insurance'); END IF;
  IF NEW.insurance_networks IS DISTINCT FROM OLD.insurance_networks THEN v_changed := array_append(v_changed, 'insurance_networks'); END IF;
  IF NEW.therapies IS DISTINCT FROM OLD.therapies THEN v_changed := array_append(v_changed, 'therapies'); END IF;
  IF NEW.populations IS DISTINCT FROM OLD.populations THEN v_changed := array_append(v_changed, 'populations'); END IF;
  IF NEW.levels IS DISTINCT FROM OLD.levels THEN v_changed := array_append(v_changed, 'levels'); END IF;
  IF NEW.note IS DISTINCT FROM OLD.note THEN v_changed := array_append(v_changed, 'note'); END IF;

  FOREACH v_field IN ARRAY v_changed LOOP
    IF NOT (v_field = ANY (NEW.local_overrides)) THEN
      NEW.local_overrides := array_append(NEW.local_overrides, v_field);
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.track_partner_local_overrides() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.suggest_global_listing(p_partner_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid := public.current_org_id();
  v_partner public.partners%ROWTYPE;
  v_phone text;
  v_domain text;
  v_existing uuid;
  v_new uuid;
  v_prev text := coalesce(current_setting('referralfit.syncing', true), '');
BEGIN
  IF v_user IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO v_partner FROM public.partners WHERE id = p_partner_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Partner not found in this workspace' USING ERRCODE = 'P0002';
  END IF;
  IF v_partner.global_partner_id IS NOT NULL THEN
    RETURN v_partner.global_partner_id;
  END IF;

  v_phone := regexp_replace(coalesce(v_partner.phone, ''), '\D', '', 'g');
  v_domain := lower(regexp_replace(regexp_replace(coalesce(v_partner.website, ''), '^\s*https?://', ''), '^(www\.)?([^/?#]+).*$', '\2'));

  SELECT id INTO v_existing FROM public.global_partners
   WHERE status <> 'archived'
     AND ((v_domain <> '' AND website_domain = v_domain) OR (v_phone <> '' AND phone_digits = v_phone))
   ORDER BY (status = 'active') DESC, created_at
   LIMIT 1;

  IF v_existing IS NOT NULL THEN
    -- One linked copy per workspace (partners_org_global_partner_unique).
    -- If another partner here already tracks this listing, report the match
    -- but leave this partner private.
    IF EXISTS (
      SELECT 1 FROM public.partners
       WHERE org_id = v_org AND global_partner_id = v_existing AND id <> p_partner_id
    ) THEN
      RETURN v_existing;
    END IF;

    PERFORM set_config('referralfit.syncing', 'on', true);
    UPDATE public.partners p
       SET global_partner_id = v_existing,
           global_listing_status = g.status,
           global_synced_at = now()
      FROM public.global_partners g
     WHERE p.id = p_partner_id AND g.id = v_existing;
    PERFORM set_config('referralfit.syncing', v_prev, true);
    RETURN v_existing;
  END IF;

  INSERT INTO public.global_partners (
    name, organization, types, city, state, regions, phone, email, website, monthly_cost,
    insurance, insurance_networks, therapies, populations, levels, description,
    status, created_by, suggested_by_org_id
  ) VALUES (
    v_partner.name, v_partner.organization, v_partner.types, v_partner.city, v_partner.state, v_partner.regions,
    v_partner.phone, v_partner.email, v_partner.website, v_partner.monthly_cost,
    v_partner.insurance, v_partner.insurance_networks, v_partner.therapies, v_partner.populations, v_partner.levels,
    left(v_partner.note, 4000), 'pending', v_user, v_org
  ) RETURNING id INTO v_new;

  PERFORM set_config('referralfit.syncing', 'on', true);
  UPDATE public.partners SET global_partner_id = v_new, global_listing_status = 'pending', global_synced_at = now()
   WHERE id = p_partner_id;
  PERFORM set_config('referralfit.syncing', v_prev, true);
  RETURN v_new;
END
$$;
REVOKE ALL ON FUNCTION public.suggest_global_listing(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.suggest_global_listing(uuid) TO authenticated;

COMMIT;
