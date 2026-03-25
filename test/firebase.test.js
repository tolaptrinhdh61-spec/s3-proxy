/**
 * test/firebase.test.js
 * T2 verification test for Firebase RTDB layer.
 *
 * Usage:
 *   PROXY_API_KEY=test FIREBASE_RTDB_URL=https://<project>.firebaseio.com \
 *   FIREBASE_DB_SECRET=<secret> node test/firebase.test.js
 *
 * Expected output:
 *   ✅ rtdbSet /test/ping
 *   ✅ rtdbGet /test/ping → { ok: true }
 *   ✅ rtdbPatch /test/ping → { ok: true, patched: 1 }
 *   ✅ rtdbDelete /test/ping
 *   ✅ rtdbListen nhận event trong 3s
 *   ✅ rtdbBatchPatch 500 entries (auto-chunk 2 lần)
 */

import {
  rtdbGet,
  rtdbSet,
  rtdbPatch,
  rtdbDelete,
  rtdbListen,
  rtdbBatchPatch,
} from '../src/firebase.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function ok(label) {
  console.log(`✅ ${label}`)
  passed++
}

function fail(label, err) {
  console.error(`❌ ${label}`)
  console.error(`   ${err?.message || err}`)
  failed++
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testSet() {
  await rtdbSet('/test/ping', { ok: true })
  ok('rtdbSet /test/ping')
}

async function testGet() {
  const val = await rtdbGet('/test/ping')
  if (val && val.ok === true) {
    ok(`rtdbGet /test/ping → ${JSON.stringify(val)}`)
  } else {
    fail('rtdbGet /test/ping', new Error(`Expected { ok: true }, got ${JSON.stringify(val)}`))
  }
}

async function testPatch() {
  await rtdbPatch('/test/ping', { patched: 1 })
  const val = await rtdbGet('/test/ping')
  if (val && val.ok === true && val.patched === 1) {
    ok(`rtdbPatch /test/ping → ${JSON.stringify(val)}`)
  } else {
    fail('rtdbPatch /test/ping', new Error(`Expected { ok: true, patched: 1 }, got ${JSON.stringify(val)}`))
  }
}

async function testDelete() {
  await rtdbDelete('/test/ping')
  const val = await rtdbGet('/test/ping')
  if (val === null) {
    ok('rtdbDelete /test/ping')
  } else {
    fail('rtdbDelete /test/ping', new Error(`Expected null after delete, got ${JSON.stringify(val)}`))
  }
}

async function testListen() {
  return new Promise((resolve) => {
    let received = false
    let listener = null

    const timeout = setTimeout(() => {
      listener?.close()
      if (!received) {
        fail('rtdbListen nhận event trong 3s', new Error('Timeout: no event received in 3s'))
      }
      resolve()
    }, 3000)

    listener = rtdbListen(
      '/test/listen',
      (eventType, data) => {
        // 'put' with path '/' is the initial sync event from Firebase
        if (!received && eventType === 'put') {
          received = true
          clearTimeout(timeout)
          listener?.close()
          ok('rtdbListen nhận event trong 3s')
          // Cleanup test node (fire and forget)
          rtdbDelete('/test/listen').catch(() => {})
          resolve()
        }
      },
      (err) => {
        clearTimeout(timeout)
        listener?.close()
        fail('rtdbListen nhận event trong 3s', err)
        resolve()
      }
    )

    // Trigger a write so listener fires (write after short delay to let SSE connect)
    sleep(500).then(() => rtdbSet('/test/listen', { ts: Date.now() })).catch(() => {})
  })
}

async function testBatchPatch() {
  // Build 500 entries — should auto-chunk into 2 batches (default RTDB_SYNC_BATCH_SIZE=400)
  const updates = {}
  for (let i = 0; i < 500; i++) {
    updates[`/test/batch/item${i}`] = { idx: i, ts: Date.now() }
  }

  await rtdbBatchPatch(updates)

  // Spot-check a few entries
  const sample = await rtdbGet('/test/batch/item0')
  const sampleLast = await rtdbGet('/test/batch/item499')

  if (sample && sample.idx === 0 && sampleLast && sampleLast.idx === 499) {
    ok('rtdbBatchPatch 500 entries (auto-chunk 2 lần)')
  } else {
    fail('rtdbBatchPatch 500 entries', new Error(
      `sample item0=${JSON.stringify(sample)}, item499=${JSON.stringify(sampleLast)}`
    ))
  }

  // Cleanup
  await rtdbDelete('/test/batch').catch(() => {})
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('─'.repeat(50))
  console.log('T2 — Firebase RTDB Layer Tests')
  console.log(`FIREBASE_RTDB_URL: ${process.env.FIREBASE_RTDB_URL}`)
  console.log('─'.repeat(50))

  try {
    await testSet()
    await testGet()
    await testPatch()
    await testDelete()
    await testListen()
    await testBatchPatch()
  } catch (err) {
    console.error('Unhandled test error:', err)
    failed++
  }

  console.log('─'.repeat(50))
  console.log(`Results: ${passed} passed, ${failed} failed`)

  if (failed > 0) {
    process.exit(1)
  }
}

main()
