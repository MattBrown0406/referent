-- Focused coverage for 20260929174333_self_serve_accounts.sql.
-- Run after a local migration reset with: supabase test db

BEGIN;
SELECT plan(26);

-- ─── Fixtures ────────────────────────────────────────────────────────────────
-- s1: signs up alone (sole owner of a workspace with data + a claimed listing)
-- o2: owner of a shared workspace; m2 joins it
-- c3: treatment-center staff (center_members row) with an empty personal org

INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('aa100000-0000-0000-0000-0000000000aa', 's1@example.test',
   '{"practice_name": "  Riverbend Interventions ", "display_name": "Sam Rivers"}'::jsonb),
  ('aa200000-0000-0000-0000-0000000000aa', 'o2@example.test', '{}'::jsonb),
  ('aa300000-0000-0000-0000-0000000000aa', 'm2@example.test', NULL),
  ('aa400000-0000-0000-0000-0000000000aa', 'c3@example.test', '{"practice_name": ""}'::jsonb);

-- ─── handle_new_user reads sign-up metadata ──────────────────────────────────

SELECT is(
  (SELECT o.name FROM public.orgs o JOIN public.org_members m ON m.org_id = o.id
    WHERE m.user_id = 'aa100000-0000-0000-0000-0000000000aa'),
  'Riverbend Interventions',
  'sign-up practice_name becomes the workspace name (trimmed)'
);
SELECT is(
  (SELECT display_name FROM public.org_members WHERE user_id = 'aa100000-0000-0000-0000-0000000000aa'),
  'Sam Rivers',
  'sign-up display_name becomes the member display name'
);
SELECT is(
  (SELECT o.name FROM public.orgs o JOIN public.org_members m ON m.org_id = o.id
    WHERE m.user_id = 'aa300000-0000-0000-0000-0000000000aa'),
  'My Practice',
  'missing metadata falls back to My Practice'
);
SELECT is(
  (SELECT display_name FROM public.org_members WHERE user_id = 'aa300000-0000-0000-0000-0000000000aa'),
  'm2',
  'missing display_name falls back to the email local part'
);
SELECT is(
  (SELECT o.name FROM public.orgs o JOIN public.org_members m ON m.org_id = o.id
    WHERE m.user_id = 'aa400000-0000-0000-0000-0000000000aa'),
  'My Practice',
  'blank practice_name falls back to My Practice'
);

-- ─── Workspace data for the sole owner ───────────────────────────────────────

SELECT set_config('test.s1_org', (SELECT org_id::text FROM public.org_members WHERE user_id = 'aa100000-0000-0000-0000-0000000000aa'), true);
SELECT set_config('test.o2_org', (SELECT org_id::text FROM public.org_members WHERE user_id = 'aa200000-0000-0000-0000-0000000000aa'), true);

-- m2 joins o2's workspace (the personal org m2 was bootstrapped with goes away).
DELETE FROM public.orgs WHERE id = (SELECT org_id FROM public.org_members WHERE user_id = 'aa300000-0000-0000-0000-0000000000aa');
INSERT INTO public.org_members (org_id, user_id, role, display_name)
VALUES (current_setting('test.o2_org')::uuid, 'aa300000-0000-0000-0000-0000000000aa', 'member', 'Member Two');

