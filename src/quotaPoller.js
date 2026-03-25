/**
 * src/quotaPoller.js
 * Periodic background poller that checks actual storage usage via S3 ListObjectsV2.
 * Updates SQLite if discrepancy > 5%.
 * Never crashes the process — all errors caught and logged.
 *
 * Exported:
 *   startQuotaPoller() → void
 *   stopQuotaPoller()  → void
 */

import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { getAllActiveAccounts, setUsedBytesAbsolute } from './db.js'
import { getAccount } from './accountPool.js'
import config from './config.js'

let pollerTimer = null
let running = false

// ─── Core poll logic ──────────────────────────────────────────────────────────

/**
 * Poll a single account: list all objects, sum sizes, compare vs stored used_bytes.
 * If difference > 5%, update SQLite.
 */
async function pollAccount(account) {
  const client = new S3Client({
    endpoint:         account.endpoint,
    region:           account.region,
    credentials: {
      accessKeyId:     account.access_key_id,
      secretAccessKey: account.secret_key,
    },
    forcePathStyle: true,
  })

  let totalBytes = 0
  let continuationToken = undefined

  // Paginate through all objects
  do {
    const cmd = new ListObjectsV2Command({
      Bucket:            account.bucket,
      MaxKeys:           1000,
      ContinuationToken: continuationToken,
    })

    const response = await client.send(cmd)

    if (response.Contents) {
      for (const obj of response.Contents) {
        totalBytes += obj.Size ?? 0
      }
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
  } while (continuationToken)

  // Check discrepancy
  const stored = account.used_bytes
  if (stored === 0 && totalBytes === 0) return

  const diff = Math.abs(totalBytes - stored)
  const threshold = stored * 0.05 // 5%

  if (diff > threshold) {
    process.stderr.write(
      `[quotaPoller] WARN: account ${account.account_id} stored=${stored} polled=${totalBytes} diff=${diff} → updating\n`
    )
    setUsedBytesAbsolute(account.account_id, totalBytes)

    // Also update in-memory account pool
    const inMem = getAccount(account.account_id)
    if (inMem) {
      inMem.used_bytes = totalBytes
    }
  }
}

/**
 * Run one full poll cycle across all active accounts.
 */
async function runPollCycle() {
  if (running) return // prevent overlap if previous cycle is slow
  running = true

  try {
    const accounts = getAllActiveAccounts()
    for (const account of accounts) {
      try {
        await pollAccount(account)
      } catch (err) {
        // Per-account error — log and continue to next account
        process.stderr.write(
          `[quotaPoller] ERROR polling account ${account.account_id}: ${err.message}\n`
        )
      }
    }
  } catch (err) {
    process.stderr.write(`[quotaPoller] ERROR in poll cycle: ${err.message}\n`)
  } finally {
    running = false
  }
}

// ─── Exported controls ────────────────────────────────────────────────────────

/**
 * Start the background quota poller.
 * First run is delayed by one interval to avoid blocking startup.
 */
export function startQuotaPoller() {
  if (pollerTimer) return // already running

  pollerTimer = setInterval(() => {
    runPollCycle().catch(() => {}) // extra safety net
  }, config.QUOTA_POLL_INTERVAL_MS)

  // Don't block Node.js exit
  if (pollerTimer.unref) pollerTimer.unref()

  process.stderr.write(
    `[quotaPoller] started, interval=${config.QUOTA_POLL_INTERVAL_MS}ms\n`
  )
}

/**
 * Stop the background quota poller.
 */
export function stopQuotaPoller() {
  if (pollerTimer) {
    clearInterval(pollerTimer)
    pollerTimer = null
    process.stderr.write('[quotaPoller] stopped\n')
  }
}
