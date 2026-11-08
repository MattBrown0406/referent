-- Focused coverage for 20261108180000_partner_import.sql: partners from
-- contacts and a spreadsheet (import_partners), and program referrals in the
-- referral history (the inbound log, case_program_referral, and
-- log_program_referral). Run after a local migration reset with:
-- supabase test db
--
-- This file is never pasted into production.

BEGIN;
SELECT plan(48);

-- Actors
--   p1  owner of practice P (profile listing I1, Cascade Interventions)
--   p2  member of practice P
--   x1  owner of another practice X
--   c1  center account of program L1, already in P's network
--   c4  center account of program L4, not in P's network
--   c5  center account of program L5, archived after it refers
INSERT INTO auth.users (id, email)
VALUES
  ('b1000000-0000-0000-0000-0000000000a7', 'pimport-p1@example.test'),
  ('b2000000-0000-0000-0000-0000000000a7', 'pimport-p2@example.test'),
  ('b3000000-0000-0000-0000-0000000000a7', 'pimport-x1@example.test'),
  ('c1000000-0000-0000-0000-0000000000a7', 'pimport-c1@example.test'),
  ('c4000000-0000-0000-0000-0000000000a7', 'pimport-c4@example.test'),
  ('c5000000-0000-0000-0000-0000000000a7', 'pimport-c5@example.test');

SELECT set_config('test.org_p', org_id::text, true) FROM public.org_members WHERE user_id = 'b1000000-0000-0000-0000-0000000000a7';
SELECT set_config('test.org_x', org_id::text, true) FROM public.org_members WHERE user_id = 'b3000000-0000-0000-0000-0000000000a7';
UPDATE public.org_members SET org_id = current_setting('test.org_p')::uuid, role = 'member'
 WHERE user_id = 'b2000000-0000-0000-0000-0000000000a7';

INSERT INTO public.global_partners (id, name, organization, types, city, state, status, verified_at, owner_org_id)
VALUES
  ('d1000000-0000-0000-0000-0000000000a7', 'Admissions', 'Juniper Ridge Recovery', ARRAY['Inpatient'], 'Bend', 'OR', 'active', now(), NULL),
  ('d3000000-0000-0000-0000-0000000000a7', 'Intake', 'Willow Detox', ARRAY['Detox'], 'Eugene', 'OR', 'active', now(), NULL),
  ('d4000000-0000-0000-0000-0000000000a7', 'Admissions', 'Cedar House', ARRAY['Inpatient'], 'Salem', 'OR', 'active', now(), NULL),
  ('d5000000-0000-0000-0000-0000000000a7', 'Admissions', 'Fading Oaks', ARRAY['Inpatient'], 'Medford', 'OR', 'active', now(), NULL),
  ('d6000000-0000-0000-0000-0000000000a7', 'Intake', 'Closed Pines', ARRAY['Inpatient'], 'Salem', 'OR', 'archived', now(), NULL),
  ('d9000000-0000-0000-0000-0000000000a7', 'Dana Cole', 'Cascade Interventions', ARRAY['Interventionist'], 'Portland', 'OR', 'active', now(),
   current_setting('test.org_p')::uuid);
INSERT INTO public.center_members (user_id, global_partner_id)
VALUES ('c1000000-0000-0000-0000-0000000000a7', 'd1000000-0000-0000-0000-0000000000a7'),
       ('c4000000-0000-0000-0000-0000000000a7', 'd4000000-0000-0000-0000-0000000000a7'),
       ('c5000000-0000-0000-0000-0000000000a7', 'd5000000-0000-0000-0000-0000000000a7');

-- P already has Juniper Ridge (L1) in its network, from the Directory.
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT set_config('test.partner_l1', public.import_global_partner('d1000000-0000-0000-0000-0000000000a7', gen_random_uuid())::text, true);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

-- ===========================================================================
-- A. Grants
-- ===========================================================================

