-- Business operations: attribution, stage history, and external-system sync.
-- Square remains authoritative for money and PandaDoc for contracts. Referent
-- stores only the case linkage and a reporting/status mirror.

ALTER TABLE public.cases
  ADD COLUMN lead_source text NOT NULL DEFAULT 'Unspecified',
  ADD COLUMN lead_source_detail text NOT NULL DEFAULT '',
  ADD COLUMN lost_reason text NOT NULL DEFAULT '',
  ADD COLUMN stage_changed_at timestamptz NOT NULL DEFAULT now();

-- Preserve the existing case activity ordering while seeding the stage clock.
-- The normal cases_updated_at trigger would otherwise make every historical
-- case look newly active when this migration runs.
ALTER TABLE public.cases DISABLE TRIGGER cases_updated_at;
UPDATE public.cases SET stage_changed_at = created_at;
ALTER TABLE public.cases ENABLE TRIGGER cases_updated_at;

ALTER TABLE public.cases
  ADD CONSTRAINT cases_lead_source_length CHECK (
    pg_catalog.length(pg_catalog.btrim(lead_source)) BETWEEN 1 AND 80
  ),
  ADD CONSTRAINT cases_lead_source_detail_length CHECK (
    pg_catalog.length(lead_source_detail) <= 500
  ),
  ADD CONSTRAINT cases_lost_reason_length CHECK (
    pg_catalog.length(lost_reason) <= 500
  );

CREATE INDEX cases_owner_lead_source_idx
  ON public.cases (owner_id, lead_source, created_at DESC);

CREATE TABLE public.case_stage_history (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  case_id    uuid NOT NULL,
  status     text NOT NULL CHECK (
    status IN ('inquiry','consult','deciding','engaged','intervention','placed','aftercare','closed','lost')
  ),
  entered_at timestamptz NOT NULL DEFAULT now(),
  exited_at  timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_stage_history_case_owner_fk
    FOREIGN KEY (case_id, owner_id)
    REFERENCES public.cases(id, owner_id)
    ON DELETE CASCADE,
  CONSTRAINT case_stage_history_time_order CHECK (
    exited_at IS NULL OR exited_at >= entered_at
  )
);

CREATE INDEX case_stage_history_owner_case_idx
  ON public.case_stage_history (owner_id, case_id, entered_at DESC);
CREATE UNIQUE INDEX case_stage_history_one_open_idx
  ON public.case_stage_history (owner_id, case_id)
  WHERE exited_at IS NULL;

INSERT INTO public.case_stage_history (owner_id, case_id, status, entered_at)
SELECT owner_id, id, status, created_at
  FROM public.cases;

CREATE OR REPLACE FUNCTION public.set_case_stage_changed_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.stage_changed_at := pg_catalog.clock_timestamp();
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.track_case_stage_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz := coalesce(NEW.stage_changed_at, pg_catalog.clock_timestamp());
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.case_stage_history (owner_id, case_id, status, entered_at)
    VALUES (NEW.owner_id, NEW.id, NEW.status, coalesce(NEW.stage_changed_at, NEW.created_at, v_now));
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE public.case_stage_history
       SET exited_at = v_now
     WHERE owner_id = NEW.owner_id
       AND case_id = NEW.id
       AND exited_at IS NULL;

    INSERT INTO public.case_stage_history (owner_id, case_id, status, entered_at)
    VALUES (NEW.owner_id, NEW.id, NEW.status, v_now);
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER cases_set_stage_changed_at
BEFORE UPDATE OF status ON public.cases
FOR EACH ROW EXECUTE FUNCTION public.set_case_stage_changed_at();

CREATE TRIGGER cases_track_stage_history
AFTER INSERT OR UPDATE OF status ON public.cases
FOR EACH ROW EXECUTE FUNCTION public.track_case_stage_history();

REVOKE ALL ON FUNCTION public.set_case_stage_changed_at() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.track_case_stage_history() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.case_stage_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "case_stage_history: owner read" ON public.case_stage_history
  FOR SELECT USING (owner_id = auth.uid());
REVOKE ALL ON public.case_stage_history FROM anon, PUBLIC;
GRANT SELECT ON public.case_stage_history TO authenticated;

CREATE TABLE public.case_integrations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  case_id        uuid NOT NULL,
  provider       text NOT NULL CHECK (provider IN ('square','pandadoc')),
  record_type    text NOT NULL CHECK (record_type IN ('customer','invoice','payment','refund','document')),
  external_id    text NOT NULL,
  status         text NOT NULL DEFAULT 'linked',
  amount_cents   bigint CHECK (amount_cents IS NULL OR amount_cents >= 0),
  paid_amount_cents bigint CHECK (paid_amount_cents IS NULL OR paid_amount_cents >= 0),
  currency       text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  due_on         date,
  completed_at   timestamptz,
  external_url   text NOT NULL DEFAULT '',
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  last_synced_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_integrations_case_owner_fk
    FOREIGN KEY (case_id, owner_id)
    REFERENCES public.cases(id, owner_id)
    ON DELETE CASCADE,
  CONSTRAINT case_integrations_external_id_length CHECK (
    pg_catalog.length(pg_catalog.btrim(external_id)) BETWEEN 1 AND 255
  ),
  CONSTRAINT case_integrations_status_length CHECK (
    pg_catalog.length(pg_catalog.btrim(status)) BETWEEN 1 AND 100
  ),
  CONSTRAINT case_integrations_external_url_length CHECK (
    pg_catalog.length(external_url) <= 2048
    AND (external_url = '' OR external_url ~* '^https://')
  ),
  CONSTRAINT case_integrations_provider_type_check CHECK (
    (provider = 'pandadoc' AND record_type = 'document')
    OR (provider = 'square' AND record_type IN ('customer','invoice','payment','refund'))
  ),
  UNIQUE (owner_id, provider, record_type, external_id)
);

