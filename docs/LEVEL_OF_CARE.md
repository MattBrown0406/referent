# Level-of-care assessment

A short, structured intake across six areas gives a **recommended level of
care with a written rationale**. The practitioner chooses the level to place
at (the recommendation, or a different level with a one-line reason); the
chosen level becomes the match's level of care, and the rationale goes into
the **program's** copy of the placement packet.

Why: clinical reasoning on paper for every placement; a level-of-care
justification payers ask for at authorization; and a prompt when a placement
drifts away from what the assessment found.

- Rules (pure, tested): `src/lib/level-of-care.ts`
- API and hook: `src/lib/level-of-care-api.ts`
- Screens: `src/lib/LevelOfCareSheet.tsx` (the assessment, inside the case
  file's own sheet), `src/lib/LevelOfCareCard.tsx` (the case-file card and
  the "Assessed: ..." line on the match)
- Server: `supabase/migrations/20261104150000_level_of_care.sql`
- Tests: `scripts/level-of-care-test.mjs`,
  `supabase/tests/level_of_care_test.sql`

## Decision support, not a diagnosis

The recommendation is a starting point for the practitioner's clinical
judgment. The app says so on the card, on the first screen and on the
result. The practitioner can always choose a different level; when they do,
they give a one-line reason, which is stored, shown on the card and printed
in the program's packet next to the recommendation. Nothing in the app
blocks a placement because of an assessment.

## Licensing

The six areas follow **the widely used six-dimension framework** for
substance-use placement. That framework's criteria, scales and decision
rules are licensed; **none of them is used here**. Every question,
descriptor, rule and sentence in this feature is ReferralFit's own wording,
written for this app. The framework's licensed name is not used in the UI,
the packet, the timeline, the migration or the feature's source files
(`scripts/level-of-care-test.mjs` checks the screens, the rules module, the
generated rationale and packet section, and the migration). If ReferralFit
ever licenses the criteria, that would be a separate, reviewed change.

## The six areas

Each area is rated **0 to 4** (0 none, 1 mild, 2 moderate, 3 significant,
4 severe; for readiness, a higher rating means less ready). Each has an
optional note of up to 200 characters. Notes stay in the workspace: they are
never printed in a packet, on the timeline or in the rationale.

Before the six areas, one question: **is anyone in immediate danger right
now?** "Yes" shows 911 / 988 guidance at once (see Safety flags); the
assessment can continue.

### 1. Withdrawal risk

How risky it would be to stop or cut down now, and whether withdrawal has already started.

| Rating | Label | What it looks like |
| --- | --- | --- |
| 0 | None | No recent heavy use and no signs of withdrawal. |
| 1 | Mild | Some discomfort is likely if use stops; it can be handled at home. |
| 2 | Moderate | Withdrawal is likely to be hard; a medical provider should keep an eye on it. |
| 3 | Significant | Heavy daily use of alcohol, sedatives or opioids, or a hard withdrawal before; needs medically supervised withdrawal. |
| 4 | Severe | Dangerous withdrawal now or expected: seizures, confusion or hallucinations, now or in the past. Needs medical care today. |

### 2. Physical health

Medical conditions, injuries, pregnancy or pain that affect safety or treatment.

| Rating | Label | What it looks like |
| --- | --- | --- |
| 0 | None | No health problems that affect treatment. |
| 1 | Mild | Stable conditions the client manages on their own. |
| 2 | Moderate | Conditions that need regular attention but are stable, such as managed diabetes or chronic pain. |
| 3 | Significant | Conditions that need close medical monitoring or nursing care during treatment. |
| 4 | Severe | An unstable or sudden medical problem that a doctor needs to see before placement. |

### 3. Emotional, behavioral or cognitive

Mental health, mood, behavior and thinking, including whether the client can stay safe.

| Rating | Label | What it looks like |
| --- | --- | --- |
| 0 | None | No mental health or behavior concerns. |
| 1 | Mild | Some stress, low mood or worry that does not get in the way of daily life. |
| 2 | Moderate | Symptoms that get in the way of daily life or recovery and need care alongside treatment. |
| 3 | Significant | Serious symptoms or behavior that need daily support or psychiatric care. |
| 4 | Severe | Cannot stay safe or manage day to day: for example, thoughts of suicide with a plan, losing touch with reality, or violence. |

