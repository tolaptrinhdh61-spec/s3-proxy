/**
 * src/utils/s3Xml.js
 * Build S3-compatible XML responses.
 *
 * Exported:
 *   buildErrorXml(code, message, requestId)
 *   buildListBucketResult(bucket, objects, options)
 *   buildInitiateMultipartUploadResult(bucket, key, uploadId)
 *   buildCompleteMultipartUploadResult(bucket, key, location, etag)
 *   buildDeleteObjectsResult(deleted, errors)
 */

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>'

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Build S3 error XML.
 * @param {string} code - S3 error code (e.g. 'NoSuchKey')
 * @param {string} message
 * @param {string} requestId
 * @returns {string} XML string
 */
export function buildErrorXml(code, message, requestId = '') {
  return [
    XML_DECLARATION,
    '<Error>',
    `  <Code>${esc(code)}</Code>`,
    `  <Message>${esc(message)}</Message>`,
    `  <RequestId>${esc(requestId)}</RequestId>`,
    `  <HostId>${esc(requestId)}</HostId>`,
    '</Error>',
  ].join('\n')
}

/**
 * Build ListBucketResult XML (ListObjectsV2 response).
 * @param {string} bucket
 * @param {Array<{key: string, size: number, lastModified: Date|string, etag?: string, storageClass?: string}>} objects
 * @param {object} options
 * @param {string} [options.prefix='']
 * @param {string} [options.delimiter='']
 * @param {number} [options.maxKeys=1000]
 * @param {string} [options.continuationToken='']
 * @param {string} [options.nextContinuationToken='']
 * @param {boolean} [options.isTruncated=false]
 * @param {string[]} [options.commonPrefixes=[]]
 * @returns {string} XML string
 */
export function buildListBucketResult(bucket, objects = [], options = {}) {
  const {
    prefix = '',
    delimiter = '',
    maxKeys = 1000,
    continuationToken = '',
    nextContinuationToken = '',
    isTruncated = false,
    commonPrefixes = [],
  } = options

  const contents = objects.map(obj => {
    const lastMod = obj.lastModified
      ? new Date(obj.lastModified).toISOString()
      : new Date().toISOString()
    const etag = obj.etag ? `&quot;${obj.etag.replace(/"/g, '')}&quot;` : ''
    return [
      '  <Contents>',
      `    <Key>${esc(obj.key)}</Key>`,
      `    <LastModified>${lastMod}</LastModified>`,
      etag ? `    <ETag>${etag}</ETag>` : '    <ETag></ETag>',
      `    <Size>${obj.size ?? 0}</Size>`,
      `    <StorageClass>${esc(obj.storageClass ?? 'STANDARD')}</StorageClass>`,
      '  </Contents>',
    ].join('\n')
  }).join('\n')

  const prefixNodes = commonPrefixes.map(p =>
    `  <CommonPrefixes>\n    <Prefix>${esc(p)}</Prefix>\n  </CommonPrefixes>`
  ).join('\n')

  const lines = [
    XML_DECLARATION,
    '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
    `  <Name>${esc(bucket)}</Name>`,
    `  <Prefix>${esc(prefix)}</Prefix>`,
    `  <MaxKeys>${maxKeys}</MaxKeys>`,
    `  <IsTruncated>${isTruncated}</IsTruncated>`,
    `  <KeyCount>${objects.length}</KeyCount>`,
  ]

  if (delimiter) lines.push(`  <Delimiter>${esc(delimiter)}</Delimiter>`)
  if (continuationToken) lines.push(`  <ContinuationToken>${esc(continuationToken)}</ContinuationToken>`)
  if (nextContinuationToken) lines.push(`  <NextContinuationToken>${esc(nextContinuationToken)}</NextContinuationToken>`)
  if (contents) lines.push(contents)
  if (prefixNodes) lines.push(prefixNodes)

  lines.push('</ListBucketResult>')
  return lines.join('\n')
}

/**
 * Build InitiateMultipartUpload XML response.
 */
export function buildInitiateMultipartUploadResult(bucket, key, uploadId) {
  return [
    XML_DECLARATION,
    '<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
    `  <Bucket>${esc(bucket)}</Bucket>`,
    `  <Key>${esc(key)}</Key>`,
    `  <UploadId>${esc(uploadId)}</UploadId>`,
    '</InitiateMultipartUploadResult>',
  ].join('\n')
}

/**
 * Build CompleteMultipartUpload XML response.
 */
export function buildCompleteMultipartUploadResult(bucket, key, location, etag) {
  return [
    XML_DECLARATION,
    '<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
    `  <Location>${esc(location)}</Location>`,
    `  <Bucket>${esc(bucket)}</Bucket>`,
    `  <Key>${esc(key)}</Key>`,
    `  <ETag>&quot;${esc(etag?.replace(/"/g, '') ?? '')}&quot;</ETag>`,
    '</CompleteMultipartUploadResult>',
  ].join('\n')
}

/**
 * Build DeleteObjects result XML.
 */
export function buildDeleteObjectsResult(deleted = [], errors = []) {
  const deletedNodes = deleted.map(k =>
    `  <Deleted>\n    <Key>${esc(k)}</Key>\n  </Deleted>`
  ).join('\n')

  const errorNodes = errors.map(e => [
    '  <Error>',
    `    <Key>${esc(e.key)}</Key>`,
    `    <Code>${esc(e.code)}</Code>`,
    `    <Message>${esc(e.message)}</Message>`,
    '  </Error>',
  ].join('\n')).join('\n')

  return [
    XML_DECLARATION,
    '<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
    deletedNodes,
    errorNodes,
    '</DeleteResult>',
  ].filter(Boolean).join('\n')
}
