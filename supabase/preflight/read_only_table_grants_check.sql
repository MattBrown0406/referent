-- Read-only check for 20261106140000_read_only_table_grants.sql. Paste into
-- the SQL editor and Run, before and after. One SELECT on the system
-- catalogs: it reads no app rows and changes nothing.
WITH k AS (
 SELECT 'anon'::regrole::oid AS anon, 'authenticated'::regrole::oid AS auth, 'postgres'::regrole::oid AS pg
), ro(relname) AS (
 VALUES ('case_stage_history'), ('center_claim_codes'), ('center_claim_requests'), ('center_members'),
 ('org_entitlements'), ('org_invites'), ('org_members'), ('org_revenuecat_grants'), ('platform_admins'), ('orgs')
), t AS (
 SELECT c.oid, c.relname::text AS relname, c.relkind, c.relrowsecurity AS rls, a.anon_p, a.auth_p, a.other_g,
 coalesce(array_to_string(c.reloptions, ','), '') ~ 'security_invoker=(on|true|1|yes)' AS invoker
 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN k
 CROSS JOIN LATERAL (
  SELECT string_agg(DISTINCT x.privilege_type, ',' ORDER BY x.privilege_type) FILTER (WHERE x.grantee IN (k.anon, 0)) AS anon_p,
  string_agg(DISTINCT x.privilege_type, ',' ORDER BY x.privilege_type) FILTER (WHERE x.grantee = k.auth) AS auth_p,
  string_agg(DISTINCT pg_get_userbyid(x.grantor), ',') FILTER (WHERE x.grantee IN (k.anon, k.auth, 0) AND x.grantor <> k.pg) AS other_g
  FROM aclexplode(c.relacl) x
 ) a
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
)
SELECT * FROM (
 SELECT 1 AS sort, 'server' AS kind, 'postgres ' || current_setting('server_version') AS object,
 NULL::text AS anon, NULL::text AS authenticated, NULL::text AS expected, 'info' AS status
 UNION ALL
 SELECT 2, 'default privileges', 'tables created by ' || pg_get_userbyid(d.defaclrole),
 string_agg(DISTINCT x.privilege_type, ',' ORDER BY x.privilege_type) FILTER (WHERE x.grantee IN (k.anon, 0)),
 string_agg(DISTINCT x.privilege_type, ',' ORDER BY x.privilege_type) FILTER (WHERE x.grantee = k.auth), NULL, 'info'
 FROM pg_default_acl d CROSS JOIN k CROSS JOIN LATERAL aclexplode(d.defaclacl) x
 WHERE d.defaclnamespace = 'public'::regnamespace AND d.defaclobjtype = 'r'
 GROUP BY d.defaclrole
 UNION ALL
 SELECT 3, CASE WHEN ro.relname IS NOT NULL THEN 'read-only table' WHEN t.relkind IN ('r', 'p') THEN 'table' ELSE 'view' END,
 coalesce(t.relname, ro.relname), t.anon_p, t.auth_p, CASE WHEN ro.relname IS NOT NULL THEN 'SELECT' END,
 CASE
  WHEN t.oid IS NULL THEN 'MISSING: not in this database, do not run the migration'
  WHEN ro.relname IS NOT NULL AND t.other_g IS NOT NULL THEN 'BLOCKER: granted by ' || t.other_g
  WHEN ro.relname IS NOT NULL AND (t.anon_p IS NOT NULL OR t.auth_p IS DISTINCT FROM 'SELECT') THEN 'FIX: the migration revokes this'
  WHEN t.relkind IN ('r', 'p') AND NOT t.rls AND (t.anon_p IS NOT NULL OR t.auth_p IS NOT NULL) THEN 'REVIEW: no RLS'
  WHEN t.relkind IN ('v', 'm') AND NOT t.invoker AND concat(t.anon_p, t.auth_p) LIKE '%SELECT%' THEN 'REVIEW: readable view without RLS'
  ELSE 'ok'
 END
 FROM t FULL JOIN ro ON ro.relname = t.relname
 UNION ALL
 SELECT 4, 'column grant', 'orgs: columns authenticated can UPDATE', NULL, oc.cols, 'lead_response_target_minutes,name',
 CASE WHEN oc.cols = 'lead_response_target_minutes,name' THEN 'ok' ELSE 'FIX: the migration narrows this' END
 FROM (SELECT string_agg(a.attname, ',' ORDER BY a.attname) AS cols FROM pg_attribute a
  WHERE a.attrelid = 'public.orgs'::regclass AND a.attnum > 0 AND NOT a.attisdropped
  AND has_column_privilege('authenticated', a.attrelid, a.attnum, 'UPDATE')) oc
) r
ORDER BY sort, status = 'ok', object;
