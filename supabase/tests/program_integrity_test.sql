-- Focused coverage for 20261104130000_program_integrity.sql (Program
-- Integrity Watch). Run after a local migration reset with: supabase test db
--
-- This file is never pasted into production.

BEGIN;
SELECT plan(97);

-- Actors
--   s1  platform admin (ReferralFit)
--   c1  center account that claimed L1
--   c2  center account that claimed L2
--   c3  center account that claimed L3 (a pending listing)
--   p1  owner of practice P (imports L1 as PA; private partner PB)
--   p2  member of practice P
--   q1  owner of practice Q (another practice)
--   j1  solo owner of workspace J (imports L1 as JA; private JB), joins P
INSERT INTO auth.users (id, email)
VALUES
  ('a1000000-0000-0000-0000-000000c7ed01', 'integrity-admin@example.test'),
  ('c1000000-0000-0000-0000-000000c7ed01', 'integrity-c1@example.test'),
  ('c2000000-0000-0000-0000-000000c7ed01', 'integrity-c2@example.test'),
  ('c3000000-0000-0000-0000-000000c7ed01', 'integrity-c3@example.test'),
  ('b1000000-0000-0000-0000-000000c7ed01', 'integrity-p1@example.test'),
  ('b2000000-0000-0000-0000-000000c7ed01', 'integrity-p2@example.test'),
  ('b3000000-0000-0000-0000-000000c7ed01', 'integrity-q1@example.test'),
  ('b4000000-0000-0000-0000-000000c7ed01', 'integrity-j1@example.test');

INSERT INTO public.platform_admins (user_id) VALUES ('a1000000-0000-0000-0000-000000c7ed01');

SELECT set_config('test.org_p', org_id::text, true) FROM public.org_members WHERE user_id = 'b1000000-0000-0000-0000-000000c7ed01';
SELECT set_config('test.org_q', org_id::text, true) FROM public.org_members WHERE user_id = 'b3000000-0000-0000-0000-000000c7ed01';
SELECT set_config('test.org_j', org_id::text, true) FROM public.org_members WHERE user_id = 'b4000000-0000-0000-0000-000000c7ed01';
UPDATE public.org_members SET org_id = current_setting('test.org_p')::uuid, role = 'member', display_name = 'Mikayla'
 WHERE user_id = 'b2000000-0000-0000-0000-000000c7ed01';

-- Listings: L1, L2 active and claimed; L3 pending (hidden) and claimed; L4 active, unclaimed.
INSERT INTO public.global_partners (id, name, organization, types, city, state, phone, website, status, verified_at)
VALUES
  ('d1000000-0000-0000-0000-000000c7ed01', 'Admissions', 'Juniper Ridge Recovery', ARRAY['Inpatient'], 'Bend', 'OR', '(541) 555-0710', 'https://juniper.example.org', 'active', now()),
  ('d2000000-0000-0000-0000-000000c7ed01', 'Intake', 'Cedar House', ARRAY['Detox'], 'Salem', 'OR', '(503) 555-0711', NULL, 'active', now()),
  ('d3000000-0000-0000-0000-000000c7ed01', 'Intake', 'Pending Pines', ARRAY['Inpatient'], 'Eugene', 'OR', '(541) 555-0712', NULL, 'pending', NULL),
  ('d4000000-0000-0000-0000-000000c7ed01', 'Intake', 'Unclaimed Oaks', ARRAY['Inpatient'], 'Bend', 'OR', '(541) 555-0713', NULL, 'active', now());
INSERT INTO public.center_members (user_id, global_partner_id)
VALUES
  ('c1000000-0000-0000-0000-000000c7ed01', 'd1000000-0000-0000-0000-000000c7ed01'),
  ('c2000000-0000-0000-0000-000000c7ed01', 'd2000000-0000-0000-0000-000000c7ed01'),
  ('c3000000-0000-0000-0000-000000c7ed01', 'd3000000-0000-0000-0000-000000c7ed01');

-- Practice P imports L1 (PA) and keeps a private partner (PB, PC); Q has QA.
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-000000c7ed01', true);
SET LOCAL ROLE authenticated;
SELECT public.import_global_partner('d1000000-0000-0000-0000-000000c7ed01', 'e1000000-0000-0000-0000-000000c7ed01');
INSERT INTO public.partners (id, owner_id, name, organization, state) VALUES
  ('e2000000-0000-0000-0000-000000c7ed01', 'b1000000-0000-0000-0000-000000c7ed01', 'Intake', 'Private Program', 'OR'),
  ('e6000000-0000-0000-0000-000000c7ed01', 'b1000000-0000-0000-0000-000000c7ed01', 'Intake', 'Busy Program', 'OR');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'b3000000-0000-0000-0000-000000c7ed01', true);
SET LOCAL ROLE authenticated;
INSERT INTO public.partners (id, owner_id, name, organization) VALUES
  ('e3000000-0000-0000-0000-000000c7ed01', 'b3000000-0000-0000-0000-000000c7ed01', 'Intake', 'Q Program');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

-- ===========================================================================
-- A. Schema, grants, production-grant emulation
-- ===========================================================================

