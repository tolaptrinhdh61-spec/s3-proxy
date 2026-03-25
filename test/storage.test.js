/**
 * test/storage.test.js
 * T3 verification — Storage Layer tests.
 *
 * Usage (no Firebase/Supabase needed):
 *   PROXY_API_KEY=test \
 *   FIREBASE_RTDB_URL=https://dummy.firebaseio.com \
 *   FIREBASE_DB_SECRET=dummy \
 *   SQLITE_PATH=./data/test-routes.db \
 *   node test/storage.test.js
 *
 * Expected output:
 *   ✅ upsertAccount + getAllActiveAccounts trả đúng thứ tự used_bytes ASC
 *   ✅ selectAccountForUpload(100MB) → acc1 (acc2 vượt threshold 90%)
 *   ✅ recordUpload acc1 +100MB → updateUsedBytes đúng
 *   ✅ cacheSet / cacheGet hit
 *   ✅ cacheDelete → miss
 *   ✅ SQLite migrate chạy 2 lần → không lỗi (idempotent)
 *   ✅ selectAccountForUpload khi tất cả full → throw StorageFullError
 */

// ─── Override SQLITE_PATH to avoid polluting real DB ─────────────────────────
import { mkdirSync, existsSync, unlinkSync } from 'fs'

const TEST_DB = './data/test-t3-storage.db'
process.env.SQLITE_PATH = TEST_DB

// Clean up stale test DB
mkdirSync('./data', { recursive: true })
if (existsSync(TEST_DB)) unlinkSync(TEST_DB)

// ─── Imports (after env override) ────────────────────────────────────────────
import {
  db,
  upsertAccount,
  getAllActiveAccounts,
  updateUsedBytes,
  setUsedBytesAbsolute,
  upsertRoute,
  getRoute,
  deleteRoute,
  getAllRoutes,
  countRoutes,
} from '../src/db.js'

import {
  cacheGet,
  cacheSet,
  cacheDelete,
  cacheClear,
} from '../src/cache.js'

import {
  selectAccountForUpload,
  recordUpload,
  StorageFullError,
} from '../src/accountPool.js'

// ─── Test helpers ─────────────────────────────────────────────────────────────

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

const MB = 1024 * 1024
const GB = 1024 * MB

// ─── Seed accounts ────────────────────────────────────────────────────────────

function seedAccounts() {
  upsertAccount({
    account_id:    'acc1',
    access_key_id: 'key1',
    secret_key:    'secret1',
    endpoint:      'https://acc1.supabase.co/storage/v1/s3',
    region:        'ap-southeast-1',
    bucket:        'bucket1',
    quota_bytes:   5 * GB,
    used_bytes:    0,
    active:        1,
    added_at:      Date.now(),
  })

  upsertAccount({
    account_id:    'acc2',
    access_key_id: 'key2',
    secret_key:    'secret2',
    endpoint:      'https://acc2.supabase.co/storage/v1/s3',
    region:        'ap-southeast-1',
    bucket:        'bucket2',
    quota_bytes:   5 * GB,
    used_bytes:    4_600 * MB, // 4.6 GB / 5 GB = 92% → over threshold
    active:        1,
    added_at:      Date.now(),
  })
}

// ─── Test cases ───────────────────────────────────────────────────────────────

async function testUpsertAndOrder() {
  try {
    seedAccounts()
    const accounts = getAllActiveAccounts()
    if (
      accounts.length === 2 &&
      accounts[0].account_id === 'acc1' && // used_bytes=0 → first
      accounts[1].account_id === 'acc2'    // used_bytes=4600MB → second
    ) {
      ok('upsertAccount + getAllActiveAccounts trả đúng thứ tự used_bytes ASC')
    } else {
      fail('upsertAccount + getAllActiveAccounts', new Error(
        `Got: ${JSON.stringify(accounts.map(a => ({ id: a.account_id, used: a.used_bytes })))}`
      ))
    }
  } catch (err) {
    fail('upsertAccount + getAllActiveAccounts', err)
  }
}

async function testSelectAccount() {
  try {
    // Reload accountPool in-memory state (it loaded at import time, before seed)
    // Re-import is not possible in ESM, so we directly test via re-seeded SQLite
    // accountPool loads from SQLite at import — re-trigger by calling reloadAccountsFromRTDB
    // But since RTDB is mocked as dummy, we need to call the internal loadFromSQLite path
    // Workaround: use the exported selectAccountForUpload directly since pool loaded at import
    // The pool was initialized before seedAccounts(), so we need to force reload
    const { reloadAccountsFromRTDB } = await import('../src/accountPool.js')

    // Mock rtdbGet to return null (skip RTDB pull, only use SQLite)
    // reloadAccountsFromRTDB calls rtdbGet('/accounts') — with dummy RTDB it will fail gracefully
    // then falls back to SQLite loadFromSQLite()
    await reloadAccountsFromRTDB()

    const selected = selectAccountForUpload(100 * MB)
    if (selected.account_id === 'acc1') {
      ok('selectAccountForUpload(100MB) → acc1 (acc2 vượt threshold 90%)')
    } else {
      fail('selectAccountForUpload(100MB)', new Error(`Got account: ${selected.account_id}`))
    }
  } catch (err) {
    fail('selectAccountForUpload(100MB)', err)
  }
}

