-- Focused coverage for 20261104140000_placement_requests.sql (Placement
-- Request). Run after a local migration reset with: supabase test db
--
-- This file is never pasted into production.

BEGIN;
SELECT plan(95);

-- Actors
--   c1  center account that claimed L1
--   c2  center account that claimed L2
--   p1  owner of practice P (PA imports L1, PB imports L2, PC imports the
--       unclaimed L4, PD..PI private partners)
--   p2  member of practice P
--   q1  owner of practice Q (QA imports L1)
--   j1  solo owner of workspace J (JA imports L1, JB private), joins P
INSERT INTO auth.users (id, email)
VALUES
  ('c1000000-0000-0000-0000-0000000000a7', 'placement-c1@example.test'),
  ('c2000000-0000-0000-0000-0000000000a7', 'placement-c2@example.test'),
  ('b1000000-0000-0000-0000-0000000000a7', 'placement-p1@example.test'),
  ('b2000000-0000-0000-0000-0000000000a7', 'placement-p2@example.test'),
  ('b3000000-0000-0000-0000-0000000000a7', 'placement-q1@example.test'),
  ('b4000000-0000-0000-0000-0000000000a7', 'placement-j1@example.test');

SELECT set_config('test.org_p', org_id::text, true) FROM public.org_members WHERE user_id = 'b1000000-0000-0000-0000-0000000000a7';
SELECT set_config('test.org_q', org_id::text, true) FROM public.org_members WHERE user_id = 'b3000000-0000-0000-0000-0000000000a7';
SELECT set_config('test.org_j', org_id::text, true) FROM public.org_members WHERE user_id = 'b4000000-0000-0000-0000-0000000000a7';
UPDATE public.org_members SET org_id = current_setting('test.org_p')::uuid, role = 'member', display_name = 'Mikayla'
 WHERE user_id = 'b2000000-0000-0000-0000-0000000000a7';
UPDATE public.orgs SET name = 'Cascade Interventions' WHERE id = current_setting('test.org_p')::uuid;
UPDATE public.orgs SET name = 'Harbor Family Services' WHERE id = current_setting('test.org_q')::uuid;

INSERT INTO public.global_partners (id, name, organization, types, city, state, phone, website, status, verified_at)
VALUES
  ('d1000000-0000-0000-0000-0000000000a7', 'Admissions', 'Juniper Ridge Recovery', ARRAY['Inpatient'], 'Bend', 'OR', '(541) 555-0810', 'https://juniper.example.org', 'active', now()),
  ('d2000000-0000-0000-0000-0000000000a7', 'Intake', 'Cedar House', ARRAY['Inpatient'], 'Salem', 'OR', '(503) 555-0811', NULL, 'active', now()),
  ('d4000000-0000-0000-0000-0000000000a7', 'Intake', 'Unclaimed Oaks', ARRAY['Inpatient'], 'Bend', 'OR', '(541) 555-0813', NULL, 'active', now());
INSERT INTO public.center_members (user_id, global_partner_id)
VALUES
  ('c1000000-0000-0000-0000-0000000000a7', 'd1000000-0000-0000-0000-0000000000a7'),
  ('c2000000-0000-0000-0000-0000000000a7', 'd2000000-0000-0000-0000-0000000000a7');

-- Practice P: partners, a case and a saved match (with a budget the
-- programs must never see).
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT public.import_global_partner('d1000000-0000-0000-0000-0000000000a7', 'e1000000-0000-0000-0000-0000000000a7');
SELECT public.import_global_partner('d2000000-0000-0000-0000-0000000000a7', 'e2000000-0000-0000-0000-0000000000a7');
SELECT public.import_global_partner('d4000000-0000-0000-0000-0000000000a7', 'e3000000-0000-0000-0000-0000000000a7');
INSERT INTO public.partners (id, owner_id, name, organization, state) VALUES
  ('e4000000-0000-0000-0000-0000000000a7', 'b1000000-0000-0000-0000-0000000000a7', 'Intake', 'Private Pines', 'OR'),
  ('e5000000-0000-0000-0000-0000000000a7', 'b1000000-0000-0000-0000-0000000000a7', 'Intake', 'Program E', 'OR'),
  ('e6000000-0000-0000-0000-0000000000a7', 'b1000000-0000-0000-0000-0000000000a7', 'Intake', 'Program F', 'OR'),
  ('e7000000-0000-0000-0000-0000000000a7', 'b1000000-0000-0000-0000-0000000000a7', 'Intake', 'Program G', 'OR'),
  ('e8000000-0000-0000-0000-0000000000a7', 'b1000000-0000-0000-0000-0000000000a7', 'Intake', 'Program H', 'OR'),
  ('e9000000-0000-0000-0000-0000000000a7', 'b1000000-0000-0000-0000-0000000000a7', 'Intake', 'Program I', 'OR');
INSERT INTO public.cases (id, title, status) VALUES ('f1000000-0000-0000-0000-0000000000a7', 'Rivera intervention', 'inquiry');
INSERT INTO public.match_profiles (id, client_label, level_of_care, state, insurance, max_budget, therapies, must_have_therapies,
                                   population, location_preference, case_id)
VALUES ('f2000000-0000-0000-0000-0000000000a7', 'Rivera family', 'Inpatient', 'OR', 'Aetna', 48765,
        ARRAY['Trauma', 'MAT', 'Women only', 'EMDR', 'Bogus', 'Trauma'], ARRAY['Trauma'], 'Women', 'Close to family',
        'f1000000-0000-0000-0000-0000000000a7');
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', 'b3000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT public.import_global_partner('d1000000-0000-0000-0000-0000000000a7', 'ea000000-0000-0000-0000-0000000000a7');
INSERT INTO public.match_profiles (id, client_label, level_of_care, state, insurance, therapies)
VALUES ('f3000000-0000-0000-0000-0000000000a7', 'Q client', 'Detox', 'WA', 'Cash pay', ARRAY['MAT']);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

-- ===========================================================================
-- A. Schema, grants, the allow-list
-- ===========================================================================

