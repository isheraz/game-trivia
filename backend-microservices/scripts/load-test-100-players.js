#!/usr/bin/env node
/**
 * Load test script: Simulates 100 concurrent players in a trivia game
 * Tests atomic answer processing, race condition handling, and notification queuing
 */

import { execSync } from 'child_process'

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321'
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH'
const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const WHATSAPP_GROUP_ID = process.env.WHATSAPP_GROUP_ID || '120363380598109107@g.us' // Replace with your group ID

const NUM_PLAYERS = 100
const BASE_PHONE = 92300000000 // Will generate 92300000001 to 92300000100

// Questions with varying difficulty
const QUESTIONS = [
  { question_text: "What is 2 + 2?", option_a: "3", option_b: "4", option_c: "5", option_d: "6", correct_answer: "4" },
  { question_text: "Capital of Pakistan?", option_a: "Karachi", option_b: "Lahore", option_c: "Islamabad", option_d: "Peshawar", correct_answer: "Islamabad" },
  { question_text: "Largest ocean?", option_a: "Atlantic", option_b: "Pacific", option_c: "Indian", option_d: "Arctic", correct_answer: "Pacific" },
  { question_text: "Speed of light (km/s)?", option_a: "300,000", option_b: "150,000", option_c: "500,000", option_d: "100,000", correct_answer: "300,000" },
  { question_text: "Who painted Mona Lisa?", option_a: "Da Vinci", option_b: "Picasso", option_c: "Van Gogh", option_d: "Rembrandt", correct_answer: "Da Vinci" }
]

async function execSQL(query) {
  const result = execSync(`psql "${DB_URL}" -t -A -c "${query.replace(/"/g, '\\"')}"`, { encoding: 'utf8' })
  return result.trim().split('\n')[0] // Take only first line to avoid "INSERT 0 1" etc
}

