-- Record an additional case payment without lost updates across devices.
-- The event UUID is the idempotency key: retrying the same request returns the
-- current case totals without incrementing revenue a second time.

CREATE OR REPLACE FUNCTION public.record_case_payment(
  p_case_id uuid,
  p_event_id uuid,
  p_amount integer,
  p_note text DEFAULT ''
)
RETURNS TABLE (
  paid_amount integer,
  payment_status text,
  occurred_at timestamptz,
  event_body text
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_paid_amount integer;
  v_payment_status text;
  v_occurred_at timestamptz;
  v_event_body text;
  v_event_prefix text;
  v_existing public.case_events%ROWTYPE;
  v_note text := pg_catalog.left(
    pg_catalog.btrim(
      pg_catalog.regexp_replace(coalesce(p_note, ''), E'[\r\n]+', ' ', 'g')
    ),
    200
  );
BEGIN
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF p_case_id IS NULL OR p_event_id IS NULL THEN
    RAISE EXCEPTION 'Case and payment event IDs are required' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 10000000 THEN
    RAISE EXCEPTION 'Payment amount must be between 1 and 10000000 whole dollars' USING ERRCODE = '22023';
  END IF;

  v_event_prefix := 'Payment received: $'
    || pg_catalog.to_char(p_amount, 'FM999G999G999G990')
    || CASE WHEN v_note <> '' THEN ' · ' || v_note ELSE '' END
    || ' · Total paid: $';

  -- Serialize every payment for this case before checking the idempotency key.
  SELECT c.paid_amount, c.payment_status
    INTO v_paid_amount, v_payment_status
    FROM public.cases AS c
   WHERE c.id = p_case_id
     AND c.owner_id = v_owner_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Case not found for the authenticated owner' USING ERRCODE = 'P0002';
  END IF;

  SELECT e.*
    INTO v_existing
    FROM public.case_events AS e
   WHERE e.id = p_event_id
     AND e.owner_id = v_owner_id;

  IF FOUND THEN
    IF v_existing.case_id <> p_case_id
       OR v_existing.kind <> 'payment'
       OR pg_catalog.left(v_existing.body, pg_catalog.length(v_event_prefix)) <> v_event_prefix THEN
      RAISE EXCEPTION 'Payment event ID is already used by a different payment request' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT v_paid_amount, v_payment_status, v_existing.occurred_at, v_existing.body;
    RETURN;
  END IF;

  v_occurred_at := pg_catalog.clock_timestamp();
  UPDATE public.cases AS c
     SET paid_amount = c.paid_amount + p_amount,
         payment_status = CASE
           WHEN c.quoted_amount IS NOT NULL AND c.paid_amount + p_amount >= c.quoted_amount THEN 'paid'
           ELSE 'partial'
         END,
         updated_at = v_occurred_at
   WHERE c.id = p_case_id
     AND c.owner_id = v_owner_id
  RETURNING c.paid_amount, c.payment_status
       INTO v_paid_amount, v_payment_status;

  v_event_body := v_event_prefix || pg_catalog.to_char(v_paid_amount, 'FM999G999G999G990');

  INSERT INTO public.case_events (
    id, owner_id, case_id, kind, body, occurred_at
  ) VALUES (
    p_event_id, v_owner_id, p_case_id, 'payment', v_event_body, v_occurred_at
  );

  RETURN QUERY SELECT v_paid_amount, v_payment_status, v_occurred_at, v_event_body;
END
$$;

REVOKE ALL ON FUNCTION public.record_case_payment(uuid, uuid, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_case_payment(uuid, uuid, integer, text) TO authenticated;

-- Limit the legacy whole-case workflow RPC to the fields implied by its event.
-- This prevents a stale title/status edit from replacing newer payment totals.
CREATE OR REPLACE FUNCTION public.update_case_with_event(p_case jsonb, p_event jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_case_id uuid := (p_case ->> 'id')::uuid;
  v_kind text := p_event ->> 'kind';
  v_updated integer;
BEGIN
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF v_kind <> 'status_change' THEN
    RAISE EXCEPTION 'Use a field-specific case RPC for this update' USING ERRCODE = '22023';
  END IF;

  UPDATE public.cases AS c
     SET status = p_case ->> 'status',
         updated_at = pg_catalog.now()
   WHERE c.id = v_case_id AND c.owner_id = v_owner_id;
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
    v_kind,
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
  WHERE public.case_events.owner_id = v_owner_id
    AND public.case_events.case_id = EXCLUDED.case_id
    AND public.case_events.kind = EXCLUDED.kind;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'Case event ID is already used by another request' USING ERRCODE = '23505';
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.update_case_with_event(jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_case_with_event(jsonb, jsonb) TO authenticated;

-- Patch case name/summary without sending a stale whole-case snapshot.
CREATE OR REPLACE FUNCTION public.update_case_details_with_event(
  p_case_id uuid,
  p_event_id uuid,
  p_patch jsonb,
  p_event_body text
)
RETURNS TABLE (title text, summary text, occurred_at timestamptz, event_body text)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_title text;
  v_summary text;
  v_occurred_at timestamptz;
  v_existing public.case_events%ROWTYPE;
BEGIN
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF p_patch IS NULL OR p_patch = '{}'::jsonb OR EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_object_keys(p_patch) AS field
    WHERE field NOT IN ('title', 'summary')
  ) THEN
    RAISE EXCEPTION 'Case-details patch contains no supported fields' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'title' AND pg_catalog.btrim(coalesce(p_patch ->> 'title', '')) = '' THEN
    RAISE EXCEPTION 'Case title is required' USING ERRCODE = '22023';
  END IF;

  SELECT c.title, c.summary
    INTO v_title, v_summary
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
       OR v_existing.body <> coalesce(p_event_body, '') THEN
      RAISE EXCEPTION 'Case event ID is already used by another request' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT v_title, v_summary, v_existing.occurred_at, v_existing.body;
    RETURN;
  END IF;

  v_title := CASE WHEN p_patch ? 'title' THEN pg_catalog.btrim(p_patch ->> 'title') ELSE v_title END;
  v_summary := CASE WHEN p_patch ? 'summary' THEN pg_catalog.btrim(coalesce(p_patch ->> 'summary', '')) ELSE v_summary END;
  v_occurred_at := pg_catalog.clock_timestamp();

  UPDATE public.cases AS c
     SET title = v_title,
         summary = v_summary,
         updated_at = v_occurred_at
   WHERE c.id = p_case_id AND c.owner_id = v_owner_id;

  INSERT INTO public.case_events (id, owner_id, case_id, kind, body, occurred_at)
  VALUES (p_event_id, v_owner_id, p_case_id, 'system', coalesce(p_event_body, ''), v_occurred_at);

  RETURN QUERY SELECT v_title, v_summary, v_occurred_at, coalesce(p_event_body, '');
END
$$;

REVOKE ALL ON FUNCTION public.update_case_details_with_event(uuid, uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_case_details_with_event(uuid, uuid, jsonb, text) TO authenticated;

-- Closing a case-linked follow-up intentionally changes only the follow-up and
-- the case status. Keeping this field-specific prevents a stale workflow card
-- from replacing newer payment or case-detail values.
CREATE OR REPLACE FUNCTION public.complete_follow_up_with_case(
  p_completed jsonb,
  p_case jsonb,
  p_event jsonb
)
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

  UPDATE public.follow_ups
     SET status = p_completed ->> 'status',
         completed_at = nullif(p_completed ->> 'completed_at', '')::timestamptz,
         snoozed_until = nullif(p_completed ->> 'snoozed_until', '')::date,
         note = coalesce(p_completed ->> 'note', note)
   WHERE id = (p_completed ->> 'id')::uuid
     AND owner_id = v_owner_id
     AND case_id = v_case_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'Case-linked follow-up not found for the authenticated owner' USING ERRCODE = 'P0002';
  END IF;

  IF (CASE
        WHEN p_case ? 'apply_status' THEN coalesce((p_case ->> 'apply_status')::boolean, false)
        ELSE pg_catalog.strpos(coalesce(p_event ->> 'body', ''), '(case → ') > 0
      END) THEN
    UPDATE public.cases AS c
       SET status = p_case ->> 'status',
           updated_at = pg_catalog.now()
     WHERE c.id = v_case_id AND c.owner_id = v_owner_id;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> 1 THEN
      RAISE EXCEPTION 'Case not found for the authenticated owner' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  INSERT INTO public.case_events (id, owner_id, case_id, kind, body, occurred_at)
  VALUES (
    (p_event ->> 'id')::uuid,
    v_owner_id,
    v_case_id,
    coalesce(p_event ->> 'kind', 'system'),
    coalesce(p_event ->> 'body', ''),
    coalesce(nullif(p_event ->> 'occurred_at', '')::timestamptz, pg_catalog.now())
  )
  ON CONFLICT (id) DO UPDATE
    SET case_id = EXCLUDED.case_id,
        kind = EXCLUDED.kind,
        body = EXCLUDED.body,
        occurred_at = EXCLUDED.occurred_at
  WHERE public.case_events.owner_id = v_owner_id
    AND public.case_events.case_id = EXCLUDED.case_id
    AND public.case_events.kind = EXCLUDED.kind;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'Case event ID is already used by another request' USING ERRCODE = '23505';
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.complete_follow_up_with_case(jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_follow_up_with_case(jsonb, jsonb, jsonb) TO authenticated;

-- Locked, patch-based corrections for status/quote/paid-total edits. The caller
-- sends only the field it intends to change, so stale values cannot overwrite a
-- payment recorded by another device.
CREATE OR REPLACE FUNCTION public.update_case_payment_with_event(
  p_case_id uuid,
  p_event_id uuid,
  p_patch jsonb
)
RETURNS TABLE (
  paid_amount integer,
  payment_status text,
  quoted_amount integer,
  occurred_at timestamptz,
  event_body text
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_paid integer;

  v_status text;
  v_quote integer;
  v_occurred_at timestamptz;
  v_body text := 'Payment updated';
  v_existing public.case_events%ROWTYPE;
BEGIN
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF p_patch IS NULL OR p_patch = '{}'::jsonb OR EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_object_keys(p_patch) AS key
    WHERE key NOT IN ('payment_status', 'quoted_amount', 'paid_amount')
  ) THEN
    RAISE EXCEPTION 'Payment patch contains no supported fields' USING ERRCODE = '22023';
  END IF;

  SELECT c.paid_amount, c.payment_status, c.quoted_amount
    INTO v_paid, v_status, v_quote
    FROM public.cases AS c
   WHERE c.id = p_case_id AND c.owner_id = v_owner_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Case not found for the authenticated owner' USING ERRCODE = 'P0002';
  END IF;


  IF p_patch ? 'paid_amount' THEN
    IF pg_catalog.jsonb_typeof(p_patch -> 'paid_amount') <> 'number' THEN
      RAISE EXCEPTION 'Paid amount must be a whole-dollar number' USING ERRCODE = '22023';
    END IF;
    v_paid := (p_patch ->> 'paid_amount')::integer;
    IF v_paid < 0 OR v_paid > 10000000 THEN
      RAISE EXCEPTION 'Paid amount is outside the supported range' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_patch ? 'quoted_amount' THEN
    IF p_patch -> 'quoted_amount' = 'null'::jsonb THEN
      v_quote := NULL;
    ELSIF pg_catalog.jsonb_typeof(p_patch -> 'quoted_amount') = 'number' THEN
      v_quote := (p_patch ->> 'quoted_amount')::integer;
      IF v_quote < 0 OR v_quote > 10000000 THEN
        RAISE EXCEPTION 'Quoted amount is outside the supported range' USING ERRCODE = '22023';
      END IF;
    ELSE
      RAISE EXCEPTION 'Quoted amount must be null or a whole-dollar number' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_patch ? 'payment_status' THEN
    v_status := p_patch ->> 'payment_status';
    IF v_status NOT IN ('none','quoted','deposit','paid','partial','refunded') THEN
      RAISE EXCEPTION 'Unsupported payment status' USING ERRCODE = '22023';
    END IF;
    IF v_status = 'refunded' THEN
      v_paid := 0;
      v_quote := NULL;
    END IF;
  ELSIF p_patch ? 'paid_amount' OR p_patch ? 'quoted_amount' THEN
    v_status := CASE
      WHEN v_paid = 0 AND v_quote IS NULL THEN 'none'
      WHEN v_paid = 0 THEN 'quoted'
      WHEN v_quote IS NOT NULL AND v_paid >= v_quote THEN 'paid'
      ELSE 'partial'
    END;
  END IF;

  IF v_status = 'none' AND (v_paid <> 0 OR v_quote IS NOT NULL) THEN
    RAISE EXCEPTION 'No-payment status requires zero paid and no quote' USING ERRCODE = '22023';
  ELSIF v_status = 'quoted' AND (v_paid <> 0 OR v_quote IS NULL) THEN
    RAISE EXCEPTION 'Quoted status requires a quote and zero paid' USING ERRCODE = '22023';
  ELSIF v_status IN ('deposit', 'partial') AND (v_paid <= 0 OR (v_status = 'partial' AND v_quote IS NOT NULL AND v_paid >= v_quote)) THEN
    RAISE EXCEPTION 'Deposit/partial status is inconsistent with payment totals' USING ERRCODE = '22023';
  ELSIF v_status = 'paid' AND (v_paid <= 0 OR (v_quote IS NOT NULL AND v_paid < v_quote)) THEN
    RAISE EXCEPTION 'Paid status requires paid revenue meeting the quote when present' USING ERRCODE = '22023';
  ELSIF v_status = 'refunded' AND (v_paid <> 0 OR v_quote IS NOT NULL) THEN
    RAISE EXCEPTION 'Refunded status requires zero net paid and no open quote' USING ERRCODE = '22023';
  END IF;

  IF p_patch ? 'payment_status' THEN v_body := v_body || ' · Status: ' || v_status; END IF;
  IF v_status = 'refunded' AND p_patch ? 'payment_status' THEN
    v_body := v_body || ' · Paid total: $0 · Quote cleared';
  END IF;
  IF p_patch ? 'quoted_amount' THEN v_body := v_body || ' · Quoted: ' || coalesce('$' || pg_catalog.to_char(v_quote, 'FM999G999G999G990'), '—'); END IF;
  IF p_patch ? 'paid_amount' THEN v_body := v_body || ' · Paid total: $' || pg_catalog.to_char(v_paid, 'FM999G999G999G990'); END IF;

  SELECT e.* INTO v_existing
    FROM public.case_events AS e
   WHERE e.id = p_event_id AND e.owner_id = v_owner_id;
  IF FOUND THEN
    IF v_existing.case_id <> p_case_id
       OR v_existing.kind <> 'payment'
       OR v_existing.body <> v_body THEN
      RAISE EXCEPTION 'Payment event ID is already used by a different correction request' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT v_paid, v_status, v_quote, v_existing.occurred_at, v_existing.body;
    RETURN;
  END IF;

  v_occurred_at := pg_catalog.clock_timestamp();
  UPDATE public.cases AS c
     SET paid_amount = v_paid,
         payment_status = v_status,
         quoted_amount = v_quote,
         updated_at = v_occurred_at
   WHERE c.id = p_case_id AND c.owner_id = v_owner_id;

  INSERT INTO public.case_events (id, owner_id, case_id, kind, body, occurred_at)
  VALUES (p_event_id, v_owner_id, p_case_id, 'payment', v_body, v_occurred_at);

  RETURN QUERY SELECT v_paid, v_status, v_quote, v_occurred_at, v_body;
END
$$;

REVOKE ALL ON FUNCTION public.update_case_payment_with_event(uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_case_payment_with_event(uuid, uuid, jsonb) TO authenticated;
