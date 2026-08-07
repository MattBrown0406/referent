# Business operations and automation

ReferralFit uses a three-system boundary:

| System | Authoritative responsibility |
| --- | --- |
| PandaDoc | Contract content, recipients, signatures, and completed PDF |
| Square | Customer, invoice, payment, refund, and processing-fee records |
| ReferralFit | Case workflow, attribution, next actions, and aggregate business reporting |

ReferralFit never collects card data and does not reproduce PandaDoc's signing
workflow. `case_integrations` is a status and reporting mirror linked to a case.

## What this release adds

- Lead source, source detail, and lost reason on every case
- Automatic case-stage history maintained by a database trigger
- A 30/90/365-day and all-time Business dashboard
- Case funnel, source conversion, quoted/collected/outstanding revenue, referral outcomes, and time-to-engagement
- Complete searchable inbound/outbound referral history
- Per-case links to existing PandaDoc documents and Square customers, invoices, or payments
- HMAC-verified, idempotent Square and PandaDoc webhook handlers
- Service-only webhook receipt records with minimized payloads

## Deployment order

The app expects the schema migration before the new client is released.

1. Apply `20260806210000_business_operations.sql` to a staging project.
2. Run the database test suite and schema lint.
3. Deploy the two Edge Functions:

   ```sh
   supabase functions deploy square-webhook --no-verify-jwt
   supabase functions deploy pandadoc-webhook --no-verify-jwt
   ```

4. Store secrets in Supabase. Never put these values in the Expo app or Git:

   ```sh
   supabase secrets set \
     SQUARE_WEBHOOK_SIGNATURE_KEY='…' \
     SQUARE_WEBHOOK_NOTIFICATION_URL='https://PROJECT.supabase.co/functions/v1/square-webhook' \
     PANDADOC_WEBHOOK_SHARED_KEY='…' \
     REFERENT_OWNER_ID='SUPABASE_AUTH_USER_UUID'
   ```

5. In Square Developer Console, register the exact value used for
   `SQUARE_WEBHOOK_NOTIFICATION_URL`. Subscribe to invoice, payment, and refund
   state changes needed by the business. Square signs the notification URL plus
   the unmodified request body, so redirects or a mismatched URL break validation.
6. In PandaDoc Developer Dashboard, register:

   `https://PROJECT.supabase.co/functions/v1/pandadoc-webhook`

   Subscribe to `document_state_changed`, `recipient_completed`, and
   `document_completed_pdf_ready`. Copy that subscription's shared key into the
   Supabase secret above.
7. Link one existing Square invoice and PandaDoc document from a staging case,
   send provider test events, and verify status and `last_synced_at` change.
8. Apply the production migration, deploy the functions, repeat the test-event
   check, and then ship the Expo client.

Provider references:

- [Square webhook signature validation](https://developer.squareup.com/docs/webhooks/step3validate)
- [Square invoice webhooks](https://developer.squareup.com/reference/square/invoices-api/webhooks)
- [PandaDoc webhook verification](https://developers.pandadoc.com/docs/webhook-verification)
- [PandaDoc webhook events](https://developers.pandadoc.com/docs/webhook-events)

## Linking existing records

Open a case and choose **Contracts & payments → Link**. Copy the external record
ID and URL from Square or PandaDoc. Linking does not modify or resend the
external record. Once linked, matching provider webhook events update the
status mirror automatically.

For PandaDoc documents created through a future API action, include this
metadata when creating the document:

```json
{
  "referent_case_id": "CASE_UUID",
  "referent_owner_id": "OWNER_UUID"
}
```

The PandaDoc webhook can securely create the link from that metadata after it
confirms the case belongs to the stated owner. Square records should remain
explicitly linked until a deterministic case reference is configured in the
Square order/invoice creation workflow.

Both handlers are also pinned to `REFERENT_OWNER_ID`. That matches the app's
current single-owner security model and prevents a guessed external ID from
causing a cross-owner update. Before multi-user use, replace that setting with
an owner-to-provider-account binding established through provider OAuth.

## Automation design for secure intake (#3)

The intake workflow should be implemented as a separate, narrowly scoped web
surface—not by making the authenticated Expo app or case tables public.

### Intended flow

1. A prospect or referral partner opens a mobile-friendly HTTPS intake page.
2. The page creates a short-lived intake session after rate limiting and bot
   protection. The token grants access only to that one unfinished submission.
3. The form collects the minimum required contact, consent, urgency, payer,
   location, level-of-care, scheduling, and lead-source data. It clearly labels
   which fields may contain sensitive information.
4. Documents upload directly to a private owner/intake-prefixed storage path
   using a short-lived signed upload authorization. Files never pass through a
   public bucket.
5. A server-side Edge Function validates field lengths, file types, consent,
   token expiry, and duplicate submissions. It resolves the destination owner;
   the browser never supplies a trusted `owner_id`.
6. One database transaction creates the case, primary contact, document rows,
   attribution, consent audit record, and today's first-call action. A salted
   lookup hash of normalized phone/email can flag possible duplicate cases
   without putting those values in analytics or logs.
7. ReferralFit's Today list immediately shows the first call. A push
   notification can announce a new intake without including PHI in the push
   payload.
8. A confirmation message is sent only through a communication provider and
   configuration covered by the organization's compliance requirements. The
   message contains a neutral confirmation and no sensitive case summary.
9. After qualification, the existing workflow continues: match, PandaDoc
   contract, Square collection, follow-up, and outcome capture.

### Required tables/functions

- `intake_sessions`: hashed token, owner, expiry, attempt/rate metadata, status
- `intake_consents`: versioned disclosure, accepted timestamp, request evidence
- `intake_submissions`: encrypted/minimized staging data with a short retention period
- `finalize_intake`: authenticated service-only transaction that creates the
  case bundle and invalidates the one-time token
- A storage policy allowing only the short-lived intake function to move files
  from staging into the existing private case-document layout

### Gates before enabling it publicly

- Formal HIPAA/security review and signed BAAs where applicable
- Documented minimum-necessary data fields and retention/deletion rules
- Consent language approved for the actual services offered
- Abuse controls: rate limits, CAPTCHA/bot defense, upload scanning, and size/type limits
- No PHI in URLs, analytics, application logs, email subject lines, or push payloads
- Integration and RLS tests proving one intake can never access another intake or owner
- Incident response, access audit, and backup/restore procedures

Until those gates are complete, the intake design remains deliberately disabled.
