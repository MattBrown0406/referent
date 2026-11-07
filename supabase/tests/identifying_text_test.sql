-- The identifying-details check (public.identifying_text_problem and its
-- helpers, in 20261104140000_placement_requests.sql), rules version 2, the
-- SQL twin of identifyingTextProblem in src/lib/identifying-text.ts.
--
-- Section B runs every case of scripts/fixtures/identifying-text-cases.json
-- with its names and client label: null is allowed, a name refusal must
-- quote the expected word, any other refusal must contain the expected
-- word. Section B is written by `node scripts/identifying-text-test.mjs
-- --write` (which also sets the plan), and `npm test` checks that every
-- case is here exactly as the app's test runs it. Invisible characters are
-- written with chr() so they can be read here.
--
-- This file is never pasted into production.

BEGIN;
SELECT plan(286);

-- ===========================================================================
-- A. The functions themselves
-- ===========================================================================

SELECT ok(
  (SELECT bool_and(p.provolatile = 'i' AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog']) AND count(*) = 12
     FROM pg_proc p
    WHERE p.oid IN ('public.identifying_text_problem(text, text[], text)'::regprocedure, 'public.identifying_fold(text)'::regprocedure,
                    'public.identifying_ordinary_words()'::regprocedure, 'public.identifying_everyday_two()'::regprocedure,
                    'public.identifying_abbreviations()'::regprocedure, 'public.identifying_name_words(text[])'::regprocedure,
                    'public.identifying_tokens(text)'::regprocedure, 'public.identifying_label_initials(text)'::regprocedure,
                    'public.identifying_mentions_date(text)'::regprocedure, 'public.identifying_mentions_id_number(text)'::regprocedure,
                    'public.identifying_mentions_money(text)'::regprocedure, 'public.identifying_name_found(text, text[], text)'::regprocedure)),
  'the check and its eleven helpers: immutable, run as the caller, search_path pinned'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'identifying%'
       AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))),
  'internal: only the SECURITY DEFINER writers call them (identifying_case_names included)'
);
SELECT is(
  (SELECT array_agg(p.proname || '/' || p.pronargs ORDER BY p.proname)
     FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('identifying_text_problem', 'placement_note_problem')),
  ARRAY['identifying_text_problem/3', 'placement_note_problem/3'],
  'one of each: the older (text, text[]) versions are dropped before the new ones are made'
);
SELECT is(
  public.identifying_name_words(ARRAY['Rivera family ' || chr(8212) || ' son Jake']),
  ARRAY['jake', 'rivera'],
  'name words: letters only, no relationship words (nameWords)'
);
SELECT is(
  public.identifying_name_words(ARRAY['Jos' || chr(233) || ' N' || chr(250) || chr(241) || 'ez', 'Al', 'Mom and Dad', NULL]),
  ARRAY['al', 'jose', 'nunez'],
  'accents are folded, a two-letter name counts, relationship words never do, a missing name is skipped'
);
SELECT is(
  public.identifying_name_words(ARRAY['Rivera intervention', 'Lopez family''s first call', 'New inquiry - detox follow-up']),
  ARRAY['lopez', 'rivera'],
  'a case title''s ordinary words are never a name; the name in it still is (nameWords)'
);
SELECT is(
  public.identifying_name_words(ARRAY['Rivera - TX', 'AA follow-up', 'Lopez 3rd call', 'Ed', 'Li', 'Dr. Ng']),
  ARRAY['li', 'lopez', 'ng', 'rivera'],
  'everyday words, state codes, care shorthand and ordinal endings are never two-letter names'
);
SELECT is(
  ARRAY[array_to_string(public.identifying_label_initials('J.R. 34M'), ','), array_to_string(public.identifying_label_initials('Client A'), ','),
        array_to_string(public.identifying_label_initials('Case 2024-117'), ','), array_to_string(public.identifying_label_initials('IN'), ','),
        array_to_string(public.identifying_label_initials(NULL), ','), array_to_string(public.identifying_label_initials('TX 34'), ',')],
  ARRAY['34m,jr', '', '', '', '', 'tx'],
  'the label''s initials: dotted initials collapse, a tag with a letter counts; never an ordinary or everyday word or a number alone (labelInitials)'
);
SELECT is(
  (SELECT array_agg(t.token ORDER BY t.token COLLATE "C") FROM unnest(public.identifying_tokens(public.identifying_fold('J.R.''s note: jr. 34M e.g.'))) AS t(token)),
  ARRAY['34m', 'eg', 'jr', 'jr', 'note', 's'],
  'tokens: letters or digits, dotted initials collapsed, a closing period dropped (tokens)'
);
SELECT is(
  ARRAY[public.identifying_text_problem('', NULL), public.identifying_text_problem(NULL, NULL),
        public.identifying_text_problem('Rivera asked', NULL), public.identifying_text_problem('Rivera asked', ARRAY[]::text[]),
        public.identifying_text_problem('JR asked', NULL, NULL), public.identifying_text_problem('JR asked', NULL, '')],
  ARRAY[NULL, NULL, NULL, NULL, NULL, NULL]::text[],
  'empty or missing text is fine; without names or a label, a name is not known'
);
SELECT is(
  public.identifying_text_problem('Jos' || chr(233) || ' asked about detox', ARRAY['Jose Lopez']),
  'Leave out names ("jose" is a name on this case). Programs read this.',
  'accents are folded on both sides, and the message says which word'
);
SELECT is(
  ARRAY[public.identifying_text_problem('3nov 12', NULL), public.identifying_text_problem('xnov 12', NULL)],
  ARRAY['Leave out dates such as a birth date. Programs read this.', NULL],
  'a month name must start a word (not follow a letter): 3nov 12 is a date, xnov 12 is not'
);
SELECT is(
  ARRAY[public.identifying_text_problem('affordable', NULL), public.identifying_text_problem('jane [at] gmail [dot] com', NULL),
        public.identifying_text_problem('x' || chr(160) || 'y', NULL), public.identifying_text_problem('x' || chr(133) || 'y', NULL)],
  ARRAY['Leave money out. Programs read this.', 'Leave out email addresses. Programs read this.', NULL, 'Remove line breaks and hidden characters.'],
  'the same edge cases as the app: afford words, [at] [dot] addresses, a no-break space is fine, a C1 control is hidden'
);
SELECT is(
  ARRAY[public.identifying_text_problem('the Riveras want a quiet place', ARRAY['Rivera intervention']),
        public.identifying_text_problem('a riverside setting', ARRAY['Rivera intervention'])],
  ARRAY['Leave out names ("rivera" is a name on this case). Programs read this.', NULL],
  'a name''s plural is the name; a longer word is not'
);
SELECT is(
  ARRAY[public.placement_note_problem('JR prefers mornings', ARRAY['Rivera intervention'], 'J.R.'),
        public.placement_note_problem('JR prefers mornings', ARRAY['J.R.']),
        public.placement_note_problem('Rivera prefers mornings', ARRAY[]::text[], 'Rivera family')],
  ARRAY['Leave out names ("jr" is a name on this case). Programs read this.', NULL,
        'Leave out names ("rivera" is a name on this case). Programs read this.'],
  'the note: the label''s initials count for the label only; its words count as names'
);

