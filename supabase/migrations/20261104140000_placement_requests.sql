-- ReferralFit - Placement Request (2026-11-04).
--
-- Today a practitioner calls programs one by one to ask about beds, fit and
-- price. A placement request asks several of the practice's own ranked
-- programs at once with ONE de-identified summary, and the answers come
-- back side by side within hours.
--
--   1. placement_requests: one row per request. Its payload is built HERE,
--      on the server, from an allow-list (placement_request_payload): level
--      of care, population, needs and must-haves, the insurance carrier's
--      name (never a member id) or self-pay (never a budget), home state
--      and location preference, the admit window, and a short note that is
--      refused if it carries contact details, money, or the client's label.
--      A CHECK refuses any other key, whoever writes the row.
--   2. placement_request_recipients: one row per program asked, in the
--      practice's own ranked order (rank). channel 'portal' when the
--      program's listing is claimed by a center account that answers in
--      the center portal, otherwise 'manual' (the practitioner texts or
--      emails the summary and logs the answer by hand).
--   3. Reads: the practice reads its own rows (RLS). Centers read nothing
--      directly: list_center_placement_requests returns only the rows
--      addressed to a listing they claimed, with the practice's name and no
--      client identity. anon reads nothing. No client writes either table.
--   4. Writes, all SECURITY DEFINER: create_placement_request,
--      cancel_placement_request, close_placement_request and
--      log_manual_response (the practice); mark_placement_request_viewed and
--      respond_to_placement_request (the center).
--   5. org_move_workspace_rows / org_merge_linked_partner_copies: a joiner's
--      requests move with the rest of the workspace.
--
-- ETHICS (non-negotiable):
--   * Answers NEVER change ranking or scores. The matcher
--     (src/lib/matching.ts) never reads these tables and nothing here
--     writes back to matching.
--   * Programs cannot pay to be asked or to be shown: who is asked is the
--     practitioner's choice from the practice's own ranked list.
--   * Nothing identifies the client until the family chooses a program and
--     the practitioner sends the packet through the existing flow.
--
-- The 1.0.4 app does not know these tables; nothing it calls changes. See
-- docs/PLACEMENT_REQUESTS.md.
--
-- Transit rule: this file is pasted into the SQL editor from a chat client.
-- ASCII only, no backslash characters anywhere, every top-level statement
-- under 3,700 characters.

BEGIN;

-- ===========================================================================
-- 1. Pure helpers
-- ===========================================================================

-- The first thing wrong with a request's note, in plain words, or NULL. No
-- email addresses, no phone, ID or date numbers, no links, no money
-- (programs never see the family's budget), and not the client's label or
-- the case title (p_identifiers). Names cannot be detected reliably; the app
-- warns. Mirrored by placementNoteProblem in src/lib/placement-requests.ts.
CREATE OR REPLACE FUNCTION public.placement_note_problem(p_note text, p_identifiers text[])
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN length(btrim(coalesce(p_note, ''))) > 300 THEN 'Keep the note to 300 characters'
    WHEN p_note ~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}' THEN 'Leave email addresses out of the note'
    WHEN p_note ~ '[0-9]([ ().-]*[0-9]){6,}' THEN 'Leave phone numbers, ID numbers and dates out of the note'
    WHEN p_note ~* '(https?:|www[.])' THEN 'Leave links out of the note'
    WHEN strpos(p_note, chr(36)) > 0 THEN 'Leave money out of the note. Programs never see the family''s budget.'
    WHEN EXISTS (SELECT 1 FROM unnest(coalesce(p_identifiers, ARRAY[]::text[])) AS i(v)
                  WHERE length(btrim(coalesce(i.v, ''))) >= 3 AND strpos(lower(p_note), lower(btrim(i.v))) > 0)
      THEN 'The note mentions how this client is labeled in your workspace. Leave names and labels out.'
  END
$$;
REVOKE ALL ON FUNCTION public.placement_note_problem(text, text[]) FROM PUBLIC, anon, authenticated;

-- The payload a program sees has these ten keys and nothing else. Each
-- value is checked against the app's own choices; anything unknown is
-- dropped, never passed through:
--   level_of_care        one of the app's levels, else 'Any type'
--   population           Any, Men, Women, Adolescent (an older profile
--                        carries it as a need, read as matching.ts does)
--   must_haves, needs    the app's needs list only; must-haves are the
--                        profile's (MAT by default) plus population needs
--   payment              'insurance' or 'self_pay'. A budget is never read.
--   insurance_carrier    the carrier's name only: no digits or @ (a member
--                        id never fits), at most 80 characters, else NULL
--   home_state           a two-letter state, else NULL
--   location_preference  No preference, Close to family, Away from home
--   admit_window         asap, this_week, two_weeks, flexible (required)
--   note                 at most 300 characters, NULL when empty
-- This helper: the needs from the app's list (data.ts therapyOptions) only,
-- each once, in the profile's order.
CREATE OR REPLACE FUNCTION public.placement_allowed_needs(p_therapies text[])
RETURNS text[]
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_allowed text[] := ARRAY['Men only', 'Women only', 'Adolescent', 'LGBTQ+', 'Trauma', 'Dual diagnosis', 'Eating disorders',
    'Gambling', 'Sex addiction', 'Chronic relapse', 'MAT', 'CBT', 'DBT', 'EMDR', 'IFS', 'Equine', 'Adventure',
    'Family systems', 'Chronic pain', 'Faith based'];
  v_needs text[];
