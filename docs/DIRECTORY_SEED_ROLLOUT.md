# Directory seed rollout

Migration `20260928120000_auto_publish_admin_directory.sql` turns the platform
owner's workspace into the verified seed of the shared directory:

- every treatment program in a **seed org** (a workspace whose owner is in
  `platform_admins`) is published as an `active`, verified `global_partners`
  listing, deduplicated by phone digits / website domain;
- edits to those programs flow to the listing and from there to every
  workspace that imported it (since `20260930190000` the relationship note
  is the exception: it never leaves the seed workspace, see "Seed notes are
  private" below);
- placeholder listings (rows nobody links to, nobody claimed, no claim code
  issued) are **deleted** the moment the migration runs, before the backfill.

Ordinary workspaces are untouched: their partners stay private unless they
suggest them, and suggestions still land as `pending`. (Since
`20260930120000_directory_submissions.sql` a suggestion must be complete and
is approved or rejected from the in-app review queue — see
`docs/DIRECTORY_SUBMISSIONS.md`. Seed auto-publish is not subject to that
rule, and still covers programs only: the seed workspace's interventionists
and therapists are submitted and approved through that same queue.)

The migration is idempotent. Re-running the cleanup and backfill functions
publishes and deletes nothing new.

All SQL below runs in the Supabase SQL editor (as `postgres`) or through
`supabase db push` from a linked checkout. Nothing here touches the app.

## 1. Make sure the owner is a platform admin

The seed rule keys off `platform_admins`. Check first, then insert only if
the row is missing. Replace the email once at the top.

```sql
-- Check
SELECT u.id, u.email, (a.user_id IS NOT NULL) AS is_platform_admin,
       m.org_id, m.role
  FROM auth.users u
  LEFT JOIN public.platform_admins a ON a.user_id = u.id
  LEFT JOIN public.org_members m ON m.user_id = u.id
 WHERE lower(u.email) = lower('matt@freedominterventions.com');
```

Expected: one row, `is_platform_admin = true`, `role = 'owner'`. If
`is_platform_admin` is `false`:

```sql
-- Add (no-op if already present)
INSERT INTO public.platform_admins (user_id)
SELECT id FROM auth.users WHERE lower(email) = lower('matt@freedominterventions.com')
ON CONFLICT (user_id) DO NOTHING;
```

If `role` is `member`, the workspace is not a seed org: the rule is
owner-only on purpose (an admin who accepts a colleague's invite must not
publish that colleague's network). Fix ownership before applying.

## 2. Preview what the migration will do

Run this **before** applying. It lists the placeholder listings the cleanup
would delete and the seed-org partners the backfill would publish, without
changing anything.

```sql
-- 2a. Placeholder listings that will be DELETED
SELECT g.id, g.organization, g.name, g.status, g.phone, g.website, g.created_at
  FROM public.global_partners g
 WHERE NOT EXISTS (SELECT 1 FROM public.partners p WHERE p.global_partner_id = g.id)
   AND NOT EXISTS (SELECT 1 FROM public.center_members c WHERE c.global_partner_id = g.id)
   AND NOT EXISTS (SELECT 1 FROM public.center_claim_codes k WHERE k.global_partner_id = g.id)
 ORDER BY g.organization, g.name;

-- 2b. Seed-org partners that will be PUBLISHED (or linked to an existing listing)
WITH seed_orgs AS (
  SELECT m.org_id
    FROM public.org_members m
    JOIN public.platform_admins a ON a.user_id = m.user_id
   WHERE m.role = 'owner'
)
SELECT p.id, p.organization, p.name, p.types, p.phone, p.website,
       CASE
         WHEN NOT (coalesce(cardinality(p.types), 0) = 0
                   OR p.types && ARRAY['Inpatient','IOP / PHP','Sober Living','Detox']::text[])
           THEN 'skip: not a program'
         WHEN length(btrim(p.name)) = 0 THEN 'skip: blank name'
         WHEN g.id IS NOT NULL THEN 'link to existing: ' || g.organization || ' (' || g.status || ')'
         ELSE 'new active listing'
       END AS outcome
  FROM public.partners p
  JOIN seed_orgs s ON s.org_id = p.org_id
  LEFT JOIN LATERAL (
    SELECT g.id, g.organization, g.status
      FROM public.global_partners g
     WHERE g.status <> 'archived'
       AND (
         (lower(regexp_replace(regexp_replace(coalesce(p.website, ''), '^\s*https?://', ''), '^(www\.)?([^/?#]+).*$', '\2')) <> ''
          AND g.website_domain = lower(regexp_replace(regexp_replace(coalesce(p.website, ''), '^\s*https?://', ''), '^(www\.)?([^/?#]+).*$', '\2')))
         OR (regexp_replace(coalesce(p.phone, ''), '\D', '', 'g') <> ''
             AND g.phone_digits = regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'))
       )
     ORDER BY (g.status = 'active') DESC, g.created_at
     LIMIT 1
  ) g ON true
 WHERE p.global_partner_id IS NULL
 ORDER BY outcome, p.organization, p.name;
```

Note that 2b runs against the directory *before* the cleanup, so a partner
shown as "link to existing" may end up as "new active listing" if that
existing row is a placeholder in 2a. Either way it is published.

If anything in 2a should survive, link it from a partner or issue a claim
code before applying; the cleanup only deletes rows with no references.

## 3. Apply

Preferred, from a checkout linked to the production project:

```sh
supabase db push
```

Or paste the full contents of
`supabase/migrations/20260928120000_auto_publish_admin_directory.sql` into
the SQL editor and run it once. It is a single transaction. The final
`NOTICE` reports the two counts:

```
auto_publish_admin_directory: deleted N placeholder listing(s), published M seed-org partner(s)
```

If you pasted it by hand, also record the migration so `supabase db push`
does not try to apply it again later:

```sql
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('20260928120000', 'auto_publish_admin_directory')
ON CONFLICT DO NOTHING;
```

## 4. Verify

```sql
-- Every seed-org program is linked to an active, verified listing.
WITH seed_orgs AS (
  SELECT m.org_id FROM public.org_members m
  JOIN public.platform_admins a ON a.user_id = m.user_id WHERE m.role = 'owner'
)
SELECT
  count(*) FILTER (WHERE p.global_partner_id IS NOT NULL)                      AS published,
  count(*) FILTER (WHERE p.global_partner_id IS NULL
                     AND (coalesce(cardinality(p.types), 0) = 0
                          OR p.types && ARRAY['Inpatient','IOP / PHP','Sober Living','Detox']::text[])) AS programs_not_published,
  count(*) FILTER (WHERE p.global_partner_id IS NULL)                          AS unlinked_total,
  count(*) FILTER (WHERE g.status = 'active' AND g.verified_at IS NOT NULL)    AS active_verified
  FROM public.partners p
  JOIN seed_orgs s ON s.org_id = p.org_id
  LEFT JOIN public.global_partners g ON g.id = p.global_partner_id;
```

Expected: `programs_not_published = 0` and `active_verified = published`.
`unlinked_total` counts interventionist/therapist-only partners, which is
fine. If `programs_not_published` is not zero, list them:

```sql
WITH seed_orgs AS (
  SELECT m.org_id FROM public.org_members m
  JOIN public.platform_admins a ON a.user_id = m.user_id WHERE m.role = 'owner'
)
SELECT p.id, p.organization, p.name, p.types, p.phone, p.website
  FROM public.partners p JOIN seed_orgs s ON s.org_id = p.org_id
 WHERE p.global_partner_id IS NULL
   AND (coalesce(cardinality(p.types), 0) = 0
        OR p.types && ARRAY['Inpatient','IOP / PHP','Sober Living','Detox']::text[]);
```

The usual cause is a second contact for a program the workspace already
publishes (one linked copy per workspace), which is expected. Anything else
can be retried with `SELECT public.publish_seed_org_partners();`.

Finally, from the app on any Directory-plan workspace, open the Directory
tab: the seed programs should appear as verified listings, and on the seed
workspace itself they show the "Imported" mark because they are linked.

## Day-to-day behaviour after rollout

- Adding a program in the seed workspace publishes it immediately. The
  listing starts with an empty public description; the partner's
  relationship note is not copied into it.
- Editing a program there updates the listing; other workspaces receive the
  change unless they overrode that field locally. Editing its relationship
  note changes nothing outside the workspace.
- Deleting a program archives its listing only when no other workspace has
  imported it; otherwise the listing stays and only the seed link goes away.
- Changing a program's type to Interventionist/Therapist only unlinks it
  (and archives the listing under the same rule).
- Admin edits made directly on a listing (SQL, center portal review) still
  propagate down to the seed copy without creating local overrides.
- **Claimed listings are authoritative** (`20260928170000`, see
  `docs/DIRECTORY_OWNERSHIP.md`). Once a program claims its listing in the
  center portal, or a workspace owns it as its profile, the seed workspace
  stops pushing into it: seed edits to that copy become local overrides, the
  claimant's edits flow down to the seed copy instead, deleting the seed copy
  never archives it, and adding a seed program that matches a claimed listing
  links the copy without overwriting the listing.

## Seed notes are private (`20260930190000_seed_notes_private.sql`)

Matt, 2026-09-30: "Make my partner notes private for sure."

Until this migration, auto-publishing a seed program copied the partner's
private relationship note (`partners.note`) into the listing's public
description (`global_partners.description`), and later note edits were
pushed up too. `20260930120000_directory_submissions.sql` had already
closed this for every other workspace. Now the seed workspace works the same
way:

- A newly published listing starts with an empty description. Linking a seed
  program to an existing listing leaves that listing's description alone.
- Note edits in the seed workspace are never pushed to the listing. The seed
  push path works from `seed_partner_pushed_fields()` (every synced field
  except `note`). `global_partner_synced_fields()` is unchanged, so a
  listing's description still flows down to workspaces that imported it,
  and `clear_partner_override(partner, 'note')` still works for them.
- Every linked seed partner records `note` in `local_overrides`, exactly like
  a submission does, so a description written later by a claimant or an
  admin never overwrites the private note. Already-linked seed partners are
  backfilled (`seed_notes_private_protect()`).
- One-time cleanup, `seed_notes_private_cleanup()`: for every listing linked
  from a seed partner that is **not claimed** (no `owner_org_id`, no
  `center_members` row) and whose description is byte-equal to
  `left(partner.note, 4000)`, the description is set to `''`. Claimed
  listings and descriptions that differ from the note (someone wrote them on
  purpose) are never touched. The function returns the number of listings
  cleared, runs the protect step first, and stays in the database so it can
  be re-run (a second run returns 0).
- That cleanup is an ordinary description edit as far as propagation goes:
  a workspace that imported one of those listings and never edited its copy
  of the note receives the empty text too, so the copied note leaves their
  list as well. A workspace that edited its note keeps it.
- Unchanged: `search_global_partners`, workspace profiles
  (`upsert_org_directory_profile` keeps its deliberately public
  description), claims, RLS, and every grant. Interventionist / Therapist
  partners are still never auto-published.

The migration is plain ASCII with no backslash escapes (it is pasted by hand
from a chat client). The phone-digit and website-domain expressions moved
into `directory_phone_digits(text)` and `directory_website_domain(text)`,
proven equal to the originals in `supabase/tests/seed_notes_private_test.sql`.

### Preview before applying

Lists exactly the listings the cleanup will clear. Nothing is changed.

```sql
SELECT g.organization, g.name, left(g.description, 60) AS description_start
  FROM public.global_partners g
  JOIN public.partners p ON p.global_partner_id = g.id
 WHERE public.org_is_platform_seed(p.org_id)
   AND g.description <> ''
   AND g.description = left(p.note, 4000)
   AND NOT public.global_listing_is_claimed(g.id)
 ORDER BY g.organization, g.name;
```

Read the list. The rule is "description byte-equal to the seed partner's
note", which is what the old publish path produced. It cannot tell that
apart from the one other way the two can be equal: a public description you
wrote by hand (SQL editor) on an unclaimed listing, which the old propagation
then copied down into your note. If a row here is one of those, note its
text; after applying, write it back with
`UPDATE public.global_partners SET description = '...' WHERE id = '...';`
(your note is protected by then and will not change).

### Apply

Paste the whole of `supabase/migrations/20260930190000_seed_notes_private.sql`
into the SQL editor and run it once. It is a single transaction. The final
`NOTICE` reports both counts:

```
seed_notes_private: protected N linked seed partner note(s), cleared M auto-copied listing description(s)
```

Then record it:

```sql
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('20260930190000', 'seed_notes_private');
```

### Verify

```sql
-- 1. No unclaimed seed-linked listing still shows a copied note. Expected: 0
SELECT count(*) AS remaining
  FROM public.global_partners g
  JOIN public.partners p ON p.global_partner_id = g.id
 WHERE public.org_is_platform_seed(p.org_id)
   AND g.description <> ''
   AND g.description = left(p.note, 4000)
   AND NOT public.global_listing_is_claimed(g.id);

-- 2. Every linked seed partner protects its note. Expected: 0
SELECT count(*) AS unprotected
  FROM public.partners p
 WHERE p.global_partner_id IS NOT NULL
   AND public.org_is_platform_seed(p.org_id)
   AND NOT ('note' = ANY (p.local_overrides));

-- 3. The push list no longer carries note and the helpers arrived intact.
--    Expected: false | example.org | 5415550100
SELECT 'note' = ANY (public.seed_partner_pushed_fields()) AS note_is_pushed,
       public.directory_website_domain('https://www.example.org/x') AS domain_check,
       public.directory_phone_digits('(541) 555-0100') AS digits_check;
```

Re-running the cleanup later is safe: `SELECT public.seed_notes_private_cleanup();`
returns 0 when there is nothing left to clear.