### 4. Readiness and engagement

How willing the client is to take part in treatment. A higher rating means less ready.

| Rating | Label | What it looks like |
| --- | --- | --- |
| 0 | Ready | Wants help and is already taking steps toward it. |
| 1 | Mostly ready | Agrees to treatment, with some doubts. |
| 2 | Unsure | Goes along when family or others push; follow-through is uneven. |
| 3 | Reluctant | Does not see a problem, or turns down most help. |
| 4 | Refusing | Rejects treatment outright, or is required to attend with no buy-in at all. |

### 5. Relapse or continued-use risk

How likely use is to continue, or come back, without more structure.

| Rating | Label | What it looks like |
| --- | --- | --- |
| 0 | Low | A steady stretch without use and solid ways of coping. |
| 1 | Some | Occasional cravings, mostly handled. |
| 2 | Moderate | Recent use or strong cravings; few ways of coping. |
| 3 | Significant | Likely to keep using without structure every day. |
| 4 | Severe | Cannot stop even for a short time without round-the-clock structure, or keeps relapsing soon after treatment. |

### 6. Recovery environment

Where the client lives, the people around them, work or school, and who supports recovery.

| Rating | Label | What it looks like |
| --- | --- | --- |
| 0 | Supportive | A stable home without substances, with people who back recovery. |
| 1 | Mostly supportive | Some stress at home or a few gaps in support. |
| 2 | Mixed | Substances or conflict at home, or few people to lean on. |
| 3 | Unsupportive | Home or friends work against recovery, or housing is unstable. |
| 4 | Unsafe | Violence, abuse or active use at home, or no safe place to live. |

## The rules (for a clinician reviewer)

One table, in `LEVEL_OF_CARE_RULES` (`src/lib/level-of-care.ts`), **version
2**. Version 2 is version 1 plus Matt's clinical decisions of **2026-11-05**,
marked "(v2)" below: withdrawal oversight (rule 3), several moderate risks
together (rule 2b), the step down after detox (rule 4), and no emergency
first step (rule 6). Only version 2 is accepted by the server; no
assessment was ever saved under version 1.

The recommended level is the **most intensive level any rule asks for**.

**1. Each area on its own.** Areas 2 to 6 each ask for a level:

| Area | 0 | 1 | 2 | 3 | 4 |
| --- | --- | --- | --- | --- | --- |
| 2. Physical health | Therapist | Therapist | IOP / PHP | Inpatient | Inpatient |
| 3. Emotional, behavioral or cognitive | Therapist | Therapist | IOP / PHP | Inpatient | Inpatient |
| 4. Readiness and engagement | Therapist | Therapist | Therapist | IOP / PHP | IOP / PHP |
| 5. Relapse or continued-use risk | Therapist | Therapist | IOP / PHP | IOP / PHP | Inpatient |
| 6. Recovery environment | Therapist | Therapist | Therapist | Therapist (+ sober living) | Inpatient (+ sober living) |

"Therapist" is outpatient therapy. Low readiness on its own asks for more
structure and engagement work (IOP / PHP), never residential care.

**2. Risks together.** Risks that each ask for less add up to 24-hour
structure (Inpatient), whatever each asks for alone:

| Rule | When | Level |
| --- | --- | --- |
| 2a. Serious risks together | **Two or more** of readiness, relapse and environment rated **3 or 4** | Inpatient |
| 2b. Several moderate risks together (v2) | **Four or more** of physical, emotional, readiness, relapse and environment rated **2 or more** | Inpatient |

Three of the five at 2 or more is not enough for 2b (for example 0 2 2 2 1 0
is IOP / PHP; 0 2 2 2 2 0 is Inpatient).

**3. Withdrawal oversight (v2).** Withdrawal risk **2**: withdrawal needs
medical oversight, so the level is **at least IOP / PHP**. Withdrawal never
asks for more than that on its own, and a rating of 2 is not detox.

**4. Detox first, then step down no lower than IOP / PHP (v2).** Withdrawal
risk **3 or 4**: medically supervised withdrawal (Detox) is the **first
step**. The level after it comes from the rules above, and is **never lower
than IOP / PHP**.