-- ===========================================================================
-- B. The shared cases (scripts/fixtures/identifying-text-cases.json)
-- ===========================================================================

-- BEGIN fixture cases (node scripts/identifying-text-test.mjs --write; do not edit by hand)
SELECT set_config('test.names', (ARRAY['Jane Rivera', 'Rivera family — son Jake', 'Maria Lopez', 'Rivera intervention'])::text, true);
SELECT set_config('test.label', 'J.R. 34M', true);

SELECT is(public.identifying_text_problem('Prefers a small program with a quiet setting', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Prefers a small program with a quiet setting');
SELECT is(public.identifying_text_problem('Needs medication management and a trauma focus', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Needs medication management and a trauma focus');
SELECT is(public.identifying_text_problem('Family prefers somewhere within a few hours of home', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Family prefers somewhere within a few hours of home');
SELECT is(public.identifying_text_problem('Admit within 3 days if possible', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Admit within 3 days if possible');
SELECT is(public.identifying_text_problem('Son has tried outpatient twice', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Son has tried outpatient twice');
SELECT is(public.identifying_text_problem('Needs a 30 day stay, 2 prior admissions', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Needs a 30 day stay, 2 prior admissions');
SELECT is(public.identifying_text_problem('Call me at the office if you have a bed', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Call me at the office if you have a bed');
SELECT is(public.identifying_text_problem('intervention planned for next week', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: intervention planned for next week');
SELECT is(public.identifying_text_problem('decent 12', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: decent 12');
SELECT is(public.identifying_text_problem('marvel 3', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: marvel 3');
SELECT ok(coalesce(lower(public.identifying_text_problem('jane@gmail.com', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%email%', false), 'refused as email: jane@gmail.com');
SELECT ok(coalesce(lower(public.identifying_text_problem('jane@gmail', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%email%', false), 'refused as email: jane@gmail');
SELECT ok(coalesce(lower(public.identifying_text_problem('jane＠gmail.com', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%email%', false), 'refused as email: jane＠gmail.com');
SELECT ok(coalesce(lower(public.identifying_text_problem('rivera at gmail dot com', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%email%', false), 'refused as email: rivera at gmail dot com');
SELECT ok(coalesce(lower(public.identifying_text_problem('see instagram.com/jriv85', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%link%', false), 'refused as link: see instagram.com/jriv85');
SELECT ok(coalesce(lower(public.identifying_text_problem('facebook.com/jane.doe.77', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%link%', false), 'refused as link: facebook.com/jane.doe.77');
SELECT ok(coalesce(lower(public.identifying_text_problem('www.example.org', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%link%', false), 'refused as link: www.example.org');
SELECT ok(coalesce(lower(public.identifying_text_problem('https://x.co/abc', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%link%', false), 'refused as link: https://x.co/abc');
SELECT ok(coalesce(lower(public.identifying_text_problem('Family can pay 40,000 cash', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%money%', false), 'refused as money: Family can pay 40,000 cash');
SELECT ok(coalesce(lower(public.identifying_text_problem('budget is 40k', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%money%', false), 'refused as money: budget is 40k');
SELECT ok(coalesce(lower(public.identifying_text_problem('family pays USD 8000', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%money%', false), 'refused as money: family pays USD 8000');
SELECT ok(coalesce(lower(public.identifying_text_problem('€30000 available', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%money%', false), 'refused as money: €30000 available');
SELECT ok(coalesce(lower(public.identifying_text_problem('cannot afford residential', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%money%', false), 'refused as money: cannot afford residential');
SELECT ok(coalesce(lower(public.identifying_text_problem('$25', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%money%', false), 'refused as money: $25');
SELECT ok(coalesce(lower(public.identifying_text_problem('DOB 3/14/1985', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%date%', false), 'refused as date: DOB 3/14/1985');
SELECT ok(coalesce(lower(public.identifying_text_problem('born 03/14/85', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%date%', false), 'refused as date: born 03/14/85');
SELECT ok(coalesce(lower(public.identifying_text_problem('admit 11.12.2026', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%date%', false), 'refused as date: admit 11.12.2026');
SELECT ok(coalesce(lower(public.identifying_text_problem('seen Nov 12', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%date%', false), 'refused as date: seen Nov 12');
SELECT ok(coalesce(lower(public.identifying_text_problem('Dec 12', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%date%', false), 'refused as date: Dec 12');
SELECT ok(coalesce(lower(public.identifying_text_problem('december 3', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%date%', false), 'refused as date: december 3');
SELECT ok(coalesce(lower(public.identifying_text_problem('Sept. 14', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%date%', false), 'refused as date: Sept. 14');
SELECT ok(coalesce(lower(public.identifying_text_problem('555/123/4567', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%number%', false), 'refused as number: 555/123/4567');
SELECT ok(coalesce(lower(public.identifying_text_problem('555,123,4567', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%number%', false), 'refused as number: 555,123,4567');
SELECT ok(coalesce(lower(public.identifying_text_problem('555_123_4567', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%number%', false), 'refused as number: 555_123_4567');
SELECT ok(coalesce(lower(public.identifying_text_problem('５５５１２３４５６７', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%number%', false), 'refused as number: ５５５１２３４５６７');
SELECT ok(coalesce(lower(public.identifying_text_problem('MRN 123456', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%number%', false), 'refused as number: MRN 123456');
SELECT ok(coalesce(lower(public.identifying_text_problem('call 541 555 0142', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%number%', false), 'refused as number: call 541 555 0142');
SELECT ok(coalesce(lower(public.identifying_text_problem('541–555–0142', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%number%', false), 'refused as number: 541–555–0142');
SELECT is(public.identifying_text_problem('Rivera', current_setting('test.names')::text[], current_setting('test.label')), 'Leave out names ("rivera" is a name on this case). Programs read this.', 'refused as name (rivera): Rivera');
SELECT is(public.identifying_text_problem('rivera refuses residential', current_setting('test.names')::text[], current_setting('test.label')), 'Leave out names ("rivera" is a name on this case). Programs read this.', 'refused as name (rivera): rivera refuses residential');
SELECT is(public.identifying_text_problem('Jake does better with men only', current_setting('test.names')::text[], current_setting('test.label')), 'Leave out names ("jake" is a name on this case). Programs read this.', 'refused as name (jake): Jake does better with men only');
SELECT is(public.identifying_text_problem('Maria  Lopez asked', current_setting('test.names')::text[], current_setting('test.label')), 'Leave out names ("lopez" is a name on this case). Programs read this.', 'refused as name (lopez): Maria  Lopez asked');
SELECT ok(coalesce(lower(public.identifying_text_problem('line one' || chr(8232) || 'line two', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%hidden%', false), 'refused as hidden: line one<U+2028>line two');
SELECT ok(coalesce(lower(public.identifying_text_problem('abc' || chr(8238) || 'def', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%hidden%', false), 'refused as hidden: abc<U+202E>def');
SELECT ok(coalesce(lower(public.identifying_text_problem('zero' || chr(8203) || 'width', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%hidden%', false), 'refused as hidden: zero<U+200B>width');
SELECT is(public.identifying_text_problem('Jose Nunez refuses residential', ARRAY['José Núñez', 'Zoë Brontë', 'Núñez family — daughter Zoë']::text[], current_setting('test.label')), 'Leave out names ("jose" is a name on this case). Programs read this.', 'refused as name (jose): Jose Nunez refuses residential [names: José Núñez | Zoë Brontë | Núñez family — daughter Zoë]');
SELECT is(public.identifying_text_problem('jose prefers men only', ARRAY['José Núñez', 'Zoë Brontë', 'Núñez family — daughter Zoë']::text[], current_setting('test.label')), 'Leave out names ("jose" is a name on this case). Programs read this.', 'refused as name (jose): jose prefers men only [names: José Núñez | Zoë Brontë | Núñez family — daughter Zoë]');
SELECT is(public.identifying_text_problem('Zoe does better with women', ARRAY['José Núñez', 'Zoë Brontë', 'Núñez family — daughter Zoë']::text[], current_setting('test.label')), 'Leave out names ("zoe" is a name on this case). Programs read this.', 'refused as name (zoe): Zoe does better with women [names: José Núñez | Zoë Brontë | Núñez family — daughter Zoë]');
SELECT is(public.identifying_text_problem('JOSÉ refuses residential', ARRAY['José Núñez', 'Zoë Brontë', 'Núñez family — daughter Zoë']::text[], current_setting('test.label')), 'Leave out names ("jose" is a name on this case). Programs read this.', 'refused as name (jose): JOSÉ refuses residential [names: José Núñez | Zoë Brontë | Núñez family — daughter Zoë]');
SELECT is(public.identifying_text_problem('Jose Garcia, needs detox', ARRAY['JOSÉ GARCÍA', 'ÉLODIE']::text[], current_setting('test.label')), 'Leave out names ("garcia" is a name on this case). Programs read this.', 'refused as name (garcia): Jose Garcia, needs detox [names: JOSÉ GARCÍA | ÉLODIE]');
SELECT is(public.identifying_text_problem('José García needs detox', ARRAY['Jose Garcia']::text[], current_setting('test.label')), 'Leave out names ("garcia" is a name on this case). Programs read this.', 'refused as name (garcia): José García needs detox [names: Jose Garcia]');
SELECT is(public.identifying_text_problem('Elodie needs detox', ARRAY['JOSÉ GARCÍA', 'ÉLODIE']::text[], current_setting('test.label')), 'Leave out names ("elodie" is a name on this case). Programs read this.', 'refused as name (elodie): Elodie needs detox [names: JOSÉ GARCÍA | ÉLODIE]');
SELECT is(public.identifying_text_problem('Jose' || chr(769) || ' refuses', ARRAY['José Núñez', 'Zoë Brontë', 'Núñez family — daughter Zoë']::text[], current_setting('test.label')), 'Leave out names ("jose" is a name on this case). Programs read this.', 'refused as name (jose): Jose<U+0301> refuses [names: José Núñez | Zoë Brontë | Núñez family — daughter Zoë]');
SELECT is(public.identifying_text_problem('Rivera''s son wants out of state', current_setting('test.names')::text[], current_setting('test.label')), 'Leave out names ("rivera" is a name on this case). Programs read this.', 'refused as name (rivera): Rivera''s son wants out of state');
SELECT is(public.identifying_text_problem('Rivera’s son wants out of state', current_setting('test.names')::text[], current_setting('test.label')), 'Leave out names ("rivera" is a name on this case). Programs read this.', 'refused as name (rivera): Rivera’s son wants out of state');
SELECT is(public.identifying_text_problem('the Riveras want a quiet place', current_setting('test.names')::text[], current_setting('test.label')), 'Leave out names ("rivera" is a name on this case). Programs read this.', 'refused as name (rivera): the Riveras want a quiet place');
SELECT is(public.identifying_text_problem('Smith-Jones family agrees', ARRAY['O''Brien family', 'Smith-Jones', 'McDonald']::text[], current_setting('test.label')), 'Leave out names ("jones" is a name on this case). Programs read this.', 'refused as name (jones): Smith-Jones family agrees [names: O''Brien family | Smith-Jones | McDonald]');
SELECT is(public.identifying_text_problem('SmithJones family agrees', ARRAY['O''Brien family', 'Smith-Jones', 'McDonald']::text[], current_setting('test.label')), NULL, 'allowed: SmithJones family agrees [names: O''Brien family | Smith-Jones | McDonald]');
SELECT is(public.identifying_text_problem('OBrien family agrees', ARRAY['O''Brien family', 'Smith-Jones', 'McDonald']::text[], current_setting('test.label')), NULL, 'allowed: OBrien family agrees [names: O''Brien family | Smith-Jones | McDonald]');
SELECT is(public.identifying_text_problem('O''Brien family agrees', ARRAY['O''Brien family', 'Smith-Jones', 'McDonald']::text[], current_setting('test.label')), 'Leave out names ("brien" is a name on this case). Programs read this.', 'refused as name (brien): O''Brien family agrees [names: O''Brien family | Smith-Jones | McDonald]');
SELECT is(public.identifying_text_problem('Mc Donald family agrees', ARRAY['O''Brien family', 'Smith-Jones', 'McDonald']::text[], current_setting('test.label')), NULL, 'allowed: Mc Donald family agrees [names: O''Brien family | Smith-Jones | McDonald]');
SELECT is(public.identifying_text_problem('Li refuses residential', ARRAY['Wu family — son Li', 'Le Van', 'Ng']::text[], current_setting('test.label')), 'Leave out names ("li" is a name on this case). Programs read this.', 'refused as name (li): Li refuses residential [names: Wu family — son Li | Le Van | Ng]');
SELECT is(public.identifying_text_problem('Wu family wants close to home', ARRAY['Wu family — son Li', 'Le Van', 'Ng']::text[], current_setting('test.label')), 'Leave out names ("wu" is a name on this case). Programs read this.', 'refused as name (wu): Wu family wants close to home [names: Wu family — son Li | Le Van | Ng]');
SELECT is(public.identifying_text_problem('Ng prefers men only', ARRAY['Wu family — son Li', 'Le Van', 'Ng']::text[], current_setting('test.label')), 'Leave out names ("ng" is a name on this case). Programs read this.', 'refused as name (ng): Ng prefers men only [names: Wu family — son Li | Le Van | Ng]');
SELECT is(public.identifying_text_problem('J. Rivera needs detox', current_setting('test.names')::text[], current_setting('test.label')), 'Leave out names ("rivera" is a name on this case). Programs read this.', 'refused as name (rivera): J. Rivera needs detox');
SELECT is(public.identifying_text_problem('JR needs detox', current_setting('test.names')::text[], current_setting('test.label')), 'Leave out names ("jr" is a name on this case). Programs read this.', 'refused as name (jr): JR needs detox');
SELECT is(public.identifying_text_problem('Rivеra refuses', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Rivеra refuses');
SELECT ok(coalesce(lower(public.identifying_text_problem('Riv' || chr(173) || 'era refuses', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%hidden%', false), 'refused as hidden: Riv<U+00AD>era refuses');
SELECT ok(coalesce(lower(public.identifying_text_problem('Riv' || chr(8288) || 'era refuses', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%hidden%', false), 'refused as hidden: Riv<U+2060>era refuses');
SELECT ok(coalesce(lower(public.identifying_text_problem('Riv' || chr(65279) || 'era refuses', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%hidden%', false), 'refused as hidden: Riv<U+FEFF>era refuses');
SELECT is(public.identifying_text_problem('σοφος refuses', ARRAY['ΣΟΦΟΣ', 'İsmail Şahin', 'Straße']::text[], current_setting('test.label')), 'Leave out names ("σοφος" is a name on this case). Programs read this.', 'refused as name (σοφος): σοφος refuses [names: ΣΟΦΟΣ | İsmail Şahin | Straße]');
SELECT is(public.identifying_text_problem('STRASSE refuses', ARRAY['ΣΟΦΟΣ', 'İsmail Şahin', 'Straße']::text[], current_setting('test.label')), NULL, 'allowed: STRASSE refuses [names: ΣΟΦΟΣ | İsmail Şahin | Straße]');
SELECT is(public.identifying_text_problem('ISMAIL refuses', ARRAY['ΣΟΦΟΣ', 'İsmail Şahin', 'Straße']::text[], current_setting('test.label')), 'Leave out names ("ismail" is a name on this case). Programs read this.', 'refused as name (ismail): ISMAIL refuses [names: ΣΟΦΟΣ | İsmail Şahin | Straße]');
SELECT is(public.identifying_text_problem('İSMAİL refuses', ARRAY['ΣΟΦΟΣ', 'İsmail Şahin', 'Straße']::text[], current_setting('test.label')), 'Leave out names ("ismail" is a name on this case). Programs read this.', 'refused as name (ismail): İSMAİL refuses [names: ΣΟΦΟΣ | İsmail Şahin | Straße]');
SELECT is(public.identifying_text_problem('call five four one five five five zero one four two', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: call five four one five five five zero one four two');
SELECT is(public.identifying_text_problem('call 541 555 O142', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: call 541 555 O142');
SELECT is(public.identifying_text_problem('call ٥٤١٥٥٥٠١٤٢', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: call ٥٤١٥٥٥٠١٤٢');
SELECT ok(coalesce(lower(public.identifying_text_problem('call 555-0142', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%number%', false), 'refused as number: call 555-0142');
SELECT ok(coalesce(lower(public.identifying_text_problem('jane @ gmail . com', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%email%', false), 'refused as email: jane @ gmail . com');
SELECT is(public.identifying_text_problem('jane at gmail . com', current_setting('test.names')::text[], current_setting('test.label')), 'Leave out names ("jane" is a name on this case). Programs read this.', 'refused as name (jane): jane at gmail . com');
SELECT is(public.identifying_text_problem('jane at gmail', current_setting('test.names')::text[], current_setting('test.label')), 'Leave out names ("jane" is a name on this case). Programs read this.', 'refused as name (jane): jane at gmail');
SELECT ok(coalesce(lower(public.identifying_text_problem('jane.doe gmаil.com', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%link%', false), 'refused as link: jane.doe gmаil.com');
SELECT is(public.identifying_text_problem('janedoe85 gmail.соm', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: janedoe85 gmail.соm');
SELECT ok(coalesce(lower(public.identifying_text_problem('jdoe85 at gmail dot com', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%email%', false), 'refused as email: jdoe85 at gmail dot com');
SELECT ok(coalesce(lower(public.identifying_text_problem('jdoe85 at gmail．com', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%link%', false), 'refused as link: jdoe85 at gmail．com');
SELECT is(public.identifying_text_problem('see linktr.ee/jriv85', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: see linktr.ee/jriv85');
SELECT is(public.identifying_text_problem('site janerivera.ca', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: site janerivera.ca');
SELECT is(public.identifying_text_problem('blog jriv.mx', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: blog jriv.mx');
SELECT is(public.identifying_text_problem('IG jriv85', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: IG jriv85');
SELECT is(public.identifying_text_problem('insta: jriv85, snap jriv_85', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: insta: jriv85, snap jriv_85');
SELECT is(public.identifying_text_problem('fb jane.rivera.77', current_setting('test.names')::text[], current_setting('test.label')), 'Leave out names ("jane" is a name on this case). Programs read this.', 'refused as name (jane): fb jane.rivera.77');
SELECT ok(coalesce(lower(public.identifying_text_problem('family has forty thousand saved', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%money%', false), 'refused as money: family has forty thousand saved');
SELECT ok(coalesce(lower(public.identifying_text_problem('can spend 40 grand', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%money%', false), 'refused as money: can spend 40 grand');
SELECT ok(coalesce(lower(public.identifying_text_problem('can spend 40 thousand', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%money%', false), 'refused as money: can spend 40 thousand');
SELECT ok(coalesce(lower(public.identifying_text_problem('family has 40000 for treatment', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%number%', false), 'refused as number: family has 40000 for treatment');
SELECT is(public.identifying_text_problem('can do 5000 a month', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: can do 5000 a month');
SELECT is(public.identifying_text_problem('family has 40.000 saved', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: family has 40.000 saved');
SELECT is(public.identifying_text_problem('paying cash, money is no object', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: paying cash, money is no object');
SELECT is(public.identifying_text_problem('private pay up to 30', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: private pay up to 30');
SELECT is(public.identifying_text_problem('dad will pay whatever it costs', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: dad will pay whatever it costs');
SELECT is(public.identifying_text_problem('family is wealthy', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: family is wealthy');
SELECT ok(coalesce(lower(public.identifying_text_problem('1.5 million trust fund', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%money%', false), 'refused as money: 1.5 million trust fund');
SELECT ok(coalesce(lower(public.identifying_text_problem('has 2 mil in savings', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%money%', false), 'refused as money: has 2 mil in savings');
SELECT ok(coalesce(lower(public.identifying_text_problem('DOB is 14 March 1985', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%date%', false), 'refused as date: DOB is 14 March 1985');
SELECT ok(coalesce(lower(public.identifying_text_problem('born on the 3rd of March', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%date%', false), 'refused as date: born on the 3rd of March');
SELECT ok(coalesce(lower(public.identifying_text_problem('birthday 14 March 1985', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%date%', false), 'refused as date: birthday 14 March 1985');
SELECT ok(coalesce(lower(public.identifying_text_problem('birthday 3rd of March', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%date%', false), 'refused as date: birthday 3rd of March');
SELECT ok(coalesce(lower(public.identifying_text_problem('14th March 1985', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%date%', false), 'refused as date: 14th March 1985');
SELECT ok(coalesce(lower(public.identifying_text_problem('1985-03-14', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%date%', false), 'refused as date: 1985-03-14');
SELECT ok(coalesce(lower(public.identifying_text_problem('birthday 3/14', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%date%', false), 'refused as date: birthday 3/14');
SELECT ok(coalesce(lower(public.identifying_text_problem('bday 3/14', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%date%', false), 'refused as date: bday 3/14');
SELECT is(public.identifying_text_problem('turns 40 on the 14th', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: turns 40 on the 14th');
SELECT is(public.identifying_text_problem('nacio el 14 de marzo de 1985', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: nacio el 14 de marzo de 1985');
SELECT is(public.identifying_text_problem('marzo 14 1985', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: marzo 14 1985');
SELECT ok(coalesce(lower(public.identifying_text_problem('March 14th', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%date%', false), 'refused as date: March 14th');
SELECT ok(coalesce(lower(public.identifying_text_problem('born March 1985', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%date%', false), 'refused as date: born March 1985');
SELECT is(public.identifying_text_problem('Mar,14', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Mar,14');
SELECT is(public.identifying_text_problem('Mar14', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Mar14');
SELECT is(public.identifying_text_problem('lives at 123 Main St', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: lives at 123 Main St');
SELECT is(public.identifying_text_problem('pick up at 1420 Oak Street', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: pick up at 1420 Oak Street');
SELECT ok(coalesce(lower(public.identifying_text_problem('lives in 97201', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%number%', false), 'refused as number: lives in 97201');
SELECT is(public.identifying_text_problem('SSN ends 4421', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: SSN ends 4421');
SELECT ok(coalesce(lower(public.identifying_text_problem('MRN 12345', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%number%', false), 'refused as number: MRN 12345');
SELECT is(public.identifying_text_problem('Henry Rivera III', current_setting('test.names')::text[], current_setting('test.label')), 'Leave out names ("rivera" is a name on this case). Programs read this.', 'refused as name (rivera): Henry Rivera III');
SELECT is(public.identifying_text_problem('needs 2-3 weeks', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: needs 2-3 weeks');
SELECT is(public.identifying_text_problem('30-60 day program', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: 30-60 day program');
SELECT is(public.identifying_text_problem('30/60/90 day program', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: 30/60/90 day program');
SELECT is(public.identifying_text_problem('30-60-90 day program', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: 30-60-90 day program');
SELECT is(public.identifying_text_problem('uses 1/2 gram daily', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: uses 1/2 gram daily');
SELECT is(public.identifying_text_problem('dose 0.5mg', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: dose 0.5mg');
SELECT is(public.identifying_text_problem('clonazepam 0.125 mg twice a day', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: clonazepam 0.125 mg twice a day');
SELECT is(public.identifying_text_problem('may need detox first', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: may need detox first');
SELECT is(public.identifying_text_problem('March is fine', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: March is fine');
SELECT is(public.identifying_text_problem('admit by the 15th', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: admit by the 15th');
SELECT is(public.identifying_text_problem('co-occurring anxiety', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: co-occurring anxiety');
SELECT is(public.identifying_text_problem('needs MAT', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: needs MAT');
SELECT ok(coalesce(lower(public.identifying_text_problem('found you on recovery.com', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%link%', false), 'refused as link: found you on recovery.com');
SELECT ok(coalesce(lower(public.identifying_text_problem('Detox first.Co-occurring PTSD', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%link%', false), 'refused as link: Detox first.Co-occurring PTSD');
SELECT is(public.identifying_text_problem('BP 160/100 at intake', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: BP 160/100 at intake');
SELECT is(public.identifying_text_problem('BP 140/90 at intake', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: BP 140/90 at intake');
SELECT is(public.identifying_text_problem('evening IOP only, 6:00-9:00', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: evening IOP only, 6:00-9:00');
SELECT is(public.identifying_text_problem('available 10:30-11:45', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: available 10:30-11:45');
SELECT ok(coalesce(lower(public.identifying_text_problem('IOP @ 3x/week', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%email%', false), 'refused as email: IOP @ 3x/week');
SELECT ok(coalesce(lower(public.identifying_text_problem('currently @ home', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%email%', false), 'refused as email: currently @ home');
SELECT is(public.identifying_text_problem('history of grand mal seizures', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: history of grand mal seizures');
SELECT ok(coalesce(lower(public.identifying_text_problem('uses 2 K bumps a day', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%money%', false), 'refused as money: uses 2 K bumps a day');
SELECT ok(coalesce(lower(public.identifying_text_problem('looking for an affordable program', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%money%', false), 'refused as money: looking for an affordable program');
SELECT is(public.identifying_text_problem('option 1 may work', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: option 1 may work');
SELECT ok(coalesce(lower(public.identifying_text_problem('may 2x a week', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%date%', false), 'refused as date: may 2x a week');
SELECT is(public.identifying_text_problem('ok with 12-step', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: ok with 12-step');
SELECT is(public.identifying_text_problem('3 DUIs, on probation', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: 3 DUIs, on probation');
SELECT is(public.identifying_text_problem('history of opioids, needs MAT', ARRAY['Henderson family — son Jake, 24, opioids']::text[], current_setting('test.label')), NULL, 'allowed: history of opioids, needs MAT [names: Henderson family — son Jake, 24, opioids]');
SELECT is(public.identifying_text_problem('Henderson-style family systems work', ARRAY['Dr. Henderson']::text[], current_setting('test.label')), 'Leave out names ("henderson" is a name on this case). Programs read this.', 'refused as name (henderson): Henderson-style family systems work [names: Dr. Henderson]');
SELECT is(public.identifying_text_problem('ED history, needs dual dx', ARRAY['Ed Rivera']::text[], current_setting('test.label')), NULL, 'allowed: ED history, needs dual dx [names: Ed Rivera]');
SELECT is(public.identifying_text_problem('24/7 supervision', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: 24/7 supervision');
SELECT is(public.identifying_text_problem('PHQ-9 22, GAD-7 18', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: PHQ-9 22, GAD-7 18');
SELECT is(public.identifying_text_problem('CIWA 15, COWS 12', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: CIWA 15, COWS 12');
SELECT is(public.identifying_text_problem('2nd or 3rd treatment episode', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: 2nd or 3rd treatment episode');
SELECT is(public.identifying_text_problem('sober 90 days in 2024', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: sober 90 days in 2024');
SELECT is(public.identifying_text_problem('relapsed after 18 months', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: relapsed after 18 months');
SELECT is(public.identifying_text_problem('drinks a fifth a day', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: drinks a fifth a day');
SELECT is(public.identifying_text_problem('1.75L vodka per day', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: 1.75L vodka per day');
SELECT is(public.identifying_text_problem('2-4 mg suboxone, 8/2 mg strips', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: 2-4 mg suboxone, 8/2 mg strips');
SELECT is(public.identifying_text_problem('Suboxone 8mg/2mg', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Suboxone 8mg/2mg');
SELECT is(public.identifying_text_problem('e.g. trauma focus, i.e. EMDR', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: e.g. trauma focus, i.e. EMDR');
SELECT ok(coalesce(lower(public.identifying_text_problem('no budget concerns with insurance', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%money%', false), 'refused as money: no budget concerns with insurance');
SELECT is(public.identifying_text_problem('Dec. 2025 relapse', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Dec. 2025 relapse');
SELECT ok(coalesce(lower(public.identifying_text_problem('jan 2', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%date%', false), 'refused as date: jan 2');
SELECT is(public.identifying_text_problem('out of state ok, Medicaid', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: out of state ok, Medicaid');
SELECT is(public.identifying_text_problem('detox at St. Mary''s then 30 days', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: detox at St. Mary''s then 30 days');
SELECT is(public.identifying_text_problem('adolescent, 16yo', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: adolescent, 16yo');
SELECT is(public.identifying_text_problem('2x/week, 3x/week', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: 2x/week, 3x/week');
SELECT is(public.identifying_text_problem('between 9-5', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: between 9-5');
SELECT is(public.identifying_text_problem('2.5-3 mg/kg', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: 2.5-3 mg/kg');
SELECT is(public.identifying_text_problem('admits 3-5 days, 7-10 day detox', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: admits 3-5 days, 7-10 day detox');
SELECT is(public.identifying_text_problem('IOP 3hrs x 3 days x 8 weeks', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: IOP 3hrs x 3 days x 8 weeks');
SELECT is(public.identifying_text_problem('PHP 5 days 6 hrs', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: PHP 5 days 6 hrs');
SELECT is(public.identifying_text_problem('1-2-3 weeks', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: 1-2-3 weeks');
SELECT is(public.identifying_text_problem('methadone 120 mg, 100-120mg range', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: methadone 120 mg, 100-120mg range');
SELECT is(public.identifying_text_problem('fentanyl 10-20 pills a day', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: fentanyl 10-20 pills a day');
SELECT is(public.identifying_text_problem('level 3.5 or 3.7', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: level 3.5 or 3.7');
SELECT is(public.identifying_text_problem('ASAM 3.1, 3.5, 3.7', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: ASAM 3.1, 3.5, 3.7');
SELECT is(public.identifying_text_problem('ASAM 2.1/2.5/3.1/3.5/3.7', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: ASAM 2.1/2.5/3.1/3.5/3.7');
SELECT is(public.identifying_text_problem('ASAM 3.5-3.7', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: ASAM 3.5-3.7');
SELECT is(public.identifying_text_problem('level 3.7-WM', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: level 3.7-WM');
SELECT is(public.identifying_text_problem('1.0 or 2.1', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: 1.0 or 2.1');
SELECT is(public.identifying_text_problem('Prefers a smaller program; open to out of state', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Prefers a smaller program; open to out of state');
SELECT is(public.identifying_text_problem('Sober 2018-2022, relapsed last spring', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Sober 2018-2022, relapsed last spring');
SELECT is(public.identifying_text_problem('Prior treatment 2019, 2021, 2023', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Prior treatment 2019, 2021, 2023');
SELECT is(public.identifying_text_problem('Used daily 2015-2024', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Used daily 2015-2024');
SELECT is(public.identifying_text_problem('Sober since 12/2024', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Sober since 12/2024');
SELECT is(public.identifying_text_problem('Relapsed 10/2025 after 18 months', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Relapsed 10/2025 after 18 months');
SELECT is(public.identifying_text_problem('HR 110-120 at intake, BP 180/110', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: HR 110-120 at intake, BP 180/110');
SELECT is(public.identifying_text_problem('BP 160/100, shaky, last drink 8 hrs ago', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: BP 160/100, shaky, last drink 8 hrs ago');
SELECT is(public.identifying_text_problem('Methadone 80-120 mg range, needs MAT continuation', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Methadone 80-120 mg range, needs MAT continuation');
SELECT is(public.identifying_text_problem('Suboxone 16mg daily, Vivitrol considered', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Suboxone 16mg daily, Vivitrol considered');
SELECT is(public.identifying_text_problem('Drinks 12-15 beers a day, 1.75L on weekends', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Drinks 12-15 beers a day, 1.75L on weekends');
SELECT is(public.identifying_text_problem('Needs evening IOP, 6:00-9:00 pm', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Needs evening IOP, 6:00-9:00 pm');
SELECT is(public.identifying_text_problem('Can attend 9:00-12:00 weekdays', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Can attend 9:00-12:00 weekdays');
SELECT is(public.identifying_text_problem('Insurance denied 3.7; approved 3.5', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Insurance denied 3.7; approved 3.5');
SELECT is(public.identifying_text_problem('Meets 3.5/3.7; family prefers 2.1', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Meets 3.5/3.7; family prefers 2.1');
SELECT is(public.identifying_text_problem('ASAM 3.1, 3.5 or 3.7 all fit', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: ASAM 3.1, 3.5 or 3.7 all fit');
SELECT is(public.identifying_text_problem('Prior 3 admits, 28-30 days each', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Prior 3 admits, 28-30 days each');
SELECT is(public.identifying_text_problem('DUI, court ordered 90 days, on probation', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: DUI, court ordered 90 days, on probation');
SELECT is(public.identifying_text_problem('Needs 24/7 nursing, seizure history 2019', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Needs 24/7 nursing, seizure history 2019');
SELECT is(public.identifying_text_problem('Young adult program 18-25 preferred', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Young adult program 18-25 preferred');
SELECT is(public.identifying_text_problem('Spanish-speaking staff a must', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Spanish-speaking staff a must');
SELECT is(public.identifying_text_problem('Commercial PPO, OON benefits, deductible met', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Commercial PPO, OON benefits, deductible met');
SELECT is(public.identifying_text_problem('Detox at hospital first, 5-7 days', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Detox at hospital first, 5-7 days');
SELECT is(public.identifying_text_problem('CIWA 15, COWS 12 at intake', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: CIWA 15, COWS 12 at intake');
SELECT is(public.identifying_text_problem('PHQ-9 = 21, GAD-7 = 17', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: PHQ-9 = 21, GAD-7 = 17');
SELECT is(public.identifying_text_problem('Co-occurring bipolar, stable on lithium 900 mg', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Co-occurring bipolar, stable on lithium 900 mg');
SELECT is(public.identifying_text_problem('Fentanyl 10-20 pills a day', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Fentanyl 10-20 pills a day');
SELECT is(public.identifying_text_problem('Works nights, needs flexible IOP', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Works nights, needs flexible IOP');
SELECT is(public.identifying_text_problem('May need a medical bed first', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: May need a medical bed first');
SELECT is(public.identifying_text_problem('March or April admission works', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: March or April admission works');
SELECT is(public.identifying_text_problem('Drinks 750-1000 ml of vodka a day', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Drinks 750-1000 ml of vodka a day');
SELECT is(public.identifying_text_problem('Weight 250 lbs, BMI 38', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Weight 250 lbs, BMI 38');
SELECT is(public.identifying_text_problem('Glucose 200-300 on and off', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Glucose 200-300 on and off');
SELECT is(public.identifying_text_problem('IOP 3 hrs x 3 days x 8 weeks', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: IOP 3 hrs x 3 days x 8 weeks');
SELECT is(public.identifying_text_problem('Sober 2015-2017 and 2019-2022', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Sober 2015-2017 and 2019-2022');
SELECT is(public.identifying_text_problem('Admits in 2019, 2021 and 2023', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Admits in 2019, 2021 and 2023');
SELECT is(public.identifying_text_problem('Henderson family wants close to home', ARRAY['Henderson family — son Jake, 24', 'Mary Henderson', 'Tom Henderson']::text[], current_setting('test.label')), 'Leave out names ("henderson" is a name on this case). Programs read this.', 'refused as name (henderson): Henderson family wants close to home [names: Henderson family — son Jake, 24 | Mary Henderson | Tom Henderson]');
SELECT is(public.identifying_text_problem('Tom''s employer requires FMLA paperwork', ARRAY['Henderson family — son Jake, 24', 'Mary Henderson', 'Tom Henderson']::text[], current_setting('test.label')), 'Leave out names ("tom" is a name on this case). Programs read this.', 'refused as name (tom): Tom''s employer requires FMLA paperwork [names: Henderson family — son Jake, 24 | Mary Henderson | Tom Henderson]');
SELECT is(public.identifying_text_problem('JR prefers a quiet setting', current_setting('test.names')::text[], current_setting('test.label')), 'Leave out names ("jr" is a name on this case). Programs read this.', 'refused as name (jr): JR prefers a quiet setting');
SELECT is(public.identifying_text_problem('J.R. prefers a quiet setting', current_setting('test.names')::text[], current_setting('test.label')), 'Leave out names ("jr" is a name on this case). Programs read this.', 'refused as name (jr): J.R. prefers a quiet setting');
SELECT is(public.identifying_text_problem('jr. does better with structure', current_setting('test.names')::text[], current_setting('test.label')), 'Leave out names ("jr" is a name on this case). Programs read this.', 'refused as name (jr): jr. does better with structure');
SELECT is(public.identifying_text_problem('Prefers a program near J.R.''s sister', current_setting('test.names')::text[], current_setting('test.label')), 'Leave out names ("jr" is a name on this case). Programs read this.', 'refused as name (jr): Prefers a program near J.R.''s sister');
SELECT is(public.identifying_text_problem('34M, needs detox first', current_setting('test.names')::text[], current_setting('test.label')), 'Leave out names ("34m" is a name on this case). Programs read this.', 'refused as name (34m): 34M, needs detox first');
SELECT is(public.identifying_text_problem('J. R. prefers mornings', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: J. R. prefers mornings');
SELECT is(public.identifying_text_problem('Needs a 34 bed program', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Needs a 34 bed program');
SELECT is(public.identifying_text_problem('Client prefers a quiet program', current_setting('test.names')::text[], 'Client A'), NULL, 'allowed: Client prefers a quiet program [label: Client A]');
SELECT is(public.identifying_text_problem('Open to programs in TX', current_setting('test.names')::text[], 'TX 34'), 'Leave out names ("tx" is a name on this case). Programs read this.', 'refused as name (tx): Open to programs in TX [label: TX 34]');
SELECT is(public.identifying_text_problem('Open to programs in TX', ARRAY['Rivera intervention — TX']::text[], NULL), NULL, 'allowed: Open to programs in TX [names: Rivera intervention — TX] [label: none]');
SELECT is(public.identifying_text_problem('Prefers a program in Oregon', current_setting('test.names')::text[], 'IN'), NULL, 'allowed: Prefers a program in Oregon [label: IN]');
SELECT is(public.identifying_text_problem('Needs an MD on site', current_setting('test.names')::text[], 'M.D.'), 'Leave out names ("md" is a name on this case). Programs read this.', 'refused as name (md): Needs an MD on site [label: M.D.]');
SELECT is(public.identifying_text_problem('Sober since 2024, two prior admits', current_setting('test.names')::text[], 'Case 2024-117'), NULL, 'allowed: Sober since 2024, two prior admits [label: Case 2024-117]');
SELECT is(public.identifying_text_problem('Admit by the 15th', current_setting('test.names')::text[], 'TH 41M'), NULL, 'allowed: Admit by the 15th [label: TH 41M]');
SELECT is(public.identifying_text_problem('Smith prefers mornings', ARRAY[]::text[], 'Smith'), 'Leave out names ("smith" is a name on this case). Programs read this.', 'refused as name (smith): Smith prefers mornings [names: none] [label: Smith]');
SELECT is(public.identifying_text_problem('The Smiths want a quiet place', ARRAY[]::text[], 'Smith'), 'Leave out names ("smith" is a name on this case). Programs read this.', 'refused as name (smith): The Smiths want a quiet place [names: none] [label: Smith]');
SELECT is(public.identifying_text_problem('ＪＲ prefers mornings', current_setting('test.names')::text[], current_setting('test.label')), 'Leave out names ("jr" is a name on this case). Programs read this.', 'refused as name (jr): ＪＲ prefers mornings');
SELECT is(public.identifying_text_problem('Prefers mornings', current_setting('test.names')::text[], NULL), NULL, 'allowed: Prefers mornings [label: none]');
SELECT is(public.identifying_text_problem('Al prefers mornings', ARRAY['Al Ma']::text[], NULL), 'Leave out names ("al" is a name on this case). Programs read this.', 'refused as name (al): Al prefers mornings [names: Al Ma] [label: none]');
SELECT is(public.identifying_text_problem('Ma family wants close to home', ARRAY['Al Ma']::text[], NULL), 'Leave out names ("ma" is a name on this case). Programs read this.', 'refused as name (ma): Ma family wants close to home [names: Al Ma] [label: none]');
SELECT is(public.identifying_text_problem('Goes to AA and NA meetings', ARRAY['AA follow-up', 'NA sponsor']::text[], NULL), NULL, 'allowed: Goes to AA and NA meetings [names: AA follow-up | NA sponsor] [label: none]');
SELECT is(public.identifying_text_problem('Third treatment episode, 3rd admit', ARRAY['Lopez 3rd call']::text[], NULL), NULL, 'allowed: Third treatment episode, 3rd admit [names: Lopez 3rd call] [label: none]');
SELECT is(public.identifying_text_problem('Lopez refuses residential', ARRAY['Lopez 3rd call']::text[], NULL), 'Leave out names ("lopez" is a name on this case). Programs read this.', 'refused as name (lopez): Lopez refuses residential [names: Lopez 3rd call] [label: none]');
SELECT is(public.identifying_text_problem('Loved one prefers a quiet program; best friend and family member support it', ARRAY['Loved one', 'Best friend', 'Family member']::text[], NULL), NULL, 'allowed: Loved one prefers a quiet program; best friend and family member support it [names: Loved one | Best friend | Family member] [label: none]');
SELECT is(public.identifying_text_problem('The patient himself agrees; a referring professional called', ARRAY['Patient', 'Himself', 'Referring professional']::text[], NULL), NULL, 'allowed: The patient himself agrees; a referring professional called [names: Patient | Himself | Referring professional] [label: none]');
SELECT is(public.identifying_text_problem('Stepchild and grandchild both at home; mother supportive', ARRAY['Stepchild', 'Grandchild', 'Myself', 'Themselves', 'Herself', 'Themself']::text[], NULL), NULL, 'allowed: Stepchild and grandchild both at home; mother supportive [names: Stepchild | Grandchild | Myself | Themselves | Herself | Themself] [label: none]');
SELECT is(public.identifying_text_problem('Rivera prefers mornings', ARRAY['Loved one', 'Rivera']::text[], NULL), 'Leave out names ("rivera" is a name on this case). Programs read this.', 'refused as name (rivera): Rivera prefers mornings [names: Loved one | Rivera] [label: none]');
SELECT is(public.identifying_text_problem('Rivera and Lopez both asked', current_setting('test.names')::text[], current_setting('test.label')), 'Leave out names ("lopez" is a name on this case). Programs read this.', 'refused as name (lopez): Rivera and Lopez both asked');
SELECT is(public.identifying_text_problem('Lopez and Jake both asked', current_setting('test.names')::text[], current_setting('test.label')), 'Leave out names ("jake" is a name on this case). Programs read this.', 'refused as name (jake): Lopez and Jake both asked');
SELECT is(public.identifying_text_problem('Her mom is supportive', ARRAY['Sarah Mitchell — her son Kyle']::text[], NULL), NULL, 'allowed: Her mom is supportive [names: Sarah Mitchell — her son Kyle] [label: none]');
SELECT is(public.identifying_text_problem('Our team will coordinate transport', ARRAY['Rosa Garcia — our son Mateo']::text[], NULL), NULL, 'allowed: Our team will coordinate transport [names: Rosa Garcia — our son Mateo] [label: none]');
SELECT is(public.identifying_text_problem('His family wants him close to home', ARRAY['Calling about their son', 'His dad Tom Reyes']::text[], NULL), NULL, 'allowed: His family wants him close to home [names: Calling about their son | His dad Tom Reyes] [label: none]');
SELECT is(public.identifying_text_problem('Her family agrees', ARRAY['Kao Her — son Tou']::text[], NULL), 'Leave out names ("her" is a name on this case). Programs read this.', 'refused as name (her): Her family agrees [names: Kao Her — son Tou] [label: none]');
SELECT ok(coalesce(lower(public.identifying_text_problem('Pt 14-Mar-1985, needs detox', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%date%', false), 'refused as date: Pt 14-Mar-1985, needs detox');
SELECT ok(coalesce(lower(public.identifying_text_problem('14Mar1985', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%date%', false), 'refused as date: 14Mar1985');
SELECT ok(coalesce(lower(public.identifying_text_problem('DOB 14/Mar/85', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%date%', false), 'refused as date: DOB 14/Mar/85');
SELECT ok(coalesce(lower(public.identifying_text_problem('Mar-14-1985', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%date%', false), 'refused as date: Mar-14-1985');
SELECT ok(coalesce(lower(public.identifying_text_problem('March.14.85', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%date%', false), 'refused as date: March.14.85');
SELECT is(public.identifying_text_problem('Sober since Oct-2023', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Sober since Oct-2023');
SELECT is(public.identifying_text_problem('Relapsed Dec-24, 30 days sober before', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Relapsed Dec-24, 30 days sober before');
SELECT is(public.identifying_text_problem('Prior stays Jan-Mar 2024 and Start Jan-25', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Prior stays Jan-Mar 2024 and Start Jan-25');
SELECT is(public.identifying_text_problem('Born-again Christian, wants a faith based program', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Born-again Christian, wants a faith based program');
SELECT is(public.identifying_text_problem('Born and raised in Ohio, wants to stay in state', current_setting('test.names')::text[], current_setting('test.label')), NULL, 'allowed: Born and raised in Ohio, wants to stay in state');
SELECT ok(coalesce(lower(public.identifying_text_problem('Born in 1985', current_setting('test.names')::text[], current_setting('test.label'))) LIKE '%date%', false), 'refused as date: Born in 1985');
SELECT is(public.identifying_text_problem('Lukasz prefers mornings', ARRAY['Łukasz Nowak']::text[], NULL), 'Leave out names ("lukasz" is a name on this case). Programs read this.', 'refused as name (lukasz): Lukasz prefers mornings [names: Łukasz Nowak] [label: none]');
SELECT is(public.identifying_text_problem('Soren and Odegard family', ARRAY['Søren Ødegård']::text[], NULL), 'Leave out names ("odegard" is a name on this case). Programs read this.', 'refused as name (odegard): Soren and Odegard family [names: Søren Ødegård] [label: none]');
SELECT is(public.identifying_text_problem('Le family wants close to home', ARRAY['Le family']::text[], NULL), 'Leave out names ("le" is a name on this case). Programs read this.', 'refused as name (le): Le family wants close to home [names: Le family] [label: none]');
-- END fixture cases

SELECT * FROM finish();
ROLLBACK;
