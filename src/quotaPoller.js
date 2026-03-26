/**
 * src/quotaPoller.js
 * Periodic usage verification using the shared backend inventory scanner.
 */

import { getAllActiveAccounts, setUsedBytesAbsolute } from './db.js'
import { syncAccountFromDb } from './accountPool.js'
import { scanAccountInventory } from './inventoryScanner.js'
import config from './config.js'

let pollerTimer = null
let running = false
let activeLogger = console

export async function verifyAccountUsage(account, logger = activeLogger) {
  const { totalBytes } = await scanAccountInventory(account)
  const stored = account.used_bytes
  const diff = Math.abs(totalBytes - stored)
  const threshold = Math.max(1, stored * config.QUOTA_DRIFT_THRESHOLD_RATIO)

  if (stored === 0 && totalBytes === 0) {
    return { accountId: account.account_id, totalBytes, updated: false }
  }

  if (diff > threshold) {
    logger.warn?.({
      accountId: account.account_id,
      stored,
      totalBytes,
      diff,
    }, 'quota poller corrected account usage drift')

    setUsedBytesAbsolute(account.account_id, totalBytes)
    syncAccountFromDb(account.account_id)
    return { accountId: account.account_id, totalBytes, updated: true }
  }

  return { accountId: account.account_id, totalBytes, updated: false }
}

export async function runQuotaPollCycle(logger = activeLogger) {
  if (running) return
  running = true

  try {
    const accounts = getAllActiveAccounts()
    for (const account of accounts) {
      try {
        await verifyAccountUsage(account, logger)
      } catch (err) {
        logger.error?.({ err, accountId: account.account_id }, 'quota poller account scan failed')
      }
    }
  } catch (err) {
    logger.error?.({ err }, 'quota poller cycle failed')
  } finally {
    running = false
  }
}

export function startQuotaPoller(logger = console) {
  if (pollerTimer) return

  activeLogger = logger
  pollerTimer = setInterval(() => {
    runQuotaPollCycle(activeLogger).catch(() => {})
  }, config.QUOTA_POLL_INTERVAL_MS)

  if (pollerTimer.unref) pollerTimer.unref()
  activeLogger.info?.({ intervalMs: config.QUOTA_POLL_INTERVAL_MS }, 'quota poller started')
}

export function stopQuotaPoller() {
  if (!pollerTimer) return

  clearInterval(pollerTimer)
  pollerTimer = null
  activeLogger.info?.('quota poller stopped')
}
