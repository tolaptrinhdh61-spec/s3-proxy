/**
 * src/db.js
 * SQLite init, migrations (idempotent), and all query functions.
 * Uses better-sqlite3 (synchronous).
 *
 * Exported functions:
 *   // Accounts
 *   upsertAccount(account)
 *   getAllActiveAccounts()
 *   updateUsedBytes(accountId, delta)
 *   setUsedBytesAbsolute(accountId, bytes)
 *
 *   // Routes
 *   upsertRoute(route)
 *   getRoute(encodedKey)
 *   deleteRoute(encodedKey)
 *   getAllRoutes()
 *   countRoutes()
 *
 *   // Multipart
 *   upsertMultipartUpload(upload)
 *   getMultipartUpload(uploadId)
 *   deleteMultipartUpload(uploadId)
 *
 *   // Misc
 *   db  — raw better-sqlite3 instance (for transactions)
 */

import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import config from './config.js'

// ─── Init ────────────────────────────────────────────────────────────────────

// Ensure data directory exists
try {
  mkdirSync(dirname(config.SQLITE_PATH), { recursive: true })
} catch {
  // ignore if already exists
}

export const db = new Database(config.SQLITE_PATH)

db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
db.pragma('cache_size = -64000') // 64 MB
db.pragma('foreign_keys = ON')
db.pragma('busy_timeout = 5000')

