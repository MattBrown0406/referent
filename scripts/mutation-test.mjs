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
assert.match(source, /function removeReferralMatch\(item: ReferralMatch\)/, 'active referral matches must be removable');
assert.match(source, /deleteMatchProfile\(item\.id, activeUserId\)/, 'removing an active match must persist the deletion');
assert.match(source, /Existing case and referral records will not be deleted\./, 'the removal confirmation must explain what is and is not deleted');
assert.match(source, /accessibilityLabel=\{`Remove \$\{item\.clientLabel\} from active referral matches`\}/, 'each active match must expose a clear accessible remove action');
assert.match(source, /const stillCurrent = \(\) => active[\s\S]*activeUserIdRef\.current === userId/);
// One cost field (no cash min/max). Its wording follows the partner's types:
// "MONTHLY CASH COST" for programs, "TYPICAL FEE" for an interventionist or
// therapist (src/lib/directory-submission.ts directoryCostLabel).
assert.match(source, /label=\{directoryCostLabel\(partnerForm\.types\)\.toUpperCase\(\)\}/);
assert.match(
  await readFile(new URL('../src/lib/directory-submission.ts', import.meta.url), 'utf8'),
  /isIndividualProfessional\(types\) \? 'Typical fee' : 'Monthly cash cost'/,
);
assert.doesNotMatch(source, /label="CASH MIN"|label="CASH MAX"/);
assert.match(source, /accessibilityLabel=\{`\$\{plan\} \$\{status\}`\}/);
assert.match(source, /insuranceNetworks: partnerForm\.insuranceNetworks/);
// Payment fit lives in the pure ranker now (matching integrity); App.tsx
// must not grow a second copy of it.
const matchingSource = await readFile(new URL('../src/lib/matching.ts', import.meta.url), 'utf8');
assert.match(matchingSource, /isOutOfNetwork = networkCapabilities\.includes\('Out-of-network'\)/);
assert.doesNotMatch(source, /networkCapabilities\.includes\('Out-of-network'\)/, 'App.tsx must call the ranker, not re-derive payment fit');
assert.match(source, /const matches = useMemo\(\s*\(\) => rankPrograms\(draftMatchProfile, partners, scorecards, bedOptions\)/, 'the match memo must rank through src/lib/matching.ts (with the bed filter as the only extra input)');
assert.doesNotMatch(source, /reciprocity|inbound - partner\.outbound|to return|Tie-breaker/, 'no reciprocity or score-keeping language in App.tsx');
assert.doesNotMatch(matchingSource, /\.(inbound|outbound)\b|['"](inbound|outbound)['"]/, 'the ranker never reads referral counts');
assert.match(matchingSource, /disclosure: hasFinancialRelationship\(partner\),/, 'the disclosure is a flag on the result');
assert.doesNotMatch(matchingSource.slice(matchingSource.indexOf('export function compareScored'), matchingSource.indexOf('export function rankPrograms')), /disclosure|financialRelationship/, 'ties never look at the disclosure');
// A pick below the top needs a reason; a disclosed relationship needs one more tap, in both assignment flows.
assert.match(source, /function addReferral\(disclosureConfirmed = false\)/);
assert.match(source, /function finalizePacketSend\(disclosureConfirmed = false\)/);
assert.ok((source.match(/confirmDisclosedRelationship\(/g) || []).length >= 3, 'both assignment flows must route through the disclosure confirmation');
assert.ok((source.match(/await recordPlacementDecision\(decision, activeUserId\)/g) || []).length === 2, 'both assignment flows must write the placement record after the assignment');

for (const label of [
  'The match', 'The match removal', 'The packet log', 'The case', 'The case status change',
  'The payment change', 'The additional payment', 'The case summary', 'The case details', 'The case contact',
  'The completed step and its next step', 'The follow-up and case status',
  'The next step', 'The case next step', 'The contact log', 'The contact note', 'The follow-up',
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
assert.match(source, /function selectCasePaymentStatus\(record: CaseRecord, status: PaymentStatus\)/, 'payment status selection must validate server invariants before writing');
assert.match(source, /saveCasePayment\(record, \{ paymentStatus: 'quoted', quotedAmount \}\)/, 'choosing quoted without an amount must save the entered quote and status atomically');
assert.match(source, /Enter a quote to mark the case quoted automatically\./, 'the payment UI must explain that entering a quote derives quoted status');
assert.match(source, /function CaseNextStepModal\(record: CaseRecord\)/, 'case files must provide an in-place next-step scheduler');
assert.match(source, /accessibilityLabel=\{`Schedule a next step for \$\{record\.title\}`\}/, 'case files must expose a clear schedule-next-step action');
assert.match(source, /function saveCaseNextStep\(record: CaseRecord\)[\s\S]{0,1200}caseId: record\.id,[\s\S]{0,500}status: 'open'/, 'case-file scheduling must create an open follow-up linked to that case');
assert.match(source, /Scheduled here also appears on Today when it is due\./, 'case files must explain where scheduled next steps appear');
assert.match(source, /function formatTwelveHourInput\(value: string\): string/, 'consult times must auto-format numeric input as a clock time');
assert.match(source, /function twelveHourToStoredTime\(value: string, period: TimePeriod\): string \| null/, '12-hour input must be converted to the stored 24-hour time contract');
assert.match(source, /<Text style=\{styles\.fieldLabel\}>AM OR PM<\/Text>/, 'consult scheduling must provide an explicit AM/PM selector');
assert.match(source, /Enter a time from 1:00 through 12:59, then choose AM or PM\./, 'invalid consultation times must be rejected with useful guidance');
assert.match(source, /id: paymentForm\.eventId/, 'additional-payment retries must reuse the same idempotency key');
assert.match(source, /setCasePaymentForm\(paymentForm\)/, 'an unconfirmed payment must reopen with its original idempotency key');
assert.match(source, /key=\{`\$\{record\.id\}:\$\{record\.summary\}`\}/, 'the inline summary editor must remount after a modal edit');
assert.match(source, /Payment received: \$\{formatMoney\(amount\)\}/, 'each payment must be recorded as its own timeline event');
assert.match(source, /Edit contact information for \$\{contact\.name\}/, 'contact information must have a full-row edit target');
assert.match(source, /const totalRevenue = cases\.reduce/, 'Cases tab must summarize cumulative paid revenue');
assert.match(source, /TOTAL PAID REVENUE/, 'Cases tab must display cumulative paid revenue');
assert.match(source, /record\.paidAmount > 0 \? `\$\{formatMoney\(record\.paidAmount\)\} paid`/, 'each case row must show its paid revenue total');
assert.match(source, /completeFollowUpWithCase\(completed, updatedCase, event, status !== 'keep'\)/, 'keep-status close-loop actions must explicitly skip the case status update');
const doneSheetSource = source.slice(source.indexOf('function DoneSheet()'), source.indexOf('function NextStepSheet()'));
assert.equal((doneSheetSource.match(/<Modal/g) || []).length, 1, 'DoneSheet must keep one stable native modal while choosing a case status');
assert.match(doneSheetSource, /nextStepCard\?\.id === doneCard\.id[\s\S]*StepFormFields\(\)[\s\S]*confirmDoneNextStep/, 'Done → Next step must replace content inside the existing iOS modal');
assert.match(source, /function NextStepSheet\(\) \{\s*if \(!nextStepCard \|\| doneCard\) return null;/, 'the standalone next-step modal must never mount over the Done modal');
assert.match(source, /setNextStepCard\(null\);\s*setDoneCard\(null\);/, 'completing and scheduling must dismiss both pieces of Done flow state');
assert.match(doneSheetSource, /showingDoneNextStep && styles\.stepFormSheet[\s\S]*showingDoneNextStep && styles\.stepFormScroll/, 'the Done next-step form must use a bounded, scrollable iOS sheet');
assert.match(source, /stepFormSheet: \{ height: '92%', maxHeight: '92%' \}[\s\S]*stepFormScroll: \{ flex: 1 \}/, 'the next-step sheet must reserve viewport height and scrolling space for timing and save controls');
assert.match(source, /scroll to set when it should happen and save/, 'the long next-step form must tell users that timing and save controls continue below');
assert.match(source, /const \[caseCloseLoopSaving, setCaseCloseLoopSaving\] = useState\(false\)/, 'case close-loop saves must expose a visible pending state');
assert.match(source, /if \(!card\?\.followUp \|\| caseCloseLoopSaving\) return/, 'case close-loop saves must reject repeat taps');
assert.match(source, /setCaseCloseLoopSaving\(true\)[\s\S]{0,700}settleOptimisticWrite\(/, 'the status sheet must stay mounted while the optimistic write settles');
assert.match(source, /requestAnimationFrame\(\(\) => \{\s*setDoneCard\(\(current\) => current\?\.id === card\.id \? null : current\)/, 'the status sheet must dismiss after the status-pill press settles');
assert.match(source, /withTimeout\(\s*rescheduleNotifications\(/, 'native notification refresh must not block a completed save indefinitely');

for (const operation of [
  'completeFollowUpWithNext', 'completeFollowUpWithCase',
  'recordPlacementOutcome', 'finalizeMatchPacket',
]) {
  // Either `() => op(` or the awaited form `async () => { await op(` (used
  // where the placement record follows the assignment inside the same fence).
  assert.match(source, new RegExp(`(async )?\\(\\) => (\\{\\s*await )?${operation}\\(`), `${operation} must be deferred until after the mutation/session fence`);
}
assert.match(source, /async \(\) => \{\s*if \(assignedMatch\) \{\s*await assignMatchReferral\(/, 'assignMatchReferral must be deferred until after the mutation/session fence');

console.log('optimistic mutation serialization/dependency invariants: ok');
