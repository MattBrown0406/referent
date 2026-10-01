# ReferralFit

A native Expo app for managing professional referral relationships and finding clinically appropriate placements.

## Platform (multi-practice buildout)

ReferralFit is now a multi-tenant platform with five layers, built to be sold
to other intervention practices on recurring plans:

1. **Org workspaces** — every account belongs to a practice workspace
   (`orgs`/`org_members`); teammates share partners, referrals, cases, and
   follow-ups, joined via single-use invite codes from the in-app Workspace
   screen. Tenancy is enforced end-to-end: RLS, composite foreign keys, and
   every transactional RPC scope by `org_id`.
2. **Entitlements** — subscription state per workspace
   (`pro` / `directory` / `benchmarks`), mirrored from RevenueCat IAP by the
   `revenuecat-webhook` edge function. See `docs/ENTITLEMENTS.md`.
3. **Shared directory** — a platform-curated, verified list of treatment
   programs (`global_partners`) that Directory-plan workspaces browse and
   import into their own network with provenance. Imports stay **live-linked**:
   listing edits (admin or center portal) propagate to every linked tenant
   partner except fields the workspace overrode by hand (`partners.local_overrides`,
   reset per field via `clear_partner_override`). Search is server-side and
   paged (`search_global_partners`: trigram + full-text + array filters), with
   `fetch_global_partner_changes` for incremental offline sync. Listings carry
   normalized `phone_digits` / `website_domain` / `npi` for identity, an admin
   duplicate report and `merge_global_partners`, member-suggested listings
   (`suggest_global_listing` → pending, visible to the suggesting workspace),
   and verification that expires after 12 months. Network-wide usage per
   listing (`global_partner_stats`, hourly refresh) is exposed through
   `fetch_global_partner_stats` as aggregates only, behind the same
   five-workspace k-anonymity floor as benchmarks.
   **Seed orgs:** a workspace owned by a platform admin (`org_is_platform_seed`)
   is the directory's verified seed. Every treatment program added there is
   published automatically as an `active`, verified listing (dedup by phone /
   domain; matching `pending` suggestions from other workspaces go live), edits
   in the seed workspace flow to the listing and on to every linked copy, and
   deleting a seed program archives its listing when no other workspace links
   to it. Interventionist- or therapist-only partners never auto-publish, and
   ordinary workspaces keep the suggest → pending flow. Rollout steps live in
   `docs/DIRECTORY_SEED_ROLLOUT.md`.
   **Submissions:** a practice submits a partner of any type — program,
   interventionist, or therapist — from partner detail → *Shared directory*
   once it is directory-ready (organization name, contact, a type,
   city/state, 10-digit phone, email, website, cost, insurance or private
   pay — `directory_missing_fields`, mirrored in
   `src/lib/directory-submission.ts`). Anything less stays saved to the
   practice's own list; saving is never blocked. Platform admins review the
   queue from Workspace → *Directory submissions*
   (`list_pending_global_listings`, `review_global_listing`); a rejected
   partner stays in the submitter's list with the reviewer's note. The seed
   workspace's interventionists and therapists go through the same flow
   (only its programs auto-publish). See `docs/DIRECTORY_SUBMISSIONS.md`.
   **Ownership:** once a listing is claimed — by a program in the center
   portal (`center_members`) or by a workspace as its own profile
   (`owner_org_id`) — it is authoritative regardless of who created it: the
   claimant's edits keep it verified and flow down to every linked copy, and
   the seed workspace's edits to its copy become local overrides instead of
   pushing up. Every workspace owner can build one verified profile from
   Workspace → *Your directory profile* (`upsert_org_directory_profile`,
   Interventionist/Therapist types included). Duplicates by phone/domain are
   taken over only on an email-domain, creator, or suggesting-workspace
   match; otherwise a `center_claim_requests` row waits for admin approval
   (`approve_center_claim_request`) and nothing is overwritten. Details and
   the review SQL live in `docs/DIRECTORY_OWNERSHIP.md`.
