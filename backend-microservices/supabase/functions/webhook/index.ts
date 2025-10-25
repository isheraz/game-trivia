import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { Hono } from 'https://esm.sh/hono@4.4.10'
import { jsonResponse, badRequest, serverError } from '../_lib/utils.ts'
import { getServiceClient } from '../_lib/db.ts'

const app = new Hono()

// GET verification for WhatsApp
app.get('/', (c) => {
  const url = new URL(c.req.url)
  const mode = url.searchParams.get('hub.mode')
  const token = url.searchParams.get('hub.verify_token')
  const challenge = url.searchParams.get('hub.challenge')
  const verify = Deno.env.get('WHATSAPP_VERIFY_TOKEN')
  if (mode === 'subscribe' && token && verify && token === verify) {
    return new Response(challenge ?? '', { status: 200 })
  }
  return badRequest('Forbidden')
})

// POST message webhook (store and fan-out later)
app.post('/', async (c) => {
  try {
    const payload = await c.req.json()
    // Persist raw webhook for audit
    const supabase = getServiceClient()
    await supabase.from('webhook_events').insert({ provider: 'whatsapp', payload })
    // TODO: parse messages and enqueue notifications or player actions
    return jsonResponse({ status: 'EVENT_RECEIVED' })
  } catch (e: any) {
    return serverError(e.message)
  }
})

Deno.serve((req) => app.fetch(req))
