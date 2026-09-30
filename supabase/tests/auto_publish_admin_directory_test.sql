-- Focused coverage for 20260928120000_auto_publish_admin_directory.sql.
-- Run after a local migration reset with: supabase test db

BEGIN;
SELECT plan(42);

-- Actors: d1 owns the seed workspace (platform admin), d2 is a non-admin
-- member of that same workspace, d3 owns an ordinary practice.
INSERT INTO auth.users (id, email)
VALUES
  ('d1000000-0000-0000-0000-00000000000d', 'seed-owner@example.test'),
  ('d2000000-0000-0000-0000-00000000000d', 'seed-staff@example.test'),
  ('d3000000-0000-0000-0000-00000000000d', 'practice@example.test');

INSERT INTO public.platform_admins (user_id)
VALUES ('d1000000-0000-0000-0000-00000000000d');

UPDATE public.org_members
   SET org_id = (SELECT org_id FROM public.org_members WHERE user_id = 'd1000000-0000-0000-0000-00000000000d'),
       role = 'member'
 WHERE user_id = 'd2000000-0000-0000-0000-00000000000d';

CREATE TEMP VIEW seed_org AS
  SELECT org_id FROM public.org_members WHERE user_id = 'd1000000-0000-0000-0000-00000000000d';
CREATE TEMP VIEW practice_org AS
  SELECT org_id FROM public.org_members WHERE user_id = 'd3000000-0000-0000-0000-00000000000d';
GRANT SELECT ON seed_org, practice_org TO authenticated;

-- ─── Seed-org detection ─────────────────────────────────────────────────────

SELECT ok(
  public.org_is_platform_seed((SELECT org_id FROM seed_org)),
  'a workspace owned by a platform admin is a seed org'
);

SELECT ok(
  NOT public.org_is_platform_seed((SELECT org_id FROM practice_org)),
  'an ordinary practice is not a seed org'
);

SELECT ok(
  public.partner_is_directory_program(ARRAY['Inpatient', 'Therapist'])
  AND public.partner_is_directory_program('{}'::text[])
  AND NOT public.partner_is_directory_program(ARRAY['Therapist', 'Interventionist']),
  'programs and untyped partners publish; individual professionals do not'
);

-- ─── Placeholder cleanup ────────────────────────────────────────────────────
-- Three curated listings: one orphan, one linked from a practice, one with an
-- issued claim code. Only the orphan is placeholder data.

INSERT INTO public.global_partners (id, name, organization, types, city, state, phone, status, verified_at)
VALUES ('e1000000-0000-0000-0000-000000000001', 'Admissions', 'Orphan Placeholder', ARRAY['Inpatient'], 'Salem', 'OR', '(503) 555-0001', 'active', now()),
       ('e1000000-0000-0000-0000-000000000002', 'Admissions', 'Curated Linked Center', ARRAY['Inpatient'], 'Eugene', 'OR', '(541) 555-0002', 'active', now()),
       ('e1000000-0000-0000-0000-000000000003', 'Admissions', 'Claimed Center', ARRAY['Detox'], 'Medford', 'OR', '(541) 555-0003', 'active', now());

INSERT INTO public.user_favorites (user_id, org_id, target_type, target_id)
VALUES ('d3000000-0000-0000-0000-00000000000d', (SELECT org_id FROM practice_org), 'global_partner', 'e1000000-0000-0000-0000-000000000001');

INSERT INTO public.center_claim_codes (global_partner_id, code, expires_at)
VALUES ('e1000000-0000-0000-0000-000000000003', 'CLAIMME01', now() + interval '7 days');

-- The practice imported the curated listing before any of this existed.
INSERT INTO public.partners (id, owner_id, name, organization, phone, global_partner_id)
VALUES ('f3000000-0000-0000-0000-000000000001', 'd3000000-0000-0000-0000-00000000000d', 'Admissions', 'Curated Linked Center', '(541) 555-0002', 'e1000000-0000-0000-0000-000000000002');

SELECT is(
  public.cleanup_unlinked_global_partners(),
  1,
  'placeholder cleanup removes exactly the unlinked, unclaimed listing'
);

