# Push notifications (server-sent)

ReferralFit has two kinds of notification:

* **Local reminders** (unchanged): the daily briefing, consult reminders,
  and partner-cadence nudges are scheduled on the phone by
  `src/lib/notifications.ts` from the data the app already holds.
* **Server-sent push** (this document): a practice with staff gets a short
  heads-up when something changes on the server that the phone cannot know
  about: a lead arrived through the intake link, a teammate assigned
  something to you, your own follow-ups are past due, or ReferralFit made a
  directory decision. Delivery is through the Expo Push service.

Migration: `supabase/migrations/20261001140000_team_basics.sql` (also covers
assignees and who-did-what; see `TEAM_BASICS.md`).

## No private detail in a push, ever

A push notification is handled by Apple, Google, and Expo before it reaches
the phone, and it sits on the lock screen. So the server never puts a
family's name, a caller, a phone number, a case title, a note, or a listing
name into one. Every kind has a fixed, generic title and body, written in
`notification_copy()` in the migration:

| kind | title | body |
| --- | --- | --- |
| `new_lead` | New lead waiting | A new lead is waiting for its first call. |
| `assigned_to_me` | Assigned to you | A follow-up was assigned to you. / A case was assigned to you. |
| `overdue_mine` | Follow-ups past due | Some of your follow-ups are past due. Open ReferralFit to catch up. |
| `directory_decision` | Directory decision | There is a directory decision on one of your submissions. |
| `directory_submission` | New directory submission | A practice submitted a listing for review. |
| `bed_opened` | A bed opened | A program you follow has a bed open today. |

The `data` payload carries only ids (`case_id`, `follow_up_id`,
`global_partner_id`), the `kind`, and the recipient's `user_id`. The app
opens the item from those ids after sign-in, and ignores a tap addressed to
a different account. The dispatcher adds nothing to the payload and logs
none of it. `team_basics_test.sql` asserts that no caller or family name
appears in any queued title, body, or data.

## How it fits together

```
trigger / hourly job  ->  notification_outbox  ->  push-dispatch (edge fn)  ->  Expo Push API  ->  phone
   (notify_enqueue)        one row per recipient      every minute via pg_cron + pg_net
```

1. **Preferences** (`notification_preferences`, one row per user): the
   member turns push on in Workspace > "Notify me about..." and chooses the
   kinds. `directory_submission` is honored only for platform admins
   (`platform_admins`), whatever the row says. The row also carries the
   device's timezone offset for the 9 AM reminder.
2. **Devices** (`push_tokens`, one row per Expo push token): the app
   registers its token through `register_push_token()` after the OS
   permission is granted, and unregisters on sign-out. A token belongs to
   exactly one account; registering it under another moves it. Clients can
   read only their own rows and cannot write the table directly.
3. **Outbox** (`notification_outbox`): triggers call `notify_enqueue()`,
   which queues a row only when the member has push on, wants that kind,
   and has a device, and when the same notification is not already waiting.
   No client role can read or write the outbox.
4. **Dispatcher** (`supabase/functions/push-dispatch`): claims up to 100
   rows at a time (`push_outbox_claim`), sends them in chunks of 100 to
   `https://exp.host/--/api/v2/push/send`, records tickets or errors
   (`push_outbox_record`), and fifteen minutes later reads the receipts
   (`push_receipts_pending` / `push_receipts_record`). A token Expo reports
   as `DeviceNotRegistered` (in a ticket or a receipt) is deleted so it is
   never tried again. The service role has no table grants; it only runs
   those four RPCs.

### What enqueues what

