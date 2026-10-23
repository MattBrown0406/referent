# Follow-up outreach: timelines, AI drafts, and the 48-hour rhythm

A new case or referral partner gets a follow-up timeline. When a step comes
due, the practitioner taps **Follow up**, picks text, email, or call, starts
from a ready draft (or asks the AI for one), edits it, and sends it from the
phone's own Messages or Mail (or dials). Once it is sent, or the call is
logged, the step is closed, the outreach is on the timeline, and the next
follow-up is set for 48 hours later.

AI drafts are **bring your own key**: ReferralFit is free, so each
practitioner adds their own Anthropic API key in the app, and drafts run on
(and are billed to) their own Anthropic account. ReferralFit holds no
Anthropic key and pays for no one's drafts.

Nothing in this document is applied automatically. The migration and the
`draft-follow-up` function are separate steps, listed under **Deploy**.

## What the user sees

- **Today**: every case- or partner-linked card has a ✦ button next to
  Call and Text. It opens the outreach sheet on that step.
- **Case file**: the "Next steps" card is now **Follow-up timeline**. It
  shows the last few calls, texts, and emails, then the open steps with their
  due time, and adds a **Follow up** action. Each contact row has a
  **Follow up** action that opens the sheet addressed to that person.
- **Partner profile**: a **Follow up** action, and a **Next follow-up** line
  under "Staying in touch".

The sheet:

1. **To** (when the case has several contacts) and **How**: Text, Email, or
   Call. A channel the recipient has no number or address for is disabled.
   The suggestion varies the channel (a first call is a call; after a call,
   a text; after a text, an email).
2. A plain, discreet starting draft is already filled in, so the
   practitioner can send without the AI at all.
3. **Anything to mention?** (optional) and **✦ Draft with AI**. With no key
   on the phone yet, **Turn on AI drafts** explains that drafts run on the
   user's own Anthropic account, says exactly what is sent and to whom (App
   Review guideline 5.1.2(i)), links to the Anthropic Console to create a
   key, and takes the pasted key. The key is checked with Anthropic (a free
   model-list call) before it is saved; saving it is the user's agreement.
   **Workspace → AI drafts** shows the saved key masked (`sk-ant-…a1B2`)
   with Replace and Remove.
4. The draft is editable. **Open in Messages** / **Open in Mail** presents
   the iOS compose sheet with the recipient and the message filled in;
   **Call** dials and shows the opener, talking points, and voicemail.
5. After sending:
   - Messages and Mail compose sheets report **sent** or **cancelled**.
     Sent is logged at once; cancelled (or saved as a draft) logs nothing.
   - Where the app had to hand off with a link instead (no Mail account set
     up, so the default mail app opens; or an older binary; or Android), it
     asks **Did it go out?** and logs only on Yes.
   - A call asks **How did the call go?** (talked / voicemail / no answer)
     and logs the call with the result.
6. The confirmation shows the next follow-up, e.g. "Sat, Oct 25 · 3:15 PM".

## The timeline rules (`src/lib/outreach.ts`)

| Event | What is created |
| --- | --- |
| New case, stage **inquiry** (case form, New lead, intake link) | The existing first call, due today (unchanged). |
| New case, any other open stage | "Follow up — {case}" due 48 hours later. |
| New case, **closed** or **lost** | Nothing. |
| New partner (added by hand or from the directory) | "Follow up — {organization}" due 24 hours later. |
| A text or email sent, or a call logged, from the sheet | The step it came from is marked done (or, when opened from the case file or profile, the earliest open call / follow-up / touch step for that case or partner due by the new date). A case event or partner touch is logged. "Follow up — {case or organization}" is created due exactly 48 wall-clock hours after the send (3:15 PM → 3:15 PM two days later, across daylight-saving changes too). |

The timeline is rolling: one open outreach step at a time, so a family who
answers is never sitting on a pile of pre-scheduled texts. A consult, a
waiting-on item, or an outcome check-in is never closed by an outreach.
The new step keeps the assignee of the step it replaced. Done → Next step and
Snooze work on these steps exactly as on any other.

The write is one atomic, replay-safe RPC, `record_outreach_sent`, sent
through the offline queue like every other write: offline, it is queued and
lands in order when the phone reconnects. A replay never creates a second
follow-up, and a step deleted in the meantime does not block the log.

