-- Focused coverage for 20261001170000_insurance_workflow.sql.
-- Run after a local migration reset with: supabase test db
--
-- This file is never pasted into production.

BEGIN;
SELECT plan(56);

-- Actors
--   u1  owner of practice P
--   u2  member of practice P
--   q1  owner of practice Q (sees nothing of P)
INSERT INTO auth.users (id, email)
VALUES
  ('a1000000-0000-0000-0000-00000000d100', 'vob-u1@example.test'),
  ('a2000000-0000-0000-0000-00000000d100', 'vob-u2@example.test'),
  ('b1000000-0000-0000-0000-00000000d100', 'vob-q1@example.test');

SELECT set_config('test.org_p', org_id::text, true) FROM public.org_members WHERE user_id = 'a1000000-0000-0000-0000-00000000d100';
SELECT set_config('test.org_q', org_id::text, true) FROM public.org_members WHERE user_id = 'b1000000-0000-0000-0000-00000000d100';
UPDATE public.org_members SET org_id = current_setting('test.org_p')::uuid, role = 'member', display_name = 'Mikayla'
 WHERE user_id = 'a2000000-0000-0000-0000-00000000d100';

-- P can read the directory, so a linked listing's data is what counts.
INSERT INTO public.org_entitlements (org_id, entitlement, active, source)
VALUES (current_setting('test.org_p')::uuid, 'directory', true, 'manual');

-- Listings: G1 active (bills Aetna out-of-network), G2 archived.
INSERT INTO public.global_partners (id, name, organization, types, city, state, phone, status, verified_at, insurance, insurance_networks)
VALUES
  ('d1000000-0000-0000-0000-00000000d100', 'Admissions', 'Juniper Ridge Recovery', ARRAY['Inpatient'], 'Bend', 'OR', '(541) 555-0400', 'active', now(),
   ARRAY['Aetna'], '{"Aetna": ["Out-of-network"]}'::jsonb),
  ('d2000000-0000-0000-0000-00000000d100', 'Admissions', 'Old Mill Lodge', ARRAY['Inpatient'], 'Bend', 'OR', '(541) 555-0405', 'archived', NULL,
   ARRAY['Cigna'], '{"Cigna": ["In-network"]}'::jsonb);

-- Practice P partners:
--   X  Aetna in-network, Cigna out-of-network (explicit entries)
--   Y  Aetna listed with no networks entry (counts as in-network), WA
--   Z  linked to G1; its own copy says Aetna in-network, the listing says out
--   W  linked to archived G2; falls back to its own data
--   V  no insurance data at all
INSERT INTO public.partners (id, owner_id, org_id, name, organization, types, city, state, phone, insurance, insurance_networks, global_partner_id)
VALUES
  ('e1000000-0000-0000-0000-00000000d100', 'a1000000-0000-0000-0000-00000000d100', current_setting('test.org_p')::uuid, 'Intake', 'Cascade Recovery', ARRAY['Inpatient'], 'Bend', 'OR', '(541) 555-0401',
   ARRAY['Aetna', 'Cigna'], '{"Aetna": ["In-network"], "Cigna": ["Out-of-network"]}'::jsonb, NULL),
  ('e2000000-0000-0000-0000-00000000d100', 'a1000000-0000-0000-0000-00000000d100', current_setting('test.org_p')::uuid, 'Intake', 'Deschutes Lodge', ARRAY['Inpatient'], 'Seattle', 'WA', '(541) 555-0402',
   ARRAY['Aetna', 'Cigna'], '{"Cigna": ["In-network"]}'::jsonb, NULL),
  ('e3000000-0000-0000-0000-00000000d100', 'a1000000-0000-0000-0000-00000000d100', current_setting('test.org_p')::uuid, 'Admissions', 'Juniper Ridge Recovery', ARRAY['Inpatient'], 'Bend', 'OR', '(541) 555-0400',
   ARRAY['Aetna'], '{"Aetna": ["In-network"]}'::jsonb, 'd1000000-0000-0000-0000-00000000d100'),
  ('e4000000-0000-0000-0000-00000000d100', 'a1000000-0000-0000-0000-00000000d100', current_setting('test.org_p')::uuid, 'Admissions', 'Old Mill Lodge', ARRAY['Inpatient'], 'Bend', 'OR', '(541) 555-0405',
   ARRAY['Cigna'], '{"Cigna": ["Out-of-network"]}'::jsonb, 'd2000000-0000-0000-0000-00000000d100'),
  ('e5000000-0000-0000-0000-00000000d100', 'a1000000-0000-0000-0000-00000000d100', current_setting('test.org_p')::uuid, 'Office', 'Quiet Pines Counseling', ARRAY['Therapist'], 'Bend', 'OR', '(541) 555-0406',
   ARRAY[]::text[], '{}'::jsonb, NULL),
  ('f1000000-0000-0000-0000-00000000d100', 'b1000000-0000-0000-0000-00000000d100', current_setting('test.org_q')::uuid, 'Intake', 'Cascade Recovery', ARRAY['Inpatient'], 'Bend', 'OR', '(541) 555-0401',
   ARRAY['Aetna'], '{"Aetna": ["In-network"]}'::jsonb, NULL);

