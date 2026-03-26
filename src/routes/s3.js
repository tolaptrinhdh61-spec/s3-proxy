/**
 * src/routes/s3.js
 * S3-compatible route handlers backed by logical metadata control-plane state.
 */

import { randomBytes } from 'crypto'
import { Readable } from 'stream'

import { cacheDelete, cacheGet, cacheSet } from '../cache.js'
import {
  commitUploadedObjectMetadata,
  finalizeRouteDelete,
  getAccountById,
  getMultipartUpload,
  getRoute,
  listVisibleObjectsPage,
  markRouteDeleting,
  markRouteMissingBackend,
  revertDeletingRoute,
  ROUTE_RECONCILE_STATUS,
  ROUTE_STATE,
  upsertMultipartUpload,
  deleteMultipartUpload,
} from '../db.js'
import { rtdbGet } from '../firebase.js'
import {
  buildBackendKey,
  decodeListContinuationToken,
  encodeKey,
  encodeListContinuationToken,
  isVisibleRoute,
  routeFromRtdb,
  toRouteCacheValue,
} from '../metadata.js'
import {
  patchAccountUsageToRtdb,
  reloadAccountsFromRTDB,
  selectAccountForUpload,
  StorageFullError,
  syncAccountsFromRows,
} from '../accountPool.js'
import { proxyRequest } from '../utils/sigv4.js'
import { withRetry } from '../utils/retry.js'
import { sendAlert } from '../utils/webhook.js'
import {
  buildCompleteMultipartUploadResult,
  buildErrorXml,
  buildInitiateMultipartUploadResult,
  buildListBucketResult,
} from '../utils/s3Xml.js'
import { syncRouteToRtdb } from '../controlPlane.js'
import { metrics, refreshMetadataMetrics } from './metrics.js'
import config from '../config.js'

const XML_CONTENT_TYPE = 'application/xml'
const MAX_LIST_SCAN_MULTIPLIER = 4
const MIN_LIST_PAGE_SIZE = 100
const UPLOAD_ID_PATTERN = /<UploadId>([^<]+)<\/UploadId>/i
const FORWARD_RESPONSE_HEADERS = [
  'content-type', 'content-length', 'etag', 'last-modified',
  'cache-control', 'content-disposition', 'x-amz-request-id',
  'x-amz-id-2', 'x-amz-version-id',
]

function nanoid(size = 10) {
  return randomBytes(size).toString('base64url').slice(0, size)
}

function normalizeQueryValue(value) {
  if (Array.isArray(value)) return value[0] ?? ''
  if (value === undefined || value === null) return ''
  return String(value)
}

function hasQueryFlag(query, key) {
  return Object.prototype.hasOwnProperty.call(query, key)
}

function nextLexicographicValue(value) {
  return `${value}\u0000`
}

function parseMaxKeys(rawValue) {
  const parsed = Number.parseInt(rawValue || '1000', 10)
  if (!Number.isFinite(parsed)) return 1000
  return Math.max(1, Math.min(parsed, 1000))
}

function getPayloadStream(request) {
  if (request.body && typeof request.body.pipe === 'function') {
    return request.body
  }
  if (Buffer.isBuffer(request.body)) {
    return Readable.from(request.body)
  }
  if (request.body instanceof Uint8Array) {
    return Readable.from(Buffer.from(request.body))
  }
  if (typeof request.body === 'string') {
    return Readable.from(Buffer.from(request.body))
  }
  return request.raw
}

async function readRequestBodyBuffer(request, maxBytes = 10 * 1024 * 1024) {
  if (Buffer.isBuffer(request.body)) return request.body
  if (request.body instanceof Uint8Array) return Buffer.from(request.body)
  if (typeof request.body === 'string') return Buffer.from(request.body)

  const source = request.body && typeof request.body[Symbol.asyncIterator] === 'function'
    ? request.body
    : request.raw

  const chunks = []
  let total = 0

  for await (const chunk of source) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length

    if (total > maxBytes) {
      const err = new Error(`Request body exceeds ${maxBytes} bytes`)
      err.statusCode = 413
      throw err
    }

    chunks.push(buffer)
  }

  return Buffer.concat(chunks)
}

function toReplyBody(body) {
  if (!body) return ''
  if (typeof body.pipe === 'function') return body
  if (typeof Readable.fromWeb === 'function' && typeof body.getReader === 'function') {
    return Readable.fromWeb(body)
  }
  return body
}