SELECT is(
  (SELECT array_agg(organization ORDER BY organization) FROM public.global_partners),
  ARRAY['Claimed Center', 'Curated Linked Center'],
  'linked and claimed listings survive the cleanup'
);

SELECT is(
  (SELECT count(*)::integer FROM public.user_favorites WHERE target_id = 'e1000000-0000-0000-0000-000000000001'),
  0,
  'favorites pointing at a deleted placeholder are removed with it'
);

SELECT is(
  public.cleanup_unlinked_global_partners(),
  0,
  'a second cleanup pass deletes nothing'
);

-- ─── Seed owner adds a program: published, active, verified, linked ─────────

SELECT set_config('request.jwt.claim.sub', 'd1000000-0000-0000-0000-00000000000d', true);
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$ INSERT INTO public.partners (id, name, organization, types, city, state, phone, website, levels, note)
     VALUES ('f1000000-0000-0000-0000-000000000001', 'Admissions', 'Seed Recovery Ranch', ARRAY['Inpatient'], 'Bend', 'OR', '(541) 555-0100', 'https://www.seedranch.example/admissions', ARRAY['Residential'], 'Owner-verified program') $$,
  'the seed owner adds a treatment program through the normal partners insert'
);

SELECT ok(
  (SELECT g.status = 'active'
      AND g.verified_at IS NOT NULL
      AND g.created_by = 'd1000000-0000-0000-0000-00000000000d'
      AND g.suggested_by_org_id = (SELECT org_id FROM seed_org)
      AND g.website_domain = 'seedranch.example'
      -- 20260930190000: the private note is not published and is protected.
      AND g.description = ''
      AND p.global_listing_status = 'active'
      AND p.local_overrides = ARRAY['note']
     FROM public.partners p
     JOIN public.global_partners g ON g.id = p.global_partner_id
    WHERE p.id = 'f1000000-0000-0000-0000-000000000001'),
  'the program is published as an active, verified listing linked to the partner'
);

SELECT is(
  (SELECT count(*)::integer FROM public.global_partners WHERE phone_digits = '5415550100'),
  1,
  'exactly one listing exists for the published program'
);

-- ─── Seed edits flow up to the listing and are not local overrides ──────────

SELECT lives_ok(
  $$ UPDATE public.partners SET phone = '(541) 555-0101', city = 'Redmond' WHERE id = 'f1000000-0000-0000-0000-000000000001' $$,
  'the seed owner edits synced fields on the program'
);

SELECT is(
  (SELECT phone_digits || '|' || city FROM public.global_partners
    WHERE id = (SELECT global_partner_id FROM public.partners WHERE id = 'f1000000-0000-0000-0000-000000000001')),
  '5415550101|Redmond',
  'the edit is pushed to the listing'
);

SELECT is(
  (SELECT local_overrides FROM public.partners WHERE id = 'f1000000-0000-0000-0000-000000000001'),
  ARRAY['note'],
  'seed edits are never recorded as local overrides (only the standing note protection is there)'
);

SELECT is(
  (SELECT phone || '|' || city FROM public.partners WHERE id = 'f1000000-0000-0000-0000-000000000001'),
  '(541) 555-0101|Redmond',
  'the round trip through propagation leaves the seed partner intact (no loop)'
);

-- ─── Same workspace, same program again: no second listing, no relink ──────

SELECT lives_ok(
  $$ INSERT INTO public.partners (id, name, organization, types, phone)
     VALUES ('f1000000-0000-0000-0000-000000000002', 'Clinical Director', 'Seed Recovery Ranch', ARRAY['Inpatient'], '541-555-0101') $$,
  'the seed owner adds a second contact for the same program'
);

SELECT ok(
  (SELECT global_partner_id IS NULL FROM public.partners WHERE id = 'f1000000-0000-0000-0000-000000000002')
  AND (SELECT count(*)::integer FROM public.global_partners WHERE phone_digits = '5415550101') = 1,
  'a workspace keeps one linked copy per listing; the duplicate stays private and no listing is added'
);

-- ─── Duplicate by phone against a curated listing: link, do not duplicate ──

