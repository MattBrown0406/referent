BEGIN;

-- Seed workspace notes are private.
--
-- Product rule (Matt Brown, 2026-09-30): "Make my partner notes private for
-- sure."
--
-- Until now the platform seed workspace (a workspace owned by a platform
-- admin, 20260928120000) auto-published its treatment programs and, in doing
-- so, copied the seed partner's PRIVATE partners.note into the listing's
-- PUBLIC global_partners.description. Later note edits were pushed up as
-- well. 20260930120000_directory_submissions.sql already closed this for
-- every other workspace (a submission starts with an empty description and
-- 'note' is recorded as a local override). This migration makes the seed
-- workspace behave the same way: notes never leave the workspace.
--
-- What changes:
--   1. publish_partner_to_global: a NEW listing starts with description ''.
--      When the partner links to an EXISTING listing, that listing's
--      description is left alone. Dedupe (phone digits / website domain),
--      verification, the seed_publish and syncing flags, and grants are as
--      before.
--   2. Seed edits to note are never pushed to the listing. The seed push
--      path (partners_seed_publish -> push_seed_partner_fields) now works
--      from seed_partner_pushed_fields(), which is global_partner_synced_fields()
--      without 'note'. global_partner_synced_fields() itself is untouched:
--      propagate_global_partner_changes still maps a listing's description
--      onto the note of every IMPORTED copy in other workspaces (unless that
--      workspace overrode its note), and clear_partner_override('note')
--      still validates against it.
--   3. A seed partner linked to a listing (publish or dedupe-link) records
--      'note' in local_overrides, exactly like a submission does, so a later
--      description edit by a claimant or an admin cannot overwrite the seed
--      workspace's private note. Already-linked seed partners are backfilled.
--   4. One-time cleanup of what is already public: seed_notes_private_cleanup()
--      blanks the description of every listing linked from a seed partner
--      that is NOT claimed and whose description is byte-equal to
--      left(partner.note, 4000), i.e. it was auto-copied. Claimed listings
--      and hand-written descriptions are never touched. The function stays
--      so it can be re-run; it returns the number of listings cleared.
--      The cleanup is an ordinary description edit as far as
--      propagate_global_partner_changes is concerned: an imported copy in
--      another workspace whose note still equals the copied text (never
--      edited there) receives the empty description too; a copy whose note
--      was edited locally keeps it.
--
-- Unchanged: search_global_partners, upsert_org_directory_profile (its
-- description is a deliberately public field), claims, RLS, every
-- REVOKE/GRANT.
--
-- Transit rule: this file is pasted by hand from a chat client, so every
-- statement is plain ASCII with no backslashes. The phone-digit and
-- website-domain expressions that publish_partner_to_global used to inline
-- are rewritten as two helpers with POSIX classes and a non-capturing group;
-- supabase/tests/seed_notes_private_test.sql proves them equal to the
-- original expressions.
--
-- Sections:
--   1. helpers: phone digits, website domain, seed pushed fields
--   2. publish_partner_to_global
--   3. push_seed_partner_fields, partners_seed_publish
--   4. backfill 'note' override for linked seed partners
--   5. cleanup function
--   6. run the backfill and the cleanup once

-- ===========================================================================
-- 1. Helpers
-- ===========================================================================