SELECT ok(
  (SELECT bool_and(has_function_privilege('authenticated', f, 'EXECUTE') AND NOT has_function_privilege('anon', f, 'EXECUTE'))
     FROM unnest(ARRAY['public.import_partners(jsonb)', 'public.log_program_referral(uuid, date)',
                       'public.case_program_referral(uuid)']) AS f),
  'signed-in users may call the RPCs; anon may not'
);
SELECT ok(
  (SELECT bool_and(NOT has_function_privilege('authenticated', f, 'EXECUTE') AND NOT has_function_privilege('anon', f, 'EXECUTE'))
     FROM unnest(ARRAY['public.import_partner_row(uuid, uuid, jsonb, jsonb, jsonb)', 'public.import_partner_website(text)',
                       'public.import_partner_keys(text, text, text, text, boolean)',
                       'public.program_referral_network_partner(uuid, uuid)', 'public.program_referrals_log_inbound()']) AS f),
  'the helpers are not callable by clients'
);
SELECT ok(
  (SELECT bool_and(p.prosecdef AND p.proconfig @> ARRAY['search_path=public'])
     FROM pg_proc p
    WHERE p.oid IN ('public.import_partners(jsonb)'::regprocedure, 'public.log_program_referral(uuid, date)'::regprocedure,
                    'public.case_program_referral(uuid)'::regprocedure, 'public.import_partner_row(uuid, uuid, jsonb, jsonb, jsonb)'::regprocedure)),
  'the RPCs are SECURITY DEFINER with a pinned search_path'
);

-- ===========================================================================
-- B. Importing partners
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.import_partners('[]'::jsonb) $$, '22023', 'Choose at least one contact to add.', 'nothing to import');
SELECT throws_ok($$ SELECT public.import_partners('{"name": "x"}'::jsonb) $$, '22023', NULL, 'rows come as a list');
SELECT throws_ok(
  $$ SELECT public.import_partners((SELECT jsonb_agg(jsonb_build_object('name', 'n' || g, 'types', '["Therapist"]'::jsonb)) FROM generate_series(1, 501) g)) $$,
  '22023', 'Add up to 500 partners at a time.', 'at most 500 at a time');
SELECT set_config('test.import1', public.import_partners(jsonb_build_array(
  jsonb_build_object('global_id', 'd3000000-0000-0000-0000-0000000000a7'),
  jsonb_build_object('name', ' Jane Doe ', 'organization', 'Harbor Therapy', 'types', jsonb_build_array('Therapist', 'Bogus'),
                     'email', ' Jane@Harbor.TEST ', 'phone', '(503) 555-0199', 'city', 'Portland', 'state', 'or',
                     'website', 'javascript:alert(1)', 'note', 'Met at the Bend conference'),
  jsonb_build_object('name', 'J. Doe', 'organization', 'Elsewhere', 'types', jsonb_build_array('Therapist'), 'email', 'jane@harbor.test'),
  jsonb_build_object('name', 'Phone Twin', 'organization', 'Twin Co', 'types', jsonb_build_array('Detox'), 'phone', '+1 503-555-0199'),
  jsonb_build_object('name', 'Sam Reyes', 'types', jsonb_build_array('Interventionist'), 'website', 'samreyes.example'),
  jsonb_build_object('name', '', 'organization', '', 'types', jsonb_build_array('Therapist')),
  jsonb_build_object('name', 'No Type', 'organization', 'Typeless', 'types', jsonb_build_array('Bogus')),
  jsonb_build_object('global_id', 'd1000000-0000-0000-0000-0000000000a7'),
  jsonb_build_object('global_id', 'd6000000-0000-0000-0000-0000000000a7'),
  '"not an object"'::jsonb
))::text, true);
RESET ROLE;
SELECT is((current_setting('test.import1')::jsonb ->> 'added')::integer, 2, 'two of the practice''s own contacts are added');
SELECT is((current_setting('test.import1')::jsonb ->> 'linked')::integer, 1, 'one Directory listing is linked');
SELECT is((current_setting('test.import1')::jsonb ->> 'skipped')::integer, 7,
  'duplicates (email, phone, a listing already in the network), empty rows, rows without a known type, archived listings and junk are skipped');
