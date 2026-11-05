-- ReferralFit - Level-of-care assessment (2026-11-04).
--
-- A short, structured intake across six areas gives a recommended level of
-- care and a written rationale, so every placement has its clinical
-- reasoning on paper (and payers get a level-of-care justification). The
-- six areas follow the widely used six-dimension framework; every question,
-- descriptor, rule and sentence is ReferralFit's own wording. It is DECISION
-- SUPPORT, not a diagnosis: the practitioner can always choose a different
-- level, with a one-line reason.
--
--   1. level_of_care_recommendation: the rules, mirrored from
--      src/lib/level-of-care.ts (LEVEL_OF_CARE_RULES, version 2: Matt's
--      clinical decisions of 2026-11-05). Both test suites check one digest
--      of all 15,625 rating sets, so they agree.
--   2. case_assessments: one row per assessment of a case. A case can be
--      reassessed; the newest row is current. Six ratings (0-4) and six
--      short notes (200 characters each), whether anyone was in immediate
--      danger, the recommendation, the chosen level and the reason for a
--      different one, the rules version, who assessed and when. A reason
--      is needed whenever the chosen level is not where the recommendation
--      starts (Detox when it is the first step), and it goes through the
--      shared identifying-details check (identifying_text_problem, from
--      20261104140000) because it goes into the program's packet.
--   3. Reads: the case's workspace only (RLS). anon reads nothing. No client
--      writes; save_case_assessment (SECURITY DEFINER) checks everything and
--      writes the timeline entry, which names the levels and never a rating.
--   4. Deleting a case deletes its assessments; deleting a sole owner's
--      account deletes them with the workspace (its cases); a deleted
--      teammate's assessments stay with the practice, unattributed.
--   5. org_move_workspace_rows: a joiner's assessments move with the
--      workspace (they also follow their case through ON UPDATE CASCADE).
--
-- Placement requests are untouched: nothing from an assessment goes into
-- their payload. The 1.0.4 app does not know this table; nothing it calls
-- changes. See docs/LEVEL_OF_CARE.md.
--
-- Transit rule: this file is pasted into the SQL editor from a chat client.
-- ASCII only, no backslash characters anywhere, every top-level statement
-- under 3,700 characters.

BEGIN;

