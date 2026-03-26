/**
 * src/routes/s3.js
 * All S3-compatible route handlers for Fastify.
 *
 * Handles: PUT, GET, HEAD, DELETE, POST (multipart), LIST
 * Auth via preHandler using fastify.authenticate decorator.
 * Body parsing disabled for binary routes — raw streams piped directly.
 */

import { randomBytes } from 'crypto'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'

import { cacheGet, cacheSet, cacheDelete } from '../cache.js'
import { getRoute, upsertRoute, deleteRoute, getAllActiveAccounts,
         upsertMultipartUpload, getMultipartUpload, deleteMultipartUpload } from '../db.js'
import { rtdbGet, rtdbSet, rtdbDelete } from '../firebase.js'
import {
  selectAccountForUpload, recordUpload, recordDelete,
  reloadAccountsFromRTDB, StorageFullError, getAccountsStats,
} from '../accountPool.js'
import { proxyRequest, resignRequest } from '../utils/sigv4.js'
import { withRetry } from '../utils/retry.js'
import { sendAlert } from '../utils/webhook.js'
import {
  buildErrorXml, buildListBucketResult,
  buildInitiateMultipartUploadResult, buildCompleteMultipartUploadResult,
} from '../utils/s3Xml.js'
import { metrics } from './metrics.js'
import config from '../config.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function encodeKey(bucket, objectKey) {
  return Buffer.from(`${bucket}/${objectKey}`).toString('base64url')
}

function nanoid(size = 10) {
  return randomBytes(size).toString('base64url').slice(0, size)
}

/**
 * Look up route: LRU → SQLite → RTDB
 * @param {string} encodedKey
 * @returns {object|null} route object or null
 */
