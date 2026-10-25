-- ReferralFit - follow-up outreach: AI-drafted texts, emails and call
-- scripts, sent from the phone's own Messages / Mail / dialer, with the next
-- follow-up set 48 hours after every send. See docs/FOLLOW_UP_OUTREACH.md.
--
--   1. outreach_drafts: one metadata row per AI draft request (who, which
--      channel, which case or partner, when). The drafted text is never
--      stored, and neither is the user's own Anthropic key (it travels with
--      each request only). No client access at all; it exists for the daily
--      cap, which keeps the drafting function from being used as a general
--      proxy.
--   2. claim_outreach_draft(): service-role only (the draft-follow-up Edge
--      Function). Confirms the user belongs to the workspace that holds the
--      case or partner, enforces the per-user daily cap, records the request.
--   3. record_outreach_sent(): one atomic write after a text or email is sent
--      or a call is logged from the outreach sheet. Completes the follow-up
--      the outreach came from (if any), logs the case event and/or partner
--      touch, and creates the next follow-up. A replay from the offline queue
--      is a no-op, and a follow-up deleted in the meantime does not block the
--      log or the next follow-up.

BEGIN;

-- ===========================================================================
-- 1. outreach_drafts
-- ===========================================================================

CREATE TABLE public.outreach_drafts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('call', 'text', 'email')),
  case_id     uuid,
  partner_id  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outreach_drafts_one_target CHECK ((case_id IS NULL) <> (partner_id IS NULL))
);

CREATE INDEX outreach_drafts_user_recent_idx ON public.outreach_drafts (user_id, created_at DESC);

ALTER TABLE public.outreach_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.outreach_drafts FROM PUBLIC, anon, authenticated, service_role;

-- ===========================================================================
-- 2. claim_outreach_draft - the daily cap, checked before the model is called
-- ===========================================================================
-- Returns how many drafts the user has left in the rolling 24 hours after
-- this one. Raises 54000 (program_limit_exceeded) at the cap so the function
-- can answer 429.

CREATE OR REPLACE FUNCTION public.outreach_draft_daily_limit()
RETURNS integer
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$ SELECT 200 $$;
GRANT EXECUTE ON FUNCTION public.outreach_draft_daily_limit() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.claim_outreach_draft(
  p_user_id uuid,
  p_channel text,
  p_case_id uuid,
  p_partner_id uuid
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_used integer;
  v_limit integer := public.outreach_draft_daily_limit();
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'A signed-in user is required' USING ERRCODE = '28000';
  END IF;
  IF p_channel IS NULL OR p_channel NOT IN ('call', 'text', 'email') THEN
    RAISE EXCEPTION 'Unknown outreach channel' USING ERRCODE = '22023';
  END IF;
  IF (p_case_id IS NULL) = (p_partner_id IS NULL) THEN
    RAISE EXCEPTION 'A draft is for exactly one case or one partner' USING ERRCODE = '22023';
  END IF;

  SELECT org_id INTO v_org FROM public.org_members WHERE user_id = p_user_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Workspace membership required' USING ERRCODE = '42501';
  END IF;
  IF p_case_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.cases WHERE id = p_case_id AND org_id = v_org) THEN
    RAISE EXCEPTION 'Case not found in this workspace' USING ERRCODE = 'P0002';
  END IF;
  IF p_partner_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.partners WHERE id = p_partner_id AND org_id = v_org) THEN
    RAISE EXCEPTION 'Partner not found in this workspace' USING ERRCODE = 'P0002';
  END IF;

  -- Serialize per user so two simultaneous requests cannot both slip under
  -- the cap.
  PERFORM pg_advisory_xact_lock(hashtext('outreach_drafts'), hashtext(p_user_id::text));

  SELECT count(*) INTO v_used
    FROM public.outreach_drafts
   WHERE user_id = p_user_id
     AND created_at > now() - interval '24 hours';
  IF v_used >= v_limit THEN
    RAISE EXCEPTION 'Daily AI draft limit reached' USING ERRCODE = '54000';
  END IF;

  INSERT INTO public.outreach_drafts (org_id, user_id, channel, case_id, partner_id)
  VALUES (v_org, p_user_id, p_channel, p_case_id, p_partner_id);

  -- Only the last day matters for the cap; keep a short tail, nothing more.
  DELETE FROM public.outreach_drafts
   WHERE user_id = p_user_id
     AND created_at < now() - interval '30 days';

  RETURN v_limit - v_used - 1;
