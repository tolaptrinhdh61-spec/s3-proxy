/**
 * src/quotaPoller.js
 * Periodic background poller - S3 ListObjectsV2, updates SQLite if diff > 5%.
 * Never crashes the process.
 */

import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { getAllActiveAccounts, setUsedBytesAbsolute } from './db.js'
import { setAccountUsedBytes } from './accountPool.js'
import config from './config.js'

let pollerTimer = null
let running = false

async function pollAccount(account) {
  const client = new S3Client({
    endpoint: account.endpoint,
    region: account.region,
    credentials: {
      accessKeyId: account.access_key_id,
      secretAccessKey: account.secret_key,
    },
    forcePathStyle: true,
  })

  let totalBytes = 0
  let continuationToken

  do {
    const command = new ListObjectsV2Command({
      Bucket: account.bucket,
      MaxKeys: 1000,
      ContinuationToken: continuationToken,
    })
    const response = await client.send(command)

    if (response.Contents) {
      for (const object of response.Contents) {
        totalBytes += object.Size ?? 0
      }
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
  } while (continuationToken)

  const stored = account.used_bytes
  if (stored === 0 && totalBytes === 0) return

  const diff = Math.abs(totalBytes - stored)
  const threshold = stored * 0.05

  if (diff > threshold) {
    process.stderr.write(
      `[quotaPoller] WARN: ${account.account_id} stored=${stored} polled=${totalBytes} diff=${diff} -> updating\n`
    )
    setUsedBytesAbsolute(account.account_id, totalBytes)
    setAccountUsedBytes(account.account_id, totalBytes)
  }
}

async function runPollCycle() {
  if (running) return
  running = true

  try {
    const accounts = getAllActiveAccounts()
    for (const account of accounts) {
      try {
        await pollAccount(account)
      } catch (err) {
        process.stderr.write(`[quotaPoller] ERROR polling ${account.account_id}: ${err.message}\n`)
      }
    }
  } catch (err) {
    process.stderr.write(`[quotaPoller] ERROR in poll cycle: ${err.message}\n`)
  } finally {
    running = false
  }
}

export function startQuotaPoller() {
  if (pollerTimer) return

  pollerTimer = setInterval(() => {
    runPollCycle().catch(() => {})
  }, config.QUOTA_POLL_INTERVAL_MS)

  if (pollerTimer.unref) pollerTimer.unref()
  process.stderr.write(`[quotaPoller] started, interval=${config.QUOTA_POLL_INTERVAL_MS}ms\n`)
}

export function stopQuotaPoller() {
  if (!pollerTimer) return

  clearInterval(pollerTimer)
  pollerTimer = null
  process.stderr.write('[quotaPoller] stopped\n')
}