**5. Sober living as support.** Recovery environment **3 or 4**: sober
living is added as a **support level** (during outpatient or IOP / PHP
treatment, or after residential care). At 4 the environment also asks for
Inpatient (rule 1).

**6. Severe physical or emotional needs (v2, unchanged levels).** Physical
health 4 and emotional, behavioral or cognitive 4 stay **Inpatient**
(rule 1), with their urgent flags (an urgent medical or psychiatric
evaluation; see Safety flags). There is **no emergency first step**: Matt
chose this explicitly. Emergencies go to 911 / 988 through the immediate
danger question and the flags, not through the recommendation.

| Rule | Where in `LEVEL_OF_CARE_RULES` | In the server's `level_of_care_recommendation` |
| --- | --- | --- |
| 1 | `primary` | `p >= 3 OR m >= 3 OR u >= 4 OR e >= 4` (Inpatient); `p >= 2 OR m >= 2 OR u >= 2 OR r >= 3` (IOP / PHP) |
| 2a | `together` (`serious`) | `(r >= 3) + (u >= 3) + (e >= 3) >= 2` |
| 2b | `together` (`moderate`) | `(p >= 2) + (m >= 2) + (r >= 2) + (u >= 2) + (e >= 2) >= 4` |
| 3, 4 | `oversight`, `firstStep.stepDownAtLeast` | `w >= 2` (IOP / PHP) |
| 4 | `firstStep` | `first_step` Detox when `w >= 3` |
| 5 | `support` | `support` Sober Living when `e >= 3` |

**The recommendation** is therefore: an optional first step (Detox), a level
(Therapist, IOP / PHP or Inpatient), and an optional support (Sober Living),
written "Detox, then Inpatient, with Sober Living".

**Monotonic.** Every rule only moves up as a rating rises, so raising any
rating can never lower the level, remove detox or remove sober living. The
test checks all 15,625 possible rating sets and every raise.

**Choosing the level to place at.** "Use recommended" picks where the
recommendation starts: the first step when there is one (where the client
goes now, Detox), else the level. That choice needs no reason. **Any other
level needs a one-line reason**, including the level after a Detox first
step (placing straight there skips the detox the rules called for), sober
living alone, or a lower or higher level. The reason is 3 to 200
characters on one line, and because it is printed in the program's packet
it goes through the shared identifying-details check
(`identifying_text_problem`, rules version 2, the same one as the
placement-request note; see docs/PLACEMENT_REQUESTS.md for the rules): no
hidden characters, email addresses, links, money, dates, phone or ID
numbers, or a name word from the case's title or its contacts' names (there
is no client label here). The server's refusal is the RPC's 22023 error
message, e.g. "Leave out names ("rivera" is a name on this case). Programs
read this."

### Named cases

W P E R U Env = withdrawal, physical, emotional/behavioral/cognitive,
readiness, relapse, environment. The rationale is exactly what the app
writes (the test asserts every row of this table, word for word).

