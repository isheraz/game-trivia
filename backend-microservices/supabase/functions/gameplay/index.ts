import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { z } from 'https://esm.sh/zod@3.23.8'
import { getServiceClient } from '../_lib/db.ts'
import { normalizePhoneNumber, jsonResponse, badRequest, serverError } from '../_lib/utils.ts'
import { enqueueNotification } from '../_lib/notify.ts'

const AnswerSchema = z.object({
  gameId: z.string().uuid(),
  phoneNumber: z.string(),
  answer: z.string().min(1)
})

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  try {
    const body = await req.json()
    const parsed = AnswerSchema.safeParse(body)
    if (!parsed.success) return badRequest('Invalid payload')

    const { gameId, answer } = parsed.data
    const phone = normalizePhoneNumber(parsed.data.phoneNumber)
    if (!phone) return badRequest('Invalid phone number')
    
    const supabase = getServiceClient()

    // Call atomic RPC function
    const { data: result, error } = await supabase.rpc('record_player_answer', {
      p_game_id: gameId,
      p_whatsapp_number: phone,
      p_answer: answer
    })

    if (error) throw error

    // Handle different outcomes
    if (result.error) {
      return jsonResponse({ error: result.error, code: result.code }, { status: 400 })
    }

    // Fetch user for notifications
    const { data: user } = await supabase.from('users').select('nickname').eq('whatsapp_number', phone).single()
    const nickname = user?.nickname || `Player_${phone.slice(-4)}`

    if (result.result === 'eliminated') {
      await enqueueNotification(
        phone,
        `❌ Wrong answer! You are eliminated at question ${result.question_number}.\n\nCorrect answer: ${result.correct_answer}`
      )
      return jsonResponse({ result: 'eliminated', questionNumber: result.question_number })
    }

    if (result.result === 'winner') {
      await enqueueNotification(
        phone,
        `🎉 Congratulations ${nickname}! You won the trivia game!\n\nYou answered all questions correctly!`
      )
      return jsonResponse({ result: 'winner', questionNumber: result.question_number })
    }

    // Correct answer, game continues
    await enqueueNotification(
      phone,
      `✅ Correct! Moving to next question.\n\n${result.remaining_players} players remaining.`
    )
    return jsonResponse({ 
      result: 'correct', 
      questionNumber: result.question_number,
      remainingPlayers: result.remaining_players
    })
  } catch (e: any) {
    console.error('Gameplay error:', e)
    return serverError(e.message)
  }
})
