# Day review: your recorder fills in ReferralFit

**Status: Phase 1 built (2026-11-08, branch feat/day-review): paste notes,
review, approve. Phase 2, Fieldy and Plaud connected, built 2026-11-08 on
the same branch** (see "Recorders, as built" below). **Share to
ReferralFit and voice notes built 2026-11-21, branch feat/share-voice** (see
"Share to ReferralFit and voice notes, as built" at the end). Background
refresh and push are still the plan. For practitioners who
have added their own Anthropic key (AI drafts). Goal from Matt: "as
automated as possible, the fewer steps for the user the better."

Practitioners who wear a recorder (Fieldy, Plaud) already capture every call
and conversation. Day review reads those conversations, finds what belongs in
ReferralFit (new leads, notes, promised follow-ups, referrals, new contacts),
matches each one to the right case or partner, and saves it with one tap. It
also catches what slipped: a family asked for a call back that never happened,
or a packet that was promised and never sent.

## What the user does

| When | Steps |
| --- | --- |
| Once | **Connect Fieldy**: tap, sign in to Fieldy in the browser sheet, done. Plaud and other apps need no setup. |
| Every day | Nothing. ReferralFit reads new conversations on its own. In the evening, if anything is waiting, one notification: "4 things from today are ready to review." |
| Review | One tap: **Approve all**. Or fix a row, or swipe it away. Nothing is saved before this tap (Matt, 2026-11-08). |

## Sources

