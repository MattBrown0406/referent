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
  `supabase/tests/placement_requests_test.sql`; the shared
  identifying-details check: `scripts/identifying-text-test.mjs`,
  `supabase/tests/identifying_text_test.sql`

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
- The note (at most 300 characters) goes through the one identifying-details
  check every free-text field a program reads shares (rules version 2):
  `public.identifying_text_problem(p_text, p_names, p_label)`, the SQL twin
  of `identifyingTextProblem(text, names, label)` in
  `src/lib/identifying-text.ts` (both test suites run every case in
  `scripts/fixtures/identifying-text-cases.json`;
  `supabase/tests/identifying_text_test.sql` on the server, written from the
  fixture by `node scripts/identifying-text-test.mjs --write`; a
  differential fuzz compares the two). Text is folded first (accents off,
  NFKD then NFKC, lower case). In order, it refuses:
  - hidden or reordering characters and line breaks (C0 and C1 controls,
    the soft hyphen, the Arabic letter mark, the Mongolian vowel separator,
    zero-width characters, direction overrides and isolates, the word
    joiner and invisible operators, the byte order mark);
  - email addresses (including "at ... dot com" and a fullwidth @), links
    and bare domains;
  - a currency sign;
  - dates: day/month/year with a real day and month ("30/60/90 day
    program" is fine), ISO dates (1985-03-14), month then day ("Dec 12",
    "december 3", "Sept. 14"; "decent 12" is not), day first ("14th March",
    "3rd of March"; "14 May" only with a year), "DOB" or "born", and a
    birthday or bday followed by a number;
  - phone and ID numbers: five digits in a row, a phone number in groups
    (not a dose range such as "100-120 mg"), an SSN, or nine or more digits
    with spaces, dots, brackets or dashes. Ordinary clinical text stays:
    year ranges, BP 160/100, HR 110-120, clock times, "3.1, 3.5, 3.7";
  - money: comma thousands, "40k", budget words, and amounts in words
    ("40 grand", "40 thousand", "forty thousand", "1.5 million"; "grand"
    only after a number, so "grand mal seizures" is fine);
  - a **name**: a name word of the case's title or its contacts' names
    (`p_names`) or of the saved match's client label (`p_label`), as a whole
    word or its plural (n+s, n+es). Name words are three or more letters, or
    two (Li, Wu, Ng) unless an everyday word, a state code or a care
    abbreviation; never a word for a relationship (every word of the app's
    relationship lists: son, mother, myself, stepchild, best friend, loved
    one, family member, patient...), the app's placeholders, the ordinary
    words case titles are made of (intervention, first call, detox...), or a
    substance or kind of care (alcohol, opioids, fentanyl, IOP, MAT...).
    For the **label** only, its initials and tags count too: tokens of two
    or more letters or digits with a letter, dotted initials collapsed
    ("J.R." refuses "JR" and "J.R."; "JR 34M" refuses "jr" and "34m").
  The refusal is the RPC's 22023 error message, and a name refusal says
  which word (the alphabetically first): "Leave out names ("rivera" is a
  name on this case). Programs read this." The app still warns under the
  field: "Programs read this note. Leave out names, contact details (phone,
  email, links), dates, ID numbers and money."
- Programs see the practice's **name** (the workspace name; its directory
  profile's name if the workspace was never named; otherwise "A ReferralFit
  practice"), never a person's email.

## What is stored

`placement_requests`: `id` (made by the app, so a retry is a no-op; a retry
that differs is refused, see below), `org_id`, `created_by`,
`match_profile_id`, `case_id`, `payload`,
`respond_by` (4, 24 or 48 hours; 24 by default), `status` (open, closed,
cancelled), `closed_at`, `created_at`.

`placement_request_recipients`: one row per program asked: `request_id`,
`org_id`, `partner_id` (the practice's partner), `global_partner_id` (its
directory listing, if any), `channel`, `rank` (1 to 999: the program's place
on the practice's match screen when the app sends `p_ranks`, else its
position in the list sent), `program_name` (kept if the partner is
deleted), `status` (sent, viewed, responded, declined), and the
answer: `bed_available` (yes / no / waitlist), `likely_accept` (yes / maybe
/ no; "no" is a decline), `earliest_admit_on`, `daily_rate` (whole dollars),
`cost_note` (200 characters), `note` (300), `responded_at`, `responded_by`,
`entered_by_practice` (the practitioner logged a phone or text answer).

**Expired is computed, never stored:** a program that has not answered by
`respond_by` reads "expired" (`placement_recipient_status`).

