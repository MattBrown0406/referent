# Team basics: assignees, who did what, push

Roadmap feature 5. For a practice with staff: share the work, see who did
what, and get a heads-up when something needs a person. Solo workspaces
see no change: the pickers, the Mine/Everyone switch, and "Take this lead"
appear only when the workspace has more than one member, and nothing is
pushed until a member turns it on.

Migration: `supabase/migrations/20261001140000_team_basics.sql`. Push
delivery and deployment are in `NOTIFICATIONS.md`.

## What it does

**Assignees.** `cases.assigned_to` and `follow_ups.assigned_to` are optional
and must name a member of the same workspace (trigger, error 22023). A
follow-up with no assignee of its own belongs to whoever its case is
assigned to; "Take this lead" on a NEW LEADS card assigns the case to you
and so takes its first call with it. Leads from the intake link arrive
unassigned. When a member leaves the practice, their assignments in it go
back to Unassigned. `assign_case()` changes the case and writes the
timeline entry ("Assigned to Mikayla", "Took this case", "Unassigned") in
one transaction.

**Today: Mine / Everyone.** Mine keeps what is assigned to you and anything
nobody has taken yet, so an unowned item never disappears from everyone's
list at once. Partner-cadence cards are nobody's and always show. The
default is Mine when the workspace has more than one member.

**Who did what.** `case_events.actor_id` is stamped from the signed-in
member on every insert and cannot be set or changed by a client (error
42501 on change). `follow_ups.completed_by` is stamped when a follow-up
leaves `open` and cleared when it is reopened. Both are backfilled from
`owner_id`. The timeline shows "by Mikayla" on rows and "Done by Mikayla,
2:14 PM" on completions. There are no counts per person anywhere, and none
are planned: this is a record, not a scoreboard.

**Push.** See `NOTIFICATIONS.md`.

## Apply the migration

The migration adds nullable columns, three tables, functions, and
triggers, and backfills `actor_id` / `completed_by`. It deletes nothing and
replaces no existing function. Apply it before the app build that contains
the pickers ships: that build writes `assigned_to` when a member assigns
something, and `fetchNotificationPreferences` reads the new table (it
degrades to "not available yet" when the table is missing).

The file is transit-safe for pasting from a chat client: no backslashes
and no non-ASCII characters anywhere, and every top-level statement is
under 3,700 characters.

1. Supabase, **SQL Editor**, paste the whole file, Run. It is wrapped in
   `BEGIN ... COMMIT`, so it applies atomically.
2. Record it so `supabase db push` and CI agree with production:

   ```sql
   INSERT INTO supabase_migrations.schema_migrations (version, name)
   VALUES ('20261001140000', 'team_basics');
   ```

## Verify

```sql
-- 1. Backfill: every timeline entry with an owner has an actor, and every
--    completed follow-up records who completed it.
SELECT count(*) FILTER (WHERE actor_id IS NULL AND owner_id IS NOT NULL) AS entries_missing_actor
  FROM public.case_events;
SELECT count(*) FILTER (WHERE status <> 'open' AND completed_by IS NULL AND owner_id IS NOT NULL) AS done_missing_completer
  FROM public.follow_ups;

-- 2. No assignment points outside its workspace (should be 0 and 0).
SELECT (SELECT count(*) FROM public.cases c
         WHERE c.assigned_to IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM public.org_members m WHERE m.user_id = c.assigned_to AND m.org_id = c.org_id)) AS bad_case_assignees,
       (SELECT count(*) FROM public.follow_ups f
         WHERE f.assigned_to IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM public.org_members m WHERE m.user_id = f.assigned_to AND m.org_id = f.org_id)) AS bad_follow_up_assignees;

-- 3. Grants: the outbox is closed to every client role; the dispatcher RPCs
--    run only as service_role.
SELECT has_table_privilege('authenticated', 'public.notification_outbox', 'SELECT') AS authenticated_reads_outbox,
       has_table_privilege('service_role', 'public.notification_outbox', 'SELECT') AS service_reads_outbox,
       has_function_privilege('authenticated', 'public.push_outbox_claim(integer)', 'EXECUTE') AS authenticated_claims,
       has_function_privilege('service_role', 'public.push_outbox_claim(integer)', 'EXECUTE') AS service_claims;
```

Expected for query 3: `false, false, false, true`.

## Tests

* `supabase/tests/team_basics_test.sql` (pgTAP): assignment visible in the
  org and invisible across orgs, member-only assignees, actor and
  completed_by stamping, token ownership, outbox rows per trigger with
  generic copy, admin-only kind never reaching a non-admin, dispatcher RPCs.
* `scripts/today-test.mjs`: Mine/Everyone filtering and the default scope.
