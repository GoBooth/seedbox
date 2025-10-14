import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

export const isSupabaseConfigured = Boolean(url && anonKey);

if (!isSupabaseConfigured) {
  console.warn(
    'Supabase configuration is missing. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable authentication.',
  );
}

const FALLBACK_SUPABASE_URL = 'https://missing-project.supabase.co';
const FALLBACK_SUPABASE_ANON_KEY = 'missing-anon-key';

export const supabase = createClient(url || FALLBACK_SUPABASE_URL, anonKey || FALLBACK_SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});
