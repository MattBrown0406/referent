-- Bug audit round 1 (2026-11-08): fixes to the five migrations of
-- 2026-11-08 found by four independent reviews. Each function below is its
-- latest definition with only the changes named here.
--
--   1. org_move_workspace_rows: program referrals move with a practice that
--      joins another (before, they cascaded away with the old workspace).
--   2. merge_global_partners: program referrals, program claim requests and
--      bed check-in links move to the kept listing; approving a claim needs
--      a live program listing (decide_program_claim_request).
--   3. Morning summary at 7 AM where the member is, across daylight saving:
--      email_preferences.tz_name (an IANA zone) set by the app on every load
--      (set_email_timezone); the fixed offset stays as the fallback.
--   4. Weekly bed check-in a day before counts go stale: after 5 days without
--      a confirmation, at most every 5 days (failed or expired rows do not
--      hold the next one back).
--   5. An answer arriving while its email is being sent gets its own email
--      (email_enqueue folds only into rows nobody claimed yet).
--   6. Answer links: once a request is closed or a week past its deadline the
--      page shows only the status (no summary, no practice name); opening a
--      link no longer marks it viewed (scanners run pages); the page calls
--      public_placement_answer_seen on the program's first interaction.
--   7. Entered treatment counts only the practice's outbound referral records.
--   8. Sending: a row's content is fixed the first time it is prepared (counts,
--      the bed check-in link), so a retry sends the same email; recipients are
--      re-checked at send time (still an admin, still in the workspace); a
--      morning summary more than 3 hours late expires instead of going out;
--      one row that cannot be prepared never blocks the queue; and
--      email_outbox_release returns claimed rows to waiting without spending
--      an attempt (a Resend account problem).
--   9. Helper functions from 20261108150000 are no longer executable by
--      clients (they never needed to be).
--
-- Transit-safe: ASCII only, no backslashes, every statement under 3,700
-- characters.

BEGIN;

-- ===========================================================================
-- 1. Program referrals move with the workspace
-- ===========================================================================
-- Same as 20261106130000 plus program_referrals.
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
  UPDATE public.referral_handoffs     SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.referral_handoff_events SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.program_referrals     SET to_org_id = p_to WHERE to_org_id = p_from;
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

-- ===========================================================================
-- 2. Merging listings, and approving a claim on a live listing
-- ===========================================================================
-- Same as 20261104140000 plus program referrals, claim requests and bed links.
CREATE OR REPLACE FUNCTION public.merge_global_partners(p_keep uuid, p_drop uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_repointed integer := 0;
  v_dupes integer := 0;
  v_prev text := coalesce(current_setting('referralfit.syncing', true), '');
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform admin required' USING ERRCODE = '42501';
  END IF;
  IF p_keep = p_drop THEN
    RAISE EXCEPTION 'Cannot merge a listing into itself' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.global_partners WHERE id = p_keep)
     OR NOT EXISTS (SELECT 1 FROM public.global_partners WHERE id = p_drop) THEN
    RAISE EXCEPTION 'Directory listing not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM set_config('referralfit.syncing', 'on', true);

  -- A workspace that imported both copies keeps the one linked to p_keep;
  -- its p_drop copy is unlinked (not deleted - it may carry local history).
  UPDATE public.partners d
     SET global_partner_id = NULL
   WHERE d.global_partner_id = p_drop
     AND EXISTS (SELECT 1 FROM public.partners k WHERE k.org_id = d.org_id AND k.global_partner_id = p_keep);
  GET DIAGNOSTICS v_dupes = ROW_COUNT;

  UPDATE public.partners SET global_partner_id = p_keep WHERE global_partner_id = p_drop;
  GET DIAGNOSTICS v_repointed = ROW_COUNT;

  UPDATE public.user_favorites SET target_id = p_keep
   WHERE target_type = 'global_partner' AND target_id = p_drop
     AND NOT EXISTS (SELECT 1 FROM public.user_favorites f2
                      WHERE f2.user_id = user_favorites.user_id AND f2.target_type = 'global_partner' AND f2.target_id = p_keep);
  DELETE FROM public.user_favorites WHERE target_type = 'global_partner' AND target_id = p_drop;

  UPDATE public.center_members SET global_partner_id = p_keep WHERE global_partner_id = p_drop;
  UPDATE public.center_claim_codes SET global_partner_id = p_keep WHERE global_partner_id = p_drop;
  UPDATE public.placement_request_recipients SET global_partner_id = p_keep WHERE global_partner_id = p_drop;
  UPDATE public.program_credentials SET global_partner_id = p_keep WHERE global_partner_id = p_drop;
  UPDATE public.program_referrals SET from_global_partner_id = p_keep WHERE from_global_partner_id = p_drop;
  UPDATE public.program_referrals SET to_global_partner_id = p_keep WHERE to_global_partner_id = p_drop;
  UPDATE public.program_claim_requests SET global_partner_id = p_keep WHERE global_partner_id = p_drop;
  UPDATE public.listing_bed_links SET global_partner_id = p_keep WHERE global_partner_id = p_drop;

  UPDATE public.global_partners SET status = 'archived', merged_into = p_keep WHERE id = p_drop;

  PERFORM set_config('referralfit.syncing', v_prev, true);
  RETURN v_repointed;
