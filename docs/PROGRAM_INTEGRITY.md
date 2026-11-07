# Program Integrity Watch

Patient brokering depends on families being sent to programs nobody checked.
Before a practitioner refers a family, ReferralFit now shows whether the
program's credentials are **on file, current and verified**: its state
license, its accreditation (The Joint Commission, CARF, or another body), its
LegitScript certification and its NPI.

It is **display only**. A program's credentials never change its match score
or its rank (`src/lib/matching.ts` never reads them; the test proves the
order is unchanged). Credentials are public business information about
programs, never client data, and the copy is plain and calm: it says what is
on file and what to check, never that a program is bad.

| Piece | File |
| --- | --- |
| Migration | `supabase/migrations/20261104130000_program_integrity.sql` |
| pgTAP | `supabase/tests/program_integrity_test.sql` |
| Pure rules (status, badge, editor, links, Today) | `src/lib/integrity.ts` |
| NPI Registry check | `src/lib/npi.ts` |
| Server calls | `src/lib/credentials.ts` |
| Credentials card, shield chip, the index hook | `src/lib/CredentialsCard.tsx` |
| ReferralFit's review queue | `src/lib/CredentialReviewQueue.tsx` (inside Workspace) |
| Center portal section | `portal/src/Credentials.tsx`, rules mirror `portal/src/credential-rules.ts` |
| Node test | `scripts/integrity-test.mjs` (in `npm test`) |

## What is stored

`public.program_credentials`, one row per credential. A row belongs to
**either**:

- a **directory listing** (`global_partner_id`): shared. The program that
  claimed the listing (its center account, or the workspace that owns it as
  its profile) or a ReferralFit platform admin adds and edits it. Only
  ReferralFit verifies it.
- one of a practice's **own partners** (`partner_id` + `org_id`): private to
  that workspace. Any member adds, edits and checks it. "Verified" here means
  the practitioner checked it themselves; who and when are recorded.

