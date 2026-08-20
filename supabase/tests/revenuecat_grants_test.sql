BEGIN;
SELECT plan(9);

INSERT INTO auth.users (id,email)
VALUES
  ('ee100000-0000-0000-0000-0000000000ee','rc-owner@example.test'),
  ('ee200000-0000-0000-0000-0000000000ee','rc-member@example.test');

UPDATE public.org_members
   SET org_id = (SELECT org_id FROM public.org_members WHERE user_id='ee100000-0000-0000-0000-0000000000ee'),
       role = 'member'
 WHERE user_id='ee200000-0000-0000-0000-0000000000ee';

INSERT INTO public.org_entitlements (org_id,entitlement,active,source)
SELECT org_id,'pro',true,'manual' FROM public.org_members WHERE user_id='ee100000-0000-0000-0000-0000000000ee';

SELECT ok(
  public.apply_revenuecat_grant_event(
    'ee100000-0000-0000-0000-0000000000ee','directory','directory.monthly','APP_STORE','PRODUCTION',
    true, now()+interval '30 days','2026-08-20 10:00:00+00','event-2'
  ),
  'a production purchase creates a per-purchaser grant'
);

SELECT set_config('request.jwt.claim.sub','ee100000-0000-0000-0000-0000000000ee',true);
SET LOCAL ROLE authenticated;
SELECT ok(public.org_has_entitlement('pro'), 'manual founder access remains effective');
SELECT ok(public.org_has_entitlement('directory'), 'the paid grant contributes to effective workspace access');
RESET ROLE;

SELECT ok(NOT public.apply_revenuecat_grant_event(
  'ee100000-0000-0000-0000-0000000000ee','directory','directory.monthly','APP_STORE','PRODUCTION',
  false, now()-interval '1 day','2026-08-20 09:00:00+00','event-1'
), 'an older expiration cannot regress a newer purchase');

SELECT ok(public.apply_revenuecat_grant_event(
  'ee100000-0000-0000-0000-0000000000ee','directory','directory.monthly','APP_STORE','PRODUCTION',
  false, now(),'2026-08-20 11:00:00+00','event-3'
), 'a newer expiration updates the purchaser grant');

SELECT set_config('request.jwt.claim.sub','ee100000-0000-0000-0000-0000000000ee',true);
SET LOCAL ROLE authenticated;
SELECT ok(NOT public.org_has_entitlement('directory'), 'expired access is removed when no other grant remains');
RESET ROLE;

SELECT ok(public.apply_revenuecat_grant_event(
  'ee200000-0000-0000-0000-0000000000ee','directory','directory.annual','APP_STORE','PRODUCTION',
  true, now()+interval '1 year','2026-08-20 12:00:00+00','event-4'
), 'a second purchaser has an independent grant');

SELECT set_config('request.jwt.claim.sub','ee100000-0000-0000-0000-0000000000ee',true);
SET LOCAL ROLE authenticated;
SELECT ok(public.org_has_entitlement('directory'), 'one purchaser expiration cannot deactivate another purchaser');
RESET ROLE;

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.apply_revenuecat_grant_event(uuid,text,text,text,text,boolean,timestamptz,timestamptz,text)',
    'EXECUTE'
  ),
  'clients cannot invoke the service-only lifecycle projection RPC'
);

SELECT * FROM finish();
ROLLBACK;
