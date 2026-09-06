BEGIN;

-- Only program identity is shared. Practice records and their RLS are unchanged.
CREATE OR REPLACE FUNCTION public.program_identity(p_name text, p_city text, p_state text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN btrim(coalesce(p_name, '')) = '' OR btrim(coalesce(p_city, '')) IN ('', '—')
    OR btrim(coalesce(p_state, '')) IN ('', '—') THEN NULL ELSE
    regexp_replace(lower(replace(btrim(p_name), '&', 'and')), '[^a-z0-9]', '', 'g') || '|' ||
    regexp_replace(lower(replace(btrim(p_city), '&', 'and')), '[^a-z0-9]', '', 'g') || '|' || upper(btrim(p_state)) END
$$;

-- Fail safely if legacy data needs curation. Never merge/delete listings or
-- their practice/center references as an incidental schema migration.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.global_partners
    WHERE public.program_identity(coalesce(nullif(organization, ''), name), city, state) IS NOT NULL
    GROUP BY public.program_identity(coalesce(nullif(organization, ''), name), city, state) HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate global program identities need administrator review before this migration';
  END IF;
END $$;
CREATE UNIQUE INDEX global_partners_program_identity_unique ON public.global_partners
  (public.program_identity(coalesce(nullif(organization, ''), name), city, state));

-- Discovery is available to every signed-in practice, rather than requiring a
-- Directory subscription. Pending/archived records retain their existing limits.
DROP POLICY "global_partners: entitled read" ON public.global_partners;
CREATE POLICY "global_partners: practice read" ON public.global_partners FOR SELECT TO authenticated
  USING (public.is_platform_admin() OR (status = 'active' AND public.current_org_id() IS NOT NULL));

-- Do not expose the identity of a listing's contributor through direct API calls.
REVOKE SELECT ON public.global_partners FROM authenticated;
GRANT SELECT (id, name, organization, types, city, state, regions, phone, email, website,
  monthly_cost, insurance, insurance_networks, therapies, populations, levels, description,
  status, verified_at, created_at, updated_at) ON public.global_partners TO authenticated;

CREATE OR REPLACE FUNCTION public.publish_partner_program(
  p_partner_id uuid, p_program jsonb, p_expected_org_id uuid, p_existing_global_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid;
  v_local public.partners%ROWTYPE;
  v_program public.global_partners%ROWTYPE;
  v_existing public.global_partners%ROWTYPE;
  v_identity text;
  v_partner uuid;
  v_created boolean := false;
BEGIN
  -- Lock membership so a workspace transition cannot race this write.
  SELECT org_id INTO v_org FROM public.org_members WHERE user_id = v_user FOR SHARE;
  IF v_user IS NULL OR v_org IS NULL OR p_expected_org_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'Active workspace changed or authentication required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_local FROM public.partners WHERE id = p_partner_id AND org_id = v_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'Save and sync this partner in your workspace first' USING ERRCODE = '42501'; END IF;

  -- An explicit allowlist, enforced on the server. Never populate a global row
  -- from a tenant record; reject accidental extra/private fields rather than ignore them.
  IF p_program IS NULL OR jsonb_typeof(p_program) <> 'object' THEN
    RAISE EXCEPTION 'Public program details are required' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_program) AS k(key) WHERE key <> ALL(ARRAY[
    'organization','city','state','phone','email','website','types','insurance','insurance_networks',
    'therapies','populations','levels','regions'])) THEN
    RAISE EXCEPTION 'Only public program fields can be published' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_program FROM jsonb_populate_record(NULL::public.global_partners, p_program);
  v_program.organization := btrim(v_program.organization);
  v_program.city := btrim(v_program.city);
  v_program.state := upper(btrim(v_program.state));
  v_identity := public.program_identity(v_program.organization, v_program.city, v_program.state);
  IF v_identity IS NULL OR split_part(v_identity,'|',1) = '' OR split_part(v_identity,'|',2) = '' OR length(v_program.organization) NOT BETWEEN 2 AND 200
    OR length(v_program.city) NOT BETWEEN 2 AND 100 OR v_program.state !~ '^[A-Z]{2}$'
    OR coalesce(cardinality(v_program.types), 0) NOT BETWEEN 1 AND 6
    OR NOT (v_program.types <@ ARRAY['Inpatient','IOP / PHP','Interventionist','Therapist','Sober Living','Detox']) THEN
    RAISE EXCEPTION 'Program name, city, two-letter state, and provider type are required' USING ERRCODE = '22023';
  END IF;
  IF length(coalesce(v_program.phone,'')) > 40 OR length(coalesce(v_program.email,'')) > 200
    OR length(coalesce(v_program.website,'')) > 500 OR pg_column_size(p_program) > 16000 THEN
    RAISE EXCEPTION 'Public program details are too long' USING ERRCODE = '22023';
  END IF;
  IF coalesce(v_program.website,'') <> '' AND (v_program.website !~ '^https://[a-zA-Z0-9.-]+(/[^?#@ ]*)?$') THEN
    RAISE EXCEPTION 'Use a public HTTPS program website without credentials or query parameters' USING ERRCODE = '22023';
  END IF;
  -- Serialize contributions for this identity; the unique index also protects
  -- concurrent admin/center writes that do not use this RPC.
  PERFORM pg_advisory_xact_lock(hashtextextended('global-program:' || v_identity, 0));
  SELECT * INTO v_existing FROM public.global_partners
    WHERE (p_existing_global_id IS NOT NULL AND id = p_existing_global_id)
      OR (p_existing_global_id IS NULL AND public.program_identity(coalesce(nullif(organization,''),name),city,state) = v_identity);
  IF p_existing_global_id IS NOT NULL AND NOT FOUND THEN RAISE EXCEPTION 'Directory listing not found' USING ERRCODE = 'P0002'; END IF;
  IF FOUND AND v_existing.status <> 'active' THEN
    RAISE EXCEPTION 'A matching program is awaiting review or unavailable. Contact support.' USING ERRCODE = '22023';
  END IF;
  IF v_local.global_partner_id IS NOT NULL AND v_local.global_partner_id IS DISTINCT FROM v_existing.id THEN
    RAISE EXCEPTION 'This partner is already linked to a different global program' USING ERRCODE = '22023';
  END IF;
  IF v_existing.id IS NULL THEN
    INSERT INTO public.global_partners (name,organization,city,state,phone,email,website,types,
      insurance,insurance_networks,therapies,populations,levels,regions,status,description,monthly_cost,created_by)
    VALUES (v_program.organization,v_program.organization,v_program.city,v_program.state,
      coalesce(v_program.phone,''),coalesce(v_program.email,''),nullif(v_program.website,''),v_program.types,
      coalesce(v_program.insurance,'{}'),coalesce(v_program.insurance_networks,'{}'),
      coalesce(v_program.therapies,'{}'),coalesce(v_program.populations,'{}'),
      coalesce(v_program.levels,'{}'),coalesce(v_program.regions,'{}'),'active','',0,NULL)
    ON CONFLICT (public.program_identity(coalesce(nullif(organization,''),name),city,state)) DO NOTHING
    RETURNING * INTO v_existing;
    v_created := FOUND;
    IF NOT v_created THEN
      SELECT * INTO v_existing FROM public.global_partners
        WHERE public.program_identity(coalesce(nullif(organization,''),name),city,state) = v_identity;
      IF v_existing.status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'Matching program is unavailable'; END IF;
    END IF;
  END IF;
  -- One imported copy per workspace, including concurrent share/import requests.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_org::text || ':' || v_existing.id::text, 0));
  SELECT id INTO v_partner FROM public.partners WHERE org_id = v_org AND global_partner_id = v_existing.id;
  IF v_partner IS NULL THEN
    UPDATE public.partners SET global_partner_id = v_existing.id WHERE id = p_partner_id AND org_id = v_org
      AND (global_partner_id IS NULL OR global_partner_id = v_existing.id);
    IF NOT FOUND THEN RAISE EXCEPTION 'Partner changed. Reload your directory.' USING ERRCODE = '42501'; END IF;
    v_partner := p_partner_id;
  END IF;
  -- No contributor identity or tenant fields appear in the response.
  RETURN jsonb_build_object('global_id',v_existing.id,'partner_id',v_partner,'created',v_created);
