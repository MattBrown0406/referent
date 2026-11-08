# Email alerts

ReferralFit sends three emails, all through Resend from the referralfit.com
domain:

| kind | to | when | default |
| --- | --- | --- | --- |
| `placement_response` | the practitioner who sent a placement request | a program answers (in the portal or from an answer link), held two minutes so answers arriving together make one email; a program editing its answer emails at most once every 15 minutes per request | on |
| `daily_summary` | a practice member who turned it on | around 7 AM in their time zone, only on days with something waiting | off |
| `bed_reminder` | a program's center account | its beds were not confirmed in the last six days; at most once a week, sent at 16:00 UTC (9 AM Pacific) | on |

Migration: `supabase/migrations/20261108120000_email_alerts.sql`.
Function: `supabase/functions/email-dispatch` (Resend).
Portal pages: `/b#<token>` (`portal/src/BedCheckIn.tsx`), `/u#<token>:<kind>`
(`portal/src/EmailPreferences.tsx`).
App: Workspace > "Email me about..." (`src/lib/email-preferences.ts`,
`src/lib/WorkspaceScreen.tsx`), on iPhone and the web.

Push is unchanged and separate (`docs/NOTIFICATIONS.md`): a member can have
either, both, or neither, and each has its own quiet time.

## What an email may say

- **Answer email and morning summary: counts only.** "A program answered
  your placement request. 2 of 4 programs have answered so far." / "1 new
  lead waiting for a call, 2 follow-ups due today." Never a client, family,
  caller, case, or program name: email passes through more hands than the
  app, so it carries no more than a push does. The outbox stores only ids
  and counts (`email_alerts_test.sql` asserts it).
- **Bed check-in: the program's own listing, to the program.** Its name,
  its last counts and when they were confirmed, and a private link.
