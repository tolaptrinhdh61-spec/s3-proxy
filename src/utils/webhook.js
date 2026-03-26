/**
 * src/utils/webhook.js
 * Send critical alert to WEBHOOK_ALERT_URL.
 * Fire-and-forget: never throws, never awaited in request path.
 *
 * Exported:
 *   sendAlert(payload) → void (fire-and-forget)
 */

import config from '../config.js'

/**
 * Send alert to webhook URL (fire-and-forget).
 * @param {{ event: string, detail: string, [key: string]: any }} payload
 */
export function sendAlert(payload) {
  if (!config.WEBHOOK_ALERT_URL) return

  const body = JSON.stringify({
    instanceId: config.INSTANCE_ID,
    timestamp:  new Date().toISOString(),
    level:      'critical',
    ...payload,
  })

  // Fire-and-forget with 5s timeout using AbortController
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)

  fetch(config.WEBHOOK_ALERT_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal:  controller.signal,
  })
    .catch(() => { /* silent — webhook failure must never affect main flow */ })
    .finally(() => clearTimeout(timer))
}
