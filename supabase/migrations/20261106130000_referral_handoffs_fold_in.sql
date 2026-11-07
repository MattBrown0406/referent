-- The referral-growth branch, folded in: handoffs stay, the rest goes.
--
-- 20260830201717 and 20260901231735 (both already applied in production,
-- from the referral-growth branch) added five things. Handoffs come into the
-- app; the others are removed here, empty in production:
--   1. Removed: referral links and their public family form (the intake link
--      and the website's form cover this), program availability (bed counts
--      replaced it), voice capture (no microphone in the app). The case
--      document bucket and its rules go back to case files only, PDF and
--      images.
--   2. Handoffs on today's schema. Since August, main redefined the
--      follow-up kinds without the handoff's, so creating a handoff failed;
--      and the handoff tables blocked three things main does: joining a
--      team (their keys did not move with the workspace), merging a
--      partner the team already tracks, and deleting an account (the
--      creator and the append-only history blocked it). Fixed: the kind is
--      back, the keys cascade and defer like the placement tables', the
--      history moves and goes with its workspace (still never edited), a
--      deleted creator leaves the handoff with the workspace, and the
--      alias a program reads passes the identifying-details check.
--   3. The program's page calls the two token-checked functions itself.
--
-- Transit-safe: ASCII only, no backslashes, every statement under 3,700
-- characters.

BEGIN;

-- ===========================================================================
-- 1. What is removed
-- ===========================================================================

DROP FUNCTION IF EXISTS public.public_referral_intake_submit(uuid, uuid, text, text, text, text, boolean, boolean, text);
DROP FUNCTION IF EXISTS public.public_referral_source_resolve(uuid);
DROP FUNCTION IF EXISTS public.rotate_referral_source(uuid);
DROP TABLE IF EXISTS public.referral_intake_submissions;
DROP TABLE IF EXISTS public.referral_intake_rate_limits;
DROP TABLE IF EXISTS public.referral_sources;
DROP FUNCTION IF EXISTS public.guard_referral_source_update();

DROP FUNCTION IF EXISTS public.confirm_center_availability(text, text[], text, text, integer);
DROP FUNCTION IF EXISTS public.get_center_availability();
DROP TABLE IF EXISTS public.center_availability;

DROP FUNCTION IF EXISTS public.save_voice_activity(uuid, jsonb, jsonb);

UPDATE storage.buckets
   SET allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/heic', 'image/webp', 'application/pdf']::text[]
 WHERE id = 'case-documents';

DROP POLICY IF EXISTS "case docs: org read" ON storage.objects;
DROP POLICY IF EXISTS "case docs: org insert" ON storage.objects;
DROP POLICY IF EXISTS "case docs: org delete" ON storage.objects;
CREATE POLICY "case docs: org read" ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'case-documents' AND public.is_org_case_folder((storage.foldername(name))[2]));
CREATE POLICY "case docs: org insert" ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'case-documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
    AND public.is_org_case_folder((storage.foldername(name))[2])
  );
CREATE POLICY "case docs: org delete" ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'case-documents' AND public.is_org_case_folder((storage.foldername(name))[2]));
DROP FUNCTION IF EXISTS public.is_org_case_or_partner_folder(text);

-- ===========================================================================
-- 2. Handoffs on today's schema
-- ===========================================================================

-- Same kinds as 20261001160000 (outcomes loop), plus the handoff's.
ALTER TABLE public.follow_ups DROP CONSTRAINT IF EXISTS follow_ups_kind_check;
ALTER TABLE public.follow_ups ADD CONSTRAINT follow_ups_kind_check
  CHECK (kind IN ('follow_up', 'first_call', 'promised_call', 'waiting_on', 'consult', 'touch', 'check_in', 'referral_handshake'));

-- Keys that move with the workspace (org_move_workspace_rows runs with
-- constraints deferred) and never block a delete main makes.
ALTER TABLE public.referral_handoffs ALTER COLUMN owner_id DROP NOT NULL;
ALTER TABLE public.referral_handoffs
  DROP CONSTRAINT IF EXISTS referral_handoffs_owner_id_fkey,
  DROP CONSTRAINT IF EXISTS referral_handoffs_referral_org_fk,
  DROP CONSTRAINT IF EXISTS referral_handoffs_case_org_fk,
  DROP CONSTRAINT IF EXISTS referral_handoffs_partner_org_fk;
