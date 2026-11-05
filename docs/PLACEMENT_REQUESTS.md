# Placement Request

Today a practitioner calls programs one by one to ask about a bed, fit and
price. With a placement request they send **one de-identified request** from
a saved match to several of their ranked programs, and compare the answers
side by side within hours.

- Server: `supabase/migrations/20261104140000_placement_requests.sql`
- Rules (pure, tested): `src/lib/placement-requests.ts`
- API and hook: `src/lib/placement-api.ts`
- Screens: `src/lib/PlacementRequestSheet.tsx` ("Ask programs"),
  `src/lib/PlacementCompare.tsx` (the answers), the Today card and the
  saved-match button in `App.tsx`
- Center portal: `portal/src/PlacementRequests.tsx` with
  `portal/src/placement-rules.ts`
- Tests: `scripts/placement-request-test.mjs`,
  `supabase/tests/placement_requests_test.sql`

## The ethics (non-negotiable)

1. **Answers never change ranking or scores.** The matcher
   (`src/lib/matching.ts`) never reads placement requests, and nothing writes
   back to matching. The answers screen lists programs in the practice's own
   ranked order, fixed when the request went out (`rank`). The practitioner
   may sort by earliest admit or lowest daily rate; that only reorders the
   list on screen. Both rules are tested.
2. **Programs cannot pay to be asked or to be shown.** Who is asked is the
   practitioner's choice, from their own ranked results. A program never
   learns where it ranked or who else was asked.
3. **Nothing identifies the client** until the family chooses a program and
   the practitioner sends the packet through the existing flow (Assign &
   refer / Send packet). "Choose this program" hands off to that flow; it
   never shares anything itself.

Families never see this feature. Programs read: "A practice is looking for
placement for a client and is asking a few programs at once."

## What is shared with programs

The payload is built **on the server** from an allow-list
(`placement_request_payload`), from the saved match's criteria. The app's
copy (`buildPlacementPayload`) mirrors it so the review screen shows exactly
what programs will see; both test suites assert the same fixture.

| Key | What it holds |
| --- | --- |
| `level_of_care` | One of the app's levels, else "Any type" |
| `population` | Any, Men, Women or Adolescent |
| `must_haves`, `needs` | Only names from the app's needs list; must-haves are the profile's (MAT by default) plus population needs |
| `payment` | `insurance` or `self_pay` |
| `insurance_carrier` | The carrier's **name only**: no digits or @ (so a member id never fits), at most 80 characters, else not shared |
| `home_state` | A two-letter state, else none |
| `location_preference` | No preference, Close to family, Away from home |
| `admit_window` | As soon as possible, within a week, within two weeks, flexible |
| `note` | At most 300 characters, optional |

**Never shared:** the client label or any name, the case title, contact
details, case notes, documents, the network preference, and the family's
budget (Matt's rule: programs never see what the family can pay; self-pay
is shown as "Self-pay" with no amount).

The rules hold whatever the client sends:

- A CHECK on `placement_requests.payload` refuses any key outside the ten,
  for every writer (service role included).
- Without a saved match, `create_placement_request` reads only seven named
  criteria from `p_criteria`; anything else (a label, a budget, an email, a
  phone, a name, an address) is ignored. Tested.
- The note is refused, in plain words, if it has an email address, a run of
  seven or more digits (a phone, an ID, a date), a link, a dollar sign, or
  the saved match's label or its case's title. Names cannot be detected
  reliably, so the app warns under the field: "Programs read this note.
  Leave out names, initials, dates of birth, phone numbers and money."
- Programs see the practice's **name** (the workspace name; its directory
  profile's name if the workspace was never named; otherwise "A ReferralFit
  practice"), never a person's email.

## What is stored

`placement_requests`: `id` (made by the app, so a retry is a no-op),
`org_id`, `created_by`, `match_profile_id`, `case_id`, `payload`,
`respond_by` (4, 24 or 48 hours; 24 by default), `status` (open, closed,
cancelled), `closed_at`, `created_at`.

`placement_request_recipients`: one row per program asked: `request_id`,
`org_id`, `partner_id` (the practice's partner), `global_partner_id` (its
directory listing, if any), `channel`, `rank`, `program_name` (kept if the
partner is deleted), `status` (sent, viewed, responded, declined), and the
answer: `bed_available` (yes / no / waitlist), `likely_accept` (yes / maybe
/ no; "no" is a decline), `earliest_admit_on`, `daily_rate` (whole dollars),
`cost_note` (200 characters), `note` (300), `responded_at`, `responded_by`,
`entered_by_practice` (the practitioner logged a phone or text answer).

