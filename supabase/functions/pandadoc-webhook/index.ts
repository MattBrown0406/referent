import { createClient } from 'npm:@supabase/supabase-js@2.110.8';

import {
  bytesToHex,
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

Deno.serve(async (request) => {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  try {
    const rawBody = await request.text();
    const receivedSignature = (new URL(request.url).searchParams.get('signature') || '').toLowerCase();
    const expectedSignature = bytesToHex(await hmacSha256(requiredEnv('PANDADOC_WEBHOOK_SHARED_KEY'), rawBody));
    if (!receivedSignature || !timingSafeEqual(expectedSignature, receivedSignature)) {
      return jsonResponse({ error: 'Invalid signature' }, 403);
    }

    const deliveries = JSON.parse(rawBody);
    if (!Array.isArray(deliveries)) return jsonResponse({ error: 'Expected an event array' }, 400);
    const headerEventId = request.headers.get('x-pandadoc-webhook-event-id') || '';
    if (!headerEventId) return jsonResponse({ error: 'Missing event identity' }, 400);

    const supabase = createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const referentOwnerId = requiredEnv('REFERENT_OWNER_ID');
    if (!isUuid(referentOwnerId)) throw new Error('REFERENT_OWNER_ID must be a UUID');
    const firstDelivery = objectValue(deliveries[0]);
    const firstData = objectValue(firstDelivery.data);
    const { error: receiptError } = await supabase.from('integration_webhook_events').insert({
      provider: 'pandadoc',
      external_event_id: headerEventId,
      event_type: typeof firstDelivery.event === 'string' ? firstDelivery.event : '',
      payload: {
        events: deliveries.map((delivery) => {
          const item = objectValue(delivery);
          const data = objectValue(item.data);
          return { event: item.event, external_id: data.id || data.uuid, status: data.status };
        }),
      },
    });
    if (receiptError?.code === '23505') {
      const { data: existingReceipt, error: lookupError } = await supabase
        .from('integration_webhook_events')
        .select('processed_at')
        .eq('provider', 'pandadoc')
        .eq('external_event_id', headerEventId)
        .single();
      if (lookupError) throw lookupError;
      if (existingReceipt?.processed_at) return jsonResponse({ ok: true, duplicate: true });
    } else if (receiptError) {
      throw receiptError;
    }

    for (const delivery of deliveries) {
      const item = objectValue(delivery);
      const data = objectValue(item.data);
      const metadata = objectValue(data.metadata);
      const externalId = typeof data.id === 'string' ? data.id : typeof data.uuid === 'string' ? data.uuid : '';
      if (!externalId) continue;
      const eventType = typeof item.event === 'string' ? item.event : '';
      const status = typeof data.status === 'string'
        ? data.status
        : eventType === 'document_completed_pdf_ready' ? 'document.completed' : eventType || 'updated';
      const caseId = metadata.referent_case_id;
      const ownerId = metadata.referent_owner_id;
      const sharedLink = typeof data.shared_link === 'string' ? data.shared_link : '';

      if (isUuid(caseId) && ownerId === referentOwnerId) {
        const { data: ownedCase } = await supabase.from('cases').select('id').eq('id', caseId).eq('owner_id', ownerId).maybeSingle();
        if (ownedCase) {
          const { error: upsertError } = await supabase.from('case_integrations').upsert({
            owner_id: ownerId,
            case_id: caseId,
            provider: 'pandadoc',
            record_type: 'document',
            external_id: externalId,
            status,
            external_url: sharedLink,
            completed_at: ['document.completed', 'document.paid'].includes(status) ? new Date().toISOString() : undefined,
            last_synced_at: new Date().toISOString(),
            metadata: { pandadoc_name: data.name || null },
          }, { onConflict: 'owner_id,provider,record_type,external_id' });
          if (upsertError) throw upsertError;
          continue;
        }
      }

      const patch: Json = {
        status,
        last_synced_at: new Date().toISOString(),
      };
      if (sharedLink) patch.external_url = sharedLink;
      if (['document.completed', 'document.paid'].includes(status)) patch.completed_at = new Date().toISOString();
      const { error: updateError } = await supabase.from('case_integrations').update(patch)
        .eq('owner_id', referentOwnerId)
        .eq('provider', 'pandadoc')
        .eq('record_type', 'document')
        .eq('external_id', externalId);
      if (updateError) throw updateError;
    }

    const { error: processedError } = await supabase.from('integration_webhook_events').update({
      processed_at: new Date().toISOString(),
      processing_error: '',
    }).eq('provider', 'pandadoc').eq('external_event_id', headerEventId);
    if (processedError) throw processedError;
    return jsonResponse({ ok: true });
  } catch (error) {
    console.error('PandaDoc webhook processing failed', error);
    return jsonResponse({ error: 'Webhook processing failed' }, 500);
  }
});