| W P E R U Env | Recommended | Rationale (as generated) |
| --- | --- | --- |
| 0 0 0 0 0 0 | Therapist | Outpatient therapy is recommended: no area calls for more structure than regular sessions. No area shows a concern. |
| 1 1 1 1 1 1 | Therapist | Outpatient therapy is recommended: no area calls for more structure than regular sessions. Every area is rated mild or none. |
| 3 0 0 0 0 0 | Detox, then IOP / PHP | Withdrawal risk is significant (3 of 4), so medically supervised withdrawal (detox) comes first. After detox, step down no lower than intensive outpatient or day treatment (IOP / PHP). No other area shows a concern. |
| 4 0 0 0 0 0 | Detox, then IOP / PHP | Withdrawal risk is severe (4 of 4), so medically supervised withdrawal (detox) comes first. After detox, step down no lower than intensive outpatient or day treatment (IOP / PHP). No other area shows a concern. |
| 3 1 1 1 1 1 | Detox, then IOP / PHP | Withdrawal risk is significant (3 of 4), so medically supervised withdrawal (detox) comes first. After detox, step down no lower than intensive outpatient or day treatment (IOP / PHP). Other areas are rated mild or none. |
| 2 0 0 0 0 0 | IOP / PHP | Withdrawal risk is moderate (2 of 4) and needs medical oversight, so at least intensive outpatient or day treatment (IOP / PHP) is recommended. No other area shows a concern. |
| 0 2 0 0 0 0 | IOP / PHP | Intensive outpatient or day treatment (IOP / PHP) is recommended because of moderate physical health needs (2 of 4). No other area shows a concern. |
| 0 0 3 0 0 0 | Inpatient | Inpatient (residential) care is recommended because of significant emotional, behavioral or cognitive needs (3 of 4). No other area shows a concern. |
| 0 3 0 0 0 0 | Inpatient | Inpatient (residential) care is recommended because of significant physical health needs (3 of 4). No other area shows a concern. |
| 0 0 0 3 0 0 | IOP / PHP | Intensive outpatient or day treatment (IOP / PHP) is recommended because of significant readiness and engagement concerns (3 of 4). No other area shows a concern. |
| 0 0 0 4 0 0 | IOP / PHP | Intensive outpatient or day treatment (IOP / PHP) is recommended because of severe readiness and engagement concerns (4 of 4). No other area shows a concern. |
| 0 0 0 0 2 0 | IOP / PHP | Intensive outpatient or day treatment (IOP / PHP) is recommended because of moderate relapse or continued-use risk (2 of 4). No other area shows a concern. |
| 0 0 0 0 3 0 | IOP / PHP | Intensive outpatient or day treatment (IOP / PHP) is recommended because of significant relapse or continued-use risk (3 of 4). No other area shows a concern. |
| 0 0 0 0 4 0 | Inpatient | Inpatient (residential) care is recommended because of severe relapse or continued-use risk (4 of 4). No other area shows a concern. |
| 0 0 0 0 0 3 | Therapist, with Sober Living | Outpatient therapy is recommended: no area calls for more structure than regular sessions. Recovery environment concerns are significant (3 of 4), so sober living is recommended as a stable, substance-free place to live during treatment. No other area shows a concern. |
| 0 0 0 0 0 4 | Inpatient, with Sober Living | Inpatient (residential) care is recommended because of severe recovery environment concerns (4 of 4). Sober living is also recommended as a stable, substance-free place to live after residential care. No other area shows a concern. |
| 0 0 0 3 3 0 | Inpatient | Inpatient (residential) care is recommended because serious risks occur together: significant readiness and engagement concerns (3 of 4) and significant relapse or continued-use risk (3 of 4). No other area shows a concern. |
| 0 0 0 0 3 3 | Inpatient, with Sober Living | Inpatient (residential) care is recommended because serious risks occur together: significant relapse or continued-use risk (3 of 4) and significant recovery environment concerns (3 of 4). Sober living is also recommended as a stable, substance-free place to live after residential care. No other area shows a concern. |
| 0 0 0 3 0 3 | Inpatient, with Sober Living | Inpatient (residential) care is recommended because serious risks occur together: significant readiness and engagement concerns (3 of 4) and significant recovery environment concerns (3 of 4). Sober living is also recommended as a stable, substance-free place to live after residential care. No other area shows a concern. |
| 0 0 0 2 2 3 | IOP / PHP, with Sober Living | Intensive outpatient or day treatment (IOP / PHP) is recommended because of moderate relapse or continued-use risk (2 of 4). Recovery environment concerns are significant (3 of 4), so sober living is recommended as a stable, substance-free place to live during treatment. Also noted: moderate readiness and engagement concerns (2 of 4). |
| 0 2 2 2 2 0 | Inpatient | Several areas are at moderate risk together, which calls for inpatient (residential) care: moderate physical health needs (2 of 4), moderate emotional, behavioral or cognitive needs (2 of 4), moderate readiness and engagement concerns (2 of 4) and moderate relapse or continued-use risk (2 of 4). No other area shows a concern. |
| 0 2 2 2 1 0 | IOP / PHP | Intensive outpatient or day treatment (IOP / PHP) is recommended because of moderate physical health needs (2 of 4) and moderate emotional, behavioral or cognitive needs (2 of 4). Also noted: moderate readiness and engagement concerns (2 of 4). |
| 0 0 2 2 2 2 | Inpatient | Several areas are at moderate risk together, which calls for inpatient (residential) care: moderate emotional, behavioral or cognitive needs (2 of 4), moderate readiness and engagement concerns (2 of 4), moderate relapse or continued-use risk (2 of 4) and moderate recovery environment concerns (2 of 4). No other area shows a concern. |
| 3 2 2 2 2 3 | Detox, then Inpatient, with Sober Living | Withdrawal risk is significant (3 of 4), so medically supervised withdrawal (detox) comes first. Several areas are at moderate risk or higher together, which calls for inpatient (residential) care after detox: moderate physical health needs (2 of 4), moderate emotional, behavioral or cognitive needs (2 of 4), moderate readiness and engagement concerns (2 of 4), moderate relapse or continued-use risk (2 of 4) and significant recovery environment concerns (3 of 4). Sober living is also recommended as a stable, substance-free place to live after residential care. |
| 0 4 0 0 0 0 | Inpatient | Inpatient (residential) care is recommended because of severe physical health needs (4 of 4). No other area shows a concern. |
| 0 0 4 0 0 0 | Inpatient | Inpatient (residential) care is recommended because of severe emotional, behavioral or cognitive needs (4 of 4). No other area shows a concern. |
| 4 3 2 1 2 3 | Detox, then Inpatient, with Sober Living | Withdrawal risk is severe (4 of 4), so medically supervised withdrawal (detox) comes first. After detox, inpatient (residential) care is recommended because of significant physical health needs (3 of 4). Recovery environment concerns are significant (3 of 4), so sober living is recommended as a stable, substance-free place to live after residential care. Also noted: moderate emotional, behavioral or cognitive needs (2 of 4) and moderate relapse or continued-use risk (2 of 4). |
| 4 4 4 4 4 4 | Detox, then Inpatient, with Sober Living | Withdrawal risk is severe (4 of 4), so medically supervised withdrawal (detox) comes first. After detox, inpatient (residential) care is recommended because of severe physical health needs (4 of 4), severe emotional, behavioral or cognitive needs (4 of 4), severe readiness and engagement concerns (4 of 4), severe relapse or continued-use risk (4 of 4) and severe recovery environment concerns (4 of 4). Sober living is also recommended as a stable, substance-free place to live after residential care. |

