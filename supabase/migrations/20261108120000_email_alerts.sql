-- Email alerts: a program answered (practitioners), the morning summary
-- (practitioners, opt-in), and the weekly bed check-in (claimed programs).
--
--   1. email_preferences: one row per user, made on first use. Missing row
--      = the defaults (answers on, morning summary off, bed check-in on).
--      unsubscribe_token lets a signed-out page and the mail client's
--      one-click unsubscribe change these without a sign-in.
--   2. email_outbox: one row per email to send, drained by the email-dispatch
--      Edge Function (Resend). Like push, an email never carries a client,
--      family or program name the practitioner chose; the bed check-in names
--      only the program's own listing, to the program.
--   3. placement_answer_notify (from 20261106120000): the push part is
--      unchanged; it also queues an email, folded per request and held two
--      minutes so answers arriving together make one email.
--   4. notify_daily_summaries (hourly): at 7 AM in the member's time zone,
--      counts only (new leads, due today, past due, answers to compare).
--   5. notify_bed_reminders (daily): a claimed program whose beds were not
--      confirmed in the last six days gets one email a week with a private
--      link (portal /b#<token>) to confirm or update them. Saving goes
--      through apply_listing_beds, the body of set_listing_beds, which now
--      calls it after its own checks (same behavior).
--   6. Signed-out RPCs for the portal's /b and /u pages, the app's settings
--      RPCs, the dispatcher's service-role RPCs, and the cron jobs.
--
-- Transit-safe: ASCII only, no backslashes, every statement under 3,700
-- characters.

BEGIN;

-- ===========================================================================
-- 1. Preferences
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.email_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  placement_response boolean NOT NULL DEFAULT true,
  daily_summary boolean NOT NULL DEFAULT false,
  bed_reminder boolean NOT NULL DEFAULT true,
  tz_offset_minutes integer NOT NULL DEFAULT -420 CHECK (tz_offset_minutes BETWEEN -840 AND 840),
  daily_summary_sent_on date,
  unsubscribe_token text NOT NULL UNIQUE DEFAULT encode(extensions.gen_random_bytes(32), 'hex'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.email_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_preferences FROM PUBLIC, anon, authenticated, service_role;

-- The row for a user, made with the defaults when missing.
CREATE OR REPLACE FUNCTION public.email_preferences_row(p_user_id uuid)
RETURNS public.email_preferences
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.email_preferences%ROWTYPE;
BEGIN
  INSERT INTO public.email_preferences (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_row FROM public.email_preferences WHERE user_id = p_user_id;
  RETURN v_row;
END
$$;
REVOKE ALL ON FUNCTION public.email_preferences_row(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Whether a user wants a kind, without making a row (defaults when missing).
CREATE OR REPLACE FUNCTION public.email_wanted(p_user_id uuid, p_kind text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE p_kind
           WHEN 'placement_response' THEN coalesce((SELECT placement_response FROM public.email_preferences WHERE user_id = p_user_id), true)
           WHEN 'daily_summary' THEN coalesce((SELECT daily_summary FROM public.email_preferences WHERE user_id = p_user_id), false)
           WHEN 'bed_reminder' THEN coalesce((SELECT bed_reminder FROM public.email_preferences WHERE user_id = p_user_id), true)
           ELSE false END
$$;
REVOKE ALL ON FUNCTION public.email_wanted(uuid, text) FROM PUBLIC, anon, authenticated, service_role;

-- ===========================================================================
-- 2. Outbox
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('placement_response', 'daily_summary', 'bed_reminder')),
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  not_before timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  sent_at timestamptz,
  provider_id text,
  error text,
  last_error text
);
CREATE INDEX IF NOT EXISTS email_outbox_waiting_idx ON public.email_outbox (not_before) WHERE sent_at IS NULL AND error IS NULL;
CREATE INDEX IF NOT EXISTS email_outbox_user_kind_idx ON public.email_outbox (user_id, kind, created_at);
ALTER TABLE public.email_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_outbox FROM PUBLIC, anon, authenticated, service_role;

-- Queue one email when the user wants the kind and the same email is not
-- already waiting (same user, kind and data).
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
                AND o.sent_at IS NULL AND o.error IS NULL) THEN
    RETURN false;
  END IF;
  INSERT INTO public.email_outbox (user_id, kind, data, not_before)
  VALUES (p_user_id, p_kind, v_data, greatest(coalesce(p_not_before, now()), now()));
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.email_enqueue(uuid, text, jsonb, timestamptz) FROM PUBLIC, anon, authenticated, service_role;

-- ===========================================================================
-- 3. A program's answer: push (unchanged) and email
-- ===========================================================================

-- Same as 20261106120000 for push. The email has its own 15-minute edit
-- throttle, so a push throttled away never holds back the email or the
-- other way round.
CREATE OR REPLACE FUNCTION public.placement_answer_notify()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  q record;
  v_edit boolean;
  v_data jsonb;
BEGIN
  IF NEW.entered_by_practice OR NEW.responded_at IS NULL OR NEW.status NOT IN ('responded', 'declined') THEN
    RETURN NULL;
  END IF;
  v_edit := OLD.status IN ('responded', 'declined') AND NOT OLD.entered_by_practice;
  IF v_edit
     AND (NEW.bed_available, NEW.likely_accept, NEW.earliest_admit_on, NEW.daily_rate, NEW.cost_note, NEW.note)
         IS NOT DISTINCT FROM (OLD.bed_available, OLD.likely_accept, OLD.earliest_admit_on, OLD.daily_rate, OLD.cost_note, OLD.note) THEN
    RETURN NULL;
  END IF;
  SELECT r.id, r.org_id, r.created_by, r.status INTO q FROM public.placement_requests r WHERE r.id = NEW.request_id;
  IF NOT FOUND OR q.created_by IS NULL OR q.status <> 'open' THEN RETURN NULL; END IF;
  IF NEW.responded_by IS NOT DISTINCT FROM q.created_by THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.org_members m WHERE m.org_id = q.org_id AND m.user_id = q.created_by) THEN
    RETURN NULL;
  END IF;
  v_data := jsonb_build_object('placement_request_id', q.id);
  IF NOT (v_edit AND EXISTS (SELECT 1 FROM public.notification_outbox o
                              WHERE o.kind = 'placement_response' AND o.data ->> 'placement_request_id' = q.id::text
                                AND o.user_id = q.created_by
                                AND coalesce(o.sent_at, o.created_at) > now() - interval '15 minutes')) THEN
    PERFORM public.notify_enqueue(q.created_by, 'placement_response', v_data);
  END IF;
  IF NOT (v_edit AND EXISTS (SELECT 1 FROM public.email_outbox o
                              WHERE o.kind = 'placement_response' AND o.data ->> 'placement_request_id' = q.id::text
                                AND o.user_id = q.created_by
                                AND coalesce(o.sent_at, o.created_at) > now() - interval '15 minutes')) THEN
    PERFORM public.email_enqueue(q.created_by, 'placement_response', v_data, now() + interval '2 minutes');
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.placement_answer_notify() FROM PUBLIC, anon, authenticated, service_role;

-- ===========================================================================
-- 4. The morning summary
-- ===========================================================================

-- Counts for one member on their local day. Mine = the follow-up's
-- assignee, else its case's, else whoever made it; leads are the
-- workspace's unanswered ones that are mine or nobody's.
CREATE OR REPLACE FUNCTION public.email_daily_summary_counts(p_user_id uuid, p_day date)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (SELECT m.org_id FROM public.org_members m WHERE m.user_id = p_user_id),
  mine AS (
    SELECT coalesce(f.snoozed_until, f.due_on) AS day
      FROM public.follow_ups f
      JOIN me ON me.org_id = f.org_id
      LEFT JOIN public.cases c ON c.id = f.case_id
     WHERE f.status = 'open'
       AND coalesce(f.assigned_to, c.assigned_to, f.owner_id) = p_user_id
       AND (c.id IS NULL OR c.status NOT IN ('closed', 'lost'))
  )
  SELECT jsonb_build_object(
    'new_leads', (SELECT count(*) FROM public.cases c JOIN me ON me.org_id = c.org_id
                   WHERE c.lead_captured_at IS NOT NULL AND c.first_touch_at IS NULL
                     AND c.status NOT IN ('closed', 'lost')
                     AND (c.assigned_to IS NULL OR c.assigned_to = p_user_id)),
    'due_today', (SELECT count(*) FROM mine WHERE day = p_day),
    'overdue', (SELECT count(*) FROM mine WHERE day < p_day),
    'answers', (SELECT count(*) FROM public.placement_request_recipients x
                  JOIN public.placement_requests r ON r.id = x.request_id
                 WHERE r.created_by = p_user_id AND r.status = 'open'
                   AND x.status IN ('responded', 'declined') AND NOT x.entered_by_practice
                   AND x.responded_at > now() - interval '24 hours'))
$$;
REVOKE ALL ON FUNCTION public.email_daily_summary_counts(uuid, date) FROM PUBLIC, anon, authenticated, service_role;

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
  FOR v_pref IN SELECT p.user_id, p.tz_offset_minutes, p.daily_summary_sent_on
                  FROM public.email_preferences p
                 WHERE p.daily_summary
                   AND EXISTS (SELECT 1 FROM public.org_members m WHERE m.user_id = p.user_id) LOOP
    v_local := (now() AT TIME ZONE 'UTC') + make_interval(mins => v_pref.tz_offset_minutes);
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
-- 5. The weekly bed check-in
-- ===========================================================================

-- A program listing's display name: the organization, else the name.
CREATE OR REPLACE FUNCTION public.listing_display_name(p_global_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(nullif(btrim(g.organization), ''), g.name) FROM public.global_partners g WHERE g.id = p_global_id
$$;
REVOKE ALL ON FUNCTION public.listing_display_name(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- The center account can still keep this listing's beds.
CREATE OR REPLACE FUNCTION public.bed_reminder_eligible(p_user_id uuid, p_global_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.center_members m
      JOIN public.global_partners g ON g.id = m.global_partner_id
     WHERE m.user_id = p_user_id AND m.global_partner_id = p_global_id
       AND g.status = 'active' AND public.listing_carries_beds(g.types))
$$;
REVOKE ALL ON FUNCTION public.bed_reminder_eligible(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Beds not confirmed in the last six days (or never): one email a week per
-- center account, so a count is confirmed before it reads Unconfirmed.
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
                  AND (g.beds_updated_at IS NULL OR g.beds_updated_at < now() - interval '6 days')
                  AND NOT EXISTS (SELECT 1 FROM public.email_outbox o
                                   WHERE o.user_id = m.user_id AND o.kind = 'bed_reminder'
                                     AND o.created_at > now() - interval '6 days 20 hours') LOOP
    IF public.email_enqueue(v_row.user_id, 'bed_reminder', jsonb_build_object('global_partner_id', v_row.global_partner_id)) THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END
$$;
REVOKE ALL ON FUNCTION public.notify_bed_reminders() FROM PUBLIC, anon, authenticated, service_role;

-- The private links in check-in emails: 256 random bits, stored only as a
-- hash, good for 14 days, for one center account and one listing.
CREATE TABLE IF NOT EXISTS public.listing_bed_links (
  token_hash bytea PRIMARY KEY,
  global_partner_id uuid NOT NULL REFERENCES public.global_partners(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '14 days'
);
CREATE INDEX IF NOT EXISTS listing_bed_links_expires_idx ON public.listing_bed_links (expires_at);
ALTER TABLE public.listing_bed_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.listing_bed_links FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.mint_bed_link(p_user_id uuid, p_global_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
BEGIN
  INSERT INTO public.listing_bed_links (token_hash, global_partner_id, user_id)
  VALUES (extensions.digest(v_token, 'sha256'), p_global_id, p_user_id);
  RETURN v_token;
END
$$;
REVOKE ALL ON FUNCTION public.mint_bed_link(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- set_listing_beds's write, for a caller already checked: the signed-in
-- claimant or admin (set_listing_beds) or a check-in link's center account
-- (public_bed_link_save). Same body as 20261001150000 after its checks.
CREATE OR REPLACE FUNCTION public.apply_listing_beds(
  p_global_id uuid, p_beds_male integer, p_beds_female integer, p_contact_name text, p_contact_phone text, p_actor uuid
)
RETURNS TABLE (beds_male integer, beds_female integer, beds_updated_at timestamptz, beds_stale boolean, beds_cadence_days integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.global_partners%ROWTYPE;
  v_now timestamptz := now();
  v_prev_pub text := coalesce(current_setting('referralfit.seed_publish', true), '');
  v_name text := left(btrim(coalesce(p_contact_name, '')), 120);
  v_phone text := left(btrim(coalesce(p_contact_phone, '')), 40);
  v_opened boolean;
BEGIN
  SELECT * INTO v_row FROM public.global_partners g WHERE g.id = p_global_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Directory listing not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.listing_carries_beds(v_row.types) THEN
    RAISE EXCEPTION 'Only treatment programs carry bed counts' USING ERRCODE = '22023';
  END IF;
  IF (p_beds_male IS NOT NULL AND p_beds_male NOT BETWEEN 0 AND 999)
     OR (p_beds_female IS NOT NULL AND p_beds_female NOT BETWEEN 0 AND 999) THEN
    RAISE EXCEPTION 'Bed counts must be between 0 and 999' USING ERRCODE = '22023';
  END IF;
  v_opened := (coalesce(v_row.beds_male, 0) = 0 AND coalesce(p_beds_male, 0) > 0)
           OR (coalesce(v_row.beds_female, 0) = 0 AND coalesce(p_beds_female, 0) > 0);
  PERFORM set_config('referralfit.beds_rpc', 'on', true);
  PERFORM set_config('referralfit.seed_publish', 'on', true);
  UPDATE public.global_partners g
     SET beds_male = p_beds_male, beds_female = p_beds_female, beds_updated_at = v_now, beds_updated_by = p_actor,
         admissions_contact_name = v_name, admissions_contact_phone = v_phone
   WHERE g.id = p_global_id;
  PERFORM set_config('referralfit.seed_publish', v_prev_pub, true);
  PERFORM set_config('referralfit.beds_rpc', '', true);
  INSERT INTO public.listing_bed_updates (global_partner_id, updated_at, beds_male, beds_female, updated_by)
  VALUES (p_global_id, v_now, p_beds_male, p_beds_female, p_actor);
  IF v_opened THEN
    PERFORM public.notify_bed_followers(p_global_id, p_actor);
  END IF;
  RETURN QUERY SELECT p_beds_male, p_beds_female, v_now, false, public.listing_bed_cadence_days(p_global_id);
END
$$;
REVOKE ALL ON FUNCTION public.apply_listing_beds(uuid, integer, integer, text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Same as 20261001150000: its checks, then the write above.
CREATE OR REPLACE FUNCTION public.set_listing_beds(
  p_global_id uuid, p_beds_male integer, p_beds_female integer, p_contact_name text, p_contact_phone text
)
RETURNS TABLE (beds_male integer, beds_female integer, beds_updated_at timestamptz, beds_stale boolean, beds_cadence_days integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.global_partners g WHERE g.id = p_global_id) THEN
    RAISE EXCEPTION 'Directory listing not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.is_platform_admin() AND NOT public.global_listing_claimed_by_caller(p_global_id) THEN
    RAISE EXCEPTION 'Only the program that claimed this listing or a platform admin can update its beds' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT * FROM public.apply_listing_beds(p_global_id, p_beds_male, p_beds_female, p_contact_name, p_contact_phone, v_user);
END
$$;
REVOKE ALL ON FUNCTION public.set_listing_beds(uuid, integer, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_listing_beds(uuid, integer, integer, text, text) TO authenticated;

-- ===========================================================================
-- 6a. The portal's /b page (signed out): a check-in link's listing
-- ===========================================================================

-- The link's listing and user, or nothing (unknown, expired, or the account
-- no longer keeps this listing's beds).
CREATE OR REPLACE FUNCTION public.bed_link_target(p_token text)
RETURNS TABLE (global_partner_id uuid, user_id uuid, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT l.global_partner_id, l.user_id, l.expires_at
    FROM public.listing_bed_links l
   WHERE l.token_hash = extensions.digest(coalesce(p_token, ''), 'sha256')
     AND l.expires_at > now()
     AND public.bed_reminder_eligible(l.user_id, l.global_partner_id)
$$;
REVOKE ALL ON FUNCTION public.bed_link_target(text) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.public_bed_link_open(p_token text)
RETURNS TABLE (
  listing_name text, city text, state text, beds_male integer, beds_female integer, beds_updated_at timestamptz,
  beds_stale boolean, admissions_contact_name text, admissions_contact_phone text, expires_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.listing_display_name(g.id), g.city, g.state, g.beds_male, g.beds_female, g.beds_updated_at,
         public.listing_beds_stale(g.beds_updated_at), g.admissions_contact_name, g.admissions_contact_phone, t.expires_at
    FROM public.bed_link_target(p_token) t
    JOIN public.global_partners g ON g.id = t.global_partner_id
$$;
REVOKE ALL ON FUNCTION public.public_bed_link_open(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_bed_link_open(text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.public_bed_link_save(
  p_token text, p_beds_male integer, p_beds_female integer, p_contact_name text, p_contact_phone text
)
RETURNS TABLE (beds_male integer, beds_female integer, beds_updated_at timestamptz, beds_stale boolean, beds_cadence_days integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target record;
BEGIN
  SELECT * INTO v_target FROM public.bed_link_target(p_token);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This link is not active' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY SELECT * FROM public.apply_listing_beds(v_target.global_partner_id, p_beds_male, p_beds_female,
                                                        p_contact_name, p_contact_phone, v_target.user_id);
END
$$;
REVOKE ALL ON FUNCTION public.public_bed_link_save(text, integer, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_bed_link_save(text, integer, integer, text, text) TO anon, authenticated;

-- ===========================================================================
-- 6b. The portal's /u page and one-click unsubscribe (signed out)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.public_email_preferences(p_token text)
RETURNS TABLE (is_practice boolean, is_program boolean, placement_response boolean, daily_summary boolean, bed_reminder boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.org_members m WHERE m.user_id = p.user_id),
         EXISTS (SELECT 1 FROM public.center_members c WHERE c.user_id = p.user_id),
         p.placement_response, p.daily_summary, p.bed_reminder
    FROM public.email_preferences p
   WHERE p.unsubscribe_token = coalesce(p_token, '') AND length(coalesce(p_token, '')) = 64
$$;
REVOKE ALL ON FUNCTION public.public_email_preferences(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_email_preferences(text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.public_email_set_preference(p_token text, p_kind text, p_value boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
BEGIN
  IF p_kind NOT IN ('placement_response', 'daily_summary', 'bed_reminder') OR p_value IS NULL THEN
    RAISE EXCEPTION 'Unknown email' USING ERRCODE = '22023';
  END IF;
  SELECT p.user_id INTO v_user FROM public.email_preferences p
   WHERE p.unsubscribe_token = coalesce(p_token, '') AND length(coalesce(p_token, '')) = 64;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'This link is not active' USING ERRCODE = 'P0002';
  END IF;
  UPDATE public.email_preferences
     SET placement_response = CASE WHEN p_kind = 'placement_response' THEN p_value ELSE placement_response END,
         daily_summary = CASE WHEN p_kind = 'daily_summary' THEN p_value ELSE daily_summary END,
         bed_reminder = CASE WHEN p_kind = 'bed_reminder' THEN p_value ELSE bed_reminder END,
         updated_at = now()
   WHERE user_id = v_user;
  IF NOT p_value THEN
    DELETE FROM public.email_outbox o
     WHERE o.user_id = v_user AND o.kind = p_kind AND o.sent_at IS NULL AND o.claimed_at IS NULL;
  END IF;
  RETURN p_value;
END
$$;
REVOKE ALL ON FUNCTION public.public_email_set_preference(text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_email_set_preference(text, text, boolean) TO anon, authenticated, service_role;

-- ===========================================================================
-- 6c. The app's settings (Workspace > Email me about...)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.get_email_preferences()
RETURNS TABLE (placement_response boolean, daily_summary boolean, bed_reminder boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.email_wanted(auth.uid(), 'placement_response'), public.email_wanted(auth.uid(), 'daily_summary'),
         public.email_wanted(auth.uid(), 'bed_reminder')
   WHERE auth.uid() IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public.get_email_preferences() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_email_preferences() TO authenticated;

-- A null argument keeps that choice as it is.
CREATE OR REPLACE FUNCTION public.set_email_preferences(
  p_placement_response boolean, p_daily_summary boolean, p_tz_offset_minutes integer
)
RETURNS TABLE (placement_response boolean, daily_summary boolean, bed_reminder boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF p_tz_offset_minutes IS NOT NULL AND p_tz_offset_minutes NOT BETWEEN -840 AND 840 THEN
    RAISE EXCEPTION 'Time zone offset out of range' USING ERRCODE = '22023';
  END IF;
  PERFORM public.email_preferences_row(v_user);
  UPDATE public.email_preferences p
     SET placement_response = coalesce(p_placement_response, p.placement_response),
         daily_summary = coalesce(p_daily_summary, p.daily_summary),
         tz_offset_minutes = coalesce(p_tz_offset_minutes, p.tz_offset_minutes),
         updated_at = now()
   WHERE p.user_id = v_user;
  IF p_placement_response IS FALSE OR p_daily_summary IS FALSE THEN
    DELETE FROM public.email_outbox o
     WHERE o.user_id = v_user AND o.sent_at IS NULL AND o.claimed_at IS NULL
       AND ((p_placement_response IS FALSE AND o.kind = 'placement_response')
         OR (p_daily_summary IS FALSE AND o.kind = 'daily_summary'));
  END IF;
  RETURN QUERY SELECT p.placement_response, p.daily_summary, p.bed_reminder
                 FROM public.email_preferences p WHERE p.user_id = v_user;
END
$$;
REVOKE ALL ON FUNCTION public.set_email_preferences(boolean, boolean, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_email_preferences(boolean, boolean, integer) TO authenticated;

-- ===========================================================================
-- 7. The dispatcher (email-dispatch Edge Function, service role only)
-- ===========================================================================

-- One claimed row made ready to send: the address, fresh counts or listing
-- details, a new check-in link, and the unsubscribe token. A row that can
-- no longer go out (no address, turned off since, request closed, listing
-- no longer kept by this account) is marked failed and returns nothing.
CREATE OR REPLACE FUNCTION public.email_outbox_prepare(p_id uuid)
RETURNS TABLE (id uuid, kind text, email text, data jsonb, unsubscribe_token text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o public.email_outbox%ROWTYPE;
  v_email text;
  v_data jsonb;
  v_req record;
  v_gid uuid;
  v_fail text;
  v_pref public.email_preferences%ROWTYPE;
BEGIN
  SELECT * INTO o FROM public.email_outbox x WHERE x.id = p_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = o.user_id;
  v_data := o.data;
  IF coalesce(btrim(v_email), '') = '' THEN
    v_fail := 'no_email';
  ELSIF NOT public.email_wanted(o.user_id, o.kind) THEN
    v_fail := 'unsubscribed';
  ELSIF o.kind = 'placement_response' THEN
    SELECT r.status,
           (SELECT count(*) FROM public.placement_request_recipients x WHERE x.request_id = r.id) AS asked,
           (SELECT count(*) FROM public.placement_request_recipients x
             WHERE x.request_id = r.id AND x.status IN ('responded', 'declined')) AS answered
      INTO v_req
      FROM public.placement_requests r WHERE r.id = (o.data ->> 'placement_request_id')::uuid;
    IF NOT FOUND OR v_req.status <> 'open' THEN
      v_fail := 'request_closed';
    ELSE
      v_data := v_data || jsonb_build_object('asked', v_req.asked, 'answered', v_req.answered);
    END IF;
  ELSIF o.kind = 'bed_reminder' THEN
    v_gid := (o.data ->> 'global_partner_id')::uuid;
    IF NOT public.bed_reminder_eligible(o.user_id, v_gid) THEN
      v_fail := 'not_eligible';
    ELSE
      SELECT v_data || jsonb_build_object(
               'listing_name', public.listing_display_name(g.id), 'beds_male', g.beds_male, 'beds_female', g.beds_female,
               'beds_updated_at', g.beds_updated_at, 'link_token', public.mint_bed_link(o.user_id, g.id))
        INTO v_data
        FROM public.global_partners g WHERE g.id = v_gid;
    END IF;
  END IF;
  IF v_fail IS NOT NULL THEN
    UPDATE public.email_outbox x SET error = v_fail WHERE x.id = p_id;
    RETURN;
  END IF;
  v_pref := public.email_preferences_row(o.user_id);
  RETURN QUERY SELECT o.id, o.kind, v_email, v_data, v_pref.unsubscribe_token;
END
$$;
REVOKE ALL ON FUNCTION public.email_outbox_prepare(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Claim a batch: rows due now and not claimed in the last five minutes (a
-- run in progress). Five attempts without a send marks the row failed.
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
    RETURN QUERY SELECT * FROM public.email_outbox_prepare(v_id);
  END LOOP;
END
$$;
REVOKE ALL ON FUNCTION public.email_outbox_claim(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_outbox_claim(integer) TO service_role;

-- Results: [{id, provider_id, error, retry}]. No error = sent. A retryable
-- error keeps the row for the next claim after five minutes.
CREATE OR REPLACE FUNCTION public.email_outbox_record(p_results jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r jsonb;
  v_count integer := 0;
BEGIN
  FOR r IN SELECT value FROM jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) LOOP
    IF coalesce(r ->> 'error', '') = '' THEN
      UPDATE public.email_outbox o SET sent_at = now(), provider_id = left(r ->> 'provider_id', 200), last_error = NULL
       WHERE o.id = (r ->> 'id')::uuid AND o.sent_at IS NULL;
    ELSIF coalesce((r ->> 'retry')::boolean, false) THEN
      UPDATE public.email_outbox o SET last_error = left(r ->> 'error', 300)
       WHERE o.id = (r ->> 'id')::uuid AND o.sent_at IS NULL;
    ELSE
      UPDATE public.email_outbox o SET error = left(r ->> 'error', 300)
       WHERE o.id = (r ->> 'id')::uuid AND o.sent_at IS NULL;
    END IF;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END
$$;
REVOKE ALL ON FUNCTION public.email_outbox_record(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_outbox_record(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.email_outbox_prune()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM public.email_outbox o
   WHERE (o.sent_at IS NOT NULL OR o.error IS NOT NULL) AND o.created_at < now() - interval '30 days';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  DELETE FROM public.listing_bed_links l WHERE l.expires_at < now() - interval '1 day';
  RETURN v_count;
END
$$;
REVOKE ALL ON FUNCTION public.email_outbox_prune() FROM PUBLIC, anon, authenticated, service_role;

-- Every minute: call the function through pg_net when an email is due.
-- Address and secret from Vault (referralfit_email_dispatch_url,
-- referralfit_email_dispatch_secret), like push_dispatch_tick.
CREATE OR REPLACE FUNCTION public.email_dispatch_tick()
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url text := public.push_dispatch_setting('referralfit_email_dispatch_url');
  v_secret text := public.push_dispatch_setting('referralfit_email_dispatch_secret');
BEGIN
  IF v_url = '' OR v_secret = '' THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.email_outbox o
                  WHERE o.sent_at IS NULL AND o.error IS NULL AND o.not_before <= now()
                    AND (o.claimed_at IS NULL OR o.claimed_at < now() - interval '5 minutes')) THEN
    RETURN false;
  END IF;
  EXECUTE 'SELECT net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 25000)'
    USING v_url, '{}'::jsonb,
          jsonb_build_object('content-type', 'application/json', 'x-email-dispatch-secret', v_secret);
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.email_dispatch_tick() FROM PUBLIC, anon, authenticated, service_role;

-- ===========================================================================
-- 8. Schedule (where pg_cron is on; harmless elsewhere)
-- ===========================================================================

DO $do$
DECLARE
  v_job record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    FOR v_job IN SELECT * FROM (VALUES
        ('referralfit-email-dispatch-minute', '* * * * *', 'SELECT public.email_dispatch_tick()'),
        ('referralfit-email-daily-summary-hourly', '2 * * * *', 'SELECT public.notify_daily_summaries()'),
        ('referralfit-email-bed-reminders-daily', '0 16 * * *', 'SELECT public.notify_bed_reminders()'),
        ('referralfit-email-outbox-prune-daily', '50 3 * * *', 'SELECT public.email_outbox_prune()')
      ) AS j (name, schedule, command) LOOP
      IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = v_job.name) THEN
        PERFORM cron.unschedule(v_job.name);
      END IF;
      PERFORM cron.schedule(v_job.name, v_job.schedule, v_job.command);
    END LOOP;
  END IF;
END
$do$;

COMMIT;