SELECT has_table('public', 'program_credentials', 'program_credentials exists');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.program_credentials'::regclass), 'RLS is on');
SELECT ok(
  has_table_privilege('authenticated', 'public.program_credentials', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.program_credentials', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.program_credentials', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.program_credentials', 'DELETE')
  AND NOT has_table_privilege('authenticated', 'public.program_credentials', 'TRUNCATE')
  AND NOT has_table_privilege('authenticated', 'public.program_credentials', 'REFERENCES')
  AND NOT has_table_privilege('authenticated', 'public.program_credentials', 'TRIGGER'),
  'signed-in users hold SELECT only, whatever the default ACL granted (TRUNCATE included)'
);
SELECT ok(
  NOT has_table_privilege('anon', 'public.program_credentials', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.program_credentials', 'INSERT')
  AND NOT has_table_privilege('anon', 'public.program_credentials', 'UPDATE')
  AND NOT has_table_privilege('anon', 'public.program_credentials', 'DELETE')
  AND NOT has_table_privilege('anon', 'public.program_credentials', 'TRUNCATE'),
  'anon holds nothing on the table'
);
SELECT ok(
  (SELECT bool_and(p.prosecdef AND p.proconfig @> ARRAY['search_path=public'])
     FROM pg_proc p
    WHERE p.oid IN ('public.save_program_credential(uuid, uuid, uuid, text, text, text, text, text, date, text, text)'::regprocedure,
                    'public.verify_program_credential(uuid, text, text, timestamptz)'::regprocedure,
                    'public.delete_program_credential(uuid)'::regprocedure,
                    'public.record_npi_lookup(uuid, text)'::regprocedure,
                    'public.list_pending_listing_credentials()'::regprocedure,
                    'public.program_credential_writer_scope(uuid, uuid)'::regprocedure,
                    'public.program_credentials_listing_visible(uuid)'::regprocedure,
                    'public.org_merge_linked_partner_copies(uuid, uuid)'::regprocedure)),
  'every privileged function is SECURITY DEFINER with a pinned search_path'
);
SELECT ok(
  NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'public.fetch_listing_credentials(uuid[])'::regprocedure)
  AND NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'public.listing_credentials_verified(uuid, date)'::regprocedure),
  'the readers run as the caller, so the read policies decide what comes back'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('is_valid_proof_url', 'is_valid_npi', 'program_credential_status', 'program_credentials_listing_visible',
                         'program_credential_problem', 'program_credential_writer_scope', 'save_program_credential',
                         'verify_program_credential', 'delete_program_credential', 'record_npi_lookup', 'fetch_listing_credentials',
                         'listing_credentials_verified', 'list_pending_listing_credentials', 'org_merge_linked_partner_copies')
       AND has_function_privilege('anon', p.oid, 'EXECUTE')),
  'anon can run none of the new functions'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.save_program_credential(uuid, uuid, uuid, text, text, text, text, text, date, text, text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.verify_program_credential(uuid, text, text, timestamptz)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.delete_program_credential(uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.record_npi_lookup(uuid, text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.fetch_listing_credentials(uuid[])', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.list_pending_listing_credentials()', 'EXECUTE'),
  'signed-in users can call the RPCs (each checks who is calling)'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.program_credential_problem(text, text, text, text, text, date, text, text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.program_credential_writer_scope(uuid, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.org_merge_linked_partner_copies(uuid, uuid)', 'EXECUTE'),
  'the internal helpers stay internal'
);
SELECT is(
  (SELECT array_agg(pg_get_function_identity_arguments(p.oid) || ' -> ' || pg_get_function_result(p.oid))
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('org_merge_linked_partner_copies', 'accept_org_invite')),
  ARRAY['p_code text -> void', 'p_from uuid, p_to uuid -> integer'],
  'the re-created merge helper keeps its signature; accept_org_invite (1.0.4) is untouched'
);

-- The status rule (mirrored by integrity.ts credentialStatus).
SELECT is(
  ARRAY[
    public.program_credential_status(NULL, NULL, DATE '2026-11-04'),
    public.program_credential_status('rejected', DATE '2030-01-01', DATE '2026-11-04'),
    public.program_credential_status('verified', DATE '2026-11-03', DATE '2026-11-04'),
    public.program_credential_status('pending', DATE '2026-11-03', DATE '2026-11-04'),
    public.program_credential_status('verified', DATE '2026-11-04', DATE '2026-11-04'),
    public.program_credential_status('pending', DATE '2026-12-04', DATE '2026-11-04'),
    public.program_credential_status('verified', DATE '2026-12-05', DATE '2026-11-04'),
    public.program_credential_status('verified', NULL, DATE '2026-11-04'),
    public.program_credential_status('pending', NULL, DATE '2026-11-04')],
  ARRAY['missing', 'rejected', 'expired', 'expired', 'expiring', 'expiring', 'verified', 'verified', 'pending'],
  'status: missing, rejected first, expired the day after, expiring through 30 days, then verified or pending'
);
SELECT is(
  ARRAY[public.is_valid_npi('1234567893'), public.is_valid_npi('1245319599'), public.is_valid_npi('1234567890'),
        public.is_valid_npi('123456789'), public.is_valid_npi('12345678930'), public.is_valid_npi('12345678a3'), public.is_valid_npi(NULL)],
  ARRAY[true, true, false, false, false, false, false],
  'NPI check digit: Luhn over the number with the 80840 prefix'
);
SELECT is(
  ARRAY[public.is_valid_proof_url('https://www.jointcommission.org/en-us/about-us/recognizing-excellence/find-accredited-organizationsquality-report/?keyword=juniper'),
        public.is_valid_proof_url('https://carf.org/find-provider/'),
        public.is_valid_proof_url('https://example.org'),
        public.is_valid_proof_url('http://example.org/x'),
        public.is_valid_proof_url('https://localhost/x'),
        public.is_valid_proof_url('https://user:pw@example.org/'),
        public.is_valid_proof_url('https://exa mple.org/'),
        public.is_valid_proof_url('javascript:alert(1)'),
        public.is_valid_proof_url('https://example.org/' || repeat('a', 500))],
  ARRAY[true, true, true, false, false, false, false, false, false],
  'proof links: https on a public host only'
);
SELECT throws_ok(
  $$ INSERT INTO public.program_credentials (global_partner_id, org_id, partner_id, kind, identifier, issuing_state)
     VALUES ('d1000000-0000-0000-0000-000000c7ed01', current_setting('test.org_p')::uuid, 'e2000000-0000-0000-0000-000000c7ed01', 'state_license', 'X', 'OR') $$,
  '23514', NULL,
  'a credential belongs to a listing or a partner, never both'
);
SELECT throws_ok(
  $$ INSERT INTO public.program_credentials (global_partner_id, kind, identifier) VALUES ('d1000000-0000-0000-0000-000000c7ed01', 'npi', '1234567890') $$,
  '23514', NULL,
  'an NPI that fails its check digit cannot be stored'
);
SELECT throws_ok(
  $$ INSERT INTO public.program_credentials (global_partner_id, kind, identifier, proof_url) VALUES ('d1000000-0000-0000-0000-000000c7ed01', 'legitscript', 'L1', 'http://example.org') $$,
  '23514', NULL,
  'an http (not https) proof link cannot be stored'
);
SELECT throws_ok(
  $$ INSERT INTO public.program_credentials (global_partner_id, kind, identifier, status) VALUES ('d1000000-0000-0000-0000-000000c7ed01', 'legitscript', 'L1', 'verified') $$,
  '23514', NULL,
  'a verified credential always says when it was verified'
);

-- ===========================================================================
-- B. A center edits only its own listing; any change goes back to pending
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000c7ed01', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT status || ':' || issuing_state || ':' || (org_id IS NULL)::text || ':' || (created_by = 'c1000000-0000-0000-0000-000000c7ed01')::text
     FROM public.save_program_credential('f1000000-0000-0000-0000-000000c7ed01', 'd1000000-0000-0000-0000-000000c7ed01', NULL,
          'state_license', 'carf', 'ignored', ' LIC-100 ', 'or', DATE '2027-06-30', ' https://oha.example.gov/lookup?id=LIC-100 ', ' renewed ')),
  'pending:OR:true:true',
  'a center adds a license to its own listing: pending, normalized, no accreditor kept'
);
SELECT is(
  (SELECT identifier || '|' || coalesce(accreditor, 'none') || '|' || proof_url || '|' || note FROM public.program_credentials WHERE id = 'f1000000-0000-0000-0000-000000c7ed01'),
  'LIC-100|none|https://oha.example.gov/lookup?id=LIC-100|renewed',
  'values are trimmed and an accreditor never sticks to a license'
);
SELECT throws_ok(
  $$ SELECT public.save_program_credential('f1100000-0000-0000-0000-000000c7ed01', 'd2000000-0000-0000-0000-000000c7ed01', NULL,
       'state_license', NULL, '', 'LIC-200', 'OR', NULL, NULL, '') $$,
  '42501', NULL,
  'a center cannot add credentials to another program''s listing'
);
SELECT throws_ok(
  $$ SELECT public.save_program_credential('f1200000-0000-0000-0000-000000c7ed01', 'd4000000-0000-0000-0000-000000c7ed01', NULL,
       'state_license', NULL, '', 'LIC-400', 'OR', NULL, NULL, '') $$,
  '42501', NULL,
  'a center cannot add credentials to an unclaimed listing'
);
SELECT throws_ok(
  $$ SELECT public.verify_program_credential('f1000000-0000-0000-0000-000000c7ed01', 'verified', '') $$,
  '42501', NULL,
  'a center cannot verify its own credentials'
);
SELECT throws_ok(
  $$ SELECT public.save_program_credential('f1300000-0000-0000-0000-000000c7ed01', 'd1000000-0000-0000-0000-000000c7ed01', NULL,
       'npi', NULL, '', '1234567890', '', NULL, NULL, '') $$,
  '22023', 'An NPI is 10 digits and its last digit must check out. Check the number.',
  'an NPI that fails its check digit is refused in plain words'
);
SELECT throws_ok(
  $$ SELECT public.save_program_credential('f1300000-0000-0000-0000-000000c7ed01', 'd1000000-0000-0000-0000-000000c7ed01', NULL,
       'accreditation', 'other', '  ', 'A-1', '', NULL, NULL, '') $$,
  '22023', 'Name the accrediting body',
  'another accrediting body needs a name'
);
SELECT throws_ok(
  $$ SELECT public.save_program_credential('f1300000-0000-0000-0000-000000c7ed01', 'd1000000-0000-0000-0000-000000c7ed01', NULL,
       'legitscript', NULL, '', '', '', NULL, 'http://legitscript.example.com/cert', '') $$,
  '22023', 'The link must be a full https:// web address',
  'an http proof link is refused in plain words'
);
SELECT throws_ok(
  $$ SELECT public.save_program_credential('f1300000-0000-0000-0000-000000c7ed01', 'd1000000-0000-0000-0000-000000c7ed01', NULL,
       'legitscript', NULL, '', '', '', NULL, NULL, '') $$,
  '22023', 'Add the certificate number or a link to the public record',
  'a LegitScript certification needs a number or a link'
);
SELECT throws_ok(
  $$ SELECT public.save_program_credential('f1300000-0000-0000-0000-000000c7ed01', 'd1000000-0000-0000-0000-000000c7ed01', NULL,
       'npi', NULL, '', '1234567893', '', DATE '2030-01-01', NULL, '') $$,
  '22023', 'An NPI does not expire. Leave the date blank.',
  'an NPI carries no expiration date'
);
SELECT lives_ok(
  $$ SELECT public.save_program_credential('f1300000-0000-0000-0000-000000c7ed01', 'd1000000-0000-0000-0000-000000c7ed01', NULL,
       'npi', NULL, '', '1234567893', '', NULL, NULL, '') $$,
  'a center adds its NPI'
);
SELECT lives_ok(
  $$ SELECT public.save_program_credential('f1400000-0000-0000-0000-000000c7ed01', 'd1000000-0000-0000-0000-000000c7ed01', NULL,
       'legitscript', NULL, '', 'LS-77', '', DATE '2027-01-31', 'https://www.legitscript.com/websites/?checker_keywords=juniper.example.org', '') $$,
  'a center adds its LegitScript certification'
);
SELECT is(
  (SELECT npi_lookup_name || ':' || (npi_checked_at IS NOT NULL)::text || ':' || status
     FROM public.record_npi_lookup('f1300000-0000-0000-0000-000000c7ed01', '  JUNIPER RIDGE RECOVERY LLC  ')),
  'JUNIPER RIDGE RECOVERY LLC:true:pending',
  'the NPI Registry name is kept as a hint and never verifies anything'
);
SELECT throws_ok(
  $$ SELECT public.record_npi_lookup('f1000000-0000-0000-0000-000000c7ed01', 'x') $$,
  '22023', NULL,
  'only an NPI takes an NPI Registry name'
);
RESET ROLE;

-- Practitioners cannot write a listing's credentials.
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-000000c7ed01', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.save_program_credential('f1500000-0000-0000-0000-000000c7ed01', 'd1000000-0000-0000-0000-000000c7ed01', NULL,
       'state_license', NULL, '', 'LIC-FAKE', 'OR', NULL, NULL, '') $$,
  '42501', NULL,
  'a practice member cannot add to a listing it does not claim'
);
SELECT throws_ok(
  $$ SELECT public.save_program_credential('f1000000-0000-0000-0000-000000c7ed01', 'd1000000-0000-0000-0000-000000c7ed01', NULL,
       'state_license', NULL, '', 'LIC-EDIT', 'OR', NULL, NULL, '') $$,
  '42501', NULL,
  'a practice member cannot edit a listing''s credential'
);
SELECT throws_ok(
  $$ SELECT public.verify_program_credential('f1000000-0000-0000-0000-000000c7ed01', 'verified', '') $$,
  '42501', NULL,
  'a practice member cannot verify a listing''s credential'
);
SELECT throws_ok(
  $$ SELECT public.delete_program_credential('f1000000-0000-0000-0000-000000c7ed01') $$,
  '42501', NULL,
  'a practice member cannot remove a listing''s credential'
);
SELECT throws_ok(
  $$ SELECT public.record_npi_lookup('f1300000-0000-0000-0000-000000c7ed01', 'Someone Else LLC') $$,
  '42501', NULL,
  'a practice member cannot overwrite a listing''s NPI Registry hint'
);
SELECT throws_ok(
  $$ SELECT * FROM public.list_pending_listing_credentials() $$,
  '42501', NULL,
  'a practice member cannot open the review queue'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-000000c7ed01', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.delete_program_credential('f1000000-0000-0000-0000-000000c7ed01') $$,
  '42501', NULL,
  'another center cannot remove the credential'
);
SELECT throws_ok(
  $$ SELECT public.save_program_credential('f1000000-0000-0000-0000-000000c7ed01', 'd2000000-0000-0000-0000-000000c7ed01', NULL,
       'state_license', NULL, '', 'LIC-STOLEN', 'OR', NULL, NULL, '') $$,
  '22023', 'This credential belongs to another program',
  'a credential id cannot be moved onto another listing'
);
SELECT throws_ok(
  $$ SELECT * FROM public.list_pending_listing_credentials() $$,
  '42501', NULL,
  'a center cannot open the review queue'
);
RESET ROLE;

