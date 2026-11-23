# App Store review runbook

How ReferralFit gets through App Review, and what to paste into App Store
Connect. Written after the 2026-09-16 rejection of 1.0.2 (2) under
Guideline 2.1 (demo account) and 2.1(b) (business model).

## Links (privacy, terms, support)

referralfit.com is the only home for ReferralFit's legal and support pages
(website repo `MattBrown0406/referralfit-web`). Use these everywhere:

| Where | URL |
| --- | --- |
| App Store Connect → App Information → Privacy Policy URL | `https://referralfit.com/privacy` |
| App Store Connect → version → Support URL | `https://referralfit.com/support` |
| App Store Connect → version → Marketing URL | `https://referralfit.com` |
| Description footer | Privacy Policy, Terms of Use (EULA) and Support at the three URLs below |
| The app (`src/lib/privacy.ts`: sign-in screen and Workspace) | `https://referralfit.com/privacy`, `https://referralfit.com/terms` |

Description footer:

```
Privacy Policy: https://referralfit.com/privacy
Terms of Use (EULA): https://referralfit.com/terms
Support: https://referralfit.com/support
```

The old copies redirect there: `mattbrown0406.github.io/referent/privacy.html`
and `support.html` (`docs/`, kept as redirects because app versions before
1.2.0 open the GitHub privacy page; delete them and turn GitHub Pages off once
no one runs those versions) and `freedominterventions.com/referralfit/privacy`
and `/terms`.

## 1. Demo account (Guideline 2.1)

The rejected submission listed `reviewer2apple.com` — not a valid address and
not an account that exists in Supabase. Reviewers need a real, dedicated
account with enough sample data to exercise
every screen.

1. **Supabase → Authentication → Users → Add user → Create new user.**
   - Email: `appreview@freedominterventions.com` (or change `v_email` in the
     seed script to whatever you use)
   - Password: long and random; keep it in App Store Connect only.
   - Tick **Auto Confirm User**.
