BEGIN;

-- Insurance as a workflow, not a note.
--
-- Roadmap feature 4 (Matt Brown, 2026-10-01). Verification of benefits
-- (VOB) is the daily blocker when placing a family. This migration makes it
-- a tracked workflow on the case file instead of a line in the summary.
--
--   1. case_benefits: the family's plan, one row per case. Carrier, plan
--      name, the LAST FOUR characters of the member id (a constraint makes
--      more than four impossible to store), and who the subscriber is.
--      Never the full member id, never a date of birth, never an SSN.
--   2. vob_requests: one row per program asked. Which program, when, the
--      status (requested, pending, in_network, out_of_network,
--      not_accepted), who answered, notes, and the quoted out-of-pocket.
--      Both tables are org-scoped under RLS, readable by every member of
--      the workspace, written only through the functions below so every
--      change lands on the case timeline with the member who made it
--      (case_events.actor_id, stamped by the existing trigger).
--   3. request_vob(...) creates the row with status requested and a
--      follow-up to chase it on the next business day, assigned to the
--      requester. update_vob_status(...) records the answer, stamps
--      answered_at, completes the chase follow-up, and writes the timeline
--      entry. save_case_benefits(...) stores the plan.
--   4. partners_for_plan(p_insurance, p_state) answers "which of my
--      partners take this plan in-network?" for the caller's workspace,
--      from each partner's own insurance data or, where the partner is
--      linked to a directory listing the caller can read, the listing's.
--      That data is self-reported by programs ("per program"). A VOB
--      answer on a case upgrades the label for that case only; it never
--      rewrites the partner's network data.
--   5. vob_turnaround_stats() gives the Business tile its median days from
--      requested to answered, for 30, 90, 365 days and all time. Counts of
--      requests, never of people.
--
-- No push notification is queued by this feature: the chase follow-up is
-- assigned to the requester themselves, which the existing trigger skips.
-- Nothing here reaches the directory, the portal, or any aggregate.
--
-- Transit rule: this file is pasted into the SQL editor from a chat client.
-- No backslashes and no non-ASCII characters anywhere in it; every
-- top-level statement stays under 3,700 characters.

