BEGIN;

-- Directory submissions: a real path from a practice's private list to the
-- shared directory, reviewed by a platform admin.
--
-- Product rule (Matt Brown, 2026-09-30): "For a program to be sent to the
-- admin for the global list, ALL of the info must be populated: price,
-- insurance, contact person, phone, email, etc. Once all of that is
-- submitted, allow it to be sent to me, the admin, for approval. If someone
-- doesn't input all the data, only allow the program to be saved to their
-- own personal list."
--
-- What changes:
--   * suggest_global_listing() refuses an incomplete partner (ERRCODE 22023,
--     message names the missing fields). Saving a partner is never affected:
--     the rule is checked only when a program is submitted.
--   * list_pending_global_listings() / review_global_listing() give platform
--     admins a review queue (there was no API-callable approval path before).
--   * A rejected submission leaves the submitter's partner in their private
--     list, unlinked, carrying the reviewer's note so they can fix and
--     resubmit.
--
-- What does not change: the platform seed workspace still auto-publishes
-- (publish_partner_to_global / partners_seed_publish are untouched and are
-- NOT subject to the completeness rule), dedupe by phone digits / website
-- domain, one linked copy per workspace, the verification guard, and every
-- RLS policy. A submitter can already read a listing it suggested
-- ("global_partners: suggester read own"), and the partner row carries the
-- state the app shows (global_listing_status, directory_rejected_at,
-- directory_review_note), so no policy is loosened here.
--
-- Sections:
--   1. completeness rule (mirrored in src/lib/directory-submission.ts)
--   2. schema: review audit columns, rejection state on the partner row
--   3. suggest_global_listing with the completeness check
--   4. admin queue: list_pending_global_listings, review_global_listing

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Completeness rule
-- ═══════════════════════════════════════════════════════════════════════════
--
-- KEEP IN LOCKSTEP with src/lib/directory-submission.ts. The field keys,
-- their order, their labels, and every test below have a line-for-line twin
-- there; scripts/directory-submission-test.mjs reads this file and fails
-- when the key/label list drifts. If a later migration redefines these
-- functions, keep the `('key', 'label')` row format so that test can still
-- read them.

