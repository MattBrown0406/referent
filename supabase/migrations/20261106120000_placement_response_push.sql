-- Push when a program answers a placement request, and a scheduler that
-- reads its address and secret from Vault.
--
--   1. notification_preferences.placement_response (on by default: the
--      practitioner asked and is waiting) and the outbox kind.
--   2. notification_copy / notify_enqueue: the new kind. The push says only
--      "A program answered"; the data is the request id. No program name, no
--      client detail (docs/NOTIFICATIONS.md).
--   3. A trigger on placement_request_recipients: an answer entered in the
--      center portal (not one the practitioner logged) queues a push for
--      the practitioner who sent the request, while still in that
--      workspace and while the request is open. notify_enqueue folds
--      several answers that arrive before the next send into one push per
--      request; a program editing its answer pushes at most once every 15
--      minutes per request. Closing, cancelling or deleting the request
--      drops a push not yet sent.
--   4. push_dispatch_tick reads referralfit_push_dispatch_url and
--      referralfit_push_dispatch_secret from Vault (Supabase does not let
--      the postgres role ALTER DATABASE SET app.* any more); the old
--      settings still work where they exist.
--   5. The three cron jobs from 20261001140000, scheduled again where
--      pg_cron is on now (it was off when that migration ran).
--
-- Transit-safe: ASCII only, no backslashes, every statement under 3,700
-- characters.

BEGIN;

-- ===========================================================================
-- 1. The preference and the kind
-- ===========================================================================

ALTER TABLE public.notification_preferences ADD COLUMN IF NOT EXISTS placement_response boolean NOT NULL DEFAULT true;

ALTER TABLE public.notification_outbox DROP CONSTRAINT IF EXISTS notification_outbox_kind_check;
ALTER TABLE public.notification_outbox ADD CONSTRAINT notification_outbox_kind_check
  CHECK (kind IN ('new_lead', 'assigned_to_me', 'overdue_mine', 'directory_decision', 'directory_submission', 'bed_opened',
                  'placement_response'));

-- The answer throttle and the close/delete drop look these rows up by request.
CREATE INDEX IF NOT EXISTS notification_outbox_placement_response_idx
  ON public.notification_outbox ((data ->> 'placement_request_id'), created_at)
  WHERE kind = 'placement_response';

-- ===========================================================================
-- 2. Copy and enqueue
-- ===========================================================================

-- Same as 20261001150000 plus placement_response.
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
           WHEN 'bed_opened' THEN 'A bed opened'
           WHEN 'placement_response' THEN 'A program answered'
           ELSE 'ReferralFit' END,
         CASE p_kind
           WHEN 'new_lead' THEN 'A new lead is waiting for its first call.'
           WHEN 'assigned_to_me' THEN CASE WHEN coalesce(p_data ->> 'follow_up_id', '') <> ''
                                           THEN 'A follow-up was assigned to you.'
                                           ELSE 'A case was assigned to you.' END
           WHEN 'overdue_mine' THEN 'Some of your follow-ups are past due. Open ReferralFit to catch up.'
           WHEN 'directory_decision' THEN 'There is a directory decision on one of your submissions.'
           WHEN 'directory_submission' THEN 'A practice submitted a listing for review.'
           WHEN 'bed_opened' THEN 'A program you follow has a bed open today.'
           WHEN 'placement_response' THEN 'A program answered your placement request. Open ReferralFit to compare.'
           ELSE 'Open ReferralFit.' END;
$$;
REVOKE ALL ON FUNCTION public.notification_copy(text, jsonb) FROM PUBLIC, anon, authenticated;

-- Same as 20261001150000 plus the placement_response branch.
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
    WHEN 'bed_opened' THEN v_pref.bed_opened
    WHEN 'placement_response' THEN v_pref.placement_response
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

-- ===========================================================================
-- 3. A program's answer
-- ===========================================================================

