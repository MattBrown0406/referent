// Unauthenticated verification for the case-files surface against the REAL
// project. No sign-in is possible here (no password) — instead we confirm
// the anon key is denied everywhere it must be denied.
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://ovfafffvcpaahktvlsdm.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_szOYQ5hbfqTsZi1uI7t8zQ_OzdpYBzi';

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
console.log('auth.getSession:', JSON.stringify({ session: sessionData.session, error: sessionError?.message || null }));

for (const table of ['cases', 'case_contacts', 'case_events', 'case_documents']) {
  const { data, error, status } = await supabase.from(table).select('*').limit(1);
  console.log(`anon select ${table}:`, JSON.stringify({
    rows: data,
    error: error?.message || null,
    code: error?.code || null,
    http: status,
  }));
}

const { data: listData, error: listError } = await supabase.storage.from('case-documents').list('');
console.log('anon storage list case-documents:', JSON.stringify({
  objects: listData,
  error: listError?.message || null,
}));

const { data: signedData, error: signedError } = await supabase.storage
  .from('case-documents')
  .createSignedUrl('nobody/nothing/fake.jpg', 60);
console.log('anon createSignedUrl (nonexistent object):', JSON.stringify({
  signedUrl: signedData?.signedUrl || null,
  error: signedError?.message || null,
}));
