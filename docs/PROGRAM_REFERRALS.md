# Program referrals: programs refer families to interventionists

A family calls a treatment program before they are ready for treatment: the
person who needs help refuses, or the family does not know where to start.
The program can refer that family to an interventionist on ReferralFit. The
referral arrives in the practice as a new lead, and the program follows how
it went: milestones per referral and a track record per interventionist.

- Migration: `supabase/migrations/20261108140000_program_referrals.sql`
- pgTAP: `supabase/tests/program_referrals_test.sql`
- Node test: `scripts/program-referral-test.mjs` (in `npm test`)
- Center portal: `portal/src/ProgramReferrals.tsx`, rules in
  `portal/src/program-referral-rules.ts`
- App (the receiving practice, iPhone and web): `src/lib/ProgramReferralCard.tsx`
  (case file), `src/lib/ProgramReferralSettingsCard.tsx` (Workspace),
  `src/lib/program-referrals.ts` and `src/lib/program-referral-rules.ts`

## Ethics first

1. **The family asked for it.** The program confirms, on every referral:
   "The family asked us to share these details with this interventionist, and
   agreed we may be kept informed of their progress and placement." Without
   it the server refuses (`consent_attested_at` is required). Programs bound
   by HIPAA or 42 CFR Part 2 still own their own consent paperwork; the
   checkbox records that they have it.
2. **Referrals never rank.** Matching (`src/lib/matching.ts`) never reads
   program referrals; nothing here changes a fit score, an order, a badge or
   a directory listing. `scripts/program-referral-test.mjs` checks that
   matching.ts does not mention them.
3. **The practice decides what the program sees.** Each referral has a
   switch on the case file, "Sharing progress with <program>", on by default.
   While it is on, the program sees milestones and, if the client enters
   treatment, the name of the program they entered, so it can help coordinate
   care (a program that is not the right fit itself can still help find the
   right one, and it builds working relationships). When it is off, the
   program sees only that it sent the referral ("Progress not shared").
4. **Nothing else leaves the practice's file.** No names (beyond what the
   program typed itself), notes, contacts, case title, insurance, cost or
   dates beyond the milestone times. A destination known only by a person's
   name reads "a treatment program".
5. **No scoreboard of referrals returned.** The destination is shown per
   referral, for care coordination, and is never aggregated: the track
   record has no "placed at your program" or "returned to us" count or rate.
   Reciprocal referral arrangements can themselves be "anything of value"
   under patient-brokering laws: the Eliminating Kickbacks in Recovery Act
   (EKRA, 18 U.S.C. 220), the federal Anti-Kickback Statute, and state
   patient-brokering statutes. A per-interventionist count of clients sent
   back to the referring program would invite exactly that kind of
   arrangement, so the app never builds one. The pgTAP and node tests assert
   the track record has no destination column.
6. **Only the program's own referrals.** No other program, practice or
   ReferralFit user sees these referrals or stats.

## Who can refer, and to whom

- **Sender:** a center account (`center_members`) whose program listing is
  live (`status = 'active'`), in the center portal.