-- Paste order: this file uses identifying_text_problem and
-- identifying_case_names, and re-creates the workspace move with the
-- placement request tables, so 20261104140000_placement_requests.sql must
-- already be in. A skipped paste stops here, before anything changes.
DO $$
BEGIN
  IF to_regclass('public.placement_requests') IS NULL OR to_regclass('public.placement_request_recipients') IS NULL
     OR to_regprocedure('public.identifying_text_problem(text, text[])') IS NULL
     OR to_regprocedure('public.identifying_case_names(uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION 'Paste 20261104140000_placement_requests.sql first: the placement request tables or the identifying-details check are missing.';
  END IF;
END
$$;

-- ===========================================================================
-- 1. Pure helpers
-- ===========================================================================

-- The rules, version 2. p_ratings: the six areas in order (withdrawal,
-- physical, emotional, readiness, relapse, environment), each 0-4.
--   level       Inpatient when physical or emotional is 3+, relapse or
--               environment is 4, two or more of readiness, relapse and
--               environment are 3+, or four or more of physical, emotional,
--               readiness, relapse and environment are 2+. Else IOP / PHP
--               when physical, emotional or relapse is 2+, readiness is 3+,
--               or withdrawal is 2+ (at 2 it needs medical oversight; at 3+
--               detox comes first, and the step down after it is never
--               lower than IOP / PHP). Else Therapist.
--   first_step  Detox when withdrawal is 3+.
--   support     Sober Living when environment is 3+.
-- Only version 2 is accepted: NULL for any other. Mirrors recommend() in
-- src/lib/level-of-care.ts; change both together.
CREATE OR REPLACE FUNCTION public.level_of_care_recommendation(p_ratings integer[], p_rules_version integer)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  w integer := p_ratings[1];
  p integer := p_ratings[2];
  m integer := p_ratings[3];
  r integer := p_ratings[4];
  u integer := p_ratings[5];
  e integer := p_ratings[6];
  v_level text := 'Therapist';
BEGIN
  IF p_rules_version IS DISTINCT FROM 2 THEN
    RETURN NULL;
  END IF;
  IF p >= 3 OR m >= 3 OR u >= 4 OR e >= 4
     OR ((r >= 3)::integer + (u >= 3)::integer + (e >= 3)::integer) >= 2
     OR ((p >= 2)::integer + (m >= 2)::integer + (r >= 2)::integer + (u >= 2)::integer + (e >= 2)::integer) >= 4 THEN
    v_level := 'Inpatient';
  ELSIF p >= 2 OR m >= 2 OR u >= 2 OR r >= 3 OR w >= 2 THEN
    v_level := 'IOP / PHP';
  END IF;
  RETURN jsonb_build_object(
    'level', v_level,
    'first_step', CASE WHEN w >= 3 THEN 'Detox' END,
    'support', CASE WHEN e >= 3 THEN 'Sober Living' END);
END
$$;
REVOKE ALL ON FUNCTION public.level_of_care_recommendation(integer[], integer) FROM PUBLIC, anon, authenticated;

-- The timeline wording: the levels only, never a rating. "; chosen X" when
-- the chosen level is not where the recommendation starts (its first step,
-- else its level). Mirrors assessmentEventBody in src/lib/level-of-care.ts.
CREATE OR REPLACE FUNCTION public.case_assessment_event_body(p_level text, p_first_step text, p_support text, p_chosen text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT 'Level-of-care assessment: recommended '
    || CASE WHEN p_first_step IS NOT NULL THEN p_first_step || ', then ' ELSE '' END
    || p_level
    || CASE WHEN p_support IS NOT NULL THEN ', with ' || p_support ELSE '' END
    || CASE WHEN p_chosen IS DISTINCT FROM coalesce(p_first_step, p_level) THEN '; chosen ' || p_chosen ELSE '' END
$$;
REVOKE ALL ON FUNCTION public.case_assessment_event_body(text, text, text, text) FROM PUBLIC, anon, authenticated;

-- The first thing wrong with the reason for choosing a different level, or
-- NULL. It goes into the program's copy of the packet: 3 to 200 characters,
-- one line, then the identifying-details check (no email addresses, links,
-- money, dates, phone or ID numbers, or a name word from p_names: the
-- case's title and its contacts' names). Mirrors reasonProblem.
CREATE OR REPLACE FUNCTION public.case_assessment_reason_problem(p_reason text, p_names text[])
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN length(btrim(coalesce(p_reason, ''))) < 3 THEN 'Say why you chose a different level. The reason goes in the program''s packet.'
    WHEN length(btrim(p_reason)) > 200 THEN 'Keep the reason to 200 characters'
    WHEN p_reason ~ '[[:cntrl:]]' THEN 'Keep the reason to one line'
    ELSE public.identifying_text_problem(p_reason, p_names)
  END
$$;
REVOKE ALL ON FUNCTION public.case_assessment_reason_problem(text, text[]) FROM PUBLIC, anon, authenticated;

-- The first thing wrong with an assessment, in plain words, or NULL: six
-- ratings 0-4, six notes (or none) of at most 200 characters, a level of
-- care, the recommendation the app showed matching these rules, and a reason
-- whenever the chosen level is not where the recommendation starts (its
-- first step when it has one, else its level). p_names: see the reason.
CREATE OR REPLACE FUNCTION public.case_assessment_problem(
  p_ratings integer[], p_notes text[], p_rules_version integer, p_level text, p_first_step text,
  p_support text, p_chosen text, p_reason text, p_names text[])
RETURNS text
LANGUAGE plpgsql IMMUTABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_rec jsonb;
BEGIN
  IF p_ratings IS NULL OR array_ndims(p_ratings) IS DISTINCT FROM 1 OR cardinality(p_ratings) <> 6
     OR EXISTS (SELECT 1 FROM unnest(p_ratings) AS x(v) WHERE x.v IS NULL OR x.v < 0 OR x.v > 4) THEN
    RETURN 'Rate all six areas from 0 to 4';
  END IF;
  IF p_notes IS NOT NULL AND (array_ndims(p_notes) IS DISTINCT FROM 1 OR cardinality(p_notes) <> 6) THEN
    RETURN 'Notes come one per area, six in all';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_notes) AS x(v) WHERE length(btrim(coalesce(x.v, ''))) > 200) THEN
    RETURN 'Keep each note to 200 characters';
  END IF;
  IF p_chosen IS NULL OR p_chosen NOT IN ('Detox', 'Inpatient', 'IOP / PHP', 'Sober Living', 'Therapist') THEN
    RETURN 'Choose a level of care';
  END IF;
  v_rec := public.level_of_care_recommendation(p_ratings, p_rules_version);
  IF v_rec IS NULL THEN
    RETURN 'This version of the app uses recommendation rules the server does not have. Update the app, then save again.';
  END IF;
  IF (v_rec ->> 'level', v_rec ->> 'first_step', v_rec ->> 'support')
     IS DISTINCT FROM (p_level, nullif(p_first_step, ''), nullif(p_support, '')) THEN
    RETURN 'The recommendation on this phone does not match the server''s rules. Update the app, then save again.';
  END IF;
  IF p_chosen = coalesce(v_rec ->> 'first_step', v_rec ->> 'level') THEN
    RETURN NULL;
  END IF;
  RETURN public.case_assessment_reason_problem(p_reason, p_names);