-- Same result as regexp_replace(p, '<backslash>D', '', 'g').
CREATE OR REPLACE FUNCTION public.directory_phone_digits(p_phone text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')
$$;
REVOKE ALL ON FUNCTION public.directory_phone_digits(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.directory_phone_digits(text) TO authenticated;

-- Same result as the inline expression in 20260928170000: strip leading
-- whitespace and http(s)://, then the host without a leading www. When the
-- remainder has no host (empty, or starts with / ? #) it is returned as is,
-- which is what the original regexp_replace did on a non-match.
CREATE OR REPLACE FUNCTION public.directory_website_domain(p_website text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT lower(coalesce(
    substring(regexp_replace(coalesce(p_website, ''), '^[[:space:]]*https?://', '') from '^(?:www[.])?([^/?#]+)'),
    regexp_replace(coalesce(p_website, ''), '^[[:space:]]*https?://', '')
  ))
$$;
REVOKE ALL ON FUNCTION public.directory_website_domain(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.directory_website_domain(text) TO authenticated;

-- Fields the seed workspace pushes up into an unclaimed listing it is linked
-- to: every synced field except note. (global_partner_synced_fields() keeps
-- 'note' because the listing -> partner direction still maps description to
-- note for imported copies.)
CREATE OR REPLACE FUNCTION public.seed_partner_pushed_fields()
RETURNS text[]
LANGUAGE sql IMMUTABLE
AS $$
  SELECT array_remove(public.global_partner_synced_fields(), 'note')
$$;
REVOKE ALL ON FUNCTION public.seed_partner_pushed_fields() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.seed_partner_pushed_fields() TO authenticated;

-- ===========================================================================
-- 2. Publish
-- ===========================================================================

-- Identical to 20260928170000 except: a new listing starts with description
-- '', linking (either branch) records 'note' as a local override, the
-- dedupe-link push uses seed_partner_pushed_fields(), and the phone/domain
-- normalisation goes through the helpers above.
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

  v_phone := public.directory_phone_digits(v_partner.phone);
  v_domain := public.directory_website_domain(v_partner.website);

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
           local_overrides = ARRAY['note']
      FROM public.global_partners g
     WHERE p.id = p_partner_id AND g.id = v_existing;
    PERFORM set_config('referralfit.syncing', v_prev, true);

    IF NOT public.global_listing_is_claimed(v_existing) THEN
      SELECT * INTO v_partner FROM public.partners WHERE id = p_partner_id;
      PERFORM public.push_seed_partner_fields(v_partner, public.seed_partner_pushed_fields());
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
    '',
    'active', now(), coalesce(v_partner.owner_id, auth.uid()), v_partner.org_id
  ) RETURNING id INTO v_new;

  PERFORM set_config('referralfit.syncing', 'on', true);
  UPDATE public.partners
     SET global_partner_id = v_new,
         global_listing_status = 'active',
         global_synced_at = now(),
         local_overrides = ARRAY['note']
   WHERE id = p_partner_id;
  PERFORM set_config('referralfit.syncing', v_prev, true);
  RETURN v_new;
END
$$;
REVOKE ALL ON FUNCTION public.publish_partner_to_global(uuid) FROM PUBLIC, anon, authenticated;

-- ===========================================================================
-- 3. Push
-- ===========================================================================

-- Identical to 20260928170000 except that 'note' is never pushed: the
-- allowlist is seed_partner_pushed_fields() and the description branch is
-- gone.
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
    IF NOT (v_field = ANY (public.seed_partner_pushed_fields())) THEN
      CONTINUE;
    END IF;
    v_sets := array_append(v_sets, CASE v_field
      WHEN 'name'         THEN 'name = left(($1).name, 200)'
      WHEN 'organization' THEN 'organization = left(($1).organization, 200)'
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

-- Identical to 20260930120000 except that the changed-field scan runs over
-- seed_partner_pushed_fields(), so a note edit is never a pushed change.
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

    IF NOT public.partner_is_directory_program(NEW.types)
       AND public.partner_is_directory_program(OLD.types) THEN
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
    FOREACH v_field IN ARRAY public.seed_partner_pushed_fields() LOOP
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

-- ===========================================================================
-- 4. Backfill: every linked seed partner protects its note
-- ===========================================================================

-- Adds 'note' to local_overrides on every seed-workspace partner that is
-- linked to a listing and does not have it yet. Runs under referralfit.syncing
-- so neither partner trigger reacts. Idempotent; returns the number of
-- partners updated. Migration/admin only.
CREATE OR REPLACE FUNCTION public.seed_notes_private_protect()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev text := coalesce(current_setting('referralfit.syncing', true), '');
  v_count integer := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform admin required' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('referralfit.syncing', 'on', true);
  UPDATE public.partners p
     SET local_overrides = array_append(p.local_overrides, 'note')
   WHERE p.global_partner_id IS NOT NULL
     AND NOT ('note' = ANY (p.local_overrides))
     AND public.org_is_platform_seed(p.org_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  PERFORM set_config('referralfit.syncing', v_prev, true);
  RETURN v_count;
END
$$;
REVOKE ALL ON FUNCTION public.seed_notes_private_protect() FROM PUBLIC, anon, authenticated;

-- ===========================================================================
-- 5. Cleanup of already-published notes
-- ===========================================================================

-- Blanks the public description of every listing that
--   * is linked from a seed-workspace partner,
--   * is NOT claimed (no owner_org_id, no center_members row), and
--   * has a description byte-equal to left(that partner's note, 4000),
--     i.e. it was auto-copied and nobody rewrote it since.
-- Runs the protect step first so the seed partner's own note is a local
-- override before the listing edit propagates, and under
-- referralfit.seed_publish so the verification guard leaves verified_at
-- alone. Returns the number of listings cleared; 0 on a second run.
CREATE OR REPLACE FUNCTION public.seed_notes_private_cleanup()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev_sync text := coalesce(current_setting('referralfit.syncing', true), '');
  v_prev_pub text := coalesce(current_setting('referralfit.seed_publish', true), '');
  v_count integer := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform admin required' USING ERRCODE = '42501';
  END IF;
  PERFORM public.seed_notes_private_protect();

  PERFORM set_config('referralfit.syncing', 'on', true);
  PERFORM set_config('referralfit.seed_publish', 'on', true);
  UPDATE public.global_partners g
     SET description = ''
   WHERE g.description <> ''
     AND g.owner_org_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.center_members c WHERE c.global_partner_id = g.id)
     AND EXISTS (
       SELECT 1 FROM public.partners p
        WHERE p.global_partner_id = g.id
          AND public.org_is_platform_seed(p.org_id)
          AND g.description = left(p.note, 4000)
     );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  PERFORM set_config('referralfit.seed_publish', v_prev_pub, true);
  PERFORM set_config('referralfit.syncing', v_prev_sync, true);
  RETURN v_count;
END
$$;
REVOKE ALL ON FUNCTION public.seed_notes_private_cleanup() FROM PUBLIC, anon, authenticated;

-- ===========================================================================
-- 6. Run once
-- ===========================================================================

DO $$
DECLARE
  v_protected integer;
  v_cleared integer;
BEGIN
  v_protected := public.seed_notes_private_protect();
  v_cleared := public.seed_notes_private_cleanup();
  RAISE NOTICE 'seed_notes_private: protected % linked seed partner note(s), cleared % auto-copied listing description(s)', v_protected, v_cleared;
END
$$;

COMMIT;
