BEGIN;

-- Matching integrity: hard requirements hide, fit scores order, counts never rank.
--
-- Roadmap item "matching integrity" (Matt Brown, 2026-10-01). The ranking
-- itself runs in the app (src/lib/matching.ts, docs/MATCHING.md). This
-- migration adds what the rule needs to persist:
--
--   1. partners: a disclosed financial relationship with the practice.
--      Private to the workspace. It is NEVER published to the directory and
--      never part of any synced, pushed, or profile field list.
--   2. match_profiles: who the client is (population), where the family
--      wants care (location_preference), and which selected needs are
--      must-haves. NULL must_have_therapies means "saved before this
--      change": the app applies the defaults (MAT only).
--   3. placement_decisions: the shortlist a clinician saw, with scores,
--      the pick, its rank, and the reason when the pick was not the top
--      result. Append-only, org-scoped, RLS like the rest.
--   4. save_match_with_case carries the new match-profile columns.
--
-- Nothing here changes referral counts: partner_balances stays as data.
--
-- Transit rule: this file is pasted into the SQL editor from a chat client.
-- No backslashes and no non-ASCII characters anywhere in it.

-- ===========================================================================
-- 1. partners: financial relationship (disclosed, private, never published)
-- ===========================================================================

ALTER TABLE public.partners ADD COLUMN IF NOT EXISTS financial_relationship text NOT NULL DEFAULT 'none';
ALTER TABLE public.partners ADD COLUMN IF NOT EXISTS financial_relationship_note text NOT NULL DEFAULT '';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partners_financial_relationship_kind') THEN
    ALTER TABLE public.partners ADD CONSTRAINT partners_financial_relationship_kind
      CHECK (financial_relationship IN ('none', 'consulting_fee', 'marketing_agreement', 'speaking_fee', 'shared_ownership', 'other'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partners_financial_relationship_note_length') THEN
    ALTER TABLE public.partners ADD CONSTRAINT partners_financial_relationship_note_length
      CHECK (length(financial_relationship_note) <= 300);
  END IF;
END $$;

COMMENT ON COLUMN public.partners.financial_relationship IS
  'Disclosed financial relationship between the practice and this partner. Shown to families; never affects ranking; never published to the directory.';

-- The rule, as data, so a test can hold every publish path to it: these
-- columns must never appear in global_partners or in any field list that
-- feeds it (global_partner_synced_fields, seed_partner_pushed_fields,
-- org_directory_profile_fields).
CREATE OR REPLACE FUNCTION public.partner_never_published_fields()
RETURNS text[]
LANGUAGE sql IMMUTABLE
AS $$
  SELECT ARRAY['financial_relationship', 'financial_relationship_note']
$$;
REVOKE ALL ON FUNCTION public.partner_never_published_fields() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_never_published_fields() TO authenticated;

-- ===========================================================================
-- 2. match_profiles: population, location preference, must-have needs
-- ===========================================================================

ALTER TABLE public.match_profiles ADD COLUMN IF NOT EXISTS must_have_therapies text[];
ALTER TABLE public.match_profiles ADD COLUMN IF NOT EXISTS population text NOT NULL DEFAULT 'Any';
ALTER TABLE public.match_profiles ADD COLUMN IF NOT EXISTS location_preference text NOT NULL DEFAULT 'No preference';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'match_profiles_population_kind') THEN
    ALTER TABLE public.match_profiles ADD CONSTRAINT match_profiles_population_kind
      CHECK (population IN ('Any', 'Men', 'Women', 'Adolescent'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'match_profiles_location_preference_kind') THEN
    ALTER TABLE public.match_profiles ADD CONSTRAINT match_profiles_location_preference_kind
      CHECK (location_preference IN ('No preference', 'Close to family', 'Away from home'));
  END IF;
END $$;

COMMENT ON COLUMN public.match_profiles.must_have_therapies IS
  'Selected needs the program must offer. NULL = saved before matching integrity; the app applies the defaults (MAT).';

-- ===========================================================================
-- 3. placement_decisions (append-only placement record)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.placement_decisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id            uuid NOT NULL REFERENCES public.orgs(id),
  match_profile_id  uuid NOT NULL,
  case_id           uuid,
  referral_id       uuid REFERENCES public.referrals(id) ON DELETE SET NULL,
  chosen_partner_id uuid,
  chosen_rank       integer NOT NULL CHECK (chosen_rank >= 1),
  reason            text CHECK (reason IN ('family_preference', 'bed_availability', 'clinical_judgment', 'other')),
  reason_note       text NOT NULL DEFAULT '' CHECK (length(reason_note) <= 500),
  candidates        jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(candidates) = 'array'),
  weights           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(weights) = 'object'),
  decided_at        timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT placement_decisions_reason_required CHECK (chosen_rank = 1 OR reason IS NOT NULL),
  CONSTRAINT placement_decisions_match_org_fk FOREIGN KEY (match_profile_id, org_id)
    REFERENCES public.match_profiles (id, org_id) ON DELETE CASCADE,
  CONSTRAINT placement_decisions_partner_org_fk FOREIGN KEY (chosen_partner_id, org_id)
    REFERENCES public.partners (id, org_id) ON DELETE SET NULL (chosen_partner_id),
  CONSTRAINT placement_decisions_case_org_fk FOREIGN KEY (case_id, org_id)
    REFERENCES public.cases (id, org_id) ON DELETE SET NULL (case_id)
);