-- ===========================================================================
-- 1. case_benefits: the family's plan
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.case_benefits (
  case_id                 uuid PRIMARY KEY,
  owner_id                uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id                  uuid NOT NULL REFERENCES public.orgs(id),
  carrier                 text NOT NULL DEFAULT '' CHECK (length(carrier) <= 120),
  plan_name               text NOT NULL DEFAULT '' CHECK (length(plan_name) <= 120),
  member_id_last4         text NOT NULL DEFAULT ''
                          CHECK (member_id_last4 = '' OR (length(member_id_last4) = 4 AND member_id_last4 ~ '^[0-9A-Za-z]{4}$')),
  subscriber_relationship text NOT NULL DEFAULT ''
                          CHECK (subscriber_relationship IN ('', 'self', 'spouse', 'parent', 'child', 'other')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_benefits_case_org_fk FOREIGN KEY (case_id, org_id)
    REFERENCES public.cases (id, org_id) ON DELETE CASCADE
);

COMMENT ON TABLE public.case_benefits IS
  'The family plan on a case: carrier, plan name, last four of the member id, subscriber relationship. Never the full member id, DOB or SSN.';
COMMENT ON COLUMN public.case_benefits.member_id_last4 IS
  'Exactly four characters or empty. The constraint makes a longer value impossible to store.';

CREATE INDEX IF NOT EXISTS case_benefits_org_idx ON public.case_benefits (org_id, case_id);

DROP TRIGGER IF EXISTS case_benefits_set_org ON public.case_benefits;
CREATE TRIGGER case_benefits_set_org BEFORE INSERT ON public.case_benefits
  FOR EACH ROW EXECUTE FUNCTION public.set_row_org_from_owner();
DROP TRIGGER IF EXISTS case_benefits_updated_at ON public.case_benefits;
CREATE TRIGGER case_benefits_updated_at BEFORE UPDATE ON public.case_benefits
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.case_benefits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "case_benefits: org read" ON public.case_benefits;
CREATE POLICY "case_benefits: org read" ON public.case_benefits
  FOR SELECT USING (org_id = public.current_org_id());

REVOKE ALL ON TABLE public.case_benefits FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.case_benefits TO authenticated;
GRANT ALL ON TABLE public.case_benefits TO service_role;

-- ===========================================================================
-- 2. vob_requests: one row per program asked
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.vob_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id             uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id               uuid NOT NULL REFERENCES public.orgs(id),
  case_id              uuid NOT NULL,
  partner_id           uuid,
  global_partner_id    uuid REFERENCES public.global_partners(id) ON DELETE SET NULL,
  program_name         text NOT NULL DEFAULT '' CHECK (length(program_name) <= 200),
  status               text NOT NULL DEFAULT 'requested'
                       CHECK (status IN ('requested', 'pending', 'in_network', 'out_of_network', 'not_accepted')),
  requested_at         timestamptz NOT NULL DEFAULT now(),
  requested_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  answered_at          timestamptz,
  answered_by          text NOT NULL DEFAULT '' CHECK (length(answered_by) <= 120),
  note                 text NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  quoted_out_of_pocket integer CHECK (quoted_out_of_pocket IS NULL OR quoted_out_of_pocket >= 0),
  follow_up_id         uuid REFERENCES public.follow_ups(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vob_requests_case_org_fk FOREIGN KEY (case_id, org_id)
    REFERENCES public.cases (id, org_id) ON DELETE CASCADE,
  CONSTRAINT vob_requests_partner_org_fk FOREIGN KEY (partner_id, org_id)
    REFERENCES public.partners (id, org_id) ON DELETE SET NULL (partner_id),
  CONSTRAINT vob_requests_answered_consistent
    CHECK ((status IN ('requested', 'pending')) = (answered_at IS NULL))
);

COMMENT ON TABLE public.vob_requests IS
  'Verification-of-benefits requests on a case: which program was asked, when, the status, who answered, notes and the quoted out-of-pocket. Written only through request_vob and update_vob_status.';

CREATE INDEX IF NOT EXISTS vob_requests_case_idx ON public.vob_requests (org_id, case_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS vob_requests_org_requested_idx ON public.vob_requests (org_id, requested_at DESC);

DROP TRIGGER IF EXISTS vob_requests_set_org ON public.vob_requests;
CREATE TRIGGER vob_requests_set_org BEFORE INSERT ON public.vob_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_row_org_from_owner();
DROP TRIGGER IF EXISTS vob_requests_updated_at ON public.vob_requests;
CREATE TRIGGER vob_requests_updated_at BEFORE UPDATE ON public.vob_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.vob_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "vob_requests: org read" ON public.vob_requests;
CREATE POLICY "vob_requests: org read" ON public.vob_requests
  FOR SELECT USING (org_id = public.current_org_id());

REVOKE ALL ON TABLE public.vob_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.vob_requests TO authenticated;
GRANT ALL ON TABLE public.vob_requests TO service_role;

-- ===========================================================================
-- 3. Writes: save_case_benefits, request_vob, update_vob_status
-- ===========================================================================

-- Human wording shared by the timeline entries and the app.
CREATE OR REPLACE FUNCTION public.vob_status_label(p_status text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE p_status
    WHEN 'requested' THEN 'requested'
    WHEN 'pending' THEN 'pending with the program'
    WHEN 'in_network' THEN 'in-network'
    WHEN 'out_of_network' THEN 'out-of-network'
    WHEN 'not_accepted' THEN 'not accepted'
    ELSE coalesce(p_status, '')
  END
$$;
REVOKE ALL ON FUNCTION public.vob_status_label(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vob_status_label(text) TO authenticated;

-- Stores the family's plan. p_patch keys (all optional): carrier,
-- plan_name, member_id_last4, subscriber_relationship. The timeline entry
-- names the carrier and plan, never the member id digits. Returns the
-- stored row and the entry wording so the optimistic row matches; the
-- entry is only written when something actually changed.
CREATE OR REPLACE FUNCTION public.save_case_benefits(p_case_id uuid, p_patch jsonb, p_event_id uuid)
RETURNS TABLE (carrier text, plan_name text, member_id_last4 text, subscriber_relationship text, event_body text, occurred_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_user uuid := auth.uid();
  v_org uuid := public.current_org_id();
  v_old public.case_benefits;
  v_new public.case_benefits;
  v_last4 text;
  v_body text := '';
  v_now timestamptz := now();
BEGIN
  IF v_user IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cases c WHERE c.id = p_case_id AND c.org_id = v_org) THEN
    RAISE EXCEPTION 'Case not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_patch ? 'member_id_last4' THEN
    v_last4 := btrim(coalesce(p_patch ->> 'member_id_last4', ''));
    IF v_last4 <> '' AND length(v_last4) <> 4 THEN
      RAISE EXCEPTION 'Only the last four characters of the member id are stored' USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT * INTO v_old FROM public.case_benefits b WHERE b.case_id = p_case_id AND b.org_id = v_org;

  INSERT INTO public.case_benefits (case_id, owner_id, org_id, carrier, plan_name, member_id_last4, subscriber_relationship)
  VALUES (p_case_id, v_user, v_org,
          left(btrim(coalesce(p_patch ->> 'carrier', '')), 120),
          left(btrim(coalesce(p_patch ->> 'plan_name', '')), 120),
          coalesce(v_last4, ''),
          coalesce(p_patch ->> 'subscriber_relationship', ''))
  ON CONFLICT (case_id) DO UPDATE SET
    carrier = CASE WHEN p_patch ? 'carrier' THEN EXCLUDED.carrier ELSE public.case_benefits.carrier END,
    plan_name = CASE WHEN p_patch ? 'plan_name' THEN EXCLUDED.plan_name ELSE public.case_benefits.plan_name END,
    member_id_last4 = CASE WHEN p_patch ? 'member_id_last4' THEN EXCLUDED.member_id_last4 ELSE public.case_benefits.member_id_last4 END,
    subscriber_relationship = CASE WHEN p_patch ? 'subscriber_relationship' THEN EXCLUDED.subscriber_relationship ELSE public.case_benefits.subscriber_relationship END
  RETURNING * INTO v_new;

  IF v_old IS NULL OR (v_old.carrier, v_old.plan_name, v_old.member_id_last4, v_old.subscriber_relationship)
     IS DISTINCT FROM (v_new.carrier, v_new.plan_name, v_new.member_id_last4, v_new.subscriber_relationship) THEN
    v_body := 'Insurance plan ' || CASE WHEN v_old IS NULL THEN 'added' ELSE 'updated' END
      || CASE WHEN v_new.carrier <> '' THEN ': ' || v_new.carrier ELSE '' END
      || CASE WHEN v_new.plan_name <> '' THEN ' ' || v_new.plan_name ELSE '' END
      || CASE WHEN v_new.subscriber_relationship <> '' THEN ' (subscriber: ' || v_new.subscriber_relationship || ')' ELSE '' END;
    INSERT INTO public.case_events (id, owner_id, org_id, case_id, kind, body, occurred_at)
    VALUES (coalesce(p_event_id, gen_random_uuid()), v_user, v_org, p_case_id, 'system', v_body, v_now)
    ON CONFLICT (id) DO NOTHING;
  END IF;

  RETURN QUERY SELECT v_new.carrier, v_new.plan_name, v_new.member_id_last4, v_new.subscriber_relationship, v_body, v_now;
END
$$;
REVOKE ALL ON FUNCTION public.save_case_benefits(uuid, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_case_benefits(uuid, jsonb, uuid) TO authenticated;

-- The next business day after a date: Saturday and Sunday roll to Monday.
CREATE OR REPLACE FUNCTION public.next_business_day(p_from date)
RETURNS date
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE extract(dow FROM p_from + 1)
    WHEN 6 THEN p_from + 3
    WHEN 0 THEN p_from + 2
    ELSE p_from + 1
  END
$$;
REVOKE ALL ON FUNCTION public.next_business_day(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.next_business_day(date) TO authenticated;

-- One tap: "Request VOB". p_request keys: id (optional, client-generated so
-- the optimistic row matches), case_id, partner_id (optional), program_name
-- (used when there is no partner), note, due_on (device-local next business
-- day; the server computes its own when missing), follow_up_id, event_id.
-- Creates the request with status requested, the chase follow-up assigned
-- to the requester, and the timeline entry, in one transaction. Idempotent
-- on id: a repeat returns the existing row.
CREATE OR REPLACE FUNCTION public.request_vob(p_request jsonb)
RETURNS TABLE (id uuid, program_name text, global_partner_id uuid, requested_at timestamptz, follow_up_id uuid, due_on date, event_body text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_user uuid := auth.uid();
  v_org uuid := public.current_org_id();
  v_id uuid := coalesce(nullif(p_request ->> 'id', '')::uuid, gen_random_uuid());
  v_case uuid := nullif(p_request ->> 'case_id', '')::uuid;
  v_partner uuid := nullif(p_request ->> 'partner_id', '')::uuid;
  v_program text := left(btrim(coalesce(p_request ->> 'program_name', '')), 200);
  v_listing uuid;
  v_due date := nullif(p_request ->> 'due_on', '')::date;
  v_follow uuid := coalesce(nullif(p_request ->> 'follow_up_id', '')::uuid, gen_random_uuid());
  v_row public.vob_requests;
  v_inserted integer;
  v_body text;
BEGIN
  IF v_user IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF v_case IS NULL OR NOT EXISTS (SELECT 1 FROM public.cases c WHERE c.id = v_case AND c.org_id = v_org) THEN
    RAISE EXCEPTION 'Case not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_partner IS NOT NULL THEN
    SELECT p.organization, p.global_partner_id INTO v_program, v_listing
      FROM public.partners p WHERE p.id = v_partner AND p.org_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Partner not found' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  IF v_program = '' THEN
    RAISE EXCEPTION 'Name the program being asked' USING ERRCODE = '22023';
  END IF;
  IF v_due IS NULL OR v_due < CURRENT_DATE - 1 THEN
    v_due := public.next_business_day(CURRENT_DATE);
  END IF;
  v_body := 'VOB requested: ' || v_program;

  INSERT INTO public.vob_requests (id, owner_id, org_id, case_id, partner_id, global_partner_id, program_name, status, requested_by, note)
  VALUES (v_id, v_user, v_org, v_case, v_partner, v_listing, v_program, 'requested', v_user, left(coalesce(p_request ->> 'note', ''), 2000))
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 1 THEN
    INSERT INTO public.follow_ups (id, owner_id, org_id, partner_id, case_id, title, due_on, kind, waiting_on, assigned_to, status)
    VALUES (v_follow, v_user, v_org, v_partner, v_case, 'Check on VOB: ' || v_program, v_due, 'waiting_on', v_program, v_user, 'open')
    ON CONFLICT (id) DO NOTHING;
    UPDATE public.vob_requests SET follow_up_id = v_follow WHERE public.vob_requests.id = v_id;
    INSERT INTO public.case_events (id, owner_id, org_id, case_id, kind, body, occurred_at)
    VALUES (coalesce(nullif(p_request ->> 'event_id', '')::uuid, gen_random_uuid()), v_user, v_org, v_case, 'system', v_body, now())
    ON CONFLICT (id) DO NOTHING;
  END IF;

  SELECT * INTO v_row FROM public.vob_requests r WHERE r.id = v_id AND r.org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VOB request not found in this workspace' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY
  SELECT v_row.id, v_row.program_name, v_row.global_partner_id, v_row.requested_at, v_row.follow_up_id,
         (SELECT f.due_on FROM public.follow_ups f WHERE f.id = v_row.follow_up_id)::date,
         (CASE WHEN v_inserted = 1 THEN v_body ELSE '' END)::text;
END
$$;
REVOKE ALL ON FUNCTION public.request_vob(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_vob(jsonb) TO authenticated;

-- Records what the program said. p_patch keys (all optional): status,
-- answered_by (the person at the program), note, quoted_out_of_pocket
-- (whole dollars, null to clear). An answer (in_network, out_of_network,
-- not_accepted) stamps answered_at and completes the chase follow-up;
-- moving back to requested or pending clears it. A status change writes
-- the timeline entry; a note-only edit does not.
CREATE OR REPLACE FUNCTION public.update_vob_status(p_id uuid, p_patch jsonb, p_event_id uuid)
RETURNS TABLE (status text, answered_at timestamptz, answered_by text, note text, quoted_out_of_pocket integer, event_body text, occurred_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_user uuid := auth.uid();
  v_org uuid := public.current_org_id();
  v_old public.vob_requests;
  v_new public.vob_requests;
  v_status text;
  v_body text := '';
  v_now timestamptz := now();
BEGIN
  IF v_user IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO v_old FROM public.vob_requests r WHERE r.id = p_id AND r.org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VOB request not found in this workspace' USING ERRCODE = 'P0002';
  END IF;
  v_status := coalesce(nullif(p_patch ->> 'status', ''), v_old.status);
  IF v_status NOT IN ('requested', 'pending', 'in_network', 'out_of_network', 'not_accepted') THEN
    RAISE EXCEPTION 'Unknown VOB status' USING ERRCODE = '22023';
  END IF;

  UPDATE public.vob_requests r
     SET status = v_status,
         answered_at = CASE WHEN v_status IN ('requested', 'pending') THEN NULL
                            WHEN r.answered_at IS NULL OR r.status <> v_status THEN v_now
                            ELSE r.answered_at END,
         answered_by = CASE WHEN p_patch ? 'answered_by' THEN left(btrim(coalesce(p_patch ->> 'answered_by', '')), 120) ELSE r.answered_by END,
         note = CASE WHEN p_patch ? 'note' THEN left(coalesce(p_patch ->> 'note', ''), 2000) ELSE r.note END,
         quoted_out_of_pocket = CASE WHEN p_patch ? 'quoted_out_of_pocket' THEN nullif(p_patch ->> 'quoted_out_of_pocket', '')::integer ELSE r.quoted_out_of_pocket END
   WHERE r.id = p_id AND r.org_id = v_org
  RETURNING * INTO v_new;

  IF v_new.status <> v_old.status THEN
    v_body := 'VOB ' || public.vob_status_label(v_new.status) || ': ' || v_new.program_name
      || CASE WHEN v_new.quoted_out_of_pocket IS NOT NULL AND v_new.status IN ('in_network', 'out_of_network')
              THEN ', about $' || v_new.quoted_out_of_pocket::text || ' out of pocket' ELSE '' END
      || CASE WHEN v_new.answered_by <> '' AND v_new.answered_at IS NOT NULL THEN ' (per ' || v_new.answered_by || ')' ELSE '' END;
    INSERT INTO public.case_events (id, owner_id, org_id, case_id, kind, body, occurred_at)
    VALUES (coalesce(p_event_id, gen_random_uuid()), v_user, v_org, v_new.case_id, 'system', v_body, v_now)
    ON CONFLICT (id) DO NOTHING;
    IF v_new.answered_at IS NOT NULL AND v_new.follow_up_id IS NOT NULL THEN
      UPDATE public.follow_ups f SET status = 'done', completed_at = v_now
       WHERE f.id = v_new.follow_up_id AND f.org_id = v_org AND f.status = 'open';
    END IF;
  END IF;

  RETURN QUERY SELECT v_new.status, v_new.answered_at, v_new.answered_by, v_new.note, v_new.quoted_out_of_pocket, v_body, v_now;
END
$$;
REVOKE ALL ON FUNCTION public.update_vob_status(uuid, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_vob_status(uuid, jsonb, uuid) TO authenticated;

-- ===========================================================================
-- 4. partners_for_plan: which of my partners take this plan?
-- ===========================================================================
-- For every partner in the caller's workspace: in_network, out_of_network
-- or unknown for p_insurance. The data comes from the partner's own
-- insurance and insurance_networks columns, or from the linked directory
-- listing when the caller can read it (source = listing). An explicit
-- networks entry wins; a carrier listed under insurance with no entry
-- counts as in-network, mirroring networkCapabilitiesForPartner in the app;
-- anything else is unknown. Self-reported by programs: label it
-- "per program". same_state is null when p_state is empty or ANY. Runs as
-- the caller, so RLS keeps it to the caller's partners and listings.
CREATE OR REPLACE FUNCTION public.partners_for_plan(p_insurance text, p_state text DEFAULT NULL)
RETURNS TABLE (partner_id uuid, organization text, network_status text, source text, same_state boolean)
LANGUAGE sql STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH src AS (
    SELECT p.id, p.organization, p.state,
           CASE WHEN g.id IS NOT NULL THEN g.insurance ELSE p.insurance END AS ins,
           CASE WHEN g.id IS NOT NULL THEN g.insurance_networks ELSE p.insurance_networks END AS nets,
           CASE WHEN g.id IS NOT NULL THEN 'listing' ELSE 'partner' END AS src
      FROM public.partners p
      LEFT JOIN public.global_partners g ON g.id = p.global_partner_id AND g.status = 'active'
     WHERE p.org_id = public.current_org_id()
  )
  SELECT s.id,
         s.organization,
         CASE WHEN s.nets ? btrim(p_insurance) AND (s.nets -> btrim(p_insurance)) ? 'In-network' THEN 'in_network'
              WHEN s.nets ? btrim(p_insurance) AND (s.nets -> btrim(p_insurance)) ? 'Out-of-network' THEN 'out_of_network'
              WHEN btrim(p_insurance) = ANY (s.ins) THEN 'in_network'
              ELSE 'unknown' END,
         CASE WHEN s.nets ? btrim(p_insurance) OR btrim(p_insurance) = ANY (s.ins) THEN s.src ELSE 'none' END,
         CASE WHEN p_state IS NULL OR btrim(p_state) = '' OR upper(btrim(p_state)) = 'ANY' THEN NULL
              ELSE upper(s.state) = upper(btrim(p_state)) END
    FROM src s
   ORDER BY s.organization, s.id
$$;
REVOKE ALL ON FUNCTION public.partners_for_plan(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partners_for_plan(text, text) TO authenticated;

-- ===========================================================================
-- 5. vob_turnaround_stats: the Business tile
-- ===========================================================================
-- Median days from requested_at to answered_at over answered requests, by
-- the date they were requested, for 30, 90 and 365 days and all time.
-- Workspace totals only, never per person. Runs as the caller under RLS.
CREATE OR REPLACE FUNCTION public.vob_turnaround_stats()
RETURNS TABLE (period text, requested integer, answered integer, median_days numeric)
LANGUAGE sql STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH periods AS (
    SELECT * FROM (VALUES ('30', 30), ('90', 90), ('365', 365), ('all', NULL::integer)) AS v(period, days)
  )
  SELECT pr.period,
         (SELECT count(*) FROM public.vob_requests r
           WHERE r.org_id = public.current_org_id()
             AND (pr.days IS NULL OR r.requested_at >= now() - make_interval(days => pr.days)))::integer,
         (SELECT count(*) FROM public.vob_requests r
           WHERE r.org_id = public.current_org_id() AND r.answered_at IS NOT NULL
             AND (pr.days IS NULL OR r.requested_at >= now() - make_interval(days => pr.days)))::integer,
         (SELECT round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (r.answered_at - r.requested_at)) / 86400.0))::numeric, 1)
            FROM public.vob_requests r
           WHERE r.org_id = public.current_org_id() AND r.answered_at IS NOT NULL
             AND (pr.days IS NULL OR r.requested_at >= now() - make_interval(days => pr.days)))
    FROM periods pr
   ORDER BY CASE pr.period WHEN '30' THEN 1 WHEN '90' THEN 2 WHEN '365' THEN 3 ELSE 4 END
$$;
REVOKE ALL ON FUNCTION public.vob_turnaround_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vob_turnaround_stats() TO authenticated;

COMMIT;
