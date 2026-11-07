-- ============================================================================
-- App Store review demo account - seed / reset
-- ============================================================================
--
-- Purpose: give Apple App Review a dedicated ReferralFit account whose
-- workspace is fully entitled (pro + directory + benchmarks) and populated
-- with realistic, entirely fictional data, so every feature can be exercised
-- (Guideline 2.1 - "full access to the app's features and functionality").
--
-- HOW TO USE (Supabase Dashboard, production project):
--
--   1. Authentication -> Users -> "Add user" -> "Create new user".
--        Email:    the address in v_email below
--        Password: a long random password (store it in App Store Connect ->
--                  App Review Information; never commit it)
--        Tick "Auto Confirm User".
--      The on_auth_user_created trigger gives the user a personal workspace.
--
--   2. SQL Editor -> paste this whole file -> Run.
--      Re-runnable: it wipes and re-seeds ONLY the reviewer's own workspace.
--
--   3. In App Store Connect -> App Review Information, enter the exact email
--      and password, then sign in once yourself on a device to confirm.
--
-- Safety: the script refuses to run if the reviewer's workspace has any
-- other member, so it can never touch a real practice's data.
--
-- 1.1.0 (placement requests, level of care, true cost to the family,
-- program credentials, referral handoffs): the last section writes these
-- through the app's own functions, signed in as the reviewer for this
-- transaction only (request.jwt.claims, local to the transaction), so every
-- row, timeline entry and reminder is exactly what the app would write. None
-- of it leaves the reviewer's workspace: the programs here have no portal
-- account, so their answers are logged by the practice (no push to anyone),
-- and a handoff link is never emailed. The placement request is open for 48
-- hours from the run; re-run this script to reset it.
--
-- The file is ASCII only (the em dashes in titles are chr(8212)) so it
-- pastes cleanly into the SQL editor.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_email text := 'appreview@freedominterventions.com';   -- <<< change if you used a different address
  v_user  uuid;
  v_org   uuid;
  v_members integer;

  -- partners
  p_cedar uuid; p_harbor uuid; p_summit uuid; p_bridge uuid; p_sage uuid; p_north uuid;
  -- cases
  c_henderson uuid; c_ortiz uuid; c_nguyen uuid; c_walker uuid;
  -- contacts
  ct_h_mom uuid; ct_h_dad uuid; ct_o_wife uuid; ct_n_sister uuid; ct_w_son uuid;
  -- referrals
  r_cedar_out uuid; r_harbor_out uuid; r_sage_in uuid; r_north_in uuid; r_summit_out uuid;
  -- 1.1.0: three more residential programs, the saved match, its placement
  -- request, and working values
  p_basalt uuid; p_clear uuid; p_juniper uuid;
  v_match uuid; v_req uuid; v_rcpt uuid; v_vob uuid; v_loc jsonb;
  v_cred public.program_credentials; v_c record; v_h record; v_ver integer; v_step text;
  v_dash constant text := chr(8212);
