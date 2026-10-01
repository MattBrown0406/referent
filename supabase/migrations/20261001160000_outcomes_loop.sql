BEGIN;

-- Outcomes loop: scheduled check-ins after a placement, a richer partner
-- scorecard, and network-wide completion and time-to-admit aggregates.
--
-- Roadmap feature 2 (Matt Brown, 2026-10-01): "Close the loop: outcomes
-- that make your matching smarter". Ratings stay exactly as they are: the
-- interventionist enters the 1-5 family experience after talking with the
-- family. Nothing here is family-facing.
--
--   1. referrals carries completed / completed_on / still_enrolled /
--      last_check_in_at next to the existing outcome columns.
--   2. follow_ups gains the check_in kind and check_in_days (7, 30 or 90).
--      record_placement_outcome(...) updates the referral and creates the
--      three check-ins in one transaction. It is idempotent: a partial
--      unique index on (referral_id, check_in_days) for check-ins, and
--      ON CONFLICT DO NOTHING. Check-ins whose date is already past are
--      skipped. Each one is assigned to the case assignee, else to the
--      referral's author while they are still a member.
--   3. partner_scorecard adds completed, decided_placements,
--      completion_rate, median_days_to_admit and still_enrolled.
--   4. global_partner_stats adds completion_rate and median_days_to_admit
--      over the same 12-month window, disclosed only under the existing
--      five-distinct-workspaces rule (plus at least five decided placements
--      or dated admits, mirroring the admit_rate floor).
--
-- Transit rule: this file is pasted into the SQL editor from a chat client.
-- No backslashes and no non-ASCII characters anywhere in it; every
-- top-level statement stays under 3,700 characters.

-- ===========================================================================
-- 1. Referral outcome fields
-- ===========================================================================

ALTER TABLE public.referrals ADD COLUMN IF NOT EXISTS completed boolean;
ALTER TABLE public.referrals ADD COLUMN IF NOT EXISTS completed_on date;
ALTER TABLE public.referrals ADD COLUMN IF NOT EXISTS still_enrolled boolean;
ALTER TABLE public.referrals ADD COLUMN IF NOT EXISTS last_check_in_at timestamptz;

-- ===========================================================================
-- 2. The check_in follow-up kind
-- ===========================================================================

ALTER TABLE public.follow_ups ADD COLUMN IF NOT EXISTS check_in_days smallint;

-- The kind check was created inline in 20260724190000, so its name is
-- whatever Postgres chose. Drop every check constraint that mentions kind
-- and re-create one with a stable name.
DO $do$
DECLARE
  v_name text;
BEGIN
  FOR v_name IN
    SELECT c.conname
      FROM pg_constraint c
     WHERE c.conrelid = 'public.follow_ups'::regclass
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '%kind%'
  LOOP
    EXECUTE format('ALTER TABLE public.follow_ups DROP CONSTRAINT %I', v_name);
  END LOOP;
END
$do$;

ALTER TABLE public.follow_ups ADD CONSTRAINT follow_ups_kind_check
  CHECK (kind IN ('follow_up', 'first_call', 'promised_call', 'waiting_on', 'consult', 'touch', 'check_in'));

ALTER TABLE public.follow_ups ADD CONSTRAINT follow_ups_check_in_days_check
  CHECK (check_in_days IS NULL OR check_in_days IN (7, 30, 90));

CREATE UNIQUE INDEX IF NOT EXISTS follow_ups_check_in_once_idx
  ON public.follow_ups (referral_id, check_in_days)
  WHERE kind = 'check_in';

-- ===========================================================================
-- 3. record_placement_outcome: one path for the app and the offline queue
-- ===========================================================================
-- p_outcome keys (all optional): admitted, admitted_on, family_experience,
-- outcome_note, outcome, completed, completed_on, still_enrolled, check_in.
-- p_completed (optional): the follow-up being completed, as the client
-- sends it to complete_follow_up_with_outcome (id, status, completed_at,
-- snoozed_until, note). Returns the number of check-ins created.