`channel` is `portal` when the program's listing is claimed by a center
account (and not merged or archived), so it answers in the center portal;
otherwise `manual`: the practitioner texts or emails the summary from the
phone's own Messages or Mail, with an answer link the program can answer
from itself (see "Answer links"), or logs the answer by hand.

`answered_via` (20261108130000) says how an answer arrived: `portal`,
`link` or `practice`; NULL while unanswered. A BEFORE UPDATE trigger
(`placement_recipient_answered_via`) keeps it right for every writer.

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
- **anon** reads no table. It can call only the two answer-link functions,
  each with a link's token (see "Answer links"). No client writes either
  table (no write policies; TRUNCATE revoked; production's default ACL
  emulated in the tests).

RPCs (all SECURITY DEFINER, `search_path` pinned):

| RPC | Who | What |
| --- | --- | --- |
| `create_placement_request(p_id, p_match_profile_id, p_criteria, p_partner_ids, p_respond_hours, p_admit_window, p_note, p_case_id default null, p_ranks default null)` | practice | 1 to 8 of its own partners, in ranked order; `p_ranks` (integer[], one per entry of `p_partner_ids`, 1 to 999, no two the same) is each program's place on the match screen, stored as `rank`; without it, 1, 2, 3 in the order sent. At most 20 requests per workspace in any 24 hours. A replayed id with the same note, admit window, response window and set of programs returns the request already made and changes nothing; if any of those differ it is refused (22023, "This request already went out as first written. Cancel it and send a new one."). Returns `{request, recipients}`. |
| `cancel_placement_request(p_id)` / `close_placement_request(p_id)` | practice | No longer needed / placement found. Programs can no longer answer. Idempotent. |
| `log_manual_response(p_recipient_id, ...)` | practice | A phone or text answer; allowed after the deadline, never over the program's own portal answer, never on a cancelled request. |
| `placement_request_channels(p_partner_ids)` | practice | Before sending: which programs answer in the portal. |
| `list_center_placement_requests(p_recipient_id default null)` | center | Its inbox, newest first, with `status` (expired computed) and `can_respond`. |
| `mark_placement_request_viewed(p_recipient_id)` | center | Opening a request marks it viewed, once. |
| `respond_to_placement_request(p_recipient_id, ...)` | center | Its own row only, while the request is open and before `respond_by`; editable until then. |
| `placement_answer_link(p_recipient_id)` | practice | A new answer link for a program asked by hand, on an open request before its deadline; returns the token (only its hash is kept). |
| `public_placement_answer_open(p_token)` / `public_placement_answer_respond(p_token, ...)` | anon (the program, by link) | Read the request as the center inbox shows it (marks it viewed); answer it with the portal's checks. |

A joiner's requests move with their workspace when they join a practice
(`org_move_workspace_rows`, plus `org_merge_linked_partner_copies` repointing
a program the team already tracks). Both are the latest definitions plus
those lines, same signatures; tested through `accept_org_invite`.