function buildProxyLocation(request, bucket, objectKey) {
  const protocol = request.protocol || 'http'
  const host = request.headers.host || `localhost:${config.PORT}`
  return `${protocol}://${host}/${bucket}/${objectKey}`
}

function extractUploadId(xml) {
  const match = UPLOAD_ID_PATTERN.exec(xml)
  return match?.[1] ?? ''
}

function xmlReply(reply, status, xml) {
  return reply.code(status).header('Content-Type', XML_CONTENT_TYPE).send(xml)
}

function addCorsHeaders(reply) {
  reply
    .header('Access-Control-Allow-Origin', '*')
    .header('Access-Control-Allow-Methods', 'GET, PUT, DELETE, HEAD, POST, OPTIONS')
    .header('Access-Control-Allow-Headers', 'x-api-key, authorization, content-type, content-length, x-amz-*')
    .header('Access-Control-Expose-Headers', 'ETag, Content-Type, Content-Length, Last-Modified')
}

function buildForwardHeaders(request) {
  const headers = {}

  for (const [key, value] of Object.entries(request.headers)) {
    const lower = key.toLowerCase()
    if (!['host', 'connection', 'x-api-key', 'authorization'].includes(lower)) {
      headers[lower] = value
    }
  }

  headers['x-forwarded-request-id'] = request.id
  return headers
}

async function consumeTextBody(response) {
  if (!response?.body) return ''
  return response.body.text().catch(() => '')
}

