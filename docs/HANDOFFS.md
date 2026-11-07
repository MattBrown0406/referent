# Referral handoffs

After referring a family to a program, the practitioner sends the program a
private link. The program marks each step as it happens: received, contact
attempted, family reached, consult scheduled, closed. The practitioner's
reminder moves with every step.

- **App:** Referrals → **Handoffs** (`src/lib/HandoffsSheet.tsx`,
  `src/lib/handoffs.ts`). New handoff: pick an outbound referral, an alias the
  program sees, and who receives it. The link is shown once. A handoff can be
  marked forward here by anyone on the team (when the program called
  instead) or revoked. A referral has one open handoff at a time, and only a
  referral the practice sent out can have one (the server checks both).
- **Program's page:** `https://portal.referralfit.com/h#<token>`
  (`portal/src/Handoff.tsx`). Signed out, even in a browser signed in to the
  center portal: it uses its own client, which sends no stored session. It
  shows the alias, the two names and the status, and records the next step.
  When the server cannot be reached it says so and offers to try again
  (the link is not called revoked).
- **Today:** each handoff has one open reminder (follow-up kind
  `referral_handshake`), written by the server for the handoff's creator
  while they are on the team, else for the workspace owner, whoever moved
  the step. Done on it opens Handoffs; it is never treated as the referral's
  admit question.

## Privacy

- The program reads the **alias** only, never the client label, the case or a
  contact. The alias passes the identifying-details check (no names from the
  case, its contacts or the client label; no dates, phone or ID numbers,
  emails or links), in the app and again in `create_referral_handoff`.
- The token is 256 random bits, kept only as a SHA-256 hash, and shown once.
  It travels in the URL fragment, so it never reaches a server log, a proxy or
  a Referer header, and the page removes it from the address bar on load.
- The page calls two functions, `public_referral_handoff_resolve` and
  `public_referral_handoff_transition`, with the token alone (granted to
  `anon`). Nothing else about handoffs is reachable signed out.
- History (`referral_handoff_events`) is append-only: never edited, and
  deleted only with its handoff. Deleting the referral or the partner, or
  the workspace, deletes the handoff, its history and its link.

## Where it came from

Handoffs were built on the `feature/referral-growth-system` branch (August
2026), whose two migrations are already applied in production. Folding it in
(migration `20261106130000_referral_handoffs_fold_in.sql`) kept handoffs and
removed the rest: referral links and their public form, program availability,
voice capture (all empty in production). It also fixed handoffs for today's
schema, where creating one had been failing and the tables blocked joining a
team, merging a partner, and deleting an account. See the migration's header.

## Deploy

1. Paste `20261106130000_referral_handoffs_fold_in.sql` with the other new
   migrations (it needs `20261104140000`'s identifying-details functions).
2. Redeploy the portal from `main` (`portal/vercel.json` serves `/h` and sets
   the security headers).
3. Ship the app build.

Until all three are done the Handoffs screen fails cleanly (the functions
answer with an error the sheet shows), and old links stay unusable.

## Tests

- `supabase/tests/referral_handoffs_test.sql`: create, the alias check, the
  program's steps, joining a team, the duplicate-partner merge, deleting an
  account (team member and solo), grants, keys.
- `scripts/handoff-test.mjs`: the app module, the portal page, the app wiring.
