/**
 * src/accountPool.js
 * Account pool management: selection, quota tracking, in-memory state.
 *
 * Exported:
 *   StorageFullError       — custom error class
 *   selectAccountForUpload(sizeBytes) → account object
 *   recordUpload(accountId, sizeBytes)
 *   recordDelete(accountId, sizeBytes)
 *   reloadAccountsFromRTDB() → void (async)
 *   getAccountsStats()     → { total, active, full, totalBytes, usedBytes }
 *   getAccount(accountId)  → account | undefined
 */

import { getAllActiveAccounts, upsertAccount, updateUsedBytes } from './db.js'
import { rtdbGet, rtdbPatch } from './firebase.js'
import config from './config.js'

// ─── StorageFullError ─────────────────────────────────────────────────────────

export class StorageFullError extends Error {
  constructor(message = 'All storage accounts are at capacity') {
    super(message)
    this.name = 'StorageFullError'
    this.statusCode = 507
  }
}

// ─── In-memory state ──────────────────────────────────────────────────────────

/** @type {Map<string, object>} accountId → account row */
const accountMap = new Map()

/** Sorted array of active accounts (least usedBytes first) */
let activeAccounts = []

// ─── Internal helpers ─────────────────────────────────────────────────────────

function rebuildActiveAccounts() {
  activeAccounts = [...accountMap.values()]
    .filter(a => a.active === 1 || a.active === true)
    .sort((a, b) => a.used_bytes - b.used_bytes)
}

function loadFromSQLite() {
  const rows = getAllActiveAccounts()
  accountMap.clear()
  for (const row of rows) {
    accountMap.set(row.account_id, { ...row })
  }
  rebuildActiveAccounts()
}

// ─── Initialize on module load ────────────────────────────────────────────────

loadFromSQLite()

// ─── Exported functions ───────────────────────────────────────────────────────

/**
 * Select best account for an upload of sizeBytes.
 * Iterates accounts sorted by used_bytes ASC, picks first under QUOTA_THRESHOLD.
 * Throws StorageFullError if none available.
 *
 * @param {number} sizeBytes
 * @param {Set<string>} [excludeIds] - accountIds to skip (used for fallback retry)
 * @returns {object} account row
 */
export function selectAccountForUpload(sizeBytes, excludeIds = new Set()) {
  for (const account of activeAccounts) {
    if (excludeIds.has(account.account_id)) continue

    const projected = (account.used_bytes + sizeBytes) / account.quota_bytes
    if (projected < config.QUOTA_THRESHOLD) {
      return account
    }
  }

  throw new StorageFullError(
    `No account can accept ${sizeBytes} bytes (threshold: ${config.QUOTA_THRESHOLD * 100}%)`
  )
}

/**
 * Record an upload: update SQLite, in-memory map, re-sort, then async push to RTDB.
 * RTDB write is fire-and-forget (not awaited in request path).
 *
 * @param {string} accountId
 * @param {number} sizeBytes
 */
export function recordUpload(accountId, sizeBytes) {
  // SQLite (sync)
  updateUsedBytes(accountId, sizeBytes)

  // In-memory
  const account = accountMap.get(accountId)
  if (account) {
    account.used_bytes = Math.max(0, account.used_bytes + sizeBytes)
    rebuildActiveAccounts()

    // RTDB fire-and-forget
    Promise.resolve().then(() =>
      rtdbPatch(`/accounts/${accountId}`, { usedBytes: account.used_bytes })
    ).catch(() => {})
  }
}

/**
 * Record a delete: update SQLite, in-memory map, re-sort, then async push to RTDB.
 *
 * @param {string} accountId
 * @param {number} sizeBytes
 */
export function recordDelete(accountId, sizeBytes) {
  // SQLite (sync)
  updateUsedBytes(accountId, -sizeBytes)

  // In-memory
  const account = accountMap.get(accountId)
  if (account) {
    account.used_bytes = Math.max(0, account.used_bytes - sizeBytes)
    rebuildActiveAccounts()

    // RTDB fire-and-forget
    Promise.resolve().then(() =>
      rtdbPatch(`/accounts/${accountId}`, { usedBytes: account.used_bytes })
    ).catch(() => {})
  }
}

/**
 * Reload all accounts from RTDB → upsert into SQLite → rebuild in-memory map.
 * Called at startup, when StorageFullError thrown, and on RTDB /accounts change.
 */
export async function reloadAccountsFromRTDB() {
  try {
    const rtdbAccounts = await rtdbGet('/accounts')
    if (rtdbAccounts && typeof rtdbAccounts === 'object') {
      for (const [accountId, data] of Object.entries(rtdbAccounts)) {
        upsertAccount({
          account_id:    accountId,
          access_key_id: data.accessKeyId,
          secret_key:    data.secretAccessKey,
          endpoint:      data.endpoint,
          region:        data.region,
          bucket:        data.bucket,
          quota_bytes:   data.quotaBytes   ?? 5_368_709_120,
          used_bytes:    data.usedBytes    ?? 0,
          active:        data.active       ? 1 : 0,
          added_at:      data.addedAt      ?? Date.now(),
        })
      }
    }
  } catch (err) {
    // Log but don't crash — fallback to SQLite data
    process.stderr.write(`[accountPool] reloadAccountsFromRTDB error: ${err.message}\n`)
  }

  // Rebuild in-memory from SQLite (source of truth after upsert)
  loadFromSQLite()
}

/**
 * Get a single account by ID (from in-memory map).
 * @param {string} accountId
 * @returns {object|undefined}
 */
export function getAccount(accountId) {
  return accountMap.get(accountId)
}

/**
 * Get aggregated stats for health endpoint and metrics.
 * @returns {{ total: number, active: number, full: number, totalBytes: number, usedBytes: number }}
 */
export function getAccountsStats() {
  const all = [...accountMap.values()]
  let totalBytes = 0
  let usedBytes = 0
  let full = 0

  for (const a of all) {
    totalBytes += a.quota_bytes
    usedBytes  += a.used_bytes
    if ((a.used_bytes / a.quota_bytes) >= config.QUOTA_THRESHOLD) {
      full++
    }
  }

  return {
    total: all.length,
    active: activeAccounts.length,
    full,
    totalBytes,
    usedBytes,
  }
}