### The rationale

Two to four short sentences, built **only from the ratings and fixed
words**: the first step and why, the level and why, sober living and why,
then anything else rated moderate or higher ("Also noted: ..."). Ratings
appear as "(3 of 4)". The level's reason is the most specific rule that
gives it:

- areas that ask for it on their own: "Inpatient (residential) care is
  recommended because of significant physical health needs (3 of 4)."
- rule 2a: "... is recommended because serious risks occur together: ..."
- rule 2b: "Several areas are at moderate risk together, which calls for
  inpatient (residential) care: ..." ("or higher" when one of them is rated
  above 2; "after detox" when detox comes first)
- rule 3: "Withdrawal risk is moderate (2 of 4) and needs medical oversight,
  so at least intensive outpatient or day treatment (IOP / PHP) is
  recommended."
- rule 4: "After detox, step down no lower than intensive outpatient or day
  treatment (IOP / PHP)."

When an area already asks for the level on its own, a rule that gives the
same level is not repeated: rule 2b's and the withdrawal floor's areas
appear under "Also noted" (rule 2a's areas, as in version 1, are named with
the area).

The rationale never includes a note, a name, the case title or anything
else about the client. An assessment saved under rules that would now
recommend something different keeps its stored recommendation; its
rationale is not rebuilt.

### Safety flags

