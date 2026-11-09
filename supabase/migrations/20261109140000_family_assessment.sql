-- ReferralFit - the family assessment (docs/FAMILY_ASSESSMENT.md).
--
-- A practitioner sends a family a private link to a full intake assessment,
-- branded with the practice's name and logo. The family fills it in on the
-- portal's /f page (signed out), can stop and come back, uploads the
-- insurance card, signs one consent, and submits. The answers land on the
-- case, for the practitioner to read and rate the level of care (by hand,
-- or with an AI suggestion on their own key).
--
--   1. orgs.logo_path and the public org-logos bucket: a practice's logo,
--      set by its owner (set_org_logo).
--   2. family_assessments: one row per assessment, tied to a case. Org
--      members read it (RLS, through the case's org, so it moves with the
--      case); nobody writes it directly. Answers, the consent and the
--      signature are written only through the functions below.
--   3. family_assessment_links: the sha256 of each 256-bit link token,
--      never the token (as answer links and handoffs). The five newest
--      links of an assessment work.
--   4. The private assessment-files bucket for insurance card photos, under
--      <case id>/<assessment id>/. Org members of the case read and delete;
--      no client uploads: the family uploads through a signed URL the
--      family-assessment-upload function makes after checking the link.
--   5. Practitioner functions: family_assessment_send (a new link, by email
--      through Resend or to copy), family_assessment_revoke,
--      family_assessment_delete.
--   6. The family's page (anon, the token alone):
--      public_family_assessment_open / _save / _photo_done / _submit.
--   7. Two emails on the outbox: the invite to the family (the practice's
--      name, its logo, replies to the practitioner) and "submitted" to the
--      practitioner. Neither says anything about the client or the answers.
--
-- Transit-safe: ASCII only, no backslashes, every statement under 3,700
-- characters. Safe to re-run.

BEGIN;

-- ===========================================================================
-- 1. The practice's logo
-- ===========================================================================

ALTER TABLE public.orgs ADD COLUMN IF NOT EXISTS logo_path text;
ALTER TABLE public.orgs DROP CONSTRAINT IF EXISTS orgs_logo_path_check;
ALTER TABLE public.orgs ADD CONSTRAINT orgs_logo_path_check
  CHECK (logo_path IS NULL OR logo_path ~ '^[0-9a-f-]{36}/logo-[0-9]{10,16}[.](png|jpg|webp)$');

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('org-logos', 'org-logos', true, 1048576, ARRAY['image/png', 'image/jpeg', 'image/webp']::text[])
ON CONFLICT (id) DO UPDATE
  SET public = true, file_size_limit = 1048576, allowed_mime_types = ARRAY['image/png', 'image/jpeg', 'image/webp']::text[];

-- Only the practice's owner adds or removes its logo, in its own folder.
-- Files are never overwritten (each upload has a new name), so no update.
DROP POLICY IF EXISTS "org logos: owner insert" ON storage.objects;
DROP POLICY IF EXISTS "org logos: owner delete" ON storage.objects;
CREATE POLICY "org logos: owner insert" ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'org-logos'
    AND (storage.foldername(name))[1] = public.current_org_id()::text
    AND public.current_org_role() = 'owner'
  );
CREATE POLICY "org logos: owner delete" ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'org-logos'
    AND (storage.foldername(name))[1] = public.current_org_id()::text
    AND public.current_org_role() = 'owner'
  );

-- The owner sets (or with NULL clears) the logo the family sees. The file
-- must already be in the practice's own folder.
CREATE OR REPLACE FUNCTION public.set_org_logo(p_path text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.current_org_id();
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF public.current_org_role() <> 'owner' THEN
    RAISE EXCEPTION 'Only the practice owner can change the logo' USING ERRCODE = '42501';
  END IF;
  IF p_path IS NOT NULL THEN
    IF split_part(p_path, '/', 1) <> v_org::text
       OR p_path !~ '^[0-9a-f-]{36}/logo-[0-9]{10,16}[.](png|jpg|webp)$' THEN
      RAISE EXCEPTION 'That is not a logo for this practice' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'org-logos' AND o.name = p_path) THEN
      RAISE EXCEPTION 'Upload the logo first' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  UPDATE public.orgs SET logo_path = p_path WHERE id = v_org;
  RETURN p_path;