SELECT has_table('public', 'placement_requests', 'placement_requests exists');
SELECT has_table('public', 'placement_request_recipients', 'placement_request_recipients exists');
SELECT ok(
  (SELECT bool_and(relrowsecurity) FROM pg_class
    WHERE oid IN ('public.placement_requests'::regclass, 'public.placement_request_recipients'::regclass)),
  'RLS is on for both tables'
);
SELECT ok(
  (SELECT bool_and(has_table_privilege('authenticated', t, 'SELECT')
                   AND NOT has_table_privilege('authenticated', t, 'INSERT')
                   AND NOT has_table_privilege('authenticated', t, 'UPDATE')
                   AND NOT has_table_privilege('authenticated', t, 'DELETE')
                   AND NOT has_table_privilege('authenticated', t, 'TRUNCATE')
                   AND NOT has_table_privilege('authenticated', t, 'REFERENCES')
                   AND NOT has_table_privilege('authenticated', t, 'TRIGGER'))
     FROM unnest(ARRAY['public.placement_requests', 'public.placement_request_recipients']) AS t),
  'signed-in users hold SELECT only on both tables, whatever the default ACL granted'
);
SELECT ok(
  (SELECT bool_and(NOT has_table_privilege('anon', t, 'SELECT') AND NOT has_table_privilege('anon', t, 'INSERT')
                   AND NOT has_table_privilege('anon', t, 'UPDATE') AND NOT has_table_privilege('anon', t, 'DELETE')
                   AND NOT has_table_privilege('anon', t, 'TRUNCATE'))
     FROM unnest(ARRAY['public.placement_requests', 'public.placement_request_recipients']) AS t),
  'anon holds nothing on either table'
);
SELECT ok(
  (SELECT bool_and(p.prosecdef AND p.proconfig @> ARRAY['search_path=public'])
     FROM pg_proc p
    WHERE p.oid IN ('public.create_placement_request(uuid, uuid, jsonb, uuid[], integer, text, text, uuid)'::regprocedure,
                    'public.cancel_placement_request(uuid)'::regprocedure,
                    'public.close_placement_request(uuid)'::regprocedure,
                    'public.placement_request_finish(uuid, text)'::regprocedure,
                    'public.log_manual_response(uuid, text, text, date, integer, text, text)'::regprocedure,
                    'public.list_center_placement_requests(uuid)'::regprocedure,
                    'public.mark_placement_request_viewed(uuid)'::regprocedure,
                    'public.respond_to_placement_request(uuid, text, text, date, integer, text, text)'::regprocedure,
                    'public.placement_request_channels(uuid[])'::regprocedure,
                    'public.placement_request_build(uuid, uuid, jsonb, uuid, text, text)'::regprocedure,
                    'public.placement_request_partner_ids(uuid, uuid[])'::regprocedure,
                    'public.placement_request_json(uuid)'::regprocedure,
                    'public.placement_listing_answers_in_portal(uuid)'::regprocedure,
                    'public.placement_practice_name(uuid)'::regprocedure,
                    'public.org_move_workspace_rows(uuid, uuid)'::regprocedure,
                    'public.org_merge_linked_partner_copies(uuid, uuid)'::regprocedure)),
  'every privileged function is SECURITY DEFINER with a pinned search_path'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND (p.proname LIKE 'placement%' OR p.proname IN ('create_placement_request', 'cancel_placement_request', 'close_placement_request',
                                                       'log_manual_response', 'list_center_placement_requests',
                                                       'mark_placement_request_viewed', 'respond_to_placement_request'))
       AND has_function_privilege('anon', p.oid, 'EXECUTE')),
  'anon can run none of the new functions'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.create_placement_request(uuid, uuid, jsonb, uuid[], integer, text, text, uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.cancel_placement_request(uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.close_placement_request(uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.log_manual_response(uuid, text, text, date, integer, text, text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.list_center_placement_requests(uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.mark_placement_request_viewed(uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.respond_to_placement_request(uuid, text, text, date, integer, text, text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.placement_request_channels(uuid[])', 'EXECUTE'),
  'signed-in users can call the RPCs (each checks who is calling)'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.placement_request_payload(text, text, text[], text[], text, text, text, text, text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.placement_note_problem(text, text[])', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.placement_allowed_needs(text[])', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.placement_request_partner_ids(uuid, uuid[])', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.placement_request_build(uuid, uuid, jsonb, uuid, text, text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.placement_request_json(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.placement_request_finish(uuid, text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.placement_listing_answers_in_portal(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.placement_practice_name(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.org_move_workspace_rows(uuid, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.org_merge_linked_partner_copies(uuid, uuid)', 'EXECUTE'),
  'the internal helpers stay internal'
);
SELECT is(
  (SELECT array_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') -> ' || pg_get_function_result(p.oid) ORDER BY p.proname)
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('org_move_workspace_rows', 'org_merge_linked_partner_copies', 'accept_org_invite')),
  ARRAY['accept_org_invite(p_code text) -> void',
        'org_merge_linked_partner_copies(p_from uuid, p_to uuid) -> integer',
        'org_move_workspace_rows(p_from uuid, p_to uuid) -> void'],
  'the re-created workspace helpers keep their signatures; accept_org_invite (1.0.4) is untouched'
);

-- The allow-list. The same fixture and the same expected JSON are in
-- scripts/placement-request-test.mjs, so the app's preview and the
-- server's payload cannot drift apart.
SELECT is(
  public.placement_request_payload('Inpatient', 'Women', ARRAY['Trauma', 'MAT', 'Women only', 'EMDR', 'Bogus', 'Trauma'], ARRAY['Trauma'],
                                   'Aetna', 'or', 'Close to family', 'this_week', '  Prefers a quiet setting  '),
  '{"level_of_care":"Inpatient","population":"Women","must_haves":["Trauma","Women only"],"needs":["MAT","EMDR"],"payment":"insurance","insurance_carrier":"Aetna","home_state":"OR","location_preference":"Close to family","admit_window":"this_week","note":"Prefers a quiet setting"}'::jsonb,
  'the payload: allowed needs only, must-haves plus population needs, carrier name, state, window, trimmed note'
);
SELECT is(
  public.placement_request_payload('Detox', 'Any', ARRAY['MAT', 'CBT'], NULL, 'Cash pay', 'ANY', 'No preference', 'asap', ''),
  '{"level_of_care":"Detox","population":"Any","must_haves":["MAT"],"needs":["CBT"],"payment":"self_pay","insurance_carrier":null,"home_state":null,"location_preference":"No preference","admit_window":"asap","note":null}'::jsonb,
  'self-pay carries no amount; MAT is a must-have by default; Any location is no state'
);
SELECT is(
  ARRAY[
    public.placement_request_payload('Somewhere', 'Kids', ARRAY['Adolescent'], ARRAY[]::text[], 'Aetna ID W123456789', 'Oregon', 'Downtown', 'flexible', NULL) ->> 'level_of_care',
    public.placement_request_payload('Somewhere', 'Kids', ARRAY['Adolescent'], ARRAY[]::text[], 'Aetna ID W123456789', 'Oregon', 'Downtown', 'flexible', NULL) ->> 'population',
    coalesce(public.placement_request_payload('Somewhere', 'Kids', ARRAY['Adolescent'], ARRAY[]::text[], 'Aetna ID W123456789', 'Oregon', 'Downtown', 'flexible', NULL) ->> 'insurance_carrier', 'none'),
    public.placement_request_payload('Somewhere', 'Kids', ARRAY['Adolescent'], ARRAY[]::text[], 'Aetna ID W123456789', 'Oregon', 'Downtown', 'flexible', NULL) ->> 'payment',
    coalesce(public.placement_request_payload('Somewhere', 'Kids', ARRAY['Adolescent'], ARRAY[]::text[], 'Aetna ID W123456789', 'Oregon', 'Downtown', 'flexible', NULL) ->> 'home_state', 'none'),
    public.placement_request_payload('Somewhere', 'Kids', ARRAY['Adolescent'], ARRAY[]::text[], 'Aetna ID W123456789', 'Oregon', 'Downtown', 'flexible', NULL) ->> 'location_preference',
    public.placement_request_payload('Banner|Aetna', 'Any', ARRAY['Men only'], NULL, 'Banner|Aetna', 'AZ', '', 'asap', NULL) ->> 'population',
    public.placement_request_payload('Banner|Aetna', 'Any', ARRAY['Men only'], NULL, 'Banner|Aetna', 'AZ', '', 'asap', NULL) ->> 'insurance_carrier'],
  ARRAY['Any type', 'Adolescent', 'none', 'insurance', 'none', 'No preference', 'Men', 'Banner|Aetna'],
  'unknown values are dropped, never passed through: a carrier with an id in it is not shared'
);
SELECT throws_ok(
  $$ SELECT public.placement_request_payload('Detox', 'Any', NULL, NULL, 'Cash pay', '', '', 'someday', NULL) $$,
  '22023', 'Choose when the client could be admitted',
  'the admit window is one of the four choices'
);
SELECT is(
  ARRAY[
    coalesce(public.placement_note_problem('Prefers a quiet setting, 30 days sober before', ARRAY['Rivera family']), 'ok'),
    public.placement_note_problem('Call mom at jane.rivera@example.com', ARRAY[]::text[]),
    public.placement_note_problem('Call (541) 555-0199 after 5', ARRAY[]::text[]),
    public.placement_note_problem('Born 1990-04-12', ARRAY[]::text[]),
    public.placement_note_problem('See www.example.org', ARRAY[]::text[]),
    public.placement_note_problem('Family can pay $30,000', ARRAY[]::text[]),
    public.placement_note_problem('The rivera FAMILY prefers women staff', ARRAY['Rivera family', NULL]),
    public.placement_note_problem(repeat('a', 301), ARRAY[]::text[])],
  ARRAY['ok',
        'Leave email addresses out of the note',
        'Leave phone numbers, ID numbers and dates out of the note',
        'Leave phone numbers, ID numbers and dates out of the note',
        'Leave links out of the note',
        'Leave money out of the note. Programs never see the family''s budget.',
        'The note mentions how this client is labeled in your workspace. Leave names and labels out.',
        'Keep the note to 300 characters'],
  'the note: no contact details, numbers, links, money, or the client''s label'
);
SELECT is(
  ARRAY[public.placement_recipient_status('sent', now() - interval '1 minute', now()),
        public.placement_recipient_status('viewed', now() - interval '1 minute', now()),
        public.placement_recipient_status('viewed', now() + interval '1 minute', now()),
        public.placement_recipient_status('responded', now() - interval '1 minute', now()),
        public.placement_recipient_status('declined', now() - interval '1 minute', now())],
  ARRAY['expired', 'expired', 'viewed', 'responded', 'declined'],
  'expired is computed from the deadline, never stored, and never hides an answer'
);
SELECT throws_ok(
  $$ INSERT INTO public.placement_requests (id, org_id, payload)
     VALUES (gen_random_uuid(), current_setting('test.org_p')::uuid, '{"level_of_care":"Detox","client_label":"Rivera family"}') $$,
  '23514', NULL,
  'no key outside the allow-list can be stored, whoever writes the row'
);

-- ===========================================================================
-- B. A practice sends a request
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT string_agg(c.partner_id::text || ':' || c.channel, ',' ORDER BY c.partner_id)
     FROM public.placement_request_channels(ARRAY['e1000000-0000-0000-0000-0000000000a7', 'e2000000-0000-0000-0000-0000000000a7',
                                                 'e3000000-0000-0000-0000-0000000000a7', 'e4000000-0000-0000-0000-0000000000a7',
                                                 'ea000000-0000-0000-0000-0000000000a7']::uuid[]) AS c),
  'e1000000-0000-0000-0000-0000000000a7:portal,e2000000-0000-0000-0000-0000000000a7:portal,e3000000-0000-0000-0000-0000000000a7:manual,e4000000-0000-0000-0000-0000000000a7:manual',
  'channels: a claimed listing answers in the portal, the rest are manual; another practice''s partner is not answered'
);
SELECT is(
  (SELECT string_agg((r ->> 'partner_id') || ':' || (r ->> 'rank') || ':' || (r ->> 'channel') || ':' || (r ->> 'status'), ',' ORDER BY (r ->> 'rank')::integer)
     FROM jsonb_array_elements(public.create_placement_request('91000000-0000-0000-0000-0000000000a7', 'f2000000-0000-0000-0000-0000000000a7', NULL,
            ARRAY['e2000000-0000-0000-0000-0000000000a7', 'e1000000-0000-0000-0000-0000000000a7',
                  'e3000000-0000-0000-0000-0000000000a7', 'e4000000-0000-0000-0000-0000000000a7']::uuid[],
            24, 'this_week', 'Prefers a quiet setting') -> 'recipients') AS r),
  'e2000000-0000-0000-0000-0000000000a7:1:portal:sent,e1000000-0000-0000-0000-0000000000a7:2:portal:sent,e3000000-0000-0000-0000-0000000000a7:3:manual:sent,e4000000-0000-0000-0000-0000000000a7:4:manual:sent',
  'a request goes to the chosen programs in the practice''s own ranked order'
);
SELECT is(
  (SELECT payload FROM public.placement_requests WHERE id = '91000000-0000-0000-0000-0000000000a7'),
  '{"level_of_care":"Inpatient","population":"Women","must_haves":["Trauma","Women only"],"needs":["MAT","EMDR"],"payment":"insurance","insurance_carrier":"Aetna","home_state":"OR","location_preference":"Close to family","admit_window":"this_week","note":"Prefers a quiet setting"}'::jsonb,
  'the stored payload is built on the server from the saved match'
);
SELECT ok(
  (SELECT payload::text NOT ILIKE '%rivera%' AND payload::text NOT LIKE '%48765%'
          AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(payload) AS k)
              = ARRAY['admit_window', 'home_state', 'insurance_carrier', 'level_of_care', 'location_preference', 'must_haves', 'needs', 'note', 'payment', 'population']
     FROM public.placement_requests WHERE id = '91000000-0000-0000-0000-0000000000a7'),
  'no label, no case title, no budget: exactly the ten allowed keys'
);
SELECT is(
  (SELECT (respond_by = now() + interval '24 hours')::text || ':' || status || ':' || (case_id = 'f1000000-0000-0000-0000-0000000000a7')::text
          || ':' || (created_by = 'b1000000-0000-0000-0000-0000000000a7')::text
     FROM public.placement_requests WHERE id = '91000000-0000-0000-0000-0000000000a7'),
  'true:open:true:true',
  'answers are due in 24 hours; the request is open and linked to the match''s case'
);
SELECT is(
  (SELECT jsonb_array_length(public.create_placement_request('91000000-0000-0000-0000-0000000000a7', 'f2000000-0000-0000-0000-0000000000a7', NULL,
            ARRAY['e5000000-0000-0000-0000-0000000000a7']::uuid[], 4, 'asap', 'Different') -> 'recipients')
          || ':' || (SELECT count(*) FROM public.placement_request_recipients WHERE request_id = '91000000-0000-0000-0000-0000000000a7')
          || ':' || (SELECT payload ->> 'note' FROM public.placement_requests WHERE id = '91000000-0000-0000-0000-0000000000a7')),
  '4:4:Prefers a quiet setting',
  'a replay with the same id is a no-op: the request already made comes back unchanged'
);
-- Without a saved match: only the allowed criteria are read.
SELECT lives_ok(
  $$ SELECT public.create_placement_request('92000000-0000-0000-0000-0000000000a7', NULL,
       '{"client_label":"Rivera family","max_budget":48765,"budget":"$50k","email":"jane.rivera@example.com","phone":"5415550199",
         "name":"Jane Rivera","level_of_care":"Detox","population":"Men","therapies":["MAT","Trauma",7,"Jane"],"must_have_therapies":"MAT",
         "insurance":"Cigna","state":"wa","location_preference":"Away from home","home_address":"12 Elm St"}'::jsonb,
       ARRAY['e1000000-0000-0000-0000-0000000000a7']::uuid[], 48, 'asap', NULL) $$,
  'a request from the match fields alone'
);
SELECT is(
  (SELECT payload FROM public.placement_requests WHERE id = '92000000-0000-0000-0000-0000000000a7'),
  '{"level_of_care":"Detox","population":"Men","must_haves":["MAT"],"needs":["Trauma"],"payment":"insurance","insurance_carrier":"Cigna","home_state":"WA","location_preference":"Away from home","admit_window":"asap","note":null}'::jsonb,
  'a label, budget, email, phone, name or address sent by the client is stripped'
);
SELECT throws_ok(
  $$ SELECT public.create_placement_request(gen_random_uuid(), NULL, '{"client_label":"Rivera family","level_of_care":"Detox"}'::jsonb,
       ARRAY['e1000000-0000-0000-0000-0000000000a7']::uuid[], 24, 'asap', 'Rivera family needs detox first') $$,
  '22023', 'The note mentions how this client is labeled in your workspace. Leave names and labels out.',
  'a note naming the client''s label is refused'
);
SELECT throws_ok(
  $$ SELECT public.create_placement_request(gen_random_uuid(), 'f2000000-0000-0000-0000-0000000000a7', NULL,
       ARRAY['e1000000-0000-0000-0000-0000000000a7']::uuid[], 24, 'asap', 'See the Rivera intervention notes') $$,
  '22023', 'The note mentions how this client is labeled in your workspace. Leave names and labels out.',
  'a note naming the case title is refused'
);
SELECT throws_ok(
  $$ SELECT public.create_placement_request(gen_random_uuid(), 'f2000000-0000-0000-0000-0000000000a7', NULL,
       ARRAY['e1000000-0000-0000-0000-0000000000a7']::uuid[], 24, 'asap', 'Mom: 541 555 0199') $$,
  '22023', 'Leave phone numbers, ID numbers and dates out of the note',
  'a note with a phone number is refused'
);
SELECT throws_ok(
  $$ SELECT public.create_placement_request(gen_random_uuid(), 'f2000000-0000-0000-0000-0000000000a7', NULL,
       ARRAY['e1000000-0000-0000-0000-0000000000a7']::uuid[], 12, 'asap', NULL) $$,
  '22023', 'Choose 4, 24 or 48 hours for programs to answer',
  'the response window is 4, 24 or 48 hours'
);
SELECT throws_ok(
  $$ SELECT public.create_placement_request(gen_random_uuid(), 'f2000000-0000-0000-0000-0000000000a7', NULL,
       ARRAY['e1000000-0000-0000-0000-0000000000a7', 'e2000000-0000-0000-0000-0000000000a7', 'e3000000-0000-0000-0000-0000000000a7',
             'e4000000-0000-0000-0000-0000000000a7', 'e5000000-0000-0000-0000-0000000000a7', 'e6000000-0000-0000-0000-0000000000a7',
             'e7000000-0000-0000-0000-0000000000a7', 'e8000000-0000-0000-0000-0000000000a7', 'e9000000-0000-0000-0000-0000000000a7']::uuid[],
       24, 'asap', NULL) $$,
  '22023', 'A request can go to at most 8 programs',
  'at most 8 programs per request'
);
SELECT throws_ok(
  $$ SELECT public.create_placement_request(gen_random_uuid(), 'f2000000-0000-0000-0000-0000000000a7', NULL, ARRAY[]::uuid[], 24, 'asap', NULL) $$,
  '22023', 'Choose at least one program to ask',
  'at least one program'
);
SELECT throws_ok(
  $$ SELECT public.create_placement_request(gen_random_uuid(), 'f2000000-0000-0000-0000-0000000000a7', NULL,
       ARRAY['e1000000-0000-0000-0000-0000000000a7', 'ea000000-0000-0000-0000-0000000000a7']::uuid[], 24, 'asap', NULL) $$,
  'P0002', 'One of these programs is not in your workspace',
  'another practice''s partner cannot be asked'
);
SELECT throws_ok(
  $$ SELECT public.create_placement_request(gen_random_uuid(), 'f3000000-0000-0000-0000-0000000000a7', NULL,
       ARRAY['e1000000-0000-0000-0000-0000000000a7']::uuid[], 24, 'asap', NULL) $$,
  'P0002', 'Save the match first, then ask programs',
  'another practice''s match cannot be used'
);
SELECT is(
  (SELECT jsonb_array_length(public.create_placement_request('94000000-0000-0000-0000-0000000000a7', 'f2000000-0000-0000-0000-0000000000a7', NULL,
            ARRAY['e1000000-0000-0000-0000-0000000000a7', 'e1000000-0000-0000-0000-0000000000a7', NULL, 'e4000000-0000-0000-0000-0000000000a7']::uuid[],
            4, 'flexible', NULL) -> 'recipients')),
  2,
  'a program listed twice is asked once'
);
RESET ROLE;

-- The other side of the replay rule: an id another workspace used.
SELECT set_config('request.jwt.claim.sub', 'b3000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.create_placement_request('91000000-0000-0000-0000-0000000000a7', 'f3000000-0000-0000-0000-0000000000a7', NULL,
       ARRAY['ea000000-0000-0000-0000-0000000000a7']::uuid[], 24, 'asap', NULL) $$,
  'P0002', 'Placement request not found',
  'a replayed id from another workspace reveals nothing'
);
SELECT lives_ok(
  $$ SELECT public.create_placement_request('95000000-0000-0000-0000-0000000000a7', 'f3000000-0000-0000-0000-0000000000a7', NULL,
       ARRAY['ea000000-0000-0000-0000-0000000000a7']::uuid[], 24, 'asap', NULL) $$,
  'practice Q asks the same program'
);
SELECT is((SELECT count(*)::integer FROM public.placement_requests), 1, 'practice Q reads only its own request');
SELECT is((SELECT count(*)::integer FROM public.placement_request_recipients), 1, 'and only its own recipients');
RESET ROLE;

