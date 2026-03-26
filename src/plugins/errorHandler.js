/**
 * src/plugins/errorHandler.js
 * Global Fastify error handler — converts all errors to S3-compatible XML.
 */

import fp from 'fastify-plugin'
import { buildErrorXml } from '../utils/s3Xml.js'

const STATUS_CODE_MAP = {
  400: 'InvalidRequest',
  403: 'AccessDenied',
  404: 'NoSuchKey',
  405: 'MethodNotAllowed',
  409: 'Conflict',
  411: 'MissingContentLength',
  500: 'InternalError',
  501: 'NotImplemented',
  503: 'ServiceUnavailable',
  507: 'InsufficientStorage',
}

function getErrorCode(statusCode, err) {
  // Check if error already has an S3 code
  if (err?.s3Code) return err.s3Code
  return STATUS_CODE_MAP[statusCode] ?? 'InternalError'
}

async function errorHandlerPlugin(fastify, _opts) {
  fastify.setErrorHandler(function (err, request, reply) {
    const statusCode = err.statusCode ?? err.status ?? 500
    const code = getErrorCode(statusCode, err)
    const message = err.message ?? 'An internal error occurred'
    const requestId = request.id ?? ''

    request.log?.error({ err, statusCode, code }, 'request error')

    reply
      .code(statusCode)
      .header('Content-Type', 'application/xml')
      .send(buildErrorXml(code, message, requestId))
  })

  // Handle 404 not found
  fastify.setNotFoundHandler(function (request, reply) {
    const requestId = request.id ?? ''
    reply
      .code(404)
      .header('Content-Type', 'application/xml')
      .send(buildErrorXml('NoSuchKey', `The specified key does not exist.`, requestId))
  })
}

export default fp(errorHandlerPlugin, { name: 'errorHandler' })
