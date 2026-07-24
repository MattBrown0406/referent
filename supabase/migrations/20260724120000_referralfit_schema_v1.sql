-- ReferralFit schema v1 — clean slate on the InterventionOS project.
-- Drops the earlier InterventionOS prototype tables (user-approved 2026-07-24),
-- then builds the ReferralFit business hub schema with owner-only RLS.

-- ─── 0. Clean slate ───────────────────────────────────────────────────────────
DROP TABLE IF EXISTS public.agent_actions CASCADE;
DROP TABLE IF EXISTS public.documents CASCADE;
DROP TABLE IF EXISTS public.schedule_items CASCADE;
DROP TABLE IF EXISTS public.tasks CASCADE;
DROP TABLE IF EXISTS public.families CASCADE;

-- ─── 1. Helpers ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

-- ─── 2. partners ──────────────────────────────────────────────────────────────
-- Mirrors src/data.ts Partner, plus cadence fields for the relationship engine.
CREATE TABLE public.partners (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  organization  text NOT NULL DEFAULT '',
  types         text[] NOT NULL DEFAULT '{}',      -- PartnerType[]; first entry = primary type
  city          text NOT NULL DEFAULT '',
  state         text NOT NULL DEFAULT '',
  regions       text[] NOT NULL DEFAULT '{}',
  phone         text NOT NULL DEFAULT '',
  email         text NOT NULL DEFAULT '',
  website       text,
  cash_min      integer NOT NULL DEFAULT 0,
  cash_max      integer NOT NULL DEFAULT 0,
  insurance     text[] NOT NULL DEFAULT '{}',
  therapies     text[] NOT NULL DEFAULT '{}',
  populations   text[] NOT NULL DEFAULT '{}',
  levels        text[] NOT NULL DEFAULT '{}',
  note          text NOT NULL DEFAULT '',
  favorite      boolean NOT NULL DEFAULT false,
  -- relationship cadence (idea #1 foundation)
  touch_cadence_days integer,                       -- NULL = no cadence set
  last_contact_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX partners_owner_idx ON public.partners (owner_id);
CREATE INDEX partners_owner_state_idx ON public.partners (owner_id, state);
CREATE TRIGGER partners_updated_at BEFORE UPDATE ON public.partners
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── 3. touches — contact log; source of truth for last_contact_at ───────────
CREATE TABLE public.touches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  partner_id  uuid NOT NULL REFERENCES public.partners(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('call','text','email','meeting','other')),
  note        text NOT NULL DEFAULT '',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX touches_owner_partner_idx ON public.touches (owner_id, partner_id, occurred_at DESC);

-- Keep partners.last_contact_at in sync automatically.
CREATE OR REPLACE FUNCTION public.touch_partner_last_contact()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.partners p
     SET last_contact_at = GREATEST(coalesce(p.last_contact_at, NEW.occurred_at), NEW.occurred_at)
   WHERE p.id = NEW.partner_id;
  RETURN NEW;
END $$;

CREATE TRIGGER touches_update_last_contact AFTER INSERT ON public.touches
  FOR EACH ROW EXECUTE FUNCTION public.touch_partner_last_contact();

-- ─── 4. referrals — inbound/outbound ledger ───────────────────────────────────
CREATE TABLE public.referrals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  partner_id   uuid NOT NULL REFERENCES public.partners(id) ON DELETE CASCADE,
  direction    text NOT NULL CHECK (direction IN ('inbound','outbound')),
  referred_on  date NOT NULL DEFAULT CURRENT_DATE,
  client_label text NOT NULL DEFAULT '',            -- de-identified label ONLY (no PHI)
  outcome      text NOT NULL DEFAULT 'Pending'
               CHECK (outcome IN ('Placed','Introduced','Consulted','Pending')),
  note         text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX referrals_owner_partner_idx ON public.referrals (owner_id, partner_id, referred_on DESC);
CREATE TRIGGER referrals_updated_at BEFORE UPDATE ON public.referrals
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── 5. match_profiles — saved client-match profiles ─────────────────────────
CREATE TABLE public.match_profiles (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  client_label        text NOT NULL DEFAULT '',      -- de-identified label ONLY
  level_of_care       text NOT NULL DEFAULT 'Any type',
  state               text NOT NULL DEFAULT '',
  insurance           text NOT NULL DEFAULT '',
  network_preferences text[] NOT NULL DEFAULT '{}',
  max_budget          integer,
  therapies           text[] NOT NULL DEFAULT '{}',
  status              text NOT NULL DEFAULT 'Matching'
                      CHECK (status IN ('Matching','Referred')),
  assigned_partner_id uuid REFERENCES public.partners(id) ON DELETE SET NULL,
  referral_id         uuid REFERENCES public.referrals(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX match_profiles_owner_idx ON public.match_profiles (owner_id, updated_at DESC);
CREATE TRIGGER match_profiles_updated_at BEFORE UPDATE ON public.match_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── 6. RLS — owner-only on everything ────────────────────────────────────────
ALTER TABLE public.partners       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.touches        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referrals      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "partners: owner all" ON public.partners
  FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE POLICY "touches: owner all" ON public.touches
  FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE POLICY "referrals: owner all" ON public.referrals
  FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE POLICY "match_profiles: owner all" ON public.match_profiles
  FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

-- Lock down table privileges: authenticated only (RLS scopes rows).
REVOKE ALL ON public.partners, public.touches, public.referrals, public.match_profiles FROM anon, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.partners, public.touches, public.referrals, public.match_profiles TO authenticated;

-- ─── 7. Reciprocity + cadence views (computed server-side) ───────────────────
CREATE OR REPLACE VIEW public.partner_balances
WITH (security_invoker = on) AS
SELECT
  p.id AS partner_id,
  p.owner_id,
  count(*) FILTER (WHERE r.direction = 'inbound')  AS inbound,
  count(*) FILTER (WHERE r.direction = 'outbound') AS outbound,
  count(*) FILTER (WHERE r.direction = 'inbound')
    - count(*) FILTER (WHERE r.direction = 'outbound') AS balance
FROM public.partners p
LEFT JOIN public.referrals r ON r.partner_id = p.id
GROUP BY p.id, p.owner_id;

CREATE OR REPLACE VIEW public.partners_going_cold
WITH (security_invoker = on) AS
SELECT
  p.*,
  (CURRENT_DATE - coalesce(p.last_contact_at, p.created_at)::date) AS days_since_contact,
  (CURRENT_DATE - coalesce(p.last_contact_at, p.created_at)::date) - p.touch_cadence_days AS days_overdue
FROM public.partners p
WHERE p.touch_cadence_days IS NOT NULL
  AND (CURRENT_DATE - coalesce(p.last_contact_at, p.created_at)::date) > p.touch_cadence_days;

GRANT SELECT ON public.partner_balances, public.partners_going_cold TO authenticated;
