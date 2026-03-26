/**
 * src/index.js
 * Fastify server bootstrap — T6 full implementation.
 *
 * 12-step startup order:
 *  1. Validate config (already done at import of config.js)
 *  2. Init SQLite (tables created at import of db.js)
 *  3. Connect RTDB (test GET /accounts.json)
 *  4. reloadAccountsFromRTDB()
 *  5. Pull all /routes from RTDB, upsert into SQLite
 *  6. Warm LRU cache
 *  7. Register RTDB realtime listener on /routes
 *  8. Register RTDB realtime listener on /accounts
 *  9. Start Fastify server on PORT
 * 10. Register instance heartbeat (every 30s)
 * 11. Start quota poller
 * 12. Register graceful shutdown
 */

import Fastify from 'fastify'
import pino from 'pino'
import { randomBytes } from 'crypto'

import config from './config.js'
import { db, upsertRoute, deleteRoute, getAllRoutes } from './db.js'
import { cacheSet, cacheDelete, cacheClear } from './cache.js'
import {
  reloadAccountsFromRTDB,
  getAccountsStats,
} from './accountPool.js'
import { rtdbGet, rtdbPatch, rtdbListen } from './firebase.js'
import { startQuotaPoller, stopQuotaPoller } from './quotaPoller.js'
import { setRtdbState } from './routes/health.js'
import { metrics } from './routes/metrics.js'
import { sendAlert } from './utils/webhook.js'

import authPlugin       from './plugins/auth.js'
import errorHandler     from './plugins/errorHandler.js'
import healthRoutes     from './routes/health.js'
import metricsRoutes    from './routes/metrics.js'
import s3Routes         from './routes/s3.js'

// ─── Logger ──────────────────────────────────────────────────────────────────

const log = pino({
  level: config.LOG_LEVEL,
  ...(process.env.NODE_ENV !== 'production' ? {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  } : {}),
})

// ─── Fastify instance ─────────────────────────────────────────────────────────

const fastify = Fastify({
  logger: log,
  genReqId: () => randomBytes(6).toString('base64url').slice(0, 10),
  // Disable body parsing for raw binary — we handle streams manually
  bodyLimit: 100 * 1024 * 1024, // 100MB safety limit
})

// ─── RTDB listener handles ────────────────────────────────────────────────────

let routesListener = null
let accountsListener = null
let rtdbLastEventAt = Date.now()
let accountsDebounceTimer = null

