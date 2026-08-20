import { createClient } from '@supabase/supabase-js';

// Same public project values as the mobile app (see src/lib/supabase.ts there):
// the publishable key is designed to ship in clients; RLS protects the data.
const SUPABASE_URL = 'https://ovfafffvcpaahktvlsdm.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_szOYQ5hbfqTsZi1uI7t8zQ_OzdpYBzi';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