-- ReferralFit reviews.
SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000c7ed01', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT array_agg(listing || ':' || kind || ':' || status_today ORDER BY kind) FROM public.list_pending_listing_credentials()
    WHERE global_partner_id = 'd1000000-0000-0000-0000-000000c7ed01'),
  ARRAY['Juniper Ridge Recovery:legitscript:pending', 'Juniper Ridge Recovery:npi:pending', 'Juniper Ridge Recovery:state_license:pending'],
  'the admin queue lists every pending listing credential with its listing'
);
SELECT throws_ok(
  $$ SELECT public.verify_program_credential('f1000000-0000-0000-0000-000000c7ed01', 'verified', '', '2001-01-01'::timestamptz) $$,
  '22023', 'This credential changed after you opened it. Review it again.',
  'a credential changed after the reviewer opened it is reviewed again'
);
SELECT is(
  (SELECT status || ':' || (verified_by = 'a1000000-0000-0000-0000-000000c7ed01')::text || ':' || (verified_at IS NOT NULL)::text
     FROM public.verify_program_credential('f1000000-0000-0000-0000-000000c7ed01', 'verified', 'Checked on the OHA lookup',
          (SELECT updated_at FROM public.program_credentials WHERE id = 'f1000000-0000-0000-0000-000000c7ed01'))),
  'verified:true:true',
  'a platform admin verifies, recorded with who and when'
);
SELECT throws_ok(
  $$ SELECT public.verify_program_credential('f1400000-0000-0000-0000-000000c7ed01', 'rejected', '   ') $$,
  '22023', NULL,
  'rejecting a listing''s credential needs a note the program can act on'
);
SELECT is(
  (SELECT status || ':' || verification_note FROM public.verify_program_credential('f1400000-0000-0000-0000-000000c7ed01', 'rejected', 'Not found on LegitScript')),
  'rejected:Not found on LegitScript',
  'a platform admin rejects with a note'
);
SELECT throws_ok(
  $$ SELECT public.verify_program_credential('f1000000-0000-0000-0000-000000c7ed01', 'approved', '') $$,
  '22023', NULL,
  'only verified or rejected'
);
SELECT ok(
  NOT public.listing_credentials_verified('d1000000-0000-0000-0000-000000c7ed01', CURRENT_DATE),
  'no badge: the license is verified but the LegitScript certification was rejected'
);
SELECT lives_ok(
  $$ SELECT public.verify_program_credential('f1400000-0000-0000-0000-000000c7ed01', 'verified', 'Found it after all') $$,
  'the admin can change a decision'
);
SELECT is(
  ARRAY[public.listing_credentials_verified('d1000000-0000-0000-0000-000000c7ed01', DATE '2026-11-04'),
        public.listing_credentials_verified('d1000000-0000-0000-0000-000000c7ed01', DATE '2027-01-31'),
        public.listing_credentials_verified('d1000000-0000-0000-0000-000000c7ed01', DATE '2027-02-01'),
        public.listing_credentials_verified('d4000000-0000-0000-0000-000000c7ed01', DATE '2026-11-04')],
  ARRAY[true, true, false, false],
  'badge: a current verified license AND a current verified LegitScript (good through its last day); nothing on file is no badge'
);
RESET ROLE;