END
$$;
REVOKE ALL ON FUNCTION public.merge_global_partners(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.merge_global_partners(uuid, uuid) TO authenticated;

-- Same as 20261108150000 plus the live-listing check on approve.
CREATE OR REPLACE FUNCTION public.decide_program_claim_request(p_id uuid, p_approve boolean, p_note text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin uuid := auth.uid();
  r public.program_claim_requests%ROWTYPE;
  v_prev_pub text := coalesce(current_setting('referralfit.seed_publish', true), '');
  v_other record;
BEGIN
  IF v_admin IS NULL OR NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Only platform admins can decide claim requests' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO r FROM public.program_claim_requests x WHERE x.id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Claim request not found' USING ERRCODE = 'P0002'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'This request was already decided' USING ERRCODE = '22023'; END IF;
  IF p_approve THEN
    IF NOT EXISTS (SELECT 1 FROM public.global_partners g
                    WHERE g.id = r.global_partner_id AND g.status = 'active' AND g.merged_into IS NULL
                      AND public.listing_is_program(g.types)) THEN
      RAISE EXCEPTION 'This listing is no longer live in the directory. Decline this request.' USING ERRCODE = '22023';
    END IF;
    IF public.global_listing_is_claimed(r.global_partner_id) THEN
      RAISE EXCEPTION 'Another account manages this listing now. Decline this request.' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.center_members m WHERE m.user_id = r.user_id) THEN
      RAISE EXCEPTION 'This account already manages another listing. Decline this request.' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.center_members (user_id, global_partner_id) VALUES (r.user_id, r.global_partner_id);
    UPDATE public.center_claim_codes c SET expires_at = now()
     WHERE c.global_partner_id = r.global_partner_id AND c.claimed_at IS NULL AND c.expires_at > now();
    PERFORM set_config('referralfit.seed_publish', 'on', true);
    UPDATE public.global_partners g SET verified_at = coalesce(g.verified_at, now()) WHERE g.id = r.global_partner_id;
    PERFORM set_config('referralfit.seed_publish', v_prev_pub, true);
    FOR v_other IN SELECT x.id, x.user_id FROM public.program_claim_requests x
                    WHERE x.global_partner_id = r.global_partner_id AND x.status = 'pending' AND x.id <> r.id LOOP
      UPDATE public.program_claim_requests x
         SET status = 'declined', decided_by = v_admin, decided_at = now(),
             decision_note = 'Another account at this program manages the listing now.'
       WHERE x.id = v_other.id;
      PERFORM public.email_enqueue(v_other.user_id, 'claim_decision', jsonb_build_object('claim_request_id', v_other.id));
    END LOOP;
  END IF;
  UPDATE public.program_claim_requests x
     SET status = CASE WHEN p_approve THEN 'approved' ELSE 'declined' END,
         decided_by = v_admin, decided_at = now(), decision_note = left(btrim(coalesce(p_note, '')), 500)
   WHERE x.id = r.id;
  PERFORM public.email_enqueue(r.user_id, 'claim_decision', jsonb_build_object('claim_request_id', r.id));
  RETURN CASE WHEN p_approve THEN 'approved' ELSE 'declined' END;
END
$$;
REVOKE ALL ON FUNCTION public.decide_program_claim_request(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_program_claim_request(uuid, boolean, text) TO authenticated;

-- ===========================================================================
-- 3. The morning summary keeps to 7 AM local time
-- ===========================================================================

ALTER TABLE public.email_preferences ADD COLUMN IF NOT EXISTS tz_name text;

-- The device's zone name ('America/Los_Angeles', checked against the
-- server's list) and its current offset. A null or unknown name keeps the
-- one stored; the offset is the fallback for members whose app never sent a
-- name.
CREATE OR REPLACE FUNCTION public.set_email_timezone(p_tz_name text, p_tz_offset_minutes integer)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_name text := nullif(btrim(coalesce(p_tz_name, '')), '');
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF v_name IS NOT NULL AND (length(v_name) > 64 OR NOT EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = v_name)) THEN
    v_name := NULL;
  END IF;
  PERFORM public.email_preferences_row(v_user);
  UPDATE public.email_preferences p
     SET tz_name = coalesce(v_name, p.tz_name),
         tz_offset_minutes = CASE WHEN p_tz_offset_minutes BETWEEN -840 AND 840 THEN p_tz_offset_minutes ELSE p.tz_offset_minutes END,
         updated_at = now()
   WHERE p.user_id = v_user;
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.set_email_timezone(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_email_timezone(text, integer) TO authenticated;

-- A member's local time now: their zone when known, else the stored offset.
CREATE OR REPLACE FUNCTION public.email_local_now(p_tz_name text, p_tz_offset_minutes integer)
RETURNS timestamp
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT CASE WHEN p_tz_name IS NOT NULL AND EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = p_tz_name)
              THEN now() AT TIME ZONE p_tz_name
              ELSE (now() AT TIME ZONE 'UTC') + make_interval(mins => coalesce(p_tz_offset_minutes, -420)) END
$$;
REVOKE ALL ON FUNCTION public.email_local_now(text, integer) FROM PUBLIC, anon, authenticated, service_role;

-- Same as 20261108120000, reading the zone name first.
CREATE OR REPLACE FUNCTION public.notify_daily_summaries()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pref record;
  v_local timestamp;
  v_counts jsonb;
  v_count integer := 0;
BEGIN
  FOR v_pref IN SELECT p.user_id, p.tz_offset_minutes, p.tz_name, p.daily_summary_sent_on
                  FROM public.email_preferences p
                 WHERE p.daily_summary
                   AND EXISTS (SELECT 1 FROM public.org_members m WHERE m.user_id = p.user_id) LOOP
    v_local := public.email_local_now(v_pref.tz_name, v_pref.tz_offset_minutes);
    IF extract(hour FROM v_local) <> 7 THEN CONTINUE; END IF;
    IF v_pref.daily_summary_sent_on IS NOT DISTINCT FROM v_local::date THEN CONTINUE; END IF;
    UPDATE public.email_preferences SET daily_summary_sent_on = v_local::date WHERE user_id = v_pref.user_id;
    v_counts := public.email_daily_summary_counts(v_pref.user_id, v_local::date);
    IF (v_counts ->> 'new_leads')::int + (v_counts ->> 'due_today')::int + (v_counts ->> 'overdue')::int
       + (v_counts ->> 'answers')::int = 0 THEN
      CONTINUE;
    END IF;
    IF public.email_enqueue(v_pref.user_id, 'daily_summary', v_counts || jsonb_build_object('day', v_local::date::text)) THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END
$$;
REVOKE ALL ON FUNCTION public.notify_daily_summaries() FROM PUBLIC, anon, authenticated, service_role;

-- ===========================================================================
-- 4 + 5. The bed check-in's timing, and folding only unclaimed emails
-- ===========================================================================
-- Same as 20261108120000: after 5 days (counts go stale at 7), at most
-- every 5 days; a failed or expired check-in does not hold the next back.
CREATE OR REPLACE FUNCTION public.notify_bed_reminders()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row record;
  v_count integer := 0;
BEGIN
  FOR v_row IN SELECT m.user_id, m.global_partner_id
                 FROM public.center_members m
                 JOIN public.global_partners g ON g.id = m.global_partner_id
                WHERE g.status = 'active' AND public.listing_carries_beds(g.types)
                  AND (g.beds_updated_at IS NULL OR g.beds_updated_at < now() - interval '5 days')
                  AND NOT EXISTS (SELECT 1 FROM public.email_outbox o
                                   WHERE o.user_id = m.user_id AND o.kind = 'bed_reminder' AND o.error IS NULL
                                     AND o.created_at > now() - interval '4 days 20 hours') LOOP
    IF public.email_enqueue(v_row.user_id, 'bed_reminder', jsonb_build_object('global_partner_id', v_row.global_partner_id)) THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END
$$;
REVOKE ALL ON FUNCTION public.notify_bed_reminders() FROM PUBLIC, anon, authenticated, service_role;

-- Same as 20261108120000, folding only into emails nobody claimed yet.
CREATE OR REPLACE FUNCTION public.email_enqueue(p_user_id uuid, p_kind text, p_data jsonb, p_not_before timestamptz DEFAULT now())
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_data jsonb := coalesce(p_data, '{}');
BEGIN
  IF p_user_id IS NULL OR NOT public.email_wanted(p_user_id, p_kind) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.email_outbox o
              WHERE o.user_id = p_user_id AND o.kind = p_kind AND o.data = v_data
                AND o.sent_at IS NULL AND o.error IS NULL AND o.claimed_at IS NULL) THEN
    RETURN false;
  END IF;
  INSERT INTO public.email_outbox (user_id, kind, data, not_before)
  VALUES (p_user_id, p_kind, v_data, greatest(coalesce(p_not_before, now()), now()));
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.email_enqueue(uuid, text, jsonb, timestamptz) FROM PUBLIC, anon, authenticated, service_role;

