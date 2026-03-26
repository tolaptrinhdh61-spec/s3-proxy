/**
 * src/plugins/auth.js
 * Fastify plugin: validate x-api-key header on all S3 routes.
 * Returns 403 XML on mismatch.
 */

import fp from 'fastify-plugin'
import config from '../config.js'
import { buildErrorXml } from '../utils/s3Xml.js'

async function authPlugin(fastify, _opts) {
  fastify.decorate('authenticate', async function (request, reply) {
    const apiKey = request.headers['x-api-key'] || request.headers['authorization']

    // Support both x-api-key and Authorization: Bearer <key>
    let provided = apiKey
    if (provided && provided.toLowerCase().startsWith('bearer ')) {
      provided = provided.slice(7).trim()
    }

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