-- ===========================================================================
-- C. Who reads what
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.placement_requests WHERE id IN ('91000000-0000-0000-0000-0000000000a7', '92000000-0000-0000-0000-0000000000a7', '94000000-0000-0000-0000-0000000000a7')), 3,
  'a teammate reads the practice''s requests');
SELECT is((SELECT count(*)::integer FROM public.placement_requests WHERE id = '95000000-0000-0000-0000-0000000000a7'), 0,
  'and never another practice''s');
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.placement_requests) + (SELECT count(*)::integer FROM public.placement_request_recipients), 0,
  'a center reads nothing from the tables directly');
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', '', true);
SET LOCAL ROLE anon;
SELECT throws_ok($$ SELECT count(*) FROM public.placement_requests $$, '42501', NULL, 'anon cannot read the requests');
SELECT throws_ok($$ SELECT count(*) FROM public.placement_request_recipients $$, '42501', NULL, 'anon cannot read the recipients');
SELECT throws_ok($$ SELECT * FROM public.list_center_placement_requests() $$, '42501', NULL, 'anon cannot call the center list');
SELECT throws_ok(
  $$ SELECT public.create_placement_request(gen_random_uuid(), NULL, NULL, ARRAY['e1000000-0000-0000-0000-0000000000a7']::uuid[], 24, 'asap', NULL) $$,
  '42501', NULL, 'anon cannot send a request'
);
RESET ROLE;

