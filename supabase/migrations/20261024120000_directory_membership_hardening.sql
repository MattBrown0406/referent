-- ReferralFit - directory and membership hardening (reviewer findings, 2026-10-24).
--
--   0. A directory review queue (directory_review_requests) for what a
--      platform admin must decide: claimant identity edits that collide
--      with another listing, profiles that collide with another
--      workspace's listing, and profiles left unowned by a team join.
--   1. Directory profiles never take over an existing listing on their own.
--      upsert_org_directory_profile used to hand an unclaimed duplicate to
--      the caller when the caller's workspace had suggested it, the caller
--      had created it, or the caller's (unconfirmed) sign-in email domain
--      matched its website. None of those prove the caller IS that program.
--      A duplicate becomes a claim request for an admin, or (when another
--      workspace owns it) a pending profile plus a profile_conflict review;
--      the listing is not touched. A brand-new profile is still created live.
--   2. suggest_global_listing links a private partner only to an UNCLAIMED
--      listing with the same phone or domain AND a matching name (exact
--      first; a prefix match also needs the same state / city). Claimant
--      identity edits that collide with another listing are held.
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
--      (public.org_is_established: 60+ days old, 3+ cases or 5+ referrals,
--      activity on 10+ distinct days), so throwaway workspaces cannot
--      satisfy the k-anonymity floor or skew the aggregates.
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
-- 0. Directory review queue: a platform admin decides, nothing changes first
-- ===========================================================================

-- kind:
--   identity_edit     a claimant (owner workspace or center) changed the
--                     organization, name, phone or website to values that
--                     another listing already uses. The listing keeps its
--                     live values; proposed holds the change.
--   profile_conflict  a workspace's first profile collides with a listing
--                     another workspace owns. The new profile exists
--                     (global_partner_id), owned but pending (hidden);
--                     related_listing_id is the other listing.
--   orphaned_profile  a solo workspace joined a practice that already owns
--                     a profile. The joiner's listing stays live, unowned,
--                     until the admin keeps or archives it.
--   resubmitted_profile  the owner saved its archived profile; it is
--                     pending (hidden) again until the admin decides.
CREATE TABLE public.directory_review_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text NOT NULL CHECK (kind IN ('identity_edit', 'profile_conflict', 'orphaned_profile', 'resubmitted_profile')),
  global_partner_id  uuid NOT NULL REFERENCES public.global_partners(id) ON DELETE CASCADE,
  related_listing_id uuid REFERENCES public.global_partners(id) ON DELETE SET NULL,
  org_id             uuid REFERENCES public.orgs(id) ON DELETE SET NULL,
  requested_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  proposed           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(proposed) = 'object'),
  collisions         text[] NOT NULL DEFAULT '{}',
  note               text NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz,
  resolved_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX directory_review_requests_one_pending
  ON public.directory_review_requests (kind, global_partner_id) WHERE status = 'pending';
CREATE INDEX directory_review_requests_org_idx ON public.directory_review_requests (org_id, status);

ALTER TABLE public.directory_review_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.directory_review_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.directory_review_requests TO authenticated;
CREATE POLICY "directory_review_requests: requester or admin read" ON public.directory_review_requests
  FOR SELECT USING (
    org_id = (SELECT public.current_org_id())
    OR requested_by = (SELECT auth.uid())
    OR (SELECT public.is_platform_admin())
  );

