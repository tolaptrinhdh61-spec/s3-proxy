/**
 * test/firebase.test.js — T2 verification
 * Usage:
 *   PROXY_API_KEY=test FIREBASE_RTDB_URL=https://<project>.firebaseio.com \
 *   FIREBASE_DB_SECRET=<secret> node test/firebase.test.js
 */

import { rtdbGet, rtdbSet, rtdbPatch, rtdbDelete, rtdbListen, rtdbBatchPatch } from '../src/firebase.js'

let passed = 0, failed = 0
const ok   = (l) => { console.log(`✅ ${l}`); passed++ }
const fail = (l, e) => { console.error(`❌ ${l}\n   ${e?.message || e}`); failed++ }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function testSet()   { await rtdbSet('/test/ping', { ok: true }); ok('rtdbSet /test/ping') }
async function testGet()   {
  const v = await rtdbGet('/test/ping')
  if (v?.ok === true) ok(`rtdbGet /test/ping → ${JSON.stringify(v)}`)
  else fail('rtdbGet', new Error(`got ${JSON.stringify(v)}`))
}
async function testPatch() {
  await rtdbPatch('/test/ping', { patched: 1 })
  const v = await rtdbGet('/test/ping')
  if (v?.ok === true && v?.patched === 1) ok(`rtdbPatch /test/ping → ${JSON.stringify(v)}`)
  else fail('rtdbPatch', new Error(`got ${JSON.stringify(v)}`))
}
async function testDelete() {
  await rtdbDelete('/test/ping')
  const v = await rtdbGet('/test/ping')
  if (v === null) ok('rtdbDelete /test/ping')
  else fail('rtdbDelete', new Error(`Expected null, got ${JSON.stringify(v)}`))
}
async function testListen() {
  return new Promise((resolve) => {
    let received = false, listener = null
    const timeout = setTimeout(() => {
      listener?.close()
      if (!received) fail('rtdbListen nhận event trong 3s', new Error('Timeout'))
      resolve()
    }, 3000)
    listener = rtdbListen('/test/listen', (type, data) => {
      if (!received && type === 'put') {
        received = true; clearTimeout(timeout); listener?.close()
        ok('rtdbListen nhận event trong 3s')
        rtdbDelete('/test/listen').catch(() => {})
        resolve()
      }
    }, (err) => { clearTimeout(timeout); listener?.close(); fail('rtdbListen', err); resolve() })
    sleep(500).then(() => rtdbSet('/test/listen', { ts: Date.now() })).catch(() => {})
  })
}
async function testBatchPatch() {
  const updates = {}
  for (let i = 0; i < 500; i++) updates[`/test/batch/item${i}`] = { idx: i }
  await rtdbBatchPatch(updates)
  const s0 = await rtdbGet('/test/batch/item0')
  const s499 = await rtdbGet('/test/batch/item499')
  if (s0?.idx === 0 && s499?.idx === 499) ok('rtdbBatchPatch 500 entries (auto-chunk 2 lần)')
  else fail('rtdbBatchPatch', new Error(`item0=${JSON.stringify(s0)} item499=${JSON.stringify(s499)}`))
  await rtdbDelete('/test/batch').catch(() => {})
}

async function main() {
  console.log('─'.repeat(50))
  console.log('T2 — Firebase RTDB Layer Tests')
  console.log(`FIREBASE_RTDB_URL: ${process.env.FIREBASE_RTDB_URL}`)
  console.log('─'.repeat(50))
  try {
    await testSet(); await testGet(); await testPatch()
    await testDelete(); await testListen(); await testBatchPatch()
  } catch (e) { console.error('Unhandled:', e); failed++ }
  console.log('─'.repeat(50))
  console.log(`Results: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}
main()
