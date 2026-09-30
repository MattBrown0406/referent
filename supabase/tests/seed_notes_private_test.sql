-- Focused coverage for 20260930190000_seed_notes_private.sql.
-- Run after a local migration reset with: supabase test db
--
-- This file is never pasted into production, so it may use backslash
-- escapes: section A compares the new helpers against the ORIGINAL
-- expressions from 20260928170000 (which had them).

BEGIN;
SELECT plan(20);

-- Actors
--   s1  seed owner (platform admin)               workspace SEED
--   s2  seed staff, non-admin member of SEED
--   p1  owner of an ordinary practice             workspace P1
--   p2  owner of a second practice                workspace P2
--   c1  center account that claims one listing
INSERT INTO auth.users (id, email)
VALUES
  ('a1000000-0000-0000-0000-0000000000f1', 'seed-owner@example.test'),
  ('a2000000-0000-0000-0000-0000000000f1', 'seed-staff@example.test'),
  ('b1000000-0000-0000-0000-0000000000f1', 'p1@example.test'),
  ('b2000000-0000-0000-0000-0000000000f1', 'p2@example.test'),
  ('c1000000-0000-0000-0000-0000000000f1', 'center@example.test');

INSERT INTO public.platform_admins (user_id)
VALUES ('a1000000-0000-0000-0000-0000000000f1');

UPDATE public.org_members
   SET org_id = (SELECT org_id FROM public.org_members WHERE user_id = 'a1000000-0000-0000-0000-0000000000f1'), role = 'member'
 WHERE user_id = 'a2000000-0000-0000-0000-0000000000f1';

SELECT set_config('test.org_seed', org_id::text, true) FROM public.org_members WHERE user_id = 'a1000000-0000-0000-0000-0000000000f1';
SELECT set_config('test.org_p1', org_id::text, true) FROM public.org_members WHERE user_id = 'b1000000-0000-0000-0000-0000000000f1';
SELECT set_config('test.org_p2', org_id::text, true) FROM public.org_members WHERE user_id = 'b2000000-0000-0000-0000-0000000000f1';

-- ═══════════════════════════════════════════════════════════════════════════
-- A. Backslash-free helpers are equivalent to the original expressions
-- ═══════════════════════════════════════════════════════════════════════════

SELECT is(
  (SELECT count(*)::integer
     FROM (VALUES ('(541) 555-0100'), ('541.555.0100 ext 4'), (''), (NULL), ('+1 541-555-0100'), ('abc'), (' 5 4 1 ')) AS t(v)
    WHERE public.directory_phone_digits(v) IS DISTINCT FROM regexp_replace(coalesce(v, ''), '\D', '', 'g')),
  0,
  'directory_phone_digits gives the same answer as the original backslash-D expression'
);

SELECT is(
  (SELECT count(*)::integer
     FROM (VALUES ('https://www.seedranch.example/admissions'), ('HTTP://Example.ORG'), ('  https://example.org?x=1'),
                  ('www.example.org/path'), ('example.org#frag'), (''), (NULL), ('/just/a/path'), ('?query'), ('www.'),
                  ('https://'), ('  http://www.a.b.c:8080/x'), ('wwwexample.org'), (E'\thttps://tab.example')) AS t(v)
    WHERE public.directory_website_domain(v) IS DISTINCT FROM
          lower(regexp_replace(regexp_replace(coalesce(v, ''), '^\s*https?://', ''), '^(www\.)?([^/?#]+).*$', '\2'))),
  0,
  'directory_website_domain gives the same answer as the original backslash expression'
);

