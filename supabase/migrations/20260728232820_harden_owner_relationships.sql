BEGIN;

-- Enforce tenant ownership at every relationship boundary.
--
-- Each parent already has a globally unique id, so these composite UNIQUE
-- constraints cannot reject existing data. The composite foreign keys are added
-- NOT VALID first: they protect concurrent/new writes immediately, while the
-- explicit VALIDATE steps make any pre-existing cross-owner relationship fail
-- the migration (and roll back) rather than silently rewriting ownership.

ALTER TABLE public.partners
  ADD CONSTRAINT partners_id_owner_key UNIQUE (id, owner_id);
ALTER TABLE public.referrals
  ADD CONSTRAINT referrals_id_owner_key UNIQUE (id, owner_id);
ALTER TABLE public.match_profiles
  ADD CONSTRAINT match_profiles_id_owner_key UNIQUE (id, owner_id);
ALTER TABLE public.cases
  ADD CONSTRAINT cases_id_owner_key UNIQUE (id, owner_id);
ALTER TABLE public.case_contacts
  ADD CONSTRAINT case_contacts_id_owner_key UNIQUE (id, owner_id);
ALTER TABLE public.case_documents
  ADD CONSTRAINT case_documents_id_owner_key UNIQUE (id, owner_id);

-- CASCADE relationships.
ALTER TABLE public.touches
  DROP CONSTRAINT touches_partner_id_fkey,
  ADD CONSTRAINT touches_partner_owner_fk
    FOREIGN KEY (partner_id, owner_id)
    REFERENCES public.partners (id, owner_id)
    ON DELETE CASCADE NOT VALID;

ALTER TABLE public.referrals
  DROP CONSTRAINT referrals_partner_id_fkey,
  ADD CONSTRAINT referrals_partner_owner_fk
    FOREIGN KEY (partner_id, owner_id)
    REFERENCES public.partners (id, owner_id)
    ON DELETE CASCADE NOT VALID;

ALTER TABLE public.follow_ups
  DROP CONSTRAINT follow_ups_partner_id_fkey,
  DROP CONSTRAINT follow_ups_referral_id_fkey,
  ADD CONSTRAINT follow_ups_partner_owner_fk
    FOREIGN KEY (partner_id, owner_id)
    REFERENCES public.partners (id, owner_id)
    ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT follow_ups_referral_owner_fk
    FOREIGN KEY (referral_id, owner_id)
    REFERENCES public.referrals (id, owner_id)
    ON DELETE CASCADE NOT VALID;

ALTER TABLE public.case_contacts
  DROP CONSTRAINT case_contacts_case_id_fkey,
  ADD CONSTRAINT case_contacts_case_owner_fk
    FOREIGN KEY (case_id, owner_id)
    REFERENCES public.cases (id, owner_id)
    ON DELETE CASCADE NOT VALID;

ALTER TABLE public.case_events
  DROP CONSTRAINT case_events_case_id_fkey,
  ADD CONSTRAINT case_events_case_owner_fk
    FOREIGN KEY (case_id, owner_id)
    REFERENCES public.cases (id, owner_id)
    ON DELETE CASCADE NOT VALID;

ALTER TABLE public.case_documents
  DROP CONSTRAINT case_documents_case_id_fkey,
  ADD CONSTRAINT case_documents_case_owner_fk
    FOREIGN KEY (case_id, owner_id)
    REFERENCES public.cases (id, owner_id)
    ON DELETE CASCADE NOT VALID;

-- SET NULL relationships. PostgreSQL 17's column-list form is intentional:
-- only the nullable relationship column is cleared; owner_id remains intact.
ALTER TABLE public.match_profiles
  DROP CONSTRAINT match_profiles_assigned_partner_id_fkey,
  DROP CONSTRAINT match_profiles_referral_id_fkey,
  DROP CONSTRAINT match_profiles_case_id_fkey,
  ADD CONSTRAINT match_profiles_partner_owner_fk
    FOREIGN KEY (assigned_partner_id, owner_id)
    REFERENCES public.partners (id, owner_id)
    ON DELETE SET NULL (assigned_partner_id) NOT VALID,
  ADD CONSTRAINT match_profiles_referral_owner_fk
    FOREIGN KEY (referral_id, owner_id)
    REFERENCES public.referrals (id, owner_id)
    ON DELETE SET NULL (referral_id) NOT VALID,
  ADD CONSTRAINT match_profiles_case_owner_fk
    FOREIGN KEY (case_id, owner_id)
    REFERENCES public.cases (id, owner_id)
    ON DELETE SET NULL (case_id) NOT VALID;

ALTER TABLE public.referrals
  DROP CONSTRAINT referrals_match_profile_id_fkey,
  DROP CONSTRAINT referrals_case_id_fkey,
  ADD CONSTRAINT referrals_match_profile_owner_fk
    FOREIGN KEY (match_profile_id, owner_id)
    REFERENCES public.match_profiles (id, owner_id)
    ON DELETE SET NULL (match_profile_id) NOT VALID,
  ADD CONSTRAINT referrals_case_owner_fk
    FOREIGN KEY (case_id, owner_id)
    REFERENCES public.cases (id, owner_id)
    ON DELETE SET NULL (case_id) NOT VALID;

ALTER TABLE public.cases
  DROP CONSTRAINT cases_match_profile_id_fkey,
  ADD CONSTRAINT cases_match_profile_owner_fk
    FOREIGN KEY (match_profile_id, owner_id)
    REFERENCES public.match_profiles (id, owner_id)
    ON DELETE SET NULL (match_profile_id) NOT VALID;

