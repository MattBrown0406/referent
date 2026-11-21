// Share to ReferralFit and voice notes (docs/DAY_REVIEW.md, "Share to
// ReferralFit and voice notes, as built"): the rules in src/lib/share-intake.ts,
// and the wiring that keeps a share from ever being sent on its own, from
// replacing typed notes, or from opening in another account, and keeps the
// native modules away from builds and platforms that lack them.
// Run with: node scripts/share-voice-test.mjs

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(repoRoot, 'node_modules', '.cache', 'share-voice-test');
const require = createRequire(import.meta.url);
const ts = require(path.join(repoRoot, 'node_modules', 'typescript'));
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

function load(relSrc, outName) {
  const js = ts.transpileModule(read(relSrc), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const outPath = path.join(tmpDir, outName);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, js);
  return require(outPath);
}

let checks = 0;
const check = (fn, label) => {
  try { fn(); } catch (error) { console.error(`FAIL ${label || ''}`); throw error; }
  checks += 1;
};

const intake = load('src/lib/share-intake.ts', 'share-intake.js');

// ─── The cap is the review's own ───────────────────────────────────────────
check(() => {
  const review = read('supabase/functions/day-review/review.ts');
  const max = Number(/textMax:\s*([\d_]+)/.exec(review)[1].replace(/_/g, ''));
  assert.equal(intake.REVIEW_TEXT_MAX, max, 'the share cap is the day-review function\'s input cap');
}, 'cap matches the function');

// ─── What a share puts in the box ──────────────────────────────────────────
check(() => {
  const note = intake.sharedNote({ type: 'text', text: '  Called Dana about her son.\r\nShe wants a call back Friday.  ', webUrl: null, meta: {} });
  assert.deepEqual(note, { text: 'Called Dana about her son.\nShe wants a call back Friday.', trimmed: false, kind: 'text' });
}, 'plain text, cleaned, no made-up source line');

check(() => {
  const note = intake.sharedNote({ type: 'text', text: 'Left a voicemail\u0000 for Harbor Light\u0007.', webUrl: null });
  assert.equal(note.text, 'Left a voicemail for Harbor Light.', 'control characters removed');
}, 'control characters');

check(() => {
  const note = intake.sharedNote({ type: 'weburl', text: 'https://docs.example.com/notes', webUrl: 'https://docs.example.com/notes', meta: { title: 'Call notes, Nov 21' } });
  assert.equal(note.kind, 'link');
  assert.equal(note.text, 'Shared link: Call notes, Nov 21\nhttps://docs.example.com/notes');
  const bare = intake.sharedNote({ type: 'weburl', text: null, webUrl: 'https://example.com/a', meta: null });
  assert.equal(bare.text, 'Shared link:\nhttps://example.com/a');
  assert.match(intake.sharedNoteMessage(note, { appended: false, totalLength: note.text.length }), /not the page the link opens/);
}, 'a link says the page is not read');

check(() => {
  const note = intake.sharedNote({ type: 'weburl', text: 'Mom called, see https://example.com/x for the form', webUrl: 'https://example.com/x' });
  assert.equal(note.kind, 'text', 'text with a link in it is text');
  assert.equal(note.text, 'Mom called, see https://example.com/x for the form');
}, 'text containing a link');

check(() => {
  const note = intake.sharedNote({ type: 'file', files: [{ path: 'file:///x/1.txt', mimeType: 'text/plain', fileName: 'Call.txt', size: 40 }] }, [{ name: 'Call.txt', text: 'Spoke with the program director.' }]);
  assert.deepEqual(note, { text: 'Shared from Call.txt:\nSpoke with the program director.', trimmed: false, kind: 'file' });
  assert.equal(intake.sharedNote({ type: 'media', files: [{ path: 'file:///x/1.jpg', mimeType: 'image/jpeg', fileName: 'a.jpg' }] }, []), null, 'a photo gives nothing');
  assert.equal(intake.sharedNote({ type: 'text', text: '   ' }), null, 'blank gives nothing');
  assert.equal(intake.sharedNote(null), null);
}, 'files');

check(() => {
  assert.equal(intake.isTextFile({ path: 'file:///a.txt', mimeType: null, fileName: 'a.txt', size: 10 }), true);
  assert.equal(intake.isTextFile({ path: 'file:///a', mimeType: 'text/plain; charset=utf-8', fileName: null, size: 10 }), true);
  assert.equal(intake.isTextFile({ path: 'file:///a.pdf', mimeType: 'application/pdf', fileName: 'a.pdf', size: 10 }), false);
  assert.equal(intake.isTextFile({ path: 'file:///a.txt', mimeType: 'text/plain', fileName: 'a.txt', size: intake.SHARED_FILE_MAX_BYTES + 1 }), false, 'a huge file is not read');
  assert.equal(intake.isTextFile({ path: null, fileName: 'a.txt' }), false);
}, 'which files are read');

