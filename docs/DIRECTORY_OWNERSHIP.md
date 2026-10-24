# Directory ownership: claimed listings and workspace profiles

Migration: `supabase/migrations/20260928170000_claimed_listings_authoritative.sql`,
amended by `supabase/migrations/20261024120000_directory_membership_hardening.sql`
(no automatic takeovers; every duplicate goes to admin review).
Tests: `supabase/tests/claimed_listings_authoritative_test.sql`,
`supabase/tests/directory_membership_hardening_test.sql`.

Product rule (Matt, 2026-09-28): *once a listing has been claimed by a
professional, that becomes authoritative, regardless of who created it*, and
*every new user can build a verified profile for themselves as they start to
use the app*.

How a practice gets one of its *partners* — a program, an interventionist,
or a therapist it works with — into the directory (complete the required
fields, submit, admin review) is a separate flow: see
`docs/DIRECTORY_SUBMISSIONS.md`. A submitted listing is never owned by the
practice that submitted it.

## The model

Every directory listing (`global_partners`) is in exactly one ownership state.

| State | How it happens | Who edits it | Verification |
| --- | --- | --- | --- |
| **Platform** | Hand-curated, or auto-published from the seed workspace (`docs/DIRECTORY_SEED_ROLLOUT.md`). | Platform admins; the seed workspace's edits push up. | Admin-controlled. Any other non-admin edit clears `verified_at` for review. |
| **Center** | A program claims it in the center portal with an admin-issued claim code (`center_members` row). | The center account, in the portal. | Claiming stamps `verified_at` if it was empty. Every center edit re-stamps it `now()`. |
| **Org** | A ReferralFit workspace built it as its own profile (no duplicate existed), or a platform admin granted the workspace's claim request (`owner_org_id`). One per workspace. | The workspace **owner**, in the app (Workspace → Your directory profile). | Created live + verified. Every owner edit re-stamps `verified_at`. |

"Claimed" = center **or** org (`public.global_listing_is_claimed(id)`).
`public.global_listing_claimed_by_caller(id)` answers whether the signed-in
user is that listing's center member or a member of the owning workspace.

## Authority rules

1. **A claimed listing keeps its verification.** `guard_global_partner_verification`
   still pins `status` for every non-admin write, but a claimant's write sets
   `verified_at = now()` instead of clearing it. Non-claimant non-admin writes
   still clear it (nothing else can reach those rows anyway).
2. **The seed workspace stops pushing into a claimed listing.**
   `push_seed_partner_fields` returns early for claimed listings;
   `partners_seed_publish` does not push or unlink-on-type-change for them;
   `track_partner_local_overrides` records seed-org edits as
   `local_overrides` when the listing is claimed. The seed workspace becomes a
   tenant like any other for that listing. Publishing a new seed program that
   matches a claimed listing links the seed copy (one per workspace) without
   pushing its fields up.
3. **Claimant edits flow down.** The existing `propagate_global_partner_changes`
   trigger copies the claimant's edits to every linked `partners` row —
   including the seed workspace's copy — skipping fields each workspace
   overrode locally.
4. **Claimed listings are never retired.** `retire_orphaned_global_listing`
   and `cleanup_unlinked_global_partners` skip any listing with a center
   member, an owner workspace, or an open claim request.
5. **Status stays admin-controlled.** Claiming does not activate a `pending`
   listing; the org-profile paths (create, approval) do set
   `status = 'active'` because the owner is attesting their own practice.

## Workspace profiles (self-serve)

`public.upsert_org_directory_profile(p_payload jsonb)` — SECURITY DEFINER,
caller must be the `owner` of `current_org_id()`. Accepts **only** these keys
(anything else is rejected with `22023`): `name, organization, types, city,
state, regions, phone, email, website, monthly_cost, insurance,
insurance_networks, therapies, populations, levels, description`. The client
list in `src/lib/directory.ts` is asserted equal to the database list by
`scripts/store-account-test.mjs`.

`types` may include `Interventionist` and `Therapist`; `partner_is_directory_program()`
is untouched (it only governs the seed auto-publish path) and
`search_global_partners` returns any active listing, so professionals are
searchable. The search RPC gained an optional `p_types text[]` overlap filter
(appended last; positional callers unaffected) and a `claimed boolean` output
column.

