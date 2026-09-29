BEGIN;

-- Claimed listings are authoritative; every workspace can build its own
-- verified directory profile.
--
-- Product rule (Matt Brown, 2026-09-28): "Once a listing has been claimed by
-- a professional, that becomes authoritative, regardless of who created it.
-- ... Allow each new user to build a verified profile for themselves as they
-- start to use the app."
--
-- Model. A directory listing (global_partners) is in exactly one of three
-- ownership states:
--
--   platform   nobody has claimed it. Curated by hand or auto-published from
--              the seed workspace (20260928120000). Seed-org edits push up
--              into it; admins verify it.
--   center     a center account claimed it with an admin-issued claim code
--              (center_members row). The center edits it in the portal.
--   org        a ReferralFit workspace owns it as its own profile
--              (owner_org_id). The workspace owner edits it in the app.
--
-- "Claimed" = center OR org (public.global_listing_is_claimed). A claimed
-- listing is authoritative:
--   * the claimant's edits keep it verified (they re-attest the content, so
--     verified_at is stamped now() on every claimant write);
--   * the seed workspace stops pushing its copy up. Its edits become local
--     overrides exactly like any other tenant's;
--   * claimant edits still propagate down to every linked copy (including
--     the seed org's) except fields a workspace overrode locally;
--   * it is never archived by the orphan-retirement or placeholder cleanup
--     paths while it has an owner.
--
-- Self-serve profiles. upsert_org_directory_profile(jsonb) lets a workspace
-- owner create or update the workspace's own listing (status active,
-- verified). Individual professionals (Interventionist / Therapist) are
-- listable this way; partner_is_directory_program() is untouched and still
-- governs only the seed auto-publish path.
--
-- Anti-hijack. On first create the RPC dedupes by phone digits / website
-- domain like suggest_global_listing. An UNCLAIMED match is taken over
-- automatically only when the caller's auth email domain equals the
-- listing's website domain, or the listing was created by the caller, or was
-- suggested by this workspace. Otherwise (and always when the match is
-- already claimed by someone else) a center_claim_requests row is recorded
-- and a platform admin approves or rejects it. Nothing is ever overwritten
-- by a claim request.
--
-- Sections:
--   1. schema: owner_org_id, one profile per org, claim requests
--   2. helpers: is-claimed, claimed-by-caller
--   3. verification guard learns about claimants; claim stamps verified_at
--   4. seed machinery defers to claimed listings
--   5. RLS: owners read their listing regardless of status
--   6. RPCs: upsert profile, approve / reject claim requests
--   7. search: p_types filter + claimed flag
--   8. backfill: already-claimed listings are verified

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Schema
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.global_partners
  ADD COLUMN IF NOT EXISTS owner_org_id uuid REFERENCES public.orgs(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.global_partners.owner_org_id IS
  'Workspace that owns this listing as its own directory profile. NULL unless the workspace built or was granted the profile.';

-- One profile per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS global_partners_owner_org_unique
  ON public.global_partners (owner_org_id)
  WHERE owner_org_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.center_claim_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  global_partner_id uuid NOT NULL REFERENCES public.global_partners(id) ON DELETE CASCADE,
  requested_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  note              text NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  -- The profile the workspace tried to publish, kept for the reviewer's
  -- context. Not applied automatically on approval.
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  resolved_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS center_claim_requests_listing_idx ON public.center_claim_requests (global_partner_id, status);
CREATE INDEX IF NOT EXISTS center_claim_requests_org_idx ON public.center_claim_requests (org_id, status);
-- One open request per workspace per listing.
CREATE UNIQUE INDEX IF NOT EXISTS center_claim_requests_one_pending
  ON public.center_claim_requests (org_id, global_partner_id)
  WHERE status = 'pending';

ALTER TABLE public.center_claim_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "center_claim_requests: org read own" ON public.center_claim_requests;
CREATE POLICY "center_claim_requests: org read own" ON public.center_claim_requests
  FOR SELECT USING (
    (SELECT public.is_platform_admin())
    OR org_id = (SELECT public.current_org_id())
  );
REVOKE ALL ON public.center_claim_requests FROM anon, PUBLIC;
GRANT SELECT ON public.center_claim_requests TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Helpers
-- ═══════════════════════════════════════════════════════════════════════════

-- SECURITY DEFINER: center_members is self-read only and global_partners
-- may be invisible to the caller, yet triggers running as the caller
-- (track_partner_local_overrides) need the answer.
CREATE OR REPLACE FUNCTION public.global_listing_is_claimed(p_global_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_global_id IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.global_partners g WHERE g.id = p_global_id AND g.owner_org_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM public.center_members c WHERE c.global_partner_id = p_global_id)
  )
