/**
 * src/routes/metrics.js
 * GET /metrics — Prometheus text format, no auth required.
 * Registers all prom-client metrics used across the proxy.
 */

import { Registry, Counter, Gauge, collectDefaultMetrics } from 'prom-client'

// ─── Registry ─────────────────────────────────────────────────────────────────

export const register = new Registry()
register.setDefaultLabels({ service: 's3proxy' })
collectDefaultMetrics({ register })

// ─── Counters & Gauges ────────────────────────────────────────────────────────

export const metrics = {
  requestsTotal: new Counter({
    name: 's3proxy_requests_total',
    help: 'Total S3 proxy requests',
    labelNames: ['method', 'operation', 'status_code'],
    registers: [register],
  }),

  uploadBytesTotal: new Counter({
    name: 's3proxy_upload_bytes_total',
    help: 'Total bytes uploaded per account',
    labelNames: ['account_id'],
    registers: [register],
  }),

  downloadBytesTotal: new Counter({
    name: 's3proxy_download_bytes_total',
    help: 'Total bytes downloaded per account',
    labelNames: ['account_id'],
    registers: [register],
  }),

  accountUsedBytes: new Gauge({
    name: 's3proxy_account_used_bytes',
    help: 'Current used bytes per account',
    labelNames: ['account_id'],
    registers: [register],
  }),

  accountQuotaBytes: new Gauge({
    name: 's3proxy_account_quota_bytes',
    help: 'Quota bytes per account',
    labelNames: ['account_id'],
    registers: [register],
  }),

  rtdbSyncLagMs: new Gauge({
    name: 's3proxy_rtdb_sync_lag_ms',
    help: 'Time since last RTDB event in milliseconds',
    registers: [register],
  }),

  cacheHitsTotal: new Counter({
    name: 's3proxy_cache_hits_total',
    help: 'LRU cache hits',
    registers: [register],
  }),

  cacheMissesTotal: new Counter({
    name: 's3proxy_cache_misses_total',
    help: 'LRU cache misses',
    registers: [register],
  }),

  retryTotal: new Counter({
    name: 's3proxy_retry_total',
    help: 'Retry attempts per operation',
    labelNames: ['operation'],
    registers: [register],
  }),

  fallbackTotal: new Counter({
    name: 's3proxy_fallback_total',
    help: 'Fallback triggers per reason',
    labelNames: ['reason'],
    registers: [register],
  }),
}

// ─── Route ────────────────────────────────────────────────────────────────────

export default async function metricsRoutes(fastify, _opts) {
  fastify.get('/metrics', {
    config: { skipAuth: true },
  }, async (_request, reply) => {
    const output = await register.metrics()
    reply
      .code(200)
      .header('Content-Type', register.contentType)
      .send(output)
  })
}