When ReferralFit merges two directory listings, `merge_global_partners`
(re-created from `20260907120000` plus two lines, same signature; one
comment's dash made ASCII) also moves the programs asked in requests
(`placement_request_recipients.global_partner_id`) and the listing's
credentials (`program_credentials`, with their private notes) from the
dropped listing to the kept one, so an open request can still be answered
by the center and the credentials survive the merge.

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

## Answer links

Migration `20261108130000_placement_answer_links.sql`. A program asked by
hand (`channel = 'manual'`) can answer the request itself, signed out, from
a link in the practitioner's text or email. The server sends nothing: the
link rides in the message the practitioner sends from their own phone.

- **The token:** 256 random bits (64 hex characters), made by
  `placement_answer_link(recipient)` for a practice member, only for a
  program asked by hand, on an open request before its deadline. Only its
  sha256 is stored (`placement_answer_links`, no client role can read or
  write it). Each call makes a new link; a recipient's five newest work,
  so a program texted and then emailed can use either, and an older one
  stops. The app keeps the link it made for each program while it runs, so
  a second text or email to the same program reuses it. Deleting the
  request deletes its links.
- **The page:** `https://portal.referralfit.com/a#<token>` (the center
  portal's `src/AnswerLink.tsx`). The token is in the fragment, so it never
  reaches a server log or a Referer header; the page keeps it for that tab
  only (sessionStorage, so a reload works) and takes it out of the address
  bar. It calls two functions with the token alone, as anon:
  - `public_placement_answer_open(token)`: NULL for a link that does not
    work; else exactly `program_name`, `practice_name` (the center inbox's
    rule), `payload` (the allow-listed summary), `sent_at`, `respond_by`,
    `request_status`, `status` (expired computed), `can_respond`, and
    `answer`: the program's own answer, or null (one the practice logged
    reads as unanswered, as in the center inbox). Opening marks the row
    viewed, once; the answers screen then says "They opened your link and
    have not answered yet."
  - `public_placement_answer_respond(token, ...)`: the same checks and
    words as `respond_to_placement_request` (open, before the deadline,
    `placement_answer_problem`). The answer is the program's own:
    `entered_by_practice` false, `responded_by` NULL, `answered_via`
    'link'. It replaces an answer the practice logged by hand, and
    `log_manual_response` refuses to write over it ("The program already
    answered in ReferralFit"). The existing trigger
    (`placement_answer_notify`) queues the practitioner's push exactly as
    for a portal answer.
- **Nothing more is reachable:** no rank, no other program, no partner,
  case, request or recipient id, no label or budget (tested).
- **The app:** "Text" and "Email" on the send sheet and on the answers
  screen ask for the program's link (`fetchPlacementAnswerLink`) and add
  "Answer in one tap, no account needed: <link>" to that program's message
  (every message goes to one program). Offline, slow (4 seconds), on an
  older server, or on any refusal, the message goes without the link, as
  before; making a link never blocks a text. The answers screen reads
  "Answered from your link" for such an answer.
- **The page's footer** invites the program to claim its free listing on
  ReferralFit to answer every request in one place
  (https://referralfit.com/programs).

## Offline and older servers

Reads are online only and never cached. Offline, the answers screen says
"Answers load when you're online". Writes are online-only RPCs that throw
the app's `OfflineError`. After any send whose outcome is unknown (offline,
a timeout, a server failure, an answer that could not be read back) the
next send keeps the same request id, whatever was changed meanwhile, so a
request that did go out is never sent twice: the server returns it, or, if
the review changed, refuses it as already sent and the sheet offers to
cancel the earlier one. A new id is made only after a definite refusal
(22023 or P0002 in the server's words) or a confirmed cancel ("SendKey" in
`placement-requests.ts`); an unanswered id is kept for its saved match even
when the sheet is closed and opened again (while the app runs). "Try
again" shows only while the review is the one whose send is unknown. The
sheet cannot be dismissed while a send or a cancel is on its way, and once
it is gone an answer still on its way shows nothing.

Against a server **without** this migration the reads get PGRST202 /
PGRST205 / 42P01 / 42703 / 42883, report `available: false`, and the whole
feature hides: no Ask button, no Answers button, no Today card, no portal
section. Tested with Supabase stubbed.

## Compatibility with the 1.0.4 app

Two new tables and new functions. The existing functions re-created are
the internal `org_move_workspace_rows` and `org_merge_linked_partner_copies`
(called only by `accept_org_invite`), and the admin-only
`merge_global_partners` (two added lines), each from its latest definition
with the same signature. No existing table, column, policy or trigger
changes, and nothing the 1.0.4 app calls changes. The 1.0.4 app's own
partner and match deletes still work with requests on them (the answer
stays under the program's name; the request stays without its match), and
account deletion takes a solo workspace's requests with it (tested).

## Applying to production

Production has every migration through 20261024130000. Apply, in order,
`20261104120000_family_cost.sql`, `20261104130000_program_integrity.sql`,
then this one, **before** shipping an app build with the feature (the app
copes without it, but the feature stays hidden). The file checks the order
itself: without `public.program_credentials` it stops at once with "Paste
20261104130000_program_integrity.sql first: ..." and changes nothing.

1. Paste `supabase/migrations/20261104140000_placement_requests.sql` into the
   SQL editor and run it. It is ASCII only, has no backslashes, every
   top-level statement is under 3,700 characters, and it runs in one
   BEGIN/COMMIT. Re-running a file before the next one is pasted is harmless
   (CREATE TABLE / INDEX IF NOT EXISTS, DROP POLICY IF EXISTS, DROP FUNCTION IF
   EXISTS for an older draft's signature, CREATE OR REPLACE). Once a later file
   is in, do not re-run an earlier one: it would put back older copies of the
   shared helpers the later file re-creates.
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
      AND (p.proname LIKE 'placement%' OR p.proname LIKE 'identifying%'
           OR p.proname IN ('create_placement_request', 'cancel_placement_request',
           'close_placement_request', 'log_manual_response', 'list_center_placement_requests',
           'mark_placement_request_viewed', 'respond_to_placement_request', 'merge_global_partners',
           'org_move_workspace_rows', 'org_merge_linked_partner_copies'))
    ORDER BY p.proname;

   -- The allow-list, spot-checked: no budget, no member id.
   SELECT public.placement_request_payload('Inpatient', 'Women', ARRAY['Trauma', 'MAT'], NULL,
          'Aetna ID W123456789', 'OR', 'Close to family', 'asap', '') AS payload;

   -- The identifying-details check, spot-checked.
   SELECT public.identifying_text_problem('Jake prefers a quiet program', ARRAY['Rivera family - son Jake']) AS name_check,
          public.identifying_text_problem('JR prefers mornings', ARRAY['Rivera family'], 'J.R.') AS initials_check,
          public.identifying_text_problem('Needs a 30 day stay', ARRAY['Rivera family']) AS fine;
   ```

   Expected: both tables `rls = true`, `authenticated_select = true`,
   `authenticated_writes = false`, `anon_select = false`. Every function
   `anon_ok = false`; `authenticated_ok = true` for the seven RPCs plus
   `placement_request_channels`, `placement_recipient_status` and
   `merge_global_partners` (it checks for a platform admin itself), false
   for the internal helpers (`identifying_text_problem` and its helpers
   `identifying_fold`, `identifying_ordinary_words`,
   `identifying_everyday_two`, `identifying_abbreviations`,
   `identifying_name_words`, `identifying_tokens`,
   `identifying_label_initials`, `identifying_mentions_date`,
   `identifying_mentions_id_number`, `identifying_mentions_money`,
   `identifying_name_found`; `identifying_case_names`,
   `placement_note_problem`, `placement_allowed_needs`,
   `placement_request_payload`, `placement_answer_problem`,
   `placement_request_partner_ids`, `placement_request_ranks`,
   `placement_request_replay_differs`,
   `placement_listing_answers_in_portal`, `placement_practice_name`,
   `placement_request_json`, `placement_request_build`,
   `placement_request_finish`, `org_move_workspace_rows`,
   `org_merge_linked_partner_copies`). The payload has
   `"insurance_carrier": null` and `"payment": "insurance"`;
   `name_check = 'Leave out names ("jake" is a name on this case). Programs read this.'`,
   `initials_check = 'Leave out names ("jr" is a name on this case). Programs read this.'`,
   `fine` is NULL.

4. Rebuild and deploy the center portal (`cd portal && npm run build`, as
   in `portal/README.md`).
5. Ship the app build. Nothing else to deploy: no Edge Function, cron or
   secret.

### Answer links (20261108130000)

After `20261106120000_placement_response_push.sql` (production has it):

1. Paste `supabase/migrations/20261108130000_placement_answer_links.sql`
   into the SQL editor and run it (ASCII only, no backslashes, every
   statement under 3,700 characters, one BEGIN/COMMIT, safe to re-run).
2. Record it:

   ```sql
   INSERT INTO supabase_migrations.schema_migrations (version, name)
   VALUES ('20261108130000', 'placement_answer_links');
   ```

3. Verify:

   ```sql
   SELECT has_table_privilege('anon', 'public.placement_answer_links', 'SELECT') AS anon_reads_links,          -- false
          has_table_privilege('authenticated', 'public.placement_answer_links', 'SELECT') AS users_read_links, -- false
          has_function_privilege('anon', 'public.public_placement_answer_open(text)', 'EXECUTE') AS page_opens, -- true
          has_function_privilege('anon', 'public.placement_answer_link(uuid)', 'EXECUTE') AS anon_makes_links;  -- false
   SELECT answered_via, count(*) FROM public.placement_request_recipients GROUP BY 1;  -- answers backfilled
   ```

4. Deploy the center portal (it adds the `/a` page). Until it is live, a
   link opens the portal's sign-in page, so deploy it **before** the app
   build or web app that adds links to messages.
5. The web app and the next iPhone build add the link to the messages.
   Against a server without the migration they send the message as before.

## Not in this version

- No email or text is sent by the server: programs without a claimed
  listing get the summary (and their answer link) from the practitioner's
  own Messages or Mail.
- An app that does not send `p_ranks` stores the position among the
  programs asked (1 to 8), not the original result number.
- The "new answers" marker is per phone (AsyncStorage), not synced across
  devices.
- Answers are not cached for offline use.
