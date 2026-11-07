# Read-only table grants

Migration: `supabase/migrations/20261106140000_read_only_table_grants.sql`
Check: `supabase/preflight/read_only_table_grants_check.sql`
Tests: `supabase/tests/read_only_table_grants_test.sql`

Written 2026-10-23 (as 20261023200000, never applied). Renamed to
20261106140000 when it joined this branch, because production applies it after
the November migrations. The production check (below) was run read-only on
2026-11-06: no blockers; all ten tables still hold privileges the migration
removes (MAINTAIN, REFERENCES, TRIGGER, TRUNCATE; none reachable through the
API); the `orgs` column grant is already narrowed.

Ten tables are meant to be read-only to signed-in clients. Their writes go
through SECURITY DEFINER functions or the service role. In fact, clients held
every write privilege on them. This migration takes those privileges away. The
app does not change: it never writes to these tables directly, and the two
`orgs` columns it does edit keep their grants.

## What was wrong

Each of these tables was created with:

```sql
REVOKE ALL ON public.<table> FROM anon, PUBLIC;
GRANT SELECT ON public.<table> TO authenticated;
```

That assumes `authenticated` starts with nothing, and it doesn't. Supabase's
default privileges for tables that `postgres` creates in `public`
(`pg_default_acl`) grant `arwdDxtm` to `anon`, `authenticated` and
`service_role`. That is INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES,
TRIGGER and, on Postgres 17, MAINTAIN. The migrations revoked from `anon` and
`PUBLIC` only, so `authenticated` kept everything.

- Without a write policy, RLS still blocked INSERT, UPDATE and DELETE. RLS was
  the only guard.
- RLS does not apply to TRUNCATE or MAINTAIN. On a fresh local reset, a
  session running as `authenticated` could
  `TRUNCATE public.platform_admins, public.org_entitlements,
  public.case_stage_history`. PostgREST has no TRUNCATE endpoint, so the API
  can't reach this. Any other SQL path running as `authenticated` could.
- **`orgs` was reachable through the API.** The migrations grant
  `UPDATE (name)` and `UPDATE (lead_response_target_minutes)` only. The default
  table-level UPDATE let a workspace owner PATCH any column under the "owner
  rename" policy. On a local reset an owner set `intake_token` to forty zeros
  and back-dated `intake_token_rotated_at`. `intake_token` is meant to change
  only through `rotate_intake_token()`.

CI pins Supabase CLI 2.110 and its pgTAP suite passes. Local CLI 2.118 (image
`postgres:17.6.1.171`) applies the default privileges above, and two tests
fail there: `business_operations_test.sql` test 4 and `entitlements_test.sql`
test 2.

## The fix

For the ten tables: `REVOKE ALL ... FROM PUBLIC, anon, authenticated`, then
`GRANT SELECT ... TO authenticated` and
`GRANT UPDATE (name, lead_response_target_minutes) ON public.orgs TO authenticated`.

The migration uses REVOKE ALL instead of listing privileges because REVOKE ALL
also removes MAINTAIN, which `information_schema.role_table_grants` doesn't
report. REVOKE ALL is also valid on every Postgres version. The file runs as
one transaction, so clients never see a table without SELECT. A self-check at
the end raises if anything other than these grants is still held, and the
whole migration then rolls back unchanged. Two things trigger it:

- a grant made by a role other than `postgres`, which REVOKE run as `postgres`
  cannot remove;
- an extra updatable `orgs` column.

| Table | Who writes it (all keep working) |
| --- | --- |
| `case_stage_history` | `track_case_stage_history` trigger |
| `center_claim_codes` | `create_center_claim_code`, `claim_center_listing` |
| `center_claim_requests` | `upsert_org_directory_profile`, approve/reject RPCs |
| `center_members` | `claim_center_listing` |
| `org_entitlements` | service role (RevenueCat webhook), manual SQL |
| `org_invites` | `create_org_invite`, `accept_org_invite` |
| `org_members` | `handle_new_user`, `accept_org_invite`, `remove_org_member` |
| `org_revenuecat_grants` | `apply_revenuecat_grant_event` (service role) |
| `platform_admins` | manual SQL |
| `orgs` | clients: `name`, `lead_response_target_minutes`. Everything else through RPCs |