1. **Fieldy, connected (automatic).** Fieldy's guidance for an app used by
   other people is OAuth, not a personal API key ("Use OAuth apps when your
   product needs access to other people's Fieldy accounts"). So the user
   never creates or pastes a key. OAuth tokens work with Fieldy's MCP server
   (`https://api.fieldy.ai/mcp`), not the REST API. Scopes:
   `conversations:read` (conversations and their summaries) and
   `transcripts:read`. PKCE is required, access tokens last an hour, and
   refresh tokens rotate. The refresh token lives in the phone's keychain,
   like the Anthropic key. `expo-auth-session` and `expo-web-browser` are
   in Expo's bundled set, and the app already has the `referralfit://`
   scheme for the return trip.
2. **Share to ReferralFit (any app, one tap). Built 2026-11-21.** An iOS
   share extension puts ReferralFit in the share sheet. In Messages, Mail,
   Notes, Voice Memos (its transcript), Otter or a recorder's app: select the
   text, Share, then ReferralFit, and the text lands in the Review notes box.
   The practitioner checks it and taps Find, as for pasted notes; nothing is
   sent on its own.
3. **Voice note. Built 2026-11-21.** "Voice note" on the review screen: right
   after a call, say what happened and it is typed into the box; Stop, edit,
   Find.
4. **Paste.** A text box on the review screen. A fallback for anything else.
5. **Later: push.** Fieldy can call a URL when a conversation finishes (its
   organization webhook, `conversation.completed`, HMAC-signed). Plaud can do
   the same through a Zapier zap ("Transcript & Summary Ready", then a POST
   to a private ReferralFit link). Both land on ReferralFit's server, so they
   belong to the real-time option under "Decisions".

## Recorders, as built (2026-11-08)

Fieldy and Plaud work the same way, through each one's MCP server with
OAuth (`src/lib/fieldy.ts` has both; `src/lib/fieldy-api.ts` the calls).

| | Fieldy | Plaud |
| --- | --- | --- |
| MCP server | `https://api.fieldy.ai/mcp` | `https://mcp.plaud.ai/mcp` (launched 2026-09) |
| Sign-in | `api.fieldy.ai/api/auth/oauth2/*` | `mcp.plaud.ai/authorize`, `/token` |
| Scopes | `openid email offline_access conversations:read transcripts:read` | none named |
| Recordings | `list_conversations` style tool, with summaries | `list_files` (date_from, date_to), then `get_note` per recording for its summary (8 per review) |
| Account shown | userinfo endpoint | `get_current_user` tool |
| Disconnect | revocation endpoint | `logout` tool |

- **Registration:** ReferralFit registered itself once with each, by
  dynamic client registration (both allow it for apps used by other
  people): native public clients (no secret), redirects
  `com.mattbrown.referralfit:/oauth/fieldy` and `…/oauth/plaud`, client ids
  in `src/lib/fieldy.ts`. Nobody registers anything per user.
- **Connect Fieldy** (Review notes): the practitioner signs in to their own
  Fieldy account in the system sheet (PKCE S256, state and issuer checked)
  and approves only `openid email offline_access conversations:read
  transcripts:read`. The refresh token stays in this phone's keychain for
  this account (`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`: never synced or
  backed up), rotates on every refresh (one change to it at a time), and is
  revoked at Fieldy on Disconnect and when the account is deleted. The
  sign-in never reaches ReferralFit's server. The text of a conversation
  does, only for the review: through the `day-review` function, which
  neither stores nor logs it, to Anthropic on the practitioner's own key.
- **Reading:** Fieldy's MCP server, straight from the phone. The list tool
  and its argument names are read from `tools/list` (they mirror the Public
  API's `GET /conversations?startTime&endTime&pageSize&cursor`).
  Conversations not yet reviewed, from the last week at most (the first
  time: since the start of today), oldest first, each under a header
  ("From Fieldy, Nov 9, 2:15 PM · title"), up to the review's 12,000
  characters and three recordings (so one review rarely finds more than the
  20 items it lists; when it does, it reads fewer, below); each summary is kept to 6,000 characters (its start
  and end).
  The rest wait for the next read, as does one still in progress or not
  summarized yet. One with no summary is read from its transcript; one with
  neither a day after it ended is skipped, and the review says so.
- **Review:** the same review as pasted notes. Each item says which
  conversation it came from when only one matches its quote, and a saved
  note keeps that conversation's time on the timeline. Each conversation is
  marked reviewed on its own: once every item from it is saved or switched
  off (on Approve, or when the review is closed), or when nothing was found
  in it. One with an item still waiting (left on, or failed to save) comes
  back next time, as do all of them while an item's quote is in none of
  them. "Done with these" marks them all. Items saved from a recording are remembered with it on
  this phone, as fingerprints (no words), until it is reviewed, so a
  recording read again never offers them twice; an item is taken as saved
  only when its text or summary (with its case or partner, and a
  follow-up's date) matches, or a lead's quote and caller: a phone or a
  quote alone never hides an item. Every call to a recorder gives up
  after 30 seconds (the whole answer, not only its start), and a read can
  be stopped with Close. Which ones were reviewed is kept apart from the sign-in (for 14
  days), so disconnecting and reconnecting never reads them again.
- **Automatic:** when the app opens or comes back (at most every 15
  minutes) it counts new recordings in each connected recorder, never
  reviewing them. Today shows "From your day: N new Fieldy conversations
  (or Plaud recordings) to review"; one tap opens the review and reads the
  one with the most waiting. While some wait, a local reminder, at most one
  a day: "Your recorded conversations are ready to review." (no names). The
  count drops on the phone as soon as recordings are marked reviewed, and
  goes to none when the Anthropic key is removed, so no reminder is left
  behind for recordings already dealt with. It is sent at
  6 PM unless the user picks another time, or turns it off, on the review
  screen (the REMINDER card, shown once a recorder is connected: Earlier and
  Later move it half an hour; Turn off). The choice is kept on the phone per
  account (`src/lib/day-review-reminder.ts`). The reminder is set for the
  next time that hour comes round: today, or tomorrow when it has already
  passed, because recordings are only counted while the app is open.
  Background refresh while the app is closed is not built yet.

## What the AI finds, and what approving does

Every save goes through a path the app already has, through the offline
queue, and is labeled with its source ("From Fieldy, 2:15 PM").

| Found in a conversation | Approving it |
| --- | --- |
| **New lead**: someone asking for help ("a mother called about her son, wants a call back") | `createLead` (the `create_lead` RPC): the caller's name and phone, relationship, the first name of the person they are calling about, source, urgency. The usual first-call follow-up and team notification follow. |
| **Note on a case**: a call or meeting about a family already in ReferralFit | A timeline entry on the case, plus the call logged as a touch (`logContactActivity`), so the case's follow-up rhythm moves. |
| **Note on a partner**: a conversation with a program or professional | A touch on that partner, so its stay-in-touch cadence resets. |
| **Promised follow-up**: "I'll send the packet by Friday" | `createFollowUp` with that due date, on the right case or partner. |
| **Referral**: "I referred the family to Juniper Ridge" / "Harbor Light sent us a family" | The referral history (`referral.insert`), outbound or inbound. Never read by matching. |
| **New contact**: a program director you met | Added as a partner through `import_partners`, matched to the Directory listing when there is one. |
| **Missed opportunity**: asked for a call back with no call logged since | A follow-up for today, marked "Possibly missed". |

## How it works

1. **Fetch.** New Fieldy conversations since the last run: titles, summaries
   and times. A full transcript is read only when a conversation has no
   summary yet; Fieldy writes summaries after the conversation ends.
2. **Extract.** A new Edge Function, `day-review`, built like
   `draft-follow-up`: the key comes in the request body (`anthropicKey`,
   never a header, which platform logs can record), is used for that one
   call, and is never stored or logged. It asks Claude for a
   strict JSON list of items. Each item must quote the line it came from,
   which the review screen shows. Phone numbers and emails must appear in the
   text; the AI never fills them in.
3. **Match on the phone.** The AI returns names, phones and organizations,
   not workspace ids. The phone matches them against the workspace's cases,
   contacts, partners and the Directory, reusing the partner-import matcher
   (`src/lib/partner-import.ts`). The workspace's case list is never sent to
   Anthropic.
4. **Skip what's already there.** A lead the intake form already created, a
   call already logged, a follow-up already set.
5. **Review, then save** (below).

## When it runs, without storing keys on our server

- **When the app opens:** automatically, in the background of the app.
- **iOS background refresh:** `expo-background-task` wakes the app every
  few hours, when iOS allows. Best effort: iOS picks the time.
- **Evening reminder:** a local notification at a time the user picks
  (default 6 PM), only when items are waiting. Generic text, never a name
  on the lock screen. Tapping it opens the review and runs a fresh check
  first.

## The review screen

- A card on Today, "From your day": "2 new leads, 3 notes, 1 follow-up."
- **Approve all** at the top. Each row shows what it is, where it goes (the
  matched case or partner, which can be changed), and the quoted line it
  came from. Tap to edit, swipe to skip.
- When the match is unsure ("Which Sarah?"), the row asks before it can be
  approved.
- Nothing is saved until the user approves it. There is no auto-save, by
  Matt's decision: every item, including notes and follow-ups, waits for
  Approve all or its own tap.

## Guardrails

- The AI never invents contact details, ranks or recommends programs, sets a
  level of care, sends a message, or writes "send us referrals back"
  language (reciprocal referral arrangements can be patient brokering under
  EKRA).
- **Safety:** a mention of immediate danger puts that item first, marked
  urgent, with 911 and 988 shown. The connect screen says plainly that day
  review is not a crisis monitor.
- Each person connects their own recorder. A teammate's conversations
  never reach someone else's review.

## Privacy and consent

- **The connect screen is the consent:**
  - what is read: summaries of your recorded conversations, plus a
    transcript only when there is no summary;
  - where it goes: from Fieldy to your phone, then to Anthropic on your
    key. ReferralFit's server passes it along and never stores it;
  - a check box: "I am responsible for having consent to record the
    conversations my recorder captures." Some states require everyone in a
    conversation to agree to being recorded;
  - the BAA note, as on the AI drafts setup screen;
  - **Disconnect**, which revokes the token.
- **Where things live:** items waiting for review are kept on the phone
  (iOS file protection) and deleted once reviewed, or after 7 days. Saved
  items become ordinary workspace data. Which conversations were already
  read is kept as ids only, no content.
- **Before release:**
  - a new section in the privacy policy: written 2026-11-10 ("Conversation
    recorders (Fieldy and Plaud)", referralfit-web branch feat/day-review);
  - the App Review notes: written 2026-11-10 (`APP_REVIEW.md`, section 3a);
  - a check of the App Privacy answers in App Store Connect (Matt;
    `APP_REVIEW.md`, section 3a).

## Model and cost

- Claude Opus 5.5 (`claude-opus-5-5`), the same model as AI drafts, at low
  effort with structured output. Claude Sonnet 5.5 (cheaper and faster) is an
  option to weigh for Phase 2's background runs; it is Matt's call.
- Billed to the user's own Anthropic account. A day of conversation
  summaries is usually a few cents.
- A daily cap like the drafts' cap, as an abuse guard.

## Build phases

1. **Engine and review screen, with Paste.** The `day-review` function, the
   extraction prompt and schema, matching, dedupe, the review screen, and
   saving. Matt tests it by pasting his own Fieldy summaries. This proves the
   AI and the review before any connection work.
2. **Connect Fieldy and run on its own.** OAuth, reading through Fieldy's
   MCP server, runs on open, background refresh, the evening reminder, and
   the iOS share extension (Plaud and everything else). Needs an iPhone
   build.
3. **Real-time (optional, see Decisions).** Fieldy's webhook and a Plaud
   Zapier link, processed on the server within minutes, with a push
   notification.

Each phase gets the usual bug check, a simulator run and TestFlight before
release.

## To confirm before building

- **Fieldy's MCP tools:** which tools exist (list conversations by date,
  read a summary, read action items), checked by connecting Matt's own
  Fieldy account.
- **Fieldy OAuth:** registering ReferralFit as an OAuth client (Fieldy
  supports client registration), and the redirect back to the app.
- **Fieldy terms:**
  - which Fieldy plan includes API, MCP and webhook access;
  - Fieldy's terms for third-party apps.
- **Plaud:** exactly what the Zapier trigger sends (Phase 3 only).

## Decisions (Matt, 2026-11-08)

1. **No auto-save.** Everything the AI finds waits for the user's approval
   (Approve all, or one row at a time).
2. **Real-time mode: decide after Phase 2.** It would mean keeping the
   user's Anthropic key (encrypted) and Fieldy connection on ReferralFit's
   server, which changes today's promise ("never stored on ReferralFit's
   server") and needs an explicit opt-in and a privacy policy update. Phases
   1 and 2 keep keys on the phone.
3. **Evening reminder: 6 PM by default**, changeable per user, sent only
   when items are waiting.

## Phase 1, as built

| Piece | Where |
| --- | --- |
| Edge Function | `supabase/functions/day-review/` (`index.ts`, `review.ts` prompt + schema + output checks, `review_test.ts`) |
| Daily cap | `supabase/migrations/20261109120000_day_review.sql` (`claim_day_review`, 60 a day; the function runs without it until it is applied), `supabase/tests/day_review_test.sql` |
| Matching, duplicates, writes | `src/lib/day-review.ts`, tests in `scripts/day-review-test.mjs` |
| Calling the function, saving | `src/lib/day-review-api.ts` |
| The sheet | `src/lib/DayReviewSheet.tsx`, opened from Today, "Review notes" (iPhone, where AI keys live) |

What the function checks in the model's answer: a phone number or email
that is not one written in the notes is dropped (each number and address is
read on its own, so digits from two numbers never join); a quote shorter than
four words, or not found word for word (ignoring case and punctuation), marks
the row unverified, and it starts switched off; due dates outside yesterday
to a year out are cleared; a missed promise is due today; a referral whose
direction the notes do not make clear is left for the practitioner; anything
urgent comes first. Notes are capped at 12,000 characters and 20 items, so
the answer comes back inside the function's deadline (no SDK retry); an
answer that stopped at 20 says so (`truncated`, below); text in
the notes that looks like the `<notes>` tags is changed.

How rows are placed (all on the phone, `src/lib/day-review.ts`):

- **A new lead** becomes a note on a case only when the caller's phone or
  email is on exactly one open case. A name alone, or several cases, keeps
  the lead and says "Possibly already a case", with a switch between New lead
  and Note on a case. A closed or lost case never takes the note.
- **The same caller twice** in one review is one lead; the second item goes
  on the case the first creates, and so does a follow-up or note about a
  caller who is new today. Those rows save only after the lead (leads save
  first) and wait if the lead is switched off. Two callers with the same
  name but another phone or email are confirmed first. A "call back" for a
  caller who is new today is the lead's own first call, not a second one.
- **Matched by name only** (a case or a partner, even a full name): the row
  is picked but asks "Yes, this case" before it can be saved. A name or
  organization the notes never mention makes the item unverified (the
  function checks), so it is never saved without a look. Organization names match on
  distinctive whole words ("Juniper Ridge" / "Juniper Ridge Recovery"), never
  on words like Recovery or Center alone.
- **A follow-up** goes on one place, its case or else its partner. With
  several possible cases it waits for a choice or "Not linked". It is a
  repeat when the same task is open there at any date, or when it is a call
  and a call is already open there for about the same day.
- **A referral** asks which way it went when the notes do not say; its client
  label is initials ("AR / L"), since the referral history stays
  de-identified. A referral sent to a program with a license concern waits
  for "Refer anyway", and that is noted on the referral.
- **A new partner** that may already be in the network ("Cascade Detox" for
  "Cascade Recovery Center") offers that partner; tapping it makes the row a
  note on it. The summary is never stored on the partner record.

Saving uses ids chosen when the review is built, so a retry writes the same
records (a follow-up or referral already there counts as saved). A new
partner whose note fails is saved, with a message. Items saved in this
review are switched off if the same notes are read again.

Saving: a new lead goes through `create_lead` with the summary as the case
summary; a case note is a case event (a call, meeting, text or email stamps
the first touch like any logged call); a partner note is a touch; a referral
uses the case title as the client label when a case matched (as program
referrals do), otherwise the practitioner types one; a new partner goes
through `import_partners` (the Directory listing when it matched) and the
row's note becomes its first touch.

### Deploy (Matt)

For the 1.3.0 release, follow the one ordered list in
`docs/FAMILY_ASSESSMENT.md` ("Deploy"): functions first, then the database.
This feature's own parts:

1. Paste `supabase/migrations/20261109120000_day_review.sql` in the SQL
   editor (ASCII, one BEGIN/COMMIT, safe to re-run), with its
   `schema_migrations` row.
2. Deploy the function: `supabase functions deploy day-review --no-verify-jwt
   --project-ref ovfafffvcpaahktvlsdm` (it checks the session itself, like
   `draft-follow-up`).
3. Before the build that carries it ships: add day review to the privacy
   policy on referralfit.com (what is sent, to whom, not stored) and to the
   App Review notes.


## New case from a review (2026-11-20, Matt)

A note, follow-up or referral about a family not in ReferralFit yet: on its
row, under CASE, **+ New case** opens a name field (filled in from the notes,
"Dana Whitfield — son Eli", as a new lead's case is named). **Use this new
case** puts the row on it; the other rows of the review can choose it too
("… (new case)"). Nothing is created until Approve: then each new case that a
row being saved is on is created first (stage Inquiry, no first call added,
since the conversation in the notes was it; a follow-up in 48 hours unless a
follow-up in the review goes on it, so it never has no next step; the person
the notes name, with their phone or email, as its contact), and its rows are
saved on it. A name that is already a case puts the row on that case. A
case that cannot be created leaves its rows unsaved with the reason, and
Approve again retries with the same case id (a repeat that landed is taken as
done). `withPendingCases`, `suggestedCaseTitle` in `src/lib/day-review.ts`.


## Share to ReferralFit and voice notes, as built (2026-11-21, Matt approved)

Branch `feat/share-voice` (from `feat/next-build`). iPhone and iPad only; the
web app has neither (its pages also turn the microphone off).

### What the practitioner sees

**Share.** In Messages, Mail, Notes, Voice Memos, Safari or any app: select
the text (or the whole note, or a link), tap Share, then ReferralFit (the
icon in the row of apps; the first time, it may be under More).

1. ReferralFit opens on Review notes with the text in the notes box. If
   notes were already typed there, the shared text goes below them; it never
   replaces them. A line above it says where it came from when iOS says so (a
   web page's title, a file's name). iOS does not tell an app which app shared
   to it, so plain text has no such line.
2. A message says what happened: "What you shared is in the box. Check it,
   then tap Find what's in it." For a link: ReferralFit reads only the words
   in the box, not the page the link opens. Longer than one review reads
   (12,000 characters, the `day-review` function's own cap): "Only the first
   12,000 characters were kept: that is the most one review reads. Share the
   rest after this review."
3. They tap Find, as for pasted notes. Nothing is sent to the AI until then.
   "+ New case" on a row works as before, so a call about a family not in
   ReferralFit yet can be captured from anywhere.

When it cannot open at once:

| Situation | What happens |
| --- | --- |
| Signed out | "Sign in to review it": it opens once they sign in (kept in memory only, so closing ReferralFit clears it). |
| Face ID lock on | The lock's own cover hides the sheet until they unlock; the text is already waiting. |
| Another screen is open (a case file, a compose sheet) | "It opens in Review notes when you close this screen." It waits for a clear screen, as a notification tap does. |
| Review notes already open | Into the box at once; during a review on screen, it waits until they tap Back to the notes, or everything is saved (then a new review starts with it); during a read, a save or a voice note, it waits for that to finish. |
| Two shares before the first is taken | Each goes into the box in turn, below the last. |
| Shared while one account was signed in, then another signs in | Dropped: it never opens in another account. |
| A photo or another file | "ReferralFit takes text and links from other apps, not photos or other files." |

**Voice note.** On the review screen, next to Paste: **Voice note**.

1. The first time, iOS asks for the microphone and for speech recognition
   (the reasons below). Turned down: an alert says to turn both on in
   Settings > Apps > ReferralFit, with an Open Settings button.
2. "Listening": the words appear in the box as they speak (after any notes
   already there). The box, Paste, Find and the recorder buttons wait.
3. **Stop**: the last words land, and the box can be edited. Then Find.
4. The small print says where the voice goes: "Your voice stays on this
   phone" when the iPhone can turn speech into text itself (most can;
   `requiresOnDeviceRecognition` is then set, so nothing goes to Apple), or
   "Apple turns your voice into text; the sound is not saved" when it cannot.
   The sound is never saved by ReferralFit.

It stops by itself, keeping what was heard, and says why: a phone call, Siri
or an alarm; leaving ReferralFit; a long pause after speaking; no words at
all ("No words were heard"); the box reaching the 12,000 characters one
review reads; or 30 minutes. iOS ends a recognition session on its own now
and then (a pause, or Apple's time limit when its servers do the work): the
note goes on in a new session without a break the practitioner sees (up to
40 times). If speech recognition is off on the phone (Dictation off,
restricted by Screen Time or a work profile, or offline when the phone needs
Apple's servers), it says to check Dictation in Settings > General >
Keyboard.

### Pieces

| Piece | Where |
| --- | --- |
| Share extension (a second iOS target, `ShareExtension`, bundle id `com.mattbrown.referralfit.share-extension`) | `expo-share-intent` 8.0.1 in `app.json`: text (`NSExtensionActivationSupportsText`) and one link (`NSExtensionActivationSupportsWebURLWithMaxCount`); no photos, videos or other files; `disableAndroid` |
| Its name in the share sheet ("ReferralFit", not "ReferralFit - Share Extension") | `plugins/share-extension-name.js` |
| App Group shared by the app and the extension | `group.com.mattbrown.referralfit` (the plugin adds it to both entitlements and to `extra.eas.build.experimental.ios.appExtensions`, which EAS reads for credentials; it must not also be written in app.json, or the plugin stops) |
| Receiving a share | `src/lib/share-receiver.ts` (loads expo-share-intent only on an iPhone build that has its native module and ExpoLinking's) |
| The text rules (cap, source line, appending, messages) | `src/lib/share-intake.ts` |
| Waiting through sign-in, other sheets and account switches | `App.tsx` ("Share to ReferralFit", `pendingShares`) |
| Into the box | `src/lib/DayReviewSheet.tsx` (`incomingShare`) |
| Voice note | `src/lib/voice-note.ts` (`expo-speech-recognition` 57.1.1, through `requireOptionalNativeModule`), button in `DayReviewSheet.tsx` |
| Tests | `scripts/share-voice-test.mjs`; `scripts/mutation-test.mjs` (the usage strings) |

Details that matter:

- **Deep links do not collide.** The extension opens
  `referralfit://dataUrl=referralfitShareKey?nonce=…#text`. The auth handler
  in App.tsx ignores it (no tokens or code: `parseAuthRedirect` is null, and
  the test checks it), and the Fieldy and Plaud returns
  (`com.mattbrown.referralfit:/oauth/…`) come back inside the sign-in sheet,
  not through links. Another app can open that URL too, but it only makes
  ReferralFit read what the extension stored in the App Group (only the
  extension can write there), and that never leaves the box without Find.
- **Nothing shared stays on the phone outside the box.** The share is read
  from the App Group and cleared there at once; a file the extension copied
  (a .txt, or a picture in a shared note) is deleted after reading. The
  pending share is kept in memory only.
- **A shared .txt file** is read when the sending app hands it over as a
  file (up to 512 KB). Some apps hand a .txt over in a way the extension
  cannot read; the share sheet then shows its own error, and copying the text
  works instead.
- **Microphone usage string.** `expo-image-picker`'s `microphonePermission`
  carries the same string as the speech plugin's: `false` there deletes
  `NSMicrophoneUsageDescription` after the speech plugin sets it (checked with
  `expo config --type introspect`), and iOS ends an app that opens the
  microphone without one.
- **Pinned versions.** `expo-linking` 57.0.4 and `expo-constants` 57.0.7 are
  the versions expo 57.0.8 bundles (later 57.0.x versions are what
  `expo install` and expo-doctor ask for; like expo-contacts they are held,
  in `expo.install.exclude`, and `scripts/native-compat-test.mjs` checks it).

### Usage strings (iOS asks with these)

- Microphone: "ReferralFit uses the microphone only while you record a voice
  note in Review notes. What you say becomes text in the notes box. The sound
  is not saved."
- Speech recognition: "ReferralFit turns your voice note into text in the
  notes box. On most iPhones this happens on the phone. If your iPhone cannot
  do it on the phone, Apple turns the sound into text on its servers.
  ReferralFit never saves the sound."

### For Matt: the next iPhone build

The share extension is a second app target inside ReferralFit with its own
bundle id (`com.mattbrown.referralfit.share-extension`), and both it and the
app now use an App Group (`group.com.mattbrown.referralfit`). EAS has no
signing for them yet, so **the first build after this must be run in a
terminal where you can answer questions**, without `--non-interactive`:

```
npx -y eas-cli@21.4.0 build --platform ios --profile production
```

What to expect:

1. EAS lists two targets, ReferralFit and ShareExtension, and asks to log in
   to your Apple Developer account (Apple ID, password, the 6-digit code).
2. It should register the new bundle id
   `com.mattbrown.referralfit.share-extension`, register the App Group
   `group.com.mattbrown.referralfit`, and turn App Groups on for both ids (it
   prints "Syncing capabilities"). If it cannot, add them by hand at
   developer.apple.com > Certificates, Identifiers & Profiles (Identifiers:
   the App Group, then App Groups on both app ids), and run the build again.
3. It reuses the distribution certificate you have and makes a new App Store
   provisioning profile for the extension; the app's own profile is made
   again because it now needs App Groups. Say yes when it offers.
4. The build then runs as usual. After this one, builds can go back to
   `--non-interactive`.

Nothing is needed in App Store Connect for the extension itself (it ships
inside the app). If the build fails with "Credentials are not set up" or a
provisioning profile that lacks App Groups, run it again interactively.

### Before release

- Matt's device test (TestFlight): share a text thread, an email, a Notes
  page and a Voice Memos transcript; share while signed out and while the lock
  is on; a voice note with a call coming in; a voice note longer than a
  minute; turning the microphone off in Settings.
- App Review notes and the App Privacy answers: `APP_REVIEW.md`, section 3b.
- The privacy policy on referralfit.com: add the share extension and voice
  notes to the day review section (what is read, that the sound is never
  saved, that speech is turned into text on the phone or by Apple).

## Bug audit, 2026-11-21

Branch `fix/day-review-audit`. Five findings, all fixed:

1. **A review that stopped at 20 items no longer marks unread recordings
   reviewed.** The model now says when the notes held more than it listed
   (`more` in the output schema); the function answers `truncated: true` then,
   and also whenever it got 20 or more items (`parseReviewAnswer` in
   `review.ts`). A function deployed before this sends no such field: the app
   takes that as not truncated. On the phone, when truncated, a recording
   nothing was listed from is not done on reading, nor on Approve or close
   (`recordingsDoneOnRead`, `recordingsHeld` in `day-review.ts`): it is read
   again next time, and the review says so ("There was more than one review
   can show (20 items). These are the most important. The 2 Fieldy
   conversations with nothing listed here are read again next time.").
   "Done with these" still marks them all, saying that some were not read in
   full. A read now takes at most six recordings (`firstRecordings`), so this
   is rare; the rest wait and are counted.
2. **Editing the box keeps the link to the recordings.** After "Back to the
   notes", the review stays linked to each recording whose text (with its
   header) is still in the box word for word, spacing aside
   (`blocksInNotes`). Notes typed, shared or spoken beside them are read with
   them; a recording edited or deleted there is let go and read again next
   time. A saved item whose quote is in none of the linked recordings is
   remembered on every recording of the read (an edited one may be its
   source), so it is never offered twice. Closing during a read, and reading
   a recorder again, ask first whenever the box holds anything besides the
   recordings (`notesBesides`).
3. **A note saved on a case or partner picked by hand is known again.** Read
   again, a case note, partner note, referral or follow-up with no pick (or
   one made by name only) is checked against each case and partner it could
   be (`savedTargets`); when it was saved on exactly one, it starts switched
   off on that one ("Saved in an earlier review."). Saved on two: switched
   off, with no place picked.
4. After a failed Approve, "Saved: …" is said only when something was saved
   (`savedLine`), never "Saved: Nothing to add."
5. A recording's saved fingerprints past 200 keep the newest 200, each once
   (`mergeFingerprints`); before, the newest were the ones dropped.

Tests: `review_test.ts` (truncated), `scripts/day-review-test.mjs` (the
rules and the wiring).

**For Matt:** finding 1 needs the `day-review` function deployed again
(`supabase functions deploy day-review --no-verify-jwt --project-ref
ovfafffvcpaahktvlsdm`); the rest ships with the next iPhone build. Either
order is safe: the new function with today's app, and the new app with
today's function, both work as before.

### Round 2 (confirming round), branch `fix/day-review-round2`

Six findings, all fixed:

1. **One sentence about two people: saving one never marks the other
   saved.** "Both Sarahs want the Saturday family session", read as two case
   notes with no case picked: once one was saved on Sarah Miller's case, a
   re-read checked the other against Miller's case too, matched the shared
   quote, and showed both as saved; Sarah Chen's note was never offered
   again and the recording was done. Now a case or partner other than the
   row's own pick is matched by the row's text or summary only, never its
   quote (`possibleTargets`, `claims` in `day-review.ts`), and one saved
   signature marks one row of a review only: when two rows match it, the
   closer one (its own pick, its text) is the saved one and the other stays
   as it was (`markSavedBefore`). The sheet takes "decided" from what
   `markSavedBefore` found (`row.savedEarlier`), never works it out again.
   Cost, accepted: two notes on the same case from one sentence, with one
   reworded by the model on the re-read, can bring that one back switched
   on; the practitioner sees it and can switch it off.
2. **No items lost past 20 when every recording got a row.** A read takes at
   most three recordings now (`RECORDINGS_PER_REVIEW`). When a review of
   several comes back stopped at 20 and the box is only the recordings, the
   older half is read again on its own before any row is shown (`olderHalf`,
   at most `NARROWED_READS` = 2 extra reads; with three recordings it is one,
   down to one recording), and the rest wait for the next read. The box then
   holds what was read, and the review says so ("Your 3 Fieldy
   conversations held more than one review can show (20 items), so this
   review reads the oldest conversation on its own. 2 more Fieldy
   conversations wait for the next review."). If that extra read fails, the
   first review is shown. A review of several that still stopped at 20 (notes
   typed beside them, or the extra read failed) holds all of them for the
   next read whatever is saved now (`recordingsHeld`); what is saved is not
   offered again, and the next read takes fewer at a time, so none is held
   forever. A single recording still over 20 is done once its shown rows
   are decided, as before, and the review says a few smaller items may not
   be listed. The "N more wait for the next review" line now always shows
   beside any other message (`waitingLine`).
3. **A failed read keeps which recordings the rows came from.** Find no
   longer clears the link before the request. If it fails (or there is no
   key), a Find again keeps the review on screen linked to its recordings
   still in the box, with those held; a fresh recorder read that failed
   keeps its recordings for a retry and drops the rows of the earlier notes.
   The Discard question says how many recordings are read again next time,
   counted as Discard will settle them (`readAgainLine`).
4. **A new partner or new lead saved as a note is known again.** A new
   partner saved as a note on a partner it may be ("Possibly already in your
   network") and an unchecked new lead saved as a note on a case it may be
   are checked there too, by their wording, and come back as that note,
   switched off.
5. **`truncated` comes from the count alone** (20 items): the model's own
   `more` flag is gone from the schema and the prompt; under 20 it could only
   be a false alarm that held recordings for nothing. On the phone, a
   truncated answer with no items is taken as not truncated.
6. A row moved to the case it was saved on is set the way the row's own
   pickers set it (`chooseCase`, `choosePartner`): a referral's automatic
   client label follows that case.

Tests: `scripts/day-review-test.mjs` (round 2 checks, the two-Sarahs
scenario among them), `review_test.ts` (truncated by count, no `more`).

**For Matt:** finding 5 changes the `day-review` function (deploy it with
the round 1 change: `supabase functions deploy day-review --no-verify-jwt
--project-ref ovfafffvcpaahktvlsdm`); the rest ships with the next iPhone
build. Either order is safe. Until it is deployed, a round 1 function can
still send a false `truncated` under 20 items: the phone then reads fewer
recordings, or holds them one read longer; nothing is lost or settled
unread. A function from before round 1 sends no `truncated` at all.

### Round 3, branch `fix/day-review-round3`

Four findings, all fixed:

1. **A narrowed review keeps the urgent items already found.** When a review
   of several recordings stopped at 20 and was read again with the older
   half, what the first review had found in the recordings set aside was
   thrown away, urgent items included ("she's not safe tonight, call her back
   by 6" waited for another review). Now every urgent item of the first
   review whose quote is in a recording set aside (or in none) is shown with
   the narrowed review, unless that review found it too (`carriedUrgent`,
   `sameFinding` in `day-review.ts`), and the review says so ("1 urgent item
   already found in the Fieldy conversations that wait is shown here too.").
   Each is tied to the set-aside recordings it is from: its save is
   remembered on them, so it is not offered again when they are read, and
   they are not this review's recordings, so they are never settled here and
   are read in full next time. Once everything in a review is decided and
   recordings wait (set aside, or beyond this read), the sheet offers "Read
   the next N now": the decided recordings are marked done (written before
   the next read looks), then the next read runs in the same opening. It
   runs only on a tap.
2. **Notes worded alike, one saved on each case, each go back to their own
   case.** Round 2 gave each saved signature to the closest row, so with two
   identical case notes ("Wants the Saturday family session.", both about
   "Sarah", choices Miller and Chen), one saved on each, the first row took
   both cases (and showed no case) and the second came back switched on.
   Now saved places and rows are matched one to one (`assignSaved`): the
   closest claims first; a row that takes a place lets go of its other
   claims, and the signatures it took there are nobody else's. Between
   equals, the row with fewer places left goes first, then the place fewer
   rows want, then the first row, so the result does not depend on the
   order. A row that alone matches two saved places is still saved with no
   place guessed (round 1).
3. **Cancel during a recorder read asks about that read.** The read in
   progress is kept on its own (`inFlightRef`): while recordings are being
   fetched, or the box is just them, Cancel closes without asking; with
   notes typed beside them, the Discard question counts that read's
   recordings, never the previous review's.
4. **A read that fails no longer blocks the queue.** A read of several
   recordings, with only the recordings in the box, that came back
   incomplete (`max_tokens`), was turned down, or took too long (the
   function's `timeout`, or the phone's own) is read again with the older
   half, down to one, sharing the extra-read budget (`NARROWED_READS`) with
   the cap narrowing; the rest wait (`failedForLength` in
   `day-review-api.ts`; the function's error code now reaches the phone).
   After any failed recorder read the box offers "Done with these: don't
   read them again", with a confirm that says they are not offered again and
   that anything not saved from them is not saved (notes typed beside them
   stay in the box). A single recording whose review fails on its own is
   remembered on the phone (`unreviewable` in the read state,
   `rememberReviewFailed`): from then on it is read alone, and only when
   nothing else is new (`failedApart`), counted with those waiting, so it
   never holds newer recordings back; "Read the next N now" brings it up
   after the others are decided. The existing one-day give-up clock does not
   cover this: it is only for a recording whose summary or transcript cannot
   be fetched from the recorder (the recorder answering with an error), and
   never for a review that failed. A recording that fails alone is not given
   up by itself either, so nothing is dropped unread without the
   practitioner choosing "Done with this"; until then it keeps counting on
   Today and in the reminder (and, like any recording not reviewed, falls out
   of the 7-day look-back after a week).

Tests: `scripts/day-review-test.mjs` (round 3 checks: the two Sarahs both
saved, one saved, either order; carried urgent items; Cancel during a read;
failure narrowing, "Done with these", `failedApart`), `scripts/fieldy-test.mjs`.

**For Matt:** nothing new to deploy for this round: the `day-review`
function is unchanged (the error codes it already sends, live on main too,
are read now; the round 1 and 2 deploy above still stands); everything
ships with the next iPhone build. Each narrowed read is one more review against the day's cap
(at most two extra per Find). Not tried on a device: a read that fails for
its length, and "Read the next N now".

### Round 4, branch `feat/fieldy-web`

Six findings (an audit of 9125f2a), all fixed:

1. **A long recording whose review failed on its own no longer blocks the
   newer ones.** It was set aside only after the review was planned, so it
   had already taken the room (a review holds about 11,500 characters, each
   recording up to 6,000): the newer long ones waited behind it, and the plan
   then read it alone, every time. Now recordings marked `unreviewable` are
   set aside before the plan (`apartFromFailed` in `day-review.ts`), counted
   as waiting, and one is read alone only when nothing else can be read
   (`planAroundFailed`).
2. **"Read the next N now" only when every row is decided**, on Done as on
   the review. On Done it showed with a row still undecided (one switched off
   because it was not found word for word), and the next read skipped the
   close question, so nothing was settled and the same oldest recordings
   were read again (another model call). `readNext` also refuses past an
   undecided row. After a review that stopped at its cap the button says it
   reads the held ones again ("Read the 2 conversations not read in full
   again now").
3. **Two recordings that failed alone take turns.** The mark is now
   "<since> <last tried>" (`failedMark`, `lastTried`); each failure refreshes
   the last-tried time and the one tried least recently goes next. Older
   marks (one time) still read.
4. **One slow moment is not held against a recording.** The phone giving up
   waiting is now its own code (`phone_timeout`, apart from the function's
   `timeout`); it still narrows a read of several, but never marks one read
   alone as unreviewable (`failedForLength(error, true)`). A review of a
   recording that comes back clears its mark (`reviewCameBack`).
5. **Urgent items carried from set-aside recordings come back** after "Back
   to the notes", then Find again: they are kept with the read
   (`carried`, `carriedFrom`), still tied only to the recordings set aside.
6. Web wording: when the browser will not hand over the clipboard, Paste
   says to click in the box and press Cmd+V (Ctrl+V on Windows); the phone
   keeps "Long-press the box". The Today card's "Review notes" line on the
   web no longer promises Plaud.

Tests: `scripts/day-review-test.mjs` (round 4 checks, with the long
recordings case).

**For Matt:** nothing to deploy; it ships with the next iPhone build and the
next web deploy.