2. **Supabase → SQL Editor** → paste `supabase/preflight/app_review_demo_account.sql`
   → Run. It seeds nine partners, four cases, referrals, touches, and a Today list,
   and the 1.1.0 features: on the Nguyen case, a level-of-care assessment, the
   family's plan benefits with three programs' benefits answers (so "True cost
   to the family" shows estimates), and a placement request from the saved
   match to four programs (three answered, one waiting; Today → Placement
   requests, or Match → Program answers); verified credentials on four
   programs (Basalt Canyon has no LegitScript on file, Juniper Crest has none);
   and a referral handoff the program has moved to "family reached"
   (Referrals → Handoffs). The placement request is open for 48 hours from the
   run, so run it close to submission.
   Re-run it any time to reset the reviewer workspace; it refuses to touch a
   workspace that has any other member.
3. **Sign in once yourself** on a device with those credentials and tap
   through the tabs (Home, Match, Cases, Directory, Referrals), the Business
   dashboard, and Workspace and settings (the gear icon at the top of the
   screen). The sample partners are complete, so partner detail shows **Submit
   to directory**. If a reviewer taps it, an `example.com` listing lands in
   Workspace and settings → *Directory submissions*; reject it
   (`docs/DIRECTORY_SUBMISSIONS.md`).
4. **App Store Connect → App Information → App Review Information.**
   - Sign-in required: **on**
   - User name / Password: exactly what you created (copy-paste, watch the `@`)
   - Notes: see §3.

Never commit the password. The seed script does not contain it.

## 2. Business-model reply (Guideline 2.1(b))

Facts the answer rests on (all verifiable in this repo):

- The app is free. `public.free_launch_period()` returns `true`
  (`supabase/migrations/20260918230000_free_launch_period.sql`), so every
  workspace has every feature. No plan tiers are shown, sold, or gated.
- Sign-in is email/password. The sign-in screen also offers self-serve
  "Create account" (practice name, your name, email, password) and "Forgot
  password?" (`src/lib/LoginScreen.tsx`). Accounts are free.
- In-app account deletion (guideline 5.1.1(v)): Workspace and settings (the
  gear icon at the top of every screen) → "Delete account…" → two
  confirmations → `public.delete_own_account()` RPC deletes
  the auth user (and the whole workspace when the user is its sole owner).
  See `docs/SELF_SERVE_ACCOUNTS.md`.
- `react-native-purchases` is **not** installed. No RevenueCat products,
  prices, paywalls, or external purchase links exist anywhere in the app.
- Square and PandaDoc references are optional record links a practice can
  attach to its *own* client cases (their own invoices and agreements). They
  are not a way to pay ReferralFit.

Suggested reply — paste into the App Store Connect message thread:

> Thank you for the review. Answers to the business-model questions:
>
> **1. Who are the users of the paid content/features?** There are none.
> ReferralFit is free. Every feature in the app is available to every
> account, and there are no paid tiers, subscriptions, or purchasable
> content.
>
> **2. Where can users purchase them?** Nowhere — nothing is sold in the
> app or outside it. The app contains no prices, paywalls, or links to any
> purchase.
>
> **3. What previously purchased content can be accessed?** None. No
> content or feature has ever been sold for this app.
>
> **4. What paid content is unlocked without In-App Purchase?** None. All
> functionality is free for every account. One optional feature, AI-drafted
> follow-up messages, can use the practitioner's own API key from a
> third-party AI provider (Anthropic), which they obtain and manage with that
> provider directly. ReferralFit does not sell, resell, or receive payment for
> it, and the app links to no purchase.
>
> **5. Are the enterprise services sold to single users, consumers, or for
> family use?** No enterprise services are sold. ReferralFit is a free
> business tool for licensed addiction-intervention practices; it is not
> offered to consumers or families.
>
> **6. How do users obtain an account? Is there a fee?** Anyone can create an
> account from the sign-in screen ("Create account") at no charge, and can
> delete it in the app (Workspace and settings, the gear icon at the top of
> the screen). ReferralFit also sets up accounts for a
> practice's staff on request. There is no fee to create an account or to use
> the app. The demo account provided in App
> Review Information has full access to every feature.

If a reviewer asks about the "Square" and "PandaDoc" labels on a case: those
are optional links to a practice's *own* client invoices and agreements in
tools the practice already uses. They are not a way to pay ReferralFit, and
the app never collects payment details.

## 3. Notes for the reviewer (App Review Information → Notes)

Current text for 1.0.4 (2). Fill in the demo password from App Store Connect;
never write it here.

> ReferralFit is a free B2B tool for addiction-intervention practices. It is
> not offered to consumers or families. Nothing is sold in the app: no
> subscriptions, in-app purchases, or links to outside purchase.
>
> DEMO ACCOUNT: use the credentials in App Review Information. The demo
> workspace has sample data (fictional families and programs) and access to
> every feature. Sign in on the first screen with that email and password.
>
> ACCOUNT CREATION: the sign-in screen also offers "Create account" (practice
> name, your name, email, password). New accounts are free and get their own
> private workspace immediately. "Forgot password?" sends a reset link that
> opens the app.
>
> ACCOUNT DELETION (5.1.1(v)): tap the gear icon at the top right of any
> screen (Workspace and settings) → scroll to "Delete account…" → two
> confirmations. This deletes the sign-in and, for a sole owner, the whole
> workspace. Please do not delete the demo account; create a throwaway account
> if you want to test deletion.
>
> SHARED DIRECTORY: the Directory tab lists treatment programs and
> professionals. A practice can submit one of its own partners for review;
> submissions are checked by ReferralFit staff before they appear. If you tap
> "Submit to directory" in the demo account, it goes to our review queue and
> is discarded.
>
> The "Square" and "PandaDoc" labels on a case are optional links to a
> practice's own client invoices and agreements in tools it already uses.
> They are not a way to pay ReferralFit, and the app never collects payment
> details.
>
> FOLLOW UP / AI DRAFTS (optional): the Follow up button (on the Home tab, a
> case, or a partner) gives a ready draft to edit and send from the iPhone's own Messages
> or Mail; it works without any setup. "Draft with AI" is optional and uses
> the practice's own Anthropic API key, which the user creates under their
> own Anthropic account and adds in the app. ReferralFit sells nothing and receives no
> payment for it. Before a key is added, the app explains exactly what is
> sent to Anthropic. Trying "Draft with AI" needs your own Anthropic key;
> every other part of Follow up works without one.
>
> Notifications are optional and asked for only after the user taps to turn
> them on. Reminders (daily briefing, follow-up cadence, consults) are
> scheduled on the device and show only generic text, never client, family,
> or program names.
>
> NEW LEAD: "New lead" on the Home tab is a quick form for a practice to
> record an inbound call (name and phone are enough); the lead then shows
> under NEW LEADS with a clock until the practice calls back. It involves no
> payment and no account.

### 3a. Additions for 1.3.0 (day review, recorders, family assessment)

Add these paragraphs to the Notes for 1.3.0, after the FOLLOW UP / AI DRAFTS
paragraph:

> REVIEW NOTES / FIELDY AND PLAUD (optional): "Review notes" on the Home tab
> lets a practitioner paste their own call notes; the app lists the leads,
> notes and follow-ups it finds, and nothing is saved until the user approves
> each item. Like "Draft with AI", it uses the practice's own Anthropic API
> key and needs one to try; ReferralFit sells nothing and receives no payment
> for it. With a key added, the same screen offers "Connect Fieldy" and
> "Connect Plaud". These are third-party voice recorders some practitioners
> already own. Connecting is optional and uses the recorder's own sign-in
> page (OAuth, in the system browser sheet); the app then reads the user's
> own recordings so they do not have to paste them. The sign-in is stored
> only in the iPhone's keychain and is removed with "Disconnect" or when the
> account is deleted. A Fieldy or Plaud account is needed to try it; every
> other part of the app works without one. ReferralFit does not record audio
> and does not use the microphone.
>
> EXPLAIN TO THE FAMILY: on the Match tab, after running a match, "Explain to
> the family" writes why the programs fit, in the app's own order, to send by
> text or email. It works without any setup.
>
> FAMILY ASSESSMENT: on a case, "Family assessment" sends the family a
> private link to an intake form on portal.referralfit.com. The family
> reads and signs a consent statement before sending, and their answers
> appear on the case. To try it, enter an email address you can open.

**App Privacy answers (App Store Connect → App Privacy) to check for 1.3.0.**
What changed in what the app handles:

- **Audio Data: still not collected.** The app never records and never
  reads audio; it reads text (summaries and transcripts) from the user's own
  recorder account, on the device.
- **Other User Content** (already declared for case notes): recordings' text
  is sent to Anthropic for one review through our server and is not stored.
  It is covered by the same answer as AI drafts; no new data type, and it is
  not used for tracking.
- **Health and sensitive information:** the family assessment collects
  health information, insurance member ID and date of birth from families
  through the portal, stored for the practice. If "Health" and "Sensitive
  Info" are not yet declared as collected (linked to the user, App
  Functionality, not for tracking), add them.
