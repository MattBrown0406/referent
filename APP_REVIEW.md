# App Store review runbook

How ReferralFit gets through App Review, and what to paste into App Store
Connect. Written after the 2026-09-16 rejection of 1.0.2 (2) under
Guideline 2.1 (demo account) and 2.1(b) (business model).

## 1. Demo account (Guideline 2.1)

The rejected submission listed `reviewer2apple.com` — not a valid address and
not an account that exists in Supabase. Reviewers need a real, dedicated
account whose workspace has every plan active and enough data to exercise
every screen.

1. **Supabase → Authentication → Users → Add user → Create new user.**
   - Email: `appreview@freedominterventions.com` (or change `v_email` in the
     seed script to whatever you use)
   - Password: long and random; keep it in App Store Connect only.
   - Tick **Auto Confirm User**.
2. **Supabase → SQL Editor** → paste `supabase/preflight/app_review_demo_account.sql`
   → Run. It grants `pro` + `directory` + `benchmarks` (manual, non-expiring)
   and seeds six partners, four cases, referrals, touches, and a Today list.
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

- The app is free to download. Sign-in is email/password only; there is no
  self-serve sign-up in the app (`src/lib/LoginScreen.tsx`).
- Every account belongs to a practice workspace (`orgs` / `org_members`).
  Accounts are created by ReferralFit for a practice's staff.
- Three plan tiers exist as *entitlements* on a workspace
  (`org_entitlements`: `pro`, `directory`, `benchmarks`). Nothing in the app
  sells them, links out to buy them, or shows a price. `react-native-purchases`
  is **not** installed; the RevenueCat webhook (`supabase/functions/revenuecat-webhook`)
  exists for a future IAP launch but no products are configured.
- Without a plan the app is fully usable for a solo practice: partner network,
  matching, referral ledger, case files, Today command center, notifications.
  Plans add team invitations + full business analytics (`pro`), the shared
  verified directory (`directory`), and network benchmarks (`benchmarks`).

Suggested reply — paste into the App Store Connect message thread and edit
anything that is not accurate for how you actually sell today:

> Thank you for the review. Answers to the business-model questions:
>
> **1. Who are the users of the paid features?** Licensed addiction
> interventionists and clinical staff at intervention practices. ReferralFit is
> a business tool for professionals who place clients into treatment programs;
> it is not offered to consumers or families.
>
> **2. Where can users purchase them?** They cannot be purchased in the app,
> and the app contains no links, prices, or calls to action to buy anywhere
> else. Plan tiers (Pro, Directory, Benchmarks) are licensed by ReferralFit
> directly to a practice as an organization under a business agreement, and
> ReferralFit then activates the plan for that practice's shared workspace.
> Today the only workspace with active plans is our own practice.
> *(Edit this sentence if other practices already have plans active.)*
>
> **3. What previously purchased content can be accessed?** A practice whose
> workspace has an active plan sees the corresponding features: Pro — team
> workspace invitations and full business analytics; Directory — the shared,
> verified treatment-program directory; Benchmarks — anonymized cross-practice
> benchmarking. All other functionality (partner network, placement matching,
> referral ledger, case files, the Today command center) is available to
> every account with no plan.
>
> **4. What paid content is unlocked without In-App Purchase?** Only the
> organization-level plans described above, provisioned to practices as
> enterprise/B2B services (Guideline 3.1.3(c)). No digital content or
> feature is sold to individual consumers outside of In-App Purchase, and
> nothing in the app directs users to an outside purchase. If we later offer
> self-serve subscriptions to individuals, they will be sold through In-App
> Purchase.
>
> **5. Are the enterprise services sold to single users, consumers, or for
> family use?** To organizations (intervention practices) for their staff.
> Not to consumers and not for family use.
>
> **6. How do users obtain an account? Is there a fee?** ReferralFit creates
> accounts for a practice's staff; there is no self-serve sign-up in the app
> and no fee to create an account or to use the app. The demo account
> provided in App Review Information has every plan active so the full
> feature set can be reviewed.

Risk to be aware of: Apple's enterprise exception (3.1.3(c)) covers sales to
organizations. If the reviewer decides a solo practitioner is a "single
user", they may require In-App Purchase for the plan tiers before approval.
The clean path then is the RevenueCat integration already described in
`docs/ENTITLEMENTS.md`: install `react-native-purchases`, add an IAP paywall
on the Workspace screen, and keep manual grants for comps.

## 3. Notes for the reviewer (App Review Information → Notes)

> ReferralFit is a B2B tool for addiction-intervention practices. Accounts
> are provisioned by us for a practice's staff, so there is no sign-up
> screen; please use the demo credentials above. The demo workspace has all
> plan tiers active and sample data (fictional families and programs).
> Nothing is sold inside the app and there are no links to outside purchase.
> Push notifications are local reminders (daily briefing, follow-up cadence)
> and are optional.

## 4. What changed in the app for the resubmission

- Plan copy no longer implies a purchase path: Workspace screen and Directory
  teaser now say plans are licensed to the practice and activated by
  ReferralFit; inactive plans read "Not active" instead of "Free".
- Login placeholder is generic (`you@yourpractice.com`) instead of the
  founder's real address; footnote explains accounts are set up per practice.
- iOS build number bumped to 3.
- CI replays the demo seed (twice, for idempotency) against a clean local
  Supabase so the script cannot drift from the schema.