function startRoutesListener() {
  let backoff = 1000

  function connect() {
    if (routesListener) {
      try { routesListener.close() } catch { /* ignore */ }
    }

    routesListener = rtdbListen(
      '/routes',
      (eventType, data) => {
        rtdbLastEventAt = Date.now()
        metrics.rtdbSyncLagMs.set(0)

        try {
          if (eventType === 'put') {
            if (!data) return
            if (data.path === '/' && data.data) {
              // Full replace
              log.info('[rtdb] full routes replace received')
              const replaceStmt = db.prepare('DELETE FROM routes')
              const insertMany = db.transaction((entries) => {
                replaceStmt.run()
                cacheClear()
                for (const [encodedKey, route] of entries) {
                  if (!route) continue
                  upsertRoute({
                    encoded_key: encodedKey,
                    account_id:  route.accountId,
                    bucket:      route.bucket,
                    object_key:  route.objectKey,
                    size_bytes:  route.sizeBytes ?? 0,
                    uploaded_at: route.uploadedAt ?? Date.now(),
                    instance_id: route.instanceId ?? '',
                  })
                }
              })
              insertMany(Object.entries(data.data))
            } else {
              // Single key update
              const encodedKey = data.path?.replace(/^\//, '')
              if (!encodedKey) return

              if (data.data === null) {
                deleteRoute(encodedKey)
                cacheDelete(encodedKey)
              } else {
                const route = data.data
                upsertRoute({
                  encoded_key: encodedKey,
                  account_id:  route.accountId,
                  bucket:      route.bucket,
                  object_key:  route.objectKey,
                  size_bytes:  route.sizeBytes ?? 0,
                  uploaded_at: route.uploadedAt ?? Date.now(),
                  instance_id: route.instanceId ?? '',
                })
                cacheSet(encodedKey, {
                  accountId: route.accountId,
                  bucket:    route.bucket,
                  objectKey: route.objectKey,
                  sizeBytes: route.sizeBytes ?? 0,
                })
              }
            }
          } else if (eventType === 'patch') {
            for (const [encodedKey, route] of Object.entries(data.data ?? {})) {
              if (!route) continue
              upsertRoute({
                encoded_key: encodedKey,
                account_id:  route.accountId,
                bucket:      route.bucket,
                object_key:  route.objectKey,
                size_bytes:  route.sizeBytes ?? 0,
                uploaded_at: route.uploadedAt ?? Date.now(),
                instance_id: route.instanceId ?? '',
              })
              cacheSet(encodedKey, {
                accountId: route.accountId,
                bucket:    route.bucket,
                objectKey: route.objectKey,
                sizeBytes: route.sizeBytes ?? 0,
              })
            }
          }
        } catch (err) {
          log.error({ err }, '[rtdb] routes listener processing error')
        }

        backoff = 1000 // reset backoff on successful event
      },
      (err) => {
        log.warn({ err: err.message, backoff }, '[rtdb] routes listener error — reconnecting')
        setRtdbState({ listenerActive: false })
        setTimeout(() => {
          backoff = Math.min(backoff * 2, 60_000)
          connect()
        }, backoff)
      }
    )

    setRtdbState({ listenerActive: true })
  }

  connect()
}

function startAccountsListener() {
  let backoff = 1000

  function connect() {
    if (accountsListener) {
      try { accountsListener.close() } catch { /* ignore */ }
    }

    accountsListener = rtdbListen(
      '/accounts',
      (_eventType, _data) => {
        rtdbLastEventAt = Date.now()
        // Debounce reload to avoid thundering herd
        if (accountsDebounceTimer) clearTimeout(accountsDebounceTimer)
        accountsDebounceTimer = setTimeout(() => {
          reloadAccountsFromRTDB().catch(err =>
            log.error({ err }, '[rtdb] accounts reload error')
          )
        }, 2000)
        backoff = 1000
      },
      (err) => {
        log.warn({ err: err.message, backoff }, '[rtdb] accounts listener error — reconnecting')
        setTimeout(() => {
          backoff = Math.min(backoff * 2, 60_000)
          connect()
        }, backoff)
      }
    )
  }

  connect()
}

// ─── Shutdown ──────────────────────────────────────────────────────────────────

let shuttingDown = false

async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true

  log.info({ signal }, 'Shutting down...')

  try {
    await fastify.close()
  } catch (err) {
    log.error({ err }, 'Error closing Fastify')
  }

  stopQuotaPoller()

  if (routesListener)   { try { routesListener.close()   } catch { /* ignore */ } }
  if (accountsListener) { try { accountsListener.close() } catch { /* ignore */ } }

  try {
    await rtdbPatch(`/instances/${config.INSTANCE_ID}`, { healthy: false })
  } catch { /* ignore */ }

  try {
    db.close()
  } catch { /* ignore */ }

  log.info('Shutdown complete')
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))

process.on('unhandledRejection', (reason, promise) => {
  log.error({ reason, promise }, 'Unhandled promise rejection')
  sendAlert({ event: 'unhandled_rejection', detail: String(reason) })
})

process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'Uncaught exception')
  sendAlert({ event: 'uncaught_exception', detail: err.message })
  process.exit(1)
})

// ─── RTDB sync lag metric updater ─────────────────────────────────────────────

