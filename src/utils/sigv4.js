/**
 * src/utils/sigv4.js
 * Re-sign outgoing S3 requests to Supabase using AWS Signature V4.
 * Uses @aws-sdk/signature-v4 + @smithy/protocol-http.
 * All outgoing HTTP via undici (built-in Node 20).
 *
 * Exported:
 *   resignRequest(options) → { url, headers }
 *   proxyRequest(options)  → undici response (stream)
 */

import { SignatureV4 } from '@aws-sdk/signature-v4'
import { HttpRequest } from '@smithy/protocol-http'
import { Sha256 } from '@aws-crypto/sha256-js'
import { request as undiciRequest } from 'undici'

// Headers that must be stripped from incoming client request before re-signing
const STRIP_HEADERS = new Set([
  'authorization',
  'x-amz-security-token',
  'x-amz-date',
  'x-amz-content-sha256',
  'x-amz-credential',
  'x-amz-algorithm',
  'x-amz-signature',
  'x-amz-signed-headers',
  'host',
  'connection',
  'transfer-encoding',
  'expect',
])

/**
 * Re-sign an S3 request for a specific account.
 *
 * @param {object} options
 * @param {object} options.account        - { access_key_id, secret_key, endpoint, region, bucket }
 * @param {string} options.method         - HTTP method
 * @param {string} options.path           - URL path (e.g. '/bucket/key')
 * @param {object} [options.query]        - query string params as object
 * @param {object} [options.headers]      - incoming headers (will be stripped of AWS auth)
 * @param {Buffer|Uint8Array|null} [options.body] - body for signing (optional, used for hash)
 * @returns {Promise<{ url: string, headers: object }>}
 */
export async function resignRequest({ account, method, path, query = {}, headers = {}, body = null }) {
  // Parse endpoint to get hostname
  const endpointUrl = new URL(account.endpoint)

  // Build clean headers (strip AWS auth headers, keep relevant ones)
  const cleanHeaders = {}
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase()
    if (!STRIP_HEADERS.has(lower)) {
      cleanHeaders[lower] = v
    }
  }
  cleanHeaders['host'] = endpointUrl.host

  // Build query string
  const queryParams = {}
  for (const [k, v] of Object.entries(query)) {
    queryParams[k] = v
  }

  // Build the HttpRequest
  const httpRequest = new HttpRequest({
    method: method.toUpperCase(),
    protocol: endpointUrl.protocol,
    hostname: endpointUrl.hostname,
    port: endpointUrl.port ? parseInt(endpointUrl.port, 10) : undefined,
    path,
    query: queryParams,
    headers: cleanHeaders,
    body,
  })

  // Sign
  const signer = new SignatureV4({
    credentials: {
      accessKeyId:     account.access_key_id,
      secretAccessKey: account.secret_key,
    },
    region:  account.region || 'auto',
    service: 's3',
    sha256:  Sha256,
  })

  const signed = await signer.sign(httpRequest)

  // Build final URL
  const queryStr = Object.entries(signed.query ?? {})
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')

  const url = `${endpointUrl.protocol}//${endpointUrl.host}${path}${queryStr ? '?' + queryStr : ''}`

  return { url, headers: signed.headers }
}

/**
 * Make an outgoing request to Supabase using undici, with re-signed headers.
 * Returns the raw undici response (with body as a stream).
 *
 * @param {object} options
 * @param {object} options.account
 * @param {string} options.method
 * @param {string} options.path
 * @param {object} [options.query]
 * @param {object} [options.headers]
 * @param {import('stream').Readable|Buffer|null} [options.bodyStream] - for PUT/POST
 * @returns {Promise<import('undici').Dispatcher.ResponseData>}
 */
export async function proxyRequest({ account, method, path, query = {}, headers = {}, bodyStream = null }) {
  // For signing, we don't buffer the body — use UNSIGNED-PAYLOAD for streaming
  const headersForSign = { ...headers }

  // Use unsigned payload for streaming PUTs to avoid buffering
  if (bodyStream && (method === 'PUT' || method === 'POST')) {
    headersForSign['x-amz-content-sha256'] = 'UNSIGNED-PAYLOAD'
  }

  const { url, headers: signedHeaders } = await resignRequest({
    account,
    method,
    path,
    query,
    headers: headersForSign,
    body: null,
  })

  // Override with unsigned payload header if streaming
  if (bodyStream && (method === 'PUT' || method === 'POST')) {
    signedHeaders['x-amz-content-sha256'] = 'UNSIGNED-PAYLOAD'
  }

  const requestOptions = {
    method: method.toUpperCase(),
    headers: signedHeaders,
  }

  if (bodyStream) {
    requestOptions.body = bodyStream
  }

  return undiciRequest(url, requestOptions)
}
