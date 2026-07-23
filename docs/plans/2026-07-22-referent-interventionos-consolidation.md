# Referent + InterventionOS Consolidation Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make Referent/ReferralFit the single iOS app for referral matching plus intervention/coaching case workflow, while preserving its existing app identity and user data.

**Architecture:** Keep Referent as the only Expo shell and add typed workflow modules rather than merging the older Expo 51 project. Upgrade the existing `referralfit-v2` payload into a validated, backed-up schema-v3 envelope; add cases, participants, checklist state, tasks, appointments, revenue, optional device Contacts/Calendar integrations, and optional Supabase sync against the existing InterventionOS tables. Existing referral records remain the source of relationship counts; workflow records link to referrals/partners by stable IDs.

**Tech Stack:** Expo 57, React Native 0.86, React 19, TypeScript 6, AsyncStorage, Expo Contacts, Expo Calendar, Supabase JS, Node test runner with `tsx`.

---

### Task 1: Add domain contracts, storage migration, and bug regression tests

**Objective:** Create a validated schema-v3 data envelope and pure utilities that fix known Referent data crashes and matching defects before adding workflow UI.

**Files:**
- Create: `src/domain/types.ts`
- Create: `src/domain/storage.ts`
- Create: `src/domain/matching.ts`
- Create: `src/domain/__tests__/storage.test.ts`
- Create: `src/domain/__tests__/matching.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Required behavior:**
1. Normalize legacy partner/referral/match objects so missing arrays or fields cannot crash rendering.
2. Preserve the exact legacy `referralfit-v2` JSON under a timestamped backup key before first schema-v3 write.
3. Reject malformed JSON into a visible recovery result; never overwrite unreadable source data automatically.
4. Use collision-resistant IDs rather than `Date.now()` alone.
5. Treat blank, zero, negative, or nonnumeric cash budgets as invalid/unbounded according to an explicit contract; never silently reinterpret an entered zero as Infinity.
6. A selected geography must not match a partner merely because `regions` defaults to `Nationwide`; newly created partners must only be nationwide when explicitly selected.
7. Out-of-network matching must require a recorded insurance/out-of-network capability, not classify every non-contracted/cash-only partner as eligible.
8. Referral counts must be derivable from referral records; stored partner counters are compatibility fields only.

**TDD:** Write failing tests first, run `npm test`, implement, then rerun `npm test` and `npx tsc --noEmit`.

### Task 2: Add the consolidated workflow data layer and cloud adapter

**Objective:** Port the safe InterventionOS case/schedule/task contracts into typed modules and reuse the existing RLS-protected Supabase rows without destructive pulls.

**Files:**
- Create: `src/workflow/types.ts`
- Create: `src/workflow/checklist.ts`
- Create: `src/workflow/cloud.ts`
- Create: `src/lib/supabase.ts`
- Create: `src/workflow/__tests__/merge.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Required behavior:**
1. Define cases, participants, checklist completion timestamps, document references, tasks, appointments, and payment states.
2. Map existing Supabase `families`, `schedule_items`, and `tasks` rows without changing the production schema.
3. Preserve all local nonempty records before cloud exchange.
4. Merge by stable local/cloud identity with newest `updatedAt` winning; cloud-empty must upload local records instead of erasing them.
5. Cloud operations are optional and fail closed when env values or auth are absent.
6. Never expose a service-role key. Use only publishable client credentials and existing owner-scoped RLS.
7. Do not copy device-specific calendar IDs between devices as authoritative calendar state.

**TDD:** Add merge fixtures for local-only, cloud-only, conflicting, deleted/archived, and empty-cloud cases.

### Task 3: Build the Workflow workspace

**Objective:** Add a native Referent workspace that replaces InterventionOS daily usage.

**Files:**
- Create: `src/workflow/WorkflowScreen.tsx`
- Create: `src/workflow/styles.ts`
- Create: `src/workflow/nativeIntegrations.ts`

**Required behavior:**
1. Workspace sections: Today, Cases, Schedule, Revenue, Settings.
2. Case pipeline supports intervention/coaching, active/archive state, status, IP name, primary substance, contact, notes, focus, participants, amount/payment state, and intervention checklist.
3. Participants support call/email actions and explicit Contacts sync.
4. Tasks support create/edit/complete/delete with case association and due date.
5. Appointments support create/edit/delete with case association, date/time, and explicit device Calendar sync.
6. Revenue shows collected, outstanding, average active-case value, and excludes archived pending cases from outstanding totals while retaining collected history.
7. Settings supports optional Supabase sign-in, safe bidirectional sync, sign-out, and recovery/backup status.
8. Do not claim document upload, push notifications, encryption, or Google Calendar API sync unless actually implemented.
9. Every destructive action requires confirmation and reports failures truthfully.

**Verification:** Component renders with empty and populated data, persistence survives reload, and native-only actions degrade clearly on web.

### Task 4: Integrate Workflow into Referent and configure native permissions

**Objective:** Make the consolidated workspace reachable without removing existing referral features or changing app identity.

**Files:**
- Modify: `App.tsx`
- Modify: `app.json`
- Modify: `README.md`
- Modify: `package.json`
- Modify: `package-lock.json`

**Required behavior:**
1. Preserve bundle ID `com.mattbrown.referralfit`, EAS project `931063d5-1135-428d-adb9-572c7fe0885e`, ASC app ID `6793327876`, scheme `referralfit`, icon, and existing referral tabs.
2. Add a fifth `Workflow` tab with an accessible icon/label.
3. Replace direct unvalidated AsyncStorage loading in `App.tsx` with the schema-v3 storage module.
4. Preserve old local partner/referral/match data through migration and backup.
5. Add current Expo-compatible Contacts/Calendar dependencies and usage descriptions.
6. Update Expo from `~57.0.7` to the doctor-required `~57.0.8` patch.
7. Update README with single-app architecture, privacy limits, migration behavior, native build requirement, and cloud configuration.

### Task 5: Full validation and independent review

**Objective:** Prove the merged app is buildable, preserves data, and does not reproduce either app's known defects.

**Commands:**
- `npm ci`
- `npm test`
- `npx tsc --noEmit`
- `npx expo-doctor`
- `npx expo export --platform web --output-dir /tmp/referent-web-final`
- `npx expo export --platform ios --output-dir /tmp/referent-ios-final`
- `npx expo export --platform android --output-dir /tmp/referent-android-final`
- `git diff --check`

**Runtime checks:**
1. Clean first run.
2. Valid v2 migration with backup.
3. Corrupt storage recovery without overwrite.
4. Legacy partner missing arrays no longer crashes Directory.
5. Cash and insurance matching edge cases.
6. Create/edit/archive/restore case.
7. Add/edit/remove participant.
8. Checklist/payment consistency.
9. Create/edit/complete/delete task.
10. Create/edit/delete appointment.
11. Revenue calculations.
12. Empty-cloud/nonempty-local safe sync.
13. Web degradation for Contacts/Calendar.
14. Narrow iPhone layout and iPad layout.

**Final gate:** Independent spec review, then independent code-quality/security review. Fix all blockers/high findings and rerun the complete gate after the last change.

### Task 6: Release handoff

**Objective:** Commit and push only verified changes; do not create an EAS build or submit to App Store Connect without Matt's explicit release approval.

**Steps:**
1. Fetch and reconcile `origin/main` without force-pushing.
2. Commit the reviewed implementation.
3. Push the feature branch or fast-forward `main` only after the final gate.
4. Verify local HEAD equals the GitHub remote SHA.
5. Report exact commit, tests, native-build requirement, cloud env status, and any remaining physical-device gates.
