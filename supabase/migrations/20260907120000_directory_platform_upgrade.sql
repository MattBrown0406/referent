BEGIN;

-- Directory platform upgrade.
--
-- 1. Per-user favorites (user_favorites) alongside the existing team pin
--    (partners.favorite), so teammates stop overwriting each other and a
--    global listing can be favorited before it is imported.
-- 2. Live-linked imports: edits to a global listing propagate to every
--    linked tenant partner except fields the tenant deliberately overrode.
-- 3. Server-side directory search with trigram + array indexes, an
--    incremental-sync RPC, and an InitPlan-friendly read policy.
-- 4. Aggregate usage stats per listing across the whole network
--    (k-anonymous, aggregate-only, no pay-for-placement).
-- 5. Listing identity: normalized phone/domain, NPI, duplicate report,
--    merge, member-suggested listings, and verification expiry.

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- Columns referenced across sections (declared up front so the search RPC
-- in §3 and the identity helpers in §5 can be created in any order).
ALTER TABLE public.global_partners
  ADD COLUMN suggested_by_org_id uuid REFERENCES public.orgs(id) ON DELETE SET NULL,
  ADD COLUMN phone_digits text NOT NULL DEFAULT '',
  ADD COLUMN website_domain text NOT NULL DEFAULT '',
  ADD COLUMN search_tsv tsvector,
  ADD COLUMN npi text CHECK (npi IS NULL OR npi ~ '^[0-9]{10}$'),
  ADD COLUMN merged_into uuid REFERENCES public.global_partners(id) ON DELETE SET NULL;

-- Derived columns (normalized phone, website domain, search vector) are
-- maintained by trigger rather than as generated columns, so no expression
-- has to satisfy Postgres' IMMUTABLE requirement. Verification expiry
-- (verified_at + 12 months) is computed in search_global_partners.
CREATE OR REPLACE FUNCTION public.global_partners_derive_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.phone_digits := regexp_replace(coalesce(NEW.phone, ''), '\D', '', 'g');
  NEW.website_domain := lower(regexp_replace(regexp_replace(coalesce(NEW.website, ''), '^\s*https?://', ''), '^(www\.)?([^/?#]+).*$', '\2'));
  NEW.search_tsv := to_tsvector('simple',
    coalesce(NEW.name, '') || ' ' || coalesce(NEW.organization, '') || ' ' ||
    coalesce(NEW.city, '') || ' ' || coalesce(NEW.state, '') || ' ' || coalesce(NEW.description, ''));
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.global_partners_derive_columns() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER global_partners_derive_columns
BEFORE INSERT OR UPDATE ON public.global_partners
FOR EACH ROW EXECUTE FUNCTION public.global_partners_derive_columns();

-- Backfill existing listings through the trigger.
UPDATE public.global_partners SET phone = phone;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Per-user favorites
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE public.user_favorites (
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id      uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('partner', 'global_partner')),
  target_id   uuid NOT NULL,
  position    integer NOT NULL DEFAULT 0,
  note        text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, target_type, target_id)
);

CREATE INDEX user_favorites_user_org_idx ON public.user_favorites (user_id, org_id, position);
CREATE INDEX user_favorites_target_idx ON public.user_favorites (target_type, target_id);

ALTER TABLE public.user_favorites ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_favorites: own read" ON public.user_favorites
  FOR SELECT USING (user_id = auth.uid() AND org_id = (SELECT public.current_org_id()));
CREATE POLICY "user_favorites: own insert" ON public.user_favorites
  FOR INSERT WITH CHECK (user_id = auth.uid() AND org_id = (SELECT public.current_org_id()));
CREATE POLICY "user_favorites: own update" ON public.user_favorites
  FOR UPDATE USING (user_id = auth.uid() AND org_id = (SELECT public.current_org_id()))
  WITH CHECK (user_id = auth.uid() AND org_id = (SELECT public.current_org_id()));
CREATE POLICY "user_favorites: own delete" ON public.user_favorites
  FOR DELETE USING (user_id = auth.uid() AND org_id = (SELECT public.current_org_id()));

REVOKE ALL ON public.user_favorites FROM anon, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_favorites TO authenticated;