BEGIN
  SELECT coalesce(array_agg(x.t ORDER BY x.n), ARRAY[]::text[]) INTO v_needs
    FROM (SELECT u.t, min(u.n) AS n FROM unnest(coalesce(p_therapies, ARRAY[]::text[])) WITH ORDINALITY AS u(t, n)
           WHERE u.t = ANY (v_allowed) GROUP BY u.t) AS x;
  RETURN v_needs;
END
$$;
REVOKE ALL ON FUNCTION public.placement_allowed_needs(text[]) FROM PUBLIC, anon, authenticated;

-- The de-identified summary a program sees, from the allow-list above.
-- Mirrored by buildPlacementPayload in src/lib/placement-requests.ts.
CREATE OR REPLACE FUNCTION public.placement_request_payload(
  p_level text, p_population text, p_therapies text[], p_must_haves text[],
  p_insurance text, p_state text, p_location text, p_admit_window text, p_note text)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_people text[] := ARRAY['Men only', 'Women only', 'Adolescent'];
  v_explicit text[] := coalesce(array_remove(p_must_haves, NULL), ARRAY['MAT']);
  v_level text := btrim(coalesce(p_level, ''));
  v_population text := btrim(coalesce(p_population, ''));
  v_insurance text := btrim(coalesce(p_insurance, ''));
  v_state text := upper(btrim(coalesce(p_state, '')));
  v_location text := btrim(coalesce(p_location, ''));
  v_window text := btrim(coalesce(p_admit_window, ''));
  v_note text := btrim(coalesce(p_note, ''));
  v_needs text[] := public.placement_allowed_needs(p_therapies);
BEGIN
  IF v_window NOT IN ('asap', 'this_week', 'two_weeks', 'flexible') THEN
    RAISE EXCEPTION 'Choose when the client could be admitted' USING ERRCODE = '22023';
  END IF;
  IF length(v_note) > 300 THEN
    RAISE EXCEPTION 'Keep the note to 300 characters' USING ERRCODE = '22023';
  END IF;
  IF v_level NOT IN ('Inpatient', 'IOP / PHP', 'Interventionist', 'Therapist', 'Sober Living', 'Detox') THEN
    v_level := 'Any type';
  END IF;
  IF v_population NOT IN ('Men', 'Women', 'Adolescent') THEN
    v_population := CASE WHEN 'Adolescent' = ANY (v_needs) THEN 'Adolescent'
                         WHEN 'Women only' = ANY (v_needs) THEN 'Women'
                         WHEN 'Men only' = ANY (v_needs) THEN 'Men'
                         ELSE 'Any' END;
  END IF;
  RETURN jsonb_build_object(
    'level_of_care', v_level,
    'population', v_population,
    'must_haves', to_jsonb(ARRAY(SELECT u.t FROM unnest(v_needs) WITH ORDINALITY AS u(t, n)
                                  WHERE u.t = ANY (v_explicit) OR u.t = ANY (v_people) ORDER BY u.n)),
    'needs', to_jsonb(ARRAY(SELECT u.t FROM unnest(v_needs) WITH ORDINALITY AS u(t, n)
                             WHERE NOT (u.t = ANY (v_explicit) OR u.t = ANY (v_people)) ORDER BY u.n)),
    'payment', CASE WHEN v_insurance IN ('', 'Cash pay') THEN 'self_pay' ELSE 'insurance' END,
    'insurance_carrier', CASE WHEN v_insurance NOT IN ('', 'Cash pay') AND length(v_insurance) <= 80
                                   AND v_insurance !~ '[0-9@]' AND v_insurance !~ '[[:cntrl:]]' THEN v_insurance END,
    'home_state', CASE WHEN v_state ~ '^[A-Z]{2}$' THEN v_state END,
    'location_preference', CASE WHEN v_location IN ('Close to family', 'Away from home') THEN v_location ELSE 'No preference' END,
    'admit_window', v_window,
    'note', nullif(v_note, ''));
END
$$;
REVOKE ALL ON FUNCTION public.placement_request_payload(text, text, text[], text[], text, text, text, text, text) FROM PUBLIC, anon, authenticated;

