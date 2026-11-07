// The web app (docs/WEB_APP.md): source checks for what makes the Expo app
// safe and usable in a browser. Runs in plain node.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// Alerts and Share are replaced before the app renders, only on the web.
const index = read('index.ts');
assert.ok(index.indexOf('installWebAlert();') < index.indexOf('registerRootComponent('), 'web alerts installed before the app starts');
assert.ok(index.indexOf('installWebShare();') < index.indexOf('registerRootComponent('), 'web share installed before the app starts');
assert.match(index, /registerRootComponent\(Platform\.OS === 'web' \? WebRoot : App\)/);
const alert = read('src/lib/web-alert.tsx');
assert.match(alert, /if \(Platform\.OS !== 'web' \|\| installed\) return;/);
assert.match(alert, /if \(!current \|\| handledRef\.current === current\.id\) return;/, 'a dialog runs one button action at most');
assert.match(alert, /button\.style !== 'cancel' && button\.style !== 'destructive'/, 'Enter never presses a destructive button');
assert.match(alert, /if \(current\.buttons\.length > 2\) return;/, 'a list of choices has no Enter default');
assert.match(alert, /if \(event\.key === 'Tab'\) \{ tabbedRef\.current = true; return; \}[\s\S]{0,400}if \(onButton && tabbedRef\.current\) return;/,
  'Enter follows a focused button only when the person tabbed to it (never the dialog\'s own first focus)');
assert.match(read('src/lib/web-share.ts'), /if \(Platform\.OS !== 'web' \|\| installed\) return;/);

// A browser never logs a call or text it could not make.
const phone = read('src/lib/phone-actions.ts');
assert.match(phone, /if \(Platform\.OS === 'web'\) \{[\s\S]*?'I called' : 'I texted'/);
const app = read('App.tsx');
assert.equal((app.match(/Linking\.openURL\(`?(tel|sms):/g) || []).length, 1, 'only the partner card opens tel: directly (behind IS_WEB)');
assert.match(app, /else if \(IS_WEB\) Alert\.alert\(`Call \$\{selectedPartner\.organization\}`/);

// Signing out of a browser leaves none of the practice's data behind.
const signOut = app.slice(app.indexOf('function confirmSignOut()'), app.indexOf('function renderHeader('));
assert.match(signOut, /if \(IS_WEB && userId\) \{(\s*\/\/[^\n]*\n)+\s*await flushWriteQueue\(userId\)\.catch\(\(\) => undefined\);\s*await wipeAccountDataWithoutSession\(userId\);/,
  'sign-out removes the data with no session needed, and says so if it cannot');
assert.ok(signOut.indexOf('wipeAccountDataWithoutSession(userId)') < signOut.indexOf("supabase.auth.signOut({ scope: 'local' })"), 'data goes before the session');
assert.ok(!app.includes('supabase.auth.signOut()'), 'signing out ends this device\'s session only, never the phone\'s');
// ...and a session that ended any other way does the same.
assert.match(app, /resetAccountState\(\);\s*(\/\/[^\n]*\n\s*)+if \(IS_WEB\) \{\s*void wipeAccountDataWithoutSession\(userId\)/,
  'signed out elsewhere, revoked, or another account: the browser keeps practice data only for the account signed in now');

// System notifications are never touched in a browser.
const notifications = read('src/lib/notifications.ts');
assert.match(notifications, /async function clearSystemNotifications\(\): Promise<void> \{\s*if \(Platform\.OS === 'web'\) return;/);

// Release builds always use production; only a development build reads the local-stack overrides.
const supabase = read('src/lib/supabase.ts');
assert.match(supabase, /const DEV_BUILD = typeof __DEV__ !== 'undefined' && __DEV__;/);
assert.match(supabase, /const LOCAL_URL = DEV_BUILD \? process\.env\.EXPO_PUBLIC_SUPABASE_URL : undefined;/);

// Hosting: one page app, never framed, not indexed.
const vercel = JSON.parse(read('vercel.json'));
assert.equal(vercel.outputDirectory, 'dist');
assert.deepEqual(vercel.rewrites, [{ source: '/(.*)', destination: '/index.html' }]);
const headers = Object.fromEntries(vercel.headers.find((rule) => rule.source === '/(.*)').headers.map((h) => [h.key, h.value]));
assert.equal(headers['X-Frame-Options'], 'DENY');
assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/);
assert.equal(headers['Referrer-Policy'], 'no-referrer');
assert.match(headers['X-Robots-Tag'], /noindex/);
assert.equal(JSON.parse(read('app.json')).expo.web.output, 'single');

console.log('web app checks: ok');