COMMENT ON TABLE public.placement_decisions IS
  'What the clinician saw (top candidates with scores and components), what was chosen, its rank, and why when it was not the top. Append-only.';

CREATE INDEX IF NOT EXISTS placement_decisions_org_idx ON public.placement_decisions (org_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS placement_decisions_match_idx ON public.placement_decisions (match_profile_id);

DROP TRIGGER IF EXISTS placement_decisions_set_org ON public.placement_decisions;
CREATE TRIGGER placement_decisions_set_org BEFORE INSERT ON public.placement_decisions
  FOR EACH ROW EXECUTE FUNCTION public.set_row_org_from_owner();

ALTER TABLE public.placement_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "placement_decisions: org read" ON public.placement_decisions;
CREATE POLICY "placement_decisions: org read" ON public.placement_decisions
  FOR SELECT USING (org_id = public.current_org_id());

DROP POLICY IF EXISTS "placement_decisions: org insert" ON public.placement_decisions;
CREATE POLICY "placement_decisions: org insert" ON public.placement_decisions
  FOR INSERT WITH CHECK (org_id = public.current_org_id());

REVOKE ALL ON TABLE public.placement_decisions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.placement_decisions TO authenticated;
GRANT ALL ON TABLE public.placement_decisions TO service_role;

-- ===========================================================================
-- 4. save_match_with_case carries the new match-profile columns
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.save_match_with_case(p_expected_owner_id uuid, p_match jsonb, p_case_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_org_id uuid := public.current_org_id();
  v_updated integer;
  v_must_have text[];
BEGIN
  IF v_owner_id IS NULL OR v_owner_id <> p_expected_owner_id THEN RAISE EXCEPTION 'Authenticated account changed' USING ERRCODE='42501'; END IF;
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'Workspace membership required' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p_match->'must_have_therapies') = 'array' THEN
    v_must_have := ARRAY(SELECT jsonb_array_elements_text(p_match->'must_have_therapies'));
  END IF;
  INSERT INTO public.match_profiles (id, owner_id, client_label, level_of_care, state, insurance, network_preferences, max_budget, therapies, status, assigned_partner_id, referral_id, case_id, must_have_therapies, population, location_preference)
  VALUES ((p_match->>'id')::uuid, v_owner_id, p_match->>'client_label', p_match->>'level_of_care', p_match->>'state', p_match->>'insurance',
    coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p_match->'network_preferences','[]'::jsonb))), ARRAY[]::text[]),
    nullif(p_match->>'max_budget','')::integer,
    coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p_match->'therapies','[]'::jsonb))), ARRAY[]::text[]),
    coalesce(p_match->>'status','Matching'), nullif(p_match->>'assigned_partner_id','')::uuid, nullif(p_match->>'referral_id','')::uuid, p_case_id,
    v_must_have, coalesce(nullif(p_match->>'population',''), 'Any'), coalesce(nullif(p_match->>'location_preference',''), 'No preference'))
  ON CONFLICT (id) DO UPDATE SET client_label=EXCLUDED.client_label, level_of_care=EXCLUDED.level_of_care, state=EXCLUDED.state, insurance=EXCLUDED.insurance,
    network_preferences=EXCLUDED.network_preferences, max_budget=EXCLUDED.max_budget, therapies=EXCLUDED.therapies, status=EXCLUDED.status,
    assigned_partner_id=EXCLUDED.assigned_partner_id, referral_id=EXCLUDED.referral_id, case_id=EXCLUDED.case_id,
    must_have_therapies=EXCLUDED.must_have_therapies, population=EXCLUDED.population, location_preference=EXCLUDED.location_preference
  WHERE match_profiles.org_id=v_org_id;
  UPDATE public.cases SET match_profile_id=(p_match->>'id')::uuid WHERE id=p_case_id AND org_id=v_org_id;
  GET DIAGNOSTICS v_updated=ROW_COUNT;
  IF v_updated<>1 THEN RAISE EXCEPTION 'Owned case was not found'; END IF;
END $$;

COMMIT;