END
$$;
REVOKE ALL ON FUNCTION public.case_assessment_problem(integer[], text[], integer, text, text, text, text, text, text[]) FROM PUBLIC, anon, authenticated;

-- ===========================================================================
-- 2. The table
-- ===========================================================================

-- One assessment of one case; the newest (assessed_at, then id) is current.
-- id is made by the app, so a retry after a timeout is a no-op. The timeline
-- entry it wrote has the same id. override_reason is empty exactly when the
-- chosen level is where the recommendation starts: its first step when it
-- has one (Detox), else the recommended level.
CREATE TABLE IF NOT EXISTS public.case_assessments (
  id                     uuid PRIMARY KEY,
  org_id                 uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  case_id                uuid NOT NULL,
  withdrawal_rating      smallint NOT NULL CHECK (withdrawal_rating BETWEEN 0 AND 4),
  physical_rating        smallint NOT NULL CHECK (physical_rating BETWEEN 0 AND 4),
  emotional_rating       smallint NOT NULL CHECK (emotional_rating BETWEEN 0 AND 4),
  readiness_rating       smallint NOT NULL CHECK (readiness_rating BETWEEN 0 AND 4),
  relapse_rating         smallint NOT NULL CHECK (relapse_rating BETWEEN 0 AND 4),
  environment_rating     smallint NOT NULL CHECK (environment_rating BETWEEN 0 AND 4),
  withdrawal_note        text NOT NULL DEFAULT '' CHECK (length(withdrawal_note) <= 200),
  physical_note          text NOT NULL DEFAULT '' CHECK (length(physical_note) <= 200),
  emotional_note         text NOT NULL DEFAULT '' CHECK (length(emotional_note) <= 200),
  readiness_note         text NOT NULL DEFAULT '' CHECK (length(readiness_note) <= 200),
  relapse_note           text NOT NULL DEFAULT '' CHECK (length(relapse_note) <= 200),
  environment_note       text NOT NULL DEFAULT '' CHECK (length(environment_note) <= 200),
  imminent_danger        boolean NOT NULL DEFAULT false,
  recommended_level      text NOT NULL CHECK (recommended_level IN ('Inpatient', 'IOP / PHP', 'Therapist')),
  recommended_first_step text CHECK (recommended_first_step IN ('Detox')),
  recommended_support    text CHECK (recommended_support IN ('Sober Living')),
  chosen_level           text NOT NULL CHECK (chosen_level IN ('Detox', 'Inpatient', 'IOP / PHP', 'Sober Living', 'Therapist')),
  override_reason        text NOT NULL DEFAULT '' CHECK (length(override_reason) <= 200),
  rules_version          smallint NOT NULL CHECK (rules_version >= 1),
  assessed_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  assessed_at            timestamptz NOT NULL DEFAULT now(),
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_assessments_override_reason CHECK (
    (chosen_level = coalesce(recommended_first_step, recommended_level)) = (override_reason = '')),
  CONSTRAINT case_assessments_case_org_fk FOREIGN KEY (case_id, org_id)
    REFERENCES public.cases (id, org_id) ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);

CREATE INDEX IF NOT EXISTS case_assessments_case_idx ON public.case_assessments (case_id, org_id, assessed_at DESC, id DESC);

COMMENT ON TABLE public.case_assessments IS
  'Level-of-care assessments of a case (decision support, not a diagnosis): six ratings 0-4 with short notes, the recommendation, the chosen level and the reason for a different one. The newest is current. Written only through save_case_assessment.';

-- ===========================================================================
-- 3. Who reads what (RLS) and the grants
-- ===========================================================================

ALTER TABLE public.case_assessments ENABLE ROW LEVEL SECURITY;

-- Production's default ACL grants ALL on new tables: revoke first, then the
-- one narrow grant. There is no write policy, so even a stray grant writes
-- nothing; TRUNCATE (which RLS does not cover) is revoked here too.
REVOKE ALL ON TABLE public.case_assessments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.case_assessments TO authenticated;
GRANT ALL ON TABLE public.case_assessments TO service_role;

-- The case's workspace, and nobody else.
DROP POLICY IF EXISTS "case_assessments: workspace read" ON public.case_assessments;
CREATE POLICY "case_assessments: workspace read" ON public.case_assessments
  FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()));

-- ===========================================================================
-- 4. The writer
-- ===========================================================================