-- The center changes the verified license: back to pending.
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000c7ed01', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT status FROM public.save_program_credential('f1000000-0000-0000-0000-000000c7ed01', 'd1000000-0000-0000-0000-000000c7ed01', NULL,
     'state_license', NULL, '', 'LIC-100', 'OR', DATE '2027-06-30', 'https://oha.example.gov/lookup?id=LIC-100', 'renewed')),
  'verified',
  'saving the same values again changes nothing (a retry after a timeout is safe)'
);
SELECT is(
  (SELECT status || ':' || (verified_by IS NULL)::text || ':' || (verified_at IS NULL)::text || ':' || verification_note || ':' || (updated_by = 'c1000000-0000-0000-0000-000000c7ed01')::text
     FROM public.save_program_credential('f1000000-0000-0000-0000-000000c7ed01', 'd1000000-0000-0000-0000-000000c7ed01', NULL,
          'state_license', NULL, '', 'LIC-100', 'OR', DATE '2028-06-30', 'https://oha.example.gov/lookup?id=LIC-100', 'renewed')),
  'pending:true:true::true',
  'a center''s change resets the verification to pending'
);
SELECT is(
  (SELECT status FROM public.save_program_credential('f1400000-0000-0000-0000-000000c7ed01', 'd1000000-0000-0000-0000-000000c7ed01', NULL,
     'legitscript', NULL, '', 'LS-77', '', DATE '2027-01-31', 'https://www.legitscript.com/websites/?checker_keywords=juniper.example.org', 'note only')),
  'pending',
  'even a note-only change goes back to ReferralFit'
);
SELECT is(
  (SELECT npi_lookup_name FROM public.save_program_credential('f1300000-0000-0000-0000-000000c7ed01', 'd1000000-0000-0000-0000-000000c7ed01', NULL,
     'npi', NULL, '', '1234567893', '', NULL, NULL, 'same number')),
  'JUNIPER RIDGE RECOVERY LLC',
  'the registry hint survives an edit that keeps the NPI'
);
SELECT is(
  (SELECT coalesce(npi_lookup_name, 'cleared') FROM public.save_program_credential('f1300000-0000-0000-0000-000000c7ed01', 'd1000000-0000-0000-0000-000000c7ed01', NULL,
     'npi', NULL, '', '1245319599', '', NULL, NULL, 'new number')),
  'cleared',
  'a new NPI drops the old registry hint'
);
RESET ROLE;

