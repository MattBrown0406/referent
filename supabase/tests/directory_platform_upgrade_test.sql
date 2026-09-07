-- Focused coverage for 20260907120000_directory_platform_upgrade.sql.
-- Run after a local migration reset with: supabase test db

BEGIN;
SELECT plan(27);

INSERT INTO auth.users (id, email)
VALUES
  ('a1000000-0000-0000-0000-00000000000a', 'curator@example.test'),
  ('a2000000-0000-0000-0000-00000000000a', 'practice-one@example.test'),
  ('a3000000-0000-0000-0000-00000000000a', 'practice-two@example.test'),
  ('a4000000-0000-0000-0000-00000000000a', 'free-user@example.test');

INSERT INTO public.platform_admins (user_id)
VALUES ('a1000000-0000-0000-0000-00000000000a');

INSERT INTO public.org_entitlements (org_id, entitlement, active, source)
SELECT org_id, 'directory', true, 'manual'
  FROM public.org_members
 WHERE user_id IN ('a2000000-0000-0000-0000-00000000000a', 'a3000000-0000-0000-0000-00000000000a');

-- ─── Curator seeds listings ─────────────────────────────────────────────────

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-00000000000a', true);
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$ INSERT INTO public.global_partners (id, name, organization, types, city, state, phone, website, levels, status, verified_at)
     VALUES ('b1000000-0000-0000-0000-000000000001', 'Admissions', 'Cascade Recovery Center', ARRAY['Inpatient'], 'Bend', 'OR', '(541) 555-0100', 'https://www.cascaderecovery.example/admissions', ARRAY['Residential'], 'active', now()),
            ('b1000000-0000-0000-0000-000000000003', 'Intake Line', 'Cascade Recovery Ctr', ARRAY['Inpatient'], 'Bend', 'OR', '541-555-0100', 'https://cascaderecovery.example', ARRAY['Detox'], 'active', now() - interval '13 months') $$,
  'the curator seeds an active listing and a near-duplicate of it'
);

SELECT is(
  (SELECT phone_digits || '|' || website_domain FROM public.global_partners WHERE id = 'b1000000-0000-0000-0000-000000000001'),
  '5415550100|cascaderecovery.example',
  'phone digits and website domain are normalized on write'
);

SELECT is(
  (SELECT count(*)::integer FROM public.find_duplicate_global_partners()),
  2,
  'the duplicate report flags the pair by both phone and domain'
);

-- ─── Practice one: favorites, import, overrides ─────────────────────────────

SELECT set_config('request.jwt.claim.sub', 'a2000000-0000-0000-0000-00000000000a', true);

SELECT is(
  public.toggle_user_favorite('global_partner', 'b1000000-0000-0000-0000-000000000001'),
  true,
  'a subscriber can favorite a directory listing before importing it'
);

SELECT is(
  (SELECT count(*)::integer FROM public.user_favorites),
  1,
  'the favorite is visible to its owner'
);

SELECT lives_ok(
  $$ SELECT public.import_global_partner(
       'b1000000-0000-0000-0000-000000000001'::uuid,
       'c2000000-0000-0000-0000-000000000001'::uuid
     ) $$,
  'practice one imports the listing'
);

SELECT ok(
  EXISTS (SELECT 1 FROM public.user_favorites
           WHERE target_type = 'partner' AND target_id = 'c2000000-0000-0000-0000-000000000001'),
  'the personal favorite carries over to the imported tenant partner'
);

SELECT lives_ok(
  $$ UPDATE public.partners SET phone = '(541) 555-0199' WHERE id = 'c2000000-0000-0000-0000-000000000001' $$,
  'the workspace edits a synced field on its copy'
);

SELECT is(
  (SELECT local_overrides FROM public.partners WHERE id = 'c2000000-0000-0000-0000-000000000001'),
  ARRAY['phone'],
  'the local edit is recorded as an override'
);

SELECT is(
  (SELECT count(*)::integer FROM public.search_global_partners('cascade')),
  2,
  'server search finds listings by trigram/full-text match'
);

SELECT is(
  (SELECT count(*)::integer FROM public.search_global_partners('cascade', 'WA')),
  0,
  'server search honors the state filter'
);

SELECT is(
  (SELECT verified_current FROM public.search_global_partners('cascade') WHERE id = 'b1000000-0000-0000-0000-000000000003'),
  false,
  'a verification older than 12 months is no longer current'
);

-- ─── Practice two: isolation + import of the near-duplicate ─────────────────

SELECT set_config('request.jwt.claim.sub', 'a3000000-0000-0000-0000-00000000000a', true);

