-- ReferralFit: a new lead's first call reaches someone on time.
--
-- 1. The 9 AM overdue push (notify_overdue_follow_ups) counted only steps
--    with an assignee of their own or on their case. A lead arrives
--    unassigned (quick-add and the intake link both create it so), so an
--    overdue first call nobody had taken reached nobody. An unassigned step
--    now counts for every member of its practice: the same rule as Today's
--    Mine view, where an item nobody has taken shows for everyone.
-- 2. A new push at the speed-to-lead target: when a lead's first call is
--    still not made lead_response_target_minutes after it arrived (15 unless
--    the practice changed it), one "New lead waiting" push goes to whoever
--    has the lead, or to every member when nobody has taken it yet. Once per
--    lead (lead_first_call_nudges), only for leads from the last 24 hours (a
--    deploy never sends a push for every old lead), never for a lead that
--    arrived as possible spam (create_lead_from_intake sent no push for it
--    either). Run every minute by pg_cron; the push dispatcher, already on a
--    one-minute tick, sends it.
--
-- The push reuses the new_lead kind and its copy ("New lead waiting" / "A new
-- lead is waiting for its first call."), so the member's existing "New lead"
-- choice applies and the app already opens the case on tap. No name is ever
-- in a push. Additive and re-runnable. Transit-safe: ASCII only, no
-- backslashes, every statement under 3,700 characters.

BEGIN;

-- ===========================================================================
-- 1. Overdue push: unassigned steps count for the whole practice
-- ===========================================================================

-- Same as 20261001140000 except the ownership test: a step is this member's
-- when it (or, without an assignee of its own, its case) is assigned to the
-- member, or when it is assigned to nobody in the member's practice.
CREATE OR REPLACE FUNCTION public.notify_overdue_follow_ups()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pref record;
  v_local timestamp;
  v_count integer := 0;
BEGIN
  FOR v_pref IN SELECT p.user_id, p.tz_offset_minutes, p.overdue_notified_on, m.org_id
                  FROM public.notification_preferences p
                  LEFT JOIN public.org_members m ON m.user_id = p.user_id
                 WHERE p.push_enabled AND p.overdue_mine LOOP
    v_local := (now() AT TIME ZONE 'UTC') + make_interval(mins => v_pref.tz_offset_minutes);
    IF extract(hour FROM v_local) <> 9 THEN CONTINUE; END IF;
    IF v_pref.overdue_notified_on IS NOT DISTINCT FROM v_local::date THEN CONTINUE; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.follow_ups f
        LEFT JOIN public.cases c ON c.id = f.case_id
       WHERE f.status = 'open'
         AND coalesce(f.snoozed_until, f.due_on) < v_local::date
         AND (coalesce(f.assigned_to, c.assigned_to) = v_pref.user_id
              OR (coalesce(f.assigned_to, c.assigned_to) IS NULL
                  AND v_pref.org_id IS NOT NULL
                  AND f.org_id = v_pref.org_id))
    ) THEN CONTINUE; END IF;
    IF public.notify_enqueue(v_pref.user_id, 'overdue_mine', jsonb_build_object('day', v_local::date::text)) THEN
      v_count := v_count + 1;
    END IF;
    UPDATE public.notification_preferences SET overdue_notified_on = v_local::date WHERE user_id = v_pref.user_id;
  END LOOP;
  RETURN v_count;
END
$$;
REVOKE ALL ON FUNCTION public.notify_overdue_follow_ups() FROM PUBLIC, anon, authenticated, service_role;

-- ===========================================================================
-- 2. A first call past the speed-to-lead target
-- ===========================================================================

-- One row per lead that has had its first-call push. No client role can
-- read or write it.
CREATE TABLE IF NOT EXISTS public.lead_first_call_nudges (
  case_id    uuid PRIMARY KEY REFERENCES public.cases(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  nudged_at  timestamptz NOT NULL DEFAULT now(),
  recipients integer NOT NULL DEFAULT 0
);
ALTER TABLE public.lead_first_call_nudges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.lead_first_call_nudges FROM PUBLIC, anon, authenticated, service_role;

-- The minute pass reads only leads still waiting for their first touch.
CREATE INDEX IF NOT EXISTS cases_waiting_leads_idx ON public.cases (lead_captured_at)
  WHERE lead_captured_at IS NOT NULL AND first_touch_at IS NULL;

CREATE OR REPLACE FUNCTION public.notify_missed_first_calls()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lead record;
  v_sent integer;
  v_count integer := 0;
BEGIN
  FOR v_lead IN
    SELECT c.id AS case_id, c.org_id, f.id AS follow_up_id,
           coalesce(f.assigned_to, c.assigned_to) AS owner_id
      FROM public.cases c
      JOIN public.orgs o ON o.id = c.org_id
      JOIN LATERAL (
        SELECT f1.id, f1.assigned_to
          FROM public.follow_ups f1
         WHERE f1.case_id = c.id
           AND f1.kind = 'first_call'
           AND f1.status = 'open'
           AND (f1.snoozed_until IS NULL OR f1.snoozed_until <= CURRENT_DATE)
         ORDER BY f1.created_at
         LIMIT 1
      ) f ON true
     WHERE c.lead_captured_at IS NOT NULL
       AND c.first_touch_at IS NULL
       AND c.status NOT IN ('closed', 'lost')
       AND c.lead_captured_at > now() - interval '24 hours'
       AND c.lead_captured_at + make_interval(mins => o.lead_response_target_minutes) <= now()
       AND position('Possible spam:' IN coalesce(c.summary, '')) = 0
       AND NOT EXISTS (SELECT 1 FROM public.lead_first_call_nudges n WHERE n.case_id = c.id)
     ORDER BY c.lead_captured_at
     LIMIT 200
  LOOP
    v_sent := 0;
    IF v_lead.owner_id IS NOT NULL THEN
      IF public.notify_enqueue(v_lead.owner_id, 'new_lead',
           jsonb_build_object('case_id', v_lead.case_id, 'follow_up_id', v_lead.follow_up_id, 'reason', 'first_call_due')) THEN
        v_sent := 1;
      END IF;
    ELSE
      v_sent := public.notify_org_members(v_lead.org_id, 'new_lead',
        jsonb_build_object('case_id', v_lead.case_id, 'follow_up_id', v_lead.follow_up_id, 'reason', 'first_call_due'), NULL);
    END IF;
    INSERT INTO public.lead_first_call_nudges (case_id, org_id, recipients)
    VALUES (v_lead.case_id, v_lead.org_id, v_sent)
    ON CONFLICT (case_id) DO NOTHING;
    v_count := v_count + v_sent;
  END LOOP;
  RETURN v_count;
END
$$;
REVOKE ALL ON FUNCTION public.notify_missed_first_calls() FROM PUBLIC, anon, authenticated, service_role;

-- ===========================================================================
-- 3. Schedule (where pg_cron is on; harmless elsewhere)
-- ===========================================================================

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'referralfit-push-first-call-minute') THEN
      PERFORM cron.unschedule('referralfit-push-first-call-minute');
    END IF;
    PERFORM cron.schedule('referralfit-push-first-call-minute', '* * * * *', 'SELECT public.notify_missed_first_calls()');
  END IF;
END
$do$;

COMMIT;