-- ===========================================================================
-- C. Who reads a listing's credentials
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'c3000000-0000-0000-0000-000000c7ed01', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$ SELECT public.save_program_credential('f3000000-0000-0000-0000-000000c7ed01', 'd3000000-0000-0000-0000-000000c7ed01', NULL,
       'state_license', NULL, '', 'LIC-300', 'OR', NULL, NULL, '') $$,
  'the center of a pending listing can add credentials'
);
SELECT is((SELECT count(*)::integer FROM public.program_credentials WHERE global_partner_id = 'd3000000-0000-0000-0000-000000c7ed01'), 1,
  'and sees them while its listing is pending');
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', 'b3000000-0000-0000-0000-000000c7ed01', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.program_credentials WHERE global_partner_id = 'd1000000-0000-0000-0000-000000c7ed01'), 3,
  'any signed-in practitioner reads an active listing''s credentials');
SELECT is((SELECT count(*)::integer FROM public.fetch_listing_credentials(ARRAY['d1000000-0000-0000-0000-000000c7ed01', 'd3000000-0000-0000-0000-000000c7ed01']::uuid[])), 3,
  'fetch_listing_credentials returns them, and nothing of the pending listing');
SELECT is((SELECT count(*)::integer FROM public.program_credentials WHERE global_partner_id = 'd3000000-0000-0000-0000-000000c7ed01'), 0,
  'a pending listing''s credentials are hidden from practitioners');
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000c7ed01', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.program_credentials WHERE global_partner_id = 'd3000000-0000-0000-0000-000000c7ed01'), 1,
  'ReferralFit sees a pending listing''s credentials');