-- One program's status as the people involved see it: a request nobody
-- answered by its deadline reads 'expired' (never stored).
CREATE OR REPLACE FUNCTION public.placement_recipient_status(p_status text, p_respond_by timestamptz, p_now timestamptz)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN p_status IN ('sent', 'viewed') AND p_now > p_respond_by THEN 'expired' ELSE p_status END
$$;
REVOKE ALL ON FUNCTION public.placement_recipient_status(text, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.placement_recipient_status(text, timestamptz, timestamptz) TO authenticated, service_role;

-- The first thing wrong with an answer (a program's own, or one the
-- practitioner logs from a call or a text), or NULL. p_sent_on is the day
-- the request went out. Mirrored by answerProblem in placement-requests.ts.
CREATE OR REPLACE FUNCTION public.placement_answer_problem(
  p_bed text, p_likely text, p_admit_on date, p_daily_rate integer, p_cost_note text, p_note text, p_sent_on date)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN p_bed IS NULL OR p_bed NOT IN ('yes', 'no', 'waitlist') THEN 'Choose yes, no or waitlist for a bed'
    WHEN p_likely IS NULL OR p_likely NOT IN ('yes', 'maybe', 'no') THEN 'Choose yes, maybe or no for likely to accept'
    WHEN p_admit_on IS NOT NULL AND (p_admit_on < p_sent_on - 1 OR p_admit_on > p_sent_on + 366) THEN 'Check the earliest admit date'
    WHEN p_daily_rate IS NOT NULL AND (p_daily_rate < 1 OR p_daily_rate > 100000) THEN 'The daily rate is whole dollars, from 1 to 100,000'
    WHEN length(btrim(coalesce(p_cost_note, ''))) > 200 THEN 'Keep the cost note to 200 characters'
    WHEN length(btrim(coalesce(p_note, ''))) > 300 THEN 'Keep the note to 300 characters'
  END
$$;
REVOKE ALL ON FUNCTION public.placement_answer_problem(text, text, date, integer, text, text, date) FROM PUBLIC, anon, authenticated;

-- ===========================================================================
-- 2. The tables
-- ===========================================================================

-- One request. payload: the de-identified summary (section 1). respond_by:
-- 4, 24 or 48 hours after it was sent. status: open until the practitioner
-- closes it (a placement was found) or cancels it.
CREATE TABLE IF NOT EXISTS public.placement_requests (
  id               uuid PRIMARY KEY,
  org_id           uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  match_profile_id uuid,
  case_id          uuid,
  payload          jsonb NOT NULL CHECK (
                     jsonb_typeof(payload) = 'object'
                     AND (payload - ARRAY['level_of_care', 'population', 'must_haves', 'needs', 'payment', 'insurance_carrier',
                                          'home_state', 'location_preference', 'admit_window', 'note']::text[]) = '{}'::jsonb
                     AND length(coalesce(payload ->> 'note', '')) <= 300),
  respond_by       timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  closed_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT placement_requests_id_org_key UNIQUE (id, org_id),
  CONSTRAINT placement_requests_window CHECK (respond_by > created_at),
  CONSTRAINT placement_requests_closed_at CHECK ((status = 'open') = (closed_at IS NULL)),
  CONSTRAINT placement_requests_match_org_fk FOREIGN KEY (match_profile_id, org_id)
    REFERENCES public.match_profiles (id, org_id) ON UPDATE CASCADE ON DELETE SET NULL (match_profile_id) DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT placement_requests_case_org_fk FOREIGN KEY (case_id, org_id)
    REFERENCES public.cases (id, org_id) ON UPDATE CASCADE ON DELETE SET NULL (case_id) DEFERRABLE INITIALLY IMMEDIATE
);

CREATE INDEX IF NOT EXISTS placement_requests_org_idx ON public.placement_requests (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS placement_requests_match_idx ON public.placement_requests (match_profile_id, org_id)
  WHERE match_profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS placement_requests_case_idx ON public.placement_requests (case_id, org_id)
  WHERE case_id IS NOT NULL;

COMMENT ON TABLE public.placement_requests IS
  'A practice asks several of its own ranked programs about beds, fit and cost at once. payload is the de-identified summary built by placement_request_payload (no label, name, contact details or budget). Answers never change ranking. Written only through the placement request RPCs.';

-- One program asked. rank: its place in the practice's own ranked order
-- when the request went out (1 first); the answers never change it.
-- channel: 'portal' (the program answers in the center portal) or 'manual'
-- (the practitioner logs the answer; entered_by_practice). program_name:
-- the partner's name then, kept if the partner is deleted later.
CREATE TABLE IF NOT EXISTS public.placement_request_recipients (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id          uuid NOT NULL,
  org_id              uuid NOT NULL,
  partner_id          uuid,
  global_partner_id   uuid REFERENCES public.global_partners(id) ON DELETE SET NULL,
  channel             text NOT NULL CHECK (channel IN ('portal', 'manual')),
  rank                integer NOT NULL CHECK (rank BETWEEN 1 AND 8),
  program_name        text NOT NULL DEFAULT '' CHECK (length(program_name) <= 200),
  status              text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'viewed', 'responded', 'declined')),
  viewed_at           timestamptz,
  bed_available       text CHECK (bed_available IN ('yes', 'no', 'waitlist')),
  likely_accept       text CHECK (likely_accept IN ('yes', 'maybe', 'no')),
  earliest_admit_on   date,
  daily_rate          integer CHECK (daily_rate BETWEEN 1 AND 100000),
  cost_note           text NOT NULL DEFAULT '' CHECK (length(cost_note) <= 200),
  note                text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  responded_at        timestamptz,
  responded_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  entered_by_practice boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT placement_request_recipients_request_fk FOREIGN KEY (request_id, org_id)
    REFERENCES public.placement_requests (id, org_id) ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT placement_request_recipients_partner_org_fk FOREIGN KEY (partner_id, org_id)
    REFERENCES public.partners (id, org_id) ON UPDATE CASCADE ON DELETE SET NULL (partner_id) DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT placement_request_recipients_rank_key UNIQUE (request_id, rank),
  CONSTRAINT placement_request_recipients_partner_key UNIQUE (request_id, partner_id),
  CONSTRAINT placement_request_recipients_answer CHECK (
    (status IN ('responded', 'declined')) = (responded_at IS NOT NULL)
    AND (responded_at IS NULL OR (bed_available IS NOT NULL AND likely_accept IS NOT NULL))
    AND (status <> 'declined' OR likely_accept = 'no')
    AND (status <> 'responded' OR likely_accept <> 'no'))
);

