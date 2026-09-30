# Directory submissions: from a practice's list to the shared directory

Migration `20260930120000_directory_submissions.sql` gives every practice a
real path into the shared directory, with ReferralFit (a platform admin)
approving each listing first.

Product rule (Matt Brown, 2026-09-30): a partner can be sent to the admin
only when **all** of its information is filled in. Until then it is simply
saved to the practice's own list. Saving is never blocked. The same day:
"Let's add categories for therapists and interventionists" — so all six
partner types can be submitted, programs and individual professionals alike.

The platform seed workspace's auto-publish is unchanged: its treatment
**programs** still publish automatically (`docs/DIRECTORY_SEED_ROLLOUT.md`)
and are not subject to this rule. Its interventionists and therapists are
**not** published automatically; it submits them through this same flow (see
"The seed workspace" below). Workspace profiles and claims are unchanged too
(`docs/DIRECTORY_OWNERSHIP.md`).

## The rule

A partner is **directory-ready** when every line below holds.

| Field | Requirement |
| --- | --- |
| Organization name (`organization`) — program or practice | not blank |
| Contact person (`name`) | not blank |
| Partner type (`types`) | at least one of Inpatient, IOP / PHP, Sober Living, Detox, Interventionist, Therapist |
| City, State | not blank (the form's `—` placeholder counts as blank) |
| Phone | at least 10 digits |
| Email | looks like an address (`name@domain.tld`) |
| Website | not blank |
| Cost (`monthly_cost`) | greater than 0 |
| Insurance | at least one plan, **or** "Private pay only" |

Therapies, populations, levels, regions, and notes stay optional.

Things worth knowing:

- An untyped partner is not ready. The partner form always requires a type,
  so this only affects older or imported rows; opening and saving the
  partner fixes it.
- "Private pay only" is a checkbox in the partner form, shown when no
  insurance plan is selected — the usual answer for an interventionist. It
  is stored as the existing `Cash pay` insurance entry, which the rest of
  the app already treats as "no plan".
- Cost is one column for everyone. For a partner whose types are all
  Interventionist / Therapist the app labels it **Typical fee** (form,
  partner detail, review queue, and directory cards, which show
  "$7,500 typical fee" instead of "$7,500/mo"); otherwise **Monthly cash
  cost**. No new column; matching still compares the number to a budget as
  before.
- **Private notes are never published.** A partner's relationship note
  (`partners.note`) stays in the practice's workspace. A submitted listing
  starts with an empty public description (`global_partners.description`);
  a platform admin, or the program once it claims the listing, can write one
  later. The submitter's partner also records `note` in `local_overrides`,
  so a later description edit never replaces their private note.
- A submitted listing is never owned by the practice that submitted it
  (`owner_org_id` stays NULL, not "claimed"). A practice's *own* verified
  profile is the separate Workspace → *Your directory profile* path.

The rule lives in two places that must stay in lockstep:

- SQL (the authority): `directory_missing_fields(...)`,
  `partner_directory_missing_fields(partner)`,
  `directory_submission_field_labels()`, `directory_missing_fields_message(text[])`.
  `suggest_global_listing` raises `22023` with a sentence such as
  *"Add email and cost to submit this partner to the shared directory."*
- TypeScript (what the app shows): `src/lib/directory-submission.ts`.

`scripts/directory-submission-test.mjs` (part of `npm test`) reads the
migration and fails when the field keys or labels drift apart.

## What a practice sees

Partner detail → **Shared directory**:

| State | Shown |
| --- | --- |
| Not ready | "Saved to your list only" and the specific fields to add. No submit button. |
| Ready | "Submit to directory", with a line saying ReferralFit reviews it first. |
| Submitted | "Pending review". |
| Approved | "In the shared directory". |
| Not approved | "Not added to the directory", the reviewer's note, and "Submit again" once it is ready. |

If the program or professional is already in the directory (same phone
digits or website domain), submitting links the partner to the existing
listing instead of creating a duplicate — same as before.

Approved interventionists and therapists are found in the Directory screen
under its existing **Interventionists** and **Therapists** filter pills
(`search_global_partners` `p_types`), next to **Programs** and **All**.

## The seed workspace

- Programs added in the platform seed workspace still publish on their own,
  active and verified, complete or not. Nothing about that changed.
- Interventionist / Therapist partners in the seed workspace are **never**
  published by a trigger and this migration publishes none of them. To list
  one: fill in the required fields, tap **Submit to directory** in partner
  detail, then approve it in Workspace → **Review submissions**.
- One trigger branch changed to make that hold. `partners_seed_publish` used
  to unlink a linked seed partner and retire its listing on *any* edit while
  the partner was not a program. That was meant for "this edit just stopped
  it being a program", but it would also have archived an approved
  interventionist the first time its phone number was corrected. The branch
  now runs only when the edit itself turns a program into a non-program.
  Edits to an already-listed professional in the seed workspace flow up to
  the listing, the same way program edits do.

Submitting does not require the `directory` entitlement (that was already
the server's rule); browsing and importing still do.

## Reviewing submissions (Matt, in the app)

1. Open **Workspace**. Platform admins see a **Directory submissions** card
   with the number waiting. Nobody else sees it, and the server refuses the
   queue to anyone who is not in `platform_admins`.
2. Tap **Review submissions**. Each card leads with the type(s) — Inpatient,
   Interventionist, Therapist, and so on — then the organization, contact,
   phone, email, website, city/state, cost, insurance, which practice
   submitted it, and when. Oldest first. The practice's private notes are
   not part of a submission, so there is normally no description to read.
3. **Approve** → the listing becomes `active` and verified, and the
   submitter's partner shows "In the shared directory".
4. **Reject** → optionally type a note for the practice, then **Reject
   submission**. Their partner stays in their own list, unlinked, with your
   note.

### What "rejected" means in the data

- Every partner linked to the listing is unlinked (`global_partner_id` NULL)
  and gets `directory_rejected_at` + `directory_review_note`. Nothing in the
  practice's list is deleted or changed otherwise.
- The listing is **archived**, not deleted, with `reviewed_by`,
  `reviewed_at`, and `review_note`. Archived listings are ignored by the
  phone/domain dedupe, so a rejected listing is never resurrected; a
  resubmission creates a fresh pending listing. Archived-and-unlinked is the
  same terminal state `retire_orphaned_global_listing` already produces, and
  `cleanup_unlinked_global_partners()` removes such rows if you ever run that
  maintenance sweep.
- On approval no note is stored: an active listing is readable by every
  directory workspace.

### Reviewing without the app (SQL editor fallback)

`review_global_listing` needs a signed-in platform admin, so in the SQL
editor you act as yourself for one transaction. Replace the email and id.

```sql
-- The queue
SELECT id, organization, name, city, state, created_at
  FROM public.global_partners
 WHERE status = 'pending'
 ORDER BY created_at;

-- Approve (true) or reject (false, with an optional note)
BEGIN;
SELECT set_config('request.jwt.claim.sub',
                  (SELECT id::text FROM auth.users WHERE email = 'you@example.com'), true);
SELECT public.review_global_listing('00000000-0000-0000-0000-000000000000', true);
-- SELECT public.review_global_listing('00000000-0000-0000-0000-000000000000', false, 'Please confirm the admissions phone number.');
COMMIT;
```

## Apply the migration

The migration is `supabase/migrations/20260930120000_directory_submissions.sql`.
It adds nullable/defaulted columns and functions, and replaces two existing
functions (`suggest_global_listing`, `partners_seed_publish`); no existing
row is rewritten, nothing is published, and nothing is deleted. It is safe to apply before the app build
that contains the new screens ships (the current build never calls
`suggest_global_listing`).

1. Supabase → **SQL Editor** → paste the whole file → Run. It is wrapped in
   `BEGIN … COMMIT`, so it applies atomically.
2. Record it so `supabase db push` and CI agree with production:

   ```sql
   INSERT INTO supabase_migrations.schema_migrations (version, name)
   VALUES ('20260930120000', 'directory_submissions');
   ```

## Verify

```sql
-- 1. The RPCs exist, anon cannot run them, signed-in users can.
SELECT p.oid::regprocedure AS fn,
       has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_can_run,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_run
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('suggest_global_listing', 'list_pending_global_listings', 'review_global_listing')
 ORDER BY 1;
-- expected: 3 rows, anon_can_run = false, authenticated_can_run = true

-- 2. The rule answers in plain language.
SELECT public.directory_missing_fields_message(
         public.directory_missing_fields('Example Program', 'Front Desk', ARRAY['Inpatient'],
                                         'Bend', 'OR', '(541) 555-0100', '', 'example.org', 0, ARRAY['Cash pay'], '{}'::jsonb));
-- expected: Add email and cost to submit this partner to the shared directory.

-- 3. The new columns exist and nothing was marked rejected by the migration.
--    pending_with_description should be 0; if not, see "Known limits".
SELECT count(*) FILTER (WHERE directory_rejected_at IS NOT NULL) AS rejected_partners,
       (SELECT count(*) FROM public.global_partners WHERE status = 'pending') AS pending_listings,
       (SELECT count(*) FROM public.global_partners WHERE status = 'pending' AND description <> '') AS pending_with_description
  FROM public.partners;
-- expected: rejected_partners = 0; pending_listings = whatever was pending before
```

End-to-end check on a device (needs the app build that includes this
change): in an ordinary practice, open a partner with a field missing and
confirm it says "Saved to your list only"; fill everything in, tap **Submit
to directory**, and confirm "Pending review"; then sign in as the platform
admin, open Workspace → **Review submissions**, and approve or reject it.
Repeat once with an interventionist and confirm it appears under the
Directory's **Interventionists** filter after approval.

## Known limits

- The pending listing is a snapshot taken when the partner is submitted.
  Edits the practice makes while it is pending stay in their own copy; to
  send corrected details they resubmit after a rejection. (The seed
  workspace is the exception: its edits to a linked, unclaimed listing flow
  up, pending or not.)
- Listings that were already `pending` before this migration appear in the
  queue as they are. If one lacks required fields the card says "Still
  missing: …"; approving is still your call. The old
  `suggest_global_listing` also copied the partner's note into the listing's
  description, so if a card shows **Public description**, read it before
  approving — it would be shown to everyone. Clear it first with
  `UPDATE public.global_partners SET description = '' WHERE id = '…';`
  (No app screen ever called the old function, so there should be none.)
- The seed workspace is different by earlier design: auto-publishing a
  program copies that partner's note into the public description, and note
  edits on a linked, unclaimed seed partner flow up to the listing. That
  includes interventionists and therapists the seed workspace submits: the
  listing starts with no description, but a later edit to the note in the
  seed workspace becomes the public description. Not changed here.
- A pending listing that someone has claimed (center account or workspace
  profile) cannot be rejected from the queue; use the claim tools in
  `docs/DIRECTORY_OWNERSHIP.md`.
- The existing anti-hijack rule lets a workspace take over an **unclaimed**
  listing it suggested when it later builds its own profile with the same
  phone or website (`docs/DIRECTORY_OWNERSHIP.md`). That rule is unchanged,
  and it now also covers third-party professionals a practice submitted.
- The ranked-match budget check treats the cost number the same way for
  every type; "Typical fee" is wording only.
- The practice is not notified when a review happens; they see the outcome
  the next time the app refreshes their partners.
- The App Review demo account's sample partners are complete, so a reviewer
  can submit them. Those would land in the queue as `example.com` listings;
  reject them.