-- ===========================================================================
-- D. A center sees and answers only its own
-- ===========================================================================

SELECT set_config('test.r1_pa', id::text, true) FROM public.placement_request_recipients
 WHERE request_id = '91000000-0000-0000-0000-0000000000a7' AND partner_id = 'e1000000-0000-0000-0000-0000000000a7';
SELECT set_config('test.r1_pb', id::text, true) FROM public.placement_request_recipients
 WHERE request_id = '91000000-0000-0000-0000-0000000000a7' AND partner_id = 'e2000000-0000-0000-0000-0000000000a7';
SELECT set_config('test.r1_pc', id::text, true) FROM public.placement_request_recipients
 WHERE request_id = '91000000-0000-0000-0000-0000000000a7' AND partner_id = 'e3000000-0000-0000-0000-0000000000a7';
SELECT set_config('test.r1_pd', id::text, true) FROM public.placement_request_recipients
 WHERE request_id = '91000000-0000-0000-0000-0000000000a7' AND partner_id = 'e4000000-0000-0000-0000-0000000000a7';
SELECT set_config('test.rq_qa', id::text, true) FROM public.placement_request_recipients
 WHERE request_id = '95000000-0000-0000-0000-0000000000a7';

SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT string_agg(l.request_id::text || ':' || l.practice_name || ':' || l.status, ',' ORDER BY l.request_id)
     FROM public.list_center_placement_requests() AS l),
  '91000000-0000-0000-0000-0000000000a7:Cascade Interventions:sent,92000000-0000-0000-0000-0000000000a7:Cascade Interventions:sent,'
  || '94000000-0000-0000-0000-0000000000a7:Cascade Interventions:sent,95000000-0000-0000-0000-0000000000a7:Harbor Family Services:sent',
  'a center sees every request addressed to its listing, with the asking practice''s name'
);
SELECT ok(
  (SELECT bool_and(to_jsonb(l)::text NOT ILIKE '%rivera%' AND to_jsonb(l)::text NOT LIKE '%48765%'
                   AND NOT (to_jsonb(l) ? 'rank') AND NOT (to_jsonb(l) ? 'partner_id') AND NOT (to_jsonb(l) ? 'org_id')
                   AND NOT (to_jsonb(l) ? 'program_name') AND NOT (to_jsonb(l) ? 'case_id') AND NOT (to_jsonb(l) ? 'match_profile_id'))
     FROM public.list_center_placement_requests() AS l),
  'nothing identifies the client, and a program never learns its rank or who else was asked'
);
SELECT is(public.mark_placement_request_viewed(current_setting('test.r1_pa')::uuid), true, 'opening a request marks it viewed');
SELECT is(public.mark_placement_request_viewed(current_setting('test.r1_pa')::uuid), false, 'once');
SELECT throws_ok(
  format('SELECT public.mark_placement_request_viewed(%L)', current_setting('test.r1_pb')),
  'P0002', 'Placement request not found',
  'a center cannot touch another program''s row'
);
SELECT is(
  (SELECT (v ->> 'status') || ':' || (v ->> 'bed_available') || ':' || (v ->> 'daily_rate') || ':' || (v ->> 'can_respond')
     FROM public.respond_to_placement_request(current_setting('test.r1_pa')::uuid, 'yes', 'yes', CURRENT_DATE + 2, 950, ' Most plans ', ' Happy to help ') AS v),
  'responded:yes:950:true',
  'a center answers its own row'
);
SELECT is(
  (SELECT (v ->> 'status') || ':' || (v ->> 'likely_accept') || ':' || (v ->> 'note')
     FROM public.respond_to_placement_request(current_setting('test.r1_pa')::uuid, 'waitlist', 'no', NULL, NULL, '', 'We do not serve this population right now') AS v),
  'declined:no:We do not serve this population right now',
  'and can change it before the deadline (no is a decline)'
);
SELECT throws_ok(
  format('SELECT public.respond_to_placement_request(%L, %L, %L, NULL, NULL, %L, %L)', current_setting('test.r1_pb'), 'yes', 'yes', '', ''),
  'P0002', 'Placement request not found',
  'a center cannot answer for another program'
);
SELECT throws_ok(
  format('SELECT public.respond_to_placement_request(%L, %L, %L, NULL, NULL, %L, %L)', current_setting('test.r1_pc'), 'yes', 'yes', '', ''),
  'P0002', 'Placement request not found',
  'a manual row cannot be answered in the portal'
);
SELECT throws_ok(
  format('SELECT public.respond_to_placement_request(%L, %L, %L, NULL, NULL, %L, %L)', current_setting('test.rq_qa'), 'maybe', 'yes', '', ''),
  '22023', 'Choose yes, no or waitlist for a bed',
  'an answer needs a bed answer'
);
SELECT throws_ok(
  format('SELECT public.respond_to_placement_request(%L, %L, %L, NULL, 0, %L, %L)', current_setting('test.rq_qa'), 'yes', 'yes', '', ''),
  '22023', 'The daily rate is whole dollars, from 1 to 100,000',
  'a daily rate is whole dollars'
);
SELECT throws_ok(
  format('SELECT public.respond_to_placement_request(%L, %L, %L, %L, NULL, %L, %L)', current_setting('test.rq_qa'), 'yes', 'yes', (CURRENT_DATE + 400)::text, '', ''),
  '22023', 'Check the earliest admit date',
  'an admit date within the year'
);
SELECT throws_ok(
  format('SELECT public.log_manual_response(%L, %L, %L, NULL, NULL, %L, %L)', current_setting('test.r1_pa'), 'yes', 'yes', '', ''),
  'P0002', 'That program is not on this request',
  'a center cannot use the practice''s manual log'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT string_agg(l.recipient_id::text, ',') FROM public.list_center_placement_requests() AS l),
  current_setting('test.r1_pb'),
  'another center sees only the row addressed to its own listing'
);
RESET ROLE;

