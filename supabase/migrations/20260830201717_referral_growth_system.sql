BEGIN;

-- Referral growth system: public intake capabilities, closed-loop handoffs,
-- and independently fresh center availability.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ─── Referral intake sources ─────────────────────────────────────────────────
CREATE TABLE public.referral_sources (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  owner_id                 uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  partner_id               uuid,
  label                    text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 120),
  public_practice_display  text NOT NULL CHECK (length(btrim(public_practice_display)) BETWEEN 1 AND 120),
  public_source_display    text NOT NULL CHECK (length(btrim(public_source_display)) BETWEEN 1 AND 120),
  active                   boolean NOT NULL DEFAULT true,
  revoked_at               timestamptz,
  rotated_to_source_id     uuid UNIQUE REFERENCES public.referral_sources(id) ON DELETE RESTRICT,
  submission_count         bigint NOT NULL DEFAULT 0 CHECK (submission_count >= 0),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT referral_sources_active_revoke_check
    CHECK ((active AND revoked_at IS NULL) OR (NOT active AND revoked_at IS NOT NULL)),
  CONSTRAINT referral_sources_partner_org_fk
    FOREIGN KEY (partner_id, org_id) REFERENCES public.partners(id, org_id)
    ON DELETE SET NULL (partner_id)
);
CREATE INDEX referral_sources_org_idx ON public.referral_sources(org_id, active, created_at DESC);
CREATE TRIGGER referral_sources_updated_at BEFORE UPDATE ON public.referral_sources
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER referral_sources_set_org BEFORE INSERT ON public.referral_sources
  FOR EACH ROW EXECUTE FUNCTION public.set_row_org_from_owner();

CREATE OR REPLACE FUNCTION public.guard_referral_source_update()
RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND (
    NEW.id IS DISTINCT FROM OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id
    OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.submission_count IS DISTINCT FROM OLD.submission_count
  ) THEN
    RAISE EXCEPTION 'Referral source identity and counters are server-managed' USING ERRCODE = '42501';
  END IF;
  IF auth.uid() IS NOT NULL AND NEW.active IS DISTINCT FROM OLD.active THEN
    IF NEW.active AND OLD.rotated_to_source_id IS NOT NULL THEN
      RAISE EXCEPTION 'A rotated referral source cannot be reactivated' USING ERRCODE = '42501';
    END IF;
    NEW.revoked_at := CASE WHEN NEW.active THEN NULL ELSE pg_catalog.clock_timestamp() END;
  ELSIF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'Set active to revoke or reactivate a referral source' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER referral_sources_guard_update BEFORE UPDATE ON public.referral_sources
  FOR EACH ROW EXECUTE FUNCTION public.guard_referral_source_update();

ALTER TABLE public.referral_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY "referral_sources: org read" ON public.referral_sources FOR SELECT TO authenticated
  USING (org_id = public.current_org_id());
CREATE POLICY "referral_sources: org insert" ON public.referral_sources FOR INSERT TO authenticated
  WITH CHECK (org_id = public.current_org_id() AND owner_id = auth.uid());
CREATE POLICY "referral_sources: org update" ON public.referral_sources FOR UPDATE TO authenticated
  USING (org_id = public.current_org_id()) WITH CHECK (org_id = public.current_org_id());
REVOKE ALL ON public.referral_sources FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.referral_sources TO authenticated;
GRANT INSERT (id, owner_id, partner_id, label, public_practice_display, public_source_display, active)
  ON public.referral_sources TO authenticated;
GRANT UPDATE (partner_id, label, public_practice_display, public_source_display, active)
  ON public.referral_sources TO authenticated;

CREATE OR REPLACE FUNCTION public.rotate_referral_source(p_source_id uuid)
RETURNS SETOF public.referral_sources
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid := public.current_org_id();
  v_source public.referral_sources%ROWTYPE;
  v_new_id uuid := gen_random_uuid();