check(() => {
  const long = `${'word '.repeat(3000)}end`; // 15,003 characters
  const note = intake.sharedNote({ type: 'text', text: long });
  assert.equal(note.trimmed, true);
  assert.ok(note.text.length <= intake.REVIEW_TEXT_MAX, 'capped');
  assert.ok(note.text.length > intake.REVIEW_TEXT_MAX - 300, 'cut near the cap');
  assert.ok(note.text.endsWith('word'), 'cut at a word');
  const message = intake.sharedNoteMessage(note, { appended: false, totalLength: note.text.length });
  assert.match(message, /Only the first 12,000 characters were kept/);
  const noSpaces = intake.capForReview('x'.repeat(13_000));
  assert.equal(noSpaces.text.length, intake.REVIEW_TEXT_MAX, 'a run with no spaces is cut at the cap');
}, 'long shares are cut and say so');

check(() => {
  assert.equal(intake.appendToNotes('', 'Shared'), 'Shared');
  assert.equal(intake.appendToNotes('   \n', 'Shared'), 'Shared');
  assert.equal(intake.appendToNotes('My notes  \n', 'Shared'), 'My notes\n\nShared', 'below typed notes, never replacing them');
  const message = intake.sharedNoteMessage({ kind: 'text', trimmed: false }, { appended: true, totalLength: 12_500 });
  assert.match(message, /below the notes that were already there/);
  assert.match(message, /more than one review reads/);
}, 'appending');

check(() => {
  const a = { type: 'text', text: 'Same', webUrl: null, files: null };
  assert.equal(intake.shareKey(a), intake.shareKey({ ...a }), 'the same share twice has one key');
  assert.notEqual(intake.shareKey(a), intake.shareKey({ ...a, text: 'Other' }));
}, 'duplicate key');

// ─── Wiring ────────────────────────────────────────────────────────────────
const app = read('App.tsx');
const sheet = read('src/lib/DayReviewSheet.tsx');
const receiver = read('src/lib/share-receiver.ts');
const voice = read('src/lib/voice-note.ts');
const appJson = JSON.parse(read('app.json'));
const pkg = JSON.parse(read('package.json'));

check(() => {
  // A JS update reaching an older build, or the web app, never loads the native code.
  for (const [file, text] of [['App.tsx', app], ['DayReviewSheet.tsx', sheet], ['share-receiver.ts', receiver], ['voice-note.ts', voice]]) {
    assert.doesNotMatch(text, /^import (?!type )[^;]*from 'expo-share-intent'/m, `${file}: expo-share-intent is only required lazily`);
    assert.doesNotMatch(text, /^import (?!type )[^;]*from 'expo-speech-recognition'/m, `${file}: expo-speech-recognition is never imported (its import needs the native module)`);
    assert.doesNotMatch(text, /^import (?!type )[^;]*from 'expo-linking'/m, `${file}: expo-linking only through expo-share-intent`);
  }
  assert.match(receiver, /Platform\.OS !== 'ios' \|\| !requireOptionalNativeModule\('ExpoShareIntentModule'\) \|\| !requireOptionalNativeModule\('ExpoLinking'\)/, 'share hook only with both native modules');
  assert.match(voice, /if \(Platform\.OS !== 'ios'\) return null;[\s\S]{0,80}requireOptionalNativeModule<SpeechNative>\('ExpoSpeechRecognition'\)/, 'voice only on iOS with the module');
  assert.match(receiver, /resetOnBackground: false/, 'a Face ID prompt or a trip to Settings does not drop a share');
  assert.match(receiver, /FileSystem\.deleteAsync\(file\.path!/, 'shared file copies are deleted');
}, 'native modules are optional');

check(() => {
  // The share never reaches the AI by itself: the sheet puts it in the box and stops.
  const effect = /Text shared from another app: into the box[\s\S]*?\}, \[visible, incomingShare, openReady, phase, voiceActive\]\);/.exec(sheet)?.[0] || '';
  assert.ok(effect, 'the incoming-share effect');
  assert.doesNotMatch(effect, /find\(|requestDayReview|approve\(/, 'no Find, no review, no save from a share');
  assert.match(effect, /appendToNotes\(before, incomingShare\.text\)/, 'appended, not replacing');
  assert.match(effect, /if \(phase === 'review'\)[\s\S]{0,400}return;/, 'a review on screen keeps it until it is done');
  assert.match(effect, /voiceActive\) return;/, 'not while a voice note writes the box');
  assert.match(effect, /onIncomingShareTaken\?\.\(incomingShare\.id\)/, 'App lets it go once it is in the box');
  assert.match(sheet, /setKeyState\(key \? 'ready' : 'missing'\);\s*setOpenReady\(true\);/, 'taken only once the opening has read the key (and started a recorder read)');
  assert.match(sheet, /disabled=\{busy \|\| voiceActive \|\| keyMissing \|\| keyState === 'checking'\}/, 'Find waits for the voice note to stop');
  assert.match(sheet, /editable=\{!busy && !voiceActive\}/, 'the box is not edited while the voice note writes it');
}, 'sheet wiring');

