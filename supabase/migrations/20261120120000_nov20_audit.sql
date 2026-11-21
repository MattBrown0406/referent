-- Bug audit, 2026-11-20 (family assessments). Paste in the SQL editor;
-- ASCII, one transaction, safe to re-run. Redefines four functions from
-- 20261109140000_family_assessment.sql (same signatures) and adds one.
--
--   1. family_assessment_count_send: counted one at a time per practitioner
--      (parallel sends could slip under the daily limit); an emailed invite
--      only from an account whose own email is confirmed, and at most 400
--      emailed invites a day across all practices (referralfit.com's
--      sending reputation).
--   2. family_assessment_new_link: the 50 newest links work, not 10 (each
--      "Text or copy" tap and each resend makes one; the family's working
--      link was retired after ten).
--   3. family_assessment_send: a new link after "Stop" carries the stopped
--      assessment's answers on, so the family continues where they were.
--   4. family_assessment_invite_failures: which invites could not be
--      delivered, so the case says so instead of "Sent".
--   5. "org logos: owner read": lets the owner list and remove the
--      practice's own logo files (old ones, and on account deletion).

BEGIN;

CREATE OR REPLACE FUNCTION public.family_assessment_count_send(p_user uuid, p_email text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- One count at a time per practitioner: parallel sends on two cases never
  -- both slip under the limit.
  PERFORM pg_advisory_xact_lock(hashtextextended('family_assessment_count_send:' || p_user::text, 0));
  IF p_email <> '' THEN
    -- An emailed invite goes out under referralfit.com: only from an account
    -- whose own email address is confirmed, and under a ceiling for all
    -- practices together, so the address cannot be used to send in bulk.
    IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user AND u.email_confirmed_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Confirm your own email address first (the link is in your inbox), then send the assessment by email. You can text or copy the link now.' USING ERRCODE = '42501';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('family_assessment_count_send:all', 0));
    IF (SELECT count(*) FROM public.family_assessment_sends s
         WHERE s.email <> '' AND s.created_at > now() - interval '24 hours') >= 400 THEN
      RAISE EXCEPTION 'Assessment emails are paused for today. Text or copy the link instead.' USING ERRCODE = '54000';
    END IF;
  END IF;
  DELETE FROM public.family_assessment_sends s WHERE s.created_at < now() - interval '2 days';
  IF (SELECT count(*) FROM public.family_assessment_sends s
       WHERE s.user_id = p_user AND s.created_at > now() - interval '24 hours') >= 40 THEN
    RAISE EXCEPTION 'You have sent many assessment links today. Try again tomorrow.' USING ERRCODE = '54000';
  END IF;
  IF p_email <> '' AND (SELECT count(*) FROM public.family_assessment_sends s
                         WHERE s.email = p_email AND s.created_at > now() - interval '24 hours') >= 3 THEN
    RAISE EXCEPTION 'This address was sent the assessment 3 times today. Try again tomorrow, or text or copy the link.' USING ERRCODE = '54000';
  END IF;
  INSERT INTO public.family_assessment_sends (user_id, email) VALUES (p_user, p_email);
END
$$;
REVOKE ALL ON FUNCTION public.family_assessment_count_send(uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.family_assessment_new_link(p_id uuid, p_user uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token text := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
BEGIN
  INSERT INTO public.family_assessment_links (token_hash, assessment_id, created_by)
  VALUES (extensions.digest(v_token, 'sha256'), p_id, p_user);
  DELETE FROM public.family_assessment_links l
   WHERE l.assessment_id = p_id
     AND l.token_hash NOT IN (SELECT k.token_hash FROM public.family_assessment_links k
                               WHERE k.assessment_id = p_id
                               ORDER BY k.created_at DESC, k.token_hash LIMIT 50);
  RETURN v_token;
END
$$;
REVOKE ALL ON FUNCTION public.family_assessment_new_link(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.family_assessment_send(p_case_id uuid, p_name text, p_email text, p_send_email boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_send boolean := coalesce(p_send_email, false);
  v_id uuid;
  v_old text;
  v_old_expires timestamptz;
  v_to_name text;
  v_expires timestamptz := now() + interval '30 days';
  v_carry_answers jsonb;
  v_carry_step integer;
  v_carry_started timestamptz;
  v_carry_saved timestamptz;
  v_carry_urgent timestamptz;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cases c WHERE c.id = p_case_id AND c.org_id = public.current_org_id()) THEN
    RAISE EXCEPTION 'That case is not in your practice' USING ERRCODE = 'P0002';
  END IF;
  IF length(v_name) > 120 THEN
    RAISE EXCEPTION 'The name is too long' USING ERRCODE = '22023';
  END IF;
  IF v_email <> '' AND (length(v_email) > 254 OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$') THEN
    RAISE EXCEPTION 'Check the email address' USING ERRCODE = '22023';
  END IF;
  IF v_send AND v_email = '' THEN
    RAISE EXCEPTION 'Add the email address to send it to' USING ERRCODE = '22023';
  END IF;
  -- One send at a time per case, so two taps never make two assessments.
  PERFORM pg_advisory_xact_lock(hashtextextended('family_assessment_send:' || p_case_id::text, 0));
  PERFORM public.family_assessment_count_send(v_user, CASE WHEN v_send THEN v_email ELSE '' END);

  SELECT a.id, a.recipient_email, a.expires_at INTO v_id, v_old, v_old_expires FROM public.family_assessments a
   WHERE a.case_id = p_case_id AND a.status IN ('sent', 'started')
   ORDER BY a.created_at DESC LIMIT 1 FOR UPDATE;
  IF v_id IS NULL THEN
    -- The case's newest assessment was stopped part way (a link forwarded by
    -- mistake, say): the new one carries its answers on, so the family
    -- continues instead of starting over. The stopped links stay stopped.
    SELECT a.answers, a.step, a.started_at, a.last_saved_at, a.urgent_notified_at
      INTO v_carry_answers, v_carry_step, v_carry_started, v_carry_saved, v_carry_urgent
      FROM public.family_assessments a
     WHERE a.case_id = p_case_id
     ORDER BY a.created_at DESC LIMIT 1;
    IF NOT FOUND OR v_carry_answers IS NULL OR v_carry_answers = '{}'::jsonb
       OR NOT EXISTS (SELECT 1 FROM public.family_assessments a
                       WHERE a.case_id = p_case_id AND a.status = 'revoked' AND a.submitted_at IS NULL
                         AND a.revoked_at > now() - interval '30 days'
                         AND a.created_at = (SELECT max(b.created_at) FROM public.family_assessments b WHERE b.case_id = p_case_id)) THEN
      v_carry_answers := NULL;
    END IF;
    INSERT INTO public.family_assessments (case_id, created_by, recipient_name, recipient_email, expires_at,
                                           answers, step, status, started_at, last_saved_at, urgent_notified_at)
    VALUES (p_case_id, v_user, v_name, v_email, v_expires,
            coalesce(v_carry_answers, '{}'::jsonb),
            CASE WHEN v_carry_answers IS NULL THEN 0 ELSE v_carry_step END,
            CASE WHEN v_carry_answers IS NULL THEN 'sent' ELSE 'started' END,
            CASE WHEN v_carry_answers IS NULL THEN NULL ELSE v_carry_started END,
            CASE WHEN v_carry_answers IS NULL THEN NULL ELSE v_carry_saved END,
            -- The practitioner was already told about an urgent answer carried on.
            CASE WHEN v_carry_answers IS NULL THEN NULL ELSE v_carry_urgent END)
    RETURNING id, recipient_name INTO v_id, v_to_name;
  ELSE
    -- A corrected address: a mistyped one must not keep reading the answers.
    IF (v_email <> '' AND v_old <> '' AND v_email <> v_old) OR v_old_expires <= now() THEN
      DELETE FROM public.family_assessment_links l WHERE l.assessment_id = v_id;
    END IF;
    UPDATE public.family_assessments a
       SET recipient_name = CASE WHEN v_name <> '' THEN v_name ELSE a.recipient_name END,
           recipient_email = CASE WHEN v_email <> '' THEN v_email ELSE a.recipient_email END,
           expires_at = v_expires
     WHERE a.id = v_id
    RETURNING a.recipient_name INTO v_to_name;
  END IF;

  IF v_send THEN
    PERFORM public.email_enqueue(v_user, 'family_assessment_invite',
      jsonb_build_object('assessment_id', v_id, 'to', v_email, 'recipient_name', v_to_name));
    UPDATE public.family_assessments SET emailed_at = now() WHERE id = v_id;
    RETURN jsonb_build_object('id', v_id, 'token', NULL, 'expires_at', v_expires);
  END IF;
  RETURN jsonb_build_object('id', v_id, 'token', public.family_assessment_new_link(v_id, v_user), 'expires_at', v_expires);
END
$$;
REVOKE ALL ON FUNCTION public.family_assessment_send(uuid, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.family_assessment_send(uuid, text, text, boolean) TO authenticated;

-- Which of a case's invites could not be delivered: the email was given up
-- (a refused address, say) and no later invite went out for it. The outbox
-- is not readable from the app; the practitioner is told on the case.
CREATE OR REPLACE FUNCTION public.family_assessment_invite_failures(p_case_id uuid)
RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(array_agg(a.id), '{}'::uuid[])
    FROM public.family_assessments a
    JOIN public.cases c ON c.id = a.case_id AND c.org_id = public.current_org_id()
   WHERE a.case_id = p_case_id
     AND a.status IN ('sent', 'started')
     AND EXISTS (
       SELECT 1 FROM public.email_outbox o
        WHERE o.kind = 'family_assessment_invite'
          AND o.data ->> 'assessment_id' = a.id::text
          AND o.sent_at IS NULL AND o.error IS NOT NULL
          -- Started (answers carried on after a Stop): nothing saved since the invite.
          AND (a.status = 'sent' OR a.last_saved_at IS NULL OR a.last_saved_at < o.created_at)
          AND NOT EXISTS (SELECT 1 FROM public.email_outbox n
                           WHERE n.kind = 'family_assessment_invite'
                             AND n.data ->> 'assessment_id' = a.id::text
                             AND n.created_at > o.created_at))
$$;
REVOKE ALL ON FUNCTION public.family_assessment_invite_failures(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.family_assessment_invite_failures(uuid) TO authenticated;

-- 5. The practice owner can see the logo files in its own folder (the
--    bucket is public by URL, but listing and removing them through the
--    storage API needs a read policy): older logos are cleared on upload,
--    and the logo goes with the account when it is deleted.
DROP POLICY IF EXISTS "org logos: owner read" ON storage.objects;
CREATE POLICY "org logos: owner read" ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'org-logos'
    AND (storage.foldername(name))[1] = public.current_org_id()::text
    AND public.current_org_role() = 'owner'
  );

COMMIT;
