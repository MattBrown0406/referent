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
  'The payment change', 'The case summary', 'The case contact',
  'The completed step and its next step', 'The follow-up and case status',
  'The next step', 'The contact log', 'The contact note', 'The follow-up',
  'The follow-up change', 'The outcome', 'The partner', 'The referral',
  'The touch', 'The favorite change', 'The contact removal',
]) {
  assert.ok(source.includes(`mutationSlotAvailable('${label}')`), `missing pre-optimistic mutation guard: ${label}`);
}

for (const operation of [
  'completeFollowUpWithNext', 'completeFollowUpWithCase',
  'completeFollowUpWithOutcome', 'finalizeMatchPacket',
]) {
  assert.match(source, new RegExp(`\\(\\) => ${operation}\\(`), `${operation} must be deferred until after the mutation/session fence`);
}
assert.match(source, /\(\) => assignedMatch\s*\? assignMatchReferral\(/, 'assignMatchReferral must be deferred until after the mutation/session fence');

console.log('optimistic mutation serialization/dependency invariants: ok');