ALTER TABLE public.follow_ups
  DROP CONSTRAINT follow_ups_case_id_fkey,
  ADD CONSTRAINT follow_ups_case_owner_fk
    FOREIGN KEY (case_id, owner_id)
    REFERENCES public.cases (id, owner_id)
    ON DELETE SET NULL (case_id) NOT VALID;

ALTER TABLE public.case_events
  DROP CONSTRAINT case_events_contact_id_fkey,
  DROP CONSTRAINT case_events_referral_id_fkey,
  DROP CONSTRAINT case_events_document_fk,
  ADD CONSTRAINT case_events_contact_owner_fk
    FOREIGN KEY (contact_id, owner_id)
    REFERENCES public.case_contacts (id, owner_id)
    ON DELETE SET NULL (contact_id) NOT VALID,
  ADD CONSTRAINT case_events_referral_owner_fk
    FOREIGN KEY (referral_id, owner_id)
    REFERENCES public.referrals (id, owner_id)
    ON DELETE SET NULL (referral_id) NOT VALID,
  ADD CONSTRAINT case_events_document_owner_fk
    FOREIGN KEY (document_id, owner_id)
    REFERENCES public.case_documents (id, owner_id)
    ON DELETE SET NULL (document_id) NOT VALID;

-- Validate every new relationship. Any legacy mismatch aborts this migration;
-- no owner_id or relationship value is modified to make validation pass.
ALTER TABLE public.touches VALIDATE CONSTRAINT touches_partner_owner_fk;
ALTER TABLE public.referrals VALIDATE CONSTRAINT referrals_partner_owner_fk;
ALTER TABLE public.follow_ups VALIDATE CONSTRAINT follow_ups_partner_owner_fk;
ALTER TABLE public.follow_ups VALIDATE CONSTRAINT follow_ups_referral_owner_fk;
ALTER TABLE public.case_contacts VALIDATE CONSTRAINT case_contacts_case_owner_fk;
ALTER TABLE public.case_events VALIDATE CONSTRAINT case_events_case_owner_fk;
ALTER TABLE public.case_documents VALIDATE CONSTRAINT case_documents_case_owner_fk;
ALTER TABLE public.match_profiles VALIDATE CONSTRAINT match_profiles_partner_owner_fk;
ALTER TABLE public.match_profiles VALIDATE CONSTRAINT match_profiles_referral_owner_fk;
ALTER TABLE public.match_profiles VALIDATE CONSTRAINT match_profiles_case_owner_fk;
ALTER TABLE public.referrals VALIDATE CONSTRAINT referrals_match_profile_owner_fk;
ALTER TABLE public.referrals VALIDATE CONSTRAINT referrals_case_owner_fk;
ALTER TABLE public.cases VALIDATE CONSTRAINT cases_match_profile_owner_fk;
ALTER TABLE public.follow_ups VALIDATE CONSTRAINT follow_ups_case_owner_fk;
ALTER TABLE public.case_events VALIDATE CONSTRAINT case_events_contact_owner_fk;
ALTER TABLE public.case_events VALIDATE CONSTRAINT case_events_referral_owner_fk;
ALTER TABLE public.case_events VALIDATE CONSTRAINT case_events_document_owner_fk;

-- The scorecard is a security-invoker view derived from partners/referrals, not
-- a stored child table, so there is no scorecard foreign key to replace.

CREATE OR REPLACE FUNCTION public.touch_partner_last_contact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE public.partners AS p
     SET last_contact_at = GREATEST(
       coalesce(p.last_contact_at, NEW.occurred_at),
       NEW.occurred_at
     )
   WHERE p.id = NEW.partner_id
     AND p.owner_id = NEW.owner_id;
  RETURN NEW;
END
$$;

-- Trigger execution does not require callers to hold direct EXECUTE on the
-- trigger function. Keep it out of the Data API/RPC surface as defense in depth.
REVOKE EXECUTE ON FUNCTION public.touch_partner_last_contact() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.touch_partner_last_contact() FROM anon;
REVOKE EXECUTE ON FUNCTION public.touch_partner_last_contact() FROM authenticated;