CREATE INDEX case_integrations_owner_case_idx
  ON public.case_integrations (owner_id, case_id, provider, updated_at DESC);
CREATE INDEX case_integrations_due_idx
  ON public.case_integrations (owner_id, provider, due_on)
  WHERE due_on IS NOT NULL;
CREATE TRIGGER case_integrations_updated_at
BEFORE UPDATE ON public.case_integrations
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.case_integrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "case_integrations: owner all" ON public.case_integrations
  FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
REVOKE ALL ON public.case_integrations FROM anon, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.case_integrations TO authenticated;

-- Webhook receipts are service-only. The provider event id is the idempotency
-- key, so retry deliveries never duplicate downstream changes.
CREATE TABLE public.integration_webhook_events (
  provider          text NOT NULL CHECK (provider IN ('square','pandadoc')),
  external_event_id text NOT NULL,
  event_type        text NOT NULL DEFAULT '',
  payload           jsonb NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  processing_error  text NOT NULL DEFAULT '',
  PRIMARY KEY (provider, external_event_id)
);

ALTER TABLE public.integration_webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.integration_webhook_events FROM anon, authenticated, PUBLIC;

-- Patch business metadata without sending a stale whole-case snapshot. The
-- audit event is inserted in the same transaction.
CREATE OR REPLACE FUNCTION public.update_case_business_details_with_event(
  p_case_id uuid,
  p_event_id uuid,
  p_patch jsonb,
  p_event_body text
)
RETURNS TABLE (
  lead_source text,
  lead_source_detail text,
  lost_reason text,
  occurred_at timestamptz,
  event_body text
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_source text;
  v_detail text;
  v_lost_reason text;
  v_occurred_at timestamptz;
  v_body text := pg_catalog.left(coalesce(p_event_body, 'Business details updated'), 1000);
  v_existing public.case_events%ROWTYPE;
BEGIN
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF p_patch IS NULL OR p_patch = '{}'::jsonb OR EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_object_keys(p_patch) AS field
    WHERE field NOT IN ('lead_source', 'lead_source_detail', 'lost_reason')
  ) THEN
    RAISE EXCEPTION 'Business-details patch contains no supported fields' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'lead_source'
     AND pg_catalog.btrim(coalesce(p_patch ->> 'lead_source', '')) = '' THEN
    RAISE EXCEPTION 'Lead source is required' USING ERRCODE = '22023';
  END IF;

  SELECT c.lead_source, c.lead_source_detail, c.lost_reason
    INTO v_source, v_detail, v_lost_reason
    FROM public.cases AS c
   WHERE c.id = p_case_id AND c.owner_id = v_owner_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Case not found for the authenticated owner' USING ERRCODE = 'P0002';
  END IF;

  SELECT e.* INTO v_existing
    FROM public.case_events AS e
   WHERE e.id = p_event_id AND e.owner_id = v_owner_id;

  IF FOUND THEN
    IF v_existing.case_id <> p_case_id
       OR v_existing.kind <> 'system'
       OR v_existing.body <> v_body THEN
      RAISE EXCEPTION 'Case event ID is already used by another request' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT v_source, v_detail, v_lost_reason, v_existing.occurred_at, v_existing.body;
    RETURN;
  END IF;

  v_source := CASE WHEN p_patch ? 'lead_source'
    THEN pg_catalog.btrim(p_patch ->> 'lead_source') ELSE v_source END;
  v_detail := CASE WHEN p_patch ? 'lead_source_detail'
    THEN pg_catalog.btrim(coalesce(p_patch ->> 'lead_source_detail', '')) ELSE v_detail END;
  v_lost_reason := CASE WHEN p_patch ? 'lost_reason'
    THEN pg_catalog.btrim(coalesce(p_patch ->> 'lost_reason', '')) ELSE v_lost_reason END;
  v_occurred_at := pg_catalog.clock_timestamp();

  UPDATE public.cases AS c
     SET lead_source = v_source,
         lead_source_detail = v_detail,
         lost_reason = v_lost_reason,
         updated_at = v_occurred_at
   WHERE c.id = p_case_id AND c.owner_id = v_owner_id;

  INSERT INTO public.case_events (id, owner_id, case_id, kind, body, occurred_at)
  VALUES (p_event_id, v_owner_id, p_case_id, 'system', v_body, v_occurred_at);

  RETURN QUERY SELECT v_source, v_detail, v_lost_reason, v_occurred_at, v_body;
END
$$;

REVOKE ALL ON FUNCTION public.update_case_business_details_with_event(uuid, uuid, jsonb, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_case_business_details_with_event(uuid, uuid, jsonb, text)
  TO authenticated;

-- Preserve the transactional case + primary contact + first-call creation while
-- accepting the new attribution fields.
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
    quoted_amount, paid_amount, match_profile_id,
    lead_source, lead_source_detail, lost_reason
  ) VALUES (
    v_case_id,
    v_owner_id,
    p_case ->> 'title',
    coalesce(p_case ->> 'status', 'inquiry'),
    coalesce(p_case ->> 'summary', ''),
    coalesce(p_case ->> 'payment_status', 'none'),
    nullif(p_case ->> 'quoted_amount', '')::integer,
    coalesce(nullif(p_case ->> 'paid_amount', '')::integer, 0),
    nullif(p_case ->> 'match_profile_id', '')::uuid,
    coalesce(nullif(pg_catalog.btrim(p_case ->> 'lead_source'), ''), 'Unspecified'),
    coalesce(p_case ->> 'lead_source_detail', ''),
    coalesce(p_case ->> 'lost_reason', '')
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