ALTER TABLE public.referral_handoffs
  ADD CONSTRAINT referral_handoffs_owner_id_fkey FOREIGN KEY (owner_id)
    REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD CONSTRAINT referral_handoffs_referral_org_fk FOREIGN KEY (referral_id, org_id)
    REFERENCES public.referrals (id, org_id) ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT referral_handoffs_case_org_fk FOREIGN KEY (case_id, org_id)
    REFERENCES public.cases (id, org_id) ON UPDATE CASCADE ON DELETE SET NULL (case_id) DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT referral_handoffs_partner_org_fk FOREIGN KEY (partner_id, org_id)
    REFERENCES public.partners (id, org_id) ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE public.referral_handoff_events DROP CONSTRAINT IF EXISTS referral_handoff_events_handoff_org_fk;
ALTER TABLE public.referral_handoff_events
  ADD CONSTRAINT referral_handoff_events_handoff_org_fk FOREIGN KEY (handoff_id, org_id)
    REFERENCES public.referral_handoffs (id, org_id) ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE public.follow_ups DROP CONSTRAINT IF EXISTS follow_ups_handoff_org_fk;
ALTER TABLE public.follow_ups
  ADD CONSTRAINT follow_ups_handoff_org_fk FOREIGN KEY (referral_handoff_id, org_id)
    REFERENCES public.referral_handoffs (id, org_id) ON UPDATE CASCADE ON DELETE SET NULL (referral_handoff_id) DEFERRABLE INITIALLY IMMEDIATE;

