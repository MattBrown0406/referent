BEGIN;

-- Lead capture: never lose a lead, and see how fast the practice answers.
--
-- Roadmap feature 1 (Matt Brown, 2026-10-01). Two doors into the same place:
--   * the in-app "New lead" quick-add (create_lead, authenticated), and
--   * a hosted intake link served by the `intake` edge function
--     (create_lead_from_intake, service_role only).
-- Both create one case (status inquiry), its primary contact, a first-call
-- follow-up, and a system timeline entry, inside one transaction.
--
-- Speed to lead: cases.first_touch_at is set by a trigger the first time a
-- call, text, email, or meeting is logged against the case. It is set once
-- and never moved, so the Business dashboard can read it straight off the
-- row. lead_capture_metrics() returns the same numbers server-side.
--
-- Sections:
--   1. orgs: intake token (rotatable) and first-call target
--   2. cases: first_touch_at, lead_captured_at, lead_channel, lead_urgency
--   3. first-touch trigger on case_events
--   4. lead creation: shared internal, app RPC, intake RPC
--   5. intake rate limiting (service role only)
--   6. token rotation
--   7. speed-to-lead metrics
--
-- Transit rule: this file is pasted into the SQL editor from a chat client.
-- No backslashes and no non-ASCII characters anywhere in it; character
-- sets are built with chr().

-- ===========================================================================
-- 1. orgs: intake token and first-call target
-- ===========================================================================

-- 40 hex characters from two random UUIDs. Core Postgres only (no pgcrypto
-- dependency), unguessable, and URL-safe.
CREATE OR REPLACE FUNCTION public.generate_intake_token()
RETURNS text
LANGUAGE sql VOLATILE
SET search_path = pg_catalog
AS $$
  SELECT substr(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 1, 40)
$$;
REVOKE ALL ON FUNCTION public.generate_intake_token() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.orgs ADD COLUMN IF NOT EXISTS intake_token text;
ALTER TABLE public.orgs ADD COLUMN IF NOT EXISTS intake_token_rotated_at timestamptz;
ALTER TABLE public.orgs ADD COLUMN IF NOT EXISTS lead_response_target_minutes integer NOT NULL DEFAULT 15;

UPDATE public.orgs SET intake_token = public.generate_intake_token() WHERE intake_token IS NULL;

ALTER TABLE public.orgs ALTER COLUMN intake_token SET NOT NULL;
ALTER TABLE public.orgs ALTER COLUMN intake_token SET DEFAULT public.generate_intake_token();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orgs_intake_token_shape') THEN
    ALTER TABLE public.orgs ADD CONSTRAINT orgs_intake_token_shape
      CHECK (intake_token ~ '^[0-9a-f]{32,64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orgs_lead_response_target_range') THEN
    ALTER TABLE public.orgs ADD CONSTRAINT orgs_lead_response_target_range
      CHECK (lead_response_target_minutes BETWEEN 1 AND 1440);
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS orgs_intake_token_key ON public.orgs (intake_token);

-- Members read the token (the Workspace screen shows the link); only the
-- owner changes the target, through the existing "orgs: owner rename" UPDATE
-- policy. The token itself is only ever changed by rotate_intake_token().
GRANT UPDATE (lead_response_target_minutes) ON public.orgs TO authenticated;