// ─── Schema migrations (idempotent) ──────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    account_id     TEXT    PRIMARY KEY,
    access_key_id  TEXT    NOT NULL,
    secret_key     TEXT    NOT NULL,
    endpoint       TEXT    NOT NULL,
    region         TEXT    NOT NULL,
    bucket         TEXT    NOT NULL,
    quota_bytes    INTEGER NOT NULL DEFAULT 5368709120,
    used_bytes     INTEGER NOT NULL DEFAULT 0,
    active         INTEGER NOT NULL DEFAULT 1,
    added_at       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS routes (
    encoded_key  TEXT    PRIMARY KEY,
    account_id   TEXT    NOT NULL REFERENCES accounts(account_id),
    bucket       TEXT    NOT NULL,
    object_key   TEXT    NOT NULL,
    size_bytes   INTEGER NOT NULL DEFAULT 0,
    uploaded_at  INTEGER NOT NULL,
    instance_id  TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_routes_account  ON routes(account_id);
  CREATE INDEX IF NOT EXISTS idx_routes_bucket   ON routes(bucket);
  CREATE INDEX IF NOT EXISTS idx_routes_uploaded ON routes(uploaded_at);
  CREATE INDEX IF NOT EXISTS idx_accounts_active ON accounts(active, used_bytes);

  CREATE TABLE IF NOT EXISTS multipart_uploads (
    upload_id   TEXT    PRIMARY KEY,
    account_id  TEXT    NOT NULL,
    bucket      TEXT    NOT NULL,
    object_key  TEXT    NOT NULL,
    started_at  INTEGER NOT NULL
  );
`)

// ─── Prepared statements ─────────────────────────────────────────────────────

const stmts = {
  upsertAccount: db.prepare(`
    INSERT OR REPLACE INTO accounts
      (account_id, access_key_id, secret_key, endpoint, region, bucket,
       quota_bytes, used_bytes, active, added_at)
    VALUES
      (@account_id, @access_key_id, @secret_key, @endpoint, @region, @bucket,
       @quota_bytes, @used_bytes, @active, @added_at)
  `),

  getAllActiveAccounts: db.prepare(`
    SELECT * FROM accounts
    WHERE active = 1
    ORDER BY used_bytes ASC
  `),

  updateUsedBytes: db.prepare(`
    UPDATE accounts
    SET used_bytes = MAX(0, used_bytes + @delta)
    WHERE account_id = @account_id
  `),

  setUsedBytesAbsolute: db.prepare(`
    UPDATE accounts
    SET used_bytes = @bytes
    WHERE account_id = @account_id
  `),

  upsertRoute: db.prepare(`
    INSERT OR REPLACE INTO routes
      (encoded_key, account_id, bucket, object_key, size_bytes, uploaded_at, instance_id)
    VALUES
      (@encoded_key, @account_id, @bucket, @object_key, @size_bytes, @uploaded_at, @instance_id)
  `),

  getRoute: db.prepare(`
    SELECT * FROM routes WHERE encoded_key = ?
  `),

  deleteRoute: db.prepare(`
    DELETE FROM routes WHERE encoded_key = ?
  `),

  getAllRoutes: db.prepare(`
    SELECT * FROM routes ORDER BY uploaded_at DESC
  `),

  countRoutes: db.prepare(`
    SELECT COUNT(*) as count FROM routes
  `),

  upsertMultipartUpload: db.prepare(`
    INSERT OR REPLACE INTO multipart_uploads
      (upload_id, account_id, bucket, object_key, started_at)
    VALUES
      (@upload_id, @account_id, @bucket, @object_key, @started_at)
  `),

  getMultipartUpload: db.prepare(`
    SELECT * FROM multipart_uploads WHERE upload_id = ?
  `),

  deleteMultipartUpload: db.prepare(`
    DELETE FROM multipart_uploads WHERE upload_id = ?
  `),
}

// ─── Exported functions ──────────────────────────────────────────────────────

/**
 * Upsert an account record.
 * @param {object} account - { account_id, access_key_id, secret_key, endpoint, region, bucket, quota_bytes?, used_bytes?, active?, added_at }
 */
export function upsertAccount(account) {
  stmts.upsertAccount.run({
    account_id:    account.account_id,
    access_key_id: account.access_key_id,
    secret_key:    account.secret_key,
    endpoint:      account.endpoint,
    region:        account.region,
    bucket:        account.bucket,
    quota_bytes:   account.quota_bytes    ?? 5_368_709_120,
    used_bytes:    account.used_bytes     ?? 0,
    active:        account.active         ?? 1,
    added_at:      account.added_at       ?? Date.now(),
  })
}

/**
 * Get all active accounts sorted by used_bytes ASC (least used first).
 * @returns {Array<object>}
 */
export function getAllActiveAccounts() {
  return stmts.getAllActiveAccounts.all()
}

/**
 * Update used_bytes for an account by delta (positive = add, negative = subtract).
 * Clamps to minimum 0.
 * @param {string} accountId
 * @param {number} delta - bytes to add (negative to subtract)
 */
export function updateUsedBytes(accountId, delta) {
  stmts.updateUsedBytes.run({ account_id: accountId, delta })
}

/**
 * Set used_bytes to an absolute value (from poller).
 * @param {string} accountId
 * @param {number} bytes
 */
export function setUsedBytesAbsolute(accountId, bytes) {
  stmts.setUsedBytesAbsolute.run({ account_id: accountId, bytes })
}

/**
 * Upsert a route record.
 * @param {object} route - { encoded_key, account_id, bucket, object_key, size_bytes, uploaded_at, instance_id }
 */
export function upsertRoute(route) {
  stmts.upsertRoute.run({
    encoded_key: route.encoded_key,
    account_id:  route.account_id,
    bucket:      route.bucket,
    object_key:  route.object_key,
    size_bytes:  route.size_bytes  ?? 0,
    uploaded_at: route.uploaded_at ?? Date.now(),
    instance_id: route.instance_id ?? '',
  })
}

/**
 * Get a single route by encodedKey.
 * @param {string} encodedKey
 * @returns {object|undefined}
 */
export function getRoute(encodedKey) {
  return stmts.getRoute.get(encodedKey)
}

/**
 * Delete a route by encodedKey.
 * @param {string} encodedKey
 */
export function deleteRoute(encodedKey) {
  stmts.deleteRoute.run(encodedKey)
}

/**
 * Get all routes (used at startup for RTDB push).
 * @returns {Array<object>}
 */
export function getAllRoutes() {
  return stmts.getAllRoutes.all()
}

/**
 * Count total routes in SQLite.
 * @returns {number}
 */
export function countRoutes() {
  return stmts.countRoutes.get().count
}

/**
 * Upsert a multipart upload tracking record.
 * @param {object} upload - { upload_id, account_id, bucket, object_key, started_at? }
 */
export function upsertMultipartUpload(upload) {
  stmts.upsertMultipartUpload.run({
    upload_id:  upload.upload_id,
    account_id: upload.account_id,
    bucket:     upload.bucket,
    object_key: upload.object_key,
    started_at: upload.started_at ?? Date.now(),
  })
}

/**
 * Get a multipart upload record by uploadId.
 * @param {string} uploadId
 * @returns {object|undefined}
 */
export function getMultipartUpload(uploadId) {
  return stmts.getMultipartUpload.get(uploadId)
}

/**
 * Delete a multipart upload record.
 * @param {string} uploadId
 */
export function deleteMultipartUpload(uploadId) {
  stmts.deleteMultipartUpload.run(uploadId)
}