RESET ROLE;

-- An archived listing's credentials disappear for practitioners. (Direct
-- listing edits run as the SQL editor: no signed-in user.)
SELECT set_config('request.jwt.claim.sub', '', true);
UPDATE public.global_partners SET status = 'archived' WHERE id = 'd1000000-0000-0000-0000-000000c7ed01';
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-000000c7ed01', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.program_credentials WHERE global_partner_id = 'd1000000-0000-0000-0000-000000c7ed01'), 0,
  'an inactive listing''s credentials are hidden');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000c7ed01', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.program_credentials WHERE global_partner_id = 'd1000000-0000-0000-0000-000000c7ed01'), 3,
  'its own center still sees them');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
UPDATE public.global_partners SET status = 'active' WHERE id = 'd1000000-0000-0000-0000-000000c7ed01';
SELECT is((SELECT status FROM public.global_partners WHERE id = 'd1000000-0000-0000-0000-000000c7ed01'), 'active', 'the listing is live again');

-- anon reads nothing and calls nothing.
SELECT set_config('request.jwt.claim.sub', '', true);
SET LOCAL ROLE anon;
SELECT throws_ok($$ SELECT count(*) FROM public.program_credentials $$, '42501', NULL, 'anon cannot read the table');
SELECT throws_ok($$ SELECT * FROM public.fetch_listing_credentials(ARRAY['d1000000-0000-0000-0000-000000c7ed01']::uuid[]) $$, '42501', NULL,
  'anon cannot call the reader');
SELECT throws_ok($$ SELECT public.save_program_credential(gen_random_uuid(), 'd1000000-0000-0000-0000-000000c7ed01', NULL, 'npi', NULL, '', '1234567893', '', NULL, NULL, '') $$,
  '42501', NULL, 'anon cannot call a writer');
RESET ROLE;

-- Production's default ACL grants ALL on new tables. Even with every
-- privilege granted, RLS keeps anon out and refuses every client write.
GRANT ALL ON TABLE public.program_credentials TO anon, authenticated;
SET LOCAL ROLE anon;
SELECT is((SELECT count(*)::integer FROM public.program_credentials), 0, 'production grants: anon still reads no rows');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000c7ed01', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ INSERT INTO public.program_credentials (global_partner_id, kind, identifier, issuing_state) VALUES ('d1000000-0000-0000-0000-000000c7ed01', 'state_license', 'DIRECT', 'OR') $$,
  '42501', NULL,
  'production grants: a direct insert is refused by RLS'
);
UPDATE public.program_credentials SET status = 'verified', verified_at = now() WHERE id = 'f1000000-0000-0000-0000-000000c7ed01';
DELETE FROM public.program_credentials WHERE id = 'f1000000-0000-0000-0000-000000c7ed01';
RESET ROLE;
SELECT is(
  (SELECT status FROM public.program_credentials WHERE id = 'f1000000-0000-0000-0000-000000c7ed01'),
  'pending',
  'production grants: a direct update or delete changes nothing (a center cannot verify itself)'
);
REVOKE ALL ON TABLE public.program_credentials FROM anon, authenticated;
GRANT SELECT ON TABLE public.program_credentials TO authenticated;

