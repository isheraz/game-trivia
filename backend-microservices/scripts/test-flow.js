#!/usr/bin/env node
/**
 * Interactive test script for QRush Trivia backend
 * Uses the Supabase API to test game flows
 */

import { execSync } from 'child_process'

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH'
const TEST_PHONE = process.env.TEST_PHONE || '923124501070'
const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const apiCall = async (method, path, body = null) => {
  const url = `${SUPABASE_URL}/functions/v1/${path}`
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
  }

  const options = { method, headers }
  if (body) options.body = JSON.stringify(body)

  const res = await fetch(url, options)
  const text = await res.text()
  try {
    return { status: res.status, data: JSON.parse(text) }
  } catch {
    return { status: res.status, data: text }
  }
}

const execSQL = (query) => {
  const result = execSync(`psql "${DB_URL}" -t -A -c "${query.replace(/"/g, '\\"')}"`, { encoding: 'utf8' })
  return result.trim().split('\n')[0]
}

const log = (emoji, msg) => console.log(`${emoji} ${msg}`)

async function runTests() {
  log('🎮', 'QRush Trivia - Interactive Test Suite')
  log('═', '='.repeat(50))
  console.log()

  try {
    // 1. Create Game via SQL
    log('📝', 'Creating test game...')
    const gameId = execSQL(`
      INSERT INTO games (title, start_time, prize_pool, total_questions, status)
      VALUES ('Test Flow ${Date.now()}', now() + interval '1 hour', 100, 5, 'scheduled')
      RETURNING id::text;
    `)
    log('✅', `Game created: ${gameId}`)
    console.log()

    // 2. Add Questions via SQL
    log('❓', 'Adding questions...')
    const questions = [
      { text: 'Who wrote Hamlet?', opts: ['Shakespeare', 'Dickens', 'Twain', 'Austen'], ans: 'Shakespeare' },
      { text: 'What is 2+2?', opts: ['3', '4', '5', '6'], ans: '4' },
      { text: 'Capital of France?', opts: ['London', 'Berlin', 'Paris', 'Madrid'], ans: 'Paris' },
      { text: 'Largest ocean?', opts: ['Atlantic', 'Pacific', 'Indian', 'Arctic'], ans: 'Pacific' },
      { text: 'Speed of light?', opts: ['300k km/s', '150k km/s', '500k km/s', '100k km/s'], ans: '300k km/s' }
    ]

    const questionsJson = JSON.stringify(questions.map((q, i) => ({
      question_text: q.text,
      option_a: q.opts[0],
      option_b: q.opts[1],
      option_c: q.opts[2],
      option_d: q.opts[3],
      correct_answer: q.ans,
      question_order: i + 1
    }))).replace(/'/g, "''")
    
    execSQL(`SELECT bulk_insert_questions('${gameId}', '${questionsJson}'::jsonb);`)
    log('✅', `Added ${questions.length} questions`)
    console.log()

    // 3. Open Registration via SQL
    log('📢', 'Opening registration...')
    execSQL(`UPDATE games SET status = 'pre_game' WHERE id = '${gameId}';`)
    log('✅', 'Registration opened')
    console.log()

    // 4. Player Join
    log('👤', `Player ${TEST_PHONE} joining...`)
    const { data: joinRes } = await apiCall('POST', 'registration', {
      gameId: gameId,
      phoneNumber: TEST_PHONE
    })
    log('✅', joinRes.message || 'Player joined')
    console.log()

    // 5. Start Game via SQL
    log('🚀', 'Starting game...')
    execSQL(`
      UPDATE games SET status = 'in_progress', started_at = now() WHERE id = '${gameId}';
      UPDATE game_players SET status = 'active' WHERE game_id = '${gameId}' AND status = 'registered';
    `)
    log('✅', 'Game started')
    console.log()

    // 6. Submit Answers
    log('📝', 'Submitting answers...')
    for (let i = 0; i < 3; i++) {
      const answer = i === 0 ? questions[i].ans : 'Wrong Answer'
      const { data: answerRes } = await apiCall('POST', 'gameplay', {
        gameId: gameId,
        phoneNumber: TEST_PHONE,
        answer
      })
      log(answerRes.result === 'correct' ? '✅' : '❌', 
        `Q${i + 1}: ${answerRes.result} ${answerRes.error || ''}`)
      
      if (answerRes.result === 'eliminated') {
        log('⚠️', 'Player eliminated - test complete')
        break
      }
    }
    console.log()

    // 7. Process Notifications
    log('📬', 'Processing notification queue...')
    const { data: dispatchRes } = await apiCall('GET', 'cron-dispatcher')
    log('✅', `Processed ${dispatchRes.processed || 0} notifications`)
    console.log()

    // 8. Check notification status
    log('📊', 'Checking notification status...')
    const notifStatus = execSQL(`
      SELECT status, count(*) FROM notifications 
      WHERE to_number = '${TEST_PHONE}' 
      GROUP BY status;
    `)
    log('ℹ️', `Notification status: ${notifStatus}`)
    console.log()

    log('✅', 'Test suite completed!')
    log('📱', `Check WhatsApp messages on ${TEST_PHONE}`)
    log('🎮', `Game ID: ${gameId}`)

  } catch (error) {
    log('❌', `Test failed: ${error.message}`)
    console.error(error)
    process.exit(1)
  }
}

runTests()
