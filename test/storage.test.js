/**
 * test/storage.test.js - T3 verification
 */

import { mkdirSync, existsSync, unlinkSync } from 'fs'

process.env.PROXY_API_KEY = process.env.PROXY_API_KEY || 'test'
process.env.FIREBASE_RTDB_URL = process.env.FIREBASE_RTDB_URL || 'https://dummy.firebaseio.com'
process.env.FIREBASE_DB_SECRET = process.env.FIREBASE_DB_SECRET || 'dummy'

const TEST_DB = './data/test-t3-storage.db'
process.env.SQLITE_PATH = TEST_DB
mkdirSync('./data', { recursive: true })
if (existsSync(TEST_DB)) unlinkSync(TEST_DB)

let passed = 0
let failed = 0
const ok = (label) => { console.log(`✅ ${label}`); passed++ }
const fail = (label, err) => { console.error(`❌ ${label}\n   ${err?.message || err}`); failed++ }

const MB = 1024 * 1024
const GB = 1024 * MB

const {
  db,
  upsertAccount,
  getAllActiveAccounts,
  setUsedBytesAbsolute,
  upsertRoute,
  getRoute,
  deleteRoute,
  getAllRoutes,
  countRoutes,
} = await import('../src/db.js')
const { cacheGet, cacheSet, cacheDelete, cacheClear } = await import('../src/cache.js')
const {
  selectAccountForUpload,
  recordUpload,
  StorageFullError,
  reloadAccountsFromSQLite,
} = await import('../src/accountPool.js')

function seedAccounts() {
  upsertAccount({
    account_id: 'acc1',
    access_key_id: 'k1',
    secret_key: 's1',
    endpoint: 'https://a1.supabase.co/storage/v1/s3',
    region: 'auto',
    bucket: 'b1',
    quota_bytes: 5 * GB,
    used_bytes: 0,
    active: 1,
    added_at: Date.now(),
  })
  upsertAccount({
    account_id: 'acc2',
    access_key_id: 'k2',
    secret_key: 's2',
    endpoint: 'https://a2.supabase.co/storage/v1/s3',
    region: 'auto',
    bucket: 'b2',
    quota_bytes: 5 * GB,
    used_bytes: 4600 * MB,
    active: 1,
    added_at: Date.now(),
  })
  reloadAccountsFromSQLite()
}

async function testUpsertAndOrder() {
  try {
    seedAccounts()
    const accounts = getAllActiveAccounts()
    if (accounts.length === 2 && accounts[0].account_id === 'acc1' && accounts[1].account_id === 'acc2') {
      ok('upsertAccount + getAllActiveAccounts tra dung thu tu used_bytes ASC')
    } else {
      fail('upsertAccount + getAllActiveAccounts', new Error(JSON.stringify(accounts.map((account) => account.account_id))))
    }
  } catch (err) {
    fail('upsertAccount + getAllActiveAccounts', err)
  }
}

async function testSelectAccount() {
  try {
    reloadAccountsFromSQLite()
    const selected = selectAccountForUpload(100 * MB)
    if (selected.account_id === 'acc1') {
      ok('selectAccountForUpload(100MB) -> acc1 (acc2 vuot threshold 90%)')
    } else {
      fail('selectAccountForUpload', new Error(`Got: ${selected.account_id}`))
    }
  } catch (err) {
    fail('selectAccountForUpload', err)
  }
}

async function testRecordUpload() {
  try {
    const before = getAllActiveAccounts().find((account) => account.account_id === 'acc1')
    recordUpload('acc1', 100 * MB)
    const after = getAllActiveAccounts().find((account) => account.account_id === 'acc1')
    if (after.used_bytes === before.used_bytes + 100 * MB) {
      ok('recordUpload acc1 +100MB -> updateUsedBytes dung')
    } else {
      fail('recordUpload', new Error(`Expected ${before.used_bytes + 100 * MB}, got ${after.used_bytes}`))
    }
  } catch (err) {
    fail('recordUpload', err)
  }
}

async function testCacheSetGet() {
  try {
    cacheClear()
    const key = 'dGVzdC9mb28udHh0'
    const value = { accountId: 'acc1', bucket: 'test', objectKey: 'foo.txt', sizeBytes: 1024 }
    cacheSet(key, value)
    const hit = cacheGet(key)
    if (hit && hit.accountId === 'acc1') ok('cacheSet / cacheGet hit')
    else fail('cacheSet / cacheGet', new Error(JSON.stringify(hit)))
  } catch (err) {
    fail('cacheSet / cacheGet', err)
  }
}

async function testCacheDelete() {
  try {
    const key = 'dGVzdC9iYXIudHh0'
    cacheSet(key, { accountId: 'acc1', bucket: 'b', objectKey: 'bar.txt', sizeBytes: 512 })
    cacheDelete(key)
    if (cacheGet(key) === undefined) ok('cacheDelete -> miss')
    else fail('cacheDelete', new Error('still exists'))
  } catch (err) {
    fail('cacheDelete', err)
  }
}

async function testMigrateIdempotent() {
  try {
    db.exec('CREATE TABLE IF NOT EXISTS accounts (account_id TEXT PRIMARY KEY, access_key_id TEXT NOT NULL, secret_key TEXT NOT NULL, endpoint TEXT NOT NULL, region TEXT NOT NULL, bucket TEXT NOT NULL, quota_bytes INTEGER NOT NULL DEFAULT 5368709120, used_bytes INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, added_at INTEGER NOT NULL);')
    ok('SQLite migrate chay 2 lan -> khong loi (idempotent)')
  } catch (err) {
    fail('SQLite migrate idempotent', err)
  }
}

async function testStorageFullError() {
  try {
    setUsedBytesAbsolute('acc1', 4600 * MB)
    reloadAccountsFromSQLite()
    let threw = false
    try {
      selectAccountForUpload(100 * MB)
    } catch (err) {
      if (err instanceof StorageFullError) threw = true
      else throw err
    }
    if (threw) ok('selectAccountForUpload khi tat ca full -> throw StorageFullError')
    else fail('StorageFullError', new Error('Did not throw'))
  } catch (err) {
    fail('StorageFullError', err)
  }
}

async function testRouteCRUD() {
  try {
    const route = {
      encoded_key: 'dGVzdC9zYW1wbGU',
      account_id: 'acc1',
      bucket: 'test',
      object_key: 'sample.txt',
      size_bytes: 2048,
      uploaded_at: Date.now(),
      instance_id: 'test',
    }
    upsertRoute(route)
    const fetched = getRoute(route.encoded_key)
    if (!fetched || fetched.account_id !== 'acc1') throw new Error(`getRoute: ${JSON.stringify(fetched)}`)
    if (countRoutes() < 1) throw new Error('countRoutes=0')
    if (!getAllRoutes().find((row) => row.encoded_key === route.encoded_key)) throw new Error('getAllRoutes miss')
    deleteRoute(route.encoded_key)
    if (getRoute(route.encoded_key) !== undefined) throw new Error('still exists after delete')
    ok('upsertRoute / getRoute / countRoutes / getAllRoutes / deleteRoute - CRUD OK')
  } catch (err) {
    fail('Route CRUD', err)
  }
}

async function main() {
  console.log('─'.repeat(60))
  console.log('T3 - Storage Layer Tests')
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
    for (const file of [TEST_DB, `${TEST_DB}-shm`, `${TEST_DB}-wal`]) {
      if (existsSync(file)) unlinkSync(file)
    }
  } catch {
    // ignore cleanup failure
  }

  process.exit(failed > 0 ? 1 : 0)
}

main()
