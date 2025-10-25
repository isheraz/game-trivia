import { getServiceClient } from './db.ts'

export async function enqueueNotification(to_number: string, message: string, template = null, payload = null) {
  const supabase = getServiceClient()
  const { data, error } = await supabase.from('notifications').insert({ to_number, message, template, payload }).select().single()
  if (error) throw error
  return data
}

// WhatsApp Graph API integration
export async function sendNotificationRow(row: any) {
  const supabase = getServiceClient()
  try {
    const accessToken = Deno.env.get('WHATSAPP_ACCESS_TOKEN')
    const phoneNumberId = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID')
    const apiVersion = Deno.env.get('WHATSAPP_API_VERSION') || 'v18.0'
    
    if (!accessToken || !phoneNumberId) {
      throw new Error('WhatsApp credentials not configured')
    }

    const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`
    
    // Determine if sending to group (ends with @g.us) or individual
    const isGroup = row.to_number.endsWith('@g.us')
    const recipient = row.to_number
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: recipient,
        type: 'text',
        text: {
          body: row.message
        }
      })
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(`WhatsApp API error: ${response.status} - ${JSON.stringify(errorData)}`)
    }

    const result = await response.json()
    
    // Mark as sent and store message ID
    const { error } = await supabase
      .from('notifications')
      .update({ 
        status: 'sent',
        payload: { 
          ...row.payload, 
          whatsapp_message_id: result.messages?.[0]?.id,
          is_group: isGroup 
        }
      })
      .eq('id', row.id)
    
    if (error) throw error
    
    return { ok: true, messageId: result.messages?.[0]?.id, isGroup }
  } catch (err) {
    // Mark as failed with error details
    await supabase
      .from('notifications')
      .update({ 
        status: 'failed',
        payload: { ...row.payload, error: (err as any).message }
      })
      .eq('id', row.id)
    
    return { ok: false, error: (err as any).message }
  }
}