Every function listed is SECURITY DEFINER and owned by `postgres`. None of
them depends on the revoked grants. The app (`src/`, `portal/src/`) only
reads these tables. Its one direct write is the two `orgs` column updates in
`src/lib/org.ts`.

## Audit of every public table (local reset, CLI 2.118)

Privileges are what `authenticated` holds. anon holds nothing on any table.

| Table | Before | After | Design |
| --- | --- | --- | --- |
| the ten above | all eight | SELECT (+ two `orgs` columns) | read-only, fixed here |
| `case_benefits`, `vob_requests`, `listing_bed_updates`, `push_tokens` | SELECT | SELECT | read-only, already right |
| `placement_decisions` | INSERT, SELECT | same | append-only, already right |
| `notification_preferences` | INSERT, SELECT, UPDATE | same | already right |
| `integration_webhook_events`, `intake_rate_limits`, `notification_outbox` | none | none | service-only, already right |
| `cases`, `case_contacts`, `case_documents`, `case_events`, `case_integrations`, `follow_ups`, `match_profiles`, `partners`, `referrals`, `touches`, `user_favorites` | all eight | same | read-write with an ALL or per-command policy, not changed |
| `global_partners` | all but table-level UPDATE (UPDATE is column-level) | same | admin/center writes under policy, not changed |

## Applying to production

The migration is pasted by hand into the SQL editor. It contains no
backslashes and no non-ASCII characters. Every top-level statement is under
3,700 characters, and the comments contain no semicolons.

1. **Check first.** Paste `supabase/preflight/read_only_table_grants_check.sql`
   into the SQL editor and Run it. It is one SELECT on the system catalogs, so
   it reads no app rows and changes nothing. Read the `status` column:
   - `FIX: the migration revokes this` / `FIX: the migration narrows this`:
     production has the same gap as local. The migration fixes it.
   - `ok` on all ten read-only rows and on the `orgs` column row:
     production is already right. The migration is then a no-op. Apply it
     anyway so the history matches.
   - `MISSING` or `BLOCKER`: stop. A table isn't there, or a grant was made by
     a role the SQL editor can't revoke from. Send the output before going
     further.
   - The `default privileges` rows show what production hands out by default.
     If they list INSERT for `authenticated`, every future table needs
     `REVOKE ALL ... FROM PUBLIC, anon, authenticated` before its GRANT.
2. Paste the whole migration file into the SQL editor and Run it. It is
   wrapped in `BEGIN ... COMMIT` and checks itself before committing.
3. Record it so `supabase db push` and CI agree with production:

   ```sql
   INSERT INTO supabase_migrations.schema_migrations (version, name)
   VALUES ('20261106140000', 'read_only_table_grants');
   ```

4. Run the check again. Expected: every `read-only table` row and the
   `column grant` row say `ok`.
5. Smoke test in the app: rename the workspace, change the first-call target,
   and rotate the intake link.

To undo a single table, if something unexpected turns out to need a write
grant: `GRANT INSERT, UPDATE, DELETE ON public.<table> TO authenticated;`.
RLS still applies after that grant.

## Not changed here

- The read-write tables keep TRUNCATE, REFERENCES, TRIGGER and MAINTAIN from
  the default privileges. TRUNCATE ignores RLS. The API can't reach these
  privileges, and a separate migration could revoke all four from
  `authenticated` everywhere.
- `anon` holds every privilege on the views `partner_balances`,
  `partner_scorecard`, `partners_going_cold` and `today_actions`. All four
  are `security_invoker`, so anon still gets permission denied on the base
  tables. The check flags any view that is readable and not
  `security_invoker`.
- CI still pins CLI 2.110. The new test's drift guards fail on images that
  apply the default privileges: a client write grant with no matching policy,
  or a reachable table without RLS. They only protect CI once CI runs such an
  image.
