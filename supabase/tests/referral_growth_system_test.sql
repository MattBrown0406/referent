-- Attack and state-machine coverage for referral growth system.
BEGIN;
SELECT plan(41);

INSERT INTO auth.users(id,email) VALUES
 ('91000000-0000-0000-0000-000000000001','owner@referral.test'),
 ('91000000-0000-0000-0000-000000000002','outsider@referral.test'),
 ('91000000-0000-0000-0000-000000000003','center@referral.test'),
 ('91000000-0000-0000-0000-000000000004','other-center@referral.test');

INSERT INTO public.partners(id,owner_id,name,organization) VALUES
 ('92000000-0000-0000-0000-000000000001','91000000-0000-0000-0000-000000000001','Referral partner','Partner practice');
INSERT INTO public.referral_sources(
 id,org_id,owner_id,partner_id,label,public_practice_display,public_source_display
) VALUES (
 '93000000-0000-0000-0000-000000000001',
 (SELECT org_id FROM public.org_members WHERE user_id='91000000-0000-0000-0000-000000000001'),
 '91000000-0000-0000-0000-000000000001','92000000-0000-0000-0000-000000000001',
 'Professional referral link','Safe Practice','Trusted referral source'
);

SELECT ok(NOT has_table_privilege('anon','public.referral_sources','SELECT'), 'anon cannot read sources');
SELECT ok(NOT has_table_privilege('anon','public.referral_handoffs','SELECT'), 'anon cannot read handoffs');
SELECT ok(NOT has_table_privilege('anon','public.center_availability','SELECT'), 'anon cannot read availability');
SELECT ok(NOT has_function_privilege('anon','public.public_referral_intake_submit(uuid,uuid,text,text,text,text,boolean,boolean,text)','EXECUTE'), 'anon cannot bypass the Edge Function by calling intake RPC');

SELECT set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000001',true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.referral_sources),1,'source owner org can read source');
SELECT set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000002',true);
SELECT is((SELECT count(*)::integer FROM public.referral_sources),0,'cross-org source reads are isolated');
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000001',true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$SELECT public.save_voice_activity(
  '91000000-0000-0000-0000-000000000001',
  '{"id":"96000000-0000-0000-0000-000000000001","partner_id":"92000000-0000-0000-0000-000000000001","kind":"call","note":"Reviewed availability","occurred_at":"2026-08-30T12:00:00Z"}'::jsonb,
  '{"id":"96000000-0000-0000-0000-000000000002","partner_id":"92000000-0000-0000-0000-000000000001","kind":"touch","title":"Follow up on availability","due_on":"2026-09-02","due_time":"10:00","status":"open","note":""}'::jsonb
)$$,'reviewed voice activity saves atomically');
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.touches WHERE id='96000000-0000-0000-0000-000000000001'),1,'voice activity creates one reviewed touch');
SELECT is((SELECT count(*)::integer FROM public.follow_ups WHERE id='96000000-0000-0000-0000-000000000002' AND kind='touch' AND status='open'),1,'voice activity creates its optional follow-up');

SET LOCAL ROLE service_role;
SELECT lives_ok($$SELECT public.public_referral_intake_submit(
 '93000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001',
 'Ada','Lovelace','+1 555 222 3333','ada@example.test',true,true,repeat('a',64))$$,
 'service intake atomically succeeds');
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.cases WHERE lead_source='Professional referral' AND lead_source_detail='Professional referral link'),1,'intake creates attributed inquiry case');
SELECT is((SELECT count(*)::integer FROM public.case_contacts WHERE name='Ada Lovelace' AND is_primary),1,'intake creates sensitive primary contact');
SELECT is((SELECT count(*)::integer FROM public.referrals WHERE direction='inbound' AND partner_id='92000000-0000-0000-0000-000000000001'),1,'intake creates partner-tied inbound referral');
SELECT ok((SELECT client_label='Public intake' AND note='' AND client_label NOT LIKE '%Ada%' FROM public.referrals WHERE direction='inbound'),'referral ledger remains de-identified');
SELECT is((SELECT count(*)::integer FROM public.follow_ups WHERE kind='first_call' AND due_on=CURRENT_DATE),1,'intake creates today first-call reminder');