CREATE INDEX IF NOT EXISTS placement_request_recipients_org_idx ON public.placement_request_recipients (org_id, request_id);
CREATE INDEX IF NOT EXISTS placement_request_recipients_partner_idx ON public.placement_request_recipients (partner_id, org_id)
  WHERE partner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS placement_request_recipients_listing_idx ON public.placement_request_recipients (global_partner_id, created_at DESC)
  WHERE channel = 'portal';

COMMENT ON TABLE public.placement_request_recipients IS
  'One program asked in a placement request, at its rank in the practice''s own order, with its answer (from the center portal, or logged by the practitioner when entered_by_practice). Answers never change ranking.';

-- ===========================================================================
-- 3. Who reads what (RLS) and the grants
-- ===========================================================================

ALTER TABLE public.placement_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.placement_request_recipients ENABLE ROW LEVEL SECURITY;

-- Production's default ACL grants ALL on new tables: revoke first, then the
-- one narrow grant. There is no write policy, so even a stray grant writes
-- nothing; TRUNCATE (which RLS does not cover) is revoked here too.
REVOKE ALL ON TABLE public.placement_requests FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.placement_request_recipients FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.placement_requests TO authenticated;
GRANT SELECT ON TABLE public.placement_request_recipients TO authenticated;
GRANT ALL ON TABLE public.placement_requests TO service_role;
GRANT ALL ON TABLE public.placement_request_recipients TO service_role;

-- The practice that asked, and nobody else. A center sees its own rows only
-- through list_center_placement_requests.
DROP POLICY IF EXISTS "placement_requests: workspace read" ON public.placement_requests;
CREATE POLICY "placement_requests: workspace read" ON public.placement_requests
  FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()));

DROP POLICY IF EXISTS "placement_request_recipients: workspace read" ON public.placement_request_recipients;
CREATE POLICY "placement_request_recipients: workspace read" ON public.placement_request_recipients
  FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()));

-- ===========================================================================
-- 4. Internal helpers
-- ===========================================================================

-- Can this listing answer in the center portal: claimed by a center
-- account, not merged into another listing, not archived. SECURITY
-- DEFINER: center_members is self-read only.
CREATE OR REPLACE FUNCTION public.placement_listing_answers_in_portal(p_global_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_global_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.global_partners g
                  WHERE g.id = p_global_id AND g.merged_into IS NULL AND g.status <> 'archived')
     AND EXISTS (SELECT 1 FROM public.center_members c WHERE c.global_partner_id = p_global_id)
$$;
REVOKE ALL ON FUNCTION public.placement_listing_answers_in_portal(uuid) FROM PUBLIC, anon, authenticated;

-- The name a program sees for the practice asking: the workspace's name,
-- or its directory profile's when the workspace was never named, else a
-- plain stand-in. Never a person's email or a client's anything.
CREATE OR REPLACE FUNCTION public.placement_practice_name(p_org uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    (SELECT btrim(o.name) FROM public.orgs o WHERE o.id = p_org AND btrim(o.name) NOT IN ('', 'My Practice')),
    (SELECT nullif(btrim(coalesce(nullif(btrim(g.organization), ''), g.name, '')), '') FROM public.global_partners g
      WHERE g.owner_org_id = p_org AND g.merged_into IS NULL ORDER BY g.id LIMIT 1),
    'A ReferralFit practice')