## The user's Anthropic key

- Stored only in this phone's keychain, per account
  (`expo-secure-store`, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`: never synced to
  iCloud Keychain or backups, never written to ReferralFit's database).
  Another account signed in on the same phone cannot use it. Deleting the
  account removes it; signing out keeps it for that account's next sign-in.
- Sent with each draft request in the `x-anthropic-key` header over TLS. The
  function checks its shape (`sk-ant-…`), uses it for that one Anthropic call,
  and never stores, logs, or returns it.
- Anthropic's answers are passed back in plain words: a key Anthropic does
  not accept (or without permission) sends the user back to **Update your
  Anthropic key**; no credit or billing, or the account's rate limit, says so.
- Web (`npm run web`) has no keychain, so AI drafts are set up in the iPhone
  app only; everything else works there.

## What leaves the device, and what does not

The AI draft is the only part that talks to a third party. The request the
app builds (`buildDraftRequest`) and the function re-validates
(`parseDraftRequest`) contains only:

- the recipient's **first name** and relationship (family), or a partner's
  first name, organization, and partner type;
- the sender's first name and the practice name;
- the case stage, the outreach number, the last channel, and days since the
  last outreach;
- the practitioner's optional note (500 characters).

It never contains phone numbers, email addresses, last names, case titles,
case summaries, timeline notes, documents, or the client's name. Neither the
request nor the draft is stored or logged; `outreach_drafts` keeps only who
drafted, which channel, which case or partner, and when (for the daily cap).

The system prompt (`supabase/functions/draft-follow-up/draft.ts`) also holds
the model to: discretion (no mention of addiction, substances, treatment, or
intervention in a text, email subject, or voicemail, and first name only
there); no client details; no referral-for-referral language or anything of
value with partners (EKRA / patient-brokering); facts only, no placeholders;
the 911 / 988 line when the note suggests danger. Drafts with a `[blank]` or
`{{slot}}` are rejected rather than shown.

**HIPAA / 42 CFR Part 2:** the practitioner's note is free text and could
carry health details despite the on-screen hint. Because each practice uses
its own Anthropic account, each practice arranges its own Business Associate
Agreement (and, if it wants, zero data retention) with Anthropic; the setup
screen says so.

## Deploy

The function needs the migration. The app works before either (Draft with AI
says drafting is unavailable; the starting draft and sending still work).
There is no Anthropic secret to set on the server.

### 1. Apply the migration

`supabase/migrations/20261023120000_follow_up_outreach.sql` adds one
service-only table (`outreach_drafts`) and three functions
(`outreach_draft_daily_limit`, `claim_outreach_draft`,
`record_outreach_sent`). It changes no existing table, function, or policy.
It is transit-safe for pasting: ASCII only, no backslashes, every top-level
statement under 3,700 characters, wrapped in `BEGIN ... COMMIT`.

1. Supabase, **SQL Editor**, paste the whole file, Run.
2. Record it so `supabase db push` and CI agree with production:

   ```sql
   INSERT INTO supabase_migrations.schema_migrations (version, name)
   VALUES ('20261023120000', 'follow_up_outreach');
   ```

3. Verify:

   ```sql
   SELECT to_regclass('public.outreach_drafts') IS NOT NULL AS drafts_table,
          has_function_privilege('authenticated', 'public.record_outreach_sent(uuid, uuid, jsonb, jsonb, jsonb)', 'EXECUTE') AS app_can_record,
          NOT has_function_privilege('authenticated', 'public.claim_outreach_draft(uuid, text, uuid, uuid)', 'EXECUTE') AS claim_is_server_only;
   ```

   All three should be `true`.

### 2. Deploy the function

```sh
supabase functions deploy draft-follow-up --no-verify-jwt --project-ref ovfafffvcpaahktvlsdm
```

`--no-verify-jwt` is intentional: the function checks the caller's access
token itself with `auth.getUser`, which works with the project's publishable
and secret API keys (the gateway's legacy JWT check does not).
`supabase/config.toml` carries the same setting for local serving. The
function uses only the platform-provided `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`.

### 3. Check it

From the app (a build that contains this change, on a device): open a case
with a contact, ✦ Follow up → Draft with AI → paste your Anthropic key →
Save key and draft. A draft appears in a few seconds. Send it to your own number; Messages reports it sent, the
confirmation shows a follow-up two days out, the case timeline shows the
text, and Today shows the new step on that date.

Without a device, with a signed-in user's access token in `$TOKEN`, a case
id from that user's workspace in `$CASE`, and an Anthropic key in `$KEY`:

```sh
curl -s -X POST "https://ovfafffvcpaahktvlsdm.supabase.co/functions/v1/draft-follow-up" \
  -H "Authorization: Bearer $TOKEN" -H "x-anthropic-key: $KEY" -H 'content-type: application/json' \
  -d '{"channel":"text","target":{"kind":"case","caseId":"'"$CASE"'"},"recipient":{"firstName":"Ana","relationship":"mother"},"sender":{"firstName":"Matt","practiceName":"Freedom Interventions"},"situation":{"stage":"inquiry","attempt":2,"lastChannel":"call","daysSinceLastContact":2,"purpose":"follow_up"}}'
```

Expect `{"draft":{"channel":"text","body":"…"},"remaining":199}`. The same
call with the body `{"action":"verify"}` checks the key and returns
`{"ok":true}`.

### 4. Ship a native build

`expo-sms` and `expo-mail-composer` are native modules, so the compose
sheets need a new binary (EAS build); an over-the-air update cannot add them.
The JS loads them only when the module is in the binary, so an older build
that receives this code falls back to `sms:` / `mailto:` links and the "Did it
go out?" question instead of crashing. Both are pinned at 57.0.1 with the rest
of the native set and covered by `scripts/native-compat-test.mjs`.

Before submitting, update App Store Connect → **App Privacy**: names (first
names of contacts) can be shared with Anthropic for App Functionality when a
user turns on AI drafts, not linked to tracking. The privacy policy
(`docs/privacy.html`) has an "AI-drafted follow-ups" section and lists
Anthropic. `APP_REVIEW.md` has a reviewer note: AI drafts are optional and use
the user's own Anthropic account, so nothing is sold.

## Function behaviour

| Request | Response |
| --- | --- |
| No or bad `Authorization` | 401 `unauthorized` |
| No `x-anthropic-key`, or not shaped like `sk-ant-…` | 400 `key_required` |
| Anthropic does not accept the key / key lacks permission | 401 `key_invalid` / 403 `key_forbidden` |
| Anthropic rejects the request (no credit or billing) | 400 `key_rejected` |
| The user's Anthropic account is rate-limited | 429 `key_rate_limited` |
| `{"action":"verify"}` with a working key | 200 `{ ok: true }` (no draft, no cap) |
| Unreadable body, unknown channel, bad id, no recipient name | 400 `bad_request` |
| Case or partner not in the caller's workspace | 404 `not_found` |
| Caller has no workspace | 403 `forbidden` |
| 200 drafts in the last 24 hours (per user) | 429 `daily_limit` |
| Anthropic busy or erroring / timed out | 503 `busy` / 504 `timeout` |
| Model declined | 422 `refused` |
| Unusable draft (empty, placeholder, malformed) | 502 `bad_output` |
| Success | 200 `{ draft, remaining }` |

The app shows each message under the Draft button and keeps the starting
draft, so a failed draft never blocks a follow-up.

Model: `claude-opus-5-5` at low effort with structured JSON output and
server-side fallback (`fallbacks: "default"`), `@anthropic-ai/sdk` 1.1.0.
A draft is roughly 1,500 input and 300–1,500 output tokens, about one to
four cents at $4 / $20 per million tokens, billed to the user's own Anthropic
account. The daily cap (200 per user, `public.outreach_draft_daily_limit()`)
only keeps the function from being used as a general proxy.

## Tests

- `node scripts/outreach-test.mjs` (in `npm test`): timeline steps, the
  48-hour rhythm across daylight-saving changes, which step a send closes,
  the minimal draft request, the fallback drafts, composer URLs.
- `deno test --node-modules-dir=none supabase/functions/draft-follow-up/`
  (in CI): key-header validation, request validation and minimization, the
  prompt, the output schema, output validation.
- `supabase/tests/follow_up_outreach_test.sql` (pgTAP, in CI): privileges,
  the workspace fence and daily cap, and `record_outreach_sent` (complete +
  log + next, replay safety, guards, other-workspace isolation).