-- Create a case and its optional initial contact/follow-up as one transaction.
-- SECURITY INVOKER keeps RLS active; owner_id is always derived from auth.uid()
-- rather than trusting JSON supplied by the client.
CREATE OR REPLACE FUNCTION public.create_case_bundle(
  p_expected_owner_id uuid,
  p_case jsonb,
  p_contact jsonb DEFAULT NULL,
  p_follow_up jsonb DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_case_id uuid := (p_case ->> 'id')::uuid;
BEGIN
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF v_owner_id <> p_expected_owner_id THEN
    RAISE EXCEPTION 'Authenticated account changed before case creation' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.cases (
    id, owner_id, title, status, summary, payment_status,
    quoted_amount, paid_amount, match_profile_id
  ) VALUES (
    v_case_id,
    v_owner_id,
    p_case ->> 'title',
    coalesce(p_case ->> 'status', 'inquiry'),
    coalesce(p_case ->> 'summary', ''),
    coalesce(p_case ->> 'payment_status', 'none'),
    nullif(p_case ->> 'quoted_amount', '')::integer,
    coalesce(nullif(p_case ->> 'paid_amount', '')::integer, 0),
    nullif(p_case ->> 'match_profile_id', '')::uuid
  );

  IF p_contact IS NOT NULL AND p_contact <> 'null'::jsonb THEN
    INSERT INTO public.case_contacts (
      id, owner_id, case_id, name, relationship, phone, email, is_primary, note
    ) VALUES (
      (p_contact ->> 'id')::uuid,
      v_owner_id,
      v_case_id,
      p_contact ->> 'name',
      coalesce(p_contact ->> 'relationship', ''),
      coalesce(p_contact ->> 'phone', ''),
      coalesce(p_contact ->> 'email', ''),
      coalesce((p_contact ->> 'is_primary')::boolean, false),
      coalesce(p_contact ->> 'note', '')
    );
  END IF;

  IF p_follow_up IS NOT NULL AND p_follow_up <> 'null'::jsonb THEN
    INSERT INTO public.follow_ups (
      id, owner_id, partner_id, referral_id, case_id, title, due_on,
      status, completed_at, note, kind, due_time, waiting_on, snoozed_until
    ) VALUES (
      (p_follow_up ->> 'id')::uuid,
      v_owner_id,
      nullif(p_follow_up ->> 'partner_id', '')::uuid,
      nullif(p_follow_up ->> 'referral_id', '')::uuid,
      v_case_id,
      p_follow_up ->> 'title',
      (p_follow_up ->> 'due_on')::date,
      coalesce(p_follow_up ->> 'status', 'open'),
      nullif(p_follow_up ->> 'completed_at', '')::timestamptz,
      coalesce(p_follow_up ->> 'note', ''),
      coalesce(p_follow_up ->> 'kind', 'follow_up'),
      nullif(p_follow_up ->> 'due_time', '')::time,
      coalesce(p_follow_up ->> 'waiting_on', ''),
      nullif(p_follow_up ->> 'snoozed_until', '')::date
    );
  END IF;

  RETURN v_case_id;
END
$$;

REVOKE ALL ON FUNCTION public.create_case_bundle(uuid, jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_case_bundle(uuid, jsonb, jsonb, jsonb) TO authenticated;

-- Update a case and append its audit event atomically so the timeline can never
-- disagree with status/payment fields after a partial failure.
CREATE OR REPLACE FUNCTION public.update_case_with_event(p_case jsonb, p_event jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_case_id uuid := (p_case ->> 'id')::uuid;
  v_updated integer;
BEGIN
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;

  UPDATE public.cases
     SET title = p_case ->> 'title',
         status = p_case ->> 'status',
         summary = coalesce(p_case ->> 'summary', ''),
         payment_status = p_case ->> 'payment_status',
         quoted_amount = nullif(p_case ->> 'quoted_amount', '')::integer,
         paid_amount = coalesce(nullif(p_case ->> 'paid_amount', '')::integer, 0),
         match_profile_id = nullif(p_case ->> 'match_profile_id', '')::uuid,
         updated_at = coalesce(nullif(p_case ->> 'updated_at', '')::timestamptz, pg_catalog.now())
   WHERE id = v_case_id AND owner_id = v_owner_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'Case not found for the authenticated owner' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.case_events (
    id, owner_id, case_id, kind, body, contact_id, referral_id, document_id, occurred_at
  ) VALUES (
    (p_event ->> 'id')::uuid,
    v_owner_id,
    v_case_id,
    p_event ->> 'kind',
    coalesce(p_event ->> 'body', ''),
    nullif(p_event ->> 'contact_id', '')::uuid,
    nullif(p_event ->> 'referral_id', '')::uuid,
    nullif(p_event ->> 'document_id', '')::uuid,
    coalesce(nullif(p_event ->> 'occurred_at', '')::timestamptz, pg_catalog.now())
  )
  ON CONFLICT (id) DO UPDATE
    SET case_id = EXCLUDED.case_id,
        kind = EXCLUDED.kind,
        body = EXCLUDED.body,
        contact_id = EXCLUDED.contact_id,
        referral_id = EXCLUDED.referral_id,
        document_id = EXCLUDED.document_id,
        occurred_at = EXCLUDED.occurred_at
  WHERE public.case_events.owner_id = v_owner_id;
END
$$;

REVOKE ALL ON FUNCTION public.update_case_with_event(jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_case_with_event(jsonb, jsonb) TO authenticated;

-- Enforce the product invariant at the database boundary as well as in the
-- transactional RPC. The production preflight rejects historical duplicates
-- before this index is attempted.
CREATE UNIQUE INDEX IF NOT EXISTS case_contacts_one_primary_per_case_idx
  ON public.case_contacts (owner_id, case_id)
  WHERE is_primary;

CREATE OR REPLACE FUNCTION public.enforce_case_contact_primary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP <> 'DELETE' AND EXISTS (
    SELECT 1 FROM public.case_contacts
    WHERE case_id = NEW.case_id AND owner_id = NEW.owner_id
  ) AND NOT EXISTS (
    SELECT 1 FROM public.case_contacts
    WHERE case_id = NEW.case_id AND owner_id = NEW.owner_id AND is_primary
  ) THEN
    RAISE EXCEPTION 'A case with contacts must have exactly one primary contact' USING ERRCODE = '23514';
  END IF;

  -- An UPDATE may move a contact between cases. Validate the old parent too;
  -- coalescing OLD/NEW would inspect only the destination and could orphan the
  -- source case without a primary.
  IF TG_OP <> 'INSERT'
     AND (TG_OP = 'DELETE' OR OLD.case_id IS DISTINCT FROM NEW.case_id OR OLD.owner_id IS DISTINCT FROM NEW.owner_id)
     AND EXISTS (
       SELECT 1 FROM public.case_contacts
       WHERE case_id = OLD.case_id AND owner_id = OLD.owner_id
     ) AND NOT EXISTS (
       SELECT 1 FROM public.case_contacts
       WHERE case_id = OLD.case_id AND owner_id = OLD.owner_id AND is_primary
     ) THEN
    RAISE EXCEPTION 'A case with contacts must have exactly one primary contact' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS case_contacts_require_primary ON public.case_contacts;
CREATE CONSTRAINT TRIGGER case_contacts_require_primary
AFTER INSERT OR UPDATE OR DELETE ON public.case_contacts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.enforce_case_contact_primary();

CREATE OR REPLACE FUNCTION public.save_case_contact(p_contact jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_case_id uuid := (p_contact ->> 'case_id')::uuid;
  v_contact_id uuid := (p_contact ->> 'id')::uuid;
  v_primary boolean := coalesce((p_contact ->> 'is_primary')::boolean, false);
  v_saved integer;
BEGIN
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;

  -- Serialize primary-contact changes for one case across devices. The row
  -- lock plus the partial unique index prevents two simultaneous primaries.
  PERFORM 1 FROM public.cases
   WHERE id = v_case_id AND owner_id = v_owner_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Case not found for the authenticated owner' USING ERRCODE = 'P0002';
  END IF;

  IF v_primary THEN
    UPDATE public.case_contacts
       SET is_primary = false
     WHERE owner_id = v_owner_id AND case_id = v_case_id AND id <> v_contact_id AND is_primary;
  END IF;

  INSERT INTO public.case_contacts (
    id, owner_id, case_id, name, relationship, phone, email, is_primary, note
  ) VALUES (
    v_contact_id,
    v_owner_id,
    v_case_id,
    p_contact ->> 'name',
    coalesce(p_contact ->> 'relationship', ''),
    coalesce(p_contact ->> 'phone', ''),
    coalesce(p_contact ->> 'email', ''),
    v_primary,
    coalesce(p_contact ->> 'note', '')
  )
  ON CONFLICT (id) DO UPDATE
    SET case_id = EXCLUDED.case_id,
        name = EXCLUDED.name,
        relationship = EXCLUDED.relationship,
        phone = EXCLUDED.phone,
        email = EXCLUDED.email,
        is_primary = EXCLUDED.is_primary,
        note = EXCLUDED.note
  WHERE public.case_contacts.owner_id = v_owner_id;

  GET DIAGNOSTICS v_saved = ROW_COUNT;
  IF v_saved <> 1 THEN
    RAISE EXCEPTION 'Contact not found for the authenticated owner' USING ERRCODE = 'P0002';
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.save_case_contact(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_case_contact(jsonb) TO authenticated;

-- Complete a follow-up and create its next step atomically. The upsert makes a
-- retry safe when the server committed but the client lost the response.
CREATE OR REPLACE FUNCTION public.complete_follow_up_with_next(p_completed jsonb, p_next jsonb, p_event jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_updated integer;
BEGIN
  IF v_owner_id IS NULL THEN RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000'; END IF;

  UPDATE public.follow_ups
     SET partner_id = nullif(p_completed ->> 'partner_id', '')::uuid,
         referral_id = nullif(p_completed ->> 'referral_id', '')::uuid,
         case_id = nullif(p_completed ->> 'case_id', '')::uuid,
         title = p_completed ->> 'title',
         due_on = (p_completed ->> 'due_on')::date,
         status = p_completed ->> 'status',
         completed_at = nullif(p_completed ->> 'completed_at', '')::timestamptz,
         note = coalesce(p_completed ->> 'note', ''),
         kind = coalesce(p_completed ->> 'kind', 'follow_up'),
         due_time = nullif(p_completed ->> 'due_time', '')::time,
         waiting_on = coalesce(p_completed ->> 'waiting_on', ''),
         snoozed_until = nullif(p_completed ->> 'snoozed_until', '')::date
   WHERE id = (p_completed ->> 'id')::uuid AND owner_id = v_owner_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN RAISE EXCEPTION 'Follow-up not found for the authenticated owner' USING ERRCODE = 'P0002'; END IF;

  INSERT INTO public.follow_ups (
    id, owner_id, partner_id, referral_id, case_id, title, due_on, status,
    completed_at, note, kind, due_time, waiting_on, snoozed_until
  ) VALUES (
    (p_next ->> 'id')::uuid, v_owner_id,
    nullif(p_next ->> 'partner_id', '')::uuid,
    nullif(p_next ->> 'referral_id', '')::uuid,
    nullif(p_next ->> 'case_id', '')::uuid,
    p_next ->> 'title', (p_next ->> 'due_on')::date,
    coalesce(p_next ->> 'status', 'open'),
    nullif(p_next ->> 'completed_at', '')::timestamptz,
    coalesce(p_next ->> 'note', ''), coalesce(p_next ->> 'kind', 'follow_up'),
    nullif(p_next ->> 'due_time', '')::time,
    coalesce(p_next ->> 'waiting_on', ''),
    nullif(p_next ->> 'snoozed_until', '')::date
  )
  ON CONFLICT (id) DO UPDATE SET
    partner_id = EXCLUDED.partner_id, referral_id = EXCLUDED.referral_id,
    case_id = EXCLUDED.case_id, title = EXCLUDED.title, due_on = EXCLUDED.due_on,
    status = EXCLUDED.status, completed_at = EXCLUDED.completed_at,
    note = EXCLUDED.note, kind = EXCLUDED.kind, due_time = EXCLUDED.due_time,
    waiting_on = EXCLUDED.waiting_on, snoozed_until = EXCLUDED.snoozed_until
  WHERE public.follow_ups.owner_id = v_owner_id;

  IF p_event IS NOT NULL THEN
    INSERT INTO public.case_events (id, owner_id, case_id, kind, body, occurred_at)
    VALUES (
      (p_event ->> 'id')::uuid, v_owner_id,
      (p_event ->> 'case_id')::uuid,
      p_event ->> 'kind', coalesce(p_event ->> 'body', ''),
      coalesce(nullif(p_event ->> 'occurred_at', '')::timestamptz, pg_catalog.now())
    )
    ON CONFLICT (id) DO UPDATE SET
      case_id = EXCLUDED.case_id, kind = EXCLUDED.kind,
      body = EXCLUDED.body, occurred_at = EXCLUDED.occurred_at
    WHERE public.case_events.owner_id = v_owner_id;
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.complete_follow_up_with_next(jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_follow_up_with_next(jsonb, jsonb, jsonb) TO authenticated;

-- Complete an outcome check and update its referral in one commit.
CREATE OR REPLACE FUNCTION public.complete_follow_up_with_outcome(p_completed jsonb, p_referral_id uuid, p_outcome jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_updated integer;
BEGIN
  IF v_owner_id IS NULL THEN RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000'; END IF;

  UPDATE public.follow_ups
     SET status = p_completed ->> 'status',
         completed_at = nullif(p_completed ->> 'completed_at', '')::timestamptz,
         snoozed_until = nullif(p_completed ->> 'snoozed_until', '')::date,
         note = coalesce(p_completed ->> 'note', note)
   WHERE id = (p_completed ->> 'id')::uuid AND owner_id = v_owner_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN RAISE EXCEPTION 'Follow-up not found for the authenticated owner' USING ERRCODE = 'P0002'; END IF;

  UPDATE public.referrals
     SET admitted = CASE WHEN p_outcome ? 'admitted' THEN (p_outcome ->> 'admitted')::boolean ELSE admitted END,
         admitted_on = CASE WHEN p_outcome ? 'admitted_on' THEN nullif(p_outcome ->> 'admitted_on', '')::date ELSE admitted_on END,
         family_experience = CASE WHEN p_outcome ? 'family_experience' THEN nullif(p_outcome ->> 'family_experience', '')::smallint ELSE family_experience END,
         outcome_note = CASE WHEN p_outcome ? 'outcome_note' THEN coalesce(p_outcome ->> 'outcome_note', '') ELSE outcome_note END,
         outcome = CASE WHEN p_outcome ? 'outcome' THEN nullif(p_outcome ->> 'outcome', '') ELSE outcome END
   WHERE id = p_referral_id AND owner_id = v_owner_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN RAISE EXCEPTION 'Referral not found for the authenticated owner' USING ERRCODE = 'P0002'; END IF;
END
$$;

REVOKE ALL ON FUNCTION public.complete_follow_up_with_outcome(jsonb, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_follow_up_with_outcome(jsonb, uuid, jsonb) TO authenticated;

-- Case-linked close-loop is also a single transaction: follow-up completion,
-- case state, and audit event either all commit or all roll back.
CREATE OR REPLACE FUNCTION public.complete_follow_up_with_case(p_completed jsonb, p_case jsonb, p_event jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_updated integer;
BEGIN
  IF v_owner_id IS NULL THEN RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000'; END IF;

  UPDATE public.follow_ups
     SET status = p_completed ->> 'status',
         completed_at = nullif(p_completed ->> 'completed_at', '')::timestamptz,
         snoozed_until = nullif(p_completed ->> 'snoozed_until', '')::date,
         note = coalesce(p_completed ->> 'note', note)
   WHERE id = (p_completed ->> 'id')::uuid
     AND owner_id = v_owner_id
     AND case_id = (p_case ->> 'id')::uuid;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN RAISE EXCEPTION 'Case-linked follow-up not found for the authenticated owner' USING ERRCODE = 'P0002'; END IF;

  PERFORM public.update_case_with_event(p_case, p_event);
END
$$;

REVOKE ALL ON FUNCTION public.complete_follow_up_with_case(jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_follow_up_with_case(jsonb, jsonb, jsonb) TO authenticated;

-- Document metadata and its required timeline entry are one database action;
-- storage cleanup remains the client's compensation boundary.
CREATE OR REPLACE FUNCTION public.save_case_document_with_event(p_document jsonb, p_event jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_case_id uuid := (p_document ->> 'case_id')::uuid;
  v_document_id uuid := (p_document ->> 'id')::uuid;
BEGIN
  IF v_owner_id IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  IF (p_event ->> 'case_id')::uuid IS DISTINCT FROM v_case_id
     OR (p_event ->> 'document_id')::uuid IS DISTINCT FROM v_document_id THEN
    RAISE EXCEPTION 'Document event links do not match';
  END IF;

  INSERT INTO public.case_documents (
    id, owner_id, case_id, label, storage_path, mime_type, size_bytes, created_at
  ) VALUES (
    v_document_id, v_owner_id, v_case_id,
    coalesce(p_document ->> 'label', ''), p_document ->> 'storage_path',
    coalesce(p_document ->> 'mime_type', 'application/octet-stream'),
    nullif(p_document ->> 'size_bytes', '')::bigint,
    coalesce(nullif(p_document ->> 'created_at', '')::timestamptz, now())
  )
  ON CONFLICT (id) DO UPDATE
     SET label = EXCLUDED.label,
         storage_path = EXCLUDED.storage_path,
         mime_type = EXCLUDED.mime_type,
         size_bytes = EXCLUDED.size_bytes
   WHERE case_documents.owner_id = v_owner_id;

  INSERT INTO public.case_events (
    id, owner_id, case_id, kind, body, contact_id, referral_id, document_id, occurred_at
  ) VALUES (
    (p_event ->> 'id')::uuid, v_owner_id, v_case_id,
    coalesce(p_event ->> 'kind', 'document'), coalesce(p_event ->> 'body', ''),
    nullif(p_event ->> 'contact_id', '')::uuid,
    nullif(p_event ->> 'referral_id', '')::uuid,
    v_document_id,
    coalesce(nullif(p_event ->> 'occurred_at', '')::timestamptz, now())
  )
  ON CONFLICT (id) DO UPDATE
     SET kind = EXCLUDED.kind, body = EXCLUDED.body, document_id = EXCLUDED.document_id,
         occurred_at = EXCLUDED.occurred_at
   WHERE case_events.owner_id = v_owner_id;
END;
$$;
REVOKE ALL ON FUNCTION public.save_case_document_with_event(jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_case_document_with_event(jsonb, jsonb) TO authenticated;

-- If object deletion fails after metadata deletion, restore the document row and
-- its timeline links together so compensation cannot leave a broken audit trail.
CREATE OR REPLACE FUNCTION public.restore_case_document(p_document jsonb, p_event_ids uuid[] DEFAULT ARRAY[]::uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_case_id uuid := (p_document ->> 'case_id')::uuid;
  v_document_id uuid := (p_document ->> 'id')::uuid;
BEGIN
  IF v_owner_id IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;

  INSERT INTO public.case_documents (
    id, owner_id, case_id, label, storage_path, mime_type, size_bytes, created_at
  ) VALUES (
    v_document_id, v_owner_id, v_case_id,
    coalesce(p_document ->> 'label', ''), p_document ->> 'storage_path',
    coalesce(p_document ->> 'mime_type', 'application/octet-stream'),
    nullif(p_document ->> 'size_bytes', '')::bigint,
    coalesce(nullif(p_document ->> 'created_at', '')::timestamptz, now())
  )
  ON CONFLICT (id) DO UPDATE
     SET label = EXCLUDED.label, storage_path = EXCLUDED.storage_path,
         mime_type = EXCLUDED.mime_type, size_bytes = EXCLUDED.size_bytes
   WHERE case_documents.owner_id = v_owner_id;

  UPDATE public.case_events
     SET document_id = v_document_id
   WHERE owner_id = v_owner_id
     AND case_id = v_case_id
     AND id = ANY(coalesce(p_event_ids, ARRAY[]::uuid[]));
END;
$$;
REVOKE ALL ON FUNCTION public.restore_case_document(jsonb, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_case_document(jsonb, uuid[]) TO authenticated;

-- Save a match and link its case in one idempotent transaction.
CREATE OR REPLACE FUNCTION public.save_match_with_case(p_expected_owner_id uuid, p_match jsonb, p_case_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_owner_id uuid := auth.uid(); v_updated integer;
BEGIN
  IF v_owner_id IS NULL OR v_owner_id <> p_expected_owner_id THEN RAISE EXCEPTION 'Authenticated account changed' USING ERRCODE='42501'; END IF;
  INSERT INTO public.match_profiles (id, owner_id, client_label, level_of_care, state, insurance, network_preferences, max_budget, therapies, status, assigned_partner_id, referral_id, case_id)
  VALUES ((p_match->>'id')::uuid, v_owner_id, p_match->>'client_label', p_match->>'level_of_care', p_match->>'state', p_match->>'insurance', coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p_match->'network_preferences','[]'::jsonb))), ARRAY[]::text[]), nullif(p_match->>'max_budget','')::integer, coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p_match->'therapies','[]'::jsonb))), ARRAY[]::text[]), coalesce(p_match->>'status','Matching'), nullif(p_match->>'assigned_partner_id','')::uuid, nullif(p_match->>'referral_id','')::uuid, p_case_id)
  ON CONFLICT (id) DO UPDATE SET client_label=EXCLUDED.client_label, level_of_care=EXCLUDED.level_of_care, state=EXCLUDED.state, insurance=EXCLUDED.insurance, network_preferences=EXCLUDED.network_preferences, max_budget=EXCLUDED.max_budget, therapies=EXCLUDED.therapies, status=EXCLUDED.status, assigned_partner_id=EXCLUDED.assigned_partner_id, referral_id=EXCLUDED.referral_id, case_id=EXCLUDED.case_id WHERE match_profiles.owner_id=v_owner_id;
  UPDATE public.cases SET match_profile_id=(p_match->>'id')::uuid WHERE id=p_case_id AND owner_id=v_owner_id;
  GET DIAGNOSTICS v_updated=ROW_COUNT;
  IF v_updated<>1 THEN RAISE EXCEPTION 'Owned case was not found'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.save_match_with_case(uuid,jsonb,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_match_with_case(uuid,jsonb,uuid) TO authenticated;

-- Create/update a referral and assign its match as one idempotent transaction.
CREATE OR REPLACE FUNCTION public.assign_match_referral(p_expected_owner_id uuid, p_referral jsonb, p_match jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_owner_id uuid := auth.uid(); v_updated integer;
BEGIN
  IF v_owner_id IS NULL OR v_owner_id<>p_expected_owner_id THEN RAISE EXCEPTION 'Authenticated account changed' USING ERRCODE='42501'; END IF;
  -- Upsert the match first so rapid assignment is safe even while the standalone
  -- match save is still in flight. Keep referral_id null until its parent exists.
  IF EXISTS (SELECT 1 FROM public.match_profiles WHERE id=(p_match->>'id')::uuid AND owner_id=v_owner_id) THEN
    UPDATE public.match_profiles SET
      client_label=coalesce(p_match->>'client_label',client_label),
      level_of_care=coalesce(p_match->>'level_of_care',level_of_care),
      state=coalesce(p_match->>'state',state),
      insurance=coalesce(p_match->>'insurance',insurance),
      status=coalesce(p_match->>'status',status),
      assigned_partner_id=coalesce(nullif(p_match->>'assigned_partner_id','')::uuid,assigned_partner_id),
      case_id=coalesce(nullif(p_match->>'case_id','')::uuid,case_id), updated_at=now()
    WHERE id=(p_match->>'id')::uuid AND owner_id=v_owner_id;
  ELSE
    INSERT INTO public.match_profiles (id,owner_id,client_label,level_of_care,state,insurance,network_preferences,max_budget,therapies,status,assigned_partner_id,referral_id,case_id)
    VALUES ((p_match->>'id')::uuid,v_owner_id,p_match->>'client_label',p_match->>'level_of_care',p_match->>'state',p_match->>'insurance',coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p_match->'network_preferences','[]'::jsonb))),ARRAY[]::text[]),nullif(p_match->>'max_budget','')::integer,coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p_match->'therapies','[]'::jsonb))),ARRAY[]::text[]),coalesce(p_match->>'status','Matching'),nullif(p_match->>'assigned_partner_id','')::uuid,NULL,nullif(p_match->>'case_id','')::uuid);
  END IF;
  INSERT INTO public.referrals (id,owner_id,partner_id,direction,referred_on,client_label,outcome,note,packet_sent_at,match_profile_id,case_id,admitted,admitted_on,family_experience,outcome_note)
  VALUES ((p_referral->>'id')::uuid,v_owner_id,(p_referral->>'partner_id')::uuid,p_referral->>'direction',(p_referral->>'referred_on')::date,p_referral->>'client_label',p_referral->>'outcome',coalesce(p_referral->>'note',''),nullif(p_referral->>'packet_sent_at','')::timestamptz,nullif(p_referral->>'match_profile_id','')::uuid,nullif(p_referral->>'case_id','')::uuid,nullif(p_referral->>'admitted','')::boolean,nullif(p_referral->>'admitted_on','')::date,nullif(p_referral->>'family_experience','')::smallint,coalesce(p_referral->>'outcome_note',''))
  ON CONFLICT (id) DO UPDATE SET partner_id=EXCLUDED.partner_id,direction=EXCLUDED.direction,referred_on=EXCLUDED.referred_on,client_label=EXCLUDED.client_label,outcome=EXCLUDED.outcome,note=EXCLUDED.note,packet_sent_at=EXCLUDED.packet_sent_at,match_profile_id=EXCLUDED.match_profile_id,case_id=EXCLUDED.case_id,admitted=EXCLUDED.admitted,admitted_on=EXCLUDED.admitted_on,family_experience=EXCLUDED.family_experience,outcome_note=EXCLUDED.outcome_note WHERE referrals.owner_id=v_owner_id;
  UPDATE public.match_profiles SET client_label=p_match->>'client_label',status=p_match->>'status',assigned_partner_id=nullif(p_match->>'assigned_partner_id','')::uuid,referral_id=(p_referral->>'id')::uuid,case_id=nullif(p_match->>'case_id','')::uuid,updated_at=now() WHERE id=(p_match->>'id')::uuid AND owner_id=v_owner_id;
  GET DIAGNOSTICS v_updated=ROW_COUNT; IF v_updated<>1 THEN RAISE EXCEPTION 'Owned match was not found'; END IF;
  IF nullif(p_match->>'case_id','') IS NOT NULL THEN
    UPDATE public.cases SET match_profile_id=(p_match->>'id')::uuid WHERE id=(p_match->>'case_id')::uuid AND owner_id=v_owner_id;
    GET DIAGNOSTICS v_updated=ROW_COUNT; IF v_updated<>1 THEN RAISE EXCEPTION 'Owned case was not found'; END IF;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.assign_match_referral(uuid,jsonb,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_match_referral(uuid,jsonb,jsonb) TO authenticated;

-- Finalize packet send as one retry-safe transaction.
CREATE OR REPLACE FUNCTION public.finalize_match_packet(p_expected_owner_id uuid,p_referral jsonb,p_match jsonb,p_touch jsonb,p_follow_up jsonb,p_event jsonb DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_owner_id uuid:=auth.uid(); v_updated integer;
BEGIN
  IF v_owner_id IS NULL OR v_owner_id<>p_expected_owner_id THEN RAISE EXCEPTION 'Authenticated account changed' USING ERRCODE='42501'; END IF;
  IF p_match IS NOT NULL AND p_match<>'null'::jsonb THEN
    IF EXISTS (SELECT 1 FROM public.match_profiles WHERE id=(p_match->>'id')::uuid AND owner_id=v_owner_id) THEN
      UPDATE public.match_profiles SET
        client_label=coalesce(p_match->>'client_label',client_label),
        level_of_care=coalesce(p_match->>'level_of_care',level_of_care),
        state=coalesce(p_match->>'state',state),
        insurance=coalesce(p_match->>'insurance',insurance),
        status=coalesce(p_match->>'status',status),
        assigned_partner_id=coalesce(nullif(p_match->>'assigned_partner_id','')::uuid,assigned_partner_id),
        case_id=coalesce(nullif(p_match->>'case_id','')::uuid,case_id), updated_at=now()
      WHERE id=(p_match->>'id')::uuid AND owner_id=v_owner_id;
    ELSE
      INSERT INTO public.match_profiles (id,owner_id,client_label,level_of_care,state,insurance,network_preferences,max_budget,therapies,status,assigned_partner_id,referral_id,case_id)
      VALUES ((p_match->>'id')::uuid,v_owner_id,p_match->>'client_label',p_match->>'level_of_care',p_match->>'state',p_match->>'insurance',coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p_match->'network_preferences','[]'::jsonb))),ARRAY[]::text[]),nullif(p_match->>'max_budget','')::integer,coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p_match->'therapies','[]'::jsonb))),ARRAY[]::text[]),coalesce(p_match->>'status','Referred'),nullif(p_match->>'assigned_partner_id','')::uuid,NULL,nullif(p_match->>'case_id','')::uuid);
    END IF;
  END IF;
  INSERT INTO public.referrals (id,owner_id,partner_id,direction,referred_on,client_label,outcome,note,packet_sent_at,match_profile_id,case_id,admitted,admitted_on,family_experience,outcome_note)
  VALUES ((p_referral->>'id')::uuid,v_owner_id,(p_referral->>'partner_id')::uuid,p_referral->>'direction',(p_referral->>'referred_on')::date,p_referral->>'client_label',p_referral->>'outcome',coalesce(p_referral->>'note',''),nullif(p_referral->>'packet_sent_at','')::timestamptz,nullif(p_referral->>'match_profile_id','')::uuid,nullif(p_referral->>'case_id','')::uuid,nullif(p_referral->>'admitted','')::boolean,nullif(p_referral->>'admitted_on','')::date,nullif(p_referral->>'family_experience','')::smallint,coalesce(p_referral->>'outcome_note',''))
  ON CONFLICT (id) DO UPDATE SET packet_sent_at=EXCLUDED.packet_sent_at,match_profile_id=EXCLUDED.match_profile_id,case_id=EXCLUDED.case_id WHERE referrals.owner_id=v_owner_id;
  IF p_match IS NOT NULL AND p_match<>'null'::jsonb THEN
    UPDATE public.match_profiles SET status=p_match->>'status',assigned_partner_id=nullif(p_match->>'assigned_partner_id','')::uuid,referral_id=(p_referral->>'id')::uuid,updated_at=now() WHERE id=(p_match->>'id')::uuid AND owner_id=v_owner_id;
    GET DIAGNOSTICS v_updated=ROW_COUNT; IF v_updated<>1 THEN RAISE EXCEPTION 'Owned match was not found'; END IF;
  END IF;
  INSERT INTO public.touches (id,owner_id,partner_id,kind,note,occurred_at) VALUES ((p_touch->>'id')::uuid,v_owner_id,(p_touch->>'partner_id')::uuid,p_touch->>'kind',coalesce(p_touch->>'note',''),(p_touch->>'occurred_at')::timestamptz) ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.follow_ups (id,owner_id,partner_id,referral_id,case_id,title,due_on,status,completed_at,note,kind,due_time,waiting_on,snoozed_until)
  VALUES ((p_follow_up->>'id')::uuid,v_owner_id,nullif(p_follow_up->>'partner_id','')::uuid,(p_referral->>'id')::uuid,nullif(p_follow_up->>'case_id','')::uuid,p_follow_up->>'title',(p_follow_up->>'due_on')::date,coalesce(p_follow_up->>'status','open'),nullif(p_follow_up->>'completed_at','')::timestamptz,coalesce(p_follow_up->>'note',''),coalesce(p_follow_up->>'kind','follow_up'),nullif(p_follow_up->>'due_time','')::time,coalesce(p_follow_up->>'waiting_on',''),nullif(p_follow_up->>'snoozed_until','')::date) ON CONFLICT (id) DO NOTHING;
  IF p_event IS NOT NULL AND p_event<>'null'::jsonb THEN
    INSERT INTO public.case_events (id,owner_id,case_id,kind,body,contact_id,referral_id,document_id,occurred_at) VALUES ((p_event->>'id')::uuid,v_owner_id,(p_event->>'case_id')::uuid,p_event->>'kind',p_event->>'body',nullif(p_event->>'contact_id','')::uuid,(p_referral->>'id')::uuid,nullif(p_event->>'document_id','')::uuid,coalesce(nullif(p_event->>'occurred_at','')::timestamptz,now())) ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.finalize_match_packet(uuid,jsonb,jsonb,jsonb,jsonb,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalize_match_packet(uuid,jsonb,jsonb,jsonb,jsonb,jsonb) TO authenticated;

-- Record the successful OS contact handoff as one retry-safe action. Cards can
-- be linked to a case, a partner, or both; either row may therefore be absent.
CREATE OR REPLACE FUNCTION public.log_contact_activity(p_expected_owner_id uuid, p_event jsonb DEFAULT NULL, p_touch jsonb DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_owner_id uuid := auth.uid();
BEGIN
  IF v_owner_id IS NULL OR v_owner_id <> p_expected_owner_id THEN
    RAISE EXCEPTION 'Authenticated account changed' USING ERRCODE = '42501';
  END IF;
  IF (p_event IS NULL OR p_event = 'null'::jsonb) AND (p_touch IS NULL OR p_touch = 'null'::jsonb) THEN
    RAISE EXCEPTION 'A case event or partner touch is required';
  END IF;
  IF p_event IS NOT NULL AND p_event <> 'null'::jsonb THEN
    INSERT INTO public.case_events (id,owner_id,case_id,kind,body,contact_id,referral_id,document_id,occurred_at)
    VALUES ((p_event->>'id')::uuid,v_owner_id,(p_event->>'case_id')::uuid,p_event->>'kind',coalesce(p_event->>'body',''),nullif(p_event->>'contact_id','')::uuid,nullif(p_event->>'referral_id','')::uuid,nullif(p_event->>'document_id','')::uuid,coalesce(nullif(p_event->>'occurred_at','')::timestamptz,now()))
    ON CONFLICT (id) DO UPDATE SET kind=EXCLUDED.kind,body=EXCLUDED.body,contact_id=EXCLUDED.contact_id,occurred_at=EXCLUDED.occurred_at WHERE case_events.owner_id=v_owner_id;
  END IF;
  IF p_touch IS NOT NULL AND p_touch <> 'null'::jsonb THEN
    INSERT INTO public.touches (id,owner_id,partner_id,kind,note,occurred_at)
    VALUES ((p_touch->>'id')::uuid,v_owner_id,(p_touch->>'partner_id')::uuid,p_touch->>'kind',coalesce(p_touch->>'note',''),coalesce(nullif(p_touch->>'occurred_at','')::timestamptz,now()))
    ON CONFLICT (id) DO UPDATE SET kind=EXCLUDED.kind,note=EXCLUDED.note,occurred_at=EXCLUDED.occurred_at WHERE touches.owner_id=v_owner_id;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.log_contact_activity(uuid,jsonb,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_contact_activity(uuid,jsonb,jsonb) TO authenticated;

COMMIT;