-- Targets are validated by trigger because the FK differs per target_type.
-- Tenant partners must belong to the caller's workspace; global listings
-- must be visible to the caller (RLS is applied via the SECURITY INVOKER
-- lookup below).
CREATE OR REPLACE FUNCTION public.validate_user_favorite_target()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF NEW.target_type = 'partner' THEN
    IF NOT EXISTS (SELECT 1 FROM public.partners WHERE id = NEW.target_id AND org_id = NEW.org_id) THEN
      RAISE EXCEPTION 'Partner not found in this workspace' USING ERRCODE = 'P0002';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.global_partners WHERE id = NEW.target_id) THEN
      RAISE EXCEPTION 'Directory listing not found' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.validate_user_favorite_target() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER user_favorites_validate_target
BEFORE INSERT OR UPDATE ON public.user_favorites
FOR EACH ROW EXECUTE FUNCTION public.validate_user_favorite_target();

-- Toggle helper: returns the new favorite state.
CREATE OR REPLACE FUNCTION public.toggle_user_favorite(p_target_type text, p_target_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid := public.current_org_id();
  v_deleted integer;
BEGIN
  IF v_user IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF p_target_type NOT IN ('partner', 'global_partner') THEN
    RAISE EXCEPTION 'Unsupported favorite target' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.user_favorites
   WHERE user_id = v_user AND target_type = p_target_type AND target_id = p_target_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted > 0 THEN
    RETURN false;
  END IF;

  INSERT INTO public.user_favorites (user_id, org_id, target_type, target_id, position)
  VALUES (
    v_user, v_org, p_target_type, p_target_id,
    COALESCE((SELECT max(position) + 1 FROM public.user_favorites WHERE user_id = v_user AND org_id = v_org), 0)
  );
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.toggle_user_favorite(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.toggle_user_favorite(text, uuid) TO authenticated;

-- When a listing is imported, a personal favorite on the global listing
-- carries over to the tenant partner so the user does not lose it.
CREATE OR REPLACE FUNCTION public.carry_global_favorite_to_partner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.global_partner_id IS NOT NULL THEN
    INSERT INTO public.user_favorites (user_id, org_id, target_type, target_id, position, note)
    SELECT f.user_id, f.org_id, 'partner', NEW.id, f.position, f.note
      FROM public.user_favorites f
     WHERE f.org_id = NEW.org_id
       AND f.target_type = 'global_partner'
       AND f.target_id = NEW.global_partner_id
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.carry_global_favorite_to_partner() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER partners_carry_global_favorite
AFTER INSERT ON public.partners
FOR EACH ROW EXECUTE FUNCTION public.carry_global_favorite_to_partner();

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Live-linked imports
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.partners
  ADD COLUMN local_overrides text[] NOT NULL DEFAULT '{}',
  ADD COLUMN global_listing_status text NOT NULL DEFAULT 'active'
    CHECK (global_listing_status IN ('active', 'pending', 'archived')),
  ADD COLUMN global_synced_at timestamptz;

COMMENT ON COLUMN public.partners.local_overrides IS
  'Synced field names the workspace edited locally; directory updates skip these.';

-- Fields that flow from a global listing to its linked tenant partners.
-- (global column -> partner column; description maps to note.)
CREATE OR REPLACE FUNCTION public.global_partner_synced_fields()
RETURNS text[]
LANGUAGE sql IMMUTABLE
AS $$
  SELECT ARRAY['name','organization','types','city','state','regions','phone','email','website',
               'monthly_cost','insurance','insurance_networks','therapies','populations','levels','note']
$$;

-- Record which synced fields a tenant changed by hand, so propagation
-- never clobbers a deliberate local edit. Propagation sets
-- referralfit.syncing = 'on' to bypass this bookkeeping.
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

  IF NEW.name IS DISTINCT FROM OLD.name THEN v_changed := v_changed || 'name'; END IF;
  IF NEW.organization IS DISTINCT FROM OLD.organization THEN v_changed := v_changed || 'organization'; END IF;
  IF NEW.types IS DISTINCT FROM OLD.types THEN v_changed := v_changed || 'types'; END IF;
  IF NEW.city IS DISTINCT FROM OLD.city THEN v_changed := v_changed || 'city'; END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN v_changed := v_changed || 'state'; END IF;
  IF NEW.regions IS DISTINCT FROM OLD.regions THEN v_changed := v_changed || 'regions'; END IF;
  IF NEW.phone IS DISTINCT FROM OLD.phone THEN v_changed := v_changed || 'phone'; END IF;
  IF NEW.email IS DISTINCT FROM OLD.email THEN v_changed := v_changed || 'email'; END IF;
  IF NEW.website IS DISTINCT FROM OLD.website THEN v_changed := v_changed || 'website'; END IF;
  IF NEW.monthly_cost IS DISTINCT FROM OLD.monthly_cost THEN v_changed := v_changed || 'monthly_cost'; END IF;
  IF NEW.insurance IS DISTINCT FROM OLD.insurance THEN v_changed := v_changed || 'insurance'; END IF;
  IF NEW.insurance_networks IS DISTINCT FROM OLD.insurance_networks THEN v_changed := v_changed || 'insurance_networks'; END IF;
  IF NEW.therapies IS DISTINCT FROM OLD.therapies THEN v_changed := v_changed || 'therapies'; END IF;
  IF NEW.populations IS DISTINCT FROM OLD.populations THEN v_changed := v_changed || 'populations'; END IF;
  IF NEW.levels IS DISTINCT FROM OLD.levels THEN v_changed := v_changed || 'levels'; END IF;
  IF NEW.note IS DISTINCT FROM OLD.note THEN v_changed := v_changed || 'note'; END IF;

  FOREACH v_field IN ARRAY v_changed LOOP
    IF NOT (v_field = ANY (NEW.local_overrides)) THEN
      NEW.local_overrides := NEW.local_overrides || v_field;
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.track_partner_local_overrides() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER partners_track_local_overrides
BEFORE UPDATE ON public.partners
FOR EACH ROW EXECUTE FUNCTION public.track_partner_local_overrides();

-- Push listing changes to every linked tenant partner, skipping overridden
-- fields. SECURITY DEFINER because linked partners live in other workspaces.
CREATE OR REPLACE FUNCTION public.propagate_global_partner_changes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sets text[] := '{}';
  v_sql text;
  v_prev text := coalesce(current_setting('referralfit.syncing', true), '');
BEGIN

  IF NEW.name IS DISTINCT FROM OLD.name THEN
    v_sets := v_sets || format('name = CASE WHEN %L = ANY(local_overrides) THEN name ELSE %L END', 'name', NEW.name); END IF;
  IF NEW.organization IS DISTINCT FROM OLD.organization THEN
    v_sets := v_sets || format('organization = CASE WHEN %L = ANY(local_overrides) THEN organization ELSE %L END', 'organization', NEW.organization); END IF;
  IF NEW.types IS DISTINCT FROM OLD.types THEN
    v_sets := v_sets || format('types = CASE WHEN %L = ANY(local_overrides) THEN types ELSE %L::text[] END', 'types', NEW.types); END IF;
  IF NEW.city IS DISTINCT FROM OLD.city THEN
    v_sets := v_sets || format('city = CASE WHEN %L = ANY(local_overrides) THEN city ELSE %L END', 'city', NEW.city); END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    v_sets := v_sets || format('state = CASE WHEN %L = ANY(local_overrides) THEN state ELSE %L END', 'state', NEW.state); END IF;
  IF NEW.regions IS DISTINCT FROM OLD.regions THEN
    v_sets := v_sets || format('regions = CASE WHEN %L = ANY(local_overrides) THEN regions ELSE %L::text[] END', 'regions', NEW.regions); END IF;
  IF NEW.phone IS DISTINCT FROM OLD.phone THEN
    v_sets := v_sets || format('phone = CASE WHEN %L = ANY(local_overrides) THEN phone ELSE %L END', 'phone', NEW.phone); END IF;
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    v_sets := v_sets || format('email = CASE WHEN %L = ANY(local_overrides) THEN email ELSE %L END', 'email', NEW.email); END IF;
  IF NEW.website IS DISTINCT FROM OLD.website THEN
    v_sets := v_sets || format('website = CASE WHEN %L = ANY(local_overrides) THEN website ELSE %L END', 'website', NEW.website); END IF;
  IF NEW.monthly_cost IS DISTINCT FROM OLD.monthly_cost THEN
    v_sets := v_sets || format('monthly_cost = CASE WHEN %L = ANY(local_overrides) THEN monthly_cost ELSE %L::integer END', 'monthly_cost', NEW.monthly_cost); END IF;
  IF NEW.insurance IS DISTINCT FROM OLD.insurance THEN
    v_sets := v_sets || format('insurance = CASE WHEN %L = ANY(local_overrides) THEN insurance ELSE %L::text[] END', 'insurance', NEW.insurance); END IF;
  IF NEW.insurance_networks IS DISTINCT FROM OLD.insurance_networks THEN
    v_sets := v_sets || format('insurance_networks = CASE WHEN %L = ANY(local_overrides) THEN insurance_networks ELSE %L::jsonb END', 'insurance_networks', NEW.insurance_networks); END IF;
  IF NEW.therapies IS DISTINCT FROM OLD.therapies THEN
    v_sets := v_sets || format('therapies = CASE WHEN %L = ANY(local_overrides) THEN therapies ELSE %L::text[] END', 'therapies', NEW.therapies); END IF;
  IF NEW.populations IS DISTINCT FROM OLD.populations THEN
    v_sets := v_sets || format('populations = CASE WHEN %L = ANY(local_overrides) THEN populations ELSE %L::text[] END', 'populations', NEW.populations); END IF;
  IF NEW.levels IS DISTINCT FROM OLD.levels THEN
    v_sets := v_sets || format('levels = CASE WHEN %L = ANY(local_overrides) THEN levels ELSE %L::text[] END', 'levels', NEW.levels); END IF;
  IF NEW.description IS DISTINCT FROM OLD.description THEN
    v_sets := v_sets || format('note = CASE WHEN %L = ANY(local_overrides) THEN note ELSE %L END', 'note', NEW.description); END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_sets := v_sets || format('global_listing_status = %L', NEW.status); END IF;

  IF array_length(v_sets, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  v_sql := format(
    'UPDATE public.partners SET %s, global_synced_at = now() WHERE global_partner_id = %L',
    array_to_string(v_sets, ', '), NEW.id
  );
  PERFORM set_config('referralfit.syncing', 'on', true);
  EXECUTE v_sql;
  PERFORM set_config('referralfit.syncing', v_prev, true);
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.propagate_global_partner_changes() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER global_partners_propagate_changes
AFTER UPDATE ON public.global_partners
FOR EACH ROW EXECUTE FUNCTION public.propagate_global_partner_changes();

-- Let a workspace re-adopt the listing's value for a field it had overridden.
CREATE OR REPLACE FUNCTION public.clear_partner_override(p_partner_id uuid, p_field text)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_partner public.partners%ROWTYPE;
  v_listing public.global_partners%ROWTYPE;
  v_prev text := coalesce(current_setting('referralfit.syncing', true), '');
BEGIN
  IF NOT (p_field = ANY (public.global_partner_synced_fields())) THEN
    RAISE EXCEPTION 'Unknown synced field' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_partner FROM public.partners WHERE id = p_partner_id AND org_id = public.current_org_id();
  IF NOT FOUND OR v_partner.global_partner_id IS NULL THEN
    RAISE EXCEPTION 'Linked partner not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_listing FROM public.global_partners WHERE id = v_partner.global_partner_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Directory listing not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM set_config('referralfit.syncing', 'on', true);
  EXECUTE format(
    'UPDATE public.partners SET %I = ($1).%I, local_overrides = array_remove(local_overrides, $2), global_synced_at = now() WHERE id = $3',
    p_field, CASE WHEN p_field = 'note' THEN 'description' ELSE p_field END
  ) USING v_listing, p_field, p_partner_id;
  PERFORM set_config('referralfit.syncing', v_prev, true);
END
$$;
REVOKE ALL ON FUNCTION public.clear_partner_override(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clear_partner_override(uuid, text) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Server-side search, indexes, incremental sync, InitPlan policy
-- ═══════════════════════════════════════════════════════════════════════════

-- (search_tsv is added and maintained by trigger at the top of this migration)
CREATE INDEX global_partners_search_tsv_idx ON public.global_partners USING gin (search_tsv);
CREATE INDEX global_partners_name_trgm_idx ON public.global_partners USING gin (name extensions.gin_trgm_ops);
CREATE INDEX global_partners_org_trgm_idx ON public.global_partners USING gin (organization extensions.gin_trgm_ops);
CREATE INDEX global_partners_levels_idx ON public.global_partners USING gin (levels);
CREATE INDEX global_partners_insurance_idx ON public.global_partners USING gin (insurance);
CREATE INDEX global_partners_populations_idx ON public.global_partners USING gin (populations);
CREATE INDEX global_partners_active_idx ON public.global_partners (state, organization, name) WHERE status = 'active';
CREATE INDEX global_partners_updated_idx ON public.global_partners (updated_at);

-- Re-create the entitled read policy so the entitlement lookups are evaluated
-- once per statement (InitPlan) instead of once per row.
DROP POLICY IF EXISTS "global_partners: entitled read" ON public.global_partners;
CREATE POLICY "global_partners: entitled read" ON public.global_partners
  FOR SELECT USING (
    (SELECT public.is_platform_admin())
    OR (status = 'active' AND (SELECT public.org_has_entitlement('directory')))
  );

-- Workspaces can follow the status of listings they suggested (see §5).
CREATE POLICY "global_partners: suggester read own" ON public.global_partners
  FOR SELECT USING (suggested_by_org_id IS NOT NULL AND suggested_by_org_id = (SELECT public.current_org_id()));

-- Paged, filtered search. SECURITY INVOKER so RLS still governs visibility.
CREATE OR REPLACE FUNCTION public.search_global_partners(
  p_query text DEFAULT NULL,
  p_state text DEFAULT NULL,
  p_levels text[] DEFAULT NULL,
  p_insurance text[] DEFAULT NULL,
  p_populations text[] DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid, name text, organization text, types text[], city text, state text, regions text[],
  phone text, email text, website text, monthly_cost integer, insurance text[],
  insurance_networks jsonb, therapies text[], populations text[], levels text[],
  description text, verified_at timestamptz, verification_expires_at timestamptz,
  verified_current boolean, updated_at timestamptz, rank real
)
LANGUAGE sql STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
  WITH q AS (
    SELECT nullif(btrim(coalesce(p_query, '')), '') AS text
  )
  SELECT g.id, g.name, g.organization, g.types, g.city, g.state, g.regions,
         g.phone, g.email, g.website, g.monthly_cost, g.insurance,
         g.insurance_networks, g.therapies, g.populations, g.levels,
         g.description, g.verified_at,
         (g.verified_at + INTERVAL '12 months') AS verification_expires_at,
         (g.verified_at IS NOT NULL AND g.verified_at + INTERVAL '12 months' > now()) AS verified_current,
         g.updated_at,
         CASE WHEN q.text IS NULL THEN 0::real
              ELSE greatest(similarity(g.organization, q.text), similarity(g.name, q.text),
                            ts_rank(g.search_tsv, plainto_tsquery('simple', q.text)))::real
         END AS rank
    FROM public.global_partners g, q
   WHERE g.status = 'active'
     AND (p_state IS NULL OR p_state = '' OR g.state = p_state)
     AND (p_levels IS NULL OR g.levels && p_levels)
     AND (p_insurance IS NULL OR g.insurance && p_insurance)
     AND (p_populations IS NULL OR g.populations && p_populations)
     AND (q.text IS NULL
          OR g.search_tsv @@ plainto_tsquery('simple', q.text)
          OR g.organization % q.text
          OR g.name % q.text
          OR g.organization ILIKE '%' || q.text || '%')
   ORDER BY rank DESC, g.state, g.organization, g.name, g.id
   LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
  OFFSET greatest(coalesce(p_offset, 0), 0)
$$;
REVOKE ALL ON FUNCTION public.search_global_partners(text, text, text[], text[], text[], integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_global_partners(text, text, text[], text[], text[], integer, integer) TO authenticated;

-- Incremental sync for the offline cache: everything changed since p_since,
-- including listings that were archived (so caches can drop them).
CREATE OR REPLACE FUNCTION public.fetch_global_partner_changes(p_since timestamptz)
RETURNS TABLE (id uuid, status text, updated_at timestamptz)
LANGUAGE sql STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT g.id, g.status, g.updated_at
    FROM public.global_partners g
   WHERE g.updated_at > coalesce(p_since, '-infinity'::timestamptz)
   ORDER BY g.updated_at
   LIMIT 1000
$$;
REVOKE ALL ON FUNCTION public.fetch_global_partner_changes(timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fetch_global_partner_changes(timestamptz) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Network-wide usage stats per listing (aggregate-only, k-anonymous)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE MATERIALIZED VIEW public.global_partner_stats AS
  WITH linked AS (
    SELECT p.id AS partner_id, p.org_id, p.global_partner_id
      FROM public.partners p
     WHERE p.global_partner_id IS NOT NULL
  ),
  ref AS (
    SELECT l.global_partner_id,
           r.org_id,
           r.referred_on,
           r.admitted,
           r.family_experience
      FROM linked l
      JOIN public.referrals r ON r.partner_id = l.partner_id AND r.org_id = l.org_id
     WHERE r.direction = 'outbound'
       AND r.referred_on >= (CURRENT_DATE - INTERVAL '12 months')
  )
  SELECT g.id AS global_partner_id,
         (SELECT count(DISTINCT org_id) FROM linked WHERE global_partner_id = g.id)::integer AS importing_orgs,
         (SELECT count(DISTINCT org_id) FROM ref WHERE global_partner_id = g.id)::integer AS referring_orgs,
         (SELECT count(*) FROM ref WHERE global_partner_id = g.id)::integer AS referrals_12m,
         (SELECT count(*) FROM ref WHERE global_partner_id = g.id AND admitted IS NOT NULL)::integer AS decided_12m,
         (SELECT avg(CASE WHEN admitted THEN 1.0 ELSE 0.0 END) FROM ref WHERE global_partner_id = g.id AND admitted IS NOT NULL)::numeric(5,4) AS admit_rate,
         (SELECT count(family_experience) FROM ref WHERE global_partner_id = g.id)::integer AS rated_12m,
         (SELECT avg(family_experience) FROM ref WHERE global_partner_id = g.id)::numeric(4,2) AS family_experience,
         (SELECT max(referred_on) FROM ref WHERE global_partner_id = g.id) AS last_referral_on,
         now() AS refreshed_at
    FROM public.global_partners g
  WITH NO DATA;

CREATE UNIQUE INDEX global_partner_stats_pkey ON public.global_partner_stats (global_partner_id);
REVOKE ALL ON public.global_partner_stats FROM PUBLIC, anon, authenticated;

REFRESH MATERIALIZED VIEW public.global_partner_stats;

-- Refresh entry point: platform admins, or the scheduler (which runs as the
-- table owner and has no auth.uid()).
CREATE OR REPLACE FUNCTION public.refresh_global_partner_stats()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform admin required' USING ERRCODE = '42501';
  END IF;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.global_partner_stats;
END
$$;
REVOKE ALL ON FUNCTION public.refresh_global_partner_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.refresh_global_partner_stats() TO authenticated;

-- Read entry point. Directory entitlement (or admin) required. Metrics for a
-- listing are only disclosed once at least five distinct workspaces
-- contributed to them — the same floor the benchmarks use.
CREATE OR REPLACE FUNCTION public.fetch_global_partner_stats(p_ids uuid[])
RETURNS TABLE (
  global_partner_id uuid,
  importing_orgs integer,
  referrals_12m integer,
  admit_rate numeric,
  family_experience numeric,
  last_referral_on date,
  disclosed boolean,
  refreshed_at timestamptz
)
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin boolean := public.is_platform_admin();
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF NOT v_admin AND NOT public.org_has_entitlement('directory') THEN
    RAISE EXCEPTION 'Directory stats require the directory plan' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT s.global_partner_id,
         CASE WHEN v_admin OR s.importing_orgs >= 5 THEN s.importing_orgs ELSE NULL END,
         CASE WHEN v_admin OR s.referring_orgs >= 5 THEN s.referrals_12m ELSE NULL END,
         CASE WHEN (v_admin OR s.referring_orgs >= 5) AND s.decided_12m >= 5 THEN s.admit_rate ELSE NULL END,
         CASE WHEN (v_admin OR s.referring_orgs >= 5) AND s.rated_12m >= 3 THEN s.family_experience ELSE NULL END,
         CASE WHEN v_admin OR s.referring_orgs >= 5 THEN s.last_referral_on ELSE NULL END,
         (v_admin OR s.importing_orgs >= 5 OR s.referring_orgs >= 5),
         s.refreshed_at
    FROM public.global_partner_stats s
   WHERE s.global_partner_id = ANY (p_ids)
     AND EXISTS (SELECT 1 FROM public.global_partners g WHERE g.id = s.global_partner_id AND (v_admin OR g.status = 'active'));
END
$$;
REVOKE ALL ON FUNCTION public.fetch_global_partner_stats(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fetch_global_partner_stats(uuid[]) TO authenticated;

-- Hourly refresh where pg_cron is available (production); harmless locally.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'referralfit-global-partner-stats-hourly') THEN
      PERFORM cron.unschedule('referralfit-global-partner-stats-hourly');
    END IF;
    PERFORM cron.schedule(
      'referralfit-global-partner-stats-hourly',
      '17 * * * *',
      'SELECT public.refresh_global_partner_stats()'
    );
  END IF;
END
$do$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Listing identity, duplicates, merge, suggestions, verification expiry
-- ═══════════════════════════════════════════════════════════════════════════

-- (identity columns were added at the top of this migration)
CREATE INDEX global_partners_phone_digits_idx ON public.global_partners (phone_digits) WHERE phone_digits <> '';
CREATE INDEX global_partners_website_domain_idx ON public.global_partners (website_domain) WHERE website_domain <> '';
CREATE INDEX global_partners_npi_idx ON public.global_partners (npi) WHERE npi IS NOT NULL;

-- Admin duplicate report: listings sharing a phone, domain, or NPI.
CREATE OR REPLACE FUNCTION public.find_duplicate_global_partners()
RETURNS TABLE (match_key text, match_value text, listing_ids uuid[], listing_count integer)
LANGUAGE sql STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT 'phone', phone_digits, array_agg(id ORDER BY created_at), count(*)::integer
    FROM public.global_partners
   WHERE status <> 'archived' AND phone_digits <> ''
   GROUP BY phone_digits HAVING count(*) > 1
  UNION ALL
  SELECT 'domain', website_domain, array_agg(id ORDER BY created_at), count(*)::integer
    FROM public.global_partners
   WHERE status <> 'archived' AND website_domain <> ''
   GROUP BY website_domain HAVING count(*) > 1
  UNION ALL
  SELECT 'npi', npi, array_agg(id ORDER BY created_at), count(*)::integer
    FROM public.global_partners
   WHERE status <> 'archived' AND npi IS NOT NULL
   GROUP BY npi HAVING count(*) > 1
$$;
REVOKE ALL ON FUNCTION public.find_duplicate_global_partners() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.find_duplicate_global_partners() TO authenticated;

-- Merge p_drop into p_keep: repoint tenant links, center members and claim
-- codes, then archive the dropped listing with a pointer. Admin only.
CREATE OR REPLACE FUNCTION public.merge_global_partners(p_keep uuid, p_drop uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_repointed integer := 0;
  v_dupes integer := 0;
  v_prev text := coalesce(current_setting('referralfit.syncing', true), '');
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform admin required' USING ERRCODE = '42501';
  END IF;
  IF p_keep = p_drop THEN
    RAISE EXCEPTION 'Cannot merge a listing into itself' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.global_partners WHERE id = p_keep)
     OR NOT EXISTS (SELECT 1 FROM public.global_partners WHERE id = p_drop) THEN
    RAISE EXCEPTION 'Directory listing not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM set_config('referralfit.syncing', 'on', true);

  -- A workspace that imported both copies keeps the one linked to p_keep;
  -- its p_drop copy is unlinked (not deleted — it may carry local history).
  UPDATE public.partners d
     SET global_partner_id = NULL
   WHERE d.global_partner_id = p_drop
     AND EXISTS (SELECT 1 FROM public.partners k WHERE k.org_id = d.org_id AND k.global_partner_id = p_keep);
  GET DIAGNOSTICS v_dupes = ROW_COUNT;

  UPDATE public.partners SET global_partner_id = p_keep WHERE global_partner_id = p_drop;
  GET DIAGNOSTICS v_repointed = ROW_COUNT;

  UPDATE public.user_favorites SET target_id = p_keep
   WHERE target_type = 'global_partner' AND target_id = p_drop
     AND NOT EXISTS (SELECT 1 FROM public.user_favorites f2
                      WHERE f2.user_id = user_favorites.user_id AND f2.target_type = 'global_partner' AND f2.target_id = p_keep);
  DELETE FROM public.user_favorites WHERE target_type = 'global_partner' AND target_id = p_drop;

  UPDATE public.center_members SET global_partner_id = p_keep WHERE global_partner_id = p_drop;
  UPDATE public.center_claim_codes SET global_partner_id = p_keep WHERE global_partner_id = p_drop;

  UPDATE public.global_partners SET status = 'archived', merged_into = p_keep WHERE id = p_drop;

  PERFORM set_config('referralfit.syncing', v_prev, true);
  RETURN v_repointed;
END
$$;
REVOKE ALL ON FUNCTION public.merge_global_partners(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.merge_global_partners(uuid, uuid) TO authenticated;

-- A workspace proposes one of its private partners for the shared directory.
-- If a listing already exists for that phone/domain, the partner is linked to
-- it instead (and the existing id is returned). Otherwise a pending listing
-- is created for admin review. Directory entitlement not required to suggest.
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
