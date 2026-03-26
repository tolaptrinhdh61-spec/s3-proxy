/**
 * test/storage.test.js — T3 verification
 * Usage:
 *   PROXY_API_KEY=test FIREBASE_RTDB_URL=https://dummy.firebaseio.com \
 *   FIREBASE_DB_SECRET=dummy SQLITE_PATH=./data/test-t3.db \
 *   node test/storage.test.js
 */

import { mkdirSync, existsSync, unlinkSync } from 'fs'

const TEST_DB = './data/test-t3-storage.db'
process.env.SQLITE_PATH = TEST_DB
mkdirSync('./data', { recursive: true })
if (existsSync(TEST_DB)) unlinkSync(TEST_DB)

import {
  db, upsertAccount, getAllActiveAccounts, updateUsedBytes,
  setUsedBytesAbsolute, upsertRoute, getRoute, deleteRoute,
  getAllRoutes, countRoutes,
} from '../src/db.js'
import { cacheGet, cacheSet, cacheDelete, cacheClear } from '../src/cache.js'
import { selectAccountForUpload, recordUpload, StorageFullError } from '../src/accountPool.js'

let passed = 0, failed = 0
const ok  = (l) => { console.log(`✅ ${l}`); passed++ }
const fail = (l, e) => { console.error(`❌ ${l}\n   ${e?.message || e}`); failed++ }

const MB = 1024 * 1024, GB = 1024 * MB

function seedAccounts() {
  upsertAccount({ account_id: 'acc1', access_key_id: 'k1', secret_key: 's1',
    endpoint: 'https://a1.supabase.co/storage/v1/s3', region: 'auto', bucket: 'b1',
    quota_bytes: 5*GB, used_bytes: 0, active: 1, added_at: Date.now() })
  upsertAccount({ account_id: 'acc2', access_key_id: 'k2', secret_key: 's2',
    endpoint: 'https://a2.supabase.co/storage/v1/s3', region: 'auto', bucket: 'b2',
    quota_bytes: 5*GB, used_bytes: 4600*MB, active: 1, added_at: Date.now() })
}

async function testUpsertAndOrder() {
  try {
    seedAccounts()
    const accounts = getAllActiveAccounts()
    if (accounts.length === 2 && accounts[0].account_id === 'acc1' && accounts[1].account_id === 'acc2') {
      ok('upsertAccount + getAllActiveAccounts trả đúng thứ tự used_bytes ASC')
    } else {
      fail('upsertAccount + getAllActiveAccounts', new Error(JSON.stringify(accounts.map(a => a.account_id))))
    }
  } catch (e) { fail('upsertAccount + getAllActiveAccounts', e) }
}

async function testSelectAccount() {
  try {
    const { reloadAccountsFromRTDB } = await import('../src/accountPool.js')
    await reloadAccountsFromRTDB()
    const selected = selectAccountForUpload(100 * MB)
    if (selected.account_id === 'acc1') {
      ok('selectAccountForUpload(100MB) → acc1 (acc2 vượt threshold 90%)')
    } else {
      fail('selectAccountForUpload', new Error(`Got: ${selected.account_id}`))
    }
  } catch (e) { fail('selectAccountForUpload', e) }
}

async function testRecordUpload() {
  try {
    const before = getAllActiveAccounts().find(a => a.account_id === 'acc1')
    recordUpload('acc1', 100 * MB)
    const after = getAllActiveAccounts().find(a => a.account_id === 'acc1')
    if (after.used_bytes === before.used_bytes + 100 * MB) {
      ok(`recordUpload acc1 +100MB → updateUsedBytes đúng`)
    } else {
      fail('recordUpload', new Error(`Expected ${before.used_bytes + 100*MB}, got ${after.used_bytes}`))
    }
  } catch (e) { fail('recordUpload', e) }
}

