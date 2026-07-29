-- Focused regression coverage for 20260728232820_harden_owner_relationships.sql.
-- Run after a local migration reset with: supabase test db

BEGIN;
SELECT plan(61);

WITH expected(child_table, constraint_name, parent_table, child_columns, delete_action) AS (
  VALUES
    ('touches', 'touches_partner_owner_fk', 'partners', ARRAY['partner_id','owner_id'], 'c'),
    ('referrals', 'referrals_partner_owner_fk', 'partners', ARRAY['partner_id','owner_id'], 'c'),
    ('follow_ups', 'follow_ups_partner_owner_fk', 'partners', ARRAY['partner_id','owner_id'], 'c'),
    ('follow_ups', 'follow_ups_referral_owner_fk', 'referrals', ARRAY['referral_id','owner_id'], 'c'),
    ('case_contacts', 'case_contacts_case_owner_fk', 'cases', ARRAY['case_id','owner_id'], 'c'),
    ('case_events', 'case_events_case_owner_fk', 'cases', ARRAY['case_id','owner_id'], 'c'),
    ('case_documents', 'case_documents_case_owner_fk', 'cases', ARRAY['case_id','owner_id'], 'c'),
    ('match_profiles', 'match_profiles_partner_owner_fk', 'partners', ARRAY['assigned_partner_id','owner_id'], 'n'),
    ('match_profiles', 'match_profiles_referral_owner_fk', 'referrals', ARRAY['referral_id','owner_id'], 'n'),
    ('match_profiles', 'match_profiles_case_owner_fk', 'cases', ARRAY['case_id','owner_id'], 'n'),
    ('referrals', 'referrals_match_profile_owner_fk', 'match_profiles', ARRAY['match_profile_id','owner_id'], 'n'),
    ('referrals', 'referrals_case_owner_fk', 'cases', ARRAY['case_id','owner_id'], 'n'),
    ('cases', 'cases_match_profile_owner_fk', 'match_profiles', ARRAY['match_profile_id','owner_id'], 'n'),
    ('follow_ups', 'follow_ups_case_owner_fk', 'cases', ARRAY['case_id','owner_id'], 'n'),
    ('case_events', 'case_events_contact_owner_fk', 'case_contacts', ARRAY['contact_id','owner_id'], 'n'),
    ('case_events', 'case_events_referral_owner_fk', 'referrals', ARRAY['referral_id','owner_id'], 'n'),
    ('case_events', 'case_events_document_owner_fk', 'case_documents', ARRAY['document_id','owner_id'], 'n')
), actual AS (
  SELECT
    child.relname AS child_table,
    c.conname AS constraint_name,
    parent.relname AS parent_table,
    ARRAY(
      SELECT a.attname::text
      FROM unnest(c.conkey) WITH ORDINALITY AS key(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key.attnum
      ORDER BY key.ord
    ) AS child_columns,
    c.confdeltype::text AS delete_action,
    c.convalidated
  FROM pg_constraint c
  JOIN pg_class child ON child.oid = c.conrelid
  JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
  JOIN pg_class parent ON parent.oid = c.confrelid
  WHERE child_ns.nspname = 'public'
    AND c.conname LIKE '%_owner_fk'
)
SELECT is(
  (SELECT count(*)::integer
     FROM expected e
     JOIN actual a USING (child_table, constraint_name, parent_table, child_columns, delete_action)
    WHERE a.convalidated),
  17,
  'all 17 expected same-owner foreign keys exist, preserve delete behavior, and are validated'
);

SELECT is(
  (SELECT count(*)::integer
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND c.contype = 'u'
      AND c.conname IN (
        'partners_id_owner_key', 'referrals_id_owner_key',
        'match_profiles_id_owner_key', 'cases_id_owner_key',
        'case_contacts_id_owner_key', 'case_documents_id_owner_key'
      )),
  6,
  'all referenced parents expose composite unique keys'
);

SELECT ok(
  NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.touch_partner_last_contact()'::regprocedure),
  'touch trigger function is SECURITY INVOKER'
);

SELECT is(
  (SELECT proconfig FROM pg_proc WHERE oid = 'public.touch_partner_last_contact()'::regprocedure),
  ARRAY['search_path=pg_catalog'],
  'touch trigger function has a fixed minimal search_path'
);

SELECT ok(
  pg_get_functiondef('public.touch_partner_last_contact()'::regprocedure)
    LIKE '%p.owner_id = NEW.owner_id%',
  'touch trigger update matches both partner id and owner id'
);

SELECT is(
  (SELECT count(*)::integer
     FROM pg_proc p
     CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
    WHERE p.oid = 'public.touch_partner_last_contact()'::regprocedure
      AND acl.grantee = 0
      AND acl.privilege_type = 'EXECUTE'),
  0,
  'PUBLIC has no EXECUTE grant on the trigger function'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.touch_partner_last_contact()', 'EXECUTE'),
  'anon cannot execute the trigger function'
);

SELECT ok(
  NOT has_function_privilege('authenticated', 'public.touch_partner_last_contact()', 'EXECUTE'),
  'authenticated cannot execute the trigger function directly'
);

INSERT INTO auth.users (id, email)
VALUES
  ('10000000-0000-0000-0000-000000000001', 'owner-one@example.test'),
  ('20000000-0000-0000-0000-000000000002', 'owner-two@example.test');

INSERT INTO public.partners (id, owner_id, name)
VALUES (
  '30000000-0000-0000-0000-000000000003',
  '10000000-0000-0000-0000-000000000001',
  'Owner one partner'
);

SELECT throws_ok(
  $$
    INSERT INTO public.touches (owner_id, partner_id, kind)
    VALUES (
      '20000000-0000-0000-0000-000000000002',
      '30000000-0000-0000-0000-000000000003',
      'call'
    )
  $$,
  '23503',
  'insert or update on table "touches" violates foreign key constraint "touches_partner_owner_fk"',
  'a child cannot reference another owner''s parent'
);

INSERT INTO public.touches (owner_id, partner_id, kind, occurred_at)
VALUES (
  '10000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000003',
  'call',
  '2026-07-28 12:00:00+00'
);

SELECT is(
  (SELECT last_contact_at FROM public.partners
    WHERE id = '30000000-0000-0000-0000-000000000003'),
  '2026-07-28 12:00:00+00'::timestamptz,
  'same-owner touch updates its partner last-contact timestamp'
);

INSERT INTO public.match_profiles (id, owner_id, assigned_partner_id)
VALUES (
  '40000000-0000-0000-0000-000000000004',
  '10000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000003'
);
DELETE FROM public.partners
WHERE id = '30000000-0000-0000-0000-000000000003';

SELECT is(
  (SELECT assigned_partner_id FROM public.match_profiles
    WHERE id = '40000000-0000-0000-0000-000000000004'),
  NULL::uuid,
  'ON DELETE SET NULL clears only the nullable relationship column'
);

SELECT is(
  (SELECT owner_id FROM public.match_profiles
    WHERE id = '40000000-0000-0000-0000-000000000004'),
  '10000000-0000-0000-0000-000000000001'::uuid,
  'ON DELETE SET NULL preserves child ownership'
);

SELECT is(
  (SELECT count(*)::integer FROM public.touches
    WHERE partner_id = '30000000-0000-0000-0000-000000000003'),
  0,
  'ON DELETE CASCADE behavior is preserved'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.create_case_bundle(uuid,jsonb,jsonb,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.create_case_bundle(uuid,jsonb,jsonb,jsonb)', 'EXECUTE'),
  'only authenticated clients can call the transactional case-bundle RPC'
);

SELECT set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$
    SELECT public.create_case_bundle(
      '10000000-0000-0000-0000-000000000001'::uuid,
      '{"id":"50000000-0000-0000-0000-000000000005","title":"Bundle test","status":"inquiry","summary":"","payment_status":"none","paid_amount":0}'::jsonb,
      '{"id":"60000000-0000-0000-0000-000000000006","name":"Primary contact","is_primary":true}'::jsonb,
      '{"id":"70000000-0000-0000-0000-000000000007","title":"First call","due_on":"2026-07-29","status":"open","kind":"first_call"}'::jsonb
    )
  $$,
  'case bundle RPC creates its parent and children in one transaction'
);

SELECT is(
  (SELECT count(*)::integer
     FROM public.cases c
     JOIN public.case_contacts cc ON cc.case_id = c.id AND cc.owner_id = c.owner_id
     JOIN public.follow_ups f ON f.case_id = c.id AND f.owner_id = c.owner_id
    WHERE c.id = '50000000-0000-0000-0000-000000000005'
      AND c.owner_id = '10000000-0000-0000-0000-000000000001'),
  1,
  'case bundle assigns the authenticated owner consistently to all three rows'
);

SELECT is(
  (SELECT count(*)::integer
     FROM pg_proc
    WHERE oid IN (
      'public.create_case_bundle(uuid,jsonb,jsonb,jsonb)'::regprocedure,
      'public.update_case_with_event(jsonb,jsonb)'::regprocedure,
      'public.save_case_contact(jsonb)'::regprocedure,
      'public.complete_follow_up_with_next(jsonb,jsonb,jsonb)'::regprocedure,
      'public.complete_follow_up_with_outcome(jsonb,uuid,jsonb)'::regprocedure,
      'public.complete_follow_up_with_case(jsonb,jsonb,jsonb)'::regprocedure,
      'public.save_case_document_with_event(jsonb,jsonb)'::regprocedure,
      'public.restore_case_document(jsonb,uuid[])'::regprocedure,
      'public.save_match_with_case(uuid,jsonb,uuid)'::regprocedure,
      'public.assign_match_referral(uuid,jsonb,jsonb)'::regprocedure,
      'public.finalize_match_packet(uuid,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure,
      'public.log_contact_activity(uuid,jsonb,jsonb)'::regprocedure
    )
      AND NOT prosecdef
      AND proconfig = ARRAY['search_path=pg_catalog']),
  12,
  'all workflow RPCs are SECURITY INVOKER with a fixed minimal search_path'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.update_case_with_event(jsonb,jsonb)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.save_case_contact(jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.update_case_with_event(jsonb,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.save_case_contact(jsonb)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.complete_follow_up_with_next(jsonb,jsonb,jsonb)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.complete_follow_up_with_outcome(jsonb,uuid,jsonb)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.complete_follow_up_with_case(jsonb,jsonb,jsonb)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.save_case_document_with_event(jsonb,jsonb)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.restore_case_document(jsonb,uuid[])', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.save_match_with_case(uuid,jsonb,uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.assign_match_referral(uuid,jsonb,jsonb)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.finalize_match_packet(uuid,jsonb,jsonb,jsonb,jsonb,jsonb)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.log_contact_activity(uuid,jsonb,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.complete_follow_up_with_next(jsonb,jsonb,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.complete_follow_up_with_outcome(jsonb,uuid,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.complete_follow_up_with_case(jsonb,jsonb,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.save_case_document_with_event(jsonb,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.restore_case_document(jsonb,uuid[])', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.save_match_with_case(uuid,jsonb,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.assign_match_referral(uuid,jsonb,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.finalize_match_packet(uuid,jsonb,jsonb,jsonb,jsonb,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.log_contact_activity(uuid,jsonb,jsonb)', 'EXECUTE'),
  'only authenticated clients can call workflow RPCs'
);

SELECT lives_ok(
  $$
    SELECT public.save_case_contact(
      '{"id":"61000000-0000-0000-0000-000000000006","case_id":"50000000-0000-0000-0000-000000000005","name":"New primary","relationship":"parent","phone":"","email":"","is_primary":true,"note":""}'::jsonb
    )
  $$,
  'contact RPC saves a new primary transactionally'
);

SELECT is(
  (SELECT count(*)::integer FROM public.case_contacts
    WHERE case_id = '50000000-0000-0000-0000-000000000005' AND is_primary),
  1,
  'contact RPC leaves exactly one primary'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'case_contacts'
       AND indexname = 'case_contacts_one_primary_per_case_idx'
       AND indexdef LIKE '%UNIQUE%WHERE is_primary%'
  ),
  'case contacts have a partial unique primary-contact index'
);

SELECT throws_ok(
  $$
    INSERT INTO public.case_contacts (id, owner_id, case_id, name, relationship, phone, email, is_primary, note)
    VALUES ('62000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000005', 'Second primary', '', '', '', true, '')
  $$,
  '23505',
  NULL,
  'database invariant rejects a second primary contact'
);

SELECT has_trigger(
  'public', 'case_contacts', 'case_contacts_require_primary',
  'database requires one primary whenever a case has contacts'
);

SELECT throws_ok(
  $$
    INSERT INTO public.cases (id, owner_id, title, status, summary, payment_status, paid_amount)
    VALUES ('50000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', 'Move target', 'inquiry', '', 'none', 0);
    UPDATE public.case_contacts
       SET case_id = '50000000-0000-0000-0000-000000000006'
     WHERE id = '61000000-0000-0000-0000-000000000006';
    SET CONSTRAINTS case_contacts_require_primary IMMEDIATE;
  $$,
  '23514',
  NULL,
  'moving a primary contact cannot leave its old populated case without one'
);

SELECT throws_ok(
  $$
    SELECT public.update_case_with_event(
      '{"id":"50000000-0000-0000-0000-000000000005","title":"Bundle test","status":"consult","summary":"","payment_status":"none","paid_amount":0}'::jsonb,
      '{"id":"80000000-0000-0000-0000-000000000008","kind":"status_change","body":"inquiry → consult","contact_id":"99000000-0000-0000-0000-000000000099"}'::jsonb
    )
  $$,
  '23503',
  NULL,
  'an invalid event link aborts the atomic case update'
);

SELECT is(
  (SELECT status FROM public.cases WHERE id = '50000000-0000-0000-0000-000000000005'),
  'inquiry',
  'failed event insertion rolls back the case update'
);

SELECT lives_ok(
  $$
    SELECT public.update_case_with_event(
      '{"id":"50000000-0000-0000-0000-000000000005","title":"Bundle test","status":"consult","summary":"Ready","payment_status":"none","paid_amount":0}'::jsonb,
      '{"id":"81000000-0000-0000-0000-000000000008","kind":"status_change","body":"inquiry → consult","occurred_at":"2026-07-29T12:00:00Z"}'::jsonb
    )
  $$,
  'valid case update and audit event commit together'
);

SELECT is(
  (SELECT c.status || ':' || count(e.id)::text
     FROM public.cases c
     LEFT JOIN public.case_events e ON e.case_id = c.id AND e.id = '81000000-0000-0000-0000-000000000008'
    WHERE c.id = '50000000-0000-0000-0000-000000000005'
    GROUP BY c.status),
  'consult:1',
  'atomic case update persists both the new state and its audit event'
);

SELECT lives_ok(
  $$
    SELECT public.complete_follow_up_with_next(
      '{"id":"70000000-0000-0000-0000-000000000007","case_id":"50000000-0000-0000-0000-000000000005","title":"First call","due_on":"2026-07-29","status":"done","completed_at":"2026-07-29T13:00:00Z","note":"","kind":"first_call"}'::jsonb,
      '{"id":"72000000-0000-0000-0000-000000000007","case_id":"50000000-0000-0000-0000-000000000005","title":"Consult","due_on":"2026-07-30","status":"open","note":"","kind":"consult"}'::jsonb,
      '{"id":"82000000-0000-0000-0000-000000000008","case_id":"50000000-0000-0000-0000-000000000005","kind":"system","body":"Completed and set next"}'::jsonb
    )
  $$,
  'complete-next RPC commits completion, next step, and timeline event'
);

SELECT is(
  (SELECT count(*)::integer FROM public.follow_ups f
    WHERE (f.id = '70000000-0000-0000-0000-000000000007' AND f.status = 'done')
       OR (f.id = '72000000-0000-0000-0000-000000000007' AND f.status = 'open'))
  + (SELECT count(*)::integer FROM public.case_events WHERE id = '82000000-0000-0000-0000-000000000008'),
  3,
  'complete-next RPC persisted all three rows'
);

INSERT INTO public.partners (id, owner_id, name)
VALUES ('92000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000001', 'Outcome partner');
INSERT INTO public.referrals (id, owner_id, partner_id, client_label, direction, referred_on)
VALUES ('90000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000001', '92000000-0000-0000-0000-000000000009', 'Outcome test', 'outbound', '2026-07-29');
INSERT INTO public.follow_ups (id, owner_id, referral_id, title, due_on, status)
VALUES ('91000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-000000000009', 'Check outcome', '2026-07-29', 'open');

SELECT lives_ok(
  $$
    SELECT public.complete_follow_up_with_outcome(
      '{"id":"91000000-0000-0000-0000-000000000009","status":"done","completed_at":"2026-07-29T14:00:00Z","note":""}'::jsonb,
      '90000000-0000-0000-0000-000000000009'::uuid,
      '{"admitted":true,"admitted_on":"2026-07-29","outcome":"Placed","family_experience":5,"outcome_note":"Good handoff"}'::jsonb
    )
  $$,
  'outcome RPC commits follow-up completion and referral outcome together'
);

SELECT is(
  (SELECT f.status || ':' || r.outcome || ':' || r.family_experience::text
     FROM public.follow_ups f JOIN public.referrals r ON r.id = f.referral_id AND r.owner_id = f.owner_id
    WHERE f.id = '91000000-0000-0000-0000-000000000009'),
  'done:Placed:5',
  'outcome RPC persisted both sides of the workflow'
);

SELECT lives_ok(
  $$
    SELECT public.complete_follow_up_with_case(
      '{"id":"72000000-0000-0000-0000-000000000007","status":"done","completed_at":"2026-07-29T15:00:00Z","note":""}'::jsonb,
      '{"id":"50000000-0000-0000-0000-000000000005","title":"Bundle test","status":"engaged","summary":"Ready","payment_status":"none","paid_amount":0}'::jsonb,
      '{"id":"83000000-0000-0000-0000-000000000008","kind":"system","body":"Closed the loop"}'::jsonb
    )
  $$,
  'case close-loop RPC commits follow-up, case state, and event together'
);

SELECT is(
  (SELECT f.status || ':' || c.status || ':' || count(e.id)::text
     FROM public.follow_ups f
     JOIN public.cases c ON c.id = f.case_id AND c.owner_id = f.owner_id
     LEFT JOIN public.case_events e ON e.case_id = c.id AND e.id = '83000000-0000-0000-0000-000000000008'
    WHERE f.id = '72000000-0000-0000-0000-000000000007'
    GROUP BY f.status, c.status),
  'done:engaged:1',
  'case close-loop RPC persisted all three workflow changes'
);

SELECT lives_ok(
  $$
    SELECT public.save_case_document_with_event(
      '{"id":"93000000-0000-0000-0000-000000000009","case_id":"50000000-0000-0000-0000-000000000005","label":"Photo","storage_path":"10000000-0000-0000-0000-000000000001/50000000-0000-0000-0000-000000000005/93000000-0000-0000-0000-000000000009.jpg","mime_type":"image/jpeg"}'::jsonb,
      '{"id":"94000000-0000-0000-0000-000000000009","case_id":"50000000-0000-0000-0000-000000000005","kind":"document","body":"Added document: Photo","document_id":"93000000-0000-0000-0000-000000000009"}'::jsonb
    )
  $$,
  'document RPC commits metadata and its timeline event together'
);

SELECT is(
  (SELECT count(*)::integer FROM public.case_documents d
    JOIN public.case_events e ON e.document_id = d.id AND e.owner_id = d.owner_id
   WHERE d.id = '93000000-0000-0000-0000-000000000009'),
  1,
  'document metadata and event share the authenticated owner'
);

DELETE FROM public.case_documents WHERE id = '93000000-0000-0000-0000-000000000009';
SELECT lives_ok(
  $$
    SELECT public.restore_case_document(
      '{"id":"93000000-0000-0000-0000-000000000009","case_id":"50000000-0000-0000-0000-000000000005","label":"Photo","storage_path":"10000000-0000-0000-0000-000000000001/50000000-0000-0000-0000-000000000005/93000000-0000-0000-0000-000000000009.jpg","mime_type":"image/jpeg"}'::jsonb,
      ARRAY['94000000-0000-0000-0000-000000000009'::uuid]
    )
  $$,
  'document compensation restores metadata and timeline links atomically'
);

SELECT is(
  (SELECT count(*)::integer FROM public.case_documents d
    JOIN public.case_events e ON e.document_id = d.id AND e.owner_id = d.owner_id
   WHERE d.id = '93000000-0000-0000-0000-000000000009'),
  1,
  'restored document is relinked to its timeline event'
);

SELECT throws_ok(
  $$ SELECT public.create_case_bundle(
    '20000000-0000-0000-0000-000000000002'::uuid,
    '{"id":"51000000-0000-0000-0000-000000000005","title":"Wrong owner"}'::jsonb,
    '{"id":"62000000-0000-0000-0000-000000000006","name":"Wrong owner"}'::jsonb,
    '{"id":"73000000-0000-0000-0000-000000000007","title":"Wrong owner","due_on":"2026-07-30"}'::jsonb
  ) $$,
  '42501', NULL,
  'case creation rejects a request whose initiating owner no longer matches auth'
);

INSERT INTO public.partners (id, owner_id, name)
VALUES ('31000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','Packet partner');

SELECT lives_ok(
  $$ SELECT public.save_match_with_case(
    '10000000-0000-0000-0000-000000000001'::uuid,
    '{"id":"40000000-0000-0000-0000-000000000004","client_label":"Case match","level_of_care":"Residential","state":"OR","insurance":"Cash pay","network_preferences":[],"therapies":[],"status":"Matching"}'::jsonb,
    '50000000-0000-0000-0000-000000000005'::uuid
  ) $$,
  'match save and case link commit in one transaction'
);

SELECT is(
  (SELECT (m.case_id = c.id AND c.match_profile_id = m.id)::text
     FROM public.match_profiles m JOIN public.cases c ON c.id=m.case_id
    WHERE m.id='40000000-0000-0000-0000-000000000004'),
  'true',
  'match and case contain the same two-sided link'
);

SELECT lives_ok(
  $$ SELECT public.assign_match_referral(
    '10000000-0000-0000-0000-000000000001'::uuid,
    '{"id":"92000000-0000-0000-0000-000000000009","partner_id":"31000000-0000-0000-0000-000000000003","direction":"outbound","referred_on":"2026-07-29","client_label":"Case match","outcome":"Pending","note":"","match_profile_id":"40000000-0000-0000-0000-000000000004","case_id":"50000000-0000-0000-0000-000000000005"}'::jsonb,
    '{"id":"40000000-0000-0000-0000-000000000004","client_label":"Case match","status":"Referred","assigned_partner_id":"31000000-0000-0000-0000-000000000003","case_id":"50000000-0000-0000-0000-000000000005"}'::jsonb
  ) $$,
  'referral insert and match assignment commit in one transaction'
);

SELECT is(
  (SELECT (m.referral_id=r.id AND r.match_profile_id=m.id AND m.assigned_partner_id=r.partner_id)::text
     FROM public.match_profiles m JOIN public.referrals r ON r.id=m.referral_id
    WHERE m.id='40000000-0000-0000-0000-000000000004'),
  'true',
  'assignment persists one consistent referral-match relationship'
);

SELECT lives_ok(
  $$ SELECT public.assign_match_referral(
    '10000000-0000-0000-0000-000000000001'::uuid,
    '{"id":"92000000-0000-0000-0000-000000000010","partner_id":"31000000-0000-0000-0000-000000000003","direction":"outbound","referred_on":"2026-07-29","client_label":"Rapid match","outcome":"Pending","note":"","match_profile_id":"40000000-0000-0000-0000-000000000010"}'::jsonb,
    '{"id":"40000000-0000-0000-0000-000000000010","client_label":"Rapid match","level_of_care":"Residential","state":"OR","insurance":"Cash pay","network_preferences":[],"therapies":[],"status":"Referred","assigned_partner_id":"31000000-0000-0000-0000-000000000003"}'::jsonb
  ) $$,
  'assignment upserts a match that has not finished its standalone save'
);

SELECT is(
  (SELECT count(*)::integer FROM public.match_profiles m JOIN public.referrals r ON r.id=m.referral_id WHERE m.id='40000000-0000-0000-0000-000000000010' AND r.match_profile_id=m.id),
  1,
  'rapid assignment leaves one consistent match-referral relationship'
);

SELECT lives_ok(
  $$ SELECT public.finalize_match_packet(
    '10000000-0000-0000-0000-000000000001'::uuid,
    '{"id":"92000000-0000-0000-0000-000000000009","partner_id":"31000000-0000-0000-0000-000000000003","direction":"outbound","referred_on":"2026-07-29","client_label":"Case match","outcome":"Pending","note":"","packet_sent_at":"2026-07-29T16:00:00Z","match_profile_id":"40000000-0000-0000-0000-000000000004","case_id":"50000000-0000-0000-0000-000000000005"}'::jsonb,
    '{"id":"40000000-0000-0000-0000-000000000004","status":"Referred","assigned_partner_id":"31000000-0000-0000-0000-000000000003"}'::jsonb,
    '{"id":"95000000-0000-0000-0000-000000000009","partner_id":"31000000-0000-0000-0000-000000000003","kind":"email","note":"Packet sent","occurred_at":"2026-07-29T16:00:00Z"}'::jsonb,
    '{"id":"96000000-0000-0000-0000-000000000009","partner_id":"31000000-0000-0000-0000-000000000003","referral_id":"92000000-0000-0000-0000-000000000009","case_id":"50000000-0000-0000-0000-000000000005","title":"Check placement","due_on":"2026-07-30","status":"open","kind":"follow_up"}'::jsonb,
    '{"id":"97000000-0000-0000-0000-000000000009","case_id":"50000000-0000-0000-0000-000000000005","kind":"referral","body":"Sent packet","referral_id":"92000000-0000-0000-0000-000000000009","occurred_at":"2026-07-29T16:00:00Z"}'::jsonb
  ) $$,
  'packet finalization commits all linked rows transactionally'
);

SELECT is(
  (SELECT count(*)::integer
     FROM public.referrals r
     JOIN public.touches t ON t.partner_id=r.partner_id AND t.owner_id=r.owner_id
     JOIN public.follow_ups f ON f.referral_id=r.id AND f.owner_id=r.owner_id
     JOIN public.case_events e ON e.referral_id=r.id AND e.owner_id=r.owner_id
    WHERE r.id='92000000-0000-0000-0000-000000000009'
      AND r.packet_sent_at='2026-07-29T16:00:00Z'::timestamptz),
  1,
  'packet finalization leaves referral, touch, follow-up, and case event consistent'
);

SELECT lives_ok(
  $$ SELECT public.finalize_match_packet(
    '10000000-0000-0000-0000-000000000001'::uuid,
    '{"id":"92000000-0000-0000-0000-000000000009","partner_id":"31000000-0000-0000-0000-000000000003","direction":"outbound","referred_on":"2026-07-29","client_label":"Case match","outcome":"Pending","note":"","packet_sent_at":"2026-07-29T16:00:00Z","match_profile_id":"40000000-0000-0000-0000-000000000004","case_id":"50000000-0000-0000-0000-000000000005"}'::jsonb,
    '{"id":"40000000-0000-0000-0000-000000000004","status":"Referred","assigned_partner_id":"31000000-0000-0000-0000-000000000003"}'::jsonb,
    '{"id":"95000000-0000-0000-0000-000000000009","partner_id":"31000000-0000-0000-0000-000000000003","kind":"email","note":"Packet sent","occurred_at":"2026-07-29T16:00:00Z"}'::jsonb,
    '{"id":"96000000-0000-0000-0000-000000000009","partner_id":"31000000-0000-0000-0000-000000000003","referral_id":"92000000-0000-0000-0000-000000000009","case_id":"50000000-0000-0000-0000-000000000005","title":"Check placement","due_on":"2026-07-30","status":"open","kind":"follow_up"}'::jsonb,
    '{"id":"97000000-0000-0000-0000-000000000009","case_id":"50000000-0000-0000-0000-000000000005","kind":"referral","body":"Sent packet","referral_id":"92000000-0000-0000-0000-000000000009","occurred_at":"2026-07-29T16:00:00Z"}'::jsonb
  ) $$,
  'packet finalization is idempotent on retry'
);

SELECT lives_ok(
  $$ SELECT public.log_contact_activity(
    '10000000-0000-0000-0000-000000000001'::uuid,
    '{"id":"98000000-0000-0000-0000-000000000009","case_id":"50000000-0000-0000-0000-000000000005","kind":"call","body":"Called family","occurred_at":"2026-07-29T17:00:00Z"}'::jsonb,
    '{"id":"99000000-0000-0000-0000-000000000009","partner_id":"31000000-0000-0000-0000-000000000003","kind":"call","note":"Called family","occurred_at":"2026-07-29T17:00:00Z"}'::jsonb
  ) $$,
  'contact activity saves its case event and partner touch atomically'
);

SELECT is(
  (SELECT count(*)::integer FROM public.case_events e JOIN public.touches t ON t.owner_id=e.owner_id
    WHERE e.id='98000000-0000-0000-0000-000000000009' AND t.id='99000000-0000-0000-0000-000000000009'),
  1,
  'contact activity leaves both owner-linked records present'
);

SELECT lives_ok(
  $$ SELECT public.log_contact_activity(
    '10000000-0000-0000-0000-000000000001'::uuid,
    '{"id":"98000000-0000-0000-0000-000000000009","case_id":"50000000-0000-0000-0000-000000000005","kind":"call","body":"Called family","occurred_at":"2026-07-29T17:00:00Z"}'::jsonb,
    '{"id":"99000000-0000-0000-0000-000000000009","partner_id":"31000000-0000-0000-0000-000000000003","kind":"call","note":"Called family","occurred_at":"2026-07-29T17:00:00Z"}'::jsonb
  ) $$,
  'contact activity is idempotent on offline retry'
);

SELECT has_column('public', 'partners', 'monthly_cost', 'partners stores one monthly cash cost');
SELECT col_type_is('public', 'partners', 'monthly_cost', 'integer', 'monthly cost is an integer');
SELECT has_column('public', 'partners', 'insurance_networks', 'partners stores per-carrier network capabilities');
SELECT col_type_is('public', 'partners', 'insurance_networks', 'jsonb', 'insurance network capabilities use jsonb');
SELECT has_trigger('public', 'partners', 'partners_sync_payment_compatibility', 'legacy clients synchronize into the new payment fields');
SELECT lives_ok(
  $$ UPDATE public.partners
     SET cash_min = 3500, cash_max = 4200, insurance = ARRAY['Aetna', 'Cigna']
     WHERE id = '31000000-0000-0000-0000-000000000003'::uuid $$,
  'legacy partner updates continue working after the migration'
);
SELECT is(
  (SELECT jsonb_build_object('monthlyCost', monthly_cost, 'networks', insurance_networks)
     FROM public.partners
    WHERE id = '31000000-0000-0000-0000-000000000003'::uuid),
  '{"monthlyCost":4200,"networks":{"Aetna":["In-network"],"Cigna":["In-network"]}}'::jsonb,
  'legacy cash and insurance values synchronize into monthly cost and explicit network capabilities'
);
SELECT lives_ok(
  $$ UPDATE public.partners
     SET insurance_networks = '{"Aetna":["Out-of-network"]}'::jsonb
     WHERE id = '31000000-0000-0000-0000-000000000003'::uuid;
     UPDATE public.partners
     SET insurance = ARRAY['Aetna', 'Cigna', 'UnitedHealthcare']
     WHERE id = '31000000-0000-0000-0000-000000000003'::uuid $$,
  'a legacy insurance edit preserves explicit network classifications'
);
SELECT is(
  (SELECT insurance_networks
     FROM public.partners
    WHERE id = '31000000-0000-0000-0000-000000000003'::uuid),
  '{"Aetna":["Out-of-network"],"Cigna":["In-network"],"UnitedHealthcare":["In-network"]}'::jsonb,
  'retained carriers keep their status while newly added carriers default to in-network'
);
SELECT throws_ok(
  $$ UPDATE public.partners
     SET insurance_networks = '{"Aetna":"Out-of-network"}'::jsonb
     WHERE id = '31000000-0000-0000-0000-000000000003'::uuid $$,
  '23514',
  NULL,
  'malformed insurance network capabilities are rejected'
);

SELECT * FROM finish();
ROLLBACK;
