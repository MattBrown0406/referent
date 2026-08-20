# ReferralFit for Programs (center portal)

The treatment-center side of the platform: a small web app where a program
claims its listing in the shared ReferralFit directory and keeps it accurate
(levels of care, insurance panels, admissions contacts, cost). Verification
status and directory placement stay with ReferralFit — claiming a listing
never buys ranking (see the anti-patient-brokering stance in the main README).

## Flow

1. A platform admin creates the listing in `global_partners` and issues a
   claim code: `SELECT * FROM public.create_center_claim_code('<listing id>');`
2. The center creates an account here and redeems the code
   (`claim_center_listing`), binding the account to the listing.
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
