// Deno-compatible helpers for Supabase Edge Functions
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

export type DBClient = SupabaseClient

export function getServiceClient(): DBClient {
  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  }
  return createClient(url, key, {
    auth: { persistSession: false },
    global: { headers: { 'X-Client-Info': 'qrush-functions/1.0' } }
  })
}

export function getRLSClient(req: Request): DBClient {
  const url = Deno.env.get('SUPABASE_URL')
  const anon = Deno.env.get('SUPABASE_ANON_KEY')
  if (!url || !anon) throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY')
  const authHeader = req.headers.get('Authorization') || ''
  const supabase = createClient(url, anon, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false }
  })
  return supabase
}
