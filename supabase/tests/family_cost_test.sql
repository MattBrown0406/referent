-- Focused coverage for 20261104120000_family_cost.sql (true cost to the
-- family). Run after a local migration reset with: supabase test db
--
-- Section C is the backward-compatibility check: the 1.0.4 app's three
-- calls, with exactly the parameters it sends on main (src/lib/cases.ts at
-- e62a13b), still succeed, read back the same, and never disturb the new
-- columns.
--
-- This file is never pasted into production.

BEGIN;
SELECT plan(73);

-- Actors
--   u1  owner of practice P
--   u2  member of practice P
--   q1  owner of practice Q (sees nothing of P)
INSERT INTO auth.users (id, email)
VALUES
  ('a1000000-0000-0000-0000-0000000fc001', 'cost-u1@example.test'),
  ('a2000000-0000-0000-0000-0000000fc001', 'cost-u2@example.test'),
  ('b1000000-0000-0000-0000-0000000fc001', 'cost-q1@example.test');

SELECT set_config('test.org_p', org_id::text, true) FROM public.org_members WHERE user_id = 'a1000000-0000-0000-0000-0000000fc001';
SELECT set_config('test.org_q', org_id::text, true) FROM public.org_members WHERE user_id = 'b1000000-0000-0000-0000-0000000fc001';
UPDATE public.org_members SET org_id = current_setting('test.org_p')::uuid, role = 'member', display_name = 'Mikayla'
 WHERE user_id = 'a2000000-0000-0000-0000-0000000fc001';

INSERT INTO public.partners (id, owner_id, org_id, name, organization, types, city, state, phone, insurance, insurance_networks)
VALUES
  ('e1000000-0000-0000-0000-0000000fc001', 'a1000000-0000-0000-0000-0000000fc001', current_setting('test.org_p')::uuid, 'Intake', 'Cascade Recovery', ARRAY['Inpatient'], 'Bend', 'OR', '(541) 555-0401',
   ARRAY['Aetna'], '{"Aetna": ["In-network"]}'::jsonb);

INSERT INTO public.cases (id, owner_id, org_id, title)
VALUES
  ('a9000000-0000-0000-0000-0000000fc001', 'a1000000-0000-0000-0000-0000000fc001', current_setting('test.org_p')::uuid, 'Henderson family'),
  ('a9000000-0000-0000-0000-0000000fc002', 'a1000000-0000-0000-0000-0000000fc001', current_setting('test.org_p')::uuid, 'Ortiz family'),
  ('b9000000-0000-0000-0000-0000000fc001', 'b1000000-0000-0000-0000-0000000fc001', current_setting('test.org_q')::uuid, 'Other practice family');

-- ===========================================================================
-- A. Schema: nullable columns, constraints as a backstop
-- ===========================================================================

SELECT is(
  (SELECT array_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, 'none') ORDER BY column_name)
     FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'case_benefits'
      AND column_name ~ '^(in|oon)_'),
  ARRAY[
    'in_coinsurance_pct:integer:YES:none', 'in_deductible:integer:YES:none', 'in_deductible_met:integer:YES:none',
    'in_oop_max:integer:YES:none', 'in_oop_met:integer:YES:none', 'oon_benefits:boolean:YES:none',
    'oon_coinsurance_pct:integer:YES:none', 'oon_deductible:integer:YES:none', 'oon_deductible_met:integer:YES:none',
    'oon_oop_max:integer:YES:none', 'oon_oop_met:integer:YES:none'],
  'case_benefits has the eleven cost columns, nullable, no default (existing rows read as not entered)'
);
SELECT is(
  (SELECT array_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, 'none') ORDER BY column_name)
     FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'vob_requests'
      AND column_name IN ('allowed_daily_rate', 'billed_daily_rate', 'copay_per_day', 'precert_required')),
  ARRAY['allowed_daily_rate:integer:YES:none', 'billed_daily_rate:integer:YES:none', 'copay_per_day:integer:YES:none', 'precert_required:boolean:YES:none'],
  'vob_requests has the four cost columns, nullable, no default'
);

