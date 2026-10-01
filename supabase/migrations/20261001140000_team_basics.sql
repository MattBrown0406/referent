BEGIN;

-- Team-grade basics: assignees, who did what, and server-sent push.
--
-- Roadmap feature 5 (Matt Brown, 2026-10-01). Practices with staff share
-- the work and nobody misses something urgent.
--
--   1. Assignees: cases.assigned_to and follow_ups.assigned_to, optional,
--      always a member of the same workspace. A follow-up with no assignee
--      belongs to whoever its case is assigned to (the app applies that).
--   2. Who did what: case_events.actor_id (the member who did it) and
--      follow_ups.completed_by, stamped server-side and never settable by a
--      client. Backfilled from owner_id. Factual only: no counts per person.
--   3. Push: push_tokens (one row per device), notification_preferences
--      (per user), notification_outbox (queued sends). Triggers enqueue a
--      generic title and body per kind; the push-dispatch edge function
--      drains the outbox. No family or case detail ever enters a payload:
--      only ids, which the app resolves after sign-in.
--   4. Scheduling: a pg_cron tick every minute calls the function through
--      pg_net when both extensions exist, plus an hourly pass that queues
--      the overdue reminder at 9 AM in each member's own timezone.
--
-- Solo workspaces see no change: assignment stays empty, the app hides
-- the pickers, and no push is queued until a member turns it on.
--
-- Transit rule: this file is pasted into the SQL editor from a chat client.
-- No backslashes and no non-ASCII characters anywhere in it; character
-- sets are built with chr() or bracket expressions.

-- ===========================================================================
-- 1. Assignees
-- ===========================================================================

ALTER TABLE public.cases
  ADD COLUMN assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.follow_ups
  ADD COLUMN assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX cases_org_assignee_idx ON public.cases (org_id, assigned_to)
  WHERE assigned_to IS NOT NULL;
CREATE INDEX follow_ups_org_assignee_idx ON public.follow_ups (org_id, assigned_to)
  WHERE assigned_to IS NOT NULL;

-- An assignee must belong to the row's workspace. Runs after *_set_org
-- (trigger names fire alphabetically), so org_id is already derived.
CREATE OR REPLACE FUNCTION public.assignee_must_be_member()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.assigned_to IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.org_members m
     WHERE m.user_id = NEW.assigned_to AND m.org_id = NEW.org_id
  ) THEN
    RAISE EXCEPTION 'The assignee must be a member of this workspace' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.assignee_must_be_member() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER cases_team_assignee
  BEFORE INSERT OR UPDATE OF assigned_to ON public.cases
  FOR EACH ROW EXECUTE FUNCTION public.assignee_must_be_member();
CREATE TRIGGER follow_ups_team_assignee
  BEFORE INSERT OR UPDATE OF assigned_to ON public.follow_ups
  FOR EACH ROW EXECUTE FUNCTION public.assignee_must_be_member();

-- When a member moves to another practice or is removed, their assignments
-- in the workspace they left go back to Unassigned so nothing is owned by
-- someone who is no longer there.
CREATE OR REPLACE FUNCTION public.org_members_release_assignments()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.org_id = OLD.org_id THEN
    RETURN NULL;
  END IF;
  UPDATE public.cases SET assigned_to = NULL
   WHERE org_id = OLD.org_id AND assigned_to = OLD.user_id;
  UPDATE public.follow_ups SET assigned_to = NULL
   WHERE org_id = OLD.org_id AND assigned_to = OLD.user_id;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.org_members_release_assignments() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER org_members_release_assignments
  AFTER UPDATE OF org_id OR DELETE ON public.org_members
  FOR EACH ROW EXECUTE FUNCTION public.org_members_release_assignments();