SELECT is(jsonb_array_length(current_setting('test.import1')::jsonb -> 'ids'), 3, 'the new partners'' ids come back');
SELECT is(
  (SELECT row(p.name, p.organization, p.types, p.levels, p.email, p.phone, p.city, p.state, p.website, p.note, p.owner_id, p.org_id)::text
     FROM public.partners p WHERE p.organization = 'Harbor Therapy'),
  row('Jane Doe', 'Harbor Therapy', ARRAY['Therapist'], ARRAY['Therapist'], 'jane@harbor.test', '(503) 555-0199', 'Portland', 'OR', '',
      'Met at the Bend conference', 'b1000000-0000-0000-0000-0000000000a7'::uuid, current_setting('test.org_p')::uuid)::text,
  'an own contact is cleaned: known types only, lower-case email, two-letter state, no javascript: website, the caller as author'
);
SELECT is(
  (SELECT row(p.organization, p.website, p.city, p.state)::text FROM public.partners p WHERE p.name = 'Sam Reyes'),
  row('Sam Reyes', 'samreyes.example', chr(8212), chr(8212))::text,
  'a person without an organization is their own organization; a bare host is kept; blanks read as a dash, like the app'
);
SELECT is(
  (SELECT count(*)::integer FROM public.partners p WHERE p.org_id = current_setting('test.org_p')::uuid
      AND p.global_partner_id = 'd3000000-0000-0000-0000-0000000000a7' AND p.organization = 'Willow Detox'),
  1, 'a Directory row imports the listing itself'
);
SELECT is((SELECT count(*)::integer FROM public.partners WHERE org_id = current_setting('test.org_x')::uuid), 0,
  'nothing lands in another workspace');

SELECT set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT is(
  public.import_partners(jsonb_build_array(
    jsonb_build_object('global_id', 'd3000000-0000-0000-0000-0000000000a7'),
    jsonb_build_object('name', 'Jane Doe', 'organization', 'Harbor Therapy', 'types', jsonb_build_array('Therapist')))) ->> 'skipped',
  '2', 'the same import again, by a teammate, adds nothing'
);
RESET ROLE;
SELECT is(public.import_partner_website('https://ok.example/path?a=1'), 'https://ok.example/path?a=1', 'an https website is kept');
SELECT is(public.import_partner_website('data:text/html,hi'), '', 'any other scheme is dropped');
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT public.import_partners(jsonb_build_array(
  jsonb_build_object('name', 'Order Kept', 'types', jsonb_build_array('Therapist', 'Interventionist', 'Therapist')),
  jsonb_build_object('name', 'Loose Fields', 'types', jsonb_build_array('Detox'), 'state', 'Texas', 'email', E'a@b.co\nBcc: x@y.z')));
RESET ROLE;
SELECT is((SELECT types FROM public.partners WHERE name = 'Order Kept'), ARRAY['Therapist', 'Interventionist'],
  'types keep the order given (the first is the main type), each once');
SELECT is((SELECT row(state, email)::text FROM public.partners WHERE name = 'Loose Fields'), row(chr(8212), '')::text,
  'a state that is not two letters, and an email with a line break, are dropped');

-- ===========================================================================
-- C. A referral from a program already in the network is logged
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000a7', true);
SELECT set_config('request.jwt.claims', '{"sub": "c1000000-0000-0000-0000-0000000000a7", "role": "authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT set_config('test.ref1', public.program_refer_family('d9000000-0000-0000-0000-0000000000a7', 'Maria', '(503) 555-0101', '',
  'mother', 'Alex', 'none', '', true)::text, true);
SELECT is(auth.uid(), 'c1000000-0000-0000-0000-0000000000a7'::uuid, 'the program''s own session is restored after the log');
SELECT is(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', 'c1000000-0000-0000-0000-0000000000a7',
  'both claim settings are restored (PostgREST sets the JSON one)');
SELECT set_config('request.jwt.claims', '', true);
RESET ROLE;
SELECT set_config('test.case1', case_id::text, true) FROM public.program_referrals WHERE id = current_setting('test.ref1')::uuid;
SELECT is(
  (SELECT row(r.partner_id, r.direction, r.outcome, r.note, r.org_id, r.owner_id, r.client_label = c.title)::text
     FROM public.referrals r JOIN public.cases c ON c.id = r.case_id
    WHERE r.case_id = current_setting('test.case1')::uuid),
  row(current_setting('test.partner_l1')::uuid, 'inbound', 'Pending', 'Referred through ReferralFit.', current_setting('test.org_p')::uuid,
      'b1000000-0000-0000-0000-0000000000a7'::uuid, true)::text,
  'an inbound referral from the program, on the new lead, written as the practice'
);
SELECT ok((SELECT referred_on BETWEEN current_date - 1 AND current_date + 1 FROM public.referrals
            WHERE case_id = current_setting('test.case1')::uuid), 'dated today where the practice is');
SELECT set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT row(in_network, logged, can_log)::text FROM public.case_program_referral(current_setting('test.case1')::uuid)),
  row(true, true, true)::text, 'the case file shows it is in the referral history'
);
SELECT is((public.log_program_referral(current_setting('test.ref1')::uuid, current_date) ->> 'added_partner')::boolean, false,
  'logging again finds the partner');
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.referrals WHERE case_id = current_setting('test.case1')::uuid), 1,
  'and adds no second referral');

