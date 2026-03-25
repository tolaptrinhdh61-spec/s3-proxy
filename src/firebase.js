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

function buildUrl(path) {
  const cleanPath = path.replace(/\/+$/, '')
  return `${config.FIREBASE_RTDB_URL}${cleanPath}.json?auth=${config.FIREBASE_DB_SECRET}`
}

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

export async function rtdbGet(path) {
  return rtdbFetch('GET', path)
}

export async function rtdbSet(path, value) {
  await rtdbFetch('PUT', path, value)
}

export async function rtdbPatch(path, value) {
  await rtdbFetch('PATCH', path, value)
}

export async function rtdbDelete(path) {
  const url = buildUrl(path)
  const res = await fetch(url, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '')
    throw new Error(`RTDB DELETE ${path} → HTTP ${res.status}: ${text}`)
  }
}

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
  return json.name
}

export function rtdbListen(path, onData, onError) {
  const cleanPath = path.replace(/\/+$/, '')
  const url = `${config.FIREBASE_RTDB_URL}${cleanPath}.json?auth=${config.FIREBASE_DB_SECRET}`

  const es = new EventSource(url, {
    headers: { Accept: 'text/event-stream' },
  })

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

export async function rtdbBatchPatch(updates) {
  const entries = Object.entries(updates)
  const chunkSize = config.RTDB_SYNC_BATCH_SIZE

  if (entries.length === 0) return

  for (let i = 0; i < entries.length; i += chunkSize) {
    const chunk = entries.slice(i, i + chunkSize)
    const chunkObj = Object.fromEntries(chunk)
    await rtdbFetch('PATCH', '/', chunkObj)
  }
}
