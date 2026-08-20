# Entitlements & RevenueCat integration

Billing runs through RevenueCat (App Store / Play in-app purchases). The
backend never talks to the stores directly: RevenueCat sends webhook events to
the `revenuecat-webhook` edge function, which mirrors subscription state into
`public.org_entitlements`. Every feature gate reads that table — clients via
`src/lib/entitlements.ts`, and database policies via
`public.org_has_entitlement(text)`.

## Entitlement identifiers

Configure these exact identifiers in the RevenueCat dashboard:

| Identifier   | Gates                                              |
| ------------ | -------------------------------------------------- |
| `pro`        | Team workspace features, full business analytics   |
| `benchmarks` | Cross-practice benchmarking analytics (Phase 5)    |
| `directory`  | Shared, verified placement directory (Phase 3)     |

## App-side setup (RevenueCat SDK)

1. Install `react-native-purchases` and configure with the public API key.
2. **After Supabase sign-in, call `Purchases.logIn(session.user.id)`** — the
   webhook maps `app_user_id` to the user's workspace through `org_members`,
   so the RevenueCat app user id must be the Supabase auth user UUID.
3. Call `Purchases.logOut()` on sign-out.
4. After a purchase or restore completes, re-run `fetchEntitlements()` (or
   bump the workspace epoch) so the UI reflects the new state without waiting
   for the next app launch.

The entitlement state shown in the app updates when the webhook lands, so a
few seconds of propagation delay after purchase is normal; RevenueCat's SDK
customer-info can be used for instant optimistic UI if desired.

## Webhook setup

1. Deploy the function: `supabase functions deploy revenuecat-webhook --no-verify-jwt`
2. Set the secrets:
   ```
   supabase secrets set \
     REVENUECAT_WEBHOOK_AUTH="<long random string>" \
     REVENUECAT_ALLOWED_APP_IDS="<RevenueCat production app id>" \
     REVENUECAT_ALLOWED_STORES="APP_STORE,PLAY_STORE" \
     REVENUECAT_PRODUCT_MAP_JSON='{"<store product id>":"pro"}'
   ```
   (`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are provided automatically.)
3. In RevenueCat → Project → Integrations → Webhooks, add
   `https://<project-ref>.functions.supabase.co/revenuecat-webhook` and set the
   Authorization header value to the same string.

Production events are accepted by default. Sandbox events are recorded but do
not grant access. For an isolated non-production project only, set
`REVENUECAT_ALLOW_SANDBOX=true`; never enable that override on production.
Events must also match the configured RevenueCat app ID, store, product ID, and
entitlement mapping. Missing configuration fails closed.

Deliveries are idempotent: the RevenueCat event id is recorded in
`integration_webhook_events`, duplicates are acknowledged without reprocessing,
and lifecycle updates are ordered by RevenueCat's event timestamp plus event ID.
Paid grants are stored per purchaser/product and unioned with manual grants, so
one purchaser cannot overwrite another purchaser or a founder comp.

### Event handling

- `INITIAL_PURCHASE`, `RENEWAL`, `UNCANCELLATION`, `NON_RENEWING_PURCHASE`,
  `PRODUCT_CHANGE`, `SUBSCRIPTION_EXTENDED` → entitlement active, expiry from
  `expiration_at_ms`.
- `EXPIRATION` → entitlement inactive.
- `CANCELLATION`, `BILLING_ISSUE`, `SUBSCRIPTION_PAUSED` → no change
  (access continues until `EXPIRATION` arrives).

## Manual grants (comps, beta access, founder account)

Insert rows with `source = 'manual'` and no expiry. Webhook processing preserves
manual rows even if a later RevenueCat event names the same entitlement. For the
founder account:

```sql
INSERT INTO public.org_entitlements (org_id, entitlement, active, source)
SELECT m.org_id, e.entitlement, true, 'manual'
  FROM public.org_members m
 CROSS JOIN (VALUES ('pro'), ('directory'), ('benchmarks')) AS e(entitlement)
 WHERE m.user_id = '<founder auth user uuid>'
ON CONFLICT (org_id, entitlement)
DO UPDATE SET active = true, source = 'manual', expires_at = NULL;
```