- **Photos:** insurance card photos are uploaded by families in the portal
  (a web page), not by the app. No change for the app.
- **Email Address:** the recorder account's email is kept on the device only
  (not collected). The family's email for the assessment invite is "Other
  contact info" entered by the practitioner, as case contacts already are.

**What's New in This Version (1.3.0):**

```
New in 1.3

- Review notes from your day. Paste your call notes, or connect a Fieldy or Plaud recorder, and ReferralFit lists the new leads, notes, follow-ups and referrals it finds. You approve each one before anything is saved. Uses your own Anthropic key.
- A reminder when recordings are waiting for your review, at the time you choose.
- Explain to the family. After a match, get a plain-language note on why these programs fit, ready to send by text or email.
- Family assessment. Send a family a private intake link; their answers appear on the case. With your Anthropic key, ReferralFit can suggest level-of-care ratings from their answers for you to confirm.
- Practice logo. Add your logo and families see it on the assessment.
- Fixes and improvements.
```

If email confirmation is turned on in Supabase before the review, add:

> Creating an account sends a confirmation email; the demo account is already
> confirmed and needs no email step.

### 3b. Additions for the next build (share to ReferralFit, voice notes)

Change the last sentence of the REVIEW NOTES paragraph in 3a ("ReferralFit
does not record audio and does not use the microphone.") to the paragraph
below, and add it to the Notes:

> SHARE TO REFERRALFIT AND VOICE NOTES (optional): ReferralFit now appears in
> the iOS share sheet. Select text in Notes, Messages or Mail, tap Share, then
> ReferralFit: the app opens on "Review notes" with the text in the box, and
> nothing is sent anywhere until the user taps "Find what's in it" (which,
> like the rest of Review notes, needs the practice's own Anthropic key). On
> the same screen, "Voice note" types what the user says into the box using
> iOS speech recognition, on the device when the iPhone supports it. The
> microphone is used only while a voice note is being recorded, and the audio
> is never saved or sent by ReferralFit. Both work without a key: the text
> lands in the box either way.

**App Privacy answers to check (App Store Connect > App Privacy):**

- **Audio Data: still not collected.** The microphone turns speech into text
  on the iPhone (or, on an iPhone that cannot do that, by Apple's speech
  service, which Apple runs under its own terms); ReferralFit never receives,
  stores or sends the sound.
- **Other User Content:** shared text and voice-note text are notes like
  pasted ones: sent to Anthropic for one review only when the user taps Find,
  not stored. Covered by the existing answer; no new data type.

**What's New in This Version (add):**

```
- Share to ReferralFit. Share a text thread, an email, a Voice Memos transcript or a note from any app, and it opens in Review notes, ready to review.
- Voice notes. Right after a call, say what happened and ReferralFit types it into Review notes for you to check.
```

### 3c. As submitted: 1.4.0 (1), 2026-11-22

1.3.0 never went to App Review, so 1.4.0 carries everything since 1.2.
Submitted through the App Store Connect API (release: automatically after
approval). Contact and demo account copied from 1.2; screenshots carried
over (10 iPhone 6.5", 10 iPad 13").

**Promotional text**

```
Your recorder fills in ReferralFit: a day of calls becomes leads, notes and follow-ups you approve. Plus a family intake that comes back ready to match. All free.
```

**What's New**

```
Review notes from your day
• Paste your call notes, connect a Fieldy or Plaud recorder, share text from any app, or say a quick voice note. ReferralFit lists the new leads, notes, follow-ups and referrals it finds, and you approve each one before anything is saved. Uses your own Anthropic key.
• A conversation about a family you haven't entered yet? Tap "+ New case" right on the row.
• An optional reminder, at the time you choose, when recordings are waiting.

Family assessment
• Send a family a private intake link in your practice's name, with your logo. Their answers come back to the case.
• See matches from their answers: Match opens already filled in, with a note on where each field came from.
• Case brief for programs: a short, de-identified summary for an admissions team, ready to share or add to a referral packet.
• Read the insurance card into Benefits, for you to check before saving.
• Start the level-of-care rating from an AI suggestion that you confirm.

Explain to the family
• After a match, get a plain-language note on why these programs fit, in your order, ready to send.

Also
• Many reliability fixes.
```

**Notes for the reviewer**

```
ReferralFit is a free B2B tool for addiction-intervention practices, not offered to consumers or families. Nothing is sold in the app: no subscriptions, in-app purchases, or links to outside purchase.

DEMO ACCOUNT: use the credentials in App Review Information. The demo workspace has fictional sample data and every feature. Sign in on the first screen.

ACCOUNT CREATION: "Create account" on the sign-in screen (practice name, your name, email, password). Free. "Forgot password?" sends a reset link.

ACCOUNT DELETION (5.1.1(v)): gear icon at the top right (Workspace and settings), "Delete account…", two confirmations. Please do not delete the demo account; create a throwaway account to test deletion.

NEW IN 1.4.0:
• REVIEW NOTES (Home tab): paste call notes; the app lists the leads, notes and follow-ups it finds, and nothing is saved until the user approves each item. It runs on the practice's own Anthropic API key (Workspace and settings, AI drafts), so a key is needed to try it; ReferralFit sells nothing and receives no payment for it. "+ New case" on a row creates a case for a family not yet entered.
• FIELDY AND PLAUD (optional): third-party recorders some practitioners own. "Connect" opens the recorder's own sign-in page (OAuth in the system browser sheet); the app then reads the user's own recordings' text. The sign-in stays in the iPhone's keychain and is removed with "Disconnect" or account deletion. A Fieldy or Plaud account is needed to try it.
• SHARE TO REFERRALFIT: ReferralFit appears in the iOS share sheet. Select text in Notes, Messages or Mail, tap Share, then ReferralFit: the app opens on Review notes with the text in the box. Nothing is sent until the user taps "Find what's in it".
• VOICE NOTE (Review notes): types what the user says into the box with iOS speech recognition, on the device when the iPhone supports it. The microphone is used only while a voice note is recording; ReferralFit never saves or sends the audio.
• FAMILY ASSESSMENT: on a case, "Family assessment" sends the family a private intake link on portal.referralfit.com (enter an email you can open to try it). The family signs a consent before sending; their answers appear on the case. From a finished assessment: "See matches from these answers" fills in Match; "Case brief for programs" makes a de-identified summary the practitioner shares; "Read the card into Benefits" (needs the key and a card photo the family uploaded) reads the insurer, plan and last four of the member ID for the practitioner to confirm; an AI suggestion can start the level-of-care rating.
• EXPLAIN TO THE FAMILY (Match tab, after a match): a plain-language note on why the programs fit, to send by text or email. No setup.

FOLLOW UP / AI DRAFTS (optional): "Follow up" gives a ready draft to send from the iPhone's own Messages or Mail, no setup. "Draft with AI" uses the same Anthropic key.

NOTIFICATIONS are optional, requested only after the user turns them on, and use generic text without client, family or program names.

SHARED DIRECTORY: submissions are reviewed by ReferralFit staff; one from the demo account goes to our queue and is discarded.

The "Square" and "PandaDoc" labels on a case are optional links to a practice's own client invoices and agreements, not a way to pay ReferralFit.
```

**Description**

```
ReferralFit is the working notebook of a professional intervention practice. It keeps the people, programs and promises of this work in one place, so no family waits on a call that was forgotten and no referral partner goes cold.

Built by an interventionist with 22 years in the field, for the practices doing this work every day.

TODAY
Open the app and see what is due: new leads to call back, consults on the calendar, beds to confirm, follow-ups you owe, and programs that have answered your placement requests. Overdue items rise to the top.

REVIEW NOTES FROM YOUR DAY
Paste your call notes, connect a Fieldy or Plaud recorder, share text from any app, or say a quick voice note. ReferralFit finds the new leads, case notes, follow-ups and referrals in it, matched to your cases and partners, and you approve each one before anything is saved. Runs on your own Anthropic account.

FAMILY ASSESSMENT
Send a family a private intake link in your practice's name. Their answers, a signed consent and their insurance card come back to the case. From there, open Match already filled in from their answers, share a de-identified case brief with a program's admissions team, and read the insurance card into the family's benefits.

MATCHING
Describe what a family needs, and ReferralFit ranks your partners by level of care, location, insurance, budget and therapy fit. Explain the order to the family in plain words, ready to send. Save the match to the case so the reasoning stays with the family.

PLACEMENT REQUESTS
Instead of calling programs one by one, send one de-identified request to several of your ranked programs and compare their answers side by side: whether they can admit, how soon, and the daily rate. Programs cannot pay to be asked, and their answers never change your rankings.

LEVEL OF CARE
A short, structured assessment across six areas recommends a level of care and writes out the rationale. You choose the level to place at, and the reasoning goes into the program's copy of the placement packet.

TRUE COST TO THE FAMILY
Record the family's deductible, out-of-pocket maximum and coinsurance, and see an estimate of what a placement would cost them. Always labeled an estimate, never shared with programs, and never used to rank.

PROGRAM INTEGRITY
Before you refer, see whether a program's state license, accreditation, LegitScript certification and NPI are on file and current.

CASES
One record per family: contacts, the timeline of calls and emails, documents, and the next step with a date on it, from first call through consult, intervention, placement and aftercare.

FOLLOW UP
Every case and partner gets a follow-up rhythm. Tap Follow up for a ready draft to text, email or call, sent from your own Messages or Mail. Optional AI drafts run on your own Anthropic account.

REFERRALS AND HANDOFFS
Track referrals sent and received. Send a program a private handoff link: they mark each step, from received to consult scheduled, and your reminder moves with them.

DIRECTORY
A shared, reviewed directory of treatment programs and professionals, open to every workspace. Submit a listing from your own partner list; nothing about your practice or your clients is shared.

TEAM
Invite colleagues into your workspace so everyone works from the same plan.

PRIVATE BY DESIGN
Your workspace belongs to your practice alone. Other practices using ReferralFit cannot see your partners, cases or notes. Lock the app with Face ID, and a cover keeps your cases out of the app switcher. Data syncs over an encrypted connection.

FOR PROFESSIONALS
ReferralFit is free for intervention practices, treatment-placement specialists and family coaches. Create your practice's account in the app. It is not a crisis service. If someone is in immediate danger, call 911; for a mental-health crisis, call or text 988.

Privacy Policy: https://referralfit.com/privacy
Terms of Use (EULA): https://referralfit.com/terms
Support: https://referralfit.com/support
```

## 4. What changed in the app for the resubmission

- The app is free: a database switch (`free_launch_period()`) opens every
  feature for every workspace. No plan tiers, prices, "Not active" badges, or
  upgrade prompts remain anywhere in the app.
- First launch shows a welcome sheet stating that the workspace is private to
  the practice, what (little) is shared, and that the app is free. The same
  statement lives permanently on the Workspace screen.
- Login placeholder is generic (`you@yourpractice.com`) instead of the
  founder's real address; footnote explains accounts are set up per practice
  at no charge and data is private.
- Square/PandaDoc case links are labelled optional and no longer promise
  automatic status updates (those are wired to one practice today).
- iOS build number bumped to 3.
- CI replays the demo seed (twice, for idempotency) against a clean local
  Supabase so the script cannot drift from the schema.
