-- Regression coverage for 20260820033721_harden_multi_practice_boundaries.sql.
BEGIN;
SELECT plan(15);

INSERT INTO auth.users (id, email)
VALUES
  ('aa000000-0000-0000-0000-000000000001', 'hardening-owner-a@example.test'),
  ('bb000000-0000-0000-0000-000000000002', 'hardening-member@example.test'),
  ('cc000000-0000-0000-0000-000000000003', 'hardening-owner-c@example.test'),
  ('dd000000-0000-0000-0000-000000000004', 'hardening-free-owner@example.test');

INSERT INTO public.org_entitlements (org_id, entitlement, active, source)
SELECT org_id, 'pro', true, 'manual'
  FROM public.org_members
 WHERE user_id IN (
   'aa000000-0000-0000-0000-000000000001',
   'cc000000-0000-0000-0000-000000000003'
 );

-- A solo owner brings personal data into the first practice.
INSERT INTO public.partners (id, owner_id, name)
VALUES ('bb100000-0000-0000-0000-000000000002', 'bb000000-0000-0000-0000-000000000002', 'Personal partner');

SELECT set_config('request.jwt.claim.sub', 'aa000000-0000-0000-0000-000000000001', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$ SELECT set_config('test.hardening_invite_a', code, true) FROM public.create_org_invite() $$,
  'a Pro owner can create a team invite'
);

SELECT set_config('request.jwt.claim.sub', 'bb000000-0000-0000-0000-000000000002', true);
SELECT lives_ok(
  $$ SELECT public.accept_org_invite(current_setting('test.hardening_invite_a')) $$,
  'the solo owner can join the first practice'
);

SELECT is(
  (SELECT org_id FROM public.partners WHERE id = 'bb100000-0000-0000-0000-000000000002'),
  (SELECT org_id FROM public.org_members WHERE user_id = 'aa000000-0000-0000-0000-000000000001'),
  'personal workspace data moves on the first join'
);

-- This row is authored while B is a member of A's practice and therefore
-- belongs to A's practice, not to B personally.
INSERT INTO public.partners (id, owner_id, name)
VALUES ('bb200000-0000-0000-0000-000000000002', 'bb000000-0000-0000-0000-000000000002', 'Practice-owned partner');

SELECT throws_ok(
  $$ UPDATE public.partners
        SET owner_id = 'aa000000-0000-0000-0000-000000000001'
      WHERE id = 'bb200000-0000-0000-0000-000000000002' $$,
  '42501',
  'Row attribution cannot be changed',
  'workspace members cannot rewrite row attribution before leaving'
);

SELECT is(
  (SELECT count(*)::integer FROM public.org_invites),
  0,
  'a non-owner member cannot read workspace invite credentials'
);

SELECT set_config('request.jwt.claim.sub', 'aa000000-0000-0000-0000-000000000001', true);
INSERT INTO public.cases (id, owner_id, title)
VALUES ('aa300000-0000-0000-0000-000000000001', 'aa000000-0000-0000-0000-000000000001', 'Practice case');
SELECT set_config('request.jwt.claim.sub', 'bb000000-0000-0000-0000-000000000002', true);
SELECT throws_ok(
  $$ INSERT INTO public.case_integrations (
       owner_id, case_id, provider, record_type, external_id
     ) VALUES (
       'aa000000-0000-0000-0000-000000000001',
       'aa300000-0000-0000-0000-000000000001',
       'square', 'invoice', 'spoofed-invoice'
     ) $$,
  '42501',
  'Rows must be created by their authenticated author',
  'a teammate cannot forge integration attribution to another member'
);
RESET ROLE;
INSERT INTO storage.objects (bucket_id, name, owner_id)
VALUES (
  'case-documents',
  'bb000000-0000-0000-0000-000000000002/aa300000-0000-0000-0000-000000000001/aa400000-0000-0000-0000-000000000001.pdf',
  'bb000000-0000-0000-0000-000000000002'
);

-- C issues a second invite. B is now a member, so accepting it must not pull
-- A's practice-owned rows into C's workspace.
SELECT set_config('request.jwt.claim.sub', 'cc000000-0000-0000-0000-000000000003', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$ SELECT set_config('test.hardening_invite_c', code, true) FROM public.create_org_invite() $$,
  'a second Pro owner can create an invite'
);

SELECT set_config('request.jwt.claim.sub', 'bb000000-0000-0000-0000-000000000002', true);
SELECT lives_ok(
  $$ SELECT public.accept_org_invite(current_setting('test.hardening_invite_c')) $$,
  'an existing member can move their account to another practice'
);

RESET ROLE;
SELECT is(
  (SELECT org_id FROM public.partners WHERE id = 'bb200000-0000-0000-0000-000000000002'),
  (SELECT org_id FROM public.org_members WHERE user_id = 'aa000000-0000-0000-0000-000000000001'),
  'a departing member cannot move practice-owned data to the new practice'
);

SELECT isnt(
  (SELECT org_id FROM public.partners WHERE id = 'bb200000-0000-0000-0000-000000000002'),
  (SELECT org_id FROM public.org_members WHERE user_id = 'cc000000-0000-0000-0000-000000000003'),
  'the new practice receives no rows authored inside the old practice'
);

SELECT set_config('request.jwt.claim.sub', 'bb000000-0000-0000-0000-000000000002', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT count(*)::integer FROM storage.objects WHERE bucket_id = 'case-documents'),
  0,
  'a departed uploader immediately loses access to the old practice document'
);

SELECT set_config('request.jwt.claim.sub', 'aa000000-0000-0000-0000-000000000001', true);
SELECT is(
  (SELECT count(*)::integer FROM storage.objects WHERE bucket_id = 'case-documents'),
  1,
  'the practice retains access to a document uploaded by a departed member'
);

RESET ROLE;
DELETE FROM auth.users WHERE id = 'bb000000-0000-0000-0000-000000000002';
SELECT is(
  (SELECT count(*)::integer FROM public.partners
    WHERE id = 'bb200000-0000-0000-0000-000000000002' AND owner_id IS NULL),
  1,
  'deleting a former member account preserves practice-owned rows and clears only attribution'
);

SELECT set_config('request.jwt.claim.sub', 'dd000000-0000-0000-0000-000000000004', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.create_org_invite() $$,
  '42501',
  'Team workspace invites require the Pro plan',
  'a free workspace cannot bypass the Pro team gate through the RPC'
);

RESET ROLE;
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'partners_org_global_partner_unique'
       AND indexdef LIKE 'CREATE UNIQUE INDEX%'
  ),
  'directory imports have a database-enforced per-workspace uniqueness gate'
);

SELECT * FROM finish();
ROLLBACK;
