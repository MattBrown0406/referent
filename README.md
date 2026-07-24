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
- Daily briefing and cadence reminder notifications (local, on-device)

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
native code compiled into the binary. The rest of the app (auth, sync, offline
cache) runs fine in Expo Go via `npm run ios` if you only need a quick look.

Use `npm run web` for the browser preview (notifications are a no-op on web).

## EAS / App Store Connect

After confirming the final bundle identifier and signing into the intended Expo account:

```sh
npx eas-cli init
npx eas-cli build --platform ios --profile production
npx eas-cli submit --platform ios
```

The final App Store Connect app ID can be added to the `submit.production.ios.ascAppId` field in `eas.json` after the app record exists.

## Privacy note

Referral records are designed around de-identified family labels; **client_label
fields must remain de-identified — no PHI.** Do not enter names, dates of birth,
diagnoses, or any protected health information in any field. Data syncs to a
single-user Supabase project over TLS with owner-only row-level security, and
sessions are stored in the device keychain/keystore. A wider release should add
access controls beyond single-user, audit logging, backups, and a formal
HIPAA/security review before any sensitive client data is stored.

Insurance and Medicaid contracts change frequently and may vary by county, eligibility group, and level of care. Menu entries are discovery aids only; verify benefits, authorization requirements, and in-network status directly before presenting a placement.
