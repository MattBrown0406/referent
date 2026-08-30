// Deterministic fixture tests for the pure, approval-first voice parser.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'voice-test');
const require = createRequire(import.meta.url);
const ts = require(path.join(repoRoot, 'node_modules', 'typescript'));

const source = readFileSync(path.join(repoRoot, 'src/lib/voice.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
mkdirSync(tmpDir, { recursive: true });
writeFileSync(path.join(tmpDir, 'voice.js'), js);
const { parseVoiceTranscript } = require(path.join(tmpDir, 'voice.js'));

let failures = 0;
function eq(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `\n  got:  ${JSON.stringify(actual)}\n  want: ${JSON.stringify(expected)}`}`);
}
function check(label, condition, detail = '') {
  const pass = Boolean(condition);
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass || !detail ? '' : ` — ${detail}`}`);
}

const partners = [
  { id: 'p-river', name: 'Sarah Ellison', organization: 'Riverstone Recovery' },
  { id: 'p-cascade', name: 'Mike Rhee', organization: 'Cascade Detox' },
  { id: 'p-sarah', name: 'Sarah Kim', organization: 'Northstar Health' },
];
const FRIDAY = new Date(2026, 6, 24, 23, 30, 0); // local calendar date; time must not cause UTC shifting

console.log('— partner and touch suggestions —');
let draft = parseVoiceTranscript(
  'Called Sarah Ellison at Riverstone Recovery today. She will send the updated intake packet. Follow up tomorrow at 2:30 PM.',
  partners,
  FRIDAY,
);
eq('exact partner suggestion',
  { id: draft.partnerId, name: draft.partnerName, confidence: draft.partnerConfidence },
  { id: 'p-river', name: 'Sarah Ellison', confidence: 'high' });
eq('call kind', draft.touchKind, 'call');
eq('follow-up date/time', draft.followUp && { dueOn: draft.followUp.dueOn, dueTime: draft.followUp.dueTime },
  { dueOn: '2026-07-25', dueTime: '14:30' });
check('note keeps the meaningful update', draft.note.includes('She will send the updated intake packet'), draft.note);
check('follow-up command is removed from note', !/follow up tomorrow/i.test(draft.note), draft.note);
eq('approval-first flags', { approvalRequired: draft.approvalRequired, autoSave: draft.autoSave },
  { approvalRequired: true, autoSave: false });
check('raw transcript is not returned', !Object.prototype.hasOwnProperty.call(draft, 'transcript'));

draft = parseVoiceTranscript('Texted Cascade Detox about bed availability.', partners, FRIDAY);
eq('organization-only exact match', [draft.partnerId, draft.partnerConfidence, draft.touchKind], ['p-cascade', 'high', 'text']);
eq('organization wording alone is not treated as sensitive clinical detail', draft.warnings, []);

draft = parseVoiceTranscript('Emailed Sarah about the packet.', partners, FRIDAY);
eq('ambiguous first name is not linked', [draft.partnerId, draft.partnerName, draft.partnerConfidence], [undefined, undefined, 'none']);
eq('email kind', draft.touchKind, 'email');

draft = parseVoiceTranscript('Spoke with an intake coordinator about placement options.', partners, FRIDAY);
eq('generic role does not invent a partner', [draft.partnerId, draft.partnerConfidence], [undefined, 'none']);

console.log('\n— local relative date parsing —');
const dateCases = [
  ['today', '2026-07-24'],
  ['tomorrow', '2026-07-25'],
  ['Friday', '2026-07-31'],
  ['Wednesday', '2026-07-29'],
  ['in 3 days', '2026-07-27'],
  ['in 2 weeks', '2026-08-07'],
  ['next week', '2026-07-31'],
];
for (const [phrase, dueOn] of dateCases) {
  const parsed = parseVoiceTranscript(`Met with Mike Rhee. Follow up ${phrase}.`, partners, FRIDAY);
  eq(phrase, parsed.followUp?.dueOn, dueOn);
}

draft = parseVoiceTranscript('Meeting with Riverstone Recovery. Follow up next week at noon.', partners, FRIDAY);
eq('meeting + noon', [draft.touchKind, draft.followUp?.dueTime], ['meeting', '12:00']);

draft = parseVoiceTranscript('Left Mike Rhee a voicemail. Call him in 1 week at 9 AM.', partners, FRIDAY);
eq('imperative call creates follow-up', draft.followUp,
  { title: 'Call Mike Rhee', dueOn: '2026-07-31', dueTime: '09:00' });

console.log('\n— note cleanup, warnings, and empty input —');
draft = parseVoiceTranscript('Called Riverstone Recovery. Their client has bipolar disorder and his daughter reported an overdose. Follow up Monday.', partners, FRIDAY);
check('clinical warning', draft.warnings.some((warning) => warning.code === 'possible-clinical-detail'));
check('family warning', draft.warnings.some((warning) => warning.code === 'possible-family-detail'));
check('warning tells UI not to place detail in ledger', draft.warnings.every((warning) => /referral ledger/i.test(warning.message)));
check('sensitive meaning remains editable rather than silently deleted', /bipolar disorder/i.test(draft.note));

draft = parseVoiceTranscript('   ', partners, FRIDAY);
eq('empty input is safe', draft, {
  partnerConfidence: 'none', touchKind: 'other', note: '', warnings: [], approvalRequired: true, autoSave: false,
});

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
