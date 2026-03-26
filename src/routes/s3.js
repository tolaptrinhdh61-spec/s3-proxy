/**
 * src/routes/s3.js
 * All S3-compatible route handlers for Fastify.
 */

import { randomBytes } from 'crypto'
import { Readable } from 'stream'

import { cacheGet, cacheSet, cacheDelete } from '../cache.js'
import {
  getRoute,
  upsertRoute,
  deleteRoute,
  getAllActiveAccounts,
  getAccountById,
  listRoutesByBucket,
  upsertMultipartUpload,
  getMultipartUpload,
  deleteMultipartUpload,
} from '../db.js'
import { rtdbGet, rtdbSet, rtdbDelete } from '../firebase.js'
import {
  selectAccountForUpload,
  recordUpload,
  recordDelete,
  reloadAccountsFromRTDB,
  StorageFullError,
} from '../accountPool.js'
import { proxyRequest } from '../utils/sigv4.js'
import { withRetry } from '../utils/retry.js'
import { sendAlert } from '../utils/webhook.js'
import {
  buildErrorXml,
  buildListBucketResult,
  buildInitiateMultipartUploadResult,
  buildCompleteMultipartUploadResult,
} from '../utils/s3Xml.js'
import { metrics } from './metrics.js'
import config from '../config.js'

const MAX_BUFFERED_UPLOAD_BYTES = 100 * 1024 * 1024
const UPLOAD_ID_PATTERN = /<UploadId>([^<]+)<\/UploadId>/i

function encodeKey(bucket, objectKey) {
  return Buffer.from(`${bucket}/${objectKey}`).toString('base64url')
}

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

function createBodyStream(buffer) {
  return buffer.length > 0 ? Readable.from(buffer) : null
}

