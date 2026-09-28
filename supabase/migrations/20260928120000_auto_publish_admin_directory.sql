BEGIN;

-- Auto-publish the platform seed workspace into the shared directory.
--
-- The shared directory (global_partners) started as a hand-curated list. In
-- practice the platform owner's own workspace *is* the verified seed: every
-- treatment program in that workspace should appear in the directory without
-- a manual suggest/approve round trip, and edits made there should flow to
-- the listing (and from the listing to every other workspace that imported
-- it). Other practices keep today's behaviour exactly: their partners stay
-- private unless they call suggest_global_listing, and suggestions still
-- land as 'pending' for review.
--
-- Vocabulary used below:
--   seed org       a workspace owned by a platform admin (org_is_platform_seed)
--   publish        link a seed-org partner to an 'active', verified listing,
--                  creating the listing when no phone/domain match exists
--   seed_publish   a transaction-local flag (referralfit.seed_publish) that
--                  lets the publish path change a listing's verification
--                  state on behalf of a non-admin member of the seed org
--
-- Sections:
--   1. helpers (seed-org test, program-type test)
--   2. verification guard + local-override tracking learn about seed orgs
--   3. publish / push / retire functions
--   4. partners triggers
--   5. one-off maintenance functions (placeholder cleanup, backfill)
--   6. run cleanup, then backfill, and report the counts

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Helpers
-- ═══════════════════════════════════════════════════════════════════════════

-- A seed org is a workspace whose OWNER is a platform admin.
--
-- Why owner rather than any member: platform-admin status is a per-user
-- attribute (is_platform_admin() reads platform_admins by auth.uid()), while
-- org_members holds exactly one row per user with role 'owner' | 'member'.
-- accept_org_invite re-homes a user into another practice as a plain
-- 'member'. If any-member were the rule, an admin accepting a colleague's
-- invite would silently turn that colleague's private network into the
-- public directory. Tying the seed status to ownership keeps the blast
-- radius to workspaces the admin actually runs, and matches the owner-only
-- checks the workspace RPCs already use for org-level decisions.
CREATE OR REPLACE FUNCTION public.org_is_platform_seed(p_org uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.org_members m
      JOIN public.platform_admins a ON a.user_id = m.user_id
     WHERE m.org_id = p_org
       AND m.role = 'owner'
  )
