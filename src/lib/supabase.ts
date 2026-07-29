import { createClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

// PUBLIC client values — the publishable (anon) key is designed to ship inside
// the app bundle and is safe to commit. Row Level Security on every table
// (owner-only policies) is what actually protects the data.
const SUPABASE_URL = 'https://ovfafffvcpaahktvlsdm.supabase.co';
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

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: ChunkedSecureStoreAdapter,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
