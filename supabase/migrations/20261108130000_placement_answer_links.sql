-- Answer links: a program that does not answer in the center portal
-- (placement_request_recipients.channel = 'manual') can answer a placement
-- request itself, from a link in the text or email the practitioner sends.
--
--   1. placement_request_recipients.answered_via: 'portal' (the center
--      portal), 'link' (an answer link) or 'practice' (logged by hand).
--      Existing answers are backfilled; a BEFORE UPDATE trigger keeps it
--      right for every writer, so no existing function is re-created.
--   2. placement_answer_links: one row per link, the token stored only as
--      its sha256 (256 random bits, as referral handoffs do). A practice
--      member makes one with placement_answer_link(recipient) for a program
--      asked by hand on an open request. A program can be texted and
--      emailed, so the five newest links of a recipient all work; an older
--      one stops.
--   3. The program's page (the portal's /a, signed out) calls two functions
--      with the token alone: public_placement_answer_open (the summary as
--      the center inbox shows it, the practice's name, the time left and the
--      program's own answer; opening marks it viewed) and
--      public_placement_answer_respond (the same checks as
--      respond_to_placement_request: open, before the deadline). The answer
--      is the program's own (entered_by_practice false, responded_by NULL,
--      answered_via 'link'): it replaces an answer the practice logged by
--      hand, log_manual_response refuses to write over it, and the existing
--      AFTER UPDATE trigger (placement_answer_notify) queues the push.
--
-- Nothing about the client is reachable: the payload is the allow-listed
-- summary (its CHECK), with no rank, no other program, no partner or case
-- id. Answers never change ranking.
--
-- Transit-safe: ASCII only, no backslashes, every statement under 3,700
-- characters.

BEGIN;

-- ===========================================================================
-- 1. How an answer arrived
-- ===========================================================================

ALTER TABLE public.placement_request_recipients ADD COLUMN IF NOT EXISTS answered_via text;
ALTER TABLE public.placement_request_recipients DROP CONSTRAINT IF EXISTS placement_request_recipients_answered_via_check;
ALTER TABLE public.placement_request_recipients ADD CONSTRAINT placement_request_recipients_answered_via_check
  CHECK (answered_via IN ('portal', 'link', 'practice'));

-- Answers given before this migration: a logged one is the practice's, any
-- other came from the portal (the only other writer until now). The answer
-- columns do not change, so placement_answer_notify queues nothing.
UPDATE public.placement_request_recipients
   SET answered_via = CASE WHEN entered_by_practice THEN 'practice' ELSE 'portal' END
 WHERE responded_at IS NOT NULL AND answered_via IS NULL;

-- Every answer write sets responded_at (or flips entered_by_practice, or
-- names who answered): the practice's own log is 'practice', a signed-in
-- program's is 'portal', and the only writer that leaves responded_by empty
-- is the answer link. A deleted account (responded_by set to NULL by its
-- foreign key) changes nothing here.
CREATE OR REPLACE FUNCTION public.placement_recipient_answered_via()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.responded_at IS NULL THEN
    NEW.answered_via := NULL;
  ELSIF NEW.responded_at IS DISTINCT FROM OLD.responded_at
     OR NEW.entered_by_practice IS DISTINCT FROM OLD.entered_by_practice
     OR (NEW.responded_by IS NOT NULL AND NEW.responded_by IS DISTINCT FROM OLD.responded_by) THEN
    NEW.answered_via := CASE WHEN NEW.entered_by_practice THEN 'practice'
                             WHEN NEW.responded_by IS NOT NULL THEN 'portal'
                             ELSE 'link' END;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.placement_recipient_answered_via() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS placement_request_recipients_answered_via ON public.placement_request_recipients;
CREATE TRIGGER placement_request_recipients_answered_via
  BEFORE UPDATE OF responded_at, entered_by_practice, responded_by ON public.placement_request_recipients
  FOR EACH ROW EXECUTE FUNCTION public.placement_recipient_answered_via();