| Column | What it holds |
| --- | --- |
| `kind` | `state_license`, `accreditation`, `legitscript`, `npi` |
| `accreditor`, `accreditor_name` | Accreditations only: `joint_commission`, `carf`, or `other` with its name |
| `identifier` | The license, certificate or NPI number (required for a license and an NPI; an accreditation or LegitScript needs a number or a link) |
| `issuing_state` | State licenses only, two letters |
| `expires_on` | The last day it is good. NULL when there is none (an NPI never has one) |
| `proof_url` | The issuer's public lookup page or record. `https://` on a public host only (`is_valid_proof_url`) |
| `note` | Free text, up to 1,000 characters. A partner's: on the row (`''` when empty). A listing's: **always NULL here** (see below) |
| `status` | `pending`, `verified` or `rejected` (the stored review) |
| `verified_by`, `verified_at`, `verification_note` | Who reviewed it, when, and the note (a rejection of a listing's credential needs one). A listing's `verification_note` is **always NULL here** too |
| `npi_lookup_name`, `npi_checked_at` | The name the NPI Registry returned, and when. **A hint, never a verification** |
| `created_by`, `updated_by`, `updated_at` | Who added and last changed it |

CHECK constraints back the rules up: one owner per row, an NPI that passes
its check digit and has no date, an accreditor only on an accreditation, a
state only (and always) on a license, `verified_at` set exactly when the
review is not pending, and a listing's notes never on the row
(`program_credentials_listing_notes_private`). At most 20 credentials per
listing or partner.

**A listing's notes are private.** The program's own note and ReferralFit's
review note (why a credential could not be confirmed) are for the program
and ReferralFit, not for every practitioner who can read the listing. They
live in `program_credential_listing_notes` (`credential_id` primary key,
`ON DELETE CASCADE`; `note`, `verification_note`), which has RLS on, no
policy and no client grant at all. `fetch_listing_credential_notes(p_global_partner_id)`
(SECURITY DEFINER) returns `(id, note, verification_note)` for each of the
listing's credentials (`''` when empty) to the listing's claimant (its
center, or the workspace that owns it) and to platform admins; anyone else
gets no rows. A practice's own credentials keep both notes on the row,
inside the workspace, as before.

## Who reads what

RLS, `SELECT` only (production's default ACL grants ALL on new tables, so the
migration revokes everything from `PUBLIC`, `anon` and `authenticated` first,
then grants `SELECT` to `authenticated`; TRUNCATE, which RLS does not cover,
is gone too):

- a listing's credentials: **any signed-in user while the listing is
  active**; its claimant and ReferralFit also while it is pending or archived
  (`program_credentials_listing_visible`, SECURITY DEFINER because
  `global_partners` is entitlement-gated and `center_members` is self-read);
- a partner's credentials: **its workspace only**;
- a listing's notes: its claimant and ReferralFit only, through
  `fetch_listing_credential_notes`;
- `anon`: nothing. No client writes either table, ever (no write policy).

## How it is written

All SECURITY DEFINER with a pinned `search_path`, revoked from `PUBLIC` and
`anon`:

- `save_program_credential(p_id, p_global_partner_id, p_partner_id, p_kind,
  p_accreditor, p_accreditor_name, p_identifier, p_issuing_state,
  p_expires_on, p_proof_url, p_note)`: add (new id) or edit. The app makes
  the id, so a retry after a timeout is safe; the same values again change
  nothing. **Any change resets the review to pending**: a center's edit goes
  back to ReferralFit, a practice's edit waits for a new check. **Except: a
  rejection sticks.** When a claimant (not an admin) edits a listing
  credential ReferralFit rejected, the new values are saved but it stays
  `rejected`, with ReferralFit's note, until ReferralFit reviews it again (it
  goes back into the review queue). Such a credential can only be
  corrected (its number, date, link or note): another kind, accreditor
  (or other body's name) or issuing state is a different credential, and
  the edit is refused with 22023 "ReferralFit could not confirm this
  credential. Correct its number, date or link, or add a new credential."
  The app and the portal show that sentence calmly in the editor, as
  information. The NPI Registry hint survives only
  while the NPI is unchanged. A listing's note goes to its private notes.
  Plain-words errors (`program_credential_problem`), e.g. "An NPI is 10
  digits and its last digit must check out. Check the number."
- `verify_program_credential(p_id, p_verdict, p_note, p_seen_updated_at)`:
  `verified` or `rejected`. A listing's: platform admin only (or the SQL
  editor), and a rejection needs a note the program can act on (stored in
  the private notes). A partner's: a member of its workspace (the note on
  the row). `p_seen_updated_at` refuses a check on a credential that changed
  after the reviewer opened it.
- `delete_program_credential(p_id)`: the same people who may edit it;
  `false` when it is already gone. A claimant cannot remove a listing
  credential ReferralFit rejected (42501, "ReferralFit could not confirm
  this credential, so it stays on record. Add an updated one and we will
  review it.").
- `record_npi_lookup(p_id, p_name)`: keeps the registry name on an NPI
  credential. On a **listing's** NPI, ReferralFit only (a platform admin, or
  the SQL editor): a claimant gets 42501, because a program cannot vouch for
  itself. On a partner's NPI, any member of its workspace. Never changes
  the review.

A platform admin may add, edit and remove any listing's credentials, a
merged or archived listing included (a claimant cannot touch a merged one).

Readers: `fetch_listing_credentials(p_ids uuid[])` (SECURITY INVOKER, up to
500 listings per call, so the policies decide; listing rows carry NULL
notes), `fetch_listing_credential_notes(p_global_partner_id)` (the private
notes, above), `list_pending_listing_credentials()` (platform admins: every
pending listing credential, plus a rejected one the program edited since its
review, whose `status_today` reads `rejected`; `note` is the program's
private note), `listing_credentials_verified(p_global_id, p_today)`.