-- One case in P, one in Q.
INSERT INTO public.cases (id, owner_id, org_id, title)
VALUES
  ('a9000000-0000-0000-0000-00000000d100', 'a1000000-0000-0000-0000-00000000d100', current_setting('test.org_p')::uuid, 'Henderson family'),
  ('b9000000-0000-0000-0000-00000000d100', 'b1000000-0000-0000-0000-00000000d100', current_setting('test.org_q')::uuid, 'Other practice family');

-- ===========================================================================
-- A. Schema and constraints
-- ===========================================================================

SELECT has_table('public', 'case_benefits', 'case_benefits exists');
SELECT has_table('public', 'vob_requests', 'vob_requests exists');
SELECT has_function('public', 'request_vob', ARRAY['jsonb'], 'request_vob exists');
SELECT has_function('public', 'update_vob_status', ARRAY['uuid', 'jsonb', 'uuid'], 'update_vob_status exists');
SELECT has_function('public', 'save_case_benefits', ARRAY['uuid', 'jsonb', 'uuid'], 'save_case_benefits exists');
SELECT has_function('public', 'partners_for_plan', ARRAY['text', 'text'], 'partners_for_plan exists');
SELECT has_function('public', 'vob_turnaround_stats', ARRAY[]::text[], 'vob_turnaround_stats exists');

SELECT throws_ok(
  $$ INSERT INTO public.case_benefits (case_id, owner_id, org_id, member_id_last4)
     VALUES ('a9000000-0000-0000-0000-00000000d100', 'a1000000-0000-0000-0000-00000000d100', current_setting('test.org_p')::uuid, '12345') $$,
  '23514', NULL,
  'five characters of a member id cannot be stored'
);
SELECT throws_ok(
  $$ INSERT INTO public.case_benefits (case_id, owner_id, org_id, member_id_last4)
     VALUES ('a9000000-0000-0000-0000-00000000d100', 'a1000000-0000-0000-0000-00000000d100', current_setting('test.org_p')::uuid, '123') $$,
  '23514', NULL,
  'three characters are rejected too: four or nothing'
);
SELECT throws_ok(
  $$ INSERT INTO public.vob_requests (owner_id, org_id, case_id, program_name, status)
     VALUES ('a1000000-0000-0000-0000-00000000d100', current_setting('test.org_p')::uuid, 'a9000000-0000-0000-0000-00000000d100', 'x', 'bogus') $$,
  '23514', NULL,
  'an unknown VOB status is rejected'
);
SELECT throws_ok(
  $$ INSERT INTO public.vob_requests (owner_id, org_id, case_id, program_name, status, answered_at)
     VALUES ('a1000000-0000-0000-0000-00000000d100', current_setting('test.org_p')::uuid, 'a9000000-0000-0000-0000-00000000d100', 'x', 'in_network', NULL) $$,
  '23514', NULL,
  'an answered status needs answered_at and an open one cannot have it'
);

SELECT is(public.next_business_day(DATE '2026-10-01'), DATE '2026-10-02', 'Thursday rolls to Friday');
SELECT is(public.next_business_day(DATE '2026-10-02'), DATE '2026-10-05', 'Friday rolls to Monday');
SELECT is(public.next_business_day(DATE '2026-10-03'), DATE '2026-10-05', 'Saturday rolls to Monday');

