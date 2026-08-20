import { createClient } from 'npm:@supabase/supabase-js@2.110.8';

import { isUuid, jsonResponse, requiredEnv, timingSafeEqual } from '../_shared/webhooks.ts';

// RevenueCat → org_entitlements mirror.
//
// Setup expectations (documented in docs/entitlements.md):
// - The app calls Purchases.logIn(<supabase auth user id>) so RevenueCat's
//   app_user_id is the Supabase user UUID; this function maps it to the
//   user's org via org_members.
// - RevenueCat entitlement identifiers are exactly: pro, directory, benchmarks.
// - The webhook's Authorization header value is configured in both RevenueCat
//   and the REVENUECAT_WEBHOOK_AUTH function secret.

type Json = Record<string, unknown>;

function objectValue(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}

const KNOWN_ENTITLEMENTS = ['pro', 'directory', 'benchmarks'] as const;

// Event types that assert the subscription is (still) paid-up. CANCELLATION
// only turns off auto-renew — access continues until EXPIRATION arrives.
const ACTIVATING_TYPES = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'UNCANCELLATION',
  'NON_RENEWING_PURCHASE',
  'PRODUCT_CHANGE',
  'SUBSCRIPTION_EXTENDED',
]);
const DEACTIVATING_TYPES = new Set(['EXPIRATION']);
const PASSIVE_TYPES = new Set(['CANCELLATION', 'BILLING_ISSUE', 'SUBSCRIPTION_PAUSED', 'TEST']);

Deno.serve(async (request) => {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  try {
    const expectedAuth = requiredEnv('REVENUECAT_WEBHOOK_AUTH');
    const receivedAuth = request.headers.get('authorization') || '';
    if (!receivedAuth || !timingSafeEqual(expectedAuth, receivedAuth)) {
      return jsonResponse({ error: 'Invalid authorization' }, 403);
    }

    const payload = JSON.parse(await request.text()) as Json;
    const event = objectValue(payload.event);
    const eventId = typeof event.id === 'string' ? event.id : '';
    const eventType = typeof event.type === 'string' ? event.type : '';
    if (!eventId || !eventType) return jsonResponse({ error: 'Missing event identity' }, 400);

    const supabase = createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const appUserId = [event.app_user_id, event.original_app_user_id]
      .find((value): value is string => isUuid(value)) || '';
    const entitlements = (Array.isArray(event.entitlement_ids) ? event.entitlement_ids : [])
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.toLowerCase())
      .filter((value): value is typeof KNOWN_ENTITLEMENTS[number] =>
        (KNOWN_ENTITLEMENTS as readonly string[]).includes(value));
    const expirationMs = typeof event.expiration_at_ms === 'number' ? event.expiration_at_ms : null;

    const { error: receiptError } = await supabase.from('integration_webhook_events').insert({
      provider: 'revenuecat',
      external_event_id: eventId,
      event_type: eventType,
      payload: {
        app_user_id: appUserId,
        entitlement_ids: entitlements,
        expiration_at_ms: expirationMs,
        environment: event.environment ?? null,
      },
    });
    if (receiptError?.code === '23505') {
      const { data: existingReceipt, error: lookupError } = await supabase
        .from('integration_webhook_events')
        .select('processed_at')
        .eq('provider', 'revenuecat')
        .eq('external_event_id', eventId)
        .single();
      if (lookupError) throw lookupError;
      if (existingReceipt?.processed_at) return jsonResponse({ ok: true, duplicate: true });
      // Recorded but unprocessed delivery: fall through and retry the
      // idempotent entitlement upsert.
    } else if (receiptError) {
      throw receiptError;
    }

    const markProcessed = (processingError = '') =>
      supabase.from('integration_webhook_events').update({
        processed_at: new Date().toISOString(),
        processing_error: processingError,
      }).eq('provider', 'revenuecat').eq('external_event_id', eventId);

    if (PASSIVE_TYPES.has(eventType) || (!ACTIVATING_TYPES.has(eventType) && !DEACTIVATING_TYPES.has(eventType))) {
      await markProcessed();
      return jsonResponse({ ok: true, ignored: eventType });
    }
    if (!appUserId) {
      // Anonymous RevenueCat id — nothing to map. Acknowledge so RevenueCat
      // stops retrying, but record why nothing changed.
      await markProcessed('app_user_id is not a Supabase user UUID');
      return jsonResponse({ ok: true, unmapped: true });
    }
    if (!entitlements.length) {
      await markProcessed('no known entitlement ids on event');
      return jsonResponse({ ok: true, unmapped: true });
    }

    const { data: membership, error: memberError } = await supabase
      .from('org_members')
      .select('org_id')
      .eq('user_id', appUserId)
      .maybeSingle();
    if (memberError) throw memberError;
    if (!membership?.org_id) {
      await markProcessed('no workspace membership for app_user_id');
      return jsonResponse({ ok: true, unmapped: true });
    }

    const active = ACTIVATING_TYPES.has(eventType);
    const rows = entitlements.map((entitlement) => ({
      org_id: membership.org_id,
      entitlement,
      active,
      source: 'revenuecat',
      rc_app_user_id: appUserId,
      expires_at: expirationMs ? new Date(expirationMs).toISOString() : null,
    }));
    const { error: upsertError } = await supabase
      .from('org_entitlements')
      .upsert(rows, { onConflict: 'org_id,entitlement' });
    if (upsertError) throw upsertError;

    await markProcessed();
    return jsonResponse({ ok: true });
  } catch (error) {
    console.error('RevenueCat webhook processing failed', error);
    return jsonResponse({ error: 'Webhook processing failed' }, 500);
  }
});