SET LOCAL ROLE service_role;
SELECT lives_ok($$SELECT public.public_referral_intake_submit(
 '93000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001',
 'Ada','Lovelace','+1 555 222 3333','ada@example.test',true,true,repeat('a',64))$$,
 'idempotent retry succeeds without duplicate writes');
RESET ROLE;
SELECT is((SELECT submission_count::integer FROM public.referral_sources WHERE id='93000000-0000-0000-0000-000000000001'),1,'idempotent retry increments source only once');

SELECT set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000001',true);
SET LOCAL ROLE authenticated;
UPDATE public.referral_sources SET active=false WHERE id='93000000-0000-0000-0000-000000000001';
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT throws_ok($$SELECT public.public_referral_intake_submit(
 '93000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000002',
 'Grace','Hopper','','grace@example.test',true,true,repeat('b',64))$$,
 'P0002','Referral source is unavailable','revoked sources reject intake');
RESET ROLE;

SELECT set_config('test.referral_id',(SELECT id::text FROM public.referrals WHERE direction='inbound'),true);
SELECT set_config('test.case_id',(SELECT id::text FROM public.cases WHERE lead_source='Professional referral'),true);
SELECT set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000001',true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$SELECT set_config('test.handoff_id',handoff_id::text,true),set_config('test.handoff_token',token,true)
 FROM public.create_referral_handoff(
 current_setting('test.referral_id')::uuid,current_setting('test.case_id')::uuid,
 '92000000-0000-0000-0000-000000000001','Family A','Program Admissions','admissions@example.test')$$,
 'authenticated member creates handoff and receives token once');
RESET ROLE;
SELECT ok((SELECT pg_catalog.encode(token_hash,'hex')<>current_setting('test.handoff_token') AND octet_length(token_hash)=32
 FROM public.referral_handoffs WHERE id=current_setting('test.handoff_id')::uuid),'only SHA-256 token hash is stored');
SET LOCAL ROLE service_role;
SELECT is((SELECT count(*)::integer FROM public.public_referral_handoff_resolve(current_setting('test.handoff_token')) WHERE client_alias='Family A' AND allowed_next_status='received'),1,'public resolve returns safe state and next transition');
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.referral_handoff_events WHERE handoff_id=current_setting('test.handoff_id')::uuid),1,'handoff starts with one append-only sent event');
SELECT is((SELECT count(*)::integer FROM public.follow_ups WHERE referral_handoff_id=current_setting('test.handoff_id')::uuid AND status='open'),1,'handoff starts with one open reminder');

