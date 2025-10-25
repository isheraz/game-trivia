#!/usr/bin/env node
/**
 * Interactive test script for QRush Trivia backend
 * Uses the Supabase API to test game flows
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
const TEST_PHONE = process.env.TEST_PHONE || '923196612416'
const DEV_BYPASS = process.env.ADMIN_DEV_PASSWORD || 'dev123'

const apiCall = async (method, path, body = null, auth = null) => {
  const url = `${SUPABASE_URL}/functions/v1/${path}`
  const headers = {
    'Content-Type': 'application/json',
    'x-admin-bypass': DEV_BYPASS
  }
  if (auth) headers['Authorization'] = `Bearer ${auth}`

  const options = { method, headers }
  if (body) options.body = JSON.stringify(body)

  const res = await fetch(url, options)
  const data = await res.json()
  return { status: res.status, data }
}

const log = (emoji, msg) => console.log(`${emoji} ${msg}`)

async function runTests() {
  log('🎮', 'QRush Trivia - Interactive Test Suite')
  log('═', '='.repeat(50))
  console.log()

  try {
    // 1. Create Game
    log('📝', 'Creating test game...')
    const gameData = {
      title: `Test Quiz ${Date.now()}`,
      startTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      prizePool: 100,
      totalQuestions: 5
    }
    const { data: game } = await apiCall('POST', 'admin-games', gameData)
    if (!game.id) throw new Error('Game creation failed')
    log('✅', `Game created: ${game.id}`)
    console.log()

    // 2. Add Questions
    log('❓', 'Adding questions...')
    const questions = [
      { text: 'Who wrote Hamlet?', opts: ['Shakespeare', 'Dickens', 'Twain', 'Austen'], ans: 'Shakespeare' },
      { text: 'What is 2+2?', opts: ['3', '4', '5', '6'], ans: '4' },
      { text: 'Capital of France?', opts: ['London', 'Berlin', 'Paris', 'Madrid'], ans: 'Paris' },
      { text: 'Largest ocean?', opts: ['Atlantic', 'Pacific', 'Indian', 'Arctic'], ans: 'Pacific' },
      { text: 'Speed of light?', opts: ['300k km/s', '150k km/s', '500k km/s', '100k km/s'], ans: '300k km/s' }
    ]

    // Direct DB insert would be needed here - for now, note that questions should be added via admin UI or CSV
    log('ℹ️', 'Note: Add questions via SQL or admin UI before testing')
    console.log()

    // 3. Open Registration
    log('📢', 'Opening registration...')
    await apiCall('POST', `admin-games/${game.id}/register`)
    log('✅', 'Registration opened')
    console.log()

    // 4. Player Join
    log('👤', `Player ${TEST_PHONE} joining...`)
    const { data: joinRes } = await apiCall('POST', 'registration/join', {
      gameId: game.id,
      phoneNumber: TEST_PHONE
    })
    log('✅', joinRes.message || 'Player joined')
    console.log()

    // 5. Start Game
    log('🚀', 'Starting game...')
    const { data: startRes } = await apiCall('POST', `admin-games/${game.id}/start`)
    log('✅', startRes.message || 'Game started')
    console.log()

    // 6. Submit Answers
    log('📝', 'Submitting answers...')
    for (let i = 0; i < 3; i++) {
      const answer = i === 0 ? questions[i].ans : 'Wrong Answer'
      const { data: answerRes } = await apiCall('POST', 'gameplay/answer', {
        gameId: game.id,
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

    // 8. Export Results
    log('📊', 'Exporting game results...')
    log('ℹ️', `Export URL: ${SUPABASE_URL}/functions/v1/admin-games/${game.id}/export`)
    console.log()

    log('✅', 'Test suite completed!')
    log('📱', `Check WhatsApp messages on ${TEST_PHONE}`)

  } catch (error) {
    log('❌', `Test failed: ${error.message}`)
    console.error(error)
    process.exit(1)
  }
}

runTests()
