-- Partners from contacts and a spreadsheet, and program referrals in the
-- referral history (2026-11-08). docs/PARTNER_IMPORT.md, docs/PROGRAM_REFERRALS.md.
--
--   1. import_partners(rows): the practice's chosen contacts as partners in
--      one call (up to 500). A row with a Directory listing id imports that
--      listing (as import_global_partner does); any other row is the
--      practice's own contact. Rows already in the network (same listing,
--      email, phone or name and organization) are skipped, and so are
--      Directory rows for a workspace without the Directory (the same rule
--      as reading it, global_partners RLS). The app matches
--      contacts to the Directory on the device and sends only the rows the
--      practitioner confirmed; nothing else from the address book or file
--      reaches the server.
--   2. A program referral that arrives from a program already in the
--      receiving practice's network is logged in its referral history as an
--      inbound referral on the new lead, as if the practice had logged it by
--      hand (program_referrals_log_inbound). Otherwise the case file offers
--      one tap, "Add to network and log" (log_program_referral);
--      case_program_referral says which applies.
--
-- Referrals never rank: matching never reads inbound or outbound counts.
-- Transit-safe: ASCII only, no backslashes, every statement under 3,700
-- characters.

BEGIN;

-- ===========================================================================
-- 1. Import partners
-- ===========================================================================