-- Pending requests for the reviewer (platform admin, or the SQL editor).
CREATE OR REPLACE FUNCTION public.list_directory_review_requests()
RETURNS TABLE (id uuid, kind text, global_partner_id uuid, listing text, related_listing_id uuid, related_listing text,
               org_id uuid, practice text, requested_by uuid, proposed jsonb, collisions text[], note text, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform admin required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT r.id, r.kind, r.global_partner_id, coalesce(nullif(g.organization, ''), g.name),
         r.related_listing_id, coalesce(nullif(x.organization, ''), x.name),
         r.org_id, o.name, r.requested_by, r.proposed, r.collisions, r.note, r.created_at
    FROM public.directory_review_requests r
    JOIN public.global_partners g ON g.id = r.global_partner_id
    LEFT JOIN public.global_partners x ON x.id = r.related_listing_id
    LEFT JOIN public.orgs o ON o.id = r.org_id
   WHERE r.status = 'pending'
   ORDER BY r.created_at, r.id;
END
$$;
REVOKE ALL ON FUNCTION public.list_directory_review_requests() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_directory_review_requests() TO authenticated;

-- Approve or decline. identity_edit: approve applies the proposed values.
-- profile_conflict / resubmitted_profile: approve makes the profile live and
-- verified, decline archives it. orphaned_profile: approve keeps the
-- listing live and unowned, decline archives it. Returns 'approved' or
-- 'rejected'. A listing merged into another (merged_into) is never made
-- live again: such a profile_conflict or resubmitted_profile can only be
-- declined. The listing is locked before the request, the order a
-- claimant's save uses, so the two cannot deadlock.
CREATE OR REPLACE FUNCTION public.resolve_directory_review_request(p_request_id uuid, p_approve boolean)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.directory_review_requests%ROWTYPE;
  v_merged uuid;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform admin required' USING ERRCODE = '42501';
  END IF;
  IF p_approve IS NULL THEN
    RAISE EXCEPTION 'Choose approve or decline' USING ERRCODE = '22023';
  END IF;
  SELECT g.merged_into INTO v_merged FROM public.global_partners g
   WHERE g.id = (SELECT r.global_partner_id FROM public.directory_review_requests r WHERE r.id = p_request_id)
   FOR UPDATE;
  SELECT * INTO v_req FROM public.directory_review_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Review request not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'Review request was already %', v_req.status USING ERRCODE = '22023';
  END IF;
  IF p_approve AND v_merged IS NOT NULL AND v_req.kind IN ('profile_conflict', 'resubmitted_profile') THEN
    RAISE EXCEPTION 'This listing was merged into another; decline the request instead' USING ERRCODE = '22023';
  END IF;

  IF v_req.kind = 'identity_edit' AND p_approve THEN
    UPDATE public.global_partners g
       SET organization = coalesce(v_req.proposed ->> 'organization', g.organization),
           name = coalesce(v_req.proposed ->> 'name', g.name),
           phone = coalesce(v_req.proposed ->> 'phone', g.phone),
           website = CASE WHEN v_req.proposed ? 'website' THEN v_req.proposed ->> 'website' ELSE g.website END
     WHERE g.id = v_req.global_partner_id;
  ELSIF v_req.kind IN ('profile_conflict', 'resubmitted_profile') THEN
    UPDATE public.global_partners
       SET status = CASE WHEN p_approve THEN 'active' ELSE 'archived' END,
           verified_at = CASE WHEN p_approve THEN now() ELSE NULL END
     WHERE id = v_req.global_partner_id;
  ELSIF v_req.kind = 'orphaned_profile' AND NOT p_approve THEN
    UPDATE public.global_partners SET status = 'archived' WHERE id = v_req.global_partner_id;
  END IF;

  UPDATE public.directory_review_requests
     SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
         resolved_at = now(), resolved_by = auth.uid()
   WHERE id = v_req.id;
  RETURN CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END;
END
$$;
REVOKE ALL ON FUNCTION public.resolve_directory_review_request(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_directory_review_request(uuid, boolean) TO authenticated;

-- Same as 20260928170000, except that a listing merged into another
-- (merged_into) is never claimed back to live: reject the claim instead.
CREATE OR REPLACE FUNCTION public.approve_center_claim_request(p_request_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.center_claim_requests%ROWTYPE;
  v_owner uuid;
  v_merged uuid;
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
  SELECT owner_org_id, merged_into INTO v_owner, v_merged FROM public.global_partners WHERE id = v_req.global_partner_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Directory listing not found' USING ERRCODE = 'P0002'; END IF;
  IF v_merged IS NOT NULL THEN
    RAISE EXCEPTION 'This listing was merged into another; reject the claim instead' USING ERRCODE = '22023';
  END IF;
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
-- listing owned by p_org when p_listing is NULL (live and verified when
-- p_live, otherwise pending for review). Returns the id.
CREATE OR REPLACE FUNCTION public.org_directory_profile_save(p_listing uuid, p_row public.global_partners, p_org uuid, p_user uuid, p_live boolean)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid := p_listing;
  v_prev_pub text := coalesce(current_setting('referralfit.seed_publish', true), '');
BEGIN
  IF v_id IS NOT NULL THEN
    -- Not flagged as a seed publish: the claimant guards (verification and
    -- the identity-collision hold) apply to the owner's own edits.
    UPDATE public.global_partners
       SET name = p_row.name, organization = p_row.organization, types = p_row.types, city = p_row.city,
           state = p_row.state, regions = p_row.regions, phone = p_row.phone, email = p_row.email,
           website = p_row.website, monthly_cost = p_row.monthly_cost, insurance = p_row.insurance,
           insurance_networks = p_row.insurance_networks, therapies = p_row.therapies,
           populations = p_row.populations, levels = p_row.levels, description = p_row.description,
           verified_at = now()
     WHERE id = v_id;
  ELSE
    PERFORM set_config('referralfit.seed_publish', 'on', true);
    INSERT INTO public.global_partners (
      name, organization, types, city, state, regions, phone, email, website, monthly_cost,
      insurance, insurance_networks, therapies, populations, levels, description,
      status, verified_at, created_by, owner_org_id
    ) VALUES (
      p_row.name, p_row.organization, p_row.types, p_row.city, p_row.state, p_row.regions, p_row.phone,
      p_row.email, p_row.website, p_row.monthly_cost, p_row.insurance, p_row.insurance_networks,
      p_row.therapies, p_row.populations, p_row.levels, p_row.description,
      CASE WHEN p_live THEN 'active' ELSE 'pending' END, CASE WHEN p_live THEN now() END, p_user, p_org
    ) RETURNING id INTO v_id;
    PERFORM set_config('referralfit.seed_publish', v_prev_pub, true);
  END IF;
  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION public.org_directory_profile_save(uuid, public.global_partners, uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;

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

-- Internal. The caller's first profile collides with p_match: on phone or
-- website with a listing another workspace owns (p_reason 'contact'; a
-- claim could never be approved), or on name with any listing (p_reason
-- 'name'). The profile is created owned but pending (hidden) and a
-- profile_conflict review request is filed.
CREATE OR REPLACE FUNCTION public.org_directory_profile_conflict(p_match public.global_partners, p_row public.global_partners, p_org uuid, p_user uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new uuid := public.org_directory_profile_save(NULL, p_row, p_org, p_user, false);
  v_other text := CASE WHEN p_match.status = 'active'
                       THEN '"' || coalesce(nullif(p_match.organization, ''), p_match.name) || '"' ELSE 'a listing' END;
  v_review uuid;
BEGIN
  INSERT INTO public.directory_review_requests (kind, global_partner_id, related_listing_id, org_id, requested_by, note)
  VALUES ('profile_conflict', v_new, p_match.id, p_org, p_user,
          left(CASE WHEN p_reason = 'name'
                    THEN format('%s has the same name as %s', p_row.organization, v_other)
                    ELSE format('%s shares a phone number or website with %s, which another workspace manages', p_row.organization, v_other) END, 2000))
  RETURNING id INTO v_review;
  RETURN jsonb_build_object('status', 'conflict', 'listing_id', v_new, 'review_id', v_review,
    'message', CASE WHEN p_reason = 'name'
      THEN 'Another directory listing already uses this name. Your profile is saved and ReferralFit will review it before it appears in the directory.'
      ELSE 'Another practice already manages a directory listing with this phone number or website. Your profile is saved and ReferralFit will review it before it appears in the directory.' END);
END
$$;
REVOKE ALL ON FUNCTION public.org_directory_profile_conflict(public.global_partners, public.global_partners, uuid, uuid, text) FROM PUBLIC, anon, authenticated;


-- Internal. The owner saved a profile an admin had archived: it goes back
-- to pending (hidden) with a resubmitted_profile review request that names
-- what it still collides with, if anything (same phone, website or name as
-- another non-archived listing). A listing an admin merged into another
-- (merged_into) is never resubmitted.
CREATE OR REPLACE FUNCTION public.org_directory_profile_resubmit(p_listing uuid, p_org uuid, p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev_pub text := coalesce(current_setting('referralfit.seed_publish', true), '');
  g public.global_partners%ROWTYPE;
  v_related uuid;
  v_on text;
  v_review uuid;
BEGIN
  SELECT * INTO g FROM public.global_partners WHERE id = p_listing;
  IF g.merged_into IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'merged', 'listing_id', p_listing, 'merged_into', g.merged_into,
      'message', 'ReferralFit merged this profile into another directory listing, so it cannot be sent for review again. Contact ReferralFit to manage the combined listing.');
  END IF;
  v_related := public.directory_identity_collision(p_listing, 'phone', g.phone_digits);
  v_on := CASE WHEN v_related IS NOT NULL THEN 'phone' END;
  IF v_related IS NULL THEN
    v_related := public.directory_identity_collision(p_listing, 'website', g.website_domain);
    v_on := CASE WHEN v_related IS NOT NULL THEN 'website' END;
  END IF;
  IF v_related IS NULL THEN
    v_related := public.directory_identity_collision(p_listing, 'name',
      public.directory_name_key(coalesce(nullif(btrim(g.organization), ''), g.name)));
    v_on := CASE WHEN v_related IS NOT NULL THEN 'name' END;
  END IF;

  -- The verification guard pins status for non-admin writers; this is the
  -- sanctioned definer path, like the seed publish.
  PERFORM set_config('referralfit.seed_publish', 'on', true);
  UPDATE public.global_partners SET status = 'pending', verified_at = NULL WHERE id = p_listing;
  PERFORM set_config('referralfit.seed_publish', v_prev_pub, true);
  INSERT INTO public.directory_review_requests (kind, global_partner_id, related_listing_id, org_id, requested_by, collisions, note)
  VALUES ('resubmitted_profile', p_listing, v_related, p_org, p_user, CASE WHEN v_on IS NULL THEN '{}'::text[] ELSE ARRAY[v_on] END,
          'The owner saved this profile after it was archived; it is hidden until reviewed. '
          || CASE WHEN v_on IS NULL THEN 'It matches no other listing now.'
                  ELSE 'It still matches another listing on: ' || v_on || '.' END)
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_review;
  RETURN jsonb_build_object('status', 'resubmitted_for_review', 'listing_id', p_listing, 'review_id', v_review,
    'message', 'Your profile was not approved for the directory earlier. It is saved and sent to ReferralFit for review again, and it stays hidden until then.');
END
$$;
REVOKE ALL ON FUNCTION public.org_directory_profile_resubmit(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Internal. The answer after the owner updated their own profile: conflict,
-- resubmitted_for_review or updated_pending_review while a review request
-- is open, else updated.
CREATE OR REPLACE FUNCTION public.org_directory_profile_update_result(p_listing uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_review public.directory_review_requests%ROWTYPE;
  v_fields text[];
  v_text text;
BEGIN
  SELECT * INTO v_review FROM public.directory_review_requests
   WHERE global_partner_id = p_listing AND status = 'pending'
     AND kind IN ('identity_edit', 'profile_conflict', 'resubmitted_profile')
   ORDER BY (kind <> 'identity_edit') DESC LIMIT 1;
  IF v_review.kind IN ('profile_conflict', 'resubmitted_profile') THEN
    RETURN jsonb_build_object('status', CASE WHEN v_review.kind = 'profile_conflict' THEN 'conflict' ELSE 'resubmitted_for_review' END,
      'listing_id', p_listing, 'review_id', v_review.id,
      'message', 'Your profile is saved and waits for ReferralFit to review it before it appears in the directory.');
  ELSIF v_review.kind = 'identity_edit' THEN
    v_fields := ARRAY(SELECT CASE c WHEN 'phone' THEN 'phone number' ELSE c END
                        FROM unnest(v_review.collisions) WITH ORDINALITY AS t(c, n) ORDER BY n);
    v_text := CASE WHEN cardinality(v_fields) <= 1 THEN coalesce(v_fields[1], 'details')
                   ELSE array_to_string(v_fields[1:cardinality(v_fields) - 1], ', ') || ' and ' || v_fields[cardinality(v_fields)] END;
    RETURN jsonb_build_object('status', 'updated_pending_review', 'listing_id', p_listing, 'review_id', v_review.id,
      'held_fields', to_jsonb(v_review.collisions),
      'message', 'Your other changes are live. The new ' || v_text
                 || CASE WHEN cardinality(v_fields) > 1 THEN ' match' ELSE ' matches' END
                 || ' another directory listing, so ReferralFit will review '
                 || CASE WHEN cardinality(v_fields) > 1 THEN 'those changes' ELSE 'that change' END
                 || ' first. Until then your current ' || v_text
                 || CASE WHEN cardinality(v_fields) > 1 THEN ' stay' ELSE ' stays' END || ' up.');
  END IF;
  RETURN jsonb_build_object('status', 'updated', 'listing_id', p_listing);
END
$$;
REVOKE ALL ON FUNCTION public.org_directory_profile_update_result(uuid) FROM PUBLIC, anon, authenticated;

-- {status, listing_id, ...}; status is created, updated, updated_pending_review,
-- conflict, resubmitted_for_review, merged or claim_requested
-- (docs/DIRECTORY_OWNERSHIP.md).
-- The automatic takeover ('claimed') is gone.
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
  v_own_status text;
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

  SELECT id, status INTO v_own, v_own_status FROM public.global_partners WHERE owner_org_id = v_org;
  IF v_own IS NOT NULL THEN
    IF v_own_status = 'archived' AND EXISTS (SELECT 1 FROM public.global_partners WHERE id = v_own AND merged_into IS NOT NULL) THEN
      RETURN public.org_directory_profile_resubmit(v_own, v_org, v_user);
    END IF;
    PERFORM public.org_directory_profile_save(v_own, v_row, v_org, v_user, true);
    IF v_own_status = 'archived' THEN
      RETURN public.org_directory_profile_resubmit(v_own, v_org, v_user);
    END IF;
    RETURN public.org_directory_profile_update_result(v_own);
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
    -- Same name as an existing listing (but no shared phone or website):
    -- review before it can appear as a second verified program.
    v_match := public.directory_listing_named(v_row.organization);
    IF v_match.id IS NOT NULL THEN
      RETURN public.org_directory_profile_conflict(v_match, v_row, v_org, v_user, 'name');
    END IF;
    v_own := public.org_directory_profile_save(NULL, v_row, v_org, v_user, true);
    RETURN jsonb_build_object('status', 'created', 'listing_id', v_own);
  END IF;
  IF v_match.owner_org_id IS NOT NULL THEN
    RETURN public.org_directory_profile_conflict(v_match, v_row, v_org, v_user, 'contact');
  END IF;

  -- listing_id only when the caller may see that listing anyway.
  RETURN jsonb_build_object('status', 'claim_requested',
    'listing_id', CASE WHEN v_match.status = 'active' OR v_match.suggested_by_org_id = v_org OR v_match.created_by = v_user
                       THEN v_match.id END,
    'request_id', public.org_directory_claim_request(v_match, v_org, v_user, p_payload, v_row.organization),
    'message', 'A directory listing with this phone number or website already exists. ReferralFit will review your request to manage it; nothing changes until then.');
END
$$;
REVOKE ALL ON FUNCTION public.upsert_org_directory_profile(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_org_directory_profile(jsonb) TO authenticated;

-- ===========================================================================
-- 2. Submissions link to an existing listing only on a name match too
-- ===========================================================================

-- Normalization used for duplicate detection (redefines 20260930190000).
-- Phone: digits only; an 11-digit number starting with 1 (US country code)
-- drops the 1, so "+1 541 555 0100" matches "541-555-0100".
CREATE OR REPLACE FUNCTION public.directory_phone_digits(p_phone text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN length(d) = 11 AND left(d, 1) = '1' THEN substr(d, 2) ELSE d END
    FROM (SELECT regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') AS d) AS x
$$;
REVOKE ALL ON FUNCTION public.directory_phone_digits(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.directory_phone_digits(text) TO authenticated, service_role;

-- Website: the host only, lowercased, without the scheme (any case), a
-- leading "www.", a path, query, fragment or port:
-- "Https://WWW.Example.com:8443/intake?x=1" -> "example.com". No host -> ''.
CREATE OR REPLACE FUNCTION public.directory_website_domain(p_website text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT regexp_replace(regexp_replace(
           split_part(split_part(split_part(
             regexp_replace(lower(btrim(coalesce(p_website, ''), ' ' || chr(9) || chr(10) || chr(13))), '^[a-z][a-z0-9+.-]*://', ''),
           '/', 1), '?', 1), '#', 1),
         ':[0-9]*$', ''), '^www[.]', '')
$$;
REVOKE ALL ON FUNCTION public.directory_website_domain(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.directory_website_domain(text) TO authenticated, service_role;

-- The search document, shared by derive_columns and the identity hold.
CREATE OR REPLACE FUNCTION public.global_partner_search_tsv(p_name text, p_organization text, p_city text, p_state text, p_description text)
RETURNS tsvector
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT to_tsvector('simple',
    coalesce(p_name, '') || ' ' || coalesce(p_organization, '') || ' ' ||
    coalesce(p_city, '') || ' ' || coalesce(p_state, '') || ' ' || coalesce(p_description, ''))
$$;
REVOKE ALL ON FUNCTION public.global_partner_search_tsv(text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.global_partner_search_tsv(text, text, text, text, text) TO authenticated, service_role;

-- Same as 20260907120000, through the helpers above.
CREATE OR REPLACE FUNCTION public.global_partners_derive_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.phone_digits := public.directory_phone_digits(NEW.phone);
  NEW.website_domain := public.directory_website_domain(NEW.website);
  NEW.search_tsv := public.global_partner_search_tsv(NEW.name, NEW.organization, NEW.city, NEW.state, NEW.description);
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.global_partners_derive_columns() FROM PUBLIC, anon, authenticated;

-- Re-normalize the stored columns. No unique index covers them today; a row
-- that would break one anyway is left as it was and counted.
DO $$
DECLARE
  v_row record;
  v_changed integer := 0;
  v_skipped integer := 0;
BEGIN
  FOR v_row IN
    SELECT id FROM public.global_partners
     WHERE phone_digits IS DISTINCT FROM public.directory_phone_digits(phone)
        OR website_domain IS DISTINCT FROM public.directory_website_domain(website)
  LOOP
    BEGIN
      UPDATE public.global_partners
         SET phone_digits = public.directory_phone_digits(phone),
             website_domain = public.directory_website_domain(website)
       WHERE id = v_row.id;
      v_changed := v_changed + 1;
    EXCEPTION WHEN unique_violation THEN
      v_skipped := v_skipped + 1;
    END;
  END LOOP;
  RAISE NOTICE 'directory_membership_hardening: re-normalized % listing(s), % left as they were (unique index)', v_changed, v_skipped;
END
$$;

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

-- Internal. Any non-archived listing whose organization (or name) has the
-- same name key as p_organization; NULL fields when there is none.
CREATE OR REPLACE FUNCTION public.directory_listing_named(p_organization text)
RETURNS public.global_partners
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT g.* FROM public.global_partners g
   WHERE g.status <> 'archived'
     AND public.directory_name_key(p_organization) <> ''
     AND public.directory_name_key(coalesce(nullif(btrim(g.organization), ''), g.name)) = public.directory_name_key(p_organization)
   ORDER BY (g.status = 'active') DESC, g.created_at
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.directory_listing_named(text) FROM PUBLIC, anon, authenticated;

-- The listing a submitted partner may link to. All of:
--   * not archived, and NOT claimed (no owner workspace, no center
--     member): a claimant controls its listing's name and phone, so a
--     private partner is never auto-linked to one (import it explicitly
--     instead); the submission becomes a new pending listing;
--   * same phone digits or website domain;
--   * a matching organization name (the listing's organization, or its
--     name when that is blank). An exact name-key match is preferred; a
--     prefix-only match ("Recovery Unplugged" for "Recovery Unplugged
--     Nashville") also needs the same state, and the same city when both
--     have one.
CREATE OR REPLACE FUNCTION public.directory_listing_match_for_partner(p_partner public.partners)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT g.id
    FROM public.global_partners g
   CROSS JOIN LATERAL (
     SELECT public.directory_name_key(p_partner.organization)
            = public.directory_name_key(coalesce(nullif(btrim(g.organization), ''), g.name)) AS exact
   ) AS m
   WHERE g.status <> 'archived'
     AND g.owner_org_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.center_members c WHERE c.global_partner_id = g.id)
     AND ((public.directory_website_domain(p_partner.website) <> ''
           AND g.website_domain = public.directory_website_domain(p_partner.website))
       OR (public.directory_phone_digits(p_partner.phone) <> ''
           AND g.phone_digits = public.directory_phone_digits(p_partner.phone)))
     AND public.directory_names_match(p_partner.organization, coalesce(nullif(btrim(g.organization), ''), g.name))
     AND (m.exact OR (
           NOT public.directory_text_is_blank(p_partner.state)
           AND upper(btrim(p_partner.state)) = upper(btrim(g.state))
           AND (public.directory_text_is_blank(p_partner.city) OR public.directory_text_is_blank(g.city)
                OR lower(btrim(p_partner.city)) = lower(btrim(g.city)))))
   ORDER BY m.exact DESC, (g.status = 'active') DESC, g.created_at
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.directory_listing_match_for_partner(public.partners) FROM PUBLIC, anon, authenticated;

-- Same as 20260930120000 except the existing listing comes from
-- directory_listing_match_for_partner. Without a match a new pending
-- listing is created for admin review.
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

-- Internal. The first other non-archived listing that already uses this
-- identity value: p_kind 'name' (name key), 'phone' (phone digits) or
-- 'website' (domain). NULL when none, or when p_value is blank.
CREATE OR REPLACE FUNCTION public.directory_identity_collision(p_listing uuid, p_kind text, p_value text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT g.id FROM public.global_partners g
   WHERE coalesce(p_value, '') <> '' AND g.id <> p_listing AND g.status <> 'archived'
     AND CASE p_kind
           WHEN 'name' THEN public.directory_name_key(coalesce(nullif(btrim(g.organization), ''), g.name)) = p_value
           WHEN 'phone' THEN g.phone_digits = p_value
           WHEN 'website' THEN g.website_domain = p_value
           ELSE false END
   ORDER BY (g.status = 'active') DESC, g.created_at
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.directory_identity_collision(uuid, text, text) FROM PUBLIC, anon, authenticated;

-- Internal. Keeps the listing's pending identity_edit in step with one
-- claimant write: groups that just went live (p_applied) leave the held
-- proposal, groups just held (p_held, p_hits) are merged in, and a proposal
-- left empty is withdrawn. The note and related_listing_id always describe
-- what is still held: the related listing is the one the first held group
-- (name, phone, website) collides with.
CREATE OR REPLACE FUNCTION public.directory_identity_queue(p_listing uuid, p_org uuid, p_held jsonb, p_hits text[], p_applied text[], p_related uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_drop text[] := '{}';
BEGIN
  IF 'name' = ANY (p_applied) THEN v_drop := v_drop || ARRAY['organization', 'name']; END IF;
  IF 'phone' = ANY (p_applied) THEN v_drop := v_drop || ARRAY['phone']; END IF;
  IF 'website' = ANY (p_applied) THEN v_drop := v_drop || ARRAY['website']; END IF;
  IF cardinality(v_drop) > 0 THEN
    UPDATE public.directory_review_requests
       SET proposed = proposed - v_drop,
           collisions = ARRAY(SELECT c FROM unnest(collisions) AS c WHERE NOT (c = ANY (p_applied))),
           note = 'Matches another listing on: '
                  || array_to_string(ARRAY(SELECT c FROM unnest(collisions) AS c WHERE NOT (c = ANY (p_applied))), ', ')
     WHERE kind = 'identity_edit' AND global_partner_id = p_listing AND status = 'pending';
  END IF;
  IF cardinality(p_hits) > 0 THEN
    INSERT INTO public.directory_review_requests AS r (kind, global_partner_id, related_listing_id, org_id, requested_by, proposed, collisions, note)
    VALUES ('identity_edit', p_listing, p_related, p_org, auth.uid(), p_held, p_hits,
            'Matches another listing on: ' || array_to_string(p_hits, ', '))
    ON CONFLICT (kind, global_partner_id) WHERE status = 'pending'
    DO UPDATE SET proposed = r.proposed || EXCLUDED.proposed,
                  collisions = ARRAY(SELECT DISTINCT c FROM unnest(r.collisions || EXCLUDED.collisions) AS c ORDER BY c),
                  note = 'Matches another listing on: '
                         || array_to_string(ARRAY(SELECT DISTINCT c FROM unnest(r.collisions || EXCLUDED.collisions) AS c ORDER BY c), ', '),
                  related_listing_id = EXCLUDED.related_listing_id,
                  requested_by = EXCLUDED.requested_by, org_id = EXCLUDED.org_id, created_at = now();
  END IF;
  UPDATE public.directory_review_requests SET status = 'withdrawn', resolved_at = now()
   WHERE kind = 'identity_edit' AND global_partner_id = p_listing AND status = 'pending' AND proposed = '{}'::jsonb;
  UPDATE public.directory_review_requests r
     SET related_listing_id = coalesce(
           public.directory_identity_collision(p_listing, 'name',
             public.directory_name_key(coalesce(nullif(btrim(r.proposed ->> 'organization'), ''), r.proposed ->> 'name'))),
           public.directory_identity_collision(p_listing, 'phone', public.directory_phone_digits(r.proposed ->> 'phone')),
           public.directory_identity_collision(p_listing, 'website', public.directory_website_domain(r.proposed ->> 'website')),
           r.related_listing_id)
   WHERE r.kind = 'identity_edit' AND r.global_partner_id = p_listing AND r.status = 'pending';
END
$$;
REVOKE ALL ON FUNCTION public.directory_identity_queue(uuid, uuid, jsonb, text[], text[], uuid) FROM PUBLIC, anon, authenticated;

-- Holds a claimant's identity change that another listing already uses,
-- per group: organization + contact name, phone, website. Only a held
-- group keeps its live values (queued as an identity_edit); in a held name
-- group a field sent unchanged keeps its held value. Admins and server
-- code are never held. Runs after derive_columns (DIRECTORY_OWNERSHIP.md).
CREATE OR REPLACE FUNCTION public.global_partners_hold_colliding_edits()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hits text[] := '{}';
  v_applied text[] := '{}';
  v_held jsonb := '{}'::jsonb;
  v_prev jsonb;
  v_related uuid;
  v_hit uuid;
  v_key text;
BEGIN
  IF auth.uid() IS NULL OR public.is_platform_admin()
     OR (NEW.organization, NEW.name, NEW.phone, NEW.website) IS NOT DISTINCT FROM (OLD.organization, OLD.name, OLD.phone, OLD.website)
     OR NOT public.global_listing_is_claimed(OLD.id) THEN
    RETURN NEW;
  END IF;

  IF (NEW.organization, NEW.name) IS DISTINCT FROM (OLD.organization, OLD.name) THEN
    SELECT r.proposed INTO v_prev FROM public.directory_review_requests r
     WHERE r.kind = 'identity_edit' AND r.global_partner_id = OLD.id AND r.status = 'pending' AND r.proposed ? 'organization';
    IF v_prev IS NOT NULL THEN
      IF NEW.organization IS NOT DISTINCT FROM OLD.organization THEN NEW.organization := v_prev ->> 'organization'; END IF;
      IF NEW.name IS NOT DISTINCT FROM OLD.name THEN NEW.name := v_prev ->> 'name'; END IF;
    END IF;
    v_key := public.directory_name_key(coalesce(nullif(btrim(NEW.organization), ''), NEW.name));
    v_hit := CASE WHEN v_key <> public.directory_name_key(coalesce(nullif(btrim(OLD.organization), ''), OLD.name))
                  THEN public.directory_identity_collision(OLD.id, 'name', v_key) END;
    IF v_hit IS NOT NULL THEN
      v_hits := v_hits || ARRAY['name'];
      v_held := v_held || jsonb_build_object('organization', NEW.organization, 'name', NEW.name);
      v_related := coalesce(v_related, v_hit);
      NEW.organization := OLD.organization;
      NEW.name := OLD.name;
    ELSE
      v_applied := v_applied || ARRAY['name'];
    END IF;
  END IF;
  IF NEW.phone IS DISTINCT FROM OLD.phone THEN
    v_hit := CASE WHEN NEW.phone_digits <> OLD.phone_digits
                  THEN public.directory_identity_collision(OLD.id, 'phone', NEW.phone_digits) END;
    IF v_hit IS NOT NULL THEN
      v_hits := v_hits || ARRAY['phone'];
      v_held := v_held || jsonb_build_object('phone', NEW.phone);
      v_related := coalesce(v_related, v_hit);
      NEW.phone := OLD.phone;
      NEW.phone_digits := OLD.phone_digits;
    ELSE
      v_applied := v_applied || ARRAY['phone'];
    END IF;
  END IF;
  IF NEW.website IS DISTINCT FROM OLD.website THEN
    v_hit := CASE WHEN NEW.website_domain <> OLD.website_domain
                  THEN public.directory_identity_collision(OLD.id, 'website', NEW.website_domain) END;
    IF v_hit IS NOT NULL THEN
      v_hits := v_hits || ARRAY['website'];
      v_held := v_held || jsonb_build_object('website', NEW.website);
      v_related := coalesce(v_related, v_hit);
      NEW.website := OLD.website;
      NEW.website_domain := OLD.website_domain;
    ELSE
      v_applied := v_applied || ARRAY['website'];
    END IF;
  END IF;

  PERFORM public.directory_identity_queue(OLD.id, OLD.owner_org_id, v_held, v_hits, v_applied, v_related);
  IF 'name' = ANY (v_hits || v_applied) THEN
    -- derive_columns indexed the submitted name; index the one that stays.
    NEW.search_tsv := public.global_partner_search_tsv(NEW.name, NEW.organization, NEW.city, NEW.state, NEW.description);
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.global_partners_hold_colliding_edits() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS global_partners_hold_colliding_edits ON public.global_partners;
CREATE TRIGGER global_partners_hold_colliding_edits BEFORE UPDATE ON public.global_partners
  FOR EACH ROW EXECUTE FUNCTION public.global_partners_hold_colliding_edits();

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

-- Internal. What the joiner's copy of a partner (p_dup) knew that the
-- team's copy (p_keep) should keep. Appended to the team note, attributed
-- ("From <name>: ..."), one line each, skipping anything blank or already
-- there: the private note, and a phone or email that differs from the team
-- copy ("Joiner's contact: ..."). A financial relationship is taken when
-- the team has none; otherwise the joiner's relationship note is added to
-- the team's (or to the note when that would pass 300 characters). Touch
-- cadence fills a blank, favorite is either, last contact is the later.
CREATE OR REPLACE FUNCTION public.org_merge_partner_fields(p_keep uuid, p_dup uuid, p_name text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  k public.partners%ROWTYPE;
  d public.partners%ROWTYPE;
  v_add text[] := '{}';
  v_contact text;
  v_kind text;
  v_fin text;
  v_dfin text;
BEGIN
  SELECT * INTO k FROM public.partners WHERE id = p_keep;
  SELECT * INTO d FROM public.partners WHERE id = p_dup;
  IF btrim(d.note) <> '' AND position(btrim(d.note) IN k.note) = 0 THEN
    v_add := array_append(v_add, btrim(d.note));
  END IF;
  v_contact := concat_ws(', ',
    CASE WHEN public.directory_phone_digits(d.phone) <> ''
          AND public.directory_phone_digits(d.phone) <> public.directory_phone_digits(k.phone) THEN btrim(d.phone) END,
    CASE WHEN btrim(d.email) <> '' AND lower(btrim(d.email)) <> lower(btrim(k.email)) THEN btrim(d.email) END);
  IF v_contact <> '' AND position(v_contact IN k.note) = 0 THEN
    v_add := array_append(v_add, 'Joiner''s contact: ' || v_contact);
  END IF;

  v_kind := k.financial_relationship;
  v_fin := k.financial_relationship_note;
  v_dfin := btrim(d.financial_relationship_note);
  IF d.financial_relationship <> 'none' AND k.financial_relationship = 'none' THEN
    v_kind := d.financial_relationship;
    v_fin := d.financial_relationship_note;
  ELSIF d.financial_relationship <> 'none' AND v_dfin <> '' AND position(v_dfin IN k.financial_relationship_note) = 0 THEN
    IF length(btrim(k.financial_relationship_note)) + length(v_dfin) + 2 <= 300 THEN
      v_fin := CASE WHEN btrim(k.financial_relationship_note) = '' THEN v_dfin
                    ELSE btrim(k.financial_relationship_note) || '; ' || v_dfin END;
    ELSE
      v_add := array_append(v_add, 'Financial relationship: ' || v_dfin);
    END IF;
  END IF;

  UPDATE public.partners
     SET note = CASE WHEN cardinality(v_add) = 0 THEN k.note
                     ELSE CASE WHEN btrim(k.note) = '' THEN '' ELSE k.note || chr(10) || chr(10) END
                          || 'From ' || p_name || ': ' || array_to_string(v_add, chr(10)) END,
         financial_relationship = v_kind,
         financial_relationship_note = v_fin,
         touch_cadence_days = coalesce(k.touch_cadence_days, d.touch_cadence_days),
         favorite = k.favorite OR d.favorite,
         last_contact_at = greatest(k.last_contact_at, d.last_contact_at)
   WHERE id = p_keep;
END
$$;
REVOKE ALL ON FUNCTION public.org_merge_partner_fields(uuid, uuid, text) FROM PUBLIC, anon, authenticated;

-- Internal. A partner in p_from linked to a listing that p_to already tracks
-- would break partners_org_global_partner_unique on the move: repoint
-- everything that references it to the team's copy, carry its private
-- fields over (org_merge_partner_fields), then delete it. Runs with
-- constraints deferred (the repointed rows still carry p_from until the
-- move). Returns the number of partners merged.
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
    PERFORM public.org_merge_partner_fields(v_pair.keep_id, v_pair.dup_id, v_name);
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

-- Internal. The directory side of a solo workspace joining p_to:
--   * its own profile (owner_org_id) goes to the team when the team owns
--     none; otherwise it is left unowned but live and an orphaned_profile
--     review request (visible to the team) tells the admin. A profile
--     ReferralFit merged into another listing (merged_into) is only
--     released, so the team is never stuck with it;
--   * listings it submitted (suggested_by_org_id) now count as the team's;
--   * its pending claim requests move (a duplicate of one the team already
--     has is dropped);
--   * its entitlement rows merge into the team's: active if either is, the
--     later expiry, no expiry when an active row had none.
CREATE OR REPLACE FUNCTION public.org_move_directory_state(p_from uuid, p_to uuid, p_user uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_listing uuid;
BEGIN
  UPDATE public.global_partners SET owner_org_id = NULL WHERE owner_org_id = p_from AND merged_into IS NOT NULL;
  SELECT id INTO v_listing FROM public.global_partners WHERE owner_org_id = p_from;
  IF v_listing IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.global_partners WHERE owner_org_id = p_to) THEN
      UPDATE public.global_partners SET owner_org_id = p_to WHERE id = v_listing;
    ELSE
      UPDATE public.global_partners SET owner_org_id = NULL WHERE id = v_listing;
      INSERT INTO public.directory_review_requests (kind, global_partner_id, org_id, requested_by, note)
      VALUES ('orphaned_profile', v_listing, p_to, p_user,
              'The owner of this profile joined a practice that already has a directory profile. It is live and unowned until reviewed.')
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  UPDATE public.global_partners SET suggested_by_org_id = p_to WHERE suggested_by_org_id = p_from;

  DELETE FROM public.center_claim_requests r
   WHERE r.org_id = p_from AND r.status = 'pending'
     AND EXISTS (SELECT 1 FROM public.center_claim_requests t
                  WHERE t.org_id = p_to AND t.status = 'pending' AND t.global_partner_id = r.global_partner_id);
  UPDATE public.center_claim_requests SET org_id = p_to WHERE org_id = p_from AND status = 'pending';

  INSERT INTO public.org_entitlements AS t (org_id, entitlement, active, source, rc_app_user_id, expires_at)
  SELECT p_to, e.entitlement, e.active, e.source, e.rc_app_user_id, e.expires_at
    FROM public.org_entitlements e WHERE e.org_id = p_from
  ON CONFLICT (org_id, entitlement) DO UPDATE SET
    active = t.active OR EXCLUDED.active,
    expires_at = CASE WHEN (t.active AND t.expires_at IS NULL) OR (EXCLUDED.active AND EXCLUDED.expires_at IS NULL) THEN NULL
                      ELSE greatest(t.expires_at, EXCLUDED.expires_at) END,
    source = CASE WHEN t.active THEN t.source ELSE EXCLUDED.source END,
    rc_app_user_id = CASE WHEN t.active THEN t.rc_app_user_id ELSE EXCLUDED.rc_app_user_id END;
END
$$;
REVOKE ALL ON FUNCTION public.org_move_directory_state(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Same contract as 20260820033721. A solo owner's rows and directory state
-- move (merging linked partner copies the team already has); a member
-- leaving a practice brings nothing but their devices. The invite and the
-- caller's membership are locked. Rows move BEFORE the membership changes
-- so a solo owner's self-assignments survive (the release trigger only
-- clears what is left in the old workspace). Deferred constraints are
-- checked at commit.
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

  -- Locked: two accepts for one user run one after the other.
  SELECT org_id, role INTO v_old_org, v_old_role FROM public.org_members WHERE user_id = v_user FOR UPDATE;
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
    PERFORM public.org_move_directory_state(v_old_org, v_invite.org_id, v_user);
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
-- floors) only once ALL of these hold (docs/OUTCOMES.md):
--   * it was created at least 60 days ago;
--   * it has at least 3 cases or at least 5 referrals, all-time;
--   * cases, referrals or touches were created on at least 10 distinct
--     calendar days (UTC).
-- Every created_at involved is server-set (see pin_row_created_at below).
CREATE OR REPLACE FUNCTION public.org_is_established(p_org_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.orgs o
     WHERE o.id = p_org_id
       AND o.created_at <= now() - interval '60 days'
       AND ((SELECT count(*) FROM (SELECT 1 FROM public.cases c WHERE c.org_id = o.id LIMIT 3) AS c3) >= 3
         OR (SELECT count(*) FROM (SELECT 1 FROM public.referrals r WHERE r.org_id = o.id LIMIT 5) AS r5) >= 5)
       AND (SELECT count(*) FROM (
              SELECT a.day FROM (
                SELECT (c.created_at AT TIME ZONE 'UTC')::date AS day FROM public.cases c WHERE c.org_id = o.id
                UNION
                SELECT (r.created_at AT TIME ZONE 'UTC')::date FROM public.referrals r WHERE r.org_id = o.id
                UNION
                SELECT (t.created_at AT TIME ZONE 'UTC')::date FROM public.touches t WHERE t.org_id = o.id
              ) AS a LIMIT 10) AS d10) >= 10
  )
$$;
REVOKE ALL ON FUNCTION public.org_is_established(uuid) FROM PUBLIC, anon, authenticated;

-- The rule needs created_at values no client can write: a client insert
-- gets now(), a client update keeps the old value. Server code (definer
-- functions, service role, the SQL editor) is unaffected. Covers orgs
-- (the owner may rename the workspace, nothing else) and the three
-- activity tables.
CREATE OR REPLACE FUNCTION public.pin_row_created_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.created_at := now();
    ELSE
      NEW.created_at := OLD.created_at;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.pin_row_created_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS orgs_pin_created_at ON public.orgs;
CREATE TRIGGER orgs_pin_created_at BEFORE UPDATE ON public.orgs
  FOR EACH ROW EXECUTE FUNCTION public.pin_row_created_at();
DROP TRIGGER IF EXISTS cases_pin_created_at ON public.cases;
CREATE TRIGGER cases_pin_created_at BEFORE INSERT OR UPDATE ON public.cases
  FOR EACH ROW EXECUTE FUNCTION public.pin_row_created_at();
DROP TRIGGER IF EXISTS referrals_pin_created_at ON public.referrals;
CREATE TRIGGER referrals_pin_created_at BEFORE INSERT OR UPDATE ON public.referrals
  FOR EACH ROW EXECUTE FUNCTION public.pin_row_created_at();
DROP TRIGGER IF EXISTS touches_pin_created_at ON public.touches;
CREATE TRIGGER touches_pin_created_at BEFORE INSERT OR UPDATE ON public.touches
  FOR EACH ROW EXECUTE FUNCTION public.pin_row_created_at();

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
