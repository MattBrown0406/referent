# ReferralFit

A native Expo app for managing professional referral relationships and finding clinically appropriate placements.

## First-version features

- Searchable partner directory organized by provider type
- Placement matching across level of care, all 50 states plus DC, cash budget, insurance, therapeutic specialties, and men-only/women-only populations
- State-aware insurance menus that list relevant regional plans before major national providers
- State Medicaid program names and major Medicaid managed-care plans for every state and DC, informed by the CMS 2024 Managed Care Enrollment by Program and Plan dataset
- Two-stage ranking: client fit first, referral reciprocity only as a tie-breaker
- Reusable, locally saved client-match profiles with payment-aware budget fields
- Referent assignment from a recommended match that automatically creates an outbound referral record
- Inbound and outbound referral ledger with relationship-balance summaries
- Add partners, favorite relationships, log referrals, and persist changes locally
- Fictional demo data for safe product evaluation

## Run locally

```sh
npm install
npm run ios
```

Use `npm run web` for the browser preview.

## EAS / App Store Connect

After confirming the final bundle identifier and signing into the intended Expo account:

```sh
npx eas-cli init
npx eas-cli build --platform ios --profile production
npx eas-cli submit --platform ios
```

The final App Store Connect app ID can be added to the `submit.production.ios.ascAppId` field in `eas.json` after the app record exists.

## Privacy note

This prototype stores data locally on the device. Referral records are designed around de-identified family labels; do not enter protected health information. A production release should add authentication, encrypted cloud sync, access controls, audit logging, backups, and a formal HIPAA/security review before any sensitive client data is stored.

Insurance and Medicaid contracts change frequently and may vary by county, eligibility group, and level of care. Menu entries are discovery aids only; verify benefits, authorization requirements, and in-network status directly before presenting a placement.