SELECT is(
  (SELECT count(*)::integer FROM public.user_favorites),
  0,
  'favorites are private to the user who made them'
);

SELECT lives_ok(
  $$ SELECT public.import_global_partner(
       'b1000000-0000-0000-0000-000000000003'::uuid,
       'c3000000-0000-0000-0000-000000000003'::uuid
     ) $$,
  'practice two imports the near-duplicate listing'
);

-- ─── Curator edits the listing: propagation respects overrides ──────────────

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-00000000000a', true);

SELECT lives_ok(
  $$ UPDATE public.global_partners
        SET organization = 'Cascade Recovery Center (Bend Campus)', phone = '(541) 555-0111'
      WHERE id = 'b1000000-0000-0000-0000-000000000001' $$,
  'the curator updates the listing'
);

SELECT is(
  (SELECT organization || '|' || phone FROM public.partners WHERE id = 'c2000000-0000-0000-0000-000000000001'),
  'Cascade Recovery Center (Bend Campus)|(541) 555-0199',
  'the organization change propagates while the overridden phone is preserved'
);

SELECT lives_ok(
  $$ SELECT public.merge_global_partners(
       'b1000000-0000-0000-0000-000000000001'::uuid,
       'b1000000-0000-0000-0000-000000000003'::uuid
     ) $$,
  'the curator merges the duplicate into the primary listing'
);

SELECT is(
  (SELECT global_partner_id FROM public.partners WHERE id = 'c3000000-0000-0000-0000-000000000003'),
  'b1000000-0000-0000-0000-000000000001'::uuid,
  'tenant links are repointed to the surviving listing'
);

SELECT is(
  (SELECT status || '|' || merged_into::text FROM public.global_partners WHERE id = 'b1000000-0000-0000-0000-000000000003'),
  'archived|b1000000-0000-0000-0000-000000000001',
  'the merged listing is archived with a pointer to its survivor'
);

SELECT lives_ok(
  $$ SELECT public.refresh_global_partner_stats() $$,
  'a platform admin can refresh network stats'
);

SELECT is(
  (SELECT importing_orgs FROM public.fetch_global_partner_stats(ARRAY['b1000000-0000-0000-0000-000000000001'::uuid])),
  2,
  'admins see raw usage counts across the network'
);

-- ─── Practice one: k-anonymity + suggestions ────────────────────────────────

SELECT set_config('request.jwt.claim.sub', 'a2000000-0000-0000-0000-00000000000a', true);

SELECT is(
  (SELECT disclosed FROM public.fetch_global_partner_stats(ARRAY['b1000000-0000-0000-0000-000000000001'::uuid])),
  false,
  'below the five-workspace floor, subscribers get no usage numbers'
);

SELECT lives_ok(
  $$ INSERT INTO public.partners (id, name, organization, phone, website)
     VALUES ('c2000000-0000-0000-0000-000000000010', 'Front Desk', 'New Horizons Ranch', '(503) 555-0150', 'https://www.newhorizons.example/'),
            ('c2000000-0000-0000-0000-000000000011', 'Clinical Director', 'New Horizons Ranch', '', 'newhorizons.example/team') $$,
  'practice one adds two private partners for the same program'
);

SELECT lives_ok(
  $$ SELECT public.suggest_global_listing('c2000000-0000-0000-0000-000000000010') $$,
  'practice one suggests a private partner for the directory'
);

SELECT ok(
  (SELECT g.status = 'pending' AND g.suggested_by_org_id IS NOT NULL AND p.global_listing_status = 'pending'
     FROM public.partners p
     JOIN public.global_partners g ON g.id = p.global_partner_id
    WHERE p.id = 'c2000000-0000-0000-0000-000000000010'),
  'the suggestion creates a pending listing attributed to the workspace, visible to the suggester'
);

SELECT is(
  public.suggest_global_listing('c2000000-0000-0000-0000-000000000011'),
  (SELECT global_partner_id FROM public.partners WHERE id = 'c2000000-0000-0000-0000-000000000010'),
  'a second suggestion with the same domain links to the existing listing instead of duplicating'
);

-- ─── Free tier ───────────────────────────────────────────────────────────────

SELECT set_config('request.jwt.claim.sub', 'a4000000-0000-0000-0000-00000000000a', true);

SELECT throws_ok(
  $$ SELECT public.toggle_user_favorite('global_partner', 'b1000000-0000-0000-0000-000000000001') $$,
  'P0002',
  'Directory listing not found',
  'without the entitlement a listing cannot be favorited'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
