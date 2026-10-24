-- Focused coverage for 20261024120000_directory_membership_hardening.sql.
-- Run after a local migration reset with: supabase test db
--
-- This file is never pasted into production.

BEGIN;
SELECT plan(109);

-- Actors (suffix d7)
--   ad  platform admin
--   s1  solo practitioner who joins team T          (finding 3, then 4)
--   t1  owner of team T
--   o1  owner who submitted a third-party program   (finding 1)
--   o2  owner whose email domain matches a listing  (finding 1)
--   o3  owner with a brand-new profile              (finding 1)
--   o4  owner whose profile collides with o3's      (round 2, item 5)
--   s2  second solo practitioner with a profile     (round 2, item 4)
--   c1  center account holding a claimed listing    (finding 2)
--   p1  practice submitting partners                (finding 2)
--   f1..f5  five practices referring to one listing (finding 5)
--   x1, x2  two unrelated practices                 (finding 8)
INSERT INTO auth.users (id, email)
VALUES
  ('ad000000-0000-0000-0000-0000000000d7', 'hardening-admin@example.test'),
  ('a1000000-0000-0000-0000-0000000000d7', 'solo@solo-practice.example'),
  ('a2000000-0000-0000-0000-0000000000d7', 'owner@team-practice.example'),
  ('b1000000-0000-0000-0000-0000000000d7', 'owner@helpful-practice.example'),
  ('b2000000-0000-0000-0000-0000000000d7', 'dr@northstar.example'),
  ('b3000000-0000-0000-0000-0000000000d7', 'owner@fresh-practice.example'),
  ('b4000000-0000-0000-0000-0000000000d7', 'owner@second-practice.example'),
  ('b5000000-0000-0000-0000-0000000000d7', 'owner@name-twin.example'),
  ('a3000000-0000-0000-0000-0000000000d7', 'second-solo@solo-two.example'),
  ('c1000000-0000-0000-0000-0000000000d7', 'admissions@attacker.example'),
  ('c2000000-0000-0000-0000-0000000000d7', 'owner@submitting-practice.example'),
  ('f1000000-0000-0000-0000-0000000000d7', 'f1@example.test'),
  ('f2000000-0000-0000-0000-0000000000d7', 'f2@example.test'),
  ('f3000000-0000-0000-0000-0000000000d7', 'f3@example.test'),
  ('f4000000-0000-0000-0000-0000000000d7', 'f4@example.test'),
  ('f5000000-0000-0000-0000-0000000000d7', 'f5@example.test'),
  ('e1000000-0000-0000-0000-0000000000d7', 'x1@example.test'),
  ('e2000000-0000-0000-0000-0000000000d7', 'x2@example.test');

INSERT INTO public.platform_admins (user_id) VALUES ('ad000000-0000-0000-0000-0000000000d7');

SELECT set_config('test.org_s', org_id::text, true) FROM public.org_members WHERE user_id = 'a1000000-0000-0000-0000-0000000000d7';
SELECT set_config('test.org_t', org_id::text, true) FROM public.org_members WHERE user_id = 'a2000000-0000-0000-0000-0000000000d7';
SELECT set_config('test.org_o1', org_id::text, true) FROM public.org_members WHERE user_id = 'b1000000-0000-0000-0000-0000000000d7';
SELECT set_config('test.org_o3', org_id::text, true) FROM public.org_members WHERE user_id = 'b3000000-0000-0000-0000-0000000000d7';
SELECT set_config('test.org_o4', org_id::text, true) FROM public.org_members WHERE user_id = 'b4000000-0000-0000-0000-0000000000d7';
SELECT set_config('test.org_o5', org_id::text, true) FROM public.org_members WHERE user_id = 'b5000000-0000-0000-0000-0000000000d7';
SELECT set_config('test.org_s2', org_id::text, true) FROM public.org_members WHERE user_id = 'a3000000-0000-0000-0000-0000000000d7';
SELECT set_config('test.org_p1', org_id::text, true) FROM public.org_members WHERE user_id = 'c2000000-0000-0000-0000-0000000000d7';

-- ═══════════════════════════════════════════════════════════════════════════
-- Finding 1: a directory profile never takes over an existing listing
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO public.global_partners (id, name, organization, types, phone, website, status)
VALUES ('d2000000-0000-0000-0000-0000000000d7', 'Front desk', 'North Star Family Therapy', ARRAY['Therapist'], '(541) 555-0820', 'https://northstar.example', 'pending');

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000d7', true);
SET LOCAL ROLE authenticated;

INSERT INTO public.partners (id, owner_id, name, organization, types, city, state, phone, email, website, monthly_cost, insurance)
VALUES ('91000000-0000-0000-0000-0000000000d7', 'b1000000-0000-0000-0000-0000000000d7', 'Admissions', 'Helpful Third Party Recovery',
        ARRAY['Inpatient'], 'Bend', 'OR', '(541) 555-0810', 'admissions@third-party.example', 'https://third-party.example', 30000, ARRAY['Aetna']);
SELECT set_config('test.l_suggested', public.suggest_global_listing('91000000-0000-0000-0000-0000000000d7')::text, true);

SELECT set_config('test.profile', public.upsert_org_directory_profile(
  '{"name":"Mal","organization":"Helpful Practice","types":["Interventionist"],"phone":"541-555-0810"}'::jsonb)::text, true);

SELECT is(
  (current_setting('test.profile')::jsonb ->> 'status') || '|' || (current_setting('test.profile')::jsonb ->> 'listing_id'),
  'claim_requested|' || current_setting('test.l_suggested'),
  'a listing the workspace itself submitted (and created) is not taken over: it becomes a claim request'
);

RESET ROLE;
SELECT ok(
  (SELECT owner_org_id IS NULL AND status = 'pending' AND organization = 'Helpful Third Party Recovery' AND name = 'Admissions'
     FROM public.global_partners WHERE id = current_setting('test.l_suggested')::uuid),
  'the submitted listing is untouched by the profile save'
);

SELECT ok(
  (SELECT note LIKE '%submitted by this workspace%' AND note LIKE '%created by this user%' AND status = 'pending'
     FROM public.center_claim_requests WHERE id = (current_setting('test.profile')::jsonb ->> 'request_id')::uuid),
  'the claim request tells the reviewer who submitted and created the listing'
);

SELECT set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-0000000000d7', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT (r ->> 'status') || '|' || coalesce(r ->> 'listing_id', 'hidden')
     FROM public.upsert_org_directory_profile(
       '{"name":"Dr. North","organization":"North Star Family Therapy","types":["Therapist"],"website":"https://www.northstar.example"}'::jsonb) AS r),
  'claim_requested|hidden',
  'a sign-in email domain that matches the website is not proof either, and a pending listing''s id is not revealed'
);
RESET ROLE;
SELECT ok(
  (SELECT owner_org_id IS NULL AND status = 'pending' AND name = 'Front desk'
     FROM public.global_partners WHERE id = 'd2000000-0000-0000-0000-0000000000d7')
  AND (SELECT note LIKE '%email domain matches the website (unverified)%' FROM public.center_claim_requests
        WHERE global_partner_id = 'd2000000-0000-0000-0000-0000000000d7'),
  'the email-domain listing is untouched and the hint is recorded for the reviewer'
);

SELECT set_config('request.jwt.claim.sub', 'b3000000-0000-0000-0000-0000000000d7', true);
SET LOCAL ROLE authenticated;
SELECT is(
  public.upsert_org_directory_profile(
    '{"name":"Fresh Owner","organization":"Fresh Practice","types":["Interventionist"],"phone":"541-555-0830","website":"https://fresh-practice.example"}'::jsonb) ->> 'status',
  'created',
  'a profile with no duplicate is still created at once'
);
SELECT ok(
  (SELECT owner_org_id = current_setting('test.org_o3')::uuid AND status = 'active' AND verified_at IS NOT NULL
     FROM public.global_partners WHERE phone_digits = '5415550830'),
  'the new profile is owned, live, and verified'
);
SELECT is(
  public.upsert_org_directory_profile(
    '{"name":"Fresh Owner","organization":"Fresh Practice","types":["Interventionist"],"phone":"541-555-0830","city":"Bend"}'::jsonb) ->> 'status',
  'updated',
  'the owner keeps editing the profile'
);