BEGIN
  IF v_user IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO v_source FROM public.referral_sources
   WHERE id = p_source_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Referral source not found' USING ERRCODE = 'P0002'; END IF;
  IF v_source.owner_id <> v_user THEN
    RAISE EXCEPTION 'Only the source owner can rotate this referral link' USING ERRCODE = '42501';
  END IF;

  -- Return the same successor after a lost response. The row lock serializes
  -- concurrent calls, so one source can produce only one replacement.
  IF v_source.rotated_to_source_id IS NOT NULL THEN
    RETURN QUERY SELECT * FROM public.referral_sources WHERE id = v_source.rotated_to_source_id;
    RETURN;
  END IF;
  IF NOT v_source.active OR v_source.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Only an active referral source can be rotated' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.referral_sources(
    id, org_id, owner_id, partner_id, label,
    public_practice_display, public_source_display, active
  ) VALUES (
    v_new_id, v_org, v_user, v_source.partner_id,
    pg_catalog.left(v_source.label, 110) || ' (rotated)', v_source.public_practice_display,
    v_source.public_source_display, true
  );
  UPDATE public.referral_sources
     SET active = false, rotated_to_source_id = v_new_id
   WHERE id = v_source.id;
  RETURN QUERY SELECT * FROM public.referral_sources WHERE id = v_new_id;
END
$$;

