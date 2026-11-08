-- Program referrals: a treatment program refers a family to an interventionist.
--
-- Ethics first (docs/PROGRAM_REFERRALS.md):
--   * The family asked for it. The program confirms that the family asked it
--     to share their details with this interventionist (consent_attested_at);
--     without that the referral is refused.
--   * Referrals never rank. Matching (src/lib/matching.ts) never reads this
--     table; nothing here changes a fit score, an order, or a badge.
--   * While the practice shares progress (share_progress, the practice's
--     switch, on by default) the program sees milestones (received, family
--     reached, consult, intervention, entered treatment, not proceeding,
--     closed) and, per referral, the name of the treatment program the
--     client entered, so it can help coordinate care. Nothing else from the
--     case: no names, notes, contacts, case title, insurance or cost.
--   * No scoreboard of referrals returned: the per-interventionist track
--     record never counts where clients went (no "placed with you" rate);
--     reciprocal referral arrangements can be "anything of value" under
--     patient-brokering laws (EKRA, the Anti-Kickback Statute, state law).
--
-- What it adds:
--   1. orgs.accepts_program_referrals (on by default; the owner's switch),
--      lead_channel 'program_referral', and create_lead_internal (from
--      20261024120000) accepting that channel with a "referred by" timeline
--      entry. The lead is an ordinary lead: lead_captured_at, a first-call
--      follow-up, and the existing new_lead push from cases_notify_new_lead.
--   2. program_referrals, readable only through the RPCs below.
--   3. Portal RPCs (a center account, for its own claimed listing):
--      program_referral_targets, program_refer_family (30 per program per
--      24 hours), list_program_referrals, program_referral_stats.
--   4. App RPCs (the receiving practice): case_program_referral,
--      set_program_referral_sharing, program_referral_settings,
--      set_accepts_program_referrals (owner).
--
-- Not done: a received entry in the practice's referral ledger (referrals).
-- That table's insert path assumes the practice's own signed-in author
-- (set_row_org_from_owner and the ledger triggers), so the practitioner logs
-- it as before if they track the program as a partner.
--
-- Transit-safe: ASCII only, no backslashes, every statement under 3,700
-- characters.

BEGIN;

-- ===========================================================================
-- 1. The practice's switch, the lead channel, and the lead itself
-- ===========================================================================

ALTER TABLE public.orgs ADD COLUMN IF NOT EXISTS accepts_program_referrals boolean NOT NULL DEFAULT true;

ALTER TABLE public.cases DROP CONSTRAINT IF EXISTS cases_lead_channel_check;
ALTER TABLE public.cases ADD CONSTRAINT cases_lead_channel_check
  CHECK (lead_channel IS NULL OR lead_channel IN ('app', 'intake_link', 'program_referral'));

-- Same as 20261024120000 plus the program_referral channel and its timeline
-- entry ("New lead referred by <program> through ReferralFit").
CREATE OR REPLACE FUNCTION public.create_lead_internal(
  p_org_id uuid,
  p_owner_id uuid,
  p_lead jsonb,
  p_channel text
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lead jsonb := public.lead_payload_normalize(p_lead);
  v_case_id uuid := coalesce(nullif(p_lead ->> 'id', '')::uuid, gen_random_uuid());
  v_contact_id uuid := coalesce(nullif(p_lead ->> 'contact_id', '')::uuid, gen_random_uuid());
  v_follow_up_id uuid := coalesce(nullif(p_lead ->> 'follow_up_id', '')::uuid, gen_random_uuid());
  v_title text := public.lead_case_title(v_lead);
  v_now timestamptz := now();
  v_summary text;
BEGIN
  IF p_channel NOT IN ('app', 'intake_link', 'program_referral') THEN
    RAISE EXCEPTION 'Unknown lead channel' USING ERRCODE = '22023';
  END IF;
  v_summary := CASE WHEN v_lead ->> 'urgency' = 'immediate_danger'
    THEN 'Caller reported immediate danger when this lead arrived.' ELSE '' END;
  IF v_lead ->> 'note' <> '' THEN
    v_summary := btrim(v_summary || chr(10) || (v_lead ->> 'note'));
  END IF;

  INSERT INTO public.cases (
    id, owner_id, org_id, title, status, summary, payment_status, paid_amount,
    lead_source, lead_source_detail, lost_reason,
    lead_captured_at, lead_channel, lead_urgency
  ) VALUES (
    v_case_id, p_owner_id, p_org_id, v_title, 'inquiry', v_summary, 'none', 0,
    v_lead ->> 'lead_source', v_lead ->> 'lead_source_detail', '',
    v_now, p_channel, v_lead ->> 'urgency'
  );

  INSERT INTO public.case_contacts (
    id, owner_id, org_id, case_id, name, relationship, phone, email, is_primary, note
  ) VALUES (
    v_contact_id, p_owner_id, p_org_id, v_case_id,
    v_lead ->> 'caller_name', public.lead_caller_relationship(v_lead ->> 'about_relationship'),
    v_lead ->> 'phone', v_lead ->> 'email', true, ''
  );

  INSERT INTO public.follow_ups (
    id, owner_id, org_id, case_id, title, due_on, status, note, kind, due_time
  ) VALUES (
    v_follow_up_id, p_owner_id, p_org_id, v_case_id,
    'First call ' || chr(8212) || ' ' || v_title,
    coalesce(nullif(p_lead ->> 'due_on', '')::date, CURRENT_DATE),
    'open', '', 'first_call',
    nullif(p_lead ->> 'due_time', '')::time
  );

  INSERT INTO public.case_events (owner_id, org_id, case_id, kind, body, contact_id, occurred_at)
  VALUES (
    p_owner_id, p_org_id, v_case_id, 'system',
    CASE WHEN p_channel = 'intake_link' THEN 'New lead arrived through the intake link'
         WHEN p_channel = 'program_referral' THEN 'New lead referred by '
           || coalesce(nullif(left(btrim(coalesce(p_lead ->> 'referred_by', '')), 200), ''), 'a treatment program')
           || ' through ReferralFit'
         ELSE 'New lead added in the app' END,
    v_contact_id, v_now
  );

  RETURN v_case_id;
END
$$;
REVOKE ALL ON FUNCTION public.create_lead_internal(uuid, uuid, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;

-- ===========================================================================
-- 2. The table
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.program_referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_global_partner_id uuid NOT NULL REFERENCES public.global_partners(id) ON DELETE CASCADE,
  from_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  from_display text NOT NULL CHECK (length(from_display) BETWEEN 1 AND 200),
  to_global_partner_id uuid REFERENCES public.global_partners(id) ON DELETE SET NULL,
  to_org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  to_display text NOT NULL CHECK (length(to_display) BETWEEN 1 AND 200),
  case_id uuid REFERENCES public.cases(id) ON DELETE SET NULL,
  -- What the program typed to tell its own referrals apart ("Maria (mother)").
  family_label text NOT NULL DEFAULT '' CHECK (length(family_label) <= 120),
  consent_attested_at timestamptz NOT NULL,
  share_progress boolean NOT NULL DEFAULT true,
  share_changed_at timestamptz,
  share_changed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS program_referrals_from_idx ON public.program_referrals (from_global_partner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS program_referrals_to_org_idx ON public.program_referrals (to_org_id);
CREATE INDEX IF NOT EXISTS program_referrals_case_idx ON public.program_referrals (case_id);

ALTER TABLE public.program_referrals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.program_referrals FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.program_referrals TO service_role;
REVOKE TRUNCATE ON TABLE public.program_referrals FROM service_role;

-- ===========================================================================
-- 3. Helpers (no client grants)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.program_referral_listing_name(p_global_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT left(coalesce(nullif(btrim(g.organization), ''), btrim(g.name)), 200)
    FROM public.global_partners g WHERE g.id = p_global_id
$$;
REVOKE ALL ON FUNCTION public.program_referral_listing_name(uuid) FROM PUBLIC, anon, authenticated;

-- The signed-in center account's own claimed, active program listing.
CREATE OR REPLACE FUNCTION public.program_referral_caller_listing()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.global_partner_id
    FROM public.center_members m
    JOIN public.global_partners g ON g.id = m.global_partner_id
   WHERE m.user_id = auth.uid() AND g.status = 'active'
$$;
REVOKE ALL ON FUNCTION public.program_referral_caller_listing() FROM PUBLIC, anon, authenticated;

-- Whether a listing can receive: 'ready', 'not_on_referralfit' (unclaimed by
-- a workspace, or not an active professional listing), 'not_taking' (the
-- practice switched program referrals off).
CREATE OR REPLACE FUNCTION public.program_referral_receive_status(p_global_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN g.id IS NULL OR g.status <> 'active' OR public.listing_carries_beds(g.types) OR g.owner_org_id IS NULL
         OR o.id IS NULL THEN 'not_on_referralfit'
    WHEN NOT o.accepts_program_referrals THEN 'not_taking'
    ELSE 'ready' END
    FROM (SELECT p_global_id AS gid) x
    LEFT JOIN public.global_partners g ON g.id = x.gid
    LEFT JOIN public.orgs o ON o.id = g.owner_org_id
$$;
REVOKE ALL ON FUNCTION public.program_referral_receive_status(uuid) FROM PUBLIC, anon, authenticated;

-- Where a case's client was admitted: the program's name from the case's
-- latest outbound referral recorded as admitted (the partner's organization,
-- else its directory listing's). Never a person's name: a partner with no
-- organization and no listing reads 'a treatment program'.
CREATE OR REPLACE FUNCTION public.program_referral_destination(p_case_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT left(coalesce(nullif(btrim(pa.organization), ''), nullif(btrim(g.organization), ''), 'a treatment program'), 200)
    FROM public.referrals r
    JOIN public.partners pa ON pa.id = r.partner_id
    LEFT JOIN public.global_partners g ON g.id = pa.global_partner_id
   WHERE r.case_id = p_case_id AND r.direction = 'outbound' AND r.admitted IS TRUE
   ORDER BY r.admitted_on DESC NULLS LAST, r.created_at DESC
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.program_referral_destination(uuid) FROM PUBLIC, anon, authenticated;

-- Milestones from the case, derived on every read. Ever reached a stage =
-- the stage history (or the current status) shows it. Entered treatment =
-- placed or aftercare, or any referral on the case recorded as admitted.
-- placed_with = program_referral_destination (NULL when not recorded).
CREATE OR REPLACE FUNCTION public.program_referral_milestones(p_case_id uuid)
RETURNS TABLE (reached_at timestamptz, consult boolean, intervention boolean, entered_treatment boolean,
               lost boolean, closed boolean, placed_with text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.first_touch_at,
         c.status IN ('consult', 'deciding', 'engaged', 'intervention', 'placed', 'aftercare')
           OR EXISTS (SELECT 1 FROM public.case_stage_history h WHERE h.case_id = c.id
                         AND h.status IN ('consult', 'deciding', 'engaged', 'intervention', 'placed', 'aftercare')),
         c.status IN ('intervention', 'placed', 'aftercare')
           OR EXISTS (SELECT 1 FROM public.case_stage_history h WHERE h.case_id = c.id
                         AND h.status IN ('intervention', 'placed', 'aftercare')),
         c.status IN ('placed', 'aftercare')
           OR EXISTS (SELECT 1 FROM public.case_stage_history h WHERE h.case_id = c.id AND h.status IN ('placed', 'aftercare'))
           OR EXISTS (SELECT 1 FROM public.referrals r WHERE r.case_id = c.id AND r.admitted IS TRUE),
         c.status = 'lost',
         c.status = 'closed',
         public.program_referral_destination(c.id)
    FROM public.cases c WHERE c.id = p_case_id
$$;
REVOKE ALL ON FUNCTION public.program_referral_milestones(uuid) FROM PUBLIC, anon, authenticated;

-- One program's referrals as the program may see them. Not shared (the
-- practice's switch is off): milestone 'not_shared' and every progress
-- field NULL, the destination included. The case removed: 'closed'.
CREATE OR REPLACE FUNCTION public.program_referral_rows(p_from uuid)
RETURNS TABLE (
  id uuid, to_global_partner_id uuid, to_org_id uuid, to_display text, family_label text, created_at timestamptz,
  shared boolean, milestone text, reached_at timestamptz, minutes_to_reach integer,
  consult boolean, intervention boolean, entered_treatment boolean, placed_with text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT pr.id, pr.to_global_partner_id, pr.to_org_id, pr.to_display, pr.family_label, pr.created_at,
         s.shared,
         CASE WHEN NOT pr.share_progress THEN 'not_shared'
              WHEN m.closed IS NULL THEN 'closed'
              WHEN m.entered_treatment THEN 'entered_treatment'
              WHEN m.lost THEN 'not_proceeding'
              WHEN m.intervention THEN 'intervention'
              WHEN m.consult THEN 'consult'
              WHEN m.closed THEN 'closed'
              WHEN m.reached_at IS NOT NULL THEN 'family_reached'
              ELSE 'received' END,
         CASE WHEN s.shared THEN m.reached_at END,
         CASE WHEN s.shared AND m.reached_at IS NOT NULL
              THEN greatest(0, round(extract(epoch FROM (m.reached_at - pr.created_at)) / 60))::integer END,
         CASE WHEN s.shared THEN m.consult END,
         CASE WHEN s.shared THEN m.intervention END,
         CASE WHEN s.shared THEN m.entered_treatment END,
         CASE WHEN s.shared AND m.entered_treatment THEN m.placed_with END
    FROM public.program_referrals pr
    LEFT JOIN LATERAL public.program_referral_milestones(pr.case_id) m ON true
    CROSS JOIN LATERAL (SELECT pr.share_progress AND m.closed IS NOT NULL AS shared) s
   WHERE pr.from_global_partner_id = p_from
$$;
REVOKE ALL ON FUNCTION public.program_referral_rows(uuid) FROM PUBLIC, anon, authenticated;

-- ===========================================================================
-- 4. The center portal (a center account, for its own listing)
-- ===========================================================================

-- Interventionists and practices to refer to: active professional listings
-- (never programs), by name and state, business details only, with whether
-- each can receive through ReferralFit. At most 25.
CREATE OR REPLACE FUNCTION public.program_referral_targets(p_query text, p_state text DEFAULT NULL)
RETURNS TABLE (global_partner_id uuid, display_name text, city text, state text, types text[], website text, receive_status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from uuid := public.program_referral_caller_listing();
  v_query text := lower(left(btrim(coalesce(p_query, '')), 80));
  v_state text := upper(left(btrim(coalesce(p_state, '')), 2));
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF v_from IS NULL THEN
    RAISE EXCEPTION 'Only a program account with a live listing can refer families' USING ERRCODE = '42501';
  END IF;
  IF length(v_query) < 2 AND v_state = '' THEN RETURN; END IF;
  RETURN QUERY
  SELECT g.id, public.program_referral_listing_name(g.id), g.city, g.state, g.types, g.website,
         public.program_referral_receive_status(g.id)
    FROM public.global_partners g
   WHERE g.status = 'active' AND NOT public.listing_carries_beds(g.types) AND g.id <> v_from
     AND (length(v_query) < 2 OR strpos(lower(g.name), v_query) > 0 OR strpos(lower(g.organization), v_query) > 0)
     AND (v_state = '' OR g.state = v_state)
   ORDER BY (public.program_referral_receive_status(g.id) = 'ready') DESC, 2
   LIMIT 25;
END
$$;
REVOKE ALL ON FUNCTION public.program_referral_targets(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.program_referral_targets(text, text) TO authenticated;

-- The referral's lead, made the way the intake link makes one: no signed-in
-- author on the practice's rows (the claims are cleared for the insert and
-- put back), so it is an ordinary lead with its first call, and the new_lead
-- push goes to every member of the practice.
CREATE OR REPLACE FUNCTION public.program_referral_lead(p_org_id uuid, p_owner_id uuid, p_from_name text, p_lead jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sub text := coalesce(current_setting('request.jwt.claim.sub', true), '');
  v_claims text := coalesce(current_setting('request.jwt.claims', true), '');
  v_note text := left(btrim(coalesce(p_lead ->> 'note', '')), 1000);
  v_case uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  v_case := public.create_lead_internal(p_org_id, p_owner_id, p_lead || jsonb_build_object(
      'urgency', coalesce(nullif(btrim(coalesce(p_lead ->> 'urgency', '')), ''), 'none'),
      'lead_source', 'Professional referral', 'lead_source_detail', p_from_name, 'referred_by', p_from_name,
      'note', 'Referred by ' || p_from_name || ' through ReferralFit.'
              || CASE WHEN v_note <> '' THEN chr(10) || 'Their note: ' || v_note ELSE '' END),
    'program_referral');
  PERFORM set_config('request.jwt.claim.sub', v_sub, true);
  PERFORM set_config('request.jwt.claims', v_claims, true);
  RETURN v_case;
END
$$;
REVOKE ALL ON FUNCTION public.program_referral_lead(uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- Refer a family: the checks, then the lead and the referral row.
CREATE OR REPLACE FUNCTION public.program_refer_family(
  p_to_global_id uuid, p_caller_first_name text, p_phone text, p_email text, p_relationship text,
  p_about_first_name text, p_urgency text, p_note text, p_consent boolean
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_from uuid := public.program_referral_caller_listing();
  v_status text := public.program_referral_receive_status(p_to_global_id);
  v_org uuid;
  v_owner uuid;
  v_from_name text;
  v_digits text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_existing uuid;
  v_case uuid;
  v_id uuid := gen_random_uuid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF v_from IS NULL THEN
    RAISE EXCEPTION 'Only a program account with a live listing can refer families' USING ERRCODE = '42501';
  END IF;
  IF p_consent IS NOT TRUE THEN
    RAISE EXCEPTION 'Confirm that the family asked you to share their details with this interventionist.' USING ERRCODE = '22023';
  END IF;
  IF v_status = 'not_taking' THEN
    RAISE EXCEPTION 'This practice is not taking referrals through ReferralFit right now. Contact them directly.' USING ERRCODE = '22023';
  END IF;
  IF v_status <> 'ready' THEN
    RAISE EXCEPTION 'This interventionist is not on ReferralFit yet. Contact them directly.' USING ERRCODE = 'P0002';
  END IF;
  SELECT g.owner_org_id INTO v_org FROM public.global_partners g WHERE g.id = p_to_global_id;
  IF (SELECT count(*) FROM public.program_referrals pr
       WHERE pr.from_global_partner_id = v_from AND pr.created_at > now() - interval '24 hours') >= 30 THEN
    RAISE EXCEPTION 'Your program sent 30 referrals in the last 24 hours. Try again later, or call the practice directly.'
      USING ERRCODE = '22023';
  END IF;
  -- A second tap: same family, same practice, last ten minutes.
  SELECT pr.id INTO v_existing
    FROM public.program_referrals pr
    JOIN public.case_contacts cc ON cc.case_id = pr.case_id AND cc.is_primary
   WHERE pr.from_global_partner_id = v_from AND pr.to_org_id = v_org AND pr.created_at > now() - interval '10 minutes'
     AND length(v_digits) >= 10 AND regexp_replace(coalesce(cc.phone, ''), '[^0-9]', '', 'g') = v_digits
   LIMIT 1;
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  SELECT m.user_id INTO v_owner FROM public.org_members m
   WHERE m.org_id = v_org ORDER BY (m.role = 'owner') DESC, m.created_at LIMIT 1;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'This interventionist is not on ReferralFit yet. Contact them directly.' USING ERRCODE = 'P0002';
  END IF;
  v_from_name := public.program_referral_listing_name(v_from);
  v_case := public.program_referral_lead(v_org, v_owner, v_from_name, jsonb_build_object(
      'caller_name', p_caller_first_name, 'phone', p_phone, 'email', p_email, 'about_relationship', p_relationship,
      'about_first_name', p_about_first_name, 'urgency', p_urgency, 'note', p_note));
  INSERT INTO public.program_referrals (id, from_global_partner_id, from_user_id, from_display, to_global_partner_id,
                                        to_org_id, to_display, case_id, family_label, consent_attested_at)
  VALUES (v_id, v_from, v_user, v_from_name, p_to_global_id, v_org, public.program_referral_listing_name(p_to_global_id),
          v_case,
          left(btrim(btrim(coalesce(p_caller_first_name, ''))
               || CASE WHEN btrim(coalesce(p_relationship, '')) <> '' THEN ' (' || btrim(p_relationship) || ')' ELSE '' END), 120),
          now());
  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION public.program_refer_family(uuid, text, text, text, text, text, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.program_refer_family(uuid, text, text, text, text, text, text, text, boolean) TO authenticated;

-- The program's referrals, newest first.
CREATE OR REPLACE FUNCTION public.list_program_referrals()
RETURNS TABLE (
  id uuid, to_global_partner_id uuid, to_display text, family_label text, created_at timestamptz,
  shared boolean, milestone text, reached_at timestamptz, minutes_to_reach integer,
  consult boolean, intervention boolean, entered_treatment boolean, placed_with text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from uuid := public.program_referral_caller_listing();
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF v_from IS NULL THEN
    RAISE EXCEPTION 'Only a program account with a live listing can see its referrals' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT r.id, r.to_global_partner_id, r.to_display, r.family_label, r.created_at, r.shared, r.milestone,
         r.reached_at, r.minutes_to_reach, r.consult, r.intervention, r.entered_treatment, r.placed_with
    FROM public.program_referral_rows(v_from) r
   ORDER BY r.created_at DESC
   LIMIT 200;
END
$$;
REVOKE ALL ON FUNCTION public.list_program_referrals() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_program_referrals() TO authenticated;

-- The program's own track record with each interventionist it referred to.
-- Rates use only referrals whose progress is shared. Deliberately no count
-- of where clients were placed (see the header).
CREATE OR REPLACE FUNCTION public.program_referral_stats()
RETURNS TABLE (
  to_global_partner_id uuid, to_display text, sent integer, shared integer, reached_within_24h integer,
  median_minutes_to_reach integer, consult_or_intervention integer, entered_treatment integer, last_referred_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from uuid := public.program_referral_caller_listing();
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF v_from IS NULL THEN
    RAISE EXCEPTION 'Only a program account with a live listing can see its referrals' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT (array_agg(r.to_global_partner_id ORDER BY r.created_at DESC))[1],
         (array_agg(r.to_display ORDER BY r.created_at DESC))[1],
         count(*)::integer,
         (count(*) FILTER (WHERE r.shared))::integer,
         (count(*) FILTER (WHERE r.shared AND r.minutes_to_reach IS NOT NULL AND r.minutes_to_reach <= 1440))::integer,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY r.minutes_to_reach)
            FILTER (WHERE r.shared AND r.minutes_to_reach IS NOT NULL))::integer,
         (count(*) FILTER (WHERE r.shared AND (r.consult OR r.intervention)))::integer,
         (count(*) FILTER (WHERE r.shared AND r.entered_treatment))::integer,
         max(r.created_at)
    FROM public.program_referral_rows(v_from) r
   GROUP BY r.to_org_id
   ORDER BY max(r.created_at) DESC;
END
$$;
REVOKE ALL ON FUNCTION public.program_referral_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.program_referral_stats() TO authenticated;

-- ===========================================================================
-- 5. The receiving practice (the app)
-- ===========================================================================

-- The program referral behind a case, for the case file. Members of the
-- case's workspace only.
CREATE OR REPLACE FUNCTION public.case_program_referral(p_case_id uuid)
RETURNS TABLE (id uuid, from_display text, share_progress boolean, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT pr.id, pr.from_display, pr.share_progress, pr.created_at
    FROM public.program_referrals pr
    JOIN public.cases c ON c.id = pr.case_id
   WHERE pr.case_id = p_case_id AND auth.uid() IS NOT NULL AND c.org_id = public.current_org_id()
   ORDER BY pr.created_at DESC
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.case_program_referral(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.case_program_referral(uuid) TO authenticated;

-- The practice's switch for one referral. Any member of the case's
-- workspace; written to the case timeline.
CREATE OR REPLACE FUNCTION public.set_program_referral_sharing(p_referral_id uuid, p_share boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_row record;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF p_share IS NULL THEN
    RAISE EXCEPTION 'Choose whether to share progress' USING ERRCODE = '22023';
  END IF;
  SELECT pr.id, pr.share_progress, pr.from_display, c.id AS case_id, c.org_id INTO v_row
    FROM public.program_referrals pr
    JOIN public.cases c ON c.id = pr.case_id
   WHERE pr.id = p_referral_id AND c.org_id = public.current_org_id()
   FOR UPDATE OF pr;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referral not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.share_progress = p_share THEN RETURN p_share; END IF;
  UPDATE public.program_referrals pr
     SET share_progress = p_share, share_changed_at = now(), share_changed_by = v_user
   WHERE pr.id = p_referral_id;
  INSERT INTO public.case_events (owner_id, org_id, case_id, kind, body, occurred_at)
  VALUES (v_user, v_row.org_id, v_row.case_id, 'system',
          CASE WHEN p_share THEN 'Sharing progress with ' ELSE 'Stopped sharing progress with ' END || v_row.from_display,
          now());
  RETURN p_share;
END
$$;
REVOKE ALL ON FUNCTION public.set_program_referral_sharing(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_program_referral_sharing(uuid, boolean) TO authenticated;

-- The workspace's switch: whether programs can refer families to it, whether
-- the caller may change it (the owner), and whether it has a live directory
-- profile (without one, no program can find it).
CREATE OR REPLACE FUNCTION public.program_referral_settings()
RETURNS TABLE (accepts boolean, can_change boolean, has_profile boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.accepts_program_referrals,
         EXISTS (SELECT 1 FROM public.org_members m WHERE m.org_id = o.id AND m.user_id = auth.uid() AND m.role = 'owner'),
         EXISTS (SELECT 1 FROM public.global_partners g
                  WHERE g.owner_org_id = o.id AND g.status = 'active' AND NOT public.listing_carries_beds(g.types))
    FROM public.orgs o
   WHERE o.id = public.current_org_id() AND auth.uid() IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public.program_referral_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.program_referral_settings() TO authenticated;

CREATE OR REPLACE FUNCTION public.set_accepts_program_referrals(p_accepts boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.current_org_id();
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF p_accepts IS NULL THEN
    RAISE EXCEPTION 'Choose whether to accept program referrals' USING ERRCODE = '22023';
  END IF;
  IF v_org IS NULL OR NOT EXISTS (SELECT 1 FROM public.org_members m
                                   WHERE m.org_id = v_org AND m.user_id = auth.uid() AND m.role = 'owner') THEN
    RAISE EXCEPTION 'Only the workspace owner can change this' USING ERRCODE = '42501';
  END IF;
  UPDATE public.orgs SET accepts_program_referrals = p_accepts WHERE id = v_org;
  RETURN p_accepts;
END
$$;
REVOKE ALL ON FUNCTION public.set_accepts_program_referrals(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_accepts_program_referrals(boolean) TO authenticated;

COMMIT;
