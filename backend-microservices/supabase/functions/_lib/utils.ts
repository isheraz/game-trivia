export function normalizePhoneNumber(phoneNumber: string | null | undefined) {
  if (!phoneNumber) return phoneNumber
  let cleaned = phoneNumber.replace(/\D/g, '')
  if (cleaned.startsWith('0')) cleaned = '92' + cleaned.substring(1)
  if (cleaned.length === 10 && cleaned.startsWith('3')) cleaned = '92' + cleaned
  return cleaned
}

export function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers || {}) },
    status: init.status || 200
  })
}

export function badRequest(message: string) {
  return jsonResponse({ error: message }, { status: 400 })
}

export function unauthorized(message = 'Unauthorized') {
  return jsonResponse({ error: message }, { status: 401 })
}

export function forbidden(message = 'Forbidden') {
  return jsonResponse({ error: message }, { status: 403 })
}

export function serverError(message: string) {
  return jsonResponse({ error: message }, { status: 500 })
}