-- A saved row as the app reads it, plus event_body (the timeline wording).
CREATE OR REPLACE FUNCTION public.case_assessment_json(p_row public.case_assessments)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT to_jsonb(p_row) || jsonb_build_object('event_body', public.case_assessment_event_body(
    p_row.recommended_level, p_row.recommended_first_step, p_row.recommended_support, p_row.chosen_level))
$$;
REVOKE ALL ON FUNCTION public.case_assessment_json(public.case_assessments) FROM PUBLIC, anon, authenticated;

-- Save an assessment of a case in the caller's workspace, and its timeline
-- entry (same id). The app makes p_id: a retry returns the saved row and
-- changes nothing. case_assessment_problem checks everything; the reason
-- is screened against the case's title and its contacts' names.
CREATE OR REPLACE FUNCTION public.save_case_assessment(
  p_id uuid, p_case_id uuid, p_ratings integer[], p_notes text[], p_imminent_danger boolean,
  p_rules_version integer, p_recommended_level text, p_recommended_first_step text,
  p_recommended_support text, p_chosen_level text, p_override_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid := public.current_org_id();
  v_problem text;
  v_follows boolean;
  a public.case_assessments%ROWTYPE;
BEGIN
  IF v_user IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'An assessment id is required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO a FROM public.case_assessments x WHERE x.id = p_id;
  IF FOUND THEN
    IF a.org_id <> v_org THEN
      RAISE EXCEPTION 'Assessment not found' USING ERRCODE = 'P0002';
    END IF;
    RETURN public.case_assessment_json(a);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cases c WHERE c.id = p_case_id AND c.org_id = v_org) THEN
    RAISE EXCEPTION 'Case not found' USING ERRCODE = 'P0002';
  END IF;
  v_problem := public.case_assessment_problem(p_ratings, p_notes, p_rules_version, p_recommended_level,
    p_recommended_first_step, p_recommended_support, p_chosen_level, p_override_reason, public.identifying_case_names(p_case_id, v_org));
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION '%', v_problem USING ERRCODE = '22023';
  END IF;
  v_follows := p_chosen_level = coalesce(nullif(p_recommended_first_step, ''), p_recommended_level);
  INSERT INTO public.case_assessments (id, org_id, case_id, withdrawal_rating, physical_rating, emotional_rating,
    readiness_rating, relapse_rating, environment_rating, withdrawal_note, physical_note, emotional_note,
    readiness_note, relapse_note, environment_note, imminent_danger, recommended_level, recommended_first_step,
    recommended_support, chosen_level, override_reason, rules_version, assessed_by)
  VALUES (p_id, v_org, p_case_id, p_ratings[1], p_ratings[2], p_ratings[3], p_ratings[4], p_ratings[5], p_ratings[6],
    btrim(coalesce(p_notes[1], '')), btrim(coalesce(p_notes[2], '')), btrim(coalesce(p_notes[3], '')),
    btrim(coalesce(p_notes[4], '')), btrim(coalesce(p_notes[5], '')), btrim(coalesce(p_notes[6], '')),
    coalesce(p_imminent_danger, false), p_recommended_level, nullif(p_recommended_first_step, ''),
    nullif(p_recommended_support, ''), p_chosen_level,
    CASE WHEN v_follows THEN '' ELSE btrim(p_override_reason) END, p_rules_version, v_user)
  ON CONFLICT (id) DO NOTHING
  RETURNING * INTO a;
  IF NOT FOUND THEN -- a retry of the same save got there first
    SELECT * INTO a FROM public.case_assessments x WHERE x.id = p_id AND x.org_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Assessment not found' USING ERRCODE = 'P0002';
    END IF;
    RETURN public.case_assessment_json(a);
  END IF;
  INSERT INTO public.case_events (id, owner_id, org_id, case_id, kind, body, occurred_at)
  VALUES (p_id, v_user, v_org, p_case_id, 'system', public.case_assessment_event_body(a.recommended_level,
    a.recommended_first_step, a.recommended_support, a.chosen_level), a.assessed_at)
  ON CONFLICT (id) DO NOTHING;
  RETURN public.case_assessment_json(a);
END
$$;
REVOKE ALL ON FUNCTION public.save_case_assessment(uuid, uuid, integer[], text[], boolean, integer, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_case_assessment(uuid, uuid, integer[], text[], boolean, integer, text, text, text, text, text) TO authenticated;

-- ===========================================================================
-- 5. A joiner's assessments move with the workspace
-- ===========================================================================

-- Same as 20261104140000 (its latest definition), plus the assessments.
-- They follow their case through the ON UPDATE CASCADE foreign key; this
-- line makes the rule visible and moves anything left.
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
  UPDATE public.placement_requests    SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.placement_request_recipients SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.case_assessments      SET org_id = p_to WHERE org_id = p_from;
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

COMMIT;