BEGIN
  SELECT id INTO v_user FROM auth.users WHERE lower(email) = lower(v_email);
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'No auth user with email %. Create it first in Authentication -> Users (Auto Confirm on).', v_email;
  END IF;

  SELECT org_id INTO v_org FROM public.org_members WHERE user_id = v_user;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'User % has no workspace membership; the on_auth_user_created trigger did not run.', v_email;
  END IF;

  SELECT count(*) INTO v_members FROM public.org_members WHERE org_id = v_org;
  IF v_members <> 1 THEN
    RAISE EXCEPTION 'Workspace % has % members. The reviewer must be alone in a personal workspace; refusing to reseed.', v_org, v_members;
  END IF;

  -- -- Workspace identity ----------------------------------------------------
  UPDATE public.orgs SET name = 'Review Practice (demo)' WHERE id = v_org;
  UPDATE public.org_members SET display_name = 'App Reviewer' WHERE user_id = v_user;

  -- -- Wipe previous demo data in this workspace only -----------------------
  -- Order respects foreign keys; cases cascade to contacts/events/history,
  -- level-of-care assessments, benefits and benefits checks; partners to
  -- their credentials. Placement requests (with their recipients) and
  -- referral handoffs (with their history) are removed first.
  DELETE FROM public.placement_requests WHERE org_id = v_org;
  DELETE FROM public.referral_handoffs  WHERE org_id = v_org;
  DELETE FROM public.follow_ups     WHERE org_id = v_org;
  DELETE FROM public.referrals      WHERE org_id = v_org;
  DELETE FROM public.match_profiles WHERE org_id = v_org;
  DELETE FROM public.cases          WHERE org_id = v_org;
  DELETE FROM public.touches        WHERE org_id = v_org;
  DELETE FROM public.partners       WHERE org_id = v_org;

  -- -- Full entitlements (manual grant, never expires) ----------------------
  INSERT INTO public.org_entitlements (org_id, entitlement, active, source, expires_at)
  VALUES (v_org, 'pro',        true, 'manual', NULL),
         (v_org, 'directory',  true, 'manual', NULL),
         (v_org, 'benchmarks', true, 'manual', NULL)
  ON CONFLICT (org_id, entitlement)
  DO UPDATE SET active = true, source = 'manual', expires_at = NULL;

  -- -- Partners (fictional programs; 555 numbers, example.com emails) -------
  INSERT INTO public.partners (owner_id, name, organization, types, city, state, regions, phone, email, website,
                               cash_min, cash_max, insurance, therapies, populations, levels, note, favorite,
                               touch_cadence_days, last_contact_at)
  VALUES (v_user, 'Dana Whitfield', 'Cedar Ridge Recovery', ARRAY['Inpatient','Detox'], 'Bend', 'OR', ARRAY['OR','WA','ID'],
          '(541) 555-0142', 'admissions@cedarridge.example.com', 'https://cedarridge.example.com',
          28000, 36000, ARRAY['Cash pay','Aetna','Cigna','Blue Cross'], ARRAY['Dual diagnosis','Trauma','EMDR','Family systems'],
          ARRAY['Adults'], ARRAY['Inpatient','Detox'], 'Strong family program. Admissions answers on the first ring.', true,
          14, now() - interval '3 days')
  RETURNING id INTO p_cedar;

  INSERT INTO public.partners (owner_id, name, organization, types, city, state, regions, phone, email, website,
                               cash_min, cash_max, insurance, therapies, populations, levels, note, favorite,
                               touch_cadence_days, last_contact_at)
  VALUES (v_user, 'Marcus Oyelaran', 'Harbor Light Treatment Center', ARRAY['Inpatient'], 'Newport Beach', 'CA', ARRAY['Nationwide'],
          '(949) 555-0187', 'intake@harborlight.example.com', 'https://harborlight.example.com',
          45000, 60000, ARRAY['Cash pay','Anthem','UnitedHealthcare'], ARRAY['Men only','Chronic relapse','CBT','DBT','Adventure'],
          ARRAY['Adults','Men'], ARRAY['Inpatient'], 'Men-only, 60-90 day. Flies clients in; has a sober transport partner.', true,
          30, now() - interval '25 days')
  RETURNING id INTO p_harbor;

  INSERT INTO public.partners (owner_id, name, organization, types, city, state, regions, phone, email, website,
                               cash_min, cash_max, insurance, therapies, populations, levels, note, favorite,
                               touch_cadence_days, last_contact_at)
  VALUES (v_user, 'Priya Raman', 'Summit Path IOP', ARRAY['IOP / PHP'], 'Portland', 'OR', ARRAY['OR','WA'],
          '(503) 555-0119', 'priya@summitpath.example.com', 'https://summitpath.example.com',
          6000, 9000, ARRAY['Cash pay','Blue Cross','Kaiser Permanente','Oregon Health Plan'], ARRAY['Dual diagnosis','MAT','CBT'],
          ARRAY['Adults'], ARRAY['IOP / PHP'], 'Good step-down after residential. Evening IOP track for working adults.', false,
          21, now() - interval '30 days')
  RETURNING id INTO p_summit;

  INSERT INTO public.partners (owner_id, name, organization, types, city, state, regions, phone, email, website,
                               cash_min, cash_max, insurance, therapies, populations, levels, note, favorite,
                               touch_cadence_days, last_contact_at)
  VALUES (v_user, 'Elena Castellanos', 'Bridge House Sober Living', ARRAY['Sober Living'], 'Bend', 'OR', ARRAY['OR'],
          '(541) 555-0163', 'elena@bridgehouse.example.com', NULL,
          1200, 1800, ARRAY['Cash pay'], ARRAY['Women only','Faith based'],
          ARRAY['Adults','Women'], ARRAY['Sober Living'], 'Women-only house, 6 beds. Requires 30 days sober on entry.', false,
          30, now() - interval '9 days')
  RETURNING id INTO p_bridge;

  INSERT INTO public.partners (owner_id, name, organization, types, city, state, regions, phone, email, website,
                               cash_min, cash_max, insurance, therapies, populations, levels, note, favorite,
                               touch_cadence_days, last_contact_at)
  VALUES (v_user, 'Dr. Samuel Okafor, LMFT', 'Sage Counseling Group', ARRAY['Therapist'], 'Redmond', 'OR', ARRAY['OR'],
          '(541) 555-0128', 'sam@sagecounseling.example.com', 'https://sagecounseling.example.com',
          150, 200, ARRAY['Cash pay','Aetna','Blue Cross'], ARRAY['Family systems','Trauma','IFS'],
          ARRAY['Adults','Adolescents'], ARRAY['Therapist'], 'Refers families to us for intervention; we send post-treatment family work back.', true,
          14, now() - interval '2 days')
  RETURNING id INTO p_sage;

  INSERT INTO public.partners (owner_id, name, organization, types, city, state, regions, phone, email, website,
                               cash_min, cash_max, insurance, therapies, populations, levels, note, favorite,
                               touch_cadence_days, last_contact_at)
  VALUES (v_user, 'Jordan Blake', 'Northstar Intervention Services', ARRAY['Interventionist'], 'Boise', 'ID', ARRAY['ID','MT','UT'],
          '(208) 555-0176', 'jordan@northstar.example.com', NULL,
          5000, 8000, ARRAY['Cash pay'], ARRAY['Chronic relapse','Family systems'],
          ARRAY['Adults'], ARRAY['Interventionist'], 'Covers Idaho/Montana when we are booked. Sends Oregon families to us.', false,
          45, now() - interval '50 days')
  RETURNING id INTO p_north;

  -- -- Touches (relationship history) ----------------------------------------
  INSERT INTO public.touches (owner_id, partner_id, kind, note, occurred_at) VALUES
    (v_user, p_cedar,  'call',    'Confirmed two detox beds open this week.',                 now() - interval '3 days'),
    (v_user, p_cedar,  'meeting', 'Toured the new family lodge. Family weekend is now monthly.', now() - interval '20 days'),
    (v_user, p_sage,   'email',   'Sent post-treatment family session outline.',              now() - interval '2 days'),
    (v_user, p_harbor, 'call',    'Checked on Mr. O ' || v_dash || ' settled in, doing the adventure track.', now() - interval '25 days'),
    (v_user, p_bridge, 'text',    'One bed opening the 1st of the month.',                     now() - interval '9 days'),
    (v_user, p_summit, 'call',    'Evening IOP has a waitlist of ~1 week.',                    now() - interval '30 days');

  -- -- Cases (fictional families) --------------------------------------------
  INSERT INTO public.cases (owner_id, title, status, summary, payment_status, quoted_amount, paid_amount, lead_source, lead_source_detail, created_at)
  VALUES (v_user, 'Henderson family ' || v_dash || ' son Jake, 24', 'intervention',
          'Alcohol and benzos, two ER visits this year. Parents aligned; sister hesitant. Intervention set for Saturday 10am at the parents'' home.',
          'deposit', 7500, 3750, 'Professional referral', 'Sage Counseling Group', now() - interval '12 days')
  RETURNING id INTO c_henderson;

  INSERT INTO public.cases (owner_id, title, status, summary, payment_status, quoted_amount, paid_amount, lead_source, lead_source_detail, created_at)
  VALUES (v_user, 'Ortiz family ' || v_dash || ' husband Daniel, 41', 'placed',
          'Opioids after a back injury. Wife called after the second overdose. Placed at Harbor Light; family coaching ongoing.',
          'paid', 7500, 7500, 'Website', 'Sober Helpline inquiry form', now() - interval '40 days')
  RETURNING id INTO c_ortiz;

  INSERT INTO public.cases (owner_id, title, status, summary, payment_status, quoted_amount, paid_amount, lead_source, lead_source_detail, created_at)
  VALUES (v_user, 'Nguyen family ' || v_dash || ' daughter Mai, 19', 'consult',
          'Stimulants, college sophomore. Sister reached out; parents not yet on board. Consult scheduled with both parents.',
          'quoted', 7500, 0, 'Professional referral', 'Northstar Intervention Services', now() - interval '4 days')
  RETURNING id INTO c_nguyen;

  INSERT INTO public.cases (owner_id, title, status, summary, payment_status, quoted_amount, paid_amount, lead_source, lead_source_detail, created_at)
  VALUES (v_user, 'Walker family ' || v_dash || ' mother Denise, 58', 'inquiry',
          'Wine nightly, recent DUI. Adult son called this morning; wants to understand options before involving siblings.',
          'none', NULL, 0, 'Inbound call', 'Called the office line', now() - interval '6 hours')
  RETURNING id INTO c_walker;

  -- -- Case contacts ---------------------------------------------------------
  INSERT INTO public.case_contacts (owner_id, case_id, name, relationship, phone, email, is_primary, note)
  VALUES (v_user, c_henderson, 'Karen Henderson', 'Mother', '(541) 555-0201', 'karen.h@example.com', true, 'Best reached after 5pm.')
  RETURNING id INTO ct_h_mom;
  INSERT INTO public.case_contacts (owner_id, case_id, name, relationship, phone, email, is_primary, note)
  VALUES (v_user, c_henderson, 'Tom Henderson', 'Father', '(541) 555-0202', 'tom.h@example.com', false, '')
  RETURNING id INTO ct_h_dad;
  INSERT INTO public.case_contacts (owner_id, case_id, name, relationship, phone, email, is_primary, note)
  VALUES (v_user, c_henderson, 'Jake Henderson', 'Subject', '(541) 555-0203', '', false, 'Do not contact before the intervention.');

  INSERT INTO public.case_contacts (owner_id, case_id, name, relationship, phone, email, is_primary, note)
  VALUES (v_user, c_ortiz, 'Maria Ortiz', 'Wife', '(503) 555-0211', 'maria.o@example.com', true, '')
  RETURNING id INTO ct_o_wife;

  INSERT INTO public.case_contacts (owner_id, case_id, name, relationship, phone, email, is_primary, note)
  VALUES (v_user, c_nguyen, 'Linh Nguyen', 'Sister', '(971) 555-0221', 'linh.n@example.com', true, 'Initial caller.')
  RETURNING id INTO ct_n_sister;
  INSERT INTO public.case_contacts (owner_id, case_id, name, relationship, phone, email, is_primary, note)
  VALUES (v_user, c_nguyen, 'Hoa Nguyen', 'Mother', '(971) 555-0222', '', false, 'Prefers Vietnamese; Linh will translate.');

  INSERT INTO public.case_contacts (owner_id, case_id, name, relationship, phone, email, is_primary, note)
  VALUES (v_user, c_walker, 'Chris Walker', 'Son', '(541) 555-0231', 'chris.w@example.com', true, '')
  RETURNING id INTO ct_w_son;

  -- -- Referrals (de-identified labels only) --------------------------------
  INSERT INTO public.referrals (owner_id, partner_id, direction, referred_on, client_label, outcome, note, case_id, admitted, admitted_on, family_experience)
  VALUES (v_user, p_harbor, 'outbound', (now() - interval '35 days')::date, 'Male, 41, opioids', 'Placed',
          'Admitted same day. Family reports good communication from staff.', c_ortiz, true, (now() - interval '34 days')::date, 5)
  RETURNING id INTO r_harbor_out;

  INSERT INTO public.referrals (owner_id, partner_id, direction, referred_on, client_label, outcome, note, case_id)
  VALUES (v_user, p_cedar, 'outbound', (now() - interval '2 days')::date, 'Male, 24, alcohol + benzos', 'Pending',
          'Bed held for Saturday pending intervention outcome.', c_henderson)
  RETURNING id INTO r_cedar_out;

  INSERT INTO public.referrals (owner_id, partner_id, direction, referred_on, client_label, outcome, note, case_id)
  VALUES (v_user, p_sage, 'inbound', (now() - interval '12 days')::date, 'Family of male, 24', 'Consulted',
          'Sage referred the Henderson family to us.', c_henderson)
  RETURNING id INTO r_sage_in;

  INSERT INTO public.referrals (owner_id, partner_id, direction, referred_on, client_label, outcome, note, case_id)
  VALUES (v_user, p_north, 'inbound', (now() - interval '4 days')::date, 'Family of female, 19', 'Consulted',
          'Out of Northstar''s area; sent to us.', c_nguyen)
  RETURNING id INTO r_north_in;

  INSERT INTO public.referrals (owner_id, partner_id, direction, referred_on, client_label, outcome, note, admitted, admitted_on, family_experience)
  VALUES (v_user, p_summit, 'outbound', (now() - interval '70 days')::date, 'Female, 33, alcohol', 'Placed',
          'Step-down after residential elsewhere.', true, (now() - interval '68 days')::date, 4)
  RETURNING id INTO r_summit_out;

  INSERT INTO public.referrals (owner_id, partner_id, direction, referred_on, client_label, outcome, note)
  VALUES (v_user, p_bridge, 'outbound', (now() - interval '55 days')::date, 'Female, 33, alcohol', 'Introduced',
          'Introduced for housing after IOP; family still deciding.');

  -- -- Case timeline events --------------------------------------------------
  INSERT INTO public.case_events (owner_id, case_id, kind, body, contact_id, referral_id, occurred_at) VALUES
    (v_user, c_henderson, 'call',    'Intake call with Karen. Two ER visits, last one 3 weeks ago. Wants to move fast.', ct_h_mom, NULL, now() - interval '12 days'),
    (v_user, c_henderson, 'meeting', 'Family consult (parents + sister). Sister worried about ''ambushing''. Explained the invitational approach.', NULL, NULL, now() - interval '8 days'),
    (v_user, c_henderson, 'payment', 'Deposit received: $3,750.', NULL, NULL, now() - interval '7 days'),
    (v_user, c_henderson, 'referral','Bed held at Cedar Ridge Recovery.', NULL, r_cedar_out, now() - interval '2 days'),
    (v_user, c_henderson, 'text',    'Confirmed Saturday 10am with Tom.', ct_h_dad, NULL, now() - interval '1 day'),
    (v_user, c_ortiz,     'call',    'Maria called after second overdose. Narcan on hand. Discussed immediate safety plan.', ct_o_wife, NULL, now() - interval '40 days'),
    (v_user, c_ortiz,     'referral','Placed at Harbor Light. Sober transport arranged.', NULL, r_harbor_out, now() - interval '35 days'),
    (v_user, c_ortiz,     'payment', 'Balance paid in full.', NULL, NULL, now() - interval '33 days'),
    (v_user, c_ortiz,     'note',    'Week 4 family session: Maria attending Al-Anon, boundaries around finances holding.', NULL, NULL, now() - interval '6 days'),
    (v_user, c_nguyen,    'call',    'Linh: parents believe it is ''just college''. Walked through how to invite them to a consult.', ct_n_sister, NULL, now() - interval '4 days'),
    (v_user, c_nguyen,    'email',   'Sent consult prep sheet to Linh to share with parents.', ct_n_sister, NULL, now() - interval '3 days'),
    (v_user, c_walker,    'call',    'Chris: mom''s DUI last week. Wants to understand options before involving siblings. Gentle, not urgent.', ct_w_son, NULL, now() - interval '6 hours');

  -- -- Today Command Center: follow-ups and next steps ----------------------
  INSERT INTO public.follow_ups (owner_id, case_id, partner_id, referral_id, kind, title, due_on, due_time, status, note, waiting_on) VALUES
    (v_user, c_walker,    NULL,     NULL,         'first_call',    'First call back ' || v_dash || ' Chris Walker',                    CURRENT_DATE,                 '14:00', 'open', 'He asked for a call this afternoon.', ''),
    (v_user, c_nguyen,    NULL,     NULL,         'consult',       'Consult ' || v_dash || ' Nguyen parents (Linh translating)',        CURRENT_DATE + 1,             '18:30', 'open', 'Zoom link sent.', ''),
    (v_user, c_henderson, p_cedar,  r_cedar_out,  'promised_call', 'Confirm Cedar Ridge bed for Saturday',              CURRENT_DATE,                 NULL,    'open', '', ''),
    (v_user, c_henderson, NULL,     NULL,         'follow_up',     'Rehearsal call with the Henderson family',          CURRENT_DATE + 2,             '17:00', 'open', 'Letters due before the call.', ''),
    (v_user, c_ortiz,     p_harbor, r_harbor_out, 'follow_up',     'Week 6 check-in ' || v_dash || ' Daniel Ortiz discharge plan',     CURRENT_DATE + 5,             NULL,    'open', 'Ask about step-down to Summit Path.', ''),
    (v_user, c_nguyen,    NULL,     NULL,         'waiting_on',    'Waiting on parents to confirm consult time',        CURRENT_DATE - 1,             NULL,    'open', '', 'Linh Nguyen'),
    (v_user, NULL,        p_summit, NULL,         'touch',         'Stay in touch ' || v_dash || ' Summit Path IOP',                   CURRENT_DATE - 9,             NULL,    'open', 'Cadence 21 days; last contact 30 days ago.', ''),
    (v_user, NULL,        p_north,  NULL,         'touch',         'Stay in touch ' || v_dash || ' Northstar Intervention Services',   CURRENT_DATE - 5,             NULL,    'open', '', ''),
    (v_user, c_ortiz,     NULL,     NULL,         'follow_up',     'Send Maria the family-boundaries worksheet',        CURRENT_DATE - 3,             NULL,    'done', '', '');

  UPDATE public.follow_ups SET completed_at = now() - interval '3 days' WHERE org_id = v_org AND status = 'done';

  -- -- A saved match profile (Matching tab) ---------------------------------
  INSERT INTO public.match_profiles (owner_id, client_label, level_of_care, state, insurance, network_preferences, max_budget, therapies, status, case_id)
  VALUES (v_user, 'Female, 19, stimulants', 'Inpatient', 'OR', 'Blue Cross', ARRAY['In-network','Out-of-network'], 40000, ARRAY['Dual diagnosis','Trauma'], 'Matching', c_nguyen)
  RETURNING id INTO v_match;

  -- -- 1.1.0 features ---------------------------------------------------------
  -- Signed in as the reviewer for the rest of this transaction, so the app's
  -- functions below check and write exactly what the app would.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);

  -- Three more residential programs for the placement request (fictional).
  INSERT INTO public.partners (owner_id, name, organization, types, city, state, regions, phone, email, website,
                               cash_min, cash_max, insurance, therapies, populations, levels, note, favorite,
                               touch_cadence_days, last_contact_at)
  VALUES (v_user, 'Hannah Ellery', 'Basalt Canyon Recovery', ARRAY['Inpatient','Detox'], 'Redmond', 'OR', ARRAY['OR','WA','CA'],
          '(541) 555-0190', 'admissions@basaltcanyon.example.com', 'https://basaltcanyon.example.com',
          24000, 32000, ARRAY['Cash pay','Blue Cross','Aetna','Cigna'], ARRAY['Dual diagnosis','Trauma','Women only','MAT','Family systems'],
          ARRAY['Adults','Women'], ARRAY['Inpatient','Detox'], 'Women''s track with a young-adult cohort. Answers within the hour.', true,
          21, now() - interval '6 days')
  RETURNING id INTO p_basalt;

  INSERT INTO public.partners (owner_id, name, organization, types, city, state, regions, phone, email, website,
                               cash_min, cash_max, insurance, therapies, populations, levels, note, favorite,
                               touch_cadence_days, last_contact_at)
  VALUES (v_user, 'Owen Castellane', 'Clearwater Bluff Recovery', ARRAY['Inpatient'], 'Spokane', 'WA', ARRAY['WA','OR','ID'],
          '(509) 555-0144', 'intake@clearwaterbluff.example.com', 'https://clearwaterbluff.example.com',
          30000, 42000, ARRAY['Cash pay','Blue Cross','Premera','Regence'], ARRAY['Dual diagnosis','Trauma','EMDR','DBT','MAT'],
          ARRAY['Adults'], ARRAY['Inpatient'], 'Strong dual-diagnosis team. Takes college-age clients mid-semester.', false,
          30, now() - interval '12 days')
  RETURNING id INTO p_clear;

  INSERT INTO public.partners (owner_id, name, organization, types, city, state, regions, phone, email, website,
                               cash_min, cash_max, insurance, therapies, populations, levels, note, favorite,
                               touch_cadence_days, last_contact_at)
  VALUES (v_user, 'Rosa Abernathy', 'Juniper Crest Recovery', ARRAY['Inpatient'], 'Eugene', 'OR', ARRAY['OR'],
          '(541) 555-0177', 'admissions@junipercrest.example.com', 'https://junipercrest.example.com',
          26000, 34000, ARRAY['Cash pay','Blue Cross','PacificSource'], ARRAY['Dual diagnosis','Trauma','Women only'],
          ARRAY['Adults','Women'], ARRAY['Inpatient'], 'Small women''s program. Slow to call back on weekends.', false,
          30, now() - interval '18 days')
  RETURNING id INTO p_juniper;

  -- True cost to the family (Nguyen case): the family's plan, then three
  -- programs' benefits answers, in- and out-of-network.
  PERFORM public.save_case_benefits(c_nguyen, jsonb_build_object(
    'carrier', 'Blue Cross', 'plan_name', 'PPO 1500', 'subscriber_relationship', 'parent',
    'in_deductible', 1500, 'in_deductible_met', 400, 'in_oop_max', 6500, 'in_oop_met', 900, 'in_coinsurance_pct', 20,
    'oon_benefits', true, 'oon_deductible', 4000, 'oon_deductible_met', 0, 'oon_oop_max', 13000, 'oon_oop_met', 0,
    'oon_coinsurance_pct', 40), gen_random_uuid());
  FOR v_c IN SELECT * FROM (VALUES
      (p_basalt, 'Basalt Canyon Recovery',    'in_network',     880,  980),
      (p_cedar,  'Cedar Ridge Recovery',      'in_network',     950, 1150),
      (p_clear,  'Clearwater Bluff Recovery', 'out_of_network', 760, 1300)
    ) AS t(partner_id, program_name, status, allowed, billed)
  LOOP
    v_vob := gen_random_uuid();
    PERFORM public.request_vob(jsonb_build_object('id', v_vob, 'case_id', c_nguyen, 'partner_id', v_c.partner_id,
      'program_name', v_c.program_name, 'note', '', 'due_on', CURRENT_DATE + 1,
      'event_id', gen_random_uuid(), 'follow_up_id', gen_random_uuid()));
    PERFORM public.update_vob_status(v_vob, jsonb_build_object('status', v_c.status, 'answered_by', 'Plan representative',
      'note', '', 'allowed_daily_rate', v_c.allowed, 'billed_daily_rate', v_c.billed, 'copay_per_day', 0,
      'precert_required', true), gen_random_uuid());
  END LOOP;

  -- Level-of-care assessment (Nguyen case): six areas, the recommendation the
  -- rules give, and the level chosen (the recommendation).
  v_loc := public.level_of_care_recommendation(ARRAY[1,1,3,2,3,3], 2);
  PERFORM public.save_case_assessment(gen_random_uuid(), c_nguyen, ARRAY[1,1,3,2,3,3],
    ARRAY['Stimulants; sleep and appetite off, no withdrawal risk.',
          'No acute medical concerns.',
          'Anxiety and low mood since spring; no current self-harm.',
          'Ambivalent. Agrees school is slipping.',
          'Two attempts to cut down this semester did not hold.',
          'Dorm with active use around her; family supportive.'],
    false, 2, v_loc ->> 'level', v_loc ->> 'first_step', v_loc ->> 'support',
    coalesce(v_loc ->> 'first_step', v_loc ->> 'level'), '');

  -- Placement request from the saved match to four programs, in the
  -- practice's own ranking; three answers logged by the practice, one open.
  v_req := gen_random_uuid();
  PERFORM public.create_placement_request(v_req, v_match, '{}'::jsonb,
    ARRAY[p_basalt, p_cedar, p_clear, p_juniper], 48, 'this_week',
    'Mid-semester; family can travel within the region. Prefers a young-adult cohort.',
    c_nguyen, ARRAY[1, 2, 3, 4]);
  SELECT id INTO v_rcpt FROM public.placement_request_recipients WHERE request_id = v_req AND partner_id = p_basalt;
  PERFORM public.log_manual_response(v_rcpt, 'yes', 'yes', CURRENT_DATE + 2, 980,
    'In-network with Blue Cross', 'Young-adult women''s cohort has an opening.');
  SELECT id INTO v_rcpt FROM public.placement_request_recipients WHERE request_id = v_req AND partner_id = p_cedar;
  PERFORM public.log_manual_response(v_rcpt, 'waitlist', 'maybe', CURRENT_DATE + 8, 1150,
    '', 'Wants a clinical call first.');
  SELECT id INTO v_rcpt FROM public.placement_request_recipients WHERE request_id = v_req AND partner_id = p_clear;
  PERFORM public.log_manual_response(v_rcpt, 'yes', 'yes', CURRENT_DATE + 4, 1300,
    'Out of network; single-case agreement possible', '');

  -- Program credentials, checked by this practice: Cedar Ridge and Clearwater
  -- Bluff have all four; Basalt Canyon has no LegitScript on file; Harbor
  -- Light has its license and accreditation. NPIs are valid numbers that the
  -- NPI Registry has no one under (checked 2026-11-07).
  FOR v_c IN SELECT * FROM (VALUES
      (p_cedar,  'state_license', NULL::text,         'OR-SUD-3982', 'OR', CURRENT_DATE + 240),
      (p_cedar,  'accreditation', 'carf',             '4471203',     '',   CURRENT_DATE + 400),
      (p_cedar,  'legitscript',   NULL,               'LS-60238',    '',   CURRENT_DATE + 300),
      (p_cedar,  'npi',           NULL,               '1628394052',  '',   NULL::date),
      (p_basalt, 'state_license', NULL,               'OR-SUD-4417', 'OR', CURRENT_DATE + 210),
      (p_basalt, 'accreditation', 'joint_commission', '558213',      '',   CURRENT_DATE + 520),
      (p_basalt, 'npi',           NULL,               '1745820393',  '',   NULL),
      (p_clear,  'state_license', NULL,               'WA-BHA-2291', 'WA', CURRENT_DATE + 150),
      (p_clear,  'accreditation', 'joint_commission', '602174',      '',   CURRENT_DATE + 480),
      (p_clear,  'legitscript',   NULL,               'LS-71554',    '',   CURRENT_DATE + 330),
      (p_clear,  'npi',           NULL,               '1582746305',  '',   NULL),
      (p_harbor, 'state_license', NULL,               'CA-DHCS-8817', 'CA', CURRENT_DATE + 365),
      (p_harbor, 'accreditation', 'joint_commission', '491027',      '',   CURRENT_DATE + 600)
    ) AS t(partner_id, kind, accreditor, identifier, issuing_state, expires_on)
  LOOP
    SELECT * INTO v_cred FROM public.save_program_credential(gen_random_uuid(), NULL, v_c.partner_id, v_c.kind,
      v_c.accreditor, '', v_c.identifier, v_c.issuing_state, v_c.expires_on, NULL, '');
    PERFORM public.verify_program_credential(v_cred.id, 'verified', '', v_cred.updated_at);
  END LOOP;

  -- A referral handoff in progress: the Henderson referral to Cedar Ridge.
  -- The program has marked each step on its handoff page up to "family
  -- reached" (the same function its page calls, with the link's token).
  SELECT * INTO v_h FROM public.create_referral_handoff(r_cedar_out, c_henderson, p_cedar,
    'Young adult, alcohol', 'Dana Whitfield, Admissions', 'admissions@cedarridge.example.com');
  v_ver := v_h.version;
  FOREACH v_step IN ARRAY ARRAY['received', 'contact_attempted', 'family_reached'] LOOP
    SELECT t.version INTO v_ver FROM public.public_referral_handoff_transition(v_h.token, v_ver, v_step) AS t;
  END LOOP;

  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);

  RAISE NOTICE 'Seeded reviewer workspace % for %', v_org, v_email;
