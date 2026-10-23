-- ReferralFit - directory and membership hardening (reviewer findings, 2026-10-24).
--
--   1. Directory profiles never take over an existing listing on their own.
--      upsert_org_directory_profile used to hand an unclaimed duplicate to
--      the caller when the caller's workspace had suggested it, the caller
--      had created it, or the caller's (unconfirmed) sign-in email domain
--      matched its website. None of those prove the caller IS that program.
--      Every duplicate now becomes a center_claim_requests row that a
--      platform admin approves (approve_center_claim_request); the listing
--      is not touched until then. A brand-new profile is still created live.
--   2. suggest_global_listing links a private partner to an existing listing
--      only when the normalized organization name ALSO matches (on top of
--      phone digits or website domain). Otherwise a new pending suggestion
--      is created, exactly as for a brand-new program. A claimed center can
--      no longer capture other practices' partners by copying a phone number.
--   3. accept_org_invite works for a typical solo practitioner: a partner
--      linked to a directory listing the team already tracks is merged into
--      the team's copy (its activity is repointed, then it is deleted), the
--      insurance / matching tables move with the rest, their composite FKs
--      are DEFERRABLE like the others, and nothing that should move is lost
--      to the old workspace's ON DELETE CASCADE.
--   4. case_benefits, vob_requests and placement_decisions keep the
--      practice's records when the member who created them deletes their
--      account (owner_id is nullable, ON DELETE SET NULL).
--   5. Network stats and benchmarks count only established workspaces
--      (public.org_is_established: 30+ days old AND 3+ cases or 5+
--      referrals), so free throwaway workspaces cannot satisfy the
--      k-anonymity floor or skew the aggregates.
--   6. push_outbox_record keeps a transiently failed push retryable.
--   7. Cross-tenant references closed: vob_requests.follow_up_id and
--      placement_decisions.referral_id are org-scoped composite FKs, and
--      request_vob refuses another workspace's follow-up id.
--   8. Offline replays are safe: complete_follow_up_with_next no longer
--      re-opens a finished next step, assign_match_referral no longer wipes
--      recorded outcomes, and both match RPCs keep the matching-integrity
--      columns of a match they create.
--   9. Placement check-ins due "today" in US evening hours are no longer
--      skipped because the server's UTC date already rolled over.
--
-- Transit rule: this file is pasted into the SQL editor from a chat client.
-- ASCII only, no backslash characters anywhere, every top-level statement
-- under 3,700 characters.

BEGIN;

-- ===========================================================================
-- 1. Directory profiles: duplicates always go to admin review
-- ===========================================================================

-- Parses and validates a profile payload into a global_partners row value.
-- Same rules and messages as before; only the listing fields are set.
CREATE OR REPLACE FUNCTION public.org_directory_profile_row(p_payload jsonb)
RETURNS public.global_partners
LANGUAGE plpgsql STABLE
SET search_path = public
AS $$
DECLARE
  v_key text;
  v_row public.global_partners;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'Profile payload must be an object' USING ERRCODE = '22023';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_payload) LOOP
    IF NOT (v_key = ANY (public.org_directory_profile_fields())) THEN
      RAISE EXCEPTION 'Field "%" is not part of a directory profile', v_key USING ERRCODE = '22023';
    END IF;
  END LOOP;

  v_row.name := left(btrim(coalesce(p_payload ->> 'name', '')), 200);
  v_row.organization := left(btrim(coalesce(p_payload ->> 'organization', '')), 200);
  v_row.types := public.directory_payload_text_array(p_payload -> 'types');
  v_row.city := btrim(coalesce(p_payload ->> 'city', ''));
  v_row.state := upper(btrim(coalesce(p_payload ->> 'state', '')));
  v_row.regions := public.directory_payload_text_array(p_payload -> 'regions');
  v_row.phone := btrim(coalesce(p_payload ->> 'phone', ''));
  v_row.email := btrim(coalesce(p_payload ->> 'email', ''));
  v_row.website := nullif(btrim(coalesce(p_payload ->> 'website', '')), '');
  v_row.monthly_cost := coalesce(nullif(btrim(coalesce(p_payload ->> 'monthly_cost', '')), '')::integer, 0);
  v_row.insurance := public.directory_payload_text_array(p_payload -> 'insurance');
  v_row.insurance_networks := CASE WHEN jsonb_typeof(p_payload -> 'insurance_networks') = 'object'
                                   THEN p_payload -> 'insurance_networks' ELSE '{}'::jsonb END;
  v_row.therapies := public.directory_payload_text_array(p_payload -> 'therapies');
  v_row.populations := public.directory_payload_text_array(p_payload -> 'populations');
  v_row.levels := public.directory_payload_text_array(p_payload -> 'levels');
  v_row.description := left(btrim(coalesce(p_payload ->> 'description', '')), 4000);

  IF v_row.name = '' THEN
    RAISE EXCEPTION 'A contact name is required' USING ERRCODE = '22023';
  END IF;
  IF v_row.organization = '' THEN
    RAISE EXCEPTION 'An organization or practice name is required' USING ERRCODE = '22023';
  END IF;
  IF cardinality(v_row.types) = 0 THEN
    RAISE EXCEPTION 'Choose at least one listing type' USING ERRCODE = '22023';
  END IF;
  IF NOT (v_row.types <@ ARRAY['Inpatient', 'IOP / PHP', 'Interventionist', 'Therapist', 'Sober Living', 'Detox']::text[]) THEN
    RAISE EXCEPTION 'Unknown listing type' USING ERRCODE = '22023';
  END IF;
  IF length(v_row.state) > 2 THEN
    RAISE EXCEPTION 'Use the two-letter state code' USING ERRCODE = '22023';
  END IF;
  IF v_row.monthly_cost < 0 THEN
    RAISE EXCEPTION 'Monthly cost cannot be negative' USING ERRCODE = '22023';
  END IF;
  IF NOT public.is_valid_insurance_networks(v_row.insurance_networks) THEN
    RAISE EXCEPTION 'Insurance network statuses are invalid' USING ERRCODE = '22023';
  END IF;
  RETURN v_row;
END
$$;
REVOKE ALL ON FUNCTION public.org_directory_profile_row(jsonb) FROM PUBLIC, anon, authenticated;

