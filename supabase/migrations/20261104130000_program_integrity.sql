-- ReferralFit - Program Integrity Watch (2026-11-04).
--
-- Before a practitioner refers a family, they see whether a program's
-- credentials are on file, current and verified: its state license, its
-- accreditation (The Joint Commission, CARF, or another body), its
-- LegitScript certification and its NPI. This is the strongest protection
-- the app offers against patient brokering and bad actors. It never changes
-- a match's score or rank (src/lib/matching.ts never reads it).
--
--   1. program_credentials: one row per credential. A row belongs to EITHER
--      a directory listing (global_partner_id: shared, public business
--      information about the program) OR one of a practice's own partners
--      (partner_id + org_id: private to that workspace).
--   2. Reads: a listing's credentials are readable by any signed-in user
--      while the listing is active (its claimant and ReferralFit also see
--      them while it is pending or archived); a partner's are readable by its
--      workspace only. anon reads nothing. No client writes the table.
--      A listing credential's notes (the program's note and ReferralFit's
--      review note) are private: they live in program_credential_listing_
--      notes (no client grants), its row keeps both columns NULL, and only
--      the claimant and ReferralFit read them (fetch_listing_credential_
--      notes). A partner's notes stay on its row, inside the workspace.
--   3. Writes go through SECURITY DEFINER functions:
--        save_program_credential     add or edit (any change resets the
--                                    verification to pending, except that a
--                                    claimant's edit of a rejected listing
--                                    credential stays rejected until
--                                    ReferralFit reviews it again)
--        verify_program_credential   a listing's: platform admin only; a
--                                    partner's: the practitioner's own check
--        delete_program_credential   a claimant cannot remove a rejected
--                                    listing credential
--        record_npi_lookup           the name the public NPI Registry gave,
--                                    a hint only, never a verification; on
--                                    a listing's NPI, ReferralFit only
--      A platform admin may change any listing's credentials, a merged or
--      archived one included.
--   4. list_pending_listing_credentials: ReferralFit's review queue (new
--      and edited credentials, and rejected ones edited since the review).
--   5. program_credential_status and listing_credentials_verified: the
--      status rules and the directory badge, mirrored in src/lib/integrity.ts.
--   6. org_merge_linked_partner_copies keeps a joiner's checks on the
--      team's copy of a partner (same as 20261024120000 plus one line).
--
-- Credentials are public business information about programs, never client
-- data. The 1.0.4 app does not know this table; nothing it calls changes.
-- See docs/PROGRAM_INTEGRITY.md.
--
-- Transit rule: this file is pasted into the SQL editor from a chat client.
-- ASCII only, no backslash characters anywhere, every top-level statement
-- under 3,700 characters.

BEGIN;

-- Paste order: 20261104120000_family_cost.sql comes first. A skipped paste
-- stops here, before anything changes.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'case_benefits' AND column_name = 'in_deductible')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'vob_requests' AND column_name = 'allowed_daily_rate') THEN
    RAISE EXCEPTION 'Paste 20261104120000_family_cost.sql first: the case_benefits and vob_requests cost columns are missing.';
  END IF;
END
$$;

