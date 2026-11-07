-- Focused coverage for 20261106140000_read_only_table_grants.sql.
-- Run after a local migration reset with: supabase test db
--
-- The catalog checks read pg_class.relacl directly (aclexplode) rather than
-- information_schema, so they also see Postgres 17's MAINTAIN privilege.
-- They hold on any Supabase image: with or without the default privileges
-- that grant arwdDxtm to authenticated on every new table in public.

BEGIN;
SELECT plan(21);

-- --- 1. Catalog: what each role holds -------------------------------------

SELECT results_eq(
  $$ SELECT c.relname::text COLLATE "default", x.privilege_type::text
       FROM pg_class c
       CROSS JOIN LATERAL aclexplode(c.relacl) x
      WHERE c.oid IN (
              'public.case_stage_history'::regclass, 'public.center_claim_codes'::regclass,
              'public.center_claim_requests'::regclass, 'public.center_members'::regclass,
              'public.org_entitlements'::regclass, 'public.org_invites'::regclass,
              'public.org_members'::regclass, 'public.org_revenuecat_grants'::regclass,
              'public.platform_admins'::regclass, 'public.orgs'::regclass)
        AND x.grantee = 'authenticated'::regrole
      ORDER BY 1, 2 $$,
  $$ VALUES ('case_stage_history', 'SELECT'), ('center_claim_codes', 'SELECT'),
            ('center_claim_requests', 'SELECT'), ('center_members', 'SELECT'),
            ('org_entitlements', 'SELECT'), ('org_invites', 'SELECT'),
            ('org_members', 'SELECT'), ('org_revenuecat_grants', 'SELECT'),
            ('orgs', 'SELECT'), ('platform_admins', 'SELECT') $$,
  'signed-in clients hold SELECT and nothing else on the read-only tables'
);

SELECT is_empty(
  $$ SELECT c.relname, x.grantee, x.privilege_type
       FROM pg_class c
       CROSS JOIN LATERAL aclexplode(c.relacl) x
      WHERE c.oid IN (
              'public.case_stage_history'::regclass, 'public.center_claim_codes'::regclass,
              'public.center_claim_requests'::regclass, 'public.center_members'::regclass,
              'public.org_entitlements'::regclass, 'public.org_invites'::regclass,
              'public.org_members'::regclass, 'public.org_revenuecat_grants'::regclass,
              'public.platform_admins'::regclass, 'public.orgs'::regclass)
        AND (x.grantee = 0 OR x.grantee = 'anon'::regrole) $$,
  'anon and PUBLIC hold nothing on the read-only tables'
);

SELECT is(
  (SELECT string_agg(a.attname, ',' ORDER BY a.attname)
     FROM pg_attribute a
    WHERE a.attrelid = 'public.orgs'::regclass AND a.attnum > 0 AND NOT a.attisdropped
      AND has_column_privilege('authenticated', a.attrelid, a.attnum, 'UPDATE')),
  'lead_response_target_minutes,name',
  'clients may update only the workspace name and first-call target'
);

-- Drift guards for every table, including ones added later: a client write
-- grant is only ever paired with a policy that allows that write, and no
-- table a client can reach skips RLS.
SELECT is_empty(
  $$ SELECT c.relname, p.priv
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND has_table_privilege('authenticated', c.oid, p.priv)
        AND NOT EXISTS (
              SELECT 1 FROM pg_policies pol
               WHERE pol.schemaname = 'public' AND pol.tablename = c.relname
                 AND pol.cmd IN (p.priv, 'ALL')
                 AND pol.roles && ARRAY['public', 'authenticated']::name[]) $$,
  'no table grants a client write that no policy allows'
);