-- ===========================================================================
-- 2. The links
-- ===========================================================================

-- created_at is the clock time, so the five newest are always the five
-- made last, even within one transaction.
CREATE TABLE IF NOT EXISTS public.placement_answer_links (
  token_hash   bytea PRIMARY KEY,
  recipient_id uuid NOT NULL REFERENCES public.placement_request_recipients(id) ON DELETE CASCADE,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS placement_answer_links_recipient_idx ON public.placement_answer_links (recipient_id, created_at DESC);

COMMENT ON TABLE public.placement_answer_links IS
  'Answer links for programs asked by hand (channel manual): the sha256 of a 256-bit token, never the token. Read only by the placement answer link functions.';

-- Production's default ACL grants ALL on new tables: revoke it. No client
-- role reads or writes this table, and there is no policy.
ALTER TABLE public.placement_answer_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.placement_answer_links FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.placement_answer_links TO service_role;

-- A new link for one program the practice asked by hand, on an open request
-- before its deadline. Returns the token (64 hex characters); only its hash
-- is kept. The recipient's five newest links work; older ones stop.
CREATE OR REPLACE FUNCTION public.placement_answer_link(p_recipient_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  r public.placement_request_recipients%ROWTYPE;
  q public.placement_requests%ROWTYPE;
  v_token text;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO r FROM public.placement_request_recipients x
   WHERE x.id = p_recipient_id AND x.org_id = public.current_org_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That program is not on this request' USING ERRCODE = 'P0002';
  END IF;
  IF r.channel <> 'manual' THEN
    RAISE EXCEPTION 'This program answers in ReferralFit' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO q FROM public.placement_requests WHERE id = r.request_id;
  IF q.status <> 'open' THEN
    RAISE EXCEPTION 'This request is closed' USING ERRCODE = '22023';
  END IF;
  IF now() > q.respond_by THEN
    RAISE EXCEPTION 'The time to answer this request has passed' USING ERRCODE = '22023';
  END IF;
  v_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  INSERT INTO public.placement_answer_links (token_hash, recipient_id, created_by)
  VALUES (extensions.digest(v_token, 'sha256'), r.id, v_user);
  DELETE FROM public.placement_answer_links l
   WHERE l.recipient_id = r.id
     AND l.token_hash NOT IN (SELECT k.token_hash FROM public.placement_answer_links k
                               WHERE k.recipient_id = r.id
                               ORDER BY k.created_at DESC, k.token_hash LIMIT 5);
  RETURN v_token;
END
$$;
REVOKE ALL ON FUNCTION public.placement_answer_link(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.placement_answer_link(uuid) TO authenticated;

-- ===========================================================================
-- 3. The program's page
-- ===========================================================================

-- The recipient a token opens, or NULL (a wrong, cut-off or retired link).
CREATE OR REPLACE FUNCTION public.placement_answer_link_recipient(p_token text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT l.recipient_id
    FROM public.placement_answer_links l
    JOIN public.placement_request_recipients r ON r.id = l.recipient_id AND r.channel = 'manual'
   WHERE coalesce(p_token, '') ~ '^[0-9a-f]{64}$'
     AND l.token_hash = extensions.digest(p_token, 'sha256')
$$;
REVOKE ALL ON FUNCTION public.placement_answer_link_recipient(text) FROM PUBLIC, anon, authenticated;

-- What the program's page shows: the same fields the center inbox shows for
-- a request (list_center_placement_requests), plus the program's name as
-- the practice wrote it. answer is the program's own (never one the
-- practice logged, which reads as unanswered here), or null.
CREATE OR REPLACE FUNCTION public.placement_answer_link_view(p_recipient_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'program_name', r.program_name,
           'practice_name', public.placement_practice_name(q.org_id),
           'payload', q.payload,
           'sent_at', q.created_at,
           'respond_by', q.respond_by,
           'request_status', q.status,
           'status', public.placement_recipient_status(
                       CASE WHEN NOT r.entered_by_practice THEN r.status
                            WHEN r.viewed_at IS NULL THEN 'sent' ELSE 'viewed' END, q.respond_by, now()),
           'can_respond', q.status = 'open' AND now() <= q.respond_by,
           'answer', CASE WHEN r.responded_at IS NOT NULL AND NOT r.entered_by_practice THEN
                       jsonb_build_object('responded_at', r.responded_at, 'bed_available', r.bed_available,
                                          'likely_accept', r.likely_accept, 'earliest_admit_on', r.earliest_admit_on,
                                          'daily_rate', r.daily_rate, 'cost_note', r.cost_note, 'note', r.note)
                     END)
    FROM public.placement_request_recipients r
    JOIN public.placement_requests q ON q.id = r.request_id
   WHERE r.id = p_recipient_id
$$;
REVOKE ALL ON FUNCTION public.placement_answer_link_view(uuid) FROM PUBLIC, anon, authenticated;

-- Open the page: NULL for a link that does not work, else the view.
-- Opening marks the program's row viewed, once.
CREATE OR REPLACE FUNCTION public.public_placement_answer_open(p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid := public.placement_answer_link_recipient(p_token);
BEGIN
  IF v_id IS NULL THEN
    RETURN NULL;
  END IF;
  UPDATE public.placement_request_recipients r
     SET viewed_at = now(), status = CASE WHEN r.status = 'sent' THEN 'viewed' ELSE r.status END
   WHERE r.id = v_id AND r.viewed_at IS NULL;
  RETURN public.placement_answer_link_view(v_id);
END
$$;
REVOKE ALL ON FUNCTION public.public_placement_answer_open(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_placement_answer_open(text) TO anon, authenticated;

-- The program answers (or changes its answer) while the request is open and
-- before its deadline, with the checks respond_to_placement_request makes.
-- likely_accept 'no' is a decline. Returns the view.
CREATE OR REPLACE FUNCTION public.public_placement_answer_respond(
  p_token text, p_bed_available text, p_likely_accept text, p_earliest_admit_on date,
  p_daily_rate integer, p_cost_note text, p_note text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid := public.placement_answer_link_recipient(p_token);
  r public.placement_request_recipients%ROWTYPE;
  q public.placement_requests%ROWTYPE;
  v_problem text;
BEGIN
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'This link is not active' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO r FROM public.placement_request_recipients WHERE id = v_id;
  -- Locked: a cancel and an answer never cross.
  SELECT * INTO q FROM public.placement_requests WHERE id = r.request_id FOR UPDATE;
  IF q.status <> 'open' THEN
    RAISE EXCEPTION 'This request is closed. The practice is no longer waiting for answers.' USING ERRCODE = '22023';
  END IF;
  IF now() > q.respond_by THEN
    RAISE EXCEPTION 'The time to answer this request has passed' USING ERRCODE = '22023';
  END IF;
  v_problem := public.placement_answer_problem(p_bed_available, p_likely_accept, p_earliest_admit_on, p_daily_rate,
                                               p_cost_note, p_note, (q.created_at AT TIME ZONE 'UTC')::date);
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION '%', v_problem USING ERRCODE = '22023';
  END IF;
  UPDATE public.placement_request_recipients x
     SET bed_available = p_bed_available, likely_accept = p_likely_accept, earliest_admit_on = p_earliest_admit_on,
         daily_rate = p_daily_rate, cost_note = btrim(coalesce(p_cost_note, '')), note = btrim(coalesce(p_note, '')),
         status = CASE WHEN p_likely_accept = 'no' THEN 'declined' ELSE 'responded' END,
         responded_at = now(), responded_by = NULL, entered_by_practice = false, answered_via = 'link',
         viewed_at = coalesce(x.viewed_at, now())
   WHERE x.id = v_id;
  RETURN public.placement_answer_link_view(v_id);
END
$$;
REVOKE ALL ON FUNCTION public.public_placement_answer_respond(text, text, text, date, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_placement_answer_respond(text, text, text, date, integer, text, text) TO anon, authenticated;

COMMIT;
