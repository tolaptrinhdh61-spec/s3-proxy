/**
 * src/routes/health.js
 * GET /health — no auth required.
 * Returns 200 with system status JSON, or 503 if both RTDB and SQLite are dead.
 */

import { getAccountsStats } from '../accountPool.js'
import { countRoutes } from '../db.js'
import { cacheSize } from '../cache.js'

// These are set by index.js after startup
let _rtdbState = { connected: false, listenerActive: false }

export function setRtdbState(state) {
  _rtdbState = { ..._rtdbState, ...state }
}

export function getRtdbState() {
  return _rtdbState
}

export default async function healthRoutes(fastify, _opts) {
  fastify.get('/health', {
    config: { skipAuth: true },
  }, async (request, reply) => {
    let sqliteOk = true
    let routeCount = 0
    let accountStats = { total: 0, active: 0, full: 0, totalBytes: 0, usedBytes: 0 }

    try {
      routeCount = countRoutes()
      accountStats = getAccountsStats()
    } catch (err) {
      sqliteOk = false
      request.log.error({ err }, 'health: SQLite query failed')
    }

    // 503 only if both RTDB and SQLite are dead
    const status = (!sqliteOk && !_rtdbState.connected) ? 503 : 200

    const percentUsed = accountStats.totalBytes > 0
      ? parseFloat(((accountStats.usedBytes / accountStats.totalBytes) * 100).toFixed(2))
      : 0

    const body = {
      status:     status === 200 ? 'ok' : 'degraded',
      instanceId: fastify.config?.INSTANCE_ID ?? process.env.INSTANCE_ID ?? 'unknown',
      uptime:     parseFloat(process.uptime().toFixed(2)),
      accounts: {
        total:  accountStats.total,
        active: accountStats.active,
        full:   accountStats.full,
      },
      routes: {
        sqliteCount: routeCount,
        cacheSize:   cacheSize(),
      },
      rtdb: {
        connected:      _rtdbState.connected,
        listenerActive: _rtdbState.listenerActive,
      },
      quota: {
        totalBytes:  accountStats.totalBytes,
        usedBytes:   accountStats.usedBytes,
        percentUsed,
      },
    }

    reply.code(status).send(body)
  })
}