END
$$;

COMMIT;

-- -- Verification (all counts should be > 0 and all three entitlements true) --
SELECT
  (SELECT count(*) FROM public.partners  p JOIN public.org_members m ON m.org_id = p.org_id
    JOIN auth.users u ON u.id = m.user_id WHERE lower(u.email) = 'appreview@freedominterventions.com') AS partners,
  (SELECT count(*) FROM public.cases     c JOIN public.org_members m ON m.org_id = c.org_id
    JOIN auth.users u ON u.id = m.user_id WHERE lower(u.email) = 'appreview@freedominterventions.com') AS cases,
  (SELECT count(*) FROM public.follow_ups f JOIN public.org_members m ON m.org_id = f.org_id
    JOIN auth.users u ON u.id = m.user_id WHERE lower(u.email) = 'appreview@freedominterventions.com') AS follow_ups,
  (SELECT bool_and(e.active) FROM public.org_entitlements e JOIN public.org_members m ON m.org_id = e.org_id
    JOIN auth.users u ON u.id = m.user_id WHERE lower(u.email) = 'appreview@freedominterventions.com') AS all_plans_active,
  -- 1.1.0: expect 3 answered of 4 asked, 1 assessment, 3 benefits answers,
  -- 13 verified credentials, and the handoff at family_reached.
  (SELECT count(*) FILTER (WHERE r.status = 'responded') || ' of ' || count(*) FROM public.placement_request_recipients r
    JOIN public.org_members m ON m.org_id = r.org_id JOIN auth.users u ON u.id = m.user_id
    WHERE lower(u.email) = 'appreview@freedominterventions.com') AS placement_answers,
  (SELECT count(*) FROM public.case_assessments a JOIN public.org_members m ON m.org_id = a.org_id
    JOIN auth.users u ON u.id = m.user_id WHERE lower(u.email) = 'appreview@freedominterventions.com') AS assessments,
  (SELECT count(*) FROM public.vob_requests v JOIN public.org_members m ON m.org_id = v.org_id
    JOIN auth.users u ON u.id = m.user_id WHERE lower(u.email) = 'appreview@freedominterventions.com'
    AND v.allowed_daily_rate IS NOT NULL) AS benefits_answers,
  (SELECT count(*) FROM public.program_credentials c JOIN public.org_members m ON m.org_id = c.org_id
    JOIN auth.users u ON u.id = m.user_id WHERE lower(u.email) = 'appreview@freedominterventions.com'
    AND c.status = 'verified') AS verified_credentials,
  (SELECT string_agg(h.status, ',') FROM public.referral_handoffs h JOIN public.org_members m ON m.org_id = h.org_id
    JOIN auth.users u ON u.id = m.user_id WHERE lower(u.email) = 'appreview@freedominterventions.com') AS handoff;
