import { assertEquals, assertThrows } from 'jsr:@std/assert@1';

import { parseUploadRequest, UploadRequestError } from './upload.ts';

const TOKEN = 'ab'.repeat(32);

Deno.test('an upload needs a whole link token and a side', () => {
  assertEquals(parseUploadRequest({ token: ` ${TOKEN.toUpperCase()} `, side: 'front' }), { token: TOKEN, side: 'front' });
  assertEquals(parseUploadRequest({ token: TOKEN, side: 'back' }).side, 'back');
  assertThrows(() => parseUploadRequest({ token: TOKEN.slice(1), side: 'front' }), UploadRequestError);
  assertThrows(() => parseUploadRequest({ token: TOKEN, side: '../../x' }), UploadRequestError);
  assertThrows(() => parseUploadRequest({ token: TOKEN }), UploadRequestError);
  assertThrows(() => parseUploadRequest(null), UploadRequestError);
});