-- Blank = nothing but whitespace and dashes. The partner form stores an em
-- dash for an empty city or state, so '—' must not count as an answer.
CREATE OR REPLACE FUNCTION public.directory_text_is_blank(p_value text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  SELECT btrim(coalesce(p_value, ''), E' \t\n\r—–-') = ''
$$;
REVOKE ALL ON FUNCTION public.directory_text_is_blank(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.directory_text_is_blank(text) TO authenticated;

-- Required fields in display order, with the plain-language label used in
-- "Add <label> to submit this program to the shared directory."
CREATE OR REPLACE FUNCTION public.directory_submission_field_labels()
RETURNS TABLE (field text, label text)
LANGUAGE sql IMMUTABLE
AS $$
  VALUES
    ('organization', 'program name'),
    ('name', 'contact person'),
    ('types', 'program type'),
    ('city', 'city'),
    ('state', 'state'),
    ('phone', '10-digit phone number'),
    ('email', 'email'),
    ('website', 'website'),
    ('monthly_cost', 'monthly cost'),
    ('insurance', 'insurance or private pay')
$$;
REVOKE ALL ON FUNCTION public.directory_submission_field_labels() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.directory_submission_field_labels() TO authenticated;

-- The rule itself, on plain values so it can judge a tenant partner and a
-- directory listing alike. Returns the keys of the missing fields in display
-- order; an empty array means "directory-ready".
--
--   organization  program name, not blank
--   name          contact person, not blank
--   types         at least one PROGRAM type: Inpatient, IOP / PHP, Sober
--                 Living, Detox. Unlike partner_is_directory_program() (the
--                 seed auto-publish test) an untyped partner is NOT ready,
--                 and an Interventionist/Therapist-only partner never is.
--   city, state   not blank
--   phone         at least 10 digits
--   email         looks like an address (something@something.tld)
--   website       not blank
--   monthly_cost  greater than 0
--   insurance     at least one entry in insurance or insurance_networks. The
--                 partner form's "Private pay only" choice stores the
--                 existing 'Cash pay' entry, so it counts as answered.
-- Therapies, populations, levels, regions and the description stay optional.
CREATE OR REPLACE FUNCTION public.directory_missing_fields(
  p_organization text,
  p_name text,
  p_types text[],
  p_city text,
  p_state text,
  p_phone text,
  p_email text,
  p_website text,
  p_monthly_cost integer,
  p_insurance text[],
  p_insurance_networks jsonb
)
RETURNS text[]
LANGUAGE sql IMMUTABLE
AS $$
  SELECT coalesce(array_agg(f.field ORDER BY f.ord), '{}'::text[])
    FROM (VALUES
      (1, 'organization', public.directory_text_is_blank(p_organization)),
      (2, 'name', public.directory_text_is_blank(p_name)),
      (3, 'types', NOT (coalesce(p_types, '{}'::text[]) && ARRAY['Inpatient', 'IOP / PHP', 'Sober Living', 'Detox']::text[])),
      (4, 'city', public.directory_text_is_blank(p_city)),
      (5, 'state', public.directory_text_is_blank(p_state)),
      (6, 'phone', length(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')) < 10),
      (7, 'email', btrim(coalesce(p_email, ''), E' \t\n\r') !~ E'^[^@ \t\n\r]+@[^@ \t\n\r]+\\.[^@ \t\n\r]+$'),
      (8, 'website', public.directory_text_is_blank(p_website)),
      (9, 'monthly_cost', coalesce(p_monthly_cost, 0) <= 0),
      (10, 'insurance', NOT (
        EXISTS (SELECT 1 FROM unnest(coalesce(p_insurance, '{}'::text[])) AS plan WHERE NOT public.directory_text_is_blank(plan))
        OR (p_insurance_networks IS NOT NULL
            AND jsonb_typeof(p_insurance_networks) = 'object'
            AND p_insurance_networks <> '{}'::jsonb)
      ))
    ) AS f(ord, field, missing)
   WHERE f.missing
$$;
REVOKE ALL ON FUNCTION public.directory_missing_fields(text, text, text[], text, text, text, text, text, integer, text[], jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.directory_missing_fields(text, text, text[], text, text, text, text, text, integer, text[], jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.partner_directory_missing_fields(p_partner public.partners)
RETURNS text[]
LANGUAGE sql STABLE
AS $$
  SELECT public.directory_missing_fields(
    p_partner.organization, p_partner.name, p_partner.types, p_partner.city, p_partner.state,
    p_partner.phone, p_partner.email, p_partner.website, p_partner.monthly_cost,
    p_partner.insurance, p_partner.insurance_networks
  )
$$;
REVOKE ALL ON FUNCTION public.partner_directory_missing_fields(public.partners) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_directory_missing_fields(public.partners) TO authenticated;

-- "Add monthly cost and email to submit this program to the shared
-- directory." Same sentence the app builds from the same labels.
CREATE OR REPLACE FUNCTION public.directory_missing_fields_message(p_fields text[])
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  WITH labels AS (
    SELECT array_agg(l.label ORDER BY array_position(p_fields, l.field)) AS items
      FROM public.directory_submission_field_labels() l
     WHERE l.field = ANY (p_fields)
  )
  SELECT CASE coalesce(cardinality(items), 0)
           WHEN 0 THEN ''
           WHEN 1 THEN 'Add ' || items[1]
           WHEN 2 THEN 'Add ' || items[1] || ' and ' || items[2]
           ELSE 'Add ' || array_to_string(items[1:cardinality(items) - 1], ', ') || ', and ' || items[cardinality(items)]
         END
         || CASE WHEN coalesce(cardinality(items), 0) = 0 THEN ''
                 ELSE ' to submit this program to the shared directory.' END
    FROM labels
$$;
REVOKE ALL ON FUNCTION public.directory_missing_fields_message(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.directory_missing_fields_message(text[]) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Schema
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Who submitted a listing is already recorded: suggested_by_org_id
-- (20260907120000) and created_by. Only the review outcome is new.
ALTER TABLE public.global_partners
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_note text NOT NULL DEFAULT '' CHECK (length(review_note) <= 2000);

COMMENT ON COLUMN public.global_partners.review_note IS
  'Reviewer''s note on a rejected submission. Left empty on approval: an active listing is readable by every directory workspace.';

-- The submitter follows a submission through its own partner row:
--   linked + global_listing_status 'pending'   waiting for review
--   linked + global_listing_status 'active'    in the directory
--   unlinked + directory_rejected_at set       not added; note says why
ALTER TABLE public.partners
  ADD COLUMN IF NOT EXISTS directory_rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS directory_review_note text NOT NULL DEFAULT '' CHECK (length(directory_review_note) <= 2000);

COMMENT ON COLUMN public.partners.directory_rejected_at IS
  'Set when a platform admin declined this partner''s directory submission; cleared when it is submitted again.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Submission
-- ═══════════════════════════════════════════════════════════════════════════

-- Identical to 20260916170000_fix_directory_platform_rpcs.sql except:
--   * an incomplete partner is refused before anything is written;
--   * linking clears a previous rejection from the partner row.
-- Directory entitlement is still not required to submit.
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
  v_missing text[];
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

  v_missing := public.partner_directory_missing_fields(v_partner);
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '%', public.directory_missing_fields_message(v_missing)
      USING ERRCODE = '22023',
            DETAIL = 'missing: ' || array_to_string(v_missing, ','),
            HINT = 'The program stays saved to your own list.';
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
           global_synced_at = now(),
           directory_rejected_at = NULL,
           directory_review_note = ''
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
  UPDATE public.partners
     SET global_partner_id = v_new,
         global_listing_status = 'pending',
         global_synced_at = now(),
         directory_rejected_at = NULL,
         directory_review_note = ''
   WHERE id = p_partner_id;
  PERFORM set_config('referralfit.syncing', v_prev, true);
  RETURN v_new;
END
$$;
REVOKE ALL ON FUNCTION public.suggest_global_listing(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.suggest_global_listing(uuid) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Admin review queue
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The app learns whether to show the queue from the existing
-- public.is_platform_admin() (already granted to authenticated). That answer
-- only decides what the app displays; both functions below re-check it.

-- Pending submissions, oldest first, with everything a reviewer needs.
-- missing_fields re-runs the completeness rule on the listing itself, so a
-- listing that went pending before this rule existed is visible as such.
CREATE OR REPLACE FUNCTION public.list_pending_global_listings()
RETURNS TABLE (
  id uuid,
  name text,
  organization text,
  types text[],
  city text,
  state text,
  phone text,
  email text,
  website text,
  monthly_cost integer,
  insurance text[],
  insurance_networks jsonb,
  therapies text[],
  description text,
  submitted_at timestamptz,
  submitted_by_org_id uuid,
  submitted_by_practice text,
  submitted_by_member text,
  missing_fields text[]
)
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform admin required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT g.id, g.name, g.organization, g.types, g.city, g.state, g.phone, g.email, g.website,
         g.monthly_cost, g.insurance, g.insurance_networks, g.therapies, g.description,
         g.created_at,
         g.suggested_by_org_id,
         coalesce(o.name, ''),
         coalesce(m.display_name, ''),
         public.directory_missing_fields(
           g.organization, g.name, g.types, g.city, g.state, g.phone, g.email, g.website,
           g.monthly_cost, g.insurance, g.insurance_networks)
    FROM public.global_partners g
    LEFT JOIN public.orgs o ON o.id = g.suggested_by_org_id
    LEFT JOIN public.org_members m ON m.user_id = g.created_by
   WHERE g.status = 'pending'
   ORDER BY g.created_at, g.id;
END
$$;
REVOKE ALL ON FUNCTION public.list_pending_global_listings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_pending_global_listings() TO authenticated;

-- Approve or decline one pending submission. Returns the listing's new
-- status ('active' or 'archived').
--
-- Approve: one UPDATE to status 'active' + verified_at now(). The caller is
-- a signed-in platform admin, which is exactly what
-- guard_global_partner_verification lets through, so no bypass flag
-- (referralfit.seed_publish) is set here. The status change reaches every
-- linked partner row through the existing propagate_global_partner_changes
-- trigger, the same way every other status change does.
--
-- Decline: every partner linked to the listing is unlinked and keeps living
-- in its workspace's private list, now carrying directory_rejected_at and
-- the note. The listing is ARCHIVED rather than deleted:
--   * suggest_global_listing and publish_partner_to_global both ignore
--     archived listings when they dedupe, so a declined listing is never
--     resurrected — a resubmission creates a fresh pending listing;
--   * it keeps the audit trail (reviewed_by / reviewed_at / review_note);
--   * 'archived' is already the terminal state retire_orphaned_global_listing
--     gives an unlinked listing, and cleanup_unlinked_global_partners (the
--     admin-only maintenance sweep) removes unlinked, unclaimed listings, so
--     a declined row is an ordinary retired listing, not a new kind of
--     orphan.
-- A listing someone has claimed (center account or owning workspace) is not
-- declined here; that belongs to the claim tools.
CREATE OR REPLACE FUNCTION public.review_global_listing(
  p_global_id uuid,
  p_approve boolean,
  p_note text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_note text := left(btrim(coalesce(p_note, '')), 2000);
  v_prev text := coalesce(current_setting('referralfit.syncing', true), '');
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform admin required' USING ERRCODE = '42501';
  END IF;
  IF p_approve IS NULL THEN
    RAISE EXCEPTION 'Choose approve or decline' USING ERRCODE = '22023';
  END IF;

  SELECT status INTO v_status FROM public.global_partners WHERE id = p_global_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Directory listing not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'This submission was already reviewed' USING ERRCODE = '22023';
  END IF;

  IF p_approve THEN
    UPDATE public.global_partners
       SET status = 'active',
           verified_at = now(),
           reviewed_by = auth.uid(),
           reviewed_at = now(),
           review_note = ''
     WHERE id = p_global_id;
    RETURN 'active';
  END IF;

  IF public.global_listing_is_claimed(p_global_id) THEN
    RAISE EXCEPTION 'This listing has been claimed by its program and cannot be declined here' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('referralfit.syncing', 'on', true);
  UPDATE public.partners
     SET global_partner_id = NULL,
         global_listing_status = 'active',
         global_synced_at = NULL,
         local_overrides = '{}',
         directory_rejected_at = now(),
         directory_review_note = v_note
   WHERE global_partner_id = p_global_id;
  PERFORM set_config('referralfit.syncing', v_prev, true);

  UPDATE public.global_partners
     SET status = 'archived',
         reviewed_by = auth.uid(),
         reviewed_at = now(),
         review_note = v_note
   WHERE id = p_global_id;
  RETURN 'archived';
END
$$;
REVOKE ALL ON FUNCTION public.review_global_listing(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_global_listing(uuid, boolean, text) TO authenticated;

COMMIT;