-- Assign (or unassign) a case and write the timeline entry in one
-- transaction. Returns the entry body so the app's optimistic row matches.
-- "Take this lead" is this function with the caller's own id.
CREATE OR REPLACE FUNCTION public.assign_case(p_case_id uuid, p_assigned_to uuid, p_event_id uuid)
RETURNS TABLE (event_body text, occurred_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid := public.current_org_id();
  v_name text;
  v_body text;
  v_now timestamptz := now();
BEGIN
  IF v_user IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cases WHERE id = p_case_id AND org_id = v_org) THEN
    RAISE EXCEPTION 'Case not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_assigned_to IS NULL THEN
    v_body := 'Unassigned';
  ELSE
    SELECT nullif(btrim(display_name), '') INTO v_name
      FROM public.org_members WHERE user_id = p_assigned_to AND org_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The assignee must be a member of this workspace' USING ERRCODE = '22023';
    END IF;
    v_body := CASE WHEN p_assigned_to = v_user THEN 'Took this case'
                   ELSE 'Assigned to ' || coalesce(v_name, 'a teammate') END;
  END IF;
  UPDATE public.cases SET assigned_to = p_assigned_to
   WHERE id = p_case_id AND org_id = v_org AND assigned_to IS DISTINCT FROM p_assigned_to;
  INSERT INTO public.case_events (id, owner_id, org_id, case_id, kind, body, occurred_at)
  VALUES (coalesce(p_event_id, gen_random_uuid()), v_user, v_org, p_case_id, 'system', v_body, v_now)
  ON CONFLICT (id) DO NOTHING;
  RETURN QUERY SELECT v_body, v_now;