-- The history is never edited. It may move with its workspace (org_id),
-- lose a deleted account's id (actor_id set to NULL by its key), and goes
-- only with its handoff (which goes with its workspace, referral or
-- partner). No client can update or delete it either way: authenticated
-- holds SELECT only.
CREATE OR REPLACE FUNCTION public.reject_handoff_event_mutation()
RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.referral_handoffs h WHERE h.id = OLD.handoff_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Referral handoff history is append-only' USING ERRCODE = '42501';
  END IF;
  IF (to_jsonb(NEW) - 'org_id' - 'actor_id') = (to_jsonb(OLD) - 'org_id' - 'actor_id')
     AND (NEW.actor_id IS NULL OR NEW.actor_id = OLD.actor_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Referral handoff history is append-only' USING ERRCODE = '42501';
END
$$;
REVOKE ALL ON FUNCTION public.reject_handoff_event_mutation() FROM PUBLIC, anon, authenticated;

-- Same as 20260830201717, plus: the alias (what the program reads) passes
-- the identifying-details check; one open handoff per outbound referral.
CREATE OR REPLACE FUNCTION public.create_referral_handoff(
  p_referral_id uuid, p_case_id uuid, p_partner_id uuid,
  p_client_alias text, p_recipient_display text, p_recipient_email text DEFAULT '')
RETURNS TABLE (handoff_id uuid, token text, status text, version integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid := public.current_org_id();
  v_handoff uuid := gen_random_uuid();
  v_token text := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  v_sender text;
  v_referral public.referrals%ROWTYPE;
  v_problem text;
BEGIN
  IF v_user IS NULL OR v_org IS NULL THEN RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000'; END IF;
  IF length(pg_catalog.btrim(coalesce(p_client_alias, ''))) NOT BETWEEN 1 AND 80
     OR length(pg_catalog.btrim(coalesce(p_recipient_display, ''))) NOT BETWEEN 1 AND 120
     OR length(coalesce(p_recipient_email, '')) > 254
     OR (coalesce(p_recipient_email, '') <> ''
         AND pg_catalog.lower(pg_catalog.btrim(p_recipient_email)) !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$') THEN
    RAISE EXCEPTION 'Invalid handoff details' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_referral FROM public.referrals WHERE id = p_referral_id AND org_id = v_org FOR NO KEY UPDATE;
  IF NOT FOUND OR v_referral.partner_id IS DISTINCT FROM p_partner_id
     OR (p_case_id IS NOT NULL AND v_referral.case_id IS DISTINCT FROM p_case_id) THEN
    RAISE EXCEPTION 'Referral links do not match this workspace' USING ERRCODE = 'P0002';
  END IF;
  IF v_referral.direction IS DISTINCT FROM 'outbound' THEN
    RAISE EXCEPTION 'A handoff is for a referral you sent to a program' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.referral_handoffs h
              WHERE h.referral_id = p_referral_id AND h.revoked_at IS NULL AND h.status <> 'closed') THEN
    RAISE EXCEPTION 'This referral already has an open handoff. Revoke it to send a new link.' USING ERRCODE = '23505';
  END IF;
  v_problem := public.identifying_text_problem(p_client_alias,
    public.identifying_case_names(coalesce(p_case_id, v_referral.case_id), v_org), v_referral.client_label);
  IF v_problem IS NOT NULL THEN RAISE EXCEPTION '%', v_problem USING ERRCODE = '22023'; END IF;
  SELECT name INTO v_sender FROM public.orgs WHERE id = v_org;
  INSERT INTO public.referral_handoffs (id, org_id, owner_id, referral_id, case_id, partner_id, client_alias,
    sender_practice_display, recipient_display, recipient_email, token_hash)
  VALUES (v_handoff, v_org, v_user, p_referral_id, p_case_id, p_partner_id, pg_catalog.btrim(p_client_alias),
    pg_catalog.btrim(v_sender), pg_catalog.btrim(p_recipient_display),
    pg_catalog.lower(pg_catalog.btrim(coalesce(p_recipient_email, ''))), extensions.digest(v_token, 'sha256'));
  INSERT INTO public.referral_handoff_events (handoff_id, org_id, from_status, to_status, version, actor_type, actor_id)
  VALUES (v_handoff, v_org, NULL, 'sent', 1, 'owner', v_user);
  INSERT INTO public.follow_ups (owner_id, org_id, partner_id, referral_id, case_id, referral_handoff_id, title, due_on, status, note, kind)
  VALUES (v_user, v_org, p_partner_id, p_referral_id, p_case_id, v_handoff,
    'Referral handoff: awaiting receipt', CURRENT_DATE + 1, 'open', '', 'referral_handshake');
  RETURN QUERY SELECT v_handoff, v_token, 'sent'::text, 1;
END
$$;
REVOKE ALL ON FUNCTION public.create_referral_handoff(uuid, uuid, uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_referral_handoff(uuid, uuid, uuid, text, text, text) TO authenticated;

-- Sets (or puts back) the request's identity: follow_ups pins a new row to
-- the signed-in author, and a handoff's reminder is written for its owner
-- whoever moved the step.
CREATE OR REPLACE FUNCTION public.handoff_request_identity(p_sub text, p_claims text)
RETURNS void
LANGUAGE sql
SET search_path = pg_catalog
AS $$
  SELECT pg_catalog.set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true),
         pg_catalog.set_config('request.jwt.claims', coalesce(p_claims, ''), true);
$$;
REVOKE ALL ON FUNCTION public.handoff_request_identity(text, text) FROM PUBLIC, anon, authenticated, service_role;

-- Same as 20260830201717, plus: the next reminder goes to the creator while
-- still on the team, else the workspace owner; a teammate or the program's
-- page (signed in to the portal or not) can move the step, and the page's
-- account is never written into the practice's rows.
CREATE OR REPLACE FUNCTION public.apply_referral_handoff_transition(
  p_handoff_id uuid, p_expected_version integer, p_next_status text, p_actor_type text, p_actor_id uuid DEFAULT NULL)
RETURNS TABLE (handoff_status text, handoff_version integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_h public.referral_handoffs%ROWTYPE;
  v_allowed text;
  v_new_version integer;
  v_title text;
  v_owner uuid;
  v_sub text := current_setting('request.jwt.claim.sub', true);
  v_claims text := current_setting('request.jwt.claims', true);
BEGIN
  SELECT * INTO v_h FROM public.referral_handoffs WHERE id = p_handoff_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Handoff not found' USING ERRCODE = 'P0002'; END IF;
  IF v_h.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'Handoff is revoked' USING ERRCODE = '42501'; END IF;
  IF p_next_status = v_h.status THEN RETURN QUERY SELECT v_h.status, v_h.version; RETURN; END IF;
  IF p_expected_version IS DISTINCT FROM v_h.version THEN
    RAISE EXCEPTION 'Handoff version conflict' USING ERRCODE = '40001';
  END IF;
  v_allowed := public.referral_handoff_next_status(v_h.status);
  IF v_allowed IS NULL OR p_next_status IS DISTINCT FROM v_allowed THEN
    RAISE EXCEPTION 'Invalid handoff transition' USING ERRCODE = '22023';
  END IF;
  v_new_version := v_h.version + 1;
  UPDATE public.referral_handoffs SET status = p_next_status, version = v_new_version WHERE id = v_h.id;
  INSERT INTO public.referral_handoff_events (handoff_id, org_id, from_status, to_status, version, actor_type, actor_id)
  VALUES (v_h.id, v_h.org_id, v_h.status, p_next_status, v_new_version, p_actor_type, p_actor_id);
  IF p_actor_type = 'recipient' THEN PERFORM public.handoff_request_identity('', ''); END IF;
  UPDATE public.follow_ups AS f SET status = 'done', completed_at = pg_catalog.clock_timestamp()
   WHERE f.referral_handoff_id = v_h.id AND f.kind = 'referral_handshake' AND f.status = 'open';
  SELECT m.user_id INTO v_owner FROM public.org_members m WHERE m.org_id = v_h.org_id AND m.user_id = v_h.owner_id;
  IF v_owner IS NULL THEN
    SELECT m.user_id INTO v_owner FROM public.org_members m
     WHERE m.org_id = v_h.org_id ORDER BY (m.role = 'owner') DESC, m.user_id LIMIT 1;
  END IF;
  PERFORM public.handoff_request_identity('', '');
  IF p_next_status <> 'closed' AND v_owner IS NOT NULL THEN
    v_title := CASE p_next_status
      WHEN 'received' THEN 'Referral handoff: contact the family'
      WHEN 'contact_attempted' THEN 'Referral handoff: retry family contact'
      WHEN 'family_reached' THEN 'Referral handoff: schedule the consult'
      WHEN 'consult_scheduled' THEN 'Referral handoff: close the loop' END;
    INSERT INTO public.follow_ups (owner_id, org_id, partner_id, referral_id, case_id, referral_handoff_id, title, due_on, status, note, kind)
    VALUES (v_owner, v_h.org_id, v_h.partner_id, v_h.referral_id, v_h.case_id, v_h.id, v_title, CURRENT_DATE + 1, 'open', '', 'referral_handshake');
  END IF;
  PERFORM public.handoff_request_identity(v_sub, v_claims);
  RETURN QUERY SELECT p_next_status, v_new_version;
END
$$;
REVOKE ALL ON FUNCTION public.apply_referral_handoff_transition(uuid, integer, text, text, uuid) FROM PUBLIC, anon, authenticated;

-- Same as 20261104150000 (its latest definition), plus the two handoff
-- tables (their keys cascade too; this catches any row they did not reach).
CREATE OR REPLACE FUNCTION public.org_move_workspace_rows(p_from uuid, p_to uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.partners              SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.touches               SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.referrals             SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.match_profiles        SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.follow_ups            SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.cases                 SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.case_contacts         SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.case_events           SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.case_documents        SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.case_stage_history    SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.case_integrations     SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.case_benefits         SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.vob_requests          SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.placement_decisions   SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.placement_requests    SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.placement_request_recipients SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.case_assessments      SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.referral_handoffs     SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.referral_handoff_events SET org_id = p_to WHERE org_id = p_from;
  -- These cascade from orgs, so without a move they would vanish with the
  -- personal workspace: favorites, the AI draft cap history, and the
  -- practitioner's own store purchases (RevenueCat maps a purchase to the
  -- buyer's current workspace anyway).
  UPDATE public.user_favorites        SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.outreach_drafts       SET org_id = p_to WHERE org_id = p_from;
  UPDATE public.org_revenuecat_grants SET org_id = p_to WHERE org_id = p_from;
END
$$;
REVOKE ALL ON FUNCTION public.org_move_workspace_rows(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Same as 20261104140000 (its latest definition), plus one line: a joiner's
-- handoff to a partner the team already tracks points at the team's copy
-- before the joiner's copy is deleted.
CREATE OR REPLACE FUNCTION public.org_merge_linked_partner_copies(p_from uuid, p_to uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pair record;
  v_name text;
  v_count integer := 0;
BEGIN
  SELECT nullif(btrim(m.display_name), '') INTO v_name FROM public.org_members m
   WHERE m.org_id = p_from ORDER BY (m.role = 'owner') DESC LIMIT 1;
  v_name := coalesce(v_name, 'a teammate');
  FOR v_pair IN
    SELECT d.id AS dup_id, k.id AS keep_id
      FROM public.partners d
      JOIN public.partners k ON k.global_partner_id = d.global_partner_id AND k.org_id = p_to
     WHERE d.org_id = p_from AND d.global_partner_id IS NOT NULL
  LOOP
    UPDATE public.referrals SET partner_id = v_pair.keep_id WHERE org_id = p_from AND partner_id = v_pair.dup_id;
    UPDATE public.touches SET partner_id = v_pair.keep_id WHERE org_id = p_from AND partner_id = v_pair.dup_id;
    UPDATE public.follow_ups SET partner_id = v_pair.keep_id WHERE org_id = p_from AND partner_id = v_pair.dup_id;
    UPDATE public.match_profiles SET assigned_partner_id = v_pair.keep_id
     WHERE org_id = p_from AND assigned_partner_id = v_pair.dup_id;
    UPDATE public.placement_decisions SET chosen_partner_id = v_pair.keep_id
     WHERE org_id = p_from AND chosen_partner_id = v_pair.dup_id;
    UPDATE public.vob_requests SET partner_id = v_pair.keep_id WHERE org_id = p_from AND partner_id = v_pair.dup_id;
    UPDATE public.outreach_drafts SET partner_id = v_pair.keep_id WHERE org_id = p_from AND partner_id = v_pair.dup_id;
    UPDATE public.program_credentials SET partner_id = v_pair.keep_id, org_id = p_to WHERE org_id = p_from AND partner_id = v_pair.dup_id;
    UPDATE public.placement_request_recipients SET partner_id = v_pair.keep_id WHERE org_id = p_from AND partner_id = v_pair.dup_id;
    UPDATE public.referral_handoffs SET partner_id = v_pair.keep_id WHERE org_id = p_from AND partner_id = v_pair.dup_id;
    DELETE FROM public.user_favorites f
     WHERE f.org_id = p_from AND f.target_type = 'partner' AND f.target_id = v_pair.dup_id
       AND EXISTS (SELECT 1 FROM public.user_favorites x
                    WHERE x.user_id = f.user_id AND x.target_type = 'partner' AND x.target_id = v_pair.keep_id);
    UPDATE public.user_favorites SET target_id = v_pair.keep_id, org_id = p_to
     WHERE org_id = p_from AND target_type = 'partner' AND target_id = v_pair.dup_id;
    PERFORM public.org_merge_partner_fields(v_pair.keep_id, v_pair.dup_id, v_name);
    DELETE FROM public.partners WHERE id = v_pair.dup_id AND org_id = p_from;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END
$$;
REVOKE ALL ON FUNCTION public.org_merge_linked_partner_copies(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- The program's page (the portal's /h, signed out) reads and advances a
-- handoff with the link's token alone: 256 random bits, stored only as a
-- hash, and the page sees the alias, the two names and the status, nothing
-- more. So it calls these two directly; no server function in between.
REVOKE ALL ON FUNCTION public.public_referral_handoff_resolve(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_referral_handoff_transition(text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_referral_handoff_resolve(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_referral_handoff_transition(text, integer, text) TO anon, authenticated;

COMMIT;
