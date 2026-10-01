import { assert, assertEquals } from 'jsr:@std/assert@1';

import {
  buildMessages,
  chunk,
  collectReceiptResults,
  collectSendResults,
  isAuthorized,
  secretMatches,
  type OutboxRow,
} from './push.ts';

const row = (id: string, tokens: OutboxRow['tokens']): OutboxRow => ({
  id,
  user_id: 'u1',
  kind: 'new_lead',
  title: 'New lead waiting',
  body: 'A new lead is waiting for its first call.',
  data: { kind: 'new_lead', case_id: 'c1', user_id: 'u1' },
  tokens,
});

Deno.test('chunk splits into Expo-sized batches', () => {
  assertEquals(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assertEquals(chunk([], 100), []);
});

Deno.test('buildMessages makes one message per device and carries only the queued payload', () => {
  const messages = buildMessages([
    row('r1', [{ token: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]', platform: 'ios' }, { token: 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]', platform: 'android' }]),
    row('r2', []),
  ]);
  assertEquals(messages.length, 2);
  assertEquals(messages[0].rowId, 'r1');
  assertEquals(messages[0].message.to, 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]');
  assertEquals(messages[0].message.title, 'New lead waiting');
  assertEquals(messages[0].message.channelId, undefined);
  assertEquals(messages[1].message.channelId, 'referralfit');
  assertEquals(Object.keys(messages[0].message.data).sort(), ['case_id', 'kind', 'user_id']);
});

Deno.test('collectSendResults marks a row sent when any device accepted and prunes dead tokens', () => {
  const sent = [
    { rowId: 'r1', token: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]' },
    { rowId: 'r1', token: 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]' },
    { rowId: 'r2', token: 'ExponentPushToken[cccccccccccccccccccccc]' },
  ];
  const { results, deadTokens } = collectSendResults(sent, [
    { status: 'ok', id: 't1' },
    { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
    { status: 'error', message: 'rate', details: { error: 'MessageRateExceeded' } },
  ]);
  assertEquals(results, [
    { id: 'r1', tickets: [{ token: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]', id: 't1' }], error: '' },
    { id: 'r2', tickets: [], error: 'MessageRateExceeded' },
  ]);
  assertEquals(deadTokens, ['ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]']);
});

Deno.test('collectSendResults treats a missing ticket as a failed attempt', () => {
  const { results } = collectSendResults([{ rowId: 'r1', token: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]' }], []);
  assertEquals(results, [{ id: 'r1', tickets: [], error: 'no_ticket' }]);
});

Deno.test('collectReceiptResults reads receipts by ticket id', () => {
  const { results, deadTokens } = collectReceiptResults(
    [
      { id: 'r1', tickets: [{ token: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]', id: 't1' }, { token: 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]', id: 't2' }] },
      { id: 'r2', tickets: [{ token: 'ExponentPushToken[cccccccccccccccccccccc]', id: 't3' }] },
    ],
    {
      t1: { status: 'ok' },
      t2: { status: 'error', details: { error: 'DeviceNotRegistered' } },
    },
  );
  assertEquals(results, [{ id: 'r1', error: 'DeviceNotRegistered' }, { id: 'r2', error: '' }]);
  assertEquals(deadTokens, ['ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]']);
});

Deno.test('authorization needs the shared secret header or the service-role bearer', () => {
  assert(secretMatches('abc', 'abc'));
  assert(!secretMatches('abc', 'abd'));
  assert(!secretMatches(null, 'abc'));
  assert(!secretMatches('', ''));
  assert(isAuthorized(new Headers({ 'x-push-dispatch-secret': 'shh' }), 'shh', 'service'));
  assert(isAuthorized(new Headers({ authorization: 'Bearer service' }), 'shh', 'service'));
  assert(!isAuthorized(new Headers({ authorization: 'Bearer anon-key' }), 'shh', 'service'));
  assert(!isAuthorized(new Headers(), 'shh', 'service'));
  assert(!isAuthorized(new Headers({ 'x-push-dispatch-secret': '' }), '', 'service'), 'an unset secret never matches');
});