SELECT ok(
  public.seed_partner_pushed_fields() = array_remove(public.global_partner_synced_fields(), 'note')
  AND NOT ('note' = ANY (public.seed_partner_pushed_fields()))
  AND 'note' = ANY (public.global_partner_synced_fields())
  AND 'phone' = ANY (public.seed_partner_pushed_fields()),
  'the seed push list is the synced list without note; the synced list itself still carries note'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- B. Publishing a seed program never publishes its note
-- ═══════════════════════════════════════════════════════════════════════════

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000f1', true);
SET LOCAL ROLE authenticated;

INSERT INTO public.partners (id, name, organization, types, city, state, phone, website, note)
VALUES ('f1000000-0000-0000-0000-0000000000f1', 'Admissions', 'Cedar Haven', ARRAY['Inpatient'], 'Bend', 'OR',
        '(541) 555-0700', 'https://www.cedarhaven.example/admissions', 'Private: admissions director is slow to call back');

SELECT set_config('test.l1', global_partner_id::text, true)
  FROM public.partners WHERE id = 'f1000000-0000-0000-0000-0000000000f1';

SELECT ok(
  (SELECT g.status = 'active' AND g.verified_at IS NOT NULL
          AND g.description = ''
          AND g.website_domain = 'cedarhaven.example' AND g.phone_digits = '5415550700'
          AND g.organization = 'Cedar Haven'
          AND p.local_overrides = ARRAY['note']
          AND p.note = 'Private: admissions director is slow to call back'
     FROM public.partners p JOIN public.global_partners g ON g.id = p.global_partner_id
    WHERE p.id = 'f1000000-0000-0000-0000-0000000000f1'),
  'the program is published active and verified with an EMPTY description; the note stays on the partner as a protected override'
);

INSERT INTO public.partners (id, name, organization, types, phone, note)
VALUES ('f2000000-0000-0000-0000-0000000000f1', 'Dr. Solo', 'Solo Counseling', ARRAY['Therapist', 'Interventionist'], '(541) 555-0710', 'private');

SELECT ok(
  (SELECT global_partner_id IS NULL FROM public.partners WHERE id = 'f2000000-0000-0000-0000-0000000000f1')
  AND NOT EXISTS (SELECT 1 FROM public.global_partners WHERE phone_digits = '5415550710'),
  'a therapist / interventionist partner in the seed workspace is still not auto-published'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- C. Note edits change nothing on the listing; other seed edits still push
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE public.partners SET note = 'Private v2' WHERE id = 'f1000000-0000-0000-0000-0000000000f1';

SELECT ok(
  (SELECT g.description = '' AND g.verified_at IS NOT NULL AND g.status = 'active'
          AND p.note = 'Private v2' AND p.local_overrides = ARRAY['note']
     FROM public.partners p JOIN public.global_partners g ON g.id = p.global_partner_id
    WHERE p.id = 'f1000000-0000-0000-0000-0000000000f1'),
  'editing the seed note changes nothing on the listing'
);

UPDATE public.partners SET phone = '(541) 555-0701', city = 'Redmond' WHERE id = 'f1000000-0000-0000-0000-0000000000f1';

SELECT ok(
  (SELECT g.phone_digits = '5415550701' AND g.city = 'Redmond' AND g.description = '' AND g.verified_at IS NOT NULL
          AND p.note = 'Private v2' AND p.local_overrides = ARRAY['note']
     FROM public.partners p JOIN public.global_partners g ON g.id = p.global_partner_id
    WHERE p.id = 'f1000000-0000-0000-0000-0000000000f1'),
  'editing the seed phone and city still pushes to the listing and keeps it verified'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- D. A listing description still propagates to imported copies elsewhere
-- ═══════════════════════════════════════════════════════════════════════════

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000f1', true);
SELECT public.import_global_partner(current_setting('test.l1')::uuid, 'f3000000-0000-0000-0000-0000000000f1');

-- The platform admin writes a public description on the listing.
SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000f1', true);
UPDATE public.global_partners SET description = 'Public blurb' WHERE id = current_setting('test.l1')::uuid;

-- Rows in two workspaces: read them as the superuser (RLS would hide one).
RESET ROLE;
SELECT ok(
  (SELECT note = 'Public blurb' AND local_overrides = '{}'::text[]
     FROM public.partners WHERE id = 'f3000000-0000-0000-0000-0000000000f1')
  AND (SELECT note = 'Private v2' FROM public.partners WHERE id = 'f1000000-0000-0000-0000-0000000000f1'),
  'a description edit propagates to the imported copy in another workspace and skips the seed partner''s protected note'
);
SET LOCAL ROLE authenticated;

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000f1', true);
UPDATE public.partners SET note = 'P1 candid note' WHERE id = 'f3000000-0000-0000-0000-0000000000f1';

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000f1', true);
UPDATE public.global_partners SET description = 'Public blurb v2' WHERE id = current_setting('test.l1')::uuid;

RESET ROLE;
SELECT ok(
  (SELECT note = 'P1 candid note' AND local_overrides = ARRAY['note']
     FROM public.partners WHERE id = 'f3000000-0000-0000-0000-0000000000f1')
  AND (SELECT note = 'Private v2' FROM public.partners WHERE id = 'f1000000-0000-0000-0000-0000000000f1'),
  'once a workspace edits its imported note, later description edits leave it alone (existing behaviour)'
);
SET LOCAL ROLE authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- E. Linking to an existing listing leaves that listing's description alone
-- ═══════════════════════════════════════════════════════════════════════════

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
INSERT INTO public.global_partners (id, name, organization, types, city, state, phone, description, status, verified_at)
VALUES ('e1000000-0000-0000-0000-0000000000f1', 'Intake', 'Curated Center', ARRAY['Detox'], 'Salem', 'OR', '(541) 555-0800', 'Curated public blurb', 'active', now());

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000f1', true);
SET LOCAL ROLE authenticated;

INSERT INTO public.partners (id, name, organization, types, phone, note)
VALUES ('f4000000-0000-0000-0000-0000000000f1', 'Intake', 'Curated Ctr', ARRAY['Detox'], '541-555-0800', 'Private about the curated center');

SELECT ok(
  (SELECT p.global_partner_id = 'e1000000-0000-0000-0000-0000000000f1'
          AND g.description = 'Curated public blurb'
          AND g.organization = 'Curated Ctr'
          AND p.local_overrides = ARRAY['note']
          AND p.note = 'Private about the curated center'
     FROM public.partners p JOIN public.global_partners g ON g.id = p.global_partner_id
    WHERE p.id = 'f4000000-0000-0000-0000-0000000000f1')
  AND (SELECT count(*)::integer FROM public.global_partners WHERE phone_digits = '5415550800') = 1,
  'a seed program matching an existing listing links to it, pushes its other fields, and leaves the description untouched'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- F. Cleanup of what an earlier build already published
-- ═══════════════════════════════════════════════════════════════════════════
-- Legacy state, written directly (triggers muted) the way the old publish
-- path left it: description = note, no override on the seed partner.
--   la  unclaimed, description auto-copied         -> cleared
--   lb  claimed by a center, description copied    -> kept
--   lc  unclaimed, description hand-written        -> kept
--   ld  owned by workspace P1, description copied  -> kept
-- Workspace P1 imported la and never touched the note; P2 imported la and
-- edited its note.

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('referralfit.syncing', 'on', true);
SELECT set_config('referralfit.seed_publish', 'on', true);

INSERT INTO public.global_partners (id, name, organization, types, phone, description, status, verified_at, owner_org_id)
VALUES ('ea000000-0000-0000-0000-0000000000f1', 'Admissions', 'Legacy A', ARRAY['Inpatient'], '(541) 555-0901', 'Legacy note A', 'active', now() - interval '2 months', NULL),
       ('eb000000-0000-0000-0000-0000000000f1', 'Admissions', 'Legacy B', ARRAY['Inpatient'], '(541) 555-0902', 'Legacy note B', 'active', now(), NULL),
       ('ec000000-0000-0000-0000-0000000000f1', 'Admissions', 'Legacy C', ARRAY['Inpatient'], '(541) 555-0903', 'Hand-written blurb', 'active', now(), NULL),
       ('ed000000-0000-0000-0000-0000000000f1', 'Admissions', 'Legacy D', ARRAY['Detox'], '(541) 555-0904', 'Legacy note D', 'active', now(), current_setting('test.org_p1')::uuid);

INSERT INTO public.center_members (user_id, global_partner_id)
VALUES ('c1000000-0000-0000-0000-0000000000f1', 'eb000000-0000-0000-0000-0000000000f1');

INSERT INTO public.partners (id, owner_id, org_id, name, organization, types, phone, note, global_partner_id, local_overrides)
VALUES ('f5000000-0000-0000-0000-0000000000f1', 'a1000000-0000-0000-0000-0000000000f1', current_setting('test.org_seed')::uuid, 'Admissions', 'Legacy A', ARRAY['Inpatient'], '(541) 555-0901', 'Legacy note A', 'ea000000-0000-0000-0000-0000000000f1', '{}'),
       ('f6000000-0000-0000-0000-0000000000f1', 'b1000000-0000-0000-0000-0000000000f1', current_setting('test.org_p1')::uuid,   'Admissions', 'Legacy A', ARRAY['Inpatient'], '(541) 555-0901', 'Legacy note A', 'ea000000-0000-0000-0000-0000000000f1', '{}'),
       ('f7000000-0000-0000-0000-0000000000f1', 'b2000000-0000-0000-0000-0000000000f1', current_setting('test.org_p2')::uuid,   'Admissions', 'Legacy A', ARRAY['Inpatient'], '(541) 555-0901', 'P2 edited note', 'ea000000-0000-0000-0000-0000000000f1', ARRAY['note']),
       ('f8000000-0000-0000-0000-0000000000f1', 'a1000000-0000-0000-0000-0000000000f1', current_setting('test.org_seed')::uuid, 'Admissions', 'Legacy B', ARRAY['Inpatient'], '(541) 555-0902', 'Legacy note B', 'eb000000-0000-0000-0000-0000000000f1', '{}'),
       ('f9000000-0000-0000-0000-0000000000f1', 'a1000000-0000-0000-0000-0000000000f1', current_setting('test.org_seed')::uuid, 'Admissions', 'Legacy C', ARRAY['Inpatient'], '(541) 555-0903', 'Legacy note C', 'ec000000-0000-0000-0000-0000000000f1', '{}'),
       ('fa000000-0000-0000-0000-0000000000f1', 'a1000000-0000-0000-0000-0000000000f1', current_setting('test.org_seed')::uuid, 'Admissions', 'Legacy D', ARRAY['Detox'],     '(541) 555-0904', 'Legacy note D', 'ed000000-0000-0000-0000-0000000000f1', '{}');

SELECT set_config('referralfit.seed_publish', '', true);
SELECT set_config('referralfit.syncing', '', true);

SELECT set_config('test.la_verified_before', verified_at::text, true)
  FROM public.global_partners WHERE id = 'ea000000-0000-0000-0000-0000000000f1';

-- Preview query from docs/DIRECTORY_SEED_ROLLOUT.md: exactly the rows the
-- cleanup will clear.
SELECT is(
  (SELECT array_agg(g.organization ORDER BY g.organization)
     FROM public.global_partners g
     JOIN public.partners p ON p.global_partner_id = g.id
    WHERE public.org_is_platform_seed(p.org_id)
      AND g.description <> ''
      AND g.description = left(p.note, 4000)
      AND NOT public.global_listing_is_claimed(g.id)),
  ARRAY['Legacy A'],
  'the preview query lists only the unclaimed, auto-copied listing'
);

SELECT set_config('request.jwt.claim.sub', 'a2000000-0000-0000-0000-0000000000f1', true);
SELECT throws_ok(
  $$ SELECT public.seed_notes_private_cleanup() $$,
  '42501',
  'Platform admin required',
  'a non-admin cannot run the cleanup'
);

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000f1', true);
SELECT is(public.seed_notes_private_cleanup(), 1, 'the cleanup clears exactly one listing');

SELECT ok(
  (SELECT description = '' AND verified_at::text = current_setting('test.la_verified_before') AND status = 'active'
     FROM public.global_partners WHERE id = 'ea000000-0000-0000-0000-0000000000f1'),
  'the auto-copied description is cleared and the listing keeps its verification stamp'
);

SELECT is(
  (SELECT array_agg(description ORDER BY id) FROM public.global_partners
    WHERE id IN ('eb000000-0000-0000-0000-0000000000f1', 'ec000000-0000-0000-0000-0000000000f1', 'ed000000-0000-0000-0000-0000000000f1')),
  ARRAY['Legacy note B', 'Hand-written blurb', 'Legacy note D'],
  'a center-claimed listing, a hand-written description, and a workspace-owned listing are left alone'
);

SELECT ok(
  (SELECT bool_and(note <> '' AND 'note' = ANY (local_overrides))
     FROM public.partners
    WHERE id IN ('f5000000-0000-0000-0000-0000000000f1', 'f8000000-0000-0000-0000-0000000000f1',
                 'f9000000-0000-0000-0000-0000000000f1', 'fa000000-0000-0000-0000-0000000000f1'))
  AND (SELECT note = 'Legacy note A' FROM public.partners WHERE id = 'f5000000-0000-0000-0000-0000000000f1'),
  'every linked seed partner keeps its note and now carries the note override (backfill)'
);

SELECT is(
  (SELECT array_agg(note ORDER BY id) FROM public.partners
    WHERE id IN ('f6000000-0000-0000-0000-0000000000f1', 'f7000000-0000-0000-0000-0000000000f1')),
  ARRAY['', 'P2 edited note'],
  'the cleared description reaches an untouched imported copy and skips one whose note was edited'
);

SELECT ok(
  public.seed_notes_private_cleanup() = 0 AND public.seed_notes_private_protect() = 0,
  'a second run clears and protects nothing'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- G. The backfill publisher goes through the same path
-- ═══════════════════════════════════════════════════════════════════════════

SELECT set_config('referralfit.syncing', 'on', true);
INSERT INTO public.partners (id, owner_id, org_id, name, organization, types, phone, note)
VALUES ('fb000000-0000-0000-0000-0000000000f1', 'a1000000-0000-0000-0000-0000000000f1', current_setting('test.org_seed')::uuid, 'Admissions', 'Backfilled Lodge', ARRAY['Sober Living'], '(541) 555-0950', 'Private about the lodge');
SELECT set_config('referralfit.syncing', '', true);

SELECT is(public.publish_seed_org_partners(), 1, 'the backfill publishes the unlinked seed partner');

SELECT ok(
  (SELECT g.description = '' AND g.status = 'active' AND p.local_overrides = ARRAY['note'] AND p.note = 'Private about the lodge'
     FROM public.partners p JOIN public.global_partners g ON g.id = p.global_partner_id
    WHERE p.id = 'fb000000-0000-0000-0000-0000000000f1'),
  'a backfilled listing starts with an empty description and the partner note is protected'
);

SELECT * FROM finish();
ROLLBACK;