| When | Severity | Title | What it says |
| --- | --- | --- | --- |
| Immediate danger (the first question) | emergency | Someone may be in immediate danger | If anyone is in immediate danger, call 911 now. For thoughts of suicide or an emotional crisis, call or text 988 (the Suicide & Crisis Lifeline). Stay with the person, or keep a safe adult with them, until help arrives. Placement can wait until everyone is safe. |
| Withdrawal risk 4 | urgent | Arrange medically supervised withdrawal today | Severe withdrawal risk: the client should not stop on their own. Arrange a medically supervised setting today. Seizures, confusion or hallucinations during withdrawal are an emergency: call 911. |
| Physical health 4 | urgent | Arrange an urgent medical evaluation | Arrange an urgent medical evaluation before placement: the client's doctor today, urgent care, or an emergency department. Programs may need a doctor's clearance to admit. If symptoms are life-threatening, call 911. |
| Emotional, behavioral or cognitive 4 | urgent | Arrange an urgent psychiatric evaluation | Arrange an urgent psychiatric evaluation before placement. If there are thoughts of suicide, call or text 988. If anyone is in danger now, call 911. |
| Recovery environment 4 | urgent | Plan a safe place to stay until admission | The living situation is unsafe. Plan where the client can stay safely until admission. If anyone is being hurt or threatened, call 911. |
| Withdrawal risk 2 | advice | Make sure a medical provider oversees withdrawal at whichever level is chosen | Withdrawal needs medical oversight at this level of risk. Make sure a medical provider oversees withdrawal at whichever level is chosen. |
| Withdrawal risk 3 or 4 | advice | Arrange detox first, or a program with on-site withdrawal management | Withdrawal needs medical oversight at this level of risk. Arrange detox first, or choose a program that manages withdrawal on site, with medical staff. |
| Physical health 3 or 4 | advice | Ask about medical care on site | Ask each program whether it can manage these medical needs on site, with nursing. |
| Emotional, behavioral or cognitive 3 or 4 | advice | Look for psychiatric care on site | Look for programs with psychiatric care on site (the "Dual diagnosis" need on the match). |
| Relapse risk 3 or 4, or detox as the first step | advice | Plan for overdose risk | After detox or any break from use, tolerance drops, so using the same amount as before can cause an overdose. Make sure the family has naloxone (Narcan) and knows how to use it, and to call 911 if someone may be overdosing. |

Flags are cumulative: a higher rating keeps every flag a lower one raised
(physical 4 shows the urgent evaluation and the on-site advice of 3). The
withdrawal advice is one flag (`withdrawal_oversight`) worded for the
rating: at 2, where the rules ask for medical oversight and leave the level
open, a medical provider oversees withdrawal at whichever level is chosen;
at 3 and 4, where detox is the first step, it says to arrange detox first.
The wording is all that differs: the rules and their digest are unchanged.

Emergency and urgent flags show on the result screen (and as soon as the
rating is chosen); the card keeps a short "Safety notes from this
assessment" list. Flags never change the recommendation: emergencies go to
911 / 988, not to placement.

## Changing the rules

1. Change `LEVEL_OF_CARE_RULES` (and, if needed, `recommend()`) in
   `src/lib/level-of-care.ts`, and bump `version`.
2. Change `public.level_of_care_recommendation` in a new migration to match
   and accept the new version (keep the old version's rules if older apps
   are still in use; an app on a version the server does not know cannot
   save, by design).
3. Update the digest in **both** `scripts/level-of-care-test.mjs` and
   `supabase/tests/level_of_care_test.sql` (the JS test prints the new one
   when it fails), and the named cases above.

The server refuses to save a recommendation that its own rules would not
give for the same ratings, so the recommendation on the timeline and in the
packet is always the rules' answer, never a phone's.

## Where it shows

- **Case file, "Level of care" card** (before Benefits): the current
  recommendation, the chosen level, the reason for a different level, the
  date and who assessed, safety notes, up to three earlier assessments, and
  "Start assessment" / "Reassess" and "Find placement with this level".
- **The assessment** opens inside the case file's own sheet (the case
  file's native Modal swaps its contents; nothing is presented on top, per
  the iOS Fabric rule). Steps: the safety question, the six areas (five
  tappable ratings with their descriptors, a "Last time" hint on a
  reassessment, an optional note), the result (recommendation, rationale,
  safety flags, "Use recommended" or "Choose a different level" with the
  required reason), Save, then "Find placement with this level".
- **Find placement with this level** runs the case file's existing "Find
  placement" (`startMatchForCase`): the case's saved match opens (or a new
  one pre-filled from the case), with the chosen level as its level of care,
  exactly as if it had been picked by hand. Nothing else is duplicated.
- **Match criteria**: when the match's case has an assessment, "Assessed:
  Inpatient - Nov 4, 2026" shows under the level of care. The level stays
  editable; moved away from the assessment, a gentle note says so (or that
  the level is on the recommended path, e.g. the level after detox). Scores
  and ranking are unchanged: matching reads only the level on the form.