-- Service-only anti-abuse and idempotency ledgers. They remain in public for
-- PostgREST RPC transaction access, but expose no table privileges or policies.
CREATE TABLE public.referral_intake_rate_limits (
  source_id    uuid NOT NULL REFERENCES public.referral_sources(id) ON DELETE CASCADE,
  ip_hash      text NOT NULL CHECK (ip_hash ~ '^[0-9a-f]{64}$'),
  window_start timestamptz NOT NULL,
  attempts     integer NOT NULL CHECK (attempts BETWEEN 1 AND 1000),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, ip_hash)
);
CREATE TABLE public.referral_intake_submissions (
  source_id       uuid NOT NULL REFERENCES public.referral_sources(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  case_id         uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, idempotency_key),
  UNIQUE (case_id)
);
ALTER TABLE public.referral_intake_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_intake_submissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.referral_intake_rate_limits, public.referral_intake_submissions
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.public_referral_source_resolve(p_source_id uuid)
RETURNS TABLE (
  source_id uuid,
  practice_display text,
  source_display text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT s.id, s.public_practice_display, s.public_source_display
    FROM public.referral_sources AS s
   WHERE s.id = p_source_id AND s.active AND s.revoked_at IS NULL
$$;

CREATE OR REPLACE FUNCTION public.public_referral_intake_submit(
  p_source_id uuid,
  p_idempotency_key uuid,
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_email text,
  p_callback_consent boolean,
  p_privacy_consent boolean,
  p_ip_hash text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  v_source public.referral_sources%ROWTYPE;

  v_now timestamptz := pg_catalog.clock_timestamp();
  v_case_id uuid := gen_random_uuid();
  v_referral_id uuid := gen_random_uuid();
  v_contact_id uuid := gen_random_uuid();
  v_follow_up_id uuid := gen_random_uuid();
  v_first text := pg_catalog.btrim(coalesce(p_first_name, ''));
  v_last text := pg_catalog.btrim(coalesce(p_last_name, ''));
  v_phone text := pg_catalog.btrim(coalesce(p_phone, ''));
  v_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  v_attempts integer;
  v_source_attempts integer;
  v_old_sub text := current_setting('request.jwt.claim.sub', true);
BEGIN
  IF p_source_id IS NULL OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'Invalid request' USING ERRCODE = '22023';
  END IF;
  IF p_callback_consent IS NOT TRUE OR p_privacy_consent IS NOT TRUE THEN
    RAISE EXCEPTION 'Consent is required' USING ERRCODE = '22023';
  END IF;
  IF length(v_first) NOT BETWEEN 1 AND 80 OR length(v_last) NOT BETWEEN 1 AND 80
     OR length(v_phone) > 40 OR length(v_email) > 254
     OR (v_phone = '' AND v_email = '')
     OR (v_phone <> '' AND v_phone !~ '^\+?[0-9 ().-]{7,40}$')
     OR (v_email <> '' AND v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
     OR coalesce(p_ip_hash, '') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid request' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_source FROM public.referral_sources
   WHERE id = p_source_id FOR UPDATE;
  IF NOT FOUND OR NOT v_source.active OR v_source.revoked_at IS NOT NULL
     OR v_source.partner_id IS NULL THEN
    RAISE EXCEPTION 'Referral source is unavailable' USING ERRCODE = 'P0002';
  END IF;

  PERFORM case_id FROM public.referral_intake_submissions
   WHERE source_id = p_source_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN jsonb_build_object('accepted', true);
  END IF;

  -- Bound total source traffic as well as each network address. This prevents a
  -- caller from bypassing the per-address bucket by rotating proxy headers.
  INSERT INTO public.referral_intake_rate_limits(source_id, ip_hash, window_start, attempts, updated_at)
  VALUES (p_source_id, repeat('0', 64), v_now, 1, v_now)
  ON CONFLICT (source_id, ip_hash) DO UPDATE SET
    window_start = CASE
      WHEN public.referral_intake_rate_limits.window_start <= v_now - interval '15 minutes' THEN v_now
      ELSE public.referral_intake_rate_limits.window_start END,
    attempts = CASE
      WHEN public.referral_intake_rate_limits.window_start <= v_now - interval '15 minutes' THEN 1
      ELSE public.referral_intake_rate_limits.attempts + 1 END,
    updated_at = v_now
  RETURNING attempts INTO v_source_attempts;
  IF v_source_attempts > 40 THEN
    RAISE EXCEPTION 'Rate limit exceeded' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.referral_intake_rate_limits(source_id, ip_hash, window_start, attempts, updated_at)
  VALUES (p_source_id, p_ip_hash, v_now, 1, v_now)
  ON CONFLICT (source_id, ip_hash) DO UPDATE SET
    window_start = CASE
      WHEN public.referral_intake_rate_limits.window_start <= v_now - interval '15 minutes' THEN v_now
      ELSE public.referral_intake_rate_limits.window_start END,
    attempts = CASE
      WHEN public.referral_intake_rate_limits.window_start <= v_now - interval '15 minutes' THEN 1
      ELSE public.referral_intake_rate_limits.attempts + 1 END,
    updated_at = v_now
  RETURNING attempts INTO v_attempts;
  IF v_attempts > 5 THEN
    RAISE EXCEPTION 'Rate limit exceeded' USING ERRCODE = 'P0001';
  END IF;

  -- Service writes carry the source owner's attribution, not the caller's
  -- potentially stale JWT sub. Restore the transaction-local claim afterward.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  INSERT INTO public.cases (
    id, owner_id, org_id, title, status, summary, payment_status,
    lead_source, lead_source_detail, stage_changed_at
  ) VALUES (
    v_case_id, v_source.owner_id, v_source.org_id,
    'Public referral inquiry — ' || v_first || ' ' || v_last,
    'inquiry', '', 'none', 'Professional referral', v_source.label, v_now
  );
  INSERT INTO public.case_contacts (
    id, owner_id, org_id, case_id, name, relationship, phone, email, is_primary, note
  ) VALUES (
    v_contact_id, v_source.owner_id, v_source.org_id, v_case_id,
    v_first || ' ' || v_last, '', v_phone, v_email, true, ''
  );
  INSERT INTO public.referrals (
    id, owner_id, org_id, partner_id, direction, referred_on,
    client_label, outcome, note, case_id
  ) VALUES (
    v_referral_id, v_source.owner_id, v_source.org_id, v_source.partner_id,
    'inbound', v_now::date, 'Public intake', 'Pending', '', v_case_id
  );
  INSERT INTO public.follow_ups (
    id, owner_id, org_id, partner_id, referral_id, case_id,
    title, due_on, status, note, kind
  ) VALUES (
    v_follow_up_id, v_source.owner_id, v_source.org_id, v_source.partner_id,
    v_referral_id, v_case_id, 'First call — public referral intake',
    v_now::date, 'open', '', 'first_call'
  );
  INSERT INTO public.referral_intake_submissions(source_id, idempotency_key, case_id)
  VALUES (p_source_id, p_idempotency_key, v_case_id);
  UPDATE public.referral_sources SET submission_count = submission_count + 1 WHERE id = p_source_id;
  PERFORM set_config('request.jwt.claim.sub', coalesce(v_old_sub, ''), true);

  RETURN jsonb_build_object('accepted', true);
END
$$;

-- ─── Closed-loop referral handoffs ───────────────────────────────────────────
CREATE TABLE public.referral_handoffs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  owner_id                 uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  referral_id              uuid NOT NULL,
  case_id                  uuid,
  partner_id               uuid NOT NULL,
  client_alias             text NOT NULL CHECK (length(btrim(client_alias)) BETWEEN 1 AND 80),
  sender_practice_display  text NOT NULL CHECK (length(btrim(sender_practice_display)) BETWEEN 1 AND 120),
  recipient_display        text NOT NULL CHECK (length(btrim(recipient_display)) BETWEEN 1 AND 120),
  recipient_email          text NOT NULL DEFAULT '' CHECK (length(recipient_email) <= 254),
  token_hash               bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  status                   text NOT NULL DEFAULT 'sent'
    CHECK (status IN ('sent','received','contact_attempted','family_reached','consult_scheduled','closed')),
  version                  integer NOT NULL DEFAULT 1 CHECK (version > 0),
  revoked_at               timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  CONSTRAINT referral_handoffs_referral_org_fk FOREIGN KEY (referral_id, org_id)
    REFERENCES public.referrals(id, org_id) ON DELETE RESTRICT,
  CONSTRAINT referral_handoffs_case_org_fk FOREIGN KEY (case_id, org_id)
    REFERENCES public.cases(id, org_id) ON DELETE SET NULL (case_id),
  CONSTRAINT referral_handoffs_partner_org_fk FOREIGN KEY (partner_id, org_id)
    REFERENCES public.partners(id, org_id) ON DELETE RESTRICT
);
CREATE INDEX referral_handoffs_org_status_idx ON public.referral_handoffs(org_id, status, updated_at DESC);
CREATE TRIGGER referral_handoffs_updated_at BEFORE UPDATE ON public.referral_handoffs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.referral_handoff_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  handoff_id  uuid NOT NULL,
  org_id      uuid NOT NULL,
  from_status text,
  to_status   text NOT NULL
    CHECK (to_status IN ('sent','received','contact_attempted','family_reached','consult_scheduled','closed')),
  version     integer NOT NULL CHECK (version > 0),
  actor_type  text NOT NULL CHECK (actor_type IN ('owner','recipient','system')),
  actor_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (handoff_id, version),
  CONSTRAINT referral_handoff_events_handoff_org_fk FOREIGN KEY (handoff_id, org_id)
    REFERENCES public.referral_handoffs(id, org_id) ON DELETE RESTRICT
);
CREATE INDEX referral_handoff_events_timeline_idx
  ON public.referral_handoff_events(handoff_id, version);

-- Safely extend the universal task queue and link exactly one open handoff reminder.
ALTER TABLE public.follow_ups DROP CONSTRAINT follow_ups_kind_check;
ALTER TABLE public.follow_ups ADD CONSTRAINT follow_ups_kind_check
  CHECK (kind IN ('follow_up','first_call','promised_call','waiting_on','consult','touch','referral_handshake'));
ALTER TABLE public.follow_ups ADD COLUMN referral_handoff_id uuid;
ALTER TABLE public.follow_ups ADD CONSTRAINT follow_ups_handoff_org_fk
  FOREIGN KEY (referral_handoff_id, org_id) REFERENCES public.referral_handoffs(id, org_id)
  ON DELETE SET NULL (referral_handoff_id);
CREATE UNIQUE INDEX follow_ups_one_open_handoff_reminder_idx
  ON public.follow_ups(referral_handoff_id)
  WHERE referral_handoff_id IS NOT NULL AND kind = 'referral_handshake' AND status = 'open';

CREATE OR REPLACE FUNCTION public.reject_handoff_event_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog
AS $$ BEGIN RAISE EXCEPTION 'Referral handoff history is append-only' USING ERRCODE = '42501'; END $$;
CREATE TRIGGER referral_handoff_events_append_only
  BEFORE UPDATE OR DELETE ON public.referral_handoff_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_handoff_event_mutation();

ALTER TABLE public.referral_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_handoff_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "referral_handoffs: org read" ON public.referral_handoffs FOR SELECT TO authenticated
  USING (org_id = public.current_org_id());
CREATE POLICY "referral_handoff_events: org read" ON public.referral_handoff_events FOR SELECT TO authenticated
  USING (org_id = public.current_org_id());
REVOKE ALL ON public.referral_handoffs, public.referral_handoff_events
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.referral_handoffs, public.referral_handoff_events TO authenticated;

CREATE OR REPLACE FUNCTION public.referral_handoff_next_status(p_status text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog
AS $$
  SELECT CASE p_status
    WHEN 'sent' THEN 'received'
    WHEN 'received' THEN 'contact_attempted'
    WHEN 'contact_attempted' THEN 'family_reached'
    WHEN 'family_reached' THEN 'consult_scheduled'
    WHEN 'consult_scheduled' THEN 'closed'
    ELSE NULL END
$$;

CREATE OR REPLACE FUNCTION public.create_referral_handoff(
  p_referral_id uuid,
  p_case_id uuid,
  p_partner_id uuid,
  p_client_alias text,
  p_recipient_display text,
  p_recipient_email text DEFAULT ''
)
RETURNS TABLE (handoff_id uuid, token text, status text, version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid := public.current_org_id();
  v_handoff uuid := gen_random_uuid();
  v_token text := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  v_sender text;
  v_referral public.referrals%ROWTYPE;
BEGIN
  IF v_user IS NULL OR v_org IS NULL THEN RAISE EXCEPTION 'Authentication is required' USING ERRCODE='28000'; END IF;
  IF length(pg_catalog.btrim(coalesce(p_client_alias,''))) NOT BETWEEN 1 AND 80
     OR length(pg_catalog.btrim(coalesce(p_recipient_display,''))) NOT BETWEEN 1 AND 120
     OR length(coalesce(p_recipient_email,'')) > 254
     OR (coalesce(p_recipient_email,'') <> '' AND pg_catalog.lower(pg_catalog.btrim(p_recipient_email)) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') THEN
    RAISE EXCEPTION 'Invalid handoff details' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_referral FROM public.referrals WHERE id=p_referral_id AND org_id=v_org;
  IF NOT FOUND OR v_referral.partner_id IS DISTINCT FROM p_partner_id
     OR (p_case_id IS NOT NULL AND v_referral.case_id IS DISTINCT FROM p_case_id) THEN
    RAISE EXCEPTION 'Referral links do not match this workspace' USING ERRCODE='P0002';
  END IF;
  SELECT name INTO v_sender FROM public.orgs WHERE id=v_org;

  INSERT INTO public.referral_handoffs(
    id,org_id,owner_id,referral_id,case_id,partner_id,client_alias,
    sender_practice_display,recipient_display,recipient_email,token_hash
  ) VALUES (
    v_handoff,v_org,v_user,p_referral_id,p_case_id,p_partner_id,
    pg_catalog.btrim(p_client_alias),pg_catalog.btrim(v_sender),
    pg_catalog.btrim(p_recipient_display),pg_catalog.lower(pg_catalog.btrim(coalesce(p_recipient_email,''))),
    extensions.digest(v_token,'sha256')
  );
  INSERT INTO public.referral_handoff_events(handoff_id,org_id,from_status,to_status,version,actor_type,actor_id)
  VALUES(v_handoff,v_org,NULL,'sent',1,'owner',v_user);
  INSERT INTO public.follow_ups(owner_id,org_id,partner_id,referral_id,case_id,referral_handoff_id,
    title,due_on,status,note,kind)
  VALUES(v_user,v_org,p_partner_id,p_referral_id,p_case_id,v_handoff,
    'Referral handoff — awaiting receipt',CURRENT_DATE + 1,'open','','referral_handshake');
  RETURN QUERY SELECT v_handoff,v_token,'sent'::text,1;
END
$$;

CREATE OR REPLACE FUNCTION public.apply_referral_handoff_transition(
  p_handoff_id uuid,
  p_expected_version integer,
  p_next_status text,
  p_actor_type text,
  p_actor_id uuid DEFAULT NULL
)
RETURNS TABLE (handoff_status text, handoff_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  v_h public.referral_handoffs%ROWTYPE;
  v_allowed text;
  v_new_version integer;
  v_title text;
BEGIN
  SELECT * INTO v_h FROM public.referral_handoffs WHERE id=p_handoff_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Handoff not found' USING ERRCODE='P0002'; END IF;
  IF v_h.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'Handoff is revoked' USING ERRCODE='42501'; END IF;
  IF p_next_status = v_h.status THEN RETURN QUERY SELECT v_h.status,v_h.version; RETURN; END IF;
  IF p_expected_version IS DISTINCT FROM v_h.version THEN
    RAISE EXCEPTION 'Handoff version conflict' USING ERRCODE='40001';
  END IF;
  v_allowed := public.referral_handoff_next_status(v_h.status);
  IF v_allowed IS NULL OR p_next_status IS DISTINCT FROM v_allowed THEN
    RAISE EXCEPTION 'Invalid handoff transition' USING ERRCODE='22023';
  END IF;
  v_new_version := v_h.version + 1;
  UPDATE public.referral_handoffs SET status=p_next_status,version=v_new_version WHERE id=v_h.id;
  INSERT INTO public.referral_handoff_events(handoff_id,org_id,from_status,to_status,version,actor_type,actor_id)
  VALUES(v_h.id,v_h.org_id,v_h.status,p_next_status,v_new_version,p_actor_type,p_actor_id);

  UPDATE public.follow_ups AS f SET status='done',completed_at=pg_catalog.clock_timestamp()
   WHERE f.referral_handoff_id=v_h.id AND f.kind='referral_handshake' AND f.status='open';
  IF p_next_status <> 'closed' THEN
    v_title := CASE p_next_status
      WHEN 'received' THEN 'Referral handoff — contact family'
      WHEN 'contact_attempted' THEN 'Referral handoff — retry family contact'
      WHEN 'family_reached' THEN 'Referral handoff — schedule consult'
      WHEN 'consult_scheduled' THEN 'Referral handoff — close the loop' END;
    INSERT INTO public.follow_ups(owner_id,org_id,partner_id,referral_id,case_id,referral_handoff_id,
      title,due_on,status,note,kind)
    VALUES(v_h.owner_id,v_h.org_id,v_h.partner_id,v_h.referral_id,v_h.case_id,v_h.id,
      v_title,CURRENT_DATE + 1,'open','','referral_handshake');
  END IF;
  RETURN QUERY SELECT p_next_status,v_new_version;
END
$$;

CREATE OR REPLACE FUNCTION public.transition_referral_handoff(
  p_handoff_id uuid, p_expected_version integer, p_next_status text
)
RETURNS TABLE (status text, version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE v_user uuid:=auth.uid(); v_org uuid:=public.current_org_id();
BEGIN
  IF v_user IS NULL OR v_org IS NULL THEN RAISE EXCEPTION 'Authentication is required' USING ERRCODE='28000'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.referral_handoffs WHERE id=p_handoff_id AND org_id=v_org) THEN
    RAISE EXCEPTION 'Handoff not found' USING ERRCODE='P0002';
  END IF;
  RETURN QUERY SELECT * FROM public.apply_referral_handoff_transition(p_handoff_id,p_expected_version,p_next_status,'owner',v_user);
END
$$;

CREATE OR REPLACE FUNCTION public.revoke_referral_handoff(p_handoff_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE v_user uuid:=auth.uid(); v_org uuid:=public.current_org_id(); v_count integer;
BEGIN
  IF v_user IS NULL OR v_org IS NULL THEN RAISE EXCEPTION 'Authentication is required' USING ERRCODE='28000'; END IF;
  UPDATE public.referral_handoffs SET revoked_at=coalesce(revoked_at,pg_catalog.clock_timestamp()),version=version+CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END
   WHERE id=p_handoff_id AND org_id=v_org;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count<>1 THEN RAISE EXCEPTION 'Handoff not found' USING ERRCODE='P0002'; END IF;
  UPDATE public.follow_ups SET status='skipped',completed_at=pg_catalog.clock_timestamp()
   WHERE referral_handoff_id=p_handoff_id AND kind='referral_handshake' AND status='open';
END
$$;

CREATE OR REPLACE FUNCTION public.public_referral_handoff_resolve(p_token text)
RETURNS TABLE (
  client_alias text,
  sender_practice_display text,
  recipient_display text,
  status text,
  version integer,
  allowed_next_status text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT h.client_alias,h.sender_practice_display,h.recipient_display,h.status,h.version,
         public.referral_handoff_next_status(h.status)
    FROM public.referral_handoffs h
   WHERE h.token_hash=extensions.digest(coalesce(p_token,''),'sha256') AND h.revoked_at IS NULL
$$;

CREATE OR REPLACE FUNCTION public.public_referral_handoff_transition(
  p_token text, p_expected_version integer, p_next_status text
)
RETURNS TABLE (status text, version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM public.referral_handoffs
   WHERE token_hash=extensions.digest(coalesce(p_token,''),'sha256') FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Handoff not found' USING ERRCODE='P0002'; END IF;
  RETURN QUERY SELECT * FROM public.apply_referral_handoff_transition(v_id,p_expected_version,p_next_status,'recipient',NULL);
END
$$;

-- Approval-first voice capture persists the reviewed touch and optional follow-up
-- in one transaction. It is intentionally online-only; callers keep the draft
-- visible when this RPC fails rather than claiming a partial save.
CREATE OR REPLACE FUNCTION public.save_voice_activity(
  p_expected_owner_id uuid,
  p_touch jsonb,
  p_follow_up jsonb DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog
AS $$
DECLARE
  v_owner uuid := auth.uid();
  v_org uuid := public.current_org_id();
  v_partner uuid;
BEGIN
  IF v_owner IS NULL OR v_owner IS DISTINCT FROM p_expected_owner_id THEN
    RAISE EXCEPTION 'Authenticated account changed' USING ERRCODE='42501';
  END IF;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Workspace membership required' USING ERRCODE='42501'; END IF;
  IF p_touch IS NULL OR p_touch = 'null'::jsonb THEN RAISE EXCEPTION 'A reviewed touch is required' USING ERRCODE='22023'; END IF;
  v_partner := nullif(p_touch->>'partner_id','')::uuid;
  IF v_partner IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.partners WHERE id=v_partner AND org_id=v_org
  ) THEN RAISE EXCEPTION 'Partner not found in this workspace' USING ERRCODE='42501'; END IF;

  INSERT INTO public.touches(id,owner_id,org_id,partner_id,kind,note,occurred_at)
  VALUES((p_touch->>'id')::uuid,v_owner,v_org,v_partner,p_touch->>'kind',
    coalesce(p_touch->>'note',''),coalesce(nullif(p_touch->>'occurred_at','')::timestamptz,pg_catalog.clock_timestamp()))
  ON CONFLICT (id) DO UPDATE SET kind=EXCLUDED.kind,note=EXCLUDED.note,occurred_at=EXCLUDED.occurred_at
  WHERE touches.org_id=v_org AND touches.owner_id=v_owner;

  IF p_follow_up IS NOT NULL AND p_follow_up <> 'null'::jsonb THEN
    INSERT INTO public.follow_ups(id,owner_id,org_id,partner_id,title,due_on,due_time,status,note,kind)
    VALUES((p_follow_up->>'id')::uuid,v_owner,v_org,v_partner,p_follow_up->>'title',
      (p_follow_up->>'due_on')::date,nullif(p_follow_up->>'due_time','')::time,
      'open',coalesce(p_follow_up->>'note',''),coalesce(nullif(p_follow_up->>'kind',''),'touch'))
    ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title,due_on=EXCLUDED.due_on,
      due_time=EXCLUDED.due_time,note=EXCLUDED.note,kind=EXCLUDED.kind
    WHERE follow_ups.org_id=v_org AND follow_ups.owner_id=v_owner;
  END IF;
END
$$;

-- ─── Seven-day center availability ───────────────────────────────────────────
CREATE TABLE public.center_availability (
  global_partner_id uuid PRIMARY KEY REFERENCES public.global_partners(id) ON DELETE CASCADE,
  accepting_state text NOT NULL CHECK (accepting_state IN ('accepting','limited','not_accepting','unknown')),
  levels text[] NOT NULL DEFAULT '{}',
  response_time text NOT NULL DEFAULT '' CHECK (length(response_time) <= 120),
  public_note text NOT NULL DEFAULT '' CHECK (length(public_note) <= 500),
  confirmed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT center_availability_seven_day_check
    CHECK (expires_at = confirmed_at + interval '7 days')
);
ALTER TABLE public.center_availability ENABLE ROW LEVEL SECURITY;
CREATE POLICY "center_availability: directory read" ON public.center_availability FOR SELECT TO authenticated
  USING (
    public.org_has_entitlement('directory')
    AND EXISTS (SELECT 1 FROM public.global_partners g
                 WHERE g.id=global_partner_id AND g.status='active')
  );
REVOKE ALL ON public.center_availability FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.center_availability TO authenticated;

CREATE OR REPLACE FUNCTION public.get_center_availability()
RETURNS SETOF public.center_availability
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT a.* FROM public.center_availability a
   WHERE a.global_partner_id=public.current_center_listing_id()
$$;

CREATE OR REPLACE FUNCTION public.confirm_center_availability(
  p_accepting_state text,
  p_levels text[],
  p_response_time text,
  p_public_note text,
  p_expected_version integer DEFAULT NULL
)
RETURNS SETOF public.center_availability
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  v_user uuid:=auth.uid();
  v_listing uuid:=public.current_center_listing_id();
  v_now timestamptz:=pg_catalog.clock_timestamp();
  v_existing integer;
BEGIN
  IF v_user IS NULL OR v_listing IS NULL THEN RAISE EXCEPTION 'Claimed center listing is required' USING ERRCODE='42501'; END IF;
  IF p_accepting_state NOT IN ('accepting','limited','not_accepting','unknown')
     OR length(coalesce(p_response_time,''))>120 OR length(coalesce(p_public_note,''))>500
     OR coalesce(pg_catalog.cardinality(p_levels),0)>30
     OR EXISTS(SELECT 1 FROM pg_catalog.unnest(coalesce(p_levels,ARRAY[]::text[])) x WHERE length(x)>80 OR pg_catalog.btrim(x)='') THEN
    RAISE EXCEPTION 'Invalid availability details' USING ERRCODE='22023';
  END IF;
  SELECT version INTO v_existing FROM public.center_availability WHERE global_partner_id=v_listing FOR UPDATE;
  IF FOUND AND p_expected_version IS DISTINCT FROM v_existing THEN
    RAISE EXCEPTION 'Availability version conflict' USING ERRCODE='40001';
  ELSIF NOT FOUND AND p_expected_version IS NOT NULL THEN
    RAISE EXCEPTION 'Availability version conflict' USING ERRCODE='40001';
  END IF;
  INSERT INTO public.center_availability(global_partner_id,accepting_state,levels,response_time,public_note,
    confirmed_at,expires_at,updated_by,version)
  VALUES(v_listing,p_accepting_state,coalesce(p_levels,ARRAY[]::text[]),coalesce(p_response_time,''),
    coalesce(p_public_note,''),v_now,v_now+interval '7 days',v_user,1)
  ON CONFLICT(global_partner_id) DO UPDATE SET
    accepting_state=EXCLUDED.accepting_state,levels=EXCLUDED.levels,response_time=EXCLUDED.response_time,
    public_note=EXCLUDED.public_note,confirmed_at=EXCLUDED.confirmed_at,expires_at=EXCLUDED.expires_at,
    updated_by=EXCLUDED.updated_by,version=public.center_availability.version+1;
  RETURN QUERY SELECT * FROM public.center_availability WHERE global_partner_id=v_listing;
END
$$;

-- ─── Exact RPC privileges ────────────────────────────────────────────────────
-- Preserve the read-only contracts of pre-existing service-managed tables on
-- local stacks that apply broad authenticated default privileges at creation.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.case_stage_history, public.org_entitlements FROM authenticated;

REVOKE ALL ON FUNCTION public.guard_referral_source_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rotate_referral_source(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.public_referral_source_resolve(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.public_referral_intake_submit(uuid,uuid,text,text,text,text,boolean,boolean,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reject_handoff_event_mutation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.referral_handoff_next_status(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_referral_handoff(uuid,uuid,uuid,text,text,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.apply_referral_handoff_transition(uuid,integer,text,text,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.transition_referral_handoff(uuid,integer,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revoke_referral_handoff(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.public_referral_handoff_resolve(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.public_referral_handoff_transition(text,integer,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_voice_activity(uuid,jsonb,jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_center_availability() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.confirm_center_availability(text,text[],text,text,integer) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.referral_handoff_next_status(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rotate_referral_source(uuid),
  public.create_referral_handoff(uuid,uuid,uuid,text,text,text),
  public.transition_referral_handoff(uuid,integer,text), public.revoke_referral_handoff(uuid),
  public.save_voice_activity(uuid,jsonb,jsonb),
  public.get_center_availability(), public.confirm_center_availability(text,text[],text,text,integer)
TO authenticated;
GRANT EXECUTE ON FUNCTION public.public_referral_source_resolve(uuid),
  public.public_referral_intake_submit(uuid,uuid,text,text,text,text,boolean,boolean,text),
  public.public_referral_handoff_resolve(text),
  public.public_referral_handoff_transition(text,integer,text)
TO service_role;

COMMIT;