-- ===========================================================================
-- B. Clients write only through the functions
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-00000000d100', true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$ INSERT INTO public.case_benefits (case_id, carrier) VALUES ('a9000000-0000-0000-0000-00000000d100', 'Aetna') $$,
  '42501', NULL,
  'a client cannot insert case_benefits directly'
);
SELECT throws_ok(
  $$ INSERT INTO public.vob_requests (case_id, program_name) VALUES ('a9000000-0000-0000-0000-00000000d100', 'Cascade Recovery') $$,
  '42501', NULL,
  'a client cannot insert vob_requests directly'
);

SELECT is(
  (SELECT (carrier, plan_name, member_id_last4, subscriber_relationship, event_body)::text
     FROM public.save_case_benefits('a9000000-0000-0000-0000-00000000d100',
       jsonb_build_object('carrier', 'Aetna', 'plan_name', 'PPO Choice', 'member_id_last4', 'W123', 'subscriber_relationship', 'parent'),
       'c1000000-0000-0000-0000-00000000d100')),
  '(Aetna,"PPO Choice",W123,parent,"Insurance plan added: Aetna PPO Choice (subscriber: parent)")',
  'save_case_benefits stores the plan and words the timeline entry without the member id'
);

SELECT is(
  (SELECT (kind, body, actor_id::text)::text FROM public.case_events WHERE id = 'c1000000-0000-0000-0000-00000000d100'),
  '(system,"Insurance plan added: Aetna PPO Choice (subscriber: parent)",a1000000-0000-0000-0000-00000000d100)',
  'the plan entry is on the timeline with the member who saved it'
);

SELECT throws_ok(
  $$ SELECT * FROM public.save_case_benefits('a9000000-0000-0000-0000-00000000d100', jsonb_build_object('member_id_last4', 'W12345'), NULL) $$,
  '22023',
  'Only the last four characters of the member id are stored',
  'save_case_benefits refuses more than four characters'
);

SELECT is(
  (SELECT event_body FROM public.save_case_benefits('a9000000-0000-0000-0000-00000000d100', jsonb_build_object('plan_name', 'PPO Choice'), 'c2000000-0000-0000-0000-00000000d100')),
  '',
  'saving the same plan again writes no entry'
);

SELECT is(
  (SELECT count(*)::integer FROM public.case_events WHERE case_id = 'a9000000-0000-0000-0000-00000000d100' AND kind = 'system'),
  1,
  'exactly one plan entry so far'
);

-- ===========================================================================
-- C. Request VOB: row, chase follow-up, timeline entry
-- ===========================================================================

SELECT is(
  (SELECT (program_name, global_partner_id::text, due_on = public.next_business_day(CURRENT_DATE), event_body)::text
     FROM public.request_vob(jsonb_build_object(
       'id', 'c3000000-0000-0000-0000-00000000d100',
       'case_id', 'a9000000-0000-0000-0000-00000000d100',
       'partner_id', 'e3000000-0000-0000-0000-00000000d100',
       'follow_up_id', 'c4000000-0000-0000-0000-00000000d100',
       'event_id', 'c5000000-0000-0000-0000-00000000d100'))),
  '("Juniper Ridge Recovery",d1000000-0000-0000-0000-00000000d100,t,"VOB requested: Juniper Ridge Recovery")',
  'request_vob names the program from the partner, links its listing, and chases on the next business day'
);

SELECT is(
  (SELECT (status, requested_by::text, follow_up_id::text, answered_at IS NULL)::text
     FROM public.vob_requests WHERE id = 'c3000000-0000-0000-0000-00000000d100'),
  '(requested,a1000000-0000-0000-0000-00000000d100,c4000000-0000-0000-0000-00000000d100,t)',
  'the request starts as requested, by the requester, with its chase follow-up'
);