-- The practice sees the program's answer.
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT status || ':' || bed_available || ':' || likely_accept || ':' || entered_by_practice::text || ':' || (viewed_at IS NOT NULL)::text
     FROM public.placement_request_recipients WHERE id = current_setting('test.r1_pa')::uuid),
  'declined:waitlist:no:false:true',
  'the practice reads the program''s own answer'
);
SELECT throws_ok(
  format('SELECT public.respond_to_placement_request(%L, %L, %L, NULL, NULL, %L, %L)', current_setting('test.r1_pb'), 'yes', 'yes', '', ''),
  'P0002', 'Placement request not found',
  'a practice cannot answer as a program'
);
RESET ROLE;

-- After the deadline: closed for the program, still open to the practice's log.
UPDATE public.placement_requests SET created_at = now() - interval '25 hours', respond_by = now() - interval '1 hour'
 WHERE id = '91000000-0000-0000-0000-0000000000a7';
SELECT set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT l.status || ':' || l.can_respond::text || ':' || l.request_status FROM public.list_center_placement_requests() AS l),
  'expired:false:open',
  'an unanswered request reads expired once the deadline passed'
);
SELECT throws_ok(
  format('SELECT public.respond_to_placement_request(%L, %L, %L, NULL, NULL, %L, %L)', current_setting('test.r1_pb'), 'yes', 'yes', '', ''),
  '22023', 'The time to answer this request has passed',
  'answering after the deadline fails'
);
RESET ROLE;

