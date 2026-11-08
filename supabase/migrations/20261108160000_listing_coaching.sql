-- Hourly coaching on an interventionist's or therapist's directory profile:
-- whether they offer it, the hourly rate, and a short note. Shown on their
-- Directory card and to programs choosing whom to refer a family to.
--
--   1. Three columns on global_partners. Clients hold no UPDATE grant on
--      them (the column-level grant from 20260820033721 predates them), so
--      the only write path is set_listing_coaching.
--   2. set_listing_coaching: the owner of the workspace whose profile it is,
--      or a platform admin. Only listings that are not programs. A rate is
--      required when coaching is offered. Verification is left as it is.
--   3. fetch_listing_coaching: the coaching of active listings, for any
--      signed-in reader (practices in the Directory, programs in the portal).
--
-- Never part of matching or ranking. Transit-safe: ASCII only, no
-- backslashes, every statement under 3,700 characters.

BEGIN;

ALTER TABLE public.global_partners ADD COLUMN IF NOT EXISTS coaching_offered boolean NOT NULL DEFAULT false;
ALTER TABLE public.global_partners ADD COLUMN IF NOT EXISTS coaching_hourly_rate integer;
ALTER TABLE public.global_partners ADD COLUMN IF NOT EXISTS coaching_note text NOT NULL DEFAULT '';
ALTER TABLE public.global_partners DROP CONSTRAINT IF EXISTS global_partners_coaching_check;
ALTER TABLE public.global_partners ADD CONSTRAINT global_partners_coaching_check
  CHECK ((coaching_hourly_rate IS NULL OR coaching_hourly_rate BETWEEN 1 AND 5000)
         AND length(coaching_note) <= 200
         AND (NOT coaching_offered OR coaching_hourly_rate IS NOT NULL));
REVOKE UPDATE (coaching_offered, coaching_hourly_rate, coaching_note) ON public.global_partners FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_listing_coaching(p_global_id uuid, p_offered boolean, p_hourly_rate integer, p_note text)
RETURNS TABLE (coaching_offered boolean, coaching_hourly_rate integer, coaching_note text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_row public.global_partners%ROWTYPE;
  v_note text := left(btrim(coalesce(p_note, '')), 200);
  v_prev_pub text := coalesce(current_setting('referralfit.seed_publish', true), '');
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO v_row FROM public.global_partners g WHERE g.id = p_global_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Directory listing not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.is_platform_admin()
     AND NOT (v_row.owner_org_id IS NOT NULL AND v_row.owner_org_id = public.current_org_id()
              AND public.current_org_role() = 'owner') THEN
    RAISE EXCEPTION 'Only the workspace owner can change this profile' USING ERRCODE = '42501';
  END IF;
  IF public.listing_is_program(v_row.types) THEN
    RAISE EXCEPTION 'Hourly coaching is for interventionists and therapists' USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_offered, false) AND (p_hourly_rate IS NULL OR p_hourly_rate NOT BETWEEN 1 AND 5000) THEN
    RAISE EXCEPTION 'Add an hourly rate between $1 and $5,000' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('referralfit.seed_publish', 'on', true);
  UPDATE public.global_partners g
     SET coaching_offered = coalesce(p_offered, false),
         coaching_hourly_rate = CASE WHEN coalesce(p_offered, false) THEN p_hourly_rate ELSE g.coaching_hourly_rate END,
         coaching_note = v_note
   WHERE g.id = p_global_id;
  PERFORM set_config('referralfit.seed_publish', v_prev_pub, true);
  RETURN QUERY SELECT g.coaching_offered, g.coaching_hourly_rate, g.coaching_note FROM public.global_partners g WHERE g.id = p_global_id;
END
$$;
REVOKE ALL ON FUNCTION public.set_listing_coaching(uuid, boolean, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_listing_coaching(uuid, boolean, integer, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.fetch_listing_coaching(p_ids uuid[])
RETURNS TABLE (global_partner_id uuid, coaching_offered boolean, coaching_hourly_rate integer, coaching_note text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT g.id, g.coaching_offered, g.coaching_hourly_rate, g.coaching_note
    FROM public.global_partners g
   WHERE auth.uid() IS NOT NULL
     AND g.id = ANY (coalesce(p_ids, '{}'::uuid[]))
     AND g.status = 'active'
   LIMIT 200
$$;
REVOKE ALL ON FUNCTION public.fetch_listing_coaching(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fetch_listing_coaching(uuid[]) TO authenticated;

COMMIT;