- **Packet, program copy**: a "LEVEL-OF-CARE RATIONALE" section after the
  client criteria: recommended and chosen level, the reason for a different
  level, the rationale, and "Assessed <date> across six areas, following the
  widely used six-dimension framework. Decision support for the
  practitioner's clinical judgment, not a diagnosis." If the referral is for
  another level than the one chosen, a line says so plainly. No client
  identity, no notes, no safety flags.
- **Packet, family copy**: nothing from the assessment. Its existing "Level
  of care: X" line already names the level in plain words; ratings and the
  rationale never appear (tested, whatever is passed in).
- **Timeline**: "Level-of-care assessment: recommended Detox, then
  Inpatient, with Sober Living", plus "; chosen X" whenever the chosen level
  is not where the recommendation starts (its first step, else its level):
  e.g. "recommended Detox, then Inpatient; chosen Inpatient". Levels only,
  never a rating.
- **Placement requests**: untouched. Nothing from an assessment is added to
  their payload; the ten-key allow-list in 20261104140000 is unchanged.

## What is stored

`public.case_assessments`, one row per assessment; a case can be reassessed
and the newest (`assessed_at`, then `id`) is current.

| Column | What it holds |
| --- | --- |
| `id` | Made by the app; a retry with the same id is a no-op. The timeline entry has the same id. |
| `org_id`, `case_id` | The case and its workspace (composite foreign key to `cases`) |
| `withdrawal_rating` ... `environment_rating` | Six integers, 0 to 4 |
| `withdrawal_note` ... `environment_note` | Six notes, at most 200 characters each, trimmed |
| `imminent_danger` | The answer to the safety question |
| `recommended_level`, `recommended_first_step`, `recommended_support` | The recommendation (Therapist / IOP / PHP / Inpatient; Detox or none; Sober Living or none) |
| `chosen_level` | Detox, Inpatient, IOP / PHP, Sober Living or Therapist |
| `override_reason` | Empty exactly when the chosen level is where the recommendation starts, `coalesce(recommended_first_step, recommended_level)` (a CHECK) |
| `rules_version` | The rules the recommendation came from (2; the server accepts only the current version) |
| `assessed_by`, `assessed_at`, `created_at` | Who (set to NULL if that account is deleted) and when, both server-set |

## Who reads and writes what