-- ===========================================================================
-- D. A practice's own checks: its workspace only
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-000000c7ed01', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT (org_id = current_setting('test.org_p')::uuid)::text || ':' || status || ':' || (global_partner_id IS NULL)::text
     FROM public.save_program_credential('f2000000-0000-0000-0000-000000c7ed01', NULL, 'e2000000-0000-0000-0000-000000c7ed01',
          'state_license', NULL, '', 'OR-555', 'OR', CURRENT_DATE + 10, NULL, 'Looked up on the state site')),
  'true:pending:true',
  'a practice member adds a credential to its own partner'
);
SELECT lives_ok(
  $$ SELECT public.save_program_credential('f2100000-0000-0000-0000-000000c7ed01', NULL, 'e1000000-0000-0000-0000-000000c7ed01',
       'npi', NULL, '', '1234567893', '', NULL, NULL, '') $$,
  'and to a partner linked to a listing (its own check, beside the listing''s)'
);
SELECT is(
  (SELECT npi_lookup_name FROM public.record_npi_lookup('f2100000-0000-0000-0000-000000c7ed01', 'JUNIPER RIDGE RECOVERY LLC')),
  'JUNIPER RIDGE RECOVERY LLC',
  'the practice keeps the registry name on its own NPI'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-000000c7ed01', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.program_credentials WHERE partner_id IS NOT NULL), 2, 'a teammate sees the practice''s checks');
SELECT is(
  (SELECT status || ':' || (verified_by = 'b2000000-0000-0000-0000-000000c7ed01')::text || ':' || (verified_at IS NOT NULL)::text
     FROM public.verify_program_credential('f2000000-0000-0000-0000-000000c7ed01', 'verified', '')),
  'verified:true:true',
  'a practitioner records their own check: who and when'
);
SELECT is(
  (SELECT status FROM public.save_program_credential('f2000000-0000-0000-0000-000000c7ed01', NULL, 'e2000000-0000-0000-0000-000000c7ed01',
     'state_license', NULL, '', 'OR-556', 'OR', CURRENT_DATE + 10, NULL, 'Looked up on the state site')),
  'pending',
  'an edit sends the practice''s own check back to not checked'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', 'b3000000-0000-0000-0000-000000c7ed01', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.program_credentials WHERE partner_id IS NOT NULL), 0, 'another practice reads none of them');
SELECT throws_ok(
  $$ SELECT public.save_program_credential('f2200000-0000-0000-0000-000000c7ed01', NULL, 'e2000000-0000-0000-0000-000000c7ed01',
       'state_license', NULL, '', 'X', 'OR', NULL, NULL, '') $$,
  'P0002', NULL,
  'another practice cannot add to the partner'
);
SELECT throws_ok(
  $$ SELECT public.save_program_credential('f2000000-0000-0000-0000-000000c7ed01', NULL, 'e2000000-0000-0000-0000-000000c7ed01',
       'state_license', NULL, '', 'X', 'OR', NULL, NULL, '') $$,
  'P0002', NULL,
  'another practice cannot edit the practice''s check'
);
SELECT throws_ok(
  $$ SELECT public.save_program_credential('f2000000-0000-0000-0000-000000c7ed01', NULL, 'e3000000-0000-0000-0000-000000c7ed01',
       'state_license', NULL, '', 'X', 'OR', NULL, NULL, '') $$,
  '22023', NULL,
  'a known credential id cannot be pulled onto another practice''s partner'
);
SELECT throws_ok(
  $$ SELECT public.verify_program_credential('f2000000-0000-0000-0000-000000c7ed01', 'verified', '') $$,
  'P0002', NULL,
  'another practice cannot check it'
);
SELECT throws_ok(
  $$ SELECT public.delete_program_credential('f2000000-0000-0000-0000-000000c7ed01') $$,
  'P0002', NULL,
  'another practice cannot remove it'
);
SELECT throws_ok(
  $$ SELECT public.record_npi_lookup('f2100000-0000-0000-0000-000000c7ed01', 'x') $$,
  'P0002', NULL,
  'another practice cannot touch its NPI hint'
);
RESET ROLE;

-- At most 20 per partner.
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-000000c7ed01', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT count(*)::integer FROM generate_series(1, 20) AS g,
          LATERAL public.save_program_credential(gen_random_uuid(), NULL, 'e6000000-0000-0000-0000-000000c7ed01',
                  'legitscript', NULL, '', 'LS-' || g, '', NULL, NULL, '') AS saved),
  20,
  'twenty credentials fit on one partner'
);
SELECT throws_ok(
  $$ SELECT public.save_program_credential(gen_random_uuid(), NULL, 'e6000000-0000-0000-0000-000000c7ed01',
       'legitscript', NULL, '', 'LS-21', '', NULL, NULL, '') $$,
  '22023', 'A program can have at most 20 credentials. Remove an old one first.',
  'the twenty-first is refused'
);
SELECT is(public.delete_program_credential('f2000000-0000-0000-0000-000000c7ed01'), true, 'a practice member removes its check');
SELECT is(public.delete_program_credential('f2000000-0000-0000-0000-000000c7ed01'), false, 'removing it again is a no-op');
-- Deleting the partner takes its checks with it (the 1.0.4 app deletes partners directly).
DELETE FROM public.partners WHERE id = 'e6000000-0000-0000-0000-000000c7ed01';
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.program_credentials WHERE partner_id = 'e6000000-0000-0000-0000-000000c7ed01'), 0,
  'a deleted partner''s checks go with it');

