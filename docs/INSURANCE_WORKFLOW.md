# Insurance as a workflow, not a note

Roadmap feature 4. Verification of benefits (VOB) is the daily blocker when
placing a family. Instead of a line in the case summary, the case file now
carries the family's plan and a tracked list of VOB requests, each with a
status, a reminder to chase it, and a timeline entry for every change.

Migration: `supabase/migrations/20261001170000_insurance_workflow.sql`.
pgTAP: `supabase/tests/insurance_workflow_test.sql`. Pure logic and its
node test: `src/lib/insurance.ts`, `scripts/insurance-test.mjs`.

## What is stored

**The plan** (`case_benefits`, one row per case):

| Column | What it holds |
| --- | --- |
| `carrier` | The carrier, from the same state-aware menu Match uses |
| `plan_name` | Free text, e.g. "PPO Choice" |
| `member_id_last4` | The **last four characters** of the member id, or empty |
| `subscriber_relationship` | `self`, `spouse`, `parent`, `child`, `other`, or empty |

A check constraint makes `member_id_last4` exactly four characters or
empty, and `save_case_benefits` refuses anything longer, so a full member id
cannot be stored even by mistake. The app trims what is typed to the last
four before it is held in state.

**The requests** (`vob_requests`, one row per program asked):

| Column | What it holds |
| --- | --- |
| `case_id`, `partner_id`, `global_partner_id` | The case; the partner asked (optional) and its linked listing, if any |
| `program_name` | The program's name, snapshotted so the row still reads if the partner is removed |
| `status` | `requested`, `pending`, `in_network`, `out_of_network`, `not_accepted` |
| `requested_at`, `requested_by` | When, and which member asked |
| `answered_at`, `answered_by` | When the program answered (server-stamped) and who at the program said it (free text) |
| `note`, `quoted_out_of_pocket` | Notes and the quoted out-of-pocket in whole dollars |
| `follow_up_id` | The chase follow-up |

## What is not stored

- No full member id. No date of birth. No SSN. No group number.
- Nothing from this feature reaches the directory, the center portal, a
  push payload, or any aggregate. The Business tile reads only
  `requested_at` and `answered_at`.
- No push notification is queued: the chase follow-up is assigned to the
  member who asked, which the existing assignment trigger skips.

Both tables are org-scoped under RLS: every member of the workspace reads
them; other workspaces see nothing. Clients hold `SELECT` only. Writes go
through the functions below so each change lands on the case timeline with
`case_events.actor_id` stamped by the existing trigger.

## How statuses work

| Status | Meaning | `answered_at` |
| --- | --- | --- |
| `requested` | Asked; nothing back yet | empty |
| `pending` | The program is working on it | empty |
| `in_network` | The carrier says in-network | set |
| `out_of_network` | The carrier says out-of-network | set |
| `not_accepted` | The program does not take this plan | set |

- `request_vob(p_request)` creates the row as `requested`, a `waiting_on`
  follow-up titled "Check on VOB: <program>" due the next business day
  (Saturday and Sunday roll to Monday; the app sends its device-local date,
  the server computes its own when missing) assigned to the requester, and a
  timeline entry "VOB requested: <program>". Idempotent on the request id.
- `update_vob_status(p_id, p_patch, p_event_id)` records the answer. Moving
  to an answered status stamps `answered_at`, completes the chase follow-up,
  and writes "VOB in-network: <program>, about $500 out of pocket (per
  Maria)". Moving back to `requested` or `pending` clears `answered_at`. A
  note-only edit writes no entry.
- `save_case_benefits(p_case_id, p_patch, p_event_id)` stores the plan and
  writes "Insurance plan added: Aetna PPO Choice (subscriber: parent)" when
  something changed. The entry never includes the member id digits.

## Which of my partners take this plan?

`partners_for_plan(p_insurance, p_state)` returns every partner in the
caller's workspace with `network_status` (`in_network`, `out_of_network`,
`unknown`), `source` (`listing`, `partner`, `none`) and `same_state`.

- An explicit `insurance_networks` entry for the plan wins.
- A carrier listed under `insurance` with no entry counts as in-network, the
  same reading `networkCapabilitiesForPartner` in the app uses.
- Anything else is `unknown`, never out-of-network: self-reported lists are
  often incomplete.
- When the partner is linked to an active directory listing the caller can
  read, the listing's `insurance` and `insurance_networks` (the center
  portal's out-of-network carrier flags) are used instead of the copy.
- `same_state` is null when `p_state` is empty or `ANY`; the function never
  hides out-of-state partners, the app orders them.

It runs as the caller (`SECURITY INVOKER`), so RLS keeps it to the caller's
partners and the listings their plan allows.

## Keeping it honest

Network status from partner records, listings, and match results is what
each program reports about itself and is labelled **per program**. A VOB
answer recorded on a case is labelled **confirmed by VOB** on that case's
match results and suggestion list only. It never rewrites the partner's
`insurance_networks` or the listing.

## Business tile

"Benefits checks" shows the median days from `requested_at` to
`answered_at` over answered requests, by the day requested, for 30 / 90 /
365 days and all time, plus answered-of-requested counts. Workspace totals
only. `summarizeVobTurnaround` in `src/lib/insurance.ts` mirrors
`vob_turnaround_stats()` in the migration; keep the two in step.

## Applying to production

The migration is pasted by hand into the SQL editor. It contains no
backslashes and no non-ASCII characters, and every top-level statement is
under 3,700 characters. After it runs, record it:

```sql
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('20261001170000', 'insurance_workflow');
```

Verification queries:

```sql
-- The two tables exist, RLS is on, and clients hold SELECT only.
SELECT c.relname, c.relrowsecurity,
       has_table_privilege('authenticated', c.oid, 'SELECT') AS can_select,
       has_table_privilege('authenticated', c.oid, 'INSERT') AS can_insert,
       has_table_privilege('authenticated', c.oid, 'UPDATE') AS can_update
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname IN ('case_benefits', 'vob_requests');

-- The member id constraint is in place.
SELECT conname FROM pg_constraint
 WHERE conrelid = 'public.case_benefits'::regclass AND pg_get_constraintdef(oid) LIKE '%member_id_last4%';

-- The functions are callable by signed-in users only.
SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_ok,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_ok
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('request_vob', 'update_vob_status', 'save_case_benefits', 'partners_for_plan', 'vob_turnaround_stats');
```

Expected: two rows with `relrowsecurity = true`, `can_select = true`,
`can_insert = false`, `can_update = false`; one constraint name; five
functions with `authenticated_ok = true` and `anon_ok = false`.