-- ===========================================================================
-- 2. cases: first touch and lead capture columns
-- ===========================================================================

ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS first_touch_at timestamptz;
ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS lead_captured_at timestamptz;
ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS lead_channel text;
ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS lead_urgency text NOT NULL DEFAULT 'none';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cases_lead_channel_check') THEN
    ALTER TABLE public.cases ADD CONSTRAINT cases_lead_channel_check
      CHECK (lead_channel IS NULL OR lead_channel IN ('app', 'intake_link'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cases_lead_urgency_check') THEN
    ALTER TABLE public.cases ADD CONSTRAINT cases_lead_urgency_check
      CHECK (lead_urgency IN ('none', 'immediate_danger'));
  END IF;
END
$$;

-- Backfill: the earliest logged contact on every existing case, so the
-- metric is consistent for history too.
UPDATE public.cases AS c
   SET first_touch_at = t.first_at
  FROM (
    SELECT case_id, min(occurred_at) AS first_at
      FROM public.case_events
     WHERE kind IN ('call', 'text', 'email', 'meeting')
     GROUP BY case_id
  ) AS t
 WHERE t.case_id = c.id
   AND c.first_touch_at IS NULL;

CREATE INDEX IF NOT EXISTS cases_org_lead_captured_idx
  ON public.cases (org_id, lead_captured_at DESC)
  WHERE lead_captured_at IS NOT NULL;

-- ===========================================================================
-- 3. first-touch trigger
-- ===========================================================================

-- Set once: the first call, text, email, or meeting logged against a case
-- stamps first_touch_at. Later touches, backdated touches, and notes never
-- move it. SECURITY DEFINER so definer-side writers (log_contact_activity,
-- the intake path) stamp the case too.
CREATE OR REPLACE FUNCTION public.case_events_set_first_touch()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.kind IN ('call', 'text', 'email', 'meeting') THEN
    UPDATE public.cases
       SET first_touch_at = NEW.occurred_at
     WHERE id = NEW.case_id
       AND org_id = NEW.org_id
       AND first_touch_at IS NULL;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.case_events_set_first_touch() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS case_events_first_touch ON public.case_events;
CREATE TRIGGER case_events_first_touch
  AFTER INSERT ON public.case_events
  FOR EACH ROW EXECUTE FUNCTION public.case_events_set_first_touch();

-- ===========================================================================
-- 4. lead creation
-- ===========================================================================

-- Validates and normalizes a lead payload. Raises 22023 with a plain message
-- on a bad payload. Keys in: caller_name, phone, email, about_relationship,
-- about_first_name, lead_source, lead_source_detail, urgency, note.
CREATE OR REPLACE FUNCTION public.lead_payload_normalize(p_lead jsonb)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_name text := btrim(coalesce(p_lead ->> 'caller_name', ''));
  v_phone text := btrim(coalesce(p_lead ->> 'phone', ''));
  v_email text := btrim(coalesce(p_lead ->> 'email', ''));
  v_relationship text := btrim(coalesce(p_lead ->> 'about_relationship', ''));
  v_first_name text := btrim(coalesce(p_lead ->> 'about_first_name', ''));
  v_source text := btrim(coalesce(p_lead ->> 'lead_source', ''));
  v_detail text := btrim(coalesce(p_lead ->> 'lead_source_detail', ''));
  v_urgency text := btrim(coalesce(p_lead ->> 'urgency', 'none'));
  v_note text := btrim(coalesce(p_lead ->> 'note', ''));
  v_digits text := regexp_replace(v_phone, '[^0-9]', '', 'g');
BEGIN
  IF p_lead IS NULL OR jsonb_typeof(p_lead) <> 'object' THEN
    RAISE EXCEPTION 'A lead payload is required' USING ERRCODE = '22023';
  END IF;
  IF v_name = '' OR length(v_name) > 120 THEN
    RAISE EXCEPTION 'The caller name is required (up to 120 characters)' USING ERRCODE = '22023';
  END IF;
  IF length(v_digits) < 10 OR length(v_digits) > 15 OR length(v_phone) > 40 THEN
    RAISE EXCEPTION 'A phone number with at least 10 digits is required' USING ERRCODE = '22023';
  END IF;
  IF v_email <> '' AND (length(v_email) > 254 OR v_email !~ '^[^@ ]+@[^@ ]+[.][^@ ]+$') THEN
    RAISE EXCEPTION 'The email address does not look right' USING ERRCODE = '22023';
  END IF;
  IF length(v_relationship) > 60 OR length(v_first_name) > 60 THEN
    RAISE EXCEPTION 'Relationship and first name are limited to 60 characters' USING ERRCODE = '22023';
  END IF;
  IF length(v_source) > 80 OR length(v_detail) > 500 OR length(v_note) > 2000 THEN
    RAISE EXCEPTION 'Lead source or note is too long' USING ERRCODE = '22023';
  END IF;
  IF v_urgency NOT IN ('none', 'immediate_danger') THEN
    RAISE EXCEPTION 'Urgency must be none or immediate_danger' USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_build_object(
    'caller_name', v_name,
    'phone', v_phone,
    'email', v_email,
    'about_relationship', v_relationship,
    'about_first_name', v_first_name,
    'lead_source', CASE WHEN v_source = '' THEN 'Unspecified' ELSE v_source END,
    'lead_source_detail', v_detail,
    'urgency', v_urgency,
    'note', v_note
  );
END
$$;
REVOKE ALL ON FUNCTION public.lead_payload_normalize(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lead_payload_normalize(jsonb) TO authenticated, service_role;

-- The case title: "Caller Name - relationship First" with the same dash the
-- app uses in case titles (chr(8212)), or just the caller name.
CREATE OR REPLACE FUNCTION public.lead_case_title(p_lead jsonb)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN btrim(coalesce(p_lead ->> 'about_relationship', '') || ' ' || coalesce(p_lead ->> 'about_first_name', '')) = ''
      THEN p_lead ->> 'caller_name'
    ELSE (p_lead ->> 'caller_name') || ' ' || chr(8212) || ' '
      || btrim(coalesce(p_lead ->> 'about_relationship', '') || ' ' || coalesce(p_lead ->> 'about_first_name', ''))
  END
$$;
REVOKE ALL ON FUNCTION public.lead_case_title(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lead_case_title(jsonb) TO authenticated, service_role;

-- Shared writer. Never granted to a client role: create_lead and
-- create_lead_from_intake decide who may call it and for which workspace.
-- Optional ids (id, contact_id, follow_up_id) let the app keep its optimistic
-- rows; due_on / due_time let the app use the device-local day and the
-- first-call target time. Everything else is server-set.
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
  IF p_channel NOT IN ('app', 'intake_link') THEN
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
    v_lead ->> 'caller_name', v_lead ->> 'about_relationship',
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
         ELSE 'New lead added in the app' END,
    v_contact_id, v_now
  );

  RETURN v_case_id;
END
$$;
REVOKE ALL ON FUNCTION public.create_lead_internal(uuid, uuid, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;

-- In-app quick-add. Same owner fence as create_case_bundle.
CREATE OR REPLACE FUNCTION public.create_lead(p_expected_owner_id uuid, p_lead jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_org_id uuid := public.current_org_id();
BEGIN
  IF v_owner_id IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF v_owner_id <> p_expected_owner_id THEN
    RAISE EXCEPTION 'Authenticated account changed before the lead was saved' USING ERRCODE = '42501';
  END IF;
  RETURN public.create_lead_internal(v_org_id, v_owner_id, p_lead, 'app');
END
$$;
REVOKE ALL ON FUNCTION public.create_lead(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_lead(uuid, jsonb) TO authenticated;

-- Hosted intake link. Only the edge function (service role) may call this.
-- The lead is attributed to the workspace owner. An unknown or rotated token
-- raises P0002 so the function can answer 404 without leaking anything.
CREATE OR REPLACE FUNCTION public.create_lead_from_intake(p_token text, p_lead jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id uuid;
  v_owner_id uuid;
BEGIN
  IF coalesce(p_token, '') !~ '^[0-9a-f]{32,64}$' THEN
    RAISE EXCEPTION 'Unknown intake link' USING ERRCODE = 'P0002';
  END IF;
  SELECT id INTO v_org_id FROM public.orgs WHERE intake_token = p_token;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Unknown intake link' USING ERRCODE = 'P0002';
  END IF;
  SELECT user_id INTO v_owner_id
    FROM public.org_members
   WHERE org_id = v_org_id
   ORDER BY (role = 'owner') DESC, created_at
   LIMIT 1;
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'Unknown intake link' USING ERRCODE = 'P0002';
  END IF;
  RETURN public.create_lead_internal(v_org_id, v_owner_id, p_lead, 'intake_link');
END
$$;
REVOKE ALL ON FUNCTION public.create_lead_from_intake(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_lead_from_intake(text, jsonb) TO service_role;

-- ===========================================================================
-- 5. intake rate limiting
-- ===========================================================================

-- Fixed-window counters keyed by an opaque bucket ("token:<token>" or
-- "ip:<hmac>"; the function never stores a raw address). Service role only;
-- no client policy exists on purpose.
CREATE TABLE IF NOT EXISTS public.intake_rate_limits (
  bucket            text PRIMARY KEY CHECK (length(bucket) BETWEEN 3 AND 200),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  hits              integer NOT NULL DEFAULT 0
);
ALTER TABLE public.intake_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intake_rate_limits FROM PUBLIC, anon, authenticated;

-- Returns true when this hit is within p_limit for the window; false when
-- the caller should be told to wait. Stale buckets are swept opportunistically.
CREATE OR REPLACE FUNCTION public.intake_rate_limit_hit(p_bucket text, p_limit integer, p_window_seconds integer)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hits integer;
  v_window interval := make_interval(secs => greatest(p_window_seconds, 1));
BEGIN
  IF random() < 0.02 THEN
    DELETE FROM public.intake_rate_limits WHERE window_started_at < now() - interval '2 days';
  END IF;
  INSERT INTO public.intake_rate_limits AS r (bucket, window_started_at, hits)
  VALUES (p_bucket, now(), 1)
  ON CONFLICT (bucket) DO UPDATE
    SET hits = CASE WHEN r.window_started_at < now() - v_window THEN 1 ELSE r.hits + 1 END,
        window_started_at = CASE WHEN r.window_started_at < now() - v_window THEN now() ELSE r.window_started_at END
  RETURNING r.hits INTO v_hits;
  RETURN v_hits <= greatest(p_limit, 1);
END
$$;
REVOKE ALL ON FUNCTION public.intake_rate_limit_hit(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intake_rate_limit_hit(text, integer, integer) TO service_role;

-- ===========================================================================
-- 6. token rotation
-- ===========================================================================

-- "Make a new link": the workspace owner replaces the token; the old URL
-- stops working immediately (create_lead_from_intake looks the token up on
-- every submission).
CREATE OR REPLACE FUNCTION public.rotate_intake_token()
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id uuid := public.current_org_id();
  v_token text;
BEGIN
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF public.current_org_role() <> 'owner' THEN
    RAISE EXCEPTION 'Only the workspace owner can make a new intake link' USING ERRCODE = '42501';
  END IF;
  UPDATE public.orgs
     SET intake_token = public.generate_intake_token(),
         intake_token_rotated_at = now()
   WHERE id = v_org_id
  RETURNING intake_token INTO v_token;
  RETURN v_token;
END
$$;
REVOKE ALL ON FUNCTION public.rotate_intake_token() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rotate_intake_token() TO authenticated;

-- ===========================================================================
-- 7. speed-to-lead metrics
-- ===========================================================================

-- One row per lead source plus a total row (lead_source = '*'), for leads
-- captured since p_since (NULL = all time) in the caller's workspace.
-- median_seconds: median of first_touch_at - lead_captured_at over leads
-- that have a touch. within_target: leads touched within the workspace's
-- lead_response_target_minutes. The app computes the same numbers from the
-- case rows (src/lib/business.ts); keep the two in step.
CREATE OR REPLACE FUNCTION public.lead_capture_metrics(p_since timestamptz DEFAULT NULL)
RETURNS TABLE (lead_source text, leads integer, touched integer, within_target integer, median_seconds numeric)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
  WITH scoped AS (
    SELECT c.lead_source,
           extract(epoch FROM (c.first_touch_at - c.lead_captured_at)) AS seconds,
           o.lead_response_target_minutes * 60 AS target_seconds
      FROM public.cases AS c
      JOIN public.orgs AS o ON o.id = c.org_id
     WHERE c.org_id = public.current_org_id()
       AND c.lead_captured_at IS NOT NULL
       AND (p_since IS NULL OR c.lead_captured_at >= p_since)
  )
  SELECT CASE WHEN grouping(s.lead_source) = 1 THEN '*' ELSE s.lead_source END AS lead_source,
         count(*)::integer AS leads,
         count(s.seconds)::integer AS touched,
         count(*) FILTER (WHERE s.seconds IS NOT NULL AND s.seconds >= 0 AND s.seconds <= s.target_seconds)::integer AS within_target,
         round((percentile_cont(0.5) WITHIN GROUP (ORDER BY s.seconds) FILTER (WHERE s.seconds IS NOT NULL AND s.seconds >= 0))::numeric, 1) AS median_seconds
    FROM scoped AS s
   GROUP BY GROUPING SETS ((s.lead_source), ())
   ORDER BY grouping(s.lead_source) DESC, leads DESC, lead_source
$$;
REVOKE ALL ON FUNCTION public.lead_capture_metrics(timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lead_capture_metrics(timestamptz) TO authenticated;

COMMIT;
