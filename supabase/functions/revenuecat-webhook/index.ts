import { createClient } from 'npm:@supabase/supabase-js@2.110.8';

import { isUuid, jsonResponse, requiredEnv, timingSafeEqual } from '../_shared/webhooks.ts';

type Json = Record<string, unknown>;

function objectValue(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}

const KNOWN_ENTITLEMENTS = ['pro', 'directory', 'benchmarks'] as const;
type KnownEntitlement = typeof KNOWN_ENTITLEMENTS[number];

const ACTIVATING_TYPES = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'UNCANCELLATION',
  'NON_RENEWING_PURCHASE',
  'PRODUCT_CHANGE',
  'SUBSCRIPTION_EXTENDED',
]);
const DEACTIVATING_TYPES = new Set(['EXPIRATION', 'REFUND', 'REVOKAL']);
const PASSIVE_TYPES = new Set(['CANCELLATION', 'BILLING_ISSUE', 'SUBSCRIPTION_PAUSED', 'TEST']);

function commaSet(value: string): Set<string> {
  return new Set(value.split(',').map((item) => item.trim().toUpperCase()).filter(Boolean));
}

function productMap(): Record<string, KnownEntitlement> {
  const parsed = JSON.parse(requiredEnv('REVENUECAT_PRODUCT_MAP_JSON')) as Record<string, unknown>;
  const result: Record<string, KnownEntitlement> = {};
  for (const [productId, entitlement] of Object.entries(parsed)) {
    if (!productId.trim() || typeof entitlement !== 'string'
        || !(KNOWN_ENTITLEMENTS as readonly string[]).includes(entitlement)) {
      throw new Error('REVENUECAT_PRODUCT_MAP_JSON contains an invalid product mapping');
    }
    result[productId] = entitlement as KnownEntitlement;
  }
  return result;
}

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
    const eventType = typeof event.type === 'string' ? event.type.toUpperCase() : '';
    if (!eventId || !eventType) return jsonResponse({ error: 'Missing event identity' }, 400);

    const supabase = createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const appUserId = [event.app_user_id, event.original_app_user_id]
      .find((value): value is string => isUuid(value)) || '';
    const environment = typeof event.environment === 'string' ? event.environment.toUpperCase() : '';
    const appId = typeof event.app_id === 'string' ? event.app_id : '';
    const productId = typeof event.product_id === 'string' ? event.product_id : '';
    const store = typeof event.store === 'string' ? event.store.toUpperCase() : '';
    const expirationMs = typeof event.expiration_at_ms === 'number' && Number.isFinite(event.expiration_at_ms)
      ? event.expiration_at_ms : null;
    const eventAtMs = typeof event.event_timestamp_ms === 'number' && Number.isFinite(event.event_timestamp_ms)
      ? event.event_timestamp_ms : null;
    const declaredEntitlements = (Array.isArray(event.entitlement_ids) ? event.entitlement_ids : [])
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.toLowerCase());

    const { error: receiptError } = await supabase.from('integration_webhook_events').insert({
      provider: 'revenuecat',
      external_event_id: eventId,
      event_type: eventType,
      payload: {
        app_user_id: appUserId,
        app_id: appId,
        product_id: productId,
        store,
        entitlement_ids: declaredEntitlements,
        expiration_at_ms: expirationMs,
        event_timestamp_ms: eventAtMs,
        environment: environment || null,
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
    } else if (receiptError) {
      throw receiptError;
    }

    const markProcessed = async (processingError = '') => {
      const { error } = await supabase.from('integration_webhook_events').update({
        processed_at: new Date().toISOString(),
        processing_error: processingError,
      }).eq('provider', 'revenuecat').eq('external_event_id', eventId);
      if (error) throw error;
    };

    const allowSandbox = Deno.env.get('REVENUECAT_ALLOW_SANDBOX') === 'true';
    if (environment !== 'PRODUCTION' && !(allowSandbox && environment === 'SANDBOX')) {
      await markProcessed(`ignored RevenueCat environment: ${environment || 'missing'}`);
      return jsonResponse({ ok: true, ignored_environment: environment || 'missing' });
    }

    const allowedApps = commaSet(requiredEnv('REVENUECAT_ALLOWED_APP_IDS'));
    const allowedStores = commaSet(Deno.env.get('REVENUECAT_ALLOWED_STORES') || 'APP_STORE,PLAY_STORE');
    const products = productMap();
    const mappedEntitlement = products[productId];
    const appAllowed = allowedApps.has(appId.toUpperCase());
    const storeAllowed = allowedStores.has(store);
    const productAllowed = Boolean(mappedEntitlement);
    const entitlementAllowed = Boolean(mappedEntitlement && declaredEntitlements.includes(mappedEntitlement));
    if (!appAllowed || !storeAllowed || !productAllowed || !entitlementAllowed) {
      const mismatch = [
        !appAllowed && 'app',
        !storeAllowed && 'store',
        !productAllowed && 'product',
        !entitlementAllowed && 'entitlement',
      ].filter(Boolean).join(',');
      await markProcessed(`event configuration mismatch: ${mismatch}`);
      return jsonResponse({ ok: true, unmapped: true, mismatch });
    }
    if (!appUserId || !eventAtMs) {
      await markProcessed(!appUserId ? 'app_user_id is not a Supabase user UUID' : 'event timestamp is missing');
      return jsonResponse({ ok: true, unmapped: true });
    }
    if (eventType === 'TRANSFER') {
      throw new Error('RevenueCat TRANSFER requires authoritative subscriber reconciliation before processing');
    }
    if (PASSIVE_TYPES.has(eventType) || (!ACTIVATING_TYPES.has(eventType) && !DEACTIVATING_TYPES.has(eventType))) {
      await markProcessed();
      return jsonResponse({ ok: true, ignored: eventType });
    }

    const { data: applied, error: applyError } = await supabase.rpc('apply_revenuecat_grant_event', {
      p_app_user_id: appUserId,
      p_entitlement: mappedEntitlement,
      p_product_id: productId,
      p_store: store,
      p_environment: environment,
      p_active: ACTIVATING_TYPES.has(eventType),
      p_expires_at: expirationMs ? new Date(expirationMs).toISOString() : null,
      p_event_at: new Date(eventAtMs).toISOString(),
      p_event_id: eventId,
    });
    if (applyError) throw applyError;

    await markProcessed();
    return jsonResponse({ ok: true, applied: applied === true });
  } catch (error) {
    console.error('RevenueCat webhook processing failed', error);
    return jsonResponse({ error: 'Webhook processing failed' }, 500);
  }
});
