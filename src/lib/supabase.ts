import { createClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

// PUBLIC client values — the publishable (anon) key is designed to ship inside
// the app bundle and is safe to commit. Row Level Security on every table
// (owner-only policies) is what actually protects the data.
export const SUPABASE_URL = 'https://ovfafffvcpaahktvlsdm.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_szOYQ5hbfqTsZi1uI7t8zQ_OzdpYBzi';

// SecureStore values are capped around 2KB, and Supabase auth session JSON
// (access + refresh tokens) can exceed that, so chunk the value across a few
// SecureStore keys. This is the standard "largeSecureStore" pattern.
const CHUNK_SIZE = 1800;
const MAX_CHUNKS = 5;

const ChunkedSecureStoreAdapter = Platform.OS === 'web'
  ? undefined // supabase-js falls back to localStorage on web
  : {
      async getItem(key: string): Promise<string | null> {
        try {
          const first = await SecureStore.getItemAsync(key);
          if (first === null) return null;
          let value = first;
          for (let index = 1; index < MAX_CHUNKS; index += 1) {
            const chunk = await SecureStore.getItemAsync(`${key}-${index}`);
            if (chunk === null) break;
            value += chunk;
          }
          return value;
        } catch {
          return null;
        }
      },
      async setItem(key: string, value: string): Promise<void> {
        const chunks: string[] = [];
        for (let offset = 0; offset < value.length; offset += CHUNK_SIZE) {
          chunks.push(value.slice(offset, offset + CHUNK_SIZE));
        }
        if (chunks.length > MAX_CHUNKS) {
          // Session should never get near this; fail closed rather than
          // persisting a truncated token set.
          throw new Error('Supabase session is too large for SecureStore chunking');
        }
        await SecureStore.setItemAsync(key, chunks[0] ?? '');
        for (let index = 1; index < MAX_CHUNKS; index += 1) {
          const chunkKey = `${key}-${index}`;
          if (index < chunks.length) {
            await SecureStore.setItemAsync(chunkKey, chunks[index]);
          } else {
            await SecureStore.deleteItemAsync(chunkKey).catch(() => undefined);
          }
        }
      },
      async removeItem(key: string): Promise<void> {
        await SecureStore.deleteItemAsync(key).catch(() => undefined);
        for (let index = 1; index < MAX_CHUNKS; index += 1) {
          await SecureStore.deleteItemAsync(`${key}-${index}`).catch(() => undefined);
        }
      },
    };

// ─── Request deadlines ──────────────────────────────────────────────────────
// Without a deadline a request on a network that never answers (Wi-Fi with no
// internet, a lossy cell) waits for iOS's own ~60 s timeout, and postgrest-js
// retries a failed GET up to 3 times on top. The offline queue lock and the
// cache lock are held across those requests, so every save on the device
// would wait too. Every request therefore gets a deadline; a request that
// misses it fails as an AbortError ("Network request timed out"), which
// postgrest-js does not retry and errors.ts classifies as a timeout (network
// class: reads fall back to the saved copy, queued writes stay queued and the
// attempt counts toward the transient caps in store.ts).
//
// React Native's fetch (whatwg-fetch over XHR) resolves only once the whole
// body has arrived, so the deadline covers the full transfer there.
export const REQUEST_TIMEOUT_MS = 15_000;
// Document uploads and downloads move whole files over a cell connection.
export const STORAGE_TRANSFER_TIMEOUT_MS = 120_000;
// ...and an upload also gets time for its size, at this slowest uplink it is
// expected to survive (64 KiB/s ≈ 0.5 Mbit/s). A flat deadline is a hard size
// cap on a slow link: at 1 Mbit/s, 120 s moves ~15 MB, so a 25 MB scan (the
// case-documents bucket limit) would fail on every retry. Before deadlines
// existed iOS only timed out an upload that stopped moving, so this keeps
// slow-but-progressing uploads working.
export const STORAGE_MIN_BYTES_PER_SECOND = 64 * 1024;
// Edge Functions with no deadline of their own. A caller that passes one
// (functions-js `timeout`, e.g. outreach-api's 56 s draft call, arrives here
// as a signal) keeps exactly its own deadline: nothing shorter is imposed.
export const FUNCTION_TIMEOUT_MS = 60_000;
export const REQUEST_TIMEOUT_MESSAGE = 'Network request timed out';

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type RequestTimeoutOptions = {
  timeoutMs?: number;
  storageTransferTimeoutMs?: number;
  storageMinBytesPerSecond?: number;
  functionTimeoutMs?: number;
};

// The size of a request body when it is cheap to know (storage-js sends an
// upload's ArrayBuffer as is; a Blob has a size; a JSON body is a string).
// 0 when unknown (FormData, streams): the base deadline applies.
export function requestBodyBytes(body: unknown): number {
  if (!body) return 0;
  if (typeof body === 'string') return body.length;
  if (typeof body !== 'object') return 0;
  const { byteLength, size } = body as { byteLength?: unknown; size?: unknown };
  const bytes = typeof byteLength === 'number' ? byteLength : typeof size === 'number' ? size : 0;
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
}

// The path of a request URL, without parsing it into a URL object (one per
// request, and React Native's URL polyfill is partial): scheme and host off,
// query and fragment off.
function requestPath(input: RequestInfo | URL): string {
  const raw = typeof input === 'string' ? input : String((input as { url?: unknown }).url ?? (input as URL).href ?? '');
  return raw.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').split(/[?#]/)[0];
}

// Storage calls that move no file body: signing, listing, moving, copying,
// object info. Everything else under /storage/v1/object/ is a transfer.
const STORAGE_METADATA_PATH = /\/storage\/v1\/object\/(?:sign|list|list-v2|move|copy|info)(?:\/|$)/;

// The deadline for one request, or null when the caller's own signal is the
// deadline (an Edge Function call made with a timeout). `bodyBytes` (an
// upload's size) extends a storage transfer's deadline.
export function requestDeadlineMs(input: RequestInfo | URL, hasCallerSignal: boolean, options: RequestTimeoutOptions = {}, bodyBytes = 0): number | null {
  const path = requestPath(input);
  if (path.includes('/functions/v1/')) return hasCallerSignal ? null : options.functionTimeoutMs ?? FUNCTION_TIMEOUT_MS;
  if (path.includes('/storage/v1/object/') && !STORAGE_METADATA_PATH.test(path)) {
    const base = options.storageTransferTimeoutMs ?? STORAGE_TRANSFER_TIMEOUT_MS;
    const rate = options.storageMinBytesPerSecond ?? STORAGE_MIN_BYTES_PER_SECOND;
    return base + (bodyBytes > 0 && rate > 0 ? Math.ceil((bodyBytes / rate) * 1000) : 0);
  }
  return options.timeoutMs ?? REQUEST_TIMEOUT_MS;
}

function requestTimeoutError(deadlineMs: number): Error {
  return Object.assign(new Error(REQUEST_TIMEOUT_MESSAGE), { name: 'AbortError', timedOut: true, timeoutMs: deadlineMs });
}

// Wrap a fetch with the deadline above. A caller-supplied signal is combined
// with it (either one aborts the request; a caller's abort is rethrown as
// is). React Native's AbortController polyfill has no AbortSignal.any, so the
// two are linked by hand. The returned promise settles at the deadline even
// if the underlying fetch ignores the abort.
export function withRequestTimeout(baseFetch: FetchFn, options: RequestTimeoutOptions = {}): FetchFn {
  return (input, init) => {
    const callerSignal = init?.signal ?? undefined;
    const deadlineMs = requestDeadlineMs(input, Boolean(callerSignal), options, requestBodyBytes(init?.body));
    if (deadlineMs === null) return baseFetch(input, init);
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener('abort', onCallerAbort);
    }
    return new Promise<Response>((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(requestTimeoutError(deadlineMs));
      }, deadlineMs);
      const settle = () => {
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', onCallerAbort);
      };
      let pending: Promise<Response>;
      try {
        pending = baseFetch(input, { ...init, signal: controller.signal });
      } catch (error) {
        settle();
        reject(error);
        return;
      }
      pending.then(
        (response) => { settle(); resolve(response); },
        (error) => { settle(); reject(timedOut ? requestTimeoutError(deadlineMs) : error); },
      );
    });
  };
}

// Resolved at call time: React Native installs its fetch polyfill at startup.
const supabaseFetch = withRequestTimeout((input, init) => fetch(input, init));

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  global: { fetch: supabaseFetch },
  auth: {
    storage: ChunkedSecureStoreAdapter,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