Return value: `{"status": ..., "listing_id": ..., ...}`. The review
statuses also carry a `message` the app can show as is.

| `status` | Extra keys | Meaning |
| --- | --- | --- |
| `created` | | No duplicate; a new active, verified listing owned by the workspace. |
| `updated` | | The workspace already owned a listing; it was updated and re-verified. Status untouched. |
| `updated_pending_review` | `review_id`, `held_fields` (any of `"name"`, `"phone"`, `"website"`), `message` | Updated, but a changed identity group matches **another** listing. Only the colliding group keeps its live value (`name` = organization + contact name together, `phone`, `website`); everything else in the save, including the other groups, landed. An `identity_edit` review request holds exactly the groups in `held_fields`. |
| `conflict` | `review_id`, `message` | Either the phone/website duplicate is **owned by another workspace** (a claim could never be approved), or there is no phone/website duplicate but another non-archived listing has the **same name** (`directory_name_key`). The caller's profile is created owned but `pending` (hidden from the directory) with a `profile_conflict` review request. Saving again returns `conflict` while the review is open. `listing_id` is the caller's own new profile. |
| `merged` | `merged_into`, `message` | The workspace's profile was merged into another listing by an admin (`merged_into` set). Nothing is saved and it is not resubmitted. |
| `resubmitted_for_review` | `review_id`, `message` | The workspace saved its own profile while it was **archived** (for example after an admin declined a conflict). The save lands, the profile goes back to `pending` (hidden) and a `resubmitted_profile` review request is filed. Later saves return `resubmitted_for_review` while it is open. Before 2026-10-24 an archived profile returned `updated` and stayed archived forever. |
| `claim_requested` | `request_id`, `message` | A duplicate exists that no workspace owns (it may be center-claimed). A `center_claim_requests` row was recorded (or the open one returned). **Nothing on the listing changed**; a platform admin decides. `listing_id` is returned only when the caller may see that listing (it is active, or the caller's workspace submitted or created it); otherwise it is `null`. |

Messages, verbatim:

- `updated_pending_review`: built from `held_fields`, for example "Your other changes are live. The new name matches another directory listing, so ReferralFit will review that change first. Until then your current name stays up." or "Your other changes are live. The new name and phone number match another directory listing, so ReferralFit will review those changes first. Until then your current name and phone number stay up."
- `merged`: "ReferralFit merged this profile into another directory listing, so it cannot be sent for review again. Contact ReferralFit to manage the combined listing."
- `conflict` (first save, phone/website owned elsewhere): "Another practice already manages a directory listing with this phone number or website. Your profile is saved and ReferralFit will review it before it appears in the directory."
- `conflict` (first save, same name): "Another directory listing already uses this name. Your profile is saved and ReferralFit will review it before it appears in the directory."
- `conflict` and `resubmitted_for_review` (later saves): "Your profile is saved and waits for ReferralFit to review it before it appears in the directory."
- `resubmitted_for_review` (first save): "Your profile was not approved for the directory earlier. It is saved and sent to ReferralFit for review again, and it stays hidden until then."
- `claim_requested`: "A directory listing with this phone number or website already exists. ReferralFit will review your request to manage it; nothing changes until then."

`claimed` (automatic takeover) was removed on 2026-10-24. Older app builds
that still know the word simply never receive it.

### Anti-hijack rule

There is **no automatic takeover**. Whenever a duplicate exists, whoever
created or submitted it, the profile save changes nothing on that listing.
If no workspace owns it, a claim request is filed for a platform admin
(`approve_center_claim_request`); if another workspace owns it, the
caller's profile is saved pending with a `profile_conflict` review instead,
because that claim could never be approved.

Until 2026-10-24 three signals handed an unclaimed duplicate over on the
spot: the caller's workspace had submitted it (`suggested_by_org_id`), the
caller had created it (`created_by`), or the domain of the caller's sign-in
email matched its website. None of them proves the caller *is* that
program: practices submit listings for third-party programs they refer to,
and sign-in emails are not confirmed. They are now only **hints** written
into the request's `note` for the reviewer, for example
`[submitted by this workspace; created by this user]` or
`[sign-in email domain matches the website (unverified)]`.

Re-submitting returns the same open request (one pending request per
workspace per listing). A workspace never has more than one profile
(`global_partners_owner_org_unique`).

### Claimant identity edits that collide

A claimant (the owning workspace, through the profile RPC, or a center
account, through its direct update) can change its listing's organization,
contact name, phone or website. If the new organization/name key, phone
digits or website domain is **already used by another non-archived
listing**, the trigger `global_partners_hold_colliding_edits` keeps the
live value of **that group only** (organization + contact name together,
phone, or website), merges it into the listing's open `identity_edit`
review request (`proposed` holds exactly the held groups), and lets
everything else through, including the other identity groups. Nothing held
propagates to linked partners until an admin approves; declining never
undoes what already went live. Changing a held group again to a value that
collides with nothing puts it live and takes it out of the request (an
emptied request is withdrawn). After every claimant write, `collisions`,
`note` and `related_listing_id` describe only what is still held;
`related_listing_id` is the listing the first held group (name, then
phone, then website) collides with.

The app and the portal show the **live** values in their forms, so a field
sent back unchanged is not a change. Within a held name group this means
the untouched field keeps its held value: editing only the contact name
while a rename is held keeps the rename and holds the new contact name with
it (one group, reviewed together). Sending a group back at its live value
does not withdraw a held change; changing it to another non-colliding value
does.
Platform admins, service code and the SQL editor are never held.

The held name is not searchable either: the trigger rebuilds `search_tsv`
from the live values it keeps.

This closes the "rename your claimed listing to a competitor and copy its
phone" path.

Matching uses one normalization everywhere (`directory_phone_digits`,
`directory_website_domain`, which also fill the stored `phone_digits` /
`website_domain` columns; existing rows were re-normalized by the
migration): phone = digits only, an 11-digit number starting with 1 drops
the 1 (so "+1 541 555 0100" matches "541-555-0100"); website = host only,
lowercased, without the scheme (any case), a leading `www.`, the port, path,
query or fragment. Suggestions never auto-link to a claimed listing at all
(`docs/DIRECTORY_SUBMISSIONS.md`).

### Joining a team

When a solo owner accepts a team invite (`accept_org_invite`), their
workspace's directory state moves with them:

- their profile (`owner_org_id`) becomes the team's when the team has
  none; when the team already owns one, the joiner's profile is left
  **live and unowned** and an `orphaned_profile` review request (visible
  to the team) asks the admin to keep or archive it. A profile ReferralFit
  merged into another listing (`merged_into`) is only released (unowned,
  still archived, nothing queued), so the team can still create its own;
- listings they submitted (`suggested_by_org_id`) count as the team's;
- their pending claim requests move to the team (a duplicate of one the
  team already has is dropped);
- their `org_entitlements` merge into the team's (active if either is, the
  later expiry, no expiry when an active row had none).