END
$$;
REVOKE ALL ON FUNCTION public.claim_outreach_draft(uuid, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_outreach_draft(uuid, text, uuid, uuid) TO service_role;

-- ===========================================================================
-- 3. record_outreach_sent - complete + log + next follow-up, atomically
-- ===========================================================================
-- p_completed_id: the follow-up the outreach was started from, or NULL.
-- p_next (required): the next follow-up - id, title, due_on, and optionally
--   due_time, case_id, partner_id, kind, note, assigned_to.
-- p_event: a case_events row (kind call/text/email) - id, case_id, kind,
--   body, contact_id, occurred_at.
-- p_touch: a partner touch (kind call/text/email) - id, partner_id, kind,
--   note, occurred_at.
-- At least one of p_event / p_touch is required: an outreach is always logged.

CREATE OR REPLACE FUNCTION public.record_outreach_sent(
  p_expected_owner_id uuid,
  p_completed_id uuid,
  p_next jsonb,
  p_event jsonb DEFAULT NULL,
  p_touch jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_org_id uuid := public.current_org_id();
  v_has_event boolean := p_event IS NOT NULL AND p_event <> 'null'::jsonb;
  v_has_touch boolean := p_touch IS NOT NULL AND p_touch <> 'null'::jsonb;
BEGIN
  IF v_owner_id IS NULL OR v_owner_id <> p_expected_owner_id THEN
    RAISE EXCEPTION 'Authenticated account changed' USING ERRCODE = '42501';
  END IF;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Workspace membership required' USING ERRCODE = '42501';
  END IF;
  IF p_next IS NULL OR p_next = 'null'::jsonb
     OR nullif(btrim(coalesce(p_next ->> 'title', '')), '') IS NULL
     OR nullif(p_next ->> 'due_on', '') IS NULL THEN
    RAISE EXCEPTION 'The next follow-up needs a title and a due date' USING ERRCODE = '22023';
  END IF;
  IF NOT v_has_event AND NOT v_has_touch THEN
    RAISE EXCEPTION 'A case event or partner touch is required' USING ERRCODE = '22023';
  END IF;
  IF v_has_event AND coalesce(p_event ->> 'kind', '') NOT IN ('call', 'text', 'email') THEN
    RAISE EXCEPTION 'Outreach events are calls, texts, or emails' USING ERRCODE = '22023';
  END IF;
  IF v_has_touch AND coalesce(p_touch ->> 'kind', '') NOT IN ('call', 'text', 'email') THEN
    RAISE EXCEPTION 'Outreach touches are calls, texts, or emails' USING ERRCODE = '22023';
  END IF;

  -- Only an open outreach step (a call, follow-up, or touch) is closed, and
  -- only its status changes. A consult, a waiting-on item, a check-in, or a
  -- referral's admit check is left for its own flow. A replay finds the step
  -- already done and changes nothing.
  IF p_completed_id IS NOT NULL THEN
    UPDATE public.follow_ups
       SET status = 'done',
           completed_at = now(),
           snoozed_until = NULL
     WHERE id = p_completed_id
       AND org_id = v_org_id
       AND status = 'open'
       AND referral_id IS NULL
       AND kind IN ('first_call', 'follow_up', 'promised_call', 'touch');
  END IF;

  IF v_has_event THEN
    INSERT INTO public.case_events (id, owner_id, case_id, kind, body, contact_id, occurred_at)
    VALUES (
      (p_event ->> 'id')::uuid, v_owner_id,
      (p_event ->> 'case_id')::uuid,
      p_event ->> 'kind',
      coalesce(p_event ->> 'body', ''),
      nullif(p_event ->> 'contact_id', '')::uuid,
      coalesce(nullif(p_event ->> 'occurred_at', '')::timestamptz, now())
    )
    ON CONFLICT (id) DO NOTHING;
  END IF;

  IF v_has_touch THEN
    INSERT INTO public.touches (id, owner_id, partner_id, kind, note, occurred_at)
    VALUES (
      (p_touch ->> 'id')::uuid, v_owner_id,
      (p_touch ->> 'partner_id')::uuid,
      p_touch ->> 'kind',
      coalesce(p_touch ->> 'note', ''),
      coalesce(nullif(p_touch ->> 'occurred_at', '')::timestamptz, now())
    )
    ON CONFLICT (id) DO NOTHING;
  END IF;

  INSERT INTO public.follow_ups (
    id, owner_id, partner_id, case_id, title, due_on, due_time, status, note, kind, assigned_to
  ) VALUES (
    (p_next ->> 'id')::uuid, v_owner_id,
    nullif(p_next ->> 'partner_id', '')::uuid,
    nullif(p_next ->> 'case_id', '')::uuid,
    btrim(p_next ->> 'title'),
    (p_next ->> 'due_on')::date,
    nullif(p_next ->> 'due_time', '')::time,
    'open',
    coalesce(p_next ->> 'note', ''),
    coalesce(nullif(p_next ->> 'kind', ''), 'follow_up'),
    -- An assignee who has left the workspace (a stale copy on the phone)
    -- becomes unassigned instead of failing the write.
    (SELECT m.user_id FROM public.org_members m
      WHERE m.user_id = nullif(p_next ->> 'assigned_to', '')::uuid
        AND m.org_id = v_org_id)
  )
  ON CONFLICT (id) DO NOTHING;
END
$$;
REVOKE ALL ON FUNCTION public.record_outreach_sent(uuid, uuid, jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_outreach_sent(uuid, uuid, jsonb, jsonb, jsonb) TO authenticated;

COMMIT;
