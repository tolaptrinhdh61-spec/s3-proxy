/**
 * src/accountPool.js
 * Account pool management: selection, quota tracking, in-memory state.
 */

import { getAllActiveAccounts, upsertAccount, updateUsedBytes } from './db.js'
import { rtdbGet, rtdbPatch } from './firebase.js'
import config from './config.js'

export class StorageFullError extends Error {
  constructor(message = 'All storage accounts are at capacity') {
    super(message)
    this.name = 'StorageFullError'
    this.statusCode = 507
  }
}

/** @type {Map<string, object>} */
const accountMap = new Map()
let activeAccounts = []

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

loadFromSQLite()

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

export function recordUpload(accountId, sizeBytes) {
  updateUsedBytes(accountId, sizeBytes)
  const account = accountMap.get(accountId)
  if (account) {
    account.used_bytes = Math.max(0, account.used_bytes + sizeBytes)
    rebuildActiveAccounts()
    Promise.resolve().then(() =>
      rtdbPatch(`/accounts/${accountId}`, { usedBytes: account.used_bytes })
    ).catch(() => {})
  }
}

export function recordDelete(accountId, sizeBytes) {
  updateUsedBytes(accountId, -sizeBytes)
  const account = accountMap.get(accountId)
  if (account) {
    account.used_bytes = Math.max(0, account.used_bytes - sizeBytes)
    rebuildActiveAccounts()
    Promise.resolve().then(() =>
      rtdbPatch(`/accounts/${accountId}`, { usedBytes: account.used_bytes })
    ).catch(() => {})
  }
}

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
          quota_bytes:   data.quotaBytes  ?? 5_368_709_120,
          used_bytes:    data.usedBytes   ?? 0,
          active:        data.active      ? 1 : 0,
          added_at:      data.addedAt     ?? Date.now(),
        })
      }
    }
  } catch (err) {
    process.stderr.write(`[accountPool] reloadAccountsFromRTDB error: ${err.message}\n`)
  }
  loadFromSQLite()
}

export function getAccount(accountId) {
  return accountMap.get(accountId)
}

export function getAccountsStats() {
  const all = [...accountMap.values()]
  let totalBytes = 0, usedBytes = 0, full = 0
  for (const a of all) {
    totalBytes += a.quota_bytes
    usedBytes  += a.used_bytes
    if ((a.used_bytes / a.quota_bytes) >= config.QUOTA_THRESHOLD) full++
  }
  return { total: all.length, active: activeAccounts.length, full, totalBytes, usedBytes }
}
