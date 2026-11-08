# ReferralFit for Programs (center portal)

The treatment-center side of the platform: a small web app where a program
claims its listing in the shared ReferralFit directory and keeps it accurate
(levels of care, insurance panels, admissions contacts, cost). Verification
status and directory placement stay with ReferralFit — claiming a listing
never buys ranking (see the anti-patient-brokering stance in the main README).

## Flow

1. A program gets access one of two ways (migration 20261108150000):
   - **It asks.** It creates an account here, searches for its listing under
     "Find your program" and sends a request. ReferralFit is emailed and
     approves or declines in the app (Workspace > Program claim requests);
     the program is emailed either way.
   - **ReferralFit invites it.** A platform admin taps "Issue claim code" on the
     listing's Directory card in the app and sends the invite. Its link,
     `https://portal.referralfit.com/claim#<code>`, opens this portal with the
     code filled in; the program creates an account and taps Claim listing
     (`claim_center_listing`).
2. Either way the account is bound to the listing (`center_members`).
3. The center edits its listing; edits go live immediately. Status and
   `verified_at` are admin-only (enforced by a database trigger).
4. The portal shows how many practices have added the listing to their
   network (`center_listing_import_count`, an aggregate-only read).

## Develop

```
cd portal
npm install
npm run dev
```

## Deploy

Static SPA — `npm run build` produces `dist/`. Deploy to Vercel/Netlify with
root directory `portal`, build command `npm run build`, output `dist`.
It talks to the same Supabase project as the mobile app; RLS enforces all
access rules, so no server component is needed.