SELECT throws_ok(
  $$ INSERT INTO public.case_benefits (case_id, owner_id, org_id, in_deductible, in_deductible_met)
     VALUES ('a9000000-0000-0000-0000-0000000fc002', 'a1000000-0000-0000-0000-0000000fc001', current_setting('test.org_p')::uuid, 1000, 1500) $$,
  '23514', NULL,
  'a deductible met above the deductible cannot be stored'
);
SELECT throws_ok(
  $$ INSERT INTO public.case_benefits (case_id, owner_id, org_id, oon_oop_max, oon_oop_met)
     VALUES ('a9000000-0000-0000-0000-0000000fc002', 'a1000000-0000-0000-0000-0000000fc001', current_setting('test.org_p')::uuid, 1000, 1001) $$,
  '23514', NULL,
  'an out-of-pocket met above the max cannot be stored'
);
SELECT throws_ok(
  $$ INSERT INTO public.case_benefits (case_id, owner_id, org_id, in_coinsurance_pct)
     VALUES ('a9000000-0000-0000-0000-0000000fc002', 'a1000000-0000-0000-0000-0000000fc001', current_setting('test.org_p')::uuid, 101) $$,
  '23514', NULL,
  'coinsurance above 100 percent cannot be stored'
);
SELECT throws_ok(
  $$ INSERT INTO public.case_benefits (case_id, owner_id, org_id, in_deductible)
     VALUES ('a9000000-0000-0000-0000-0000000fc002', 'a1000000-0000-0000-0000-0000000fc001', current_setting('test.org_p')::uuid, -1) $$,
  '23514', NULL,
  'a negative amount cannot be stored'
);
SELECT throws_ok(
  $$ INSERT INTO public.case_benefits (case_id, owner_id, org_id, oon_benefits, oon_deductible)
     VALUES ('a9000000-0000-0000-0000-0000000fc002', 'a1000000-0000-0000-0000-0000000fc001', current_setting('test.org_p')::uuid, false, 500) $$,
  '23514', NULL,
  'a plan with no out-of-network benefits cannot carry out-of-network amounts'
);
SELECT throws_ok(
  $$ INSERT INTO public.vob_requests (owner_id, org_id, case_id, program_name, billed_daily_rate)
     VALUES ('a1000000-0000-0000-0000-0000000fc001', current_setting('test.org_p')::uuid, 'a9000000-0000-0000-0000-0000000fc002', 'x', 100001) $$,
  '23514', NULL,
  'a daily rate above $100,000 cannot be stored'
);

-- ===========================================================================
-- B. The 1.0.4 contract: same signatures, same return columns, same grants
-- ===========================================================================

