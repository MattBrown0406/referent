# Day review: your recorder fills in ReferralFit

**Status: plan, not built (2026-11-08).** For practitioners who have added
their own Anthropic key (AI drafts). Goal from Matt: "as automated as
possible, the fewer steps for the user the better."

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
2. **Share to ReferralFit (any app, one tap).** An iOS share extension puts
   ReferralFit in the share sheet. In Plaud, Otter, Voice Memos, Mail or Notes:
   Share, then ReferralFit, and the text goes straight into the review.
   This is how Plaud users get it until Plaud has an API.
3. **Paste.** A text box on the review screen. A fallback for anything else.
4. **Later: push.** Fieldy can call a URL when a conversation finishes (its
   organization webhook, `conversation.completed`, HMAC-signed). Plaud can do
   the same through a Zapier zap ("Transcript & Summary Ready", then a POST
   to a private ReferralFit link). Both land on ReferralFit's server, so they
   belong to the real-time option under "Decisions".

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
   `draft-follow-up`: the key comes in the `x-anthropic-key` header, is used
   for that one call, and is never stored or logged. It asks Claude for a
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
  - a new section in the privacy policy ("Conversation recorders and notes
    you share");
  - a line in the App Review notes;
  - a check of the App Privacy answers in App Store Connect.

## Model and cost

- Claude Sonnet 5.5 (`claude-sonnet-5-5`) for extraction: fast enough to
  finish inside a background refresh, and cheaper than Opus. AI drafts stay
  on Opus 5.5.
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