- **Every email says why it was sent** and links to `/u`, a signed-out page
  that turns that email off (or any of the member's emails on or off). Mail
  clients also get RFC 8058 one-click unsubscribe (`List-Unsubscribe` +
  `List-Unsubscribe-Post`), a POST to the function that can only turn that
  one email off for that token's owner.
- **Opening a link changes nothing.** Company mail scanners open links
  before people do (see `SELF_SERVE_ACCOUNTS.md`), so `/b` saves and `/u`
  unsubscribes only on a button press. Tokens travel in the URL fragment,
  which never reaches a server log or a Referer header, and the pages clear
  them from the address bar.

## How it fits together

```
trigger / hourly job  ->  email_outbox  ->  email-dispatch (edge fn)  ->  Resend  ->  inbox
 (email_enqueue)          ids and counts      every minute via pg_cron + pg_net
```

1. **Preferences** (`email_preferences`, one row per user, made on first
   use; a missing row means the defaults). `unsubscribe_token` (256 bits)
   backs `/u` and one-click unsubscribe. No client role can read the table;
   the app uses `get_email_preferences()` / `set_email_preferences()`, the
   `/u` page `public_email_preferences(token)` /
   `public_email_set_preference(token, kind, value)`.
2. **Outbox** (`email_outbox`): `email_enqueue()` queues a row when the user
   wants the kind and the same email is not already waiting. `not_before`
   holds the answer email for two minutes.
3. **Dispatcher**: `email_outbox_claim()` (service role only) claims due rows
   and prepares each: the address from `auth.users`, fresh counts for an
   answer email (programs asked and answered), the listing and a new 14-day
   link for a bed check-in, and the unsubscribe token. A row that can no
   longer go out is marked failed instead: `no_email`, `unsubscribed`,
   `request_closed` (the practitioner closed or cancelled the request),
   `not_eligible` (the account no longer keeps that listing's beds). The
   function renders and sends with the outbox id as Resend's
   `Idempotency-Key`, then records results with `email_outbox_record()`.
   429, 408, 5xx and network failures stay waiting and are tried again five
   minutes later, up to five attempts; anything else is final.
4. **Bed check-in links** (`listing_bed_links`): the token is stored only as
   a sha256 hash, for one center account and one listing, for 14 days, and
   only while that account still keeps that listing's beds. `/b` reads with
   `public_bed_link_open(token)` and saves with `public_bed_link_save(...)`,
   which runs the same write as the portal (`apply_listing_beds`, the body of
   `set_listing_beds`, which now calls it after its own checks): the audit row
   and `beds_updated_by` name the center account, and a bed opening still
   notifies followers.

Jobs (scheduled by the migration where `pg_cron` is on):

| job | schedule | runs |
| --- | --- | --- |
| `referralfit-email-dispatch-minute` | every minute | `email_dispatch_tick()`: posts to the function through `pg_net` only when an email is due |
| `referralfit-email-daily-summary-hourly` | minute 2 of every hour | `notify_daily_summaries()` |
| `referralfit-email-bed-reminders-daily` | 16:00 UTC | `notify_bed_reminders()` |
| `referralfit-email-outbox-prune-daily` | 03:50 UTC | `email_outbox_prune()`: sent or failed rows after 30 days, expired links |

## Deploy (production)

Order matters: portal first (so `/b` and `/u` exist before any email links
to them), then the database, then the function and its secrets, and the
Vault settings last (they start the sending).

1. **Resend API key.** In Resend (the account that verified referralfit.com
   for the sign-in emails): API Keys > Create, permission "Sending access",
   domain referralfit.com. Keep click tracking off for the domain.
2. **Portal.** Deploy `portal/` (adds `/b` and `/u`).
3. **Migration.** Paste `20261108120000_email_alerts.sql` in the SQL editor
   (after `20261106130000`, which production has), then record it:
   `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('20261108120000', 'email_alerts');`
4. **Function and secrets** (from the repo root):

   ```sh
   supabase functions deploy email-dispatch --project-ref ovfafffvcpaahktvlsdm
   EMAIL_DISPATCH_SECRET="$(openssl rand -hex 32)"
   supabase secrets set EMAIL_DISPATCH_SECRET="$EMAIL_DISPATCH_SECRET" RESEND_API_KEY="<the Resend key>" \
     EMAIL_REPLY_TO="<where replies should go>" --project-ref ovfafffvcpaahktvlsdm
   ```

   Optional: `EMAIL_FROM` (default `ReferralFit <notifications@referralfit.com>`),
   `EMAIL_APP_URL`, `EMAIL_PORTAL_URL`. `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` are provided automatically.
5. **Vault** (SQL editor), with the same `EMAIL_DISPATCH_SECRET` value:

   ```sql
   SELECT vault.create_secret('https://ovfafffvcpaahktvlsdm.supabase.co/functions/v1/email-dispatch', 'referralfit_email_dispatch_url');
   SELECT vault.create_secret('<the EMAIL_DISPATCH_SECRET value>', 'referralfit_email_dispatch_secret');
   ```

6. **App.** The answer email needs nothing more (on by default). The morning
   summary is turned on in Workspace > "Email me about...", which ships with
   the next web app deploy and iPhone build.

## Verify after deploy

```sql
-- Jobs exist and fire.
SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'referralfit-email%';
-- Outbox health.
SELECT kind, count(*) FILTER (WHERE sent_at IS NULL AND error IS NULL) AS waiting,
       count(*) FILTER (WHERE sent_at > now() - interval '1 day') AS sent_today,
       count(*) FILTER (WHERE error IS NOT NULL) AS failed, max(sent_at) AS last_sent
  FROM public.email_outbox GROUP BY kind;
-- Why failures failed (no addresses, no content).
SELECT kind, error, last_error, count(*) FROM public.email_outbox
 WHERE error IS NOT NULL OR last_error IS NOT NULL GROUP BY 1, 2, 3;
```

To send now instead of waiting a minute:

```sh
curl -X POST "https://ovfafffvcpaahktvlsdm.supabase.co/functions/v1/email-dispatch" \
  -H "x-email-dispatch-secret: <EMAIL_DISPATCH_SECRET>" -H "content-type: application/json" -d '{}'
```

It answers `{"ok":true,"sent":N,"failed":N,"retrying":N}`; `503 not_configured`
means `RESEND_API_KEY` is not set (every email waits until it is).

## Degrading gracefully

- No migration: the app's card reads "Email alerts are not available yet";
  nothing else changes.
- Migration but no function or Vault settings: emails queue and wait.
- `RESEND_API_KEY` missing: the function answers 503 and claims nothing.
- A member deleted: their preferences, outbox rows and links go with them
  (`ON DELETE CASCADE`).

## Tests

- `supabase/tests/email_alerts_test.sql`: queuing, folding and quiet times,
  push independence, settings, claim/record, closed requests, the morning
  summary's counts and 7 AM gate, the weekly check-in and its link,
  unsubscribe, and every ACL.
- `supabase/functions/email-dispatch/email_test.ts` (`deno test`): copy,
  escaping, unsubscribe headers, authorization, retry classification.
- `scripts/email-test.mjs`: the app's settings, the portal's link parsing
  and pages, and the wiring.
- Local end to end: `supabase functions serve email-dispatch` with
  `EMAIL_RESEND_URL_FOR_TESTS` pointing at a stand-in for Resend (never set
  it in production).
