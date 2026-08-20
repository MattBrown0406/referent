-- Focused coverage for 20260819150000_entitlements.sql.
-- Run after a local migration reset with: supabase test db

BEGIN;
SELECT plan(8);

INSERT INTO auth.users (id, email)
VALUES
  ('d4000000-0000-0000-0000-00000000000d', 'entitled@example.test'),
  ('e5000000-0000-0000-0000-00000000000e', 'free-tier@example.test');

SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.org_entitlements'::regclass),
  'org_entitlements enforces RLS'
);

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.org_entitlements', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.org_entitlements', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.org_entitlements', 'DELETE')
  AND has_table_privilege('authenticated', 'public.org_entitlements', 'SELECT'),
  'clients can only read entitlement state'
);

-- Manual grant (as the service would write it): pro active, directory expired.
INSERT INTO public.org_entitlements (org_id, entitlement, active, source, expires_at)
SELECT m.org_id, e.entitlement, e.active, 'manual', e.expires_at
  FROM public.org_members m
 CROSS JOIN (VALUES
   ('pro', true, NULL::timestamptz),
   ('directory', true, now() - interval '1 day'),
   ('benchmarks', false, NULL::timestamptz)
 ) AS e(entitlement, active, expires_at)
 WHERE m.user_id = 'd4000000-0000-0000-0000-00000000000d';

SELECT set_config('request.jwt.claim.sub', 'd4000000-0000-0000-0000-00000000000d', true);
SET LOCAL ROLE authenticated;

SELECT ok(
  public.org_has_entitlement('pro'),
  'an active non-expiring entitlement passes the gate'
);

SELECT ok(
  NOT public.org_has_entitlement('directory'),
  'an expired entitlement fails the gate'
);

SELECT ok(
  NOT public.org_has_entitlement('benchmarks'),
  'an inactive entitlement fails the gate'
);

SELECT is(
  (SELECT count(*)::integer FROM public.org_entitlements),
  3,
  'a member reads only their own workspace entitlement rows'
);

SELECT set_config('request.jwt.claim.sub', 'e5000000-0000-0000-0000-00000000000e', true);

SELECT is(
  (SELECT count(*)::integer FROM public.org_entitlements),
  0,
  'another workspace sees no entitlement rows'
);

SELECT ok(
  NOT public.org_has_entitlement('pro'),
  'a workspace without entitlements is on the free tier'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