-- Round 2, item 1: an owner's identity edit that collides with another
-- listing (here North Star's phone) is held for review.
SELECT set_config('test.edit', public.upsert_org_directory_profile(
  '{"name":"Fresh Owner","organization":"Fresh Practice","types":["Interventionist"],"phone":"(541) 555-0820","city":"Bend","description":"Now with a description"}'::jsonb)::text, true);
SELECT is(
  (current_setting('test.edit')::jsonb ->> 'status') || '|' || (current_setting('test.edit')::jsonb -> 'held_fields')::text,
  'updated_pending_review|["phone"]',
  'a phone number another listing uses is held for review'
);
SELECT ok(
  (SELECT phone_digits = '5415550830' AND description = 'Now with a description' AND verified_at IS NOT NULL
     FROM public.global_partners WHERE owner_org_id = current_setting('test.org_o3')::uuid)
  AND (SELECT kind = 'identity_edit' AND proposed ->> 'phone' = '(541) 555-0820' AND collisions = ARRAY['phone']
         FROM public.directory_review_requests WHERE id = (current_setting('test.edit')::jsonb ->> 'review_id')::uuid),
  'the live phone stays, the other changes land, and the owner can see the held change'
);
SELECT is(
  public.upsert_org_directory_profile(
    '{"name":"Fresh Owner","organization":"Fresh Practice","types":["Interventionist"],"phone":"(541) 555-0831","city":"Bend"}'::jsonb) ->> 'status',
  'updated',
  'a later phone change that collides with nothing goes live'
);
SELECT is(
  (SELECT status FROM public.directory_review_requests WHERE id = (current_setting('test.edit')::jsonb ->> 'review_id')::uuid),
  'withdrawn',
  'and withdraws the held change'
);

-- Round 2, item 5: a first profile that collides with a listing another
-- workspace owns is saved pending, with a conflict review.
SELECT set_config('request.jwt.claim.sub', 'b4000000-0000-0000-0000-0000000000d7', true);
SELECT set_config('test.conflict', public.upsert_org_directory_profile(
  '{"name":"Copy","organization":"Second Practice","types":["Interventionist"],"phone":"541.555.0831"}'::jsonb)::text, true);
SELECT is(
  current_setting('test.conflict')::jsonb ->> 'status',
  'conflict',
  'a collision with another workspace''s listing is a conflict, not an unapprovable claim'
);
SELECT ok(
  (SELECT owner_org_id = current_setting('test.org_o4')::uuid AND status = 'pending' AND verified_at IS NULL
     FROM public.global_partners WHERE id = (current_setting('test.conflict')::jsonb ->> 'listing_id')::uuid)
  AND (SELECT kind = 'profile_conflict' AND status = 'pending'
              AND related_listing_id = (SELECT id FROM public.global_partners WHERE phone_digits = '5415550831' AND owner_org_id <> current_setting('test.org_o4')::uuid)
         FROM public.directory_review_requests WHERE id = (current_setting('test.conflict')::jsonb ->> 'review_id')::uuid),
  'the new profile is owned but pending, and the review points at the other listing'
);
SELECT is(
  public.upsert_org_directory_profile(
    '{"name":"Copy","organization":"Second Practice","types":["Interventionist"],"phone":"541.555.0831","city":"Salem"}'::jsonb) ->> 'status',
  'conflict',
  'saving again reports the open conflict'
);
SELECT throws_ok(
  $$ SELECT public.resolve_directory_review_request((current_setting('test.conflict')::jsonb ->> 'review_id')::uuid, true) $$,
  '42501',
  'Platform admin required',
  'only a platform admin resolves a review'
);
SELECT set_config('request.jwt.claim.sub', 'ad000000-0000-0000-0000-0000000000d7', true);
SELECT is(
  public.resolve_directory_review_request((current_setting('test.conflict')::jsonb ->> 'review_id')::uuid, true),
  'approved',
  'the admin approves the conflicting profile'
);
SELECT ok(
  (SELECT status = 'active' AND verified_at IS NOT NULL AND city = 'Salem'
     FROM public.global_partners WHERE id = (current_setting('test.conflict')::jsonb ->> 'listing_id')::uuid),
  'and it goes live'
);
SELECT set_config('request.jwt.claim.sub', 'b3000000-0000-0000-0000-0000000000d7', true);
SELECT set_config('test.edit2', (public.upsert_org_directory_profile(
  '{"name":"Fresh Owner","organization":"Fresh Practice","types":["Interventionist"],"phone":"(541) 555-0820","city":"Bend"}'::jsonb) ->> 'review_id'), true);
SELECT set_config('request.jwt.claim.sub', 'ad000000-0000-0000-0000-0000000000d7', true);
SELECT is(
  public.resolve_directory_review_request(current_setting('test.edit2')::uuid, true),
  'approved',
  'the admin approves the held identity edit'
);
SELECT is(
  (SELECT phone FROM public.global_partners WHERE owner_org_id = current_setting('test.org_o3')::uuid),
  '(541) 555-0820',
  'an approved identity edit is applied'
);

-- Round 4: only the colliding group is held. A colliding rename plus a new
-- phone in one save: the phone goes live, the name waits.
SELECT set_config('request.jwt.claim.sub', 'b3000000-0000-0000-0000-0000000000d7', true);
SELECT set_config('test.mixed', public.upsert_org_directory_profile(
  '{"name":"Fresh Owner","organization":"North Star Family Therapy","types":["Interventionist"],"phone":"(541) 555-0832","city":"Bend"}'::jsonb)::text, true);
SELECT is(
  (current_setting('test.mixed')::jsonb ->> 'status') || '|' || (current_setting('test.mixed')::jsonb -> 'held_fields')::text
    || '|' || (current_setting('test.mixed')::jsonb ->> 'message'),
  'updated_pending_review|["name"]|Your other changes are live. The new name matches another directory listing, so ReferralFit will review that change first. Until then your current name stays up.',
  'a colliding rename is held and the message names exactly what is held'
);
SELECT ok(
  (SELECT organization = 'Fresh Practice' AND phone = '(541) 555-0832' AND phone_digits = '5415550832'
     FROM public.global_partners WHERE owner_org_id = current_setting('test.org_o3')::uuid)
  AND (SELECT proposed = '{"organization": "North Star Family Therapy", "name": "Fresh Owner"}'::jsonb
              AND collisions = ARRAY['name'] AND related_listing_id = 'd2000000-0000-0000-0000-0000000000d7'
         FROM public.directory_review_requests WHERE id = (current_setting('test.mixed')::jsonb ->> 'review_id')::uuid),
  'the new phone is live; only the name is proposed, with the listing it collides with'
);
SELECT set_config('request.jwt.claim.sub', 'ad000000-0000-0000-0000-0000000000d7', true);
SELECT is(
  public.resolve_directory_review_request((current_setting('test.mixed')::jsonb ->> 'review_id')::uuid, false),
  'rejected',
  'the admin declines the held rename'
);
SELECT is(
  (SELECT organization || '|' || phone FROM public.global_partners WHERE owner_org_id = current_setting('test.org_o3')::uuid),
  'Fresh Practice|(541) 555-0832',
  'declining the rename never undoes the phone change that went live'
);

-- Round 3, item 1: a first profile with only the NAME of another listing
-- (no shared phone or website) is held as a conflict too.
SELECT set_config('request.jwt.claim.sub', 'b5000000-0000-0000-0000-0000000000d7', true);
SELECT set_config('test.twin', public.upsert_org_directory_profile(
  '{"name":"Twin","organization":"The North Star Family Therapy","types":["Therapist"],"phone":"(503) 555-0999"}'::jsonb)::text, true);
SELECT is(
  (current_setting('test.twin')::jsonb ->> 'status') || '|' || (current_setting('test.twin')::jsonb ->> 'message'),
  'conflict|Another directory listing already uses this name. Your profile is saved and ReferralFit will review it before it appears in the directory.',
  'a profile named like an existing listing waits for review'
);
SELECT ok(
  (SELECT status = 'pending' AND verified_at IS NULL AND owner_org_id = current_setting('test.org_o5')::uuid
     FROM public.global_partners WHERE id = (current_setting('test.twin')::jsonb ->> 'listing_id')::uuid),
  'it is owned but hidden'
);

-- Round 3, item 4: declined, then saved again: back to review, not stuck.
SELECT set_config('request.jwt.claim.sub', 'ad000000-0000-0000-0000-0000000000d7', true);
SELECT is(
  public.resolve_directory_review_request((current_setting('test.twin')::jsonb ->> 'review_id')::uuid, false),
  'rejected',
  'the admin declines the name twin'
);
SELECT set_config('request.jwt.claim.sub', 'b5000000-0000-0000-0000-0000000000d7', true);
SELECT set_config('test.resub', public.upsert_org_directory_profile(
  '{"name":"Twin","organization":"North Star Counseling of Salem","types":["Therapist"],"phone":"(503) 555-0999"}'::jsonb)::text, true);
SELECT is(
  (current_setting('test.resub')::jsonb ->> 'status') || '|' || (current_setting('test.resub')::jsonb ->> 'message'),
  'resubmitted_for_review|Your profile was not approved for the directory earlier. It is saved and sent to ReferralFit for review again, and it stays hidden until then.',
  'saving an archived profile sends it back for review'
);
SELECT ok(
  (SELECT status = 'pending' AND organization = 'North Star Counseling of Salem'
     FROM public.global_partners WHERE id = (current_setting('test.twin')::jsonb ->> 'listing_id')::uuid)
  AND (SELECT kind = 'resubmitted_profile' AND status = 'pending' AND related_listing_id IS NULL
              AND note LIKE '%matches no other listing now%'
         FROM public.directory_review_requests WHERE id = (current_setting('test.resub')::jsonb ->> 'review_id')::uuid),
  'the profile is pending again with a resubmission review that says what it collides with (nothing)'
);
SELECT is(
  public.upsert_org_directory_profile(
    '{"name":"Twin","organization":"North Star Counseling of Salem","types":["Therapist"],"phone":"(503) 555-0999","city":"Salem"}'::jsonb) ->> 'status',
  'resubmitted_for_review',
  'later saves report the open resubmission'
);
SELECT set_config('request.jwt.claim.sub', 'ad000000-0000-0000-0000-0000000000d7', true);
SELECT is(
  public.resolve_directory_review_request((current_setting('test.resub')::jsonb ->> 'review_id')::uuid, true),
  'approved',
  'the admin approves the resubmission'
);
SELECT is(
  (SELECT status FROM public.global_partners WHERE id = (current_setting('test.twin')::jsonb ->> 'listing_id')::uuid),
  'active',
  'and the profile goes live'
);

-- Round 4: a profile an admin merged into another listing is never resubmitted.
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
UPDATE public.global_partners
   SET status = 'archived', merged_into = (SELECT id FROM public.global_partners WHERE owner_org_id = current_setting('test.org_o3')::uuid)
 WHERE owner_org_id = current_setting('test.org_o4')::uuid;
SELECT set_config('request.jwt.claim.sub', 'b4000000-0000-0000-0000-0000000000d7', true);
SET LOCAL ROLE authenticated;
SELECT is(
  public.upsert_org_directory_profile(
    '{"name":"Copy","organization":"Second Practice","types":["Interventionist"],"phone":"541.555.0831","city":"Portland"}'::jsonb) ->> 'status',
  'merged',
  'saving a merged-away profile reports merged'
);
SELECT ok(
  (SELECT status = 'archived' AND city = 'Salem' FROM public.global_partners WHERE owner_org_id = current_setting('test.org_o4')::uuid)
  AND NOT EXISTS (SELECT 1 FROM public.directory_review_requests
                   WHERE kind = 'resubmitted_profile' AND org_id = current_setting('test.org_o4')::uuid),
  'and it stays archived, unchanged, with no resubmission'
);
SELECT set_config('request.jwt.claim.sub', 'b3000000-0000-0000-0000-0000000000d7', true);
SELECT throws_ok(
  $$ SELECT public.upsert_org_directory_profile('{"name":"x","organization":"y","types":["Detox"],"owner_org_id":"x"}'::jsonb) $$,
  '22023',
  'Field "owner_org_id" is not part of a directory profile',
  'the field allowlist still applies'
);

SELECT set_config('request.jwt.claim.sub', 'ad000000-0000-0000-0000-0000000000d7', true);
SELECT is(
  public.approve_center_claim_request((current_setting('test.profile')::jsonb ->> 'request_id')::uuid),
  current_setting('test.l_suggested')::uuid,
  'a platform admin approves the claim request'
);
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000d7', true);
SELECT is(
  public.upsert_org_directory_profile(
    '{"name":"Mal","organization":"Helpful Practice","types":["Interventionist"],"phone":"541-555-0810"}'::jsonb) ->> 'status',
  'updated',
  'after approval the workspace edits the listing as its own profile'
);
RESET ROLE;

SELECT ok(
  position('UPDATE' in pg_get_functiondef('public.upsert_org_directory_profile(jsonb)'::regprocedure)) = 0
  AND position('owner_org_id = v_org' in pg_get_functiondef('public.upsert_org_directory_profile(jsonb)'::regprocedure)) > 0,
  'the profile RPC no longer has an automatic takeover branch'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- Finding 2: submissions link only on a name match too
-- ═══════════════════════════════════════════════════════════════════════════

SELECT ok(
  public.directory_names_match('The Meadows, LLC', 'Meadows LLC')
  AND public.directory_names_match('Cedar Hills', 'Cedar Hills Recovery')
  AND NOT public.directory_names_match('Summit Detox', 'Valley Detox')
  AND NOT public.directory_names_match('ABC', 'ABCD House')
  AND NOT public.directory_names_match('', 'Anything'),
  'directory_names_match: equal keys or a 4+ character prefix, nothing else'
);

-- A claimed center copies a competitor's phone number.
SELECT set_config('request.jwt.claim.sub', '', true);
INSERT INTO public.global_partners (id, name, organization, types, phone, website, status, verified_at)
VALUES ('d3000000-0000-0000-0000-0000000000d7', 'Admissions', 'Attacker Recovery', ARRAY['Inpatient'], '(541) 555-0700', 'https://attacker.example', 'active', now()),
       ('d4000000-0000-0000-0000-0000000000d7', 'Admissions', 'Summit Detox', ARRAY['Detox'], '(541) 555-0710', 'https://summit-detox.example', 'active', now()),
       ('d5000000-0000-0000-0000-0000000000d7', 'Admissions', 'Cedar Hills Recovery', ARRAY['Inpatient'], '(541) 555-0720', 'https://cedarhills.example', 'active', now());
UPDATE public.global_partners SET city = 'Bend', state = 'OR' WHERE id = 'd5000000-0000-0000-0000-0000000000d7';
-- Two campuses of one brand sharing a phone and website (round 2, item 2).
INSERT INTO public.global_partners (id, name, organization, types, city, state, phone, website, status, verified_at, created_at)
VALUES ('d8000000-0000-0000-0000-0000000000d7', 'Admissions', 'Recovery Unplugged', ARRAY['Inpatient'], 'Austin', 'TX', '(800) 555-0101', 'https://recoveryunplugged.example', 'active', now(), now() - interval '2 days'),
       ('d9000000-0000-0000-0000-0000000000d7', 'Admissions', 'Recovery Unplugged Nashville', ARRAY['Inpatient'], 'Nashville', 'TN', '(800) 555-0101', 'https://recoveryunplugged.example', 'active', now(), now() - interval '1 day');
INSERT INTO public.center_members (user_id, global_partner_id)
VALUES ('c1000000-0000-0000-0000-0000000000d7', 'd3000000-0000-0000-0000-0000000000d7');

SELECT set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-0000000000d7', true);
SET LOCAL ROLE authenticated;
INSERT INTO public.partners (id, owner_id, name, organization, types, city, state, phone, email, website, monthly_cost, insurance)
VALUES
  ('92000000-0000-0000-0000-0000000000d7', 'c2000000-0000-0000-0000-0000000000d7', 'Intake', 'Victim Recovery Center', ARRAY['Inpatient'], 'Bend', 'OR', '541.555.0700', 'intake@victim.example', 'https://victim.example', 28000, ARRAY['Aetna']),
  ('93000000-0000-0000-0000-0000000000d7', 'c2000000-0000-0000-0000-0000000000d7', 'Intake', 'Valley Detox', ARRAY['Detox'], 'Bend', 'OR', '(541) 555-0710', 'intake@valley.example', 'https://valley-detox.example', 9000, ARRAY['Aetna']),
  ('94000000-0000-0000-0000-0000000000d7', 'c2000000-0000-0000-0000-0000000000d7', 'Intake', 'Cedar Hills', ARRAY['Inpatient'], 'Bend', 'OR', '(503) 555-0000', 'intake@cedarhills.example', 'https://www.cedarhills.example/', 31000, ARRAY['Aetna']),
  ('9d000000-0000-0000-0000-0000000000d7', 'c2000000-0000-0000-0000-0000000000d7', 'Intake', 'Attacker Recovery', ARRAY['Inpatient'], 'Bend', 'OR', '(541) 555-0700', 'intake@attacker.example', 'https://attacker.example', 28000, ARRAY['Aetna']),
  ('9e000000-0000-0000-0000-0000000000d7', 'c2000000-0000-0000-0000-0000000000d7', 'Intake', 'Recovery Unplugged Nashville', ARRAY['Inpatient'], 'Nashville', 'TN', '800-555-0101', 'a@ru.example', 'https://recoveryunplugged.example', 20000, ARRAY['Aetna']),
  ('9f000000-0000-0000-0000-0000000000d7', 'c2000000-0000-0000-0000-0000000000d7', 'Intake', 'Recovery Unplugged Orlando', ARRAY['Inpatient'], 'Orlando', 'FL', '800-555-0101', 'o@ru.example', 'https://recoveryunplugged.example', 20000, ARRAY['Aetna']);

SELECT isnt(
  public.suggest_global_listing('92000000-0000-0000-0000-0000000000d7'),
  'd3000000-0000-0000-0000-0000000000d7'::uuid,
  'a partner sharing only a phone number with a claimed listing is not linked to it'
);
SELECT ok(
  (SELECT p.global_listing_status = 'pending' AND g.suggested_by_org_id = current_setting('test.org_p1')::uuid
          AND g.organization = 'Victim Recovery Center'
     FROM public.partners p JOIN public.global_partners g ON g.id = p.global_partner_id
    WHERE p.id = '92000000-0000-0000-0000-0000000000d7'),
  'it becomes a new pending suggestion instead'
);
SELECT isnt(
  public.suggest_global_listing('93000000-0000-0000-0000-0000000000d7'),
  'd4000000-0000-0000-0000-0000000000d7'::uuid,
  'an unclaimed listing with the same phone but another name is not linked either'
);
SELECT is(
  public.suggest_global_listing('94000000-0000-0000-0000-0000000000d7'),
  'd5000000-0000-0000-0000-0000000000d7'::uuid,
  'same website domain and a matching name still links to the existing listing'
);
SELECT isnt(
  public.suggest_global_listing('9d000000-0000-0000-0000-0000000000d7'),
  'd3000000-0000-0000-0000-0000000000d7'::uuid,
  'a claimed listing is never auto-linked, even with the same name and phone'
);
SELECT is(
  public.suggest_global_listing('9e000000-0000-0000-0000-0000000000d7'),
  'd9000000-0000-0000-0000-0000000000d7'::uuid,
  'an exact name match wins over an older prefix match'
);
SELECT ok(
  public.suggest_global_listing('9f000000-0000-0000-0000-0000000000d7')
    NOT IN ('d8000000-0000-0000-0000-0000000000d7'::uuid, 'd9000000-0000-0000-0000-0000000000d7'::uuid),
  'a prefix-only match in another state is not the same program'
);
RESET ROLE;
SELECT is(
  (SELECT organization || '|' || phone FROM public.partners WHERE id = '92000000-0000-0000-0000-0000000000d7'),
  'Victim Recovery Center|541.555.0700',
  'the claimed listing never overwrote the other practice''s partner'
);

-- Round 2, item 1: a center renaming its listing to another listing's name
-- is held; its other edits land.
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000d7', true);
SET LOCAL ROLE authenticated;
UPDATE public.global_partners SET organization = 'Summit Detox', description = 'Center edit'
 WHERE id = 'd3000000-0000-0000-0000-0000000000d7';
SELECT ok(
  (SELECT organization = 'Attacker Recovery' AND description = 'Center edit' FROM public.global_partners WHERE id = 'd3000000-0000-0000-0000-0000000000d7')
  AND (SELECT collisions = ARRAY['name'] AND proposed ->> 'organization' = 'Summit Detox' AND org_id IS NULL
         FROM public.directory_review_requests
        WHERE kind = 'identity_edit' AND global_partner_id = 'd3000000-0000-0000-0000-0000000000d7' AND status = 'pending'),
  'a center cannot take another listing''s name without review, and sees its request'
);
RESET ROLE;
SELECT ok(
  (SELECT NOT (search_tsv @@ to_tsquery('simple', 'summit')) AND search_tsv @@ to_tsquery('simple', 'attacker')
          AND search_tsv @@ to_tsquery('simple', 'center')
     FROM public.global_partners WHERE id = 'd3000000-0000-0000-0000-0000000000d7'),
  'the held name is not searchable; the live name and the applied edits are'
);

-- Round 3, item 3: normalization for duplicate detection.
SELECT ok(
  public.directory_website_domain('Https://WWW.Example.com:8443/intake?x=1') = 'example.com'
  AND public.directory_website_domain('HTTP://www.example.com') = 'example.com'
  AND public.directory_website_domain('example.com/#top') = 'example.com'
  AND public.directory_website_domain('/just/a/path') = ''
  AND public.directory_phone_digits('+1 (541) 555-0100') = '5415550100'
  AND public.directory_phone_digits('541-555-0100') = '5415550100'
  AND public.directory_phone_digits('011 44 20 7946 0958') = '011442079460958',
  'scheme case, www, port, path and a leading US country code no longer defeat matching'
);
INSERT INTO public.global_partners (id, name, organization, types, phone, website, status)
VALUES ('db000000-0000-0000-0000-0000000000d7', 'Admissions', 'Normalized Recovery', ARRAY['Inpatient'], '+1 541 555 0960', 'HTTPS://WWW.UpperCase.example/', 'active');
SELECT is(
  (SELECT phone_digits || '|' || website_domain FROM public.global_partners WHERE id = 'db000000-0000-0000-0000-0000000000d7'),
  '5415550960|uppercase.example',
  'stored phone digits and domain use the same normalization'
);
SELECT is(
  (SELECT count(*)::integer FROM public.global_partners
    WHERE phone_digits IS DISTINCT FROM public.directory_phone_digits(phone)
       OR website_domain IS DISTINCT FROM public.directory_website_domain(website)),
  0,
  'every stored listing is normalized the same way'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- Finding 3: a solo practitioner with benefits and a shared listing joins
-- ═══════════════════════════════════════════════════════════════════════════

SELECT set_config('request.jwt.claim.sub', '', true);
INSERT INTO public.global_partners (id, name, organization, types, phone, status, verified_at)
VALUES ('d1000000-0000-0000-0000-0000000000d7', 'Admissions', 'Shared Ridge Recovery', ARRAY['Inpatient'], '(541) 555-0900', 'active', now());

SELECT set_config('request.jwt.claim.sub', 'a2000000-0000-0000-0000-0000000000d7', true);
SET LOCAL ROLE authenticated;
SELECT public.import_global_partner('d1000000-0000-0000-0000-0000000000d7', '81000000-0000-0000-0000-0000000000d7');
SELECT set_config('test.invite', code, true) FROM public.create_org_invite();
SELECT set_config('test.invite2', code, true) FROM public.create_org_invite();

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000d7', true);
SELECT public.import_global_partner('d1000000-0000-0000-0000-0000000000d7', '82000000-0000-0000-0000-0000000000d7');
INSERT INTO public.partners (id, owner_id, name) VALUES ('83000000-0000-0000-0000-0000000000d7', 'a1000000-0000-0000-0000-0000000000d7', 'Private partner');
INSERT INTO public.cases (id, owner_id, title, assigned_to)
VALUES ('84000000-0000-0000-0000-0000000000d7', 'a1000000-0000-0000-0000-0000000000d7', 'Solo family', 'a1000000-0000-0000-0000-0000000000d7');
INSERT INTO public.referrals (id, owner_id, partner_id, direction, referred_on, case_id)
VALUES ('85000000-0000-0000-0000-0000000000d7', 'a1000000-0000-0000-0000-0000000000d7', '82000000-0000-0000-0000-0000000000d7', 'outbound', CURRENT_DATE, '84000000-0000-0000-0000-0000000000d7');
INSERT INTO public.touches (id, owner_id, partner_id, kind, note, occurred_at)
VALUES ('86000000-0000-0000-0000-0000000000d7', 'a1000000-0000-0000-0000-0000000000d7', '82000000-0000-0000-0000-0000000000d7', 'call', '', now());
INSERT INTO public.follow_ups (id, owner_id, partner_id, title, due_on)
VALUES ('87000000-0000-0000-0000-0000000000d7', 'a1000000-0000-0000-0000-0000000000d7', '82000000-0000-0000-0000-0000000000d7', 'Call Shared Ridge', CURRENT_DATE);
INSERT INTO public.match_profiles (id, owner_id, client_label, assigned_partner_id, case_id)
VALUES ('88000000-0000-0000-0000-0000000000d7', 'a1000000-0000-0000-0000-0000000000d7', 'S.F.', '82000000-0000-0000-0000-0000000000d7', '84000000-0000-0000-0000-0000000000d7');
INSERT INTO public.placement_decisions (id, owner_id, match_profile_id, case_id, referral_id, chosen_partner_id, chosen_rank)
VALUES ('89000000-0000-0000-0000-0000000000d7', 'a1000000-0000-0000-0000-0000000000d7', '88000000-0000-0000-0000-0000000000d7',
        '84000000-0000-0000-0000-0000000000d7', '85000000-0000-0000-0000-0000000000d7', '82000000-0000-0000-0000-0000000000d7', 1);
SELECT carrier FROM public.save_case_benefits('84000000-0000-0000-0000-0000000000d7', '{"carrier":"Aetna","plan_name":"PPO"}'::jsonb, NULL);
SELECT id FROM public.request_vob('{"id":"8a000000-0000-0000-0000-0000000000d7","case_id":"84000000-0000-0000-0000-0000000000d7","partner_id":"82000000-0000-0000-0000-0000000000d7","follow_up_id":"8b000000-0000-0000-0000-0000000000d7"}'::jsonb);
SELECT public.toggle_user_favorite('partner', '82000000-0000-0000-0000-0000000000d7');
SELECT public.toggle_user_favorite('partner', '83000000-0000-0000-0000-0000000000d7');
SELECT public.register_push_token('ExponentPushToken[solohardening0001]', 'ios');
-- Round 2, item 4: the solo workspace's own directory profile.
SELECT public.upsert_org_directory_profile('{"name":"Sol","organization":"Solo Interventions","types":["Interventionist"],"phone":"(541) 555-1234"}'::jsonb);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
-- ...a listing it submitted, a pending claim request, and a benchmarks comp
-- (the team has an expired one).
INSERT INTO public.global_partners (id, name, organization, types, phone, status, suggested_by_org_id)
VALUES ('da000000-0000-0000-0000-0000000000d7', 'Intake', 'Solo Submitted Program', ARRAY['Detox'], '(541) 555-1250', 'pending', current_setting('test.org_s')::uuid);
INSERT INTO public.center_claim_requests (org_id, global_partner_id, requested_by, note)
VALUES (current_setting('test.org_s')::uuid, 'd2000000-0000-0000-0000-0000000000d7', 'a1000000-0000-0000-0000-0000000000d7', 'solo claim');
INSERT INTO public.org_entitlements (org_id, entitlement, active, source, expires_at)
VALUES (current_setting('test.org_s')::uuid, 'benchmarks', true, 'manual', NULL),
       (current_setting('test.org_t')::uuid, 'benchmarks', false, 'manual', now() - interval '1 day');
SELECT public.claim_outreach_draft('a1000000-0000-0000-0000-0000000000d7', 'text', NULL, '82000000-0000-0000-0000-0000000000d7');
-- Both copies carry their own private fields.
UPDATE public.partners SET note = 'Team note', last_contact_at = now() - interval '10 days' WHERE id = '81000000-0000-0000-0000-0000000000d7';
UPDATE public.partners SET note = 'Ask for Dana in admissions', touch_cadence_days = 14, favorite = true,
       phone = '541-555-0000', email = 'dana@direct.example', last_contact_at = now() - interval '1 day',
       financial_relationship = 'consulting_fee', financial_relationship_note = 'Paid monthly consulting'
 WHERE id = '82000000-0000-0000-0000-0000000000d7';

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000d7', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$ SELECT public.accept_org_invite(current_setting('test.invite')) $$,
  'a solo practitioner with insurance benefits and an imported listing the team also has can join'
);
SELECT lives_ok(
  $$ SET CONSTRAINTS ALL IMMEDIATE $$,
  'every deferred relationship is consistent after the join'
);
RESET ROLE;

SELECT ok(
  (SELECT org_id = current_setting('test.org_t')::uuid AND role = 'member' FROM public.org_members WHERE user_id = 'a1000000-0000-0000-0000-0000000000d7')
  AND NOT EXISTS (SELECT 1 FROM public.orgs WHERE id = current_setting('test.org_s')::uuid),
  'the practitioner is a member of the team and the personal workspace is gone'
);
SELECT ok(
  NOT EXISTS (SELECT 1 FROM public.partners WHERE id = '82000000-0000-0000-0000-0000000000d7')
  AND (SELECT count(*) = 1 FROM public.partners WHERE org_id = current_setting('test.org_t')::uuid AND global_partner_id = 'd1000000-0000-0000-0000-0000000000d7'),
  'the duplicate linked partner was merged into the team''s copy'
);
SELECT ok(
  (SELECT note = 'Team note' || chr(10) || chr(10) || 'From solo: Ask for Dana in admissions'
                 || chr(10) || 'Joiner''s contact: 541-555-0000, dana@direct.example'
          AND touch_cadence_days = 14 AND favorite
     FROM public.partners WHERE id = '81000000-0000-0000-0000-0000000000d7'),
  'the joiner''s private note and differing contact details are appended (attributed); cadence and favorite carry over'
);
SELECT ok(
  (SELECT financial_relationship = 'consulting_fee' AND financial_relationship_note = 'Paid monthly consulting'
          AND last_contact_at > now() - interval '2 days'
     FROM public.partners WHERE id = '81000000-0000-0000-0000-0000000000d7'),
  'the joiner''s disclosed financial relationship and later last contact are kept'
);
SELECT ok(
  (SELECT owner_org_id = current_setting('test.org_t')::uuid AND status = 'active'
     FROM public.global_partners WHERE organization = 'Solo Interventions')
  AND (SELECT suggested_by_org_id = current_setting('test.org_t')::uuid FROM public.global_partners WHERE id = 'da000000-0000-0000-0000-0000000000d7'),
  'the solo profile becomes the team''s (it had none) and its submissions count as the team''s'
);
SELECT ok(
  (SELECT org_id = current_setting('test.org_t')::uuid AND status = 'pending'
     FROM public.center_claim_requests WHERE note = 'solo claim')
  AND (SELECT active AND expires_at IS NULL FROM public.org_entitlements
        WHERE org_id = current_setting('test.org_t')::uuid AND entitlement = 'benchmarks'),
  'the pending claim request moves, and entitlements merge to the most generous'
);
SELECT ok(
  (SELECT partner_id = '81000000-0000-0000-0000-0000000000d7' AND org_id = current_setting('test.org_t')::uuid
     FROM public.referrals WHERE id = '85000000-0000-0000-0000-0000000000d7')
  AND (SELECT partner_id = '81000000-0000-0000-0000-0000000000d7' AND org_id = current_setting('test.org_t')::uuid
         FROM public.touches WHERE id = '86000000-0000-0000-0000-0000000000d7')
  AND (SELECT partner_id = '81000000-0000-0000-0000-0000000000d7' AND org_id = current_setting('test.org_t')::uuid
         FROM public.follow_ups WHERE id = '87000000-0000-0000-0000-0000000000d7'),
  'the referral, touch, and follow-up now point at the team''s partner'
);
SELECT ok(
  (SELECT org_id = current_setting('test.org_t')::uuid AND assigned_to = 'a1000000-0000-0000-0000-0000000000d7'
     FROM public.cases WHERE id = '84000000-0000-0000-0000-0000000000d7')
  AND (SELECT org_id = current_setting('test.org_t')::uuid AND carrier = 'Aetna' AND plan_name = 'PPO'
         FROM public.case_benefits WHERE case_id = '84000000-0000-0000-0000-0000000000d7'),
  'the case (still assigned to the practitioner) and its insurance plan arrived'
);
SELECT ok(
  (SELECT v.org_id = current_setting('test.org_t')::uuid AND v.partner_id = '81000000-0000-0000-0000-0000000000d7'
          AND f.org_id = v.org_id
     FROM public.vob_requests v JOIN public.follow_ups f ON f.id = v.follow_up_id
    WHERE v.id = '8a000000-0000-0000-0000-0000000000d7'),
  'the VOB request and its chase follow-up arrived, pointing at the team''s partner'
);
SELECT ok(
  (SELECT org_id = current_setting('test.org_t')::uuid AND assigned_partner_id = '81000000-0000-0000-0000-0000000000d7'
     FROM public.match_profiles WHERE id = '88000000-0000-0000-0000-0000000000d7')
  AND (SELECT org_id = current_setting('test.org_t')::uuid AND chosen_partner_id = '81000000-0000-0000-0000-0000000000d7'
              AND referral_id = '85000000-0000-0000-0000-0000000000d7'
         FROM public.placement_decisions WHERE id = '89000000-0000-0000-0000-0000000000d7'),
  'the match profile and its placement decision arrived'
);
SELECT ok(
  (SELECT org_id = current_setting('test.org_t')::uuid FROM public.partners WHERE id = '83000000-0000-0000-0000-0000000000d7')
  AND (SELECT count(*) = 2 AND bool_and(org_id = current_setting('test.org_t')::uuid)
         AND bool_or(target_id = '81000000-0000-0000-0000-0000000000d7') AND bool_or(target_id = '83000000-0000-0000-0000-0000000000d7')
         FROM public.user_favorites WHERE user_id = 'a1000000-0000-0000-0000-0000000000d7'),
  'the private partner moved and both favorites survived (the merged one now targets the team copy)'
);
SELECT ok(
  (SELECT org_id = current_setting('test.org_t')::uuid FROM public.push_tokens WHERE expo_push_token = 'ExponentPushToken[solohardening0001]')
  AND (SELECT count(*) = 1 AND bool_and(org_id = current_setting('test.org_t')::uuid AND partner_id = '81000000-0000-0000-0000-0000000000d7')
         FROM public.outreach_drafts WHERE user_id = 'a1000000-0000-0000-0000-0000000000d7'),
  'the device token and the AI draft history were not cascaded away'
);

SELECT ok(
  (SELECT bool_and(condeferrable) FROM pg_constraint
    WHERE conname IN ('case_benefits_case_org_fk', 'vob_requests_case_org_fk', 'vob_requests_partner_org_fk', 'vob_requests_follow_up_org_fk',
                      'placement_decisions_match_org_fk', 'placement_decisions_partner_org_fk', 'placement_decisions_case_org_fk',
                      'placement_decisions_referral_org_fk')
    HAVING count(*) = 8),
  'the insurance and placement composite FKs are deferrable'
);

-- Round 2, item 4: a second solo practitioner with a profile joins a team
-- that now owns one; the joiner's profile is left live, unowned, reviewed.
SELECT set_config('request.jwt.claim.sub', 'a3000000-0000-0000-0000-0000000000d7', true);
SET LOCAL ROLE authenticated;
SELECT public.upsert_org_directory_profile('{"name":"Two","organization":"Solo Two Interventions","types":["Interventionist"],"phone":"(541) 555-1240"}'::jsonb);
SELECT lives_ok(
  $$ SELECT public.accept_org_invite(current_setting('test.invite2')) $$,
  'a second solo practitioner with a profile joins'
);
SET CONSTRAINTS ALL IMMEDIATE;
RESET ROLE;
SELECT ok(
  (SELECT owner_org_id IS NULL AND status = 'active' FROM public.global_partners WHERE organization = 'Solo Two Interventions')
  AND (SELECT kind = 'orphaned_profile' AND org_id = current_setting('test.org_t')::uuid AND status = 'pending'
         FROM public.directory_review_requests
        WHERE global_partner_id = (SELECT id FROM public.global_partners WHERE organization = 'Solo Two Interventions')),
  'the team keeps one profile; the joiner''s stays live, unowned, and is queued for the admin'
);
SELECT ok(
  position('WHERE user_id = v_user FOR UPDATE' in pg_get_functiondef('public.accept_org_invite(text)'::regprocedure)) > 0,
  'accept_org_invite locks the caller''s membership row'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- Finding 4: a member deleting their account leaves the practice's records
-- ═══════════════════════════════════════════════════════════════════════════

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000d7', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$ SELECT public.delete_own_account() $$,
  'the practitioner, now a team member, deletes their account'
);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

SELECT ok(
  (SELECT owner_id IS NULL AND carrier = 'Aetna' FROM public.case_benefits WHERE case_id = '84000000-0000-0000-0000-0000000000d7'),
  'the case''s insurance plan stays with the practice, attribution cleared'
);
SELECT ok(
  (SELECT owner_id IS NULL FROM public.vob_requests WHERE id = '8a000000-0000-0000-0000-0000000000d7')
  AND (SELECT owner_id IS NULL FROM public.placement_decisions WHERE id = '89000000-0000-0000-0000-0000000000d7')
  AND EXISTS (SELECT 1 FROM public.cases WHERE id = '84000000-0000-0000-0000-0000000000d7'),
  'VOB requests and placement decisions stay with the practice too'
);
SELECT ok(
  (SELECT bool_and(is_nullable = 'YES') FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'owner_id'
      AND table_name IN ('case_benefits', 'vob_requests', 'placement_decisions'))
  AND (SELECT bool_and(confdeltype = 'n') FROM pg_constraint
        WHERE conname IN ('case_benefits_owner_id_fkey', 'vob_requests_owner_id_fkey', 'placement_decisions_owner_id_fkey')),
  'owner_id is a nullable ON DELETE SET NULL audit pointer on all three tables'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- Finding 8: cross-tenant references
-- ═══════════════════════════════════════════════════════════════════════════

SELECT set_config('request.jwt.claim.sub', 'e1000000-0000-0000-0000-0000000000d7', true);
SET LOCAL ROLE authenticated;
INSERT INTO public.partners (id, owner_id, name) VALUES ('95000000-0000-0000-0000-0000000000d7', 'e1000000-0000-0000-0000-0000000000d7', 'X1 partner');
INSERT INTO public.follow_ups (id, owner_id, title, due_on)
VALUES ('96000000-0000-0000-0000-0000000000d7', 'e1000000-0000-0000-0000-0000000000d7', 'X1 private follow-up', CURRENT_DATE);
INSERT INTO public.referrals (id, owner_id, partner_id, direction, referred_on)
VALUES ('97000000-0000-0000-0000-0000000000d7', 'e1000000-0000-0000-0000-0000000000d7', '95000000-0000-0000-0000-0000000000d7', 'outbound', CURRENT_DATE);

SELECT set_config('request.jwt.claim.sub', 'e2000000-0000-0000-0000-0000000000d7', true);
INSERT INTO public.cases (id, owner_id, title) VALUES ('98000000-0000-0000-0000-0000000000d7', 'e2000000-0000-0000-0000-0000000000d7', 'X2 case');
INSERT INTO public.match_profiles (id, owner_id, client_label) VALUES ('99000000-0000-0000-0000-0000000000d7', 'e2000000-0000-0000-0000-0000000000d7', 'X2 match');

SELECT throws_ok(
  $$ SELECT * FROM public.request_vob('{"case_id":"98000000-0000-0000-0000-0000000000d7","program_name":"Prog","follow_up_id":"96000000-0000-0000-0000-0000000000d7"}'::jsonb) $$,
  'P0002',
  'Follow-up not found',
  'request_vob refuses another workspace''s follow-up id'
);
SELECT throws_ok(
  $$ INSERT INTO public.placement_decisions (owner_id, match_profile_id, referral_id, chosen_rank)
     VALUES ('e2000000-0000-0000-0000-0000000000d7', '99000000-0000-0000-0000-0000000000d7', '97000000-0000-0000-0000-0000000000d7', 1) $$,
  '23503',
  NULL,
  'a placement decision cannot reference another workspace''s referral'
);
SELECT lives_ok(
  $$ SELECT * FROM public.request_vob('{"case_id":"98000000-0000-0000-0000-0000000000d7","program_name":"Prog"}'::jsonb) $$,
  'request_vob still works with a new follow-up'
);
RESET ROLE;

SELECT throws_ok(
  $$ UPDATE public.vob_requests SET follow_up_id = '96000000-0000-0000-0000-0000000000d7'
      WHERE org_id = (SELECT org_id FROM public.org_members WHERE user_id = 'e2000000-0000-0000-0000-0000000000d7') $$,
  '23503',
  NULL,
  'the VOB follow-up link is an org-scoped foreign key'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- Finding 5: established workspaces only
-- ═══════════════════════════════════════════════════════════════════════════

SELECT set_config('request.jwt.claim.sub', '', true);
INSERT INTO public.global_partners (id, name, organization, types, phone, status, verified_at)
VALUES ('d6000000-0000-0000-0000-0000000000d7', 'Admissions', 'Floor Test Recovery', ARRAY['Inpatient'], '(541) 555-0950', 'active', now());
INSERT INTO public.partners (id, owner_id, name, organization, global_partner_id)
SELECT ('9a00000' || n || '-0000-0000-0000-0000000000d7')::uuid, ('f' || n || '000000-0000-0000-0000-0000000000d7')::uuid,
       'Admissions', 'Floor Test Recovery', 'd6000000-0000-0000-0000-0000000000d7'
  FROM generate_series(1, 5) AS n;
INSERT INTO public.referrals (owner_id, partner_id, direction, referred_on, admitted)
SELECT ('f' || n || '000000-0000-0000-0000-0000000000d7')::uuid, ('9a00000' || n || '-0000-0000-0000-0000000000d7')::uuid,
       'outbound', CURRENT_DATE - 10, (n % 2 = 0)
  FROM generate_series(1, 5) AS n, generate_series(1, 2) AS k;
SELECT set_config('test.org_f1', org_id::text, true) FROM public.org_members WHERE user_id = 'f1000000-0000-0000-0000-0000000000d7';
INSERT INTO public.org_entitlements (org_id, entitlement, active, source)
VALUES (current_setting('test.org_f1')::uuid, 'benchmarks', true, 'manual');

SELECT ok(
  NOT public.org_is_established(current_setting('test.org_f1')::uuid),
  'a brand-new workspace is not established, whatever it records'
);

SELECT lives_ok($$ SELECT public.refresh_global_partner_stats() $$, 'stats refresh with five fresh workspaces');
SELECT set_config('request.jwt.claim.sub', 'f2000000-0000-0000-0000-0000000000d7', true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (SELECT NOT disclosed AND importing_orgs IS NULL AND admit_rate IS NULL
     FROM public.fetch_global_partner_stats(ARRAY['d6000000-0000-0000-0000-0000000000d7'::uuid])),
  'five free, fresh workspaces do not satisfy the five-workspace floor'
);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT ok(
  NOT EXISTS (SELECT 1 FROM public.benchmark_cohort_orgs() WHERE org_id = current_setting('test.org_f1')::uuid),
  'a fresh benchmarks subscriber is not part of the benchmark cohort'
);

-- Age alone is not enough: 90 days old but only two referrals each.
UPDATE public.orgs SET created_at = now() - interval '90 days'
 WHERE id IN (SELECT org_id FROM public.org_members WHERE user_id::text LIKE 'f_000000-0000-0000-0000-0000000000d7');
SELECT ok(
  NOT public.org_is_established(current_setting('test.org_f1')::uuid),
  'an old workspace with almost no activity is not established'
);

-- Volume in one sitting is not enough either: activity must span 10 days.
INSERT INTO public.cases (owner_id, title)
SELECT ('f' || n || '000000-0000-0000-0000-0000000000d7')::uuid, 'Same-day fixture'
  FROM generate_series(1, 5) AS n, generate_series(1, 3) AS k;
SELECT ok(
  NOT public.org_is_established(current_setting('test.org_f1')::uuid),
  'three cases created on one day do not make a workspace established'
);

-- A client cannot backdate activity: created_at is server-set.
SELECT set_config('request.jwt.claim.sub', 'f1000000-0000-0000-0000-0000000000d7', true);
SET LOCAL ROLE authenticated;
INSERT INTO public.cases (owner_id, title, created_at)
VALUES ('f1000000-0000-0000-0000-0000000000d7', 'Backdated by a client', now() - interval '300 days');
UPDATE public.referrals SET created_at = now() - interval '300 days' WHERE owner_id = 'f1000000-0000-0000-0000-0000000000d7';
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT ok(
  (SELECT created_at > now() - interval '1 minute' FROM public.cases WHERE title = 'Backdated by a client')
  AND (SELECT bool_and(created_at > now() - interval '1 minute') FROM public.referrals WHERE owner_id = 'f1000000-0000-0000-0000-0000000000d7')
  AND NOT public.org_is_established(current_setting('test.org_f1')::uuid),
  'client-supplied created_at values are ignored on insert and update'
);

-- Server-side history on ten distinct days (as an imported backlog would be).
INSERT INTO public.cases (owner_id, title, created_at)
SELECT ('f' || n || '000000-0000-0000-0000-0000000000d7')::uuid, 'History fixture', now() - make_interval(days => d)
  FROM generate_series(1, 5) AS n, generate_series(1, 10) AS d;
SELECT ok(
  public.org_is_established(current_setting('test.org_f1')::uuid),
  '60+ days old, 3+ cases, activity on 10+ days: established'
);
SELECT lives_ok($$ SELECT public.refresh_global_partner_stats() $$, 'stats refresh with five established workspaces');
SELECT set_config('request.jwt.claim.sub', 'f2000000-0000-0000-0000-0000000000d7', true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (SELECT disclosed AND importing_orgs = 5 AND referrals_12m = 10 AND admit_rate = 0.4
     FROM public.fetch_global_partner_stats(ARRAY['d6000000-0000-0000-0000-0000000000d7'::uuid])),
  'five established workspaces unlock the network figures'
);
UPDATE public.orgs SET created_at = '2001-01-01', name = 'Renamed practice' WHERE id = (SELECT public.current_org_id());
RESET ROLE;
SELECT ok(
  (SELECT name = 'Renamed practice' AND created_at > '2020-01-01'::timestamptz FROM public.orgs
    WHERE id = (SELECT org_id FROM public.org_members WHERE user_id = 'f2000000-0000-0000-0000-0000000000d7')),
  'a workspace owner can rename the workspace but never backdate it'
);
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT ok(
  EXISTS (SELECT 1 FROM public.benchmark_cohort_orgs() WHERE org_id = current_setting('test.org_f1')::uuid),
  'an established benchmarks subscriber joins the benchmark cohort'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.org_is_established(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.benchmark_cohort_orgs()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.org_is_established(uuid)', 'EXECUTE'),
  'the established-workspace helpers are internal'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- Finding 7: transient push failures stay retryable
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO public.push_tokens (expo_push_token, user_id, org_id, platform)
VALUES ('ExponentPushToken[teamowner0000001]', 'a2000000-0000-0000-0000-0000000000d7', current_setting('test.org_t')::uuid, 'ios');
INSERT INTO public.notification_outbox (id, user_id, kind, title, body, claimed_at, attempts)
VALUES ('9b000000-0000-0000-0000-0000000000d7', 'a2000000-0000-0000-0000-0000000000d7', 'new_lead', 'New lead waiting', 'x', now(), 1),
       ('9c000000-0000-0000-0000-0000000000d7', 'a2000000-0000-0000-0000-0000000000d7', 'new_lead', 'New lead waiting', 'y', now(), 1);

SELECT is(
  public.push_outbox_record(
    '[{"id":"9b000000-0000-0000-0000-0000000000d7","tickets":[],"error":"Expo push API answered 503","retry":true},
      {"id":"9c000000-0000-0000-0000-0000000000d7","tickets":[],"error":"MessageTooBig"}]'::jsonb, NULL),
  2,
  'the dispatcher records a transient and a permanent failure'
);
SELECT ok(
  (SELECT error IS NULL AND sent_at IS NULL AND last_error = 'Expo push API answered 503'
     FROM public.notification_outbox WHERE id = '9b000000-0000-0000-0000-0000000000d7')
  AND (SELECT error = 'MessageTooBig' FROM public.notification_outbox WHERE id = '9c000000-0000-0000-0000-0000000000d7'),
  'a transient failure stays queued with its reason; a permanent one is final'
);
UPDATE public.notification_outbox SET claimed_at = now() - interval '6 minutes'
 WHERE id IN ('9b000000-0000-0000-0000-0000000000d7', '9c000000-0000-0000-0000-0000000000d7');
SELECT is(
  (SELECT array_agg(c.id::text) FROM public.push_outbox_claim(100) c),
  ARRAY['9b000000-0000-0000-0000-0000000000d7'],
  'the next run claims only the retryable row'
);
SELECT is(
  (SELECT attempts FROM public.notification_outbox WHERE id = '9b000000-0000-0000-0000-0000000000d7'),
  2,
  'as attempt two'
);
UPDATE public.notification_outbox SET attempts = 5, claimed_at = now() - interval '6 minutes'
 WHERE id = '9b000000-0000-0000-0000-0000000000d7';
SELECT is(
  (SELECT count(*)::integer FROM public.push_outbox_claim(100)),
  0,
  'after five attempts the row is given up'
);
SELECT is(
  (SELECT error FROM public.notification_outbox WHERE id = '9b000000-0000-0000-0000-0000000000d7'),
  'too_many_attempts',
  'and marked too_many_attempts'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- Replays: complete_follow_up_with_next, assign_match_referral,
-- finalize_match_packet; check-in scheduling slack
-- ═══════════════════════════════════════════════════════════════════════════

SELECT set_config('request.jwt.claim.sub', 'a2000000-0000-0000-0000-0000000000d7', true);
SET LOCAL ROLE authenticated;

INSERT INTO public.follow_ups (id, owner_id, title, due_on, note)
VALUES ('a0100000-0000-0000-0000-0000000000d7', 'a2000000-0000-0000-0000-0000000000d7', 'Call the program', CURRENT_DATE, 'server note');

SELECT lives_ok(
  $$ SELECT public.complete_follow_up_with_next(
       jsonb_build_object('id', 'a0100000-0000-0000-0000-0000000000d7', 'title', 'Stale title', 'due_on', '2020-01-01',
                          'status', 'done', 'completed_at', now()::text, 'note', 'stale note', 'kind', 'consult'),
       jsonb_build_object('id', 'a0200000-0000-0000-0000-0000000000d7', 'title', 'Next step', 'due_on', CURRENT_DATE::text,
                          'status', 'open', 'kind', 'follow_up'),
       NULL) $$,
  'complete with next step'
);
UPDATE public.follow_ups SET status = 'done', completed_at = now(), note = 'finished later'
 WHERE id = 'a0200000-0000-0000-0000-0000000000d7';
SELECT lives_ok(
  $$ SELECT public.complete_follow_up_with_next(
       jsonb_build_object('id', 'a0100000-0000-0000-0000-0000000000d7', 'title', 'Stale title', 'due_on', '2020-01-01',
                          'status', 'done', 'completed_at', now()::text, 'note', 'stale note', 'kind', 'consult'),
       jsonb_build_object('id', 'a0200000-0000-0000-0000-0000000000d7', 'title', 'Next step', 'due_on', CURRENT_DATE::text,
                          'status', 'open', 'kind', 'follow_up'),
       NULL) $$,
  'the queued op replays'
);
SELECT ok(
  (SELECT status = 'done' AND note = 'finished later' FROM public.follow_ups WHERE id = 'a0200000-0000-0000-0000-0000000000d7')
  AND (SELECT status = 'done' AND title = 'Call the program' AND due_on = CURRENT_DATE AND note = 'server note' AND kind = 'follow_up'
         FROM public.follow_ups WHERE id = 'a0100000-0000-0000-0000-0000000000d7'),
  'a replay never re-opens the finished next step or rewrites the completed one'
);

SELECT lives_ok(
  $$ SELECT public.assign_match_referral(
       'a2000000-0000-0000-0000-0000000000d7'::uuid,
       '{"id":"a0300000-0000-0000-0000-0000000000d7","partner_id":"81000000-0000-0000-0000-0000000000d7","direction":"outbound","referred_on":"2026-10-20","client_label":"M.R.","outcome":"Pending","note":""}'::jsonb,
       '{"id":"a0400000-0000-0000-0000-0000000000d7","client_label":"M.R.","level_of_care":"Residential","state":"OR","insurance":"Aetna","status":"Referred","assigned_partner_id":"81000000-0000-0000-0000-0000000000d7","must_have_therapies":["MAT","Trauma"],"population":"Women","location_preference":"Away from home"}'::jsonb
     ) $$,
  'an assignment creates the match and the referral'
);
SELECT is(
  (SELECT array_to_string(must_have_therapies, ',') || '|' || population || '|' || location_preference
     FROM public.match_profiles WHERE id = 'a0400000-0000-0000-0000-0000000000d7'),
  'MAT,Trauma|Women|Away from home',
  'a match created by assign_match_referral keeps its requirements'
);
SELECT lives_ok(
  $$ SELECT public.record_placement_outcome('a0300000-0000-0000-0000-0000000000d7',
       jsonb_build_object('admitted', true, 'admitted_on', (CURRENT_DATE - 8)::text, 'family_experience', 5,
                          'outcome', 'Placed', 'outcome_note', 'Went well', 'completed', true)) $$,
  'the outcome is recorded'
);
SELECT is(
  (SELECT string_agg(check_in_days::text, ',' ORDER BY check_in_days) FROM public.follow_ups
    WHERE referral_id = 'a0300000-0000-0000-0000-0000000000d7' AND kind = 'check_in'),
  '7,30,90',
  'a check-in that fell due yesterday (UTC) is still created'
);
SELECT lives_ok(
  $$ SELECT public.assign_match_referral(
       'a2000000-0000-0000-0000-0000000000d7'::uuid,
       '{"id":"a0300000-0000-0000-0000-0000000000d7","partner_id":"81000000-0000-0000-0000-0000000000d7","direction":"outbound","referred_on":"2026-10-20","client_label":"M.R.","outcome":"Pending","note":""}'::jsonb,
       '{"id":"a0400000-0000-0000-0000-0000000000d7","client_label":"M.R.","status":"Referred","assigned_partner_id":"81000000-0000-0000-0000-0000000000d7"}'::jsonb
     ) $$,
  'the queued assignment replays'
);
SELECT is(
  (SELECT (admitted, admitted_on = CURRENT_DATE - 8, family_experience, outcome, outcome_note, completed)::text
     FROM public.referrals WHERE id = 'a0300000-0000-0000-0000-0000000000d7'),
  '(t,t,5,Placed,"Went well",t)',
  'a replayed assignment keeps the recorded outcome'
);
SELECT is(
  (SELECT array_to_string(must_have_therapies, ',') || '|' || population FROM public.match_profiles WHERE id = 'a0400000-0000-0000-0000-0000000000d7'),
  'MAT,Trauma|Women',
  'a replay without the requirement keys leaves them as they were'
);

SELECT lives_ok(
  $$ SELECT public.finalize_match_packet(
       'a2000000-0000-0000-0000-0000000000d7'::uuid,
       '{"id":"a0500000-0000-0000-0000-0000000000d7","partner_id":"81000000-0000-0000-0000-0000000000d7","direction":"outbound","referred_on":"2026-10-21","client_label":"J.K.","outcome":"Pending","note":"","packet_sent_at":"2026-10-21T16:00:00Z"}'::jsonb,
       '{"id":"a0600000-0000-0000-0000-0000000000d7","client_label":"J.K.","level_of_care":"Residential","state":"OR","insurance":"Aetna","status":"Referred","assigned_partner_id":"81000000-0000-0000-0000-0000000000d7","must_have_therapies":[],"population":"Men","location_preference":"Close to family"}'::jsonb,
       '{"id":"a0700000-0000-0000-0000-0000000000d7","partner_id":"81000000-0000-0000-0000-0000000000d7","kind":"email","note":"Packet sent","occurred_at":"2026-10-21T16:00:00Z"}'::jsonb,
       '{"id":"a0800000-0000-0000-0000-0000000000d7","partner_id":"81000000-0000-0000-0000-0000000000d7","title":"Check placement","due_on":"2026-10-22","status":"open","kind":"follow_up"}'::jsonb,
       NULL) $$,
  'packet finalization creates a match that was never saved on its own'
);
SELECT is(
  (SELECT coalesce(array_to_string(must_have_therapies, ','), 'null') || '|' || population || '|' || location_preference || '|' || referral_id::text
     FROM public.match_profiles WHERE id = 'a0600000-0000-0000-0000-0000000000d7'),
  '|Men|Close to family|a0500000-0000-0000-0000-0000000000d7',
  'a match created by finalize_match_packet keeps its requirements'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