setInterval(() => {
  metrics.rtdbSyncLagMs.set(Date.now() - rtdbLastEventAt)
}, 5000).unref()

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap() {
  // ── [1] Config validated at import time (config.js exits on error) ──────────
  log.info({ instanceId: config.INSTANCE_ID, port: config.PORT }, '[1] config validated')

  // ── [2] SQLite initialized at import time (db.js creates tables) ─────────────
  log.info({ path: config.SQLITE_PATH }, '[2] sqlite initialized')

  // ── [3] Test RTDB connectivity ────────────────────────────────────────────────
  let rtdbConnected = false
  try {
    await rtdbGet('/accounts')
    rtdbConnected = true
    log.info('[3] rtdb connected')
  } catch (err) {
    log.warn({ err: err.message }, '[3] rtdb unreachable — continuing with local SQLite data')
  }
  setRtdbState({ connected: rtdbConnected })

  // ── [4] Load accounts from RTDB ───────────────────────────────────────────────
  if (rtdbConnected) {
    try {
      await reloadAccountsFromRTDB()
      log.info('[4] accounts loaded from rtdb')
    } catch (err) {
      log.warn({ err: err.message }, '[4] account reload failed — using SQLite')
    }
  } else {
    log.info('[4] skipped rtdb account reload (offline)')
  }

  // ── [5] Pull routes from RTDB and upsert into SQLite ─────────────────────────
  if (rtdbConnected) {
    try {
      const rtdbRoutes = await rtdbGet('/routes')
      if (rtdbRoutes && typeof rtdbRoutes === 'object') {
        const entries = Object.entries(rtdbRoutes)
        log.info({ count: entries.length }, '[5] pulling routes from rtdb')

        // Use transaction for speed
        const insertTx = db.transaction((rows) => {
          for (const [encodedKey, route] of rows) {
            if (!route || !route.accountId) continue
            upsertRoute({
              encoded_key: encodedKey,
              account_id:  route.accountId,
              bucket:      route.bucket ?? '',
              object_key:  route.objectKey ?? '',
              size_bytes:  route.sizeBytes ?? 0,
              uploaded_at: route.uploadedAt ?? Date.now(),
              instance_id: route.instanceId ?? '',
            })
          }
        })
        insertTx(entries)
        log.info('[6] routes upserted into sqlite')
      } else {
        log.info('[5] no routes in rtdb')
      }
    } catch (err) {
      log.warn({ err: err.message }, '[5] failed to pull routes from rtdb')
    }
  } else {
    log.info('[5] skipped rtdb routes pull (offline)')
  }

  // ── [6] Warm LRU cache with top 10,000 most-recent routes ────────────────────
  try {
    const recentRoutes = db.prepare(
      'SELECT * FROM routes ORDER BY uploaded_at DESC LIMIT 10000'
    ).all()

    for (const row of recentRoutes) {
      cacheSet(row.encoded_key, {
        accountId: row.account_id,
        bucket:    row.bucket,
        objectKey: row.object_key,
        sizeBytes: row.size_bytes,
      })
    }
    log.info({ count: recentRoutes.length }, '[7] lru cache warmed')
  } catch (err) {
    log.warn({ err: err.message }, '[7] cache warm failed')
  }

  // ── [7-8] Register RTDB realtime listeners ────────────────────────────────────
  if (rtdbConnected) {
    startRoutesListener()
    log.info('[8] rtdb routes listener started')

    startAccountsListener()
    log.info('[9] rtdb accounts listener started')
  } else {
    log.warn('[8-9] skipped rtdb listeners (offline)')
  }

  // ── [9] Register plugins & routes, then start Fastify ────────────────────────


  // Plugins
  await fastify.register(authPlugin)
  await fastify.register(errorHandler)

  // Decorate with config for health route
  fastify.decorate('config', config)

  // Routes
  await fastify.register(healthRoutes)
  await fastify.register(metricsRoutes)
  await fastify.register(s3Routes, { prefix: '/' })

  // Global CORS headers for non-S3 routes
  fastify.addHook('onSend', async (_request, reply) => {
    if (!reply.hasHeader('Access-Control-Allow-Origin')) {
      reply.header('Access-Control-Allow-Origin', '*')
    }
  })

  await fastify.listen({ port: config.PORT, host: '0.0.0.0' })
  log.info({ port: config.PORT }, '[10] fastify listening')

  // ── [10] Instance heartbeat ───────────────────────────────────────────────────
  const startedAt = Date.now()
  async function heartbeat() {
    try {
      await rtdbPatch(`/instances/${config.INSTANCE_ID}`, {
        lastHeartbeat: Date.now(),
        startedAt,
        healthy: true,
      })
    } catch { /* ignore */ }
  }

  await heartbeat().catch(() => {})
  const heartbeatTimer = setInterval(() => heartbeat().catch(() => {}), 30_000)
  heartbeatTimer.unref()
  log.info('[11] heartbeat started (every 30s)')

  // ── [11] Start quota poller ───────────────────────────────────────────────────
  startQuotaPoller()
  log.info('[12] quota poller started')

  // Update metrics for accounts
  const stats = getAccountsStats()
  log.info({ accounts: stats }, 'startup complete')
}

bootstrap().catch(err => {
  log.fatal({ err }, 'Bootstrap failed')
  process.exit(1)
})



