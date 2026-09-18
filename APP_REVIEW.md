# App Store review runbook

How ReferralFit gets through App Review, and what to paste into App Store
Connect. Written after the 2026-09-16 rejection of 1.0.2 (2) under
Guideline 2.1 (demo account) and 2.1(b) (business model).

## 1. Demo account (Guideline 2.1)

The rejected submission listed `reviewer2apple.com` — not a valid address and
not an account that exists in Supabase. Reviewers need a real, dedicated
account with enough sample data to exercise
every screen.

1. **Supabase → Authentication → Users → Add user → Create new user.**
   - Email: `appreview@freedominterventions.com` (or change `v_email` in the
     seed script to whatever you use)
   - Password: long and random; keep it in App Store Connect only.
   - Tick **Auto Confirm User**.
2. **Supabase → SQL Editor** → paste `supabase/preflight/app_review_demo_account.sql`
   → Run. It seeds six partners, four cases, referrals, touches, and a Today list.
   Re-run it any time to reset the reviewer workspace; it refuses to touch a
   workspace that has any other member.
3. **Sign in once yourself** on a device with those credentials and tap
   through Today, Partners, Matching, Cases, Business, Directory, Workspace.
4. **App Store Connect → App Information → App Review Information.**
   - Sign-in required: **on**
   - User name / Password: exactly what you created (copy-paste, watch the `@`)
   - Notes: see §3.

Never commit the password. The seed script does not contain it.

## 2. Business-model reply (Guideline 2.1(b))

Facts the answer rests on (all verifiable in this repo):

- The app is free. `public.free_launch_period()` returns `true`
  (`supabase/migrations/20260918230000_free_launch_period.sql`), so every
  workspace has every feature. No plan tiers are shown, sold, or gated.
- Sign-in is email/password only; there is no self-serve sign-up in the app
  (`src/lib/LoginScreen.tsx`). Accounts are created by ReferralFit for a
  practice's staff at no charge.
- `react-native-purchases` is **not** installed. No RevenueCat products,
  prices, paywalls, or external purchase links exist anywhere in the app.
- Square and PandaDoc references are optional record links a practice can
  attach to its *own* client cases (their own invoices and agreements). They
  are not a way to pay ReferralFit.

Suggested reply — paste into the App Store Connect message thread:

> Thank you for the review. Answers to the business-model questions:
>
> **1. Who are the users of the paid content/features?** There are none.
> ReferralFit is free. Every feature in the app is available to every
> account, and there are no paid tiers, subscriptions, or purchasable
> content.
>
> **2. Where can users purchase them?** Nowhere — nothing is sold in the
> app or outside it. The app contains no prices, paywalls, or links to any
> purchase.
>
> **3. What previously purchased content can be accessed?** None. No
> content or feature has ever been sold for this app.
>
> **4. What paid content is unlocked without In-App Purchase?** None. All
> functionality is free for every account.
>
> **5. Are the enterprise services sold to single users, consumers, or for
> family use?** No enterprise services are sold. ReferralFit is a free
> business tool for licensed addiction-intervention practices; it is not
> offered to consumers or families.
>
> **6. How do users obtain an account? Is there a fee?** ReferralFit creates
> accounts for a practice's staff on request, at no charge. There is no fee
> to create an account or to use the app. The demo account provided in App
> Review Information has full access to every feature.

If a reviewer asks about the "Square" and "PandaDoc" labels on a case: those
are optional links to a practice's *own* client invoices and agreements in
tools the practice already uses. They are not a way to pay ReferralFit, and
the app never collects payment details.

## 3. Notes for the reviewer (App Review Information → Notes)

> ReferralFit is a free B2B tool for addiction-intervention practices.
> Accounts are provisioned by us for a practice's staff at no charge, so
> there is no sign-up screen; please use the demo credentials above. The demo
> workspace contains sample data (fictional families and programs) and has
> access to every feature. Nothing is sold inside the app, there are no
> subscriptions or in-app purchases, and there are no links to outside
> purchase. Push notifications are local reminders (daily briefing,
> follow-up cadence) and are optional.

## 4. What changed in the app for the resubmission

- The app is free: a database switch (`free_launch_period()`) opens every
  feature for every workspace. No plan tiers, prices, "Not active" badges, or
  upgrade prompts remain anywhere in the app.
- First launch shows a welcome sheet stating that the workspace is private to
  the practice, what (little) is shared, and that the app is free. The same
  statement lives permanently on the Workspace screen.
- Login placeholder is generic (`you@yourpractice.com`) instead of the
  founder's real address; footnote explains accounts are set up per practice
  at no charge and data is private.
- Square/PandaDoc case links are labelled optional and no longer promise
  automatic status updates (those are wired to one practice today).
- iOS build number bumped to 3.
- CI replays the demo seed (twice, for idempotency) against a clean local
  Supabase so the script cannot drift from the schema.
