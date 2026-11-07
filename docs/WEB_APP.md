# The web app (app.referralfit.com)

The same Expo app, exported for the web (`npx expo export --platform web`)
and served by Vercel. It signs in to the same Supabase project as the iPhone
app, so a practice sees the same workspace in both. Nothing here changes the
iPhone build.

## What is different in a browser

| On the phone | In a browser |
| --- | --- |
| Native alerts | An in-page dialog (`src/lib/web-alert.tsx`); Escape is Cancel, Enter the main button (none in a list of three or more choices; a button reached with Tab presses itself) |
| Bottom tabs | A sidebar from 960px wide (`src/lib/web-layout.ts`); sheets are a centered column |
| Pull to refresh | A Refresh button in the header |
| Messages compose sheet | The text is copied, with the number to send it to from the phone |
| Call / Text buttons | Show the number; logged only after "I called" / "I texted" |
| Share sheet | The browser's share sheet, or a copy to the clipboard (`src/lib/web-share.ts`) |
| Push and reminders | None; Home shows what is due. Settings says to turn push on in the iPhone app |
| AI drafts | iPhone only (the key lives in the phone's keychain) |
| Offline copy kept after sign-out | Signing out removes the practice's data from the browser |
| Email links open the app | Email links return to the page they started on (`/auth/confirmed`, `/auth/recovery`) |

## One-time setup (Matt runs these)

1. **Supabase → Authentication → URL Configuration → Redirect URLs**, add:
   - `https://app.referralfit.com/auth/recovery`
   - `https://app.referralfit.com/auth/confirmed`
2. **Vercel → Add New → Project**, import the `referent` GitHub repo:
   - Root Directory: the repo root (leave blank). `vercel.json` sets the
     install, build and output (`dist`), the single-page rewrite and the
     security headers. Framework preset: Other.
   - Production branch: `main`.
   - No environment variables: the publishable Supabase key is in the
     source, and release builds ignore the local-stack overrides.
3. **Vercel → the project → Settings → Domains**, add `app.referralfit.com`.
   Vercel shows a DNS record (a CNAME); add it at the referralfit.com
   registrar, next to the Resend records.

## Checking a deploy

- Open `https://app.referralfit.com`, sign in, and open a case.
- Settings → Sign out, then check the browser keeps no practice data:
  DevTools → Application → Local Storage has no `referralfit-cache-`,
  `-write-queue-`, `-rejected-writes-`, `-case-list-`, `-case-file-` or
  `-workspace-` key. What stays holds ids and flags only, no client data:
  the welcome flag, partner snoozes, placement "seen" markers, the
  notification prompt choice, and `referralfit.authFlowStarts.v1` /
  `referralfit.authFlowEmails.v1` (the last day's sign-up and reset
  requests, so their emailed links work here).
- The same holds when the session ends any other way: signed out on the
  phone (sign-out is per device), a changed password, an account deleted.
  The next time the app sees no session it removes the data, and says so if
  changes made in the browser had not been sent.
- An emailed link works only for the address this browser asked for.
- "Forgot password?" from the web app: the email's link opens
  `app.referralfit.com/auth/recovery` and shows **Set a new password**, and
  the address bar is back to `/`.

## Local development

`.claude/launch.json` → `referralfit-webapp-dev` runs `npx expo start --web`
on port 3222 against the local Supabase stack (`EXPO_PUBLIC_SUPABASE_URL` and
`EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, read from `supabase status`; ignored
by release builds). `supabase/config.toml` allows that server's two auth
redirect URLs; emails land in Mailpit (`supabase status` → MAILPIT_URL).
