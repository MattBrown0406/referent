# ReferralFit

A native Expo app for managing professional referral relationships and finding clinically appropriate placements.

## First-version features

- Searchable partner directory organized by provider type
- Placement matching across level of care, all 50 states plus DC, cash budget, insurance, therapeutic specialties, and men-only/women-only populations
- State-aware insurance menus that list relevant regional plans before major national providers
- State Medicaid program names and major Medicaid managed-care plans for every state and DC, informed by the CMS 2024 Managed Care Enrollment by Program and Plan dataset
- Two-stage ranking: client fit first, referral reciprocity only as a tie-breaker
- Reusable client-match profiles with payment-aware budget fields
- Referent assignment from a recommended match that automatically creates an outbound referral record
- Inbound and outbound referral ledger with relationship-balance summaries
- Add partners, favorite relationships, log referrals and touches, with per-partner stay-in-touch cadences
- Case files: one family, one place — contacts with one-tap call/text/email (auto-logged to the timeline), payment tracking, documents in a private bucket, and phone-number search across cases
- Match packets that close the loop: share a de-identified placement recommendation, log the referral, set the check-in follow-up — all case-linked when the profile started from a case
- Today Command Center: the home screen is a prioritized daily operating list (OVERDUE / TODAY / PARTNERS DUE) — one-tap call/text that auto-logs, a Done sheet that always forces a next step or a closed loop, snooze, set-next-step, and a 5-second "I need to…" quick add. New inquiry cases auto-create their first-call action
- Daily briefing (counts the today list), cadence reminders, and consult alerts 30 minutes ahead (local, on-device)
- Business dashboard with case funnel, lead attribution, revenue, referral outcomes, and automatic stage history
- Square/PandaDoc case links with HMAC-verified webhook status synchronization (the providers remain authoritative)
- Complete searchable referral history with direction filters

## Backend

The app is backed by Supabase (Postgres) with email/password auth. All tables
(`partners`, `touches`, `referrals`, `match_profiles`) are protected by
owner-only row-level security; the publishable anon key in `src/lib/supabase.ts`
is a public client value and is safe to ship in the bundle. Relationship
balances come from the `partner_balances` view; `partners_going_cold` is
mirrored client-side for notification scheduling.

The session lives in Expo SecureStore so you sign in once per device. Data is
synced to Supabase on every write and cached in AsyncStorage for offline use —
when a write cannot reach the server it is queued locally and flushed
automatically the next time the app is online (last-write-wins).

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
