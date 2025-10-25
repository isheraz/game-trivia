import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { Hono } from 'https://esm.sh/hono@4.4.10'
import { z } from 'https://esm.sh/zod@3.23.8'
import { getServiceClient } from '../_lib/db.ts'
import { normalizePhoneNumber, jsonResponse, badRequest, serverError } from '../_lib/utils.ts'

const app = new Hono()

const JoinSchema = z.object({
  gameId: z.string().uuid(),
  phoneNumber: z.string().min(6)
})

app.post('/', async (c) => {
  try {
    const body = await c.req.json()
    const parsed = JoinSchema.safeParse(body)
    if (!parsed.success) return badRequest('Invalid payload')
    const { gameId } = parsed.data
    const phone = normalizePhoneNumber(parsed.data.phoneNumber)
    const supabase = getServiceClient()

    // Ensure game is in pre_game state
    const { data: game, error: gerr } = await supabase.from('games').select('id,status').eq('id', gameId).single()
    if (gerr) throw gerr
    if (game.status !== 'pre_game') return badRequest('No game is currently accepting registrations.')

    // Upsert user by whatsapp_number
    const { data: user, error: uerr } = await supabase
      .from('users')
      .upsert({ whatsapp_number: phone, nickname: `Player_${phone?.slice(-4)}` }, { onConflict: 'whatsapp_number' })
      .select()
      .single()
    if (uerr) throw uerr

    // Register player (idempotent via unique constraint)
    const { error: perr } = await supabase
      .from('game_players')
      .insert({ game_id: gameId, user_id: user.id, status: 'registered' })
    if (perr && (perr as any).code !== '23505') throw perr

    return jsonResponse({ message: "You're registered for this game!" })
  } catch (e: any) {
    return serverError(e.message)
  }
})

Deno.serve((req) => app.fetch(req))
