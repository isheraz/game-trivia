import { getRLSClient } from './db.ts'

export async function requireAdmin(req: Request) {
  // Check for bypass header in development
  const bypass = req.headers.get('x-admin-bypass')
  const devPassword = Deno.env.get('ADMIN_DEV_PASSWORD')
  
  if (bypass && devPassword && bypass === devPassword) {
    return { ok: true as const, user: { id: 'dev-admin', email: 'dev@admin.local' } }
  }

  const supabase = getRLSClient(req)
  const { data } = await supabase.auth.getUser()
  const user = data.user
  if (!user) return { ok: false as const, error: 'Unauthorized' }

  const allowList = (Deno.env.get('ADMIN_EMAILS') || '').split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean)
  if (allowList.length === 0) return { ok: false as const, error: 'Admin list not configured' }
  const isAllowed = !!user.email && allowList.includes(user.email.toLowerCase())
  return isAllowed ? { ok: true as const, user } : { ok: false as const, error: 'Forbidden' }
}

export async function getUserOrAnon(req: Request) {
  const supabase = getRLSClient(req)
  const { data } = await supabase.auth.getUser()
  return data.user || null
}
