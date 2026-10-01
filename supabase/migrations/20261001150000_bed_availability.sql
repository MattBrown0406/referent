BEGIN;

-- Bed availability: live, gender-specific bed counts on directory listings.
--
-- Roadmap feature 3 (Matt Brown, 2026-10-01): "make it gender specific:
-- 3 male beds, 1 female bed". Programs that claimed their listing keep the
-- count current from the Center Portal; a platform admin can set any
-- listing's count from the app. Nobody else can.
--
--   1. global_partners carries beds_male / beds_female (NULL = unknown,
--      0 = full), when and by whom they were last set, and an on-call
--      admissions contact. Only treatment programs (Inpatient, IOP / PHP,
--      Sober Living, Detox) carry beds; individual professionals do not.
--   2. Counts live on the listing only. They never propagate to tenant
--      copies (partners) and never touch verification: the tenant reads
--      them live through the directory and matching.
--   3. A count older than bed_stale_days() (7) is "unconfirmed". The read
--      RPCs return beds_stale so no client computes it.
--   4. listing_bed_updates is the history (and the audit trail): one row per
--      set_listing_beds call. Readable by platform admins and the listing's
--      own claimants. "Usually updates beds within N days" comes from the
--      last five gaps and is skipped with fewer than three updates.
--   5. Push: when a gender moves from 0 / unknown to open, members of
--      workspaces that favorited or imported the listing, and opted in to
--      the new bed_opened kind (default off), get a generic push.
--
-- Transit rule: this file is pasted into the SQL editor from a chat client.
-- No backslashes and no non-ASCII characters anywhere in it; every
-- top-level statement stays under 3,700 characters.

-- ===========================================================================
-- 1. Columns
-- ===========================================================================

ALTER TABLE public.global_partners ADD COLUMN IF NOT EXISTS beds_male integer;
ALTER TABLE public.global_partners ADD COLUMN IF NOT EXISTS beds_female integer;
ALTER TABLE public.global_partners ADD COLUMN IF NOT EXISTS beds_updated_at timestamptz;
ALTER TABLE public.global_partners ADD COLUMN IF NOT EXISTS beds_updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.global_partners ADD COLUMN IF NOT EXISTS admissions_contact_name text NOT NULL DEFAULT '';
ALTER TABLE public.global_partners ADD COLUMN IF NOT EXISTS admissions_contact_phone text NOT NULL DEFAULT '';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'global_partners_beds_range') THEN
    ALTER TABLE public.global_partners ADD CONSTRAINT global_partners_beds_range
      CHECK ((beds_male IS NULL OR beds_male BETWEEN 0 AND 999) AND (beds_female IS NULL OR beds_female BETWEEN 0 AND 999));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'global_partners_admissions_contact_length') THEN
    ALTER TABLE public.global_partners ADD CONSTRAINT global_partners_admissions_contact_length
      CHECK (length(admissions_contact_name) <= 120 AND length(admissions_contact_phone) <= 40);
  END IF;
END $$;

COMMENT ON COLUMN public.global_partners.beds_male IS
  'Open beds for men today. NULL = unknown, 0 = full. Written only by set_listing_beds; never copied to partners.';
COMMENT ON COLUMN public.global_partners.beds_female IS
  'Open beds for women today. NULL = unknown, 0 = full. Written only by set_listing_beds; never copied to partners.';
COMMENT ON COLUMN public.global_partners.beds_updated_at IS
  'When the bed counts were last confirmed. Older than bed_stale_days() shows as Unconfirmed.';

-- ===========================================================================
-- 2. Constants and helpers
-- ===========================================================================

-- The one place the staleness window lives. src/lib/beds.ts mirrors it and
-- scripts/bed-availability-test.mjs asserts the two agree.
CREATE OR REPLACE FUNCTION public.bed_stale_days()
RETURNS integer
LANGUAGE sql IMMUTABLE
AS $$ SELECT 7 $$;
REVOKE ALL ON FUNCTION public.bed_stale_days() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bed_stale_days() TO authenticated;