-- ===========================================================================
-- D. A program not in the network: one tap adds it and logs the referral
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'c4000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT set_config('test.ref4', public.program_refer_family('d9000000-0000-0000-0000-0000000000a7', 'Rosa', '(503) 555-0144', '',
  'sister', 'Ben', 'none', '', true)::text, true);
RESET ROLE;
SELECT set_config('test.case4', case_id::text, true) FROM public.program_referrals WHERE id = current_setting('test.ref4')::uuid;
SELECT is((SELECT count(*)::integer FROM public.referrals WHERE case_id = current_setting('test.case4')::uuid), 0,
  'nothing is logged for a program outside the network');
SELECT set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT row(in_network, logged, can_log)::text FROM public.case_program_referral(current_setting('test.case4')::uuid)),
  row(false, false, true)::text, 'the case file offers to add it'
);
SELECT set_config('test.log4', public.log_program_referral(current_setting('test.ref4')::uuid, current_date)::text, true);
SELECT is((current_setting('test.log4')::jsonb ->> 'added_partner')::boolean, true, 'the program is added to the network');
SELECT is(
  (SELECT row(in_network, logged)::text FROM public.case_program_referral(current_setting('test.case4')::uuid)),
  row(true, true)::text, 'and the referral is logged'
);
SELECT is(public.log_program_referral(current_setting('test.ref4')::uuid, current_date) ->> 'referral_id',
  current_setting('test.log4')::jsonb ->> 'referral_id', 'a second tap changes nothing');
RESET ROLE;
SELECT is(
  (SELECT row(p.organization, p.global_partner_id, p.owner_id)::text FROM public.partners p
    WHERE p.id = (current_setting('test.log4')::jsonb ->> 'partner_id')::uuid),
  row('Cedar House', 'd4000000-0000-0000-0000-0000000000a7'::uuid, 'b2000000-0000-0000-0000-0000000000a7'::uuid)::text,
  'the partner is the program''s Directory listing, added by the member who tapped'
);
SELECT is(
  (SELECT row(r.direction, r.owner_id, r.referred_on = current_date)::text FROM public.referrals r
    WHERE r.id = (current_setting('test.log4')::jsonb ->> 'referral_id')::uuid),
  row('inbound', 'b2000000-0000-0000-0000-0000000000a7'::uuid, true)::text, 'an inbound referral dated as the device said'
);
DELETE FROM public.referrals WHERE id = (current_setting('test.log4')::jsonb ->> 'referral_id')::uuid;
SELECT set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT logged FROM public.case_program_referral(current_setting('test.case4')::uuid)), false,
  'a referral the practice deleted reads as not logged');
SELECT set_config('test.log4b', public.log_program_referral(current_setting('test.ref4')::uuid, current_date + 30)::text, true);
SELECT ok((SELECT referred_on <> current_date + 30 FROM public.referrals
            WHERE id = (current_setting('test.log4b')::jsonb ->> 'referral_id')::uuid),
  'a device date far from the referral is not used');
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', 'b3000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.log_program_referral(current_setting('test.ref4')::uuid, current_date) $$, 'P0002', 'Referral not found',
  'another workspace cannot log it');
SELECT is((SELECT count(*)::integer FROM public.case_program_referral(current_setting('test.case4')::uuid)), 0,
  'or see it');
RESET ROLE;

-- ===========================================================================
-- E. A program that left the Directory
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'c5000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT set_config('test.ref5', public.program_refer_family('d9000000-0000-0000-0000-0000000000a7', 'Lena', '(503) 555-0177', '',
  'wife', 'Max', 'none', '', true)::text, true);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
UPDATE public.global_partners SET status = 'archived' WHERE id = 'd5000000-0000-0000-0000-0000000000a7';
SELECT set_config('test.case5', case_id::text, true) FROM public.program_referrals WHERE id = current_setting('test.ref5')::uuid;
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT can_log FROM public.case_program_referral(current_setting('test.case5')::uuid)), false,
  'no "Add to network" for a listing that is gone');
SELECT throws_ok($$ SELECT public.log_program_referral(current_setting('test.ref5')::uuid, current_date) $$, 'P0002',
  'This program is no longer listed in the Directory. Add it to your network by hand.', 'and the RPC says so');