-- ===========================================================================
-- E. A solo practitioner joins: their checks follow the partner
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'b4000000-0000-0000-0000-000000c7ed01', true);
SET LOCAL ROLE authenticated;
SELECT public.import_global_partner('d1000000-0000-0000-0000-000000c7ed01', 'e4000000-0000-0000-0000-000000c7ed01');
INSERT INTO public.partners (id, owner_id, name, organization) VALUES
  ('e5000000-0000-0000-0000-000000c7ed01', 'b4000000-0000-0000-0000-000000c7ed01', 'Intake', 'Solo Private Program');
SELECT public.save_program_credential('f4000000-0000-0000-0000-000000c7ed01', NULL, 'e4000000-0000-0000-0000-000000c7ed01',
  'accreditation', 'carf', '', 'CARF-9', '', DATE '2027-03-01', NULL, 'From the solo practice');
SELECT public.save_program_credential('f5000000-0000-0000-0000-000000c7ed01', NULL, 'e5000000-0000-0000-0000-000000c7ed01',
  'state_license', NULL, '', 'OR-777', 'OR', NULL, NULL, '');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-000000c7ed01', true);
SET LOCAL ROLE authenticated;
SELECT set_config('test.invite', code, true) FROM public.create_org_invite();
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'b4000000-0000-0000-0000-000000c7ed01', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$ SELECT public.accept_org_invite(current_setting('test.invite')) $$, 'a solo practitioner with checks on file joins the practice');
SELECT lives_ok($$ SET CONSTRAINTS ALL IMMEDIATE $$, 'every deferred relationship is consistent after the join');
RESET ROLE;
SELECT is(
  (SELECT partner_id::text || ':' || (org_id = current_setting('test.org_p')::uuid)::text FROM public.program_credentials WHERE id = 'f4000000-0000-0000-0000-000000c7ed01'),
  'e1000000-0000-0000-0000-000000c7ed01:true',
  'a check on a partner the team already tracks moves to the team''s copy'
);
SELECT is(
  (SELECT partner_id::text || ':' || (org_id = current_setting('test.org_p')::uuid)::text FROM public.program_credentials WHERE id = 'f5000000-0000-0000-0000-000000c7ed01'),
  'e5000000-0000-0000-0000-000000c7ed01:true',
  'a check on any other partner moves with it'
);
SELECT set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-000000c7ed01', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.program_credentials WHERE id IN ('f4000000-0000-0000-0000-000000c7ed01', 'f5000000-0000-0000-0000-000000c7ed01')), 2,
  'the team sees the joiner''s checks');
RESET ROLE;

-- ===========================================================================
-- F. Accounts and listings going away
-- ===========================================================================

-- A center account can be deleted; its listing's credentials stay, unattributed.
SELECT set_config('request.jwt.claim.sub', '', true);
DELETE FROM auth.users WHERE id = 'c3000000-0000-0000-0000-000000c7ed01';
SELECT is(
  (SELECT (created_by IS NULL AND updated_by IS NULL)::text FROM public.program_credentials WHERE id = 'f3000000-0000-0000-0000-000000c7ed01'),
  'true',
  'a deleted account leaves the credentials it added, unattributed'
);
DELETE FROM public.global_partners WHERE id = 'd3000000-0000-0000-0000-000000c7ed01';
SELECT is((SELECT count(*)::integer FROM public.program_credentials WHERE id = 'f3000000-0000-0000-0000-000000c7ed01'), 0,
  'a deleted listing takes its credentials with it');

-- A merged listing takes no new credentials.
UPDATE public.global_partners SET merged_into = 'd1000000-0000-0000-0000-000000c7ed01', status = 'archived' WHERE id = 'd2000000-0000-0000-0000-000000c7ed01';
SELECT set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-000000c7ed01', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.save_program_credential(gen_random_uuid(), 'd2000000-0000-0000-0000-000000c7ed01', NULL,
       'state_license', NULL, '', 'LIC-200', 'OR', NULL, NULL, '') $$,
  '22023', 'This listing was merged into another. Update the credentials there.',
  'a merged listing takes no new credentials'
);
RESET ROLE;

-- The SQL editor (no signed-in user) can review, like the other admin queues.
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT is(
  (SELECT status FROM public.verify_program_credential('f1000000-0000-0000-0000-000000c7ed01', 'verified', 'From the SQL editor')),
  'verified',
  'the SQL editor can verify a listing credential'
);
SELECT ok(
  (SELECT count(*) FROM public.list_pending_listing_credentials()) >= 1,
  'and read the queue'
);

SELECT * FROM finish();
ROLLBACK;
