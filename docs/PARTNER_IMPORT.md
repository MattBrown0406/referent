# Import partners from contacts and spreadsheets

Practices already keep their referral partners somewhere: the iPhone's
contacts, Google Contacts, Outlook, or a spreadsheet. Import brings them into
the network without typing each one, and without ReferralFit ever seeing an
address book.

- Migration: `supabase/migrations/20261108180000_partner_import.sql`
  (`import_partners`; also program referrals in the referral history, see
  docs/PROGRAM_REFERRALS.md)
- pgTAP: `supabase/tests/partner_import_test.sql`
- Node test: `scripts/partner-import-test.mjs` (in `npm test`)
- App: `src/lib/PartnerImportSheet.tsx` (Directory tab > Import partners),
  rules in `src/lib/partner-import.ts`, picker and file reading in
  `src/lib/partner-import-api.ts`

## Privacy first

1. **iPhone: iOS's own contact picker.** `expo-contacts`'
   `presentContactPickerAsync` shows `CNContactPickerViewController`, which
   runs outside the app and hands back only the contact picked. The app
   never calls the address-book APIs (`getContactsAsync`, permission
   requests, the iOS 18 access picker); `scripts/partner-import-test.mjs`
   checks the source for them. iOS shows no permission prompt. Apple
   requires `NSContactsUsageDescription` in any binary that links the
   Contacts framework, so `app.json` sets it ("ReferralFit uses only the
   contacts you pick, one at a time...").
2. **Web: the file is read in the browser.** A .csv (with a header row) or
   a .vcf, up to 5 MB, read with `File.text()`; nothing is uploaded.
3. **Matching happens on the device.** Each contact is matched to the
   ReferralFit Directory (same website or work-email domain, same phone, or
   same organization name; free-mail domains never match) against the
   listings the app already loads, and checked against the network (same
   Directory link, email, phone, or name and organization).
4. **Only confirmed rows are sent.** The practitioner reviews every row:
   include or not, its type, and for a Directory match whether to add the
   listing or the contact's own details. `import_partners` receives only
   those rows, at most 500.

## The rows

| Row | What happens |
| --- | --- |
| `{ "global_id": "<listing>" }` | The Directory listing is added (as `import_global_partner` does). Skipped if it is already in the network, no longer active, or the workspace does not have the Directory (`org_has_entitlement('directory')`, the same rule as reading it). |
| `{ "name", "organization", "types", "email", "phone", "city", "state", "website", "note" }` | The practice's own contact: known types only (at least one), a lower-cased valid email, a two-letter state, an http(s) or bare-host website (anything else dropped), the caller as author. A person without an organization is their own organization. Skipped when the network already has the same email, phone (last 10 digits) or name and organization. |

The result is `{ added, linked, skipped, ids }`; the app shows "Added 3
partners and 2 from the Directory. 1 was already in your network or could
not be added." and reloads the network. Imported partners get no automatic
first follow-up (a large import would flood Today); add one from the
partner's profile.

In a workspace owned by a ReferralFit admin (the platform seed workspace),
programs added this way are published to the Directory exactly as programs
added by hand are (`partners_seed_publish`); the sheet says so to admins.

## Files the web import reads

- **CSV** with a header row: Google Contacts ("First Name", "Last Name",
  "Organization Name", "E-mail 1 - Value", "Phone 1 - Value",
  "Address 1 - City", "Address 1 - Region", "Website 1 - Value"), Outlook
  ("Company", "E-mail Address", "Business Phone", "Business City",
  "Business State", "Web Page", "Notes"), or a hand-made sheet ("Name",
  "Organization" / "Program", "Type", "Email", "Phone", "City", "State",
  "Website", "Notes"). Commas, semicolons or tabs.
- **vCard** (.vcf) 3.0 and 4.0 from Apple Contacts, Google and Outlook:
  FN/N, ORG, TITLE, EMAIL, TEL, ADR, URL, NOTE; work and preferred values
  first. vCard 2.1 quoted-printable values are skipped, never misread.

A "Type" or job-title column suggests the partner type ("Interventionist",
"LMFT" to Therapist, "Detox", "Sober Living", "IOP" ...); rows with no type
wait for the practitioner to choose one (or set one for all at once).

## Deploy

1. Paste `supabase/migrations/20261108180000_partner_import.sql` in the SQL
   editor after `20261108170000_audit_round1.sql` (one BEGIN/COMMIT).
2. Deploy the web app: the Directory tab shows "Import partners" (a file).
3. The next iPhone build carries the contact picker (`expo-contacts`
   57.0.8, pinned; a native module, so it needs a new build). Older builds
   show no Contacts option.