-- ===========================================================================
-- E. Answers the practitioner logs by hand
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT (v ->> 'status') || ':' || (v ->> 'entered_by_practice') || ':' || (v ->> 'earliest_admit_on') || ':' || (v ->> 'cost_note')
     FROM public.log_manual_response(current_setting('test.r1_pc')::uuid, 'yes', 'maybe', CURRENT_DATE + 3, NULL, ' About 900 a day ', 'Spoke with intake') AS v),
  'responded:true:' || (CURRENT_DATE + 3)::text || ':About 900 a day',
  'a phone answer is logged by hand, after the deadline too'
);
SELECT lives_ok(
  format('SELECT public.log_manual_response(%L, %L, %L, NULL, 700, %L, %L)', current_setting('test.r1_pb'), 'no', 'yes', '', 'They called back'),
  'a portal program that phoned instead can be logged too'
);
SELECT throws_ok(
  format('SELECT public.log_manual_response(%L, %L, %L, NULL, NULL, %L, %L)', current_setting('test.r1_pa'), 'yes', 'yes', '', ''),
  '22023', 'The program already answered in ReferralFit',
  'the practice never overwrites a program''s own answer'
);
SELECT throws_ok(
  format('SELECT public.log_manual_response(%L, %L, %L, NULL, NULL, %L, %L)', current_setting('test.r1_pd'), 'yes', 'perhaps', '', ''),
  '22023', 'Choose yes, maybe or no for likely to accept',
  'a logged answer is checked like a program''s'
);
SELECT throws_ok(
  format('SELECT public.log_manual_response(%L, %L, %L, NULL, NULL, %L, %L)', current_setting('test.rq_qa'), 'yes', 'yes', '', ''),
  'P0002', 'That program is not on this request',
  'a practice cannot log on another practice''s request'
);
RESET ROLE;

