# Shared program directory

Each account's “My directory” belongs to its practice workspace. Teammates in that workspace share its private records; unrelated practices cannot access them. This feature does not create separate personal directories within a team workspace.

Users save a private partner, open its profile, and choose **Share public program details**. They review the proposed program fields and confirm permission before publishing. Private phone/email contacts are not prefilled. Community contributions are active but unverified; an administrator must verify them separately.

| Data | Global directory behavior |
| --- | --- |
| Program/campus name, city, state, types, public website | Shared only after review |
| Public admissions phone/email | Blank initially; entered explicitly |
| Insurance/network capabilities, specialties, populations, levels, regions | Shown for review before sharing |
| Contact person, private contacts, notes, negotiated rates | Never copied by contribution RPC |
| Clients, cases, documents, revenue, payments, referral history, relationship balances | Remain in existing practice-scoped tables |
| Contributor user ID | Not stored by contribution RPC; legacy `created_by` column is not readable by authenticated clients |

Public fields can contain user-entered text: the review screen must not be used to enter confidential information. Database isolation is not a blanket security or compliance certification. Existing device cache behavior is unchanged (account-scoped AsyncStorage, not newly encrypted by this feature).

## Duplicate handling

A unique database identity normalizes program name (organization, falling back to name), city, and state. Name/city normalization lowercases, converts `&` to `and`, and removes characters outside ASCII letters/digits. Case, spacing, and punctuation variants reuse one global program. Different cities remain separate; use distinct campus names for different campuses in the same city. Non-ASCII-only names/cities are currently unsupported for community publication.

Shared website plus city/state also surfaces possible aliases for user review. Arbitrary alternate names are not guaranteed to be detected automatically. Selecting an existing suggestion explicitly links that program; it never overwrites its public details.

Advisory transaction locks and the unique index protect simultaneous contributions/imports. Each practice has at most one partner linked to a given global program. Imports reuse an existing matching unlinked private partner and preserve its private contact, rates, notes, and history. An additional local duplicate is not deleted or merged automatically.

## Matching

Users choose **My directory** or **Global directory** before searching for referral matches. Global data is downloaded as public program records; client labels and matching criteria are evaluated locally. A global candidate must be added to My directory before recording a referral or creating a packet. Existing imported programs use that practice's private information for matching.

Unknown prices appear as **Confirm pricing** and are excluded when a finite cash budget is set. No private negotiated rates are published. Active global discovery/import is available to all signed-in practices, independent of the legacy Directory entitlement; other entitlements are unchanged.

## Deployment and verification

Apply `20260906020000_community_program_directory.sql` before releasing the app. The migration stops if legacy global rows have duplicate normalized identities. Review those rows and their references explicitly; the migration never deletes or merges legacy data. The new import RPC retains two-argument compatibility via a default third argument; updated clients supply the expected workspace.

Run `npm run quality`, reset a disposable local Supabase database and run `supabase test db`. The community-directory tests cover private-field rejection, tenant isolation, contact/rate preservation, repeat imports, normalized duplicate contribution, unverified status, contributor metadata restrictions, and anonymous access. Existing case/payment/workspace tests remain part of the full suite.

For a local concurrent-write check, run `python3 scripts/directory-concurrency-test.py` while the disposable `supabase_db_referent` container is running. It races contributions from two practices and four first imports into one practice, then removes its fixtures.
