-- Focused coverage for 20260928170000_claimed_listings_authoritative.sql.
-- Run after a local migration reset with: supabase test db

BEGIN;
SELECT plan(59);

-- Actors
--   s1  seed owner (platform admin)                 workspace SEED
--   s2  seed staff, non-admin member of SEED
--   c1  center account that will claim the seed's program listing
--   c2  center account that will claim a pending, unverified listing
--   p1  owner of an ordinary practice               workspace PRACTICE
--   p2  non-owner member of PRACTICE
--   p3  owner whose email domain matches a listing  workspace OTHER
--   p4  owner with an unrelated email domain        workspace FOURTH
--   p5  owner who collides with a claimed listing   workspace FIFTH
INSERT INTO auth.users (id, email)
VALUES
  ('a1000000-0000-0000-0000-0000000000c1', 'seed-owner@example.test'),
  ('a2000000-0000-0000-0000-0000000000c1', 'seed-staff@example.test'),
  ('c1000000-0000-0000-0000-0000000000c1', 'center-one@example.test'),
  ('c2000000-0000-0000-0000-0000000000c1', 'center-two@example.test'),
  ('b1000000-0000-0000-0000-0000000000c1', 'owner@riverbend-interventions.example'),
  ('b2000000-0000-0000-0000-0000000000c1', 'staff@riverbend-interventions.example'),
  ('b3000000-0000-0000-0000-0000000000c1', 'dr@cascadefamily.example'),
  ('b4000000-0000-0000-0000-0000000000c1', 'someone@gmail.example'),
  ('b5000000-0000-0000-0000-0000000000c1', 'admissions@copycat.example');

INSERT INTO public.platform_admins (user_id)
VALUES ('a1000000-0000-0000-0000-0000000000c1');

-- Re-home s2 into the seed workspace and p2 into the practice as members.
UPDATE public.org_members
   SET org_id = (SELECT org_id FROM public.org_members WHERE user_id = 'a1000000-0000-0000-0000-0000000000c1'), role = 'member'
 WHERE user_id = 'a2000000-0000-0000-0000-0000000000c1';
UPDATE public.org_members
   SET org_id = (SELECT org_id FROM public.org_members WHERE user_id = 'b1000000-0000-0000-0000-0000000000c1'), role = 'member'
 WHERE user_id = 'b2000000-0000-0000-0000-0000000000c1';

-- Workspace ids as transaction-local settings, so every role can read them
-- without going through org_members RLS.
SELECT set_config('test.org_practice', org_id::text, true) FROM public.org_members WHERE user_id = 'b1000000-0000-0000-0000-0000000000c1';
SELECT set_config('test.org_other', org_id::text, true) FROM public.org_members WHERE user_id = 'b3000000-0000-0000-0000-0000000000c1';
SELECT set_config('test.org_fourth', org_id::text, true) FROM public.org_members WHERE user_id = 'b4000000-0000-0000-0000-0000000000c1';

-- ═══════════════════════════════════════════════════════════════════════════
-- A. Unclaimed seed listing behaves as before
-- ═══════════════════════════════════════════════════════════════════════════

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000c1', true);
SET LOCAL ROLE authenticated;

INSERT INTO public.partners (id, name, organization, types, city, state, phone, website, note)
VALUES ('f1000000-0000-0000-0000-0000000000c1', 'Admissions', 'Riverbend Recovery', ARRAY['Inpatient'], 'Bend', 'OR', '(541) 555-0300', 'https://riverbend.example', 'Seed description');

SELECT set_config('test.l1', global_partner_id::text, true)
  FROM public.partners WHERE id = 'f1000000-0000-0000-0000-0000000000c1';

SELECT ok(
  current_setting('test.l1') <> ''
  AND NOT public.global_listing_is_claimed(current_setting('test.l1')::uuid),
  'the seed program is published and starts unclaimed'
);

UPDATE public.partners SET note = 'Seed edit while unclaimed' WHERE id = 'f1000000-0000-0000-0000-0000000000c1';

