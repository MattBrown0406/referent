-- Focused coverage for 20260819230000_benchmarks.sql.
-- Run after a local migration reset with: supabase test db

BEGIN;
SELECT plan(8);

INSERT INTO auth.users (id, email)
VALUES
  ('cc100000-0000-0000-0000-0000000000cc', 'bench-subscriber@example.test'),
  ('cc200000-0000-0000-0000-0000000000cc', 'bench-free@example.test');

INSERT INTO public.org_entitlements (org_id, entitlement, active, source)
SELECT org_id, 'benchmarks', true, 'manual'
  FROM public.org_members
 WHERE user_id = 'cc100000-0000-0000-0000-0000000000cc';

-- Workspace activity for the subscriber: 2 outbound referrals (1 admit,
-- 1 non-admit) and 2 cases (1 placed with a quote, 1 lost).
INSERT INTO public.partners (id, owner_id, name)
VALUES ('cc300000-0000-0000-0000-0000000000cc', 'cc100000-0000-0000-0000-0000000000cc', 'Bench partner');
INSERT INTO public.referrals (id, owner_id, partner_id, direction, referred_on, admitted, family_experience)
VALUES
  ('cc400000-0000-0000-0000-0000000000cc', 'cc100000-0000-0000-0000-0000000000cc', 'cc300000-0000-0000-0000-0000000000cc', 'outbound', '2026-08-01', true, 5),
  ('cc500000-0000-0000-0000-0000000000cc', 'cc100000-0000-0000-0000-0000000000cc', 'cc300000-0000-0000-0000-0000000000cc', 'outbound', '2026-08-02', false, 3);
INSERT INTO public.cases (id, owner_id, title, status, quoted_amount, payment_status, paid_amount)
VALUES
  ('cc600000-0000-0000-0000-0000000000cc', 'cc100000-0000-0000-0000-0000000000cc', 'Placed case', 'placed', 8000, 'paid', 8000),
  ('cc700000-0000-0000-0000-0000000000cc', 'cc100000-0000-0000-0000-0000000000cc', 'Lost case', 'lost', NULL, 'none', 0);

-- ─── Gating ──────────────────────────────────────────────────────────────────

SELECT set_config('request.jwt.claim.sub', 'cc200000-0000-0000-0000-0000000000cc', true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$ SELECT public.fetch_benchmarks() $$,
  '42501',
  'Benchmarks require the benchmarks plan',
  'the free tier cannot fetch benchmarks'
);

-- ─── Subscriber report ───────────────────────────────────────────────────────

SELECT set_config('request.jwt.claim.sub', 'cc100000-0000-0000-0000-0000000000cc', true);

SELECT lives_ok(
  $$ SELECT public.fetch_benchmarks() $$,
  'a benchmarks subscriber can fetch the report'
);

SELECT is(
  (SELECT (public.fetch_benchmarks() -> 'workspace' ->> 'admit_rate')::numeric),
  0.500,
  'workspace admit rate reflects recorded outcomes'
);

SELECT is(
  (SELECT (public.fetch_benchmarks() -> 'workspace' ->> 'placement_rate')::numeric),
  0.500,
  'workspace placement rate covers placed vs lost cases'
);

SELECT is(
  (SELECT (public.fetch_benchmarks() -> 'workspace' ->> 'median_quote')::numeric),
  8000::numeric,
  'workspace median quote comes from quoted cases'
);

SELECT ok(
  (SELECT (public.fetch_benchmarks() -> 'network' -> 'admit_rate') = 'null'::jsonb),
  'network metrics stay null below the k-anonymity floor'
);

SELECT is(
  (SELECT (public.fetch_benchmarks() -> 'network' ->> 'contributor_floor')::integer),
  5,
  'the report advertises the contributor floor'
);

SELECT ok(
  position('org_id <> v_org' in pg_get_functiondef('public.fetch_benchmarks()'::regprocedure)) > 0,
  'the caller workspace is excluded from every network comparison cohort'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