END
$$;
REVOKE ALL ON FUNCTION public.assign_case(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_case(uuid, uuid, uuid) TO authenticated;

-- ===========================================================================
-- 2. Who did what
-- ===========================================================================

ALTER TABLE public.case_events
  ADD COLUMN actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.follow_ups
  ADD COLUMN completed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Backfill: before this migration the row creator was the only person who
-- could have acted, so owner_id is the honest answer for old rows.
UPDATE public.case_events SET actor_id = owner_id
 WHERE actor_id IS NULL AND owner_id IS NOT NULL;
UPDATE public.follow_ups SET completed_by = owner_id
 WHERE status <> 'open' AND completed_by IS NULL AND owner_id IS NOT NULL;

-- The actor is always the signed-in member. A definer path with no signed-in
-- user (the intake link) may name an actor explicitly or leave it empty; a
-- client can neither choose nor later change it.
CREATE OR REPLACE FUNCTION public.case_events_stamp_actor()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF auth.uid() IS NOT NULL THEN
      NEW.actor_id := auth.uid();
    END IF;
    RETURN NEW;
  END IF;
  IF current_user IN ('authenticated', 'anon') AND NEW.actor_id IS DISTINCT FROM OLD.actor_id THEN
    RAISE EXCEPTION 'The actor of a timeline entry cannot be changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.case_events_stamp_actor() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER case_events_stamp_actor
  BEFORE INSERT OR UPDATE ON public.case_events
  FOR EACH ROW EXECUTE FUNCTION public.case_events_stamp_actor();

-- completed_by follows the status: stamped when a follow-up leaves open,
-- cleared when it is reopened, never chosen by the client.
CREATE OR REPLACE FUNCTION public.follow_ups_stamp_completion()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status = 'open' THEN
    NEW.completed_by := NULL;
  ELSIF TG_OP = 'INSERT' OR OLD.status = 'open' OR NEW.completed_by IS NULL THEN
    NEW.completed_by := coalesce(auth.uid(), NEW.completed_by, NEW.owner_id);
  ELSE
    NEW.completed_by := OLD.completed_by;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.follow_ups_stamp_completion() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER follow_ups_stamp_completion
  BEFORE INSERT OR UPDATE ON public.follow_ups
  FOR EACH ROW EXECUTE FUNCTION public.follow_ups_stamp_completion();

-- ===========================================================================
-- 3. Push: devices, preferences, outbox
-- ===========================================================================

-- One row per device token. A token belongs to exactly one signed-in
-- account; registering it again under another account moves it. Writes go
-- through the two RPCs below so a client never touches another user's row.
CREATE TABLE public.push_tokens (
  expo_push_token text PRIMARY KEY
    CHECK (expo_push_token ~ ('^Expo(nent)?PushToken[[][A-Za-z0-9_-]{8,64}[]]$')),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id     uuid REFERENCES public.orgs(id) ON DELETE CASCADE,
  platform   text NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_tokens_user_idx ON public.push_tokens (user_id);

ALTER TABLE public.push_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "push_tokens: own read" ON public.push_tokens
  FOR SELECT USING (user_id = auth.uid());
REVOKE ALL ON TABLE public.push_tokens FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.push_tokens TO authenticated;

-- Per-user choices. push_enabled flips only from the Workspace screen after
-- the OS permission is granted; the kinds default on except the platform
-- admin one. tz_offset_minutes is what the device reports (minutes east of
-- UTC) and drives the 9 AM overdue reminder; until a device reports, the
-- default is Pacific daylight time.
CREATE TABLE public.notification_preferences (
  user_id              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  push_enabled         boolean NOT NULL DEFAULT false,
  new_lead             boolean NOT NULL DEFAULT true,
  assigned_to_me       boolean NOT NULL DEFAULT true,
  overdue_mine         boolean NOT NULL DEFAULT true,
  directory_decision   boolean NOT NULL DEFAULT true,
  directory_submission boolean NOT NULL DEFAULT false,
  tz_offset_minutes    integer NOT NULL DEFAULT -420 CHECK (tz_offset_minutes BETWEEN -840 AND 840),
  overdue_notified_on  date,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER notification_preferences_updated_at BEFORE UPDATE ON public.notification_preferences
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notification_preferences: own all" ON public.notification_preferences
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
REVOKE ALL ON TABLE public.notification_preferences FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.notification_preferences TO authenticated;

-- Queued sends. No client role can read or write this table; triggers
-- enqueue through notify_enqueue and the dispatcher drains it through the
-- service-role RPCs in section 4.
CREATE TABLE public.notification_outbox (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('new_lead', 'assigned_to_me', 'overdue_mine', 'directory_decision', 'directory_submission')),
  title              text NOT NULL,
  body               text NOT NULL,
  data               jsonb NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  claimed_at         timestamptz,
  attempts           integer NOT NULL DEFAULT 0,
  sent_at            timestamptz,
  tickets            jsonb NOT NULL DEFAULT '[]',
  receipt_checked_at timestamptz,
  error              text
);
CREATE INDEX notification_outbox_pending_idx ON public.notification_outbox (created_at)
  WHERE sent_at IS NULL AND error IS NULL;
CREATE INDEX notification_outbox_receipts_idx ON public.notification_outbox (sent_at)
  WHERE sent_at IS NOT NULL AND receipt_checked_at IS NULL;

ALTER TABLE public.notification_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.notification_outbox FROM PUBLIC, anon, authenticated, service_role;

-- Register this device for the signed-in account (moving the token if it
-- was registered under another account on the same phone).
CREATE OR REPLACE FUNCTION public.register_push_token(p_token text, p_platform text, p_tz_offset_minutes integer DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid := public.current_org_id();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  DELETE FROM public.push_tokens WHERE expo_push_token = p_token AND user_id <> v_user;
  INSERT INTO public.push_tokens (expo_push_token, user_id, org_id, platform)
  VALUES (p_token, v_user, v_org, p_platform)
  ON CONFLICT (expo_push_token) DO UPDATE
    SET user_id = EXCLUDED.user_id, org_id = EXCLUDED.org_id,
        platform = EXCLUDED.platform, updated_at = now();
  IF p_tz_offset_minutes IS NOT NULL THEN
    UPDATE public.notification_preferences
       SET tz_offset_minutes = greatest(-840, least(840, p_tz_offset_minutes))
     WHERE user_id = v_user AND tz_offset_minutes <> greatest(-840, least(840, p_tz_offset_minutes));
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.register_push_token(text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_push_token(text, text, integer) TO authenticated;

-- Sign-out on this device: the token stops receiving anything for anyone.
CREATE OR REPLACE FUNCTION public.unregister_push_token(p_token text)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.push_tokens WHERE expo_push_token = p_token AND user_id = auth.uid();
$$;
REVOKE ALL ON FUNCTION public.unregister_push_token(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unregister_push_token(text) TO authenticated;

-- The generic wording per kind. Nothing about a family, a caller, a case
-- title, or a listing name ever goes into a push payload: the app opens the
-- item from the ids in data after the member signs in.
CREATE OR REPLACE FUNCTION public.notification_copy(p_kind text, p_data jsonb)
RETURNS TABLE (title text, body text)
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE p_kind
           WHEN 'new_lead' THEN 'New lead waiting'
           WHEN 'assigned_to_me' THEN 'Assigned to you'
           WHEN 'overdue_mine' THEN 'Follow-ups past due'
           WHEN 'directory_decision' THEN 'Directory decision'
           WHEN 'directory_submission' THEN 'New directory submission'
           ELSE 'ReferralFit' END,
         CASE p_kind
           WHEN 'new_lead' THEN 'A new lead is waiting for its first call.'
           WHEN 'assigned_to_me' THEN CASE WHEN coalesce(p_data ->> 'follow_up_id', '') <> ''
                                           THEN 'A follow-up was assigned to you.'
                                           ELSE 'A case was assigned to you.' END
           WHEN 'overdue_mine' THEN 'Some of your follow-ups are past due. Open ReferralFit to catch up.'
           WHEN 'directory_decision' THEN 'There is a directory decision on one of your submissions.'
           WHEN 'directory_submission' THEN 'A practice submitted a listing for review.'
           ELSE 'Open ReferralFit.' END;
$$;
REVOKE ALL ON FUNCTION public.notification_copy(text, jsonb) FROM PUBLIC, anon, authenticated;

-- Queue one push for one member, if they turned push on, want this kind,
-- and have a registered device. The platform-admin kind never reaches a
-- non-admin whatever their row says. A duplicate still waiting to be sent
-- (same member, kind, and data) is not queued twice.
CREATE OR REPLACE FUNCTION public.notify_enqueue(p_user_id uuid, p_kind text, p_data jsonb)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pref public.notification_preferences%ROWTYPE;
  v_wanted boolean;
  v_data jsonb := coalesce(p_data, '{}') || jsonb_build_object('kind', p_kind, 'user_id', p_user_id);
  v_copy record;
BEGIN
  IF p_user_id IS NULL THEN RETURN false; END IF;
  SELECT * INTO v_pref FROM public.notification_preferences WHERE user_id = p_user_id;
  IF NOT FOUND OR NOT v_pref.push_enabled THEN RETURN false; END IF;
  v_wanted := CASE p_kind
    WHEN 'new_lead' THEN v_pref.new_lead
    WHEN 'assigned_to_me' THEN v_pref.assigned_to_me
    WHEN 'overdue_mine' THEN v_pref.overdue_mine
    WHEN 'directory_decision' THEN v_pref.directory_decision
    WHEN 'directory_submission' THEN v_pref.directory_submission
      AND EXISTS (SELECT 1 FROM public.platform_admins a WHERE a.user_id = p_user_id)
    ELSE false END;
  IF NOT coalesce(v_wanted, false) THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.push_tokens t WHERE t.user_id = p_user_id) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.notification_outbox o
              WHERE o.user_id = p_user_id AND o.kind = p_kind AND o.data = v_data AND o.sent_at IS NULL AND o.error IS NULL) THEN
    RETURN false;
  END IF;
  SELECT * INTO v_copy FROM public.notification_copy(p_kind, v_data);
  INSERT INTO public.notification_outbox (user_id, kind, title, body, data)
  VALUES (p_user_id, p_kind, v_copy.title, v_copy.body, v_data);
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.notify_enqueue(uuid, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- Every member of a workspace except one (usually the person who acted).
CREATE OR REPLACE FUNCTION public.notify_org_members(p_org_id uuid, p_kind text, p_data jsonb, p_except uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member record;
  v_count integer := 0;
BEGIN
  FOR v_member IN SELECT user_id FROM public.org_members WHERE org_id = p_org_id LOOP
    IF p_except IS NULL OR v_member.user_id <> p_except THEN
      IF public.notify_enqueue(v_member.user_id, p_kind, p_data) THEN
        v_count := v_count + 1;
      END IF;
    END IF;
  END LOOP;
  RETURN v_count;
END
$$;
REVOKE ALL ON FUNCTION public.notify_org_members(uuid, text, jsonb, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- A new lead (quick-add or intake link): everyone in the practice who wants
-- to know, or only the assignee when the lead arrived already assigned.
CREATE OR REPLACE FUNCTION public.cases_notify_new_lead()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.assigned_to IS NOT NULL THEN
    PERFORM public.notify_enqueue(NEW.assigned_to, 'new_lead', jsonb_build_object('case_id', NEW.id));
  ELSE
    PERFORM public.notify_org_members(NEW.org_id, 'new_lead', jsonb_build_object('case_id', NEW.id), auth.uid());
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.cases_notify_new_lead() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER cases_notify_new_lead
  AFTER INSERT ON public.cases
  FOR EACH ROW WHEN (NEW.lead_captured_at IS NOT NULL)
  EXECUTE FUNCTION public.cases_notify_new_lead();

-- A case or follow-up assigned to someone other than the person doing the
-- assigning. A lead that arrives already assigned is covered above.
CREATE OR REPLACE FUNCTION public.rows_notify_assigned()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_data jsonb;
BEGIN
  IF NEW.assigned_to IS NULL OR NEW.assigned_to IS NOT DISTINCT FROM auth.uid() THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND OLD.assigned_to IS NOT DISTINCT FROM NEW.assigned_to THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME = 'cases' THEN
    IF TG_OP = 'INSERT' AND NEW.lead_captured_at IS NOT NULL THEN RETURN NULL; END IF;
    v_data := jsonb_build_object('case_id', NEW.id);
  ELSE
    v_data := jsonb_build_object('follow_up_id', NEW.id, 'case_id', NEW.case_id);
  END IF;
  PERFORM public.notify_enqueue(NEW.assigned_to, 'assigned_to_me', v_data);
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.rows_notify_assigned() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER cases_notify_assigned
  AFTER INSERT OR UPDATE OF assigned_to ON public.cases
  FOR EACH ROW EXECUTE FUNCTION public.rows_notify_assigned();
CREATE TRIGGER follow_ups_notify_assigned
  AFTER INSERT OR UPDATE OF assigned_to ON public.follow_ups
  FOR EACH ROW EXECUTE FUNCTION public.rows_notify_assigned();

-- Directory: a new submission goes to platform admins; a decision goes to
-- the submitting practice. Seed auto-publishes (status active on insert)
-- and listings with no submitting workspace queue nothing.
CREATE OR REPLACE FUNCTION public.global_partners_notify()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin record;
BEGIN
  IF NEW.suggested_by_org_id IS NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'pending' THEN
      FOR v_admin IN SELECT user_id FROM public.platform_admins LOOP
        IF v_admin.user_id IS DISTINCT FROM auth.uid() THEN
          PERFORM public.notify_enqueue(v_admin.user_id, 'directory_submission', jsonb_build_object('global_partner_id', NEW.id));
        END IF;
      END LOOP;
    END IF;
  ELSIF OLD.status = 'pending' AND NEW.status IN ('active', 'archived') THEN
    PERFORM public.notify_org_members(NEW.suggested_by_org_id, 'directory_decision',
      jsonb_build_object('global_partner_id', NEW.id, 'decision', CASE WHEN NEW.status = 'active' THEN 'approved' ELSE 'declined' END),
      auth.uid());
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.global_partners_notify() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER global_partners_notify
  AFTER INSERT OR UPDATE OF status ON public.global_partners
  FOR EACH ROW EXECUTE FUNCTION public.global_partners_notify();

-- Once a day at 9 AM local (per the device-reported offset): one reminder
-- to each member who has an open follow-up of their own past its day. A
-- follow-up with no assignee counts as the case assignee's. Called hourly
-- by the cron job in section 4; safe to call more often.
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
  FOR v_pref IN SELECT user_id, tz_offset_minutes, overdue_notified_on
                  FROM public.notification_preferences
                 WHERE push_enabled AND overdue_mine LOOP
    v_local := (now() AT TIME ZONE 'UTC') + make_interval(mins => v_pref.tz_offset_minutes);
    IF extract(hour FROM v_local) <> 9 THEN CONTINUE; END IF;
    IF v_pref.overdue_notified_on IS NOT DISTINCT FROM v_local::date THEN CONTINUE; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.follow_ups f
        LEFT JOIN public.cases c ON c.id = f.case_id
       WHERE f.status = 'open'
         AND coalesce(f.snoozed_until, f.due_on) < v_local::date
         AND coalesce(f.assigned_to, c.assigned_to) = v_pref.user_id
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
-- 4. Dispatch: service-role RPCs for the edge function, and the cron tick
-- ===========================================================================

-- Claim a batch to send: one row per queued notification with the member's
-- device tokens. Rows claimed in the last five minutes are left alone (a
-- run in progress); five attempts without a send marks the row failed.
CREATE OR REPLACE FUNCTION public.push_outbox_claim(p_limit integer DEFAULT 100)
RETURNS TABLE (id uuid, user_id uuid, kind text, title text, body text, data jsonb, tokens jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.notification_outbox o SET error = 'too_many_attempts'
   WHERE o.sent_at IS NULL AND o.error IS NULL AND o.attempts >= 5;
  UPDATE public.notification_outbox o SET error = 'no_device'
   WHERE o.sent_at IS NULL AND o.error IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.push_tokens t WHERE t.user_id = o.user_id);
  RETURN QUERY
  WITH picked AS (
    SELECT o.id FROM public.notification_outbox o
     WHERE o.sent_at IS NULL AND o.error IS NULL
       AND (o.claimed_at IS NULL OR o.claimed_at < now() - interval '5 minutes')
     ORDER BY o.created_at
     LIMIT greatest(1, least(coalesce(p_limit, 100), 500))
     FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.notification_outbox o
       SET claimed_at = now(), attempts = o.attempts + 1
      FROM picked WHERE o.id = picked.id
    RETURNING o.id, o.user_id, o.kind, o.title, o.body, o.data
  )
  SELECT c.id, c.user_id, c.kind, c.title, c.body, c.data,
         coalesce((SELECT jsonb_agg(jsonb_build_object('token', t.expo_push_token, 'platform', t.platform))
                     FROM public.push_tokens t WHERE t.user_id = c.user_id), '[]')
    FROM claimed c;
END
$$;
REVOKE ALL ON FUNCTION public.push_outbox_claim(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.push_outbox_claim(integer) TO service_role;

-- Record what Expo answered for a batch. p_results: array of
-- {id, tickets: [{token, id}], error}. Tokens Expo reports as no longer
-- registered are removed so they are never tried again.
CREATE OR REPLACE FUNCTION public.push_outbox_record(p_results jsonb, p_dead_tokens text[] DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item jsonb;
  v_count integer := 0;
BEGIN
  FOR v_item IN SELECT value FROM jsonb_array_elements(coalesce(p_results, '[]')) LOOP
    UPDATE public.notification_outbox o
       SET sent_at = CASE WHEN jsonb_array_length(coalesce(v_item -> 'tickets', '[]')) > 0 THEN now() ELSE o.sent_at END,
           tickets = coalesce(v_item -> 'tickets', '[]'),
           error = CASE WHEN jsonb_array_length(coalesce(v_item -> 'tickets', '[]')) > 0 THEN NULL
                        ELSE nullif(left(coalesce(v_item ->> 'error', ''), 200), '') END
     WHERE o.id = (v_item ->> 'id')::uuid;
    v_count := v_count + 1;
  END LOOP;
  IF p_dead_tokens IS NOT NULL THEN
    DELETE FROM public.push_tokens WHERE expo_push_token = ANY (p_dead_tokens);
  END IF;
  RETURN v_count;
END
$$;
REVOKE ALL ON FUNCTION public.push_outbox_record(jsonb, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.push_outbox_record(jsonb, text[]) TO service_role;

-- Sent rows whose Expo receipts have not been read yet (receipts are ready
-- about fifteen minutes after the send).
CREATE OR REPLACE FUNCTION public.push_receipts_pending(p_limit integer DEFAULT 300)
RETURNS TABLE (id uuid, tickets jsonb)
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.id, o.tickets FROM public.notification_outbox o
   WHERE o.sent_at IS NOT NULL AND o.sent_at < now() - interval '15 minutes'
     AND o.receipt_checked_at IS NULL AND jsonb_array_length(o.tickets) > 0
   ORDER BY o.sent_at
   LIMIT greatest(1, least(coalesce(p_limit, 300), 1000));
$$;
REVOKE ALL ON FUNCTION public.push_receipts_pending(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.push_receipts_pending(integer) TO service_role;

-- p_results: array of {id, error}; error is empty when every receipt was ok.
CREATE OR REPLACE FUNCTION public.push_receipts_record(p_results jsonb, p_dead_tokens text[] DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item jsonb;
  v_count integer := 0;
BEGIN
  FOR v_item IN SELECT value FROM jsonb_array_elements(coalesce(p_results, '[]')) LOOP
    UPDATE public.notification_outbox o
       SET receipt_checked_at = now(),
           error = nullif(left(coalesce(v_item ->> 'error', ''), 200), '')
     WHERE o.id = (v_item ->> 'id')::uuid;
    v_count := v_count + 1;
  END LOOP;
  IF p_dead_tokens IS NOT NULL THEN
    DELETE FROM public.push_tokens WHERE expo_push_token = ANY (p_dead_tokens);
  END IF;
  RETURN v_count;
END
$$;
REVOKE ALL ON FUNCTION public.push_receipts_record(jsonb, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.push_receipts_record(jsonb, text[]) TO service_role;

-- Housekeeping: delivered or failed rows older than thirty days go away.
CREATE OR REPLACE FUNCTION public.push_outbox_prune()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM public.notification_outbox
   WHERE created_at < now() - interval '30 days' AND (sent_at IS NOT NULL OR error IS NOT NULL);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;
REVOKE ALL ON FUNCTION public.push_outbox_prune() FROM PUBLIC, anon, authenticated, service_role;

-- The minute tick. Posts to the push-dispatch function through pg_net when
-- the extension exists and both database settings are set:
--   ALTER DATABASE postgres SET app.push_dispatch_url = 'https://<ref>.supabase.co/functions/v1/push-dispatch';
--   ALTER DATABASE postgres SET app.push_dispatch_secret = '<the PUSH_DISPATCH_SECRET function secret>';
-- Without them it does nothing, so the migration is safe to apply first.
CREATE OR REPLACE FUNCTION public.push_dispatch_tick()
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url text := coalesce(current_setting('app.push_dispatch_url', true), '');
  v_secret text := coalesce(current_setting('app.push_dispatch_secret', true), '');
BEGIN
  IF v_url = '' OR v_secret = '' THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.notification_outbox o WHERE o.sent_at IS NULL AND o.error IS NULL)
     AND NOT EXISTS (SELECT 1 FROM public.notification_outbox o
                      WHERE o.sent_at IS NOT NULL AND o.sent_at < now() - interval '15 minutes' AND o.receipt_checked_at IS NULL) THEN
    RETURN false;
  END IF;
  EXECUTE 'SELECT net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 25000)'
    USING v_url, '{}'::jsonb,
          jsonb_build_object('content-type', 'application/json', 'x-push-dispatch-secret', v_secret);
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.push_dispatch_tick() FROM PUBLIC, anon, authenticated, service_role;

-- Schedule where pg_cron exists (production); harmless locally.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'referralfit-push-dispatch-minute') THEN
      PERFORM cron.unschedule('referralfit-push-dispatch-minute');
    END IF;
    PERFORM cron.schedule('referralfit-push-dispatch-minute', '* * * * *', 'SELECT public.push_dispatch_tick()');
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'referralfit-push-overdue-hourly') THEN
      PERFORM cron.unschedule('referralfit-push-overdue-hourly');
    END IF;
    PERFORM cron.schedule('referralfit-push-overdue-hourly', '5 * * * *', 'SELECT public.notify_overdue_follow_ups()');
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'referralfit-push-outbox-prune-daily') THEN
      PERFORM cron.unschedule('referralfit-push-outbox-prune-daily');
    END IF;
    PERFORM cron.schedule('referralfit-push-outbox-prune-daily', '40 3 * * *', 'SELECT public.push_outbox_prune()');
  END IF;
END
$do$;

COMMIT;