### The workspace's own partner network

Building a profile does **not** insert a `partners` row for the workspace
itself; the profile is separate from the referral network. If a partner in
the workspace already links to the listing (for example the seed workspace's
copy of Matt's own practice, published by `20260928120000`), the link is
kept: it is now an ordinary linked copy, owner edits flow to it, and the
workspace's local edits to that copy become local overrides. Nothing is
unlinked automatically.

### Reading

Owners read their own listing regardless of status through the RLS policy
`global_partners: org owner read own`. Members of the requesting workspace
(and platform admins) read `center_claim_requests`. Nothing else changed for
readers; `search_global_partners` still shows active listings only.

## Reviewing review requests (Matt, SQL editor)

Identity edits, profile conflicts and orphaned profiles wait in
`directory_review_requests`:

```sql
SELECT * FROM public.list_directory_review_requests();
SELECT public.resolve_directory_review_request('<id>', true);   -- approve
SELECT public.resolve_directory_review_request('<id>', false);  -- decline
```

| kind | approve | decline |
| --- | --- | --- |
| `identity_edit` | applies `proposed` (only the held groups) | nothing changes |
| `profile_conflict` | the pending profile goes live and verified | the pending profile is archived |
| `resubmitted_profile` | the profile goes live and verified | the profile is archived again |
| `orphaned_profile` | the listing stays live and unowned | the listing is archived |

A `resubmitted_profile` row names what the profile still collides with, if
anything: `collisions` and `related_listing_id` (same phone, website or
name as another non-archived listing) and a sentence in `note`.

A listing merged into another (`merge_global_partners` sets `merged_into`)
is never made live again: approving a `profile_conflict` or
`resubmitted_profile` for it fails with "This listing was merged into
another; decline the request instead".

The requesting workspace (and, for a center, the requesting account) can
read its own rows to show "under review".

## Reviewing claim requests (Matt, SQL editor)

List what is pending:

```sql
SELECT r.id, r.created_at, r.note, o.name AS workspace, u.email AS requested_by,
       g.organization AS listing, g.website, g.phone,
       CASE WHEN g.owner_org_id IS NOT NULL THEN 'org' WHEN c.user_id IS NOT NULL THEN 'center' ELSE 'unclaimed' END AS currently
  FROM public.center_claim_requests r
  JOIN public.orgs o ON o.id = r.org_id
  LEFT JOIN auth.users u ON u.id = r.requested_by
  JOIN public.global_partners g ON g.id = r.global_partner_id
  LEFT JOIN public.center_members c ON c.global_partner_id = g.id
 WHERE r.status = 'pending'
 ORDER BY r.created_at;
```

`r.payload` holds what the workspace tried to publish, for context, and
`r.note` carries the reviewer hints described under *Anti-hijack rule*
(none of them is proof). Approval does **not** apply the payload; the
workspace edits the listing afterwards.

Approve (hands the listing to the workspace, sets it active + verified):

```sql
SELECT public.approve_center_claim_request('<request id>');
```

Fails with a clear message when the listing already belongs to another
workspace, the requesting workspace already owns a different listing, or
(since 20261024120000) the listing was merged into another ("This listing
was merged into another; reject the claim instead"). A center account may
remain attached to the same listing; both are claimants.

Reject:

```sql
SELECT public.reject_center_claim_request('<request id>');
```

The workspace sees the outcome the next time it opens Workspace (the pending
banner disappears; after approval the profile card shows the listing).

## Rollout

Nothing to prepare: the migration is a single transaction, idempotent, and
only backfills `verified_at` on listings that already have a center claim.

1. From a checkout linked to production, `supabase db push`; **or** paste the
   full contents of
   `supabase/migrations/20260928170000_claimed_listings_authoritative.sql`
   into the SQL editor and run it once. The final `NOTICE` reports how many
   already-claimed listings were verified:

   ```
   claimed_listings_authoritative: verified N previously claimed listing(s)
   ```

2. If you pasted it by hand, record it so `supabase db push` does not replay it:

   ```sql
   INSERT INTO supabase_migrations.schema_migrations (version, name)
   VALUES ('20260928170000', 'claimed_listings_authoritative')
   ON CONFLICT DO NOTHING;
   ```

3. Verify:

   ```sql
   SELECT count(*) FROM public.global_partners WHERE owner_org_id IS NOT NULL;   -- profiles
   SELECT count(*) FROM public.center_claim_requests WHERE status = 'pending';  -- awaiting you
   SELECT proname FROM pg_proc WHERE proname IN ('upsert_org_directory_profile', 'approve_center_claim_request', 'global_listing_is_claimed');
   ```

4. Ship the app build that includes the Workspace profile card; older builds
   keep working (the search RPC's new parameter is optional and its new
   column is ignored).

## Known limits

- The app's profile form has no pickers for `levels` or `populations`; it
  sends `levels = types` and keeps existing `populations` (default `Adults`),
  exactly like the partner form.
- Every duplicate needs an admin decision, including a listing the
  practice itself submitted earlier through the partner flow. Expect more
  claim requests in the queue than before 2026-10-24.
- A claimed listing can still be renamed to a program that is **not** in
  the directory yet; nothing can detect that. It no longer captures other
  practices' partners (suggestions never link to claimed listings), and the
  real program's own profile then lands as a `conflict` for the admin.
- **Existence oracle.** The status alone (`claim_requested` / `conflict`)
  tells the caller that *some* listing uses a phone number, website or name
  they typed, even when `listing_id` is withheld. Nothing about that
  listing is returned, and each probe files a request the admin can see,
  but a determined owner can learn that a phone number is listed. Accepted
  as is (2026-10-24).
- Approving a claim request does not apply the submitted payload.
