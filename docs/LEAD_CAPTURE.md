# Lead capture: never lose a lead, and a speed-to-lead clock

Roadmap feature 1 of 5 (Matt Brown, 2026-10-01). A practice never loses an
inbound lead and can see how fast it responds.

Nothing in this document is applied automatically. Matt applies the migration
by hand; the edge function is deployed separately once a Supabase access
token is available.

## What it is

Two doors into the same place:

1. **New lead** on Today (the app). Phone-first, under ten seconds: caller
   name, phone, optional email, who they are calling about (relationship and
   first name only), lead source, and one safety choice. Saving creates the
   case (status inquiry), the caller as primary contact, a **first-call**
   follow-up due today at now + the workspace's first-call target, and a
   system timeline entry, in one transaction (`create_lead`).
2. **The intake link** (hosted form). Each workspace has an opaque token on
   `orgs.intake_token`. The `intake` edge function serves a mobile-first form
   branded with the practice name at

   ```
   https://ovfafffvcpaahktvlsdm.supabase.co/functions/v1/intake/<token>
   ```

   and a submission creates the same lead in that workspace
   (`create_lead_from_intake`, service role only). The form says who will
   call, that it is not emergency medical care, and carries the 911/988 line
   tied to the "someone is in danger right now" choice.

Then:

- **NEW LEADS on Today.** Leads with no logged touch yet sit at the top of
  Today with a visible clock ("12m waiting · target 15 min", red once past
  the target), one-tap Call/Text that logs the touch as before, and the
  first-call follow-up's Done. A lead leaves the section once a call, text,
  email, or meeting is logged against the case or the first call is
  completed.
- **Speed to lead on Business.** Median time from lead arrival to first
  logged touch and the share answered within the target, for 30/90/365/all,
  plus per-source lead counts on the existing Lead sources list.
- **Workspace.** "Your intake link" with Copy, Share, and (owner only) "Make
  a new link", which rotates the token after a confirmation; the old link
  stops working immediately. The first-call target
  (`orgs.lead_response_target_minutes`, default 15) is edited on the same
  card by the owner.

### Data model

| Column | Meaning |
| --- | --- |
| `orgs.intake_token` | 40 hex chars, generated server-side, unique, rotatable. Readable by workspace members (to share the link). |
| `orgs.intake_token_rotated_at` | When the owner last made a new link. |
| `orgs.lead_response_target_minutes` | First-call target, 1 to 1440, default 15. Owner-editable (column grant + the existing owner UPDATE policy). |
| `cases.lead_captured_at` | Set only by `create_lead` / `create_lead_from_intake`. Marks the case as a lead and starts its clock. |
| `cases.first_touch_at` | Set once by the `case_events_first_touch` trigger on the first `call`, `text`, `email`, or `meeting` event for the case. Never moves. Backfilled for existing cases from their earliest logged touch. |
| `cases.lead_channel` | `app` or `intake_link`. |
| `cases.lead_urgency` | `none` or `immediate_danger`. |
| `intake_rate_limits` | Fixed-window counters keyed `token:<token>` and `ip:<hmac>`. Service role only. |

Only leads captured through New lead or the intake link count toward speed to
lead. A case created with the full New case form is not a lead (its
`lead_captured_at` stays NULL), so historical cases do not distort the
metric.

### Language rules carried into the copy

Addiction is a medical disease; families act from love and fear; no shame.
The 911/988 guidance appears in the app only when the caller said someone is
in danger right now, never by default. The hosted form states it is not
emergency medical care and shows the 911/988 line next to the safety choice.

## Apply the migration

The migration is `supabase/migrations/20261001120000_lead_capture.sql`. It
adds nullable or defaulted columns, one service-only table, functions, one
trigger, and a backfill of `cases.first_touch_at`; it deletes nothing and
replaces no existing function. It is safe to apply before the app build that
contains the new screens ships (the current build never reads the new
columns, and `fetchWorkspace` selecting them simply fails until then, which
is why the migration goes first).

The file is transit-safe for pasting from a chat client: no backslashes and
no non-ASCII characters (comment lines are stripped before pasting), and
every top-level statement is under 3,700 characters.

1. Supabase, **SQL Editor**, paste the whole file, Run. It is wrapped in
   `BEGIN ... COMMIT`, so it applies atomically.
2. Record it so `supabase db push` and CI agree with production:

   ```sql
   INSERT INTO supabase_migrations.schema_migrations (version, name)
   VALUES ('20261001120000', 'lead_capture');
   ```

## Verify