SELECT is(
  (SELECT (title, kind, waiting_on, assigned_to::text, case_id::text, partner_id::text, status)::text
     FROM public.follow_ups WHERE id = 'c4000000-0000-0000-0000-00000000d100'),
  '("Check on VOB: Juniper Ridge Recovery",waiting_on,"Juniper Ridge Recovery",a1000000-0000-0000-0000-00000000d100,a9000000-0000-0000-0000-00000000d100,e3000000-0000-0000-0000-00000000d100,open)',
  'the chase follow-up is open, on the case and partner, assigned to the requester'
);

SELECT is(
  (SELECT (kind, body, actor_id::text)::text FROM public.case_events WHERE id = 'c5000000-0000-0000-0000-00000000d100'),
  '(system,"VOB requested: Juniper Ridge Recovery",a1000000-0000-0000-0000-00000000d100)',
  'the request is on the timeline with the member who asked'
);

SELECT is(
  (SELECT event_body FROM public.request_vob(jsonb_build_object(
       'id', 'c3000000-0000-0000-0000-00000000d100',
       'case_id', 'a9000000-0000-0000-0000-00000000d100',
       'partner_id', 'e3000000-0000-0000-0000-00000000d100'))),
  '',
  'repeating the same request id is a no-op'
);

SELECT is(
  (SELECT count(*)::integer FROM public.vob_requests WHERE case_id = 'a9000000-0000-0000-0000-00000000d100'),
  1,
  'the repeat created no second row'
);

SELECT throws_ok(
  $$ SELECT * FROM public.request_vob(jsonb_build_object('case_id', 'a9000000-0000-0000-0000-00000000d100', 'partner_id', 'f1000000-0000-0000-0000-00000000d100')) $$,
  'P0002', 'Partner not found',
  'a partner from another practice cannot be asked'
);
SELECT throws_ok(
  $$ SELECT * FROM public.request_vob(jsonb_build_object('case_id', 'b9000000-0000-0000-0000-00000000d100', 'partner_id', 'e1000000-0000-0000-0000-00000000d100')) $$,
  'P0002', 'Case not found',
  'a case from another practice cannot carry a request'
);
SELECT throws_ok(
  $$ SELECT * FROM public.request_vob(jsonb_build_object('case_id', 'a9000000-0000-0000-0000-00000000d100')) $$,
  '22023', 'Name the program being asked',
  'a request needs a partner or a program name'
);

SELECT is(
  (SELECT (program_name, global_partner_id IS NULL)::text FROM public.request_vob(jsonb_build_object(
       'id', 'c6000000-0000-0000-0000-00000000d100',
       'case_id', 'a9000000-0000-0000-0000-00000000d100',
       'program_name', 'Sunrise Ranch (not in my network)',
       'due_on', (CURRENT_DATE + 2)::text))),
  '("Sunrise Ranch (not in my network)",t)',
  'a program outside the network can be asked by name'
);

SELECT is(
  (SELECT f.due_on FROM public.vob_requests r JOIN public.follow_ups f ON f.id = r.follow_up_id WHERE r.id = 'c6000000-0000-0000-0000-00000000d100'),
  CURRENT_DATE + 2,
  'the device-local due date is kept when the client sends one'
);

-- ===========================================================================
-- D. Visibility: the whole practice sees it, the other practice sees nothing
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'a2000000-0000-0000-0000-00000000d100', true);

SELECT is(
  (SELECT count(*)::integer FROM public.vob_requests WHERE case_id = 'a9000000-0000-0000-0000-00000000d100'),
  2,
  'a teammate sees the practice VOB requests'
);
SELECT is(
  (SELECT carrier FROM public.case_benefits WHERE case_id = 'a9000000-0000-0000-0000-00000000d100'),
  'Aetna',
  'a teammate sees the family plan'
);

SELECT throws_ok(
  $$ UPDATE public.vob_requests SET status = 'in_network' WHERE id = 'c3000000-0000-0000-0000-00000000d100' $$,
  '42501', NULL,
  'a client cannot update vob_requests directly'
);

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-00000000d100', true);

SELECT is((SELECT count(*)::integer FROM public.vob_requests), 0, 'another practice sees no VOB requests');
SELECT is((SELECT count(*)::integer FROM public.case_benefits), 0, 'another practice sees no family plan');
SELECT throws_ok(
  $$ SELECT * FROM public.update_vob_status('c3000000-0000-0000-0000-00000000d100', jsonb_build_object('status', 'in_network'), NULL) $$,
  'P0002', 'VOB request not found in this workspace',
  'another practice cannot answer a request that is not theirs'
);