async function apiCall(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      ...options.headers
    }
  })
  
  const text = await response.text()
  try {
    return { ok: response.ok, status: response.status, data: JSON.parse(text) }
  } catch {
    return { ok: response.ok, status: response.status, data: text }
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function main() {
  console.log('🎮 QRush Trivia - 100 Player Load Test')
  console.log('======================================\n')

  // Step 1: Create game
  console.log('📝 Step 1: Creating game...')
  const gameId = await execSQL(`
    INSERT INTO games (title, start_time, prize_pool, total_questions, status)
    VALUES ('Load Test ' || extract(epoch from now())::text, now() + interval '1 hour', 10000, ${QUESTIONS.length}, 'scheduled')
    RETURNING id::text;
  `)
  console.log(`✅ Game created: ${gameId}\n`)

  // Step 2: Add questions
  console.log('📚 Step 2: Adding questions...')
  const questionsJson = JSON.stringify(QUESTIONS).replace(/'/g, "''")
  await execSQL(`SELECT bulk_insert_questions('${gameId}', '${questionsJson}'::jsonb);`)
  console.log(`✅ Added ${QUESTIONS.length} questions\n`)

  // Step 3: Open registration
  console.log('🚪 Step 3: Opening registration...')
  await execSQL(`UPDATE games SET status = 'pre_game' WHERE id = '${gameId}';`)
  console.log('✅ Registration opened\n')

  // Step 4: Register 100 players concurrently
  console.log(`👥 Step 4: Registering ${NUM_PLAYERS} players...`)
  const startReg = Date.now()
  
  const registrations = []
  for (let i = 1; i <= NUM_PLAYERS; i++) {
    const phone = `${BASE_PHONE + i}`
    registrations.push(
      apiCall('registration', {
        method: 'POST',
        body: JSON.stringify({ gameId, phoneNumber: phone })
      })
    )
  }

  const regResults = await Promise.all(registrations)
  const regSuccess = regResults.filter(r => r.ok).length
  const regTime = Date.now() - startReg
  
  console.log(`✅ Registered ${regSuccess}/${NUM_PLAYERS} players in ${regTime}ms\n`)

  // Step 5: Queue group notification for game start
  console.log('📢 Step 5: Queuing group announcement...')
  await execSQL(`
    INSERT INTO notifications (to_number, message, status)
    VALUES ('${WHATSAPP_GROUP_ID}', 
            '🎮 GAME STARTING NOW! 🎮\n\n${NUM_PLAYERS} players registered!\n\nFirst question coming up...', 
            'queued');
  `)
  console.log('✅ Group notification queued\n')

  // Step 6: Start game
  console.log('🎬 Step 6: Starting game...')
  await execSQL(`
    UPDATE games SET status = 'in_progress', started_at = now() WHERE id = '${gameId}';
    UPDATE game_players SET status = 'active' WHERE game_id = '${gameId}' AND status = 'registered';
  `)
  console.log('✅ Game started\n')

  // Step 7: Simulate answers for each question
  for (let qNum = 1; qNum <= QUESTIONS.length; qNum++) {
    console.log(`\n📝 Question ${qNum}/${QUESTIONS.length}: "${QUESTIONS[qNum - 1].question_text}"`)
    console.log(`Correct answer: ${QUESTIONS[qNum - 1].correct_answer}`)
    
    const startAnswer = Date.now()
    const answers = []
    
    // Generate answer distribution: 70% correct, 30% wrong
    for (let i = 1; i <= NUM_PLAYERS; i++) {
      const phone = `${BASE_PHONE + i}`
      
      // Check if player is still active
      const isActive = await execSQL(`
        SELECT EXISTS(
          SELECT 1 FROM game_players 
          WHERE game_id = '${gameId}' 
          AND user_id = (SELECT id FROM users WHERE whatsapp_number = '${phone}')
          AND status = 'active'
        );
      `)
      
      if (isActive !== 't') continue // Player eliminated
      
      // 70% answer correctly, 30% answer wrong
      const answerCorrectly = Math.random() < 0.7
      const answer = answerCorrectly 
        ? QUESTIONS[qNum - 1].correct_answer 
        : QUESTIONS[qNum - 1].option_a // Wrong answer
      
      answers.push(
        apiCall('gameplay', {
          method: 'POST',
          body: JSON.stringify({ gameId, phoneNumber: phone, answer })
        }).then(res => ({ phone, answer, result: res.data }))
      )
    }

    const answerResults = await Promise.all(answers)
    const answerTime = Date.now() - startAnswer
    
    const correct = answerResults.filter(r => r.result?.result === 'correct').length
    const eliminated = answerResults.filter(r => r.result?.result === 'eliminated').length
    const winners = answerResults.filter(r => r.result?.result === 'winner').length
    const errors = answerResults.filter(r => r.result?.error).length
    
    console.log(`⏱️  Processed ${answerResults.length} answers in ${answerTime}ms`)
    console.log(`✅ Correct: ${correct} | ❌ Eliminated: ${eliminated} | 🏆 Winners: ${winners} | ⚠️  Errors: ${errors}`)
    
    // Queue group update
    const remaining = await execSQL(`
      SELECT count(*) FROM game_players 
      WHERE game_id = '${gameId}' AND status = 'active';
    `)
    
    await execSQL(`
      INSERT INTO notifications (to_number, message, status)
      VALUES ('${WHATSAPP_GROUP_ID}', 
              'Q${qNum} Results:\n✅ Correct: ${correct}\n❌ Eliminated: ${eliminated}\n👥 Remaining: ${remaining}', 
              'queued');
    `)
    
    if (parseInt(remaining) === 0 || winners > 0) {
      console.log('\n🎊 Game finished!')
      break
    }
    
    await sleep(1000) // Small delay between questions
  }

  // Step 8: Check final stats
  console.log('\n\n📊 Final Game Statistics')
  console.log('========================\n')
  
  const stats = await execSQL(`
    SELECT 
      g.status,
      g.winner_count,
      (SELECT count(*) FROM game_players WHERE game_id = g.id) as total_players,
      (SELECT count(*) FROM game_players WHERE game_id = g.id AND status = 'active') as active_players,
      (SELECT count(*) FROM game_players WHERE game_id = g.id AND status = 'eliminated') as eliminated_players,
      (SELECT count(*) FROM notifications WHERE message LIKE '%${WHATSAPP_GROUP_ID}%') as group_notifications,
      (SELECT count(*) FROM notifications) as total_notifications
    FROM games g 
    WHERE g.id = '${gameId}';
  `)
  
  console.log(stats)

  // Step 9: Dispatch notifications
  console.log('\n\n📤 Step 9: Dispatching notifications...')
  const dispatchStart = Date.now()
  
  // Call cron-dispatcher multiple times to process all notifications
  let totalProcessed = 0
  let iterations = 0
  const maxIterations = 10
  
  while (iterations < maxIterations) {
    const result = await apiCall('cron-dispatcher', { method: 'GET' })
    const processed = result.data?.processed || 0
    
    if (processed === 0) break
    
    totalProcessed += processed
    iterations++
    console.log(`  Batch ${iterations}: Processed ${processed} notifications`)
    
    await sleep(500) // Small delay between batches
  }
  
  const dispatchTime = Date.now() - dispatchStart
  console.log(`✅ Dispatched ${totalProcessed} notifications in ${dispatchTime}ms (${iterations} batches)\n`)

  // Step 10: Final notification count
  const finalNotifications = await execSQL(`
    SELECT 
      status,
      count(*) as count
    FROM notifications
    GROUP BY status
    ORDER BY status;
  `)
  
  console.log('📊 Notification Status:')
  console.log(finalNotifications)
  console.log('\n✅ Load test completed!')
  console.log(`\nGame ID: ${gameId}`)
  console.log(`View in Studio: http://127.0.0.1:54323/project/default/editor/${gameId}`)
}

main().catch(console.error)
