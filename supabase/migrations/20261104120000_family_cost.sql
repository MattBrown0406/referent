-- ReferralFit - true cost to the family (2026-11-04).
--
-- A benefits check used to record only the network status per program.
-- This migration stores the numbers that decide whether a family can afford
-- a program, so the app can estimate what the family would pay out of pocket
-- (src/lib/family-cost.ts; docs/FAMILY_COST.md):
--
--   1. case_benefits (the family's plan on a case): for in-network and for
--      out-of-network separately, the deductible, the deductible met so far,
--      the out-of-pocket max, the out-of-pocket met so far and the
--      coinsurance percent, plus whether the plan has out-of-network
--      benefits at all (true, false, or null for not known).
--   2. vob_requests (one program's answer): an estimated allowed daily rate,
--      the program's billed daily rate, a per-day copay, and whether the plan
--      needs pre-authorization (true, false, or null for not known).
--   3. save_case_benefits and update_vob_status accept the new values as
--      extra keys of the p_patch they already take. Their signatures and
--      return columns are unchanged, so the 1.0.4 app (which never sends the
--      new keys) keeps working: a key it does not send is left alone.
--
-- Every new column is ADD COLUMN ... DEFAULT NULL: existing rows read as
-- "not entered", which the app shows as unknown, never as $0. Whole dollars
-- only (the app parses with parseWholeDollars and never sends cents).
-- Nothing here reaches the directory, the portal, a push payload, an
-- aggregate or a program: the family's numbers stay in the case file under
-- the workspace RLS, and the program's copy of a packet never carries them.
-- The estimate is computed in the app and never touches matching scores.
--
-- Transit rule: this file is pasted into the SQL editor from a chat client.
-- ASCII only, no backslash characters anywhere, every top-level statement
-- under 3,700 characters.

BEGIN;

-- ===========================================================================
-- 1. Columns
-- ===========================================================================

-- The plan's cost sharing. NULL is "not entered". A met amount can never be
-- more than its total; a plan with no out-of-network benefits carries no
-- out-of-network amounts.
ALTER TABLE public.case_benefits
  ADD COLUMN IF NOT EXISTS in_deductible       integer DEFAULT NULL CHECK (in_deductible BETWEEN 0 AND 1000000),
  ADD COLUMN IF NOT EXISTS in_deductible_met   integer DEFAULT NULL CHECK (in_deductible_met BETWEEN 0 AND 1000000),
  ADD COLUMN IF NOT EXISTS in_oop_max          integer DEFAULT NULL CHECK (in_oop_max BETWEEN 0 AND 1000000),
  ADD COLUMN IF NOT EXISTS in_oop_met          integer DEFAULT NULL CHECK (in_oop_met BETWEEN 0 AND 1000000),
  ADD COLUMN IF NOT EXISTS in_coinsurance_pct  integer DEFAULT NULL CHECK (in_coinsurance_pct BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS oon_benefits        boolean DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS oon_deductible      integer DEFAULT NULL CHECK (oon_deductible BETWEEN 0 AND 1000000),
  ADD COLUMN IF NOT EXISTS oon_deductible_met  integer DEFAULT NULL CHECK (oon_deductible_met BETWEEN 0 AND 1000000),
  ADD COLUMN IF NOT EXISTS oon_oop_max         integer DEFAULT NULL CHECK (oon_oop_max BETWEEN 0 AND 1000000),
  ADD COLUMN IF NOT EXISTS oon_oop_met         integer DEFAULT NULL CHECK (oon_oop_met BETWEEN 0 AND 1000000),
  ADD COLUMN IF NOT EXISTS oon_coinsurance_pct integer DEFAULT NULL CHECK (oon_coinsurance_pct BETWEEN 0 AND 100);

ALTER TABLE public.case_benefits
  DROP CONSTRAINT IF EXISTS case_benefits_met_within_total,
  ADD CONSTRAINT case_benefits_met_within_total CHECK (
    (in_deductible_met IS NULL OR in_deductible IS NULL OR in_deductible_met <= in_deductible)
    AND (in_oop_met IS NULL OR in_oop_max IS NULL OR in_oop_met <= in_oop_max)
    AND (oon_deductible_met IS NULL OR oon_deductible IS NULL OR oon_deductible_met <= oon_deductible)
    AND (oon_oop_met IS NULL OR oon_oop_max IS NULL OR oon_oop_met <= oon_oop_max)),
  DROP CONSTRAINT IF EXISTS case_benefits_oon_amounts_need_benefits,
  ADD CONSTRAINT case_benefits_oon_amounts_need_benefits CHECK (
    oon_benefits IS DISTINCT FROM false
    OR num_nonnulls(oon_deductible, oon_deductible_met, oon_oop_max, oon_oop_met, oon_coinsurance_pct) = 0);

COMMENT ON COLUMN public.case_benefits.in_coinsurance_pct IS
  'In-network coinsurance: the percent of the allowed cost the family pays after the deductible, 0 to 100. NULL is not entered.';
COMMENT ON COLUMN public.case_benefits.oon_benefits IS
  'Whether the plan pays anything out-of-network: true, false (the family pays the full cost), or NULL (not known).';

-- One program's answer: what the stay costs per day and what the plan needs.
-- An allowed or billed rate is at least $1 (a 0 would read as a free stay;
-- not known is NULL). A copay of 0 is a real "no copay".
ALTER TABLE public.vob_requests
  ADD COLUMN IF NOT EXISTS allowed_daily_rate integer DEFAULT NULL CHECK (allowed_daily_rate BETWEEN 1 AND 100000),
  ADD COLUMN IF NOT EXISTS billed_daily_rate  integer DEFAULT NULL CHECK (billed_daily_rate BETWEEN 1 AND 100000),
  ADD COLUMN IF NOT EXISTS copay_per_day      integer DEFAULT NULL CHECK (copay_per_day BETWEEN 0 AND 100000),
  ADD COLUMN IF NOT EXISTS precert_required   boolean DEFAULT NULL;

COMMENT ON COLUMN public.vob_requests.allowed_daily_rate IS
  'Estimated amount the plan allows per day at this program, whole dollars. NULL is not known.';
COMMENT ON COLUMN public.vob_requests.billed_daily_rate IS
  'What the program bills per day, whole dollars. Out-of-network, billed minus allowed may be balance-billed to the family. NULL is not known.';

-- ===========================================================================
-- 2. Patch helpers (internal: only the SECURITY DEFINER callers run them)
-- ===========================================================================

-- A whole number from a patch key: NULL when the key is missing, JSON null
-- or blank; otherwise digits only, from 0 to p_max, or a plain-words error.
CREATE OR REPLACE FUNCTION public.patch_whole_number(p_patch jsonb, p_key text, p_label text, p_max integer)
RETURNS integer
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v text := btrim(coalesce(p_patch ->> p_key, ''));
BEGIN
  IF v = '' THEN
    RETURN NULL;
  END IF;
  IF v !~ '^[0-9]{1,9}$' OR v::bigint > p_max THEN
    RAISE EXCEPTION '% must be a whole number from 0 to %', p_label, p_max USING ERRCODE = '22023';
  END IF;
  RETURN v::integer;
END
$$;
REVOKE ALL ON FUNCTION public.patch_whole_number(jsonb, text, text, integer) FROM PUBLIC, anon, authenticated;

-- Yes / no / not known from a patch key: JSON true, false, or null (or a
-- missing key) for not known. Anything else is refused.
CREATE OR REPLACE FUNCTION public.patch_tristate(p_patch jsonb, p_key text, p_label text)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v jsonb := p_patch -> p_key;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(v) <> 'boolean' THEN
    RAISE EXCEPTION '% must be yes, no or not known', p_label USING ERRCODE = '22023';
  END IF;
  RETURN (p_patch ->> p_key)::boolean;
END
$$;
REVOKE ALL ON FUNCTION public.patch_tristate(jsonb, text, text) FROM PUBLIC, anon, authenticated;

-- The plan row with a patch's cost keys applied (keys it does not carry keep
-- their stored value), checked as a whole: a met amount above its total, or
-- an out-of-network amount on a plan with no out-of-network benefits, is
-- refused in plain words. Keys: in_ and oon_ deductible, deductible_met,
-- oop_max, oop_met (whole dollars) and coinsurance_pct (0 to 100), and
-- oon_benefits (true, false or null).
CREATE OR REPLACE FUNCTION public.case_benefits_merge_costs(p_row public.case_benefits, p_patch jsonb)
RETURNS public.case_benefits
LANGUAGE plpgsql IMMUTABLE
SET search_path = public
AS $$
DECLARE
  n public.case_benefits := p_row;
  v_max constant integer := 1000000;
BEGIN
  IF p_patch ? 'in_deductible' THEN n.in_deductible := public.patch_whole_number(p_patch, 'in_deductible', 'The in-network deductible', v_max); END IF;
  IF p_patch ? 'in_deductible_met' THEN n.in_deductible_met := public.patch_whole_number(p_patch, 'in_deductible_met', 'The in-network deductible met', v_max); END IF;
  IF p_patch ? 'in_oop_max' THEN n.in_oop_max := public.patch_whole_number(p_patch, 'in_oop_max', 'The in-network out-of-pocket max', v_max); END IF;
  IF p_patch ? 'in_oop_met' THEN n.in_oop_met := public.patch_whole_number(p_patch, 'in_oop_met', 'The in-network out-of-pocket met', v_max); END IF;
  IF p_patch ? 'in_coinsurance_pct' THEN n.in_coinsurance_pct := public.patch_whole_number(p_patch, 'in_coinsurance_pct', 'In-network coinsurance', 100); END IF;
  IF p_patch ? 'oon_benefits' THEN n.oon_benefits := public.patch_tristate(p_patch, 'oon_benefits', 'Out-of-network benefits'); END IF;
  IF p_patch ? 'oon_deductible' THEN n.oon_deductible := public.patch_whole_number(p_patch, 'oon_deductible', 'The out-of-network deductible', v_max); END IF;
  IF p_patch ? 'oon_deductible_met' THEN n.oon_deductible_met := public.patch_whole_number(p_patch, 'oon_deductible_met', 'The out-of-network deductible met', v_max); END IF;
  IF p_patch ? 'oon_oop_max' THEN n.oon_oop_max := public.patch_whole_number(p_patch, 'oon_oop_max', 'The out-of-network out-of-pocket max', v_max); END IF;
  IF p_patch ? 'oon_oop_met' THEN n.oon_oop_met := public.patch_whole_number(p_patch, 'oon_oop_met', 'The out-of-network out-of-pocket met', v_max); END IF;
  IF p_patch ? 'oon_coinsurance_pct' THEN n.oon_coinsurance_pct := public.patch_whole_number(p_patch, 'oon_coinsurance_pct', 'Out-of-network coinsurance', 100); END IF;

  IF n.in_deductible_met > n.in_deductible OR n.oon_deductible_met > n.oon_deductible THEN
    RAISE EXCEPTION 'The deductible met so far cannot be more than the deductible' USING ERRCODE = '22023';
  END IF;
  IF n.in_oop_met > n.in_oop_max OR n.oon_oop_met > n.oon_oop_max THEN
    RAISE EXCEPTION 'The out-of-pocket met so far cannot be more than the out-of-pocket max' USING ERRCODE = '22023';
  END IF;
  IF n.oon_benefits = false
     AND num_nonnulls(n.oon_deductible, n.oon_deductible_met, n.oon_oop_max, n.oon_oop_met, n.oon_coinsurance_pct) > 0 THEN
    RAISE EXCEPTION 'A plan with no out-of-network benefits has no out-of-network amounts' USING ERRCODE = '22023';
  END IF;
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION public.case_benefits_merge_costs(public.case_benefits, jsonb) FROM PUBLIC, anon, authenticated;

-- Stores the patch's cost keys on the case's plan row (save_case_benefits
-- upserts the row first). Returns true when a stored value changed.
CREATE OR REPLACE FUNCTION public.case_benefits_apply_costs(p_case_id uuid, p_org uuid, p_patch jsonb)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  o public.case_benefits;
  n public.case_benefits;
BEGIN
  SELECT * INTO o FROM public.case_benefits b WHERE b.case_id = p_case_id AND b.org_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  n := public.case_benefits_merge_costs(o, p_patch);
  IF n IS NOT DISTINCT FROM o THEN
    RETURN false;
  END IF;
  UPDATE public.case_benefits b
     SET (in_deductible, in_deductible_met, in_oop_max, in_oop_met, in_coinsurance_pct, oon_benefits,
          oon_deductible, oon_deductible_met, oon_oop_max, oon_oop_met, oon_coinsurance_pct)
       = (n.in_deductible, n.in_deductible_met, n.in_oop_max, n.in_oop_met, n.in_coinsurance_pct, n.oon_benefits,
          n.oon_deductible, n.oon_deductible_met, n.oon_oop_max, n.oon_oop_met, n.oon_coinsurance_pct)
   WHERE b.case_id = p_case_id AND b.org_id = p_org;
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.case_benefits_apply_costs(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- Stores a VOB answer's cost keys (allowed_daily_rate, billed_daily_rate:
-- whole dollars from 1, or null; copay_per_day: whole dollars from 0, or
-- null; precert_required: true, false or null). Keys the patch does not
-- carry keep their stored value.
CREATE OR REPLACE FUNCTION public.vob_requests_apply_costs(p_id uuid, p_org uuid, p_patch jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_allowed integer;
  v_billed integer;
BEGIN
  IF NOT (p_patch ?| ARRAY['allowed_daily_rate', 'billed_daily_rate', 'copay_per_day', 'precert_required']) THEN
    RETURN;
  END IF;
  v_allowed := public.patch_whole_number(p_patch, 'allowed_daily_rate', 'The allowed rate per day', 100000);
  v_billed := public.patch_whole_number(p_patch, 'billed_daily_rate', 'The billed rate per day', 100000);
  IF v_allowed = 0 OR v_billed = 0 THEN
    RAISE EXCEPTION 'Enter the daily rate in dollars, or leave it blank if you do not know it.' USING ERRCODE = '22023';
  END IF;
  UPDATE public.vob_requests r
     SET allowed_daily_rate = CASE WHEN p_patch ? 'allowed_daily_rate' THEN v_allowed ELSE r.allowed_daily_rate END,
         billed_daily_rate = CASE WHEN p_patch ? 'billed_daily_rate' THEN v_billed ELSE r.billed_daily_rate END,
         copay_per_day = CASE WHEN p_patch ? 'copay_per_day'
           THEN public.patch_whole_number(p_patch, 'copay_per_day', 'The copay per day', 100000) ELSE r.copay_per_day END,
         precert_required = CASE WHEN p_patch ? 'precert_required'
           THEN public.patch_tristate(p_patch, 'precert_required', 'Pre-authorization required') ELSE r.precert_required END
   WHERE r.id = p_id AND r.org_id = p_org;
END
$$;
REVOKE ALL ON FUNCTION public.vob_requests_apply_costs(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- 3. save_case_benefits, from its latest definition (20261001170000). Same
-- signature, return columns and wording; it also stores the cost keys. A
-- change to them alone is an "Insurance plan updated" entry (amounts never
-- go on the timeline).
CREATE OR REPLACE FUNCTION public.save_case_benefits(p_case_id uuid, p_patch jsonb, p_event_id uuid)
RETURNS TABLE (carrier text, plan_name text, member_id_last4 text, subscriber_relationship text, event_body text, occurred_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_user uuid := auth.uid();
  v_org uuid := public.current_org_id();
  v_old public.case_benefits;
  v_new public.case_benefits;
  v_last4 text;
  v_costs boolean;
  v_body text := '';
  v_now timestamptz := now();
BEGIN
  IF v_user IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cases c WHERE c.id = p_case_id AND c.org_id = v_org) THEN
    RAISE EXCEPTION 'Case not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_patch ? 'member_id_last4' THEN
    v_last4 := btrim(coalesce(p_patch ->> 'member_id_last4', ''));
    IF v_last4 <> '' AND length(v_last4) <> 4 THEN
      RAISE EXCEPTION 'Only the last four characters of the member id are stored' USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT * INTO v_old FROM public.case_benefits b WHERE b.case_id = p_case_id AND b.org_id = v_org;

  INSERT INTO public.case_benefits (case_id, owner_id, org_id, carrier, plan_name, member_id_last4, subscriber_relationship)
  VALUES (p_case_id, v_user, v_org,
          left(btrim(coalesce(p_patch ->> 'carrier', '')), 120),
          left(btrim(coalesce(p_patch ->> 'plan_name', '')), 120),
          coalesce(v_last4, ''),
          coalesce(p_patch ->> 'subscriber_relationship', ''))
  ON CONFLICT (case_id) DO UPDATE SET
    carrier = CASE WHEN p_patch ? 'carrier' THEN EXCLUDED.carrier ELSE public.case_benefits.carrier END,
    plan_name = CASE WHEN p_patch ? 'plan_name' THEN EXCLUDED.plan_name ELSE public.case_benefits.plan_name END,
    member_id_last4 = CASE WHEN p_patch ? 'member_id_last4' THEN EXCLUDED.member_id_last4 ELSE public.case_benefits.member_id_last4 END,
    subscriber_relationship = CASE WHEN p_patch ? 'subscriber_relationship' THEN EXCLUDED.subscriber_relationship ELSE public.case_benefits.subscriber_relationship END
  RETURNING * INTO v_new;
  v_costs := public.case_benefits_apply_costs(p_case_id, v_org, p_patch);

  IF v_old IS NULL OR v_costs OR (v_old.carrier, v_old.plan_name, v_old.member_id_last4, v_old.subscriber_relationship)
     IS DISTINCT FROM (v_new.carrier, v_new.plan_name, v_new.member_id_last4, v_new.subscriber_relationship) THEN
    v_body := 'Insurance plan ' || CASE WHEN v_old IS NULL THEN 'added' ELSE 'updated' END
      || CASE WHEN v_new.carrier <> '' THEN ': ' || v_new.carrier ELSE '' END
      || CASE WHEN v_new.plan_name <> '' THEN ' ' || v_new.plan_name ELSE '' END
      || CASE WHEN v_new.subscriber_relationship <> '' THEN ' (subscriber: ' || v_new.subscriber_relationship || ')' ELSE '' END;
    INSERT INTO public.case_events (id, owner_id, org_id, case_id, kind, body, occurred_at)
    VALUES (coalesce(p_event_id, gen_random_uuid()), v_user, v_org, p_case_id, 'system', v_body, v_now)
    ON CONFLICT (id) DO NOTHING;
  END IF;

  RETURN QUERY SELECT v_new.carrier, v_new.plan_name, v_new.member_id_last4, v_new.subscriber_relationship, v_body, v_now;
END
$$;
REVOKE ALL ON FUNCTION public.save_case_benefits(uuid, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_case_benefits(uuid, jsonb, uuid) TO authenticated;

-- 4. update_vob_status, from its latest definition (20261024120000 section
-- 19). Same signature and return columns; it also stores the cost keys,
-- and an answer that needs pre-authorization says so on the timeline.
CREATE OR REPLACE FUNCTION public.update_vob_status(p_id uuid, p_patch jsonb, p_event_id uuid)
RETURNS TABLE (status text, answered_at timestamptz, answered_by text, note text, quoted_out_of_pocket integer, event_body text, occurred_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_user uuid := auth.uid();
  v_org uuid := public.current_org_id();
  v_old public.vob_requests;
  v_new public.vob_requests;
  v_status text;
  v_body text := '';
  v_now timestamptz := now();
BEGIN
  IF v_user IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO v_old FROM public.vob_requests r WHERE r.id = p_id AND r.org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VOB request not found in this workspace' USING ERRCODE = 'P0002';
  END IF;
  v_status := coalesce(nullif(p_patch ->> 'status', ''), v_old.status);
  IF v_status NOT IN ('requested', 'pending', 'in_network', 'out_of_network', 'not_accepted') THEN
    RAISE EXCEPTION 'Unknown VOB status' USING ERRCODE = '22023';
  END IF;
  PERFORM public.vob_requests_apply_costs(p_id, v_org, p_patch);

  UPDATE public.vob_requests r
     SET status = v_status,
         answered_at = CASE WHEN v_status IN ('requested', 'pending') THEN NULL
                            WHEN r.answered_at IS NULL OR r.status <> v_status THEN v_now
                            ELSE r.answered_at END,
         answered_by = CASE WHEN p_patch ? 'answered_by' THEN left(btrim(coalesce(p_patch ->> 'answered_by', '')), 120) ELSE r.answered_by END,
         note = CASE WHEN p_patch ? 'note' THEN left(coalesce(p_patch ->> 'note', ''), 2000) ELSE r.note END,
         quoted_out_of_pocket = CASE WHEN p_patch ? 'quoted_out_of_pocket' THEN nullif(p_patch ->> 'quoted_out_of_pocket', '')::integer ELSE r.quoted_out_of_pocket END
   WHERE r.id = p_id AND r.org_id = v_org
  RETURNING * INTO v_new;

  IF v_new.status <> v_old.status THEN
    v_body := 'VOB ' || public.vob_status_label(v_new.status) || ': ' || v_new.program_name
      || CASE WHEN v_new.quoted_out_of_pocket IS NOT NULL AND v_new.status IN ('in_network', 'out_of_network')
              THEN ', about $' || v_new.quoted_out_of_pocket::text || ' out of pocket' ELSE '' END
      || CASE WHEN v_new.precert_required AND v_new.status IN ('in_network', 'out_of_network')
              THEN ', pre-authorization required' ELSE '' END
      || CASE WHEN v_new.answered_by <> '' AND v_new.answered_at IS NOT NULL THEN ' (per ' || v_new.answered_by || ')' ELSE '' END;
    INSERT INTO public.case_events (id, owner_id, org_id, case_id, kind, body, occurred_at)
    VALUES (coalesce(p_event_id, gen_random_uuid()), v_user, v_org, v_new.case_id, 'system', v_body, v_now)
    ON CONFLICT (id) DO NOTHING;
    IF v_new.answered_at IS NOT NULL THEN
      UPDATE public.follow_ups f SET status = 'done', completed_at = v_now
       WHERE f.org_id = v_org AND f.status = 'open'
         AND (f.id = v_new.follow_up_id
              OR (f.case_id = v_new.case_id AND f.kind = 'waiting_on'
                  AND lower(btrim(f.waiting_on)) = lower(btrim(v_new.program_name))));
    END IF;
  END IF;

  RETURN QUERY SELECT v_new.status, v_new.answered_at, v_new.answered_by, v_new.note, v_new.quoted_out_of_pocket, v_body, v_now;
END
$$;
REVOKE ALL ON FUNCTION public.update_vob_status(uuid, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_vob_status(uuid, jsonb, uuid) TO authenticated;

COMMIT;