-- ===========================================================================
-- E. The answer: status, actor, chase follow-up closed
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'a2000000-0000-0000-0000-00000000d100', true);

SELECT is(
  (SELECT (status, answered_at IS NOT NULL, answered_by, quoted_out_of_pocket, event_body)::text
     FROM public.update_vob_status('c3000000-0000-0000-0000-00000000d100',
       jsonb_build_object('status', 'in_network', 'answered_by', 'Maria in admissions', 'quoted_out_of_pocket', 500, 'note', 'Deductible met'),
       'c7000000-0000-0000-0000-00000000d100')),
  '(in_network,t,"Maria in admissions",500,"VOB in-network: Juniper Ridge Recovery, about $500 out of pocket (per Maria in admissions)")',
  'an answer stamps answered_at and words the entry with the quote and who answered'
);

SELECT is(
  (SELECT (kind, body, actor_id::text)::text FROM public.case_events WHERE id = 'c7000000-0000-0000-0000-00000000d100'),
  '(system,"VOB in-network: Juniper Ridge Recovery, about $500 out of pocket (per Maria in admissions)",a2000000-0000-0000-0000-00000000d100)',
  'the status change is on the timeline with the teammate who recorded it'
);

SELECT is(
  (SELECT (status, completed_by::text)::text FROM public.follow_ups WHERE id = 'c4000000-0000-0000-0000-00000000d100'),
  '(done,a2000000-0000-0000-0000-00000000d100)',
  'the chase follow-up is completed by the teammate who recorded the answer'
);

SELECT is(
  (SELECT event_body FROM public.update_vob_status('c3000000-0000-0000-0000-00000000d100', jsonb_build_object('note', 'Deductible met, coinsurance 20%'), NULL)),
  '',
  'a note-only edit writes no entry'
);

SELECT is(
  (SELECT (status, answered_at IS NULL, event_body)::text
     FROM public.update_vob_status('c3000000-0000-0000-0000-00000000d100', jsonb_build_object('status', 'pending'), 'c8000000-0000-0000-0000-00000000d100')),
  '(pending,t,"VOB pending with the program: Juniper Ridge Recovery")',
  'moving back to pending clears answered_at and says so'
);

SELECT throws_ok(
  $$ SELECT * FROM public.update_vob_status('c3000000-0000-0000-0000-00000000d100', jsonb_build_object('status', 'approved'), NULL) $$,
  '22023', 'Unknown VOB status',
  'an unknown status is refused'
);

SELECT is(
  (SELECT count(*)::integer FROM public.case_events WHERE case_id = 'a9000000-0000-0000-0000-00000000d100' AND kind = 'system'),
  5,
  'plan added, two requests, answer, back to pending: five entries'
);

-- ===========================================================================
-- F. partners_for_plan: classified from fixtures, never another practice
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-00000000d100', true);

SELECT is(
  (SELECT string_agg(organization || ':' || network_status || ':' || source, ',' ORDER BY organization)
     FROM public.partners_for_plan('Aetna', NULL)),
  'Cascade Recovery:in_network:partner,Deschutes Lodge:in_network:partner,Juniper Ridge Recovery:out_of_network:listing,Old Mill Lodge:unknown:none,Quiet Pines Counseling:unknown:none',
  'Aetna: explicit entry, listed-only fallback, the active listing overrides the copy, no data is unknown'
);

SELECT is(
  (SELECT string_agg(organization || ':' || network_status || ':' || source, ',' ORDER BY organization)
     FROM public.partners_for_plan('Cigna', NULL)),
  'Cascade Recovery:out_of_network:partner,Deschutes Lodge:in_network:partner,Juniper Ridge Recovery:unknown:none,Old Mill Lodge:out_of_network:partner,Quiet Pines Counseling:unknown:none',
  'Cigna: an archived listing does not override the partner copy'
);

SELECT is(
  (SELECT string_agg(network_status, ',') FROM public.partners_for_plan('Blue Cross', NULL)),
  'unknown,unknown,unknown,unknown,unknown',
  'a plan nobody lists is unknown everywhere, never out-of-network'
);