-- ===========================================================================
-- 6. Answer links: nothing past its time, nothing marked on open
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.public_placement_answer_open(p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid := public.placement_answer_link_recipient(p_token);
  v_view jsonb;
  v_live boolean;
BEGIN
  IF v_id IS NULL THEN
    RETURN NULL;
  END IF;
  v_view := public.placement_answer_link_view(v_id);
  SELECT q.status = 'open' AND now() <= q.respond_by + interval '7 days' INTO v_live
    FROM public.placement_request_recipients r
    JOIN public.placement_requests q ON q.id = r.request_id
   WHERE r.id = v_id;
  -- Closed, cancelled, or a week past the deadline: the status only.
  IF NOT coalesce(v_live, false) THEN
    v_view := v_view || jsonb_build_object('payload', '{}'::jsonb, 'practice_name', '');
  END IF;
  RETURN v_view;
END
$$;
REVOKE ALL ON FUNCTION public.public_placement_answer_open(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_placement_answer_open(text) TO anon, authenticated;

-- The program's first interaction with the page (a tap or a key, never the
-- page load) marks the request viewed, once, while it is open.
CREATE OR REPLACE FUNCTION public.public_placement_answer_seen(p_token text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid := public.placement_answer_link_recipient(p_token);
BEGIN
  IF v_id IS NULL THEN
    RETURN false;
  END IF;
  UPDATE public.placement_request_recipients r
     SET viewed_at = now(), status = CASE WHEN r.status = 'sent' THEN 'viewed' ELSE r.status END
   WHERE r.id = v_id AND r.viewed_at IS NULL
     AND EXISTS (SELECT 1 FROM public.placement_requests q WHERE q.id = r.request_id AND q.status = 'open');
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION public.public_placement_answer_seen(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_placement_answer_seen(text) TO anon, authenticated;

-- ===========================================================================
-- 7. Entered treatment: the practice's outbound referral records only
-- ===========================================================================
-- Same as 20261108140000 plus direction = 'outbound'.
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
           OR EXISTS (SELECT 1 FROM public.referrals r WHERE r.case_id = c.id AND r.direction = 'outbound' AND r.admitted IS TRUE),
         c.status = 'lost',
         c.status = 'closed',
         public.program_referral_destination(c.id)
    FROM public.cases c WHERE c.id = p_case_id
$$;
REVOKE ALL ON FUNCTION public.program_referral_milestones(uuid) FROM PUBLIC, anon, authenticated;

-- ===========================================================================
-- 8. Sending: fixed content, re-checked recipients, late summaries expire
-- ===========================================================================

-- Why a row should no longer go out, or NULL (checked at every claim).
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
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.email_prepare_problem(public.email_outbox) FROM PUBLIC, anon, authenticated, service_role;

-- What a row says, worked out once (it then stays the same for retries):
-- answer counts, the listing and a new private link, the claim details.
CREATE OR REPLACE FUNCTION public.email_prepare_data(o public.email_outbox)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_data jsonb := o.data;
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
  END IF;
  RETURN v_data || jsonb_build_object('prepared', true);
END
$$;
REVOKE ALL ON FUNCTION public.email_prepare_data(public.email_outbox) FROM PUBLIC, anon, authenticated, service_role;

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
    UPDATE public.email_outbox x SET error = v_fail WHERE x.id = p_id;
    RETURN;
  END IF;
  IF coalesce((o.data ->> 'prepared')::boolean, false) THEN
    v_data := o.data;
  ELSE
    v_data := public.email_prepare_data(o);
    UPDATE public.email_outbox x SET data = v_data WHERE x.id = p_id;
  END IF;
  v_pref := public.email_preferences_row(o.user_id);
  RETURN QUERY SELECT o.id, o.kind, v_email, v_data, v_pref.unsubscribe_token;
END
$$;
REVOKE ALL ON FUNCTION public.email_outbox_prepare(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Same as 20261108120000, each row prepared on its own.
CREATE OR REPLACE FUNCTION public.email_outbox_claim(p_limit integer DEFAULT 20)
RETURNS TABLE (id uuid, kind text, email text, data jsonb, unsubscribe_token text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ids uuid[];
  v_id uuid;
BEGIN
  UPDATE public.email_outbox o SET error = 'too_many_attempts'
   WHERE o.sent_at IS NULL AND o.error IS NULL AND o.attempts >= 5;
  WITH picked AS (
    SELECT o.id AS pid FROM public.email_outbox o
     WHERE o.sent_at IS NULL AND o.error IS NULL AND o.not_before <= now()
       AND (o.claimed_at IS NULL OR o.claimed_at < now() - interval '5 minutes')
     ORDER BY o.created_at
     LIMIT greatest(1, least(coalesce(p_limit, 20), 100))
     FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.email_outbox o SET claimed_at = now(), attempts = o.attempts + 1
      FROM picked WHERE o.id = picked.pid
    RETURNING o.id AS cid, o.created_at AS made
  )
  SELECT coalesce(array_agg(claimed.cid ORDER BY claimed.made), '{}') INTO v_ids FROM claimed;
  FOREACH v_id IN ARRAY v_ids LOOP
    -- One row that cannot be prepared never holds back the rest.
    BEGIN
      RETURN QUERY SELECT * FROM public.email_outbox_prepare(v_id);
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.email_outbox x SET error = 'prepare_failed', last_error = left(SQLERRM, 300) WHERE x.id = v_id;
    END;
  END LOOP;
END
$$;
REVOKE ALL ON FUNCTION public.email_outbox_claim(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_outbox_claim(integer) TO service_role;

-- Claimed rows the dispatcher did not try (Resend refused the account or the
-- sender): back to waiting, without spending an attempt.
CREATE OR REPLACE FUNCTION public.email_outbox_release(p_ids uuid[])
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.email_outbox o SET claimed_at = NULL, attempts = greatest(o.attempts - 1, 0)
   WHERE o.id = ANY (coalesce(p_ids, '{}'::uuid[])) AND o.sent_at IS NULL AND o.error IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;
REVOKE ALL ON FUNCTION public.email_outbox_release(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_outbox_release(uuid[]) TO service_role;

-- ===========================================================================
-- 9. Helpers that clients never call
-- ===========================================================================

REVOKE ALL ON FUNCTION public.listing_is_program(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.website_host(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.email_matches_website(text, text) FROM PUBLIC, anon, authenticated;

COMMIT;
