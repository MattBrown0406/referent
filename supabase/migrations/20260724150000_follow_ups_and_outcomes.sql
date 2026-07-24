-- ReferralFit schema v2 — follow-ups + referral outcome enrichment (Match Packet)

-- ─── follow_ups — the anti-crack task queue ───────────────────────────────────
CREATE TABLE public.follow_ups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  partner_id   uuid REFERENCES public.partners(id) ON DELETE CASCADE,
  referral_id  uuid REFERENCES public.referrals(id) ON DELETE CASCADE,
  title        text NOT NULL,                       -- "Check in — did they admit?"
  due_on       date NOT NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','skipped')),
  completed_at timestamptz,
  note         text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX follow_ups_owner_due_idx ON public.follow_ups (owner_id, status, due_on);
CREATE TRIGGER follow_ups_updated_at BEFORE UPDATE ON public.follow_ups
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.follow_ups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "follow_ups: owner all" ON public.follow_ups
  FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
REVOKE ALL ON public.follow_ups FROM anon, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.follow_ups TO authenticated;

-- ─── referral outcome enrichment — the data flywheel ─────────────────────────
-- Existing outcome ('Placed','Introduced','Consulted','Pending') stays as the
-- coarse state. These add the longitudinal quality signal per referral.
ALTER TABLE public.referrals
  ADD COLUMN admitted            boolean,             -- did the client actually admit?
  ADD COLUMN admitted_on         date,
  ADD COLUMN family_experience   smallint CHECK (family_experience BETWEEN 1 AND 5),
  ADD COLUMN outcome_note        text NOT NULL DEFAULT '',
  ADD COLUMN packet_sent_at      timestamptz,         -- set when a Match Packet is shared
  ADD COLUMN match_profile_id    uuid REFERENCES public.match_profiles(id) ON DELETE SET NULL;

-- ─── partner_scorecard — "who actually admits and treats families well" ──────
CREATE OR REPLACE VIEW public.partner_scorecard
WITH (security_invoker = on) AS
SELECT
  p.id AS partner_id,
  p.owner_id,
  count(r.*) FILTER (WHERE r.direction = 'outbound')                          AS referrals_sent,
  count(r.*) FILTER (WHERE r.direction = 'outbound' AND r.admitted IS TRUE)   AS admits,
  count(r.*) FILTER (WHERE r.direction = 'outbound' AND r.admitted IS FALSE)  AS non_admits,
  round(avg(r.family_experience) FILTER (WHERE r.direction = 'outbound'), 2)  AS avg_family_experience,
  max(r.referred_on) FILTER (WHERE r.direction = 'outbound')                  AS last_referral_on
FROM public.partners p
LEFT JOIN public.referrals r ON r.partner_id = p.id
GROUP BY p.id, p.owner_id;

GRANT SELECT ON public.partner_scorecard TO authenticated;