END
$$;
REVOKE ALL ON FUNCTION public.publish_partner_program(uuid,jsonb,uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.publish_partner_program(uuid,jsonb,uuid,uuid) TO authenticated;

DROP FUNCTION public.import_global_partner(uuid,uuid);
CREATE FUNCTION public.import_global_partner(p_global_id uuid, p_partner_id uuid, p_expected_org_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid;
  v_id uuid;
  v_listing public.global_partners%ROWTYPE;
BEGIN
  SELECT org_id INTO v_org FROM public.org_members WHERE user_id = v_user FOR SHARE;
  IF v_user IS NULL OR v_org IS NULL OR (p_expected_org_id IS NOT NULL AND p_expected_org_id <> v_org) THEN
    RAISE EXCEPTION 'Active workspace changed or authentication required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_listing FROM public.global_partners WHERE id = p_global_id AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'Directory listing not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_org::text || ':' || p_global_id::text, 0));
  SELECT id INTO v_id FROM public.partners WHERE org_id = v_org AND global_partner_id = p_global_id LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  -- Reuse an unlinked local program without replacing any private details.
  SELECT id INTO v_id FROM public.partners WHERE org_id = v_org AND global_partner_id IS NULL
    AND public.program_identity(coalesce(nullif(organization,''),name),city,state) IS NOT NULL
    AND public.program_identity(coalesce(nullif(organization,''),name),city,state) =
      public.program_identity(coalesce(nullif(v_listing.organization,''),v_listing.name),v_listing.city,v_listing.state)
    ORDER BY created_at,id LIMIT 1 FOR UPDATE;
  IF v_id IS NOT NULL THEN
    UPDATE public.partners SET global_partner_id = p_global_id WHERE id = v_id AND org_id = v_org;
    RETURN v_id;
  END IF;
  INSERT INTO public.partners (id,owner_id,org_id,name,organization,types,city,state,regions,
    phone,email,website,monthly_cost,insurance,insurance_networks,therapies,populations,levels,note,global_partner_id)
  VALUES (p_partner_id,v_user,v_org,v_listing.name,v_listing.organization,v_listing.types,
    v_listing.city,v_listing.state,v_listing.regions,v_listing.phone,v_listing.email,v_listing.website,
    v_listing.monthly_cost,v_listing.insurance,v_listing.insurance_networks,v_listing.therapies,
    v_listing.populations,v_listing.levels,'',p_global_id)
  ON CONFLICT (org_id,global_partner_id) WHERE global_partner_id IS NOT NULL
  DO UPDATE SET global_partner_id = EXCLUDED.global_partner_id RETURNING id INTO v_id;
  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION public.import_global_partner(uuid,uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_global_partner(uuid,uuid,uuid) TO authenticated;
COMMIT;