```sql
-- 1. Every workspace has a token, and the first-call target defaulted.
SELECT count(*) AS workspaces,
       count(*) FILTER (WHERE intake_token ~ '^[0-9a-f]{40}$') AS with_token,
       min(lead_response_target_minutes) AS min_target,
       max(lead_response_target_minutes) AS max_target
  FROM public.orgs;

-- 2. The first-touch backfill matches the earliest logged touch per case.
SELECT count(*) AS cases_with_touch,
       count(*) FILTER (WHERE c.first_touch_at = t.first_at) AS matching
  FROM public.cases c
  JOIN (SELECT case_id, min(occurred_at) AS first_at
          FROM public.case_events
         WHERE kind IN ('call', 'text', 'email', 'meeting')
         GROUP BY case_id) t ON t.case_id = c.id;

-- 3. Grants: anon can run nothing; the intake RPC is service-role only.
SELECT p.oid::regprocedure AS fn,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_run,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_run,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_can_run
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('create_lead', 'create_lead_from_intake', 'rotate_intake_token',
                     'lead_capture_metrics', 'intake_rate_limit_hit', 'intake_practice_name',
                     'create_lead_internal')
 ORDER BY 1;
```

Expected for query 3: `anon_can_run` false everywhere; `create_lead`,
`rotate_intake_token`, `lead_capture_metrics` true for authenticated;
`create_lead_from_intake`, `intake_practice_name`, and
`intake_rate_limit_hit` true only for service_role; `create_lead_internal`
false for all three. The edge function needs no table grants: it only calls
those three service-role RPCs.

## Deploy the edge function

The app behaves correctly before the function is deployed: the Workspace card
still shows and shares the URL; opening it returns the Supabase default 404
until the function exists. Nothing else depends on it.

1. Deploy (from the repo root, with `SUPABASE_ACCESS_TOKEN` set or after
   `supabase login`, and the project linked with `supabase link --project-ref ovfafffvcpaahktvlsdm`):

   ```sh
   supabase functions deploy intake --no-verify-jwt
   ```

   `--no-verify-jwt` is required: families open the link with no account.
   `supabase/config.toml` carries the same setting for local serving.

2. Secrets: none to add. The function uses only the platform-provided
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (every Supabase function
   has them). The service key also keys the HMAC that hashes a visitor's
   address for rate limiting, so no address is ever stored.

3. Check it from a phone: open a workspace's link from the Workspace screen.
   The form should carry the practice name. Submit a test lead; it appears
   under NEW LEADS on Today within one pull-to-refresh, with the timeline
   entry "New lead arrived through the intake link". Log the call from the
   card; the lead leaves NEW LEADS and the case shows `first_touch_at`.

### Function behaviour

| Request | Response |
| --- | --- |
| `GET /intake/<token>` | 200, the branded form. 404 "This link is not active" for an unknown, malformed, or rotated token. |
| `POST /intake/<token>` (form-encoded) | 200 thank-you page ("Thank you. We will call you shortly."); 400 with the form and a generic message on a bad submission (nothing typed is echoed back); 404 for an unknown token; 429 "Please try again in a little while" past the limits. |
| Honeypot (`company`) filled | 200 thank-you page, nothing created. |
| Other methods | 405. |

Rate limits (in `supabase/functions/intake/intake.ts`): 30 submissions per
token per hour, 6 per visitor address per hour, enforced by
`intake_rate_limit_hit` in the database. Pages carry a strict
Content-Security-Policy, no scripts, `noindex`, and `no-store`.

Local checks, matching CI:

```sh
deno check --node-modules-dir=none supabase/functions/intake/index.ts
deno test  --node-modules-dir=none supabase/functions/intake/
```

## Tests

- `supabase/tests/lead_capture_test.sql` (pgTAP, 54 assertions): lead
  creation through both RPCs; validation; `first_touch_at` set once and only
  once; RLS between workspaces; token rotation invalidating the old link;
  the rate limiter; `lead_capture_metrics()` medians and target shares on a
  pinned fixture; the owner-only target edit and its range check.
- `scripts/business-test.mjs`: `computeSpeedToLead`, `median`, per-source
  lead counts, and the dashboard wiring, on the same fixture shape.
- `scripts/today-test.mjs`: NEW LEADS ordering (immediate danger first, then
  longest waiting), exclusions, no duplication under TODAY/OVERDUE, and the
  clock formatting.
- `supabase/functions/intake/intake_test.ts` (Deno): token parsing,
  validation, honeypot, control-character stripping, page content and
  escaping, address and bucket handling.
