# Outcomes loop

Roadmap feature 2 (Matt Brown, 2026-10-01): "Close the loop: outcomes that
make your matching smarter". Migration `20261001160000_outcomes_loop.sql`;
pgTAP `supabase/tests/outcomes_loop_test.sql`; node
`scripts/outcomes-test.mjs` and section (g) of `scripts/matching-test.mjs`.

Ratings stay exactly as they were: the interventionist enters the 1-5
"family experience" after talking with the family. Nothing in this feature
is family-facing. There is no rating link, page, or message for families.

## What is recorded

On `referrals`, next to the existing outcome columns (`admitted`,
`admitted_on`, `family_experience`, `outcome_note`):

| Column | Meaning |
| --- | --- |
| `completed boolean` | Did the client finish the program? `NULL` until a check-in answers it either way. |
| `completed_on date` | Set with `completed = true`; the day the check-in was recorded unless already set. |
| `still_enrolled boolean` | From the latest check-in. |
| `last_check_in_at timestamptz` | Server-stamped whenever a check-in is saved. |

On `follow_ups`: a new kind `check_in` and `check_in_days` (7, 30 or 90).

## When check-ins fire

Recording an admission (the existing "Did they admit? Yes" sheet) now runs
`record_placement_outcome(referral, outcome, completed follow-up)`, which in
one transaction:

1. completes the follow-up that prompted it (if any),
2. updates the referral's outcome fields,
3. calls `schedule_placement_check_ins(referral)`.

The schedule rule:

- one check-in per offset, due `admitted_on + 7`, `+ 30` and `+ 90` days;
- a check-in whose due date is already past is skipped (due today is kept);
- identical check-ins are never duplicated: a partial unique index on
  `(referral_id, check_in_days) WHERE kind = 'check_in'` plus
  `ON CONFLICT DO NOTHING`, so re-saving the outcome, replaying the offline
  queue, or two devices racing all create the three rows once;
- each check-in is assigned to the case assignee when the referral is linked
  to a case, else to the referral's author while they are still a member of
  the workspace, else left unassigned;
- the title is `7-day check-in: <client label>` (ASCII only; the server
  writes it), the partner, referral and case are carried over.

Check-ins ride the existing follow-up machinery: they appear on Today with
their own icon and a "30-day outcome check-in" line, sort after calls and
consults, snooze like anything else, and the `overdue_mine` push from team
basics covers them with no new notification kind. **Done** on a check-in
opens the check-in sheet: one question (still enrolled / completed the
program / left before completing), the family-experience stars pre-filled
with the current value, an optional note. Saving runs the same
`record_placement_outcome` with `check_in = true`, which completes the
follow-up and updates the referral. A note appends to the existing outcome
note rather than replacing it.

Changing an admission date later does **not** move check-ins that already
exist (they are identified by offset, not date), and completing or leaving a
program does not cancel the remaining check-ins; the interventionist can
skip them from Today. Both are deliberate and listed as decisions for Matt.

## Partner scorecard (this workspace only)

`partner_scorecard` keeps its existing columns and adds, over outbound
referrals to the partner:

| Column | Computed as |
| --- | --- |
| `completed` | admitted and `completed = true` |
| `decided_placements` | admitted and `completed IS NOT NULL` |
| `completion_rate` | `completed / decided_placements`, 4 decimals; `NULL` until something is decided |
| `median_days_to_admit` | `percentile_cont(0.5)` of `admitted_on - referred_on` over admitted referrals with `admitted_on >= referred_on` |
| `still_enrolled` | admitted, `still_enrolled = true`, not completed |

The partner detail "Track record" card shows: sent, admitted, family
experience (as before), then completion rate with its counts, "Typically N
days from referral to admission", still-enrolled count, and "Bills some
carriers out-of-network" when the linked directory listing marks any
carrier out-of-network (`insurance_networks`, set by the program in the
Center Portal). Plain counts and rates, never a ranking, never per person.

`src/lib/outcomes.ts` (`summarizeOutcomes`) computes the same figures on the
client for the Business dashboard's **Outcomes** row (placements, completed,
time to admit, family experience) over outbound referrals in the selected
period by referral date. The referral list it reads is paged like every
other list (`fetchAllPages`).

## Network-wide aggregates

`global_partner_stats` (materialized, refreshed hourly by the existing
pg_cron job through `refresh_global_partner_stats()`) adds, over the same
12-month window of outbound referrals from linked partners:

- `completion_rate` = completed / decided placements,
- `median_days_to_admit` = median of `admitted_on - referred_on`,
- the supporting counts `decided_placements_12m` and `dated_admits_12m`.

`fetch_global_partner_stats(p_ids)` returns them under the **same
disclosure rule** as admit rate: at least five distinct referring
workspaces, and at least five decided placements (for completion) or five
dated admits (for the median). Platform admins see the raw figures. The
directory card line gains "67% completed" and "typically 5 days to admit"
when disclosed.

## Matching

See `docs/MATCHING.md`, "Track record". In short: family experience stays
the primary signal; completion joins the blend at 25% (experience 60%, admit
rate 15%); each signal is shrunk toward the prior with
`TRACK_RECORD_PRIOR_CASES` (5) prior cases; and when this workspace has
fewer than five decided cases with a program, the disclosed network figures
for its listing are the prior instead of the workspace average.

## Applying to production

The migration is pasted by hand into the SQL editor. It contains no
backslashes and no non-ASCII characters, and every top-level statement is
under 3,700 characters. After it runs, record it:

```sql
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('20261001160000', 'outcomes_loop');
```

Verification queries:

```sql
-- The check-in kind and its uniqueness guard exist.
SELECT conname FROM pg_constraint
 WHERE conrelid = 'public.follow_ups'::regclass AND conname IN ('follow_ups_kind_check', 'follow_ups_check_in_days_check');
SELECT indexname FROM pg_indexes WHERE tablename = 'follow_ups' AND indexname = 'follow_ups_check_in_once_idx';

-- The scorecard and the network view carry the new measures.
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'partner_scorecard' AND column_name IN ('completion_rate', 'median_days_to_admit', 'still_enrolled');
SELECT attname FROM pg_attribute
 WHERE attrelid = 'public.global_partner_stats'::regclass AND attname IN ('completion_rate', 'median_days_to_admit');

-- The RPCs are callable by signed-in users only.
SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_ok,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_ok
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('record_placement_outcome', 'schedule_placement_check_ins', 'fetch_global_partner_stats');
```

Expected: both constraint names and the index; three scorecard columns and
two view attributes; three functions with `authenticated_ok = true` and
`anon_ok = false`.