SELECT lives_ok(
  $$ INSERT INTO public.partners (id, name, organization, types, phone)
     VALUES ('f1000000-0000-0000-0000-000000000003', 'Intake', 'Curated Linked Ctr', ARRAY['Detox'], '541.555.0002') $$,
  'the seed owner adds a program whose phone matches a curated listing'
);

SELECT is(
  (SELECT global_partner_id FROM public.partners WHERE id = 'f1000000-0000-0000-0000-000000000003'),
  'e1000000-0000-0000-0000-000000000002'::uuid,
  'the partner is linked to the existing listing by phone'
);

SELECT is(
  (SELECT count(*)::integer FROM public.global_partners WHERE phone_digits = '5415550002'),
  1,
  'no second listing is created for the matched phone'
);

SELECT is(
  (SELECT organization || '|' || (types)[1] FROM public.global_partners WHERE id = 'e1000000-0000-0000-0000-000000000002'),
  'Curated Linked Ctr|Detox',
  'linking brings the listing in line with the seed copy'
);

SELECT set_config('request.jwt.claim.sub', 'd3000000-0000-0000-0000-00000000000d', true);

SELECT is(
  (SELECT organization FROM public.partners WHERE id = 'f3000000-0000-0000-0000-000000000001'),
  'Curated Linked Ctr',
  'the practice that imported the listing receives the seed values through propagation'
);

-- ─── Individual professionals are not published ─────────────────────────────

SELECT set_config('request.jwt.claim.sub', 'd1000000-0000-0000-0000-00000000000d', true);

SELECT lives_ok(
  $$ INSERT INTO public.partners (id, name, organization, types, phone)
     VALUES ('f1000000-0000-0000-0000-000000000004', 'Dr. Solo', 'Private Practice', ARRAY['Therapist'], '(541) 555-0400') $$,
  'the seed owner adds a therapist'
);

SELECT ok(
  (SELECT global_partner_id IS NULL FROM public.partners WHERE id = 'f1000000-0000-0000-0000-000000000004')
  AND NOT EXISTS (SELECT 1 FROM public.global_partners WHERE phone_digits = '5415550400'),
  'a therapist-only partner is not published'
);

-- ─── Ordinary practice: nothing auto-publishes, suggestions stay pending ────

SELECT set_config('request.jwt.claim.sub', 'd3000000-0000-0000-0000-00000000000d', true);

SELECT lives_ok(
  -- The suggested row is directory-ready: suggest_global_listing refuses
  -- incomplete partners (20260930120000_directory_submissions.sql).
  $$ INSERT INTO public.partners (id, name, organization, types, city, state, phone, email, website, monthly_cost, insurance)
     VALUES ('f3000000-0000-0000-0000-000000000002', 'Front Desk', 'Private Program', ARRAY['Inpatient'], DEFAULT, DEFAULT, '(503) 555-0300', DEFAULT, 'https://privateprogram.example', DEFAULT, DEFAULT),
            ('f3000000-0000-0000-0000-000000000003', 'Admissions', 'Suggested Program', ARRAY['IOP / PHP'], 'Salem', 'OR', '(503) 555-0500', 'admissions@suggestedprogram.example', 'https://suggestedprogram.example', 18000, ARRAY['Cash pay']) $$,
  'an ordinary practice adds two private programs'
);

SELECT ok(
  (SELECT global_partner_id IS NULL FROM public.partners WHERE id = 'f3000000-0000-0000-0000-000000000002')
  AND NOT EXISTS (SELECT 1 FROM public.global_partners WHERE phone_digits = '5035550300'),
  'a non-seed workspace insert does not create a listing'
);

SELECT lives_ok(
  $$ SELECT public.suggest_global_listing('f3000000-0000-0000-0000-000000000003') $$,
  'the practice suggests one of its programs'
);

SELECT is(
  (SELECT status FROM public.global_partners WHERE phone_digits = '5035550500'),
  'pending',
  'a suggestion from an ordinary practice still lands as pending'
);

-- ─── Non-admin seed member matches the pending suggestion: it goes live ────

SELECT set_config('request.jwt.claim.sub', 'd2000000-0000-0000-0000-00000000000d', true);

