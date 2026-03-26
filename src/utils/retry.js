/**
 * src/utils/retry.js
 * Exponential backoff retry utility.
 *
 * Exported:
 *   withRetry(fn, options) → result
 *
 * Only retries on:
 *   - HTTP 5xx status (error.statusCode >= 500)
 *   - Network errors: ECONNRESET, ETIMEDOUT, ENOTFOUND, ECONNREFUSED, UND_ERR_*
 * Does NOT retry on 4xx.
 */

const RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_ABORTED',
])

function isRetryable(err) {
  if (!err) return false

  // Network errors
  if (err.code && RETRYABLE_CODES.has(err.code)) return true

  // HTTP 5xx
  const status = err.statusCode ?? err.status ?? err.response?.status
  if (status && status >= 500) return true

  return false
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Retry a function with exponential backoff.
 *
 * @param {() => Promise<any>} fn - async function to retry
 * @param {object} options
 * @param {number} [options.maxAttempts=3]
 * @param {number} [options.baseDelayMs=100]
 * @param {(attempt: number, error: Error) => void} [options.onRetry]
 * @returns {Promise<any>}
 */
export async function withRetry(fn, { maxAttempts = 3, baseDelayMs = 100, onRetry } = {}) {
  let lastError

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err

      if (!isRetryable(err)) {
        throw err
      }

      if (attempt === maxAttempts) {
        break
      }

      const delay = baseDelayMs * Math.pow(2, attempt - 1) // 100, 200, 400...
      if (onRetry) {
        try { onRetry(attempt, err) } catch { /* ignore */ }
      }

      await sleep(delay)
    }
  }

  throw lastError
}