-- Creates the 7 / 30 / 90 day check-ins for an admitted referral. Called by
-- record_placement_outcome; also safe to call on its own for a referral
-- whose admission was recorded by an older build.
CREATE OR REPLACE FUNCTION public.schedule_placement_check_ins(p_referral_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid := public.current_org_id();
  v_ref record;
  v_assignee uuid;
  v_label text;
  v_days integer;
  v_due date;
  v_created integer := 0;
  v_inserted integer;
BEGIN
  IF v_user IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;

  SELECT r.id, r.partner_id, r.case_id, r.owner_id, r.client_label, r.admitted, r.admitted_on,
         c.assigned_to AS case_assignee
    INTO v_ref
    FROM public.referrals r
    LEFT JOIN public.cases c ON c.id = r.case_id
   WHERE r.id = p_referral_id AND r.org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referral not found in this workspace' USING ERRCODE = 'P0002';
  END IF;
  IF v_ref.admitted IS NOT TRUE OR v_ref.admitted_on IS NULL THEN
    RETURN 0;
  END IF;

  v_assignee := v_ref.case_assignee;
  IF v_assignee IS NULL AND EXISTS (
    SELECT 1 FROM public.org_members m WHERE m.user_id = v_ref.owner_id AND m.org_id = v_org
  ) THEN
    v_assignee := v_ref.owner_id;
  END IF;
  v_label := coalesce(nullif(v_ref.client_label, ''), 'the family');

  FOREACH v_days IN ARRAY ARRAY[7, 30, 90] LOOP
    v_due := v_ref.admitted_on + v_days;
    IF v_due < CURRENT_DATE THEN
      CONTINUE;
    END IF;
    INSERT INTO public.follow_ups (owner_id, org_id, partner_id, referral_id, case_id, title, due_on, kind, check_in_days, assigned_to)
    VALUES (v_user, v_org, v_ref.partner_id, v_ref.id, v_ref.case_id,
            v_days::text || '-day check-in: ' || v_label, v_due, 'check_in', v_days, v_assignee)
    ON CONFLICT (referral_id, check_in_days) WHERE kind = 'check_in' DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    v_created := v_created + v_inserted;
  END LOOP;

  RETURN v_created;
END
$$;
REVOKE ALL ON FUNCTION public.schedule_placement_check_ins(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.schedule_placement_check_ins(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_placement_outcome(p_referral_id uuid, p_outcome jsonb, p_completed jsonb DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid := public.current_org_id();
  v_updated integer;
BEGIN
  IF v_user IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;

  IF p_completed IS NOT NULL THEN
    UPDATE public.follow_ups
       SET status = coalesce(p_completed ->> 'status', 'done'),
           completed_at = coalesce(nullif(p_completed ->> 'completed_at', '')::timestamptz, now()),
           snoozed_until = nullif(p_completed ->> 'snoozed_until', '')::date,
           note = coalesce(p_completed ->> 'note', note)
     WHERE id = (p_completed ->> 'id')::uuid AND org_id = v_org;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> 1 THEN
      RAISE EXCEPTION 'Follow-up not found in this workspace' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  UPDATE public.referrals
     SET admitted = CASE WHEN p_outcome ? 'admitted' THEN (p_outcome ->> 'admitted')::boolean ELSE admitted END,
         admitted_on = CASE WHEN p_outcome ? 'admitted_on' THEN nullif(p_outcome ->> 'admitted_on', '')::date ELSE admitted_on END,
         family_experience = CASE WHEN p_outcome ? 'family_experience' THEN nullif(p_outcome ->> 'family_experience', '')::smallint ELSE family_experience END,
         outcome_note = CASE WHEN p_outcome ? 'outcome_note' THEN coalesce(p_outcome ->> 'outcome_note', '') ELSE outcome_note END,
         outcome = CASE WHEN p_outcome ? 'outcome' THEN nullif(p_outcome ->> 'outcome', '') ELSE outcome END,
         completed = CASE WHEN p_outcome ? 'completed' THEN (p_outcome ->> 'completed')::boolean ELSE completed END,
         completed_on = CASE WHEN p_outcome ? 'completed_on' THEN nullif(p_outcome ->> 'completed_on', '')::date ELSE completed_on END,
         still_enrolled = CASE WHEN p_outcome ? 'still_enrolled' THEN (p_outcome ->> 'still_enrolled')::boolean ELSE still_enrolled END,
         last_check_in_at = CASE WHEN coalesce((p_outcome ->> 'check_in')::boolean, false) THEN now() ELSE last_check_in_at END
   WHERE id = p_referral_id AND org_id = v_org;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'Referral not found in this workspace' USING ERRCODE = 'P0002';
  END IF;

  RETURN public.schedule_placement_check_ins(p_referral_id);
END
$$;
REVOKE ALL ON FUNCTION public.record_placement_outcome(uuid, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_placement_outcome(uuid, jsonb, jsonb) TO authenticated;

-- ===========================================================================
-- 4. partner_scorecard: completion, time to admit, still enrolled
-- ===========================================================================
-- Existing columns keep their names, types and order (CREATE OR REPLACE
-- VIEW only appends). completion_rate = completed / decided placements,
-- where a decided placement is an admitted referral whose completed flag
-- has been answered either way. median_days_to_admit is admitted_on minus
-- referred_on over admitted referrals with a sane admission date.

CREATE OR REPLACE VIEW public.partner_scorecard
WITH (security_invoker = on) AS
SELECT
  p.id AS partner_id,
  p.owner_id,
  count(r.*) FILTER (WHERE r.direction = 'outbound') AS referrals_sent,
  count(r.*) FILTER (WHERE r.direction = 'outbound' AND r.admitted IS TRUE) AS admits,
  count(r.*) FILTER (WHERE r.direction = 'outbound' AND r.admitted IS FALSE) AS non_admits,
  round(avg(r.family_experience) FILTER (WHERE r.direction = 'outbound'), 2) AS avg_family_experience,
  max(r.referred_on) FILTER (WHERE r.direction = 'outbound') AS last_referral_on,
  count(r.*) FILTER (WHERE r.direction = 'outbound' AND r.admitted IS TRUE AND r.completed IS TRUE) AS completed,
  count(r.*) FILTER (WHERE r.direction = 'outbound' AND r.admitted IS TRUE AND r.completed IS NOT NULL) AS decided_placements,
  round(avg(CASE WHEN r.completed THEN 1.0 ELSE 0.0 END)
          FILTER (WHERE r.direction = 'outbound' AND r.admitted IS TRUE AND r.completed IS NOT NULL), 4) AS completion_rate,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY (r.admitted_on - r.referred_on))
    FILTER (WHERE r.direction = 'outbound' AND r.admitted IS TRUE AND r.admitted_on IS NOT NULL AND r.admitted_on >= r.referred_on) AS median_days_to_admit,
  count(r.*) FILTER (WHERE r.direction = 'outbound' AND r.admitted IS TRUE AND r.still_enrolled IS TRUE AND r.completed IS NOT TRUE) AS still_enrolled
FROM public.partners p
LEFT JOIN public.referrals r ON r.partner_id = p.id
GROUP BY p.id, p.owner_id;

GRANT SELECT ON public.partner_scorecard TO authenticated;

-- ===========================================================================
-- 5. Network-wide aggregates: completion rate and median days to admit
-- ===========================================================================
-- A materialized view cannot gain columns in place, so it is rebuilt with
-- the same definition plus the new measures. The refresh function and the
-- hourly pg_cron job from 20260907120000 keep working unchanged; the job is
-- re-scheduled below with the same guard so the pattern stays explicit.

DROP MATERIALIZED VIEW IF EXISTS public.global_partner_stats;

CREATE MATERIALIZED VIEW public.global_partner_stats AS
  WITH linked AS (
    SELECT p.id AS partner_id, p.org_id, p.global_partner_id
      FROM public.partners p
     WHERE p.global_partner_id IS NOT NULL
  ),
  ref AS (
    SELECT l.global_partner_id,
           r.org_id,
           r.referred_on,
           r.admitted,
           r.admitted_on,
           r.completed,
           r.family_experience
      FROM linked l
      JOIN public.referrals r ON r.partner_id = l.partner_id AND r.org_id = l.org_id
     WHERE r.direction = 'outbound'
       AND r.referred_on >= (CURRENT_DATE - INTERVAL '12 months')
  )
  SELECT g.id AS global_partner_id,
         (SELECT count(DISTINCT org_id) FROM linked WHERE global_partner_id = g.id)::integer AS importing_orgs,
         (SELECT count(DISTINCT org_id) FROM ref WHERE global_partner_id = g.id)::integer AS referring_orgs,
         (SELECT count(*) FROM ref WHERE global_partner_id = g.id)::integer AS referrals_12m,
         (SELECT count(*) FROM ref WHERE global_partner_id = g.id AND admitted IS NOT NULL)::integer AS decided_12m,
         (SELECT avg(CASE WHEN admitted THEN 1.0 ELSE 0.0 END) FROM ref WHERE global_partner_id = g.id AND admitted IS NOT NULL)::numeric(5,4) AS admit_rate,
         (SELECT count(family_experience) FROM ref WHERE global_partner_id = g.id)::integer AS rated_12m,
         (SELECT avg(family_experience) FROM ref WHERE global_partner_id = g.id)::numeric(4,2) AS family_experience,
         (SELECT count(*) FROM ref WHERE global_partner_id = g.id AND admitted IS TRUE AND completed IS NOT NULL)::integer AS decided_placements_12m,
         (SELECT avg(CASE WHEN completed THEN 1.0 ELSE 0.0 END) FROM ref WHERE global_partner_id = g.id AND admitted IS TRUE AND completed IS NOT NULL)::numeric(5,4) AS completion_rate,
         (SELECT count(*) FROM ref WHERE global_partner_id = g.id AND admitted IS TRUE AND admitted_on IS NOT NULL AND admitted_on >= referred_on)::integer AS dated_admits_12m,
         (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY (admitted_on - referred_on)) FROM ref WHERE global_partner_id = g.id AND admitted IS TRUE AND admitted_on IS NOT NULL AND admitted_on >= referred_on)::numeric(6,1) AS median_days_to_admit,
         (SELECT max(referred_on) FROM ref WHERE global_partner_id = g.id) AS last_referral_on,
         now() AS refreshed_at
    FROM public.global_partners g
  WITH NO DATA;

CREATE UNIQUE INDEX global_partner_stats_pkey ON public.global_partner_stats (global_partner_id);
REVOKE ALL ON public.global_partner_stats FROM PUBLIC, anon, authenticated;

REFRESH MATERIALIZED VIEW public.global_partner_stats;

-- The return shape changes, so the function is dropped and re-created.
DROP FUNCTION IF EXISTS public.fetch_global_partner_stats(uuid[]);

CREATE FUNCTION public.fetch_global_partner_stats(p_ids uuid[])
RETURNS TABLE (
  global_partner_id uuid,
  importing_orgs integer,
  referrals_12m integer,
  admit_rate numeric,
  family_experience numeric,
  completion_rate numeric,
  median_days_to_admit numeric,
  last_referral_on date,
  disclosed boolean,
  refreshed_at timestamptz
)
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin boolean := public.is_platform_admin();
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF NOT v_admin AND NOT public.org_has_entitlement('directory') THEN
    RAISE EXCEPTION 'Directory stats require the directory plan' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT s.global_partner_id,
         CASE WHEN v_admin OR s.importing_orgs >= 5 THEN s.importing_orgs ELSE NULL END,
         CASE WHEN v_admin OR s.referring_orgs >= 5 THEN s.referrals_12m ELSE NULL END,
         CASE WHEN (v_admin OR s.referring_orgs >= 5) AND s.decided_12m >= 5 THEN s.admit_rate ELSE NULL END,
         CASE WHEN (v_admin OR s.referring_orgs >= 5) AND s.rated_12m >= 3 THEN s.family_experience ELSE NULL END,
         CASE WHEN (v_admin OR s.referring_orgs >= 5) AND s.decided_placements_12m >= 5 THEN s.completion_rate ELSE NULL END,
         CASE WHEN (v_admin OR s.referring_orgs >= 5) AND s.dated_admits_12m >= 5 THEN s.median_days_to_admit ELSE NULL END,
         CASE WHEN v_admin OR s.referring_orgs >= 5 THEN s.last_referral_on ELSE NULL END,
         (v_admin OR s.importing_orgs >= 5 OR s.referring_orgs >= 5),
         s.refreshed_at
    FROM public.global_partner_stats s
   WHERE s.global_partner_id = ANY (p_ids)
     AND EXISTS (SELECT 1 FROM public.global_partners g WHERE g.id = s.global_partner_id AND (v_admin OR g.status = 'active'));
END
$$;
REVOKE ALL ON FUNCTION public.fetch_global_partner_stats(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fetch_global_partner_stats(uuid[]) TO authenticated;

-- Hourly refresh where pg_cron is available (production); harmless locally.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'referralfit-global-partner-stats-hourly') THEN
      PERFORM cron.unschedule('referralfit-global-partner-stats-hourly');
    END IF;
    PERFORM cron.schedule(
      'referralfit-global-partner-stats-hourly',
      '17 * * * *',
      'SELECT public.refresh_global_partner_stats()'
    );
  END IF;
END
$do$;

COMMIT;