SELECT is(
  (SELECT string_agg(organization || ':' || coalesce(same_state::text, 'null'), ',' ORDER BY organization)
     FROM public.partners_for_plan('Aetna', 'OR') WHERE organization IN ('Cascade Recovery', 'Deschutes Lodge')),
  'Cascade Recovery:true,Deschutes Lodge:false',
  'same_state answers for the given state'
);

SELECT is(
  (SELECT bool_and(same_state IS NULL) FROM public.partners_for_plan('Aetna', 'ANY')),
  true,
  'same_state is null for ANY'
);

SELECT is(
  (SELECT count(*)::integer FROM public.partners_for_plan('Aetna', NULL) WHERE partner_id = 'f1000000-0000-0000-0000-00000000d100'),
  0,
  'the other practice partner never appears'
);

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-00000000d100', true);

SELECT is(
  (SELECT string_agg(partner_id::text, ',') FROM public.partners_for_plan('Aetna', NULL)),
  'f1000000-0000-0000-0000-00000000d100',
  'practice Q sees only its own partner'
);

-- The partner network data is untouched by the VOB answer on the case.
SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-00000000d100', true);
SELECT is(
  (SELECT insurance_networks::text FROM public.partners WHERE id = 'e3000000-0000-0000-0000-00000000d100'),
  '{"Aetna": ["In-network"]}',
  'a VOB answer never rewrites the partner network data'
);

-- ===========================================================================
-- G. vob_turnaround_stats: the Business median on a fixture
-- ===========================================================================

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

-- Answered in 1, 2 and 4 days inside the last 30 days; one answered in 10
-- days requested 100 days ago; one still open from 5 days ago.
INSERT INTO public.vob_requests (owner_id, org_id, case_id, program_name, status, requested_at, answered_at)
VALUES
  ('a1000000-0000-0000-0000-00000000d100', current_setting('test.org_p')::uuid, 'a9000000-0000-0000-0000-00000000d100', 'A', 'in_network', now() - interval '20 days', now() - interval '19 days'),
  ('a1000000-0000-0000-0000-00000000d100', current_setting('test.org_p')::uuid, 'a9000000-0000-0000-0000-00000000d100', 'B', 'out_of_network', now() - interval '15 days', now() - interval '13 days'),
  ('a1000000-0000-0000-0000-00000000d100', current_setting('test.org_p')::uuid, 'a9000000-0000-0000-0000-00000000d100', 'C', 'not_accepted', now() - interval '10 days', now() - interval '6 days'),
  ('a1000000-0000-0000-0000-00000000d100', current_setting('test.org_p')::uuid, 'a9000000-0000-0000-0000-00000000d100', 'D', 'in_network', now() - interval '100 days', now() - interval '90 days'),
  ('a1000000-0000-0000-0000-00000000d100', current_setting('test.org_p')::uuid, 'a9000000-0000-0000-0000-00000000d100', 'E', 'requested', now() - interval '5 days', NULL);

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-00000000d100', true);
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT string_agg(period || ':' || requested::text || ':' || answered::text || ':' || coalesce(median_days::text, 'null'), ',')
     FROM public.vob_turnaround_stats()),
  '30:6:3:2.0,90:6:3:2.0,365:7:4:3.0,all:7:4:3.0',
  'median days requested to answered per period; open requests count but do not skew it'
);

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-00000000d100', true);

SELECT is(
  (SELECT string_agg(period || ':' || requested::text || ':' || coalesce(median_days::text, 'null'), ',')
     FROM public.vob_turnaround_stats()),
  '30:0:null,90:0:null,365:0:null,all:0:null',
  'another practice gets empty stats, never ours'
);

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

-- No push left this feature: the chase follow-up is self-assigned.
SELECT is(
  (SELECT count(*)::integer FROM public.notification_outbox
    WHERE user_id IN ('a1000000-0000-0000-0000-00000000d100', 'a2000000-0000-0000-0000-00000000d100')),
  0,
  'no push payload was queued by the VOB workflow'
);

SELECT * FROM finish();
ROLLBACK;