async function readStreamToBuffer(stream, maxBytes = MAX_BUFFERED_UPLOAD_BYTES) {
  const chunks = []
  let total = 0

  for await (const chunk of stream) {
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

async function getRequestBodyBuffer(request) {
  if (Buffer.isBuffer(request.body)) return request.body
  if (request.body instanceof Uint8Array) return Buffer.from(request.body)
  if (typeof request.body === 'string') return Buffer.from(request.body)
  if (request.body === undefined || request.body === null) return Buffer.alloc(0)
  return readStreamToBuffer(request.raw)
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

function encodeContinuationToken(marker) {
  return Buffer.from(marker).toString('base64url')
}

function decodeContinuationToken(token) {
  try {
    return Buffer.from(token, 'base64url').toString('utf8')
  } catch {
    return ''
  }
}

function buildListResultFromRoutes(bucket, routes, query) {
  const prefix = normalizeQueryValue(query.prefix)
  const delimiter = normalizeQueryValue(query.delimiter)
  const requestedMaxKeys = parseInt(normalizeQueryValue(query['max-keys']) || '1000', 10)
  const maxKeys = Number.isFinite(requestedMaxKeys)
    ? Math.max(1, Math.min(requestedMaxKeys, 1000))
    : 1000
  const continuationToken = normalizeQueryValue(query['continuation-token'])
  const startAfter = decodeContinuationToken(continuationToken) || normalizeQueryValue(query['start-after'])

  const entries = []
  const seenPrefixes = new Set()

  for (const route of routes) {
    const objectKey = route.object_key
    if (startAfter) {
      if (objectKey <= startAfter) continue
      if (delimiter && startAfter.endsWith(delimiter) && objectKey.startsWith(startAfter)) continue
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
      } else {
        entries.push({ type: 'object', value: route })
      }
    } else {
      entries.push({ type: 'object', value: route })
    }
  }

  const isTruncated = entries.length > maxKeys
  const visibleEntries = entries.slice(0, maxKeys)
  const lastEntry = visibleEntries.at(-1)
  const nextContinuationToken = isTruncated && lastEntry
    ? encodeContinuationToken(lastEntry.type === 'object' ? lastEntry.value.object_key : lastEntry.value)
    : ''

  const objects = visibleEntries
    .filter(entry => entry.type === 'object')
    .map(entry => ({
      key: entry.value.object_key,
      size: entry.value.size_bytes,
      lastModified: entry.value.uploaded_at,
    }))

  const commonPrefixes = visibleEntries
    .filter(entry => entry.type === 'prefix')
    .map(entry => entry.value)

  return buildListBucketResult(bucket, objects, {
    prefix,
    delimiter,
    maxKeys,
    continuationToken,
    nextContinuationToken,
    isTruncated,
    commonPrefixes,
  })
}

async function lookupRoute(encodedKey) {
  const cached = cacheGet(encodedKey)
  if (cached) {
    metrics.cacheHitsTotal.inc()
    return cached
  }
  metrics.cacheMissesTotal.inc()

  const row = getRoute(encodedKey)
  if (row) {
    const route = {
      accountId: row.account_id,
      bucket: row.bucket,
      objectKey: row.object_key,
      sizeBytes: row.size_bytes,
    }
    cacheSet(encodedKey, route)
    return route
  }

  try {
    const rtdbRoute = await rtdbGet(`/routes/${encodedKey}`)
    if (rtdbRoute) {
      upsertRoute({
        encoded_key: encodedKey,
        account_id: rtdbRoute.accountId,
        bucket: rtdbRoute.bucket,
        object_key: rtdbRoute.objectKey,
        size_bytes: rtdbRoute.sizeBytes ?? 0,
        uploaded_at: rtdbRoute.uploadedAt ?? Date.now(),
        instance_id: rtdbRoute.instanceId ?? '',
      })

      const route = {
        accountId: rtdbRoute.accountId,
        bucket: rtdbRoute.bucket,
        objectKey: rtdbRoute.objectKey,
        sizeBytes: rtdbRoute.sizeBytes ?? 0,
      }
      cacheSet(encodedKey, route)
      return route
    }
  } catch {
    // RTDB unreachable - fall through to 404 path.
  }

  return null
}

function xmlReply(reply, status, xml) {
  return reply.code(status).header('Content-Type', 'application/xml').send(xml)
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

const FORWARD_RESPONSE_HEADERS = [
  'content-type', 'content-length', 'etag', 'last-modified',
  'cache-control', 'content-disposition', 'x-amz-request-id',
  'x-amz-id-2', 'x-amz-version-id',
]

export default async function s3Routes(fastify, _opts) {
  fastify.options('/*', async (_request, reply) => {
    addCorsHeaders(reply)
    reply.code(200).send('')
  })

  const authHook = { preHandler: [fastify.authenticate] }

  try {
    fastify.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body))
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

      const bodyBuffer = await getRequestBodyBuffer(request)
      const supabaseRes = await proxyRequest({
        account,
        method: 'PUT',
        path: `/${account.bucket}/${multipart.object_key}`,
        query: { uploadId, partNumber },
        headers: buildForwardHeaders(request),
        bodyStream: createBodyStream(bodyBuffer),
      })

      for (const header of ['etag', 'x-amz-request-id']) {
        const value = supabaseRes.headers[header]
        if (value) reply.header(header, value)
      }

      metrics.requestsTotal.inc({ method: 'PUT', operation: 'upload_part', status_code: supabaseRes.statusCode })
      reply.code(supabaseRes.statusCode)
      const body = await supabaseRes.body.text().catch(() => '')
      return reply.send(body || '')
    }

    const sizeBytes = parseInt(request.headers['content-length'] ?? '0', 10) || 0
    const requestBody = await getRequestBodyBuffer(request)
    const forwardHeaders = buildForwardHeaders(request)

    let account
    try {
      account = selectAccountForUpload(sizeBytes)
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

    let supabaseRes
    const excludedAccounts = new Set()

    try {
      supabaseRes = await withRetry(
        async () => {
          const response = await proxyRequest({
            account,
            method: 'PUT',
            path: `/${account.bucket}/${objectKey}`,
            headers: forwardHeaders,
            bodyStream: createBodyStream(requestBody),
          })

          if (response.statusCode >= 500) {
            const err = new Error(`Supabase error ${response.statusCode}`)
            err.statusCode = response.statusCode
            throw err
          }

          return response
        },
        {
          maxAttempts: 3,
          baseDelayMs: 100,
          onRetry: (attempt, err) => {
            request.log.warn({ attempt, err: err.message }, 'PUT retry')
            metrics.retryTotal.inc({ operation: 'put_object' })
          },
        }
      )
    } catch (primaryErr) {
      excludedAccounts.add(account.account_id)
      let fallbackAccount
      try {
        fallbackAccount = selectAccountForUpload(sizeBytes, excludedAccounts)
      } catch {
        return xmlReply(reply, 507, buildErrorXml('InsufficientStorage', 'All accounts unavailable', reqId))
      }

      metrics.fallbackTotal.inc({ reason: 'supabase_5xx' })
      request.log.warn({ primaryAccount: account.account_id, fallback: fallbackAccount.account_id }, 'falling back to account')

      supabaseRes = await proxyRequest({
        account: fallbackAccount,
        method: 'PUT',
        path: `/${fallbackAccount.bucket}/${objectKey}`,
        headers: forwardHeaders,
        bodyStream: createBodyStream(requestBody),
      })
      account = fallbackAccount
    }

    for (const header of FORWARD_RESPONSE_HEADERS) {
      const value = supabaseRes.headers[header]
      if (value) reply.header(header, value)
    }

    if (supabaseRes.statusCode < 300) {
      const now = Date.now()
      upsertRoute({
        encoded_key: encodedKey,
        account_id: account.account_id,
        bucket,
        object_key: objectKey,
        size_bytes: sizeBytes,
        uploaded_at: now,
        instance_id: config.INSTANCE_ID,
      })
      cacheSet(encodedKey, { accountId: account.account_id, bucket, objectKey, sizeBytes })
      recordUpload(account.account_id, sizeBytes)

      Promise.resolve()
        .then(() => rtdbSet(`/routes/${encodedKey}`, {
          accountId: account.account_id,
          bucket,
          objectKey,
          sizeBytes,
          uploadedAt: now,
          instanceId: config.INSTANCE_ID,
        }))
        .catch(() => {})

      metrics.uploadBytesTotal.inc({ account_id: account.account_id }, sizeBytes)
    }

    metrics.requestsTotal.inc({ method: 'PUT', operation: 'put_object', status_code: supabaseRes.statusCode })

    reply.code(supabaseRes.statusCode)
    const body = await supabaseRes.body.text().catch(() => '')
    return reply.send(body || '')
  })

  fastify.get('/:bucket/*', authHook, async (request, reply) => {
    const { bucket } = request.params
    const objectKey = request.params['*']
    const encodedKey = encodeKey(bucket, objectKey)
    const reqId = request.id

    addCorsHeaders(reply)

    const route = await lookupRoute(encodedKey)
    if (!route) {
      return xmlReply(reply, 404, buildErrorXml('NoSuchKey', 'The specified key does not exist.', reqId))
    }

    const account = getAccountById(route.accountId)
    if (!account) {
      return xmlReply(reply, 404, buildErrorXml('NoSuchKey', 'Account not found', reqId))
    }

    const supabaseRes = await proxyRequest({
      account,
      method: 'GET',
      path: `/${account.bucket}/${objectKey}`,
      headers: buildForwardHeaders(request),
    })

    for (const header of FORWARD_RESPONSE_HEADERS) {
      const value = supabaseRes.headers[header]
      if (value) reply.header(header, value)
    }

    metrics.requestsTotal.inc({ method: 'GET', operation: 'get_object', status_code: supabaseRes.statusCode })

    if (supabaseRes.statusCode === 200) {
      const size = parseInt(supabaseRes.headers['content-length'] ?? '0', 10) || 0
      if (size > 0) {
        metrics.downloadBytesTotal.inc({ account_id: account.account_id }, size)
      }
    }

    reply.code(supabaseRes.statusCode)
    return reply.send(toReplyBody(supabaseRes.body))
  })

  fastify.head('/:bucket/*', authHook, async (request, reply) => {
    const { bucket } = request.params
    const objectKey = request.params['*']
    const encodedKey = encodeKey(bucket, objectKey)
    const reqId = request.id

    addCorsHeaders(reply)

    const route = await lookupRoute(encodedKey)
    if (!route) {
      return xmlReply(reply, 404, buildErrorXml('NoSuchKey', 'The specified key does not exist.', reqId))
    }

    const account = getAccountById(route.accountId)
    if (!account) {
      return reply.code(404).send()
    }

    const supabaseRes = await proxyRequest({
      account,
      method: 'HEAD',
      path: `/${account.bucket}/${objectKey}`,
      headers: { 'x-forwarded-request-id': request.id },
    })

    for (const header of FORWARD_RESPONSE_HEADERS) {
      const value = supabaseRes.headers[header]
      if (value) reply.header(header, value)
    }

    metrics.requestsTotal.inc({ method: 'HEAD', operation: 'head_object', status_code: supabaseRes.statusCode })
    return reply.code(supabaseRes.statusCode).send()
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

      const supabaseRes = await proxyRequest({
        account,
        method: 'DELETE',
        path: `/${account.bucket}/${multipart.object_key}`,
        query: { uploadId },
        headers: { 'x-forwarded-request-id': request.id },
      })

      metrics.requestsTotal.inc({ method: 'DELETE', operation: 'abort_multipart', status_code: supabaseRes.statusCode })

      if (supabaseRes.statusCode < 300 || supabaseRes.statusCode === 404) {
        deleteMultipartUpload(uploadId)
        return reply.code(204).send()
      }

      const body = await supabaseRes.body.text().catch(() => '')
      return reply.code(supabaseRes.statusCode).send(body || '')
    }

    const route = await lookupRoute(encodedKey)
    if (!route) {
      return reply.code(204).send()
    }

    const account = getAccountById(route.accountId)
    if (!account) {
      return xmlReply(reply, 404, buildErrorXml('NoSuchKey', 'Account not found', reqId))
    }

    const supabaseRes = await proxyRequest({
      account,
      method: 'DELETE',
      path: `/${account.bucket}/${objectKey}`,
      headers: { 'x-forwarded-request-id': request.id },
    })

    if (supabaseRes.statusCode < 300 || supabaseRes.statusCode === 404) {
      deleteRoute(encodedKey)
      cacheDelete(encodedKey)
      recordDelete(account.account_id, route.sizeBytes ?? 0)

      Promise.resolve()
        .then(() => rtdbDelete(`/routes/${encodedKey}`))
        .catch(() => {})
    }

    metrics.requestsTotal.inc({ method: 'DELETE', operation: 'delete_object', status_code: supabaseRes.statusCode })
    return reply.code(204).send()
  })

  fastify.get('/:bucket', authHook, async (request, reply) => {
    const { bucket } = request.params

    addCorsHeaders(reply)

    const prefix = normalizeQueryValue(request.query?.prefix)
    const routes = listRoutesByBucket(bucket, prefix)
    const xml = buildListResultFromRoutes(bucket, routes, request.query ?? {})

    metrics.requestsTotal.inc({ method: 'GET', operation: 'list_objects', status_code: 200 })
    return reply.code(200).header('Content-Type', 'application/xml').send(xml)
  })

  fastify.put('/:bucket', authHook, async (request, reply) => {
    addCorsHeaders(reply)

    const accounts = getAllActiveAccounts()
    if (accounts.length === 0) {
      return xmlReply(reply, 503, buildErrorXml('ServiceUnavailable', 'No active accounts', request.id))
    }

    const account = accounts[0]
    const supabaseRes = await proxyRequest({ account, method: 'PUT', path: `/${account.bucket}`, headers: {} })
    metrics.requestsTotal.inc({ method: 'PUT', operation: 'create_bucket', status_code: supabaseRes.statusCode })
    return reply.code(supabaseRes.statusCode).send()
  })

  fastify.delete('/:bucket', authHook, async (request, reply) => {
    addCorsHeaders(reply)

    const accounts = getAllActiveAccounts()
    if (accounts.length === 0) return reply.code(204).send()

    const account = accounts[0]
    const supabaseRes = await proxyRequest({ account, method: 'DELETE', path: `/${account.bucket}`, headers: {} })
    metrics.requestsTotal.inc({ method: 'DELETE', operation: 'delete_bucket', status_code: supabaseRes.statusCode })
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
      let account
      try {
        account = selectAccountForUpload(0)
      } catch (err) {
        if (err instanceof StorageFullError) {
          sendAlert({ event: 'storage_full', detail: err.message })
          return xmlReply(reply, 507, buildErrorXml('InsufficientStorage', err.message, reqId))
        }
        throw err
      }

      const supabaseRes = await proxyRequest({
        account,
        method: 'POST',
        path: `/${account.bucket}/${objectKey}`,
        query: { uploads: '' },
        headers: { 'x-forwarded-request-id': reqId },
      })

      const responseBody = await supabaseRes.body.text().catch(() => '')
      metrics.requestsTotal.inc({ method: 'POST', operation: 'create_multipart', status_code: supabaseRes.statusCode })

      if (supabaseRes.statusCode >= 300) {
        return reply.code(supabaseRes.statusCode).header('Content-Type', 'application/xml').send(responseBody)
      }

      const uploadId = extractUploadId(responseBody)
      if (!uploadId) {
        return xmlReply(reply, 502, buildErrorXml('InternalError', 'Upstream multipart upload ID missing', reqId))
      }

      upsertMultipartUpload({
        upload_id: uploadId,
        account_id: account.account_id,
        bucket,
        object_key: objectKey,
        started_at: Date.now(),
      })

      return reply.code(200).header('Content-Type', 'application/xml').send(
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

      const bodyBuffer = await getRequestBodyBuffer(request)
      const supabaseRes = await proxyRequest({
        account,
        method: 'POST',
        path: `/${account.bucket}/${multipart.object_key}`,
        query: { uploadId },
        headers: {
          'content-type': request.headers['content-type'] || 'application/xml',
          'x-forwarded-request-id': reqId,
        },
        bodyStream: createBodyStream(bodyBuffer),
      })

      const responseBody = await supabaseRes.body.text().catch(() => '')
      metrics.requestsTotal.inc({ method: 'POST', operation: 'complete_multipart', status_code: supabaseRes.statusCode })

      if (supabaseRes.statusCode >= 300) {
        return reply.code(supabaseRes.statusCode).header('Content-Type', 'application/xml').send(responseBody)
      }

      deleteMultipartUpload(uploadId)

      const now = Date.now()
      upsertRoute({
        encoded_key: encodedKey,
        account_id: account.account_id,
        bucket,
        object_key: objectKey,
        size_bytes: 0,
        uploaded_at: now,
        instance_id: config.INSTANCE_ID,
      })
      cacheSet(encodedKey, { accountId: account.account_id, bucket, objectKey, sizeBytes: 0 })

      Promise.resolve()
        .then(() => rtdbSet(`/routes/${encodedKey}`, {
          accountId: account.account_id,
          bucket,
          objectKey,
          sizeBytes: 0,
          uploadedAt: now,
          instanceId: config.INSTANCE_ID,
        }))
        .catch(() => {})

      const etag = supabaseRes.headers.etag?.replace(/"/g, '') ?? nanoid(16)
      const location = buildProxyLocation(request, bucket, objectKey)

      reply.code(200).header('Content-Type', 'application/xml')
      return reply.send(buildCompleteMultipartUploadResult(bucket, objectKey, location, etag))
    }

    return xmlReply(reply, 400, buildErrorXml('InvalidRequest', 'Unknown multipart operation', reqId))
  })
}



