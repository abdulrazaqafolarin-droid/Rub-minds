import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

/** Browser-safe publishable/anon key only. Never use a service_role key here. */
export const supabase: SupabaseClient | null = url && key
  ? createClient(url, key, { auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true } })
  : null;
export const isCloudConfigured = Boolean(supabase);