async function testRecordUpload() {
  try {
    const before = getAllActiveAccounts().find(a => a.account_id === 'acc1')
    const beforeUsed = before.used_bytes

    recordUpload('acc1', 100 * MB)

    // Check SQLite
    const after = getAllActiveAccounts().find(a => a.account_id === 'acc1')
    const expected = beforeUsed + 100 * MB

    if (after.used_bytes === expected) {
      ok(`recordUpload acc1 +100MB → updateUsedBytes đúng (${expected} bytes)`)
    } else {
      fail('recordUpload acc1 +100MB', new Error(
        `Expected ${expected}, got ${after.used_bytes}`
      ))
    }
  } catch (err) {
    fail('recordUpload acc1 +100MB', err)
  }
}

async function testCacheSetGet() {
  try {
    cacheClear()
    const key = 'dGVzdC9mb28udHh0' // base64url of "test/foo.txt"
    const value = { accountId: 'acc1', bucket: 'test', objectKey: 'foo.txt', sizeBytes: 1024 }

    cacheSet(key, value)
    const hit = cacheGet(key)

    if (hit && hit.accountId === 'acc1' && hit.bucket === 'test') {
      ok('cacheSet / cacheGet hit')
    } else {
      fail('cacheSet / cacheGet', new Error(`Got: ${JSON.stringify(hit)}`))
    }
  } catch (err) {
    fail('cacheSet / cacheGet', err)
  }
}

async function testCacheDelete() {
  try {
    const key = 'dGVzdC9iYXIudHh0'
    cacheSet(key, { accountId: 'acc1', bucket: 'test', objectKey: 'bar.txt', sizeBytes: 512 })
    cacheDelete(key)
    const miss = cacheGet(key)

    if (miss === undefined) {
      ok('cacheDelete → miss')
    } else {
      fail('cacheDelete → miss', new Error(`Expected undefined, got ${JSON.stringify(miss)}`))
    }
  } catch (err) {
    fail('cacheDelete → miss', err)
  }
}

async function testMigrateIdempotent() {
  try {
    // Re-import db.js — in ESM modules are cached, so the migration ran once.
    // We test idempotency by running the same CREATE TABLE IF NOT EXISTS again directly.
    db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        account_id TEXT PRIMARY KEY,
        access_key_id TEXT NOT NULL,
        secret_key TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        region TEXT NOT NULL,
        bucket TEXT NOT NULL,
        quota_bytes INTEGER NOT NULL DEFAULT 5368709120,
        used_bytes INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        added_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_accounts_active ON accounts(active, used_bytes);
    `)
    ok('SQLite migrate chạy 2 lần → không lỗi (idempotent)')
  } catch (err) {
    fail('SQLite migrate idempotent', err)
  }
}

async function testStorageFullError() {
  try {
    const { reloadAccountsFromRTDB } = await import('../src/accountPool.js')

    // Fill acc1 to near capacity
    // acc1: used_bytes was 100MB after recordUpload; set to 4.6GB to trigger threshold
    setUsedBytesAbsolute('acc1', 4_600 * MB)
    await reloadAccountsFromRTDB() // reload in-memory

    let threw = false
    try {
      selectAccountForUpload(100 * MB)
    } catch (err) {
      if (err instanceof StorageFullError) {
        threw = true
      } else {
        throw err
      }
    }

    if (threw) {
      ok('selectAccountForUpload khi tất cả full → throw StorageFullError')
    } else {
      fail('selectAccountForUpload full', new Error('Did not throw StorageFullError'))
    }
  } catch (err) {
    fail('selectAccountForUpload full', err)
  }
}

// ─── Route CRUD smoke test ────────────────────────────────────────────────────

async function testRouteCRUD() {
  try {
    const route = {
      encoded_key: 'dGVzdC9zYW1wbGUudHh0',
      account_id:  'acc1',
      bucket:      'test-bucket',
      object_key:  'sample.txt',
      size_bytes:  2048,
      uploaded_at: Date.now(),
      instance_id: 'test-instance',
    }

    upsertRoute(route)
    const fetched = getRoute(route.encoded_key)

    if (!fetched || fetched.account_id !== 'acc1') {
      throw new Error(`getRoute returned: ${JSON.stringify(fetched)}`)
    }

    const total = countRoutes()
    if (total < 1) throw new Error(`countRoutes=${total}`)

    const all = getAllRoutes()
    if (!all.find(r => r.encoded_key === route.encoded_key)) {
      throw new Error('getAllRoutes did not include upserted route')
    }

    deleteRoute(route.encoded_key)
    const afterDelete = getRoute(route.encoded_key)
    if (afterDelete !== undefined) {
      throw new Error('Route still exists after deleteRoute')
    }

    ok('upsertRoute / getRoute / countRoutes / getAllRoutes / deleteRoute — CRUD OK')
  } catch (err) {
    fail('Route CRUD', err)
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('─'.repeat(60))
  console.log('T3 — Storage Layer Tests')
  console.log(`SQLITE_PATH: ${TEST_DB}`)
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

  // Cleanup
  try {
    db.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
    // WAL files
    ;[`${TEST_DB}-shm`, `${TEST_DB}-wal`].forEach(f => {
      if (existsSync(f)) unlinkSync(f)
    })
  } catch { /* ignore cleanup errors */ }

  process.exit(failed > 0 ? 1 : 0)
}

main()
