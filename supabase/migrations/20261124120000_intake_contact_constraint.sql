BEGIN;

-- PostgREST commits the intake RPC as service_role. The primary-contact
-- constraint runs then, after the RPC owner's privileges have ended.
-- Its existing trigger uses an empty search_path, reads public.case_contacts
-- for the affected case and organization, and returns no contact data.
ALTER FUNCTION public.enforce_case_contact_primary() SECURITY DEFINER;
REVOKE ALL ON FUNCTION public.enforce_case_contact_primary()
  FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
