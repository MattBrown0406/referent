# True cost to the family

A benefits check used to answer one question per program: in-network,
out-of-network, or not accepted. That does not tell a family whether they
can afford a placement. This feature records the numbers that decide it and
turns them into an estimate of what the family would pay out of pocket, so a
practitioner can place clients in programs that are clinically **and**
financially appropriate.

It is always labelled an **estimate, not a quote**. It never changes a
match's score or rank. It is the family's business: the program's copy of a
packet never carries it.

Migration: `supabase/migrations/20261104120000_family_cost.sql`.
pgTAP: `supabase/tests/family_cost_test.sql`. Pure logic:
`src/lib/family-cost.ts` (the estimator) and `src/lib/family-cost-form.ts`
(the editor fields). Node test: `scripts/family-cost-test.mjs`. The case
file panel: `src/lib/FamilyCostPanel.tsx`.

## What is stored

**On the family's plan** (`case_benefits`, one row per case), for
in-network (`in_`) and out-of-network (`oon_`) separately:

| Column | What it holds |
| --- | --- |
| `in_deductible`, `oon_deductible` | The deductible, whole dollars |
| `in_deductible_met`, `oon_deductible_met` | How much of it is met so far this plan year |
| `in_oop_max`, `oon_oop_max` | The out-of-pocket maximum |
| `in_oop_met`, `oon_oop_met` | How much of it is met so far |
| `in_coinsurance_pct`, `oon_coinsurance_pct` | The family's share after the deductible, 0 to 100 |
| `oon_benefits` | Does the plan pay anything out-of-network? `true`, `false`, or `null` (not known) |

**On each program's answer** (`vob_requests`):

| Column | What it holds |
| --- | --- |
| `allowed_daily_rate` | What the plan (estimated) allows per day at this program |
| `billed_daily_rate` | What the program bills per day |
| `copay_per_day` | A per-day copay, if the plan has one |
| `precert_required` | Does the plan need pre-authorization? `true`, `false`, or `null` |