**Expired is computed, never stored:** a program that has not answered by
`respond_by` reads "expired" (`placement_recipient_status`).

`channel` is `portal` when the program's listing is claimed by a center
account (and not merged or archived), so it answers in the center portal;
otherwise `manual`: the practitioner texts or emails the summary from the
phone's own Messages or Mail and logs the answer by hand.

## Who reads and writes what

- **The practice** reads its own requests and recipients (RLS on
  `org_id = current_org_id()`). Every teammate sees the workspace's
  requests; Today's "Mine" shows the ones you sent.
- **Centers** read nothing directly. `list_center_placement_requests`
  returns only rows addressed to a listing they claimed
  (`global_listing_claimed_by_caller`), with the practice's name and no
  client identity, rank, other programs, partner or case ids. An answer the
  practitioner logged by hand is the practice's own record: the program sees
  its row as unanswered.
- **anon** gets nothing. No client writes either table (no write policies;
  TRUNCATE revoked; production's default ACL emulated in the tests).

RPCs (all SECURITY DEFINER, `search_path` pinned):

| RPC | Who | What |
| --- | --- | --- |
| `create_placement_request(p_id, p_match_profile_id, p_criteria, p_partner_ids, p_respond_hours, p_admit_window, p_note, p_case_id)` | practice | 1 to 8 of its own partners, in ranked order; at most 20 requests per workspace in any 24 hours; a replayed id returns the request already made. Returns `{request, recipients}`. |
| `cancel_placement_request(p_id)` / `close_placement_request(p_id)` | practice | No longer needed / placement found. Programs can no longer answer. Idempotent. |
| `log_manual_response(p_recipient_id, ...)` | practice | A phone or text answer; allowed after the deadline, never over the program's own portal answer, never on a cancelled request. |
| `placement_request_channels(p_partner_ids)` | practice | Before sending: which programs answer in the portal. |
| `list_center_placement_requests(p_recipient_id default null)` | center | Its inbox, newest first, with `status` (expired computed) and `can_respond`. |
| `mark_placement_request_viewed(p_recipient_id)` | center | Opening a request marks it viewed, once. |
| `respond_to_placement_request(p_recipient_id, ...)` | center | Its own row only, while the request is open and before `respond_by`; editable until then. |

A joiner's requests move with their workspace when they join a practice
(`org_move_workspace_rows`, plus `org_merge_linked_partner_copies` repointing
a program the team already tracks). Both are the latest definitions plus
those lines, same signatures; tested through `accept_org_invite`.

## Where it shows

- **Match results:** "Ask programs" under "Recommended matches". It saves
  the match (as Send packet does), then opens one sheet: pick up to 8 of the
  ranked programs (checkboxes, the credentials chip, and whether each
  answers in ReferralFit), choose the response window (4 / 24 / 48 hours)
  and when the client could be admitted, add an optional note, review the
  exact summary programs will see, and send. For programs that answer by
  hand, the sheet then offers Text / Email of the same summary.
- **Answers screen:** from the saved match card ("Answers 3/5") and from
  Today. One row per program in ranked order: status, bed, likely to accept,
  earliest admit, the quoted daily rate (with what 30 days would be before
  insurance) or cost note, the program's note, the credentials chip, and the
  family-cost estimate when the case's benefits make one possible (the
  practitioner's own; never shown to a program). "Log answer" for programs
  that answered by phone or text; "Choose this program" closes the screen
  and starts the usual Send packet or Assign & refer for that partner.
  "We found a placement" closes the request; "Cancel request" cancels it.
- **Today:** one card, "Placement request: 3 of 5 programs answered", while
  a request is open and before its deadline, and for answers that arrived
  since the practitioner last opened its answers (remembered on this phone).
- **Center portal:** "Placement requests" for a claimed center: open
  requests addressed to its listing, newest first, with the time left; the
  summary and the practice's name; and an answer form (bed, likely to
  accept, earliest admit, daily rate or cost note, note) editable until the
  deadline. Opening one marks it viewed; expired ones read closed.

Every screen follows the one-sheet rule: each is one native Modal whose
content changes by step; every question is an Alert; the answers screen
opens only after the send sheet has closed (`afterSheetCloses`); both count
in `anySheetOpenRef`; Messages and Mail present over them the way the
follow-up sheet's do and are released when they close.

## Offline and older servers

Reads are online only and never cached. Offline, the answers screen says
"Answers load when you're online". Writes are online-only RPCs that throw
the app's `OfflineError`; the send keeps its id, so "Try again" never sends
twice.

