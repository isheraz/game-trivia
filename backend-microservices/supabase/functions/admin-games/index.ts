import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { Hono } from 'https://esm.sh/hono@4.4.10'
import { z } from 'https://esm.sh/zod@3.23.8'
import { getServiceClient } from '../_lib/db.ts'
import { requireAdmin } from '../_lib/auth.ts'
import { jsonResponse, badRequest, forbidden, serverError } from '../_lib/utils.ts'

const app = new Hono()

const CreateGameSchema = z.object({
  title: z.string().min(3),
  startTime: z.string(),
  prizePool: z.number().nonnegative(),
  totalQuestions: z.number().int().positive()
})

app.get('/', async (c) => {
  try {
    const admin = await requireAdmin(c.req.raw)
    if (!admin.ok) return forbidden(admin.error)
    const supabase = getServiceClient()
    const { data, error } = await supabase.from('games').select('*').order('created_at', { ascending: false })
    if (error) throw error
    return jsonResponse(data)
  } catch (e: any) {
    return serverError(e.message)
  }
})

app.get('/:id', async (c) => {
  try {
    const admin = await requireAdmin(c.req.raw)
    if (!admin.ok) return forbidden(admin.error)
    const id = c.req.param('id')
    const supabase = getServiceClient()
    const { data, error } = await supabase
      .from('games')
      .select('*, questions(*), game_players(*, user:users(*))')
      .eq('id', id)
      .single()
    if (error) throw error
    return jsonResponse(data)
  } catch (e: any) {
    return serverError(e.message)
  }
})

app.post('/', async (c) => {
  try {
    const admin = await requireAdmin(c.req.raw)
    if (!admin.ok) return forbidden(admin.error)
    const body = await c.req.json()
    const parsed = CreateGameSchema.safeParse(body)
    if (!parsed.success) return badRequest('Invalid payload')
    const { title, startTime, prizePool, totalQuestions } = parsed.data
    const supabase = getServiceClient()
    const { data, error } = await supabase
      .from('games')
      .insert({ title, start_time: new Date(startTime).toISOString(), prize_pool: prizePool, total_questions: totalQuestions, status: 'scheduled' })
      .select()
      .single()
    if (error) {
      if ((error as any).code === '23505') return badRequest('Game with this title already exists.')
      throw error
    }
    return jsonResponse(data, { status: 201 })
  } catch (e: any) {
    return serverError(e.message)
  }
})

// Open registration (JOIN-only mode)
app.post('/:id/register', async (c) => {
  try {
    const admin = await requireAdmin(c.req.raw)
    if (!admin.ok) return forbidden(admin.error)
    const id = c.req.param('id')
    const supabase = getServiceClient()
    const { data: game, error: gerr } = await supabase.from('games').update({ status: 'pre_game' }).eq('id', id).select().single()
    if (gerr) throw gerr
    return jsonResponse({ message: 'Game registration opened', game })
  } catch (e: any) {
    return serverError(e.message)
  }
})

// Start game
app.post('/:id/start', async (c) => {
  try {
    const admin = await requireAdmin(c.req.raw)
    if (!admin.ok) return forbidden(admin.error)
    const id = c.req.param('id')
    const supabase = getServiceClient()
    const [{ count: qCount }, { count: pCount }] = await Promise.all([
      supabase.from('questions').select('id', { count: 'exact', head: true }).eq('game_id', id),
      supabase.from('game_players').select('id', { count: 'exact', head: true }).eq('game_id', id)
    ])
    if (!qCount || qCount === 0) return badRequest('Game must have questions before starting')
    if (!pCount || pCount === 0) return badRequest('Game must have players before starting')
    const { data: game, error } = await supabase.from('games').update({ status: 'in_progress', started_at: new Date().toISOString() }).eq('id', id).select().single()
    if (error) throw error
    return jsonResponse({ message: 'Game started successfully', game })
  } catch (e: any) {
    return serverError(e.message)
  }
})

// Export CSV (simplified)
app.get('/:id/export', async (c) => {
  try {
    const admin = await requireAdmin(c.req.raw)
    if (!admin.ok) return forbidden(admin.error)
    const id = c.req.param('id')
    const supabase = getServiceClient()
    const { data: game, error } = await supabase
      .from('games')
      .select('id,status,start_time,end_time,prize_pool,total_questions,winner_count, game_players(status, eliminated_by_question, user:users(nickname, whatsapp_number)), questions(id, question_text, question_order)')
      .eq('id', id)
      .single()
    if (error) throw error
    let csv = ''
    csv += 'GAME SUMMARY\n'
    csv += `Game ID,${game.id}\n`
    csv += `Status,${game.status}\n`
    csv += `Start Time,${game.start_time || ''}\n`
    csv += `End Time,${game.end_time || 'N/A'}\n`
    csv += `Prize Pool,$${game.prize_pool}\n`
    csv += `Total Questions,${game.total_questions}\n`
    csv += `Winner Count,${game.winner_count || 0}\n\n`
    csv += 'PLAYER SUMMARY\n'
    csv += 'Nickname,WhatsApp Number,Status,Elimination Question,Final Position\n'
    for (const p of game.game_players || []) {
      const pos = p.status === 'winner' ? 'Winner' : `Eliminated Q${p.eliminated_by_question || ''}`
      csv += `"${p.user?.nickname ?? ''}","${p.user?.whatsapp_number ?? ''}","${p.status}","${p.eliminated_by_question ?? 'N/A'}","${pos}"\n`
    }
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename=qrush-game-${id}.csv`
      }
    })
  } catch (e: any) {
    return serverError(e.message)
  }
})

Deno.serve((req) => app.fetch(req))
