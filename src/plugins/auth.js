/**
 * src/plugins/auth.js
 * Fastify plugin: validate x-api-key header on all S3 routes.
 * Returns 403 XML on mismatch.
 *
 * Supports 3 formats:
 *   1. x-api-key: <key>
 *   2. Authorization: Bearer <key>
 *   3. Authorization: AWS4-HMAC-SHA256 Credential=<key>/...  (PocketBase, AWS SDK)
 */

import fp from 'fastify-plugin'
import config from '../config.js'
import { buildErrorXml } from '../utils/s3Xml.js'

function extractApiKey(request) {
  // Format 1: x-api-key header
  const xApiKey = request.headers['x-api-key']
  if (xApiKey) return xApiKey.trim()

  const authHeader = request.headers['authorization']
  if (!authHeader) return null

  // Format 2: Bearer token
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim()
  }

  // Format 3: AWS SigV4 — Authorization: AWS4-HMAC-SHA256 Credential=<accessKeyId>/date/region/s3/aws4_request, ...
  if (authHeader.startsWith('AWS4-HMAC-SHA256')) {
    const credentialMatch = authHeader.match(/Credential=([^/,\s]+)/)
    if (credentialMatch) return credentialMatch[1].trim()
  }

  return null
}

async function authPlugin(fastify, _opts) {
  fastify.decorate('authenticate', async function (request, reply) {
    // Skip auth for routes that opt out
    if (request.routeOptions?.config?.skipAuth) return

    const provided = extractApiKey(request)

    if (provided !== config.PROXY_API_KEY) {
      const reqId = request.id ?? ''
      reply
        .code(403)
        .header('Content-Type', 'application/xml')
        .send(buildErrorXml('AccessDenied', 'Access Denied', reqId))
      return
    }
  })
}

export default fp(authPlugin, { name: 'auth' })