-- ===========================================================================
-- 1. Pure helpers (also used by the table's CHECK constraints)
-- ===========================================================================

-- A proof link: a full https:// address on a public host name (no user or
-- password part, no spaces). The app uses the same pattern
-- (src/lib/integrity.ts PROOF_URL_PATTERN; scripts/integrity-test.mjs
-- compares the two).
CREATE OR REPLACE FUNCTION public.is_valid_proof_url(p_url text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT p_url IS NOT NULL
     AND length(p_url) <= 500
     AND p_url ~ '^https://[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?([.][A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*[.][A-Za-z]{2,63}(:[0-9]{1,5})?([/?#][A-Za-z0-9._~:/?#@!&()*+,;=%-]*)?$'
$$;
REVOKE ALL ON FUNCTION public.is_valid_proof_url(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_valid_proof_url(text) TO authenticated, service_role;

-- An NPI: 10 digits whose last digit is the Luhn check digit of the number
-- with the 80840 prefix (the CMS rule; 1234567893 is valid).
CREATE OR REPLACE FUNCTION public.is_valid_npi(p_npi text)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v text;
  v_sum integer := 0;
  v_digit integer;
  v_double boolean := false;
  i integer;
BEGIN
  IF p_npi IS NULL OR p_npi !~ '^[0-9]{10}$' THEN
    RETURN false;
  END IF;
  v := '80840' || p_npi;
  FOR i IN REVERSE length(v)..1 LOOP
    v_digit := substr(v, i, 1)::integer;
    IF v_double THEN
      v_digit := v_digit * 2;
      IF v_digit > 9 THEN
        v_digit := v_digit - 9;
      END IF;
    END IF;
    v_sum := v_sum + v_digit;
    v_double := NOT v_double;
  END LOOP;
  RETURN v_sum % 10 = 0;
END
$$;
REVOKE ALL ON FUNCTION public.is_valid_npi(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_valid_npi(text) TO authenticated, service_role;

-- One credential's status on a given day. p_status is the stored review
-- (pending, verified, rejected), or NULL when there is no credential.
--   missing   nothing on file
--   rejected  the reviewer could not confirm it (whatever the dates say)
--   expired   pending or verified, but its expiration date has passed
--   expiring  pending or verified, and it expires within 30 days
--   verified  checked, and current
--   pending   on file, not checked yet
-- A credential is good through its expiration date (expires today is
-- expiring, not expired). Mirrored by credentialStatus in integrity.ts.
CREATE OR REPLACE FUNCTION public.program_credential_status(p_status text, p_expires_on date, p_today date)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN p_status IS NULL THEN 'missing'
    WHEN p_status = 'rejected' THEN 'rejected'
    WHEN p_expires_on IS NOT NULL AND p_expires_on < p_today THEN 'expired'
    WHEN p_expires_on IS NOT NULL AND p_expires_on <= p_today + 30 THEN 'expiring'
    WHEN p_status = 'verified' THEN 'verified'
    ELSE 'pending'
  END
$$;
REVOKE ALL ON FUNCTION public.program_credential_status(text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.program_credential_status(text, date, date) TO authenticated, service_role;

-- ===========================================================================
-- 2. The table
-- ===========================================================================

-- kind              state_license, accreditation, legitscript, npi
-- accreditor        accreditations only: joint_commission, carf, other
--                   (accreditor_name names an other body)
-- identifier        license / certificate / NPI number
-- issuing_state     state licenses only, two letters
-- expires_on        the last day it is good; NULL when none (an NPI)
-- proof_url         the issuer's public lookup page or record, https only
-- status            pending until checked; verified or rejected by
--                   ReferralFit (a listing's) or the practice (its own)
-- npi_lookup_name   the name the NPI Registry returned, a hint only
CREATE TABLE IF NOT EXISTS public.program_credentials (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_partner_id uuid REFERENCES public.global_partners(id) ON DELETE CASCADE,
  org_id            uuid REFERENCES public.orgs(id) ON DELETE CASCADE,
  partner_id        uuid,
  kind              text NOT NULL CHECK (kind IN ('state_license', 'accreditation', 'legitscript', 'npi')),
  accreditor        text CHECK (accreditor IN ('joint_commission', 'carf', 'other')),
  accreditor_name   text NOT NULL DEFAULT '' CHECK (length(accreditor_name) <= 120),
  identifier        text NOT NULL DEFAULT '' CHECK (length(identifier) <= 64),
  issuing_state     text NOT NULL DEFAULT '' CHECK (issuing_state = '' OR issuing_state ~ '^[A-Z]{2}$'),
  expires_on        date,
  proof_url         text CHECK (proof_url IS NULL OR public.is_valid_proof_url(proof_url)),
  note              text CHECK (length(note) <= 1000),
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
  verified_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  verified_at       timestamptz,
  verification_note text CHECK (length(verification_note) <= 1000),
  npi_lookup_name   text CHECK (npi_lookup_name IS NULL OR length(npi_lookup_name) <= 200),
  npi_checked_at    timestamptz,
  created_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT program_credentials_one_owner CHECK (
    (global_partner_id IS NOT NULL AND org_id IS NULL AND partner_id IS NULL)
    OR (global_partner_id IS NULL AND org_id IS NOT NULL AND partner_id IS NOT NULL)),
  CONSTRAINT program_credentials_partner_org_fk FOREIGN KEY (partner_id, org_id)
    REFERENCES public.partners (id, org_id) ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT program_credentials_kind_fields CHECK (
    (kind = 'accreditation') = (accreditor IS NOT NULL)
    AND (accreditor IS NOT DISTINCT FROM 'other' OR accreditor_name = '')
    AND (accreditor IS DISTINCT FROM 'other' OR btrim(accreditor_name) <> '')
    AND ((kind = 'state_license') = (issuing_state <> ''))
    AND (kind <> 'state_license' OR btrim(identifier) <> '')
    AND (kind <> 'npi' OR (public.is_valid_npi(identifier) AND expires_on IS NULL))
    AND (kind = 'npi' OR (npi_lookup_name IS NULL AND npi_checked_at IS NULL))
    AND (kind NOT IN ('accreditation', 'legitscript') OR btrim(identifier) <> '' OR proof_url IS NOT NULL)),
  CONSTRAINT program_credentials_review_consistent CHECK ((status = 'pending') = (verified_at IS NULL))
);

-- note, verification_note: a partner's are on its row ('' when empty). A
-- listing's are always NULL here: they are private to the program and
-- ReferralFit and live in program_credential_listing_notes (section 3).
ALTER TABLE public.program_credentials
  DROP CONSTRAINT IF EXISTS program_credentials_listing_notes_private,
  ADD CONSTRAINT program_credentials_listing_notes_private CHECK (
    CASE WHEN global_partner_id IS NOT NULL THEN note IS NULL AND verification_note IS NULL
         ELSE note IS NOT NULL AND verification_note IS NOT NULL END);

CREATE INDEX IF NOT EXISTS program_credentials_listing_idx ON public.program_credentials (global_partner_id, kind)
  WHERE global_partner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS program_credentials_partner_idx ON public.program_credentials (org_id, partner_id)
  WHERE partner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS program_credentials_review_queue_idx ON public.program_credentials (updated_at, id)
  WHERE global_partner_id IS NOT NULL AND status = 'pending';

COMMENT ON TABLE public.program_credentials IS
  'Program credentials (state license, accreditation, LegitScript, NPI): public business information about a program, never client data. A row belongs to a directory listing (shared) or to one practice partner (private to the workspace). Written only through save_program_credential, verify_program_credential, delete_program_credential and record_npi_lookup.';
COMMENT ON COLUMN public.program_credentials.npi_lookup_name IS
  'The name the public NPI Registry (NPPES) returned for this NPI when it was last checked. A hint for the person reading it, never a verification.';

-- ===========================================================================
-- 3. Who reads what (RLS) and the grants
-- ===========================================================================

-- SECURITY DEFINER: global_partners is entitlement-gated and center_members
-- is self-read only, yet a listing's credentials are readable by any
-- signed-in user while the listing is active, and by its claimant and
-- ReferralFit whatever its status.
CREATE OR REPLACE FUNCTION public.program_credentials_listing_visible(p_global_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_global_id IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.global_partners g WHERE g.id = p_global_id AND g.status = 'active')
    OR public.global_listing_claimed_by_caller(p_global_id)
    OR public.is_platform_admin()
  )
$$;
REVOKE ALL ON FUNCTION public.program_credentials_listing_visible(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.program_credentials_listing_visible(uuid) TO authenticated;

ALTER TABLE public.program_credentials ENABLE ROW LEVEL SECURITY;

-- Production's default ACL grants ALL on new tables: revoke first, then the
-- one narrow grant. There is no write policy, so even a stray grant writes
-- nothing; TRUNCATE (which RLS does not cover) is revoked here too.
REVOKE ALL ON TABLE public.program_credentials FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.program_credentials TO authenticated;
GRANT ALL ON TABLE public.program_credentials TO service_role;

DROP POLICY IF EXISTS "program_credentials: listing read" ON public.program_credentials;
CREATE POLICY "program_credentials: listing read" ON public.program_credentials
  FOR SELECT TO authenticated
  USING (global_partner_id IS NOT NULL AND public.program_credentials_listing_visible(global_partner_id));

DROP POLICY IF EXISTS "program_credentials: workspace read" ON public.program_credentials;
CREATE POLICY "program_credentials: workspace read" ON public.program_credentials
  FOR SELECT TO authenticated
  USING (org_id IS NOT NULL AND org_id = (SELECT public.current_org_id()));

-- A listing credential's notes: the program's own note and ReferralFit's
-- review note (why it could not be confirmed). Private to the listing's
-- claimant and ReferralFit, so they are kept off the readable table: no
-- client reads or writes this one (RLS on, no policy, no grant). The
-- writers keep it; fetch_listing_credential_notes reads it.
CREATE TABLE IF NOT EXISTS public.program_credential_listing_notes (
  credential_id     uuid PRIMARY KEY REFERENCES public.program_credentials(id) ON DELETE CASCADE,
  note              text NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  verification_note text NOT NULL DEFAULT '' CHECK (length(verification_note) <= 1000)
);
ALTER TABLE public.program_credential_listing_notes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.program_credential_listing_notes FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.program_credential_listing_notes TO service_role;
COMMENT ON TABLE public.program_credential_listing_notes IS
  'The private notes of a directory listing''s credential (the program''s note, ReferralFit''s review note). Read only through fetch_listing_credential_notes (the claimant and ReferralFit); no client grants.';

-- ===========================================================================
-- 4. Internal helpers for the writers
-- ===========================================================================

-- The first thing wrong with a credential, in plain words, or NULL. The
-- writers normalize first (an accreditor only on an accreditation, a state
-- only on a license, blank links as NULL). The app checks the same rules
-- before it sends anything (integrity.ts normalizeCredentialDraft).
CREATE OR REPLACE FUNCTION public.program_credential_problem(
  p_kind text, p_accreditor text, p_accreditor_name text, p_identifier text,
  p_issuing_state text, p_expires_on date, p_proof_url text, p_note text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_catalog
AS $$
  SELECT CASE
    WHEN p_kind IS NULL OR p_kind NOT IN ('state_license', 'accreditation', 'legitscript', 'npi')
      THEN 'Choose what kind of credential this is'
    WHEN p_kind = 'accreditation' AND (p_accreditor IS NULL OR p_accreditor NOT IN ('joint_commission', 'carf', 'other'))
      THEN 'Choose who accredits the program'
    WHEN p_accreditor = 'other' AND p_accreditor_name = '' THEN 'Name the accrediting body'
    WHEN length(p_accreditor_name) > 120 THEN 'The accrediting body name can be at most 120 characters'
    WHEN length(p_identifier) > 64 THEN 'The number can be at most 64 characters'
    WHEN p_kind = 'state_license' AND p_identifier = '' THEN 'Add the license number'
    WHEN p_kind = 'state_license' AND p_issuing_state !~ '^[A-Z]{2}$' THEN 'Choose the state that issued the license'
    WHEN p_kind = 'npi' AND NOT public.is_valid_npi(p_identifier)
      THEN 'An NPI is 10 digits and its last digit must check out. Check the number.'
    WHEN p_kind = 'npi' AND p_expires_on IS NOT NULL THEN 'An NPI does not expire. Leave the date blank.'
    WHEN p_kind IN ('accreditation', 'legitscript') AND p_identifier = '' AND p_proof_url IS NULL
      THEN 'Add the certificate number or a link to the public record'
    WHEN p_proof_url IS NOT NULL AND NOT public.is_valid_proof_url(p_proof_url)
      THEN 'The link must be a full https:// web address'
    WHEN p_expires_on IS NOT NULL AND (p_expires_on < DATE '2000-01-01' OR p_expires_on > DATE '2100-12-31')
      THEN 'Check the expiration date'
    WHEN length(p_note) > 1000 THEN 'The note can be at most 1,000 characters'
  END
$$;
REVOKE ALL ON FUNCTION public.program_credential_problem(text, text, text, text, text, date, text, text) FROM PUBLIC, anon, authenticated;

-- Who may change a credential. A listing's: its claimant (the center, or
-- the workspace that owns it as its profile) or a platform admin; only an
-- admin once the listing was merged into another. A partner's: any member
-- of that partner's workspace. Returns the workspace for a partner's
-- credential and NULL for a listing's; raises otherwise.
CREATE OR REPLACE FUNCTION public.program_credential_writer_scope(p_global_partner_id uuid, p_partner_id uuid)
RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_merged uuid;
BEGIN
  IF (p_global_partner_id IS NULL) = (p_partner_id IS NULL) THEN
    RAISE EXCEPTION 'A credential belongs to one directory listing or to one of your partners' USING ERRCODE = '22023';
  END IF;
  IF p_global_partner_id IS NOT NULL THEN
    SELECT g.merged_into INTO v_merged FROM public.global_partners g WHERE g.id = p_global_partner_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Directory listing not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT public.is_platform_admin() AND NOT public.global_listing_claimed_by_caller(p_global_partner_id) THEN
      RAISE EXCEPTION 'Only the program that claimed this listing, or ReferralFit, can change its credentials' USING ERRCODE = '42501';
    END IF;
    IF v_merged IS NOT NULL AND NOT public.is_platform_admin() THEN
      RAISE EXCEPTION 'This listing was merged into another. Update the credentials there.' USING ERRCODE = '22023';
    END IF;
    RETURN NULL;
  END IF;
  SELECT p.org_id INTO v_org FROM public.partners p
   WHERE p.id = p_partner_id AND p.org_id = public.current_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Partner not found in your workspace' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_org;
END
$$;
REVOKE ALL ON FUNCTION public.program_credential_writer_scope(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ===========================================================================
-- 5. Writers
-- ===========================================================================

-- Internal. A credential's fields as stored: trimmed, an accreditor only on
-- an accreditation (and a name only for another body), a state only on a
-- license (upper case), a blank link as NULL. Raises the first problem in
-- plain words (program_credential_problem).
CREATE OR REPLACE FUNCTION public.program_credential_fields(
  p_kind text, p_accreditor text, p_accreditor_name text, p_identifier text,
  p_issuing_state text, p_expires_on date, p_proof_url text, p_note text)
RETURNS public.program_credentials
LANGUAGE plpgsql IMMUTABLE
SET search_path = public
AS $$
DECLARE
  r public.program_credentials;
  v_problem text;
BEGIN
  r.kind := btrim(coalesce(p_kind, ''));
  r.accreditor := CASE WHEN r.kind = 'accreditation' THEN nullif(btrim(coalesce(p_accreditor, '')), '') END;
  r.accreditor_name := CASE WHEN r.accreditor = 'other' THEN btrim(coalesce(p_accreditor_name, '')) ELSE '' END;
  r.identifier := btrim(coalesce(p_identifier, ''));
  r.issuing_state := CASE WHEN r.kind = 'state_license' THEN upper(btrim(coalesce(p_issuing_state, ''))) ELSE '' END;
  r.expires_on := p_expires_on;
  r.proof_url := nullif(btrim(coalesce(p_proof_url, '')), '');
  r.note := btrim(coalesce(p_note, ''));
  v_problem := public.program_credential_problem(r.kind, r.accreditor, r.accreditor_name, r.identifier,
                                                 r.issuing_state, r.expires_on, r.proof_url, r.note);
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION '%', v_problem USING ERRCODE = '22023';
  END IF;
  RETURN r;
END
$$;
REVOKE ALL ON FUNCTION public.program_credential_fields(text, text, text, text, text, date, text, text) FROM PUBLIC, anon, authenticated;

-- Internal. Stores a listing credential's private notes. A NULL argument
-- keeps what is stored (a new row starts with '').
CREATE OR REPLACE FUNCTION public.program_credential_store_notes(p_id uuid, p_note text, p_verification_note text)
RETURNS void
LANGUAGE sql
SET search_path = public
AS $$
  INSERT INTO public.program_credential_listing_notes AS l (credential_id, note, verification_note)
  VALUES (p_id, coalesce(p_note, ''), coalesce(p_verification_note, ''))
  ON CONFLICT (credential_id) DO UPDATE
    SET note = coalesce(p_note, l.note), verification_note = coalesce(p_verification_note, l.verification_note)
$$;
REVOKE ALL ON FUNCTION public.program_credential_store_notes(uuid, text, text) FROM PUBLIC, anon, authenticated;

-- Internal (save_program_credential). Writes an edit: p_old is the stored
-- row, n the new fields. Any change resets the review to pending, except a
-- claimant's edit of a rejected listing credential: it stays rejected,
-- with ReferralFit's note, until ReferralFit reviews it again. The NPI
-- Registry hint stays only while the NPI is unchanged. A listing's note
-- goes to its private notes, never on the row.
CREATE OR REPLACE FUNCTION public.program_credential_write_edit(p_old public.program_credentials, n public.program_credentials, p_user uuid)
RETURNS public.program_credentials
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_row public.program_credentials%ROWTYPE;
  v_listing boolean := p_old.global_partner_id IS NOT NULL;
  v_keep_hint boolean := n.kind = 'npi' AND p_old.kind = 'npi' AND p_old.identifier = n.identifier;
  v_sticks boolean := p_old.global_partner_id IS NOT NULL AND p_old.status = 'rejected' AND NOT public.is_platform_admin();
BEGIN
  UPDATE public.program_credentials c
     SET kind = n.kind, accreditor = n.accreditor, accreditor_name = n.accreditor_name, identifier = n.identifier,
         issuing_state = n.issuing_state, expires_on = n.expires_on, proof_url = n.proof_url,
         note = CASE WHEN NOT v_listing THEN n.note END,
         status = CASE WHEN v_sticks THEN 'rejected' ELSE 'pending' END,
         verified_by = CASE WHEN v_sticks THEN c.verified_by END, verified_at = CASE WHEN v_sticks THEN c.verified_at END,
         verification_note = CASE WHEN NOT v_listing THEN '' END,
         npi_lookup_name = CASE WHEN v_keep_hint THEN p_old.npi_lookup_name END,
         npi_checked_at = CASE WHEN v_keep_hint THEN p_old.npi_checked_at END,
         updated_by = p_user, updated_at = now()
   WHERE c.id = p_old.id
  RETURNING * INTO v_row;
  IF v_listing THEN
    PERFORM public.program_credential_store_notes(p_old.id, n.note, CASE WHEN NOT v_sticks THEN '' END);
  END IF;
  RETURN v_row;
END
$$;
REVOKE ALL ON FUNCTION public.program_credential_write_edit(public.program_credentials, public.program_credentials, uuid) FROM PUBLIC, anon, authenticated;

-- Add (a new p_id) or edit a credential. The app makes the id, so a retry
-- is safe: the same values again change nothing. An edit resets the review
-- (program_credential_write_edit has the one exception). A listing's note
-- goes to its private notes. At most 20 credentials per listing or partner.
CREATE OR REPLACE FUNCTION public.save_program_credential(
  p_id uuid, p_global_partner_id uuid, p_partner_id uuid,
  p_kind text, p_accreditor text, p_accreditor_name text, p_identifier text,
  p_issuing_state text, p_expires_on date, p_proof_url text, p_note text)
RETURNS public.program_credentials
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid;
  v_old public.program_credentials%ROWTYPE;
  v_row public.program_credentials%ROWTYPE;
  n public.program_credentials;
  v_listing boolean := p_global_partner_id IS NOT NULL;
  v_old_note text;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'A credential id is required' USING ERRCODE = '22023';
  END IF;
  v_org := public.program_credential_writer_scope(p_global_partner_id, p_partner_id);
  n := public.program_credential_fields(p_kind, p_accreditor, p_accreditor_name, p_identifier,
                                        p_issuing_state, p_expires_on, p_proof_url, p_note);

  SELECT * INTO v_old FROM public.program_credentials WHERE id = p_id FOR UPDATE;
  IF FOUND THEN
    IF v_old.global_partner_id IS DISTINCT FROM p_global_partner_id OR v_old.partner_id IS DISTINCT FROM p_partner_id THEN
      RAISE EXCEPTION 'This credential belongs to another program' USING ERRCODE = '22023';
    END IF;
    v_old_note := CASE WHEN v_listing THEN coalesce((SELECT l.note FROM public.program_credential_listing_notes l WHERE l.credential_id = p_id), '')
                       ELSE v_old.note END;
    IF (v_old.kind, v_old.accreditor, v_old.accreditor_name, v_old.identifier, v_old.issuing_state, v_old.expires_on, v_old.proof_url, v_old_note)
       IS NOT DISTINCT FROM (n.kind, n.accreditor, n.accreditor_name, n.identifier, n.issuing_state, n.expires_on, n.proof_url, n.note) THEN
      RETURN v_old;
    END IF;
    RETURN public.program_credential_write_edit(v_old, n, v_user);
  END IF;

  IF (SELECT count(*) FROM public.program_credentials c
       WHERE c.global_partner_id = p_global_partner_id OR c.partner_id = p_partner_id) >= 20 THEN
    RAISE EXCEPTION 'A program can have at most 20 credentials. Remove an old one first.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.program_credentials (id, global_partner_id, org_id, partner_id, kind, accreditor, accreditor_name,
                                          identifier, issuing_state, expires_on, proof_url, note, verification_note, created_by, updated_by)
  VALUES (p_id, p_global_partner_id, v_org, p_partner_id, n.kind, n.accreditor, n.accreditor_name, n.identifier, n.issuing_state,
          n.expires_on, n.proof_url, CASE WHEN NOT v_listing THEN n.note END, CASE WHEN NOT v_listing THEN '' END, v_user, v_user)
  RETURNING * INTO v_row;
  IF v_listing THEN
    PERFORM public.program_credential_store_notes(p_id, n.note, '');
  END IF;
  RETURN v_row;
END
$$;
REVOKE ALL ON FUNCTION public.save_program_credential(uuid, uuid, uuid, text, text, text, text, text, date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_program_credential(uuid, uuid, uuid, text, text, text, text, text, date, text, text) TO authenticated;

-- Record a check. A listing's credential: ReferralFit only (a platform
-- admin, or the SQL editor), and declining one needs a note the program
-- can act on. A partner's: any member of its workspace, recording that they
-- checked it themselves. p_seen_updated_at, when given, must match the row:
-- a credential edited after the reviewer opened it is reviewed again. A
-- listing's review note goes to its private notes, never on the row.
CREATE OR REPLACE FUNCTION public.verify_program_credential(p_id uuid, p_verdict text, p_note text, p_seen_updated_at timestamptz DEFAULT NULL)
RETURNS public.program_credentials
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.program_credentials%ROWTYPE;
  v_note text := left(btrim(coalesce(p_note, '')), 1000);
BEGIN
  IF p_verdict IS NULL OR p_verdict NOT IN ('verified', 'rejected') THEN
    RAISE EXCEPTION 'Choose verified or could not confirm' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM public.program_credentials WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credential not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.global_partner_id IS NOT NULL THEN
    IF auth.uid() IS NOT NULL AND NOT public.is_platform_admin() THEN
      RAISE EXCEPTION 'Only ReferralFit can verify the credentials of a directory listing' USING ERRCODE = '42501';
    END IF;
    IF p_verdict = 'rejected' AND v_note = '' THEN
      RAISE EXCEPTION 'Add a note saying what could not be confirmed, so the program can fix it' USING ERRCODE = '22023';
    END IF;
  ELSIF auth.uid() IS NULL OR v_row.org_id IS DISTINCT FROM public.current_org_id() THEN
    RAISE EXCEPTION 'Credential not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_seen_updated_at IS NOT NULL AND v_row.updated_at <> p_seen_updated_at THEN
    RAISE EXCEPTION 'This credential changed after you opened it. Review it again.' USING ERRCODE = '22023';
  END IF;
  UPDATE public.program_credentials c
     SET status = p_verdict, verified_by = auth.uid(), verified_at = now(),
         verification_note = CASE WHEN c.global_partner_id IS NULL THEN v_note END
   WHERE c.id = p_id
  RETURNING * INTO v_row;
  IF v_row.global_partner_id IS NOT NULL THEN
    PERFORM public.program_credential_store_notes(p_id, NULL, v_note);
  END IF;
  RETURN v_row;
END
$$;
REVOKE ALL ON FUNCTION public.verify_program_credential(uuid, text, text, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_program_credential(uuid, text, text, timestamptz) TO authenticated;

-- Remove a credential (the same people who may edit it), with its private
-- notes. A listing credential ReferralFit rejected stays on record: only
-- ReferralFit removes it. Returns false when it is already gone, so a
-- retry is safe.
CREATE OR REPLACE FUNCTION public.delete_program_credential(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.program_credentials%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO v_row FROM public.program_credentials WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM public.program_credential_writer_scope(v_row.global_partner_id, v_row.partner_id);
  IF v_row.global_partner_id IS NOT NULL AND v_row.status = 'rejected' AND NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'ReferralFit could not confirm this credential, so it stays on record. Add an updated one and we will review it.'
      USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.program_credentials c WHERE c.id = p_id;
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.delete_program_credential(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_program_credential(uuid) TO authenticated;

-- Keep the name the public NPI Registry returned for an NPI credential, and
-- when. A hint for the reader only: it never changes the review. On a
-- listing's NPI, ReferralFit only (a platform admin, or the SQL editor):
-- the program cannot vouch for itself. On a partner's NPI, any member of
-- the partner's workspace.
CREATE OR REPLACE FUNCTION public.record_npi_lookup(p_id uuid, p_name text)
RETURNS public.program_credentials
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.program_credentials%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.program_credentials WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credential not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.global_partner_id IS NOT NULL THEN
    IF auth.uid() IS NOT NULL AND NOT public.is_platform_admin() THEN
      RAISE EXCEPTION 'Only ReferralFit can record the NPI Registry name on a directory listing' USING ERRCODE = '42501';
    END IF;
  ELSIF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  ELSE
    PERFORM public.program_credential_writer_scope(NULL, v_row.partner_id);
  END IF;
  IF v_row.kind <> 'npi' THEN
    RAISE EXCEPTION 'Only an NPI can be checked against the NPI Registry' USING ERRCODE = '22023';
  END IF;
  UPDATE public.program_credentials c
     SET npi_lookup_name = nullif(left(btrim(coalesce(p_name, '')), 200), ''), npi_checked_at = now()
   WHERE c.id = p_id
  RETURNING * INTO v_row;
  RETURN v_row;
END
$$;
REVOKE ALL ON FUNCTION public.record_npi_lookup(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_npi_lookup(uuid, text) TO authenticated;

-- ===========================================================================
-- 6. Readers
-- ===========================================================================

-- The credentials of up to 500 listings in one call (POST body, so a long
-- list of ids never hits a URL limit). SECURITY INVOKER: the read policies
-- above decide what comes back.
CREATE OR REPLACE FUNCTION public.fetch_listing_credentials(p_ids uuid[])
RETURNS SETOF public.program_credentials
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT c.*
    FROM public.program_credentials c
   WHERE c.global_partner_id = ANY ((coalesce(p_ids, ARRAY[]::uuid[]))[1:500])
   ORDER BY c.global_partner_id, c.kind, c.id
$$;
REVOKE ALL ON FUNCTION public.fetch_listing_credentials(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fetch_listing_credentials(uuid[]) TO authenticated;

-- A listing's credential notes (the program's note and ReferralFit's review
-- note, '' when empty), one row per credential: for the listing's claimant
-- (its center, or the workspace that owns it) and platform admins only.
-- Anyone else gets no rows.
CREATE OR REPLACE FUNCTION public.fetch_listing_credential_notes(p_global_partner_id uuid)
RETURNS TABLE (id uuid, note text, verification_note text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id, coalesce(l.note, ''), coalesce(l.verification_note, '')
    FROM public.program_credentials c
    LEFT JOIN public.program_credential_listing_notes l ON l.credential_id = c.id
   WHERE c.global_partner_id = p_global_partner_id
     AND (public.global_listing_claimed_by_caller(p_global_partner_id) OR public.is_platform_admin())
   ORDER BY c.kind, c.id
$$;
REVOKE ALL ON FUNCTION public.fetch_listing_credential_notes(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fetch_listing_credential_notes(uuid) TO authenticated;

-- The directory badge "Credentials verified": a state license that is
-- verified and current, AND an accreditation or a LegitScript certification
-- that is verified and current (current: not past its expiration date).
-- SECURITY INVOKER. Mirrored by programIntegrity(...).badge in integrity.ts.
CREATE OR REPLACE FUNCTION public.listing_credentials_verified(p_global_id uuid, p_today date)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
           SELECT 1 FROM public.program_credentials c
            WHERE c.global_partner_id = p_global_id AND c.kind = 'state_license' AND c.status = 'verified'
              AND public.program_credential_status(c.status, c.expires_on, p_today) IN ('verified', 'expiring'))
     AND EXISTS (
           SELECT 1 FROM public.program_credentials c
            WHERE c.global_partner_id = p_global_id AND c.kind IN ('accreditation', 'legitscript') AND c.status = 'verified'
              AND public.program_credential_status(c.status, c.expires_on, p_today) IN ('verified', 'expiring'))
$$;
REVOKE ALL ON FUNCTION public.listing_credentials_verified(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.listing_credentials_verified(uuid, date) TO authenticated;

-- ReferralFit's queue: every listing credential waiting for review (pending,
-- or rejected and edited by the program since; status_today reads rejected
-- for those), the longest-waiting first, with the listing it belongs to and
-- the program's private note. Platform admins only (or the SQL editor).
-- status_today is the status on the server's date, so an expired one
-- stands out.
CREATE OR REPLACE FUNCTION public.list_pending_listing_credentials()
RETURNS TABLE (id uuid, global_partner_id uuid, listing text, listing_state text, listing_website text, listing_status text,
               kind text, accreditor text, accreditor_name text, identifier text, issuing_state text, expires_on date,
               proof_url text, note text, npi_lookup_name text, npi_checked_at timestamptz, status_today text,
               created_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform admin required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT c.id, c.global_partner_id, coalesce(nullif(g.organization, ''), g.name), g.state, coalesce(g.website, ''), g.status,
         c.kind, c.accreditor, c.accreditor_name, c.identifier, c.issuing_state, c.expires_on,
         c.proof_url, coalesce(l.note, ''), c.npi_lookup_name, c.npi_checked_at,
         public.program_credential_status(c.status, c.expires_on, current_date),
         c.created_at, c.updated_at
    FROM public.program_credentials c
    JOIN public.global_partners g ON g.id = c.global_partner_id
    LEFT JOIN public.program_credential_listing_notes l ON l.credential_id = c.id
   WHERE c.status = 'pending' OR (c.status = 'rejected' AND c.updated_at > c.verified_at)
   ORDER BY c.updated_at, c.id;
END
$$;
REVOKE ALL ON FUNCTION public.list_pending_listing_credentials() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_pending_listing_credentials() TO authenticated;

-- ===========================================================================
-- 7. A joiner's checks follow the partner
-- ===========================================================================

-- Same as 20261024120000 (the only earlier definition), plus one line: a
-- joiner's own credentials on a partner the team already tracks move to the
-- team's copy instead of being deleted with the joiner's copy. (Every other
-- partner's credentials follow it to the team through the ON UPDATE CASCADE
-- foreign key when org_move_workspace_rows moves the partner.)
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
    UPDATE public.program_credentials SET partner_id = v_pair.keep_id, org_id = p_to WHERE org_id = p_from AND partner_id = v_pair.dup_id;
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

COMMIT;