4. **Center portal** (`portal/`) — treatment programs claim their listing with
   an admin-issued code and keep it accurate themselves. Verification status
   stays with ReferralFit; claiming never buys ranking (no pay-for-placement,
   consistent with EKRA/anti-brokering constraints).
5. **Benchmarks** — entitlement-gated, aggregate-only network medians
   (admit rate, family experience, placement rate, median quote) with a
   minimum cohort of five other paid workspaces plus per-metric activity floors.

## First-version features

- Searchable partner directory organized by provider type
- Placement matching across level of care, all 50 states plus DC, cash budget, insurance, therapeutic specialties, and men-only/women-only populations
- State-aware insurance menus that list relevant regional plans before major national providers
- State Medicaid program names and major Medicaid managed-care plans for every state and DC, informed by the CMS 2024 Managed Care Enrollment by Program and Plan dataset
- Three-step ranking (`docs/MATCHING.md`): hard requirements hide a program, a 0-100 fit score orders the rest, and ties go to lower family cost then a rotation seeded by the match. Referral counts and financial relationships never enter
- Reusable client-match profiles with payment-aware budget fields
- Referent assignment from a recommended match that automatically creates an outbound referral record
- Inbound and outbound referral ledger with neutral per-partner activity (last referral date, received, sent)
- Add partners, favorite relationships, log referrals and touches, with per-partner stay-in-touch cadences. Favorites are two-tier: `partners.favorite` is the workspace-wide team pin; `user_favorites` are personal to each signed-in user, work on directory listings before import, and carry over to the imported partner
- Case files: one family, one place — contacts with one-tap call/text/email (auto-logged to the timeline), payment tracking, documents in a private bucket, and phone-number search across cases
- Match packets that close the loop: share a de-identified placement recommendation, log the referral, set the check-in follow-up — all case-linked when the profile started from a case
- Today Command Center: the home screen is a prioritized daily operating list (OVERDUE / TODAY / PARTNERS DUE) — one-tap call/text that auto-logs, a Done sheet that always forces a next step or a closed loop, snooze, set-next-step, and a 5-second "I need to…" quick add. New inquiry cases auto-create their first-call action
- Daily briefing (counts the today list), cadence reminders, and consult alerts 30 minutes ahead (local, on-device)
- Business dashboard with case funnel, lead attribution, collected/outstanding revenue, proposed-contract pending revenue, referral outcomes, and automatic stage history
- Square/PandaDoc case links with editable proposed contract amounts and HMAC-verified webhook status synchronization (the providers remain authoritative)
- Complete searchable referral history with direction filters

## Backend

The app is backed by Supabase (Postgres) with email/password auth. All tenant
tables (`partners`, `touches`, `referrals`, `match_profiles`, the case tables)
are protected by workspace-scoped row-level security (`org_id`), with
`owner_id` retained on every row for attribution; the publishable anon key in
`src/lib/supabase.ts` is a public client value and is safe to ship in the
bundle. Relationship
balances come from the `partner_balances` view; `partners_going_cold` is
mirrored client-side for notification scheduling.

The session lives in Expo SecureStore so you sign in once per device. Data is
synced to Supabase on every write and cached in AsyncStorage for offline use —
when a write cannot reach the server it is queued locally and flushed
automatically the next time the app is online (last-write-wins). Case files
are the exception: their writes are online-only, but the case list with every
contact, plus the timeline and document list of the 25 most recently opened
cases, are kept as read-only saved copies so a family's numbers and history
are still there with no signal. Every list has pull-to-refresh, and a
foreground return refreshes at most once every 30 seconds.

## Run locally

```sh
npm install
npx expo run:ios
```

IMPORTANT: `expo-notifications` requires a development build (EAS Build or
`npx expo run:ios` / `npx expo run:android`). Local notifications do NOT work in
Expo Go, and an OTA-only (EAS Update) release cannot add them — they need
native code compiled into the binary. The same is true of `expo-image-picker`
(case-file document attach): it is a config-plugin native module, so attaching
documents needs the same development build. The rest of the app (auth, sync,
offline cache, case files minus document attach) runs fine in Expo Go via
`npm run ios` if you only need a quick look.