$$;
REVOKE ALL ON FUNCTION public.placement_practice_name(uuid) FROM PUBLIC, anon, authenticated;

-- A request and its programs (in rank order) as the practice sees them.
CREATE OR REPLACE FUNCTION public.placement_request_json(p_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'request', to_jsonb(q),
           'recipients', coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.rank)
                                     FROM public.placement_request_recipients r WHERE r.request_id = q.id), '[]'::jsonb))
    FROM public.placement_requests q
   WHERE q.id = p_id
$$;
REVOKE ALL ON FUNCTION public.placement_request_json(uuid) FROM PUBLIC, anon, authenticated;

-- The payload and the linked case for a new request: from the saved match
-- (p_match_profile_id) or, without one, from p_criteria, of which only
-- level_of_care, population, therapies, must_have_therapies, insurance,
-- state and location_preference are read. Any other key (a label, a
-- budget, a name) is ignored; a client_label there only screens the note.
CREATE OR REPLACE FUNCTION public.placement_request_build(
  p_org uuid, p_match_profile_id uuid, p_criteria jsonb, p_case_id uuid, p_admit_window text, p_note text)
RETURNS TABLE (o_payload jsonb, o_case_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  m public.match_profiles%ROWTYPE;
  c jsonb := CASE WHEN jsonb_typeof(p_criteria) = 'object' THEN p_criteria ELSE '{}'::jsonb END;
  v_case uuid := p_case_id;
  v_label text;
  v_title text;
  v_problem text;
BEGIN
  IF p_match_profile_id IS NOT NULL THEN
    SELECT * INTO m FROM public.match_profiles mp WHERE mp.id = p_match_profile_id AND mp.org_id = p_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Save the match first, then ask programs' USING ERRCODE = 'P0002';
    END IF;
    v_case := coalesce(m.case_id, p_case_id);
    v_label := m.client_label;
  ELSE
    v_label := c ->> 'client_label';
  END IF;
  IF v_case IS NOT NULL THEN
    SELECT k.title INTO v_title FROM public.cases k WHERE k.id = v_case AND k.org_id = p_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Case not found in your workspace' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  v_problem := public.placement_note_problem(btrim(coalesce(p_note, '')), ARRAY[v_label, v_title]);
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION '%', v_problem USING ERRCODE = '22023';
  END IF;
  IF p_match_profile_id IS NOT NULL THEN
    o_payload := public.placement_request_payload(m.level_of_care, m.population, m.therapies, m.must_have_therapies,
                                                  m.insurance, m.state, m.location_preference, p_admit_window, p_note);
  ELSE
    o_payload := public.placement_request_payload(c ->> 'level_of_care', c ->> 'population',
      CASE WHEN jsonb_typeof(c -> 'therapies') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(c -> 'therapies')) END,
      CASE WHEN jsonb_typeof(c -> 'must_have_therapies') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(c -> 'must_have_therapies')) END,
      c ->> 'insurance', c ->> 'state', c ->> 'location_preference', p_admit_window, p_note);
  END IF;
  o_case_id := v_case;
  RETURN NEXT;
END
$$;
REVOKE ALL ON FUNCTION public.placement_request_build(uuid, uuid, jsonb, uuid, text, text) FROM PUBLIC, anon, authenticated;

-- The programs a request goes to: the caller's own partners, each once,
-- in the order given (the practice's ranked order), 1 to 8 of them.
CREATE OR REPLACE FUNCTION public.placement_request_partner_ids(p_org uuid, p_partner_ids uuid[])
RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ids uuid[];
BEGIN
  SELECT coalesce(array_agg(x.pid ORDER BY x.n), ARRAY[]::uuid[]) INTO v_ids
    FROM (SELECT u.pid, min(u.n) AS n FROM unnest(coalesce(p_partner_ids, ARRAY[]::uuid[])) WITH ORDINALITY AS u(pid, n)
           WHERE u.pid IS NOT NULL GROUP BY u.pid) AS x;
  IF cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION 'Choose at least one program to ask' USING ERRCODE = '22023';
  END IF;
  IF cardinality(v_ids) > 8 THEN
    RAISE EXCEPTION 'A request can go to at most 8 programs' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM public.partners p WHERE p.id = ANY (v_ids) AND p.org_id = p_org) <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'One of these programs is not in your workspace' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_ids;
END
$$;
REVOKE ALL ON FUNCTION public.placement_request_partner_ids(uuid, uuid[]) FROM PUBLIC, anon, authenticated;

-- ===========================================================================
-- 5. The practice's writers
-- ===========================================================================

