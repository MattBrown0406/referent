# Directory ownership: claimed listings and workspace profiles

Migration: `supabase/migrations/20260928170000_claimed_listings_authoritative.sql`.
Tests: `supabase/tests/claimed_listings_authoritative_test.sql`.

Product rule (Matt, 2026-09-28): *once a listing has been claimed by a
professional, that becomes authoritative, regardless of who created it*, and
*every new user can build a verified profile for themselves as they start to
use the app*.

## The model

Every directory listing (`global_partners`) is in exactly one ownership state.

| State | How it happens | Who edits it | Verification |
| --- | --- | --- | --- |
| **Platform** | Hand-curated, or auto-published from the seed workspace (`docs/DIRECTORY_SEED_ROLLOUT.md`). | Platform admins; the seed workspace's edits push up. | Admin-controlled. Any other non-admin edit clears `verified_at` for review. |
| **Center** | A program claims it in the center portal with an admin-issued claim code (`center_members` row). | The center account, in the portal. | Claiming stamps `verified_at` if it was empty. Every center edit re-stamps it `now()`. |
| **Org** | A ReferralFit workspace built it as its own profile, took over a duplicate, or was granted a claim request (`owner_org_id`). One per workspace. | The workspace **owner**, in the app (Workspace → Your directory profile). | Created live + verified. Every owner edit re-stamps `verified_at`. |

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
   listing; the org-profile paths (create, takeover, approval) do set
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

Return value: `{"status": ..., "listing_id": ..., "request_id"?: ...}`.

| `status` | Meaning |
| --- | --- |
| `created` | No duplicate; a new active, verified listing owned by the workspace. |
| `updated` | The workspace already owned a listing; it was updated and re-verified. Status untouched (an admin-archived profile stays archived). |
| `claimed` | An **unclaimed** duplicate (same phone digits or website domain, like `suggest_global_listing`) was taken over automatically, updated with the payload, set active + verified, and owned. |
| `claim_requested` | A duplicate exists that the workspace may not take over automatically. A `center_claim_requests` row was recorded (or the existing open one returned). **Nothing on the listing changed.** |

### Anti-hijack rule

Automatic takeover of an unclaimed duplicate happens **only** when one of:

- the lowercased domain of the caller's auth email equals the listing's
  `website_domain` (and that domain is non-empty);
- the listing's `created_by` is the caller;
- the listing's `suggested_by_org_id` is the caller's workspace.

Any other match — and **always** when the duplicate is already claimed by a
center or owned by another workspace — goes to the claim-request path.
Re-submitting returns the same open request (one pending request per
workspace per listing). A workspace never has more than one profile
(`global_partners_owner_org_unique`).

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

`r.payload` holds what the workspace tried to publish, for context. Approval
does **not** apply it; the workspace edits the listing afterwards.

Approve (hands the listing to the workspace, sets it active + verified):

```sql
SELECT public.approve_center_claim_request('<request id>');
```

Fails with a clear message when the listing already belongs to another
workspace or the requesting workspace already owns a different listing. A
center account may remain attached to the same listing; both are claimants.

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
- Email-domain takeover compares against the listing's website domain only.
  A workspace whose owner signs in with a public mailbox (gmail etc.) always
  goes through the claim-request path when a duplicate exists.
- Approving a claim request does not apply the submitted payload.