END
$$;
REVOKE ALL ON FUNCTION public.set_org_logo(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_org_logo(text) TO authenticated;

-- ===========================================================================
-- 2. Assessments
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.family_assessments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id         uuid NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  recipient_name  text NOT NULL DEFAULT '' CHECK (length(recipient_name) <= 120),
  recipient_email text NOT NULL DEFAULT '' CHECK (length(recipient_email) <= 254),
  status          text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'started', 'submitted', 'revoked')),
  answers         jsonb NOT NULL DEFAULT '{}'::jsonb
                  CHECK (jsonb_typeof(answers) = 'object' AND pg_column_size(answers) <= 262144),
  step            integer NOT NULL DEFAULT 0 CHECK (step BETWEEN 0 AND 40),
  card_front_at   timestamptz,
  card_back_at    timestamptz,
  urgent          text[] NOT NULL DEFAULT '{}',
  consent_name    text CHECK (consent_name IS NULL OR length(consent_name) BETWEEN 2 AND 120),
  consent_version text,
  consent_text    text CHECK (consent_text IS NULL OR length(consent_text) <= 6000),
  consent_at      timestamptz,
  consent_client  text CHECK (consent_client IS NULL OR length(consent_client) <= 300),
  created_at      timestamptz NOT NULL DEFAULT now(),
  emailed_at      timestamptz,
  started_at      timestamptz,
  last_saved_at   timestamptz,
  submitted_at    timestamptz,
  revoked_at      timestamptz,
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '30 days',
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS family_assessments_case_idx ON public.family_assessments (case_id, created_at DESC);
DROP TRIGGER IF EXISTS family_assessments_updated_at ON public.family_assessments;
CREATE TRIGGER family_assessments_updated_at BEFORE UPDATE ON public.family_assessments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Org members read the assessments of their practice's cases. No client
-- writes: every change goes through a function below.
ALTER TABLE public.family_assessments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.family_assessments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.family_assessments TO authenticated;
GRANT ALL ON TABLE public.family_assessments TO service_role;
DROP POLICY IF EXISTS "family assessments: org read" ON public.family_assessments;
CREATE POLICY "family assessments: org read" ON public.family_assessments FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.cases c WHERE c.id = case_id AND c.org_id = public.current_org_id()));

COMMENT ON TABLE public.family_assessments IS
  'A family assessment sent to a family by private link (docs/FAMILY_ASSESSMENT.md). PHI: org members of the case read it; written only through the family_assessment functions.';

