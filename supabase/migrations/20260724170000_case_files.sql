-- ReferralFit schema v3 — Case files: one family, one place.
-- Cases hold real contact info and documents (PHI-adjacent). Owner-only RLS,
-- private storage bucket, signed-URL access only.

-- ─── cases ────────────────────────────────────────────────────────────────────
CREATE TABLE public.cases (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  title          text NOT NULL,                    -- "Henderson family — son Jake, 24"
  status         text NOT NULL DEFAULT 'inquiry'
                 CHECK (status IN ('inquiry','consult','deciding','engaged','intervention','placed','aftercare','closed','lost')),
  summary        text NOT NULL DEFAULT '',
  payment_status text NOT NULL DEFAULT 'none'
                 CHECK (payment_status IN ('none','quoted','deposit','paid','partial','refunded')),
  quoted_amount  integer,
  paid_amount    integer NOT NULL DEFAULT 0,
  match_profile_id uuid REFERENCES public.match_profiles(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cases_owner_status_idx ON public.cases (owner_id, status, updated_at DESC);
CREATE TRIGGER cases_updated_at BEFORE UPDATE ON public.cases
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── case_contacts — the mother's cell, the stepdad's email ──────────────────
CREATE TABLE public.case_contacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  case_id      uuid NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
  name         text NOT NULL,
  relationship text NOT NULL DEFAULT '',            -- mother, stepdad, subject, referent...
  phone        text NOT NULL DEFAULT '',
  phone_e164   text GENERATED ALWAYS AS (regexp_replace(phone, '[^0-9+]', '', 'g')) STORED,
  email        text NOT NULL DEFAULT '',
  is_primary   boolean NOT NULL DEFAULT false,
  note         text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_contacts_case_idx ON public.case_contacts (owner_id, case_id);
-- The "14 months ago" lookup: normalized phone search across all cases.
CREATE INDEX case_contacts_phone_idx ON public.case_contacts (owner_id, phone_e164);

-- ─── case_events — the running timeline ──────────────────────────────────────
CREATE TABLE public.case_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  case_id     uuid NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('call','text','email','meeting','note','voice_note','status_change','payment','referral','document','system')),
  body        text NOT NULL DEFAULT '',
  contact_id  uuid REFERENCES public.case_contacts(id) ON DELETE SET NULL,
  referral_id uuid REFERENCES public.referrals(id) ON DELETE SET NULL,
  document_id uuid,                                  -- FK added below after table exists
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_events_case_idx ON public.case_events (owner_id, case_id, occurred_at DESC);

-- ─── case_documents — insurance card photo, signed agreement ─────────────────
CREATE TABLE public.case_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  case_id      uuid NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
  label        text NOT NULL,                        -- "Insurance card (front)"
  storage_path text NOT NULL,                        -- case-documents/{owner_id}/{case_id}/{uuid}.{ext}
  mime_type    text NOT NULL DEFAULT '',
  size_bytes   integer,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_documents_case_idx ON public.case_documents (owner_id, case_id);
ALTER TABLE public.case_events
  ADD CONSTRAINT case_events_document_fk FOREIGN KEY (document_id)
  REFERENCES public.case_documents(id) ON DELETE SET NULL;

-- ─── Link existing entities to cases ──────────────────────────────────────────
ALTER TABLE public.match_profiles ADD COLUMN case_id uuid REFERENCES public.cases(id) ON DELETE SET NULL;
ALTER TABLE public.referrals      ADD COLUMN case_id uuid REFERENCES public.cases(id) ON DELETE SET NULL;
ALTER TABLE public.follow_ups     ADD COLUMN case_id uuid REFERENCES public.cases(id) ON DELETE SET NULL;
CREATE INDEX referrals_case_idx  ON public.referrals (case_id) WHERE case_id IS NOT NULL;
CREATE INDEX follow_ups_case_idx ON public.follow_ups (case_id) WHERE case_id IS NOT NULL;

-- ─── RLS — owner-only on everything ───────────────────────────────────────────
ALTER TABLE public.cases          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_contacts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_events    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cases: owner all" ON public.cases
  FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE POLICY "case_contacts: owner all" ON public.case_contacts
  FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE POLICY "case_events: owner all" ON public.case_events
  FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE POLICY "case_documents: owner all" ON public.case_documents
  FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

REVOKE ALL ON public.cases, public.case_contacts, public.case_events, public.case_documents FROM anon, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cases, public.case_contacts, public.case_events, public.case_documents TO authenticated;

-- ─── Private storage bucket for documents ─────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('case-documents', 'case-documents', false, 26214400,
        ARRAY['image/jpeg','image/png','image/heic','image/webp','application/pdf'])
ON CONFLICT (id) DO NOTHING;

-- Owner-only object access, path convention: {owner_id}/{case_id}/{file}
CREATE POLICY "case docs: owner read" ON storage.objects FOR SELECT
  USING (bucket_id = 'case-documents' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "case docs: owner insert" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'case-documents' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "case docs: owner delete" ON storage.objects FOR DELETE
  USING (bucket_id = 'case-documents' AND (storage.foldername(name))[1] = auth.uid()::text);