Use `npm run web` for the browser preview (notifications are a no-op on web).

## EAS / App Store Connect

Release builds must come from a clean detached checkout of the independently recorded commit merged into `main`. Build and submit are intentionally separate so the exact EAS build record is verified before TestFlight upload.

```sh
set -euo pipefail

# Set this from the GitHub PR merge result; never derive it from the current checkout.
: "${MERGED_SHA:?Set MERGED_SHA to the recorded GitHub merge commit}"
git fetch origin main
git cat-file -e "${MERGED_SHA}^{commit}"
git merge-base --is-ancestor "$MERGED_SHA" origin/main
git checkout --detach "$MERGED_SHA"
test "$(git rev-parse HEAD)" = "$MERGED_SHA"
test -z "$(git status --porcelain)"

npx eas-cli@21.4.0 build --platform ios --profile production --freeze-credentials --non-interactive --wait
APP_VERSION="$(node -p "require('./app.json').expo.version")"
APP_BUILD_NUMBER="$(node -p "require('./app.json').expo.ios.buildNumber")"
npx eas-cli@21.4.0 build:list --platform ios --app-identifier com.mattbrown.referralfit --git-commit-hash "$MERGED_SHA" --build-profile production --distribution store --app-version "$APP_VERSION" --app-build-version "$APP_BUILD_NUMBER" --status finished --limit 10 --json --non-interactive > /tmp/referent-eas-build.json
# Require exactly one matching record and verify commit, profile, platform,
# distribution, app version, and build number.
VERIFIED_EAS_BUILD_ID="$(node scripts/verify-eas-build.mjs /tmp/referent-eas-build.json "$MERGED_SHA" "$APP_VERSION" "$APP_BUILD_NUMBER")"

# EAS build records do not expose CFBundleIdentifier. Verify the signed IPA
# itself before submitting it to Apple.
IPA_URL="$(node -e 'const x=require("/tmp/referent-eas-build.json"); process.stdout.write(x[0].artifacts.applicationArchiveUrl)')"
curl --fail --location "$IPA_URL" --output "/tmp/referent-${VERIFIED_EAS_BUILD_ID}.ipa"
python3 scripts/verify-ios-ipa.py "/tmp/referent-${VERIFIED_EAS_BUILD_ID}.ipa" com.mattbrown.referralfit "$APP_VERSION" "$APP_BUILD_NUMBER"

npx eas-cli@21.4.0 submit --platform ios --id "$VERIFIED_EAS_BUILD_ID" --non-interactive --wait
```

Submission is TestFlight-only. Do not submit the app for public App Store review or release from this procedure.

## Privacy note

Two data classes, deliberately different:

1. **Referral ledger** (`referrals.client_label`, match profiles) — must stay
   de-identified, exactly as before. **No PHI in the ledger.**
2. **Case files** (`cases`, `case_contacts`, `case_events`, `case_documents`)
   — these *do* hold real contact info and documents by design: a mother's
   cell, a photo of the insurance card, the running call timeline. This is
   PHI-adjacent data. Current controls: single-user email/password auth,
   owner-only row-level security on every case table, a **private** Storage
   bucket (`case-documents`) with owner-prefixed object policies, and
   60-second signed URLs for viewing — documents are never exposed at a
   public URL. Sessions live in the device keychain/keystore; data syncs over
   TLS.

   A formal security/HIPAA review is **required** before any multi-user use,
   data sharing, export, or wider release. Until then this is a single-user
   tool on a single Supabase project.

Insurance and Medicaid contracts change frequently and may vary by county, eligibility group, and level of care. Menu entries are discovery aids only; verify benefits, authorization requirements, and in-network status directly before presenting a placement.

## Business automation

See [`docs/BUSINESS_AUTOMATION.md`](docs/BUSINESS_AUTOMATION.md) for the
Square/PandaDoc deployment runbook and the gated secure-intake automation design.