-- ===========================================================================
-- 3. Links
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.family_assessment_links (
  token_hash    bytea PRIMARY KEY,
  assessment_id uuid NOT NULL REFERENCES public.family_assessments(id) ON DELETE CASCADE,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS family_assessment_links_assessment_idx
  ON public.family_assessment_links (assessment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS family_assessment_links_creator_idx
  ON public.family_assessment_links (created_by, created_at DESC);
ALTER TABLE public.family_assessment_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.family_assessment_links FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.family_assessment_links TO service_role;

-- The assessment a token opens while it can still be filled in or shows
-- "submitted", or NULL (a wrong, cut-off, retired, revoked or expired link).
CREATE OR REPLACE FUNCTION public.family_assessment_for_token(p_token text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.id
    FROM public.family_assessment_links l
    JOIN public.family_assessments a ON a.id = l.assessment_id
   WHERE coalesce(p_token, '') ~ '^[0-9a-f]{64}$'
     AND l.token_hash = extensions.digest(p_token, 'sha256')
     AND a.status <> 'revoked'
     AND (a.status = 'submitted' OR a.expires_at > now())
$$;
REVOKE ALL ON FUNCTION public.family_assessment_for_token(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.family_assessment_for_token(text) TO service_role;

-- ===========================================================================
-- 4. Insurance card photos
-- ===========================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('assessment-files', 'assessment-files', false, 10485760,
        ARRAY['image/jpeg', 'image/png', 'image/heic', 'image/webp']::text[])
ON CONFLICT (id) DO UPDATE
  SET public = false, file_size_limit = 10485760,
      allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/heic', 'image/webp']::text[];

DROP POLICY IF EXISTS "assessment files: org read" ON storage.objects;
DROP POLICY IF EXISTS "assessment files: org delete" ON storage.objects;
CREATE POLICY "assessment files: org read" ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'assessment-files' AND public.is_org_case_folder((storage.foldername(name))[1]));
CREATE POLICY "assessment files: org delete" ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'assessment-files' AND public.is_org_case_folder((storage.foldername(name))[1]));

-- Where a card photo goes, for the upload function (service role) after it
-- checks the link: NULL when the link cannot take uploads.
CREATE OR REPLACE FUNCTION public.family_assessment_upload_path(p_token text, p_side text)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.case_id::text || '/' || a.id::text || '/card-' || p_side
    FROM public.family_assessments a
   WHERE a.id = public.family_assessment_for_token(p_token)
     AND a.status IN ('sent', 'started')
     AND p_side IN ('front', 'back')
$$;
REVOKE ALL ON FUNCTION public.family_assessment_upload_path(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.family_assessment_upload_path(text, text) TO service_role;

-- ===========================================================================
-- 5. The consent the family signs (one, for everything)
-- ===========================================================================

-- The current consent version and its words, with the practice's name. The
-- family's page shows exactly this, and the signed copy keeps it.
CREATE OR REPLACE FUNCTION public.family_assessment_consent_version()
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$ SELECT '2026-11-08' $$;
REVOKE ALL ON FUNCTION public.family_assessment_consent_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.family_assessment_consent_version() TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.family_assessment_consent_text(p_practice text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT concat_ws(chr(10) || chr(10),
    'I am sharing this information to help find the right care for my loved one. By checking the box and typing my name, I agree that:',
    '1. ' || p_practice || ' may use everything I share in this assessment, including names, dates of birth, insurance details, and health, mental health and substance use information, to understand my loved one''s needs and plan care.',
    '2. ' || p_practice || ' may share this information with other ethical, licensed treatment providers and professionals, such as treatment programs, detox and sober living providers, therapists, physicians and interventionists, to determine the best fit and find additional resources for my loved one. ' || p_practice || ' will share only what is needed for that purpose.',
    '3. Once a provider receives the information, that provider''s own privacy rules apply to it, and it may no longer be protected in the same way.',
    '4. This consent lasts one year from today unless I withdraw it sooner. I can withdraw it at any time by telling ' || p_practice || ' in writing. Withdrawing does not undo sharing that already happened.',
    '5. I do not have to sign this. If I do not, I can still talk with ' || p_practice || ' about other ways to get help, but this assessment will not be sent.',
    '6. What I share is true to the best of my knowledge. Typing my name is my electronic signature, and I may keep a copy of this page.')
$$;
REVOKE ALL ON FUNCTION public.family_assessment_consent_text(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.family_assessment_consent_text(text) TO anon, authenticated, service_role;

-- The practice's name as the family sees it.
CREATE OR REPLACE FUNCTION public.family_assessment_practice(p_assessment_id uuid)
RETURNS TABLE (practice_name text, logo_path text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(nullif(btrim(o.name), ''), 'Your practitioner'), o.logo_path
    FROM public.family_assessments a
    JOIN public.cases c ON c.id = a.case_id
    JOIN public.orgs o ON o.id = c.org_id
   WHERE a.id = p_assessment_id
$$;
REVOKE ALL ON FUNCTION public.family_assessment_practice(uuid) FROM PUBLIC, anon, authenticated;

-- ===========================================================================
-- 6. The practitioner's side
-- ===========================================================================

-- A new link for a case's assessment: the case's open assessment (sent or
-- started) gets a fresh link and 30 more days, or a new one is made. With
-- p_email, the invite also goes out by email (Resend) to that address.
-- Returns the assessment id, the token (64 hex; only its hash is kept) and
-- when the link stops working. At most 40 links a day per practitioner.
CREATE OR REPLACE FUNCTION public.family_assessment_send(p_case_id uuid, p_name text, p_email text, p_send_email boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_id uuid;
  v_token text;
  v_expires timestamptz := now() + interval '30 days';
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cases c WHERE c.id = p_case_id AND c.org_id = public.current_org_id()) THEN
    RAISE EXCEPTION 'That case is not in your practice' USING ERRCODE = 'P0002';
  END IF;
  IF length(v_name) > 120 THEN
    RAISE EXCEPTION 'The name is too long' USING ERRCODE = '22023';
  END IF;
  IF v_email <> '' AND (length(v_email) > 254 OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$') THEN
    RAISE EXCEPTION 'Check the email address' USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_send_email, false) AND v_email = '' THEN
    RAISE EXCEPTION 'Add the email address to send it to' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM public.family_assessment_links l
       WHERE l.created_by = v_user AND l.created_at > now() - interval '24 hours') >= 40 THEN
    RAISE EXCEPTION 'You have sent many assessment links today. Try again tomorrow.' USING ERRCODE = '54000';
  END IF;

  SELECT a.id INTO v_id FROM public.family_assessments a
   WHERE a.case_id = p_case_id AND a.status IN ('sent', 'started')
   ORDER BY a.created_at DESC LIMIT 1 FOR UPDATE;
  IF v_id IS NULL THEN
    INSERT INTO public.family_assessments (case_id, created_by, recipient_name, recipient_email, expires_at)
    VALUES (p_case_id, v_user, v_name, v_email, v_expires)
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.family_assessments a
       SET recipient_name = CASE WHEN v_name <> '' THEN v_name ELSE a.recipient_name END,
           recipient_email = CASE WHEN v_email <> '' THEN v_email ELSE a.recipient_email END,
           expires_at = v_expires
     WHERE a.id = v_id;
  END IF;

  v_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  INSERT INTO public.family_assessment_links (token_hash, assessment_id, created_by)
  VALUES (extensions.digest(v_token, 'sha256'), v_id, v_user);
  DELETE FROM public.family_assessment_links l
   WHERE l.assessment_id = v_id
     AND l.token_hash NOT IN (SELECT k.token_hash FROM public.family_assessment_links k
                               WHERE k.assessment_id = v_id
                               ORDER BY k.created_at DESC, k.token_hash LIMIT 5);

  IF coalesce(p_send_email, false) THEN
    PERFORM public.email_enqueue(v_user, 'family_assessment_invite',
      jsonb_build_object('assessment_id', v_id, 'link_token', v_token));
    UPDATE public.family_assessments SET emailed_at = now() WHERE id = v_id;
  END IF;
  RETURN jsonb_build_object('id', v_id, 'token', v_token, 'expires_at', v_expires);
END
$$;
REVOKE ALL ON FUNCTION public.family_assessment_send(uuid, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.family_assessment_send(uuid, text, text, boolean) TO authenticated;

-- Stop an assessment's links. What the family already saved stays on the case.
CREATE OR REPLACE FUNCTION public.family_assessment_revoke(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  UPDATE public.family_assessments a SET status = 'revoked', revoked_at = now()
   WHERE a.id = p_id AND a.status IN ('sent', 'started')
     AND EXISTS (SELECT 1 FROM public.cases c WHERE c.id = a.case_id AND c.org_id = public.current_org_id());
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That assessment cannot be stopped' USING ERRCODE = 'P0002';
  END IF;
  DELETE FROM public.family_assessment_links WHERE assessment_id = p_id;
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.family_assessment_revoke(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.family_assessment_revoke(uuid) TO authenticated;

-- Delete an assessment and its answers for good. The app removes the card
-- photos first (the org delete policy on assessment-files).
CREATE OR REPLACE FUNCTION public.family_assessment_delete(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  DELETE FROM public.family_assessments a
   WHERE a.id = p_id
     AND EXISTS (SELECT 1 FROM public.cases c WHERE c.id = a.case_id AND c.org_id = public.current_org_id());
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That assessment is not in your practice' USING ERRCODE = 'P0002';
  END IF;
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.family_assessment_delete(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.family_assessment_delete(uuid) TO authenticated;

-- ===========================================================================
-- 7. The family's page (signed out, the token alone)
-- ===========================================================================

-- What the page shows: the practice's name and logo, the consent, and, while
-- the assessment is open, what the family saved so far. After it is
-- submitted the answers are never shown again by link (a forwarded email
-- reveals nothing). NULL for a link that does not work.
CREATE OR REPLACE FUNCTION public.public_family_assessment_open(p_token text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid := public.family_assessment_for_token(p_token);
  a public.family_assessments%ROWTYPE;
  p record;
BEGIN
  IF v_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO a FROM public.family_assessments WHERE id = v_id;
  SELECT * INTO p FROM public.family_assessment_practice(v_id);
  IF a.status = 'submitted' THEN
    RETURN jsonb_build_object('status', 'submitted', 'practice_name', p.practice_name, 'logo_path', p.logo_path,
                              'submitted_at', a.submitted_at);
  END IF;
  RETURN jsonb_build_object(
    'status', 'open',
    'practice_name', p.practice_name,
    'logo_path', p.logo_path,
    'recipient_name', a.recipient_name,
    'answers', a.answers,
    'step', a.step,
    'card_front', a.card_front_at IS NOT NULL,
    'card_back', a.card_back_at IS NOT NULL,
    'consent_version', public.family_assessment_consent_version(),
    'consent_text', public.family_assessment_consent_text(p.practice_name),
    'expires_at', a.expires_at,
    'last_saved_at', a.last_saved_at);
END
$$;
REVOKE ALL ON FUNCTION public.public_family_assessment_open(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_family_assessment_open(text) TO anon, authenticated;

-- The answers, as the family has them so far (the whole object each time),
-- and the step they are on, so they can stop and come back.
CREATE OR REPLACE FUNCTION public.public_family_assessment_save(p_token text, p_answers jsonb, p_step integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid := public.family_assessment_for_token(p_token);
  v_at timestamptz := now();
BEGIN
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'This link is not active' USING ERRCODE = 'P0002';
  END IF;
  IF p_answers IS NULL OR jsonb_typeof(p_answers) <> 'object' OR pg_column_size(p_answers) > 262144 THEN
    RAISE EXCEPTION 'The answers could not be saved. They may be too long.' USING ERRCODE = '22023';
  END IF;
  UPDATE public.family_assessments a
     SET answers = p_answers,
         step = greatest(0, least(coalesce(p_step, a.step), 40)),
         status = 'started',
         started_at = coalesce(a.started_at, v_at),
         last_saved_at = v_at
   WHERE a.id = v_id AND a.status IN ('sent', 'started');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This assessment was already sent to your practitioner' USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_build_object('saved_at', v_at);
END
$$;
REVOKE ALL ON FUNCTION public.public_family_assessment_save(text, jsonb, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_family_assessment_save(text, jsonb, integer) TO anon, authenticated;

-- After the page uploads a card photo through its signed URL: confirms the
-- file is there and marks that side done.
CREATE OR REPLACE FUNCTION public.public_family_assessment_photo_done(p_token text, p_side text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid := public.family_assessment_for_token(p_token);
  v_path text := public.family_assessment_upload_path(p_token, p_side);
BEGIN
  IF v_id IS NULL OR v_path IS NULL THEN
    RAISE EXCEPTION 'This link is not active' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'assessment-files' AND o.name = v_path) THEN
    RAISE EXCEPTION 'The photo did not arrive. Try again.' USING ERRCODE = 'P0002';
  END IF;
  UPDATE public.family_assessments a
     SET card_front_at = CASE WHEN p_side = 'front' THEN now() ELSE a.card_front_at END,
         card_back_at = CASE WHEN p_side = 'back' THEN now() ELSE a.card_back_at END,
         status = 'started', started_at = coalesce(a.started_at, now()), last_saved_at = now()
   WHERE a.id = v_id;
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.public_family_assessment_photo_done(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_family_assessment_photo_done(text, text) TO anon, authenticated;

-- Answers that suggest someone may be in danger now: the same rules as
-- safetyFlags in src/lib/assessment-schema.ts (keep the two in step).
CREATE OR REPLACE FUNCTION public.family_assessment_urgent(p_answers jsonb)
RETURNS text[]
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT array_remove(ARRAY[
    CASE WHEN btrim(coalesce(p_answers ->> 'suicideIdeation', '')) = 'yes' THEN 'suicidal_thoughts' END,
    CASE WHEN btrim(coalesce(p_answers ->> 'homicidalIdeation', '')) = 'yes' THEN 'homicidal_thoughts' END,
    CASE WHEN btrim(coalesce(p_answers ->> 'urgencyLevel', '')) = 'crisis' THEN 'crisis' END,
    CASE WHEN jsonb_typeof(p_answers -> 'immediateSafetyConcerns') = 'string'
              AND regexp_replace(lower(btrim(p_answers ->> 'immediateSafetyConcerns')), '[.![:space:]]+$', '') <> ''
              AND regexp_replace(lower(btrim(p_answers ->> 'immediateSafetyConcerns')), '[.![:space:]]+$', '')
                  !~ '^(none|no|nope|n/?a|na|not applicable|nothing|no concerns?|none at this time|none currently|not at this time|-+)$'
         THEN 'safety_concern' END
  ], NULL)
$$;
REVOKE ALL ON FUNCTION public.family_assessment_urgent(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.family_assessment_urgent(jsonb) TO authenticated, service_role;

-- The family sends the assessment: the final answers, the consent box
-- checked, their typed full name as the signature, and the consent version
-- they read. The signed words are kept with it. The practitioner who sent
-- it (or the practice's owner) gets an email; urgent answers say so.
CREATE OR REPLACE FUNCTION public.public_family_assessment_submit(
  p_token text, p_answers jsonb, p_agreed boolean, p_name text, p_consent_version text, p_client text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid := public.family_assessment_for_token(p_token);
  v_name text := btrim(coalesce(p_name, ''));
  v_at timestamptz := now();
  v_urgent text[];
  v_practice text;
  v_to uuid;
  v_case uuid;
BEGIN
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'This link is not active' USING ERRCODE = 'P0002';
  END IF;
  IF p_answers IS NULL OR jsonb_typeof(p_answers) <> 'object' OR pg_column_size(p_answers) > 262144 THEN
    RAISE EXCEPTION 'The answers could not be sent. They may be too long.' USING ERRCODE = '22023';
  END IF;
  IF NOT coalesce(p_agreed, false) THEN
    RAISE EXCEPTION 'Check the box to agree before sending' USING ERRCODE = '22023';
  END IF;
  IF length(v_name) < 2 OR length(v_name) > 120 THEN
    RAISE EXCEPTION 'Type your full name to sign' USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_consent_version, '') <> public.family_assessment_consent_version() THEN
    RAISE EXCEPTION 'The consent was updated. Reload the page to read it, then sign.' USING ERRCODE = '22023';
  END IF;
  SELECT practice_name INTO v_practice FROM public.family_assessment_practice(v_id);
  v_urgent := public.family_assessment_urgent(p_answers);
  UPDATE public.family_assessments a
     SET answers = p_answers, status = 'submitted', submitted_at = v_at, last_saved_at = v_at,
         started_at = coalesce(a.started_at, v_at), urgent = v_urgent,
         consent_name = v_name, consent_version = public.family_assessment_consent_version(),
         consent_text = public.family_assessment_consent_text(v_practice), consent_at = v_at,
         consent_client = left(btrim(coalesce(p_client, '')), 300)
   WHERE a.id = v_id AND a.status IN ('sent', 'started')
  RETURNING a.created_by, a.case_id INTO v_to, v_case;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This assessment was already sent to your practitioner' USING ERRCODE = '22023';
  END IF;
  -- The practitioner who sent it, while still in the practice; else its owner.
  SELECT coalesce(
           (SELECT m.user_id FROM public.org_members m WHERE m.user_id = v_to AND m.org_id = c.org_id),
           (SELECT m.user_id FROM public.org_members m WHERE m.org_id = c.org_id AND m.role = 'owner' ORDER BY m.user_id LIMIT 1))
    INTO v_to
    FROM public.cases c WHERE c.id = v_case;
  PERFORM public.email_enqueue(v_to, 'family_assessment_submitted', jsonb_build_object('assessment_id', v_id));
  RETURN jsonb_build_object('submitted_at', v_at, 'urgent', cardinality(v_urgent) > 0);
END
$$;
REVOKE ALL ON FUNCTION public.public_family_assessment_submit(text, jsonb, boolean, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_family_assessment_submit(text, jsonb, boolean, text, text, text) TO anon, authenticated;

-- ===========================================================================
-- 8. The emails (on the outbox from 20261108120000)
-- ===========================================================================

ALTER TABLE public.email_outbox DROP CONSTRAINT IF EXISTS email_outbox_kind_check;
ALTER TABLE public.email_outbox ADD CONSTRAINT email_outbox_kind_check
  CHECK (kind IN ('placement_response', 'daily_summary', 'bed_reminder', 'claim_request', 'claim_decision',
                  'family_assessment_invite', 'family_assessment_submitted'));

-- Same as 20261108150000 plus the two assessment emails, which a person
-- asked for by acting (sending one), so they are always wanted.
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
           WHEN 'family_assessment_invite' THEN true
           WHEN 'family_assessment_submitted' THEN true
           ELSE false END
$$;
REVOKE ALL ON FUNCTION public.email_wanted(uuid, text) FROM PUBLIC, anon, authenticated, service_role;

-- Who an assessment email goes to and what it may say, or NULL when it
-- should no longer go out (stopped, expired, or not submitted). The invite
-- goes to the family's address and replies reach the practitioner (p_user_email).
CREATE OR REPLACE FUNCTION public.email_family_assessment_details(p_kind text, p_data jsonb, p_user_email text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a public.family_assessments%ROWTYPE;
  p record;
BEGIN
  IF coalesce(p_data ->> 'assessment_id', '') !~ '^[0-9a-f-]{36}$' THEN RETURN NULL; END IF;
  SELECT * INTO a FROM public.family_assessments x WHERE x.id = (p_data ->> 'assessment_id')::uuid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_kind = 'family_assessment_invite' THEN
    IF a.status NOT IN ('sent', 'started') OR a.expires_at <= now() OR a.recipient_email = '' THEN RETURN NULL; END IF;
    SELECT * INTO p FROM public.family_assessment_practice(a.id);
    RETURN jsonb_build_object('to', a.recipient_email, 'data', jsonb_build_object(
      'practice_name', p.practice_name, 'logo_path', p.logo_path, 'reply_to', p_user_email,
      'recipient_name', a.recipient_name, 'expires_at', a.expires_at));
  END IF;
  IF p_kind = 'family_assessment_submitted' AND a.status = 'submitted' THEN
    RETURN jsonb_build_object('to', p_user_email, 'data', jsonb_build_object('urgent', cardinality(a.urgent) > 0));
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.email_family_assessment_details(text, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;

-- Same as 20261108170000 plus the assessment emails: they stop when the
-- assessment can no longer be filled in (the invite) or was not sent.
CREATE OR REPLACE FUNCTION public.email_prepare_problem(o public.email_outbox)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req record;
BEGIN
  IF NOT public.email_wanted(o.user_id, o.kind) THEN RETURN 'unsubscribed'; END IF;
  IF o.kind = 'placement_response' THEN
    SELECT r.status, r.org_id INTO v_req FROM public.placement_requests r WHERE r.id = (o.data ->> 'placement_request_id')::uuid;
    IF NOT FOUND OR v_req.status <> 'open' THEN RETURN 'request_closed'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.org_members m WHERE m.org_id = v_req.org_id AND m.user_id = o.user_id) THEN
      RETURN 'not_member';
    END IF;
  ELSIF o.kind = 'daily_summary' THEN
    IF o.created_at < now() - interval '3 hours' THEN RETURN 'expired'; END IF;
  ELSIF o.kind = 'bed_reminder' THEN
    IF NOT public.bed_reminder_eligible(o.user_id, (o.data ->> 'global_partner_id')::uuid) THEN RETURN 'not_eligible'; END IF;
  ELSIF o.kind IN ('claim_request', 'claim_decision') THEN
    IF public.email_claim_details(o.kind, o.data) IS NULL THEN RETURN 'not_pending'; END IF;
    IF o.kind = 'claim_request' AND NOT EXISTS (SELECT 1 FROM public.platform_admins a WHERE a.user_id = o.user_id) THEN
      RETURN 'not_admin';
    END IF;
  ELSIF o.kind IN ('family_assessment_invite', 'family_assessment_submitted') THEN
    IF public.email_family_assessment_details(o.kind, o.data, '') IS NULL THEN RETURN 'not_open'; END IF;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.email_prepare_problem(public.email_outbox) FROM PUBLIC, anon, authenticated, service_role;

-- Same as 20261108170000 plus the assessment emails: the family's address
-- ('to'), the practice's name and logo, and the practitioner to reply to.
CREATE OR REPLACE FUNCTION public.email_prepare_data(o public.email_outbox)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_data jsonb := o.data;
  v_details jsonb;
BEGIN
  IF o.kind = 'placement_response' THEN
    SELECT v_data || jsonb_build_object('asked', count(*),
             'answered', count(*) FILTER (WHERE x.status IN ('responded', 'declined')))
      INTO v_data
      FROM public.placement_request_recipients x WHERE x.request_id = (o.data ->> 'placement_request_id')::uuid;
  ELSIF o.kind = 'bed_reminder' THEN
    SELECT v_data || jsonb_build_object(
             'listing_name', public.listing_display_name(g.id), 'beds_male', g.beds_male, 'beds_female', g.beds_female,
             'beds_updated_at', g.beds_updated_at, 'link_token', public.mint_bed_link(o.user_id, g.id))
      INTO v_data
      FROM public.global_partners g WHERE g.id = (o.data ->> 'global_partner_id')::uuid;
  ELSIF o.kind IN ('claim_request', 'claim_decision') THEN
    v_data := v_data || coalesce(public.email_claim_details(o.kind, o.data), '{}'::jsonb);
  ELSIF o.kind IN ('family_assessment_invite', 'family_assessment_submitted') THEN
    v_details := public.email_family_assessment_details(o.kind, o.data,
                   (SELECT coalesce(u.email, '') FROM auth.users u WHERE u.id = o.user_id));
    v_data := v_data || coalesce(v_details -> 'data', '{}'::jsonb)
                     || jsonb_build_object('to', coalesce(v_details ->> 'to', ''));
  END IF;
  RETURN v_data || jsonb_build_object('prepared', true, 'prepared_at', now());
END
$$;
REVOKE ALL ON FUNCTION public.email_prepare_data(public.email_outbox) FROM PUBLIC, anon, authenticated, service_role;

-- Same as 20261108170000, except that an assessment invite goes to the
-- family's address worked out when the row was prepared.
CREATE OR REPLACE FUNCTION public.email_outbox_prepare(p_id uuid)
RETURNS TABLE (id uuid, kind text, email text, data jsonb, unsubscribe_token text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o public.email_outbox%ROWTYPE;
  v_email text;
  v_fail text;
  v_data jsonb;
  v_pref public.email_preferences%ROWTYPE;
BEGIN
  SELECT * INTO o FROM public.email_outbox x WHERE x.id = p_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = o.user_id;
  v_fail := CASE WHEN coalesce(btrim(v_email), '') = '' THEN 'no_email' ELSE public.email_prepare_problem(o) END;
  IF v_fail IS NOT NULL THEN
    UPDATE public.email_outbox x SET error = v_fail, data = x.data - 'link_token' WHERE x.id = p_id;
    RETURN;
  END IF;
  IF coalesce((o.data ->> 'prepared')::boolean, false) THEN
    v_data := o.data;
  ELSE
    v_data := public.email_prepare_data(o);
    UPDATE public.email_outbox x SET data = v_data WHERE x.id = p_id;
  END IF;
  IF o.kind = 'family_assessment_invite' THEN
    v_email := v_data ->> 'to';
    IF coalesce(btrim(v_email), '') = '' THEN
      UPDATE public.email_outbox x SET error = 'no_email', data = x.data - 'link_token' WHERE x.id = p_id;
      RETURN;
    END IF;
  END IF;
  v_pref := public.email_preferences_row(o.user_id);
  RETURN QUERY SELECT o.id, o.kind, v_email, v_data, v_pref.unsubscribe_token;
END
$$;
REVOKE ALL ON FUNCTION public.email_outbox_prepare(uuid) FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
