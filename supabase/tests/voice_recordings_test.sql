-- Voice recording Storage authorization and MIME regression coverage.
BEGIN;
SELECT plan(8);

INSERT INTO auth.users (id, email)
VALUES
  ('ee000000-0000-0000-0000-000000000001', 'voice-owner@example.test'),
  ('ff000000-0000-0000-0000-000000000002', 'voice-other@example.test');

INSERT INTO public.partners (id, owner_id, name)
VALUES (
  'ff200000-0000-0000-0000-000000000002',
  'ff000000-0000-0000-0000-000000000002',
  'Other practice referent'
);

SELECT set_config('request.jwt.claim.sub', 'ee000000-0000-0000-0000-000000000001', true);
SET LOCAL ROLE authenticated;

INSERT INTO public.cases (id, owner_id, title)
VALUES (
  'ee100000-0000-0000-0000-000000000001',
  'ee000000-0000-0000-0000-000000000001',
  'Voice case'
);
INSERT INTO public.partners (id, owner_id, name)
VALUES (
  'ee200000-0000-0000-0000-000000000001',
  'ee000000-0000-0000-0000-000000000001',
  'Voice referent'
);

SELECT ok(
  public.is_org_case_or_partner_folder('ee100000-0000-0000-0000-000000000001'),
  'an active-organization case folder is authorized'
);
SELECT ok(
  public.is_org_case_or_partner_folder('partner-ee200000-0000-0000-0000-000000000001'),
  'an active-organization professional referent folder is authorized'
);
SELECT ok(
  NOT public.is_org_case_or_partner_folder('partner-00000000-0000-4000-8000-000000000099'),
  'a nonexistent professional referent folder is rejected'
);
SELECT ok(
  NOT public.is_org_case_or_partner_folder('partner-ff200000-0000-0000-0000-000000000002'),
  'a professional referent in another organization is rejected'
);
SELECT ok(
  NOT public.is_org_case_or_partner_folder('partner-not-a-uuid'),
  'a malformed professional referent folder is rejected without a cast error'
);

SELECT lives_ok(
  $$ INSERT INTO storage.objects (bucket_id, name, owner_id)
     VALUES (
       'case-documents',
       'ee000000-0000-0000-0000-000000000001/partner-ee200000-0000-0000-0000-000000000001/ee300000-0000-0000-0000-000000000001.wav',
       'ee000000-0000-0000-0000-000000000001'
     ) $$,
  'the signed-in author can upload a recording to an authorized referent folder'
);

SELECT throws_ok(
  $$ INSERT INTO storage.objects (bucket_id, name, owner_id)
     VALUES (
       'case-documents',
       'ee000000-0000-0000-0000-000000000001/partner-00000000-0000-4000-8000-000000000099/ee300000-0000-0000-0000-000000000002.wav',
       'ee000000-0000-0000-0000-000000000001'
     ) $$,
  '42501',
  'new row violates row-level security policy for table "objects"',
  'Storage RLS rejects a referent outside the active organization'
);

RESET ROLE;
SELECT ok(
  'audio/wav' = ANY (
    SELECT unnest(allowed_mime_types)
      FROM storage.buckets
     WHERE id = 'case-documents'
  ),
  'the private attachment bucket accepts WAV recordings'
);

SELECT * FROM finish();
ROLLBACK;
