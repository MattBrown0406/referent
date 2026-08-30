import assert from 'node:assert/strict';
import fs from 'node:fs';

const portal = fs.readFileSync(new URL('../portal/src/PublicRoutes.tsx', import.meta.url), 'utf8');
const edge = fs.readFileSync(new URL('../supabase/functions/public-referrals/index.ts', import.meta.url), 'utf8');
const growthScreen = fs.readFileSync(new URL('../src/lib/ReferralGrowthScreen.tsx', import.meta.url), 'utf8');

for (const field of ['firstName', 'lastName', 'phone', 'email', 'callbackConsent', 'privacyConsent', 'website']) {
  assert.match(portal, new RegExp(`\\b${field}\\b`), `portal intake must send ${field}`);
  assert.match(edge, new RegExp(`body\\.${field}\\b`), `Edge intake must read ${field}`);
}
for (const field of ['practiceDisplay', 'sourceDisplay']) {
  assert.match(portal, new RegExp(`labels\\?\\.${field}\\b`), `portal must render ${field}`);
  assert.match(edge, new RegExp(`${field}: source\\.`), `Edge resolve must return ${field}`);
}
const handoffFields = {
  clientAlias: 'client_alias',
  senderPracticeDisplay: 'sender_practice_display',
  recipientDisplay: 'recipient_display',
};
for (const [field, databaseField] of Object.entries(handoffFields)) {
  assert.match(portal, new RegExp(`record\\.${field}\\b`), `portal must render ${field}`);
  assert.match(edge, new RegExp(`${field}: handoff\\.${databaseField}\\b`), `Edge handoff resolve must return ${field}`);
}
assert.match(portal, /nextStatus:\s*record\.allowedNextStatus/, 'portal transition must send nextStatus');
assert.match(edge, /stringValue\(body\.nextStatus\)/, 'Edge transition must read nextStatus');
assert.match(portal, /setRecord\(\{ \.\.\.record, \.\.\.next, allowedNextStatus \}\)/, 'partial transition response must merge into the resolved handoff');
assert.doesNotMatch(portal, /honeypot:\s*form\.website|targetStatus:\s*record\.allowedNextStatus/, 'retired payload keys must not return');
assert.match(
  growthScreen,
  /active:\s*false,\s*rotatedToSourceId:\s*replacement\.id/,
  'successful rotation must immediately mark the old local source as permanently replaced',
);

console.log('Public portal ↔ Edge Function contract: PASS');
