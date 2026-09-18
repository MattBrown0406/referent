-- Focused coverage for 20260918230000_free_launch_period.sql.
-- Run after a local migration reset with: supabase test db
--
-- Unlike the other suites this one leaves free_launch_period() at its
-- deployed value, so it proves what a brand-new practice actually gets.

BEGIN;
SELECT plan(7);

INSERT INTO auth.users (id, email)
VALUES ('f1000000-0000-0000-0000-00000000000f', 'new-practice@example.test'),
       ('f2000000-0000-0000-0000-00000000000f', 'curator@example.test');

INSERT INTO public.platform_admins (user_id)
VALUES ('f2000000-0000-0000-0000-00000000000f');

SELECT is(public.free_launch_period(), true, 'the free launch period is on');

SELECT is(
  (SELECT count(*)::integer FROM public.org_entitlements
    WHERE org_id = (SELECT org_id FROM public.org_members WHERE user_id = 'f1000000-0000-0000-0000-00000000000f')),
  0,
  'a fresh workspace has no entitlement rows at all'
);

SELECT set_config('request.jwt.claim.sub', 'f2000000-0000-0000-0000-00000000000f', true);
SET LOCAL ROLE authenticated;

INSERT INTO public.global_partners (id, name, organization, types, city, state, phone, website, levels, status, verified_at)
VALUES ('b9000000-0000-0000-0000-000000000001', 'Admissions', 'Juniper Ridge Recovery', ARRAY['Inpatient'], 'Bend', 'OR', '(541) 555-0190', 'https://juniperridge.example', ARRAY['Residential'], 'active', now());

SELECT set_config('request.jwt.claim.sub', 'f1000000-0000-0000-0000-00000000000f', true);

SELECT is(
  (SELECT count(*)::integer FROM public.fetch_org_entitlements() WHERE active),
  3,
  'every plan reports active without any grant'
);

SELECT lives_ok(
  $$ SELECT public.toggle_user_favorite('global_partner', 'b9000000-0000-0000-0000-000000000001') $$,
  'the shared directory is open to a fresh workspace'
);

SELECT lives_ok(
  $$ SELECT public.create_org_invite() $$,
  'team invitations are open to a fresh workspace'
);

SELECT lives_ok(
  $$ SELECT public.fetch_benchmarks() $$,
  'benchmarks are open to a fresh workspace'
);

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

SELECT is(
  public.org_has_entitlement('pro'),
  false,
  'without a workspace context the free period grants nothing'
);

SELECT * FROM finish();
ROLLBACK;
