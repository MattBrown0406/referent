-- ReferralFit schema v4 — Today Command Center: typed action queue.
-- follow_ups becomes the universal "what to do next" table.

ALTER TABLE public.follow_ups
  ADD COLUMN kind text NOT NULL DEFAULT 'follow_up'
    CHECK (kind IN ('follow_up','first_call','promised_call','waiting_on','consult','touch')),
  ADD COLUMN due_time time,                -- optional intra-day time (consults, promised calls)
  ADD COLUMN waiting_on text NOT NULL DEFAULT '',  -- who/what we're waiting on, when kind='waiting_on'
  ADD COLUMN snoozed_until date;

CREATE INDEX follow_ups_owner_kind_idx ON public.follow_ups (owner_id, kind, status, due_on);

-- Today view: everything actionable today or overdue, snooze-aware.
CREATE OR REPLACE VIEW public.today_actions
WITH (security_invoker = on) AS
SELECT
  f.*,
  (CURRENT_DATE - f.due_on) AS days_overdue,
  c.title  AS case_title,
  c.status AS case_status,
  p.name   AS partner_name,
  p.phone  AS partner_phone
FROM public.follow_ups f
LEFT JOIN public.cases    c ON c.id = f.case_id
LEFT JOIN public.partners p ON p.id = f.partner_id
WHERE f.status = 'open'
  AND coalesce(f.snoozed_until, f.due_on) <= CURRENT_DATE;

GRANT SELECT ON public.today_actions TO authenticated;
