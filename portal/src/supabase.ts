import { createClient } from '@supabase/supabase-js';

// Same public project values as the mobile app (see src/lib/supabase.ts there):
// the publishable key is designed to ship in clients; RLS protects the data.
const SUPABASE_URL = 'https://ovfafffvcpaahktvlsdm.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_szOYQ5hbfqTsZi1uI7t8zQ_OzdpYBzi';

// `npm run dev` against the local Supabase stack: VITE_SUPABASE_URL and
// VITE_SUPABASE_PUBLISHABLE_KEY, both set (from `supabase status`). A
// production build never reads them.
const LOCAL_URL = import.meta.env.DEV ? import.meta.env.VITE_SUPABASE_URL as string | undefined : undefined;
const LOCAL_KEY = import.meta.env.DEV ? import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined : undefined;
const useLocal = Boolean(LOCAL_URL && LOCAL_KEY);

const url = useLocal ? LOCAL_URL as string : SUPABASE_URL;
const key = useLocal ? LOCAL_KEY as string : SUPABASE_PUBLISHABLE_KEY;

// For a save that must outlive the page (fetch keepalive, on pagehide),
// which supabase-js cannot make.
export const projectUrl = url;
export const publishableKey = key;

export const supabase = createClient(url, key);

// The handoff page (/h) is signed out by design: its calls carry the token
// only. This client never reads or sends a center portal session stored in
// the same browser (the server then sees nobody signed in), and never
// stores one.
export const signedOutSupabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'referralfit-handoff-signed-out' },
});