SELECT is_empty(
  $$ SELECT c.relname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
        AND (has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
             OR has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE')) $$,
  'every table a client can reach enforces RLS'
);

-- --- 2. Behaviour as a workspace owner ------------------------------------

INSERT INTO auth.users (id, email)
VALUES ('7e000000-0000-0000-0000-00000000007e', 'grants-owner@example.test');

SELECT set_config('test.grants_org', (SELECT org_id::text FROM public.org_members WHERE user_id = '7e000000-0000-0000-0000-00000000007e'), true);
SELECT set_config('test.grants_token', (SELECT intake_token FROM public.orgs WHERE id = current_setting('test.grants_org')::uuid), true);

SELECT set_config('request.jwt.claim.sub', '7e000000-0000-0000-0000-00000000007e', true);
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$ UPDATE public.orgs SET name = 'Renamed Practice' WHERE id = current_setting('test.grants_org')::uuid $$,
  'the owner can still rename the workspace'
);

SELECT lives_ok(
  $$ UPDATE public.orgs SET lead_response_target_minutes = 30 WHERE id = current_setting('test.grants_org')::uuid $$,
  'the owner can still change the first-call target'
);

SELECT throws_ok(
  $$ UPDATE public.orgs SET intake_token = repeat('0', 40) WHERE id = current_setting('test.grants_org')::uuid $$,
  '42501',
  NULL,
  'the owner cannot choose the intake token directly'
);

SELECT throws_ok(
  $$ UPDATE public.orgs SET created_by = auth.uid(), intake_token_rotated_at = now() WHERE id = current_setting('test.grants_org')::uuid $$,
  '42501',
  NULL,
  'the owner cannot rewrite other workspace columns'
);

SELECT throws_ok(
  $$ INSERT INTO public.platform_admins (user_id) VALUES (auth.uid()) $$,
  '42501',
  NULL,
  'a client cannot make itself a platform admin'
);

SELECT throws_ok(
  $$ INSERT INTO public.org_members (user_id, org_id, role) VALUES (auth.uid(), current_setting('test.grants_org')::uuid, 'owner') $$,
  '42501',
  NULL,
  'membership changes only through the invite and removal functions'
);

SELECT throws_ok(
  $$ UPDATE public.org_entitlements SET active = true $$,
  '42501',
  NULL,
  'a client cannot switch on an entitlement'
);

SELECT throws_ok(
  $$ DELETE FROM public.org_invites $$,
  '42501',
  NULL,
  'a client cannot delete invites directly'
);

SELECT throws_ok(
  $$ TRUNCATE public.org_entitlements $$,
  '42501',
  NULL,
  'a client cannot truncate entitlements (TRUNCATE ignores RLS)'
);

SELECT throws_ok(
  $$ TRUNCATE public.case_stage_history $$,
  '42501',
  NULL,
  'a client cannot truncate stage history'
);

-- The SECURITY DEFINER paths that own these tables still work.
SELECT lives_ok(
  $$ SELECT public.rotate_intake_token() $$,
  'the owner can still rotate the intake token'
);

SELECT ok(
  (SELECT intake_token ~ '^[0-9a-f]{40}$' AND intake_token <> current_setting('test.grants_token')
     FROM public.orgs WHERE id = current_setting('test.grants_org')::uuid),
  'rotation issued a new 40-character token'
);

SELECT lives_ok(
  $$ INSERT INTO public.cases (id, org_id, title)
     VALUES ('7e100000-0000-0000-0000-00000000007e', current_setting('test.grants_org')::uuid, 'Grants case') $$,
  'a member can still open a case'
);

SELECT lives_ok(
  $$ UPDATE public.cases SET status = 'consult' WHERE id = '7e100000-0000-0000-0000-00000000007e' $$,
  'a member can still move a case to another stage'
);

SELECT is(
  (SELECT count(*)::integer FROM public.case_stage_history WHERE case_id = '7e100000-0000-0000-0000-00000000007e'),
  2,
  'the stage-history trigger still records both stages, and the member can read them'
);

SELECT is(
  (SELECT name || '|' || lead_response_target_minutes FROM public.orgs WHERE id = current_setting('test.grants_org')::uuid),
  'Renamed Practice|30',
  'the permitted workspace edits landed'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