SELECT ok(NOT public.is_platform_admin(), 'the seed staff member is not a platform admin');

SELECT lives_ok(
  $$ INSERT INTO public.partners (id, name, organization, types, phone)
     VALUES ('f2000000-0000-0000-0000-000000000001', 'Admissions', 'Suggested Program', ARRAY['IOP / PHP'], '503-555-0500') $$,
  'a seed staff member adds the same program by phone'
);

SELECT ok(
  (SELECT g.status = 'active' AND g.verified_at IS NOT NULL AND p.global_listing_status = 'active'
     FROM public.partners p
     JOIN public.global_partners g ON g.id = p.global_partner_id
    WHERE p.id = 'f2000000-0000-0000-0000-000000000001'),
  'the pending suggestion becomes an active, verified listing linked to the seed partner'
);

SELECT is(
  (SELECT count(*)::integer FROM public.global_partners WHERE phone_digits = '5035550500'),
  1,
  'the match links instead of creating a second listing'
);

SELECT lives_ok(
  $$ UPDATE public.partners SET city = 'Portland' WHERE id = 'f2000000-0000-0000-0000-000000000001' $$,
  'the seed staff member edits the published program'
);

SELECT ok(
  (SELECT g.city = 'Portland' AND g.verified_at IS NOT NULL AND g.status = 'active'
     FROM public.partners p
     JOIN public.global_partners g ON g.id = p.global_partner_id
    WHERE p.id = 'f2000000-0000-0000-0000-000000000001'),
  'a staff edit reaches the listing and keeps it verified (unlike a center edit)'
);

SELECT set_config('request.jwt.claim.sub', 'd3000000-0000-0000-0000-00000000000d', true);

SELECT is(
  (SELECT global_listing_status FROM public.partners WHERE id = 'f3000000-0000-0000-0000-000000000003'),
  'active',
  'the suggesting practice sees its partner go live'
);

-- ─── Listing edits by the admin propagate down without looping ─────────────

SELECT set_config('request.jwt.claim.sub', 'd1000000-0000-0000-0000-00000000000d', true);

SELECT lives_ok(
  $$ UPDATE public.global_partners SET state = 'WA'
      WHERE id = (SELECT global_partner_id FROM public.partners WHERE id = 'f1000000-0000-0000-0000-000000000001') $$,
  'the admin edits the published listing directly'
);

SELECT is(
  (SELECT state || '|' || array_to_string(local_overrides, ',') FROM public.partners WHERE id = 'f1000000-0000-0000-0000-000000000001'),
  'WA|note',
  'the listing edit propagates to the seed partner without recording an override'
);

-- ─── Deleting seed partners: archive only when nobody else uses the listing ─

SELECT lives_ok(
  $$ DELETE FROM public.partners
      WHERE id IN ('f1000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000003') $$,
  'the seed owner removes two programs (and the private duplicate contact)'
);

SELECT is(
  (SELECT status FROM public.global_partners WHERE id = 'e1000000-0000-0000-0000-000000000002'),
  'active',
  'a listing another workspace still links to stays active'
);

SELECT is(
  (SELECT status FROM public.global_partners WHERE phone_digits = '5415550101'),
  'archived',
  'a listing nobody links to any more is archived'
);

-- ─── Backfill is idempotent ─────────────────────────────────────────────────

RESET ROLE;

SELECT is(public.publish_seed_org_partners(), 0, 'with everything already published the backfill links nothing');

-- A partner that slipped past the trigger (written while syncing was on).
SELECT set_config('referralfit.syncing', 'on', true);
INSERT INTO public.partners (id, owner_id, name, organization, types, phone)
VALUES ('f1000000-0000-0000-0000-000000000005', 'd1000000-0000-0000-0000-00000000000d', 'Admissions', 'Backfilled Lodge', ARRAY['Sober Living'], '(541) 555-0900');
SELECT set_config('referralfit.syncing', '', true);

SELECT is(public.publish_seed_org_partners(), 1, 'the backfill publishes the unlinked seed partner');

SELECT is(public.publish_seed_org_partners(), 0, 'running the backfill again publishes nothing new');

SELECT * FROM finish();
ROLLBACK;
