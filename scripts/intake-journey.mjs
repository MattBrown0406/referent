// Release smoke for the two family forms, using a disposable local Supabase stack.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright-core';

const config = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8' }));
assert.equal(config.API_URL, 'http://127.0.0.1:55421', 'Run against the local referent test stack');
const key = config.PUBLISHABLE_KEY || config.ANON_KEY;
const auth = { persistSession: false, autoRefreshToken: false };
const admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth });
const practice = createClient(config.API_URL, key, { auth });
// Metro binds the address localhost resolves to, including ::1 on Ubuntu.
const appOrigin = 'http://localhost:3320';
const siteOrigin = 'http://127.0.0.1:3310';
const functionBase = config.API_URL + '/functions/v1/intake';
const website = process.argv[2];
const servers = [];

async function start(cwd, cli, args, env, origin) {
  const server = spawn(process.execPath, [resolve(cwd, cli), ...args], {
    cwd, env: { ...process.env, CI: '1', BROWSER: 'none', ...env }, stdio: 'inherit',
  });
  servers.push(server);
  for (let attempt = 0; attempt < 120; attempt++) {
    assert.equal(server.exitCode, null, `Could not start ${origin}`);
    const response = await fetch(origin, { signal: AbortSignal.timeout(3000) }).catch(() => null);
    if (response) {
      await response.body?.cancel();
      if (response.ok) return;
    }
    await sleep(500);
  }
  throw new Error(`Timed out starting ${origin}`);
}

function data(result) {
  if (result.error) throw result.error;
  return result.data;
}

const id = randomUUID();
const email = `intake-${id}@example.test`;
const password = randomUUID() + 'aA1!';
const caller = 'Release check ' + id.slice(0, 8);
let browser;
let signedIn = false;
try {
  data(await admin.auth.admin.createUser({ email, password, email_confirm: true }));
  data(await practice.auth.signInWithPassword({ email, password }));
  signedIn = true;
  const org = data(await practice.from('orgs').select('id,intake_token').single());
  await start('.', 'node_modules/expo/bin/cli',
    ['start', '--web', '--localhost', '--port', '3320', '--max-workers', '2'],
    { EXPO_OFFLINE: '1', EXPO_PUBLIC_SUPABASE_URL: config.API_URL, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key }, appOrigin);
  if (website) {
    await start(website, 'node_modules/next/dist/bin/next', ['dev', '--hostname', '127.0.0.1', '--port', '3310'],
      { NEXT_TELEMETRY_DISABLED: '1', NEXT_PUBLIC_INTAKE_BASE_URL: functionBase }, siteOrigin);
  }

  browser = await chromium.launch(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : { channel: 'chrome' });
  const family = await browser.newPage();
  family.setDefaultTimeout(90_000);
  await family.goto((website ? siteOrigin + '/intake' : functionBase) + '/' + org.intake_token);
  await family.getByLabel('Your name', { exact: true }).fill(caller);
  await family.getByLabel('Your phone number').fill('2025550146');
  await family.getByRole('button', { name: /to call me/i }).click();
  await family.getByRole('heading', { name: /Thank you/i }).waitFor();
  await family.close();

  // Read as the practice, after the Edge Function's transaction has committed.
  const leads = data(await practice.from('cases').select('id,title,lead_channel').eq('org_id', org.id));
  assert.equal(leads.length, 1, 'Exactly one lead in the new workspace');
  assert.equal(leads[0].title, caller);
  assert.equal(leads[0].lead_channel, 'intake_link');
  const contacts = data(await practice.from('case_contacts').select('name,is_primary,phone').eq('case_id', leads[0].id));
  assert.deepEqual(contacts, [{ name: caller, is_primary: true, phone: '2025550146' }]);
  const calls = data(await practice.from('follow_ups').select('kind,status').eq('case_id', leads[0].id));
  assert.deepEqual(calls, [{ kind: 'first_call', status: 'open' }]);

  const app = await browser.newPage();
  app.setDefaultTimeout(120_000);
  await app.goto(appOrigin);
  await app.getByPlaceholder('you@yourpractice.com').fill(email);
  await app.getByPlaceholder('Your password').fill(password);
  await app.getByPlaceholder('Your password').press('Enter');
  await app.getByText('Got it', { exact: true }).click();
  // A real click also catches any second onboarding sheet covering Today.
  await app.getByRole('button', { name: 'Call — ' + caller, exact: true }).click();
  await app.getByText('I called', { exact: true }).waitFor();
  console.log('Family submission committed one lead, one primary contact and one first call accessible from Today.');
} finally {
  await browser?.close();
  for (const server of servers) server.kill('SIGTERM');
  if (signedIn) data(await practice.rpc('delete_own_account'));
}