function objectMetadataFromHeaders(headers, fallback = {}) {
  const contentLength = Number.parseInt(headers['content-length'] ?? fallback.size_bytes ?? '0', 10)
  const lastModifiedHeader = headers['last-modified']
  const parsedLastModified = lastModifiedHeader ? Date.parse(lastModifiedHeader) : NaN

  return {
    sizeBytes: Number.isFinite(contentLength) ? contentLength : 0,
    etag: headers.etag?.replace(/"/g, '') ?? fallback.etag ?? null,
    contentType: headers['content-type'] ?? fallback.content_type ?? 'application/octet-stream',
    lastModified: Number.isFinite(parsedLastModified) ? parsedLastModified : (fallback.last_modified ?? Date.now()),
  }
}

async function loadMetadataFromRtdb(encodedKey) {
  try {
    const rtdbRoute = await rtdbGet(`/routes/${encodedKey}`)
    if (!rtdbRoute) return null
    return routeFromRtdb(encodedKey, rtdbRoute)
  } catch {
    return null
  }
}

async function lookupRouteMetadata(encodedKey) {
  const startedAt = process.hrtime.bigint()
  let source = 'miss'

  try {
    const cached = cacheGet(encodedKey)
    if (cached) {
      metrics.cacheHitsTotal.inc()
      source = 'cache'
      return cached
    }

    metrics.cacheMissesTotal.inc()

    const local = getRoute(encodedKey)
    if (local) {
      source = 'sqlite'
      const cacheValue = toRouteCacheValue(local)
      if (isVisibleRoute(local)) {
        cacheSet(encodedKey, cacheValue)
      }
      return cacheValue
    }

    const remote = await loadMetadataFromRtdb(encodedKey)
    if (remote) {
      source = 'rtdb'
      const cacheValue = toRouteCacheValue(remote)
      if (isVisibleRoute(remote)) {
        cacheSet(encodedKey, cacheValue)
      }
      return cacheValue
    }

    source = 'miss'
    return null
  } finally {
    const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000
    metrics.metadataLookupDurationSeconds.observe({ source }, durationSeconds)
  }
}

function shouldSkipByCursor(objectKey, cursor) {
  if (!cursor?.after) return false
  if (objectKey < cursor.after) return true
  if (objectKey === cursor.after) return true
  if (cursor.kind === 'prefix' && objectKey.startsWith(cursor.after)) return true
  return false
}

function buildListResultFromMetadata(bucket, query = {}) {
  const prefix = normalizeQueryValue(query.prefix)
  const delimiter = normalizeQueryValue(query.delimiter)
  const maxKeys = parseMaxKeys(normalizeQueryValue(query['max-keys']))
  const continuationToken = normalizeQueryValue(query['continuation-token'])
  const startAfter = normalizeQueryValue(query['start-after'])
  const decodedToken = continuationToken ? decodeListContinuationToken(continuationToken) : null

  if (continuationToken && !decodedToken) {
    const err = new Error('Invalid continuation token')
    err.statusCode = 400
    err.s3Code = 'InvalidArgument'
    throw err
  }

  const cursor = decodedToken ?? (startAfter ? { after: startAfter, kind: 'object' } : null)
  const entries = []
  const seenPrefixes = new Set()
  const pageLimit = Math.max(MIN_LIST_PAGE_SIZE, maxKeys * MAX_LIST_SCAN_MULTIPLIER)
  let lowerBound = prefix || ''
  let exhausted = false

  if (cursor?.after && cursor.after > lowerBound) {
    lowerBound = cursor.after
  }

  while (entries.length <= maxKeys && !exhausted) {
    const page = listVisibleObjectsPage(bucket, { lowerBound, limit: pageLimit })
    if (page.length === 0) break

    for (const route of page) {
      const objectKey = route.object_key
      if (prefix && !objectKey.startsWith(prefix)) {
        exhausted = true
        break
      }

      if (shouldSkipByCursor(objectKey, cursor)) {
        continue
      }

      if (delimiter) {
        const remainder = objectKey.slice(prefix.length)
        const delimiterIndex = remainder.indexOf(delimiter)
        if (delimiterIndex !== -1) {
          const commonPrefix = `${prefix}${remainder.slice(0, delimiterIndex + delimiter.length)}`
          if (!seenPrefixes.has(commonPrefix)) {
            seenPrefixes.add(commonPrefix)
            entries.push({ type: 'prefix', value: commonPrefix })
          }
          continue
        }
      }

      entries.push({ type: 'object', value: route })
      if (entries.length > maxKeys) break
    }

    lowerBound = nextLexicographicValue(page.at(-1)?.object_key ?? lowerBound)
    if (page.length < pageLimit) exhausted = true
  }

  const isTruncated = entries.length > maxKeys
  const visibleEntries = isTruncated ? entries.slice(0, maxKeys) : entries
  const lastEntry = visibleEntries.at(-1)
  const nextContinuationToken = isTruncated && lastEntry
    ? encodeListContinuationToken({
        kind: lastEntry.type === 'prefix' ? 'prefix' : 'object',
        after: lastEntry.type === 'prefix' ? lastEntry.value : lastEntry.value.object_key,
      })
    : ''

  const objects = visibleEntries
    .filter((entry) => entry.type === 'object')
    .map((entry) => ({
      key: entry.value.object_key,
      size: entry.value.size_bytes,
      lastModified: entry.value.last_modified ?? entry.value.uploaded_at,
      etag: entry.value.etag,
    }))

  const commonPrefixes = visibleEntries
    .filter((entry) => entry.type === 'prefix')
    .map((entry) => entry.value)

  return buildListBucketResult(bucket, objects, {
    prefix,
    delimiter,
    maxKeys,
    startAfter: decodedToken ? '' : startAfter,
    continuationToken,
    nextContinuationToken,
    isTruncated,
    keyCount: visibleEntries.length,
    commonPrefixes,
  })
}

async function readBackendObjectMetadata(account, backendKey, requestId) {
  const response = await proxyRequest({
    account,
    method: 'HEAD',
    path: `/${account.bucket}/${backendKey}`,
    headers: { 'x-forwarded-request-id': requestId },
  })

  if (response.statusCode === 404) {
    return null
  }

  if (response.statusCode >= 300) {
    const error = new Error(`HEAD upstream returned ${response.statusCode}`)
    error.statusCode = response.statusCode
    throw error
  }

  return objectMetadataFromHeaders(response.headers)
}

async function readBackendObjectMetadataWithRetry(account, backendKey, requestId) {
  return withRetry(async () => {
    const metadata = await readBackendObjectMetadata(account, backendKey, requestId)
    if (!metadata) {
      const err = new Error('Backend object metadata not visible yet')
      err.code = 'BACKEND_METADATA_NOT_READY'
      err.statusCode = 503
      throw err
    }
    return metadata
  }, {
    maxAttempts: 3,
    baseDelayMs: 75,
  }).catch((err) => {
    if (err?.code === 'BACKEND_METADATA_NOT_READY') return null
    throw err
  })
}

async function chooseUploadTarget(bucket, objectKey, encodedKey, sizeBytes) {
  const existingMetadata = getRoute(encodedKey)
  if (existingMetadata && existingMetadata.state !== ROUTE_STATE.DELETED) {
    const account = getAccountById(existingMetadata.account_id)
    if (account) {
      return {
        account,
        backendKey: existingMetadata.backend_key || buildBackendKey(bucket, objectKey),
        existingMetadata,
      }
    }
  }

  const account = selectAccountForUpload(sizeBytes)
  return {
    account,
    backendKey: buildBackendKey(bucket, objectKey),
    existingMetadata: existingMetadata ?? null,
  }
}

async function syncCommittedRoute(route, accounts, request) {
  try {
    await syncRouteToRtdb(route)
  } catch (err) {
    metrics.metadataCommitFailuresTotal.inc({ stage: 'rtdb_sync' })
    request.log.warn({ err, encodedKey: route.encoded_key }, 'route RTDB sync failed; leaving PENDING_SYNC')
  }

  for (const account of accounts) {
    try {
      await patchAccountUsageToRtdb(account.account_id)
    } catch (err) {
      request.log.warn({ err, accountId: account.account_id }, 'account usage RTDB patch failed')
    }
  }
}

function setForwardResponseHeaders(reply, upstreamResponse) {
  for (const header of FORWARD_RESPONSE_HEADERS) {
    const value = upstreamResponse.headers[header]
    if (value) reply.header(header, value)
  }
}

export default async function s3Routes(fastify, _opts) {
  fastify.options('/*', async (_request, reply) => {
    addCorsHeaders(reply)
    reply.code(200).send('')
  })

  const authHook = { preHandler: [fastify.authenticate] }

  try {
    fastify.addContentTypeParser('*', (request, payload, done) => done(null, payload))
  } catch {
    // Parser may already exist in nested test apps.
  }

  fastify.put('/:bucket/*', {
    ...authHook,
    config: { rawBody: true },
  }, async (request, reply) => {
    const { bucket } = request.params
    const objectKey = request.params['*']
    const encodedKey = encodeKey(bucket, objectKey)
    const reqId = request.id
    const query = request.query ?? {}

    addCorsHeaders(reply)

    if (normalizeQueryValue(query.uploadId) && normalizeQueryValue(query.partNumber)) {
      const uploadId = normalizeQueryValue(query.uploadId)
      const partNumber = normalizeQueryValue(query.partNumber)
      const multipart = getMultipartUpload(uploadId)
      if (!multipart) {
        return xmlReply(reply, 404, buildErrorXml('NoSuchUpload', 'The specified upload does not exist.', reqId))
      }

      const account = getAccountById(multipart.account_id)
      if (!account) {
        return xmlReply(reply, 500, buildErrorXml('InternalError', 'Account not found', reqId))
      }

      const upstream = await proxyRequest({
        account,
        method: 'PUT',
        path: `/${account.bucket}/${multipart.backend_key}`,
        query: { uploadId, partNumber },
        headers: buildForwardHeaders(request),
        bodyStream: getPayloadStream(request),
      })

      setForwardResponseHeaders(reply, upstream)
      metrics.requestsTotal.inc({ method: 'PUT', operation: 'upload_part', status_code: upstream.statusCode })
      reply.code(upstream.statusCode)
      return reply.send(await consumeTextBody(upstream))
    }

    const sizeBytes = Number.parseInt(request.headers['content-length'] ?? '0', 10) || 0

    let target
    try {
      target = await chooseUploadTarget(bucket, objectKey, encodedKey, sizeBytes)
    } catch (err) {
      if (err instanceof StorageFullError) {
        request.log.error({ err }, 'storage full')
        sendAlert({ event: 'storage_full', detail: err.message })
        reloadAccountsFromRTDB().catch(() => {})
        metrics.fallbackTotal.inc({ reason: 'storage_full' })
        return xmlReply(reply, 507, buildErrorXml('InsufficientStorage', err.message, reqId))
      }
      throw err
    }

    const upstream = await proxyRequest({
      account: target.account,
      method: 'PUT',
      path: `/${target.account.bucket}/${target.backendKey}`,
      headers: buildForwardHeaders(request),
      bodyStream: getPayloadStream(request),
    })

    setForwardResponseHeaders(reply, upstream)
    metrics.requestsTotal.inc({ method: 'PUT', operation: 'put_object', status_code: upstream.statusCode })

    if (upstream.statusCode >= 300) {
      return reply.code(upstream.statusCode).send(await consumeTextBody(upstream))
    }

    const now = Date.now()
    const upstreamMetadata = objectMetadataFromHeaders(upstream.headers, {
      size_bytes: sizeBytes,
      content_type: request.headers['content-type'] || 'application/octet-stream',
      last_modified: now,
    })

    let committed
    try {
      committed = commitUploadedObjectMetadata({
        encoded_key: encodedKey,
        account_id: target.account.account_id,
        bucket,
        object_key: objectKey,
        backend_key: target.backendKey,
        size_bytes: upstreamMetadata.sizeBytes || sizeBytes,
        etag: upstreamMetadata.etag,
        last_modified: upstreamMetadata.lastModified,
        content_type: upstreamMetadata.contentType,
        uploaded_at: now,
        updated_at: now,
        instance_id: config.INSTANCE_ID,
      })
    } catch (err) {
      metrics.metadataCommitFailuresTotal.inc({ stage: 'sqlite_write' })
      request.log.error({ err, encodedKey }, 'metadata commit failed after upstream upload')

      try {
        await proxyRequest({
          account: target.account,
          method: 'DELETE',
          path: `/${target.account.bucket}/${target.backendKey}`,
          headers: { 'x-forwarded-request-id': reqId },
        })
      } catch (rollbackErr) {
        metrics.metadataCommitFailuresTotal.inc({ stage: 'rollback_delete' })
        request.log.error({ err: rollbackErr, encodedKey }, 'rollback delete failed after metadata commit failure')
        sendAlert({ event: 'metadata_commit_failure', detail: `Rollback delete failed for ${encodedKey}` })
      }

      return xmlReply(reply, 500, buildErrorXml('InternalError', 'Metadata commit failed after upload', reqId))
    }

    syncAccountsFromRows(committed.affectedAccounts)
    cacheSet(encodedKey, toRouteCacheValue(committed.route))
    refreshMetadataMetrics()
    await syncCommittedRoute(committed.route, committed.affectedAccounts, request)

    metrics.uploadBytesTotal.inc({ account_id: target.account.account_id }, committed.route.size_bytes)

    reply.code(upstream.statusCode)
    return reply.send(await consumeTextBody(upstream))
  })

  fastify.get('/:bucket/*', authHook, async (request, reply) => {
    const { bucket } = request.params
    const objectKey = request.params['*']
    const encodedKey = encodeKey(bucket, objectKey)
    const reqId = request.id

    addCorsHeaders(reply)

    const route = await lookupRouteMetadata(encodedKey)
    if (!route || route.state !== ROUTE_STATE.ACTIVE) {
      return xmlReply(reply, 404, buildErrorXml('NoSuchKey', 'The specified key does not exist.', reqId))
    }

    const account = getAccountById(route.accountId)
    if (!account) {
      return xmlReply(reply, 404, buildErrorXml('NoSuchKey', 'Account not found', reqId))
    }

    const upstream = await proxyRequest({
      account,
      method: 'GET',
      path: `/${account.bucket}/${route.backendKey}`,
      headers: buildForwardHeaders(request),
    })

    if (upstream.statusCode === 404) {
      const result = markRouteMissingBackend(encodedKey, Date.now())
      syncAccountsFromRows(result.affectedAccounts)
      cacheDelete(encodedKey)
      refreshMetadataMetrics()
      if (result.route) {
        await syncCommittedRoute(result.route, result.affectedAccounts, request)
      }

      metrics.reconcilerMismatchTotal.inc({ type: 'missing_backend', account_id: account.account_id })
      request.log.warn({ encodedKey, accountId: account.account_id }, 'backend returned 404 for metadata-backed GET')
      metrics.requestsTotal.inc({ method: 'GET', operation: 'get_object', status_code: 404 })
      return xmlReply(reply, 404, buildErrorXml('NoSuchKey', 'The specified key does not exist.', reqId))
    }

    setForwardResponseHeaders(reply, upstream)
    metrics.requestsTotal.inc({ method: 'GET', operation: 'get_object', status_code: upstream.statusCode })

    if (upstream.statusCode === 200) {
      const size = Number.parseInt(upstream.headers['content-length'] ?? '0', 10) || 0
      if (size > 0) {
        metrics.downloadBytesTotal.inc({ account_id: account.account_id }, size)
      }
    }

    reply.code(upstream.statusCode)
    return reply.send(toReplyBody(upstream.body))
  })

  fastify.head('/:bucket/*', authHook, async (request, reply) => {
    const { bucket } = request.params
    const objectKey = request.params['*']
    const encodedKey = encodeKey(bucket, objectKey)

    addCorsHeaders(reply)

    const route = await lookupRouteMetadata(encodedKey)
    if (!route || route.state !== ROUTE_STATE.ACTIVE) {
      return reply.code(404).send()
    }

    const account = getAccountById(route.accountId)
    if (!account) {
      return reply.code(404).send()
    }

    const upstream = await proxyRequest({
      account,
      method: 'HEAD',
      path: `/${account.bucket}/${route.backendKey}`,
      headers: { 'x-forwarded-request-id': request.id },
    })

    if (upstream.statusCode === 404) {
      const result = markRouteMissingBackend(encodedKey, Date.now())
      syncAccountsFromRows(result.affectedAccounts)
      cacheDelete(encodedKey)
      refreshMetadataMetrics()
      if (result.route) {
        await syncCommittedRoute(result.route, result.affectedAccounts, request)
      }

      metrics.reconcilerMismatchTotal.inc({ type: 'missing_backend', account_id: account.account_id })
      request.log.warn({ encodedKey, accountId: account.account_id }, 'backend returned 404 for metadata-backed HEAD')
      metrics.requestsTotal.inc({ method: 'HEAD', operation: 'head_object', status_code: 404 })
      return reply.code(404).send()
    }

    setForwardResponseHeaders(reply, upstream)
    metrics.requestsTotal.inc({ method: 'HEAD', operation: 'head_object', status_code: upstream.statusCode })
    return reply.code(upstream.statusCode).send()
  })

  fastify.delete('/:bucket/*', authHook, async (request, reply) => {
    const { bucket } = request.params
    const objectKey = request.params['*']
    const encodedKey = encodeKey(bucket, objectKey)
    const reqId = request.id
    const query = request.query ?? {}

    addCorsHeaders(reply)

    if (normalizeQueryValue(query.uploadId)) {
      const uploadId = normalizeQueryValue(query.uploadId)
      const multipart = getMultipartUpload(uploadId)
      if (!multipart) {
        metrics.requestsTotal.inc({ method: 'DELETE', operation: 'abort_multipart', status_code: 204 })
        return reply.code(204).send()
      }

      const account = getAccountById(multipart.account_id)
      if (!account) {
        deleteMultipartUpload(uploadId)
        metrics.requestsTotal.inc({ method: 'DELETE', operation: 'abort_multipart', status_code: 204 })
        return reply.code(204).send()
      }

      const upstream = await proxyRequest({
        account,
        method: 'DELETE',
        path: `/${account.bucket}/${multipart.backend_key}`,
        query: { uploadId },
        headers: { 'x-forwarded-request-id': request.id },
      })

      metrics.requestsTotal.inc({ method: 'DELETE', operation: 'abort_multipart', status_code: upstream.statusCode })

      if (upstream.statusCode < 300 || upstream.statusCode === 404) {
        deleteMultipartUpload(uploadId)
        return reply.code(204).send()
      }

      return reply.code(upstream.statusCode).send(await consumeTextBody(upstream))
    }

    const route = await lookupRouteMetadata(encodedKey)
    if (!route || route.state === ROUTE_STATE.DELETED) {
      metrics.requestsTotal.inc({ method: 'DELETE', operation: 'delete_object', status_code: 204 })
      return reply.code(204).send()
    }

    const account = getAccountById(route.accountId)
    if (!account) {
      return xmlReply(reply, 404, buildErrorXml('NoSuchKey', 'Account not found', reqId))
    }

    markRouteDeleting(encodedKey, Date.now())

    const upstream = await proxyRequest({
      account,
      method: 'DELETE',
      path: `/${account.bucket}/${route.backendKey}`,
      headers: { 'x-forwarded-request-id': request.id },
    })

    if (upstream.statusCode >= 300 && upstream.statusCode !== 404) {
      const restored = revertDeletingRoute(encodedKey, Date.now())
      if (restored && restored.state === ROUTE_STATE.ACTIVE) {
        cacheSet(encodedKey, toRouteCacheValue(restored))
        await syncCommittedRoute(restored, [], request)
      }

      metrics.requestsTotal.inc({ method: 'DELETE', operation: 'delete_object', status_code: upstream.statusCode })
      return reply.code(upstream.statusCode).send(await consumeTextBody(upstream))
    }

    if (upstream.statusCode === 404) {
      metrics.reconcilerMismatchTotal.inc({ type: 'missing_backend', account_id: account.account_id })
      request.log.warn({ encodedKey, accountId: account.account_id }, 'backend returned 404 for metadata-backed DELETE')
    }

    const finalized = finalizeRouteDelete(encodedKey, Date.now(), {
      backendMissing: upstream.statusCode === 404,
      reconcileStatus: upstream.statusCode === 404
        ? ROUTE_RECONCILE_STATUS.NEEDS_REVIEW
        : ROUTE_RECONCILE_STATUS.HEALTHY,
    })

    syncAccountsFromRows(finalized.affectedAccounts)
    cacheDelete(encodedKey)
    refreshMetadataMetrics()
    if (finalized.route) {
      await syncCommittedRoute(finalized.route, finalized.affectedAccounts, request)
    }

    metrics.requestsTotal.inc({ method: 'DELETE', operation: 'delete_object', status_code: 204 })
    return reply.code(204).send()
  })

  fastify.get('/:bucket', authHook, async (request, reply) => {
    const { bucket } = request.params

    addCorsHeaders(reply)

    try {
      const xml = buildListResultFromMetadata(bucket, request.query ?? {})
      metrics.metadataBackedListRequestsTotal.inc({ status_code: 200 })
      metrics.requestsTotal.inc({ method: 'GET', operation: 'list_objects', status_code: 200 })
      return reply.code(200).header('Content-Type', XML_CONTENT_TYPE).send(xml)
    } catch (err) {
      metrics.metadataBackedListRequestsTotal.inc({ status_code: err.statusCode ?? 500 })
      if (err.s3Code) {
        metrics.requestsTotal.inc({ method: 'GET', operation: 'list_objects', status_code: err.statusCode ?? 400 })
        return xmlReply(reply, err.statusCode ?? 400, buildErrorXml(err.s3Code, err.message, request.id))
      }
      throw err
    }
  })

  fastify.put('/:bucket', authHook, async (_request, reply) => {
    addCorsHeaders(reply)
    metrics.requestsTotal.inc({ method: 'PUT', operation: 'create_bucket', status_code: 200 })
    return reply.code(200).send('')
  })

  fastify.delete('/:bucket', authHook, async (request, reply) => {
    const { bucket } = request.params

    addCorsHeaders(reply)

    const hasObjects = listVisibleObjectsPage(bucket, { lowerBound: '', limit: 1 }).length > 0
    if (hasObjects) {
      metrics.requestsTotal.inc({ method: 'DELETE', operation: 'delete_bucket', status_code: 409 })
      return xmlReply(reply, 409, buildErrorXml('BucketNotEmpty', 'The bucket you tried to delete is not empty.', request.id))
    }

    metrics.requestsTotal.inc({ method: 'DELETE', operation: 'delete_bucket', status_code: 204 })
    return reply.code(204).send()
  })

  fastify.post('/:bucket/*', authHook, async (request, reply) => {
    const { bucket } = request.params
    const objectKey = request.params['*']
    const encodedKey = encodeKey(bucket, objectKey)
    const reqId = request.id
    const query = request.query ?? {}

    addCorsHeaders(reply)

    if (hasQueryFlag(query, 'uploads')) {
      let target
      try {
        target = await chooseUploadTarget(bucket, objectKey, encodedKey, 0)
      } catch (err) {
        if (err instanceof StorageFullError) {
          sendAlert({ event: 'storage_full', detail: err.message })
          return xmlReply(reply, 507, buildErrorXml('InsufficientStorage', err.message, reqId))
        }
        throw err
      }

      const upstream = await proxyRequest({
        account: target.account,
        method: 'POST',
        path: `/${target.account.bucket}/${target.backendKey}`,
        query: { uploads: '' },
        headers: { 'x-forwarded-request-id': reqId },
      })

      const responseBody = await consumeTextBody(upstream)
      metrics.requestsTotal.inc({ method: 'POST', operation: 'create_multipart', status_code: upstream.statusCode })

      if (upstream.statusCode >= 300) {
        return reply.code(upstream.statusCode).header('Content-Type', XML_CONTENT_TYPE).send(responseBody)
      }

      const uploadId = extractUploadId(responseBody)
      if (!uploadId) {
        return xmlReply(reply, 502, buildErrorXml('InternalError', 'Upstream multipart upload ID missing', reqId))
      }

      upsertMultipartUpload({
        upload_id: uploadId,
        account_id: target.account.account_id,
        bucket,
        object_key: objectKey,
        backend_key: target.backendKey,
        started_at: Date.now(),
      })

      return reply.code(200).header('Content-Type', XML_CONTENT_TYPE).send(
        responseBody || buildInitiateMultipartUploadResult(bucket, objectKey, uploadId)
      )
    }

    if (normalizeQueryValue(query.uploadId) && !normalizeQueryValue(query.partNumber)) {
      const uploadId = normalizeQueryValue(query.uploadId)
      const multipart = getMultipartUpload(uploadId)
      if (!multipart) {
        return xmlReply(reply, 404, buildErrorXml('NoSuchUpload', 'The specified upload does not exist.', reqId))
      }

      const account = getAccountById(multipart.account_id)
      if (!account) {
        return xmlReply(reply, 500, buildErrorXml('InternalError', 'Account not found', reqId))
      }

      const completionPayload = await readRequestBodyBuffer(request)
      const upstream = await proxyRequest({
        account,
        method: 'POST',
        path: `/${account.bucket}/${multipart.backend_key}`,
        query: { uploadId },
        headers: {
          'content-type': request.headers['content-type'] || XML_CONTENT_TYPE,
          'x-forwarded-request-id': reqId,
        },
        bodyStream: Readable.from(completionPayload),
      })

      const responseBody = await consumeTextBody(upstream)
      metrics.requestsTotal.inc({ method: 'POST', operation: 'complete_multipart', status_code: upstream.statusCode })

      if (upstream.statusCode >= 300) {
        return reply.code(upstream.statusCode).header('Content-Type', XML_CONTENT_TYPE).send(responseBody)
      }

      let backendMetadata
      try {
        backendMetadata = await readBackendObjectMetadataWithRetry(account, multipart.backend_key, reqId)
      } catch (err) {
        metrics.metadataCommitFailuresTotal.inc({ stage: 'post_complete_head' })
        request.log.error({ err, uploadId }, 'failed to read metadata after multipart completion')
        return xmlReply(reply, 500, buildErrorXml('InternalError', 'Completed multipart object metadata lookup failed', reqId))
      }

      if (!backendMetadata) {
        metrics.metadataCommitFailuresTotal.inc({ stage: 'post_complete_missing' })
        return xmlReply(reply, 500, buildErrorXml('InternalError', 'Completed multipart object missing on backend', reqId))
      }

      let committed
      try {
        committed = commitUploadedObjectMetadata({
          encoded_key: encodedKey,
          account_id: account.account_id,
          bucket,
          object_key: objectKey,
          backend_key: multipart.backend_key,
          size_bytes: backendMetadata.sizeBytes,
          etag: backendMetadata.etag,
          last_modified: backendMetadata.lastModified,
          content_type: backendMetadata.contentType,
          uploaded_at: Date.now(),
          updated_at: Date.now(),
          instance_id: config.INSTANCE_ID,
        })
      } catch (err) {
        metrics.metadataCommitFailuresTotal.inc({ stage: 'sqlite_write' })
        request.log.error({ err, uploadId }, 'multipart metadata commit failed')

        try {
          await proxyRequest({
            account,
            method: 'DELETE',
            path: `/${account.bucket}/${multipart.backend_key}`,
            headers: { 'x-forwarded-request-id': reqId },
          })
        } catch (rollbackErr) {
          metrics.metadataCommitFailuresTotal.inc({ stage: 'rollback_delete' })
          request.log.error({ err: rollbackErr, uploadId }, 'rollback delete failed after multipart metadata commit failure')
        }

        return xmlReply(reply, 500, buildErrorXml('InternalError', 'Multipart metadata commit failed', reqId))
      }

      deleteMultipartUpload(uploadId)
      syncAccountsFromRows(committed.affectedAccounts)
      cacheSet(encodedKey, toRouteCacheValue(committed.route))
      refreshMetadataMetrics()
      await syncCommittedRoute(committed.route, committed.affectedAccounts, request)

      const etag = backendMetadata.etag ?? upstream.headers.etag?.replace(/"/g, '') ?? nanoid(16)
      const location = buildProxyLocation(request, bucket, objectKey)

      reply.code(200).header('Content-Type', XML_CONTENT_TYPE)
      return reply.send(buildCompleteMultipartUploadResult(bucket, objectKey, location, etag))
    }

    return xmlReply(reply, 400, buildErrorXml('InvalidRequest', 'Unknown multipart operation', reqId))
  })
}