SELECT is(
  (SELECT array_agg(pg_get_function_identity_arguments(p.oid) || ' -> ' || pg_get_function_result(p.oid))
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'save_case_benefits'),
  ARRAY['p_case_id uuid, p_patch jsonb, p_event_id uuid -> TABLE(carrier text, plan_name text, member_id_last4 text, subscriber_relationship text, event_body text, occurred_at timestamp with time zone)'],
  'save_case_benefits: one definition, the 1.0.4 parameters and return columns'
);
SELECT is(
  (SELECT array_agg(pg_get_function_identity_arguments(p.oid) || ' -> ' || pg_get_function_result(p.oid))
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'update_vob_status'),
  ARRAY['p_id uuid, p_patch jsonb, p_event_id uuid -> TABLE(status text, answered_at timestamp with time zone, answered_by text, note text, quoted_out_of_pocket integer, event_body text, occurred_at timestamp with time zone)'],
  'update_vob_status: one definition, the 1.0.4 parameters and return columns'
);
SELECT is(
  (SELECT array_agg(pg_get_function_identity_arguments(p.oid) || ' -> ' || pg_get_function_result(p.oid))
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'request_vob'),
  ARRAY['p_request jsonb -> TABLE(id uuid, program_name text, global_partner_id uuid, requested_at timestamp with time zone, follow_up_id uuid, due_on date, event_body text)'],
  'request_vob: untouched, one definition, the 1.0.4 parameters and return columns'
);
SELECT ok(
  (SELECT bool_and(p.prosecdef AND p.proconfig @> ARRAY['search_path=public'])
     FROM pg_proc p WHERE p.oid IN ('public.save_case_benefits(uuid, jsonb, uuid)'::regprocedure, 'public.update_vob_status(uuid, jsonb, uuid)'::regprocedure)),
  'both re-created writers stay SECURITY DEFINER with a pinned search_path'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.save_case_benefits(uuid, jsonb, uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.update_vob_status(uuid, jsonb, uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.request_vob(jsonb)', 'EXECUTE'),
  'signed-in members can still call all three'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.save_case_benefits(uuid, jsonb, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.update_vob_status(uuid, jsonb, uuid)', 'EXECUTE'),
  'anon still cannot call the writers'
);
SELECT ok(
  NOT bool_or(has_function_privilege(r.role, f.sig, 'EXECUTE')),
  'the cost helpers are internal: neither anon nor authenticated can run them'
)
FROM (VALUES ('anon'), ('authenticated')) r(role),
     (VALUES ('public.patch_whole_number(jsonb, text, text, integer)'), ('public.patch_tristate(jsonb, text, text)'),
             ('public.case_benefits_merge_costs(public.case_benefits, jsonb)'), ('public.case_benefits_apply_costs(uuid, uuid, jsonb)'),
             ('public.vob_requests_apply_costs(uuid, uuid, jsonb)')) f(sig);

-- ===========================================================================
-- C. The 1.0.4 app, calling exactly as it does on main
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000fc001', true);
SET LOCAL ROLE authenticated;

-- saveCaseBenefits sends carrier, plan_name, member_id_last4, subscriber_relationship.
SELECT is(
  (SELECT (carrier, plan_name, member_id_last4, subscriber_relationship, event_body, occurred_at IS NOT NULL)::text
     FROM public.save_case_benefits('a9000000-0000-0000-0000-0000000fc001',
       jsonb_build_object('carrier', 'Aetna', 'plan_name', 'PPO Choice', 'member_id_last4', 'W123', 'subscriber_relationship', 'parent'),
       'c1000000-0000-0000-0000-0000000fc001')),
  '(Aetna,"PPO Choice",W123,parent,"Insurance plan added: Aetna PPO Choice (subscriber: parent)",t)',
  '1.0.4 save_case_benefits: the same row and timeline wording as before'
);
SELECT is(
  (SELECT num_nonnulls(in_deductible, in_deductible_met, in_oop_max, in_oop_met, in_coinsurance_pct, oon_benefits,
                       oon_deductible, oon_deductible_met, oon_oop_max, oon_oop_met, oon_coinsurance_pct)
     FROM public.case_benefits WHERE case_id = 'a9000000-0000-0000-0000-0000000fc001'),
  0,
  '1.0.4 save_case_benefits leaves every amount not entered'
);
-- fetchCaseBenefits reads select('*') and maps these six columns.
SELECT ok(
  (SELECT to_jsonb(b) ?& ARRAY['case_id', 'carrier', 'plan_name', 'member_id_last4', 'subscriber_relationship', 'updated_at']
     FROM public.case_benefits b WHERE b.case_id = 'a9000000-0000-0000-0000-0000000fc001'),
  '1.0.4 select * still returns every plan column it maps'
);

-- requestVob sends id, case_id, partner_id, program_name, note, due_on, follow_up_id, event_id.
SELECT is(
  (SELECT (id::text, program_name, follow_up_id::text, due_on = CURRENT_DATE + 1, event_body)::text
     FROM public.request_vob(jsonb_build_object(
       'id', 'c3000000-0000-0000-0000-0000000fc001',
       'case_id', 'a9000000-0000-0000-0000-0000000fc001',
       'partner_id', 'e1000000-0000-0000-0000-0000000fc001',
       'program_name', '',
       'note', '',
       'due_on', (CURRENT_DATE + 1)::text,
       'follow_up_id', 'c4000000-0000-0000-0000-0000000fc001',
       'event_id', 'c5000000-0000-0000-0000-0000000fc001'))),
  '(c3000000-0000-0000-0000-0000000fc001,"Cascade Recovery",c4000000-0000-0000-0000-0000000fc001,t,"VOB requested: Cascade Recovery")',
  '1.0.4 request_vob for a partner: the same row as before'
);
SELECT is(
  (SELECT (program_name, event_body)::text
     FROM public.request_vob(jsonb_build_object(
       'id', 'c3000000-0000-0000-0000-0000000fc002',
       'case_id', 'a9000000-0000-0000-0000-0000000fc001',
       'partner_id', NULL,
       'program_name', 'Sunrise Ranch',
       'note', 'Fax sent',
       'due_on', (CURRENT_DATE + 1)::text,
       'follow_up_id', 'c4000000-0000-0000-0000-0000000fc002',
       'event_id', 'c5000000-0000-0000-0000-0000000fc002'))),
  '("Sunrise Ranch","VOB requested: Sunrise Ranch")',
  '1.0.4 request_vob for a program typed by name (partner_id null): the same row as before'
);
SELECT is(
  (SELECT (count(*) FILTER (WHERE num_nonnulls(allowed_daily_rate, billed_daily_rate, copay_per_day, precert_required) = 0),
           count(*) FILTER (WHERE partner_id IS NULL AND note = 'Fax sent'))::text
     FROM public.vob_requests WHERE case_id = 'a9000000-0000-0000-0000-0000000fc001'),
  '(2,1)',
  'both requests landed with no rates (not known); the typed one has no partner'
);

-- updateVobStatus sends status, answered_by, note, quoted_out_of_pocket.
SELECT is(
  (SELECT (status, answered_at IS NOT NULL, answered_by, note, quoted_out_of_pocket, event_body)::text
     FROM public.update_vob_status('c3000000-0000-0000-0000-0000000fc001',
       jsonb_build_object('status', 'in_network', 'answered_by', 'Maria in admissions', 'note', 'Deductible met', 'quoted_out_of_pocket', 500),
       'c7000000-0000-0000-0000-0000000fc001')),
  '(in_network,t,"Maria in admissions","Deductible met",500,"VOB in-network: Cascade Recovery, about $500 out of pocket (per Maria in admissions)")',
  '1.0.4 update_vob_status: the same answer and wording as before'
);
SELECT is(
  (SELECT (status, quoted_out_of_pocket IS NULL, event_body)::text
     FROM public.update_vob_status('c3000000-0000-0000-0000-0000000fc002',
       jsonb_build_object('status', 'pending', 'answered_by', '', 'note', 'Fax sent', 'quoted_out_of_pocket', NULL),
       'c7000000-0000-0000-0000-0000000fc002')),
  '(pending,t,"VOB pending with the program: Sunrise Ranch")',
  '1.0.4 update_vob_status with a blank quote (null): the same as before'
);
SELECT is(
  (SELECT (status, done)::text FROM (
     SELECT f.status, f.completed_at IS NOT NULL AS done FROM public.follow_ups f WHERE f.id = 'c4000000-0000-0000-0000-0000000fc001') s),
  '(done,t)',
  '1.0.4 answer still completes the chase follow-up'
);
SELECT ok(
  (SELECT to_jsonb(v) ?& ARRAY['id', 'case_id', 'partner_id', 'global_partner_id', 'program_name', 'status', 'requested_at', 'requested_by',
                                'answered_at', 'answered_by', 'note', 'quoted_out_of_pocket', 'follow_up_id']
     FROM public.vob_requests v WHERE v.id = 'c3000000-0000-0000-0000-0000000fc001'),
  '1.0.4 select * still returns every request column it maps'
);

-- ===========================================================================
-- D. The new app: amounts on the plan
-- ===========================================================================

SELECT is(
  (SELECT event_body FROM public.save_case_benefits('a9000000-0000-0000-0000-0000000fc001',
     jsonb_build_object('carrier', 'Aetna', 'plan_name', 'PPO Choice', 'member_id_last4', 'W123', 'subscriber_relationship', 'parent',
       'in_deductible', 3000, 'in_deductible_met', 1000, 'in_oop_max', 6000, 'in_oop_met', 1500, 'in_coinsurance_pct', 20,
       'oon_benefits', true, 'oon_deductible', 6000, 'oon_deductible_met', 0, 'oon_oop_max', 12000, 'oon_oop_met', NULL, 'oon_coinsurance_pct', 40),
     'c8000000-0000-0000-0000-0000000fc001')),
  'Insurance plan updated: Aetna PPO Choice (subscriber: parent)',
  'a change to the amounts alone is an "Insurance plan updated" entry, without the amounts'
);
SELECT is(
  (SELECT (in_deductible, in_deductible_met, in_oop_max, in_oop_met, in_coinsurance_pct, oon_benefits,
           oon_deductible, oon_deductible_met, oon_oop_max, oon_oop_met, oon_coinsurance_pct)::text
     FROM public.case_benefits WHERE case_id = 'a9000000-0000-0000-0000-0000000fc001'),
  '(3000,1000,6000,1500,20,t,6000,0,12000,,40)',
  'every amount is stored as sent (null is not entered)'
);
SELECT is(
  (SELECT (kind, body, actor_id::text)::text FROM public.case_events WHERE id = 'c8000000-0000-0000-0000-0000000fc001'),
  '(system,"Insurance plan updated: Aetna PPO Choice (subscriber: parent)",a1000000-0000-0000-0000-0000000fc001)',
  'the entry is on the timeline with the member, and no dollar amount'
);
SELECT is(
  (SELECT event_body FROM public.save_case_benefits('a9000000-0000-0000-0000-0000000fc001',
     jsonb_build_object('in_deductible', 3000, 'in_coinsurance_pct', '20', 'oon_oop_met', NULL), 'c8000000-0000-0000-0000-0000000fc002')),
  '',
  'the same amounts again (a digit string reads as the number) write no entry'
);
SELECT is(
  (SELECT event_body <> '' FROM public.save_case_benefits('a9000000-0000-0000-0000-0000000fc001',
     jsonb_build_object('in_deductible_met', 2500), 'c8000000-0000-0000-0000-0000000fc003')),
  true,
  'one amount can change on its own'
);
SELECT is(
  (SELECT (in_deductible, in_deductible_met, in_oop_max, carrier)::text FROM public.case_benefits WHERE case_id = 'a9000000-0000-0000-0000-0000000fc001'),
  '(3000,2500,6000,Aetna)',
  'and everything not in the patch keeps its value'
);

-- Mixed fleet: a 1.0.4 teammate edits the plan after the new app stored amounts.
SELECT set_config('request.jwt.claim.sub', 'a2000000-0000-0000-0000-0000000fc001', true);
SELECT is(
  (SELECT (plan_name, event_body)::text FROM public.save_case_benefits('a9000000-0000-0000-0000-0000000fc001',
     jsonb_build_object('carrier', 'Aetna', 'plan_name', 'PPO Plus', 'member_id_last4', 'W123', 'subscriber_relationship', 'parent'),
     'c8000000-0000-0000-0000-0000000fc004')),
  '("PPO Plus","Insurance plan updated: Aetna PPO Plus (subscriber: parent)")',
  'a 1.0.4 save next to the new app works as before'
);
SELECT is(
  (SELECT (in_deductible, in_deductible_met, in_oop_max, in_oop_met, in_coinsurance_pct, oon_benefits, oon_coinsurance_pct)::text
     FROM public.case_benefits WHERE case_id = 'a9000000-0000-0000-0000-0000000fc001'),
  '(3000,2500,6000,1500,20,t,40)',
  'and never touches the amounts it does not know about'
);
SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000fc001', true);

-- Refusals, in plain words, checked against what is stored.
SELECT throws_ok(
  $$ SELECT * FROM public.save_case_benefits('a9000000-0000-0000-0000-0000000fc001', jsonb_build_object('in_deductible_met', 4000), NULL) $$,
  '22023', 'The deductible met so far cannot be more than the deductible',
  'a met amount above the stored deductible is refused'
);
SELECT throws_ok(
  $$ SELECT * FROM public.save_case_benefits('a9000000-0000-0000-0000-0000000fc001', jsonb_build_object('in_oop_max', 1000), NULL) $$,
  '22023', 'The out-of-pocket met so far cannot be more than the out-of-pocket max',
  'a max below what is already met is refused'
);
SELECT throws_ok(
  $$ SELECT * FROM public.save_case_benefits('a9000000-0000-0000-0000-0000000fc001', jsonb_build_object('in_coinsurance_pct', 101), NULL) $$,
  '22023', 'In-network coinsurance must be a whole number from 0 to 100',
  'coinsurance above 100 is refused'
);
SELECT throws_ok(
  $$ SELECT * FROM public.save_case_benefits('a9000000-0000-0000-0000-0000000fc001', jsonb_build_object('in_deductible', -1), NULL) $$,
  '22023', 'The in-network deductible must be a whole number from 0 to 1000000',
  'a negative amount is refused'
);
SELECT throws_ok(
  $$ SELECT * FROM public.save_case_benefits('a9000000-0000-0000-0000-0000000fc001', jsonb_build_object('oon_deductible', 1500.5), NULL) $$,
  '22023', 'The out-of-network deductible must be a whole number from 0 to 1000000',
  'cents are refused (whole dollars only)'
);
SELECT throws_ok(
  $$ SELECT * FROM public.save_case_benefits('a9000000-0000-0000-0000-0000000fc001', jsonb_build_object('in_oop_max', 'about 6k'), NULL) $$,
  '22023', 'The in-network out-of-pocket max must be a whole number from 0 to 1000000',
  'words are refused'
);
SELECT throws_ok(
  $$ SELECT * FROM public.save_case_benefits('a9000000-0000-0000-0000-0000000fc001', jsonb_build_object('in_deductible', 1000001), NULL) $$,
  '22023', 'The in-network deductible must be a whole number from 0 to 1000000',
  'an amount over $1,000,000 is refused'
);
SELECT throws_ok(
  $$ SELECT * FROM public.save_case_benefits('a9000000-0000-0000-0000-0000000fc001', jsonb_build_object('oon_benefits', 'yes'), NULL) $$,
  '22023', 'Out-of-network benefits must be yes, no or not known',
  'out-of-network benefits must be true, false or null'
);
SELECT throws_ok(
  $$ SELECT * FROM public.save_case_benefits('a9000000-0000-0000-0000-0000000fc001', jsonb_build_object('oon_benefits', false), NULL) $$,
  '22023', 'A plan with no out-of-network benefits has no out-of-network amounts',
  '"no out-of-network benefits" while out-of-network amounts are stored is refused'
);
SELECT throws_ok(
  $$ SELECT * FROM public.save_case_benefits('a9000000-0000-0000-0000-0000000fc001', jsonb_build_object('carrier', 'Cigna', 'in_deductible', -5), NULL) $$,
  '22023', 'The in-network deductible must be a whole number from 0 to 1000000',
  'a refused amount in a patch that also changes the carrier'
);
SELECT is(
  (SELECT carrier FROM public.case_benefits WHERE case_id = 'a9000000-0000-0000-0000-0000000fc001'),
  'Aetna',
  'saves nothing at all: the carrier did not change either'
);
SELECT lives_ok(
  $$ SELECT * FROM public.save_case_benefits('a9000000-0000-0000-0000-0000000fc001',
       jsonb_build_object('oon_benefits', false, 'oon_deductible', NULL, 'oon_deductible_met', NULL, 'oon_oop_max', NULL, 'oon_oop_met', NULL, 'oon_coinsurance_pct', NULL),
       NULL) $$,
  '"no out-of-network benefits" with the amounts cleared in the same save is accepted'
);
SELECT is(
  (SELECT (oon_benefits, num_nonnulls(oon_deductible, oon_deductible_met, oon_oop_max, oon_oop_met, oon_coinsurance_pct))::text
     FROM public.case_benefits WHERE case_id = 'a9000000-0000-0000-0000-0000000fc001'),
  '(f,0)',
  'and stored that way'
);
SELECT throws_ok(
  $$ SELECT * FROM public.save_case_benefits('a9000000-0000-0000-0000-0000000fc001', jsonb_build_object('oon_deductible', 500), NULL) $$,
  '22023', 'A plan with no out-of-network benefits has no out-of-network amounts',
  'and an out-of-network amount is then refused'
);
SELECT is(
  (SELECT event_body FROM public.save_case_benefits('a9000000-0000-0000-0000-0000000fc001', jsonb_build_object('oon_benefits', NULL), NULL)),
  'Insurance plan updated: Aetna PPO Plus (subscriber: parent)',
  'null sets out-of-network benefits back to not known'
);
SELECT is(
  (SELECT oon_benefits IS NULL FROM public.case_benefits WHERE case_id = 'a9000000-0000-0000-0000-0000000fc001'),
  true,
  'and it is stored as not known'
);
SELECT is(
  (SELECT event_body FROM public.save_case_benefits('a9000000-0000-0000-0000-0000000fc002', jsonb_build_object('in_deductible', 0, 'in_coinsurance_pct', 0), NULL)),
  'Insurance plan added',
  'a plan can start from amounts alone'
);
SELECT is(
  (SELECT (in_deductible, in_coinsurance_pct, in_oop_max IS NULL)::text FROM public.case_benefits WHERE case_id = 'a9000000-0000-0000-0000-0000000fc002'),
  '(0,0,t)',
  'and 0 is a real 0, distinct from not entered'
);

-- ===========================================================================
-- E. The new app: rates on an answer
-- ===========================================================================

SELECT is(
  (SELECT (status, event_body)::text FROM public.update_vob_status('c3000000-0000-0000-0000-0000000fc002',
     jsonb_build_object('status', 'out_of_network', 'answered_by', 'Dee', 'note', '', 'quoted_out_of_pocket', NULL,
       'allowed_daily_rate', 600, 'billed_daily_rate', 1200, 'copay_per_day', 0, 'precert_required', true),
     'c9000000-0000-0000-0000-0000000fc001')),
  '(out_of_network,"VOB out-of-network: Sunrise Ranch, pre-authorization required (per Dee)")',
  'an answer with rates: the entry says pre-authorization is required, never the rates'
);
SELECT is(
  (SELECT (allowed_daily_rate, billed_daily_rate, copay_per_day, precert_required)::text FROM public.vob_requests WHERE id = 'c3000000-0000-0000-0000-0000000fc002'),
  '(600,1200,0,t)',
  'the rates are stored as sent'
);
SELECT is(
  (SELECT event_body FROM public.update_vob_status('c3000000-0000-0000-0000-0000000fc002', jsonb_build_object('billed_daily_rate', 1300), NULL)),
  '',
  'a rate-only edit writes no timeline entry'
);
SELECT is(
  (SELECT (status, allowed_daily_rate, billed_daily_rate, copay_per_day, precert_required)::text FROM public.vob_requests WHERE id = 'c3000000-0000-0000-0000-0000000fc002'),
  '(out_of_network,600,1300,0,t)',
  'and changes only that rate'
);
SELECT lives_ok(
  $$ SELECT * FROM public.update_vob_status('c3000000-0000-0000-0000-0000000fc002', jsonb_build_object('copay_per_day', NULL, 'precert_required', NULL), NULL) $$,
  'null is accepted for a rate and for pre-authorization'
);
SELECT is(
  (SELECT (copay_per_day IS NULL AND precert_required IS NULL AND billed_daily_rate = 1300) FROM public.vob_requests WHERE id = 'c3000000-0000-0000-0000-0000000fc002'),
  true,
  'it clears the rate, sets pre-authorization back to not known, and leaves the rest'
);

-- Mixed fleet: a 1.0.4 teammate re-answers after the new app stored rates.
SELECT set_config('request.jwt.claim.sub', 'a2000000-0000-0000-0000-0000000fc001', true);
SELECT is(
  (SELECT (status, quoted_out_of_pocket, event_body)::text FROM public.update_vob_status('c3000000-0000-0000-0000-0000000fc002',
     jsonb_build_object('status', 'in_network', 'answered_by', 'Dee', 'note', 'Re-checked', 'quoted_out_of_pocket', 4000),
     'c9000000-0000-0000-0000-0000000fc002')),
  '(in_network,4000,"VOB in-network: Sunrise Ranch, about $4000 out of pocket (per Dee)")',
  'a 1.0.4 answer next to the new app works as before'
);
SELECT is(
  (SELECT (allowed_daily_rate, billed_daily_rate)::text FROM public.vob_requests WHERE id = 'c3000000-0000-0000-0000-0000000fc002'),
  '(600,1300)',
  'and never touches the rates it does not know about'
);
SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-0000000fc001', true);

SELECT throws_ok(
  $$ SELECT * FROM public.update_vob_status('c3000000-0000-0000-0000-0000000fc002', jsonb_build_object('allowed_daily_rate', 100001), NULL) $$,
  '22023', 'The allowed rate per day must be a whole number from 0 to 100000',
  'a daily rate over $100,000 is refused'
);
SELECT throws_ok(
  $$ SELECT * FROM public.update_vob_status('c3000000-0000-0000-0000-0000000fc002', jsonb_build_object('copay_per_day', 12.5), NULL) $$,
  '22023', 'The copay per day must be a whole number from 0 to 100000',
  'a copay in cents is refused'
);
SELECT throws_ok(
  $$ SELECT * FROM public.update_vob_status('c3000000-0000-0000-0000-0000000fc002', jsonb_build_object('precert_required', 'yes'), NULL) $$,
  '22023', 'Pre-authorization required must be yes, no or not known',
  'pre-authorization must be true, false or null'
);
SELECT throws_ok(
  $$ SELECT * FROM public.update_vob_status('c3000000-0000-0000-0000-0000000fc002', jsonb_build_object('status', 'not_accepted', 'billed_daily_rate', -1), NULL) $$,
  '22023', 'The billed rate per day must be a whole number from 0 to 100000',
  'a refused rate in a patch that also changes the status'
);
SELECT is(
  (SELECT status FROM public.vob_requests WHERE id = 'c3000000-0000-0000-0000-0000000fc002'),
  'in_network',
  'saves nothing at all: the status did not change either'
);

-- ===========================================================================
-- F. Who can see and write the numbers
-- ===========================================================================

SELECT throws_ok(
  $$ UPDATE public.case_benefits SET in_deductible = 0 WHERE case_id = 'a9000000-0000-0000-0000-0000000fc001' $$,
  '42501', NULL,
  'a client cannot write the amounts directly'
);
SELECT throws_ok(
  $$ UPDATE public.vob_requests SET billed_daily_rate = 0 WHERE id = 'c3000000-0000-0000-0000-0000000fc002' $$,
  '42501', NULL,
  'a client cannot write the rates directly'
);
SELECT throws_ok(
  $$ SELECT public.case_benefits_apply_costs('a9000000-0000-0000-0000-0000000fc001', current_setting('test.org_p')::uuid, jsonb_build_object('in_deductible', 1)) $$,
  '42501', NULL,
  'a client cannot call the internal helper to skip the checks'
);

SELECT set_config('request.jwt.claim.sub', 'a2000000-0000-0000-0000-0000000fc001', true);
SELECT is(
  (SELECT (in_deductible, in_oop_max)::text FROM public.case_benefits WHERE case_id = 'a9000000-0000-0000-0000-0000000fc001'),
  '(3000,6000)',
  'a teammate sees the family''s amounts'
);

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000fc001', true);
SELECT is(
  (SELECT count(*)::integer FROM public.case_benefits WHERE in_deductible IS NOT NULL OR oon_benefits IS NOT NULL),
  0,
  'another practice sees no amounts'
);
SELECT is(
  (SELECT count(*)::integer FROM public.vob_requests WHERE billed_daily_rate IS NOT NULL),
  0,
  'another practice sees no rates'
);
SELECT throws_ok(
  $$ SELECT * FROM public.save_case_benefits('a9000000-0000-0000-0000-0000000fc001', jsonb_build_object('in_deductible', 1), NULL) $$,
  'P0002', 'Case not found',
  'another practice cannot write amounts on a case that is not theirs'
);
SELECT throws_ok(
  $$ SELECT * FROM public.update_vob_status('c3000000-0000-0000-0000-0000000fc002', jsonb_build_object('billed_daily_rate', 1), NULL) $$,
  'P0002', 'VOB request not found in this workspace',
  'another practice cannot write rates on a request that is not theirs'
);

RESET ROLE;

SELECT is(
  (SELECT (in_deductible, in_deductible_met)::text FROM public.case_benefits WHERE case_id = 'a9000000-0000-0000-0000-0000000fc001'),
  '(3000,2500)',
  'nothing the other practice tried landed'
);

SELECT * FROM finish();
ROLLBACK;