-- What the practitioner logged from a call is the practice's own record:
-- the program never sees it (its note could say anything).
SELECT set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT l.status || ':' || coalesce(l.bed_available, 'none') || ':' || coalesce(l.note, 'none') || ':' || coalesce(l.daily_rate::text, 'none')
     FROM public.list_center_placement_requests() AS l),
  'expired:none:none:none',
  'a program never sees an answer the practice logged by hand'
);
RESET ROLE;

-- ===========================================================================
-- F. Cancelled and closed requests
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT (v -> 'request' ->> 'status') || ':' || ((v -> 'request' ->> 'closed_at') IS NOT NULL)::text
     FROM public.cancel_placement_request('94000000-0000-0000-0000-0000000000a7') AS v),
  'cancelled:true',
  'the practice cancels a request'
);
SELECT is(
  (SELECT v -> 'request' ->> 'status' FROM public.close_placement_request('94000000-0000-0000-0000-0000000000a7') AS v),
  'cancelled',
  'a finished request stays as it is (a retry is safe)'
);
SELECT is(
  (SELECT v -> 'request' ->> 'status' FROM public.close_placement_request('92000000-0000-0000-0000-0000000000a7') AS v),
  'closed',
  'a placement found closes the request'
);
SELECT set_config('test.r4_pa', id::text, true) FROM public.placement_request_recipients
 WHERE request_id = '94000000-0000-0000-0000-0000000000a7' AND partner_id = 'e1000000-0000-0000-0000-0000000000a7';
SELECT throws_ok(
  format('SELECT public.log_manual_response(%L, %L, %L, NULL, NULL, %L, %L)', current_setting('test.r4_pa'), 'yes', 'yes', '', ''),
  '22023', 'This request was cancelled',
  'nothing is logged on a cancelled request'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', 'b3000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.cancel_placement_request('91000000-0000-0000-0000-0000000000a7') $$,
  'P0002', 'Placement request not found',
  'a practice cannot cancel another practice''s request'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT l.request_status || ':' || l.can_respond::text FROM public.list_center_placement_requests() AS l WHERE l.request_id = '94000000-0000-0000-0000-0000000000a7'),
  'cancelled:false',
  'the program sees a cancelled request as closed'
);
SELECT throws_ok(
  format('SELECT public.respond_to_placement_request(%L, %L, %L, NULL, NULL, %L, %L)', current_setting('test.r4_pa'), 'yes', 'yes', '', ''),
  '22023', 'This request is closed. The practice is no longer waiting for answers.',
  'nobody answers a cancelled request'
);
RESET ROLE;

-- ===========================================================================
-- G. The daily limit
-- ===========================================================================

-- P has sent 91 (moved back 25 hours), 92 and 94 in the last 24 hours.
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT count(*)::integer FROM generate_series(1, 18) AS g,
          LATERAL public.create_placement_request(gen_random_uuid(), 'f2000000-0000-0000-0000-0000000000a7', NULL,
                  ARRAY['e4000000-0000-0000-0000-0000000000a7']::uuid[], 24, 'asap', 'Ask ' || g) AS made),
  18,
  'twenty requests fit in 24 hours'
);
SELECT throws_ok(
  $$ SELECT public.create_placement_request(gen_random_uuid(), 'f2000000-0000-0000-0000-0000000000a7', NULL,
       ARRAY['e4000000-0000-0000-0000-0000000000a7']::uuid[], 24, 'asap', NULL) $$,
  '22023', 'Your practice has sent 20 placement requests in the last 24 hours. Try again later, or call the programs directly.',
  'the twenty-first is refused'
);
SELECT lives_ok(
  $$ SELECT public.create_placement_request('92000000-0000-0000-0000-0000000000a7', NULL, NULL,
       ARRAY['e4000000-0000-0000-0000-0000000000a7']::uuid[], 24, 'asap', NULL) $$,
  'a replay still answers at the limit'
);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'b3000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$ SELECT public.create_placement_request(gen_random_uuid(), 'f3000000-0000-0000-0000-0000000000a7', NULL,
       ARRAY['ea000000-0000-0000-0000-0000000000a7']::uuid[], 4, 'asap', NULL) $$,
  'another practice has its own limit'
);
RESET ROLE;

-- ===========================================================================
-- H. Production-grant emulation
-- ===========================================================================

-- Production's default ACL grants ALL on new tables. Even with every
-- privilege granted, RLS keeps anon out and refuses every client write.
GRANT ALL ON TABLE public.placement_requests TO anon, authenticated;
GRANT ALL ON TABLE public.placement_request_recipients TO anon, authenticated;
SET LOCAL ROLE anon;
SELECT is((SELECT count(*)::integer FROM public.placement_requests) + (SELECT count(*)::integer FROM public.placement_request_recipients), 0,
  'production grants: anon still reads no rows');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ INSERT INTO public.placement_requests (id, org_id, payload)
     VALUES (gen_random_uuid(), current_setting('test.org_p')::uuid, '{"level_of_care":"Detox"}') $$,
  '42501', NULL,
  'production grants: a direct insert is refused by RLS'
);
UPDATE public.placement_requests SET payload = payload || '{"note":"changed directly"}' WHERE id = '92000000-0000-0000-0000-0000000000a7';
UPDATE public.placement_request_recipients SET status = 'sent', responded_at = NULL, bed_available = NULL, likely_accept = NULL
 WHERE id = current_setting('test.r1_pc')::uuid;