-- Ask up to 8 of the practice's own programs at once. p_partner_ids is the
-- practice's ranked order (rank 1 first); answers are compared in that
-- order and never change it. p_respond_hours: 4, 24 or 48. The app makes
-- p_id, so a retry after a timeout returns the request already made and
-- changes nothing. At most 20 requests per workspace in any 24 hours.
-- Returns {request, recipients}.
CREATE OR REPLACE FUNCTION public.create_placement_request(
  p_id uuid, p_match_profile_id uuid, p_criteria jsonb, p_partner_ids uuid[],
  p_respond_hours integer, p_admit_window text, p_note text, p_case_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid := public.current_org_id();
  v_org_of uuid;
  v_ids uuid[];
  b record;
BEGIN
  IF v_user IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'A request id is required' USING ERRCODE = '22023';
  END IF;
  -- One at a time per workspace, so the replay check and the cap hold.
  PERFORM pg_advisory_xact_lock(hashtext('placement_requests'), hashtext(v_org::text));
  SELECT q.org_id INTO v_org_of FROM public.placement_requests q WHERE q.id = p_id;
  IF FOUND THEN
    IF v_org_of <> v_org THEN
      RAISE EXCEPTION 'Placement request not found' USING ERRCODE = 'P0002';
    END IF;
    RETURN public.placement_request_json(p_id);
  END IF;
  IF p_respond_hours IS NULL OR p_respond_hours NOT IN (4, 24, 48) THEN
    RAISE EXCEPTION 'Choose 4, 24 or 48 hours for programs to answer' USING ERRCODE = '22023';
  END IF;
  v_ids := public.placement_request_partner_ids(v_org, p_partner_ids);
  SELECT * INTO b FROM public.placement_request_build(v_org, p_match_profile_id, p_criteria, p_case_id, p_admit_window, p_note);
  IF (SELECT count(*) FROM public.placement_requests q
       WHERE q.org_id = v_org AND q.created_at > now() - interval '24 hours') >= 20 THEN
    RAISE EXCEPTION 'Your practice has sent 20 placement requests in the last 24 hours. Try again later, or call the programs directly.'
      USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.placement_requests (id, org_id, created_by, match_profile_id, case_id, payload, respond_by)
  VALUES (p_id, v_org, v_user, p_match_profile_id, b.o_case_id, b.o_payload, now() + make_interval(hours => p_respond_hours));
  INSERT INTO public.placement_request_recipients (request_id, org_id, partner_id, global_partner_id, channel, rank, program_name)
  SELECT p_id, v_org, p.id, p.global_partner_id,
         CASE WHEN public.placement_listing_answers_in_portal(p.global_partner_id) THEN 'portal' ELSE 'manual' END,
         u.n, left(coalesce(nullif(btrim(p.organization), ''), nullif(btrim(p.name), ''), 'Program'), 200)
    FROM unnest(v_ids) WITH ORDINALITY AS u(pid, n)
    JOIN public.partners p ON p.id = u.pid AND p.org_id = v_org;
  RETURN public.placement_request_json(p_id);
END
$$;
REVOKE ALL ON FUNCTION public.create_placement_request(uuid, uuid, jsonb, uuid[], integer, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_placement_request(uuid, uuid, jsonb, uuid[], integer, text, text, uuid) TO authenticated;

-- Internal. An open request of the caller's workspace becomes closed (a
-- placement was found) or cancelled (no longer needed). Either way programs
-- can no longer answer. A request already finished is returned unchanged,
-- so a retry is safe.
CREATE OR REPLACE FUNCTION public.placement_request_finish(p_id uuid, p_status text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'A request is closed or cancelled' USING ERRCODE = '22023';
  END IF;
  SELECT q.status INTO v_status FROM public.placement_requests q
   WHERE q.id = p_id AND q.org_id = public.current_org_id()
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Placement request not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status = 'open' THEN
    UPDATE public.placement_requests q SET status = p_status, closed_at = now() WHERE q.id = p_id;
  END IF;
  RETURN public.placement_request_json(p_id);
END
$$;
REVOKE ALL ON FUNCTION public.placement_request_finish(uuid, text) FROM PUBLIC, anon, authenticated;

-- No longer needed: programs see the request as closed.
CREATE OR REPLACE FUNCTION public.cancel_placement_request(p_id uuid)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.placement_request_finish(p_id, 'cancelled')
$$;
REVOKE ALL ON FUNCTION public.cancel_placement_request(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_placement_request(uuid) TO authenticated;

-- A placement was found: programs see the request as closed.
CREATE OR REPLACE FUNCTION public.close_placement_request(p_id uuid)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.placement_request_finish(p_id, 'closed')
$$;
REVOKE ALL ON FUNCTION public.close_placement_request(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_placement_request(uuid) TO authenticated;

-- The practitioner logs a program's answer from a call or a text: any
-- program asked, unless it already answered in the portal itself. Still
-- possible after the deadline (programs call back late); not once the
-- request was cancelled. Returns the program's row.
CREATE OR REPLACE FUNCTION public.log_manual_response(
  p_recipient_id uuid, p_bed_available text, p_likely_accept text, p_earliest_admit_on date,
  p_daily_rate integer, p_cost_note text, p_note text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  r public.placement_request_recipients%ROWTYPE;
  q public.placement_requests%ROWTYPE;
  v_problem text;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO r FROM public.placement_request_recipients x
   WHERE x.id = p_recipient_id AND x.org_id = public.current_org_id()
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That program is not on this request' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO q FROM public.placement_requests WHERE id = r.request_id;
  IF q.status = 'cancelled' THEN
    RAISE EXCEPTION 'This request was cancelled' USING ERRCODE = '22023';
  END IF;
  IF r.responded_at IS NOT NULL AND NOT r.entered_by_practice THEN
    RAISE EXCEPTION 'The program already answered in ReferralFit' USING ERRCODE = '22023';
  END IF;
  v_problem := public.placement_answer_problem(p_bed_available, p_likely_accept, p_earliest_admit_on, p_daily_rate,
                                               p_cost_note, p_note, (q.created_at AT TIME ZONE 'UTC')::date);
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION '%', v_problem USING ERRCODE = '22023';
  END IF;
  UPDATE public.placement_request_recipients x
     SET bed_available = p_bed_available, likely_accept = p_likely_accept, earliest_admit_on = p_earliest_admit_on,
         daily_rate = p_daily_rate, cost_note = btrim(coalesce(p_cost_note, '')), note = btrim(coalesce(p_note, '')),
         status = CASE WHEN p_likely_accept = 'no' THEN 'declined' ELSE 'responded' END,
         responded_at = now(), responded_by = v_user, entered_by_practice = true
   WHERE x.id = r.id
  RETURNING * INTO r;
  RETURN to_jsonb(r);
END
$$;
REVOKE ALL ON FUNCTION public.log_manual_response(uuid, text, text, date, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_manual_response(uuid, text, text, date, integer, text, text) TO authenticated;

-- ===========================================================================
-- 6. The center's side
-- ===========================================================================

-- Requests addressed to listings the caller claimed (its center account,
-- or the workspace that owns the listing), newest first: the practice's
-- name, the de-identified summary and the program's own answer. Nothing
-- about the client, the other programs asked, or where this one ranked.
-- An answer the practitioner logged from a call (entered_by_practice) is
-- the practice's own record: the program sees its row as unanswered.
-- status reads 'expired' once the deadline passed unanswered.
CREATE OR REPLACE FUNCTION public.list_center_placement_requests(p_recipient_id uuid DEFAULT NULL)
RETURNS TABLE (recipient_id uuid, request_id uuid, practice_name text, payload jsonb, sent_at timestamptz,
               respond_by timestamptz, request_status text, status text, can_respond boolean, viewed_at timestamptz,
               responded_at timestamptz, bed_available text, likely_accept text, earliest_admit_on date,
               daily_rate integer, cost_note text, note text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  RETURN QUERY
  SELECT r.id, q.id, public.placement_practice_name(q.org_id), q.payload, q.created_at, q.respond_by, q.status,
         public.placement_recipient_status(CASE WHEN NOT r.entered_by_practice THEN r.status
                                                WHEN r.viewed_at IS NULL THEN 'sent' ELSE 'viewed' END, q.respond_by, now()),
         q.status = 'open' AND now() <= q.respond_by,
         r.viewed_at, a.responded_at, a.bed_available, a.likely_accept, a.earliest_admit_on,
         a.daily_rate, a.cost_note, a.note
    FROM public.placement_request_recipients r
    JOIN public.placement_requests q ON q.id = r.request_id
    LEFT JOIN public.placement_request_recipients a ON a.id = r.id AND NOT r.entered_by_practice
   WHERE r.channel = 'portal'
     AND r.global_partner_id IN (
           SELECT c.global_partner_id FROM public.center_members c WHERE c.user_id = auth.uid()
           UNION
           SELECT g.id FROM public.global_partners g JOIN public.org_members m ON m.org_id = g.owner_org_id
            WHERE m.user_id = auth.uid())
     AND (p_recipient_id IS NULL OR r.id = p_recipient_id)
   ORDER BY q.created_at DESC, r.id
   LIMIT 200;
END
$$;
REVOKE ALL ON FUNCTION public.list_center_placement_requests(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_center_placement_requests(uuid) TO authenticated;

-- Opening a request in the portal marks it viewed (once). Only a row
-- addressed to a listing the caller claimed; returns false when it was
-- already viewed.
CREATE OR REPLACE FUNCTION public.mark_placement_request_viewed(p_recipient_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_listing uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  SELECT r.global_partner_id INTO v_listing FROM public.placement_request_recipients r
   WHERE r.id = p_recipient_id AND r.channel = 'portal';
  IF NOT FOUND OR NOT public.global_listing_claimed_by_caller(v_listing) THEN
    RAISE EXCEPTION 'Placement request not found' USING ERRCODE = 'P0002';
  END IF;
  UPDATE public.placement_request_recipients r
     SET viewed_at = now(), status = CASE WHEN r.status = 'sent' THEN 'viewed' ELSE r.status END
   WHERE r.id = p_recipient_id AND r.viewed_at IS NULL;
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION public.mark_placement_request_viewed(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_placement_request_viewed(uuid) TO authenticated;

-- A program answers (or changes its answer) for its own row only, while the
-- request is open and before its deadline. likely_accept 'no' is a decline.
-- Returns the row as list_center_placement_requests shows it.
CREATE OR REPLACE FUNCTION public.respond_to_placement_request(
  p_recipient_id uuid, p_bed_available text, p_likely_accept text, p_earliest_admit_on date,
  p_daily_rate integer, p_cost_note text, p_note text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.placement_request_recipients%ROWTYPE;
  q public.placement_requests%ROWTYPE;
  v_problem text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO r FROM public.placement_request_recipients x WHERE x.id = p_recipient_id AND x.channel = 'portal';
  IF NOT FOUND OR NOT public.global_listing_claimed_by_caller(r.global_partner_id) THEN
    RAISE EXCEPTION 'Placement request not found' USING ERRCODE = 'P0002';
  END IF;
  -- Locked: a cancel and an answer never cross.
  SELECT * INTO q FROM public.placement_requests WHERE id = r.request_id FOR UPDATE;
  IF q.status <> 'open' THEN
    RAISE EXCEPTION 'This request is closed. The practice is no longer waiting for answers.' USING ERRCODE = '22023';
  END IF;
  IF now() > q.respond_by THEN
    RAISE EXCEPTION 'The time to answer this request has passed' USING ERRCODE = '22023';
  END IF;
  v_problem := public.placement_answer_problem(p_bed_available, p_likely_accept, p_earliest_admit_on, p_daily_rate,
                                               p_cost_note, p_note, (q.created_at AT TIME ZONE 'UTC')::date);
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION '%', v_problem USING ERRCODE = '22023';
  END IF;
  UPDATE public.placement_request_recipients x
     SET bed_available = p_bed_available, likely_accept = p_likely_accept, earliest_admit_on = p_earliest_admit_on,
         daily_rate = p_daily_rate, cost_note = btrim(coalesce(p_cost_note, '')), note = btrim(coalesce(p_note, '')),
         status = CASE WHEN p_likely_accept = 'no' THEN 'declined' ELSE 'responded' END,
         responded_at = now(), responded_by = auth.uid(), entered_by_practice = false,
         viewed_at = coalesce(x.viewed_at, now())
   WHERE x.id = r.id;
  RETURN (SELECT to_jsonb(v) FROM public.list_center_placement_requests(r.id) AS v);
END
$$;
REVOKE ALL ON FUNCTION public.respond_to_placement_request(uuid, text, text, date, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.respond_to_placement_request(uuid, text, text, date, integer, text, text) TO authenticated;

-- ===========================================================================
-- 7. Before sending: who answers where
-- ===========================================================================

-- For each of the caller's own partners: 'portal' when its listing is
-- claimed by a center account (it answers in the center portal), else
-- 'manual'. Whether a listing is claimed is already public to signed-in
-- users (global_listing_is_claimed); nothing else is revealed.
CREATE OR REPLACE FUNCTION public.placement_request_channels(p_partner_ids uuid[])
RETURNS TABLE (partner_id uuid, channel text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id, CASE WHEN public.placement_listing_answers_in_portal(p.global_partner_id) THEN 'portal' ELSE 'manual' END
    FROM public.partners p
   WHERE p.id = ANY ((coalesce(p_partner_ids, ARRAY[]::uuid[]))[1:100])
     AND p.org_id = public.current_org_id()
$$;
REVOKE ALL ON FUNCTION public.placement_request_channels(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.placement_request_channels(uuid[]) TO authenticated;

-- ===========================================================================
-- 8. A joiner's requests move with the workspace
-- ===========================================================================

-- Same as 20261024120000 (its latest definition), plus the two placement
-- request tables. Most of their rows follow their match profile and
-- partners through the ON UPDATE CASCADE foreign keys; these two lines move
-- the rest (a request whose saved match was removed).
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

-- Same as 20261104130000 (its latest definition), plus one line: a
-- joiner's placement requests that asked a partner the team already tracks
-- point at the team's copy before the joiner's copy is deleted.
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
    UPDATE public.placement_request_recipients SET partner_id = v_pair.keep_id WHERE org_id = p_from AND partner_id = v_pair.dup_id;
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
