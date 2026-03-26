/**
 * src/accountPool.js
 * Account pool management: selection, quota tracking, in-memory state.
 */

import {
  getAllAccounts,
  upsertAccount,
  updateUsedBytes,
  deactivateMissingAccounts,
} from './db.js'
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
    .filter(account => account.active === 1 || account.active === true)
    .sort((left, right) => left.used_bytes - right.used_bytes || left.account_id.localeCompare(right.account_id))
}

function loadFromSQLite() {
  const rows = getAllAccounts()
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
  if (!account) return

  account.used_bytes = Math.max(0, account.used_bytes + sizeBytes)
  rebuildActiveAccounts()

  Promise.resolve()
    .then(() => rtdbPatch(`/accounts/${accountId}`, { usedBytes: account.used_bytes }))
    .catch(() => {})
}

export function recordDelete(accountId, sizeBytes) {
  updateUsedBytes(accountId, -sizeBytes)
  const account = accountMap.get(accountId)
  if (!account) return

  account.used_bytes = Math.max(0, account.used_bytes - sizeBytes)
  rebuildActiveAccounts()

  Promise.resolve()
    .then(() => rtdbPatch(`/accounts/${accountId}`, { usedBytes: account.used_bytes }))
    .catch(() => {})
}

export function setAccountUsedBytes(accountId, usedBytes) {
  const account = accountMap.get(accountId)
  if (!account) return

  account.used_bytes = Math.max(0, usedBytes)
  rebuildActiveAccounts()
}

export async function reloadAccountsFromRTDB() {
  try {
    const rtdbAccounts = await rtdbGet('/accounts')
    const ids = []

    if (rtdbAccounts && typeof rtdbAccounts === 'object') {
      for (const [accountId, data] of Object.entries(rtdbAccounts)) {
        ids.push(accountId)
        upsertAccount({
          account_id:    accountId,
          access_key_id: data.accessKeyId,
          secret_key:    data.secretAccessKey,
          endpoint:      data.endpoint,
          region:        data.region,
          bucket:        data.bucket,
          quota_bytes:   data.quotaBytes ?? 5_368_709_120,
          used_bytes:    data.usedBytes ?? 0,
          active:        data.active ? 1 : 0,
          added_at:      data.addedAt ?? Date.now(),
        })
      }
    }

    deactivateMissingAccounts(ids)
  } catch (err) {
    process.stderr.write(`[accountPool] reloadAccountsFromRTDB error: ${err.message}\n`)
  }

  loadFromSQLite()
}

export function reloadAccountsFromSQLite() {
  loadFromSQLite()
}

export function getAccount(accountId) {
  return accountMap.get(accountId)
}

export function getAccountsStats() {
  const all = [...accountMap.values()]
  let totalBytes = 0
  let usedBytes = 0
  let full = 0

  for (const account of all) {
    totalBytes += account.quota_bytes
    usedBytes += account.used_bytes
    if ((account.used_bytes / account.quota_bytes) >= config.QUOTA_THRESHOLD) full++
  }

  return { total: all.length, active: activeAccounts.length, full, totalBytes, usedBytes }
}