When a solo practitioner joins a practice, their checks follow the partner:
the composite foreign key to `partners (id, org_id)` is `ON UPDATE CASCADE`,
and `org_merge_linked_partner_copies` (re-created from 20261024120000 with
one added line) moves a check on a partner the team already tracks to the
team's copy. Deleting a partner or a listing deletes its credentials; deleting
an account leaves the credentials it added, unattributed.

## Status rules

`credentialStatus` in `integrity.ts`, the same as
`public.program_credential_status(p_status, p_expires_on, p_today)`:

| Status | When |
| --- | --- |
| `missing` | Nothing of that kind on file |
| `rejected` | The reviewer could not confirm it (whatever the dates say) |
| `expired` | Pending or verified, and its expiration date has passed |
| `expiring` | Pending or verified, and it expires within 30 days (today counts: a credential is good through its last day) |
| `verified` | Checked, and current |
| `pending` | On file, not checked yet |

Dates are the device's local day.

**One program.** When a program has several of a kind (a renewed license
next to the lapsed one, two accreditations), the best one speaks for the
kind: verified, then expiring, pending, expired, rejected; then a checked
one; then the later expiration; then the latest edit. For a partner linked
to a listing, the listing's credentials and the practice's own are taken
together, so a check the practice recorded counts in its own view.

Flags (`programIntegrity(...).flags`): `no_license`, `license_pending`,
`license_expiring`, `license_expired`, `license_rejected`, the same for
`accreditation` and `legitscript`, `npi_pending`, `npi_rejected`, or
`all_verified` when nothing needs a look. Labels: "No license on file",
"License expired", "Accreditation expiring", "All verified", ...

**The badge, "Credentials verified":** a state license verified and current,
**and** at least one accreditation or LegitScript certification verified and
current (current: not past its expiration date; expiring still counts). The
same rule as `public.listing_credentials_verified`. In the shared Directory
it counts the listing's credentials only.

**The shield chip:** `None on file` (nothing at all), `Expired` (the license,
an accreditation or LegitScript has lapsed with nothing current in its
place), `Verified` (the badge), otherwise `Needs review`.

## Where it shows

- **Partner profile:** a "Credentials" card. A calm headline (for example
  "We couldn't find a current state license on file. Check with the program
  before referring."), the listing's credentials when the partner is linked
  to a directory listing, then the practice's own. Each has its status,
  expiry, who checked it, the link to its record, the lookup links that fit
  it, and for an NPI "Check NPI registry". The practice's own rows have Edit,
  Mark as checked, Couldn't confirm and Remove; the editor opens inside the
  card (no new sheet). A platform admin can also add to and edit the
  listing's credentials here.
- **Match results and the Directory list:** a small shield chip. Display
  only: `rankPrograms` and `scoreProgram` never read it. In the Directory
  list an interventionist or therapist shows a chip only once something is
  on file.
- **Shared Directory (the ReferralFit directory screen):** the chip on each
  listing, "Credentials verified" for the badge. Platform admins get
  "Credentials (ReferralFit admin)" on each card to add a listing's
  credentials (most listings are curated by ReferralFit and unclaimed).
- **Assign & refer, Send packet, and any outbound referral** to a program
  whose state license is **expired** or **rejected**: an Alert, "Its state
  license shows expired (Oct 1, 2026). Check with the program before
  referring. Refer anyway?" Going ahead records it: on the case timeline when
  there is a case ("Referred anyway: the state license for ... showed
  expired ..., and the practitioner confirmed going ahead."; for a packet it
  rides on the packet's own timeline entry), otherwise on the referral's
  note. Alerts only; the packet composer opens through `afterSheetCloses`
  once the Alert is gone. A missing license does not prompt (the card and
  chip say so).
- **Today:** one card, "CREDENTIALS TO CHECK", when any partner the practice
  referred a client to in the last 12 months has an expired or soon-expiring
  (30 days) license or accreditation. One card lists them all; tap one to
  open its profile.
- **Center portal:** a "Credentials" section on the program's own listing:
  add, edit, remove. After a change it says "pending ReferralFit review";
  a rejection shows ReferralFit's note (read with
  `fetch_listing_credential_notes`), stays rejected after an edit until
  ReferralFit looks again, can only be corrected (number, date or link; the
  form says so calmly when another kind, accreditor or state is tried), and
  cannot be removed.
- **ReferralFit's review:** Workspace, "Program credentials" (platform admins
  only, next to "Directory submissions"): every pending listing credential,
  and every rejected one the program has edited since, oldest first, with
  the record link, the lookup links and the NPI check, then Verify, or
  Reject with a note.

