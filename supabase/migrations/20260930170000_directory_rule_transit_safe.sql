BEGIN;

-- Directory completeness rule: same behaviour, written without backslash
-- escapes or non-ASCII characters.
--
-- 20260930120000_directory_submissions.sql defined directory_text_is_blank()
-- and directory_missing_fields() with E'...' strings containing \t \n \r and
-- \\. plus literal em/en dashes. Production migrations for this project are
-- pasted by hand into the Supabase SQL editor from a chat client, and that
-- path altered exactly those two function bodies on 2026-09-30 (a source
-- fingerprint check caught it; every other function arrived intact).
--
-- These definitions build the same character sets with chr() and use [.] for
-- a literal dot, so there is nothing for a copy/paste path to reinterpret:
--   chr(9) tab, chr(10) line feed, chr(13) carriage return,
--   chr(8212) em dash, chr(8211) en dash.
-- The rule itself is unchanged and src/lib/directory-submission.ts remains
-- its twin; supabase/tests/directory_submissions_test.sql covers both.
-- Signatures, volatility and grants are unchanged (CREATE OR REPLACE keeps
-- the existing grants; they are restated for a database that lost them).

CREATE OR REPLACE FUNCTION public.directory_text_is_blank(p_value text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  SELECT btrim(coalesce(p_value, ''), ' -' || chr(9) || chr(10) || chr(13) || chr(8212) || chr(8211)) = ''
$$;
REVOKE ALL ON FUNCTION public.directory_text_is_blank(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.directory_text_is_blank(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.directory_missing_fields(
  p_organization text,
  p_name text,
  p_types text[],
  p_city text,
  p_state text,
  p_phone text,
  p_email text,
  p_website text,
  p_monthly_cost integer,
  p_insurance text[],
  p_insurance_networks jsonb
)
RETURNS text[]
LANGUAGE sql IMMUTABLE
AS $$
  SELECT coalesce(array_agg(f.field ORDER BY f.ord), '{}'::text[])
    FROM (VALUES
      (1, 'organization', public.directory_text_is_blank(p_organization)),
      (2, 'name', public.directory_text_is_blank(p_name)),
      (3, 'types', NOT (coalesce(p_types, '{}'::text[]) && ARRAY['Inpatient', 'IOP / PHP', 'Sober Living', 'Detox', 'Interventionist', 'Therapist']::text[])),
      (4, 'city', public.directory_text_is_blank(p_city)),
      (5, 'state', public.directory_text_is_blank(p_state)),
      (6, 'phone', length(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')) < 10),
      (7, 'email', btrim(coalesce(p_email, ''), ' ' || chr(9) || chr(10) || chr(13))
                   !~ ('^[^@ ' || chr(9) || chr(10) || chr(13) || ']+@[^@ ' || chr(9) || chr(10) || chr(13) || ']+[.][^@ ' || chr(9) || chr(10) || chr(13) || ']+$')),
      (8, 'website', public.directory_text_is_blank(p_website)),
      (9, 'monthly_cost', coalesce(p_monthly_cost, 0) <= 0),
      (10, 'insurance', NOT (
        EXISTS (SELECT 1 FROM unnest(coalesce(p_insurance, '{}'::text[])) AS plan WHERE NOT public.directory_text_is_blank(plan))
        OR (p_insurance_networks IS NOT NULL
            AND jsonb_typeof(p_insurance_networks) = 'object'
            AND p_insurance_networks <> '{}'::jsonb)
      ))
    ) AS f(ord, field, missing)
   WHERE f.missing
$$;
REVOKE ALL ON FUNCTION public.directory_missing_fields(text, text, text[], text, text, text, text, text, integer, text[], jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.directory_missing_fields(text, text, text[], text, text, text, text, text, integer, text[], jsonb) TO authenticated;

COMMIT;
