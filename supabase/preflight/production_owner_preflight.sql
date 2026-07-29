-- Read-only production preflight for 20260728232820_harden_owner_relationships.sql.
-- Run with psql before supabase db push. Any mismatch returns exit code 3.
\set ON_ERROR_STOP on
BEGIN READ ONLY;

WITH conflicts(relationship, mismatch_count) AS (
  SELECT 'touches.partner', count(*) FROM public.touches c LEFT JOIN public.partners p ON p.id=c.partner_id AND p.owner_id=c.owner_id WHERE c.partner_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT 'referrals.partner', count(*) FROM public.referrals c LEFT JOIN public.partners p ON p.id=c.partner_id AND p.owner_id=c.owner_id WHERE c.partner_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT 'follow_ups.partner', count(*) FROM public.follow_ups c LEFT JOIN public.partners p ON p.id=c.partner_id AND p.owner_id=c.owner_id WHERE c.partner_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT 'follow_ups.referral', count(*) FROM public.follow_ups c LEFT JOIN public.referrals p ON p.id=c.referral_id AND p.owner_id=c.owner_id WHERE c.referral_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT 'case_contacts.case', count(*) FROM public.case_contacts c LEFT JOIN public.cases p ON p.id=c.case_id AND p.owner_id=c.owner_id WHERE c.case_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT 'case_events.case', count(*) FROM public.case_events c LEFT JOIN public.cases p ON p.id=c.case_id AND p.owner_id=c.owner_id WHERE c.case_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT 'case_documents.case', count(*) FROM public.case_documents c LEFT JOIN public.cases p ON p.id=c.case_id AND p.owner_id=c.owner_id WHERE c.case_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT 'match_profiles.partner', count(*) FROM public.match_profiles c LEFT JOIN public.partners p ON p.id=c.assigned_partner_id AND p.owner_id=c.owner_id WHERE c.assigned_partner_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT 'match_profiles.referral', count(*) FROM public.match_profiles c LEFT JOIN public.referrals p ON p.id=c.referral_id AND p.owner_id=c.owner_id WHERE c.referral_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT 'match_profiles.case', count(*) FROM public.match_profiles c LEFT JOIN public.cases p ON p.id=c.case_id AND p.owner_id=c.owner_id WHERE c.case_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT 'referrals.match_profile', count(*) FROM public.referrals c LEFT JOIN public.match_profiles p ON p.id=c.match_profile_id AND p.owner_id=c.owner_id WHERE c.match_profile_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT 'referrals.case', count(*) FROM public.referrals c LEFT JOIN public.cases p ON p.id=c.case_id AND p.owner_id=c.owner_id WHERE c.case_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT 'cases.match_profile', count(*) FROM public.cases c LEFT JOIN public.match_profiles p ON p.id=c.match_profile_id AND p.owner_id=c.owner_id WHERE c.match_profile_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT 'follow_ups.case', count(*) FROM public.follow_ups c LEFT JOIN public.cases p ON p.id=c.case_id AND p.owner_id=c.owner_id WHERE c.case_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT 'case_events.contact', count(*) FROM public.case_events c LEFT JOIN public.case_contacts p ON p.id=c.contact_id AND p.owner_id=c.owner_id WHERE c.contact_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT 'case_events.referral', count(*) FROM public.case_events c LEFT JOIN public.referrals p ON p.id=c.referral_id AND p.owner_id=c.owner_id WHERE c.referral_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT 'case_events.document', count(*) FROM public.case_events c LEFT JOIN public.case_documents p ON p.id=c.document_id AND p.owner_id=c.owner_id WHERE c.document_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT 'case_contacts.primary_unique', count(*)
    FROM (SELECT owner_id, case_id FROM public.case_contacts WHERE is_primary GROUP BY owner_id, case_id HAVING count(*) > 1) duplicates UNION ALL
  SELECT 'case_contacts.primary_required', count(*)
    FROM (SELECT owner_id, case_id FROM public.case_contacts GROUP BY owner_id, case_id HAVING count(*) FILTER (WHERE is_primary) = 0) missing
)
SELECT relationship, mismatch_count FROM conflicts ORDER BY relationship;