## Checking by hand, never scraping

LegitScript, The Joint Commission and CARF do not allow automated lookups,
so the app never fetches their sites. It opens their public search pages in
the browser (`Linking.openURL`) for a person to check. The addresses live in
one map, `LOOKUP_SITES` in `integrity.ts`, each with where it comes from:

| Button | Opens |
| --- | --- |
| Check on LegitScript | `https://www.legitscript.com/websites/?checker_keywords=<program's domain>` (the page LegitScript's certification seals link to) |
| Joint Commission accreditation search | `https://www.jointcommission.org/en-us/about-us/recognizing-excellence/find-accredited-organizations` |
| CARF provider search | `https://carf.org/find-provider/` |
| State license lookup | No national registry exists: a web search for "<State> substance use treatment facility license lookup"; with no state, SAMHSA's `https://findtreatment.gov/` |
| NPI Registry | `https://npiregistry.cms.hhs.gov/provider-view/<npi>` |

## The NPI check

`src/lib/npi.ts`. The check digit is verified on the device first (Luhn over
the number with the 80840 prefix, the CMS rule; `1234567893` is valid). Then
the device asks the public NPPES API, no key:
`https://npiregistry.cms.hhs.gov/api/?version=2.1&number=<10 digits>`, and
shows the registered name (organization, or "First Last, Credential"), the
practice location, the primary taxonomy and any other names, with "Compare it
with <program>. A matching name is a good sign, not a verification."

Supabase's request deadline (`withRequestTimeout` in `supabase.ts`) only
wraps the Supabase client, so the lookup has its own: 8 seconds for the whole
exchange, the request aborted when it passes, and a calm "The NPI Registry
did not answer in time. Try again later, or open it in your browser." A
registry that is down, a non-JSON body, an unknown number: each has its own
plain message, and `lookupNpi` never throws. The name is stored as
`npi_lookup_name` / `npi_checked_at` (the practice's own NPI, or a listing's
when ReferralFit checks it; a program cannot record it on its own listing).
It never verifies anything.

## Offline and older servers

Credential reads are online only and not cached (the case cache's account
and wipe rules would have to grow for little gain): offline, the card says
"Credentials load when you're online" and every chip, prompt and Today card
stays hidden. Writes are online-only RPCs and fail with the app's
`OfflineError`: "You're offline. Credentials save when you're online."

Against a server **without** this migration, the reads get PGRST202
(function), 42P01 / PGRST205 (table) or 42703 (column), report
`available: false`, and the whole feature hides: no card, no chip, no
prompt, no Today card, no admin queue, no portal section.

## Compatibility with the 1.0.4 app

The 1.0.4 app in TestFlight never touches the table. The migration adds two
tables and new functions, and re-creates one internal function
(`org_merge_linked_partner_copies`, called only by `accept_org_invite`) with
the same signature and one added line. No existing table, column, policy or
callable function changes. Its partner deletes cascade to the practice's
checks (tested), and its workspace joins carry them (tested).

## Applying to production

Production has every migration through 20261024130000. Apply
`20261104120000_family_cost.sql` first (it is independent of this one), then
this one, **before** shipping an app build that includes the feature (the
app copes without it, but the feature stays hidden). The file checks the
order itself: if `20261104120000`'s columns (`case_benefits.in_deductible`,
`vob_requests.allowed_daily_rate`) are missing it stops at once with "Paste
20261104120000_family_cost.sql first: ..." and changes nothing.

