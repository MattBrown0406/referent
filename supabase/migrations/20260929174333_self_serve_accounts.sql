BEGIN;

-- Self-serve accounts: sign-up metadata + in-app account deletion.
--
-- Problem (Matt Brown, 2026-09-29): a prospective user opened ReferralFit and
-- found only a sign-in screen. The app now offers "Create account" and
-- "Forgot password" in LoginScreen. Apple App Store guideline 5.1.1(v)
-- requires an app that offers account creation to also offer in-app account
-- deletion, so this migration ships both halves:
--
--   1. handle_new_user() reads the practice and display name the sign-up form
--      passes in raw_user_meta_data, instead of always creating "My Practice".
--   2. delete_own_account() lets the signed-in user delete themselves. It is
--      the only path that removes an auth.users row from the app.
--
-- Deletion rules (see delete_own_account for the exact order):
--   * Member of a shared workspace  -> only the membership goes. Work they
--     created stays with the practice (owner_id columns are ON DELETE SET NULL).
--   * Sole owner (no other members) -> the whole workspace is deleted:
--     partners, touches, referrals, match profiles, follow-ups, cases and
--     every case_* table, invites, entitlements, favorites, claim requests.
--   * Owner with other members      -> refused. The owner must remove the
--     other members first (each gets their own workspace via remove_org_member)
--     or ask ReferralFit to transfer ownership.
--   * center_members row            -> removed (the center listing stays).
--   * Directory listing owned by the workspace (global_partners.owner_org_id)
--     -> unlinked, never deleted. Other practices may have imported it.
--
-- The org_id foreign keys on the workspace data tables were created without
-- ON DELETE CASCADE (20260819120000_org_workspaces.sql), so the function
-- deletes those rows explicitly before deleting the org.

-- ─── 1. Sign-up metadata ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_meta jsonb := coalesce(NEW.raw_user_meta_data, '{}'::jsonb);
  v_practice text := left(nullif(btrim(coalesce(v_meta->>'practice_name', '')), ''), 120);
  v_display text := left(nullif(btrim(coalesce(v_meta->>'display_name', '')), ''), 80);
BEGIN
  INSERT INTO public.orgs (name, created_by)
  VALUES (coalesce(v_practice, 'My Practice'), NEW.id)
  RETURNING id INTO v_org;
  INSERT INTO public.org_members (org_id, user_id, role, display_name)
  VALUES (
    v_org, NEW.id, 'owner',
    coalesce(
      v_display,
      nullif(split_part(coalesce(NEW.email, ''), '@', 1), ''),
      'Member'
    )
  );
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- ─── 2. Self-serve account deletion ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.delete_own_account()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid;
  v_role text;
  v_others integer := 0;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_user) THEN
    RAISE EXCEPTION 'This account no longer exists' USING ERRCODE = 'P0002';
  END IF;

  SELECT org_id, role INTO v_org, v_role
    FROM public.org_members
   WHERE user_id = v_user;

  IF v_org IS NOT NULL AND v_role = 'owner' THEN
    SELECT count(*) INTO v_others
      FROM public.org_members
     WHERE org_id = v_org AND user_id <> v_user;
    IF v_others > 0 THEN
      RAISE EXCEPTION
        'Your workspace still has % other member(s). Remove them from the Workspace screen first (each keeps their own workspace), or contact ReferralFit to transfer ownership, then delete your account.',
        v_others
        USING ERRCODE = '22023';
    END IF;

    -- Sole owner: the workspace goes with the account. Delete the data tables
    -- whose org_id foreign key has no ON DELETE action, children first. The
    -- remaining tables cascade from orgs.
    DELETE FROM public.follow_ups         WHERE org_id = v_org;
    DELETE FROM public.case_events        WHERE org_id = v_org;
    DELETE FROM public.case_integrations  WHERE org_id = v_org;
    DELETE FROM public.case_documents     WHERE org_id = v_org;
    DELETE FROM public.case_stage_history WHERE org_id = v_org;
    DELETE FROM public.case_contacts      WHERE org_id = v_org;
    DELETE FROM public.referrals          WHERE org_id = v_org;
    DELETE FROM public.match_profiles     WHERE org_id = v_org;
    DELETE FROM public.cases              WHERE org_id = v_org;
    DELETE FROM public.touches            WHERE org_id = v_org;
    DELETE FROM public.partners           WHERE org_id = v_org;

    -- Directory listings this practice claimed stay public but become
    -- unclaimed. The FK is ON DELETE SET NULL as well; this is explicit so the
    -- rule is visible here.
    UPDATE public.global_partners
       SET owner_org_id = NULL
     WHERE owner_org_id = v_org;

    -- Cascades: org_members, org_invites, org_entitlements,
    -- org_revenuecat_grants, user_favorites, center_claim_requests.
    DELETE FROM public.orgs WHERE id = v_org;
  END IF;

  -- Member of a shared workspace: membership is removed by the auth.users
  -- cascade below; their contributions stay with the practice.
  DELETE FROM public.center_members WHERE user_id = v_user;

  -- auth schema rows (identities, sessions, refresh tokens, mfa factors)
  -- cascade from auth.users in Supabase.
  DELETE FROM auth.users WHERE id = v_user;
END
$$;

REVOKE ALL ON FUNCTION public.delete_own_account() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_own_account() TO authenticated;

COMMENT ON FUNCTION public.delete_own_account() IS
  'Self-serve account deletion (App Store 5.1.1(v)). Sole owners delete their workspace; owners with other members are refused; members leave their practice data behind.';

COMMIT;
