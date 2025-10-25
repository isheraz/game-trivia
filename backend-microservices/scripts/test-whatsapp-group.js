#!/usr/bin/env node
/**
 * Quick test script to send a message to WhatsApp group
 * and verify your Group ID is working
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321'
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH'
const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

// CHANGE THIS TO YOUR GROUP ID
const GROUP_ID = process.env.WHATSAPP_GROUP_ID || '120363380598109107@g.us'

import { execSync } from 'child_process'

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

async function main() {
  console.log('📱 WhatsApp Group Test\n')
  console.log(`Group ID: ${GROUP_ID}\n`)

  // Step 1: Queue test message
  console.log('Step 1: Queuing test message...')
  const message = `🎮 QRush Trivia Test Message

This is a test notification from your trivia game system!

If you're seeing this in your WhatsApp group, everything is working correctly! 🎉

Sent at: ${new Date().toLocaleString()}`

  const result = execSync(
    `psql "${DB_URL}" -t -A -c "INSERT INTO notifications (to_number, message, status) VALUES ('${GROUP_ID}', '${message.replace(/'/g, "''")}', 'queued') RETURNING id::text;"`,
    { encoding: 'utf8' }
  ).trim().split('\n')[0]

  console.log(`✅ Notification queued with ID: ${result}\n`)

  // Step 2: Dispatch notification
  console.log('Step 2: Dispatching notification...')
  const dispatch = await apiCall('cron-dispatcher', { method: 'GET' })
  
  if (dispatch.ok) {
    console.log(`✅ Dispatch result:`, dispatch.data)
  } else {
    console.log(`❌ Dispatch failed:`, dispatch.data)
  }

  // Step 3: Check status
  console.log('\nStep 3: Checking notification status...')
  const status = execSync(
    `psql "${DB_URL}" -t -A -c "SELECT status, payload->>'error' as error, payload->>'whatsapp_message_id' as msg_id FROM notifications WHERE id = '${result}';"`,
    { encoding: 'utf8' }
  ).trim()

  const [notifStatus, error, msgId] = status.split('|')

  console.log(`Status: ${notifStatus}`)
  if (msgId && msgId !== '') {
    console.log(`✅ WhatsApp Message ID: ${msgId}`)
    console.log('\n🎉 SUCCESS! Check your WhatsApp group for the test message!')
  } else if (error && error !== '') {
    console.log(`❌ Error: ${error}`)
    console.log('\n💡 Troubleshooting:')
    console.log('  1. Verify your group ID ends with @g.us')
    console.log('  2. Ensure your business number is a member of the group')
    console.log('  3. Check that WhatsApp credentials are set in Edge Functions:')
    console.log('     supabase secrets set WHATSAPP_ACCESS_TOKEN=...')
    console.log('     supabase secrets set WHATSAPP_PHONE_NUMBER_ID=...')
  } else {
    console.log('\n⏳ Message still processing...')
  }
}

main().catch(console.error)