- **Recipient:** an interventionist or practice listing (any active listing
  that is not a program, so never `listing_carries_beds`) claimed by a
  ReferralFit workspace as its own profile (`owner_org_id`).
  `program_referral_receive_status` answers `ready`, `not_on_referralfit`
  (unclaimed, or not a professional listing) or `not_taking` (the owner
  switched program referrals off: `orgs.accepts_program_referrals`, on by
  default, Workspace > "Referrals from treatment programs"). Refusals are
  neutral ("This practice is not taking referrals through ReferralFit right
  now. Contact them directly.").
- **Caps:** 30 referrals per program in any 24 hours. A second tap for the
  same family (same phone) to the same practice within ten minutes returns
  the referral already made.

## The lead

`program_refer_family` makes the lead through `create_lead_internal`, the
same path as the intake link, with the signed-in program's claims cleared
for the insert (`program_referral_lead`) so no program account is recorded
as an author on the practice's rows. So it is an ordinary lead:

- `lead_captured_at`, `lead_channel = 'program_referral'`, a first-call
  follow-up, and the existing `new_lead` push to every member of the
  practice (`cases_notify_new_lead`);
- lead source "Professional referral" with the program's name as the detail
  (so it counts on the Business screen's lead sources);
- the summary "Referred by <program> through ReferralFit." plus the
  program's note, and the timeline entry "New lead referred by <program>
  through ReferralFit";
- urgency "Someone may be in danger right now" carries over, with the
  911/988 line shown on the program's form.

Not done: a received entry in the practice's referral ledger. That table's
insert path assumes the practice's own signed-in author (its org triggers
and ledger rules), so the practitioner logs it by hand, as before, if they
track the program as a partner.

## Milestones (derived, never entered by hand)

From the case, on every read (`program_referral_milestones`):

| Milestone | When |
| --- | --- |
| Received | The referral exists |
| Family reached | `cases.first_touch_at` (with the minutes from referral to first contact) |
| Consult | The case's stage history or status reached consult, deciding, engaged or later |
| Intervention | Intervention, placed or aftercare |
| Entered treatment | Placed or aftercare, or any outbound referral on the case recorded as admitted; "Entered treatment at <program>" when the admitted referral's partner has an organization (or its directory listing does) |
| Not proceeding | The case is lost (and never entered treatment) |
| Closed | The case is closed, or the practice removed it |
| Progress not shared | The practice turned sharing off for this referral |

The program's track record per interventionist (`program_referral_stats`):
referrals sent, the share reached within 24 hours, the median time to first
contact, the share reaching consult or intervention, and the share entering
treatment anywhere. Rates use only referrals whose progress is shared; the
rest are counted as "not shared or closed".

## RPCs

| RPC | Who | What |
| --- | --- | --- |
| `program_referral_targets(p_query, p_state)` | center | Up to 25 professional listings by name and state, with business details and `receive_status` |
| `program_refer_family(p_to_global_id, p_caller_first_name, p_phone, p_email, p_relationship, p_about_first_name, p_urgency, p_note, p_consent)` | center | The referral and its lead; returns the referral id |
| `list_program_referrals()` | center | Its referrals, newest first, with milestones and `placed_with` (only while shared) |
| `program_referral_stats()` | center | Its track record per interventionist |
| `case_program_referral(p_case_id)` | practice member | The program behind a case, and the sharing switch |
| `set_program_referral_sharing(p_referral_id, p_share)` | practice member | Turn sharing on or off (written to the case timeline) |
| `program_referral_settings()` | practice member | Accepting on or off, whether the caller may change it, whether the workspace has a live profile |
| `set_accepts_program_referrals(p_accepts)` | workspace owner | The switch |

`program_referrals` has RLS on and no client grants; every read and write
goes through these SECURITY DEFINER functions (search_path pinned).

## Deploy

Order: after `20261108120000_email_alerts.sql` and
`20261108130000_placement_answer_links.sql` if those are going in too (this
migration does not depend on them, and they do not touch anything here).

1. Paste `supabase/migrations/20261108140000_program_referrals.sql` in the
   SQL editor (one BEGIN/COMMIT; re-running it is harmless).
2. Rebuild and deploy the center portal (`cd portal && npm run build`,
   `portal/README.md`). Programs see "Refer a family to an interventionist",
   "Your referrals" and, once they have referred, "Interventionists you've
   referred to".
3. The web app (app.referralfit.com) and the next iPhone build carry the case
   file card and the Workspace switch. Older builds simply do not show them;
   referrals still arrive as ordinary leads.

Verify:

```sql
SELECT count(*) FROM public.program_referrals;
SELECT lead_channel, count(*) FROM public.cases WHERE lead_channel IS NOT NULL GROUP BY 1;
```