DELETE FROM public.placement_request_recipients WHERE request_id = '91000000-0000-0000-0000-0000000000a7';
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
UPDATE public.placement_request_recipients SET status = 'responded', responded_at = now(), bed_available = 'yes', likely_accept = 'yes'
 WHERE id = current_setting('test.r4_pa')::uuid;
RESET ROLE;
SELECT is(
  (SELECT coalesce(q.payload ->> 'note', 'none') || ':' || (SELECT count(*) FROM public.placement_request_recipients WHERE request_id = '91000000-0000-0000-0000-0000000000a7')
          || ':' || (SELECT status FROM public.placement_request_recipients WHERE id = current_setting('test.r1_pc')::uuid)
          || ':' || (SELECT status FROM public.placement_request_recipients WHERE id = current_setting('test.r4_pa')::uuid)
     FROM public.placement_requests q WHERE q.id = '92000000-0000-0000-0000-0000000000a7'),
  'none:4:responded:sent',
  'production grants: direct updates and deletes change nothing, for the practice or the program'
);
REVOKE ALL ON TABLE public.placement_requests FROM anon, authenticated;
REVOKE ALL ON TABLE public.placement_request_recipients FROM anon, authenticated;
GRANT SELECT ON TABLE public.placement_requests TO authenticated;
GRANT SELECT ON TABLE public.placement_request_recipients TO authenticated;

-- ===========================================================================
-- I. A solo practitioner joins: their requests move with them
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'b4000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT public.import_global_partner('d1000000-0000-0000-0000-0000000000a7', 'eb000000-0000-0000-0000-0000000000a7');
INSERT INTO public.partners (id, owner_id, name, organization) VALUES
  ('ec000000-0000-0000-0000-0000000000a7', 'b4000000-0000-0000-0000-0000000000a7', 'Intake', 'Solo Private Program');
INSERT INTO public.match_profiles (id, client_label, level_of_care, state, insurance, therapies)
VALUES ('f4000000-0000-0000-0000-0000000000a7', 'Solo client', 'Inpatient', 'OR', 'Cash pay', ARRAY['Trauma']);
SELECT public.create_placement_request('96000000-0000-0000-0000-0000000000a7', 'f4000000-0000-0000-0000-0000000000a7', NULL,
  ARRAY['eb000000-0000-0000-0000-0000000000a7', 'ec000000-0000-0000-0000-0000000000a7']::uuid[], 48, 'two_weeks', NULL);
SELECT public.create_placement_request('97000000-0000-0000-0000-0000000000a7', NULL, '{"level_of_care":"Detox"}'::jsonb,
  ARRAY['ec000000-0000-0000-0000-0000000000a7']::uuid[], 24, 'asap', NULL);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT set_config('test.invite', code, true) FROM public.create_org_invite();
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', 'b4000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$ SELECT public.accept_org_invite(current_setting('test.invite')) $$, 'a solo practitioner with open requests joins the practice');
SELECT lives_ok($$ SET CONSTRAINTS ALL IMMEDIATE $$, 'every deferred relationship is consistent after the join');
RESET ROLE;
SELECT is(
  (SELECT string_agg(coalesce(r.partner_id::text, 'none') || ':' || (r.org_id = current_setting('test.org_p')::uuid)::text, ',' ORDER BY r.rank)
     FROM public.placement_request_recipients r WHERE r.request_id = '96000000-0000-0000-0000-0000000000a7'),
  'e1000000-0000-0000-0000-0000000000a7:true,ec000000-0000-0000-0000-0000000000a7:true',
  'a program the team already tracks now points at the team''s copy; the other moves as it is'
);
SELECT is(
  (SELECT string_agg((q.org_id = current_setting('test.org_p')::uuid)::text, ',' ORDER BY q.id)
     FROM public.placement_requests q WHERE q.id IN ('96000000-0000-0000-0000-0000000000a7', '97000000-0000-0000-0000-0000000000a7')),
  'true,true',
  'both requests (with and without a saved match) move to the team'
);
SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT l.practice_name FROM public.list_center_placement_requests() AS l WHERE l.request_id = '96000000-0000-0000-0000-0000000000a7'),
  'Cascade Interventions',
  'the program now sees the team''s name on it'
);
RESET ROLE;

-- ===========================================================================
-- J. The 1.0.4 app's own deletes, and accounts going away
-- ===========================================================================

SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$ DELETE FROM public.partners WHERE id = 'e3000000-0000-0000-0000-0000000000a7' $$,
  'the app still deletes a partner that was asked (1.0.4 deletes partners directly)');
SELECT lives_ok($$ DELETE FROM public.match_profiles WHERE id = 'f2000000-0000-0000-0000-0000000000a7' $$,
  'and removes a saved match that has requests');
SELECT is(
  (SELECT coalesce(r.partner_id::text, 'none') || ':' || r.program_name || ':' || r.status
     FROM public.placement_request_recipients r WHERE r.id = current_setting('test.r1_pc')::uuid),
  'none:Unclaimed Oaks:responded',
  'the answer stays, under the program''s name'
);
SELECT is(
  (SELECT coalesce(q.match_profile_id::text, 'none') || ':' || q.status FROM public.placement_requests q WHERE q.id = '91000000-0000-0000-0000-0000000000a7'),
  'none:open',
  'the request stays without its match'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', 'b3000000-0000-0000-0000-0000000000a7', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$ SELECT public.delete_own_account() $$, 'a solo practice with requests can delete its account');
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.placement_requests WHERE org_id = current_setting('test.org_q')::uuid), 0,
  'its requests go with its workspace');

SELECT set_config('request.jwt.claim.sub', '', true);
DELETE FROM auth.users WHERE id = 'c1000000-0000-0000-0000-0000000000a7';
SELECT is(
  (SELECT (responded_by IS NULL)::text || ':' || status FROM public.placement_request_recipients WHERE id = current_setting('test.r1_pa')::uuid),
  'true:declined',
  'a deleted center account leaves its answer, unattributed'
);

SELECT * FROM finish();
ROLLBACK;
