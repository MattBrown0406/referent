#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../App.tsx', import.meta.url), 'utf8');

assert.match(source, /function mutationSlotAvailable\(label: string\): boolean/);
assert.match(source, /async function saveCurrentReferralMatch\(\): Promise<ReferralMatch \| null>/);
assert.match(source, /const saved = await settleOptimisticWrite\(/);
assert.match(source, /const referralMatch = await saveCurrentReferralMatch\(\)/);
assert.match(source, /const matchProfile = await currentOrSavedMatch\(\)/);
assert.match(source, /async function currentOrSavedMatch\(\): Promise<ReferralMatch \| null> \{\s*return saveCurrentReferralMatch\(\);\s*\}/);
assert.match(source, /setSelectedMatchId\(previousSelectedMatchId\)/);
assert.match(source, /setPendingCaseMatchId\(previousPendingCaseMatchId\)/);
assert.doesNotMatch(source, /<TouchableOpacity key=\{item\.id\}[\s\S]*?<TouchableOpacity style=\{styles\.savedMatchPacketButton\}/);
assert.match(source, /accessibilityRole="radio"\s*accessibilityState=\{\{ selected \}\}/);
assert.match(source, /const stillCurrent = \(\) => active[\s\S]*activeUserIdRef\.current === userId/);
assert.match(source, /label="MONTHLY CASH COST"/);
assert.doesNotMatch(source, /label="CASH MIN"|label="CASH MAX"/);
assert.match(source, /accessibilityLabel=\{`\$\{plan\} \$\{status\}`\}/);
assert.match(source, /insuranceNetworks: partnerForm\.insuranceNetworks/);
assert.match(source, /isOutOfNetwork = networkCapabilities\.includes\('Out-of-network'\)/);

for (const label of [
  'The match', 'The packet log', 'The case', 'The case status change',
  'The payment change', 'The additional payment', 'The case summary', 'The case details', 'The case contact',
  'The completed step and its next step', 'The follow-up and case status',
  'The next step', 'The contact log', 'The contact note', 'The follow-up',
  'The follow-up change', 'The outcome', 'The partner', 'The referral',
  'The touch', 'The favorite change', 'The contact removal',
]) {
  assert.ok(source.includes(`mutationSlotAvailable('${label}')`), `missing pre-optimistic mutation guard: ${label}`);
}

assert.match(source, /function saveCaseDetails\(\)/, 'case names and summaries must remain editable after creation');
assert.match(source, /updateCaseDetailsWithEvent\(activeCase\.id, event\.id, detailsPatch, event\.body\)/, 'case details must use a field-specific patch RPC');
assert.match(source, /accessibilityLabel="Edit case name and summary"/, 'case detail must expose an obvious edit action');
assert.match(
  source,
  /function CaseDetailModal\(\) \{[\s\S]{0,700}if \(caseEditForm\) return EditCaseModal\(\);[\s\S]{0,160}if \(casePaymentForm\) return AddCasePaymentModal\(\);[\s\S]{0,160}if \(caseContactForm\) return CaseContactModal\(\);/,
  'case editors must replace the open case sheet instead of attempting to present a second sibling iOS modal',
);
assert.doesNotMatch(
  source,
  /\{CaseDetailModal\(\)\}[\s\S]{0,400}\{EditCaseModal\(\)\}/,
  'case editors must not be mounted as sibling native modals while the case sheet is visible',
);
assert.match(source, /function addCasePayment\(\)/, 'cases must accept additional payments');
assert.match(source, /recordCasePayment\(activeCase\.id, event\.id, amount, note\)/, 'additional payments must use the atomic server-side increment RPC');
assert.match(source, /id: paymentForm\.eventId/, 'additional-payment retries must reuse the same idempotency key');
assert.match(source, /setCasePaymentForm\(paymentForm\)/, 'an unconfirmed payment must reopen with its original idempotency key');
assert.match(source, /key=\{`\$\{record\.id\}:\$\{record\.summary\}`\}/, 'the inline summary editor must remount after a modal edit');
assert.match(source, /Payment received: \$\{formatMoney\(amount\)\}/, 'each payment must be recorded as its own timeline event');
assert.match(source, /Edit contact information for \$\{contact\.name\}/, 'contact information must have a full-row edit target');
assert.match(source, /const totalRevenue = cases\.reduce/, 'Cases tab must summarize cumulative paid revenue');
assert.match(source, /TOTAL PAID REVENUE/, 'Cases tab must display cumulative paid revenue');
assert.match(source, /record\.paidAmount > 0 \? `\$\{formatMoney\(record\.paidAmount\)\} paid`/, 'each case row must show its paid revenue total');
assert.match(source, /completeFollowUpWithCase\(completed, updatedCase, event, status !== 'keep'\)/, 'keep-status close-loop actions must explicitly skip the case status update');

for (const operation of [
  'completeFollowUpWithNext', 'completeFollowUpWithCase',
  'completeFollowUpWithOutcome', 'finalizeMatchPacket',
]) {
  assert.match(source, new RegExp(`\\(\\) => ${operation}\\(`), `${operation} must be deferred until after the mutation/session fence`);
}
assert.match(source, /\(\) => assignedMatch\s*\? assignMatchReferral\(/, 'assignMatchReferral must be deferred until after the mutation/session fence');

console.log('optimistic mutation serialization/dependency invariants: ok');