Every column is nullable with no default: **null means "not entered"**,
never 0. A real 0 (a $0 deductible, 0% coinsurance, a $0 copay) is stored as
0 and is different from blank. Whole dollars only, parsed in the app with
`parseWholeDollars` like every other money field. Limits: plan amounts $0 to
$1,000,000, the copay $0 to $100,000, coinsurance 0 to 100, and the
**allowed and billed daily rates $1 to $100,000**: a $0 rate would read as a
free stay, so it is refused (CHECK `BETWEEN 1 AND 100000`, and in
`vob_requests_apply_costs` with the 22023 message "Enter the daily rate in
dollars, or leave it blank if you do not know it."). Not known is blank
(null).

Rules, enforced in the app, in `case_benefits_merge_costs` (plain-words
errors), and by CHECK constraints as a backstop:

- a met amount is never more than its total (deductible, out-of-pocket max);
- a plan with **no** out-of-network benefits has no out-of-network amounts
  (choosing "No" in the editor clears them).

## How it is written

Through the two RPCs that already write the plan and the answers, as extra
keys of the `p_patch` they already take:

- `save_case_benefits(p_case_id, p_patch, p_event_id)` accepts the eleven
  plan keys above. A key the patch does not carry keeps its stored value;
  JSON `null` clears it. A change to the amounts alone writes an
  "Insurance plan updated: ..." timeline entry. **The amounts never go on
  the timeline.**
- `update_vob_status(p_id, p_patch, p_event_id)` accepts the four answer
  keys. A rate-only edit writes no timeline entry (like a note-only edit).
  A status change on an answer that needs pre-authorization says ",
  pre-authorization required" in its entry. The rates never go on the
  timeline.

Both keep their signature and return columns, so the 1.0.4 app works
unchanged (see "Compatibility" below). Both are re-created from their
latest definitions (`save_case_benefits` from 20261001170000;
`update_vob_status` from 20261024120000 section 19). The parsing lives in
internal helpers (`patch_whole_number`, `patch_tristate`,
`case_benefits_merge_costs`, `case_benefits_apply_costs`,
`vob_requests_apply_costs`) that only the SECURITY DEFINER writers can run.

`request_vob` is unchanged: a request carries no numbers yet.

## The estimate

`estimateFamilyCost` in `src/lib/family-cost.ts`, for one program and a
length of stay (`days`, default 30, 1 to 365). It returns a **low** and a
**high** in whole dollars, the **basis** in plain words, what is **missing**,
and **warnings**.

Which network: a VOB answer on the case wins (in-network, out-of-network,
not accepted); otherwise what the program reports for the plan ("as the
program reports it"). Which answer: the latest answered request for that
program, else the latest one with a rate on it. Cash pay ignores the plan.

### The plan's share (in-network, and out-of-network with benefits)

For `total` = daily rate x days:

```
deductible left    = max(0, deductible - deductible met)
share              = min(total, deductible left)
                   + coinsurance% x max(0, total - deductible left)
out-of-pocket left = max(0, out-of-pocket max - out-of-pocket met)
copays             = copay per day x days
low  = min(share + copays, out-of-pocket left)   copays count toward the max
high = min(share, out-of-pocket left) + copays   a plan where they do not
```

- No out-of-pocket max on file: nothing is capped (low = high = share +
  copays), and the basis says so.
- A "met so far" left blank is read as nothing met. Both readings can only
  overstate what the family pays, never understate it.
- In-network on the **billed** rate (no allowed rate on file): the allowed
  amount can only be lower, so the result is a ceiling: "up to $X".

### Out-of-network

- With out-of-network benefits: the out-of-network numbers on the **allowed**
  rate, as above, **plus the balance bill**: (billed - allowed) x days, on
  top of the high and **not capped** by the out-of-pocket max. Always
  warned: "Out-of-network, the program can bill the family the difference
  between its price and what the plan allows (balance billing)."
- Allowed known, billed not: "$X or more" (the balance bill cannot be
  priced).
- Billed known, allowed not: the share as if the plan allowed the whole
  billed price, which is the best case: "$X or more".
- **No out-of-network benefits** (or the VOB says **not accepted**): the
  full cost, billed rate x days; without a billed rate, the program's cash
  cost.
- Out-of-network benefits not known (and no out-of-network amounts):
  unknown, "add out-of-network benefits".

### Cash pay

Days x the program's daily cash rate. There is no daily cash field, so it
is the monthly cost / 30. A legacy cash range on the partner (`cashMin` <
`cashMax`, the monthly cost blank or equal to the top of the range) gives a
range. 0 is how "not entered" is stored and is never read as free.

### Unknown is unknown

When anything needed is missing the estimate is **unknown**, with what is
missing ("the in-network coinsurance", "the program's daily rate") and a
short next step for a card ("add benefits", "add the daily rate", "request
a VOB", "add the cash cost"). It never shows $0 and never says
"affordable". A **known** $0 (the out-of-pocket max is already met) is a
real answer and is shown as $0.

## Where it shows

- **Match results**: each ranked card, when the match is linked to a case
  with a plan on file (any linked case for cash pay), shows "Est. family
  cost (30 days): $X-$Y" or "... unknown - add benefits", plus "balance
  billing possible" out-of-network. Display only. `rankPrograms` and
  `scoreProgram` never read it; `scripts/family-cost-test.mjs` checks that
  the order and every score are identical with and without estimates.
- **The case file**, Benefits card: the plan's amounts, a length-of-stay
  choice (14, 30, 45, 60, 90 days; this device, this session), and one row
  per program on the case (the program the family was referred to, then
  every program asked for a VOB). Tap a row for how it was worked out.
- **The family's packet**: a short side-by-side for the program being sent
  (with the family's plan, and paying privately) and a one-line disclaimer.
  Nothing when neither is known.
- **The program's packet**: never. `buildPacket` drops the lines for the
  partner audience whatever is passed, as it already drops the family's
  budget.

The editors are inside the existing sheets (Insurance plan, VOB answer); no
new modal.

## Compatibility

The 1.0.4 app in TestFlight sends `save_case_benefits`, `request_vob` and
`update_vob_status` with the keys it has always sent and reads `select *`.
Against the new schema:

- the three functions have the same parameters and return columns (one
  definition each), so the calls succeed and read back the same rows and
  the same timeline wording;
- keys it does not send are left alone, so a 1.0.4 save or answer next to
  the new app never clears the amounts or rates;
- `select *` returns extra columns, which its mappers ignore.

`supabase/tests/family_cost_test.sql` section C makes exactly those calls.

The other way round, the new app against a server **without** this
migration: `fetchCaseBenefits` asks for the cost columns, gets 42703
(undefined column), reads again without them and reports
`costsAvailable: false`. The editors then hide the amounts (instead of
saving numbers the old functions would silently drop), the Benefits card
says the estimate needs a server update, and the match cards show nothing.

## Applying to production

Production has every migration through 20261024130000. Apply this one
**before** shipping an app build that includes the feature (the app copes
without it, but the feature stays hidden until it is applied).

1. Paste `supabase/migrations/20261104120000_family_cost.sql` into the SQL
   editor and run it. It is ASCII only, has no backslashes, every top-level
   statement is under 3,700 characters, and it runs in one BEGIN/COMMIT. It
   is safe to run twice (ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF
   EXISTS, CREATE OR REPLACE).
2. Record it:

   ```sql
   INSERT INTO supabase_migrations.schema_migrations (version, name)
   VALUES ('20261104120000', 'family_cost');
   ```

3. Verify:

   ```sql
   -- 11 + 4 new columns, all nullable with no default.
   SELECT table_name, count(*) AS columns, bool_and(is_nullable = 'YES' AND column_default IS NULL) AS nullable_no_default
     FROM information_schema.columns
    WHERE table_schema = 'public'
      AND ((table_name = 'case_benefits' AND column_name ~ '^(in|oon)_')
        OR (table_name = 'vob_requests' AND column_name IN ('allowed_daily_rate', 'billed_daily_rate', 'copay_per_day', 'precert_required')))
    GROUP BY table_name;

   -- The writers keep the 1.0.4 signatures; the helpers are internal.
   SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_ok,
          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_ok
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('save_case_benefits', 'update_vob_status', 'request_vob', 'patch_whole_number', 'patch_tristate',
                        'case_benefits_merge_costs', 'case_benefits_apply_costs', 'vob_requests_apply_costs')
    ORDER BY p.proname;
   ```

   Expected: `case_benefits` 11 and `vob_requests` 4, both
   `nullable_no_default = true`; one row per function; `save_case_benefits`,
   `update_vob_status`, `request_vob` with `authenticated_ok = true` and
   `anon_ok = false`; the five helpers with both `false`.

4. Ship the app build. Nothing else to deploy: no Edge Function, cron, or
   secret.

## Not in this version

- The length of stay is not saved; it resets to 30 days on the next launch.
- Plan-year resets (a stay that crosses into a new plan year) are not
  modelled.
- The family's packet is built when the composer opens; if the case's
  benefits had not loaded yet, reopen it.
