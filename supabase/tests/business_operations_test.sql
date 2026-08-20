-- Attribution, stage-history, and provider-link regression coverage.
BEGIN;
SELECT plan(23);

SELECT ok(
  (SELECT count(*) = 4
     FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'cases'
      AND column_name IN ('lead_source', 'lead_source_detail', 'lost_reason', 'stage_changed_at')),
  'cases expose the reporting fields'
);

SELECT has_table('public', 'case_stage_history', 'case stage history exists');
SELECT has_table('public', 'case_integrations', 'provider links exist');

SELECT ok(
  has_table_privilege('authenticated', 'public.case_stage_history', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.case_stage_history', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.case_stage_history', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.case_stage_history', 'DELETE'),
  'stage history is read-only to the app role'
);

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.integration_webhook_events', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.integration_webhook_events', 'SELECT'),
  'webhook receipts are service-only'
);

SELECT ok(
  NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.update_case_business_details_with_event(uuid,uuid,jsonb,text)'::regprocedure)
  AND (SELECT proconfig FROM pg_proc WHERE oid = 'public.update_case_business_details_with_event(uuid,uuid,jsonb,text)'::regprocedure) = ARRAY['search_path=pg_catalog'],
  'business patch RPC is SECURITY INVOKER with a fixed search path'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.update_case_business_details_with_event(uuid,uuid,jsonb,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.update_case_business_details_with_event(uuid,uuid,jsonb,text)', 'EXECUTE'),
  'only authenticated clients can patch business details'
);

SELECT ok(
  NOT has_function_privilege('authenticated', 'public.set_case_stage_changed_at()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.track_case_stage_history()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.track_case_stage_history()', 'EXECUTE'),
  'stage trigger functions cannot be called directly'
);

INSERT INTO auth.users (id, email)
VALUES
  ('91000000-0000-0000-0000-000000000001', 'business-owner@example.test'),
  ('92000000-0000-0000-0000-000000000002', 'other-business-owner@example.test');

INSERT INTO public.cases (id, owner_id, title, status)
VALUES
  ('93000000-0000-0000-0000-000000000003', '91000000-0000-0000-0000-000000000001', 'Owner business case', 'inquiry'),
  ('94000000-0000-0000-0000-000000000004', '92000000-0000-0000-0000-000000000002', 'Other business case', 'inquiry');

SELECT set_config('request.jwt.claim.sub', '91000000-0000-0000-0000-000000000001', true);
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT count(*)::integer FROM public.case_stage_history WHERE case_id = '93000000-0000-0000-0000-000000000003'),
  1,
  'the owner can read the initial automatically tracked stage'
);

SELECT is(
  (SELECT count(*)::integer FROM public.case_stage_history WHERE case_id = '94000000-0000-0000-0000-000000000004'),
  0,
  'RLS hides another owner stage history'
);

SELECT lives_ok(
  $$ UPDATE public.cases SET status = 'consult' WHERE id = '93000000-0000-0000-0000-000000000003' $$,
  'an ordinary status update writes history through the trigger'
);

SELECT is(
  (SELECT string_agg(status || ':' || (exited_at IS NULL)::text, ',' ORDER BY entered_at)
     FROM public.case_stage_history
    WHERE case_id = '93000000-0000-0000-0000-000000000003'),
  'inquiry:false,consult:true',
  'the old stage closes and exactly one current stage opens'
);

SELECT lives_ok(
  $$ SELECT * FROM public.update_case_business_details_with_event(
    '93000000-0000-0000-0000-000000000003',
    '95000000-0000-0000-0000-000000000005',
    '{"lead_source":"Website","lead_source_detail":"August landing page"}'::jsonb,
    'Lead source: Unspecified → Website · Lead-source detail updated'
  ) $$,
  'business attribution can be updated atomically with its event'
);

SELECT is(
  (SELECT lead_source || ':' || lead_source_detail FROM public.cases WHERE id = '93000000-0000-0000-0000-000000000003'),
  'Website:August landing page',
  'the business patch persists the requested values'
);

SELECT is(
  (SELECT count(*)::integer FROM public.case_events WHERE id = '95000000-0000-0000-0000-000000000005'),
  1,
  'the business patch creates one audit event'
);

SELECT lives_ok(
  $$ SELECT * FROM public.update_case_business_details_with_event(
    '93000000-0000-0000-0000-000000000003',
    '95000000-0000-0000-0000-000000000005',
    '{"lead_source":"Website","lead_source_detail":"August landing page"}'::jsonb,
    'Lead source: Unspecified → Website · Lead-source detail updated'
  ) $$,
  'an identical business patch retry is idempotent'
);

SELECT is(
  (SELECT count(*)::integer FROM public.case_events WHERE id = '95000000-0000-0000-0000-000000000005'),
  1,
  'an idempotent retry does not duplicate the event'
);

SELECT throws_ok(
  $$ SELECT * FROM public.update_case_business_details_with_event(
    '93000000-0000-0000-0000-000000000003',
    '95000000-0000-0000-0000-000000000005',
    '{"lead_source":"Other"}'::jsonb,
    'Different request'
  ) $$,
  '23505',
  'Case event ID is already used by another request',
  'an idempotency key cannot be reused for another business request'
);

SELECT throws_ok(
  $$ SELECT * FROM public.update_case_business_details_with_event(
    '94000000-0000-0000-0000-000000000004',
    '96000000-0000-0000-0000-000000000006',
    '{"lead_source":"Website"}'::jsonb,
    'Not mine'
  ) $$,
  'P0002',
  'Case not found for the authenticated owner',
  'business details cannot cross owner boundaries'
);

SELECT lives_ok(
  $$ INSERT INTO public.case_integrations (
    owner_id, case_id, provider, record_type, external_id, status, amount_cents
  ) VALUES (
    '91000000-0000-0000-0000-000000000001',
    '93000000-0000-0000-0000-000000000003',
    'square', 'invoice', 'invoice-test-1', 'unpaid', 15000
  ) $$,
  'the owner can link a valid Square invoice'
);

SELECT throws_ok(
  $$ INSERT INTO public.case_integrations (
    owner_id, case_id, provider, record_type, external_id
  ) VALUES (
    '91000000-0000-0000-0000-000000000001',
    '93000000-0000-0000-0000-000000000003',
    'pandadoc', 'payment', 'wrong-provider-type'
  ) $$,
  '23514',
  'new row for relation "case_integrations" violates check constraint "case_integrations_provider_type_check"',
  'provider and record type combinations are constrained'
);

SELECT throws_ok(
  $$ INSERT INTO public.case_integrations (
    owner_id, case_id, provider, record_type, external_id
  ) VALUES (
    '91000000-0000-0000-0000-000000000001',
    '94000000-0000-0000-0000-000000000004',
    'square', 'invoice', 'other-owner-case'
  ) $$,
  '23503',
  'insert or update on table "case_integrations" violates foreign key constraint "case_integrations_case_org_fk"',
  'a provider link cannot target another workspace''s case'
);

SELECT is(
  (SELECT count(*)::integer FROM public.case_integrations WHERE external_id = 'invoice-test-1'),
  1,
  'the owner can read the linked external record'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