INSERT INTO public.partners (id, owner_id, name, organization, types, phone)
VALUES ('bb100000-0000-0000-0000-0000000000bb', 'aa100000-0000-0000-0000-0000000000aa', 'Admissions', 'Solo Program', ARRAY['Inpatient'], '(541) 555-0100');
INSERT INTO public.touches (owner_id, partner_id, kind, note)
VALUES ('aa100000-0000-0000-0000-0000000000aa', 'bb100000-0000-0000-0000-0000000000bb', 'call', 'Intro call');
INSERT INTO public.referrals (id, owner_id, partner_id, direction, referred_on)
VALUES ('bb200000-0000-0000-0000-0000000000bb', 'aa100000-0000-0000-0000-0000000000aa', 'bb100000-0000-0000-0000-0000000000bb', 'outbound', '2026-09-01');
INSERT INTO public.match_profiles (id, owner_id, client_label)
VALUES ('bb300000-0000-0000-0000-0000000000bb', 'aa100000-0000-0000-0000-0000000000aa', 'Family A');
INSERT INTO public.cases (id, owner_id, title, status, match_profile_id)
VALUES ('bb400000-0000-0000-0000-0000000000bb', 'aa100000-0000-0000-0000-0000000000aa', 'Solo case', 'inquiry', 'bb300000-0000-0000-0000-0000000000bb');
INSERT INTO public.case_contacts (id, owner_id, case_id, name)
VALUES ('bb500000-0000-0000-0000-0000000000bb', 'aa100000-0000-0000-0000-0000000000aa', 'bb400000-0000-0000-0000-0000000000bb', 'Parent');
INSERT INTO public.case_documents (id, owner_id, case_id, label, storage_path)
VALUES ('bb600000-0000-0000-0000-0000000000bb', 'aa100000-0000-0000-0000-0000000000aa', 'bb400000-0000-0000-0000-0000000000bb', 'Intake', 'aa100000-0000-0000-0000-0000000000aa/bb400000-0000-0000-0000-0000000000bb/bb600000-0000-0000-0000-0000000000bb.pdf');
INSERT INTO public.case_events (owner_id, case_id, kind, body, contact_id, referral_id, document_id)
VALUES ('aa100000-0000-0000-0000-0000000000aa', 'bb400000-0000-0000-0000-0000000000bb', 'note', 'Reviewed intake', 'bb500000-0000-0000-0000-0000000000bb', 'bb200000-0000-0000-0000-0000000000bb', 'bb600000-0000-0000-0000-0000000000bb');
INSERT INTO public.follow_ups (owner_id, partner_id, case_id, referral_id, title, due_on)
VALUES ('aa100000-0000-0000-0000-0000000000aa', 'bb100000-0000-0000-0000-0000000000bb', 'bb400000-0000-0000-0000-0000000000bb', 'bb200000-0000-0000-0000-0000000000bb', 'Call back', '2026-10-01');
INSERT INTO public.org_invites (org_id, code, expires_at, invited_by)
VALUES (current_setting('test.s1_org')::uuid, 'solo-invite', now() + interval '7 days', 'aa100000-0000-0000-0000-0000000000aa');

-- A public directory listing claimed by s1's workspace; c3 works at that center.
INSERT INTO public.global_partners (id, name, organization, types, phone, status, verified_at, owner_org_id)
VALUES ('cc100000-0000-0000-0000-0000000000cc', 'Admissions', 'Claimed Center', ARRAY['Inpatient'], '(541) 555-0200', 'active', now(), current_setting('test.s1_org')::uuid);
INSERT INTO public.center_members (user_id, global_partner_id)
VALUES ('aa400000-0000-0000-0000-0000000000aa', 'cc100000-0000-0000-0000-0000000000cc');
INSERT INTO public.user_favorites (user_id, org_id, target_type, target_id)
VALUES ('aa100000-0000-0000-0000-0000000000aa', current_setting('test.s1_org')::uuid, 'global_partner', 'cc100000-0000-0000-0000-0000000000cc');

-- m2 contributes a partner to the shared workspace.
INSERT INTO public.partners (id, owner_id, name, organization, types, phone)
VALUES ('bb700000-0000-0000-0000-0000000000bb', 'aa300000-0000-0000-0000-0000000000aa', 'Front Desk', 'Shared Program', ARRAY['Detox'], '(541) 555-0300');

-- ─── Privileges ──────────────────────────────────────────────────────────────

SELECT ok(
  NOT has_function_privilege('anon', 'public.delete_own_account()', 'EXECUTE'),
  'anon cannot execute delete_own_account'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.delete_own_account()', 'EXECUTE'),
  'authenticated can execute delete_own_account'
);

-- ─── Unauthenticated call is refused ─────────────────────────────────────────

SELECT set_config('request.jwt.claim.sub', '', true);
SELECT throws_ok(
  $$ SELECT public.delete_own_account() $$,
  '28000',
  'Authentication is required',
  'delete_own_account requires a signed-in user'
);

-- ─── Owner with other members is refused ─────────────────────────────────────

SELECT set_config('request.jwt.claim.sub', 'aa200000-0000-0000-0000-0000000000aa', true);
SET LOCAL ROLE authenticated;
SELECT throws_like(
  $$ SELECT public.delete_own_account() $$,
  '%still has 1 other member%',
  'an owner whose workspace has other members is told to remove them first'
);
RESET ROLE;
SELECT is(
  (SELECT count(*)::integer FROM auth.users WHERE id = 'aa200000-0000-0000-0000-0000000000aa'),
  1,
  'the refused owner account still exists'
);
SELECT is(
  (SELECT count(*)::integer FROM public.org_members WHERE org_id = current_setting('test.o2_org')::uuid),
  2,
  'the shared workspace keeps both members after the refused attempt'
);

-- ─── Member of a shared workspace deletes only themselves ────────────────────

