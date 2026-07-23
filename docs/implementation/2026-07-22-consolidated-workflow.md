# ReferralFit consolidated workflow implementation — 2026-07-22

## Scope

ReferralFit remains the destination app and retains its existing iOS/Android package identity, URL scheme, partner directory, matching, and referral ledger. InterventionOS workflow concepts were reimplemented as typed Expo 57 modules rather than copied from the older application. The InterventionOS bridge artwork is now used consistently for ReferralFit's app icon, Android adaptive icon layers, favicon, splash asset, and in-app header mark.

## Local storage migration

- Historical source key: `referralfit-v2`
- Current key: `referralfit-v3`
- A valid V2 source must contain `partners`, `referrals`, and `referralMatches` arrays.
- Before successful migration, the exact original V2 serialized value is written to a non-colliding `referralfit-v2-backup-*` key.
- Malformed JSON, unsupported versions, wrong-key shapes, invalid collections, malformed rows, and duplicate IDs enter recovery mode with zero writes.
- Recovery mode disables ordinary saving and permits only an explicit, validated backup restore.
- Explicit restore first preserves the exact current serialization under a non-colliding `referralfit-restore-backup-*` key.
- Current state updates are serialized through functional storage updates; stale full-snapshot overwrites are refused.

## Implemented workflows

- Referral-to-case conversion with correct inbound/outbound placement semantics.
- Intervention and coaching pipelines, status transitions, archive, and restore.
- Participants and explicit Add to Contacts action.
- Seven-item intervention checklist.
- Notes, current focus, tasks, appointments, and Add to Calendar action.
- Pending/received payment tracking, MTD/YTD received revenue, and outstanding balances.
- Real app-local document attachment/open/delete; imported filename-only references remain labeled as legacy references.
- Strict, preview-first InterventionOS JSON import with one import per source ID, fingerprint idempotency, encoded collision-free IDs, overwrite preflight, timezone validation, and warnings.
- Complete JSON backup export and validated local restore.

## Matching and existing-app corrections

- New partners are not silently treated as Nationwide.
- Service regions and out-of-network capabilities are explicit.
- Unknown cash pricing remains unknown; explicit zero remains explicit free pricing.
- Invalid or zero budget input is not converted to an unlimited budget.
- Referral counts derive from referral rows.
- The full referral ledger is available.
- Persisted legacy records are normalized for safe rendering while current V3 records are strictly validated.
- External phone, email, and website actions report failures and reject unsupported website schemes.
- Selected/checked accessibility state and input/control labels were added.

## Native/release configuration

- Expo `~57.0.8`
- iOS bundle identifier: `com.mattbrown.referralfit`
- Android package: `com.mattbrown.referralfit`
- iOS build number: `7`
- Expo Contacts, Calendar, Document Picker, File System, and Sharing modules configured.
- Native contact/calendar IDs are intentionally not persisted as portable cross-device identifiers.

## Cloud status

Supabase synchronization is deliberately deferred. No cloud sync is presented as active. Authentication, ownership, RLS, storage policy, tombstone, conflict, retry, and migration requirements must be completed before it can be enabled safely.

## Validation

- `npm test`: 41/41 passed.
- `npx tsc --noEmit`: passed.
- `git diff --check`: passed.
- `npx expo-doctor`: 20/20 passed.
- Expo web export: passed.
- Expo iOS export: passed.
- Expo Android export: passed.
- Live web runtime inspection covered Workflow navigation, overview, Cases, and case creation without JavaScript errors.

## Remaining device/release checks

A signed EAS build and physical-device tests are still required for Contacts, Calendar, document picker/open/delete, backup sharing/restore, permission-denied paths, and final VoiceOver/TalkBack behavior. These are release verification tasks, not claims made by source-level export validation.
