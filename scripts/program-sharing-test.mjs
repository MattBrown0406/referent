import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const dir = path.resolve('node_modules/.cache/program-sharing-test');
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, 'sharing.cjs'), ts.transpileModule(readFileSync('src/lib/program-sharing.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText);
const { publicProgramDraft, programPayload, programIdentity, potentialProgramMatch } = require(path.join(dir, 'sharing.cjs'));
const partner = {
  id: 'private-id', name: 'Private contact', organization: 'Harbor & Hope', city: 'Bend', state: 'OR',
  phone: 'private-phone', email: 'private-email', website: 'https://example.test', type: 'Inpatient',
  insurance: ['Aetna'], insuranceNetworks: { Aetna: ['In-network'] }, therapies: ['CBT'], populations: ['Adults'], levels: ['Residential'], regions: ['West'],
  monthlyCost: 9876, note: 'Private case details', inbound: 42, outbound: 13, owner_id: 'private-user', cases: [{ title: 'Private client' }],
};
const draft = publicProgramDraft(partner);
assert.equal(draft.phone, ''); assert.equal(draft.email, '');
const payload = programPayload({ ...partner, ...draft });
for (const key of ['id', 'name', 'monthlyCost', 'note', 'inbound', 'outbound', 'owner_id', 'cases']) assert.ok(!(key in payload), key);
assert.ok(!JSON.stringify(payload).includes('Private'));
draft.insurance.push('Other'); draft.insurance_networks.Aetna.push('Out-of-network');
assert.deepEqual(partner.insurance, ['Aetna']); assert.deepEqual(partner.insuranceNetworks.Aetna, ['In-network']);
assert.equal(programIdentity(' Harbor & Hope ', ' Bend ', 'or'), programIdentity('HARBOR AND HOPE!', 'Bend', 'OR'));
assert.notEqual(programIdentity('Harbor & Hope', 'Bend', 'OR'), programIdentity('Harbor & Hope', 'Salem', 'OR'));
assert.equal(programIdentity('!!!', 'Bend', 'OR'), null);
assert.equal(programIdentity('Real program', '—', 'OR'), null);
assert.equal(potentialProgramMatch(partner, { ...partner, organization: 'Alternative name' }), true);
assert.equal(potentialProgramMatch(partner, { ...partner, organization: 'Alternative name', city: 'Salem' }), false);
console.log('PASS public field boundary, isolated draft copies, normalized dedupe, and campus-aware suggestions');
