BEGIN;

-- Read-only tables: make the grants say what the migrations always meant.
--
-- Each table below was created with
--
--   REVOKE ALL ON <table> FROM anon, PUBLIC
--   GRANT SELECT ON <table> TO authenticated
--
-- on the assumption that authenticated started with nothing. It does not.
-- Supabase's default privileges for tables that postgres creates in schema
-- public (pg_default_acl) grant arwdDxtm to anon, authenticated and
-- service_role: INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES,
-- TRIGGER and, on Postgres 17, MAINTAIN. Revoking from anon and PUBLIC left
-- authenticated holding every write privilege, so RLS (no write policy) was
-- the only thing stopping writes, and RLS does not apply to TRUNCATE at all.
--
--   case_stage_history     written by the track_case_stage_history trigger
--   center_claim_codes     written by create_center_claim_code / claim_center_listing
--   center_claim_requests  written by upsert_org_directory_profile and the review RPCs
--   center_members         written by claim_center_listing
--   org_entitlements       written by the service role and manual SQL only
--   org_invites            written by create_org_invite / accept_org_invite
--   org_members            written by handle_new_user / accept_org_invite / remove_org_member
--   org_revenuecat_grants  written by apply_revenuecat_grant_event (service role)
--   platform_admins        written by manual SQL only
--   orgs                   members read, owners may change name and
--                          lead_response_target_minutes, nothing else
--
-- Every writer listed is a SECURITY DEFINER function owned by postgres or
-- the service role, so none of them depends on the grants removed here.
--
-- orgs is the one with a reachable gap: the default table-level UPDATE let
-- a workspace owner rewrite any column through the API (intake_token,
-- intake_token_rotated_at, created_by), not just the two columns the app
-- edits. intake_token is meant to change only through rotate_intake_token().
--
-- REVOKE ALL rather than a list of privileges: it also removes MAINTAIN,
-- which information_schema does not report, and it is valid on every
-- Postgres version. On a table, REVOKE ALL also clears column grants, so
-- the two orgs column grants are made again. The whole file is one
-- transaction, so clients never see the table without SELECT.

REVOKE ALL ON TABLE
  public.case_stage_history,
  public.center_claim_codes,
  public.center_claim_requests,
  public.center_members,
  public.org_entitlements,
  public.org_invites,
  public.org_members,
  public.org_revenuecat_grants,
  public.platform_admins,
  public.orgs
FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE
  public.case_stage_history,
  public.center_claim_codes,
  public.center_claim_requests,
  public.center_members,
  public.org_entitlements,
  public.org_invites,
  public.org_members,
  public.org_revenuecat_grants,
  public.platform_admins,
  public.orgs
TO authenticated;

GRANT UPDATE (name, lead_response_target_minutes) ON TABLE public.orgs TO authenticated;

-- Self-check. If anything other than the grants above is still held (for
-- example a grant made by a different grantor, which REVOKE run as postgres
-- cannot remove), raise, and the whole transaction rolls back unchanged.
DO $$
DECLARE
  v_leftover text;
  v_org_columns text;
BEGIN
  SELECT string_agg(c.relname || ' ' || coalesce(r.rolname, 'PUBLIC') || ' ' || x.privilege_type, ', ' ORDER BY c.relname, x.privilege_type)
    INTO v_leftover
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) x
    LEFT JOIN pg_roles r ON r.oid = x.grantee
   WHERE c.oid IN (
           'public.case_stage_history'::regclass,
           'public.center_claim_codes'::regclass,
           'public.center_claim_requests'::regclass,
           'public.center_members'::regclass,
           'public.org_entitlements'::regclass,
           'public.org_invites'::regclass,
           'public.org_members'::regclass,
           'public.org_revenuecat_grants'::regclass,
           'public.platform_admins'::regclass,
           'public.orgs'::regclass)
     AND (x.grantee = 0 OR r.rolname IN ('anon', 'authenticated'))
     AND NOT (r.rolname = 'authenticated' AND x.privilege_type = 'SELECT');
  IF v_leftover IS NOT NULL THEN
    RAISE EXCEPTION 'read-only tables still grant: %', v_leftover;
  END IF;

  SELECT string_agg(a.attname, ',' ORDER BY a.attname)
    INTO v_org_columns
    FROM pg_attribute a
   WHERE a.attrelid = 'public.orgs'::regclass
     AND a.attnum > 0
     AND NOT a.attisdropped
     AND has_column_privilege('authenticated', a.attrelid, a.attnum, 'UPDATE');
  IF v_org_columns IS DISTINCT FROM 'lead_response_target_minutes,name' THEN
    RAISE EXCEPTION 'orgs columns updatable by authenticated: %', coalesce(v_org_columns, 'none');
  END IF;
END
$$;

COMMIT;