RESET ROLE;

-- ===========================================================================
-- F. A history entry that cannot be written never blocks the referral
-- ===========================================================================

CREATE FUNCTION pg_temp.refuse_referrals() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN RAISE EXCEPTION 'refused for the test'; END
$f$;
CREATE TRIGGER zz_refuse BEFORE INSERT ON public.referrals FOR EACH ROW EXECUTE FUNCTION pg_temp.refuse_referrals();
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$ SELECT set_config('test.ref6', public.program_refer_family('d9000000-0000-0000-0000-0000000000a7', 'Iris',
  '(503) 555-0188', '', 'aunt', 'Leo', 'none', '', true)::text, true) $$, 'the program''s referral still goes through');
RESET ROLE;
DROP TRIGGER zz_refuse ON public.referrals;
SELECT is((SELECT count(*)::integer FROM public.referrals r JOIN public.program_referrals pr ON pr.case_id = r.case_id
            WHERE pr.id = current_setting('test.ref6')::uuid), 0, 'with no history entry (the case card can log it)');

-- ===========================================================================
-- G. The platform seed workspace: imported contacts are not published
-- ===========================================================================

INSERT INTO public.platform_admins (user_id) VALUES ('b1000000-0000-0000-0000-0000000000a7');
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT public.import_partners(jsonb_build_array(
  jsonb_build_object('name', 'Intake', 'organization', 'Seed Import Ranch', 'types', jsonb_build_array('Inpatient'), 'website', 'seedranch.test')));
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.global_partners WHERE organization = 'Seed Import Ranch'), 0,
  'a program imported into the seed workspace is not published to the Directory');
SELECT is(coalesce(current_setting('referralfit.syncing', true), ''), '', 'and the publishing switch is back as it was');
DELETE FROM public.platform_admins WHERE user_id = 'b1000000-0000-0000-0000-0000000000a7';

-- ===========================================================================
-- H. Without the Directory, Directory rows are skipped
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.free_launch_period() RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $f$ SELECT false $f$;
SELECT set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT is(public.import_partners(jsonb_build_array(jsonb_build_object('global_id', 'd4000000-0000-0000-0000-0000000000a7'))) ->> 'linked',
  '0', 'a workspace without the Directory cannot add Directory listings through an import');
RESET ROLE;
CREATE OR REPLACE FUNCTION public.free_launch_period() RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $f$ SELECT true $f$;

-- ===========================================================================
-- I. A listing and a person there, in one import
-- ===========================================================================

UPDATE public.global_partners SET phone = '541-555-0199', email = 'intake@juniper.test' WHERE id = 'd1000000-0000-0000-0000-0000000000a7';
SELECT set_config('request.jwt.claim.sub', 'b3000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT is(public.import_partners(jsonb_build_array(
  jsonb_build_object('global_id', 'd1000000-0000-0000-0000-0000000000a7'),
  jsonb_build_object('name', 'Rae', 'organization', 'Juniper Ridge Recovery', 'types', jsonb_build_array('Inpatient'),
                     'phone', '541-555-0199', 'email', 'intake@juniper.test'))) - 'ids',
  '{"added": 1, "linked": 1, "skipped": 0}'::jsonb,
  'a person sharing the program''s main line is still added after its listing');
SELECT is(public.import_partners(jsonb_build_array(jsonb_build_object('name', 'Solo Coach', 'types', jsonb_build_array('Interventionist'))))
            -> 'added', '1'::jsonb, 'a person without an organization is added');
SELECT is(public.import_partners(jsonb_build_array(
  jsonb_build_object('organization', 'Juniper Ridge Recovery', 'types', jsonb_build_array('Inpatient'), 'phone', '541-555-0123'),
  jsonb_build_object('name', 'Juniper Ridge Recovery', 'organization', 'Juniper Ridge Recovery', 'types', jsonb_build_array('Inpatient'))))
            -> 'skipped', '2'::jsonb, 'a company-only card for a program already there is a duplicate');
SELECT is(public.import_partners(jsonb_build_array(
  jsonb_build_object('global_id', 'd3000000-0000-0000-0000-0000000000a7'),
  jsonb_build_object('name', 'Intake', 'organization', 'Willow Detox', 'types', jsonb_build_array('Detox'), 'phone', '541-555-0124'))) - 'ids',
  '{"added": 0, "linked": 1, "skipped": 1}'::jsonb, 'the listing''s own names are not added a second time in the same import');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
