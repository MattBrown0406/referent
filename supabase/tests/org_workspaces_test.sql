-- Focused coverage for 20260819120000_org_workspaces.sql.
-- Run after a local migration reset with: supabase test db

BEGIN;
SELECT plan(20);

-- ─── Personal org bootstrap ──────────────────────────────────────────────────

INSERT INTO auth.users (id, email)
VALUES
  ('a1000000-0000-0000-0000-00000000000a', 'practice-owner@example.test'),
  ('b2000000-0000-0000-0000-00000000000b', 'joining-member@example.test'),
  ('c3000000-0000-0000-0000-00000000000c', 'outsider@example.test');

SELECT is(
  (SELECT count(*)::integer FROM public.org_members
    WHERE user_id IN (
      'a1000000-0000-0000-0000-00000000000a',
      'b2000000-0000-0000-0000-00000000000b',
      'c3000000-0000-0000-0000-00000000000c'
    ) AND role = 'owner'),
  3,
  'every new auth user gets a personal org with the owner role'
);

SELECT is(
  (SELECT count(DISTINCT org_id)::integer FROM public.org_members
    WHERE user_id IN (
      'a1000000-0000-0000-0000-00000000000a',
      'b2000000-0000-0000-0000-00000000000b',
      'c3000000-0000-0000-0000-00000000000c'
    )),
  3,
  'personal orgs are distinct per user'
);

SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.orgs'::regclass)
  AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.org_members'::regclass)
  AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.org_invites'::regclass),
  'orgs, org_members, and org_invites all enforce RLS'
);

-- Seed one row for the joining member before they join the practice, to prove
-- the re-home moves existing data.
INSERT INTO public.partners (id, owner_id, name)
VALUES ('b2100000-0000-0000-0000-00000000000b', 'b2000000-0000-0000-0000-00000000000b', 'Member partner');

SELECT is(
  (SELECT org_id FROM public.partners WHERE id = 'b2100000-0000-0000-0000-00000000000b'),
  (SELECT org_id FROM public.org_members WHERE user_id = 'b2000000-0000-0000-0000-00000000000b'),
  'the insert trigger derives org_id from the author''s membership'
);

-- ─── Invite → join → shared workspace ────────────────────────────────────────

-- Team invitation is a Pro capability. Grant the owner a manual test
-- entitlement before exercising the invite flow.
INSERT INTO public.org_entitlements (org_id, entitlement, active, source)
SELECT org_id, 'pro', true, 'manual'
  FROM public.org_members
 WHERE user_id = 'a1000000-0000-0000-0000-00000000000a';

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-00000000000a', true);
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$ SELECT set_config('test.invite_code', code, true) FROM public.create_org_invite() $$,
  'the workspace owner can create an invite code'
);

INSERT INTO public.partners (id, owner_id, name)
VALUES ('a1100000-0000-0000-0000-00000000000a', 'a1000000-0000-0000-0000-00000000000a', 'Practice partner');

SELECT set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-00000000000b', true);

SELECT lives_ok(
  $$ SELECT public.accept_org_invite(current_setting('test.invite_code')) $$,
  'a solo user can join the practice with the invite code'
);

SELECT is(
  (SELECT org_id FROM public.org_members WHERE user_id = 'b2000000-0000-0000-0000-00000000000b'),
  (SELECT org_id FROM public.org_members WHERE user_id = 'a1000000-0000-0000-0000-00000000000a'),
  'accepting an invite moves the member into the practice org'
);

SELECT is(
  (SELECT role FROM public.org_members WHERE user_id = 'b2000000-0000-0000-0000-00000000000b'),
  'member',
  'the joining user becomes a member, not an owner'
);

SELECT is(
  (SELECT org_id FROM public.partners WHERE id = 'b2100000-0000-0000-0000-00000000000b'),
  (SELECT org_id FROM public.org_members WHERE user_id = 'a1000000-0000-0000-0000-00000000000a'),
  'joining re-homes the member''s existing rows into the practice workspace'
);

SELECT is(
  (SELECT count(*)::integer FROM public.partners),
  2,
  'the joined member sees both their own and the practice partner through RLS'
);

SELECT lives_ok(
  $$ INSERT INTO public.touches (owner_id, partner_id, kind, note)
     VALUES ('b2000000-0000-0000-0000-00000000000b', 'a1100000-0000-0000-0000-00000000000a', 'call', 'Colleague touch') $$,
  'a member can log activity against a colleague''s partner'
);

SELECT throws_ok(
  $$ SELECT public.accept_org_invite(current_setting('test.invite_code')) $$,
  '22023',
  'Invite code was already used',
  'invite codes are single-use'
);

-- ─── Attribution guard ───────────────────────────────────────────────────────

SELECT throws_ok(
  $$ INSERT INTO public.partners (id, owner_id, name)
     VALUES ('b2200000-0000-0000-0000-00000000000b', 'a1000000-0000-0000-0000-00000000000a', 'Spoofed author') $$,
  '42501',
  'Rows must be created by their authenticated author',
  'a member cannot create rows attributed to a colleague'
);

-- ─── Outsider isolation ──────────────────────────────────────────────────────

SELECT set_config('request.jwt.claim.sub', 'c3000000-0000-0000-0000-00000000000c', true);

SELECT is(
  (SELECT count(*)::integer FROM public.partners),
  0,
  'a user outside the workspace sees none of its rows'
);

SELECT is(
  (SELECT count(*)::integer FROM public.orgs),
  1,
  'a user sees only their own org row'
);

SELECT throws_ok(
  $$ SELECT public.remove_org_member('b2000000-0000-0000-0000-00000000000b') $$,
  'P0002',
  'Member not found in your workspace',
  'an outsider cannot remove members of another workspace'
);

-- ─── Member removal keeps practice data ──────────────────────────────────────

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-00000000000a', true);

SELECT lives_ok(
  $$ SELECT public.remove_org_member('b2000000-0000-0000-0000-00000000000b') $$,
  'the owner can remove a member'
);

-- The remaining assertions inspect both workspaces at once, which no single
-- member can see through RLS; return to the superuser connection role.
RESET ROLE;

SELECT is(
  (SELECT org_id FROM public.partners WHERE id = 'b2100000-0000-0000-0000-00000000000b'),
  (SELECT org_id FROM public.org_members WHERE user_id = 'a1000000-0000-0000-0000-00000000000a'),
  'a removed member''s past work stays with the practice workspace'
);

SELECT isnt(
  (SELECT org_id FROM public.org_members WHERE user_id = 'b2000000-0000-0000-0000-00000000000b'),
  (SELECT org_id FROM public.org_members WHERE user_id = 'a1000000-0000-0000-0000-00000000000a'),
  'a removed member lands in a fresh personal org'
);

SELECT is(
  (SELECT role FROM public.org_members WHERE user_id = 'b2000000-0000-0000-0000-00000000000b'),
  'owner',
  'a removed member owns their fresh personal org'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