| event | recipients | kind |
| --- | --- | --- |
| a case with `lead_captured_at` is inserted (quick-add or intake link) | every member of the workspace except the person who added it; or only the assignee when it arrived already assigned | `new_lead` |
| `cases.assigned_to` set to someone other than the person assigning | the assignee | `assigned_to_me` |
| `follow_ups.assigned_to` set (insert or update) to someone other than the person assigning | the assignee | `assigned_to_me` |
| `global_partners` inserted with status `pending` and a submitting workspace | every platform admin except the submitter | `directory_submission` |
| `global_partners` moves from `pending` to `active` or `archived` | every member of the submitting workspace except the reviewer | `directory_decision` |
| hourly job finds open follow-ups past their day that are mine (own assignee, or the case's assignee when the follow-up has none) | the member, once a day at 9 AM in their timezone | `overdue_mine` |
| `set_listing_beds` moves a gender's count from 0 or unknown to open (`BED_AVAILABILITY.md`) | every member of a workspace that favorited or imported the listing, except the person who set it; opt-in, default off | `bed_opened` |

Timezone: the app reports the device offset on every registration and
preference save (`tz_offset_minutes`, minutes east of UTC). Until a device
has reported, the default is `-420`, which is 9 AM Pacific daylight time.

## Deploy

Deployment and APNs setup are done by hand (they need a Supabase access
token and EAS credentials). Order matters: migration, then function and
secrets, then cron settings, then a build with the push entitlement.

### 1. Migration

Follow `TEAM_BASICS.md` (paste the file in the SQL editor, then record the
version). The cron jobs are created by the migration where `pg_cron` is
installed, but they do nothing until step 3.

### 2. Function and secrets

```sh
supabase functions deploy push-dispatch --project-ref <ref>
supabase secrets set PUSH_DISPATCH_SECRET="$(openssl rand -hex 32)" --project-ref <ref>
# optional: lock sending to your Expo account
supabase secrets set EXPO_ACCESS_TOKEN="<token from expo.dev > Access tokens>" --project-ref <ref>
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to every edge
function automatically. `supabase/config.toml` sets `verify_jwt = false` for
this function because it enforces its own check: every request must carry
`x-push-dispatch-secret: <PUSH_DISPATCH_SECRET>` or
`Authorization: Bearer <service role key>`; anything else gets 401 before
any database call.

### 3. Schedule (pg_cron + pg_net)

Enable both extensions in the dashboard (Database > Extensions:
`pg_cron`, `pg_net`) if they are not already on, then tell the database
where the function lives. Run in the SQL editor:

```sql
ALTER DATABASE postgres SET app.push_dispatch_url = 'https://<ref>.supabase.co/functions/v1/push-dispatch';
ALTER DATABASE postgres SET app.push_dispatch_secret = '<the PUSH_DISPATCH_SECRET value>';
SELECT pg_reload_conf();
```

The three jobs the migration created (re-run that `DO` block from the
migration if `pg_cron` was enabled after the migration):

| job | schedule | runs |
| --- | --- | --- |
| `referralfit-push-dispatch-minute` | every minute | `push_dispatch_tick()`: posts to the function through `pg_net` only when something is queued or receipts are due |
| `referralfit-push-overdue-hourly` | minute 5 of every hour | `notify_overdue_follow_ups()` |
| `referralfit-push-outbox-prune-daily` | 03:40 UTC | `push_outbox_prune()`: removes delivered or failed rows older than 30 days |

Check they exist and are firing:

```sql
SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'referralfit-push%';
SELECT jobname, status, return_message, start_time
  FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
 WHERE jobname = 'referralfit-push-dispatch-minute' ORDER BY start_time DESC LIMIT 5;
SELECT id, status_code, error_msg, created FROM net._http_response ORDER BY created DESC LIMIT 5;
```

### Manual / HTTP fallback

If `pg_net` is unavailable, or to drain the outbox right now:

```sh
curl -X POST "https://<ref>.supabase.co/functions/v1/push-dispatch" \
  -H "x-push-dispatch-secret: <PUSH_DISPATCH_SECRET>" -H "content-type: application/json" -d '{}'
```

It answers `{"ok":true,"sent":N,"failed":N,"pruned":N,"receipts":{...}}`.
Any external scheduler (GitHub Actions cron, a Mac launchd job) can call
this once a minute instead of `pg_cron`.

### 4. APNs key (iOS) and the build

`app.json` now carries `ios.entitlements["aps-environment"] = "production"`,
which changes the native build: the next build must be a new EAS build, not
an OTA update. Give EAS an APNs key once:

```sh
eas credentials --platform ios
# Build credentials > Push Notifications: Set up a new key (EAS creates and
# uploads an APNs key to the Apple Developer account), then
eas build --platform ios --profile production
```

Android needs a Firebase project (`google-services.json` and the FCM
service account in `eas credentials --platform android`); that is not set
up in this PR and Android devices will report "Push is not available on
this device or build yet" until it is.

## Degrading gracefully

* No migration yet: the Workspace card reads "Push notifications are not
  available yet" and offers no switches; nothing else changes.
* Migration applied but no function or cron: rows queue in the outbox and
  wait; the manual `curl` above drains them.
* Build without the entitlement, a simulator, or no EAS `projectId`: the
  switch explains ("Push is not available on this device or build yet")
  and stays off. Nothing crashes.
* OS permission denied: the card says to turn notifications on in Settings.
  The prompt is raised only when the member flips the switch, never on
  launch.
* A member turns push off: their row stays, `push_enabled` is false, the
  device token is removed, and nothing is queued for them.

## Verify after deploy

```sql
-- 1. Devices and members with push on.
SELECT count(*) AS devices, count(DISTINCT user_id) AS members FROM public.push_tokens;
SELECT count(*) FILTER (WHERE push_enabled) AS push_on, count(*) AS rows FROM public.notification_preferences;

-- 2. Outbox health: waiting, sent in the last day, failed.
SELECT count(*) FILTER (WHERE sent_at IS NULL AND error IS NULL) AS waiting,
       count(*) FILTER (WHERE sent_at > now() - interval '1 day') AS sent_today,
       count(*) FILTER (WHERE error IS NOT NULL) AS failed,
       max(sent_at) AS last_sent
  FROM public.notification_outbox;

-- 3. Nothing private in queued copy (should be 0).
SELECT count(*) FROM public.notification_outbox o
  JOIN public.case_contacts c ON o.title ILIKE '%' || c.name || '%' OR o.body ILIKE '%' || c.name || '%';
```

## Tests

* `supabase/tests/team_basics_test.sql`: outbox rows for every trigger
  case, generic copy, admin-only kind, token ownership, service-role RPCs.
* `supabase/functions/push-dispatch/push_test.ts` (`deno test`): message
  building, chunking, ticket and receipt folding, dead-token pruning,
  authorization.
* `scripts/notifications-test.mjs`: a tap on a server-sent push opens the
  right place and only for the addressed account.
