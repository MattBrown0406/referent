BEGIN;

-- Org workspaces: multi-tenant foundation (Phase 1 of the platform buildout).
--
-- Tenancy moves from "one auth user owns every row" to "one org (practice)
-- owns every row; members of the org share the workspace". owner_id remains on
-- every row as attribution (who created it), while the new org_id becomes the
-- tenancy key: RLS, composite relationship FKs, and the transactional RPCs all
-- scope by org_id. Every existing and future auth user gets a personal org
-- automatically, so a solo practice behaves exactly as before.

-- ─── 1. orgs / org_members / org_invites ─────────────────────────────────────

CREATE TABLE public.orgs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL DEFAULT 'My Practice'
             CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER orgs_updated_at BEFORE UPDATE ON public.orgs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- One org per user (PRIMARY KEY user_id). Joining another practice re-homes
-- the member and their rows via accept_org_invite.
CREATE TABLE public.org_members (
  user_id      uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id       uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  role         text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  display_name text NOT NULL DEFAULT '' CHECK (length(display_name) <= 120),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX org_members_org_idx ON public.org_members (org_id);

CREATE TABLE public.org_invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  code        text NOT NULL UNIQUE CHECK (length(code) BETWEEN 8 AND 32),
  invited_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  expires_at  timestamptz NOT NULL,
  accepted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  accepted_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX org_invites_org_idx ON public.org_invites (org_id, created_at DESC);

-- ─── 2. Helpers ──────────────────────────────────────────────────────────────

-- The caller's org. SECURITY DEFINER so RLS policies can use it without
-- recursive policy evaluation on org_members.
CREATE OR REPLACE FUNCTION public.current_org_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$ SELECT org_id FROM public.org_members WHERE user_id = auth.uid() $$;

CREATE OR REPLACE FUNCTION public.current_org_role()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$ SELECT role FROM public.org_members WHERE user_id = auth.uid() $$;

-- Storage-policy helper: is the given folder segment (an owner uuid as text)
-- a member of the caller's org? Text comparison avoids cast failures on any
-- non-uuid path segment.
CREATE OR REPLACE FUNCTION public.is_org_colleague_folder(p_folder text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.org_members me
      JOIN public.org_members them ON them.org_id = me.org_id
     WHERE me.user_id = auth.uid()
       AND them.user_id::text = p_folder
  )
$$;

REVOKE ALL ON FUNCTION public.current_org_id(), public.current_org_role(), public.is_org_colleague_folder(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_org_id(), public.current_org_role(), public.is_org_colleague_folder(text) TO authenticated;
-- storage policies evaluate under the requesting role; storage service uses
-- authenticated/anon JWTs, so authenticated EXECUTE covers object access.

-- ─── 3. Personal org on signup + backfill for existing users ─────────────────

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
BEGIN
  INSERT INTO public.orgs (name, created_by) VALUES ('My Practice', NEW.id)
  RETURNING id INTO v_org;
  INSERT INTO public.org_members (org_id, user_id, role, display_name)
  VALUES (
    v_org, NEW.id, 'owner',
    coalesce(nullif(split_part(coalesce(NEW.email, ''), '@', 1), ''), 'Member')
  );
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

WITH created AS (
  INSERT INTO public.orgs (name, created_by)
  SELECT 'My Practice', u.id
    FROM auth.users u
   WHERE NOT EXISTS (SELECT 1 FROM public.org_members m WHERE m.user_id = u.id)
  RETURNING id, created_by
)
INSERT INTO public.org_members (org_id, user_id, role, display_name)
SELECT c.id, c.created_by, 'owner',
       coalesce(nullif(split_part(coalesce(u.email, ''), '@', 1), ''), 'Member')
  FROM created c
  JOIN auth.users u ON u.id = c.created_by;

-- ─── 4. org_id on every tenant table ─────────────────────────────────────────

ALTER TABLE public.partners           ADD COLUMN org_id uuid REFERENCES public.orgs(id);
ALTER TABLE public.touches            ADD COLUMN org_id uuid REFERENCES public.orgs(id);
ALTER TABLE public.referrals          ADD COLUMN org_id uuid REFERENCES public.orgs(id);
ALTER TABLE public.match_profiles     ADD COLUMN org_id uuid REFERENCES public.orgs(id);
ALTER TABLE public.follow_ups         ADD COLUMN org_id uuid REFERENCES public.orgs(id);
ALTER TABLE public.cases              ADD COLUMN org_id uuid REFERENCES public.orgs(id);
ALTER TABLE public.case_contacts      ADD COLUMN org_id uuid REFERENCES public.orgs(id);
ALTER TABLE public.case_events        ADD COLUMN org_id uuid REFERENCES public.orgs(id);
ALTER TABLE public.case_documents     ADD COLUMN org_id uuid REFERENCES public.orgs(id);
ALTER TABLE public.case_stage_history ADD COLUMN org_id uuid REFERENCES public.orgs(id);
ALTER TABLE public.case_integrations  ADD COLUMN org_id uuid REFERENCES public.orgs(id);

-- Production tables already have owner-only RLS. The migration role is not a
-- user JWT, so temporarily suspend those policies for the deterministic
-- backfill, then restore RLS before any new policy or grant is exposed.
ALTER TABLE public.partners           DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.touches            DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.referrals          DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_profiles     DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.follow_ups         DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.cases              DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_contacts      DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_events        DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_documents     DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_stage_history DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_integrations  DISABLE ROW LEVEL SECURITY;

UPDATE public.partners           t SET org_id = m.org_id FROM public.org_members m WHERE m.user_id = t.owner_id;
UPDATE public.touches            t SET org_id = m.org_id FROM public.org_members m WHERE m.user_id = t.owner_id;
UPDATE public.referrals          t SET org_id = m.org_id FROM public.org_members m WHERE m.user_id = t.owner_id;
UPDATE public.match_profiles     t SET org_id = m.org_id FROM public.org_members m WHERE m.user_id = t.owner_id;
UPDATE public.follow_ups         t SET org_id = m.org_id FROM public.org_members m WHERE m.user_id = t.owner_id;
UPDATE public.cases              t SET org_id = m.org_id FROM public.org_members m WHERE m.user_id = t.owner_id;
-- Case-child tenancy follows the durable parent case. Historical activity may
-- be attributed to a different/deleted collaborator, so owner membership is not
-- authoritative for these rows. The deferred primary-contact constraint also
-- fires on every UPDATE; suspend it while changing only tenancy metadata.
ALTER TABLE public.case_contacts DISABLE TRIGGER USER;
UPDATE public.case_contacts      t SET org_id = c.org_id FROM public.cases c WHERE c.id = t.case_id;
ALTER TABLE public.case_contacts ENABLE TRIGGER USER;
UPDATE public.case_events        t SET org_id = c.org_id FROM public.cases c WHERE c.id = t.case_id;
UPDATE public.case_documents     t SET org_id = c.org_id FROM public.cases c WHERE c.id = t.case_id;
UPDATE public.case_stage_history t SET org_id = c.org_id FROM public.cases c WHERE c.id = t.case_id;
UPDATE public.case_integrations  t SET org_id = c.org_id FROM public.cases c WHERE c.id = t.case_id;

ALTER TABLE public.partners           ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.touches            ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.referrals          ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.match_profiles     ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.follow_ups         ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.cases              ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.case_contacts      ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.case_events        ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.case_documents     ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.case_stage_history ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.case_integrations  ALTER COLUMN org_id SET NOT NULL;

ALTER TABLE public.partners           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.touches            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referrals          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_profiles     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follow_ups         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cases              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_contacts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_documents     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_stage_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_integrations  ENABLE ROW LEVEL SECURITY;

CREATE INDEX partners_org_idx           ON public.partners (org_id);
CREATE INDEX touches_org_idx            ON public.touches (org_id, partner_id, occurred_at DESC);
CREATE INDEX referrals_org_idx          ON public.referrals (org_id, partner_id, referred_on DESC);
CREATE INDEX match_profiles_org_idx     ON public.match_profiles (org_id, updated_at DESC);
CREATE INDEX follow_ups_org_idx         ON public.follow_ups (org_id, status, due_on);
CREATE INDEX cases_org_idx              ON public.cases (org_id, status, updated_at DESC);
CREATE INDEX case_contacts_org_idx      ON public.case_contacts (org_id, case_id);
CREATE INDEX case_events_org_idx        ON public.case_events (org_id, case_id, occurred_at DESC);
CREATE INDEX case_documents_org_idx     ON public.case_documents (org_id, case_id);
CREATE INDEX case_stage_history_org_idx ON public.case_stage_history (org_id, case_id, entered_at DESC);
CREATE INDEX case_integrations_org_idx  ON public.case_integrations (org_id, case_id, provider, updated_at DESC);

-- Derive org_id from the author's membership when a writer (client data API,
-- service-role webhook) does not supply it, and pin INSERT attribution to the
-- authenticated user. TG_ARGV[0] = 'skip_owner_guard' exempts tables whose
-- rows are written by definer triggers on behalf of the case owner.
CREATE OR REPLACE FUNCTION public.set_row_org_from_owner()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (TG_NARGS = 0 OR TG_ARGV[0] IS DISTINCT FROM 'skip_owner_guard')
     AND auth.uid() IS NOT NULL
     AND NEW.owner_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Rows must be created by their authenticated author' USING ERRCODE = '42501';
  END IF;
  IF NEW.org_id IS NULL THEN
    SELECT org_id INTO NEW.org_id FROM public.org_members WHERE user_id = NEW.owner_id;
  END IF;
  IF NEW.org_id IS NULL THEN
    RAISE EXCEPTION 'Workspace membership required' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.set_row_org_from_owner() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER partners_set_org           BEFORE INSERT ON public.partners           FOR EACH ROW EXECUTE FUNCTION public.set_row_org_from_owner();
CREATE TRIGGER touches_set_org            BEFORE INSERT ON public.touches            FOR EACH ROW EXECUTE FUNCTION public.set_row_org_from_owner();
CREATE TRIGGER referrals_set_org          BEFORE INSERT ON public.referrals          FOR EACH ROW EXECUTE FUNCTION public.set_row_org_from_owner();
CREATE TRIGGER match_profiles_set_org     BEFORE INSERT ON public.match_profiles     FOR EACH ROW EXECUTE FUNCTION public.set_row_org_from_owner();
CREATE TRIGGER follow_ups_set_org         BEFORE INSERT ON public.follow_ups         FOR EACH ROW EXECUTE FUNCTION public.set_row_org_from_owner();
CREATE TRIGGER cases_set_org              BEFORE INSERT ON public.cases              FOR EACH ROW EXECUTE FUNCTION public.set_row_org_from_owner();
CREATE TRIGGER case_contacts_set_org      BEFORE INSERT ON public.case_contacts      FOR EACH ROW EXECUTE FUNCTION public.set_row_org_from_owner();
CREATE TRIGGER case_events_set_org        BEFORE INSERT ON public.case_events        FOR EACH ROW EXECUTE FUNCTION public.set_row_org_from_owner();
CREATE TRIGGER case_documents_set_org     BEFORE INSERT ON public.case_documents     FOR EACH ROW EXECUTE FUNCTION public.set_row_org_from_owner();
CREATE TRIGGER case_stage_history_set_org BEFORE INSERT ON public.case_stage_history FOR EACH ROW EXECUTE FUNCTION public.set_row_org_from_owner('skip_owner_guard');
CREATE TRIGGER case_integrations_set_org  BEFORE INSERT ON public.case_integrations  FOR EACH ROW EXECUTE FUNCTION public.set_row_org_from_owner('skip_owner_guard');

-- ─── 5. Composite relationships move from (id, owner_id) to (id, org_id) ────
-- Same design as the owner hardening migration: new FKs land NOT VALID first,
-- then explicit VALIDATE steps make any cross-org relationship fail the
-- migration rather than silently rewriting tenancy. DEFERRABLE lets
-- accept_org_invite re-home a member's rows atomically.

ALTER TABLE public.partners       ADD CONSTRAINT partners_id_org_key       UNIQUE (id, org_id);
ALTER TABLE public.referrals      ADD CONSTRAINT referrals_id_org_key      UNIQUE (id, org_id);
ALTER TABLE public.match_profiles ADD CONSTRAINT match_profiles_id_org_key UNIQUE (id, org_id);
ALTER TABLE public.cases          ADD CONSTRAINT cases_id_org_key          UNIQUE (id, org_id);
ALTER TABLE public.case_contacts  ADD CONSTRAINT case_contacts_id_org_key  UNIQUE (id, org_id);
ALTER TABLE public.case_documents ADD CONSTRAINT case_documents_id_org_key UNIQUE (id, org_id);

-- CASCADE relationships.
ALTER TABLE public.touches
  DROP CONSTRAINT touches_partner_owner_fk,
  ADD CONSTRAINT touches_partner_org_fk
    FOREIGN KEY (partner_id, org_id) REFERENCES public.partners (id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE public.referrals
  DROP CONSTRAINT referrals_partner_owner_fk,
  ADD CONSTRAINT referrals_partner_org_fk
    FOREIGN KEY (partner_id, org_id) REFERENCES public.partners (id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE public.follow_ups
  DROP CONSTRAINT follow_ups_partner_owner_fk,
  DROP CONSTRAINT follow_ups_referral_owner_fk,
  DROP CONSTRAINT follow_ups_case_owner_fk,
  ADD CONSTRAINT follow_ups_partner_org_fk
    FOREIGN KEY (partner_id, org_id) REFERENCES public.partners (id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  ADD CONSTRAINT follow_ups_referral_org_fk
    FOREIGN KEY (referral_id, org_id) REFERENCES public.referrals (id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  ADD CONSTRAINT follow_ups_case_org_fk
    FOREIGN KEY (case_id, org_id) REFERENCES public.cases (id, org_id)
    ON DELETE SET NULL (case_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE public.case_contacts
  DROP CONSTRAINT case_contacts_case_owner_fk,
  ADD CONSTRAINT case_contacts_case_org_fk
    FOREIGN KEY (case_id, org_id) REFERENCES public.cases (id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE public.case_events
  DROP CONSTRAINT case_events_case_owner_fk,
  DROP CONSTRAINT case_events_contact_owner_fk,
  DROP CONSTRAINT case_events_referral_owner_fk,
  DROP CONSTRAINT case_events_document_owner_fk,
  ADD CONSTRAINT case_events_case_org_fk
    FOREIGN KEY (case_id, org_id) REFERENCES public.cases (id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  ADD CONSTRAINT case_events_contact_org_fk
    FOREIGN KEY (contact_id, org_id) REFERENCES public.case_contacts (id, org_id)
    ON DELETE SET NULL (contact_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  ADD CONSTRAINT case_events_referral_org_fk
    FOREIGN KEY (referral_id, org_id) REFERENCES public.referrals (id, org_id)
    ON DELETE SET NULL (referral_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  ADD CONSTRAINT case_events_document_org_fk
    FOREIGN KEY (document_id, org_id) REFERENCES public.case_documents (id, org_id)
    ON DELETE SET NULL (document_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE public.case_documents
  DROP CONSTRAINT case_documents_case_owner_fk,
  ADD CONSTRAINT case_documents_case_org_fk
    FOREIGN KEY (case_id, org_id) REFERENCES public.cases (id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE public.match_profiles
  DROP CONSTRAINT match_profiles_partner_owner_fk,
  DROP CONSTRAINT match_profiles_referral_owner_fk,
  DROP CONSTRAINT match_profiles_case_owner_fk,
  ADD CONSTRAINT match_profiles_partner_org_fk
    FOREIGN KEY (assigned_partner_id, org_id) REFERENCES public.partners (id, org_id)
    ON DELETE SET NULL (assigned_partner_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  ADD CONSTRAINT match_profiles_referral_org_fk
    FOREIGN KEY (referral_id, org_id) REFERENCES public.referrals (id, org_id)
    ON DELETE SET NULL (referral_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  ADD CONSTRAINT match_profiles_case_org_fk
    FOREIGN KEY (case_id, org_id) REFERENCES public.cases (id, org_id)
    ON DELETE SET NULL (case_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE public.referrals
  DROP CONSTRAINT referrals_match_profile_owner_fk,
  DROP CONSTRAINT referrals_case_owner_fk,
  ADD CONSTRAINT referrals_match_profile_org_fk
    FOREIGN KEY (match_profile_id, org_id) REFERENCES public.match_profiles (id, org_id)
    ON DELETE SET NULL (match_profile_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  ADD CONSTRAINT referrals_case_org_fk
    FOREIGN KEY (case_id, org_id) REFERENCES public.cases (id, org_id)
    ON DELETE SET NULL (case_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE public.cases
  DROP CONSTRAINT cases_match_profile_owner_fk,
  ADD CONSTRAINT cases_match_profile_org_fk
    FOREIGN KEY (match_profile_id, org_id) REFERENCES public.match_profiles (id, org_id)
    ON DELETE SET NULL (match_profile_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE public.case_stage_history
  DROP CONSTRAINT case_stage_history_case_owner_fk,
  ADD CONSTRAINT case_stage_history_case_org_fk
    FOREIGN KEY (case_id, org_id) REFERENCES public.cases (id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE public.case_integrations
  DROP CONSTRAINT case_integrations_case_owner_fk,
  ADD CONSTRAINT case_integrations_case_org_fk
    FOREIGN KEY (case_id, org_id) REFERENCES public.cases (id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE public.touches            VALIDATE CONSTRAINT touches_partner_org_fk;
ALTER TABLE public.referrals          VALIDATE CONSTRAINT referrals_partner_org_fk;
ALTER TABLE public.follow_ups         VALIDATE CONSTRAINT follow_ups_partner_org_fk;
ALTER TABLE public.follow_ups         VALIDATE CONSTRAINT follow_ups_referral_org_fk;
ALTER TABLE public.follow_ups         VALIDATE CONSTRAINT follow_ups_case_org_fk;
ALTER TABLE public.case_contacts      VALIDATE CONSTRAINT case_contacts_case_org_fk;
ALTER TABLE public.case_events        VALIDATE CONSTRAINT case_events_case_org_fk;
ALTER TABLE public.case_events        VALIDATE CONSTRAINT case_events_contact_org_fk;
ALTER TABLE public.case_events        VALIDATE CONSTRAINT case_events_referral_org_fk;
ALTER TABLE public.case_events        VALIDATE CONSTRAINT case_events_document_org_fk;
ALTER TABLE public.case_documents     VALIDATE CONSTRAINT case_documents_case_org_fk;
ALTER TABLE public.match_profiles     VALIDATE CONSTRAINT match_profiles_partner_org_fk;
ALTER TABLE public.match_profiles     VALIDATE CONSTRAINT match_profiles_referral_org_fk;
ALTER TABLE public.match_profiles     VALIDATE CONSTRAINT match_profiles_case_org_fk;
ALTER TABLE public.referrals          VALIDATE CONSTRAINT referrals_match_profile_org_fk;
ALTER TABLE public.referrals          VALIDATE CONSTRAINT referrals_case_org_fk;
ALTER TABLE public.cases              VALIDATE CONSTRAINT cases_match_profile_org_fk;
ALTER TABLE public.case_stage_history VALIDATE CONSTRAINT case_stage_history_case_org_fk;
ALTER TABLE public.case_integrations  VALIDATE CONSTRAINT case_integrations_case_org_fk;

-- The old (id, owner_id) uniques only existed to anchor the owner FKs.
ALTER TABLE public.partners       DROP CONSTRAINT partners_id_owner_key;
ALTER TABLE public.referrals      DROP CONSTRAINT referrals_id_owner_key;
ALTER TABLE public.match_profiles DROP CONSTRAINT match_profiles_id_owner_key;
ALTER TABLE public.cases          DROP CONSTRAINT cases_id_owner_key;
ALTER TABLE public.case_contacts  DROP CONSTRAINT case_contacts_id_owner_key;
ALTER TABLE public.case_documents DROP CONSTRAINT case_documents_id_owner_key;

-- Product invariants scope to the workspace now.
DROP INDEX public.case_contacts_one_primary_per_case_idx;
CREATE UNIQUE INDEX case_contacts_one_primary_per_case_idx
  ON public.case_contacts (org_id, case_id)
  WHERE is_primary;

DROP INDEX public.case_stage_history_one_open_idx;
CREATE UNIQUE INDEX case_stage_history_one_open_idx
  ON public.case_stage_history (org_id, case_id)
  WHERE exited_at IS NULL;

-- case_integrations UNIQUE (owner_id, provider, record_type, external_id) is
-- intentionally unchanged: the webhook edge functions upsert on it.

-- ─── 6. RLS: workspace scope ─────────────────────────────────────────────────

DROP POLICY "partners: owner all"       ON public.partners;
DROP POLICY "touches: owner all"        ON public.touches;
DROP POLICY "referrals: owner all"      ON public.referrals;
DROP POLICY "match_profiles: owner all" ON public.match_profiles;
DROP POLICY "follow_ups: owner all"     ON public.follow_ups;
DROP POLICY "cases: owner all"          ON public.cases;
DROP POLICY "case_contacts: owner all"  ON public.case_contacts;
DROP POLICY "case_events: owner all"    ON public.case_events;
DROP POLICY "case_documents: owner all" ON public.case_documents;
DROP POLICY "case_stage_history: owner read" ON public.case_stage_history;
DROP POLICY "case_integrations: owner all"   ON public.case_integrations;

CREATE POLICY "partners: org all" ON public.partners
  FOR ALL USING (org_id = public.current_org_id()) WITH CHECK (org_id = public.current_org_id());
CREATE POLICY "touches: org all" ON public.touches
  FOR ALL USING (org_id = public.current_org_id()) WITH CHECK (org_id = public.current_org_id());
CREATE POLICY "referrals: org all" ON public.referrals
  FOR ALL USING (org_id = public.current_org_id()) WITH CHECK (org_id = public.current_org_id());
CREATE POLICY "match_profiles: org all" ON public.match_profiles
  FOR ALL USING (org_id = public.current_org_id()) WITH CHECK (org_id = public.current_org_id());
CREATE POLICY "follow_ups: org all" ON public.follow_ups
  FOR ALL USING (org_id = public.current_org_id()) WITH CHECK (org_id = public.current_org_id());
CREATE POLICY "cases: org all" ON public.cases
  FOR ALL USING (org_id = public.current_org_id()) WITH CHECK (org_id = public.current_org_id());
CREATE POLICY "case_contacts: org all" ON public.case_contacts
  FOR ALL USING (org_id = public.current_org_id()) WITH CHECK (org_id = public.current_org_id());
CREATE POLICY "case_events: org all" ON public.case_events
  FOR ALL USING (org_id = public.current_org_id()) WITH CHECK (org_id = public.current_org_id());
CREATE POLICY "case_documents: org all" ON public.case_documents
  FOR ALL USING (org_id = public.current_org_id()) WITH CHECK (org_id = public.current_org_id());
CREATE POLICY "case_stage_history: org read" ON public.case_stage_history
  FOR SELECT USING (org_id = public.current_org_id());
CREATE POLICY "case_integrations: org all" ON public.case_integrations
  FOR ALL USING (org_id = public.current_org_id()) WITH CHECK (org_id = public.current_org_id());

ALTER TABLE public.orgs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_invites ENABLE ROW LEVEL SECURITY;

CREATE POLICY "orgs: member read" ON public.orgs
  FOR SELECT USING (id = public.current_org_id());
CREATE POLICY "orgs: owner rename" ON public.orgs
  FOR UPDATE USING (id = public.current_org_id() AND public.current_org_role() = 'owner')
  WITH CHECK (id = public.current_org_id());
CREATE POLICY "org_members: member read" ON public.org_members
  FOR SELECT USING (org_id = public.current_org_id());
CREATE POLICY "org_invites: member read" ON public.org_invites
  FOR SELECT USING (org_id = public.current_org_id());

REVOKE ALL ON public.orgs, public.org_members, public.org_invites FROM anon, PUBLIC;
GRANT SELECT ON public.orgs, public.org_members, public.org_invites TO authenticated;
GRANT UPDATE (name) ON public.orgs TO authenticated;
-- Membership and invite writes happen only through the definer RPCs below.

-- ─── 7. Storage: org colleagues share case documents ─────────────────────────
-- Object paths remain {owner_id}/{case_id}/{file}; access follows the org.

DROP POLICY "case docs: owner read"   ON storage.objects;
DROP POLICY "case docs: owner insert" ON storage.objects;
DROP POLICY "case docs: owner delete" ON storage.objects;

CREATE POLICY "case docs: org read" ON storage.objects FOR SELECT
  USING (bucket_id = 'case-documents' AND public.is_org_colleague_folder((storage.foldername(name))[1]));
CREATE POLICY "case docs: org insert" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'case-documents' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "case docs: org delete" ON storage.objects FOR DELETE
  USING (bucket_id = 'case-documents' AND public.is_org_colleague_folder((storage.foldername(name))[1]));

-- ─── 8. Triggers learn org scope ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.touch_partner_last_contact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE public.partners AS p
     SET last_contact_at = GREATEST(
       coalesce(p.last_contact_at, NEW.occurred_at),
       NEW.occurred_at
     )
   WHERE p.id = NEW.partner_id
     AND p.org_id = NEW.org_id;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.enforce_case_contact_primary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP <> 'DELETE' AND EXISTS (
    SELECT 1 FROM public.case_contacts
    WHERE case_id = NEW.case_id AND org_id = NEW.org_id
  ) AND NOT EXISTS (
    SELECT 1 FROM public.case_contacts
    WHERE case_id = NEW.case_id AND org_id = NEW.org_id AND is_primary
  ) THEN
    RAISE EXCEPTION 'A case with contacts must have exactly one primary contact' USING ERRCODE = '23514';
  END IF;

  IF TG_OP <> 'INSERT'
     AND (TG_OP = 'DELETE' OR OLD.case_id IS DISTINCT FROM NEW.case_id OR OLD.org_id IS DISTINCT FROM NEW.org_id)
     AND EXISTS (
       SELECT 1 FROM public.case_contacts
       WHERE case_id = OLD.case_id AND org_id = OLD.org_id
     ) AND NOT EXISTS (
       SELECT 1 FROM public.case_contacts
       WHERE case_id = OLD.case_id AND org_id = OLD.org_id AND is_primary
     ) THEN
    RAISE EXCEPTION 'A case with contacts must have exactly one primary contact' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.track_case_stage_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz := coalesce(NEW.stage_changed_at, pg_catalog.clock_timestamp());
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.case_stage_history (owner_id, org_id, case_id, status, entered_at)
    VALUES (NEW.owner_id, NEW.org_id, NEW.id, NEW.status, coalesce(NEW.stage_changed_at, NEW.created_at, v_now));
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE public.case_stage_history
       SET exited_at = v_now
     WHERE org_id = NEW.org_id
       AND case_id = NEW.id
       AND exited_at IS NULL;

    INSERT INTO public.case_stage_history (owner_id, org_id, case_id, status, entered_at)
    VALUES (NEW.owner_id, NEW.org_id, NEW.id, NEW.status, v_now);
  END IF;
  RETURN NEW;
END
$$;

-- ─── 9. Transactional RPCs scope by workspace ────────────────────────────────
-- owner_id on new rows remains the acting user (attribution); every lookup,
-- update, and idempotent-upsert guard now checks org_id so colleagues can
-- operate on shared workspace rows.

CREATE OR REPLACE FUNCTION public.create_case_bundle(
  p_expected_owner_id uuid,
  p_case jsonb,
  p_contact jsonb DEFAULT NULL,
  p_follow_up jsonb DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_case_id uuid := (p_case ->> 'id')::uuid;
BEGIN
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF v_owner_id <> p_expected_owner_id THEN
    RAISE EXCEPTION 'Authenticated account changed before case creation' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.cases (
    id, owner_id, title, status, summary, payment_status,
    quoted_amount, paid_amount, match_profile_id,
    lead_source, lead_source_detail, lost_reason
  ) VALUES (
    v_case_id,
    v_owner_id,
    p_case ->> 'title',
    coalesce(p_case ->> 'status', 'inquiry'),
    coalesce(p_case ->> 'summary', ''),
    coalesce(p_case ->> 'payment_status', 'none'),
    nullif(p_case ->> 'quoted_amount', '')::integer,
    coalesce(nullif(p_case ->> 'paid_amount', '')::integer, 0),
    nullif(p_case ->> 'match_profile_id', '')::uuid,
    coalesce(nullif(pg_catalog.btrim(p_case ->> 'lead_source'), ''), 'Unspecified'),
    coalesce(p_case ->> 'lead_source_detail', ''),
    coalesce(p_case ->> 'lost_reason', '')
  );

  IF p_contact IS NOT NULL AND p_contact <> 'null'::jsonb THEN
    INSERT INTO public.case_contacts (
      id, owner_id, case_id, name, relationship, phone, email, is_primary, note
    ) VALUES (
      (p_contact ->> 'id')::uuid,
      v_owner_id,
      v_case_id,
      p_contact ->> 'name',
      coalesce(p_contact ->> 'relationship', ''),
      coalesce(p_contact ->> 'phone', ''),
      coalesce(p_contact ->> 'email', ''),
      coalesce((p_contact ->> 'is_primary')::boolean, false),
      coalesce(p_contact ->> 'note', '')
    );
  END IF;

  IF p_follow_up IS NOT NULL AND p_follow_up <> 'null'::jsonb THEN
    INSERT INTO public.follow_ups (
      id, owner_id, partner_id, referral_id, case_id, title, due_on,
      status, completed_at, note, kind, due_time, waiting_on, snoozed_until
    ) VALUES (
      (p_follow_up ->> 'id')::uuid,
      v_owner_id,
      nullif(p_follow_up ->> 'partner_id', '')::uuid,
      nullif(p_follow_up ->> 'referral_id', '')::uuid,
      v_case_id,
      p_follow_up ->> 'title',
      (p_follow_up ->> 'due_on')::date,
      coalesce(p_follow_up ->> 'status', 'open'),
      nullif(p_follow_up ->> 'completed_at', '')::timestamptz,
      coalesce(p_follow_up ->> 'note', ''),
      coalesce(p_follow_up ->> 'kind', 'follow_up'),
      nullif(p_follow_up ->> 'due_time', '')::time,
      coalesce(p_follow_up ->> 'waiting_on', ''),
      nullif(p_follow_up ->> 'snoozed_until', '')::date
    );
  END IF;

  RETURN v_case_id;
END
$$;

CREATE OR REPLACE FUNCTION public.update_case_with_event(p_case jsonb, p_event jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_org_id uuid := public.current_org_id();
  v_case_id uuid := (p_case ->> 'id')::uuid;
  v_kind text := p_event ->> 'kind';
  v_updated integer;
BEGIN
  IF v_owner_id IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF v_kind <> 'status_change' THEN
    RAISE EXCEPTION 'Use a field-specific case RPC for this update' USING ERRCODE = '22023';
  END IF;

  UPDATE public.cases AS c
     SET status = p_case ->> 'status',
         updated_at = pg_catalog.now()
   WHERE c.id = v_case_id AND c.org_id = v_org_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'Case not found for the authenticated owner' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.case_events (
    id, owner_id, case_id, kind, body, contact_id, referral_id, document_id, occurred_at
  ) VALUES (
    (p_event ->> 'id')::uuid,
    v_owner_id,
    v_case_id,
    v_kind,
    coalesce(p_event ->> 'body', ''),
    nullif(p_event ->> 'contact_id', '')::uuid,
    nullif(p_event ->> 'referral_id', '')::uuid,
    nullif(p_event ->> 'document_id', '')::uuid,
    coalesce(nullif(p_event ->> 'occurred_at', '')::timestamptz, pg_catalog.now())
  )
  ON CONFLICT (id) DO UPDATE
    SET case_id = EXCLUDED.case_id,
        kind = EXCLUDED.kind,
        body = EXCLUDED.body,
        contact_id = EXCLUDED.contact_id,
        referral_id = EXCLUDED.referral_id,
        document_id = EXCLUDED.document_id,
        occurred_at = EXCLUDED.occurred_at
  WHERE public.case_events.org_id = v_org_id
    AND public.case_events.case_id = EXCLUDED.case_id
    AND public.case_events.kind = EXCLUDED.kind;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'Case event ID is already used by another request' USING ERRCODE = '23505';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.record_case_payment(
  p_case_id uuid,
  p_event_id uuid,
  p_amount integer,
  p_note text DEFAULT ''
)
RETURNS TABLE (
  paid_amount integer,
  payment_status text,
  occurred_at timestamptz,
  event_body text
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_org_id uuid := public.current_org_id();
  v_paid_amount integer;
  v_payment_status text;
  v_occurred_at timestamptz;
  v_event_body text;
  v_event_prefix text;
  v_existing public.case_events%ROWTYPE;
  v_note text := pg_catalog.left(
    pg_catalog.btrim(
      pg_catalog.regexp_replace(coalesce(p_note, ''), E'[\r\n]+', ' ', 'g')
    ),
    200
  );
BEGIN
  IF v_owner_id IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF p_case_id IS NULL OR p_event_id IS NULL THEN
    RAISE EXCEPTION 'Case and payment event IDs are required' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 10000000 THEN
    RAISE EXCEPTION 'Payment amount must be between 1 and 10000000 whole dollars' USING ERRCODE = '22023';
  END IF;

  v_event_prefix := 'Payment received: $'
    || pg_catalog.to_char(p_amount, 'FM999G999G999G990')
    || CASE WHEN v_note <> '' THEN ' · ' || v_note ELSE '' END
    || ' · Total paid: $';

  SELECT c.paid_amount, c.payment_status
    INTO v_paid_amount, v_payment_status
    FROM public.cases AS c
   WHERE c.id = p_case_id
     AND c.org_id = v_org_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Case not found for the authenticated owner' USING ERRCODE = 'P0002';
  END IF;

  SELECT e.*
    INTO v_existing
    FROM public.case_events AS e
   WHERE e.id = p_event_id
     AND e.org_id = v_org_id;

  IF FOUND THEN
    IF v_existing.case_id <> p_case_id
       OR v_existing.kind <> 'payment'
       OR pg_catalog.left(v_existing.body, pg_catalog.length(v_event_prefix)) <> v_event_prefix THEN
      RAISE EXCEPTION 'Payment event ID is already used by a different payment request' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT v_paid_amount, v_payment_status, v_existing.occurred_at, v_existing.body;
    RETURN;
  END IF;

  v_occurred_at := pg_catalog.clock_timestamp();
  UPDATE public.cases AS c
     SET paid_amount = c.paid_amount + p_amount,
         payment_status = CASE
           WHEN c.quoted_amount IS NOT NULL AND c.paid_amount + p_amount >= c.quoted_amount THEN 'paid'
           ELSE 'partial'
         END,
         updated_at = v_occurred_at
   WHERE c.id = p_case_id
     AND c.org_id = v_org_id
  RETURNING c.paid_amount, c.payment_status
       INTO v_paid_amount, v_payment_status;

  v_event_body := v_event_prefix || pg_catalog.to_char(v_paid_amount, 'FM999G999G999G990');

  INSERT INTO public.case_events (
    id, owner_id, case_id, kind, body, occurred_at
  ) VALUES (
    p_event_id, v_owner_id, p_case_id, 'payment', v_event_body, v_occurred_at
  );

  RETURN QUERY SELECT v_paid_amount, v_payment_status, v_occurred_at, v_event_body;
END
$$;

CREATE OR REPLACE FUNCTION public.update_case_details_with_event(
  p_case_id uuid,
  p_event_id uuid,
  p_patch jsonb,
  p_event_body text
)
RETURNS TABLE (title text, summary text, occurred_at timestamptz, event_body text)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_org_id uuid := public.current_org_id();
  v_title text;
  v_summary text;
  v_occurred_at timestamptz;
  v_existing public.case_events%ROWTYPE;
BEGIN
  IF v_owner_id IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF p_patch IS NULL OR p_patch = '{}'::jsonb OR EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_object_keys(p_patch) AS field
    WHERE field NOT IN ('title', 'summary')
  ) THEN
    RAISE EXCEPTION 'Case-details patch contains no supported fields' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'title' AND pg_catalog.btrim(coalesce(p_patch ->> 'title', '')) = '' THEN
    RAISE EXCEPTION 'Case title is required' USING ERRCODE = '22023';
  END IF;

  SELECT c.title, c.summary
    INTO v_title, v_summary
    FROM public.cases AS c
   WHERE c.id = p_case_id AND c.org_id = v_org_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Case not found for the authenticated owner' USING ERRCODE = 'P0002';
  END IF;

  SELECT e.* INTO v_existing
    FROM public.case_events AS e
   WHERE e.id = p_event_id AND e.org_id = v_org_id;
  IF FOUND THEN
    IF v_existing.case_id <> p_case_id
       OR v_existing.kind <> 'system'
       OR v_existing.body <> coalesce(p_event_body, '') THEN
      RAISE EXCEPTION 'Case event ID is already used by another request' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT v_title, v_summary, v_existing.occurred_at, v_existing.body;
    RETURN;
  END IF;

  v_title := CASE WHEN p_patch ? 'title' THEN pg_catalog.btrim(p_patch ->> 'title') ELSE v_title END;
  v_summary := CASE WHEN p_patch ? 'summary' THEN pg_catalog.btrim(coalesce(p_patch ->> 'summary', '')) ELSE v_summary END;
  v_occurred_at := pg_catalog.clock_timestamp();

  UPDATE public.cases AS c
     SET title = v_title,
         summary = v_summary,
         updated_at = v_occurred_at
   WHERE c.id = p_case_id AND c.org_id = v_org_id;

  INSERT INTO public.case_events (id, owner_id, case_id, kind, body, occurred_at)
  VALUES (p_event_id, v_owner_id, p_case_id, 'system', coalesce(p_event_body, ''), v_occurred_at);

  RETURN QUERY SELECT v_title, v_summary, v_occurred_at, coalesce(p_event_body, '');
END
$$;

CREATE OR REPLACE FUNCTION public.update_case_payment_with_event(
  p_case_id uuid,
  p_event_id uuid,
  p_patch jsonb
)
RETURNS TABLE (
  paid_amount integer,
  payment_status text,
  quoted_amount integer,
  occurred_at timestamptz,
  event_body text
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_org_id uuid := public.current_org_id();
  v_paid integer;
  v_status text;
  v_quote integer;
  v_occurred_at timestamptz;
  v_body text := 'Payment updated';
  v_existing public.case_events%ROWTYPE;
BEGIN
  IF v_owner_id IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF p_patch IS NULL OR p_patch = '{}'::jsonb OR EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_object_keys(p_patch) AS key
    WHERE key NOT IN ('payment_status', 'quoted_amount', 'paid_amount')
  ) THEN
    RAISE EXCEPTION 'Payment patch contains no supported fields' USING ERRCODE = '22023';
  END IF;

  SELECT c.paid_amount, c.payment_status, c.quoted_amount
    INTO v_paid, v_status, v_quote
    FROM public.cases AS c
   WHERE c.id = p_case_id AND c.org_id = v_org_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Case not found for the authenticated owner' USING ERRCODE = 'P0002';
  END IF;

  IF p_patch ? 'paid_amount' THEN
    IF pg_catalog.jsonb_typeof(p_patch -> 'paid_amount') <> 'number' THEN
      RAISE EXCEPTION 'Paid amount must be a whole-dollar number' USING ERRCODE = '22023';
    END IF;
    v_paid := (p_patch ->> 'paid_amount')::integer;
    IF v_paid < 0 OR v_paid > 10000000 THEN
      RAISE EXCEPTION 'Paid amount is outside the supported range' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_patch ? 'quoted_amount' THEN
    IF p_patch -> 'quoted_amount' = 'null'::jsonb THEN
      v_quote := NULL;
    ELSIF pg_catalog.jsonb_typeof(p_patch -> 'quoted_amount') = 'number' THEN
      v_quote := (p_patch ->> 'quoted_amount')::integer;
      IF v_quote < 0 OR v_quote > 10000000 THEN
        RAISE EXCEPTION 'Quoted amount is outside the supported range' USING ERRCODE = '22023';
      END IF;
    ELSE
      RAISE EXCEPTION 'Quoted amount must be null or a whole-dollar number' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_patch ? 'payment_status' THEN
    v_status := p_patch ->> 'payment_status';
    IF v_status NOT IN ('none','quoted','deposit','paid','partial','refunded') THEN
      RAISE EXCEPTION 'Unsupported payment status' USING ERRCODE = '22023';
    END IF;
    IF v_status = 'refunded' THEN
      v_paid := 0;
      v_quote := NULL;
    END IF;
  ELSIF p_patch ? 'paid_amount' OR p_patch ? 'quoted_amount' THEN
    v_status := CASE
      WHEN v_paid = 0 AND v_quote IS NULL THEN 'none'
      WHEN v_paid = 0 THEN 'quoted'
      WHEN v_quote IS NOT NULL AND v_paid >= v_quote THEN 'paid'
      ELSE 'partial'
    END;
  END IF;

  IF v_status = 'none' AND (v_paid <> 0 OR v_quote IS NOT NULL) THEN
    RAISE EXCEPTION 'No-payment status requires zero paid and no quote' USING ERRCODE = '22023';
  ELSIF v_status = 'quoted' AND (v_paid <> 0 OR v_quote IS NULL) THEN
    RAISE EXCEPTION 'Quoted status requires a quote and zero paid' USING ERRCODE = '22023';
  ELSIF v_status IN ('deposit', 'partial') AND (v_paid <= 0 OR (v_status = 'partial' AND v_quote IS NOT NULL AND v_paid >= v_quote)) THEN
    RAISE EXCEPTION 'Deposit/partial status is inconsistent with payment totals' USING ERRCODE = '22023';
  ELSIF v_status = 'paid' AND (v_paid <= 0 OR (v_quote IS NOT NULL AND v_paid < v_quote)) THEN
    RAISE EXCEPTION 'Paid status requires paid revenue meeting the quote when present' USING ERRCODE = '22023';
  ELSIF v_status = 'refunded' AND (v_paid <> 0 OR v_quote IS NOT NULL) THEN
    RAISE EXCEPTION 'Refunded status requires zero net paid and no open quote' USING ERRCODE = '22023';
  END IF;

  IF p_patch ? 'payment_status' THEN v_body := v_body || ' · Status: ' || v_status; END IF;
  IF v_status = 'refunded' AND p_patch ? 'payment_status' THEN
    v_body := v_body || ' · Paid total: $0 · Quote cleared';
  END IF;
  IF p_patch ? 'quoted_amount' THEN v_body := v_body || ' · Quoted: ' || coalesce('$' || pg_catalog.to_char(v_quote, 'FM999G999G999G990'), '—'); END IF;
  IF p_patch ? 'paid_amount' THEN v_body := v_body || ' · Paid total: $' || pg_catalog.to_char(v_paid, 'FM999G999G999G990'); END IF;

  SELECT e.* INTO v_existing
    FROM public.case_events AS e
   WHERE e.id = p_event_id AND e.org_id = v_org_id;
  IF FOUND THEN
    IF v_existing.case_id <> p_case_id
       OR v_existing.kind <> 'payment'
       OR v_existing.body <> v_body THEN
      RAISE EXCEPTION 'Payment event ID is already used by a different correction request' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT v_paid, v_status, v_quote, v_existing.occurred_at, v_existing.body;
    RETURN;
  END IF;

  v_occurred_at := pg_catalog.clock_timestamp();
  UPDATE public.cases AS c
     SET paid_amount = v_paid,
         payment_status = v_status,
         quoted_amount = v_quote,
         updated_at = v_occurred_at
   WHERE c.id = p_case_id AND c.org_id = v_org_id;

  INSERT INTO public.case_events (id, owner_id, case_id, kind, body, occurred_at)
  VALUES (p_event_id, v_owner_id, p_case_id, 'payment', v_body, v_occurred_at);

  RETURN QUERY SELECT v_paid, v_status, v_quote, v_occurred_at, v_body;
END
$$;

CREATE OR REPLACE FUNCTION public.update_case_business_details_with_event(
  p_case_id uuid,
  p_event_id uuid,
  p_patch jsonb,
  p_event_body text
)
RETURNS TABLE (
  lead_source text,
  lead_source_detail text,
  lost_reason text,
  occurred_at timestamptz,
  event_body text
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_org_id uuid := public.current_org_id();
  v_source text;
  v_detail text;
  v_lost_reason text;
  v_occurred_at timestamptz;
  v_body text := pg_catalog.left(coalesce(p_event_body, 'Business details updated'), 1000);
  v_existing public.case_events%ROWTYPE;
BEGIN
  IF v_owner_id IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF p_patch IS NULL OR p_patch = '{}'::jsonb OR EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_object_keys(p_patch) AS field
    WHERE field NOT IN ('lead_source', 'lead_source_detail', 'lost_reason')
  ) THEN
    RAISE EXCEPTION 'Business-details patch contains no supported fields' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'lead_source'
     AND pg_catalog.btrim(coalesce(p_patch ->> 'lead_source', '')) = '' THEN
    RAISE EXCEPTION 'Lead source is required' USING ERRCODE = '22023';
  END IF;

  SELECT c.lead_source, c.lead_source_detail, c.lost_reason
    INTO v_source, v_detail, v_lost_reason
    FROM public.cases AS c
   WHERE c.id = p_case_id AND c.org_id = v_org_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Case not found for the authenticated owner' USING ERRCODE = 'P0002';
  END IF;

  SELECT e.* INTO v_existing
    FROM public.case_events AS e
   WHERE e.id = p_event_id AND e.org_id = v_org_id;

  IF FOUND THEN
    IF v_existing.case_id <> p_case_id
       OR v_existing.kind <> 'system'
       OR v_existing.body <> v_body THEN
      RAISE EXCEPTION 'Case event ID is already used by another request' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT v_source, v_detail, v_lost_reason, v_existing.occurred_at, v_existing.body;
    RETURN;
  END IF;

  v_source := CASE WHEN p_patch ? 'lead_source'
    THEN pg_catalog.btrim(p_patch ->> 'lead_source') ELSE v_source END;
  v_detail := CASE WHEN p_patch ? 'lead_source_detail'
    THEN pg_catalog.btrim(coalesce(p_patch ->> 'lead_source_detail', '')) ELSE v_detail END;
  v_lost_reason := CASE WHEN p_patch ? 'lost_reason'
    THEN pg_catalog.btrim(coalesce(p_patch ->> 'lost_reason', '')) ELSE v_lost_reason END;
  v_occurred_at := pg_catalog.clock_timestamp();

  UPDATE public.cases AS c
     SET lead_source = v_source,
         lead_source_detail = v_detail,
         lost_reason = v_lost_reason,
         updated_at = v_occurred_at
   WHERE c.id = p_case_id AND c.org_id = v_org_id;

  INSERT INTO public.case_events (id, owner_id, case_id, kind, body, occurred_at)
  VALUES (p_event_id, v_owner_id, p_case_id, 'system', v_body, v_occurred_at);

  RETURN QUERY SELECT v_source, v_detail, v_lost_reason, v_occurred_at, v_body;
END
$$;

CREATE OR REPLACE FUNCTION public.save_case_contact(p_contact jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_org_id uuid := public.current_org_id();
  v_case_id uuid := (p_contact ->> 'case_id')::uuid;
  v_contact_id uuid := (p_contact ->> 'id')::uuid;
  v_primary boolean := coalesce((p_contact ->> 'is_primary')::boolean, false);
  v_saved integer;
BEGIN
  IF v_owner_id IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;

  PERFORM 1 FROM public.cases
   WHERE id = v_case_id AND org_id = v_org_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Case not found for the authenticated owner' USING ERRCODE = 'P0002';
  END IF;

  IF v_primary THEN
    UPDATE public.case_contacts
       SET is_primary = false
     WHERE org_id = v_org_id AND case_id = v_case_id AND id <> v_contact_id AND is_primary;
  END IF;

  INSERT INTO public.case_contacts (
    id, owner_id, case_id, name, relationship, phone, email, is_primary, note
  ) VALUES (
    v_contact_id,
    v_owner_id,
    v_case_id,
    p_contact ->> 'name',
    coalesce(p_contact ->> 'relationship', ''),
    coalesce(p_contact ->> 'phone', ''),
    coalesce(p_contact ->> 'email', ''),
    v_primary,
    coalesce(p_contact ->> 'note', '')
  )
  ON CONFLICT (id) DO UPDATE
    SET case_id = EXCLUDED.case_id,
        name = EXCLUDED.name,
        relationship = EXCLUDED.relationship,
        phone = EXCLUDED.phone,
        email = EXCLUDED.email,
        is_primary = EXCLUDED.is_primary,
        note = EXCLUDED.note
  WHERE public.case_contacts.org_id = v_org_id;

  GET DIAGNOSTICS v_saved = ROW_COUNT;
  IF v_saved <> 1 THEN
    RAISE EXCEPTION 'Contact not found for the authenticated owner' USING ERRCODE = 'P0002';
  END IF;
END
$$;

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
     SET partner_id = nullif(p_completed ->> 'partner_id', '')::uuid,
         referral_id = nullif(p_completed ->> 'referral_id', '')::uuid,
         case_id = nullif(p_completed ->> 'case_id', '')::uuid,
         title = p_completed ->> 'title',
         due_on = (p_completed ->> 'due_on')::date,
         status = p_completed ->> 'status',
         completed_at = nullif(p_completed ->> 'completed_at', '')::timestamptz,
         note = coalesce(p_completed ->> 'note', ''),
         kind = coalesce(p_completed ->> 'kind', 'follow_up'),
         due_time = nullif(p_completed ->> 'due_time', '')::time,
         waiting_on = coalesce(p_completed ->> 'waiting_on', ''),
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
  ON CONFLICT (id) DO UPDATE SET
    partner_id = EXCLUDED.partner_id, referral_id = EXCLUDED.referral_id,
    case_id = EXCLUDED.case_id, title = EXCLUDED.title, due_on = EXCLUDED.due_on,
    status = EXCLUDED.status, completed_at = EXCLUDED.completed_at,
    note = EXCLUDED.note, kind = EXCLUDED.kind, due_time = EXCLUDED.due_time,
    waiting_on = EXCLUDED.waiting_on, snoozed_until = EXCLUDED.snoozed_until
  WHERE public.follow_ups.org_id = v_org_id;

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

CREATE OR REPLACE FUNCTION public.complete_follow_up_with_outcome(p_completed jsonb, p_referral_id uuid, p_outcome jsonb)
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
         snoozed_until = nullif(p_completed ->> 'snoozed_until', '')::date,
         note = coalesce(p_completed ->> 'note', note)
   WHERE id = (p_completed ->> 'id')::uuid AND org_id = v_org_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN RAISE EXCEPTION 'Follow-up not found for the authenticated owner' USING ERRCODE = 'P0002'; END IF;

  UPDATE public.referrals
     SET admitted = CASE WHEN p_outcome ? 'admitted' THEN (p_outcome ->> 'admitted')::boolean ELSE admitted END,
         admitted_on = CASE WHEN p_outcome ? 'admitted_on' THEN nullif(p_outcome ->> 'admitted_on', '')::date ELSE admitted_on END,
         family_experience = CASE WHEN p_outcome ? 'family_experience' THEN nullif(p_outcome ->> 'family_experience', '')::smallint ELSE family_experience END,
         outcome_note = CASE WHEN p_outcome ? 'outcome_note' THEN coalesce(p_outcome ->> 'outcome_note', '') ELSE outcome_note END,
         outcome = CASE WHEN p_outcome ? 'outcome' THEN nullif(p_outcome ->> 'outcome', '') ELSE outcome END
   WHERE id = p_referral_id AND org_id = v_org_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN RAISE EXCEPTION 'Referral not found for the authenticated owner' USING ERRCODE = 'P0002'; END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.complete_follow_up_with_case(
  p_completed jsonb,
  p_case jsonb,
  p_event jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_org_id uuid := public.current_org_id();
  v_case_id uuid := (p_case ->> 'id')::uuid;
  v_updated integer;
BEGIN
  IF v_owner_id IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;

  UPDATE public.follow_ups
     SET status = p_completed ->> 'status',
         completed_at = nullif(p_completed ->> 'completed_at', '')::timestamptz,
         snoozed_until = nullif(p_completed ->> 'snoozed_until', '')::date,
         note = coalesce(p_completed ->> 'note', note)
   WHERE id = (p_completed ->> 'id')::uuid
     AND org_id = v_org_id
     AND case_id = v_case_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'Case-linked follow-up not found for the authenticated owner' USING ERRCODE = 'P0002';
  END IF;

  IF (CASE
        WHEN p_case ? 'apply_status' THEN coalesce((p_case ->> 'apply_status')::boolean, false)
        ELSE pg_catalog.strpos(coalesce(p_event ->> 'body', ''), '(case → ') > 0
      END) THEN
    UPDATE public.cases AS c
       SET status = p_case ->> 'status',
           updated_at = pg_catalog.now()
     WHERE c.id = v_case_id AND c.org_id = v_org_id;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> 1 THEN
      RAISE EXCEPTION 'Case not found for the authenticated owner' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  INSERT INTO public.case_events (id, owner_id, case_id, kind, body, occurred_at)
  VALUES (
    (p_event ->> 'id')::uuid,
    v_owner_id,
    v_case_id,
    coalesce(p_event ->> 'kind', 'system'),
    coalesce(p_event ->> 'body', ''),
    coalesce(nullif(p_event ->> 'occurred_at', '')::timestamptz, pg_catalog.now())
  )
  ON CONFLICT (id) DO UPDATE
    SET case_id = EXCLUDED.case_id,
        kind = EXCLUDED.kind,
        body = EXCLUDED.body,
        occurred_at = EXCLUDED.occurred_at
  WHERE public.case_events.org_id = v_org_id
    AND public.case_events.case_id = EXCLUDED.case_id
    AND public.case_events.kind = EXCLUDED.kind;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'Case event ID is already used by another request' USING ERRCODE = '23505';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.save_case_document_with_event(p_document jsonb, p_event jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_org_id uuid := public.current_org_id();
  v_case_id uuid := (p_document ->> 'case_id')::uuid;
  v_document_id uuid := (p_document ->> 'id')::uuid;
BEGIN
  IF v_owner_id IS NULL OR v_org_id IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  IF (p_event ->> 'case_id')::uuid IS DISTINCT FROM v_case_id
     OR (p_event ->> 'document_id')::uuid IS DISTINCT FROM v_document_id THEN
    RAISE EXCEPTION 'Document event links do not match';
  END IF;

  INSERT INTO public.case_documents (
    id, owner_id, case_id, label, storage_path, mime_type, size_bytes, created_at
  ) VALUES (
    v_document_id, v_owner_id, v_case_id,
    coalesce(p_document ->> 'label', ''), p_document ->> 'storage_path',
    coalesce(p_document ->> 'mime_type', 'application/octet-stream'),
    nullif(p_document ->> 'size_bytes', '')::bigint,
    coalesce(nullif(p_document ->> 'created_at', '')::timestamptz, now())
  )
  ON CONFLICT (id) DO UPDATE
     SET label = EXCLUDED.label,
         storage_path = EXCLUDED.storage_path,
         mime_type = EXCLUDED.mime_type,
         size_bytes = EXCLUDED.size_bytes
   WHERE case_documents.org_id = v_org_id;

  INSERT INTO public.case_events (
    id, owner_id, case_id, kind, body, contact_id, referral_id, document_id, occurred_at
  ) VALUES (
    (p_event ->> 'id')::uuid, v_owner_id, v_case_id,
    coalesce(p_event ->> 'kind', 'document'), coalesce(p_event ->> 'body', ''),
    nullif(p_event ->> 'contact_id', '')::uuid,
    nullif(p_event ->> 'referral_id', '')::uuid,
    v_document_id,
    coalesce(nullif(p_event ->> 'occurred_at', '')::timestamptz, now())
  )
  ON CONFLICT (id) DO UPDATE
     SET kind = EXCLUDED.kind, body = EXCLUDED.body, document_id = EXCLUDED.document_id,
         occurred_at = EXCLUDED.occurred_at
   WHERE case_events.org_id = v_org_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.restore_case_document(p_document jsonb, p_event_ids uuid[] DEFAULT ARRAY[]::uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_org_id uuid := public.current_org_id();
  v_case_id uuid := (p_document ->> 'case_id')::uuid;
  v_document_id uuid := (p_document ->> 'id')::uuid;
BEGIN
  IF v_owner_id IS NULL OR v_org_id IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;

  INSERT INTO public.case_documents (
    id, owner_id, case_id, label, storage_path, mime_type, size_bytes, created_at
  ) VALUES (
    v_document_id, v_owner_id, v_case_id,
    coalesce(p_document ->> 'label', ''), p_document ->> 'storage_path',
    coalesce(p_document ->> 'mime_type', 'application/octet-stream'),
    nullif(p_document ->> 'size_bytes', '')::bigint,
    coalesce(nullif(p_document ->> 'created_at', '')::timestamptz, now())
  )
  ON CONFLICT (id) DO UPDATE
     SET label = EXCLUDED.label, storage_path = EXCLUDED.storage_path,
         mime_type = EXCLUDED.mime_type, size_bytes = EXCLUDED.size_bytes
   WHERE case_documents.org_id = v_org_id;

  UPDATE public.case_events
     SET document_id = v_document_id
   WHERE org_id = v_org_id
     AND case_id = v_case_id
     AND id = ANY(coalesce(p_event_ids, ARRAY[]::uuid[]));
END;
$$;

CREATE OR REPLACE FUNCTION public.save_match_with_case(p_expected_owner_id uuid, p_match jsonb, p_case_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_org_id uuid := public.current_org_id();
  v_updated integer;
BEGIN
  IF v_owner_id IS NULL OR v_owner_id <> p_expected_owner_id THEN RAISE EXCEPTION 'Authenticated account changed' USING ERRCODE='42501'; END IF;
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'Workspace membership required' USING ERRCODE='42501'; END IF;
  INSERT INTO public.match_profiles (id, owner_id, client_label, level_of_care, state, insurance, network_preferences, max_budget, therapies, status, assigned_partner_id, referral_id, case_id)
  VALUES ((p_match->>'id')::uuid, v_owner_id, p_match->>'client_label', p_match->>'level_of_care', p_match->>'state', p_match->>'insurance', coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p_match->'network_preferences','[]'::jsonb))), ARRAY[]::text[]), nullif(p_match->>'max_budget','')::integer, coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p_match->'therapies','[]'::jsonb))), ARRAY[]::text[]), coalesce(p_match->>'status','Matching'), nullif(p_match->>'assigned_partner_id','')::uuid, nullif(p_match->>'referral_id','')::uuid, p_case_id)
  ON CONFLICT (id) DO UPDATE SET client_label=EXCLUDED.client_label, level_of_care=EXCLUDED.level_of_care, state=EXCLUDED.state, insurance=EXCLUDED.insurance, network_preferences=EXCLUDED.network_preferences, max_budget=EXCLUDED.max_budget, therapies=EXCLUDED.therapies, status=EXCLUDED.status, assigned_partner_id=EXCLUDED.assigned_partner_id, referral_id=EXCLUDED.referral_id, case_id=EXCLUDED.case_id WHERE match_profiles.org_id=v_org_id;
  UPDATE public.cases SET match_profile_id=(p_match->>'id')::uuid WHERE id=p_case_id AND org_id=v_org_id;
  GET DIAGNOSTICS v_updated=ROW_COUNT;
  IF v_updated<>1 THEN RAISE EXCEPTION 'Owned case was not found'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.assign_match_referral(p_expected_owner_id uuid, p_referral jsonb, p_match jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_org_id uuid := public.current_org_id();
  v_updated integer;
BEGIN
  IF v_owner_id IS NULL OR v_owner_id<>p_expected_owner_id THEN RAISE EXCEPTION 'Authenticated account changed' USING ERRCODE='42501'; END IF;
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'Workspace membership required' USING ERRCODE='42501'; END IF;
  IF EXISTS (SELECT 1 FROM public.match_profiles WHERE id=(p_match->>'id')::uuid AND org_id=v_org_id) THEN
    UPDATE public.match_profiles SET
      client_label=coalesce(p_match->>'client_label',client_label),
      level_of_care=coalesce(p_match->>'level_of_care',level_of_care),
      state=coalesce(p_match->>'state',state),
      insurance=coalesce(p_match->>'insurance',insurance),
      status=coalesce(p_match->>'status',status),
      assigned_partner_id=coalesce(nullif(p_match->>'assigned_partner_id','')::uuid,assigned_partner_id),
      case_id=coalesce(nullif(p_match->>'case_id','')::uuid,case_id), updated_at=now()
    WHERE id=(p_match->>'id')::uuid AND org_id=v_org_id;
  ELSE
    INSERT INTO public.match_profiles (id,owner_id,client_label,level_of_care,state,insurance,network_preferences,max_budget,therapies,status,assigned_partner_id,referral_id,case_id)
    VALUES ((p_match->>'id')::uuid,v_owner_id,p_match->>'client_label',p_match->>'level_of_care',p_match->>'state',p_match->>'insurance',coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p_match->'network_preferences','[]'::jsonb))),ARRAY[]::text[]),nullif(p_match->>'max_budget','')::integer,coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p_match->'therapies','[]'::jsonb))),ARRAY[]::text[]),coalesce(p_match->>'status','Matching'),nullif(p_match->>'assigned_partner_id','')::uuid,NULL,nullif(p_match->>'case_id','')::uuid);
  END IF;
  INSERT INTO public.referrals (id,owner_id,partner_id,direction,referred_on,client_label,outcome,note,packet_sent_at,match_profile_id,case_id,admitted,admitted_on,family_experience,outcome_note)
  VALUES ((p_referral->>'id')::uuid,v_owner_id,(p_referral->>'partner_id')::uuid,p_referral->>'direction',(p_referral->>'referred_on')::date,p_referral->>'client_label',p_referral->>'outcome',coalesce(p_referral->>'note',''),nullif(p_referral->>'packet_sent_at','')::timestamptz,nullif(p_referral->>'match_profile_id','')::uuid,nullif(p_referral->>'case_id','')::uuid,nullif(p_referral->>'admitted','')::boolean,nullif(p_referral->>'admitted_on','')::date,nullif(p_referral->>'family_experience','')::smallint,coalesce(p_referral->>'outcome_note',''))
  ON CONFLICT (id) DO UPDATE SET partner_id=EXCLUDED.partner_id,direction=EXCLUDED.direction,referred_on=EXCLUDED.referred_on,client_label=EXCLUDED.client_label,outcome=EXCLUDED.outcome,note=EXCLUDED.note,packet_sent_at=EXCLUDED.packet_sent_at,match_profile_id=EXCLUDED.match_profile_id,case_id=EXCLUDED.case_id,admitted=EXCLUDED.admitted,admitted_on=EXCLUDED.admitted_on,family_experience=EXCLUDED.family_experience,outcome_note=EXCLUDED.outcome_note WHERE referrals.org_id=v_org_id;
  UPDATE public.match_profiles SET client_label=p_match->>'client_label',status=p_match->>'status',assigned_partner_id=nullif(p_match->>'assigned_partner_id','')::uuid,referral_id=(p_referral->>'id')::uuid,case_id=nullif(p_match->>'case_id','')::uuid,updated_at=now() WHERE id=(p_match->>'id')::uuid AND org_id=v_org_id;
  GET DIAGNOSTICS v_updated=ROW_COUNT; IF v_updated<>1 THEN RAISE EXCEPTION 'Owned match was not found'; END IF;
  IF nullif(p_match->>'case_id','') IS NOT NULL THEN
    UPDATE public.cases SET match_profile_id=(p_match->>'id')::uuid WHERE id=(p_match->>'case_id')::uuid AND org_id=v_org_id;
    GET DIAGNOSTICS v_updated=ROW_COUNT; IF v_updated<>1 THEN RAISE EXCEPTION 'Owned case was not found'; END IF;
  END IF;
END $$;

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
    IF EXISTS (SELECT 1 FROM public.match_profiles WHERE id=(p_match->>'id')::uuid AND org_id=v_org_id) THEN
      UPDATE public.match_profiles SET
        client_label=coalesce(p_match->>'client_label',client_label),
        level_of_care=coalesce(p_match->>'level_of_care',level_of_care),
        state=coalesce(p_match->>'state',state),
        insurance=coalesce(p_match->>'insurance',insurance),
        status=coalesce(p_match->>'status',status),
        assigned_partner_id=coalesce(nullif(p_match->>'assigned_partner_id','')::uuid,assigned_partner_id),
        case_id=coalesce(nullif(p_match->>'case_id','')::uuid,case_id), updated_at=now()
      WHERE id=(p_match->>'id')::uuid AND org_id=v_org_id;
    ELSE
      INSERT INTO public.match_profiles (id,owner_id,client_label,level_of_care,state,insurance,network_preferences,max_budget,therapies,status,assigned_partner_id,referral_id,case_id)
      VALUES ((p_match->>'id')::uuid,v_owner_id,p_match->>'client_label',p_match->>'level_of_care',p_match->>'state',p_match->>'insurance',coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p_match->'network_preferences','[]'::jsonb))),ARRAY[]::text[]),nullif(p_match->>'max_budget','')::integer,coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p_match->'therapies','[]'::jsonb))),ARRAY[]::text[]),coalesce(p_match->>'status','Referred'),nullif(p_match->>'assigned_partner_id','')::uuid,NULL,nullif(p_match->>'case_id','')::uuid);
    END IF;
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

CREATE OR REPLACE FUNCTION public.log_contact_activity(p_expected_owner_id uuid, p_event jsonb DEFAULT NULL, p_touch jsonb DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_org_id uuid := public.current_org_id();
BEGIN
  IF v_owner_id IS NULL OR v_owner_id <> p_expected_owner_id THEN
    RAISE EXCEPTION 'Authenticated account changed' USING ERRCODE = '42501';
  END IF;
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'Workspace membership required' USING ERRCODE='42501'; END IF;
  IF (p_event IS NULL OR p_event = 'null'::jsonb) AND (p_touch IS NULL OR p_touch = 'null'::jsonb) THEN
    RAISE EXCEPTION 'A case event or partner touch is required';
  END IF;
  IF p_event IS NOT NULL AND p_event <> 'null'::jsonb THEN
    INSERT INTO public.case_events (id,owner_id,case_id,kind,body,contact_id,referral_id,document_id,occurred_at)
    VALUES ((p_event->>'id')::uuid,v_owner_id,(p_event->>'case_id')::uuid,p_event->>'kind',coalesce(p_event->>'body',''),nullif(p_event->>'contact_id','')::uuid,nullif(p_event->>'referral_id','')::uuid,nullif(p_event->>'document_id','')::uuid,coalesce(nullif(p_event->>'occurred_at','')::timestamptz,now()))
    ON CONFLICT (id) DO UPDATE SET kind=EXCLUDED.kind,body=EXCLUDED.body,contact_id=EXCLUDED.contact_id,occurred_at=EXCLUDED.occurred_at WHERE case_events.org_id=v_org_id;
  END IF;
  IF p_touch IS NOT NULL AND p_touch <> 'null'::jsonb THEN
    INSERT INTO public.touches (id,owner_id,partner_id,kind,note,occurred_at)
    VALUES ((p_touch->>'id')::uuid,v_owner_id,(p_touch->>'partner_id')::uuid,p_touch->>'kind',coalesce(p_touch->>'note',''),coalesce(nullif(p_touch->>'occurred_at','')::timestamptz,now()))
    ON CONFLICT (id) DO UPDATE SET kind=EXCLUDED.kind,note=EXCLUDED.note,occurred_at=EXCLUDED.occurred_at WHERE touches.org_id=v_org_id;
  END IF;
END $$;

-- ─── 10. Workspace management RPCs ───────────────────────────────────────────

-- Owner creates a single-use invite code, shared out-of-band (text/email).
CREATE OR REPLACE FUNCTION public.create_org_invite()
RETURNS TABLE (code text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid;
  v_code text;
  v_expires timestamptz := now() + interval '7 days';
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  SELECT org_id INTO v_org FROM public.org_members WHERE user_id = v_user AND role = 'owner';
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Only the workspace owner can create invites' USING ERRCODE = '42501';
  END IF;

  v_code := lower(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 10));
  INSERT INTO public.org_invites (org_id, code, invited_by, expires_at)
  VALUES (v_org, v_code, v_user, v_expires);

  RETURN QUERY SELECT v_code, v_expires;
END
$$;

-- Joining a practice re-homes the caller and every row they authored into the
-- new workspace, atomically (the org FKs are deferrable for exactly this).
-- The caller's now-empty personal org is deleted.
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
  v_display text;
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

  SELECT org_id, role, display_name INTO v_old_org, v_old_role, v_display
    FROM public.org_members WHERE user_id = v_user;
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

  UPDATE public.org_members SET org_id = v_invite.org_id, role = 'member'
   WHERE user_id = v_user;

  UPDATE public.partners           SET org_id = v_invite.org_id WHERE owner_id = v_user;
  UPDATE public.touches            SET org_id = v_invite.org_id WHERE owner_id = v_user;
  UPDATE public.referrals          SET org_id = v_invite.org_id WHERE owner_id = v_user;
  UPDATE public.match_profiles     SET org_id = v_invite.org_id WHERE owner_id = v_user;
  UPDATE public.follow_ups         SET org_id = v_invite.org_id WHERE owner_id = v_user;
  UPDATE public.cases              SET org_id = v_invite.org_id WHERE owner_id = v_user;
  UPDATE public.case_contacts      SET org_id = v_invite.org_id WHERE owner_id = v_user;
  UPDATE public.case_events        SET org_id = v_invite.org_id WHERE owner_id = v_user;
  UPDATE public.case_documents     SET org_id = v_invite.org_id WHERE owner_id = v_user;
  UPDATE public.case_stage_history SET org_id = v_invite.org_id WHERE owner_id = v_user;
  UPDATE public.case_integrations  SET org_id = v_invite.org_id WHERE owner_id = v_user;

  UPDATE public.org_invites
     SET accepted_by = v_user, accepted_at = now()
   WHERE id = v_invite.id;

  DELETE FROM public.orgs o
   WHERE o.id = v_old_org
     AND NOT EXISTS (SELECT 1 FROM public.org_members m WHERE m.org_id = o.id);
END
$$;

-- Owner removes a member. The member's workspace rows stay with the practice;
-- the member gets a fresh empty personal org.
CREATE OR REPLACE FUNCTION public.remove_org_member(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid;
  v_new_org uuid;
  v_display text;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  SELECT org_id INTO v_org FROM public.org_members WHERE user_id = v_user AND role = 'owner';
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Only the workspace owner can remove members' USING ERRCODE = '42501';
  END IF;
  IF p_user_id = v_user THEN
    RAISE EXCEPTION 'The workspace owner cannot remove themselves' USING ERRCODE = '22023';
  END IF;

  SELECT display_name INTO v_display FROM public.org_members
   WHERE user_id = p_user_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Member not found in your workspace' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.orgs (name, created_by) VALUES ('My Practice', p_user_id)
  RETURNING id INTO v_new_org;
  UPDATE public.org_members SET org_id = v_new_org, role = 'owner'
   WHERE user_id = p_user_id;
END
$$;

REVOKE ALL ON FUNCTION public.create_org_invite(), public.accept_org_invite(text), public.remove_org_member(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_org_invite(), public.accept_org_invite(text), public.remove_org_member(uuid) TO authenticated;

COMMIT;
