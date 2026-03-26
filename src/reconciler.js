/**
 * src/reconciler.js
 * Background metadata reconciler and pending-sync flusher.
 */

import {
  finalizeRouteDelete,
  getAllActiveAccounts,
  getRoute,
  getTrackedRoutesByAccount,
  markRouteMissingBackend,
  ROUTE_RECONCILE_STATUS,
  ROUTE_STATE,
  ROUTE_SYNC_STATE,
  setUsedBytesAbsolute,
  upsertReconciledRoute,
} from './db.js'
import { patchAccountUsageToRtdb, syncAccountFromDb, syncAccountsFromRows } from './accountPool.js'
import { flushPendingRouteSync } from './controlPlane.js'
import { scanAccountInventory } from './inventoryScanner.js'
import { buildOpaqueOrphanRoute, encodeKey, parseBackendKey } from './metadata.js'
import { metrics, refreshMetadataMetrics } from './routes/metrics.js'
import config from './config.js'

let reconcilerTimer = null
let running = false
let activeLogger = console
let nextDelayMs = config.RECONCILE_INTERVAL_MS
const scanState = new Map()

function getAccountScanState(accountId) {
  if (!scanState.has(accountId)) {
    scanState.set(accountId, {
      continuationToken: undefined,
      inventory: new Map(),
      totalBytes: 0,
    })
  }
  return scanState.get(accountId)
}

async function reconcileCompletedAccountScan(account, state, logger) {
  const now = Date.now()
  const inventory = state.inventory
  const routes = getTrackedRoutesByAccount(account.account_id)
  const changedRoutes = []
  const changedAccounts = []

  setUsedBytesAbsolute(account.account_id, state.totalBytes)
  const updatedAccount = syncAccountFromDb(account.account_id)
  if (updatedAccount) {
    changedAccounts.push(updatedAccount)
  }

  for (const route of routes) {
    const backendObject = inventory.get(route.backend_key)

    if (!backendObject) {
      if (route.state === ROUTE_STATE.DELETING) {
        const finalized = finalizeRouteDelete(route.encoded_key, now, {
          reconcileStatus: ROUTE_RECONCILE_STATUS.HEALTHY,
        })
        if (finalized.route) changedRoutes.push(finalized.route)
        changedAccounts.push(...finalized.affectedAccounts)
      } else if (route.state !== ROUTE_STATE.MISSING_BACKEND && route.state !== ROUTE_STATE.ORPHANED) {
        const missing = markRouteMissingBackend(route.encoded_key, now)
        if (missing.route) changedRoutes.push(missing.route)
        changedAccounts.push(...missing.affectedAccounts)
        metrics.reconcilerMismatchTotal.inc({ type: 'missing_backend', account_id: account.account_id })
      }
      continue
    }

    const sizeMismatch = (route.size_bytes ?? 0) !== backendObject.sizeBytes
    const etagMismatch = (route.etag ?? null) !== (backendObject.etag ?? null)
    const modifiedMismatch = (route.last_modified ?? null) !== (backendObject.lastModified ?? null)
    const needsRepair = route.state === ROUTE_STATE.MISSING_BACKEND
      || route.state === ROUTE_STATE.ORPHANED
      || route.reconcile_status === ROUTE_RECONCILE_STATUS.WRONG_ACCOUNT
      || sizeMismatch
      || etagMismatch
      || modifiedMismatch

    if (needsRepair) {
      const repaired = upsertReconciledRoute({
        ...route,
        account_id: account.account_id,
        backend_key: route.backend_key,
        size_bytes: backendObject.sizeBytes,
        etag: backendObject.etag,
        last_modified: backendObject.lastModified ?? route.last_modified ?? now,
        state: route.state === ROUTE_STATE.DELETING ? ROUTE_STATE.DELETING : ROUTE_STATE.ACTIVE,
        sync_state: ROUTE_SYNC_STATE.PENDING_SYNC,
        reconcile_status: sizeMismatch || etagMismatch || modifiedMismatch
          ? ROUTE_RECONCILE_STATUS.METADATA_MISMATCH
          : ROUTE_RECONCILE_STATUS.HEALTHY,
        backend_last_seen_at: now,
        backend_missing_since: null,
        last_reconciled_at: now,
        updated_at: now,
      })
      changedRoutes.push(repaired)

      if (sizeMismatch || etagMismatch || modifiedMismatch) {
        metrics.reconcilerMismatchTotal.inc({ type: 'metadata_mismatch', account_id: account.account_id })
      }
    }
  }

  for (const backendObject of inventory.values()) {
    const parsed = parseBackendKey(backendObject.backendKey)

    if (!parsed) {
      const orphan = upsertReconciledRoute(buildOpaqueOrphanRoute(account.account_id, backendObject.backendKey, {
        sizeBytes: backendObject.sizeBytes,
        etag: backendObject.etag,
        lastModified: backendObject.lastModified,
        instanceId: config.INSTANCE_ID,
      }, now))
      changedRoutes.push(orphan)
      metrics.reconcilerMismatchTotal.inc({ type: 'orphan_backend', account_id: account.account_id })
      continue
    }

    const encodedKey = encodeKey(parsed.bucket, parsed.objectKey)
    const existing = getRoute(encodedKey)

    if (!existing) {
      const healed = upsertReconciledRoute({
        encoded_key: encodedKey,
        account_id: account.account_id,
        bucket: parsed.bucket,
        object_key: parsed.objectKey,
        backend_key: backendObject.backendKey,
        size_bytes: backendObject.sizeBytes,
        etag: backendObject.etag,
        last_modified: backendObject.lastModified ?? now,
        content_type: null,
        uploaded_at: backendObject.lastModified ?? now,
        updated_at: now,
        deleted_at: null,
        state: ROUTE_STATE.ACTIVE,
        sync_state: ROUTE_SYNC_STATE.PENDING_SYNC,
        reconcile_status: ROUTE_RECONCILE_STATUS.HEALTHY,
        backend_last_seen_at: now,
        backend_missing_since: null,
        last_reconciled_at: now,
        instance_id: config.INSTANCE_ID,
      })
      changedRoutes.push(healed)
      metrics.reconcilerMismatchTotal.inc({ type: 'orphan_backend', account_id: account.account_id })
      continue
    }

    if (existing.account_id !== account.account_id) {
      metrics.reconcilerMismatchTotal.inc({ type: 'wrong_account', account_id: account.account_id })

      if (existing.state === ROUTE_STATE.MISSING_BACKEND) {
        const rerouted = upsertReconciledRoute({
          ...existing,
          account_id: account.account_id,
          backend_key: backendObject.backendKey,
          size_bytes: backendObject.sizeBytes,
          etag: backendObject.etag,
          last_modified: backendObject.lastModified ?? existing.last_modified ?? now,
          state: ROUTE_STATE.ACTIVE,
          sync_state: ROUTE_SYNC_STATE.PENDING_SYNC,
          reconcile_status: ROUTE_RECONCILE_STATUS.HEALTHY,
          backend_last_seen_at: now,
          backend_missing_since: null,
          last_reconciled_at: now,
          updated_at: now,
        })
        changedRoutes.push(rerouted)
      } else if (existing.reconcile_status !== ROUTE_RECONCILE_STATUS.WRONG_ACCOUNT) {
        const suspect = upsertReconciledRoute({
          ...existing,
          sync_state: ROUTE_SYNC_STATE.PENDING_SYNC,
          reconcile_status: ROUTE_RECONCILE_STATUS.WRONG_ACCOUNT,
          last_reconciled_at: now,
          updated_at: now,
        })
        changedRoutes.push(suspect)
      }
    }
  }

  if (changedAccounts.length > 0) {
    syncAccountsFromRows(changedAccounts)
  }

  for (const accountRow of changedAccounts) {
    try {
      await patchAccountUsageToRtdb(accountRow.account_id)
    } catch (err) {
      logger.warn?.({ err, accountId: accountRow.account_id }, 'reconciler account RTDB patch failed')
    }
  }

  if (changedRoutes.length > 0) {
    logger.info?.({ accountId: account.account_id, routeCount: changedRoutes.length }, 'reconciler applied metadata repairs')
  }
}