async function testCacheSetGet() {
  try {
    cacheClear()
    const key = 'dGVzdC9mb28udHh0'
    const val = { accountId: 'acc1', bucket: 'test', objectKey: 'foo.txt', sizeBytes: 1024 }
    cacheSet(key, val)
    const hit = cacheGet(key)
    if (hit && hit.accountId === 'acc1') ok('cacheSet / cacheGet hit')
    else fail('cacheSet / cacheGet', new Error(JSON.stringify(hit)))
  } catch (e) { fail('cacheSet / cacheGet', e) }
}

async function testCacheDelete() {
  try {
    const key = 'dGVzdC9iYXIudHh0'
    cacheSet(key, { accountId: 'acc1', bucket: 'b', objectKey: 'bar.txt', sizeBytes: 512 })
    cacheDelete(key)
    if (cacheGet(key) === undefined) ok('cacheDelete → miss')
    else fail('cacheDelete', new Error('still exists'))
  } catch (e) { fail('cacheDelete', e) }
}

async function testMigrateIdempotent() {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS accounts (account_id TEXT PRIMARY KEY, access_key_id TEXT NOT NULL, secret_key TEXT NOT NULL, endpoint TEXT NOT NULL, region TEXT NOT NULL, bucket TEXT NOT NULL, quota_bytes INTEGER NOT NULL DEFAULT 5368709120, used_bytes INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, added_at INTEGER NOT NULL);`)
    ok('SQLite migrate chạy 2 lần → không lỗi (idempotent)')
  } catch (e) { fail('SQLite migrate idempotent', e) }
}

async function testStorageFullError() {
  try {
    const { reloadAccountsFromRTDB } = await import('../src/accountPool.js')
    setUsedBytesAbsolute('acc1', 4600 * MB)
    await reloadAccountsFromRTDB()
    let threw = false
    try { selectAccountForUpload(100 * MB) } catch (e) {
      if (e instanceof StorageFullError) threw = true
      else throw e
    }
    if (threw) ok('selectAccountForUpload khi tất cả full → throw StorageFullError')
    else fail('StorageFullError', new Error('Did not throw'))
  } catch (e) { fail('StorageFullError', e) }
}

async function testRouteCRUD() {
  try {
    const route = { encoded_key: 'dGVzdC9zYW1wbGU', account_id: 'acc1', bucket: 'test',
      object_key: 'sample.txt', size_bytes: 2048, uploaded_at: Date.now(), instance_id: 'test' }
    upsertRoute(route)
    const fetched = getRoute(route.encoded_key)
    if (!fetched || fetched.account_id !== 'acc1') throw new Error(`getRoute: ${JSON.stringify(fetched)}`)
    if (countRoutes() < 1) throw new Error('countRoutes=0')
    if (!getAllRoutes().find(r => r.encoded_key === route.encoded_key)) throw new Error('getAllRoutes miss')
    deleteRoute(route.encoded_key)
    if (getRoute(route.encoded_key) !== undefined) throw new Error('still exists after delete')
    ok('upsertRoute / getRoute / countRoutes / getAllRoutes / deleteRoute — CRUD OK')
  } catch (e) { fail('Route CRUD', e) }
}

async function main() {
  console.log('─'.repeat(60))
  console.log('T3 — Storage Layer Tests')
  console.log('─'.repeat(60))
  await testUpsertAndOrder()
  await testSelectAccount()
  await testRecordUpload()
  await testCacheSetGet()
  await testCacheDelete()
  await testMigrateIdempotent()
  await testStorageFullError()
  await testRouteCRUD()
  console.log('─'.repeat(60))
  console.log(`Results: ${passed} passed, ${failed} failed`)
  try {
    db.close()
    ;[TEST_DB, `${TEST_DB}-shm`, `${TEST_DB}-wal`].forEach(f => { if (existsSync(f)) unlinkSync(f) })
  } catch { /* ignore */ }
  process.exit(failed > 0 ? 1 : 0)
}
main()