SELECT set_config('request.jwt.claim.sub', 'aa300000-0000-0000-0000-0000000000aa', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$ SELECT public.delete_own_account() $$,
  'a member can delete their own account'
);
RESET ROLE;
SELECT is(
  (SELECT count(*)::integer FROM auth.users WHERE id = 'aa300000-0000-0000-0000-0000000000aa'),
  0,
  'the member auth user is gone'
);
SELECT is(
  (SELECT count(*)::integer FROM public.org_members WHERE org_id = current_setting('test.o2_org')::uuid),
  1,
  'only the owner remains in the shared workspace'
);
SELECT is(
  (SELECT owner_id::text FROM public.partners WHERE id = 'bb700000-0000-0000-0000-0000000000bb'),
  NULL,
  'work the member created stays with the practice, unattributed'
);
SELECT is(
  (SELECT org_id::text FROM public.partners WHERE id = 'bb700000-0000-0000-0000-0000000000bb'),
  current_setting('test.o2_org'),
  'the shared partner still belongs to the shared workspace'
);

-- ─── Sole owner deletes their whole workspace ────────────────────────────────

SELECT set_config('request.jwt.claim.sub', 'aa100000-0000-0000-0000-0000000000aa', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$ SELECT public.delete_own_account() $$,
  'a sole owner can delete their account'
);
RESET ROLE;
SELECT is(
  (SELECT count(*)::integer FROM auth.users WHERE id = 'aa100000-0000-0000-0000-0000000000aa'),
  0,
  'the sole owner auth user is gone'
);
SELECT is(
  (SELECT count(*)::integer FROM public.orgs WHERE id = current_setting('test.s1_org')::uuid),
  0,
  'the sole owner workspace is gone'
);
SELECT is(
  (SELECT (SELECT count(*) FROM public.partners           WHERE org_id = current_setting('test.s1_org')::uuid)
        + (SELECT count(*) FROM public.touches            WHERE org_id = current_setting('test.s1_org')::uuid)
        + (SELECT count(*) FROM public.referrals          WHERE org_id = current_setting('test.s1_org')::uuid)
        + (SELECT count(*) FROM public.match_profiles     WHERE org_id = current_setting('test.s1_org')::uuid)
        + (SELECT count(*) FROM public.follow_ups         WHERE org_id = current_setting('test.s1_org')::uuid)
        + (SELECT count(*) FROM public.cases              WHERE org_id = current_setting('test.s1_org')::uuid)
        + (SELECT count(*) FROM public.case_contacts      WHERE org_id = current_setting('test.s1_org')::uuid)
        + (SELECT count(*) FROM public.case_events        WHERE org_id = current_setting('test.s1_org')::uuid)
        + (SELECT count(*) FROM public.case_documents     WHERE org_id = current_setting('test.s1_org')::uuid)
        + (SELECT count(*) FROM public.case_stage_history WHERE org_id = current_setting('test.s1_org')::uuid)
        + (SELECT count(*) FROM public.org_invites        WHERE org_id = current_setting('test.s1_org')::uuid)
        + (SELECT count(*) FROM public.user_favorites     WHERE org_id = current_setting('test.s1_org')::uuid)
        + (SELECT count(*) FROM public.org_members        WHERE org_id = current_setting('test.s1_org')::uuid))::integer,
  0,
  'every workspace row (partners, activity, referrals, cases, invites, favorites, members) is deleted'
);
SELECT is(
  (SELECT count(*)::integer FROM public.global_partners WHERE id = 'cc100000-0000-0000-0000-0000000000cc'),
  1,
  'the public directory listing the workspace had claimed still exists'
);
SELECT is(
  (SELECT owner_org_id::text FROM public.global_partners WHERE id = 'cc100000-0000-0000-0000-0000000000cc'),
  NULL,
  'the directory listing is unclaimed (owner_org_id cleared)'
);

-- ─── Center staff: center_members row removed, listing untouched ─────────────

SELECT set_config('request.jwt.claim.sub', 'aa400000-0000-0000-0000-0000000000aa', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$ SELECT public.delete_own_account() $$,
  'a treatment-center staff account can delete itself'
);
RESET ROLE;
SELECT is(
  (SELECT count(*)::integer FROM public.center_members WHERE user_id = 'aa400000-0000-0000-0000-0000000000aa'),
  0,
  'the center_members row is removed'
);
SELECT is(
  (SELECT count(*)::integer FROM public.global_partners WHERE id = 'cc100000-0000-0000-0000-0000000000cc'),
  1,
  'the center listing survives its staff member leaving'
);

-- ─── A deleted user cannot call again ────────────────────────────────────────

SELECT set_config('request.jwt.claim.sub', 'aa100000-0000-0000-0000-0000000000aa', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.delete_own_account() $$,
  'P0002',
  'This account no longer exists',
  'a JWT for a deleted user cannot delete anything'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