SET LOCAL ROLE service_role;
SELECT is((SELECT status||':'||version FROM public.public_referral_handoff_transition(current_setting('test.handoff_token'),1,'received')),'received:2','external recipient advances one allowed state');
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.follow_ups WHERE referral_handoff_id=current_setting('test.handoff_id')::uuid AND status='open'),1,'transition replaces reminder with exactly one open reminder');
SET LOCAL ROLE service_role;
SELECT throws_ok($$SELECT * FROM public.public_referral_handoff_transition(current_setting('test.handoff_token'),2,'consult_scheduled')$$,'22023','Invalid handoff transition','forward jumps are rejected');
SELECT is((SELECT status||':'||version FROM public.public_referral_handoff_transition(current_setting('test.handoff_token'),1,'received')),'received:2','same-status retry is idempotent even with original version');
SELECT throws_ok($$SELECT * FROM public.public_referral_handoff_transition(current_setting('test.handoff_token'),1,'contact_attempted')$$,'40001','Handoff version conflict','stale expected versions conflict');
SELECT throws_ok($$SELECT * FROM public.public_referral_handoff_transition(current_setting('test.handoff_token'),2,'sent')$$,'22023','Invalid handoff transition','backward transitions are rejected');
RESET ROLE;
SELECT throws_ok($$UPDATE public.referral_handoff_events SET actor_type='system' WHERE handoff_id=current_setting('test.handoff_id')::uuid$$,'42501','Referral handoff history is append-only','history cannot be updated');
SET LOCAL ROLE service_role;
SELECT lives_ok($outer$DO $inner$ BEGIN
  PERFORM * FROM public.public_referral_handoff_transition(current_setting('test.handoff_token'),2,'contact_attempted');
  PERFORM * FROM public.public_referral_handoff_transition(current_setting('test.handoff_token'),3,'family_reached');
  PERFORM * FROM public.public_referral_handoff_transition(current_setting('test.handoff_token'),4,'consult_scheduled');
  PERFORM * FROM public.public_referral_handoff_transition(current_setting('test.handoff_token'),5,'closed');
END $inner$;$outer$,'remaining monotonic transitions reach closed');
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.follow_ups WHERE referral_handoff_id=current_setting('test.handoff_id')::uuid AND status='open'),0,'closed handoff completes its reminder');

SET LOCAL ROLE authenticated;
SELECT lives_ok($$SELECT set_config('test.revoked_handoff',handoff_id::text,true),set_config('test.revoked_token',token,true)
 FROM public.create_referral_handoff(current_setting('test.referral_id')::uuid,current_setting('test.case_id')::uuid,
 '92000000-0000-0000-0000-000000000001','Family B','Program Admissions','')$$,'second handoff can be created for revoke test');
SELECT lives_ok($$SELECT public.revoke_referral_handoff(current_setting('test.revoked_handoff')::uuid)$$,'owner can revoke handoff');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT throws_ok($$SELECT * FROM public.public_referral_handoff_transition(current_setting('test.revoked_token'),1,'received')$$,'42501','Handoff is revoked','revoked handoff rejects external transition');
RESET ROLE;

INSERT INTO public.global_partners(id,name,organization,status,verified_at) VALUES
 ('95000000-0000-0000-0000-000000000001','Admissions','Available Center','active','2026-01-01T00:00:00Z'),
 ('95000000-0000-0000-0000-000000000002','Admissions','Other Center','active','2026-01-02T00:00:00Z');
INSERT INTO public.center_members(user_id,global_partner_id) VALUES
 ('91000000-0000-0000-0000-000000000003','95000000-0000-0000-0000-000000000001'),
 ('91000000-0000-0000-0000-000000000004','95000000-0000-0000-0000-000000000002');
INSERT INTO public.org_entitlements(org_id,entitlement,active,source) VALUES
 ((SELECT org_id FROM public.org_members WHERE user_id='91000000-0000-0000-0000-000000000001'),'directory',true,'manual');

SELECT set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000003',true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$SELECT * FROM public.confirm_center_availability('limited',ARRAY['residential'],'Usually within one day','Call for fit',NULL)$$,'claimed center confirms its own availability');
SELECT is((SELECT expires_at-confirmed_at FROM public.get_center_availability()),interval '7 days','freshness expires exactly seven days after confirmation');
SELECT set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000004',true);
SELECT is((SELECT count(*)::integer FROM public.get_center_availability()),0,'other center cannot read first center through narrow RPC');
SELECT set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000001',true);
SELECT is((SELECT count(*)::integer FROM public.center_availability),1,'directory-entitled user reads availability for active listings');
RESET ROLE;
SELECT is((SELECT verified_at FROM public.global_partners WHERE id='95000000-0000-0000-0000-000000000001'),'2026-01-01T00:00:00Z'::timestamptz,'availability confirmation does not alter verification');
SELECT ok(NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='global_partners' AND column_name IN ('accepting_state','availability_rank')),'availability remains separate and introduces no ranking field');

SELECT * FROM finish();
ROLLBACK;
