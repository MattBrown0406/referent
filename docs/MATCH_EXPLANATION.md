# Why these programs: the family's explanation of a match

**Status: built 2026-11-08 on branch feat/day-review (ships with the next
build).**

On the Match screen, **Explain to the family** writes a plain-language
"why these programs" from the ranking already on the screen, ready to send
by Messages or Mail. It explains the order; it never changes it.

## What the family gets

```
Why these programs

These are the 3 programs that fit your loved one's needs best, in order.
Each one provides Inpatient care, works with Aetna, serves Oregon, and offers MAT.

1. Juniper Ridge Recovery (Inpatient, Bend, OR) · fit 87 of 100
Why it fits: In-network with Aetna; In Oregon, close to family; Offers EMDR.
It ranks above Cedar House mainly because it offers more of what your loved one needs.

2. Cedar House (...)
To check: Does not list Family program: ask the program.

3. Harbor Light (...)
To check: Accepts Aetna out-of-network — verify benefits.
Disclosure: our practice has a financial relationship with this program (...)

How the order was decided: each program gets a fit score out of 100 ...
How many people a program refers, and any business relationship with a
program, are never part of the score.

This is a starting point for our conversation, not a medical decision ...
```

- **The order is the ranking.** The sheet gets the Match screen's own list
  (`rankPrograms`) and explains the top 1 to 5 in that order.
- **Why each comes first** is read from the ranker's own comparison
  (`compareScored`): the score part with the biggest lead (what the client
  needs, cost to the family, location, track record), or, on a tie, the
  open bed, the lower cost, or the app's fair rotation.
- **Why it fits** uses the same facts as the packet's family copy
  (`buildFitReasons`). Anything to check (needs it does not list, out of
  network, a cost not on file) is listed as "To check".
- **Disclosures:** a program with a financial relationship carries the
  packet's disclosure line. If the practitioner edits it out, it is added
  back when the text is shared or copied (`withDisclosures`).
- **No names:** no client label, family name or case details are in it.

## Warmer words (with the practitioner's own key)

**Rewrite in warmer words** sends the facts only (`rewriteFacts`): the
intro, and per program its name, place, fit, reasons and order sentence.
Never the cautions, disclosures, how the order was decided or the closing:
the app adds those as written. The `ai-assist` Edge Function
(`explain_matches`) uses Claude Opus 5.5 at low effort with a strict schema,
and checks the answer before it comes back:

- the same programs in the same order, each paragraph naming its own program;
- another program is mentioned only where that program's facts do;
- no number that is not in the facts;
- no "best", "guarantee", "cure", "promise", "always" or "never" that the
  facts did not say.

When a check fails, the practitioner keeps the plain version. The phone
also refuses a rewrite made for a ranking that has since changed.

## Pieces

| Piece | Where |
| --- | --- |
| The explanation (pure) | `src/lib/match-explanation.ts`, tests in `scripts/match-explanation-test.mjs` |
| The sheet | `src/lib/MatchExplanationSheet.tsx`, opened from Match, "Explain to the family" |
| The call | `src/lib/ai-assist-api.ts` |
| Edge Function | `supabase/functions/ai-assist/` (`index.ts`, `common.ts`, `explain.ts`, `explain_test.ts`) |
| Daily cap | `supabase/migrations/20261109130000_ai_assist.sql` (`claim_ai_assist`, per kind: 100 explanations, 60 level-of-care suggestions a day; the function runs without it until applied), `supabase/tests/ai_assist_test.sql` |

## Deploy (Matt, at build time)

For the 1.3.0 release, follow the one ordered list in
`docs/FAMILY_ASSESSMENT.md` ("Deploy"): functions first, then the database.
This feature's own parts:

1. Paste `supabase/migrations/20261109130000_ai_assist.sql` in the SQL
   editor (ASCII, one BEGIN/COMMIT, safe to re-run), with its
   `schema_migrations` row.
2. `supabase functions deploy ai-assist --no-verify-jwt --project-ref ovfafffvcpaahktvlsdm`
   (it checks the session itself, like `draft-follow-up`).
3. Privacy policy: the AI drafts section already covers sending text to
   Anthropic on the user's own key; add "an explanation of program options
   (program names and why they fit; no names of people)" to the list of
   what can be sent.