$$;
REVOKE ALL ON FUNCTION public.global_listing_is_claimed(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.global_listing_is_claimed(uuid) TO authenticated;

-- Is the calling user a claimant of the listing: its center member, or a
-- member of the workspace that owns it?
CREATE OR REPLACE FUNCTION public.global_listing_claimed_by_caller(p_global_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND p_global_id IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.center_members c WHERE c.global_partner_id = p_global_id AND c.user_id = auth.uid())
    OR EXISTS (
      SELECT 1
        FROM public.global_partners g
        JOIN public.org_members m ON m.org_id = g.owner_org_id
       WHERE g.id = p_global_id
         AND m.user_id = auth.uid()
    )
  )
$$;
REVOKE ALL ON FUNCTION public.global_listing_claimed_by_caller(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.global_listing_claimed_by_caller(uuid) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Verification guard + claim
-- ═══════════════════════════════════════════════════════════════════════════

-- Lifecycle (status) stays admin-only for every direct non-admin write.
-- Verification: a claimant's edit re-attests the listing, so it is stamped
-- verified now; any other non-admin edit still clears it for review. The
-- seed publish path keeps its transaction-local bypass.
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
    IF public.global_listing_claimed_by_caller(OLD.id) THEN
      NEW.verified_at := now();
    ELSE
      NEW.verified_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.guard_global_partner_verification() FROM PUBLIC, anon, authenticated;

-- Claiming with a code now verifies the listing (if it was not already).
-- Everything else is identical to 20260820033721.
CREATE OR REPLACE FUNCTION public.claim_center_listing(p_code text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_claim public.center_claim_codes%ROWTYPE;
  v_prev_pub text := coalesce(current_setting('referralfit.seed_publish', true), '');
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

  PERFORM set_config('referralfit.seed_publish', 'on', true);
  UPDATE public.global_partners
     SET verified_at = coalesce(verified_at, now())
   WHERE id = v_claim.global_partner_id;
  PERFORM set_config('referralfit.seed_publish', v_prev_pub, true);

  RETURN v_claim.global_partner_id;
END
$$;
REVOKE ALL ON FUNCTION public.claim_center_listing(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_center_listing(text) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Seed machinery defers to claimed listings
-- ═══════════════════════════════════════════════════════════════════════════

-- Seed-org edits are pushed up only while the listing is unclaimed. Once
-- claimed, the seed workspace is a tenant like any other and its edits are
-- recorded as local overrides.
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
     OR (public.org_is_platform_seed(NEW.org_id) AND NOT public.global_listing_is_claimed(NEW.global_partner_id)) THEN
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

-- Never push seed fields into a claimed listing.
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
  IF p_partner.global_partner_id IS NULL
     OR public.global_listing_is_claimed(p_partner.global_partner_id) THEN
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

-- A listing with an owner is never an orphan.
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
     OR public.global_listing_is_claimed(p_global_id) THEN
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

-- Publishing a seed partner that matches a CLAIMED listing links the partner
-- (one copy per workspace, like suggest_global_listing) but does not push
-- the seed copy's fields up: the claimant's content stands. Unclaimed
-- matches behave exactly as before.
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
    IF EXISTS (
      SELECT 1 FROM public.partners
       WHERE org_id = v_partner.org_id AND global_partner_id = v_existing AND id <> p_partner_id
    ) THEN
      RETURN NULL;
    END IF;

    PERFORM public.activate_global_listing(v_existing);
    PERFORM set_config('referralfit.syncing', 'on', true);
    UPDATE public.partners p
       SET global_partner_id = v_existing,
           global_listing_status = g.status,
           global_synced_at = now(),
           local_overrides = '{}'
      FROM public.global_partners g
     WHERE p.id = p_partner_id AND g.id = v_existing;
    PERFORM set_config('referralfit.syncing', v_prev, true);

    IF NOT public.global_listing_is_claimed(v_existing) THEN
      SELECT * INTO v_partner FROM public.partners WHERE id = p_partner_id;
      PERFORM public.push_seed_partner_fields(v_partner, public.global_partner_synced_fields());
    END IF;
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

-- UPDATE of a seed partner linked to a claimed listing is a plain tenant
-- edit: no push, no unlink-on-type-change (the claimant decides what the
-- listing is). Everything else is unchanged from 20260928120000.
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

    IF public.global_listing_is_claimed(NEW.global_partner_id) THEN
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

-- Placeholder cleanup never touches a workspace's profile.
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
     WHERE g.owner_org_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.partners p WHERE p.global_partner_id = g.id)
       AND NOT EXISTS (SELECT 1 FROM public.center_members c WHERE c.global_partner_id = g.id)
       AND NOT EXISTS (SELECT 1 FROM public.center_claim_codes k WHERE k.global_partner_id = g.id)
       AND NOT EXISTS (SELECT 1 FROM public.center_claim_requests r WHERE r.global_partner_id = g.id)
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

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. RLS: a workspace reads its own profile regardless of status
-- ═══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "global_partners: org owner read own" ON public.global_partners;
CREATE POLICY "global_partners: org owner read own" ON public.global_partners
  FOR SELECT USING (owner_org_id IS NOT NULL AND owner_org_id = (SELECT public.current_org_id()));

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. RPCs
-- ═══════════════════════════════════════════════════════════════════════════

-- jsonb array of strings -> text[] (NULL / non-array -> empty). Trims and
-- drops blanks so the listing never carries empty tags.
CREATE OR REPLACE FUNCTION public.directory_payload_text_array(p_value jsonb)
RETURNS text[]
LANGUAGE sql IMMUTABLE
AS $$
  SELECT coalesce(
    (SELECT array_agg(btrim(v) ORDER BY ord)
       FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_value) = 'array' THEN p_value ELSE '[]'::jsonb END) WITH ORDINALITY AS t(v, ord)
      WHERE btrim(v) <> ''),
    '{}'::text[])
