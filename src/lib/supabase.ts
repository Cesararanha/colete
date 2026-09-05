import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { Database } from './database.types';

export type ColeteSupabaseClient = SupabaseClient<Database>;

let singleton: ColeteSupabaseClient | undefined;

export function publicSupabaseConfig() {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (url === undefined || publishableKey === undefined || url === '' || publishableKey === '') {
    throw new Error('Public Supabase configuration is unavailable.');
  }

  return { url, publishableKey };
}

export function getSupabaseClient(): ColeteSupabaseClient {
  if (singleton !== undefined) return singleton;

  const { url, publishableKey } = publicSupabaseConfig();
  singleton = createClient<Database>(url, publishableKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'pkce',
      persistSession: true,
    },
  });
  return singleton;
}
