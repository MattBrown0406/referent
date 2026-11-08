-- Focused coverage for 20261108150000_claim_requests.sql: a program asks to
-- manage its listing, a platform admin approves or declines, and the two
-- emails. Run after a local migration reset with: supabase test db
--
-- This file is never pasted into production.

BEGIN;
SELECT plan(36);

-- a1 is the platform admin; p1 and p2 are program accounts (p1's email is at
-- the program's domain, p2's is not); L1 and L2 are program listings, L3 an
-- interventionist's.
INSERT INTO auth.users (id, email)
VALUES
  ('a1000000-0000-0000-0000-0000000000c9', 'admin-c9@example.test'),
  ('c1000000-0000-0000-0000-0000000000c9', 'admissions@juniperridge.example'),
  ('c2000000-0000-0000-0000-0000000000c9', 'someone@gmail.example'),
  ('c3000000-0000-0000-0000-0000000000c9', 'third@juniperridge.example');
INSERT INTO public.platform_admins (user_id) VALUES ('a1000000-0000-0000-0000-0000000000c9');
INSERT INTO public.global_partners (id, name, organization, types, city, state, status, website)
VALUES
  ('d1000000-0000-0000-0000-0000000000c9', 'Admissions', 'Juniper Ridge Recovery', ARRAY['Inpatient'], 'Bend', 'OR', 'active', 'https://www.juniperridge.example/'),
  ('d2000000-0000-0000-0000-0000000000c9', 'Intake', 'Cedar Hollow Detox', ARRAY['Detox'], 'Eugene', 'OR', 'active', 'cedarhollow.example'),
  ('d3000000-0000-0000-0000-0000000000c9', 'Dana Price', '', ARRAY['Interventionist'], 'Bend', 'OR', 'active', 'danaprice.example');
INSERT INTO public.center_claim_codes (global_partner_id, code, expires_at)
VALUES ('d1000000-0000-0000-0000-0000000000c9', 'oldcodeunused001', now() + interval '20 days');

-- ===========================================================================
-- A. Finding a listing
-- ===========================================================================

SET LOCAL ROLE anon;
SELECT throws_ok($$ SELECT * FROM public.claimable_program_listings('juniper') $$, '42501', NULL, 'signed out cannot search');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000c9', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT listing_name || ':' || claimed FROM public.claimable_program_listings('juniper')), 'Juniper Ridge Recovery:false',
  'a signed-in account finds the program by name');
SELECT is((SELECT count(*)::integer FROM public.claimable_program_listings('juniperridge.example')), 1, 'or by its website');
SELECT is((SELECT count(*)::integer FROM public.claimable_program_listings('dana')), 0, 'an interventionist''s listing is not offered');
SELECT is((SELECT count(*)::integer FROM public.claimable_program_listings('j')), 0, 'one letter finds nothing');
SELECT is((SELECT count(*)::integer FROM public.claimable_program_listings('Recovery', 'WA')), 0, 'the state filter narrows the search');

-- ===========================================================================
-- B. Asking
-- ===========================================================================

SELECT throws_ok($$ SELECT public.request_program_claim('d1000000-0000-0000-0000-0000000000c9', '  ', '', '', '') $$,
  '22023', NULL, 'a name is required');
SELECT throws_ok($$ SELECT public.request_program_claim('d3000000-0000-0000-0000-0000000000c9', 'Ana', '', '', '') $$,
  'P0002', NULL, 'an interventionist''s listing cannot be claimed here');
SELECT lives_ok($$ SELECT public.request_program_claim('d1000000-0000-0000-0000-0000000000c9', 'Ana Ruiz', 'Admissions director', '541-555-0100', 'We run the women''s program.') $$,
  'a program account asks to manage its listing');
SELECT throws_ok($$ SELECT public.request_program_claim('d2000000-0000-0000-0000-0000000000c9', 'Ana Ruiz', '', '', '') $$,
  '22023', NULL, 'one waiting request at a time');
SELECT is((SELECT listing_name || ':' || status FROM public.my_program_claim_request()), 'Juniper Ridge Recovery:pending',
  'the portal reads the request back');
SELECT throws_ok($$ SELECT * FROM public.program_claim_requests $$, '42501', NULL, 'nobody reads the table directly');
RESET ROLE;
SELECT is((SELECT string_agg(user_id::text || ':' || kind, ',') FROM public.email_outbox WHERE kind = 'claim_request'),
  'a1000000-0000-0000-0000-0000000000c9:claim_request', 'ReferralFit is emailed about the request');

SELECT set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-0000000000c9', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$ SELECT public.request_program_claim('d1000000-0000-0000-0000-0000000000c9', 'Sam Lee', '', '', '') $$,
  'a second account can ask for the same listing');
SELECT is(public.cancel_program_claim_request(), true, 'and can cancel its request');
SELECT is((SELECT status FROM public.my_program_claim_request()), 'cancelled', 'which reads cancelled');
SELECT lives_ok($$ SELECT public.request_program_claim('d1000000-0000-0000-0000-0000000000c9', 'Sam Lee', '', '', '') $$,
  'and ask again');
RESET ROLE;

-- ===========================================================================
-- C. ReferralFit's review
-- ===========================================================================

SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT * FROM public.list_program_claim_requests() $$, '42501', NULL, 'a program account cannot see the queue');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000c9', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT string_agg(requester_email || ':' || email_matches_website, ',' ORDER BY requester_email) FROM public.list_program_claim_requests()),
  'admissions@juniperridge.example:true,someone@gmail.example:false',
  'the admin sees both waiting requests, with whether each email matches the program''s website');
SELECT set_config('test.req_p1', (SELECT id::text FROM public.list_program_claim_requests() WHERE requester_email LIKE 'admissions%'), true);
SELECT set_config('test.req_p2', (SELECT id::text FROM public.list_program_claim_requests() WHERE requester_email LIKE 'someone%'), true);
RESET ROLE;

-- The claim email ReferralFit gets names the listing and the match.
SET LOCAL ROLE service_role;
CREATE TEMP TABLE admin_mail ON COMMIT DROP AS SELECT * FROM public.email_outbox_claim(10);
RESET ROLE;
SELECT ok((SELECT bool_and(email = 'admin-c9@example.test' AND kind = 'claim_request' AND data ->> 'listing_name' = 'Juniper Ridge Recovery') FROM admin_mail),
  'the admin email names the listing');
SELECT is((SELECT count(*)::integer FROM admin_mail), 2, 'one admin email per request');

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000c9', true);
SET LOCAL ROLE authenticated;
SELECT is(public.decide_program_claim_request(current_setting('test.req_p1')::uuid, true, ''), 'approved', 'the admin approves');
SELECT throws_ok(format($$ SELECT public.decide_program_claim_request(%L, false, '') $$, current_setting('test.req_p1')),
  '22023', NULL, 'a decided request cannot be decided again');
RESET ROLE;

SELECT is((SELECT global_partner_id::text FROM public.center_members WHERE user_id = 'c1000000-0000-0000-0000-0000000000c9'),
  'd1000000-0000-0000-0000-0000000000c9', 'approving binds the account to the listing');
SELECT ok((SELECT verified_at IS NOT NULL FROM public.global_partners WHERE id = 'd1000000-0000-0000-0000-0000000000c9'),
  'and stamps the listing verified, like a claim code');
SELECT ok((SELECT expires_at <= now() FROM public.center_claim_codes WHERE code = 'oldcodeunused001'), 'unused claim codes for it stop working');
SELECT is((SELECT status || ':' || decision_note FROM public.program_claim_requests WHERE id = current_setting('test.req_p2')::uuid),
  'declined:Another account at this program manages the listing now.', 'the other request for that listing is declined');
SELECT is((SELECT string_agg(user_id::text, ',' ORDER BY user_id) FROM public.email_outbox WHERE kind = 'claim_decision'),
  'c1000000-0000-0000-0000-0000000000c9,c2000000-0000-0000-0000-0000000000c9', 'both requesters are emailed the decision');

SET LOCAL ROLE service_role;
CREATE TEMP TABLE decision_mail ON COMMIT DROP AS SELECT * FROM public.email_outbox_claim(10);
RESET ROLE;
SELECT is((SELECT string_agg(email || ':' || (data ->> 'approved'), ',' ORDER BY email) FROM decision_mail WHERE kind = 'claim_decision'),
  'admissions@juniperridge.example:true,someone@gmail.example:false', 'the approved requester hears yes, the other no');

-- A new request on a claimed listing is refused; an approve on a claimed one too.
SELECT set_config('request.jwt.claim.sub', 'c3000000-0000-0000-0000-0000000000c9', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.request_program_claim('d1000000-0000-0000-0000-0000000000c9', 'Kim', '', '', '') $$,
  '22023', NULL, 'a listing its program manages cannot be requested');
SELECT lives_ok($$ SELECT public.request_program_claim('d2000000-0000-0000-0000-0000000000c9', 'Kim', '', '', '') $$,
  'another listing can be');
RESET ROLE;
SELECT set_config('test.req_p3', (SELECT id::text FROM public.program_claim_requests WHERE user_id = 'c3000000-0000-0000-0000-0000000000c9'), true);
SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000000c9', true);
SET LOCAL ROLE authenticated;
SELECT is(public.decide_program_claim_request(current_setting('test.req_p3')::uuid, false, 'Please email us from your program''s address.'), 'declined',
  'the admin declines with a note');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'c3000000-0000-0000-0000-0000000000c9', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT status || ':' || decision_note FROM public.my_program_claim_request()),
  'declined:Please email us from your program''s address.', 'the program reads the note');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT is((SELECT data ->> 'approved' FROM public.email_outbox_claim(10) WHERE kind = 'claim_decision'), 'false',
  'the decision email says declined');
RESET ROLE;

-- A request decided before its admin email went out: the email is dropped.
SELECT set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-0000000000c9', true);
SET LOCAL ROLE authenticated;
SELECT public.request_program_claim('d2000000-0000-0000-0000-0000000000c9', 'Sam Lee', '', '', '');
SELECT public.cancel_program_claim_request();
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT is((SELECT count(*)::integer FROM public.email_outbox_claim(10)), 0, 'a cancelled request''s admin email is not sent');
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.email_outbox WHERE kind = 'claim_request' AND error = 'not_pending'), 3,
  'admin emails for requests cancelled or decided before sending say why (not_pending)');

SELECT * FROM finish();
ROLLBACK;
