import { createClient } from 'npm:@supabase/supabase-js@2.110.8';

import {
  bytesToBase64,
  hmacSha256,
  isUuid,
  jsonResponse,
  requiredEnv,
  timingSafeEqual,
} from '../_shared/webhooks.ts';

type Json = Record<string, unknown>;

function objectValue(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}

function moneyAmount(value: unknown): number | null {
  const amount = objectValue(value).amount;
  return typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
}

function invoiceAmount(invoice: Json): number | null {
  const requests = Array.isArray(invoice.payment_requests) ? invoice.payment_requests : [];
  const amounts = requests.map((request) => {
    const item = objectValue(request);
    return moneyAmount(item.computed_amount_money) ?? moneyAmount(item.total_completed_amount_money);
  }).filter((amount): amount is number => amount != null);
  return amounts.length ? amounts.reduce((sum, amount) => sum + amount, 0) : null;
}

function invoicePaidAmount(invoice: Json): number | null {
  const requests = Array.isArray(invoice.payment_requests) ? invoice.payment_requests : [];
  const amounts = requests.map((request) => moneyAmount(objectValue(request).total_completed_amount_money));
  if (!amounts.some((amount) => amount != null)) return null;
  return amounts.reduce<number>((sum, amount) => sum + (amount || 0), 0);
}

function invoiceCurrency(invoice: Json): string | null {
  const currencies = new Set<string>();
  for (const request of Array.isArray(invoice.payment_requests) ? invoice.payment_requests : []) {
    const item = objectValue(request);
    for (const money of [objectValue(item.computed_amount_money), objectValue(item.total_completed_amount_money)]) {
      if (typeof money.currency === 'string') currencies.add(money.currency.toUpperCase());
    }
  }
  return currencies.size === 1 ? [...currencies][0] : null;
}

function dueDate(invoice: Json): string | null {
  const dates = (Array.isArray(invoice.payment_requests) ? invoice.payment_requests : [])
    .map((request) => objectValue(request).due_date)
    .filter((value): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))
    .sort();
  return dates[0] || null;
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  let rawBody = '';
  try {
    rawBody = await request.text();
    const signatureKey = requiredEnv('SQUARE_WEBHOOK_SIGNATURE_KEY');
    const notificationUrl = requiredEnv('SQUARE_WEBHOOK_NOTIFICATION_URL');
    const receivedSignature = request.headers.get('x-square-hmacsha256-signature') || '';
    const expectedSignature = bytesToBase64(await hmacSha256(signatureKey, `${notificationUrl}${rawBody}`));
    if (!receivedSignature || !timingSafeEqual(expectedSignature, receivedSignature)) {
      return jsonResponse({ error: 'Invalid signature' }, 403);
    }

    const payload = JSON.parse(rawBody) as Json;
    const eventId = typeof payload.event_id === 'string' ? payload.event_id : '';
    const eventType = typeof payload.type === 'string' ? payload.type : '';
    if (!eventId || !eventType) return jsonResponse({ error: 'Missing event identity' }, 400);

    const supabase = createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const referentOwnerId = requiredEnv('REFERENT_OWNER_ID');
    if (!isUuid(referentOwnerId)) throw new Error('REFERENT_OWNER_ID must be a UUID');
    const data = objectValue(payload.data);
    const envelope = objectValue(data.object);
    const candidateType = ['invoice', 'payment', 'refund', 'customer'].find((key) => key in envelope) || '';
    const candidate = objectValue(envelope[candidateType]);
    const externalId = typeof candidate.id === 'string'
      ? candidate.id
      : typeof data.id === 'string' ? data.id : '';
    const status = typeof candidate.status === 'string' ? candidate.status.toLowerCase() : eventType;
    const amountCents = candidateType === 'invoice'
      ? invoiceAmount(candidate)
      : moneyAmount(candidate.amount_money);
    const paidAmountCents = candidateType === 'invoice' ? invoicePaidAmount(candidate) : null;
    const currencyObject = objectValue(candidate.amount_money);
    const currency = candidateType === 'invoice'
      ? invoiceCurrency(candidate)
      : typeof currencyObject.currency === 'string' ? currencyObject.currency.toUpperCase() : null;
    const updatedAt = typeof candidate.updated_at === 'string' ? candidate.updated_at : new Date().toISOString();
    const completedAt = ['paid', 'completed', 'refunded'].includes(status) ? updatedAt : null;

    const { error: receiptError } = await supabase.from('integration_webhook_events').insert({
      provider: 'square',
      external_event_id: eventId,
      event_type: eventType,
      payload: {
        merchant_id: payload.merchant_id,
        object_type: candidateType,
        external_id: externalId,
        status,
      },
    });
    if (receiptError?.code === '23505') {
      const { data: existingReceipt, error: lookupError } = await supabase
        .from('integration_webhook_events')
        .select('processed_at')
        .eq('provider', 'square')
        .eq('external_event_id', eventId)
        .single();
      if (lookupError) throw lookupError;
      if (existingReceipt?.processed_at) return jsonResponse({ ok: true, duplicate: true });
      // A previous delivery failed after recording its id. Retrying the
      // idempotent status update lets that event recover instead of staying
      // permanently unprocessed.
    } else if (receiptError) {
      throw receiptError;
    }

    if (externalId && candidateType) {
      const patch: Json = {
        status,
        last_synced_at: new Date().toISOString(),
        metadata: {
          square_order_id: candidate.order_id || null,
          square_customer_id: candidate.customer_id || objectValue(candidate.primary_recipient).customer_id || null,
        },
      };
      if (currency) patch.currency = currency;
      if (completedAt) patch.completed_at = completedAt;
      if (amountCents != null) patch.amount_cents = amountCents;
      if (candidateType === 'invoice') {
        patch.due_on = dueDate(candidate);
        patch.paid_amount_cents = paidAmountCents;
      }
      const { error: updateError } = await supabase
        .from('case_integrations')
        .update(patch)
        .eq('owner_id', referentOwnerId)
        .eq('provider', 'square')
        .eq('record_type', candidateType)
        .eq('external_id', externalId);
      if (updateError) throw updateError;
    }

    const { error: processedError } = await supabase.from('integration_webhook_events').update({
      processed_at: new Date().toISOString(),
      processing_error: '',
    }).eq('provider', 'square').eq('external_event_id', eventId);
    if (processedError) throw processedError;
    return jsonResponse({ ok: true });
  } catch (error) {
    console.error('Square webhook processing failed', error);
    return jsonResponse({ error: 'Webhook processing failed' }, 500);
  }
});
