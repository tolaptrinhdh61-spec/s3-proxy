/**
 * src/cache.js
 * LRU cache wrapper using lru-cache v10.
 * Key   = encodedKey (base64url of bucket/objectKey)
 * Value = { accountId, bucket, objectKey, sizeBytes }
 *
 * Exported functions:
 *   cacheGet(encodedKey) → value | undefined
 *   cacheSet(encodedKey, value)
 *   cacheDelete(encodedKey)
 *   cacheClear()
 *   cacheSize() → number
 */

import { LRUCache } from 'lru-cache'
import config from './config.js'

const cache = new LRUCache({
  max:  config.LRU_MAX,
  ttl:  config.LRU_TTL_MS,
  // allowStale: false (default) — expired entries return undefined
})

/**
 * Get a cached route entry.
 * @param {string} encodedKey
 * @returns {{ accountId: string, bucket: string, objectKey: string, sizeBytes: number } | undefined}
 */
export function cacheGet(encodedKey) {
  return cache.get(encodedKey)
}

/**
 * Set a route entry in cache.
 * @param {string} encodedKey
 * @param {{ accountId: string, bucket: string, objectKey: string, sizeBytes: number }} value
 */
export function cacheSet(encodedKey, value) {
  cache.set(encodedKey, value)
}

/**
 * Delete a route entry from cache.
 * @param {string} encodedKey
 */
export function cacheDelete(encodedKey) {
  cache.delete(encodedKey)
}

/**
 * Clear the entire cache.
 */
export function cacheClear() {
  cache.clear()
}

/**
 * Current number of entries in cache.
 * @returns {number}
 */
export function cacheSize() {
  return cache.size
}
