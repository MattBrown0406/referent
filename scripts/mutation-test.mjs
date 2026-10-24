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

// One share sheet at a time: a second one presented over the first never
// settles, and its overlay would then hold off every later sheet.
for (const name of ['sharePacketText', 'sharePartner']) {
  assert.match(
    source,
    new RegExp(`async function ${name}\\([^)]*\\) \\{[\\s\\S]{0,400}?const endOverlay = beginShareSheet\\(\\);\\s*if \\(!endOverlay\\) return;\\s*try \\{\\s*(const result = )?await Share\\.share\\(`),
    `${name} must open its share sheet through beginShareSheet`,
  );
}

// A rollback or a late result never presents a sheet on its own (iOS may be
// mid-dismissal, or another sheet is up), and never puts back data from
// another case file, account, or workspace.
assert.match(source, /setSelectedPartner\(\(current\) => \(current\?\.id === partner\.id \? existing \|\| null : current\)\)/, 'a refused partner save reverts the profile only while it shows that partner');
assert.doesNotMatch(source, /setSelectedPartner\(existing \|\| null\)/, 'a refused partner save must not open the profile');
assert.match(source, /if \(previousReferralUi\.showAddReferral\) afterSheetCloses\(\(\) => setShowAddReferral\(true\)\)/, 'a refused referral reopens its form only after the sheet has closed');
assert.doesNotMatch(source, /setShowAddReferral\(previousReferralUi\.showAddReferral\)/, 'a refused referral must not re-present its form during the dismissal');
for (const name of ['openMatchedReferral', 'openPacketComposer']) {
  const body = source.slice(source.indexOf(`async function ${name}(`), source.indexOf('\n  }\n', source.indexOf(`async function ${name}(`)));
  assert.match(body, /const openings = screenOpenings\(\);\s*const \w+ = await (saveCurrentReferralMatch|currentOrSavedMatch)\(\);[\s\S]{0,500}?if \(anySheetOpenRef\.current \|\| overlayOpen\(\) \|\| screenOpenings\(\) !== openings\) return;/, `${name} must not present over, or as it closes, a sheet opened during its save`);
  assert.doesNotMatch(body, /setSelectedPartner\(null\)/, `${name} must not close one sheet and present another in the same frame`);
}
// The count behind those checks moves on every no-sheet → sheet render, and
// the org profile form waits out a sheet that opened (and maybe closed) while it loaded.
assert.match(source, /if \(sheetOpenNow && !anySheetOpenRef\.current\) sheetOpenedCountRef\.current \+= 1;\s*anySheetOpenRef\.current = sheetOpenNow;/, 'every sheet opening is counted before anySheetOpenRef updates');
assert.match(source, /async function openOrgProfileForm\(fromWorkspace: boolean\) \{[\s\S]{0,300}const openings = screenOpenings\(\);[\s\S]{0,1200}\} else if \(anySheetOpenRef\.current \|\| overlayOpen\(\) \|\| screenOpenings\(\) !== openings\) \{[\s\S]{0,200}afterSheetCloses\(\(\) => setShowOrgProfile\(true\), \{ ifScreenBusy: 'wait' \}\)/, 'the org profile form never presents as a sheet opened during its load is closing');
assert.match(source, /if \(activeCaseIdRef\.current === paymentCaseId\) setCasePaymentForm\(paymentForm\)/, 'an unconfirmed payment reopens only over its own case file');
assert.match(source, /function openCase\(caseId: string\) \{[\s\S]{0,1200}setCasePaymentForm\(null\);[\s\S]{0,400}setVobAnswerForm\(null\);[\s\S]{0,200}loadCaseList\(userId\)/, 'opening a case file clears editors left from another case');
assert.doesNotMatch(source, /setCases\(previousCases\);\s*Alert\.alert\('Assignment not saved'/, 'a failed assignment must not restore a stale whole case list');
assert.match(source, /if \(!stillCurrent\(\)\) return;\s*localChangeSerialRef\.current \+= 1;\s*setCases\(\(current\) => current\.map\(\(item\) => \(item\.id === caseId \? \{ \.\.\.item, assignedTo: previousAssignee \} : item\)\)\)/, 'a failed assignment reverts that case only, in its own account and workspace, past any refresh in flight');
assert.match(source, /const saved = await assignCase\(caseId, assignedTo, eventId\);\s*if \(!stillCurrent\(\)\) return;[\s\S]{0,80}localChangeSerialRef\.current \+= 1;/, 'a refresh that started during an assignment never paints the old assignee back');
assert.doesNotMatch(source, /setCaseDocuments\(previousDocs\)/, 'a failed document delete must not paint one case file\'s documents into another');
assert.match(source, /async function submitPartnerForDirectory\(partner: Partner\) \{[\s\S]{0,900}const stillCurrent = \(\) => activeUserIdRef\.current === userId && authGenerationRef\.current === generation;/, 'a directory submission result is dropped after a workspace change');
assert.doesNotMatch(source, /const nextPartners = partners\.map\(\(item\) => item\.id === updated\.id/, 'a directory submission applies only its link fields to the current list');
const resetSource = source.slice(source.indexOf('const resetAccountState = useCallback('), source.indexOf('}, [applySnapshot]);', source.indexOf('const resetAccountState = useCallback(')));
for (const call of ['setShowAddPartner(false)', 'setShowAddReferral(false)', 'setShowOrgProfile(false)', 'setOrgProfileForm(makeEmptyOrgProfileForm())', 'setWelcomeVisible(false)', 'setProfilePromptVisible(false)']) {
  assert.ok(resetSource.includes(call), `resetAccountState must close ${call}`);
}
assert.match(source, /setSelectedPartner\(\(current\) => \{\s*if \(!current\) return current;\s*const fresh = partners\.find\(\(item\) => item\.id === current\.id\);\s*return fresh && fresh !== current \? fresh : current;\s*\}\);\s*\}, \[partners\]\);/, 'the open partner profile follows the partner list, so Edit never writes an older copy back');
const workspaceScreenSource = await readFile(new URL('../src/lib/WorkspaceScreen.tsx', import.meta.url), 'utf8');
assert.match(workspaceScreenSource, /await load\(\);\s*(\/\/[^\n]*\n\s*)*if \(!visibleRef\.current\) return;\s*await Share\.share\(/, 'the invite share sheet is never presented from a closed Workspace screen');

// ─── Round 11: placement integrity ──────────────────────────────────────────
{
  const addReferralBody = source.slice(source.indexOf('function addReferral(disclosureConfirmed = false)'), source.indexOf('function openTouchLogger('));
  assert.match(addReferralBody, /\.\.\.\(matchForReferral \? \{ matchProfileId: matchForReferral\.id, caseId: matchForReferral\.caseId \} : \{\}\)/, 'Assign & refer links the referral to its match and case');
  assert.match(addReferralBody, /title: 'Check in — did they admit\?'/, 'Assign & refer sets the same admit check as the packet path');
  assert.match(addReferralBody, /await assignMatchReferral\([\s\S]{0,300}if \(admitCheck\) await createFollowUp\(admitCheck, activeUserId\);[\s\S]{0,80}if \(decision\) await recordPlacementDecision/, 'the admit check is written after the assignment, before the placement record');
  assert.match(addReferralBody, /if \(admitCheck\) setFollowUps\(followUps\);/, 'a refused assignment rolls the admit check back');
  assert.match(source, /const ASSIGN_REFERRAL_OUTCOMES: Referral\['outcome'\]\[\] = \['Introduced', 'Consulted', 'Pending'\];/, 'the assign form does not offer Placed');
  assert.match(source, /\(matchedReferral \? ASSIGN_REFERRAL_OUTCOMES : LOG_REFERRAL_OUTCOMES\)\.map/);
  const composerBody = source.slice(source.indexOf('async function openPacketComposer('), source.indexOf('function openPacketForAssigned('));
  assert.match(composerBody, /const alreadyReferred = matchProfile\.status === 'Referred' && matchProfile\.assignedPartnerId === partner\.id && Boolean\(matchProfile\.referralId\);[\s\S]*assignOnSend: !alreadyReferred/, 'a second packet to the same program does not assign again');
  const finalizeBody = source.slice(source.indexOf('function finalizePacketSend('), source.indexOf('// ─── Case files ───', source.indexOf('function finalizePacketSend(')));
  assert.match(finalizeBody, /const admitCheckOpen = followUps\.some\(\(item\) => item\.referralId === referralId && item\.status === 'open' && item\.kind !== 'check_in'\);\s*const needsAdmitCheck = assignOnSend \|\| \(!admitCheckOpen && referral\.admitted == null\);/, 'no second admit check while one is open or the answer is in');
  assert.match(finalizeBody, /: async \(\) => \{\s*await updateReferralPacketStamp\(/, 'without a new admit check the packet only stamps the referral');
}

// ─── Round 11: Today and teams ──────────────────────────────────────────────
{
  const takeBody = source.slice(source.indexOf('async function takeLead(caseId: string)'), source.indexOf('function assigneeChoices('));
  assert.match(takeBody, /const saved = await takeCase\(caseId, eventId\);/, 'Take this lead uses the take-only server call, never a plain assignment');
  assert.doesNotMatch(takeBody, /await assignCase\(/, 'a plain assignment would overwrite a teammate who took the lead first');
  assert.match(takeBody, /if \(error instanceof LeadTakenError\) \{\s*const holder = error\.takenBy \|\| previousAssignee \|\| undefined;/, 'a refused take shows who really has the lead');
  assert.match(takeBody, /if \(saved\.eventBody && activeCaseIdRef\.current === caseId\)/, 'taking your own lead again adds no second timeline entry');
  assert.match(source, /onPress=\{\(\) => \{ void takeLead\(card\.caseId as string\); \}\}/, 'Take this lead goes through takeLead');
}

// ─── Round 11: a failed New lead / New case keeps its draft and ids ─────────
{
  const leadBody = source.slice(source.indexOf('function saveNewLead(draft: NewLeadDraft)'), source.indexOf('function openNewLeadSheet()'));
  assert.match(leadBody, /const retrying = leadSheetRetry;\s*const ids = retrying\?\.ids \?\? \{ caseId: makeId\('c'\), contactId: makeId\('cc'\), followUpId: makeId\('f'\) \};/, 'a lead retry reuses its ids, only from the sheet opened for it');
  for (const field of ['id: ids.caseId', 'id: ids.contactId', 'id: ids.followUpId']) assert.ok(leadBody.includes(field), `lead uses ${field}`);
  assert.match(leadBody, /onRejected: \(error\) => \{[\s\S]{0,200}isRetryable\(error\)[\s\S]{0,700}afterSheetCloses\(\(\) => \{ setLeadSheetRetry\(retry\); setShowNewLead\(true\); \}, \{ ifScreenBusy: 'wait'/, 'a failed lead reopens its sheet once the screen is clear');
  const caseBody = source.slice(source.indexOf('function saveNewCase()'), source.indexOf('function openNewCaseForm()'));
  assert.match(caseBody, /const retrying = caseFormRetry;\s*const ids = retrying\?\.ids \?\? \{ caseId: makeId\('c'\), contactId: makeId\('cc'\), followUpId: makeId\('f'\) \};/, 'a case retry reuses its ids, only from the form opened for it');
  assert.match(caseBody, /initialCaseFollowUp\(ids\.followUpId, record, new Date\(\)\)/);
  assert.match(caseBody, /onRejected: \(error\) => \{[\s\S]{0,400}form: submittedForm,[\s\S]{0,600}afterSheetCloses\(\(\) => \{ setCaseForm\(retry\.form\); setCaseFormRetry\(retry\); setShowNewCase\(true\); \}, \{ ifScreenBusy: 'wait'/, 'a failed case reopens filled in once the screen is clear');
  assert.match(source, /if \(options\.onRejected\?\.\(error\)\) return false;\s*if \(error instanceof OfflineError\) Alert\.alert\('Not saved', [^\n]*no connection[^\n]*\);\s*else Alert\.alert\('Not saved'/, 'a form that reopens is not also covered by an alert, and no connection is never called a rejection');
  const sheet = await readFile(new URL('../src/lib/NewLeadSheet.tsx', import.meta.url), 'utf8');
  assert.match(sheet, /if \(visible\) setDraft\(initialDraft \? \{ \.\.\.initialDraft \} : emptyDraft\(\)\);/, 'the lead sheet reopens with the kept draft');
}

// ─── Round 11: account deletion asks the server first ───────────────────────
{
  const account = await readFile(new URL('../src/lib/account.ts', import.meta.url), 'utf8');
  const body = account.slice(account.indexOf('export async function deleteOwnAccount('));
  const prepare = body.indexOf("supabase.rpc('prepare_account_deletion')");
  assert.ok(prepare > 0, 'deletion calls prepare_account_deletion');
  assert.ok(prepare < body.indexOf('await prepareForWorkspaceChange(userId)'), 'refusals come before caches and queued changes are touched');
  assert.ok(prepare < body.indexOf('await removeWorkspaceCaseFiles()'), 'refusals come before any file is removed');
  assert.ok(body.indexOf('await removeWorkspaceCaseFiles()') < body.indexOf("supabase.rpc('delete_own_account')"), 'files go before the account');
  assert.match(body, /throw new StoreError\(serverMessage\(prepareError, /, 'the server message is what the user sees');
}

// ─── Round 11: privacy and App Store ────────────────────────────────────────
{
  const workspace = await readFile(new URL('../src/lib/WorkspaceScreen.tsx', import.meta.url), 'utf8');
  const login = await readFile(new URL('../src/lib/LoginScreen.tsx', import.meta.url), 'utf8');
  const privacy = await readFile(new URL('../src/lib/privacy.ts', import.meta.url), 'utf8');
  const intake = await readFile(new URL('../src/lib/intake-link.ts', import.meta.url), 'utf8');
  const dashboard = await readFile(new URL('../src/lib/BusinessDashboard.tsx', import.meta.url), 'utf8');
  assert.match(privacy, /PRIVACY_POLICY_URL = 'https:\/\/mattbrown0406\.github\.io\/referent\/privacy\.html'/);
  assert.match(privacy, /Linking\.openURL\(PRIVACY_POLICY_URL\)/);
  for (const [name, text] of [['WorkspaceScreen', workspace], ['LoginScreen', login]]) {
    assert.match(text, /accessibilityLabel="Privacy policy"[^>]*onPress=\{openPrivacyPolicy\}/, `${name} links the privacy policy`);
  }
  assert.doesNotMatch(workspace, /ReferralFit staff do not have access/, 'no claim the operator cannot back up');
  assert.match(workspace, /is private to your workspace/);
  assert.match(intake, /export const INTAKE_LINK_ENABLED = false;/, 'the intake link is hidden this release by one flag');
  assert.match(workspace, /workspace && INTAKE_LINK_ENABLED \? intakeLinkUrl\(/, 'no intake URL to copy or share while hidden');
  assert.match(workspace, /\{INTAKE_LINK_ENABLED \? \(/, 'the intake card copy is behind the flag');
  assert.match(dashboard, /INTAKE_LINK_ENABLED \? 'Add leads with New lead on Today, or share your intake link/, 'the dashboard stops telling people to share it');
  assert.match(source, /accessibilityLabel="Workspace and settings"[\s\S]{0,200}<AppIcon name="settings-outline"/, 'Workspace (with Delete account) has its own icon');
  const appJson = JSON.parse(await readFile(new URL('../app.json', import.meta.url), 'utf8'));
  const picker = appJson.expo.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-image-picker')?.[1] || {};
  assert.equal(picker.cameraPermission, false, 'no camera usage string: the app never opens the camera');
  assert.equal(picker.microphonePermission, false, 'no microphone usage string');
  assert.match(picker.photosPermission || '', /photo/i);
  const secureStore = appJson.expo.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-secure-store')?.[1] || {};
  assert.equal(secureStore.faceIDPermission, false, 'no Face ID usage string');
  assert.ok(!(appJson.expo.android?.permissions || []).includes('android.permission.RECORD_AUDIO'), 'no RECORD_AUDIO');
}

// ─── Round 11: auth links sign in only for a flow this device started ──────
{
  const { createRequire } = await import('node:module');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const require = createRequire(import.meta.url);
  const ts = require(path.join(repoRoot, 'node_modules', 'typescript'));
  const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'mutation-test');
  mkdirSync(tmpDir, { recursive: true });
  const flowsJs = ts.transpileModule(await readFile(new URL('../src/lib/auth-flows.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  writeFileSync(path.join(tmpDir, 'auth-flows.js'), flowsJs);
  const flows = require(path.join(tmpDir, 'auth-flows.js'));
  const now = Date.UTC(2026, 9, 24, 12);
  const hour = 3600 * 1000;
  const recovery = 'referralfit://auth/recovery#access_token=AT&refresh_token=RT&type=recovery';
  const confirmed = 'referralfit://auth/confirmed#access_token=AT&refresh_token=RT&type=signup';
  assert.deepEqual([flows.authLinkPath(recovery), flows.authLinkPath(confirmed), flows.authLinkPath('referralfit://auth/recovery/'), flows.authLinkPath('referralfit://somewhere#access_token=AT&refresh_token=RT'), flows.authLinkPath('https://example.com/auth/recovery')], ['recovery', 'confirmed', 'recovery', null, null]);
  assert.equal(flows.decideAuthLink('referralfit://somewhere#access_token=AT&refresh_token=RT', { recovery: now, signup: now }, now).action, 'ignore', 'tokens on any other path are ignored');
  assert.equal(flows.decideAuthLink(recovery, {}, now).action, 'not_started', 'a reset this device never asked for is not used');
  assert.equal(flows.decideAuthLink(recovery, { signup: now }, now).action, 'not_started', 'a sign-up does not unlock a reset link');
  assert.equal(flows.decideAuthLink(recovery, { recovery: now - 25 * hour }, now).action, 'not_started', 'older than 24 hours');
  assert.equal(flows.decideAuthLink(recovery, { recovery: now + hour }, now).action, 'not_started', 'a start in the future is not trusted');
  const accepted = flows.decideAuthLink(recovery, { recovery: now - 2 * hour }, now);
  assert.deepEqual([accepted.action, accepted.path, accepted.flow, accepted.redirect?.kind], ['accept', 'recovery', 'recovery', 'tokens']);
  assert.equal(flows.decideAuthLink(confirmed, { signup: now - hour }, now).action, 'accept');
  assert.equal(flows.decideAuthLink('referralfit://auth/recovery#error=access_denied&error_code=otp_expired&error_description=Call+this+number', {}, now).action, 'not_started', 'an error link for no started flow shows nothing from the link');
  assert.deepEqual(flows.decideAuthLink('referralfit://auth/recovery#error=access_denied&error_code=otp_expired&error_description=x', { recovery: now }, now), { action: 'error', path: 'recovery', code: 'otp_expired' }, 'the link’s own text is never passed on');
  const jwt = (payload) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
  assert.equal(flows.jwtSubject(jwt({ sub: 'AAAAAAAA-1111-4111-8111-111111111111' })), 'aaaaaaaa-1111-4111-8111-111111111111');
  assert.equal(flows.jwtSubject('not-a-jwt'), null);
  assert.equal(flows.jwtSubject(jwt({ name: 'x' })), null);
  const login = await readFile(new URL('../src/lib/LoginScreen.tsx', import.meta.url), 'utf8');
  assert.match(login, /await recordAuthFlowStart\('signup'\);[\s\S]{0,400}supabase\.auth\.signUp\(/, 'sign-up is recorded before its email can arrive');
  assert.match(login, /await recordAuthFlowStart\('signup'\);\s*const \{ error: resendError \} = await supabase\.auth\.resend\(/, 'a resend is recorded');
  assert.match(login, /await recordAuthFlowStart\('recovery'\);\s*const \{ error: resetError \} = await supabase\.auth\.resetPasswordForEmail\(/, 'a reset is recorded');
  const handler = source.slice(source.indexOf('async function handleAuthUrl('), source.indexOf('Linking.getInitialURL()'));
  assert.match(handler, /const decision = decideAuthLink\(url, await readAuthFlowStarts\(\)\);/);
  assert.ok(handler.indexOf("decision.action === 'not_started'") < handler.indexOf('supabase.auth.setSession('), 'nothing is exchanged for a flow this device did not start');
  assert.match(handler, /if \(current && \(!linkUser \|\| linkUser !== current\.userId\.toLowerCase\(\)\)\) \{[\s\S]{0,200}'Switch accounts\?'/, 'a link for another account asks before switching');
  assert.ok(handler.indexOf("'Switch accounts?'") < handler.indexOf('supabase.auth.setSession('), 'the question comes before the switch');
  assert.match(handler, /await clearAuthFlowStart\(decision\.flow\);/, 'a used link needs a fresh start for the next one');
  assert.doesNotMatch(source, /flowType: 'pkce'/);
}

// ─── Round 12: a failed create closes a file opened on it ──────────────────
// The rollback removes the unsaved case, so a case file opened on it (the
// NEW LEADS card tapped while it saved) has nothing to show, but
// activeCaseId kept the screen "busy": the form never came back.
{
  const leadBody = source.slice(source.indexOf('function saveNewLead(draft: NewLeadDraft)'), source.indexOf('function openNewLeadSheet()'));
  assert.match(leadBody, /if \(activeCaseIdRef\.current === ids\.caseId\) closeCase\(\);\s*afterSheetCloses\(\(\) => \{ setLeadSheetRetry/, 'a failed lead closes its own case file before the sheet reopens');
  const caseBody = source.slice(source.indexOf('function saveNewCase()'), source.indexOf('function openNewCaseForm()'));
  assert.match(caseBody, /if \(activeCaseIdRef\.current === ids\.caseId\) closeCase\(\);\s*afterSheetCloses\(\(\) => \{ setCaseForm\(retry\.form\)/, 'a failed case closes its own case file before the form reopens');
}

// ─── Round 12: a retry's ids belong to the sheet opened for it ─────────────
// Lead A fails while the sheet is open on lead B: B must not be saved with
// A's ids (a same-id retry of an A that did land is a no-op, so B would be
// dropped), nor show A's notice, nor have its form replaced by A's.
{
  const leadBody = source.slice(source.indexOf('function saveNewLead(draft: NewLeadDraft)'), source.indexOf('function openNewLeadSheet()'));
  assert.doesNotMatch(leadBody, /leadRetry\?\.ids/, 'a lead save never takes the pending retry’s ids by itself');
  assert.match(leadBody, /if \(retrying\) setLeadRetries\(\(current\) => current\.filter\(\(item\) => item !== retrying\)\);/, 'a save clears only the retry it is for');
  const openLead = source.slice(source.indexOf('function openNewLeadSheet()'), source.indexOf('const todayCounts = useMemo('));
  assert.match(openLead, /setLeadSheetRetry\(leadRetries\[0\] \?\? null\);\s*setShowNewLead\(true\);/, 'opening New lead binds the oldest waiting retry to that sheet');
  assert.match(openLead, /const session = leadSheetRetry;\s*if \(session\) setLeadRetries\(\(current\) => current\.filter\(\(item\) => item !== session\)\);/, 'cancelling a new lead keeps another lead’s retry');
  assert.match(source, /initialDraft=\{leadSheetRetry\?\.draft \?\? null\}\s*notice=\{leadSheetRetry\?\.message\}\s*retry=\{Boolean\(leadSheetRetry\?\.retryable\)\}/, 'the sheet shows only its own retry');
  const caseBody = source.slice(source.indexOf('function saveNewCase()'), source.indexOf('function openNewCaseForm()'));
  assert.doesNotMatch(caseBody, /caseRetry\?\.ids|setCaseForm\(submittedForm\)/, 'a failed case never overwrites a form open on another case');
  const openCaseForm = source.slice(source.indexOf('function openNewCaseForm()'), source.indexOf('function changeCaseStatus('));
  assert.match(openCaseForm, /const waiting = caseRetries\[0\] \?\? null;\s*setCaseFormRetry\(waiting\);\s*setCaseForm\(waiting \? waiting\.form : makeEmptyCaseForm\(\)\);/, 'New case opens the oldest waiting retry with its own draft');
  assert.match(openCaseForm, /const session = caseFormRetry;\s*if \(session\) setCaseRetries\(\(current\) => current\.filter\(\(item\) => item !== session\)\);/, 'cancelling a new case keeps another case’s retry');
  assert.doesNotMatch(source, /\{caseRetry\?\.retryable|\{caseRetry\.message\}/, 'the form shows only its own retry');
  // Saving another lead meanwhile no longer cancels the failed one's reopen
  // (it was dropped silently): the reopen waits for its own retry only.
  assert.match(leadBody, /stillWanted: \(\) => leadRetriesRef\.current\.includes\(retry\) \}/, 'a failed lead still reopens after another lead is saved');
  assert.match(caseBody, /stillWanted: \(\) => caseRetriesRef\.current\.includes\(retry\) \}/, 'a failed case still reopens after another case is saved');
  assert.doesNotMatch(source, /createRetryTokenRef/);
}

// ─── Round 13: a second failure never displaces the first ──────────────────
// Lead A fails while the sheet is open on lead B (A's reopen waits, and gives
// up after ~30 s of typing); B is saved and fails too (still offline). With
// one slot, B replaced A and A was gone without a word. Every failure now
// waits in its own place, oldest first, until it is retried or cancelled.
{
  const leadBody = source.slice(source.indexOf('function saveNewLead(draft: NewLeadDraft)'), source.indexOf('function openNewLeadSheet()'));
  const caseBody = source.slice(source.indexOf('function saveNewCase()'), source.indexOf('function openNewCaseForm()'));
  assert.match(leadBody, /leadRetriesRef\.current = \[\.\.\.leadRetriesRef\.current, retry\];\s*setLeadRetries\(\(current\) => \[\.\.\.current, retry\]\);/, 'a failed lead is added to the waiting retries, never replacing one');
  assert.match(caseBody, /caseRetriesRef\.current = \[\.\.\.caseRetriesRef\.current, retry\];\s*setCaseRetries\(\(current\) => \[\.\.\.current, retry\]\);/, 'a failed case is added to the waiting retries, never replacing one');
  assert.doesNotMatch(source, /\bsetLeadRetry\(|\bsetCaseRetry\(|leadRetryRef|caseRetryRef/, 'no single-slot retry is left');
  assert.match(source, /leadRetriesRef\.current = \[\];\s*caseRetriesRef\.current = \[\];\s*setLeadRetries\(\[\]\);\s*setCaseRetries\(\[\]\);\s*setLeadSheetRetry\(null\);\s*setCaseFormRetry\(null\);/, 'an account or workspace change drops every waiting retry');
}

// ─── Round 13: reopening a case reads back its restored steps ──────────────
// The server puts back the steps a close skipped whichever way the case is
// reopened, including Done -> a new status on a closed case's check-in; and a
// refresh already running when the reopen lands keeps nothing it read
// (changed meanwhile), so the read-back runs after it, not inside it.
{
  const statusBody = source.slice(source.indexOf('function changeCaseStatus('), source.indexOf('function saveCasePayment('));
  assert.match(statusBody, /if \(saved && reopening\) readBackReopenedCase\(\);/, 'a reopen from the status picker reads its steps back');
  const closeLoopBody = source.slice(source.indexOf('function closeLoopWithStatus('), source.indexOf('function confirmNextStep('));
  assert.match(closeLoopBody, /const reopening = inactive\(record\.status\) && !inactive\(updatedCase\.status\);/, 'closing the loop knows when it reopens the case');
  assert.match(closeLoopBody, /if \(!saved\) return;\s*if \(reopening\) readBackReopenedCase\(\);/, 'a reopen from Done reads its steps back');
  const readBack = source.slice(source.indexOf('function readBackReopenedCase()'), source.indexOf('function saveCasePayment('));
  assert.match(readBack, /const running = refreshInFlightRef\.current;\s*void \(running \? running\.catch\(\(\) => 'ok' as const\) : Promise\.resolve\('ok' as const\)\)/, 'the read-back waits for a refresh already running');
  assert.match(readBack, /if \(activeUserIdRef\.current !== userId \|\| authGenerationRef\.current !== generation\) return 'ok' as const;\s*return refreshFromServer\('pull'\);/, 'the read-back never runs for another account');
}

// ─── Final check: the build against today's production schema ───────────────
{
  const casesSource = await readFile(new URL('../src/lib/cases.ts', import.meta.url), 'utf8');
  assert.match(casesSource, /if \(errorCode\(error\) === '23505' && \/cases_pkey\/\.test\(error\.message\)\) \{[\s\S]{0,200}\.from\('cases'\)\.select\('id'\)\.eq\('id', caseId\)\.eq\('org_id', orgId\)/, 'a same-id retry of a create that landed succeeds before the migration');
  for (const rpc of ['create_case_bundle', 'create_lead']) {
    assert.match(casesSource, new RegExp(`await createOnce\\([^,]+, \\(\\) => supabase\\.rpc\\('${rpc}'`), `${rpc} goes through createOnce`);
  }
  assert.match(casesSource, /\.from\('case_contacts'\)\.update\(\{ relationship: callerSide \}\)\.eq\('id', input\.contactId\)\.eq\('relationship', about\)/, 'a lead caller gets their own relationship before the migration does it');
  const accountSource = await readFile(new URL('../src/lib/account.ts', import.meta.url), 'utf8');
  const order = ['prepare_account_deletion', 'if (prepareError && removeWorkspaceFiles) await checkBeforeRemovingFiles(userId);', 'await removeWorkspaceCaseFiles();', "supabase.rpc('delete_own_account')"].map((needle) => accountSource.indexOf(needle));
  assert.ok(order.every((at) => at >= 0) && order.every((at, i) => i === 0 || at > order[i - 1]), 'without the preflight, the old-server checks run before any file is removed');
}

console.log('optimistic mutation serialization/dependency invariants: ok');
