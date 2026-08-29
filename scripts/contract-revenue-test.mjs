import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [panel, dashboard, business, appSource, loginSource, appConfig, icon] = await Promise.all([
  readFile(new URL('../src/lib/CaseIntegrationPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/BusinessDashboard.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/business.ts', import.meta.url), 'utf8'),
  readFile(new URL('../App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/LoginScreen.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../app.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../assets/icon-referent-symbiosis.png', import.meta.url)),
]);

assert.match(panel, /PROPOSED CONTRACT AMOUNT \(OPTIONAL\)/, 'PandaDoc contracts must expose a proposed amount field.');
assert.match(panel, /accessibilityLabel=\{form\.provider === 'pandadoc' \? 'Proposed contract amount'/, 'The amount field needs an accessible contract-specific label.');
assert.match(panel, /id: form\.id/, 'Editing an existing integration must persist by its existing ID.');
assert.match(panel, /function beginEdit\(item: CaseIntegration\)/, 'Existing linked contracts must be editable.');
assert.match(panel, /Save changes/, 'The edit form must have a clear save action.');
assert.match(panel, /editable=\{!form\.id\}/, 'An existing external record ID must be locked while editing.');
assert.match(panel, /parseOptionalPositiveUsdCents\(form\.amount\)/, 'Amount entry must use the tested strict US currency parser.');
assert.match(business, /pendingContractRevenue: pendingContractRecords\.reduce/, 'Dashboard metrics must total open proposed contract amounts.');
assert.match(dashboard, /PENDING CONTRACT REVENUE/, 'The dashboard must display pending contract revenue.');
assert.match(dashboard, /formatMoney\(metrics\.pendingContractRevenue\)/, 'Pending revenue must be currency formatted.');
assert.equal(appConfig.expo.icon, './assets/icon-referent-symbiosis.png', 'Expo must use the new symbiosis icon.');
assert.equal(appConfig.expo.web.favicon, './assets/icon-referent-symbiosis.png', 'Web must use the same new icon.');
assert.match(appSource, /require\('\.\/assets\/icon-referent-symbiosis\.png'\)/, 'The signed-in app header must use the new logo.');
assert.match(loginSource, /require\('\.\.\/\.\.\/assets\/icon-referent-symbiosis\.png'\)/, 'The login screen must use the new logo.');
assert.doesNotMatch(appSource, /Fit Point logo/, 'Retired in-app icon wording must be removed.');
assert.doesNotMatch(loginSource, /Fit Point logo/, 'Retired login icon wording must be removed.');

assert.equal(icon.toString('ascii', 1, 4), 'PNG', 'App icon must be a PNG.');
assert.equal(icon.readUInt32BE(16), 1024, 'App icon width must be 1024.');
assert.equal(icon.readUInt32BE(20), 1024, 'App icon height must be 1024.');
assert.equal(icon[25], 2, 'App icon must be opaque RGB without an alpha channel.');

console.log('Contract pending-revenue and app-icon contract: PASS');