$$;
REVOKE ALL ON FUNCTION public.directory_payload_text_array(jsonb) FROM PUBLIC, anon, authenticated;

-- The public fields a workspace may publish about itself. Mirrors the app's
-- payload (src/lib/directory.ts OrgDirectoryProfileInput).
CREATE OR REPLACE FUNCTION public.org_directory_profile_fields()
RETURNS text[]
LANGUAGE sql IMMUTABLE
AS $$
  SELECT ARRAY['name','organization','types','city','state','regions','phone','email','website',
               'monthly_cost','insurance','insurance_networks','therapies','populations','levels','description']
$$;
REVOKE ALL ON FUNCTION public.org_directory_profile_fields() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_directory_profile_fields() TO authenticated;

-- Create or update the caller's workspace profile in the directory.
--
-- Returns jsonb {status, listing_id[, request_id]} where status is one of
--   created          a new listing was inserted and is live
--   updated          the workspace's existing profile was updated
--   claimed          an unclaimed duplicate was taken over (email domain,
--                    creator, or suggesting workspace matched) and is live
--   claim_requested  a duplicate exists that this workspace may not take
--                    over automatically; a platform admin will review
--
-- Caller must be the OWNER of their workspace. Only the allowlisted fields
-- are accepted; anything else is rejected outright so the API surface stays
-- explicit.
CREATE OR REPLACE FUNCTION public.upsert_org_directory_profile(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid := public.current_org_id();
  v_key text;
  v_name text;
  v_organization text;
  v_types text[];
  v_city text;
  v_state text;
  v_regions text[];
  v_phone text;
  v_email text;
  v_website text;
  v_monthly integer;
  v_insurance text[];
  v_networks jsonb;
  v_therapies text[];
  v_populations text[];
  v_levels text[];
  v_description text;
  v_phone_digits text;
  v_domain text;
  v_email_domain text;
  v_own uuid;
  v_match public.global_partners%ROWTYPE;
  v_request uuid;
  v_prev_pub text := coalesce(current_setting('referralfit.seed_publish', true), '');
  v_status text;
BEGIN
  IF v_user IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF public.current_org_role() IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Only the workspace owner can manage the directory profile' USING ERRCODE = '42501';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'Profile payload must be an object' USING ERRCODE = '22023';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_payload) LOOP
    IF NOT (v_key = ANY (public.org_directory_profile_fields())) THEN
      RAISE EXCEPTION 'Field "%" is not part of a directory profile', v_key USING ERRCODE = '22023';
    END IF;
  END LOOP;

  v_name := left(btrim(coalesce(p_payload ->> 'name', '')), 200);
  v_organization := left(btrim(coalesce(p_payload ->> 'organization', '')), 200);
  v_types := public.directory_payload_text_array(p_payload -> 'types');
  v_city := btrim(coalesce(p_payload ->> 'city', ''));
  v_state := upper(btrim(coalesce(p_payload ->> 'state', '')));
  v_regions := public.directory_payload_text_array(p_payload -> 'regions');
  v_phone := btrim(coalesce(p_payload ->> 'phone', ''));
  v_email := btrim(coalesce(p_payload ->> 'email', ''));
  v_website := nullif(btrim(coalesce(p_payload ->> 'website', '')), '');
  v_monthly := coalesce(nullif(btrim(coalesce(p_payload ->> 'monthly_cost', '')), '')::integer, 0);
  v_insurance := public.directory_payload_text_array(p_payload -> 'insurance');
  v_networks := CASE WHEN jsonb_typeof(p_payload -> 'insurance_networks') = 'object' THEN p_payload -> 'insurance_networks' ELSE '{}'::jsonb END;
  v_therapies := public.directory_payload_text_array(p_payload -> 'therapies');
  v_populations := public.directory_payload_text_array(p_payload -> 'populations');
  v_levels := public.directory_payload_text_array(p_payload -> 'levels');
  v_description := left(btrim(coalesce(p_payload ->> 'description', '')), 4000);

  IF v_name = '' THEN
    RAISE EXCEPTION 'A contact name is required' USING ERRCODE = '22023';
  END IF;
  IF v_organization = '' THEN
    RAISE EXCEPTION 'An organization or practice name is required' USING ERRCODE = '22023';
  END IF;
  IF cardinality(v_types) = 0 THEN
    RAISE EXCEPTION 'Choose at least one listing type' USING ERRCODE = '22023';
  END IF;
  IF NOT (v_types <@ ARRAY['Inpatient', 'IOP / PHP', 'Interventionist', 'Therapist', 'Sober Living', 'Detox']::text[]) THEN
    RAISE EXCEPTION 'Unknown listing type' USING ERRCODE = '22023';
  END IF;
  IF length(v_state) > 2 THEN
    RAISE EXCEPTION 'Use the two-letter state code' USING ERRCODE = '22023';
  END IF;
  IF v_monthly < 0 THEN
    RAISE EXCEPTION 'Monthly cost cannot be negative' USING ERRCODE = '22023';
  END IF;
  IF NOT public.is_valid_insurance_networks(v_networks) THEN
    RAISE EXCEPTION 'Insurance network statuses are invalid' USING ERRCODE = '22023';
  END IF;

  -- ── Update the workspace's existing profile ──────────────────────────────
  SELECT id INTO v_own FROM public.global_partners WHERE owner_org_id = v_org;
  IF v_own IS NOT NULL THEN
    PERFORM set_config('referralfit.seed_publish', 'on', true);
    UPDATE public.global_partners
       SET name = v_name, organization = v_organization, types = v_types, city = v_city, state = v_state,
           regions = v_regions, phone = v_phone, email = v_email, website = v_website, monthly_cost = v_monthly,
           insurance = v_insurance, insurance_networks = v_networks, therapies = v_therapies,
           populations = v_populations, levels = v_levels, description = v_description,
           verified_at = now()
     WHERE id = v_own;
    PERFORM set_config('referralfit.seed_publish', v_prev_pub, true);
    RETURN jsonb_build_object('status', 'updated', 'listing_id', v_own);
  END IF;

  -- ── First create: look for a duplicate ───────────────────────────────────
  v_phone_digits := regexp_replace(v_phone, '\D', '', 'g');
  v_domain := lower(regexp_replace(regexp_replace(coalesce(v_website, ''), '^\s*https?://', ''), '^(www\.)?([^/?#]+).*$', '\2'));

  SELECT * INTO v_match FROM public.global_partners
   WHERE status <> 'archived'
     AND ((v_domain <> '' AND website_domain = v_domain) OR (v_phone_digits <> '' AND phone_digits = v_phone_digits))
   ORDER BY (owner_org_id IS NOT NULL OR EXISTS (SELECT 1 FROM public.center_members c WHERE c.global_partner_id = global_partners.id)) DESC,
            (status = 'active') DESC, created_at
   LIMIT 1;

  IF v_match.id IS NULL THEN
    PERFORM set_config('referralfit.seed_publish', 'on', true);
    INSERT INTO public.global_partners (
      name, organization, types, city, state, regions, phone, email, website, monthly_cost,
      insurance, insurance_networks, therapies, populations, levels, description,
      status, verified_at, created_by, owner_org_id
    ) VALUES (
      v_name, v_organization, v_types, v_city, v_state, v_regions, v_phone, v_email, v_website, v_monthly,
      v_insurance, v_networks, v_therapies, v_populations, v_levels, v_description,
      'active', now(), v_user, v_org
    ) RETURNING id INTO v_own;
    PERFORM set_config('referralfit.seed_publish', v_prev_pub, true);
    RETURN jsonb_build_object('status', 'created', 'listing_id', v_own);
  END IF;

  -- ── Duplicate found ──────────────────────────────────────────────────────
  v_email_domain := lower(split_part(coalesce(
    auth.jwt() ->> 'email',
    (SELECT u.email FROM auth.users u WHERE u.id = v_user)
  ), '@', 2));

  IF NOT public.global_listing_is_claimed(v_match.id)
     AND (
       (v_email_domain <> '' AND v_match.website_domain <> '' AND v_match.website_domain = v_email_domain)
       OR v_match.created_by = v_user
       OR v_match.suggested_by_org_id = v_org
     ) THEN
    PERFORM set_config('referralfit.seed_publish', 'on', true);
    UPDATE public.global_partners
       SET name = v_name, organization = v_organization, types = v_types, city = v_city, state = v_state,
           regions = v_regions, phone = v_phone, email = v_email, website = v_website, monthly_cost = v_monthly,
           insurance = v_insurance, insurance_networks = v_networks, therapies = v_therapies,
           populations = v_populations, levels = v_levels, description = v_description,
           status = 'active', verified_at = now(), owner_org_id = v_org
     WHERE id = v_match.id;
    PERFORM set_config('referralfit.seed_publish', v_prev_pub, true);
    RETURN jsonb_build_object('status', 'claimed', 'listing_id', v_match.id);
  END IF;

  -- Someone else's listing, or an unclaimed one we cannot prove is ours:
  -- ask a platform admin. Re-submitting returns the open request.
  SELECT id INTO v_request FROM public.center_claim_requests
   WHERE org_id = v_org AND global_partner_id = v_match.id AND status = 'pending';
  IF v_request IS NULL THEN
    INSERT INTO public.center_claim_requests (org_id, global_partner_id, requested_by, note, payload)
    VALUES (v_org, v_match.id, v_user,
            left(format('%s (%s) asked to own "%s"', v_organization, v_email_domain, coalesce(nullif(v_match.organization, ''), v_match.name)), 2000),
            p_payload)
    RETURNING id INTO v_request;
  END IF;
  v_status := 'claim_requested';
  RETURN jsonb_build_object('status', v_status, 'listing_id', v_match.id, 'request_id', v_request);
END
$$;
REVOKE ALL ON FUNCTION public.upsert_org_directory_profile(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_org_directory_profile(jsonb) TO authenticated;

-- Platform admin grants a pending claim request: the workspace becomes the
-- listing's owner and the listing goes live, verified. Fails when the
-- listing already belongs to another workspace or the requesting workspace
-- already owns a different listing (one profile per workspace). A center
-- account may still be attached to the same listing; both are claimants.
CREATE OR REPLACE FUNCTION public.approve_center_claim_request(p_request_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.center_claim_requests%ROWTYPE;
  v_owner uuid;
  v_prev_pub text := coalesce(current_setting('referralfit.seed_publish', true), '');
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform admin required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_req FROM public.center_claim_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Claim request not found' USING ERRCODE = 'P0002'; END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'Claim request was already %', v_req.status USING ERRCODE = '22023';
  END IF;
  SELECT owner_org_id INTO v_owner FROM public.global_partners WHERE id = v_req.global_partner_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Directory listing not found' USING ERRCODE = 'P0002'; END IF;
  IF v_owner IS NOT NULL AND v_owner <> v_req.org_id THEN
    RAISE EXCEPTION 'Directory listing is owned by another workspace' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.global_partners WHERE owner_org_id = v_req.org_id AND id <> v_req.global_partner_id) THEN
    RAISE EXCEPTION 'That workspace already owns a different listing' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('referralfit.seed_publish', 'on', true);
  UPDATE public.global_partners
     SET owner_org_id = v_req.org_id,
         status = 'active',
         verified_at = now()
   WHERE id = v_req.global_partner_id;
  PERFORM set_config('referralfit.seed_publish', v_prev_pub, true);

  UPDATE public.center_claim_requests
     SET status = 'approved', resolved_at = now(), resolved_by = auth.uid()
   WHERE id = v_req.id;
  RETURN v_req.global_partner_id;
END
$$;
REVOKE ALL ON FUNCTION public.approve_center_claim_request(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_center_claim_request(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_center_claim_request(p_request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform admin required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.center_claim_requests
     SET status = 'rejected', resolved_at = now(), resolved_by = auth.uid()
   WHERE id = p_request_id AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'No pending claim request with that id' USING ERRCODE = 'P0002'; END IF;
END
$$;
REVOKE ALL ON FUNCTION public.reject_center_claim_request(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_center_claim_request(uuid) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. Search: type filter + claimed flag
-- ═══════════════════════════════════════════════════════════════════════════

-- Same query as 20260907120000 plus an optional p_types overlap filter
-- (appended last so positional callers are unaffected) and a `claimed`
-- output column. The return type changes, hence DROP + CREATE.
DROP FUNCTION IF EXISTS public.search_global_partners(text, text, text[], text[], text[], integer, integer);
CREATE OR REPLACE FUNCTION public.search_global_partners(
  p_query text DEFAULT NULL,
  p_state text DEFAULT NULL,
  p_levels text[] DEFAULT NULL,
  p_insurance text[] DEFAULT NULL,
  p_populations text[] DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_types text[] DEFAULT NULL
)
RETURNS TABLE (
  id uuid, name text, organization text, types text[], city text, state text, regions text[],
  phone text, email text, website text, monthly_cost integer, insurance text[],
  insurance_networks jsonb, therapies text[], populations text[], levels text[],
  description text, verified_at timestamptz, verification_expires_at timestamptz,
  verified_current boolean, updated_at timestamptz, rank real, claimed boolean
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
         END AS rank,
         public.global_listing_is_claimed(g.id) AS claimed
    FROM public.global_partners g, q
   WHERE g.status = 'active'
     AND (p_state IS NULL OR p_state = '' OR g.state = p_state)
     AND (p_levels IS NULL OR g.levels && p_levels)
     AND (p_insurance IS NULL OR g.insurance && p_insurance)
     AND (p_populations IS NULL OR g.populations && p_populations)
     AND (p_types IS NULL OR cardinality(p_types) = 0 OR g.types && p_types)
     AND (q.text IS NULL
          OR g.search_tsv @@ plainto_tsquery('simple', q.text)
          OR g.organization % q.text
          OR g.name % q.text
          OR g.organization ILIKE '%' || q.text || '%')
   ORDER BY rank DESC, g.state, g.organization, g.name, g.id
   LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
  OFFSET greatest(coalesce(p_offset, 0), 0)
$$;
REVOKE ALL ON FUNCTION public.search_global_partners(text, text, text[], text[], text[], integer, integer, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_global_partners(text, text, text[], text[], text[], integer, integer, text[]) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. Backfill: listings already claimed by a center are verified
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_count integer;
BEGIN
  PERFORM set_config('referralfit.seed_publish', 'on', true);
  UPDATE public.global_partners g
     SET verified_at = now()
   WHERE g.verified_at IS NULL
     AND EXISTS (SELECT 1 FROM public.center_members c WHERE c.global_partner_id = g.id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  PERFORM set_config('referralfit.seed_publish', '', true);
  RAISE NOTICE 'claimed_listings_authoritative: verified % previously claimed listing(s)', v_count;
END
$$;

COMMIT;
