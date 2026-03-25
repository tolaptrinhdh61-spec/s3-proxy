/**
 * src/firebase.js
 * Firebase Realtime Database layer using REST API + SSE (no firebase-admin SDK).
 * All operations use fetch() with ?auth=FIREBASE_DB_SECRET.
 * SSE listener uses 'eventsource' npm package.
 *
 * Exported functions:
 *   rtdbGet(path) → parsed JSON or null
 *   rtdbSet(path, value) → void
 *   rtdbPatch(path, value) → void
 *   rtdbDelete(path) → void
 *   rtdbPush(path, value) → generated key string
 *   rtdbListen(path, onData, onError) → { close() }
 *   rtdbBatchPatch(updates) → void (auto-chunks by RTDB_SYNC_BATCH_SIZE)
 */

import EventSource from 'eventsource'
import config from './config.js'

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Build full RTDB REST URL for a given path.
 * path must start with '/'
 */
function buildUrl(path) {
  // Normalize: strip trailing slash, ensure leading slash
  const cleanPath = path.replace(/\/+$/, '')
  return `${config.FIREBASE_RTDB_URL}${cleanPath}.json?auth=${config.FIREBASE_DB_SECRET}`
}

/**
 * Generic fetch wrapper with error handling.
 * Returns parsed JSON body or null (for 404 / empty).
 * Throws on non-2xx (except 404 which returns null).
 */
async function rtdbFetch(method, path, body) {
  const url = buildUrl(path)
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  }
  if (body !== undefined) {
    options.body = JSON.stringify(body)
  }

  const res = await fetch(url, options)

  if (res.status === 404) return null

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`RTDB ${method} ${path} → HTTP ${res.status}: ${text}`)
  }

  const text = await res.text()
  if (!text || text === 'null') return null

  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ─── Exported functions ──────────────────────────────────────────────────────

/**
 * GET a value from RTDB.
 * Returns parsed JSON or null if not found.
 */
export async function rtdbGet(path) {
  return rtdbFetch('GET', path)
}

/**
 * SET (overwrite) a value at path.
 * Equivalent to RTDB PUT — replaces entire node.
 */
export async function rtdbSet(path, value) {
  await rtdbFetch('PUT', path, value)
}

/**
 * PATCH (merge) a value at path.
 * Only updates specified keys, leaves others intact.
 */
export async function rtdbPatch(path, value) {
  await rtdbFetch('PATCH', path, value)
}

/**
 * DELETE a node at path.
 */
export async function rtdbDelete(path) {
  const url = buildUrl(path)
  const res = await fetch(url, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '')
    throw new Error(`RTDB DELETE ${path} → HTTP ${res.status}: ${text}`)
  }
}

/**
 * PUSH a new child under path (Firebase auto-ID).
 * Returns the generated key string.
 */
export async function rtdbPush(path, value) {
  const url = buildUrl(path)
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`RTDB PUSH ${path} → HTTP ${res.status}: ${text}`)
  }

  const json = await res.json()
  return json.name // Firebase returns { "name": "-auto_generated_key" }
}

/**
 * Listen to realtime changes at path using SSE (EventSource).
 * onData(eventType, data) is called for each SSE event.
 *   eventType: 'put' | 'patch' | 'keep-alive' | 'cancel' | 'auth_revoked'
 *   data: { path, data } object (for put/patch)
 * onError(err) is called on connection errors.
 *
 * Returns { close() } to stop listening.
 */
export function rtdbListen(path, onData, onError) {
  // SSE URL — must use text/event-stream accept header via query param
  const cleanPath = path.replace(/\/+$/, '')
  const url = `${config.FIREBASE_RTDB_URL}${cleanPath}.json?auth=${config.FIREBASE_DB_SECRET}`

  const es = new EventSource(url, {
    headers: { Accept: 'text/event-stream' },
  })

  // Firebase SSE events: put, patch, keep-alive, cancel, auth_revoked
  const handleEvent = (eventType) => (event) => {
    try {
      if (eventType === 'keep-alive') {
        onData('keep-alive', null)
        return
      }
      if (eventType === 'cancel' || eventType === 'auth_revoked') {
        const err = new Error(`RTDB SSE ${eventType} on ${path}`)
        onError(err)
        return
      }
      const parsed = JSON.parse(event.data)
      onData(eventType, parsed)
    } catch (err) {
      onError(new Error(`RTDB SSE parse error on ${path}: ${err.message}`))
    }
  }

  es.addEventListener('put', handleEvent('put'))
  es.addEventListener('patch', handleEvent('patch'))
  es.addEventListener('keep-alive', handleEvent('keep-alive'))
  es.addEventListener('cancel', handleEvent('cancel'))
  es.addEventListener('auth_revoked', handleEvent('auth_revoked'))

  es.onerror = (err) => {
    onError(new Error(`RTDB SSE connection error on ${path}: ${JSON.stringify(err)}`))
  }

  return {
    close() {
      es.close()
    },
  }
}

/**
 * Batch PATCH to root using Firebase multi-path update.
 * updates: flat object where key = full path (e.g. '/routes/abc123'), value = data.
 * Auto-chunks if > RTDB_SYNC_BATCH_SIZE entries.
 *
 * Firebase multi-path update format:
 *   PATCH /  { "/routes/key1": {...}, "/routes/key2": {...} }
 */
export async function rtdbBatchPatch(updates) {
  const entries = Object.entries(updates)
  const chunkSize = config.RTDB_SYNC_BATCH_SIZE

  if (entries.length === 0) return

  // Split into chunks of chunkSize
  for (let i = 0; i < entries.length; i += chunkSize) {
    const chunk = entries.slice(i, i + chunkSize)
    const chunkObj = Object.fromEntries(chunk)
    await rtdbFetch('PATCH', '/', chunkObj)
  }
}
