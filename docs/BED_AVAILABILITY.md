# Bed availability: live, gender-specific bed counts

Roadmap feature 3. Matt's words: "make it gender specific: 3 male beds,
1 female bed". A program tells the network what is open today, for men and
for women; interventionists see it on the directory card and in match
results, and can ask the ranker for a program that has a bed.

Migration: `supabase/migrations/20261001150000_bed_availability.sql`.
Client: `src/lib/beds.ts` (pure helpers), `src/lib/matching.ts` (the
filter), `src/lib/ListingBedsEditor.tsx` (admin editor), `portal/src/App.tsx`
(the program's card). Tests: `supabase/tests/bed_availability_test.sql`,
`scripts/bed-availability-test.mjs`.

## The rule

- **Two counts per listing**, `beds_male` and `beds_female`, on
  `global_partners`. `NULL` = unknown (the program has not said), `0` =
  full. There is no third population count (see "Decisions" in the PR).
- **Only programs carry beds**: Inpatient, IOP / PHP, Sober Living, Detox
  (`listing_carries_beds`). Individual professionals never show the fields
  and the RPC refuses them (22023).
- **Beds live on the listing only.** They are never copied into a tenant's
  `partners` row, never part of any synced, pushed, or profile field list,
  and never touch verification. Tenants read them live through the
  directory and matching.
- **Seven days.** `bed_stale_days()` returns 7, mirrored by
  `BED_STALE_DAYS` in `src/lib/beds.ts` (the node test holds the two
  equal). A count confirmed more than seven days ago is **Unconfirmed**: it
  is never shown as a number. Every read RPC returns `beds_stale` so no
  client has to work it out; the client mirror exists only for rows read
  without the flag.
- **On-call admissions contact** (`admissions_contact_name`,
  `admissions_contact_phone`), optional, set with the counts.

## Who can set it

`set_listing_beds(p_global_id, p_beds_male, p_beds_female, p_contact_name,
p_contact_phone)` is the only write path.

| Caller | Result |
| --- | --- |
| A claimant of the listing: its center account (`center_members`) or a member of the workspace that owns it as its profile (`owner_org_id`) | allowed, from the Center Portal |
| A platform admin (`is_platform_admin()`) | allowed, from the app's Directory card ("Update beds") |
| Anyone else, including a workspace that imported or favorited the listing | 42501 |
| Nobody signed in | 28000 |
| Any caller, on a listing that is not a program | 22023 |
| Counts outside 0..999 | 22023 |

Direct writes to the bed columns are refused twice over: the column-level
`UPDATE` grant from 20260820033721 does not include them, and
`guard_global_partner_beds` raises 42501 for any signed-in caller outside
the RPC. The RPC sets the transaction-local `referralfit.seed_publish` flag
around its `UPDATE`, so `guard_global_partner_verification` leaves
`verified_at` exactly as it was, and `propagate_global_partner_changes`
never sees a bed column, so no tenant copy changes.

Every call writes one row to `listing_bed_updates` (listing, time, both
counts, who). That table is Matt's audit trail. It is readable by platform
admins and by the listing's own claimants, and by nobody else; no client
role can write it.

## Staleness and the two filters

**Directory search** (`search_global_partners`, new optional `p_bed_for`
`'men' | 'women'`, appended last): a listing is dropped only when its count
for that gender is known and is either 0 or stale. Unknown stays. The RPC
also returns `beds_male`, `beds_female`, `beds_updated_at`, `beds_stale`,
`beds_cadence_days`, and the admissions contact.

**Match results** (`src/lib/matching.ts`, "Has a bed for: Men / Women /
Anyone"): a hard requirement when selected. A partner whose linked listing
confirms 0 for the requirement is hidden; a partner with no linked listing,
an unknown count, or an unconfirmed (stale) count is **not** hidden. Among
equal fit it sorts below a confirmed open bed (`compareBedAvailability`, a
tie-break between the score and family cost). The score itself never moves.
The match profile's population (Men / Women) pre-selects the filter when
the clinician turns it on; Adolescent and Any pre-select Anyone.

The two surfaces differ on purpose: a search filter is a question the user
asked ("show me programs with a bed for men"), so a stale count does not
qualify; match results are a ranking, where hiding a program for not having
updated would punish silence.

## Where it shows

- Directory card: `Beds today: 3 men, 1 woman, updated 2h ago` /
  `Beds today: Full, updated 2h ago` / `Beds today: Unconfirmed`. Nothing at
  all when the program has never confirmed a count. Below it, when earned:
  `Usually updates beds within N days`.
- Match card: the same line. Partner profile: a "Beds today" card with the
  admissions contact.
- Cadence badge: the ceiling of the mean gap between the last six updates
  (five gaps), at least 1 day; no badge with fewer than three updates.

## Push: `bed_opened`

When a call moves a gender's count from 0 or unknown to more than 0,
`notify_bed_followers` queues `bed_opened` for every member of a workspace
that favorited (`user_favorites`) or imported (`partners.global_partner_id`)
the listing, except the person who set it. The kind is **opt-in and off by
default** (`notification_preferences.bed_opened`); the copy is generic,
"A program you follow has a bed open today.", and the payload carries only
the listing id. Open -> still open, and anything -> 0, queue nothing.
Details in `NOTIFICATIONS.md`.

## Apply the migration

Adds nullable columns and two text columns with defaults, one table, one
trigger, and functions; replaces `notification_copy`, `notify_enqueue`, and
`search_global_partners` (new return type, so DROP + CREATE; the client
passes every parameter by name). Deletes nothing. The app build that reads
`bed_opened` tolerates a server without the column (it falls back to the
older column list), so order does not matter, but apply the migration
first so the Directory shows counts from day one.

The file is transit-safe for pasting from a chat client: no backslashes and
no non-ASCII characters anywhere, and every top-level statement is under
3,700 characters.

1. Supabase, **SQL Editor**, paste the whole file, Run. It is wrapped in
   `BEGIN ... COMMIT`, so it applies atomically.
2. Record it so `supabase db push` and CI agree with production:

   ```sql
   INSERT INTO supabase_migrations.schema_migrations (version, name)
   VALUES ('20261001150000', 'bed_availability');
   ```

3. Verify:

   ```sql
   SELECT public.bed_stale_days();
   -- 7

   SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'global_partners'
      AND column_name IN ('beds_male', 'beds_female', 'beds_updated_at', 'beds_updated_by', 'admissions_contact_name', 'admissions_contact_phone');
   -- 6

   SELECT proname FROM pg_proc WHERE proname IN ('set_listing_beds', 'fetch_listing_beds', 'notify_bed_followers', 'listing_bed_cadence_days') ORDER BY 1;
   -- 4 rows

   SELECT column_default FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'notification_preferences' AND column_name = 'bed_opened';
   -- false
   ```

## Center Portal

`portal/` is a static Vite SPA. The "Beds available today" card appears
under the status card for a claimed program listing: two steppers (men /
women), "Not set" per gender, "We are full today", the admissions contact,
"Confirm beds", the last-updated line, the cadence badge, and the last five
confirmations from the history table. **Hosting for the portal is still
unknown**: nothing in the repo deploys it, so until it is hosted the only
live path for setting beds is a platform admin in the app.
