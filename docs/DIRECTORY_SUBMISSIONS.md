# Directory submissions: from a practice's list to the shared directory

Migration `20260930120000_directory_submissions.sql` gives every practice a
real path into the shared directory, with ReferralFit (a platform admin)
approving each program first.

Product rule (Matt Brown, 2026-09-30): a program can be sent to the admin
only when **all** of its information is filled in. Until then it is simply
saved to the practice's own list. Saving is never blocked.

The platform seed workspace is unchanged: its programs still publish
automatically (`docs/DIRECTORY_SEED_ROLLOUT.md`) and are not subject to this
rule. Workspace profiles and claims are unchanged too
(`docs/DIRECTORY_OWNERSHIP.md`).

## The rule

A partner is **directory-ready** when every line below holds.

| Field | Requirement |
| --- | --- |
| Program name (`organization`) | not blank |
| Contact person (`name`) | not blank |
| Program type (`types`) | at least one of Inpatient, IOP / PHP, Sober Living, Detox |
| City, State | not blank (the form's `—` placeholder counts as blank) |
| Phone | at least 10 digits |
| Email | looks like an address (`name@domain.tld`) |
| Website | not blank |
| Monthly cost | greater than 0 |
| Insurance | at least one plan, **or** "Private pay only" |

Therapies, populations, levels, regions, and notes stay optional.

Two consequences worth knowing:

- An Interventionist- or Therapist-only partner cannot be submitted. The
  directory lists programs; individual professionals are listed through
  Workspace → *Your directory profile*.
- "Private pay only" is a checkbox in the partner form, shown when no
  insurance plan is selected. It is stored as the existing `Cash pay`
  insurance entry, which the rest of the app already treats as "no plan".

The rule lives in two places that must stay in lockstep:

- SQL (the authority): `directory_missing_fields(...)`,
  `partner_directory_missing_fields(partner)`,
  `directory_submission_field_labels()`, `directory_missing_fields_message(text[])`.
  `suggest_global_listing` raises `22023` with a sentence such as
  *"Add email and monthly cost to submit this program to the shared directory."*
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
| Not approved | "Not added to the directory", the reviewer's note, and "Submit again" once the program is ready. |

If the program is already in the directory (same phone digits or website
domain), submitting links the partner to the existing listing instead of
creating a duplicate — same as before.

Submitting does not require the `directory` entitlement (that was already
the server's rule); browsing and importing still do.

## Reviewing submissions (Matt, in the app)

1. Open **Workspace**. Platform admins see a **Directory submissions** card
   with the number waiting. Nobody else sees it, and the server refuses the
   queue to anyone who is not in `platform_admins`.
2. Tap **Review submissions**. Each card shows the program, contact, phone,
   email, website, city/state, types, monthly cost, insurance, which practice
   submitted it, and when. Oldest first.
3. **Approve** → the listing becomes `active` and verified, and the
   submitter's partner shows "In the shared directory".
4. **Reject** → optionally type a note for the practice, then **Reject
   submission**. Their program stays in their own list, unlinked, with your
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
It adds nullable/defaulted columns and functions only; no existing row is
rewritten and nothing is deleted. It is safe to apply before the app build
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
-- expected: Add email and monthly cost to submit this program to the shared directory.

-- 3. The new columns exist and nothing was marked rejected by the migration.
SELECT count(*) FILTER (WHERE directory_rejected_at IS NOT NULL) AS rejected_partners,
       (SELECT count(*) FROM public.global_partners WHERE status = 'pending') AS pending_listings
  FROM public.partners;
-- expected: rejected_partners = 0; pending_listings = whatever was pending before
```

End-to-end check on a device (needs the app build that includes this
change): in an ordinary practice, open a program with a field missing and
confirm it says "Saved to your list only"; fill everything in, tap **Submit
to directory**, and confirm "Pending review"; then sign in as the platform
admin, open Workspace → **Review submissions**, and approve or reject it.

## Known limits

- The pending listing is a snapshot taken when the program is submitted.
  Edits the practice makes while it is pending stay in their own copy; to
  send corrected details they resubmit after a rejection.
- Listings that were already `pending` before this migration appear in the
  queue as they are. If one lacks required fields the card says "Still
  missing: …"; approving is still your call.
- A pending listing that a program has claimed (center account or workspace
  profile) cannot be rejected from the queue; use the claim tools in
  `docs/DIRECTORY_OWNERSHIP.md`.
- The practice is not notified when a review happens; they see the outcome
  the next time the app refreshes their partners.
- The App Review demo account's sample programs are complete, so a reviewer
  can submit them. Those would land in the queue as `example.com` programs;
  reject them.
