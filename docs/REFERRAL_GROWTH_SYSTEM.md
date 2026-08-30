# ReferralFit Growth System — implementation plan

## Product contract

1. **Personal referral links**
   - Authenticated workspace members create, deactivate, and rotate a public capability link tied to an optional partner.
   - A public family form resolves only public-safe practice/source display fields.
   - Submission requires explicit callback/privacy consent, a honeypot check, an idempotency key, and server-side validation/rate limiting.
   - One atomic transaction creates the sensitive case/contact/first-call task and a de-identified inbound referral with source attribution.
   - The public response returns no case/contact identifiers.

2. **Closed-loop handoffs**
   - Authenticated members create an external handoff for a referral using a privacy-safe alias and one-time returned capability URL.
   - Allowed progression: sent → received → contact_attempted → family_reached → consult_scheduled → closed; closed is terminal.
   - Every transition is append-only audited, idempotent, and monotonic.
   - Public recipients see only the alias, practice name, status history, and permitted next steps—never case/contact/clinical data.
   - A linked follow-up makes unacknowledged or stalled handoffs visible in Today/Referral Hub.

3. **Live program availability**
   - Claimed programs confirm accepting state, available levels, response-time band, note, and next review date.
   - Portal and directory show freshness truthfully; confirmations older than seven days are stale.
   - Availability never affects paid ranking.

4. **Relationship intelligence**
   - A deterministic, explainable local engine ranks up to five daily actions using relationship decay, referral history, open loops, reciprocity, and network gaps.
   - Every suggestion states why it exists and offers a concrete action; no opaque or paid score.

5. **Approval-first voice capture**
   - Device speech recognition creates an editable draft only.
   - Deterministic parsing proposes partner, touch kind, note, and optional follow-up date.
   - Nothing is persisted until explicit approval; transcript is not retained separately after save/cancel.

## Implementation waves

### Wave A — frozen backend contract
- Add one generated migration for referral sources, intake rate limits/atomic creation, handoffs and transition RPCs, availability confirmations, RLS, grants, constraints, indexes, and audit history.
- Add pgTAP attack/transition tests.
- Add a JWT-free public Edge Function as the only anonymous intake/handoff boundary.

### Wave B — independent clients
- Add native `growth.ts`, `intelligence.ts`, `ReferralHubScreen.tsx`, and `VoiceCaptureSheet.tsx`.
- Add portal public intake and handoff routes plus program availability editor.
- Extend directory models/cards with current availability and freshness.

### Wave C — integration
- Add a prominent Referral Hub entry to Today and wire live app state/callbacks.
- Add focused deterministic source tests, then full TypeScript/test/portal build/Supabase reset + pgTAP/Expo Doctor gates.
- Run independent spec/security and code-quality reviews; fix all blocker/high findings before commit.

## Deployment boundary

Schema/function/Edge Function deployment, portal hosting, EAS build, App Store Connect submission, and physical-device speech/QR testing are separate release steps. Source completion does not imply any of those external states.
