BEGIN;
SELECT no_plan();
INSERT INTO auth.users (id,email) VALUES
('ed000000-0000-0000-0000-000000000001','community-a@example.test'),
('ed000000-0000-0000-0000-000000000002','community-b@example.test');
INSERT INTO public.partners (id,owner_id,name,organization,city,state,types,note,monthly_cost,phone,email)
VALUES
('ed100000-0000-0000-0000-000000000001','ed000000-0000-0000-0000-000000000001','Private contact A','Harbor & Hope','Bend','OR',ARRAY['Inpatient'],'Private case details and commercial terms A',9876,'555-0001','private-a@example.test'),
('ed100000-0000-0000-0000-000000000002','ed000000-0000-0000-0000-000000000002','Private contact B','Harbor and Hope!','Bend','OR',ARRAY['Inpatient'],'Private case details and commercial terms B',7654,'555-0002','private-b@example.test'),
('ed100000-0000-0000-0000-000000000003','ed000000-0000-0000-0000-000000000001','Another contact','Other program','Salem','OR',ARRAY['Inpatient'],'Confidential',5000,'','');
INSERT INTO public.cases (id,owner_id,title) VALUES
('ed200000-0000-0000-0000-000000000001','ed000000-0000-0000-0000-000000000001','Confidential client and case');
SELECT set_config('test.org_a',(SELECT org_id::text FROM public.org_members WHERE user_id='ed000000-0000-0000-0000-000000000001'),true);
SELECT set_config('test.org_b',(SELECT org_id::text FROM public.org_members WHERE user_id='ed000000-0000-0000-0000-000000000002'),true);
SELECT set_config('test.program','{"organization":"Harbor & Hope","city":"Bend","state":"or","types":["Inpatient"],"phone":"555-9999","email":"admissions@example.test","website":"https://example.test"}',true);
SELECT set_config('request.jwt.claim.sub','ed000000-0000-0000-0000-000000000001',true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.publish_partner_program('ed100000-0000-0000-0000-000000000001',current_setting('test.program')::jsonb || '{"note":"secret","monthly_cost":9876}',current_setting('test.org_a')::uuid)$$,'22023','Only public program fields can be published','server rejects private fields even through direct RPC');
SELECT is((SELECT count(*)::int FROM public.global_partners),0,'rejected contribution creates no public row');
SELECT throws_ok($$SELECT public.publish_partner_program('ed100000-0000-0000-0000-000000000001',current_setting('test.program')::jsonb,current_setting('test.org_b')::uuid)$$,'42501',NULL,'stale workspace cannot contribute');
SELECT throws_ok($$SELECT public.publish_partner_program('ed100000-0000-0000-0000-000000000002',current_setting('test.program')::jsonb,current_setting('test.org_a')::uuid)$$,'42501',NULL,'cannot publish another practice partner');
SELECT lives_ok($$SELECT set_config('test.result',public.publish_partner_program('ed100000-0000-0000-0000-000000000001',current_setting('test.program')::jsonb,current_setting('test.org_a')::uuid)::text,true)$$,'free practice can contribute public details');
SELECT ok((current_setting('test.result')::jsonb->>'created')::boolean,'first contribution creates program');
SELECT set_config('test.global_id',current_setting('test.result')::jsonb->>'global_id',true);
SELECT is((SELECT name || '|' || phone || '|' || email || '|' || monthly_cost::int || '|' || description FROM public.global_partners),'Harbor & Hope|555-9999|admissions@example.test|0|','global record has only reviewed contact data and no private cost or note');
SELECT ok((SELECT verified_at IS NULL FROM public.global_partners),'community contribution is unverified');
SELECT throws_ok($$SELECT created_by FROM public.global_partners$$,'42501',NULL,'contributor identity is not readable through API');
SELECT is(public.publish_partner_program('ed100000-0000-0000-0000-000000000001',current_setting('test.program')::jsonb,current_setting('test.org_a')::uuid)->>'global_id',current_setting('test.global_id'),'repeat contribution reuses global program');
SELECT is(public.import_global_partner(current_setting('test.global_id')::uuid,gen_random_uuid(),current_setting('test.org_a')::uuid),'ed100000-0000-0000-0000-000000000001'::uuid,'contributor import reuses original private partner');
SELECT set_config('request.jwt.claim.sub','ed000000-0000-0000-0000-000000000002',true);
SELECT is((SELECT count(*)::int FROM public.partners),1,'other practice sees only its own private partner');
SELECT is((SELECT count(*)::int FROM public.cases),0,'other practice cannot see contributor client/case');
SELECT is((SELECT count(*)::int FROM public.global_partners),1,'other practice can discover public program');
SELECT throws_ok($$SELECT public.import_global_partner(current_setting('test.global_id')::uuid,gen_random_uuid(),current_setting('test.org_a')::uuid)$$,'42501',NULL,'stale workspace cannot import');
SELECT is(public.import_global_partner(current_setting('test.global_id')::uuid,gen_random_uuid(),current_setting('test.org_b')::uuid),'ed100000-0000-0000-0000-000000000002'::uuid,'import reuses equivalent unlinked local program');
SELECT is((SELECT name || '|' || note || '|' || monthly_cost::int || '|' || phone FROM public.partners),'Private contact B|Private case details and commercial terms B|7654|555-0002','import preserves private contacts, notes, and negotiated costs');
SELECT is(public.import_global_partner(current_setting('test.global_id')::uuid,gen_random_uuid(),current_setting('test.org_b')::uuid),'ed100000-0000-0000-0000-000000000002'::uuid,'repeat import is idempotent');
SELECT is(public.publish_partner_program('ed100000-0000-0000-0000-000000000002',current_setting('test.program')::jsonb || '{"organization":"HARBOR AND HOPE!","phone":"555-1111"}',current_setting('test.org_b')::uuid)->>'global_id',current_setting('test.global_id'),'another practice contribution with normalized identity reuses global record');
SELECT is((SELECT phone FROM public.global_partners),'555-9999','duplicate contribution does not overwrite canonical public details');
UPDATE public.partners SET note='Revised private note',phone='555-7777';
SELECT is((SELECT phone FROM public.global_partners),'555-9999','private edits do not change public listing');
SELECT throws_ok($$INSERT INTO public.global_partners(name,organization) VALUES('Rogue','Rogue')$$,'42501',NULL,'raw public inserts are denied');
SELECT results_eq($$UPDATE public.global_partners SET phone='555-2222' RETURNING id$$,$$SELECT NULL::uuid WHERE false$$,'ordinary practices cannot edit canonical public rows');
SELECT set_config('request.jwt.claim.sub','ed000000-0000-0000-0000-000000000001',true);
SELECT throws_ok($$SELECT public.publish_partner_program('ed100000-0000-0000-0000-000000000003',current_setting('test.program')::jsonb || '{"website":"https://example.test?client=secret"}',current_setting('test.org_a')::uuid)$$,'22023',NULL,'URLs with query parameters are rejected');
SELECT throws_ok($$SELECT public.publish_partner_program('ed100000-0000-0000-0000-000000000003',current_setting('test.program')::jsonb || '{"organization":"!!!"}',current_setting('test.org_a')::uuid)$$,'22023',NULL,'punctuation-only identities are rejected');
SELECT ok((public.publish_partner_program('ed100000-0000-0000-0000-000000000003',current_setting('test.program')::jsonb || '{"city":"Salem"}',current_setting('test.org_a')::uuid)->>'created')::boolean,'same program in another city is a separate listing');
SELECT is((SELECT count(*)::int FROM public.global_partners),2,'only two distinct campuses exist');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.global_partners WHERE created_by IS NOT NULL),0,'contributions store no author metadata');
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT public.publish_partner_program('ed100000-0000-0000-0000-000000000001',current_setting('test.program')::jsonb,current_setting('test.org_a')::uuid)$$,'42501',NULL,'anonymous publication is denied');
SELECT throws_ok($$SELECT public.import_global_partner(current_setting('test.global_id')::uuid,gen_random_uuid())$$,'42501',NULL,'anonymous import is denied');
RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
