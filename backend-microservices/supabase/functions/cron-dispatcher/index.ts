import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { getServiceClient } from '../_lib/db.ts'
import { sendNotificationRow } from '../_lib/notify.ts'

// This function is intended to be scheduled (Supabase cron)
// It reads queued notifications in batches, marks them as sending, processes them with concurrency control,
// and updates status to 'sent' or 'failed'. Designed for ~100 players per game.

Deno.serve(async (req) => {
  try {
    const supabase = getServiceClient()
    // Batch size tuned for moderate throughput; increase if needed.
    const BATCH_SIZE = 50
    const { data: rows } = await supabase.from('notifications').select('*').eq('status', 'queued').order('created_at', { ascending: true }).limit(BATCH_SIZE)
    if (!rows || rows.length === 0) return new Response(JSON.stringify({ processed: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } })

    const ids = rows.map((r: any) => r.id)
    // Mark as sending (atomic-ish)
    await supabase.from('notifications').update({ status: 'sending' }).in('id', ids)

    // Simple concurrency limit
    const CONCURRENCY = 10
    let index = 0
    const results: Array<any> = []

    async function worker() {
      while (index < rows.length) {
        const cur = index++
        const row = rows[cur]
        try {
          const res = await sendNotificationRow(row)
          results.push({ id: row.id, ok: res.ok })
        } catch (e) {
          results.push({ id: row.id, ok: false, error: (e as any).message })
        }
      }
    }

    const workers: Promise<void>[] = []
    for (let i = 0; i < CONCURRENCY; i++) workers.push(worker())
    await Promise.all(workers)

    return new Response(JSON.stringify({ processed: rows.length, results }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
})

