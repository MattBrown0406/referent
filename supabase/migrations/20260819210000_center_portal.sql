BEGIN;

-- Center portal accounts (Phase 4 of the platform buildout).
--
-- Treatment programs claim their directory listing with a single-use claim
-- code issued by a platform admin, then manage the listing themselves from
-- the web portal (portal/). Centers can edit listing content but never their
-- own verification state — status and verified_at stay admin-controlled.
-- Never pay-for-placement: a claim grants accuracy control, not ranking.

CREATE TABLE public.center_members (
  user_id           uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  global_partner_id uuid NOT NULL REFERENCES public.global_partners(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX center_members_listing_idx ON public.center_members (global_partner_id);

ALTER TABLE public.center_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "center_members: self read" ON public.center_members
  FOR SELECT USING (user_id = auth.uid());
REVOKE ALL ON public.center_members FROM anon, PUBLIC;
GRANT SELECT ON public.center_members TO authenticated;

CREATE TABLE public.center_claim_codes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_partner_id uuid NOT NULL REFERENCES public.global_partners(id) ON DELETE CASCADE,
  code              text NOT NULL UNIQUE CHECK (length(code) BETWEEN 8 AND 32),
  created_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  expires_at        timestamptz NOT NULL,
  claimed_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  claimed_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.center_claim_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "center_claim_codes: admin read" ON public.center_claim_codes
  FOR SELECT USING (public.is_platform_admin());
REVOKE ALL ON public.center_claim_codes FROM anon, PUBLIC;
GRANT SELECT ON public.center_claim_codes TO authenticated;

CREATE OR REPLACE FUNCTION public.current_center_listing_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$ SELECT global_partner_id FROM public.center_members WHERE user_id = auth.uid() $$;
REVOKE ALL ON FUNCTION public.current_center_listing_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_center_listing_id() TO authenticated;

-- Centers read and edit their own listing regardless of status.
CREATE POLICY "global_partners: center read own" ON public.global_partners
  FOR SELECT USING (id = public.current_center_listing_id());
CREATE POLICY "global_partners: center update own" ON public.global_partners
  FOR UPDATE USING (id = public.current_center_listing_id())
  WITH CHECK (id = public.current_center_listing_id());

-- Verification state is admin-only, whoever performs the update.
CREATE OR REPLACE FUNCTION public.guard_global_partner_verification()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_platform_admin() AND auth.uid() IS NOT NULL THEN
    NEW.status := OLD.status;
    NEW.verified_at := OLD.verified_at;
    -- Any content edit by the center invalidates nothing structurally, but
    -- flags the listing for re-review by clearing the verification stamp
    -- would be too aggressive; admins re-verify on their own cadence.
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.guard_global_partner_verification() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER global_partners_guard_verification
BEFORE UPDATE ON public.global_partners
FOR EACH ROW EXECUTE FUNCTION public.guard_global_partner_verification();

-- Admin issues a claim code for a listing (shared with the center off-band).
CREATE OR REPLACE FUNCTION public.create_center_claim_code(p_global_partner_id uuid)
RETURNS TABLE (code text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_code text;
  v_expires timestamptz := now() + interval '30 days';
BEGIN
  IF v_user IS NULL OR NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Only platform admins can issue claim codes' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.global_partners WHERE id = p_global_partner_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Directory listing not found' USING ERRCODE = 'P0002';
  END IF;

  v_code := lower(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 10));
  INSERT INTO public.center_claim_codes (global_partner_id, code, created_by, expires_at)
  VALUES (p_global_partner_id, v_code, v_user, v_expires);
  RETURN QUERY SELECT v_code, v_expires;
END
$$;

-- A center account redeems a claim code to bind itself to its listing.
CREATE OR REPLACE FUNCTION public.claim_center_listing(p_code text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_claim public.center_claim_codes%ROWTYPE;
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
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Claim code not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_claim.claimed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Claim code was already used' USING ERRCODE = '22023';
  END IF;
  IF v_claim.expires_at < now() THEN
    RAISE EXCEPTION 'Claim code has expired' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.center_members (user_id, global_partner_id)
  VALUES (v_user, v_claim.global_partner_id);
  UPDATE public.center_claim_codes
     SET claimed_by = v_user, claimed_at = now()
   WHERE id = v_claim.id;

  RETURN v_claim.global_partner_id;
END
$$;

-- How many practices have added this center's listing to their network.
-- Aggregate-only cross-tenant read, restricted to the center's own listing.
CREATE OR REPLACE FUNCTION public.center_listing_import_count()
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(DISTINCT org_id)::integer
    FROM public.partners
   WHERE global_partner_id = public.current_center_listing_id()
$$;

REVOKE ALL ON FUNCTION
  public.create_center_claim_code(uuid),
  public.claim_center_listing(text),
  public.center_listing_import_count()
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.create_center_claim_code(uuid),
  public.claim_center_listing(text),
  public.center_listing_import_count()
TO authenticated;

COMMIT;
