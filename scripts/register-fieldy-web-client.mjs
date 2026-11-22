// Registers ReferralFit's web app with Fieldy, once (docs/DAY_REVIEW.md,
// "Fieldy on the web"). Run only after Matt's OK: it creates an OAuth client
// at Fieldy (dynamic client registration, RFC 7591), as was done for the
// iPhone app on 2026-11-08.
//
//   node scripts/register-fieldy-web-client.mjs          prints the request, sends nothing
//   node scripts/register-fieldy-web-client.mjs --send   registers, and prints the client id
//   add --no-local                                       only https://app.referralfit.com
//
// Then paste the printed client id into FIELDY_WEB_CLIENT_ID in
// src/lib/fieldy.ts. A public client (no secret, PKCE), like the phone's:
// nothing here is secret, and nothing is written to disk.

import { readFileSync } from 'node:fs';

// The returns the web app uses, read from src/lib/fieldy.ts (one list for both).
const source = readFileSync(new URL('../src/lib/fieldy.ts', import.meta.url), 'utf8');
const listed = /export const FIELDY_WEB_REDIRECTS = \[([^\]]*)\]/.exec(source)?.[1] ?? '';
const FIELDY_WEB_REDIRECTS = [...listed.matchAll(/'([^']+)'/g)].map((match) => match[1]);
if (!FIELDY_WEB_REDIRECTS.includes('https://app.referralfit.com/oauth/fieldy')) throw new Error('FIELDY_WEB_REDIRECTS not found in src/lib/fieldy.ts');

const ISSUER = 'https://api.fieldy.ai/api/auth';
const send = process.argv.includes('--send');
const local = !process.argv.includes('--no-local');

const redirects = FIELDY_WEB_REDIRECTS.filter((uri) => local || uri.startsWith('https://'));

const metadata = {
  client_name: 'ReferralFit (web)',
  client_uri: 'https://referralfit.com',
  redirect_uris: redirects,
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
  application_type: 'web',
  scope: 'openid email offline_access conversations:read transcripts:read',
};

async function main() {
  // The registration endpoint is read from Fieldy's own discovery document, never assumed.
  const discovery = await fetch('https://api.fieldy.ai/.well-known/oauth-authorization-server').then((response) => response.json());
  if (discovery.issuer !== ISSUER || typeof discovery.registration_endpoint !== 'string'
    || !discovery.registration_endpoint.startsWith('https://api.fieldy.ai/')) {
    throw new Error(`Fieldy's discovery document is not what was expected (issuer ${discovery.issuer}).`);
  }
  console.log(`POST ${discovery.registration_endpoint}`);
  console.log(JSON.stringify(metadata, null, 2));
  if (!send) {
    console.log('\nNothing was sent. Run again with --send (after Matt\'s OK) to register.');
    return;
  }
  const response = await fetch(discovery.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(metadata),
  });
  const text = await response.text();
  let answer;
  try { answer = JSON.parse(text); } catch { answer = { raw: text.slice(0, 500) }; }
  if (!response.ok || typeof answer.client_id !== 'string') {
    console.error(`Fieldy did not register the client (HTTP ${response.status}):`, answer);
    if (local) console.error('If it refused the http://localhost returns, run again with --no-local.');
    process.exit(1);
  }
  if (answer.client_secret) console.warn('Fieldy sent a client secret: it is not used (the web app is a public client). Do not commit it.');
  console.log(`\nRegistered. Paste this into FIELDY_WEB_CLIENT_ID in src/lib/fieldy.ts:\n\n  ${answer.client_id}\n`);
  console.log(`Redirects registered: ${(answer.redirect_uris || redirects).join(', ')}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