1. Paste `supabase/migrations/20261104130000_program_integrity.sql` into the
   SQL editor and run it. It is ASCII only, has no backslashes, every
   top-level statement is under 3,700 characters, and it runs in one
   BEGIN/COMMIT. Re-running a file before the next one is pasted is harmless
   (CREATE TABLE / INDEX IF NOT EXISTS, DROP POLICY IF EXISTS, CREATE OR
   REPLACE). Once a later file is in, do not re-run an earlier one: it would
   put back older copies of the shared helpers the later file re-creates.
2. Record it:

   ```sql
   INSERT INTO supabase_migrations.schema_migrations (version, name)
   VALUES ('20261104130000', 'program_integrity');
   ```

3. Verify:

   ```sql
   -- RLS on; signed-in users read only; anon nothing.
   SELECT c.relrowsecurity AS rls,
          has_table_privilege('authenticated', c.oid, 'SELECT') AS authenticated_select,
          has_table_privilege('authenticated', c.oid, 'INSERT') OR has_table_privilege('authenticated', c.oid, 'UPDATE')
            OR has_table_privilege('authenticated', c.oid, 'DELETE') OR has_table_privilege('authenticated', c.oid, 'TRUNCATE') AS authenticated_writes,
          has_table_privilege('anon', c.oid, 'SELECT') AS anon_select
     FROM pg_class c WHERE c.oid = 'public.program_credentials'::regclass;

   -- The private notes: RLS on, no client privilege at all.
   SELECT c.relrowsecurity AS notes_rls,
          has_table_privilege('authenticated', c.oid, 'SELECT') OR has_table_privilege('anon', c.oid, 'SELECT') AS notes_client_select
     FROM pg_class c WHERE c.oid = 'public.program_credential_listing_notes'::regclass;

   -- Who may call what.
   SELECT p.proname,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_ok,
          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_ok
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('save_program_credential', 'verify_program_credential', 'delete_program_credential', 'record_npi_lookup',
                        'fetch_listing_credentials', 'fetch_listing_credential_notes', 'list_pending_listing_credentials',
                        'listing_credentials_verified', 'program_credential_status', 'is_valid_npi', 'is_valid_proof_url',
                        'program_credentials_listing_visible', 'program_credential_problem', 'program_credential_fields',
                        'program_credential_writer_scope', 'program_credential_store_notes', 'program_credential_write_edit',
                        'org_merge_linked_partner_copies')
    ORDER BY p.proname;

   -- The rules, spot-checked.
   SELECT public.is_valid_npi('1234567893') AS npi_ok, public.is_valid_npi('1234567890') AS npi_bad,
          public.program_credential_status('verified', CURRENT_DATE + 10, CURRENT_DATE) AS expiring,
          public.is_valid_proof_url('http://example.org') AS http_link;
   ```

   Expected: `rls = true`, `authenticated_select = true`,
   `authenticated_writes = false`, `anon_select = false`; `notes_rls = true`,
   `notes_client_select = false`. Every function with `anon_ok = false`;
   `authenticated_ok = true` for all except `program_credential_problem`,
   `program_credential_fields`, `program_credential_writer_scope`,
   `program_credential_store_notes`, `program_credential_write_edit` and
   `org_merge_linked_partner_copies` (internal). Then `npi_ok = true`, `npi_bad = false`,
   `expiring = 'expiring'`, `http_link = false`.

4. Rebuild and deploy the center portal (`cd portal && npm run build`, as
   in `portal/README.md`).
5. Ship the app build. Nothing else to deploy: no Edge Function, cron or
   secret.

## Not in this version

- Credentials are not cached for offline use.
- When ReferralFit merges two listings, the dropped listing's credentials
  move to the kept listing with their notes and reviews
  (`merge_global_partners`, re-created in `20261104140000`). Duplicates (two
  state licenses, say) are not folded together; remove the extra one.
- The state license lookup is a web search; a per-state map of licensing
  agency lookups would be better, but each address would need checking by
  hand first.
- The NPI check does not compare names automatically; a person compares.
- Nothing reminds a program before its own credential expires (the portal
  shows it; Today reminds the practitioners who refer to it).
