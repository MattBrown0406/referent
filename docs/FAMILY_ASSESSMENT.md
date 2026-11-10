# The family assessment

**Status: built 2026-11-08 on branch feat/day-review (ships with the next
build).** Practices first; programs later (Matt, 2026-11-08).

A practitioner sends a family a private link to a full intake assessment,
in the practice's name and with its logo. The family fills it in on the
web, stops and comes back as they like, uploads the insurance card, signs
one consent, and sends it. The answers land on the case, where the
practitioner reads them and rates the level of care: by hand with the
family's answers under each area, or starting from an AI suggestion on
their own Anthropic key.

## Matt's decisions (2026-11-08)

| Question | Answer |
| --- | --- |
| Consent | One blanket consent: a checkbox and a typed full name (the signature), with the date. The wording (version 2026-11-08) approved as written |
| Length | Full length: section for section like freedominterventions.com/assessment |
| Identifiers | Like the FI form: full name, date of birth, insurance card photos and typed insurance details |
| Who sends | Practices (interventionists) first; programs later |

## The questions

`src/lib/assessment-schema.ts` (the app) and `portal/src/assessment-schema.ts`
(the family's page) are the same file, word for word
(`scripts/family-assessment-test.mjs` checks). The twelve sections, their
questions, options and stored values follow the FI form, with these changes:

- written for any practice ("your practitioner"), never one person;
- the signature is one consent step at the end, not a field;
- the FI form never mentions 988 and shows nothing when an answer suggests
  danger. Here, suicidal thoughts, homicidal thoughts, "Crisis: immediate
  danger" or a described safety concern show 911 and 988 at once, and mark
  the assessment urgent for the practitioner (`safetyFlags`, and the same
  rules in the database, `family_assessment_urgent`). Seizures or DTs in
  withdrawal show a medical warning;
- the section intros use plain words, not the licensed six-dimension name
  (the app never uses it), and DSM-5 is called by its current name. The
  family sees the DSM-5 count with "not a diagnosis".

## The family's page (portal `/f#<token>`)

- **The link:** 256 random bits in the URL fragment (never in a server log),
  stored only as a sha256. The ten newest links of an assessment work; a
  link stops when the assessment is stopped, deleted, or after 30 days
  (each new link gives 30 more days). A corrected email address, or sending
  an expired assessment again, retires the older links (a mistyped address
  cannot keep reading). An emailed link is made only when the email is prepared
  (not when it is queued), leaves the outbox row once the email is sent or
  will never be, and a retried email whose link was retired meanwhile is
  dropped. The token leaves the address bar on open.
- **Limits a day:** 40 links per practitioner and 3 invites to one address,
  counted in `family_assessment_sends` (never trimmed by a new link).
- **Saves as they go:** every change saves after a moment, on every step,
  when the page is hidden, and as it closes (`public_family_assessment_save`).
  Every save carries the page's revision: if another tab or family member
  saved since (`RFA02`), the page takes their answers and keeps on top every
  answer it changed itself, then saves again (a save of unchanged answers,
  such as moving between sections, never counts as a change). Sending waits
  for a save on its way and for a photo being sent, and asks the family to
  look again if answers came in from another device meanwhile. Nothing is
  kept in the browser.
- **Danger before they finish:** a yes to suicidal or homicidal thoughts, or
  "crisis", emails the practitioner once while the family is still filling it
  in ("needs your attention today", no names or answers; stopping the link
  does not cancel it), and the case shows the alert. The answers themselves show only once the family sends it.
- **Card photos:** go straight to the private `assessment-files` bucket
  through a one-time signed URL from the `family-assessment-upload`
  function, which checks the link and picks a new name for every upload
  (`<case>/<assessment>/card-front|back-<32 hex>`). The function then records
  it (only while the assessment is open) and removes the photo it replaced,
  so a late upload can never change a card the practitioner already has.
- **Consent:** the last step shows the consent text from the server, with
  the practice's name. The family checks the box and types a full name;
  the server checks both and the consent version, and keeps the words they
  signed, the time and the browser.
- **After sending:** a thank-you, 911 and 988, and "Print or save a copy"
  (only on that screen). From then on the link says "already sent" and
  never shows the answers, so a forwarded email reveals nothing.

## The practitioner's side

- **Case file > Family assessment:** email the link (ReferralFit sends it
  through Resend, "<Practice> via ReferralFit", replies to the
  practitioner), or text or copy it. See where it stands, send it again,
  stop it, or delete it with its photos.
- **When it is finished:** urgent alerts first, the DSM-5 count, the answers
  by section, the card photos (five-minute links), and the signed consent.
- **Level of care:** "Rate the level of care" opens the level-of-care sheet
  with what the family said under each of the six areas. "Start from an AI
  suggestion" (with a key, after a confirm) sends the answers without who
  anyone is (no names, contact details, birth date, insurance numbers or
  program names: `levelOfCareFacts`) to the `ai-assist` function
  (`level_of_care`), which rates each area 0-4 on the app's own scale with
  a reason and the words it rests on (words not in the answers are
  dropped). The sheet starts from those ratings; the practitioner goes
  through every area and confirms or changes it. The app's rules, not the
  AI, recommend the level.
- **Emails:** when the family sends it, the practitioner (or the practice
  owner, if they left) gets "A family finished their assessment", or "...
  needs your attention today" when an answer is urgent. No names or answers
  in email.
- **Logo:** Workspace and settings > Practice logo (owner only), public like
  a logo on a website, shown on the page and in the invite.

## Data and access

| Data | Where | Who |
| --- | --- | --- |
| Answers, consent, signature | `family_assessments` (jsonb, 256 KB cap) | Read: members of the case's practice (RLS through the case, so it follows the case). Write: only the functions |
| Link tokens | `family_assessment_links` (sha256 only) | No client access |
| Card photos | private `assessment-files` bucket | Members of the case's practice read and delete; no client uploads |
| Logo | public `org-logos` bucket | The practice owner adds and removes |

Deleting a case deletes its assessments, and stops their emails not yet
sent. "Delete this assessment" stops the link, removes every photo in its
folder, then the row. Deleting the workspace (account deletion, sole owner)
removes the card photos first. Once an email is sent or will never be, the
family's address, name, the reply-to and any token leave the outbox row.

## Pieces

| Piece | Where |
| --- | --- |
| Questions and rules (shared) | `src/lib/assessment-schema.ts`, `portal/src/assessment-schema.ts` |
| Family page | `portal/src/FamilyAssessment.tsx`, `portal/src/assessment-link-rules.ts`, route `/f` in `portal/src/main.tsx` |
| Practitioner rules and calls | `src/lib/family-assessment.ts`, `src/lib/family-assessment-api.ts` |
| Screens | `src/lib/FamilyAssessmentSheet.tsx` (inside the case file), `src/lib/LevelOfCareSheet.tsx` (`seed`), `src/lib/PracticeLogoCard.tsx` |
| AI suggestion | `supabase/functions/ai-assist/level.ts` (+ `level_test.ts`), `src/lib/ai-assist-api.ts` |
| Photo uploads | `supabase/functions/family-assessment-upload/` |
| Emails | `supabase/functions/email-dispatch/email.ts` (`family_assessment_invite`, `family_assessment_submitted`) |
| Database | `supabase/migrations/20261109140000_family_assessment.sql`, `supabase/tests/family_assessment_test.sql` |
| Tests | `scripts/family-assessment-test.mjs` |

## Deploy (at build time): the whole 1.3.0 release, in this order

This is the one list for everything on the 1.3.0 build (day review, match
explanation, family assessment). The order matters: the new functions all
run on the old database, but the old `email-dispatch` cannot send the
assessment emails, and an email it cannot write is dropped, not retried.

1. **Functions first** (each runs on the database as it is today):
   - `supabase functions deploy email-dispatch --no-verify-jwt --project-ref ovfafffvcpaahktvlsdm`
     (the invite, "finished" and "urgent" emails; it reads the logo from `SUPABASE_URL`).
   - `supabase functions deploy day-review --no-verify-jwt --project-ref ovfafffvcpaahktvlsdm`
   - `supabase functions deploy ai-assist --no-verify-jwt --project-ref ovfafffvcpaahktvlsdm`
2. **Then the database**, pasted in the SQL editor one at a time, in this
   order (ASCII, one BEGIN/COMMIT each, safe to re-run). Each pasted copy
   needs its own record added as the last line before `COMMIT;` (the files
   in the repo do not carry it; an INSERT after COMMIT is ignored by the
   editor):
   - `20261109120000_day_review.sql`, with
     `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('20261109120000', 'day_review') ON CONFLICT (version) DO NOTHING;`
   - `20261109130000_ai_assist.sql`, with
     `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('20261109130000', 'ai_assist') ON CONFLICT (version) DO NOTHING;`
   - `20261109140000_family_assessment.sql`, with
     `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('20261109140000', 'family_assessment') ON CONFLICT (version) DO NOTHING;`
3. `supabase functions deploy family-assessment-upload --no-verify-jwt --project-ref ovfafffvcpaahktvlsdm`
   (card photos; it needs the tables from step 2).
4. Deploy the portal (the `/f` page), then the web app, from main. Until
   the portal is live an invite link opens the program sign-in page, so do
   not send a real family a link before this step.
5. Publish the privacy policy change on referralfit.com (branch
   feat/day-review in referralfit-web; bump `PRIVACY_UPDATED`): the policy
   today says ReferralFit never
   stores a date of birth or a full member ID, which this changes.
6. Check: send an assessment to your own email, open the link, add a card
   photo, send it, and see the "finished" email arrive.
7. The consent text (version 2026-11-08) is approved by Matt (2026-11-08).
   It is in `family_assessment_consent_text`; any change needs a new
   `family_assessment_consent_version`, so families sign the current words.
8. App Store: check the App Privacy answers (health, insurance and
   identifiers collected from people who are not app users, through the
   web page) and add a line to the App Review notes.