SELECT is(
  (SELECT g.description || '|' || array_to_string(p.local_overrides, ',')
     FROM public.partners p JOIN public.global_partners g ON g.id = p.global_partner_id
    WHERE p.id = 'f1000000-0000-0000-0000-0000000000c1'),
  'Seed edit while unclaimed|',
  'while unclaimed, seed edits still push up and are not local overrides'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- B. Claiming verifies; claimed listings stay verified
-- ═══════════════════════════════════════════════════════════════════════════

-- An admin-curated listing that has never been verified.
INSERT INTO public.global_partners (id, name, organization, types, phone, status)
VALUES ('e0000000-0000-0000-0000-0000000000c1', 'Intake', 'Pending Detox', ARRAY['Detox'], '(541) 555-0999', 'pending');

SELECT set_config('test.code_l1', code, true)
  FROM public.create_center_claim_code(current_setting('test.l1')::uuid);
SELECT set_config('test.code_l0', code, true)
  FROM public.create_center_claim_code('e0000000-0000-0000-0000-0000000000c1');

-- Age the seed listing's verification so the claim's coalesce is observable.
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
UPDATE public.global_partners SET verified_at = now() - interval '3 months' WHERE id = current_setting('test.l1')::uuid;
SELECT set_config('test.l1_verified_before', verified_at::text, true)
  FROM public.global_partners WHERE id = current_setting('test.l1')::uuid;
SET LOCAL ROLE authenticated;

SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000c1', true);
SELECT is(
  (SELECT public.claim_center_listing(current_setting('test.code_l1'))),
  current_setting('test.l1')::uuid,
  'a center claims the seed program with its code'
);

SELECT is(
  (SELECT verified_at::text FROM public.global_partners WHERE id = current_setting('test.l1')::uuid),
  current_setting('test.l1_verified_before'),
  'claiming an already-verified listing keeps its original verification stamp'
);

SELECT set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-0000000000c1', true);
SELECT lives_ok(
  $$ SELECT public.claim_center_listing(current_setting('test.code_l0')) $$,
  'a second center claims the never-verified pending listing'
);

SELECT is(
  (SELECT status || ':' || (verified_at IS NOT NULL)::text FROM public.global_partners WHERE id = 'e0000000-0000-0000-0000-0000000000c1'),
  'pending:true',
  'claiming verifies a listing that was not verified yet; status stays admin-controlled'
);

SELECT ok(
  public.global_listing_is_claimed(current_setting('test.l1')::uuid)
  AND public.global_listing_is_claimed('e0000000-0000-0000-0000-0000000000c1'),
  'both listings now count as claimed'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- C. Center edits keep verification and propagate down, including to the seed
-- ═══════════════════════════════════════════════════════════════════════════

SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000c1', true);

SELECT lives_ok(
  $$ UPDATE public.global_partners SET description = 'Center-owned description', city = 'Redmond'
      WHERE id = current_setting('test.l1')::uuid $$,
  'the center edits its claimed listing'
);

SELECT ok(
  (SELECT verified_at IS NOT NULL AND verified_at >= now() - interval '1 minute' AND status = 'active'
     FROM public.global_partners WHERE id = current_setting('test.l1')::uuid),
  'a claimant edit re-attests verification and leaves the lifecycle alone'
);

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000c1', true);
SELECT is(
  (SELECT note || '|' || city || '|' || array_to_string(local_overrides, ',')
     FROM public.partners WHERE id = 'f1000000-0000-0000-0000-0000000000c1'),
  'Center-owned description|Redmond|',
  'the center edit propagates down to the seed copy without creating overrides'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- D. Seed edits on a claimed listing are local overrides, not pushes
-- ═══════════════════════════════════════════════════════════════════════════

SELECT set_config('request.jwt.claim.sub', 'a2000000-0000-0000-0000-0000000000c1', true);

UPDATE public.partners SET note = 'Seed staff private note', types = ARRAY['Therapist']
 WHERE id = 'f1000000-0000-0000-0000-0000000000c1';

SELECT is(
  (SELECT description || '|' || array_to_string(types, ',') FROM public.global_partners WHERE id = current_setting('test.l1')::uuid),
  'Center-owned description|Inpatient',
  'seed edits no longer push into the claimed listing'
);

SELECT is(
  (SELECT array_to_string(local_overrides, ',') || '|' || (global_partner_id IS NOT NULL)::text
     FROM public.partners WHERE id = 'f1000000-0000-0000-0000-0000000000c1'),
  'types,note|true',
  'the seed copy records the edits as local overrides and stays linked despite the type change'
);

SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000c1', true);
UPDATE public.global_partners SET description = 'Center description v2', phone = '(541) 555-0301'
 WHERE id = current_setting('test.l1')::uuid;

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000c1', true);
SELECT is(
  (SELECT note || '|' || phone FROM public.partners WHERE id = 'f1000000-0000-0000-0000-0000000000c1'),
  'Seed staff private note|(541) 555-0301',
  'later claimant edits skip the overridden field and update the rest of the seed copy'
);

-- A seed program deleted while its listing is claimed does not archive it.
SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000c1', true);
DELETE FROM public.partners WHERE id = 'f1000000-0000-0000-0000-0000000000c1';
SELECT is(
  (SELECT status FROM public.global_partners WHERE id = current_setting('test.l1')::uuid),
  'active',
  'deleting the seed copy never archives a claimed listing'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- E. Self-serve workspace profile
-- ═══════════════════════════════════════════════════════════════════════════

SELECT set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-0000000000c1', true);
SELECT throws_ok(
  $$ SELECT public.upsert_org_directory_profile('{"name":"Staff","organization":"Riverbend Interventions","types":["Interventionist"]}'::jsonb) $$,
  '42501',
  'Only the workspace owner can manage the directory profile',
  'a non-owner member cannot publish the workspace profile'
);

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000c1', true);

SELECT throws_ok(
  $$ SELECT public.upsert_org_directory_profile('{"name":"Sam","organization":"Riverbend Interventions","types":["Interventionist"],"status":"active"}'::jsonb) $$,
  '22023',
  'Field "status" is not part of a directory profile',
  'fields outside the public allowlist are rejected'
);

SELECT throws_ok(
  $$ SELECT public.upsert_org_directory_profile('{"name":"Sam","organization":"Riverbend Interventions","types":["Wizard"]}'::jsonb) $$,
  '22023',
  'Unknown listing type',
  'unknown listing types are rejected'
);

SELECT throws_ok(
  $$ SELECT public.upsert_org_directory_profile('{"name":"Sam","organization":"Riverbend Interventions","types":[]}'::jsonb) $$,
  '22023',
  'Choose at least one listing type',
  'a profile needs at least one type'
);

SELECT set_config('test.profile_result', public.upsert_org_directory_profile(
  '{"name":"Sam Rivers","organization":"Riverbend Interventions","types":["Interventionist","Therapist"],
    "city":"Bend","state":"or","regions":["Central Oregon"],"phone":"(541) 555-0400","email":"sam@riverbend-interventions.example",
    "website":"https://www.riverbend-interventions.example/about","monthly_cost":"0",
    "insurance":["Aetna"],"insurance_networks":{"Aetna":["Out-of-network"]},
    "therapies":["Family systems"],"populations":["Adults"],"levels":["Intervention"],
    "description":"Family-first interventions across Central Oregon."}'::jsonb)::text, true);

SELECT is(
  current_setting('test.profile_result')::jsonb ->> 'status',
  'created',
  'the workspace owner creates a fresh profile'
);

CREATE TEMP VIEW lp AS
  SELECT (current_setting('test.profile_result')::jsonb ->> 'listing_id')::uuid AS id;
GRANT SELECT ON lp TO authenticated;

SELECT ok(
  (SELECT status = 'active' AND verified_at IS NOT NULL
      AND owner_org_id = current_setting('test.org_practice')::uuid
      AND created_by = 'b1000000-0000-0000-0000-0000000000c1'
      AND state = 'OR'
      AND website_domain = 'riverbend-interventions.example'
      AND types = ARRAY['Interventionist', 'Therapist']
      AND insurance_networks = '{"Aetna": ["Out-of-network"]}'::jsonb
     FROM public.global_partners WHERE id = (SELECT id FROM lp)),
  'the profile is live, verified, owned by the workspace, and normalized'
);

SELECT ok(
  public.global_listing_is_claimed((SELECT id FROM lp))
  AND public.global_listing_claimed_by_caller((SELECT id FROM lp)),
  'an org profile counts as claimed, by its owner'
);

SELECT is(
  (SELECT count(*)::integer FROM public.partners WHERE org_id = current_setting('test.org_practice')::uuid),
  0,
  'building a profile does not add the workspace to its own partner network'
);

SELECT is(
  (SELECT claimed::text || '|' || array_to_string(types, ',')
     FROM public.search_global_partners('riverbend interventions') WHERE id = (SELECT id FROM lp)),
  'true|Interventionist,Therapist',
  'search returns the professional profile flagged as claimed'
);

SELECT is(
  (SELECT count(*)::integer FROM public.search_global_partners(NULL, NULL, NULL, NULL, NULL, 50, 0, ARRAY['Interventionist'])),
  1,
  'the type filter finds interventionists'
);

SELECT is(
  (SELECT count(*)::integer FROM public.search_global_partners(NULL, NULL, NULL, NULL, NULL, 50, 0, ARRAY['Detox'])
    WHERE id = (SELECT id FROM lp)),
  0,
  'the type filter excludes the profile when it does not match'
);

SELECT set_config('test.profile_result', public.upsert_org_directory_profile(
  '{"name":"Sam Rivers","organization":"Riverbend Interventions","types":["Interventionist"],
    "city":"Bend","state":"OR","phone":"(541) 555-0400","website":"https://riverbend-interventions.example",
    "description":"Updated description."}'::jsonb)::text, true);

SELECT is(
  (current_setting('test.profile_result')::jsonb ->> 'status') || '|' || (current_setting('test.profile_result')::jsonb ->> 'listing_id'),
  'updated|' || (SELECT id::text FROM lp),
  'saving again updates the same listing'
);

SELECT ok(
  (SELECT description = 'Updated description.'
      AND types = ARRAY['Interventionist']
      AND verified_at IS NOT NULL
     FROM public.global_partners WHERE id = (SELECT id FROM lp)),
  'the update applies and the profile stays verified'
);

SELECT is(
  (SELECT count(*)::integer FROM public.global_partners WHERE owner_org_id = current_setting('test.org_practice')::uuid),
  1,
  'a workspace has exactly one profile'
);

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT throws_ok(
  $$ INSERT INTO public.global_partners (name, organization, owner_org_id)
     VALUES ('Dup', 'Second Profile', current_setting('test.org_practice')::uuid) $$,
  '23505',
  NULL,
  'the database refuses a second profile for the same workspace'
);

-- Owners read their profile regardless of status; strangers do not.
UPDATE public.global_partners SET status = 'archived' WHERE id = (SELECT id FROM lp);

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000c1', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT count(*)::integer FROM public.global_partners WHERE id = (SELECT id FROM lp)),
  1,
  'the owning workspace still reads its archived profile'
);

SELECT set_config('request.jwt.claim.sub', 'b3000000-0000-0000-0000-0000000000c1', true);
SELECT is(
  (SELECT count(*)::integer FROM public.global_partners WHERE id = (SELECT id FROM lp)),
  0,
  'another workspace cannot read the archived profile'
);

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
UPDATE public.global_partners SET status = 'active' WHERE id = (SELECT id FROM lp);

SELECT ok(
  NOT public.retire_orphaned_global_listing((SELECT id FROM lp))
  AND (SELECT status FROM public.global_partners WHERE id = (SELECT id FROM lp)) = 'active',
  'an owned profile is never retired as an orphan'
);

SELECT is(
  public.cleanup_unlinked_global_partners(),
  0,
  'placeholder cleanup skips claimed and owned listings'
);

SELECT is(
  (SELECT count(*)::integer FROM public.global_partners WHERE id = (SELECT id FROM lp)),
  1,
  'the owned profile survives the cleanup'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- F. Duplicate on first create: automatic takeover on email-domain match
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO public.global_partners (id, name, organization, types, phone, website, status)
VALUES ('e2000000-0000-0000-0000-0000000000c1', 'Front desk', 'Cascade Family Therapy', ARRAY['Therapist'], '(541) 555-0500', 'https://www.cascadefamily.example', 'pending');

SELECT set_config('request.jwt.claim.sub', 'b3000000-0000-0000-0000-0000000000c1', true);
SET LOCAL ROLE authenticated;

SELECT set_config('test.profile_result', public.upsert_org_directory_profile(
  '{"name":"Dr. Casey Cascade","organization":"Cascade Family Therapy","types":["Therapist"],
    "phone":"541-555-0500","website":"https://cascadefamily.example"}'::jsonb)::text, true);

SELECT is(
  (current_setting('test.profile_result')::jsonb ->> 'status') || '|' || (current_setting('test.profile_result')::jsonb ->> 'listing_id'),
  'claimed|e2000000-0000-0000-0000-0000000000c1',
  'a matching unclaimed listing is taken over when the email domain matches its website'
);

SELECT ok(
  (SELECT owner_org_id = current_setting('test.org_other')::uuid
      AND status = 'active' AND verified_at IS NOT NULL
      AND name = 'Dr. Casey Cascade'
     FROM public.global_partners WHERE id = 'e2000000-0000-0000-0000-0000000000c1'),
  'the taken-over listing is owned, live, verified, and carries the new content'
);

SELECT is(
  (SELECT count(*)::integer FROM public.global_partners WHERE phone_digits = '5415550500'),
  1,
  'no duplicate listing was created by the takeover'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- G. Duplicate without proof: claim request, nothing overwritten
-- ═══════════════════════════════════════════════════════════════════════════

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
INSERT INTO public.global_partners (id, name, organization, types, phone, website, status, verified_at)
VALUES ('e3000000-0000-0000-0000-0000000000c1', 'Admissions', 'Summit Detox', ARRAY['Detox'], '(541) 555-0600', 'https://summitdetox.example', 'active', now() - interval '2 months');

SELECT set_config('request.jwt.claim.sub', 'b4000000-0000-0000-0000-0000000000c1', true);
SET LOCAL ROLE authenticated;

SELECT set_config('test.profile_result', public.upsert_org_directory_profile(
  '{"name":"Jordan","organization":"Summit Detox (hijack attempt)","types":["Detox"],"phone":"(541) 555-0600"}'::jsonb)::text, true);

SELECT is(
  (current_setting('test.profile_result')::jsonb ->> 'status') || '|' || (current_setting('test.profile_result')::jsonb ->> 'listing_id'),
  'claim_requested|e3000000-0000-0000-0000-0000000000c1',
  'an unproven match becomes a claim request'
);

SELECT ok(
  (SELECT owner_org_id IS NULL AND organization = 'Summit Detox' AND name = 'Admissions'
     FROM public.global_partners WHERE id = 'e3000000-0000-0000-0000-0000000000c1'),
  'the existing listing is untouched by the claim request'
);

SELECT is(
  (SELECT count(*)::integer FROM public.global_partners WHERE owner_org_id = current_setting('test.org_fourth')::uuid),
  0,
  'no profile was created for the requesting workspace'
);

SELECT set_config('test.request_id', current_setting('test.profile_result')::jsonb ->> 'request_id', true);

SELECT is(
  (SELECT status || '|' || org_id::text || '|' || requested_by::text
     FROM public.center_claim_requests WHERE id = current_setting('test.request_id')::uuid),
  'pending|' || current_setting('test.org_fourth') || '|b4000000-0000-0000-0000-0000000000c1',
  'the request is recorded as pending for the workspace and is visible to it'
);

SELECT is(
  (public.upsert_org_directory_profile(
    '{"name":"Jordan","organization":"Summit Detox (hijack attempt)","types":["Detox"],"phone":"(541) 555-0600"}'::jsonb) ->> 'request_id'),
  current_setting('test.request_id'),
  'resubmitting returns the same open request instead of a second one'
);

SELECT throws_ok(
  $$ SELECT public.approve_center_claim_request(current_setting('test.request_id')::uuid) $$,
  '42501',
  'Platform admin required',
  'a workspace cannot approve its own claim request'
);

-- Colliding with a listing that is already claimed by a center: same path.
SELECT set_config('request.jwt.claim.sub', 'b5000000-0000-0000-0000-0000000000c1', true);

SELECT set_config('test.profile_result', public.upsert_org_directory_profile(
  '{"name":"Copycat","organization":"Riverbend Recovery","types":["Inpatient"],"phone":"(541) 555-0301"}'::jsonb)::text, true);

SELECT is(
  (current_setting('test.profile_result')::jsonb ->> 'status') || '|' || (current_setting('test.profile_result')::jsonb ->> 'listing_id'),
  'claim_requested|' || current_setting('test.l1'),
  'colliding with a claimed listing never overwrites it; a claim request is filed'
);

SELECT is(
  (SELECT name || '|' || (owner_org_id IS NULL)::text FROM public.global_partners WHERE id = current_setting('test.l1')::uuid),
  'Admissions|true',
  'the center-claimed listing is untouched'
);

SELECT set_config('test.request_id_5', current_setting('test.profile_result')::jsonb ->> 'request_id', true);

SELECT is(
  (SELECT count(*)::integer FROM public.center_claim_requests),
  1,
  'a workspace sees only its own claim requests'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- H. Admin approves / rejects
-- ═══════════════════════════════════════════════════════════════════════════

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000c1', true);

SELECT is(
  (SELECT count(*)::integer FROM public.center_claim_requests WHERE status = 'pending'),
  2,
  'the platform admin sees every pending request'
);

SELECT is(
  public.approve_center_claim_request(current_setting('test.request_id')::uuid),
  'e3000000-0000-0000-0000-0000000000c1'::uuid,
  'the admin approves the Summit Detox request'
);

SELECT ok(
  (SELECT owner_org_id = current_setting('test.org_fourth')::uuid AND status = 'active' AND verified_at >= now() - interval '1 minute'
      AND organization = 'Summit Detox'
     FROM public.global_partners WHERE id = 'e3000000-0000-0000-0000-0000000000c1'),
  'approval hands the listing to the workspace, verified, without applying the submitted payload'
);

SELECT is(
  (SELECT status || '|' || (resolved_at IS NOT NULL)::text || '|' || resolved_by::text
     FROM public.center_claim_requests WHERE id = current_setting('test.request_id')::uuid),
  'approved|true|a1000000-0000-0000-0000-0000000000c1',
  'the request records who approved it and when'
);

SELECT throws_ok(
  $$ SELECT public.approve_center_claim_request(current_setting('test.request_id')::uuid) $$,
  '22023',
  'Claim request was already approved',
  'a resolved request cannot be approved twice'
);

SELECT lives_ok(
  $$ SELECT public.reject_center_claim_request(current_setting('test.request_id_5')::uuid) $$,
  'the admin rejects the copycat request'
);

SELECT is(
  (SELECT status FROM public.center_claim_requests WHERE id = current_setting('test.request_id_5')::uuid),
  'rejected',
  'the rejected request is marked rejected'
);

-- The newly approved owner now edits through the profile RPC.
SELECT set_config('request.jwt.claim.sub', 'b4000000-0000-0000-0000-0000000000c1', true);

SELECT is(
  (public.upsert_org_directory_profile(
    '{"name":"Jordan Peak","organization":"Summit Detox","types":["Detox"],"phone":"(541) 555-0600","website":"https://summitdetox.example","description":"Medically supervised detox."}'::jsonb) ->> 'status'),
  'updated',
  'after approval the workspace edits the listing as its own profile'
);

SELECT ok(
  (SELECT name = 'Jordan Peak' AND description = 'Medically supervised detox.' AND verified_at IS NOT NULL
     FROM public.global_partners WHERE id = 'e3000000-0000-0000-0000-0000000000c1'),
  'the owner edit lands and the listing stays verified'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- I. Owner edits flow down to workspaces that imported the profile
-- ═══════════════════════════════════════════════════════════════════════════

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000c1', true);

SELECT lives_ok(
  $$ SELECT public.import_global_partner('e3000000-0000-0000-0000-0000000000c1', 'f2000000-0000-0000-0000-0000000000c1') $$,
  'the seed workspace imports the owned Summit Detox listing'
);

SELECT set_config('request.jwt.claim.sub', 'b4000000-0000-0000-0000-0000000000c1', true);
SELECT lives_ok(
  $$ SELECT public.upsert_org_directory_profile(
       '{"name":"Jordan Peak","organization":"Summit Detox","types":["Detox"],"phone":"(541) 555-0601","website":"https://summitdetox.example","description":"Medically supervised detox."}'::jsonb) $$,
  'the owner changes the profile phone number'
);

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000c1', true);
SELECT is(
  (SELECT phone || '|' || array_to_string(local_overrides, ',') FROM public.partners WHERE id = 'f2000000-0000-0000-0000-0000000000c1'),
  '(541) 555-0601|',
  'the owner edit propagates to the importing workspace copy'
);

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000c1', true);
UPDATE public.partners SET note = 'Seed note about Summit' WHERE id = 'f2000000-0000-0000-0000-0000000000c1';

SELECT is(
  (SELECT description FROM public.global_partners WHERE id = 'e3000000-0000-0000-0000-0000000000c1'),
  'Medically supervised detox.',
  'a seed edit on the imported owned listing stays local and does not push up'
);

SELECT * FROM finish();
ROLLBACK;
