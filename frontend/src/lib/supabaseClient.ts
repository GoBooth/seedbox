import { createClient } from '@supabase/supabase-js';

type SeedboxRuntimeConfig = {
  url?: string | null;
  supabaseUrl?: string | null;
  anonKey?: string | null;
  supabaseAnonKey?: string | null;
  VITE_SUPABASE_URL?: string | null;
  VITE_SUPABASE_ANON_KEY?: string | null;
};

const getRuntimeConfig = (): SeedboxRuntimeConfig | null => {
  if (typeof globalThis === 'undefined') {
    return null;
  }

  const raw = (globalThis as Record<string, unknown>).__SEEDBOX_SUPABASE__;
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  return raw as SeedboxRuntimeConfig;
};

const runtimeConfig = getRuntimeConfig();

const pickValue = (...candidates: (string | null | undefined)[]) => {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
};

const url = pickValue(
  import.meta.env.VITE_SUPABASE_URL,
  runtimeConfig?.VITE_SUPABASE_URL,
  runtimeConfig?.url,
  runtimeConfig?.supabaseUrl,
);

const anonKey = pickValue(
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  runtimeConfig?.VITE_SUPABASE_ANON_KEY,
  runtimeConfig?.anonKey,
  runtimeConfig?.supabaseAnonKey,
);

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