Against a server **without** this migration the reads get PGRST202 /
PGRST205 / 42P01 / 42703 / 42883, report `available: false`, and the whole
feature hides: no Ask button, no Answers button, no Today card, no portal
section. Tested with Supabase stubbed.

## Compatibility with the 1.0.4 app

Purely additive. Two new tables and new functions; the only existing
functions re-created are the internal `org_move_workspace_rows` and
`org_merge_linked_partner_copies` (called only by `accept_org_invite`),
from their latest definitions with the same signatures. No existing table,
column, policy, trigger or callable function changes. The 1.0.4 app's own
partner and match deletes still work with requests on them (the answer
stays under the program's name; the request stays without its match), and
account deletion takes a solo workspace's requests with it (tested).

## Applying to production

Production has every migration through 20261024130000. Apply, in order,
`20261104120000_family_cost.sql`, `20261104130000_program_integrity.sql`,
then this one, **before** shipping an app build with the feature (the app
copes without it, but the feature stays hidden).

1. Paste `supabase/migrations/20261104140000_placement_requests.sql` into the
   SQL editor and run it. It is ASCII only, has no backslashes, every
   top-level statement is under 3,700 characters, and it runs in one
   BEGIN/COMMIT. Running it twice is harmless (CREATE TABLE / INDEX IF NOT
   EXISTS, DROP POLICY IF EXISTS, CREATE OR REPLACE).
2. Record it:

   ```sql
   INSERT INTO supabase_migrations.schema_migrations (version, name)
   VALUES ('20261104140000', 'placement_requests');
   ```

3. Verify:

   ```sql
   -- RLS on; signed-in users read only; anon nothing.
   SELECT c.relname, c.relrowsecurity AS rls,
          has_table_privilege('authenticated', c.oid, 'SELECT') AS authenticated_select,
          has_table_privilege('authenticated', c.oid, 'INSERT') OR has_table_privilege('authenticated', c.oid, 'UPDATE')
            OR has_table_privilege('authenticated', c.oid, 'DELETE') OR has_table_privilege('authenticated', c.oid, 'TRUNCATE') AS authenticated_writes,
          has_table_privilege('anon', c.oid, 'SELECT') AS anon_select
     FROM pg_class c
    WHERE c.oid IN ('public.placement_requests'::regclass, 'public.placement_request_recipients'::regclass);

   -- Who may call what.
   SELECT p.proname,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_ok,
          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_ok
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND (p.proname LIKE 'placement%' OR p.proname IN ('create_placement_request', 'cancel_placement_request',
           'close_placement_request', 'log_manual_response', 'list_center_placement_requests',
           'mark_placement_request_viewed', 'respond_to_placement_request',
           'org_move_workspace_rows', 'org_merge_linked_partner_copies'))
    ORDER BY p.proname;

   -- The allow-list, spot-checked: no budget, no member id.
   SELECT public.placement_request_payload('Inpatient', 'Women', ARRAY['Trauma', 'MAT'], NULL,
          'Aetna ID W123456789', 'OR', 'Close to family', 'asap', '') AS payload;
   ```

   Expected: both tables `rls = true`, `authenticated_select = true`,
   `authenticated_writes = false`, `anon_select = false`. Every function
   `anon_ok = false`; `authenticated_ok = true` for the seven RPCs plus
   `placement_request_channels` and `placement_recipient_status`, false for
   the internal helpers (`placement_note_problem`, `placement_allowed_needs`,
   `placement_request_payload`, `placement_answer_problem`,
   `placement_request_partner_ids`,
   `placement_listing_answers_in_portal`, `placement_practice_name`,
   `placement_request_json`, `placement_request_build`,
   `placement_request_finish`, `org_move_workspace_rows`,
   `org_merge_linked_partner_copies`). The payload has
   `"insurance_carrier": null` and `"payment": "insurance"`.

4. Rebuild and deploy the center portal (`cd portal && npm run build`, as
   in `portal/README.md`).
5. Ship the app build. Nothing else to deploy: no Edge Function, cron or
   secret.

## Not in this version

- **No push notification** when a program answers. The outbox would need a
  new kind (its CHECK, `notification_copy`, `notify_enqueue`, a preference
  column, the app's settings and tap routing), which is more than this
  feature should change; answers show on Today and on the saved match
  instead. A `placement_response` kind is the natural next step.
- No email or text is sent by the server: programs without a claimed
  listing get the summary from the practitioner's own Messages or Mail.
- Rank is the position among the programs asked (1 to 8), in the order of
  the ranked results; the original result number is not kept.
- The "new answers" marker is per phone (AsyncStorage), not synced across
  devices.
- Answers are not cached for offline use.