async function lookupRoute(encodedKey) {
  // 1. LRU cache
  const cached = cacheGet(encodedKey)
  if (cached) {
    metrics.cacheHitsTotal.inc()
    return cached
  }
  metrics.cacheMissesTotal.inc()

  // 2. SQLite
  const row = getRoute(encodedKey)
  if (row) {
    cacheSet(encodedKey, {
      accountId:  row.account_id,
      bucket:     row.bucket,
      objectKey:  row.object_key,
      sizeBytes:  row.size_bytes,
    })
    return { accountId: row.account_id, bucket: row.bucket, objectKey: row.object_key, sizeBytes: row.size_bytes }
  }

  // 3. RTDB fallback
  try {
    const rtdbRoute = await rtdbGet(`/routes/${encodedKey}`)
    if (rtdbRoute) {
      upsertRoute({
        encoded_key: encodedKey,
        account_id:  rtdbRoute.accountId,
        bucket:      rtdbRoute.bucket,
        object_key:  rtdbRoute.objectKey,
        size_bytes:  rtdbRoute.sizeBytes ?? 0,
        uploaded_at: rtdbRoute.uploadedAt ?? Date.now(),
        instance_id: rtdbRoute.instanceId ?? '',
      })
      const val = {
        accountId: rtdbRoute.accountId,
        bucket:    rtdbRoute.bucket,
        objectKey: rtdbRoute.objectKey,
        sizeBytes: rtdbRoute.sizeBytes ?? 0,
      }
      cacheSet(encodedKey, val)
      return val
    }
  } catch {
    // RTDB unreachable — continue to 404
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

// Headers forwarded verbatim from Supabase to client
const FORWARD_RESPONSE_HEADERS = [
  'content-type', 'content-length', 'etag', 'last-modified',
  'cache-control', 'content-disposition', 'x-amz-request-id',
  'x-amz-id-2', 'x-amz-version-id',
]

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default async function s3Routes(fastify, _opts) {
  // CORS preflight
  fastify.options('/*', async (request, reply) => {
    addCorsHeaders(reply)
    reply.code(200).send('')
  })

  // Auth preHandler for all S3 routes
  const authHook = { preHandler: [fastify.authenticate] }

  // ── PUT /:bucket/:key* — Upload object ──────────────────────────────────────
  fastify.put('/:bucket/*', {
    ...authHook,
    config: { rawBody: true },
  }, async (request, reply) => {
    const { bucket } = request.params
    const objectKey = request.params['*']
    const encodedKey = encodeKey(bucket, objectKey)
    const reqId = request.id
    const sizeBytes = parseInt(request.headers['content-length'] ?? '0', 10) || 0

    addCorsHeaders(reply)

    // Track metric
    let operation = 'put_object'

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

    const path = `/${account.bucket}/${objectKey}`
    const forwardHeaders = {}
    for (const [k, v] of Object.entries(request.headers)) {
      const lower = k.toLowerCase()
      if (!['host', 'connection', 'x-api-key', 'authorization'].includes(lower)) {
        forwardHeaders[lower] = v
      }
    }
    forwardHeaders['x-forwarded-request-id'] = reqId

    let supabaseRes
    const excludedAccounts = new Set()

    try {
      supabaseRes = await withRetry(
        async () => {
          const res = await proxyRequest({
            account,
            method: 'PUT',
            path,
            headers: forwardHeaders,
            bodyStream: request.raw,
          })
          if (res.statusCode >= 500) {
            const err = new Error(`Supabase error ${res.statusCode}`)
            err.statusCode = res.statusCode
            throw err
          }
          return res
        },
        {
          maxAttempts: 3,
          baseDelayMs: 100,
          onRetry: (attempt, err) => {
            request.log.warn({ attempt, err: err.message }, 'PUT retry')
            metrics.retryTotal.inc({ operation })
          },
        }
      )
    } catch (primaryErr) {
      // Fallback: try another account
      excludedAccounts.add(account.account_id)
      let fallbackAccount
      try {
        fallbackAccount = selectAccountForUpload(sizeBytes, excludedAccounts)
      } catch {
        return xmlReply(reply, 507, buildErrorXml('InsufficientStorage', 'All accounts unavailable', reqId))
      }

      metrics.fallbackTotal.inc({ reason: 'supabase_5xx' })
      request.log.warn({ primaryAccount: account.account_id, fallback: fallbackAccount.account_id }, 'falling back to account')

      try {
        const fallbackPath = `/${fallbackAccount.bucket}/${objectKey}`
        supabaseRes = await proxyRequest({
          account:    fallbackAccount,
          method:     'PUT',
          path:       fallbackPath,
          headers:    forwardHeaders,
          bodyStream: request.raw,
        })
        account = fallbackAccount
      } catch (fallbackErr) {
        throw fallbackErr
      }
    }

    // Forward response headers verbatim
    for (const h of FORWARD_RESPONSE_HEADERS) {
      const val = supabaseRes.headers[h]
      if (val) reply.header(h, val)
    }

    // On success, persist route
    if (supabaseRes.statusCode < 300) {
      const now = Date.now()
      const routeObj = {
        encoded_key: encodedKey,
        account_id:  account.account_id,
        bucket,
        object_key:  objectKey,
        size_bytes:  sizeBytes,
        uploaded_at: now,
        instance_id: config.INSTANCE_ID,
      }

      upsertRoute(routeObj)
      cacheSet(encodedKey, { accountId: account.account_id, bucket, objectKey, sizeBytes })
      recordUpload(account.account_id, sizeBytes)

      // Fire-and-forget RTDB sync
      Promise.resolve().then(() => rtdbSet(`/routes/${encodedKey}`, {
        accountId:  account.account_id,
        bucket,
        objectKey,
        sizeBytes,
        uploadedAt: now,
        instanceId: config.INSTANCE_ID,
      })).catch(() => {})

      metrics.uploadBytesTotal.inc({ account_id: account.account_id }, sizeBytes)
    }

    metrics.requestsTotal.inc({ method: 'PUT', operation, status_code: supabaseRes.statusCode })

    // Drain and send Supabase body
    reply.code(supabaseRes.statusCode)
    const body = await supabaseRes.body.text().catch(() => '')
    return reply.send(body || '')
  })

  // ── GET /:bucket/:key* — Download object ────────────────────────────────────
  fastify.get('/:bucket/*', authHook, async (request, reply) => {
    const { bucket } = request.params
    const objectKey = request.params['*']
    const encodedKey = encodeKey(bucket, objectKey)
    const reqId = request.id

    addCorsHeaders(reply)

    const route = await lookupRoute(encodedKey)
    if (!route) {
      return xmlReply(reply, 404, buildErrorXml('NoSuchKey', `The specified key does not exist.`, reqId))
    }

    // Get account credentials
    const { getAllActiveAccounts: _get } = await import('../db.js')
    const accounts = _get()
    const account = accounts.find(a => a.account_id === route.accountId)
    if (!account) {
      return xmlReply(reply, 404, buildErrorXml('NoSuchKey', 'Account not found', reqId))
    }

    const path = `/${account.bucket}/${objectKey}`
    const forwardHeaders = {}
    for (const [k, v] of Object.entries(request.headers)) {
      const lower = k.toLowerCase()
      if (!['host', 'connection', 'x-api-key', 'authorization'].includes(lower)) {
        forwardHeaders[lower] = v
      }
    }

    const supabaseRes = await proxyRequest({
      account,
      method:  'GET',
      path,
      headers: forwardHeaders,
    })

    // Forward headers verbatim
    for (const h of FORWARD_RESPONSE_HEADERS) {
      const val = supabaseRes.headers[h]
      if (val) reply.header(h, val)
    }

    metrics.requestsTotal.inc({ method: 'GET', operation: 'get_object', status_code: supabaseRes.statusCode })

    if (supabaseRes.statusCode === 200) {
      const size = parseInt(supabaseRes.headers['content-length'] ?? '0', 10) || 0
      if (size > 0) metrics.downloadBytesTotal.inc({ account_id: account.account_id }, size)
    }

    reply.code(supabaseRes.statusCode)
    // Stream body directly without buffering
    return reply.send(supabaseRes.body)
  })

  // ── HEAD /:bucket/:key* — Object metadata ───────────────────────────────────
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

    const accounts = getAllActiveAccounts()
    const account = accounts.find(a => a.account_id === route.accountId)
    if (!account) {
      return reply.code(404).send()
    }

    const path = `/${account.bucket}/${objectKey}`
    const supabaseRes = await proxyRequest({
      account,
      method:  'HEAD',
      path,
      headers: { 'x-forwarded-request-id': request.id },
    })

    for (const h of FORWARD_RESPONSE_HEADERS) {
      const val = supabaseRes.headers[h]
      if (val) reply.header(h, val)
    }

    metrics.requestsTotal.inc({ method: 'HEAD', operation: 'head_object', status_code: supabaseRes.statusCode })
    // HEAD must not send body
    return reply.code(supabaseRes.statusCode).send()
  })

  // ── DELETE /:bucket/:key* — Delete object ───────────────────────────────────
  fastify.delete('/:bucket/*', authHook, async (request, reply) => {
    const { bucket } = request.params
    const objectKey = request.params['*']
    const encodedKey = encodeKey(bucket, objectKey)
    const reqId = request.id

    addCorsHeaders(reply)

    const route = await lookupRoute(encodedKey)
    if (!route) {
      return reply.code(204).send()
    }

    const accounts = getAllActiveAccounts()
    const account = accounts.find(a => a.account_id === route.accountId)
    if (!account) {
      deleteRoute(encodedKey)
      cacheDelete(encodedKey)
      return reply.code(204).send()
    }

    const path = `/${account.bucket}/${objectKey}`
    const supabaseRes = await proxyRequest({
      account,
      method:  'DELETE',
      path,
      headers: { 'x-forwarded-request-id': request.id },
    })

    if (supabaseRes.statusCode < 300 || supabaseRes.statusCode === 404) {
      deleteRoute(encodedKey)
      cacheDelete(encodedKey)
      recordDelete(account.account_id, route.sizeBytes ?? 0)

      Promise.resolve().then(() => rtdbDelete(`/routes/${encodedKey}`)).catch(() => {})
    }

    metrics.requestsTotal.inc({ method: 'DELETE', operation: 'delete_object', status_code: supabaseRes.statusCode })
    return reply.code(204).send()
  })

  // ── GET /:bucket — List objects ─────────────────────────────────────────────
  fastify.get('/:bucket', authHook, async (request, reply) => {
    const { bucket } = request.params

    addCorsHeaders(reply)

    // Pass through to first active account
    const accounts = getAllActiveAccounts()
    if (accounts.length === 0) {
      return xmlReply(reply, 503, buildErrorXml('ServiceUnavailable', 'No active accounts', request.id))
    }

    const account = accounts[0]
    const path = `/${account.bucket}`
    const queryStr = new URLSearchParams(request.query).toString()

    const { url, headers: signedHeaders } = await resignRequest({
      account,
      method:  'GET',
      path,
      query:   Object.fromEntries(new URLSearchParams(request.query)),
      headers: { 'x-forwarded-request-id': request.id },
    })

    const { request: undiciReq } = await import('undici')
    const supabaseRes = await undiciReq(url, { method: 'GET', headers: signedHeaders })

    reply.code(supabaseRes.statusCode).header('Content-Type', 'application/xml')
    metrics.requestsTotal.inc({ method: 'GET', operation: 'list_objects', status_code: supabaseRes.statusCode })
    return reply.send(supabaseRes.body)
  })

  // ── PUT /:bucket — Create bucket (passthrough) ──────────────────────────────
  fastify.put('/:bucket', authHook, async (request, reply) => {
    addCorsHeaders(reply)
    const accounts = getAllActiveAccounts()
    if (accounts.length === 0) {
      return xmlReply(reply, 503, buildErrorXml('ServiceUnavailable', 'No active accounts', request.id))
    }
    const account = accounts[0]
    const path = `/${account.bucket}`
    const supabaseRes = await proxyRequest({ account, method: 'PUT', path, headers: {} })
    metrics.requestsTotal.inc({ method: 'PUT', operation: 'create_bucket', status_code: supabaseRes.statusCode })
    return reply.code(supabaseRes.statusCode).send()
  })

  // ── DELETE /:bucket — Delete bucket (passthrough) ──────────────────────────
  fastify.delete('/:bucket', authHook, async (request, reply) => {
    addCorsHeaders(reply)
    const accounts = getAllActiveAccounts()
    if (accounts.length === 0) return reply.code(204).send()

    const account = accounts[0]
    const path = `/${account.bucket}`
    const supabaseRes = await proxyRequest({ account, method: 'DELETE', path, headers: {} })
    metrics.requestsTotal.inc({ method: 'DELETE', operation: 'delete_bucket', status_code: supabaseRes.statusCode })
    return reply.code(204).send()
  })

  // ── POST /:bucket/:key* — Multipart upload ──────────────────────────────────
  fastify.post('/:bucket/*', authHook, async (request, reply) => {
    const { bucket } = request.params
    const objectKey = request.params['*']
    const encodedKey = encodeKey(bucket, objectKey)
    const query = request.query
    const reqId = request.id

    addCorsHeaders(reply)

    // ── Initiate multipart: POST ?uploads ────────────────────────────────────
    if (query.uploads !== undefined) {
      const sizeBytes = parseInt(request.headers['content-length'] ?? '0', 10) || 0
      let account
      try {
        account = selectAccountForUpload(sizeBytes)
      } catch (err) {
        if (err instanceof StorageFullError) {
          sendAlert({ event: 'storage_full', detail: err.message })
          return xmlReply(reply, 507, buildErrorXml('InsufficientStorage', err.message, reqId))
        }
        throw err
      }

      const uploadId = nanoid(20)
      upsertMultipartUpload({
        upload_id:  uploadId,
        account_id: account.account_id,
        bucket,
        object_key: objectKey,
        started_at: Date.now(),
      })

      // Also initiate on Supabase
      const path = `/${account.bucket}/${objectKey}`
      const supabaseRes = await proxyRequest({
        account,
        method:  'POST',
        path,
        query:   { uploads: '' },
        headers: { 'x-forwarded-request-id': reqId },
      })

      metrics.requestsTotal.inc({ method: 'POST', operation: 'create_multipart', status_code: 200 })

      // Return our own uploadId so we track the account mapping
      reply.code(200).header('Content-Type', 'application/xml')
      return reply.send(buildInitiateMultipartUploadResult(bucket, objectKey, uploadId))
    }

    // ── Upload part: PUT ?uploadId=X&partNumber=N ────────────────────────────
    if (query.uploadId && query.partNumber) {
      const mp = getMultipartUpload(query.uploadId)
      if (!mp) {
        return xmlReply(reply, 404, buildErrorXml('NoSuchUpload', 'The specified upload does not exist.', reqId))
      }

      const accounts = getAllActiveAccounts()
      const account = accounts.find(a => a.account_id === mp.account_id)
      if (!account) {
        return xmlReply(reply, 500, buildErrorXml('InternalError', 'Account not found', reqId))
      }

      const path = `/${account.bucket}/${objectKey}`
      const supabaseRes = await proxyRequest({
        account,
        method:     'PUT',
        path,
        query:      { uploadId: query.uploadId, partNumber: query.partNumber },
        headers:    { ...request.headers, 'x-forwarded-request-id': reqId },
        bodyStream: request.raw,
      })

      for (const h of ['etag', 'x-amz-request-id']) {
        const v = supabaseRes.headers[h]
        if (v) reply.header(h, v)
      }

      metrics.requestsTotal.inc({ method: 'POST', operation: 'upload_part', status_code: supabaseRes.statusCode })
      return reply.code(supabaseRes.statusCode).send()
    }

    // ── Complete multipart: POST ?uploadId=X (with XML body) ─────────────────
    if (query.uploadId && !query.partNumber) {
      const mp = getMultipartUpload(query.uploadId)
      if (!mp) {
        return xmlReply(reply, 404, buildErrorXml('NoSuchUpload', 'The specified upload does not exist.', reqId))
      }

      const accounts = getAllActiveAccounts()
      const account = accounts.find(a => a.account_id === mp.account_id)
      if (!account) {
        return xmlReply(reply, 500, buildErrorXml('InternalError', 'Account not found', reqId))
      }

      const path = `/${account.bucket}/${objectKey}`
      const bodyBuf = await request.body  // Fastify parsed as string/buffer

      const supabaseRes = await proxyRequest({
        account,
        method:     'POST',
        path,
        query:      { uploadId: query.uploadId },
        headers:    { 'content-type': 'application/xml', 'x-forwarded-request-id': reqId },
        bodyStream: bodyBuf ? Readable.from(Buffer.from(bodyBuf)) : null,
      })

      const etag = supabaseRes.headers['etag']?.replace(/"/g, '') ?? nanoid(16)
      const location = `${config.PROXY_ENDPOINT ?? ''}/${bucket}/${objectKey}`

      deleteMultipartUpload(query.uploadId)

      // Insert final route
      const now = Date.now()
      upsertRoute({
        encoded_key: encodedKey,
        account_id:  account.account_id,
        bucket,
        object_key:  objectKey,
        size_bytes:  0, // size unknown at complete time
        uploaded_at: now,
        instance_id: config.INSTANCE_ID,
      })
      cacheSet(encodedKey, { accountId: account.account_id, bucket, objectKey, sizeBytes: 0 })

      Promise.resolve().then(() => rtdbSet(`/routes/${encodedKey}`, {
        accountId: account.account_id, bucket, objectKey, sizeBytes: 0, uploadedAt: now, instanceId: config.INSTANCE_ID,
      })).catch(() => {})

      metrics.requestsTotal.inc({ method: 'POST', operation: 'complete_multipart', status_code: 200 })

      reply.code(200).header('Content-Type', 'application/xml')
      return reply.send(buildCompleteMultipartUploadResult(bucket, objectKey, location, etag))
    }

    // ── Abort multipart: DELETE ?uploadId=X ──────────────────────────────────
    return xmlReply(reply, 400, buildErrorXml('InvalidRequest', 'Unknown multipart operation', reqId))
  })

  // ── DELETE /:bucket/:key?uploadId=X — Abort multipart ──────────────────────
  // (handled via DELETE with uploadId query param)
  fastify.addHook('preHandler', async (request, reply) => {
    if (request.method === 'DELETE' && request.query.uploadId) {
      const { bucket } = request.params ?? {}
      const objectKey = request.params?.['*']
      if (bucket && objectKey) {
        const mp = getMultipartUpload(request.query.uploadId)
        if (mp) {
          deleteMultipartUpload(request.query.uploadId)
        }
        addCorsHeaders(reply)
        metrics.requestsTotal.inc({ method: 'DELETE', operation: 'abort_multipart', status_code: 204 })
        reply.code(204).send()
      }
    }
  })
}
