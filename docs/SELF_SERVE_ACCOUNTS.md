# Self-serve accounts: sign-up, password reset, account deletion

Shipped 2026-09-29 after a prospective user found only a sign-in screen.
The app now offers **Create account**, **Forgot password?**, and (required by
App Store guideline 5.1.1(v) once sign-up exists) **Delete account**.

Nothing in this document is applied automatically. Matt applies the migration
and confirms the Supabase Auth settings by hand.

## 1. Supabase Auth dashboard settings to confirm

Project: `ovfafffvcpaahktvlsdm` (see `src/lib/supabase.ts`).

### Authentication → Providers → Email

| Setting | Required value | Why |
| --- | --- | --- |
| Enable Email provider | ON | Sign-in and sign-up both use email + password. |
| **Allow new users to sign up** | **ON** | Without this every "Create account" attempt fails with "Signups not allowed", which the app shows as "New sign-ups are currently turned off". |
| Confirm email | Your choice, see below | Decides which sign-up flow users get. |
| Secure email change | Either | Not used by the app. |
| Minimum password length | 8 recommended | The app already enforces 8 client-side; setting 8 here keeps the rule server-side too. |

**Confirm email OFF** (simplest): `signUp` returns a session immediately, the
workspace is created by the `handle_new_user` trigger, and the user lands in
the app signed in. Anyone with an email address can create a workspace
without proving they own the address.

**Confirm email ON** (recommended once custom SMTP is configured): `signUp`
returns no session. The app shows "Check your email" with a **Resend
confirmation email** button. The confirmation link redirects to
`referralfit://auth/confirmed`, which opens the app and signs the user in. If
the same email is already registered, Supabase returns an empty-identities
user and the app tells the person to sign in or reset instead.

Note: the built-in Supabase email sender is rate-limited (a few emails per
hour). Configure **Authentication → SMTP Settings** with a real sender before
turning on Confirm email for prospects.

### Authentication → URL Configuration

Both the reset link and the confirmation link redirect into the app via its
custom scheme (`"scheme": "referralfit"` in `app.json`). Supabase only
redirects to allow-listed URLs, so add both:

| Field | Value |
| --- | --- |
| Site URL | keep as is (used only when a redirect is not allow-listed) |
| Redirect URLs (add) | `referralfit://auth/recovery` |
| Redirect URLs (add) | `referralfit://auth/confirmed` |

If these are missing, the email link lands on the Site URL in a browser tab
instead of opening the app, and the user cannot set a new password.

### Email templates (optional)

The default **Reset Password** and **Confirm signup** templates work. If you
edit them, keep `{{ .ConfirmationURL }}` in the link.

## 2. Apply the migration

The migration is `supabase/migrations/20260929174333_self_serve_accounts.sql`.
It replaces `public.handle_new_user()` (now reads the practice and display
name from sign-up metadata) and adds `public.delete_own_account()`.

1. Supabase → **SQL Editor** → paste the whole file → Run. It is wrapped in
   `BEGIN … COMMIT`, so it applies atomically.
2. Record it so `supabase db push` and CI agree with production:

   ```sql
   INSERT INTO supabase_migrations.schema_migrations (version, name)
   VALUES ('20260929174333', 'self_serve_accounts');
   ```

## 3. Verify

```sql
-- The RPC exists and only authenticated users can call it.
SELECT proname,
       has_function_privilege('anon', 'public.delete_own_account()', 'EXECUTE')          AS anon_can_run,
       has_function_privilege('authenticated', 'public.delete_own_account()', 'EXECUTE') AS authenticated_can_run
  FROM pg_proc
 WHERE proname = 'delete_own_account';
-- expected: 1 row, anon_can_run = false, authenticated_can_run = true

-- The trigger reads sign-up metadata.
SELECT prosrc LIKE '%practice_name%' AS reads_practice_name
  FROM pg_proc WHERE proname = 'handle_new_user';
-- expected: true
```

End-to-end check on a device: create a throwaway account with a practice
name, confirm the Workspace screen shows that practice name, then delete the
account from the Workspace screen and confirm sign-in with it fails.

## 4. How the flows work

**Create account** (`src/lib/LoginScreen.tsx`): practice/organization name,
your name, email, password (8+ characters), confirm password →
`supabase.auth.signUp` with `practice_name` and `display_name` in the user
metadata. `handle_new_user()` turns that into the workspace name and the
owner's display name. Password is never logged or echoed.

**Forgot password**: `supabase.auth.resetPasswordForEmail(email, { redirectTo:
'referralfit://auth/recovery' })`. Opening the link on the phone launches the
app; `App.tsx` exchanges the tokens in the link for a session and shows
`src/lib/ResetPasswordScreen.tsx`, which calls `supabase.auth.updateUser`.
The link must be opened on a device with the app installed.

**Delete account** (`src/lib/WorkspaceScreen.tsx` → `src/lib/account.ts` →
`public.delete_own_account()`):

| Who | What happens |
| --- | --- |
| Sole owner (no other members) | The whole workspace is deleted: partners, activity, referrals, match profiles, follow-ups, cases, case contacts/events/documents/stage history, invites, entitlements, favorites. Case-document files are removed from the private bucket by the app before the RPC runs. Any directory listing the practice claimed stays public but becomes unclaimed. Then the auth user is deleted. |
| Owner with other members | Refused with a message: remove the other members first (each keeps their own workspace via the existing Remove action) or contact ReferralFit to transfer ownership. |
| Member of a shared practice | Only their sign-in is deleted. Work they created stays with the practice, no longer attributed to them. |
| Treatment-center staff (`center_members`) | Their membership row is removed; the center listing is untouched. |

The device's caches for the account are wiped before the RPC (pending offline
changes are synced first, so deletion is refused while offline), and the
local session is cleared afterwards.

## 5. Not covered

- **Ownership transfer** does not exist as a self-serve action. An owner with
  a team must remove members or ask ReferralFit.
- Storage files are only removed when the app's pre-delete step succeeds. If
  it fails the RPC still deletes the rows; orphaned files under the deleted
  user's folder in the `case-documents` bucket can be purged from the
  Supabase dashboard.
- The Center Portal (`portal/`) does not offer account deletion; center staff
  delete from the mobile app.