-- Fires on the program's first answer in the portal and on any change to
-- it (bed, likely to accept, admit date, rate, notes); saving the same
-- answer again sends nothing. An answer the practitioner logged themselves
-- (entered_by_practice) sends nothing; the program answering over one does.
CREATE OR REPLACE FUNCTION public.placement_answer_notify()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  q record;
BEGIN
  IF NEW.entered_by_practice OR NEW.responded_at IS NULL OR NEW.status NOT IN ('responded', 'declined') THEN
    RETURN NULL;
  END IF;
  IF OLD.status IN ('responded', 'declined') AND NOT OLD.entered_by_practice
     AND (NEW.bed_available, NEW.likely_accept, NEW.earliest_admit_on, NEW.daily_rate, NEW.cost_note, NEW.note)
         IS NOT DISTINCT FROM (OLD.bed_available, OLD.likely_accept, OLD.earliest_admit_on, OLD.daily_rate, OLD.cost_note, OLD.note) THEN
    RETURN NULL;
  END IF;
  SELECT r.id, r.org_id, r.created_by, r.status INTO q FROM public.placement_requests r WHERE r.id = NEW.request_id;
  IF NOT FOUND OR q.created_by IS NULL OR q.status <> 'open' THEN RETURN NULL; END IF;
  -- Their own answer (a center account of the practitioner's) needs no push.
  IF NEW.responded_by IS NOT DISTINCT FROM q.created_by THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.org_members m WHERE m.org_id = q.org_id AND m.user_id = q.created_by) THEN
    RETURN NULL;
  END IF;
  -- A program editing an answer it already gave: one push per request every
  -- 15 minutes (from the last one sent, or queued), however often it saves.
  -- A first answer always counts.
  IF OLD.status IN ('responded', 'declined') AND NOT OLD.entered_by_practice
     AND EXISTS (SELECT 1 FROM public.notification_outbox o
                  WHERE o.kind = 'placement_response' AND o.data ->> 'placement_request_id' = q.id::text
                    AND o.user_id = q.created_by
                    AND coalesce(o.sent_at, o.created_at) > now() - interval '15 minutes') THEN
    RETURN NULL;
  END IF;
  PERFORM public.notify_enqueue(q.created_by, 'placement_response', jsonb_build_object('placement_request_id', q.id));
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.placement_answer_notify() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS placement_request_recipients_answer_notify ON public.placement_request_recipients;
CREATE TRIGGER placement_request_recipients_answer_notify
  AFTER UPDATE ON public.placement_request_recipients
  FOR EACH ROW EXECUTE FUNCTION public.placement_answer_notify();

-- A request closed, cancelled or deleted: a push about it not yet sent is
-- dropped, so nobody is sent to compare answers they no longer need. One the
-- sender claimed is left to it unless its 5-minute claim has lapsed (a send
-- being retried; push_outbox_claim would pick it up again).
CREATE OR REPLACE FUNCTION public.placement_request_drop_pushes()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.notification_outbox o
   WHERE o.kind = 'placement_response' AND o.data ->> 'placement_request_id' = OLD.id::text
     AND o.sent_at IS NULL AND (o.claimed_at IS NULL OR o.claimed_at < now() - interval '5 minutes');
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.placement_request_drop_pushes() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS placement_requests_closed_drop_pushes ON public.placement_requests;
CREATE TRIGGER placement_requests_closed_drop_pushes
  AFTER UPDATE OF status ON public.placement_requests
  FOR EACH ROW WHEN (OLD.status = 'open' AND NEW.status IS DISTINCT FROM 'open')
  EXECUTE FUNCTION public.placement_request_drop_pushes();

DROP TRIGGER IF EXISTS placement_requests_deleted_drop_pushes ON public.placement_requests;
CREATE TRIGGER placement_requests_deleted_drop_pushes
  AFTER DELETE ON public.placement_requests
  FOR EACH ROW EXECUTE FUNCTION public.placement_request_drop_pushes();

-- ===========================================================================
-- 4. The scheduler's address and secret
-- ===========================================================================

-- One Vault secret by name, or '' (no Vault here, or no such secret).
CREATE OR REPLACE FUNCTION public.push_dispatch_setting(p_name text)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_value text;
BEGIN
  IF to_regclass('vault.decrypted_secrets') IS NULL THEN RETURN ''; END IF;
  EXECUTE 'SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = $1 ORDER BY created_at DESC LIMIT 1'
    INTO v_value USING p_name;
  RETURN coalesce(v_value, '');
END
$$;
REVOKE ALL ON FUNCTION public.push_dispatch_setting(text) FROM PUBLIC, anon, authenticated, service_role;

-- Same as 20261001140000, reading Vault first.
CREATE OR REPLACE FUNCTION public.push_dispatch_tick()
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url text := coalesce(nullif(public.push_dispatch_setting('referralfit_push_dispatch_url'), ''),
                         current_setting('app.push_dispatch_url', true), '');
  v_secret text := coalesce(nullif(public.push_dispatch_setting('referralfit_push_dispatch_secret'), ''),
                            current_setting('app.push_dispatch_secret', true), '');
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

-- ===========================================================================
-- 5. Schedule (where pg_cron is on; harmless elsewhere)
-- ===========================================================================

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