export async function runReconcilerCycle(logger = activeLogger) {
  if (running) return
  running = true

  try {
    await flushPendingRouteSync(logger)

    const accounts = getAllActiveAccounts()
    for (const account of accounts) {
      const state = getAccountScanState(account.account_id)
      if (!state.continuationToken) {
        state.inventory = new Map()
        state.totalBytes = 0
      }

      try {
        await scanAccountInventory(account, {
          continuationToken: state.continuationToken,
          onObject: async (record) => {
            state.inventory.set(record.backendKey, record)
            state.totalBytes += record.sizeBytes
          },
          onPage: async (page) => {
            state.continuationToken = page.nextContinuationToken ?? undefined
          },
        })

        state.continuationToken = undefined
        await reconcileCompletedAccountScan(account, state, logger)
        state.inventory = new Map()
        state.totalBytes = 0
      } catch (err) {
        logger.warn?.({ err, accountId: account.account_id, continuationToken: state.continuationToken ?? null }, 'reconciler account scan failed; will resume next cycle')
      }
    }

    await flushPendingRouteSync(logger)
    refreshMetadataMetrics()
    nextDelayMs = config.RECONCILE_INTERVAL_MS
  } catch (err) {
    logger.error?.({ err }, 'reconciler cycle failed')
    nextDelayMs = Math.min(nextDelayMs * 2, config.RECONCILE_INTERVAL_MS * 4)
  } finally {
    running = false
  }
}

function scheduleNextRun() {
  reconcilerTimer = setTimeout(async () => {
    await runReconcilerCycle(activeLogger)
    scheduleNextRun()
  }, nextDelayMs)

  if (reconcilerTimer.unref) reconcilerTimer.unref()
}

export function startReconciler(logger = console) {
  if (reconcilerTimer) return

  activeLogger = logger
  nextDelayMs = config.RECONCILE_INTERVAL_MS
  scheduleNextRun()
  activeLogger.info?.({ intervalMs: config.RECONCILE_INTERVAL_MS }, 'reconciler started')
}

export function stopReconciler() {
  if (!reconcilerTimer) return

  clearTimeout(reconcilerTimer)
  reconcilerTimer = null
  activeLogger.info?.('reconciler stopped')
}