-- A website kept only when it is an http(s) address or a bare host name.
CREATE OR REPLACE FUNCTION public.import_partner_website(p_value text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN v ~* '^https?://[a-z0-9.-]+[.][a-z]{2,}([:/?#].*)?$' THEN v
    WHEN v ~* '^[a-z0-9-]+([.][a-z0-9-]+)*[.][a-z]{2,}(/.*)?$' THEN v
    ELSE '' END
  FROM (SELECT left(btrim(coalesce(p_value, '')), 300) AS v) s
$$;
REVOKE ALL ON FUNCTION public.import_partner_website(text) FROM PUBLIC, anon, authenticated;

-- One own-contact row, or NULL when it was skipped (empty or a duplicate).
CREATE OR REPLACE FUNCTION public.import_partner_row(p_org uuid, p_user uuid, r jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_name text := left(btrim(coalesce(r ->> 'organization', '')), 200);
  v_name text := left(btrim(coalesce(r ->> 'name', '')), 200);
  v_email text := lower(left(btrim(coalesce(r ->> 'email', '')), 254));
  v_phone text := left(btrim(coalesce(r ->> 'phone', '')), 40);
  v_digits text;
  v_state text := upper(left(btrim(coalesce(r ->> 'state', '')), 2));
  v_types text[];
  v_id uuid := gen_random_uuid();
BEGIN
  IF v_org_name = '' THEN v_org_name := v_name; END IF;
  IF v_name = '' THEN v_name := v_org_name; END IF;
  SELECT coalesce(array_agg(DISTINCT t), '{}') INTO v_types
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(r -> 'types') = 'array' THEN r -> 'types' ELSE '[]'::jsonb END) t
   WHERE t IN ('Inpatient', 'IOP / PHP', 'Interventionist', 'Therapist', 'Sober Living', 'Detox');
  IF v_name = '' OR cardinality(v_types) = 0 THEN RETURN NULL; END IF;
  IF v_email !~ '^[^@ ]+@[^@ ]+[.][^@ ]+$' THEN v_email := ''; END IF;
  v_digits := right(regexp_replace(v_phone, '[^0-9]', '', 'g'), 10);
  IF v_state !~ '^[A-Z]{2}$' THEN v_state := ''; END IF;
  IF EXISTS (SELECT 1 FROM public.partners p
              WHERE p.org_id = p_org
                AND ((v_email <> '' AND lower(p.email) = v_email)
                  OR (length(v_digits) = 10 AND right(regexp_replace(p.phone, '[^0-9]', '', 'g'), 10) = v_digits)
                  OR (lower(p.organization) = lower(v_org_name) AND lower(p.name) = lower(v_name)))) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.partners (id, owner_id, org_id, name, organization, types, levels, city, state, regions,
                               phone, email, website, note, populations, monthly_cost, cash_min, cash_max)
  VALUES (v_id, p_user, p_org, v_name, v_org_name, v_types, v_types,
          coalesce(nullif(left(btrim(coalesce(r ->> 'city', '')), 100), ''), chr(8212)),
          coalesce(nullif(v_state, ''), chr(8212)), ARRAY['Nationwide'],
          v_phone, v_email, public.import_partner_website(r ->> 'website'),
          left(btrim(coalesce(r ->> 'note', '')), 1000), ARRAY['Adults'], 0, 0, 0);
  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION public.import_partner_row(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.import_partners(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid := public.current_org_id();
  r jsonb;
  v_gid uuid;
  v_id uuid;
  v_added integer := 0;
  v_linked integer := 0;
  v_skipped integer := 0;
  v_ids uuid[] := '{}';
  v_directory boolean;
BEGIN
  IF v_user IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  v_directory := public.is_platform_admin() OR public.org_has_entitlement('directory');
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Choose at least one contact to add.' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'Choose at least one contact to add.' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_rows) > 500 THEN
    RAISE EXCEPTION 'Add up to 500 partners at a time.' USING ERRCODE = '22023';
  END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    IF jsonb_typeof(r) IS DISTINCT FROM 'object' THEN v_skipped := v_skipped + 1; CONTINUE; END IF;
    v_gid := CASE WHEN coalesce(r ->> 'global_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  THEN (r ->> 'global_id')::uuid END;
    IF v_gid IS NOT NULL THEN
      IF NOT v_directory
         OR EXISTS (SELECT 1 FROM public.partners p WHERE p.org_id = v_org AND p.global_partner_id = v_gid)
         OR NOT EXISTS (SELECT 1 FROM public.global_partners g WHERE g.id = v_gid AND g.status = 'active') THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;
      v_id := public.import_global_partner(v_gid, gen_random_uuid());
      v_linked := v_linked + 1;
    ELSE
      v_id := public.import_partner_row(v_org, v_user, r);
      IF v_id IS NULL THEN v_skipped := v_skipped + 1; CONTINUE; END IF;
      v_added := v_added + 1;
    END IF;
    v_ids := v_ids || v_id;
  END LOOP;
  RETURN jsonb_build_object('added', v_added, 'linked', v_linked, 'skipped', v_skipped, 'ids', to_jsonb(v_ids));
END
$$;
REVOKE ALL ON FUNCTION public.import_partners(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_partners(jsonb) TO authenticated;

-- ===========================================================================
-- 2. Program referrals in the referral history
-- ===========================================================================

-- The receiving workspace's partner for the referring program's listing.
CREATE OR REPLACE FUNCTION public.program_referral_network_partner(p_org uuid, p_listing uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id FROM public.partners p WHERE p.org_id = p_org AND p.global_partner_id = p_listing LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.program_referral_network_partner(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- A new program referral from a program already in the network: an inbound
-- referral on the lead, written as the practice (the lead's owner), with the
-- program's claims cleared for the insert as program_referral_lead does.
CREATE OR REPLACE FUNCTION public.program_referrals_log_inbound()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sub text := coalesce(current_setting('request.jwt.claim.sub', true), '');
  v_claims text := coalesce(current_setting('request.jwt.claims', true), '');
  v_partner uuid;
  v_case record;
  v_day date;
BEGIN
  IF NEW.case_id IS NULL THEN RETURN NULL; END IF;
  v_partner := public.program_referral_network_partner(NEW.to_org_id, NEW.from_global_partner_id);
  IF v_partner IS NULL THEN RETURN NULL; END IF;
  SELECT c.owner_id, c.title INTO v_case FROM public.cases c WHERE c.id = NEW.case_id AND c.org_id = NEW.to_org_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT public.email_local_now(p.tz_name, p.tz_offset_minutes)::date INTO v_day
    FROM public.email_preferences p WHERE p.user_id = v_case.owner_id;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  INSERT INTO public.referrals (owner_id, org_id, partner_id, direction, referred_on, client_label, outcome, note, case_id)
  VALUES (v_case.owner_id, NEW.to_org_id, v_partner, 'inbound',
          coalesce(v_day, public.email_local_now(NULL, NULL)::date), left(coalesce(v_case.title, ''), 120),
          'Pending', 'Referred through ReferralFit.', NEW.case_id);
  PERFORM set_config('request.jwt.claim.sub', v_sub, true);
  PERFORM set_config('request.jwt.claims', v_claims, true);
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.program_referrals_log_inbound() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS program_referrals_log_inbound ON public.program_referrals;
CREATE TRIGGER program_referrals_log_inbound
  AFTER INSERT ON public.program_referrals
  FOR EACH ROW EXECUTE FUNCTION public.program_referrals_log_inbound();

-- The case file's view: the program behind the case, the sharing switch,
-- and whether the referral is in the referral history (in_network: the
-- program is a partner; logged: an inbound referral from it is on this case;
-- can_log: "Add to network and log" can work).
DROP FUNCTION IF EXISTS public.case_program_referral(uuid);
CREATE FUNCTION public.case_program_referral(p_case_id uuid)
RETURNS TABLE (id uuid, from_display text, share_progress boolean, created_at timestamptz,
               in_network boolean, logged boolean, can_log boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT pr.id, pr.from_display, pr.share_progress, pr.created_at,
         p.id IS NOT NULL,
         EXISTS (SELECT 1 FROM public.referrals r
                  WHERE r.case_id = c.id AND r.org_id = c.org_id AND r.direction = 'inbound' AND r.partner_id = p.id),
         p.id IS NOT NULL
           OR EXISTS (SELECT 1 FROM public.global_partners g WHERE g.id = pr.from_global_partner_id AND g.status = 'active')
    FROM public.program_referrals pr
    JOIN public.cases c ON c.id = pr.case_id
    LEFT JOIN public.partners p ON p.org_id = c.org_id AND p.global_partner_id = pr.from_global_partner_id
   WHERE pr.case_id = p_case_id AND auth.uid() IS NOT NULL AND c.org_id = public.current_org_id()
   ORDER BY pr.created_at DESC
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.case_program_referral(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.case_program_referral(uuid) TO authenticated;

-- "Add to network and log": the referring program as a partner (from its
-- Directory listing) when it is not one yet, and the inbound referral on the
-- case when it is not logged yet. Any member of the case's workspace;
-- running it twice changes nothing. p_referred_on is the device's date for
-- the referral (within a day of it; otherwise the server's).
CREATE OR REPLACE FUNCTION public.log_program_referral(p_referral_id uuid, p_referred_on date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid := public.current_org_id();
  v_row record;
  v_partner uuid;
  v_referral uuid;
  v_added boolean := false;
  v_day date;
BEGIN
  IF v_user IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  SELECT pr.id, pr.from_global_partner_id, pr.created_at, c.id AS case_id, c.title INTO v_row
    FROM public.program_referrals pr
    JOIN public.cases c ON c.id = pr.case_id
   WHERE pr.id = p_referral_id AND c.org_id = v_org
   FOR UPDATE OF pr;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referral not found' USING ERRCODE = 'P0002';
  END IF;
  v_partner := public.program_referral_network_partner(v_org, v_row.from_global_partner_id);
  IF v_partner IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.global_partners g WHERE g.id = v_row.from_global_partner_id AND g.status = 'active') THEN
      RAISE EXCEPTION 'This program is no longer listed in the Directory. Add it to your network by hand.' USING ERRCODE = 'P0002';
    END IF;
    v_partner := public.import_global_partner(v_row.from_global_partner_id, gen_random_uuid());
    v_added := true;
  END IF;
  SELECT r.id INTO v_referral FROM public.referrals r
   WHERE r.org_id = v_org AND r.case_id = v_row.case_id AND r.partner_id = v_partner AND r.direction = 'inbound'
   ORDER BY r.created_at LIMIT 1;
  IF v_referral IS NULL THEN
    v_day := v_row.created_at::date;
    IF p_referred_on BETWEEN v_day - 1 AND v_day + 1 THEN v_day := p_referred_on; END IF;
    INSERT INTO public.referrals (owner_id, org_id, partner_id, direction, referred_on, client_label, outcome, note, case_id)
    VALUES (v_user, v_org, v_partner, 'inbound', v_day, left(coalesce(v_row.title, ''), 120), 'Pending',
            'Referred through ReferralFit.', v_row.case_id)
    RETURNING id INTO v_referral;
  END IF;
  RETURN jsonb_build_object('partner_id', v_partner, 'referral_id', v_referral, 'added_partner', v_added);
END
$$;
REVOKE ALL ON FUNCTION public.log_program_referral(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_program_referral(uuid, date) TO authenticated;

COMMIT;