WITH conflicts(mismatch_count) AS (
  SELECT count(*) FROM public.touches c LEFT JOIN public.partners p ON p.id=c.partner_id AND p.owner_id=c.owner_id WHERE c.partner_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT count(*) FROM public.referrals c LEFT JOIN public.partners p ON p.id=c.partner_id AND p.owner_id=c.owner_id WHERE c.partner_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT count(*) FROM public.follow_ups c LEFT JOIN public.partners p ON p.id=c.partner_id AND p.owner_id=c.owner_id WHERE c.partner_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT count(*) FROM public.follow_ups c LEFT JOIN public.referrals p ON p.id=c.referral_id AND p.owner_id=c.owner_id WHERE c.referral_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT count(*) FROM public.case_contacts c LEFT JOIN public.cases p ON p.id=c.case_id AND p.owner_id=c.owner_id WHERE p.id IS NULL UNION ALL
  SELECT count(*) FROM public.case_events c LEFT JOIN public.cases p ON p.id=c.case_id AND p.owner_id=c.owner_id WHERE p.id IS NULL UNION ALL
  SELECT count(*) FROM public.case_documents c LEFT JOIN public.cases p ON p.id=c.case_id AND p.owner_id=c.owner_id WHERE p.id IS NULL UNION ALL
  SELECT count(*) FROM public.match_profiles c LEFT JOIN public.partners p ON p.id=c.assigned_partner_id AND p.owner_id=c.owner_id WHERE c.assigned_partner_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT count(*) FROM public.match_profiles c LEFT JOIN public.referrals p ON p.id=c.referral_id AND p.owner_id=c.owner_id WHERE c.referral_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT count(*) FROM public.match_profiles c LEFT JOIN public.cases p ON p.id=c.case_id AND p.owner_id=c.owner_id WHERE c.case_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT count(*) FROM public.referrals c LEFT JOIN public.match_profiles p ON p.id=c.match_profile_id AND p.owner_id=c.owner_id WHERE c.match_profile_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT count(*) FROM public.referrals c LEFT JOIN public.cases p ON p.id=c.case_id AND p.owner_id=c.owner_id WHERE c.case_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT count(*) FROM public.cases c LEFT JOIN public.match_profiles p ON p.id=c.match_profile_id AND p.owner_id=c.owner_id WHERE c.match_profile_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT count(*) FROM public.follow_ups c LEFT JOIN public.cases p ON p.id=c.case_id AND p.owner_id=c.owner_id WHERE c.case_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT count(*) FROM public.case_events c LEFT JOIN public.case_contacts p ON p.id=c.contact_id AND p.owner_id=c.owner_id WHERE c.contact_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT count(*) FROM public.case_events c LEFT JOIN public.referrals p ON p.id=c.referral_id AND p.owner_id=c.owner_id WHERE c.referral_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT count(*) FROM public.case_events c LEFT JOIN public.case_documents p ON p.id=c.document_id AND p.owner_id=c.owner_id WHERE c.document_id IS NOT NULL AND p.id IS NULL UNION ALL
  SELECT count(*) FROM (SELECT owner_id, case_id FROM public.case_contacts WHERE is_primary GROUP BY owner_id, case_id HAVING count(*) > 1) duplicates UNION ALL
  SELECT count(*) FROM (SELECT owner_id, case_id FROM public.case_contacts GROUP BY owner_id, case_id HAVING count(*) FILTER (WHERE is_primary) = 0) missing
)
SELECT (sum(mismatch_count) > 0) AS owner_conflicts FROM conflicts \gset
ROLLBACK;

\if :owner_conflicts
  \echo 'BLOCKED: ownership or primary-contact conflicts exist; migration was not attempted.'
  \quit 3
\else
  \echo 'PASS: no ownership or primary-contact conflicts found.'
\endif
