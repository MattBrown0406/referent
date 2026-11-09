import { assertEquals, assertMatch, assertNotEquals, assertThrows } from 'jsr:@std/assert@1';

import { parseUploadRequest, uploadName, UploadRequestError } from './upload.ts';

const TOKEN = 'ab'.repeat(32);
const PREFIX = `${'1'.repeat(8)}-1111-1111-1111-${'1'.repeat(12)}/${'2'.repeat(8)}-2222-2222-2222-${'2'.repeat(12)}/card-front`;

Deno.test('an upload needs a whole link token and a side', () => {
  assertEquals(parseUploadRequest({ token: ` ${TOKEN.toUpperCase()} `, side: 'front' }), { action: 'sign', token: TOKEN, side: 'front' });
  assertEquals(parseUploadRequest({ token: TOKEN, side: 'back' }).side, 'back');
  assertThrows(() => parseUploadRequest({ token: TOKEN.slice(1), side: 'front' }), UploadRequestError);
  assertThrows(() => parseUploadRequest({ token: TOKEN, side: '../../x' }), UploadRequestError);
  assertThrows(() => parseUploadRequest({ token: TOKEN }), UploadRequestError);
  assertThrows(() => parseUploadRequest(null), UploadRequestError);
});

Deno.test('a finished upload names the photo it sent, for that side only', () => {
  const path = uploadName(PREFIX);
  assertEquals(parseUploadRequest({ token: TOKEN, side: 'front', action: 'done', path }), { action: 'done', token: TOKEN, side: 'front', path });
  assertThrows(() => parseUploadRequest({ token: TOKEN, side: 'back', action: 'done', path }), UploadRequestError);
  assertThrows(() => parseUploadRequest({ token: TOKEN, side: 'front', action: 'done', path: `${PREFIX}/../../other` }), UploadRequestError);
  assertThrows(() => parseUploadRequest({ token: TOKEN, side: 'front', action: 'remove' }), UploadRequestError);
});

Deno.test('every upload gets its own name', () => {
  assertMatch(uploadName(PREFIX), /card-front-[0-9a-f]{32}$/);
  assertEquals(uploadName(PREFIX, new Uint8Array(16)), `${PREFIX}-${'0'.repeat(32)}`);
  assertNotEquals(uploadName(PREFIX), uploadName(PREFIX));
});
