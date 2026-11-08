-- Self-serve listing claims: a program asks, ReferralFit approves in the app.
--
--   1. program_claim_requests: a program's signed-in portal account asks to
--      manage an unclaimed program listing (its contact name, role, phone,
--      a note). One waiting request per account, at most five a day.
--   2. Portal RPCs: search claimable listings, request, read my request,
--      cancel it.
--   3. Admin RPCs (platform admins only, re-checked on the server): list the
--      waiting requests with the requester's email and whether its domain
--      matches the listing's website, and approve or decline. Approving
--      binds the account to the listing exactly as a claim code does
--      (center_members, verified_at stamped, unused codes expired) and
--      declines any other request for that listing.
--   4. Two emails on the email_outbox from 20261108120000: 'claim_request'
--      to every platform admin when a request arrives, 'claim_decision' to
--      the requester when it is decided. Account email: no preference and
--      no unsubscribe link (the request is the opt-in).
--
-- Claiming never buys ranking; this changes only who keeps a listing current.
-- Transit-safe: ASCII only, no backslashes, every statement under 3,700
-- characters.

BEGIN;

-- ===========================================================================
-- 1. Requests
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.program_claim_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  global_partner_id uuid NOT NULL REFERENCES public.global_partners(id) ON DELETE CASCADE,
  contact_name text NOT NULL CHECK (length(contact_name) BETWEEN 1 AND 120),
  contact_role text NOT NULL DEFAULT '' CHECK (length(contact_role) <= 120),
  contact_phone text NOT NULL DEFAULT '' CHECK (length(contact_phone) <= 40),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'cancelled')),
  decision_note text NOT NULL DEFAULT '' CHECK (length(decision_note) <= 500),
  decided_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS program_claim_requests_one_waiting_idx
  ON public.program_claim_requests (user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS program_claim_requests_listing_idx ON public.program_claim_requests (global_partner_id, status);
ALTER TABLE public.program_claim_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.program_claim_requests FROM PUBLIC, anon, authenticated, service_role;

-- A program listing: has types, and they are not only individual
-- professionals (interventionists and therapists keep a workspace profile).
CREATE OR REPLACE FUNCTION public.listing_is_program(p_types text[])
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
  SELECT cardinality(coalesce(p_types, '{}'::text[])) > 0
         AND NOT (p_types <@ ARRAY['Interventionist', 'Therapist']::text[])
$$;

-- The host of a website ('https://www.example.com/x' -> 'example.com').
CREATE OR REPLACE FUNCTION public.website_host(p_url text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
  SELECT nullif(regexp_replace(split_part(split_part(split_part(regexp_replace(lower(btrim(coalesce(p_url, ''))),
           '^[a-z]+://', ''), '/', 1), '?', 1), ':', 1), '^www[.]', ''), '')
$$;

-- An email's domain matches a website when it is the host or a subdomain of
-- it, or the other way round ('admissions@mail.example.com' vs example.com).
CREATE OR REPLACE FUNCTION public.email_matches_website(p_email text, p_url text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
  SELECT coalesce(d = h OR d LIKE '%.' || h OR h LIKE '%.' || d, false)
    FROM (SELECT nullif(lower(split_part(btrim(coalesce(p_email, '')), '@', 2)), '') AS d,
                 public.website_host(p_url) AS h) x
$$;


-- ===========================================================================
-- 2. The portal (a signed-in program account)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.claimable_program_listings(p_query text, p_state text DEFAULT NULL)
RETURNS TABLE (id uuid, listing_name text, city text, state text, website text, claimed boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT g.id, public.listing_display_name(g.id), g.city, g.state, g.website, public.global_listing_is_claimed(g.id)
    FROM public.global_partners g
   WHERE auth.uid() IS NOT NULL
     AND g.status = 'active' AND public.listing_is_program(g.types)
     AND length(btrim(coalesce(p_query, ''))) >= 2
     AND (g.organization ILIKE '%' || btrim(p_query) || '%' OR g.name ILIKE '%' || btrim(p_query) || '%'
          OR coalesce(g.website, '') ILIKE '%' || btrim(p_query) || '%')
     AND (nullif(btrim(coalesce(p_state, '')), '') IS NULL OR g.state = upper(btrim(p_state)))
   ORDER BY public.listing_display_name(g.id), g.city
   LIMIT 25
$$;
REVOKE ALL ON FUNCTION public.claimable_program_listings(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claimable_program_listings(text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.request_program_claim(
  p_global_id uuid, p_contact_name text, p_contact_role text, p_contact_phone text, p_note text
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_name text := left(btrim(coalesce(p_contact_name, '')), 120);
  v_id uuid;
  v_admin record;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.center_members m WHERE m.user_id = v_user) THEN
    RAISE EXCEPTION 'This account already manages a listing' USING ERRCODE = '22023';
  END IF;
  IF v_name = '' THEN
    RAISE EXCEPTION 'Add your name so ReferralFit knows who is asking' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.global_partners g
                  WHERE g.id = p_global_id AND g.status = 'active' AND public.listing_is_program(g.types)) THEN
    RAISE EXCEPTION 'That listing was not found' USING ERRCODE = 'P0002';
  END IF;
  IF public.global_listing_is_claimed(p_global_id) THEN
    RAISE EXCEPTION 'This listing is already managed by its program. If that is wrong, email matt@freedominterventions.com.'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.program_claim_requests r WHERE r.user_id = v_user AND r.status = 'pending') THEN
    RAISE EXCEPTION 'You already have a request waiting. Cancel it first to ask for a different listing.' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM public.program_claim_requests r
       WHERE r.user_id = v_user AND r.created_at > now() - interval '24 hours') >= 5 THEN
    RAISE EXCEPTION 'Too many requests today. Try again tomorrow.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.program_claim_requests (user_id, global_partner_id, contact_name, contact_role, contact_phone, note)
  VALUES (v_user, p_global_id, v_name, left(btrim(coalesce(p_contact_role, '')), 120),
          left(btrim(coalesce(p_contact_phone, '')), 40), left(btrim(coalesce(p_note, '')), 500))
  RETURNING id INTO v_id;
  FOR v_admin IN SELECT a.user_id FROM public.platform_admins a LOOP
    PERFORM public.email_enqueue(v_admin.user_id, 'claim_request', jsonb_build_object('claim_request_id', v_id));
  END LOOP;
  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION public.request_program_claim(uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_program_claim(uuid, text, text, text, text) TO authenticated;

-- The caller's latest request (any status), for the portal.
CREATE OR REPLACE FUNCTION public.my_program_claim_request()
RETURNS TABLE (id uuid, listing_name text, status text, decision_note text, created_at timestamptz, decided_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT r.id, public.listing_display_name(r.global_partner_id), r.status, r.decision_note, r.created_at, r.decided_at
    FROM public.program_claim_requests r
   WHERE r.user_id = auth.uid()
   ORDER BY r.created_at DESC
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.my_program_claim_request() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_program_claim_request() TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_program_claim_request()
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  UPDATE public.program_claim_requests r SET status = 'cancelled', decided_at = now()
   WHERE r.user_id = auth.uid() AND r.status = 'pending';
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION public.cancel_program_claim_request() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_program_claim_request() TO authenticated;

-- ===========================================================================
-- 3. ReferralFit's review (platform admins)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.list_program_claim_requests()
RETURNS TABLE (
  id uuid, global_partner_id uuid, listing_name text, city text, state text, website text, listing_phone text,
  listing_claimed boolean, requester_email text, email_matches_website boolean, contact_name text, contact_role text,
  contact_phone text, note text, created_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Only platform admins can review claim requests' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT r.id, r.global_partner_id, public.listing_display_name(g.id), g.city, g.state, g.website, g.phone,
         public.global_listing_is_claimed(g.id), u.email::text, public.email_matches_website(u.email, g.website),
         r.contact_name, r.contact_role, r.contact_phone, r.note, r.created_at
    FROM public.program_claim_requests r
    JOIN public.global_partners g ON g.id = r.global_partner_id
    JOIN auth.users u ON u.id = r.user_id
   WHERE r.status = 'pending'
   ORDER BY r.created_at;
END
$$;
REVOKE ALL ON FUNCTION public.list_program_claim_requests() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_program_claim_requests() TO authenticated;

-- Approve: the same binding as claim_center_listing. Decline: with an
-- optional note the program reads in its email and in the portal.
CREATE OR REPLACE FUNCTION public.decide_program_claim_request(p_id uuid, p_approve boolean, p_note text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin uuid := auth.uid();
  r public.program_claim_requests%ROWTYPE;
  v_prev_pub text := coalesce(current_setting('referralfit.seed_publish', true), '');
  v_other record;
BEGIN
  IF v_admin IS NULL OR NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Only platform admins can decide claim requests' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO r FROM public.program_claim_requests x WHERE x.id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Claim request not found' USING ERRCODE = 'P0002'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'This request was already decided' USING ERRCODE = '22023'; END IF;
  IF p_approve THEN
    IF public.global_listing_is_claimed(r.global_partner_id) THEN
      RAISE EXCEPTION 'Another account manages this listing now. Decline this request.' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.center_members m WHERE m.user_id = r.user_id) THEN
      RAISE EXCEPTION 'This account already manages another listing. Decline this request.' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.center_members (user_id, global_partner_id) VALUES (r.user_id, r.global_partner_id);
    UPDATE public.center_claim_codes c SET expires_at = now()
     WHERE c.global_partner_id = r.global_partner_id AND c.claimed_at IS NULL AND c.expires_at > now();
    PERFORM set_config('referralfit.seed_publish', 'on', true);
    UPDATE public.global_partners g SET verified_at = coalesce(g.verified_at, now()) WHERE g.id = r.global_partner_id;
    PERFORM set_config('referralfit.seed_publish', v_prev_pub, true);
    FOR v_other IN SELECT x.id, x.user_id FROM public.program_claim_requests x
                    WHERE x.global_partner_id = r.global_partner_id AND x.status = 'pending' AND x.id <> r.id LOOP
      UPDATE public.program_claim_requests x
         SET status = 'declined', decided_by = v_admin, decided_at = now(),
             decision_note = 'Another account at this program manages the listing now.'
       WHERE x.id = v_other.id;
      PERFORM public.email_enqueue(v_other.user_id, 'claim_decision', jsonb_build_object('claim_request_id', v_other.id));
    END LOOP;
  END IF;
  UPDATE public.program_claim_requests x
     SET status = CASE WHEN p_approve THEN 'approved' ELSE 'declined' END,
         decided_by = v_admin, decided_at = now(), decision_note = left(btrim(coalesce(p_note, '')), 500)
   WHERE x.id = r.id;
  PERFORM public.email_enqueue(r.user_id, 'claim_decision', jsonb_build_object('claim_request_id', r.id));
  RETURN CASE WHEN p_approve THEN 'approved' ELSE 'declined' END;
END
$$;
REVOKE ALL ON FUNCTION public.decide_program_claim_request(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_program_claim_request(uuid, boolean, text) TO authenticated;

-- ===========================================================================
-- 4. The two emails (on the outbox from 20261108120000)
-- ===========================================================================

ALTER TABLE public.email_outbox DROP CONSTRAINT IF EXISTS email_outbox_kind_check;
ALTER TABLE public.email_outbox ADD CONSTRAINT email_outbox_kind_check
  CHECK (kind IN ('placement_response', 'daily_summary', 'bed_reminder', 'claim_request', 'claim_decision'));

-- Same as 20261108120000 plus the two account emails (always wanted).
CREATE OR REPLACE FUNCTION public.email_wanted(p_user_id uuid, p_kind text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE p_kind
           WHEN 'placement_response' THEN coalesce((SELECT placement_response FROM public.email_preferences WHERE user_id = p_user_id), true)
           WHEN 'daily_summary' THEN coalesce((SELECT daily_summary FROM public.email_preferences WHERE user_id = p_user_id), false)
           WHEN 'bed_reminder' THEN coalesce((SELECT bed_reminder FROM public.email_preferences WHERE user_id = p_user_id), true)
           WHEN 'claim_request' THEN true
           WHEN 'claim_decision' THEN true
           ELSE false END
$$;

REVOKE ALL ON FUNCTION public.email_wanted(uuid, text) FROM PUBLIC, anon, authenticated, service_role;

-- What a claim email says, or NULL when it should no longer go out (a
-- request decided or cancelled before ReferralFit was told about it).
CREATE OR REPLACE FUNCTION public.email_claim_details(p_kind text, p_data jsonb)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
           WHEN p_kind = 'claim_request' AND r.status = 'pending' THEN
             jsonb_build_object('listing_name', public.listing_display_name(g.id), 'city', g.city, 'state', g.state,
                                'email_matches_website', public.email_matches_website(u.email, g.website),
                                'waiting', (SELECT count(*) FROM public.program_claim_requests w WHERE w.status = 'pending'))
           WHEN p_kind = 'claim_decision' AND r.status IN ('approved', 'declined') THEN
             jsonb_build_object('listing_name', public.listing_display_name(g.id), 'approved', r.status = 'approved',
                                'decision_note', r.decision_note)
         END
    FROM public.program_claim_requests r
    JOIN public.global_partners g ON g.id = r.global_partner_id
    JOIN auth.users u ON u.id = r.user_id
   WHERE r.id = (p_data ->> 'claim_request_id')::uuid
$$;
REVOKE ALL ON FUNCTION public.email_claim_details(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- Same as 20261108120000 plus the claim branch.
CREATE OR REPLACE FUNCTION public.email_outbox_prepare(p_id uuid)
RETURNS TABLE (id uuid, kind text, email text, data jsonb, unsubscribe_token text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o public.email_outbox%ROWTYPE;
  v_email text;
  v_data jsonb;
  v_req record;
  v_gid uuid;
  v_fail text;
  v_pref public.email_preferences%ROWTYPE;
BEGIN
  SELECT * INTO o FROM public.email_outbox x WHERE x.id = p_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = o.user_id;
  v_data := o.data;
  IF coalesce(btrim(v_email), '') = '' THEN
    v_fail := 'no_email';
  ELSIF NOT public.email_wanted(o.user_id, o.kind) THEN
    v_fail := 'unsubscribed';
  ELSIF o.kind = 'placement_response' THEN
    SELECT r.status,
           (SELECT count(*) FROM public.placement_request_recipients x WHERE x.request_id = r.id) AS asked,
           (SELECT count(*) FROM public.placement_request_recipients x
             WHERE x.request_id = r.id AND x.status IN ('responded', 'declined')) AS answered
      INTO v_req
      FROM public.placement_requests r WHERE r.id = (o.data ->> 'placement_request_id')::uuid;
    IF NOT FOUND OR v_req.status <> 'open' THEN
      v_fail := 'request_closed';
    ELSE
      v_data := v_data || jsonb_build_object('asked', v_req.asked, 'answered', v_req.answered);
    END IF;
  ELSIF o.kind = 'bed_reminder' THEN
    v_gid := (o.data ->> 'global_partner_id')::uuid;
    IF NOT public.bed_reminder_eligible(o.user_id, v_gid) THEN
      v_fail := 'not_eligible';
    ELSE
      SELECT v_data || jsonb_build_object(
               'listing_name', public.listing_display_name(g.id), 'beds_male', g.beds_male, 'beds_female', g.beds_female,
               'beds_updated_at', g.beds_updated_at, 'link_token', public.mint_bed_link(o.user_id, g.id))
        INTO v_data
        FROM public.global_partners g WHERE g.id = v_gid;
    END IF;
  ELSIF o.kind IN ('claim_request', 'claim_decision') THEN
    v_req := NULL;
    SELECT public.email_claim_details(o.kind, o.data) AS details INTO v_req;
    IF v_req.details IS NULL THEN
      v_fail := 'not_pending';
    ELSE
      v_data := v_data || v_req.details;
    END IF;
  END IF;
  IF v_fail IS NOT NULL THEN
    UPDATE public.email_outbox x SET error = v_fail WHERE x.id = p_id;
    RETURN;
  END IF;
  v_pref := public.email_preferences_row(o.user_id);
  RETURN QUERY SELECT o.id, o.kind, v_email, v_data, v_pref.unsubscribe_token;
END
$$;

REVOKE ALL ON FUNCTION public.email_outbox_prepare(uuid) FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
