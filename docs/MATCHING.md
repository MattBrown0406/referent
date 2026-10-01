# Matching integrity: requirements hide, fit orders, counts never rank

Roadmap item "matching integrity" (Matt Brown, 2026-10-01). A family only
ever sees programs that meet every hard requirement, the order among those is
a plain fit score, and nothing about referral traffic or money between the
practice and a program can move a program up or down.

Nothing in this document is applied automatically. Matt applies the migration
by hand (see "Apply" below).

## The rule

All of it lives in `src/lib/matching.ts` (pure functions, no React, no
Supabase) and runs in `scripts/matching-test.mjs` under `npm test`. The app's
match list, the Match Packet's "why this fits", and the placement record all
read the same `scoreProgram` result.

### Step 1: hard requirements (hide, never demote)

A program that fails any one of these is not shown. It is never shown lower.

| Requirement | How it is read |
| --- | --- |
| Level of care | The profile's level of care is `Any type` or one of the partner's types. |
| Population | `Men`: never a women-only or adolescent-only program. `Women`: never men-only or adolescent-only. `Adolescent`: only programs that serve adolescents. `Any`: no filter. Men-only / women-only come from the partner's `Men only` / `Women only` need or a single-gender `populations` list; adolescent from the `Adolescent` need or `Adolescent` / `Adolescents` / `Teens` in `populations`. A partner with no populations recorded is read as adults, unless it lists `Adolescent` as a need (then adolescent-only, the safer reading for an adult client). Older profiles that carry `Men only`, `Women only`, or `Adolescent` as a selected need are read the same way. |
| A way to pay | Cash pay: monthly cost within the budget (no budget = any cost). Insurance: in-network, or out-of-network when the clinician allowed it, using the existing `insurance_networks` logic. |
| Location | The profile has no state, or the partner is in that state, or the partner serves `Nationwide`. Unchanged. |
| Must-have needs | Every need the clinician marked must-have is offered. `MAT` is must-have by default when selected (`MUST_HAVE_BY_DEFAULT`). The three population needs (`Men only`, `Women only`, `Adolescent`) are always requirements. |
| A bed (optional) | Only when the clinician turns on "Has a bed for" (Men / Women / Anyone; the client's population pre-selects it). A partner whose linked directory listing confirms 0 for that requirement within the last seven days is hidden. A partner with no linked listing, a count never set, or a count older than seven days is NOT hidden: it stays, and among equal fit it sorts below a confirmed open bed (a tie-break between the score and family cost; the score itself never moves). See `BED_AVAILABILITY.md`. |

What `src/data.ts` has: `therapyOptions` carries `Men only`, `Women only`,
`Adolescent` and `MAT`. There is no separate "Medication-assisted" entry, so
`MAT` is the only need that defaults to must-have.

### Step 2: the fit score (0 to 100)

Four parts, each a named constant in `src/lib/matching.ts`:

| Part | Weight | Constant | How it is scored |
| --- | --- | --- | --- |
| Clinical fit | 50 | `WEIGHT_CLINICAL_FIT` | Share of the client's preferred (non-must-have) needs the program offers. No preferred needs = full points. Must-haves are requirements and are not re-counted here. |
| Cost to the family | 25 | `WEIGHT_FAMILY_COST` | In-network: full. Out-of-network: `OUT_OF_NETWORK_COST_SHARE` (0.5) of the points plus a "Verify benefits" flag on the card. Cash pay with a budget: `CASH_AT_BUDGET_COST_SHARE` (0.5) at exactly the budget, rising toward full the further under budget. Cash pay without a budget: `CASH_NO_BUDGET_COST_SHARE` (0.5); cost still breaks ties. |
| Location preference | 10 | `WEIGHT_LOCATION` | New per-client field: `No preference` (full), `Close to family` (full when the program is in the client's state, else none), `Away from home` (the reverse). The only location data on both sides is the state, so same state versus different state is the distance proxy. With no client state the score is half. |
| Track record | 15 | `WEIGHT_TRACK_RECORD` | From `partner_scorecard`: family-experience average, completion rate (outcomes loop) and admit rate, each blended toward the prior with `TRACK_RECORD_PRIOR_CASES` (5) prior cases, then combined per `TRACK_RECORD_BLEND`: 60% family experience, 25% completion, 15% admit rate. A program with no decided cases scores exactly half (7.5). |

The parts sum to the total; the maximum is `MAX_SCORE` (100). Components are
rounded to one decimal.

About the track-record prior: with k = 5 and the network average as the
prior, one 5-star review cannot outrank twenty 4.6-star reviews as long as the
network itself averages under about 4.5 stars (the test uses a network near
4.1). If a whole network really averages above 4.5, a 4.6 program is merely
average there, and a single 5-star can edge it. Raise `TRACK_RECORD_PRIOR_CASES`
to make small samples count for less.

The outcomes loop (`docs/OUTCOMES.md`) adds two things here:

- **Completion joins the blend.** `completionRate` is completed placements
  over decided placements (admitted referrals whose "completed" answer is
  known either way). It is shrunk toward the prior with the same k, weighted
  by decided placements rather than decided cases, so a program with
  admissions but no completion answers yet sits exactly on the prior. The
  weights live in `TRACK_RECORD_BLEND` (experience 0.6, completion 0.25,
  admit rate 0.15); they sum to one, so the component can never exceed 15.
- **The network as the prior for thin history.** When this workspace has
  fewer than `TRACK_RECORD_PRIOR_CASES` decided cases with a program and the
  directory discloses network figures for its listing (five distinct
  referring workspaces; see `fetch_global_partner_stats`), those figures
  replace the workspace averages as that program's prior, signal by signal
  (`priorForCard`). A figure the directory withheld falls back to the
  workspace average. With five or more local cases the network figure is not
  consulted. The figures ride along on `PartnerScorecard.network`, loaded
  best-effort with the snapshot; without the directory plan, or offline,
  ranking simply uses local history.

### Step 3: ties

1. Lower cost to the family wins: for cash pay the monthly cost, for insurance
   in-network before out-of-network.
2. Remaining ties rotate in an order seeded by the match profile id
   (`rotationKey`, FNV-1a over profile id + partner id). The same family
   always sees the same order; the next family sees a different one.

No reciprocity anywhere. `rankPrograms` and `scoreProgram` never read
`inbound`, `outbound`, or `financialRelationship` for ordering;
`scripts/mutation-test.mjs` greps for that, and `scripts/matching-test.mjs`
permutes the counts over random fixtures and asserts the order is identical.

## The placement record

When a program is assigned from a match (either the "Assign & refer" form or
sending a packet), the app writes one `placement_decisions` row after the
assignment succeeds:

- `match_profile_id`, `case_id` (when linked), `referral_id`
- `candidates`: the top five shown, each with rank, total, the four
  components, and whether a disclosure applied
- `chosen_partner_id`, `chosen_rank` (one past the end when the pick was not
  on the list)
- `reason` (required when the rank is above 1): family preference, bed
  availability, clinical judgment, or other with a short note
- `weights`: the constants in force at the time

The table is org-scoped with RLS and append-only: the client can insert and
read, never update or delete. The reason prompt appears in both assign flows;
saving is blocked until a reason is chosen.

## The disclosure

`partners.financial_relationship` (none, consulting fee, marketing agreement,
speaking fee, shared ownership, other) plus an optional note, edited in the
partner form. It shows as a badge on match cards and partner cards, is written
into every family and partner packet automatically, and choosing such a
program in either assign flow asks for one more confirmation tap.

It never affects ranking (tested), it is private to the workspace, and it is
never published: `partner_never_published_fields()` names the two columns and
pgTAP asserts they overlap no synced, pushed, or profile field list and that
`global_partners` has no such column.

Packet wording (needs healthcare counsel review): "Disclosure: our practice
has a financial relationship with this program (consulting fee). It played no
part in this recommendation, which is based on fit alone. You are free to
choose any program."

## Language

Referral counts stay as data (`partner_balances`, `inbound`, `outbound`).
What families and clinicians read is neutral activity: "Last referral Aug 12
· 4 received · 2 sent". No "to return", "balanced", or "tie-breaker" copy
remains; stay-in-touch cadence reminders are unchanged.

## Migration `supabase/migrations/20261001130000_matching_integrity.sql`

Adds `partners.financial_relationship` / `financial_relationship_note` with
checks, `partner_never_published_fields()`, `match_profiles.must_have_therapies`
(nullable: NULL means saved before this change), `population`,
`location_preference` with checks, the `placement_decisions` table with its
org trigger, RLS (select + insert), grants and indexes, and a
`save_match_with_case` that carries the new columns. Deletes nothing.

Transit check (comment lines removed): 0 backslashes, 0 non-ASCII characters,
29 statements, longest 2,527 characters.

### Apply

1. Paste the migration into the SQL editor and run it.
2. Record it:

```sql
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('20261001130000', 'matching_integrity');
```

3. Verify:

```sql
SELECT column_name, column_default FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'partners' AND column_name LIKE 'financial%';

SELECT count(*) AS never_published_columns_in_directory FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'global_partners'
   AND column_name = ANY (public.partner_never_published_fields());

SELECT polname, polcmd FROM pg_policy WHERE polrelid = 'public.placement_decisions'::regclass ORDER BY polname;
```

Expected: two `financial_` columns (defaults `'none'` and `''`), a count of
`0`, and two policies (`r` for read, `a` for insert).
