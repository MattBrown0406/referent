# Referent bug audit — 2026-07-22

Audited commit: `786bce94eb77362b80355c1497752c5e7899e4ba`

## Blockers

1. **New partners are always marked nationwide** (`App.tsx:704-706`, consumed at `App.tsx:533`). A California-only program is recommended for New York because every new partner receives `regions: ['Nationwide']`.
2. **Missing cash-price data is represented as free treatment** (`App.tsx:689-712`, `526-527`, `1015-1018`, `1185`). Blank prices become `$0–$0` and qualify for cash-pay matches.

## High

3. **Corrupt persisted JSON is overwritten with empty state** (`App.tsx:435-478`). The read error is swallowed, `loaded` becomes true, and the save effect replaces the unreadable source.
4. **Storage failures are silently presented as successful saves** (`App.tsx:475-478`, `722-729`, `745-772`). The modal closes and state appears saved even when AsyncStorage rejects.
5. **Out-of-network matching treats every non-contracted provider as eligible** (`App.tsx:525-532`), including cash-only and unknown-benefit programs.
6. **Zero, negative, or invalid cash budgets can become unlimited** (`App.tsx:520-527`, `973-978`, `604`) through `Number(value) || Infinity`.

## Medium

7. **Referral history hides entries after the fifth** (`App.tsx:552-555`, `1095-1111`) because the full ledger reuses a Home-only truncated list.
8. **Location and financial inputs lack validation** (`App.tsx:704-712`, `1231-1235`): full state names, negative values, and max below min are accepted.
9. **Call/email actions can silently fail** (`App.tsx:1171-1172`, `1232-1233`) because malformed/empty targets are accepted and URL opening is not awaited or reported.
10. **Stateful controls omit accessibility state** (`App.tsx:162-169`, `217-227`, `304-307`, `895-902`, `1140-1143`, `1287-1299`). Selected/checked/tab state is often visual only.
11. **Android production identity is not pinned** (`app.json:17-25`) because `android.package` is absent.
12. **Expo doctor fails the SDK patch gate** (`package.json:8`): Expo 57.0.7 is installed while SDK 57 currently expects `~57.0.8`.
13. **Ten moderate transitive dependency findings remain.** `npm audit fix --force` is unsafe because npm proposes downgrading Expo to 46; update only through the Expo-compatible patch path.

## Runtime reproduction

A legacy partner missing arrays such as `insurance` and `therapies` was written to `referralfit-v2`. The Home screen loaded, but opening Directory crashed `PartnerCard` at `App.tsx:359`, reached from `App.tsx:1058`. This confirms persisted-shape normalization is required, not merely static typing.

## Baseline verification

- `npm ci`: passed
- `npx tsc --noEmit`: passed
- Expo web export: passed
- Expo iOS export: passed
- Expo Android export: passed
- `npx expo-doctor`: 19/20; Expo patch mismatch above
- No signed build or physical-device test was performed during the read-only audit