$$;
REVOKE ALL ON FUNCTION public.org_is_platform_seed(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_is_platform_seed(uuid) TO authenticated;

-- The directory lists treatment programs. partners.types carries the app's
-- PartnerType values (src/data.ts): Inpatient, IOP / PHP, Sober Living and
-- Detox are programs; Interventionist and Therapist are individual
-- professionals and are never auto-published. An untyped partner is not
-- *clearly* a non-program, so it publishes.
CREATE OR REPLACE FUNCTION public.partner_is_directory_program(p_types text[])
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  SELECT coalesce(cardinality(p_types), 0) = 0
      OR p_types && ARRAY['Inpatient', 'IOP / PHP', 'Sober Living', 'Detox']::text[]
$$;
REVOKE ALL ON FUNCTION public.partner_is_directory_program(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_is_directory_program(text[]) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Existing guards learn about seed orgs
-- ═══════════════════════════════════════════════════════════════════════════

-- Verification state stays admin-only for every direct write (a center edit
-- still keeps the lifecycle and clears the verification stamp, exactly as
-- 20260820033721_harden_multi_practice_boundaries.sql defined it). The seed
-- publish path is the one exception: it is a SECURITY DEFINER function that
-- is not callable from the API, and it may activate/verify, archive, or
-- push content to a listing on behalf of a non-admin member of the seed org
-- without losing the verification. It announces itself by setting the
-- transaction-local referralfit.seed_publish flag.
CREATE OR REPLACE FUNCTION public.guard_global_partner_verification()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF coalesce(current_setting('referralfit.seed_publish', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  IF NOT public.is_platform_admin() AND auth.uid() IS NOT NULL THEN
    NEW.status := OLD.status;
    NEW.verified_at := NULL;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.guard_global_partner_verification() FROM PUBLIC, anon, authenticated;

-- Seed-org edits are the source of truth for the listing, so they are never
-- "local overrides": the trigger below pushes them up instead. Everything
-- else is unchanged from 20260916170000_fix_directory_platform_rpcs.sql.
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
  IF NEW.global_partner_id IS NULL
     OR current_setting('referralfit.syncing', true) = 'on'
     OR public.org_is_platform_seed(NEW.org_id) THEN
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

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Publish / push / retire
-- ═══════════════════════════════════════════════════════════════════════════

-- Promote a pending listing to active + verified. No-op for any other status.
CREATE OR REPLACE FUNCTION public.activate_global_listing(p_global_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev text := coalesce(current_setting('referralfit.seed_publish', true), '');
BEGIN
  PERFORM set_config('referralfit.seed_publish', 'on', true);
  UPDATE public.global_partners
     SET status = 'active',
         verified_at = coalesce(verified_at, now())
   WHERE id = p_global_id
     AND status = 'pending';
  PERFORM set_config('referralfit.seed_publish', v_prev, true);
END
$$;
REVOKE ALL ON FUNCTION public.activate_global_listing(uuid) FROM PUBLIC, anon, authenticated;

-- Copy the given synced fields from a seed-org partner onto its listing.
-- Runs under referralfit.syncing so the listing's own propagation trigger
-- (global -> partners) does not bounce the edit back into this path, and so
-- no workspace records the echo as a local override; and under
-- referralfit.seed_publish so a seed staff member's edit keeps the listing
-- verified (the seed workspace is the verification).
CREATE OR REPLACE FUNCTION public.push_seed_partner_fields(p_partner public.partners, p_fields text[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_field text;
  v_sets text[] := '{}';
  v_prev text := coalesce(current_setting('referralfit.syncing', true), '');
  v_prev_pub text := coalesce(current_setting('referralfit.seed_publish', true), '');
BEGIN
  IF p_partner.global_partner_id IS NULL THEN
    RETURN;
  END IF;
  FOREACH v_field IN ARRAY p_fields LOOP
    IF NOT (v_field = ANY (public.global_partner_synced_fields())) THEN
      CONTINUE;
    END IF;
    v_sets := array_append(v_sets, CASE v_field
      WHEN 'name'         THEN 'name = left(($1).name, 200)'
      WHEN 'organization' THEN 'organization = left(($1).organization, 200)'
      WHEN 'note'         THEN 'description = left(($1).note, 4000)'
      ELSE format('%I = ($1).%I', v_field, v_field)
    END);
  END LOOP;
  IF array_length(v_sets, 1) IS NULL THEN
    RETURN;
  END IF;

  PERFORM set_config('referralfit.syncing', 'on', true);
  PERFORM set_config('referralfit.seed_publish', 'on', true);
  EXECUTE format('UPDATE public.global_partners SET %s WHERE id = $2', array_to_string(v_sets, ', '))
    USING p_partner, p_partner.global_partner_id;
  PERFORM set_config('referralfit.seed_publish', v_prev_pub, true);
  PERFORM set_config('referralfit.syncing', v_prev, true);
END
$$;
REVOKE ALL ON FUNCTION public.push_seed_partner_fields(public.partners, text[]) FROM PUBLIC, anon, authenticated;

-- Archive a listing nobody uses any more: no tenant partner in any workspace
-- links to it and no center account has claimed it. Otherwise leave it alone.
CREATE OR REPLACE FUNCTION public.retire_orphaned_global_listing(p_global_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev_pub text := coalesce(current_setting('referralfit.seed_publish', true), '');
  v_prev_sync text := coalesce(current_setting('referralfit.syncing', true), '');
  v_done boolean := false;
BEGIN
  IF p_global_id IS NULL
     OR EXISTS (SELECT 1 FROM public.partners WHERE global_partner_id = p_global_id)
     OR EXISTS (SELECT 1 FROM public.center_members WHERE global_partner_id = p_global_id) THEN
    RETURN false;
  END IF;
  PERFORM set_config('referralfit.seed_publish', 'on', true);
  PERFORM set_config('referralfit.syncing', 'on', true);
  UPDATE public.global_partners
     SET status = 'archived'
   WHERE id = p_global_id
     AND status <> 'archived';
  v_done := FOUND;
  PERFORM set_config('referralfit.syncing', v_prev_sync, true);
  PERFORM set_config('referralfit.seed_publish', v_prev_pub, true);
  RETURN v_done;
END
$$;
REVOKE ALL ON FUNCTION public.retire_orphaned_global_listing(uuid) FROM PUBLIC, anon, authenticated;

-- Publish one seed-org partner. Mirrors suggest_global_listing's identity
-- rules (phone digits / website domain, one linked copy per workspace) but
-- the outcome is an active, verified listing rather than a pending one.
-- Returns the listing id, or NULL when the partner was skipped (not a seed
-- org, not a program, blank name, or the workspace already tracks the
-- matching listing through another partner). Not callable from the API: the
-- partners triggers and the backfill are its only callers.
CREATE OR REPLACE FUNCTION public.publish_partner_to_global(p_partner_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_partner public.partners%ROWTYPE;
  v_phone text;
  v_domain text;
  v_existing uuid;
  v_new uuid;
  v_prev text := coalesce(current_setting('referralfit.syncing', true), '');
BEGIN
  SELECT * INTO v_partner FROM public.partners WHERE id = p_partner_id;
  IF NOT FOUND
     OR NOT public.org_is_platform_seed(v_partner.org_id)
     OR NOT public.partner_is_directory_program(v_partner.types)
     OR length(btrim(coalesce(v_partner.name, ''))) = 0 THEN
    RETURN NULL;
  END IF;

  -- Already in the directory (imported, suggested, or published earlier):
  -- just make sure a still-pending listing becomes live.
  IF v_partner.global_partner_id IS NOT NULL THEN
    PERFORM public.activate_global_listing(v_partner.global_partner_id);
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
    IF EXISTS (
      SELECT 1 FROM public.partners
       WHERE org_id = v_partner.org_id AND global_partner_id = v_existing AND id <> p_partner_id
    ) THEN
      RETURN NULL;
    END IF;

    PERFORM public.activate_global_listing(v_existing);
    PERFORM set_config('referralfit.syncing', 'on', true);
    UPDATE public.partners
       SET global_partner_id = v_existing,
           global_listing_status = 'active',
           global_synced_at = now(),
           local_overrides = '{}'
     WHERE id = p_partner_id;
    PERFORM set_config('referralfit.syncing', v_prev, true);

    -- The seed copy is the source of truth: bring the listing up to date.
    SELECT * INTO v_partner FROM public.partners WHERE id = p_partner_id;
    PERFORM public.push_seed_partner_fields(v_partner, public.global_partner_synced_fields());
    RETURN v_existing;
  END IF;

  INSERT INTO public.global_partners (
    name, organization, types, city, state, regions, phone, email, website, monthly_cost,
    insurance, insurance_networks, therapies, populations, levels, description,
    status, verified_at, created_by, suggested_by_org_id
  ) VALUES (
    left(v_partner.name, 200), left(v_partner.organization, 200), v_partner.types, v_partner.city, v_partner.state, v_partner.regions,
    v_partner.phone, v_partner.email, v_partner.website, v_partner.monthly_cost,
    v_partner.insurance, v_partner.insurance_networks, v_partner.therapies, v_partner.populations, v_partner.levels,
    left(v_partner.note, 4000),
    'active', now(), coalesce(v_partner.owner_id, auth.uid()), v_partner.org_id
  ) RETURNING id INTO v_new;

  PERFORM set_config('referralfit.syncing', 'on', true);
  UPDATE public.partners
     SET global_partner_id = v_new,
         global_listing_status = 'active',
         global_synced_at = now(),
         local_overrides = '{}'
   WHERE id = p_partner_id;
  PERFORM set_config('referralfit.syncing', v_prev, true);
  RETURN v_new;
END
$$;
REVOKE ALL ON FUNCTION public.publish_partner_to_global(uuid) FROM PUBLIC, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Triggers on partners
-- ═══════════════════════════════════════════════════════════════════════════

-- INSERT: publish. UPDATE of a synced field: push the change to the listing
-- (or publish if the partner is not linked yet, e.g. its type just became a
-- program; or retire the link if it just stopped being one). DELETE: archive
-- the listing when no other workspace or center still uses it.
--
-- Guarded by referralfit.syncing so writes made by the sync machinery itself
-- (global -> partners propagation, linking, merges) never re-enter here.
-- A publish failure must never block the seed org's own partner write, so
-- the publish/push branch downgrades errors to a WARNING.
CREATE OR REPLACE FUNCTION public.partners_seed_publish()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
  v_field text;
  v_changed text[] := '{}';
  v_prev text := coalesce(current_setting('referralfit.syncing', true), '');
BEGIN
  IF current_setting('referralfit.syncing', true) = 'on' THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.global_partner_id IS NOT NULL AND public.org_is_platform_seed(OLD.org_id) THEN
      PERFORM public.retire_orphaned_global_listing(OLD.global_partner_id);
    END IF;
    RETURN NULL;
  END IF;

  IF NOT public.org_is_platform_seed(NEW.org_id) THEN
    RETURN NULL;
  END IF;

  BEGIN
    IF TG_OP = 'INSERT' OR NEW.global_partner_id IS NULL THEN
      PERFORM public.publish_partner_to_global(NEW.id);
      RETURN NULL;
    END IF;

    IF NOT public.partner_is_directory_program(NEW.types) THEN
      PERFORM set_config('referralfit.syncing', 'on', true);
      UPDATE public.partners
         SET global_partner_id = NULL, local_overrides = '{}'
       WHERE id = NEW.id;
      PERFORM set_config('referralfit.syncing', v_prev, true);
      PERFORM public.retire_orphaned_global_listing(NEW.global_partner_id);
      RETURN NULL;
    END IF;

    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    FOREACH v_field IN ARRAY public.global_partner_synced_fields() LOOP
      IF v_new -> v_field IS DISTINCT FROM v_old -> v_field THEN
        v_changed := array_append(v_changed, v_field);
      END IF;
    END LOOP;
    PERFORM public.push_seed_partner_fields(NEW, v_changed);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('referralfit.syncing', v_prev, true);
    RAISE WARNING 'seed directory publish skipped for partner % (%): %', NEW.id, SQLSTATE, SQLERRM;
  END;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.partners_seed_publish() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS partners_seed_publish_insert ON public.partners;
CREATE TRIGGER partners_seed_publish_insert
AFTER INSERT ON public.partners
FOR EACH ROW
WHEN (current_setting('referralfit.syncing', true) IS DISTINCT FROM 'on')
EXECUTE FUNCTION public.partners_seed_publish();

DROP TRIGGER IF EXISTS partners_seed_publish_delete ON public.partners;
CREATE TRIGGER partners_seed_publish_delete
AFTER DELETE ON public.partners
FOR EACH ROW
WHEN (current_setting('referralfit.syncing', true) IS DISTINCT FROM 'on')
EXECUTE FUNCTION public.partners_seed_publish();

-- The UPDATE trigger's column list is the synced-field list, so the two can
-- never drift apart.
DO $$
DECLARE
  v_cols text;
BEGIN
  SELECT string_agg(format('%I', f), ', ')
    INTO v_cols
    FROM unnest(public.global_partner_synced_fields()) AS f;
  EXECUTE 'DROP TRIGGER IF EXISTS partners_seed_publish_update ON public.partners';
  EXECUTE format(
    'CREATE TRIGGER partners_seed_publish_update
     AFTER UPDATE OF %s ON public.partners
     FOR EACH ROW
     WHEN (current_setting(''referralfit.syncing'', true) IS DISTINCT FROM ''on'')
     EXECUTE FUNCTION public.partners_seed_publish()',
    v_cols
  );
END
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Maintenance: placeholder cleanup and backfill
-- ═══════════════════════════════════════════════════════════════════════════

-- Delete directory rows nobody references: not linked from any workspace's
-- partners, not claimed by a center account, and without an issued claim
-- code. Everything that reaches this migration in that state is placeholder
-- data from the hand-curated era. Per-user favorites on those rows go first
-- (no FK there); partners.global_partner_id and merged_into are ON DELETE
-- SET NULL and the center tables cascade, so nothing else can block the
-- delete. Returns the number of listings removed. Migration/admin only.
CREATE OR REPLACE FUNCTION public.cleanup_unlinked_global_partners()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform admin required' USING ERRCODE = '42501';
  END IF;

  WITH orphans AS (
    SELECT g.id
      FROM public.global_partners g
     WHERE NOT EXISTS (SELECT 1 FROM public.partners p WHERE p.global_partner_id = g.id)
       AND NOT EXISTS (SELECT 1 FROM public.center_members c WHERE c.global_partner_id = g.id)
       AND NOT EXISTS (SELECT 1 FROM public.center_claim_codes k WHERE k.global_partner_id = g.id)
  ),
  dropped_favorites AS (
    DELETE FROM public.user_favorites f
     WHERE f.target_type = 'global_partner'
       AND f.target_id IN (SELECT id FROM orphans)
  )
  DELETE FROM public.global_partners g
   WHERE g.id IN (SELECT id FROM orphans);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN v_deleted;
END
$$;
REVOKE ALL ON FUNCTION public.cleanup_unlinked_global_partners() FROM PUBLIC, anon, authenticated;

-- Publish every not-yet-linked partner of every seed org. Idempotent: a
-- second run finds nothing left to link and returns 0. Migration/admin only.
CREATE OR REPLACE FUNCTION public.publish_seed_org_partners()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_partner_id uuid;
  v_linked integer := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform admin required' USING ERRCODE = '42501';
  END IF;

  FOR v_partner_id IN
    SELECT p.id
      FROM public.partners p
     WHERE p.global_partner_id IS NULL
       AND public.org_is_platform_seed(p.org_id)
     ORDER BY p.created_at, p.id
  LOOP
    PERFORM public.publish_partner_to_global(v_partner_id);
    IF EXISTS (SELECT 1 FROM public.partners WHERE id = v_partner_id AND global_partner_id IS NOT NULL) THEN
      v_linked := v_linked + 1;
    END IF;
  END LOOP;
  RETURN v_linked;
END
$$;
REVOKE ALL ON FUNCTION public.publish_seed_org_partners() FROM PUBLIC, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Run it: cleanup first, then backfill
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_deleted integer;
  v_published integer;
BEGIN
  v_deleted := public.cleanup_unlinked_global_partners();
  v_published := public.publish_seed_org_partners();
  RAISE NOTICE 'auto_publish_admin_directory: deleted % placeholder listing(s), published % seed-org partner(s)', v_deleted, v_published;
END
$$;

REFRESH MATERIALIZED VIEW public.global_partner_stats;

COMMIT;