- **Reads**: members of the case's workspace (RLS, `org_id =
  current_org_id()`). Another practice reads nothing; anon reads nothing.
  Signed-in users hold SELECT only, revoked first because production's
  default ACL grants ALL.
- **Writes**: only `save_case_assessment` (SECURITY DEFINER, `search_path`
  pinned, org-fenced). It checks the six ratings, the notes, the level, that
  the recommendation matches the server's rules for that rules version, and
  the reason for a different level (against the case's title and its
  contacts' names), all in plain words; writes the row and
  the timeline entry; and returns the row with `event_body`. Replaying an id
  returns the saved row unchanged; another workspace's id is "not found".
- **Deleting a case** deletes its assessments and their timeline entries.
- **Deleting an account**: a sole owner's workspace takes its cases and
  their assessments with it; a teammate's assessments stay with the
  practice, unattributed (`assessed_by` set to NULL). `delete_own_account`
  is unchanged.
- **Joining a workspace**: assessments follow their case (ON UPDATE CASCADE)
  and `org_move_workspace_rows` (re-created from its latest definition in
  20261104140000, same signature) moves them explicitly.

## Offline and older servers

Reads are online only and not part of the case file's offline copy (as with
Benefits): offline, the card says "Assessment loads when you're online."
The save is an online-only RPC that throws the app's `OfflineError`; the
sheet keeps every answer on screen and "Try again" reuses the same id, so a
save that did land is never saved twice. Changed answers get a new id.

Against a server **without** this migration the read gets PGRST205 / 42P01 /
42703 (PGRST202 / 42883 for the RPC), reports `available: false`, and the
whole feature hides: no card, no "Assessed" line, no packet section.

## Compatibility with the 1.0.4 app

Purely additive: one new table and new functions. The only existing function
re-created is the internal `org_move_workspace_rows` (called only by
`accept_org_invite`), from its latest definition plus one line, with the
same signature. No existing table, column, policy, trigger or callable
function changes; the 1.0.4 app never sees the table. It uses
`identifying_text_problem` and `identifying_case_names` from
20261104140000.

## Applying to production

Production has every migration through 20261024130000. Apply, in order,
`20261104120000_family_cost.sql`, `20261104130000_program_integrity.sql`,
`20261104140000_placement_requests.sql`, then this one, **before** shipping
an app build with the feature (the app copes without it, but the feature
stays hidden). The file checks the order itself: without the placement
request tables or the identifying-details check it stops at once with
"Paste 20261104140000_placement_requests.sql first: ..." and changes
nothing.

1. Paste `supabase/migrations/20261104150000_level_of_care.sql` into the SQL
   editor and run it. It is ASCII only, has no backslashes, every top-level
   statement is under 3,700 characters, and it runs in one BEGIN/COMMIT.
   Re-running a file before the next one is pasted is harmless (CREATE TABLE /
   INDEX IF NOT EXISTS, DROP POLICY IF EXISTS, DROP FUNCTION IF EXISTS for an
   older draft's signature, CREATE OR REPLACE). Once a later file is in, do not
   re-run an earlier one: it would put back older copies of the shared helpers
   the later file re-creates.
2. Record it:

   ```sql
   INSERT INTO supabase_migrations.schema_migrations (version, name)
   VALUES ('20261104150000', 'level_of_care');
   ```

3. Verify:

   ```sql
   -- RLS on; signed-in users read only; anon nothing.
   SELECT c.relrowsecurity AS rls,
          has_table_privilege('authenticated', c.oid, 'SELECT') AS authenticated_select,
          has_table_privilege('authenticated', c.oid, 'INSERT') OR has_table_privilege('authenticated', c.oid, 'UPDATE')
            OR has_table_privilege('authenticated', c.oid, 'DELETE') OR has_table_privilege('authenticated', c.oid, 'TRUNCATE') AS authenticated_writes,
          has_table_privilege('anon', c.oid, 'SELECT') AS anon_select
     FROM pg_class c WHERE c.oid = 'public.case_assessments'::regclass;

   -- Who may call what.
   SELECT p.proname,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_ok,
          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_ok
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND (p.proname LIKE 'case_assessment%' OR p.proname IN ('level_of_care_recommendation', 'save_case_assessment', 'org_move_workspace_rows'))
    ORDER BY p.proname;

   -- The rules (version 2), spot-checked: detox first, then inpatient,
   -- with sober living; and detox first, then no lower than IOP / PHP.
   SELECT public.level_of_care_recommendation(ARRAY[3, 2, 3, 2, 2, 3], 2) AS recommendation,
          public.level_of_care_recommendation(ARRAY[3, 0, 0, 0, 0, 0], 2) AS step_down;

   -- Skipping the detox first step needs a reason.
   SELECT public.case_assessment_problem(ARRAY[3, 3, 0, 0, 0, 0], NULL, 2, 'Inpatient', 'Detox', NULL, 'Inpatient', '', NULL) AS skip_detox;
   ```

   Expected: `rls = true`, `authenticated_select = true`,
   `authenticated_writes = false`, `anon_select = false`. Every function
   `anon_ok = false`; `authenticated_ok = true` for `save_case_assessment`
   only. The recommendation is
   `{"level": "Inpatient", "support": "Sober Living", "first_step": "Detox"}`
   and `step_down` is `{"level": "IOP / PHP", "support": null, "first_step": "Detox"}`;
   `skip_detox` is "Say why you chose a different level. The reason goes in
   the program's packet."
4. Ship the app build. Nothing else to deploy: no Edge Function, cron,
   secret or portal change.

## Not in this version

- Assessments are not part of the case file's offline copy (the case-file
  cache is versioned events and documents; extending it is a separate
  change). Offline, the card says it loads when online.
- No editing or deleting an assessment: reassess instead (history is kept,
  newest is current). There is no per-day cap on reassessments.
- The family's copy shows only its existing "Level of care" line; no
  plain-language summary of the assessment is added.
- Notes are free text in the workspace (like the case summary): they are not
  screened for names, and they never leave the workspace.
- No push notification or Today card for an urgent flag; the flags show on
  the result screen and on the case-file card.
- The center portal does not show assessments; programs see the rationale
  only in the packet the practitioner sends.
