-- Voice capture recordings are private attachments. Case recordings continue
-- to use the existing case folder. Professional-referent recordings use a
-- distinct partner-<uuid> folder so Storage authorization can validate the
-- referent against the active organization without weakening case access.
UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
  'image/jpeg', 'image/png', 'image/heic', 'image/webp', 'application/pdf',
  'audio/wav', 'audio/x-wav', 'audio/vnd.wave', 'audio/x-caf',
  'audio/mp4', 'audio/m4a', 'audio/aac', 'audio/mpeg'
]::text[]
WHERE id = 'case-documents';

CREATE OR REPLACE FUNCTION public.is_org_case_or_partner_folder(p_target text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN p_target ~ '^partner-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN EXISTS (
        SELECT 1
          FROM public.partners p
         WHERE p.org_id = public.current_org_id()
           AND p.id = substring(p_target FROM 9)::uuid
      )
    ELSE public.is_org_case_folder(p_target)
  END
$$;

REVOKE ALL ON FUNCTION public.is_org_case_or_partner_folder(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_org_case_or_partner_folder(text) TO authenticated;

DROP POLICY IF EXISTS "case docs: org read" ON storage.objects;
DROP POLICY IF EXISTS "case docs: org insert" ON storage.objects;
DROP POLICY IF EXISTS "case docs: org delete" ON storage.objects;

CREATE POLICY "case docs: org read" ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'case-documents'
    AND public.is_org_case_or_partner_folder((storage.foldername(name))[2])
  );

CREATE POLICY "case docs: org insert" ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'case-documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
    AND public.is_org_case_or_partner_folder((storage.foldername(name))[2])
  );

CREATE POLICY "case docs: org delete" ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'case-documents'
    AND public.is_org_case_or_partner_folder((storage.foldername(name))[2])
  );