-- Which listings carry beds: treatment programs by type. Stricter than
-- partner_is_directory_program (an untyped listing does not carry beds).
CREATE OR REPLACE FUNCTION public.listing_carries_beds(p_types text[])
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  SELECT coalesce(p_types, '{}'::text[]) && ARRAY['Inpatient', 'IOP / PHP', 'Sober Living', 'Detox']::text[]
$$;
REVOKE ALL ON FUNCTION public.listing_carries_beds(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.listing_carries_beds(text[]) TO authenticated;

-- Stale = never confirmed, or confirmed more than bed_stale_days() ago.
-- p_now is a parameter so a test can hold the clock still.
CREATE OR REPLACE FUNCTION public.listing_beds_stale(p_updated_at timestamptz, p_now timestamptz DEFAULT now())
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  SELECT p_updated_at IS NULL OR p_updated_at < p_now - make_interval(days => public.bed_stale_days())
$$;
REVOKE ALL ON FUNCTION public.listing_beds_stale(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.listing_beds_stale(timestamptz, timestamptz) TO authenticated;

-- The search filter rule for one gender: a listing is excluded only when its
-- count for that gender is known AND is either zero or stale. Unknown stays.
CREATE OR REPLACE FUNCTION public.listing_bed_excluded(p_male integer, p_female integer, p_updated_at timestamptz, p_for text)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT (CASE WHEN p_for = 'men' THEN p_male WHEN p_for = 'women' THEN p_female END) IS NOT NULL
     AND ((CASE WHEN p_for = 'men' THEN p_male ELSE p_female END) = 0
          OR public.listing_beds_stale(p_updated_at))
$$;
REVOKE ALL ON FUNCTION public.listing_bed_excluded(integer, integer, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.listing_bed_excluded(integer, integer, timestamptz, text) TO authenticated;

-- ===========================================================================
-- 3. History (the audit trail)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.listing_bed_updates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_partner_id uuid NOT NULL REFERENCES public.global_partners(id) ON DELETE CASCADE,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  beds_male         integer,
  beds_female       integer,
  updated_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS listing_bed_updates_listing_idx
  ON public.listing_bed_updates (global_partner_id, updated_at DESC);

ALTER TABLE public.listing_bed_updates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "listing_bed_updates: admin or claimant read" ON public.listing_bed_updates;
CREATE POLICY "listing_bed_updates: admin or claimant read" ON public.listing_bed_updates
  FOR SELECT USING (
    (SELECT public.is_platform_admin())
    OR public.global_listing_claimed_by_caller(global_partner_id)
  );
REVOKE ALL ON TABLE public.listing_bed_updates FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.listing_bed_updates TO authenticated;

-- "Usually updates beds within N days": the ceiling of the mean gap between
-- the last six updates (five gaps), at least 1. NULL with fewer than three
-- updates, so a brand-new program earns no badge yet. SECURITY DEFINER
-- because the badge is public while the history is not.
CREATE OR REPLACE FUNCTION public.listing_bed_cadence_days(p_global_id uuid)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH recent AS (
    SELECT u.updated_at FROM public.listing_bed_updates u
     WHERE u.global_partner_id = p_global_id
     ORDER BY u.updated_at DESC
     LIMIT 6
  ), gaps AS (
    SELECT extract(epoch FROM (r.updated_at - lag(r.updated_at) OVER (ORDER BY r.updated_at))) / 86400.0 AS days
      FROM recent r
  )
  SELECT CASE WHEN (SELECT count(*) FROM recent) < 3 THEN NULL
              ELSE greatest(1, ceil(avg(g.days)))::integer END
    FROM gaps g
   WHERE g.days IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public.listing_bed_cadence_days(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.listing_bed_cadence_days(uuid) TO authenticated;

-- ===========================================================================
-- 4. Bed columns change only through the RPC
-- ===========================================================================

-- A center can UPDATE its own listing row directly (center update own
-- policy). The bed columns are the exception: they change only through
-- set_listing_beds, so every change is stamped, written to the history, and
-- fans out as a push. The column-level UPDATE grant from 20260820033721
-- already leaves the new columns out for the authenticated role; this guard
-- is the second line, so a wider grant later cannot quietly reopen them.
-- Definer paths with no signed-in user are unaffected.
CREATE OR REPLACE FUNCTION public.guard_global_partner_beds()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF coalesce(current_setting('referralfit.beds_rpc', true), '') = 'on' OR auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.beds_male IS DISTINCT FROM OLD.beds_male
     OR NEW.beds_female IS DISTINCT FROM OLD.beds_female
     OR NEW.beds_updated_at IS DISTINCT FROM OLD.beds_updated_at
     OR NEW.beds_updated_by IS DISTINCT FROM OLD.beds_updated_by
     OR NEW.admissions_contact_name IS DISTINCT FROM OLD.admissions_contact_name
     OR NEW.admissions_contact_phone IS DISTINCT FROM OLD.admissions_contact_phone THEN
    RAISE EXCEPTION 'Bed counts and the admissions contact change only through set_listing_beds' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.guard_global_partner_beds() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS global_partners_guard_beds ON public.global_partners;
CREATE TRIGGER global_partners_guard_beds
  BEFORE UPDATE ON public.global_partners
  FOR EACH ROW EXECUTE FUNCTION public.guard_global_partner_beds();

-- ===========================================================================
-- 5. Push: the bed_opened kind (opt-in, default off)
-- ===========================================================================

ALTER TABLE public.notification_preferences ADD COLUMN IF NOT EXISTS bed_opened boolean NOT NULL DEFAULT false;

ALTER TABLE public.notification_outbox DROP CONSTRAINT IF EXISTS notification_outbox_kind_check;
ALTER TABLE public.notification_outbox ADD CONSTRAINT notification_outbox_kind_check
  CHECK (kind IN ('new_lead', 'assigned_to_me', 'overdue_mine', 'directory_decision', 'directory_submission', 'bed_opened'));

-- Same as 20261001140000 plus the bed_opened wording. Generic: no program
-- name, no count. The app opens the listing from the id in data.
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
           ELSE 'Open ReferralFit.' END;
$$;
REVOKE ALL ON FUNCTION public.notification_copy(text, jsonb) FROM PUBLIC, anon, authenticated;

-- Same as 20261001140000 plus the bed_opened branch.
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

-- Followers of a listing: every member of a workspace that favorited it or
-- imported it into its network. notify_enqueue applies each member's own
-- opt-in, so this reaches only people who asked.
CREATE OR REPLACE FUNCTION public.notify_bed_followers(p_global_id uuid, p_except uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member record;
  v_count integer := 0;
BEGIN
  FOR v_member IN
    SELECT DISTINCT m.user_id
      FROM public.org_members m
     WHERE m.org_id IN (
             SELECT f.org_id FROM public.user_favorites f
              WHERE f.target_type = 'global_partner' AND f.target_id = p_global_id
             UNION
             SELECT p.org_id FROM public.partners p WHERE p.global_partner_id = p_global_id
           )
  LOOP
    IF p_except IS NULL OR v_member.user_id <> p_except THEN
      IF public.notify_enqueue(v_member.user_id, 'bed_opened', jsonb_build_object('global_partner_id', p_global_id)) THEN
        v_count := v_count + 1;
      END IF;
    END IF;
  END LOOP;
  RETURN v_count;
END
$$;
REVOKE ALL ON FUNCTION public.notify_bed_followers(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ===========================================================================
-- 6. The write: set_listing_beds
-- ===========================================================================

-- Who: a claimant of the listing (center member, or a member of the
-- workspace that owns it as its profile) or a platform admin. What: both
-- counts (NULL = unknown, 0 = full) and the admissions contact, as a whole.
-- Every call stamps beds_updated_at, writes one history row, and leaves
-- verification exactly as it was. A gender moving from 0 / unknown to open
-- queues bed_opened for opted-in followers.
CREATE OR REPLACE FUNCTION public.set_listing_beds(
  p_global_id uuid,
  p_beds_male integer,
  p_beds_female integer,
  p_contact_name text,
  p_contact_phone text
)
RETURNS TABLE (beds_male integer, beds_female integer, beds_updated_at timestamptz, beds_stale boolean, beds_cadence_days integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_row public.global_partners%ROWTYPE;
  v_now timestamptz := now();
  v_prev_pub text := coalesce(current_setting('referralfit.seed_publish', true), '');
  v_name text := left(btrim(coalesce(p_contact_name, '')), 120);
  v_phone text := left(btrim(coalesce(p_contact_phone, '')), 40);
  v_opened boolean;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO v_row FROM public.global_partners g WHERE g.id = p_global_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Directory listing not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.is_platform_admin() AND NOT public.global_listing_claimed_by_caller(p_global_id) THEN
    RAISE EXCEPTION 'Only the program that claimed this listing or a platform admin can update its beds' USING ERRCODE = '42501';
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
     SET beds_male = p_beds_male,
         beds_female = p_beds_female,
         beds_updated_at = v_now,
         beds_updated_by = v_user,
         admissions_contact_name = v_name,
         admissions_contact_phone = v_phone
   WHERE g.id = p_global_id;
  PERFORM set_config('referralfit.seed_publish', v_prev_pub, true);
  PERFORM set_config('referralfit.beds_rpc', '', true);

  INSERT INTO public.listing_bed_updates (global_partner_id, updated_at, beds_male, beds_female, updated_by)
  VALUES (p_global_id, v_now, p_beds_male, p_beds_female, v_user);

  IF v_opened THEN
    PERFORM public.notify_bed_followers(p_global_id, v_user);
  END IF;

  RETURN QUERY SELECT p_beds_male, p_beds_female, v_now, false, public.listing_bed_cadence_days(p_global_id);
END
$$;
REVOKE ALL ON FUNCTION public.set_listing_beds(uuid, integer, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_listing_beds(uuid, integer, integer, text, text) TO authenticated;

-- ===========================================================================
-- 7. Reads
-- ===========================================================================

-- Bed status for a set of listings (match results read it for linked
-- partners; the portal reads its own). SECURITY INVOKER: RLS on
-- global_partners decides what the caller may see.
CREATE OR REPLACE FUNCTION public.fetch_listing_beds(p_ids uuid[])
RETURNS TABLE (
  global_partner_id uuid, program boolean, beds_male integer, beds_female integer,
  beds_updated_at timestamptz, beds_stale boolean, beds_cadence_days integer,
  admissions_contact_name text, admissions_contact_phone text
)
LANGUAGE sql STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT g.id, public.listing_carries_beds(g.types), g.beds_male, g.beds_female, g.beds_updated_at,
         public.listing_beds_stale(g.beds_updated_at), public.listing_bed_cadence_days(g.id),
         g.admissions_contact_name, g.admissions_contact_phone
    FROM public.global_partners g
   WHERE g.id = ANY (coalesce(p_ids, '{}'::uuid[]))
$$;
REVOKE ALL ON FUNCTION public.fetch_listing_beds(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fetch_listing_beds(uuid[]) TO authenticated;

-- Same query as 20260928170000 plus bed columns in the output and an
-- optional p_bed_for ('men' | 'women'; anything else means no filter) that
-- keeps unknown counts in but drops a confirmed 0 and a stale count. The
-- return type changes, hence DROP + CREATE; the new parameter is appended
-- last so positional callers are unaffected.
DROP FUNCTION IF EXISTS public.search_global_partners(text, text, text[], text[], text[], integer, integer, text[]);
CREATE OR REPLACE FUNCTION public.search_global_partners(
  p_query text DEFAULT NULL,
  p_state text DEFAULT NULL,
  p_levels text[] DEFAULT NULL,
  p_insurance text[] DEFAULT NULL,
  p_populations text[] DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_types text[] DEFAULT NULL,
  p_bed_for text DEFAULT NULL
)
RETURNS TABLE (
  id uuid, name text, organization text, types text[], city text, state text, regions text[],
  phone text, email text, website text, monthly_cost integer, insurance text[],
  insurance_networks jsonb, therapies text[], populations text[], levels text[],
  description text, verified_at timestamptz, verification_expires_at timestamptz,
  verified_current boolean, updated_at timestamptz, rank real, claimed boolean,
  beds_male integer, beds_female integer, beds_updated_at timestamptz, beds_stale boolean,
  beds_cadence_days integer, admissions_contact_name text, admissions_contact_phone text
)
LANGUAGE sql STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
  WITH q AS (
    SELECT nullif(btrim(coalesce(p_query, '')), '') AS text
  )
  SELECT g.id, g.name, g.organization, g.types, g.city, g.state, g.regions,
         g.phone, g.email, g.website, g.monthly_cost, g.insurance,
         g.insurance_networks, g.therapies, g.populations, g.levels,
         g.description, g.verified_at,
         (g.verified_at + INTERVAL '12 months') AS verification_expires_at,
         (g.verified_at IS NOT NULL AND g.verified_at + INTERVAL '12 months' > now()) AS verified_current,
         g.updated_at,
         CASE WHEN q.text IS NULL THEN 0::real
              ELSE greatest(similarity(g.organization, q.text), similarity(g.name, q.text),
                            ts_rank(g.search_tsv, plainto_tsquery('simple', q.text)))::real
         END AS rank,
         public.global_listing_is_claimed(g.id) AS claimed,
         g.beds_male, g.beds_female, g.beds_updated_at,
         public.listing_beds_stale(g.beds_updated_at) AS beds_stale,
         public.listing_bed_cadence_days(g.id) AS beds_cadence_days,
         g.admissions_contact_name, g.admissions_contact_phone
    FROM public.global_partners g, q
   WHERE g.status = 'active'
     AND (p_state IS NULL OR p_state = '' OR g.state = p_state)
     AND (p_levels IS NULL OR g.levels && p_levels)
     AND (p_insurance IS NULL OR g.insurance && p_insurance)
     AND (p_populations IS NULL OR g.populations && p_populations)
     AND (p_types IS NULL OR cardinality(p_types) = 0 OR g.types && p_types)
     AND (p_bed_for IS NULL OR p_bed_for NOT IN ('men', 'women')
          OR NOT public.listing_bed_excluded(g.beds_male, g.beds_female, g.beds_updated_at, p_bed_for))
     AND (q.text IS NULL
          OR g.search_tsv @@ plainto_tsquery('simple', q.text)
          OR g.organization % q.text
          OR g.name % q.text
          OR g.organization ILIKE '%' || q.text || '%')
   ORDER BY rank DESC, g.state, g.organization, g.name, g.id
   LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
  OFFSET greatest(coalesce(p_offset, 0), 0)
$$;
REVOKE ALL ON FUNCTION public.search_global_partners(text, text, text[], text[], text[], integer, integer, text[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_global_partners(text, text, text[], text[], text[], integer, integer, text[], text) TO authenticated;

COMMIT;