-- Internal. Writes a validated profile: updates p_listing, or inserts a new
-- live listing owned by p_org when p_listing is NULL. Returns the id.
CREATE OR REPLACE FUNCTION public.org_directory_profile_save(p_listing uuid, p_row public.global_partners, p_org uuid, p_user uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid := p_listing;
  v_prev_pub text := coalesce(current_setting('referralfit.seed_publish', true), '');
BEGIN
  PERFORM set_config('referralfit.seed_publish', 'on', true);
  IF v_id IS NOT NULL THEN
    UPDATE public.global_partners
       SET name = p_row.name, organization = p_row.organization, types = p_row.types, city = p_row.city,
           state = p_row.state, regions = p_row.regions, phone = p_row.phone, email = p_row.email,
           website = p_row.website, monthly_cost = p_row.monthly_cost, insurance = p_row.insurance,
           insurance_networks = p_row.insurance_networks, therapies = p_row.therapies,
           populations = p_row.populations, levels = p_row.levels, description = p_row.description,
           verified_at = now()
     WHERE id = v_id;
  ELSE
    INSERT INTO public.global_partners (
      name, organization, types, city, state, regions, phone, email, website, monthly_cost,
      insurance, insurance_networks, therapies, populations, levels, description,
      status, verified_at, created_by, owner_org_id
    ) VALUES (
      p_row.name, p_row.organization, p_row.types, p_row.city, p_row.state, p_row.regions, p_row.phone,
      p_row.email, p_row.website, p_row.monthly_cost, p_row.insurance, p_row.insurance_networks,
      p_row.therapies, p_row.populations, p_row.levels, p_row.description,
      'active', now(), p_user, p_org
    ) RETURNING id INTO v_id;
  END IF;
  PERFORM set_config('referralfit.seed_publish', v_prev_pub, true);
  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION public.org_directory_profile_save(uuid, public.global_partners, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Internal. Files (or returns the open) claim request for p_org on an
-- existing listing. The note carries hints for the reviewer: who submitted
-- or created the listing, and whether the sign-in email domain matches its
-- website. None of these is proof of identity, so none decides anything.
CREATE OR REPLACE FUNCTION public.org_directory_claim_request(p_match public.global_partners, p_org uuid, p_user uuid, p_payload jsonb, p_organization text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request uuid;
  v_email_domain text;
  v_why text;
BEGIN
  SELECT id INTO v_request FROM public.center_claim_requests
   WHERE org_id = p_org AND global_partner_id = p_match.id AND status = 'pending';
  IF v_request IS NOT NULL THEN
    RETURN v_request;
  END IF;
  v_email_domain := lower(split_part(coalesce(auth.jwt() ->> 'email',
    (SELECT u.email FROM auth.users u WHERE u.id = p_user)), '@', 2));
  v_why := concat_ws('; ',
    CASE WHEN p_match.suggested_by_org_id = p_org THEN 'submitted by this workspace' END,
    CASE WHEN p_match.created_by = p_user THEN 'created by this user' END,
    CASE WHEN v_email_domain <> '' AND p_match.website_domain = v_email_domain
         THEN 'sign-in email domain matches the website (unverified)' END);
  INSERT INTO public.center_claim_requests (org_id, global_partner_id, requested_by, note, payload)
  VALUES (p_org, p_match.id, p_user,
          left(format('%s (%s) asked to own "%s"', p_organization, v_email_domain,
                      coalesce(nullif(p_match.organization, ''), p_match.name))
               || CASE WHEN v_why <> '' THEN ' [' || v_why || ']' ELSE '' END, 2000),
          p_payload)
  RETURNING id INTO v_request;
  RETURN v_request;
END
$$;
REVOKE ALL ON FUNCTION public.org_directory_claim_request(public.global_partners, uuid, uuid, jsonb, text) FROM PUBLIC, anon, authenticated;

-- Returns {status, listing_id[, request_id]}; status is created, updated, or
-- claim_requested. The old automatic takeover ('claimed') is gone: any
-- existing listing with the same phone digits or website domain is handed
-- over only by a platform admin approving the claim request, and nothing on
-- it changes until then.
CREATE OR REPLACE FUNCTION public.upsert_org_directory_profile(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid := public.current_org_id();
  v_row public.global_partners;
  v_own uuid;
  v_match public.global_partners%ROWTYPE;
  v_domain text;
  v_digits text;
BEGIN
  IF v_user IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF public.current_org_role() IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Only the workspace owner can manage the directory profile' USING ERRCODE = '42501';
  END IF;
  v_row := public.org_directory_profile_row(p_payload);

  SELECT id INTO v_own FROM public.global_partners WHERE owner_org_id = v_org;
  IF v_own IS NOT NULL THEN
    PERFORM public.org_directory_profile_save(v_own, v_row, v_org, v_user);
    RETURN jsonb_build_object('status', 'updated', 'listing_id', v_own);
  END IF;

  v_digits := public.directory_phone_digits(v_row.phone);
  v_domain := public.directory_website_domain(v_row.website);
  SELECT * INTO v_match FROM public.global_partners g
   WHERE g.status <> 'archived'
     AND ((v_domain <> '' AND g.website_domain = v_domain) OR (v_digits <> '' AND g.phone_digits = v_digits))
   ORDER BY (g.owner_org_id IS NOT NULL OR EXISTS (SELECT 1 FROM public.center_members c WHERE c.global_partner_id = g.id)) DESC,
            (g.status = 'active') DESC, g.created_at
   LIMIT 1;

  IF v_match.id IS NULL THEN
    v_own := public.org_directory_profile_save(NULL, v_row, v_org, v_user);
    RETURN jsonb_build_object('status', 'created', 'listing_id', v_own);
  END IF;

  RETURN jsonb_build_object('status', 'claim_requested', 'listing_id', v_match.id,
    'request_id', public.org_directory_claim_request(v_match, v_org, v_user, p_payload, v_row.organization));
END
$$;
REVOKE ALL ON FUNCTION public.upsert_org_directory_profile(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_org_directory_profile(jsonb) TO authenticated;

-- ===========================================================================
-- 2. Submissions link to an existing listing only on a name match too
-- ===========================================================================

-- Lowercase letters and digits only, without a leading "the":
-- "The Meadows, LLC" -> "meadowsllc".
CREATE OR REPLACE FUNCTION public.directory_name_key(p_value text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT regexp_replace(regexp_replace(lower(coalesce(p_value, '')), '^[^[:alnum:]]*the[^[:alnum:]]+', ''),
                        '[^[:alnum:]]+', '', 'g')
$$;
REVOKE ALL ON FUNCTION public.directory_name_key(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.directory_name_key(text) TO authenticated;

-- Two organization names are the same program when their keys are equal,
-- or one key (at least 4 characters) starts the other: "Cedar Ridge" and
-- "Cedar Ridge Recovery" match; "Summit Detox" and "Valley Detox" do not.
CREATE OR REPLACE FUNCTION public.directory_names_match(p_left text, p_right text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN l = '' OR r = '' THEN false
    WHEN l = r THEN true
    WHEN least(length(l), length(r)) < 4 THEN false
    ELSE left(l, length(r)) = r OR left(r, length(l)) = l
  END
    FROM (SELECT public.directory_name_key(p_left) AS l, public.directory_name_key(p_right) AS r) AS k
$$;
REVOKE ALL ON FUNCTION public.directory_names_match(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.directory_names_match(text, text) TO authenticated;

-- The listing a submitted partner may link to: same phone digits or website
-- domain AND a matching organization name (directory_names_match against
-- the listing's organization, or its name when that is blank). NULL when
-- none qualifies, whether or not the listing is claimed.
CREATE OR REPLACE FUNCTION public.directory_listing_match_for_partner(p_partner public.partners)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT g.id FROM public.global_partners g
   WHERE g.status <> 'archived'
     AND ((public.directory_website_domain(p_partner.website) <> ''
           AND g.website_domain = public.directory_website_domain(p_partner.website))
       OR (public.directory_phone_digits(p_partner.phone) <> ''
           AND g.phone_digits = public.directory_phone_digits(p_partner.phone)))
     AND public.directory_names_match(p_partner.organization, coalesce(nullif(btrim(g.organization), ''), g.name))
   ORDER BY (g.status = 'active') DESC, g.created_at
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.directory_listing_match_for_partner(public.partners) FROM PUBLIC, anon, authenticated;

-- Same as 20260930120000 except the existing listing comes from
-- directory_listing_match_for_partner (name must match too). Without a match
-- a new pending listing is created for admin review, even when the phone or
-- domain belongs to a claimed listing.
CREATE OR REPLACE FUNCTION public.suggest_global_listing(p_partner_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid := public.current_org_id();
  v_partner public.partners%ROWTYPE;
  v_missing text[];
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
      USING ERRCODE = '22023', DETAIL = 'missing: ' || array_to_string(v_missing, ','),
            HINT = 'The partner stays saved to your own list.';
  END IF;

  v_existing := public.directory_listing_match_for_partner(v_partner);
  IF v_existing IS NOT NULL THEN
    -- One linked copy per workspace (partners_org_global_partner_unique).
    IF EXISTS (SELECT 1 FROM public.partners
                WHERE org_id = v_org AND global_partner_id = v_existing AND id <> p_partner_id) THEN
      RETURN v_existing;
    END IF;
    PERFORM set_config('referralfit.syncing', 'on', true);
    UPDATE public.partners p
       SET global_partner_id = v_existing, global_listing_status = g.status, global_synced_at = now(),
           local_overrides = CASE WHEN 'note' = ANY (p.local_overrides) THEN p.local_overrides
                                  ELSE array_append(p.local_overrides, 'note') END,
           directory_rejected_at = NULL, directory_review_note = ''
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
    '', 'pending', v_user, v_org
  ) RETURNING id INTO v_new;

  PERFORM set_config('referralfit.syncing', 'on', true);
  UPDATE public.partners
     SET global_partner_id = v_new, global_listing_status = 'pending', global_synced_at = now(),
         local_overrides = CASE WHEN 'note' = ANY (local_overrides) THEN local_overrides
                                ELSE array_append(local_overrides, 'note') END,
         directory_rejected_at = NULL, directory_review_note = ''
   WHERE id = p_partner_id;
  PERFORM set_config('referralfit.syncing', v_prev, true);
  RETURN v_new;
END
$$;
REVOKE ALL ON FUNCTION public.suggest_global_listing(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.suggest_global_listing(uuid) TO authenticated;

-- ===========================================================================
-- 3. Insurance / matching tables: attribution and org-scoped relationships
-- ===========================================================================

-- owner_id is an audit pointer, as on every other tenant table: a member
-- deleting their account leaves the practice's records in place.
ALTER TABLE public.case_benefits
  ALTER COLUMN owner_id DROP NOT NULL,
  DROP CONSTRAINT case_benefits_owner_id_fkey,
  ADD CONSTRAINT case_benefits_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.vob_requests
  ALTER COLUMN owner_id DROP NOT NULL,
  DROP CONSTRAINT vob_requests_owner_id_fkey,
  ADD CONSTRAINT vob_requests_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.placement_decisions
  ALTER COLUMN owner_id DROP NOT NULL,
  DROP CONSTRAINT placement_decisions_owner_id_fkey,
  ADD CONSTRAINT placement_decisions_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE SET NULL;

DROP TRIGGER IF EXISTS case_benefits_guard_attribution ON public.case_benefits;
CREATE TRIGGER case_benefits_guard_attribution BEFORE UPDATE ON public.case_benefits
  FOR EACH ROW EXECUTE FUNCTION public.guard_row_attribution();
DROP TRIGGER IF EXISTS vob_requests_guard_attribution ON public.vob_requests;
CREATE TRIGGER vob_requests_guard_attribution BEFORE UPDATE ON public.vob_requests
  FOR EACH ROW EXECUTE FUNCTION public.guard_row_attribution();
DROP TRIGGER IF EXISTS placement_decisions_guard_attribution ON public.placement_decisions;
CREATE TRIGGER placement_decisions_guard_attribution BEFORE UPDATE ON public.placement_decisions
  FOR EACH ROW EXECUTE FUNCTION public.guard_row_attribution();

-- follow_ups gets the (id, org_id) key the other parent tables already have.
ALTER TABLE public.follow_ups ADD CONSTRAINT follow_ups_id_org_key UNIQUE (id, org_id);

-- Plain id references could point into another workspace. Clear any such
-- link (it was never valid) before the org-scoped FKs are added.
DO $$
DECLARE
  v_vob integer;
  v_placement integer;
BEGIN
  UPDATE public.vob_requests v SET follow_up_id = NULL
   WHERE v.follow_up_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.follow_ups f WHERE f.id = v.follow_up_id AND f.org_id = v.org_id);
  GET DIAGNOSTICS v_vob = ROW_COUNT;
  UPDATE public.placement_decisions d SET referral_id = NULL
   WHERE d.referral_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.referrals r WHERE r.id = d.referral_id AND r.org_id = d.org_id);
  GET DIAGNOSTICS v_placement = ROW_COUNT;
  RAISE NOTICE 'directory_membership_hardening: cleared % cross-workspace VOB follow-up link(s), % placement referral link(s)',
    v_vob, v_placement;
END
$$;

-- Same names, now DEFERRABLE INITIALLY IMMEDIATE like every other
-- composite relationship, so accept_org_invite can move a workspace's rows
-- in one transaction.
ALTER TABLE public.case_benefits
  DROP CONSTRAINT case_benefits_case_org_fk,
  ADD CONSTRAINT case_benefits_case_org_fk FOREIGN KEY (case_id, org_id)
    REFERENCES public.cases (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE public.vob_requests
  DROP CONSTRAINT vob_requests_case_org_fk,
  DROP CONSTRAINT vob_requests_partner_org_fk,
  DROP CONSTRAINT vob_requests_follow_up_id_fkey,
  ADD CONSTRAINT vob_requests_case_org_fk FOREIGN KEY (case_id, org_id)
    REFERENCES public.cases (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT vob_requests_partner_org_fk FOREIGN KEY (partner_id, org_id)
    REFERENCES public.partners (id, org_id) ON DELETE SET NULL (partner_id) DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT vob_requests_follow_up_org_fk FOREIGN KEY (follow_up_id, org_id)
    REFERENCES public.follow_ups (id, org_id) ON DELETE SET NULL (follow_up_id) DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE public.placement_decisions
  DROP CONSTRAINT placement_decisions_match_org_fk,
  DROP CONSTRAINT placement_decisions_partner_org_fk,
  DROP CONSTRAINT placement_decisions_case_org_fk,
  DROP CONSTRAINT placement_decisions_referral_id_fkey,
  ADD CONSTRAINT placement_decisions_match_org_fk FOREIGN KEY (match_profile_id, org_id)
    REFERENCES public.match_profiles (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT placement_decisions_partner_org_fk FOREIGN KEY (chosen_partner_id, org_id)
    REFERENCES public.partners (id, org_id) ON DELETE SET NULL (chosen_partner_id) DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT placement_decisions_case_org_fk FOREIGN KEY (case_id, org_id)
    REFERENCES public.cases (id, org_id) ON DELETE SET NULL (case_id) DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT placement_decisions_referral_org_fk FOREIGN KEY (referral_id, org_id)
    REFERENCES public.referrals (id, org_id) ON DELETE SET NULL (referral_id) DEFERRABLE INITIALLY IMMEDIATE;

-- 4. request_vob (20261001170000) + follow-up id check.
CREATE OR REPLACE FUNCTION public.request_vob(p_request jsonb)
RETURNS TABLE (id uuid, program_name text, global_partner_id uuid, requested_at timestamptz, follow_up_id uuid, due_on date, event_body text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_user uuid := auth.uid();
  v_org uuid := public.current_org_id();
  v_id uuid := coalesce(nullif(p_request ->> 'id', '')::uuid, gen_random_uuid());
  v_case uuid := nullif(p_request ->> 'case_id', '')::uuid;
  v_partner uuid := nullif(p_request ->> 'partner_id', '')::uuid;
  v_program text := left(btrim(coalesce(p_request ->> 'program_name', '')), 200);
  v_listing uuid;
  v_due date := nullif(p_request ->> 'due_on', '')::date;
  v_follow uuid := coalesce(nullif(p_request ->> 'follow_up_id', '')::uuid, gen_random_uuid());
  v_row public.vob_requests;
  v_inserted integer;
  v_body text;
BEGIN
  IF v_user IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF v_case IS NULL OR NOT EXISTS (SELECT 1 FROM public.cases c WHERE c.id = v_case AND c.org_id = v_org) THEN
    RAISE EXCEPTION 'Case not found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM public.follow_ups f WHERE f.id = v_follow AND f.org_id <> v_org) THEN
    RAISE EXCEPTION 'Follow-up not found' USING ERRCODE = 'P0002'; END IF;
  IF v_partner IS NOT NULL THEN
    SELECT p.organization, p.global_partner_id INTO v_program, v_listing
      FROM public.partners p WHERE p.id = v_partner AND p.org_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Partner not found' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  IF v_program = '' THEN
    RAISE EXCEPTION 'Name the program being asked' USING ERRCODE = '22023';
  END IF;
  IF v_due IS NULL OR v_due < CURRENT_DATE - 1 THEN
    v_due := public.next_business_day(CURRENT_DATE);
  END IF;
  v_body := 'VOB requested: ' || v_program;

  INSERT INTO public.vob_requests (id, owner_id, org_id, case_id, partner_id, global_partner_id, program_name, status, requested_by, note)
  VALUES (v_id, v_user, v_org, v_case, v_partner, v_listing, v_program, 'requested', v_user, left(coalesce(p_request ->> 'note', ''), 2000))
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 1 THEN
    INSERT INTO public.follow_ups (id, owner_id, org_id, partner_id, case_id, title, due_on, kind, waiting_on, assigned_to, status)
    VALUES (v_follow, v_user, v_org, v_partner, v_case, 'Check on VOB: ' || v_program, v_due, 'waiting_on', v_program, v_user, 'open')
    ON CONFLICT (id) DO NOTHING;
    UPDATE public.vob_requests SET follow_up_id = v_follow WHERE public.vob_requests.id = v_id;
    INSERT INTO public.case_events (id, owner_id, org_id, case_id, kind, body, occurred_at)
    VALUES (coalesce(nullif(p_request ->> 'event_id', '')::uuid, gen_random_uuid()), v_user, v_org, v_case, 'system', v_body, now())
    ON CONFLICT (id) DO NOTHING;
  END IF;

  SELECT * INTO v_row FROM public.vob_requests r WHERE r.id = v_id AND r.org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VOB request not found in this workspace' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY
  SELECT v_row.id, v_row.program_name, v_row.global_partner_id, v_row.requested_at, v_row.follow_up_id,
         (SELECT f.due_on FROM public.follow_ups f WHERE f.id = v_row.follow_up_id)::date,
         (CASE WHEN v_inserted = 1 THEN v_body ELSE '' END)::text;
END
$$;
REVOKE ALL ON FUNCTION public.request_vob(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_vob(jsonb) TO authenticated;

-- ===========================================================================
-- 5. accept_org_invite: a solo practitioner's workspace moves whole
-- ===========================================================================

-- Internal. A partner in p_from linked to a listing that p_to already tracks
-- would break partners_org_global_partner_unique on the move: repoint
-- everything that references it to the team's copy, carry over its private
-- note (appended, attributed, unless blank or already there), its touch
-- cadence (only when the team has none) and its favorite flag, then delete
-- it. Runs with constraints deferred (the repointed rows still carry p_from
-- until the move). Returns the number of partners merged.
CREATE OR REPLACE FUNCTION public.org_merge_linked_partner_copies(p_from uuid, p_to uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pair record;
  v_name text;
  v_count integer := 0;
BEGIN
  SELECT nullif(btrim(m.display_name), '') INTO v_name FROM public.org_members m
   WHERE m.org_id = p_from ORDER BY (m.role = 'owner') DESC LIMIT 1;
  v_name := coalesce(v_name, 'a teammate');
  FOR v_pair IN
    SELECT d.id AS dup_id, k.id AS keep_id
      FROM public.partners d
      JOIN public.partners k ON k.global_partner_id = d.global_partner_id AND k.org_id = p_to
     WHERE d.org_id = p_from AND d.global_partner_id IS NOT NULL
  LOOP
    UPDATE public.referrals SET partner_id = v_pair.keep_id WHERE org_id = p_from AND partner_id = v_pair.dup_id;
    UPDATE public.touches SET partner_id = v_pair.keep_id WHERE org_id = p_from AND partner_id = v_pair.dup_id;
    UPDATE public.follow_ups SET partner_id = v_pair.keep_id WHERE org_id = p_from AND partner_id = v_pair.dup_id;
    UPDATE public.match_profiles SET assigned_partner_id = v_pair.keep_id
     WHERE org_id = p_from AND assigned_partner_id = v_pair.dup_id;
    UPDATE public.placement_decisions SET chosen_partner_id = v_pair.keep_id
     WHERE org_id = p_from AND chosen_partner_id = v_pair.dup_id;
    UPDATE public.vob_requests SET partner_id = v_pair.keep_id WHERE org_id = p_from AND partner_id = v_pair.dup_id;
    UPDATE public.outreach_drafts SET partner_id = v_pair.keep_id WHERE org_id = p_from AND partner_id = v_pair.dup_id;
    DELETE FROM public.user_favorites f
     WHERE f.org_id = p_from AND f.target_type = 'partner' AND f.target_id = v_pair.dup_id
       AND EXISTS (SELECT 1 FROM public.user_favorites x
                    WHERE x.user_id = f.user_id AND x.target_type = 'partner' AND x.target_id = v_pair.keep_id);
    UPDATE public.user_favorites SET target_id = v_pair.keep_id, org_id = p_to
     WHERE org_id = p_from AND target_type = 'partner' AND target_id = v_pair.dup_id;
    UPDATE public.partners k
       SET note = CASE WHEN btrim(d.note) = '' OR position(btrim(d.note) IN k.note) > 0 THEN k.note
                       WHEN btrim(k.note) = '' THEN 'From ' || v_name || ': ' || btrim(d.note)
                       ELSE k.note || chr(10) || chr(10) || 'From ' || v_name || ': ' || btrim(d.note) END,
           touch_cadence_days = coalesce(k.touch_cadence_days, d.touch_cadence_days),
           favorite = k.favorite OR d.favorite
      FROM public.partners d
     WHERE k.id = v_pair.keep_id AND d.id = v_pair.dup_id;
    DELETE FROM public.partners WHERE id = v_pair.dup_id AND org_id = p_from;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END
$$;
REVOKE ALL ON FUNCTION public.org_merge_linked_partner_copies(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Internal. Every org-scoped row of p_from moves to p_to. Partners move
-- before favorites (the favorites trigger checks the partner's workspace).
CREATE OR REPLACE FUNCTION public.org_move_workspace_rows(p_from uuid, p_to uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.partners              SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.touches               SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.referrals             SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.match_profiles        SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.follow_ups            SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.cases                 SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.case_contacts         SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.case_events           SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.case_documents        SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.case_stage_history    SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.case_integrations     SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.case_benefits         SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.vob_requests          SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.placement_decisions   SET org_id = p_to WHERE org_id = p_from;
  -- These cascade from orgs, so without a move they would vanish with the
  -- personal workspace: favorites, the AI draft cap history, and the
  -- practitioner's own store purchases (RevenueCat maps a purchase to the
  -- buyer's current workspace anyway).
  UPDATE public.user_favorites        SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.outreach_drafts       SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.org_revenuecat_grants SET org_id = p_to WHERE org_id = p_from;
END
$$;
REVOKE ALL ON FUNCTION public.org_move_workspace_rows(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Same contract as 20260820033721. A solo owner's rows move (merging linked
-- partner copies the team already has); a member leaving a practice brings
-- nothing but their devices. Rows move BEFORE the membership changes so a
-- solo owner's self-assignments survive (the release trigger only clears
-- what is left in the old workspace). Deferred constraints are checked at
-- commit.
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

  SELECT org_id, role INTO v_old_org, v_old_role FROM public.org_members WHERE user_id = v_user;
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

  IF v_old_role = 'owner' THEN
    PERFORM public.org_merge_linked_partner_copies(v_old_org, v_invite.org_id);
    PERFORM public.org_move_workspace_rows(v_old_org, v_invite.org_id);
  END IF;

  UPDATE public.org_members SET org_id = v_invite.org_id, role = 'member' WHERE user_id = v_user;
  UPDATE public.push_tokens SET org_id = v_invite.org_id, updated_at = now() WHERE user_id = v_user;

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

-- ===========================================================================
-- 6. Established workspaces for network stats and benchmarks
-- ===========================================================================

-- A workspace counts toward cross-practice figures (and their k-anonymity
-- floors) only once it is at least 30 days old AND has at least 3 cases or
-- at least 5 referrals, all-time. See docs/OUTCOMES.md.
CREATE OR REPLACE FUNCTION public.org_is_established(p_org_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.orgs o
     WHERE o.id = p_org_id
       AND o.created_at <= now() - interval '30 days'
       AND ((SELECT count(*) FROM (SELECT 1 FROM public.cases c WHERE c.org_id = o.id LIMIT 3) AS c3) >= 3
         OR (SELECT count(*) FROM (SELECT 1 FROM public.referrals r WHERE r.org_id = o.id LIMIT 5) AS r5) >= 5)
  )
$$;
REVOKE ALL ON FUNCTION public.org_is_established(uuid) FROM PUBLIC, anon, authenticated;

-- The age rule needs a created_at no client can rewrite (the owner may
-- rename the workspace, nothing else).
CREATE OR REPLACE FUNCTION public.orgs_pin_created_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    NEW.created_at := OLD.created_at;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.orgs_pin_created_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS orgs_pin_created_at ON public.orgs;
CREATE TRIGGER orgs_pin_created_at BEFORE UPDATE ON public.orgs
  FOR EACH ROW EXECUTE FUNCTION public.orgs_pin_created_at();

-- Same measures as 20261001160000, restricted to established workspaces,
-- so importing_orgs / referring_orgs (the disclosure floors) and every
-- aggregate ignore throwaway workspaces. fetch_global_partner_stats reads
-- these columns unchanged.
DROP MATERIALIZED VIEW IF EXISTS public.global_partner_stats;

CREATE MATERIALIZED VIEW public.global_partner_stats AS
  WITH established AS (
    SELECT o.id AS org_id FROM public.orgs o WHERE public.org_is_established(o.id)
  ),
  linked AS (
    SELECT p.id AS partner_id, p.org_id, p.global_partner_id
      FROM public.partners p JOIN established e ON e.org_id = p.org_id
     WHERE p.global_partner_id IS NOT NULL
  ),
  ref AS (
    SELECT l.global_partner_id, r.org_id, r.referred_on, r.admitted, r.admitted_on, r.completed, r.family_experience
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
         (SELECT count(*) FROM ref WHERE global_partner_id = g.id AND admitted IS TRUE AND completed IS NOT NULL)::integer AS decided_placements_12m,
         (SELECT avg(CASE WHEN completed THEN 1.0 ELSE 0.0 END) FROM ref WHERE global_partner_id = g.id AND admitted IS TRUE AND completed IS NOT NULL)::numeric(5,4) AS completion_rate,
         (SELECT count(*) FROM ref WHERE global_partner_id = g.id AND admitted IS TRUE AND admitted_on IS NOT NULL AND admitted_on >= referred_on)::integer AS dated_admits_12m,
         (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY (admitted_on - referred_on)) FROM ref WHERE global_partner_id = g.id AND admitted IS TRUE AND admitted_on IS NOT NULL AND admitted_on >= referred_on)::numeric(6,1) AS median_days_to_admit,
         (SELECT max(referred_on) FROM ref WHERE global_partner_id = g.id) AS last_referral_on,
         now() AS refreshed_at
    FROM public.global_partners g
  WITH NO DATA;

CREATE UNIQUE INDEX global_partner_stats_pkey ON public.global_partner_stats (global_partner_id);
REVOKE ALL ON public.global_partner_stats FROM PUBLIC, anon, authenticated;

REFRESH MATERIALIZED VIEW public.global_partner_stats;

-- Internal. The benchmark cohort: workspaces with an active, paid
-- benchmarks entitlement that are established.
CREATE OR REPLACE FUNCTION public.benchmark_cohort_orgs()
RETURNS TABLE (org_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT x.org_id
    FROM (
      SELECT e.org_id FROM public.org_entitlements e
       WHERE e.entitlement = 'benchmarks' AND e.active AND (e.expires_at IS NULL OR e.expires_at > now())
      UNION
      SELECT g.org_id FROM public.org_revenuecat_grants g
       WHERE g.entitlement = 'benchmarks' AND g.active AND g.environment = 'PRODUCTION'
         AND (g.expires_at IS NULL OR g.expires_at > now())
    ) AS x
   WHERE public.org_is_established(x.org_id)
$$;
REVOKE ALL ON FUNCTION public.benchmark_cohort_orgs() FROM PUBLIC, anon, authenticated;

-- Internal. The caller-side half of fetch_benchmarks, unchanged.
CREATE OR REPLACE FUNCTION public.benchmark_workspace_values(p_org uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'outbound_referrals', (SELECT count(*) FROM public.referrals WHERE org_id=p_org AND direction='outbound'),
    'admit_rate', (SELECT round(avg(CASE WHEN admitted THEN 1.0 ELSE 0.0 END)::numeric,3) FROM public.referrals WHERE org_id=p_org AND direction='outbound' AND admitted IS NOT NULL),
    'family_experience', (SELECT round(avg(family_experience)::numeric,2) FROM public.referrals WHERE org_id=p_org AND direction='outbound'),
    'cases_total', (SELECT count(*) FROM public.cases WHERE org_id=p_org),
    'placement_rate', (SELECT CASE WHEN count(*) FILTER (WHERE status IN ('placed','aftercare','lost')) > 0 THEN round((count(*) FILTER (WHERE status IN ('placed','aftercare')))::numeric / (count(*) FILTER (WHERE status IN ('placed','aftercare','lost'))),3) END FROM public.cases WHERE org_id=p_org),
    'median_quote', (SELECT round((percentile_cont(0.5) WITHIN GROUP (ORDER BY quoted_amount))::numeric) FROM public.cases WHERE org_id=p_org AND quoted_amount > 0)
  )
$$;
REVOKE ALL ON FUNCTION public.benchmark_workspace_values(uuid) FROM PUBLIC, anon, authenticated;

-- Same output as 20260820033721; the cohort is now benchmark_cohort_orgs()
-- (paid AND established), still excluding the caller's own workspace.
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
    SELECT c.org_id FROM public.benchmark_cohort_orgs() c WHERE c.org_id <> v_org
  ), referral_stats AS (
    SELECT r.org_id, count(*) FILTER (WHERE admitted IS NOT NULL) AS decided,
           avg(CASE WHEN admitted THEN 1.0 ELSE 0.0 END) FILTER (WHERE admitted IS NOT NULL) AS admit_rate,
           count(family_experience) AS rated, avg(family_experience)::numeric AS family_experience
      FROM public.referrals r JOIN eligible_orgs e ON e.org_id = r.org_id
     WHERE direction = 'outbound' GROUP BY r.org_id
  ), case_stats AS (
    SELECT c.org_id, count(*) FILTER (WHERE status IN ('placed','aftercare')) AS placed,
           count(*) FILTER (WHERE status = 'lost') AS lost,
           count(quoted_amount) FILTER (WHERE quoted_amount > 0) AS quoted,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY quoted_amount) FILTER (WHERE quoted_amount > 0) AS median_quote
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

  v_workspace := public.benchmark_workspace_values(v_org);
  RETURN jsonb_build_object('network',v_network,'workspace',v_workspace);
END
$$;
REVOKE ALL ON FUNCTION public.fetch_benchmarks() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fetch_benchmarks() TO authenticated;

-- ===========================================================================
-- 7. Push outbox: a transient failure stays retryable
-- ===========================================================================

-- The last failure reason of a row that is still being retried (error
-- stays NULL so push_outbox_claim picks it up again after five minutes,
-- up to five attempts).
ALTER TABLE public.notification_outbox ADD COLUMN IF NOT EXISTS last_error text;

-- p_results: array of {id, tickets: [{token, id}], error, retry}. retry =
-- true (sent by push-dispatch for network errors, Expo 5xx / 429 and rate
-- limits) keeps the row queued; anything else without a ticket is final.
CREATE OR REPLACE FUNCTION public.push_outbox_record(p_results jsonb, p_dead_tokens text[] DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item jsonb;
  v_sent boolean;
  v_retry boolean;
  v_reason text;
  v_count integer := 0;
BEGIN
  FOR v_item IN SELECT value FROM jsonb_array_elements(coalesce(p_results, '[]')) LOOP
    v_sent := jsonb_array_length(coalesce(v_item -> 'tickets', '[]')) > 0;
    v_retry := NOT v_sent AND coalesce(v_item -> 'retry' = 'true'::jsonb, false);
    v_reason := nullif(left(coalesce(v_item ->> 'error', ''), 200), '');
    UPDATE public.notification_outbox o
       SET sent_at = CASE WHEN v_sent THEN now() ELSE o.sent_at END,
           tickets = coalesce(v_item -> 'tickets', '[]'),
           error = CASE WHEN v_sent OR v_retry THEN NULL ELSE coalesce(v_reason, 'send_failed') END,
           last_error = CASE WHEN v_sent THEN NULL ELSE v_reason END
     WHERE o.id = (v_item ->> 'id')::uuid;
    v_count := v_count + 1;
  END LOOP;
  IF p_dead_tokens IS NOT NULL THEN
    DELETE FROM public.push_tokens WHERE expo_push_token = ANY (p_dead_tokens);
  END IF;
  RETURN v_count;
END
$$;
REVOKE ALL ON FUNCTION public.push_outbox_record(jsonb, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.push_outbox_record(jsonb, text[]) TO service_role;

-- ===========================================================================
-- 8. Offline replay safety for the workflow RPCs
-- ===========================================================================

-- Same as 20260819120000 except: the completed row only takes the
-- completion fields (status, completed_at, snoozed_until), and the next
-- step is inserted once; a replay never re-opens or rewrites it.
CREATE OR REPLACE FUNCTION public.complete_follow_up_with_next(p_completed jsonb, p_next jsonb, p_event jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_org_id uuid := public.current_org_id();
  v_updated integer;
BEGIN
  IF v_owner_id IS NULL OR v_org_id IS NULL THEN RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000'; END IF;

  UPDATE public.follow_ups
     SET status = p_completed ->> 'status',
         completed_at = nullif(p_completed ->> 'completed_at', '')::timestamptz,
         snoozed_until = nullif(p_completed ->> 'snoozed_until', '')::date
   WHERE id = (p_completed ->> 'id')::uuid AND org_id = v_org_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN RAISE EXCEPTION 'Follow-up not found for the authenticated owner' USING ERRCODE = 'P0002'; END IF;

  INSERT INTO public.follow_ups (
    id, owner_id, partner_id, referral_id, case_id, title, due_on, status,
    completed_at, note, kind, due_time, waiting_on, snoozed_until
  ) VALUES (
    (p_next ->> 'id')::uuid, v_owner_id,
    nullif(p_next ->> 'partner_id', '')::uuid,
    nullif(p_next ->> 'referral_id', '')::uuid,
    nullif(p_next ->> 'case_id', '')::uuid,
    p_next ->> 'title', (p_next ->> 'due_on')::date,
    coalesce(p_next ->> 'status', 'open'),
    nullif(p_next ->> 'completed_at', '')::timestamptz,
    coalesce(p_next ->> 'note', ''), coalesce(p_next ->> 'kind', 'follow_up'),
    nullif(p_next ->> 'due_time', '')::time,
    coalesce(p_next ->> 'waiting_on', ''),
    nullif(p_next ->> 'snoozed_until', '')::date
  )
  ON CONFLICT (id) DO NOTHING;

  IF p_event IS NOT NULL THEN
    INSERT INTO public.case_events (id, owner_id, case_id, kind, body, occurred_at)
    VALUES (
      (p_event ->> 'id')::uuid, v_owner_id,
      (p_event ->> 'case_id')::uuid,
      p_event ->> 'kind', coalesce(p_event ->> 'body', ''),
      coalesce(nullif(p_event ->> 'occurred_at', '')::timestamptz, pg_catalog.now())
    )
    ON CONFLICT (id) DO UPDATE SET
      case_id = EXCLUDED.case_id, kind = EXCLUDED.kind,
      body = EXCLUDED.body, occurred_at = EXCLUDED.occurred_at
    WHERE public.case_events.org_id = v_org_id;
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.complete_follow_up_with_next(jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_follow_up_with_next(jsonb, jsonb, jsonb) TO authenticated;

-- Shared by assign_match_referral and finalize_match_packet: update the
-- caller's match (only the keys sent) or create it, carrying the matching
-- integrity columns (must_have_therapies, population, location_preference)
-- that 20261001130000 added. Runs as the caller under RLS.
CREATE OR REPLACE FUNCTION public.upsert_match_profile_from_json(p_match jsonb, p_default_status text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_org_id uuid := public.current_org_id();
  v_must text[];
BEGIN
  IF v_owner_id IS NULL OR v_org_id IS NULL THEN RAISE EXCEPTION 'Workspace membership required' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p_match->'must_have_therapies') = 'array' THEN
    v_must := ARRAY(SELECT jsonb_array_elements_text(p_match->'must_have_therapies'));
  END IF;
  IF EXISTS (SELECT 1 FROM public.match_profiles WHERE id=(p_match->>'id')::uuid AND org_id=v_org_id) THEN
    UPDATE public.match_profiles SET
      client_label=coalesce(p_match->>'client_label',client_label),
      level_of_care=coalesce(p_match->>'level_of_care',level_of_care),
      state=coalesce(p_match->>'state',state),
      insurance=coalesce(p_match->>'insurance',insurance),
      status=coalesce(p_match->>'status',status),
      assigned_partner_id=coalesce(nullif(p_match->>'assigned_partner_id','')::uuid,assigned_partner_id),
      case_id=coalesce(nullif(p_match->>'case_id','')::uuid,case_id),
      must_have_therapies=CASE WHEN v_must IS NOT NULL THEN v_must ELSE must_have_therapies END,
      population=coalesce(nullif(p_match->>'population',''),population),
      location_preference=coalesce(nullif(p_match->>'location_preference',''),location_preference),
      updated_at=now()
    WHERE id=(p_match->>'id')::uuid AND org_id=v_org_id;
  ELSE
    INSERT INTO public.match_profiles (id,owner_id,client_label,level_of_care,state,insurance,network_preferences,max_budget,therapies,status,assigned_partner_id,referral_id,case_id,must_have_therapies,population,location_preference)
    VALUES ((p_match->>'id')::uuid,v_owner_id,p_match->>'client_label',p_match->>'level_of_care',p_match->>'state',p_match->>'insurance',
      coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p_match->'network_preferences','[]'::jsonb))),ARRAY[]::text[]),
      nullif(p_match->>'max_budget','')::integer,
      coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p_match->'therapies','[]'::jsonb))),ARRAY[]::text[]),
      coalesce(p_match->>'status',p_default_status),nullif(p_match->>'assigned_partner_id','')::uuid,NULL,nullif(p_match->>'case_id','')::uuid,
      v_must,coalesce(nullif(p_match->>'population',''),'Any'),coalesce(nullif(p_match->>'location_preference',''),'No preference'));
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.upsert_match_profile_from_json(jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_match_profile_from_json(jsonb, text) TO authenticated;

-- Same as 20260819120000 except: the match goes through
-- upsert_match_profile_from_json, and a replay of an existing referral
-- never overwrites its recorded outcome (outcome, admitted, admitted_on,
-- family_experience, outcome_note, completed, completed_on, still_enrolled,
-- last_check_in_at) or clears a packet_sent_at.
CREATE OR REPLACE FUNCTION public.assign_match_referral(p_expected_owner_id uuid, p_referral jsonb, p_match jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_org_id uuid := public.current_org_id();
  v_updated integer;
BEGIN
  IF v_owner_id IS NULL OR v_owner_id<>p_expected_owner_id THEN RAISE EXCEPTION 'Authenticated account changed' USING ERRCODE='42501'; END IF;
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'Workspace membership required' USING ERRCODE='42501'; END IF;
  PERFORM public.upsert_match_profile_from_json(p_match, 'Matching');
  INSERT INTO public.referrals (id,owner_id,partner_id,direction,referred_on,client_label,outcome,note,packet_sent_at,match_profile_id,case_id,admitted,admitted_on,family_experience,outcome_note)
  VALUES ((p_referral->>'id')::uuid,v_owner_id,(p_referral->>'partner_id')::uuid,p_referral->>'direction',(p_referral->>'referred_on')::date,p_referral->>'client_label',p_referral->>'outcome',coalesce(p_referral->>'note',''),nullif(p_referral->>'packet_sent_at','')::timestamptz,nullif(p_referral->>'match_profile_id','')::uuid,nullif(p_referral->>'case_id','')::uuid,nullif(p_referral->>'admitted','')::boolean,nullif(p_referral->>'admitted_on','')::date,nullif(p_referral->>'family_experience','')::smallint,coalesce(p_referral->>'outcome_note',''))
  ON CONFLICT (id) DO UPDATE SET partner_id=EXCLUDED.partner_id,direction=EXCLUDED.direction,referred_on=EXCLUDED.referred_on,client_label=EXCLUDED.client_label,note=EXCLUDED.note,packet_sent_at=coalesce(EXCLUDED.packet_sent_at,referrals.packet_sent_at),match_profile_id=EXCLUDED.match_profile_id,case_id=EXCLUDED.case_id WHERE referrals.org_id=v_org_id;
  UPDATE public.match_profiles SET client_label=p_match->>'client_label',status=p_match->>'status',assigned_partner_id=nullif(p_match->>'assigned_partner_id','')::uuid,referral_id=(p_referral->>'id')::uuid,case_id=nullif(p_match->>'case_id','')::uuid,updated_at=now() WHERE id=(p_match->>'id')::uuid AND org_id=v_org_id;
  GET DIAGNOSTICS v_updated=ROW_COUNT; IF v_updated<>1 THEN RAISE EXCEPTION 'Owned match was not found'; END IF;
  IF nullif(p_match->>'case_id','') IS NOT NULL THEN
    UPDATE public.cases SET match_profile_id=(p_match->>'id')::uuid WHERE id=(p_match->>'case_id')::uuid AND org_id=v_org_id;
    GET DIAGNOSTICS v_updated=ROW_COUNT; IF v_updated<>1 THEN RAISE EXCEPTION 'Owned case was not found'; END IF;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.assign_match_referral(uuid, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_match_referral(uuid, jsonb, jsonb) TO authenticated;

-- 20260819120000, with the match via upsert_match_profile_from_json.
CREATE OR REPLACE FUNCTION public.finalize_match_packet(p_expected_owner_id uuid,p_referral jsonb,p_match jsonb,p_touch jsonb,p_follow_up jsonb,p_event jsonb DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_org_id uuid := public.current_org_id();
  v_updated integer;
BEGIN
  IF v_owner_id IS NULL OR v_owner_id<>p_expected_owner_id THEN RAISE EXCEPTION 'Authenticated account changed' USING ERRCODE='42501'; END IF;
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'Workspace membership required' USING ERRCODE='42501'; END IF;
  IF p_match IS NOT NULL AND p_match<>'null'::jsonb THEN
    PERFORM public.upsert_match_profile_from_json(p_match, 'Referred');
  END IF;
  INSERT INTO public.referrals (id,owner_id,partner_id,direction,referred_on,client_label,outcome,note,packet_sent_at,match_profile_id,case_id,admitted,admitted_on,family_experience,outcome_note)
  VALUES ((p_referral->>'id')::uuid,v_owner_id,(p_referral->>'partner_id')::uuid,p_referral->>'direction',(p_referral->>'referred_on')::date,p_referral->>'client_label',p_referral->>'outcome',coalesce(p_referral->>'note',''),nullif(p_referral->>'packet_sent_at','')::timestamptz,nullif(p_referral->>'match_profile_id','')::uuid,nullif(p_referral->>'case_id','')::uuid,nullif(p_referral->>'admitted','')::boolean,nullif(p_referral->>'admitted_on','')::date,nullif(p_referral->>'family_experience','')::smallint,coalesce(p_referral->>'outcome_note',''))
  ON CONFLICT (id) DO UPDATE SET packet_sent_at=EXCLUDED.packet_sent_at,match_profile_id=EXCLUDED.match_profile_id,case_id=EXCLUDED.case_id WHERE referrals.org_id=v_org_id;
  IF p_match IS NOT NULL AND p_match<>'null'::jsonb THEN
    UPDATE public.match_profiles SET status=p_match->>'status',assigned_partner_id=nullif(p_match->>'assigned_partner_id','')::uuid,referral_id=(p_referral->>'id')::uuid,updated_at=now() WHERE id=(p_match->>'id')::uuid AND org_id=v_org_id;
    GET DIAGNOSTICS v_updated=ROW_COUNT; IF v_updated<>1 THEN RAISE EXCEPTION 'Owned match was not found'; END IF;
  END IF;
  INSERT INTO public.touches (id,owner_id,partner_id,kind,note,occurred_at) VALUES ((p_touch->>'id')::uuid,v_owner_id,(p_touch->>'partner_id')::uuid,p_touch->>'kind',coalesce(p_touch->>'note',''),(p_touch->>'occurred_at')::timestamptz) ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.follow_ups (id,owner_id,partner_id,referral_id,case_id,title,due_on,status,completed_at,note,kind,due_time,waiting_on,snoozed_until)
  VALUES ((p_follow_up->>'id')::uuid,v_owner_id,nullif(p_follow_up->>'partner_id','')::uuid,(p_referral->>'id')::uuid,nullif(p_follow_up->>'case_id','')::uuid,p_follow_up->>'title',(p_follow_up->>'due_on')::date,coalesce(p_follow_up->>'status','open'),nullif(p_follow_up->>'completed_at','')::timestamptz,coalesce(p_follow_up->>'note',''),coalesce(p_follow_up->>'kind','follow_up'),nullif(p_follow_up->>'due_time','')::time,coalesce(p_follow_up->>'waiting_on',''),nullif(p_follow_up->>'snoozed_until','')::date) ON CONFLICT (id) DO NOTHING;
  IF p_event IS NOT NULL AND p_event<>'null'::jsonb THEN
    INSERT INTO public.case_events (id,owner_id,case_id,kind,body,contact_id,referral_id,document_id,occurred_at) VALUES ((p_event->>'id')::uuid,v_owner_id,(p_event->>'case_id')::uuid,p_event->>'kind',p_event->>'body',nullif(p_event->>'contact_id','')::uuid,(p_referral->>'id')::uuid,nullif(p_event->>'document_id','')::uuid,coalesce(nullif(p_event->>'occurred_at','')::timestamptz,now())) ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.finalize_match_packet(uuid, jsonb, jsonb, jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalize_match_packet(uuid, jsonb, jsonb, jsonb, jsonb, jsonb) TO authenticated;

-- ===========================================================================
-- 9. Placement check-ins: one day of slack for the server's UTC date
-- ===========================================================================

-- Same as 20261001160000 except a check-in is skipped only when it fell due
-- before yesterday (UTC). CURRENT_DATE is already tomorrow during a US
-- evening, which used to drop a check-in due that day. Worst case elsewhere
-- is a check-in that shows one day overdue.
CREATE OR REPLACE FUNCTION public.schedule_placement_check_ins(p_referral_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid := public.current_org_id();
  v_ref record;
  v_assignee uuid;
  v_label text;
  v_days integer;
  v_due date;
  v_created integer := 0;
  v_inserted integer;
BEGIN
  IF v_user IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;

  SELECT r.id, r.partner_id, r.case_id, r.owner_id, r.client_label, r.admitted, r.admitted_on,
         c.assigned_to AS case_assignee
    INTO v_ref
    FROM public.referrals r
    LEFT JOIN public.cases c ON c.id = r.case_id
   WHERE r.id = p_referral_id AND r.org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referral not found in this workspace' USING ERRCODE = 'P0002';
  END IF;
  IF v_ref.admitted IS NOT TRUE OR v_ref.admitted_on IS NULL THEN
    RETURN 0;
  END IF;

  v_assignee := v_ref.case_assignee;
  IF v_assignee IS NULL AND EXISTS (
    SELECT 1 FROM public.org_members m WHERE m.user_id = v_ref.owner_id AND m.org_id = v_org
  ) THEN
    v_assignee := v_ref.owner_id;
  END IF;
  v_label := coalesce(nullif(v_ref.client_label, ''), 'the family');

  FOREACH v_days IN ARRAY ARRAY[7, 30, 90] LOOP
    v_due := v_ref.admitted_on + v_days;
    IF v_due < CURRENT_DATE - 1 THEN
      CONTINUE;
    END IF;
    INSERT INTO public.follow_ups (owner_id, org_id, partner_id, referral_id, case_id, title, due_on, kind, check_in_days, assigned_to)
    VALUES (v_user, v_org, v_ref.partner_id, v_ref.id, v_ref.case_id,
            v_days::text || '-day check-in: ' || v_label, v_due, 'check_in', v_days, v_assignee)
    ON CONFLICT (referral_id, check_in_days) WHERE kind = 'check_in' DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    v_created := v_created + v_inserted;
  END LOOP;

  RETURN v_created;
END
$$;
REVOKE ALL ON FUNCTION public.schedule_placement_check_ins(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.schedule_placement_check_ins(uuid) TO authenticated;

COMMIT;
