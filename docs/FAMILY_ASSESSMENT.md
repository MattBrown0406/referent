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

## From answers to matches (2026-11-21, Matt)

On a finished assessment, **See matches from these answers** opens Match
filled in from what the family said (`src/lib/assessment-match.ts`, tests in
`scripts/assessment-match-test.mjs`). It starts like "Find placement" (the
case's name, the state named in the case, the plan on Benefits), then:

| Field | From |
| --- | --- |
| Population | Under 18: Adolescent. Otherwise gender Male: Men, Female: Women (these hide only programs for the other group) |
| Men only / Women only | Never filled in (they are requirements and would hide every co-ed program). A request for gender-specific care is listed to check |
| Needs (preferences, never must-haves) | Trauma (a yes, not "suspected"), Dual diagnosis (psychiatric history or signs of a mood disorder), Chronic pain, Chronic relapse (two or more earlier programs), and what the family wrote under treatment preferences (faith based, LGBTQ+, EMDR, DBT, CBT, IFS, equine, adventure, family program, trauma, eating disorders, gambling), skipping any sentence or phrase with a "no" in it ("No wilderness programs") |
| Payment | The plan on Benefits (named to check when Match does not list that name); else the carrier the family typed, when the form lists it (common spellings such as BCBS and UHC are known). The family's budget is for the whole stay and Match's is per month, so it is listed to check, never filled in |
| Level of care | Only the level chosen on the case's level-of-care rating |

MAT is never added on its own (it is a must-have by default and would hide
programs): "Opioids or alcohol are named" is listed to check instead, with
State Medicaid, a carrier the form does not list, seizures or DTs, and no
level rating yet. A banner above the form lists every field it filled and
the answer it came from, and **Draft for the family** opens "Explain to the
family" on the ranked list. When the case already has a saved match, the app
asks first and keeps every field the answers do not speak to. Nothing is
saved until the practitioner saves the match.

## Case brief for programs (2026-11-21, Matt)

A finished assessment shows **Case brief for programs**: a short summary for
a program's admissions team (`src/lib/case-brief.ts`, tests in
`scripts/case-brief-test.mjs`). Client (age and gender only; 90 or older is
grouped), substances (from the structured rows: frequency, route, current),
use, withdrawal, medical, mental health, safety, readiness, earlier
treatment (count, types, how many completed), home, payment (the carrier
only, or State Medicaid or self-pay: never a number or the budget), the
practitioner's level-of-care rating, and urgency.

It is built only from the answers' choices, never their free-text boxes,
so it carries no names, contact details, birth date, member or group
numbers, program names or dollar amounts. The practitioner can edit it;
**Share the brief** and **Copy the brief** check the text line by line with
the same rules as every text programs read (`identifying-text.ts`), with
the case's title, its contacts and the names typed in the assessment.
Nothing is sent by ReferralFit: it goes only where the practitioner shares
it. In a referral packet **Sending to partner**, **Add the case brief**
appends it to the program's copy, which stays editable before sharing.

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
| Reading the card | `supabase/functions/ai-assist/read_card.ts` (+ `read_card_test.ts`), `src/lib/card-reading.ts`, `requestCardReading` in `src/lib/ai-assist-api.ts`, `openBenefitsFromCard` in `App.tsx`, `supabase/migrations/20261121120000_read_card.sql` |
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

## Bug audit, 2026-11-20

Migration `20261120120000_nov20_audit.sql` (paste in the SQL editor, with its
`schema_migrations` record before `COMMIT;`) and the `family-assessment-upload`
function:

- **Emailed invites** go out only from an account whose own email address is
  confirmed, and at most 400 a day across all practices, so referralfit.com
  cannot be used to send in bulk. Texting or copying a link is unchanged.
  Production confirms new accounts at sign-up today (Supabase Auth "Confirm
  email" appears to be off), so the confirmed-address rule only bites once
  that is turned on: Matt's call.
- **Fifty links** of an assessment work at a time (was ten): each "Text or
  copy" tap and each resend makes one, and the family's working link was
  retired after ten.
- **After "Stop"**, a new link carries the stopped assessment's answers on:
  the family continues where they were; the stopped links stay stopped.
- **An invite email that could not be delivered** shows on the case ("The
  email did not go out…") instead of "Sent" (`family_assessment_invite_failures`).
- **Uploads**: a link can hold at most 12 photo files at once (two card
  photos plus replaced or abandoned uploads awaiting clean-up).
- **Account deletion** also removes the practice logo (public bucket).

## Reading the card, 2026-11-21

**Approved by Matt 2026-11-21. Built on branch feat/card-reading (from
feat/next-build); ships with the next build.**

When the family added insurance card photos, the practitioner can have the
AI read them into the case's Benefits, on their own Anthropic key like every
other AI help. That fills "True cost to the family" without typing.

**What the practitioner sees**

1. Case file > Family assessment, a finished assessment with card photos:
   the Insurance card section shows the photos and, with a key, **Read the
   card into Benefits** (without a key: a line saying where to add one).
2. A confirm: the card photos go to Anthropic on their own key to be read;
   ReferralFit keeps nothing from the reading; nothing is saved until they
   check the Benefits form and tap Save. If the plan has not loaded (still
   loading, offline) the app says so first and sends nothing.
3. The **Insurance plan** form opens on what the case holds now, marked
   "Read from the card: check each field before saving." Only empty fields
   are filled (carrier, plan name, member ID last four). A field that
   already has something keeps it; the card's reading is shown beside it
   with **Use the card's**. The insurer as printed is shown when the app's
   carrier name differs ("Blue Cross" for "Blue Cross Blue Shield of
   Texas"), and anything unclear (glare, cut off) is listed.
4. **Save plan** is the normal Benefits save (last four only, the timeline
   entry, the cost amounts untouched). Back closes the form without saving
   and returns to the assessment.

**How it works**

- The phone sends `ai-assist` (`read_card`) only the assessment id, the
  sides that have a photo and the Benefits form's carrier names.
- The function reads the assessment row and the photos **with the caller's
  own session** (anon key plus their access token), so the existing RLS on
  `family_assessments` and the `assessment-files` storage policy decide
  access; the service role is used only for sign-in and the daily cap, as
  before. A photo path is used only when it sits in that assessment's own
  folder.
- Types are read from the file's bytes. JPEG, PNG, WebP, GIF (up to about 7.5 MB of photo: the Claude API's
  10 MB per image, measured in base64) and PDF (up to 10 MB) are sent as they are.
  A larger photo or an iPhone HEIC photo is asked from storage as a smaller
  copy (image transformation); if the project does not have that, the side
  is skipped and named in the note. All the reads share 20 seconds.
- The model returns the insurer as printed, the matching app carrier (or
  none), the plan name, the member ID and a note. The function works out
  the **last four** of the member ID itself and returns only that (four
  letters or digits with at least one digit in the ID, else nothing).
  Numbers of five digits or more and dates are taken out of the free text,
  and a text that repeats the full member ID is dropped. The carrier fills
  Benefits only as one of the app's own names (Match compares plan names
  exactly); an insurer the list does not have shows as printed, for the
  practitioner to choose. Never a name, date of birth or group number (Benefits has nowhere to keep
  a group number).
- Refusals: no photo recorded (`no_photo`), assessment or photos deleted or
  not the caller's (`not_found`), nothing readable (`unreadable`), plus the
  usual key, cap, timeout and offline answers. A refusal before the model
  call does not count against the cap.
- The phone drops a reading when the case was closed or another case opened
  meanwhile (the sheet unmounts, and `openBenefitsFromCard` checks the open
  case), and fills nothing when the assessment was deleted while it was
  read (it checks the list again before opening the form).
- Daily cap: 30 readings per user (`claim_ai_assist` kind `read_card`). Until
  the migration is applied, the older `claim_ai_assist` refuses the unknown
  kind (`22023`) and the function reads the card without the cap.

**Deploy (Matt)**

1. `supabase functions deploy ai-assist --no-verify-jwt --project-ref ovfafffvcpaahktvlsdm`
   (works on the database as it is: no cap for card reading until step 2).
   It uses `SUPABASE_ANON_KEY` (or `SUPABASE_PUBLISHABLE_KEYS`), which
   Supabase sets for every function; nothing to add.
2. Paste `supabase/migrations/20261121120000_read_card.sql` in the SQL
   editor (ASCII, one BEGIN/COMMIT, safe to re-run) with this as the last
   line before `COMMIT;`:
   `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('20261121120000', 'read_card') ON CONFLICT (version) DO NOTHING;`
3. The phone side ships with the next build (no web change).
4. Check on a device: a finished test assessment with a card photo, Read
   the card into Benefits, check the form, Save.

**Privacy policy:** referralfit.com/privacy may need a line that insurance
card photos are sent to Anthropic, on the practitioner's own key, when the
practitioner chooses to read a card (and that ReferralFit keeps only what
they save: carrier, plan name, last four). Not changed here (the website is
its own repo). Worth a look at the App Store privacy answers too
(insurance details are already collected through the family's page).

**Left out:** the group number and member services phone (Benefits has no
field for them); comparing the card with the family's typed insurance
answers; reading the card before the family finishes.
