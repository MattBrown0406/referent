-- The identifying-details check (public.identifying_text_problem, in
-- 20261104140000_placement_requests.sql), the SQL twin of
-- identifyingTextProblem in src/lib/identifying-text.ts. Every case of
-- scripts/fixtures/identifying-text-cases.json, with its names list: null is
-- allowed, otherwise the refusal must contain the expected word. Keep this
-- file in step with the fixture (scripts/identifying-text-test.mjs runs the
-- same cases against the app's copy). Invisible characters are written with
-- chr() so they can be read here.
--
-- This file is never pasted into production.

BEGIN;
SELECT plan(55);

SELECT set_config('test.names', (ARRAY['Jane Rivera', 'Rivera family — son Jake', 'Maria Lopez', 'Rivera intervention'])::text, true);

-- ===========================================================================
-- A. The function itself
-- ===========================================================================

SELECT ok(
  (SELECT p.provolatile = 'i' AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog']
     FROM pg_proc p WHERE p.oid = 'public.identifying_text_problem(text, text[])'::regprocedure),
  'immutable, runs as the caller, search_path pinned'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.identifying_text_problem(text, text[])', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.identifying_text_problem(text, text[])', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.identifying_name_words(text[])', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.identifying_name_words(text[])', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.identifying_case_names(uuid, uuid)', 'EXECUTE'),
  'internal: only the SECURITY DEFINER writers call it'
);
SELECT is(
  public.identifying_name_words(ARRAY['Rivera family ' || chr(8212) || ' son Jake']),
  ARRAY['jake', 'rivera'],
  'name words: letters only, three or more, no relationship words (nameWords)'
);
SELECT is(
  public.identifying_name_words(ARRAY['Jos' || chr(233) || ' N' || chr(250) || chr(241) || 'ez', 'Al', 'Mom and Dad', NULL]),
  ARRAY['jos' || chr(233), 'n' || chr(250) || chr(241) || 'ez'],
  'name words keep accented letters, drop short and relationship words, skip a missing name'
);
SELECT is(
  public.identifying_name_words(ARRAY['Rivera intervention', 'Lopez family''s first call', 'New inquiry - detox follow-up']),
  ARRAY['lopez', 'rivera'],
  'a case title''s ordinary words are never a name; the name in it still is (nameWords)'
);
SELECT is(
  ARRAY[public.identifying_text_problem('', NULL), public.identifying_text_problem(NULL, NULL),
        public.identifying_text_problem('Rivera asked', NULL), public.identifying_text_problem('Rivera asked', ARRAY[]::text[])],
  ARRAY[NULL, NULL, NULL, NULL]::text[],
  'empty or missing text is fine; without names, a name is not known'
);
SELECT is(
  public.identifying_text_problem('riveras want a quiet place', current_setting('test.names')::text[]),
  NULL,
  'names are whole words: riveras is not rivera'
);
SELECT is(
  public.identifying_text_problem('Jos' || chr(233) || ' asked about detox', ARRAY['Jos' || chr(233) || ' Lopez']),
  'Leave out names. Programs read this.',
  'an accented name is found'
);
SELECT is(
  ARRAY[public.identifying_text_problem('3nov 12', NULL), public.identifying_text_problem('xnov 12', NULL)],
  ARRAY['Leave out dates such as a birth date. Programs read this.', NULL],
  'a month name must start a word (not follow a letter): 3nov 12 is a date, xnov 12 is not'
);
SELECT is(
  ARRAY[public.identifying_text_problem('affordable', NULL), public.identifying_text_problem('jane [at] gmail [dot] com', NULL),
        public.identifying_text_problem('x' || chr(133) || 'y', NULL)],
  ARRAY['Leave money out. Programs read this.', 'Leave out email addresses. Programs read this.', NULL],
  'the same edge cases as the app: afford words, [at] [dot] addresses, a character the app allows'
);

-- ===========================================================================
-- B. The shared cases (scripts/fixtures/identifying-text-cases.json)
-- ===========================================================================

SELECT is(public.identifying_text_problem('Prefers a small program with a quiet setting', current_setting('test.names')::text[]), NULL, 'allowed: Prefers a small program with a quiet setting');
SELECT is(public.identifying_text_problem('Needs medication management and a trauma focus', current_setting('test.names')::text[]), NULL, 'allowed: Needs medication management and a trauma focus');
SELECT is(public.identifying_text_problem('Family prefers somewhere within a few hours of home', current_setting('test.names')::text[]), NULL, 'allowed: Family prefers somewhere within a few hours of home');
SELECT is(public.identifying_text_problem('Admit within 3 days if possible', current_setting('test.names')::text[]), NULL, 'allowed: Admit within 3 days if possible');
SELECT is(public.identifying_text_problem('Son has tried outpatient twice', current_setting('test.names')::text[]), NULL, 'allowed: Son has tried outpatient twice');
SELECT is(public.identifying_text_problem('Needs a 30 day stay, 2 prior admissions', current_setting('test.names')::text[]), NULL, 'allowed: Needs a 30 day stay, 2 prior admissions');
SELECT is(public.identifying_text_problem('Call me at the office if you have a bed', current_setting('test.names')::text[]), NULL, 'allowed: Call me at the office if you have a bed');
SELECT is(public.identifying_text_problem('intervention planned for next week', current_setting('test.names')::text[]), NULL, 'allowed: intervention planned for next week');
SELECT is(public.identifying_text_problem('decent 12', current_setting('test.names')::text[]), NULL, 'allowed: decent 12');
SELECT is(public.identifying_text_problem('marvel 3', current_setting('test.names')::text[]), NULL, 'allowed: marvel 3');
SELECT ok(coalesce(lower(public.identifying_text_problem('jane@gmail.com', current_setting('test.names')::text[])) LIKE '%email%', false), 'refused as email: jane@gmail.com');
SELECT ok(coalesce(lower(public.identifying_text_problem('jane@gmail', current_setting('test.names')::text[])) LIKE '%email%', false), 'refused as email: jane@gmail');
SELECT ok(coalesce(lower(public.identifying_text_problem('jane＠gmail.com', current_setting('test.names')::text[])) LIKE '%email%', false), 'refused as email: jane＠gmail.com');
SELECT ok(coalesce(lower(public.identifying_text_problem('rivera at gmail dot com', current_setting('test.names')::text[])) LIKE '%email%', false), 'refused as email: rivera at gmail dot com');
SELECT ok(coalesce(lower(public.identifying_text_problem('see instagram.com/jriv85', current_setting('test.names')::text[])) LIKE '%link%', false), 'refused as link: see instagram.com/jriv85');
SELECT ok(coalesce(lower(public.identifying_text_problem('facebook.com/jane.doe.77', current_setting('test.names')::text[])) LIKE '%link%', false), 'refused as link: facebook.com/jane.doe.77');
SELECT ok(coalesce(lower(public.identifying_text_problem('www.example.org', current_setting('test.names')::text[])) LIKE '%link%', false), 'refused as link: www.example.org');
SELECT ok(coalesce(lower(public.identifying_text_problem('https://x.co/abc', current_setting('test.names')::text[])) LIKE '%link%', false), 'refused as link: https://x.co/abc');
SELECT ok(coalesce(lower(public.identifying_text_problem('Family can pay 40,000 cash', current_setting('test.names')::text[])) LIKE '%money%', false), 'refused as money: Family can pay 40,000 cash');
SELECT ok(coalesce(lower(public.identifying_text_problem('budget is 40k', current_setting('test.names')::text[])) LIKE '%money%', false), 'refused as money: budget is 40k');
SELECT ok(coalesce(lower(public.identifying_text_problem('family pays USD 8000', current_setting('test.names')::text[])) LIKE '%money%', false), 'refused as money: family pays USD 8000');
SELECT ok(coalesce(lower(public.identifying_text_problem('€30000 available', current_setting('test.names')::text[])) LIKE '%money%', false), 'refused as money: €30000 available');
SELECT ok(coalesce(lower(public.identifying_text_problem('cannot afford residential', current_setting('test.names')::text[])) LIKE '%money%', false), 'refused as money: cannot afford residential');
SELECT ok(coalesce(lower(public.identifying_text_problem('$25', current_setting('test.names')::text[])) LIKE '%money%', false), 'refused as money: $25');
SELECT ok(coalesce(lower(public.identifying_text_problem('DOB 3/14/1985', current_setting('test.names')::text[])) LIKE '%date%', false), 'refused as date: DOB 3/14/1985');
SELECT ok(coalesce(lower(public.identifying_text_problem('born 03/14/85', current_setting('test.names')::text[])) LIKE '%date%', false), 'refused as date: born 03/14/85');
SELECT ok(coalesce(lower(public.identifying_text_problem('admit 11.12.2026', current_setting('test.names')::text[])) LIKE '%date%', false), 'refused as date: admit 11.12.2026');
SELECT ok(coalesce(lower(public.identifying_text_problem('seen Nov 12', current_setting('test.names')::text[])) LIKE '%date%', false), 'refused as date: seen Nov 12');
SELECT ok(coalesce(lower(public.identifying_text_problem('Dec 12', current_setting('test.names')::text[])) LIKE '%date%', false), 'refused as date: Dec 12');
SELECT ok(coalesce(lower(public.identifying_text_problem('december 3', current_setting('test.names')::text[])) LIKE '%date%', false), 'refused as date: december 3');
SELECT ok(coalesce(lower(public.identifying_text_problem('Sept. 14', current_setting('test.names')::text[])) LIKE '%date%', false), 'refused as date: Sept. 14');
SELECT ok(coalesce(lower(public.identifying_text_problem('555/123/4567', current_setting('test.names')::text[])) LIKE '%number%', false), 'refused as number: 555/123/4567');
SELECT ok(coalesce(lower(public.identifying_text_problem('555,123,4567', current_setting('test.names')::text[])) LIKE '%number%', false), 'refused as number: 555,123,4567');
SELECT ok(coalesce(lower(public.identifying_text_problem('555_123_4567', current_setting('test.names')::text[])) LIKE '%number%', false), 'refused as number: 555_123_4567');
SELECT ok(coalesce(lower(public.identifying_text_problem('５５５１２３４５６７', current_setting('test.names')::text[])) LIKE '%number%', false), 'refused as number: ５５５１２３４５６７');
SELECT ok(coalesce(lower(public.identifying_text_problem('MRN 123456', current_setting('test.names')::text[])) LIKE '%number%', false), 'refused as number: MRN 123456');
SELECT ok(coalesce(lower(public.identifying_text_problem('call 541 555 0142', current_setting('test.names')::text[])) LIKE '%number%', false), 'refused as number: call 541 555 0142');
SELECT ok(coalesce(lower(public.identifying_text_problem('541–555–0142', current_setting('test.names')::text[])) LIKE '%number%', false), 'refused as number: 541–555–0142');
SELECT ok(coalesce(lower(public.identifying_text_problem('Rivera', current_setting('test.names')::text[])) LIKE '%name%', false), 'refused as name: Rivera');
SELECT ok(coalesce(lower(public.identifying_text_problem('rivera refuses residential', current_setting('test.names')::text[])) LIKE '%name%', false), 'refused as name: rivera refuses residential');
SELECT ok(coalesce(lower(public.identifying_text_problem('Jake does better with men only', current_setting('test.names')::text[])) LIKE '%name%', false), 'refused as name: Jake does better with men only');
SELECT ok(coalesce(lower(public.identifying_text_problem('Maria  Lopez asked', current_setting('test.names')::text[])) LIKE '%name%', false), 'refused as name: Maria  Lopez asked');
SELECT ok(coalesce(lower(public.identifying_text_problem('line one' || chr(8232) || 'line two', current_setting('test.names')::text[])) LIKE '%hidden%', false), 'refused as hidden: line one<U+2028>line two');
SELECT ok(coalesce(lower(public.identifying_text_problem('abc' || chr(8238) || 'def', current_setting('test.names')::text[])) LIKE '%hidden%', false), 'refused as hidden: abc<U+202E>def');
SELECT ok(coalesce(lower(public.identifying_text_problem('zero' || chr(8203) || 'width', current_setting('test.names')::text[])) LIKE '%hidden%', false), 'refused as hidden: zero<U+200B>width');

SELECT * FROM finish();
ROLLBACK;