check(() => {
  assert.match(app, /useIncomingShare\(\(payload: SharedPayload\) => \{/, 'App receives shares');
  assert.match(app, /lastShareRef\.current\.key === key && now - lastShareRef\.current\.at < 60_000\) return;/, 'a share delivered twice is one');
  assert.match(app, /const userId = account\.resolved \? account\.userId : null;/, 'a share belongs to the account signed in when it came');
  assert.match(app, /setPendingShares\(\(current\) => \[\.\.\.current, \{ \.\.\.note, id, userId \}\]\);/, 'a second share before the first is taken waits its turn (never replaces it)');
  assert.match(app, /onIncomingShareTaken=\{\(id\) => setPendingShares\(\(current\) => current\.filter\(\(share\) => share\.id !== id\)\)\}/, 'only the one taken is let go');
  assert.match(app, /if \(pendingShare\.userId && pendingShare\.userId !== userId\) \{[\s\S]{0,160}setPendingShares\(\(current\) => current\.filter\(\(share\) => !share\.userId \|\| share\.userId === userId\)\);/, 'never opened in another account');
  assert.match(app, /if \(anySheetOpenRef\.current \|\| overlayOpen\(\)\) \{[\s\S]{0,400}setShowDayReview\(true\);/, 'waits for a clear screen, like a notification tap');
  assert.match(app, /incomingShare=\{pendingShare && pendingShare\.userId !== null && pendingShare\.userId !== activeUserId \? null : pendingShare\}/, 'the sheet gets it only for its own account');
  assert.match(app, /if \(!userId\) \{[\s\S]{0,400}Sign in to review it/, 'signed out: it waits and says so');
}, 'app wiring');

check(() => {
  // The auth deep-link handler ignores the share extension's URL (no tokens, no code).
  const flows = load('src/lib/auth-flows.ts', 'auth-flows.js');
  assert.equal(flows.parseAuthRedirect('referralfit://dataUrl=referralfitShareKey?nonce=1F2E#text'), null);
  assert.equal(flows.parseAuthRedirect('referralfit://dataUrl=referralfitShareKey?nonce=1F2E#weburl'), null);
}, 'no collision with auth links');

check(() => {
  const share = appJson.expo.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-share-intent');
  assert.ok(share, 'the share extension plugin');
  assert.deepEqual(share[1].iosActivationRules, { NSExtensionActivationSupportsText: true, NSExtensionActivationSupportsWebURLWithMaxCount: 1 }, 'text and links only: no photos, videos or other files');
  assert.equal(share[1].disableAndroid, true, 'no Android changes (the app is iPhone and iPad only)');
  const names = appJson.expo.plugins.map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));
  assert.ok(names.indexOf('./plugins/share-extension-name') > names.indexOf('expo-share-intent'), 'the share sheet name is set after the extension is written');
  assert.equal(appJson.expo.scheme[0], 'referralfit', 'the extension opens the first scheme');
  assert.equal(appJson.expo.extra?.eas?.build?.experimental, undefined, 'appExtensions are added by the plugin itself; a copy in app.json would be a second target (and the plugin refuses it)');
  for (const name of ['expo-share-intent', 'expo-speech-recognition', 'expo-linking', 'expo-constants']) {
    assert.match(pkg.dependencies[name] || '', /^\d+\.\d+\.\d+$/, `${name} is pinned exactly`);
  }
  assert.ok(pkg.expo.install.exclude.includes('expo-linking') && pkg.expo.install.exclude.includes('expo-constants'), 'kept at the versions expo 57.0.8 bundles');
  assert.match(pkg.scripts.test, /share-voice-test\.mjs/);
}, 'config');

check(() => {
  const vercel = JSON.parse(read('vercel.json'));
  const policy = vercel.headers[0].headers.find((header) => header.key === 'Permissions-Policy').value;
  assert.match(policy, /microphone=\(\)/, 'the web app keeps the microphone off (and has no voice note)');
}, 'web');

console.log(`Share to ReferralFit and voice notes: PASS (${checks} checks)`);
