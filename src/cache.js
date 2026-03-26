/**
 * src/cache.js
 * LRU cache wrapper using lru-cache v10.
 * Key = encodedKey, Value = { accountId, bucket, objectKey, sizeBytes }
 */

import { LRUCache } from 'lru-cache'
import config from './config.js'

const cache = new LRUCache({
  max: config.LRU_MAX,
  ttl: config.LRU_TTL_MS,
})

export function cacheGet(encodedKey) { return cache.get(encodedKey) }
export function cacheSet(encodedKey, value) { cache.set(encodedKey, value) }
export function cacheDelete(encodedKey) { cache.delete(encodedKey) }
export function cacheClear() { cache.clear() }
export function cacheSize() { return cache.size }
