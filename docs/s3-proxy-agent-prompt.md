# Agent Prompt: Build S3 Multi-Account Proxy with Firebase RTDB

ROLE

You are a senior Node.js engineer. Build a production-ready S3-compatible proxy from scratch. Follow every specification exactly. Do not ask clarifying questions. Do not skip any section. Implement everything completely — no TODOs, no placeholders.

PROJECT OVERVIEW

Build a single Node.js service (s3-proxy) that:

Exposes an S3-compatible HTTP API (AWS S3 path-style)
Pools 20+ Supabase S3 accounts behind one endpoint
Routes PUT to the least-used account under quota threshold
Routes GET/DELETE/HEAD by looking up which account holds the file
Persists routing table in local SQLite, synced bidirectionally with Firebase RTDB
Supports multiple concurrent instances (horizontal scaling / HA) via RTDB realtime listener
Runs standalone (node src/index.js) or in Docker Compose
TECH STACK
Concern Choice
Runtime Node.js 20 LTS
HTTP framework Fastify v4 (no Express)
Language Plain JavaScript (ES modules, .js)
S3 signing @aws-sdk/signature-v4 + @aws-sdk/client-s3
Local DB better-sqlite3 (synchronous, WAL mode)
In-memory cache lru-cache v10 (10 000 entries, ttl 5 min)
Firebase firebase-admin SDK (RTDB)
Logging pino + pino-pretty (dev only)
Metrics prom-client (Prometheus)
Package manager pnpm
DIRECTORY STRUCTURE

Generate exactly this layout — no extra files:

s3-proxy/
├── src/
│ ├── index.js # Fastify server bootstrap
│ ├── config.js # All env vars, validated at startup
│ ├── firebase.js # Firebase Admin init + RTDB helpers
│ ├── db.js # SQLite init, migrations, all queries
│ ├── cache.js # LRU cache wrapper (key → accountId)
│ ├── accountPool.js # Account selection, quota tracking
│ ├── quotaPoller.js # Periodic Supabase storage stats poll
│ ├── routes/
│ │ ├── s3.js # All S3 route handlers
│ │ ├── health.js # GET /health
│ │ └── metrics.js # GET /metrics
│ ├── plugins/
│ │ ├── auth.js # API key validation (Fastify plugin)
│ │ └── errorHandler.js # Global error → S3 XML error response
│ └── utils/
│ ├── s3Xml.js # S3 XML response builders
│ ├── sigv4.js # Re-sign outgoing requests to Supabase
│ └── retry.js # Exponential backoff + fallback logic
├── data/ # Gitignored, SQLite files live here
├── database.rules.json # Firebase RTDB security rules + indexes
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── .gitignore
└── package.json

1. ENVIRONMENT VARIABLES (src/config.js + .env.example)

Validate all vars at startup using manual checks. Throw a descriptive error and exit(1) if any required var is missing.

# Required

PROXY_API_KEY= # Client auth key (x-api-key header)
FIREBASE_RTDB_URL= # https://<project>.firebaseio.com
FIREBASE_DB_SECRET= # Legacy RTDB secret token

# Optional with defaults

PORT=3000
QUOTA_THRESHOLD=0.90 # Switch account at this fraction (0.0–1.0)
QUOTA_POLL_INTERVAL_MS=300000 # Poll Supabase storage API every 5 min
RTDB_SYNC_BATCH_SIZE=400 # Max writes/s to RTDB on startup
DRAIN_TIMEOUT_MS=30000 # Graceful shutdown drain window
LOG_LEVEL=info # pino log level
WEBHOOK_ALERT_URL= # POST on critical errors (optional)
INSTANCE_ID= # Auto-generated if not set: hostname-PID-4hexchars
SQLITE_PATH=./data/routes.db
LRU_MAX=10000
LRU_TTL_MS=300000

Export a frozen config object. Do not read process.env anywhere else in the codebase.

2. FIREBASE RTDB SCHEMA + RULES (database.rules.json)
   Data layout
   /accounts/{accountId}
   accessKeyId: string
   secretAccessKey: string
   endpoint: string # https://xxx.supabase.co/storage/v1/s3
   region: string
   bucket: string
   quotaBytes: number # total capacity in bytes
   usedBytes: number # tracked by proxy, updated on every upload
   active: boolean
   addedAt: number # Unix ms

/routes/{encodedKey} # encodedKey = base64url(bucket + "/" + objectKey)
accountId: string
bucket: string
objectKey: string
sizeBytes: number
uploadedAt: number # Unix ms
instanceId: string # which proxy instance wrote this

/instances/{instanceId}
startedAt: number
lastHeartbeat: number
healthy: boolean
database.rules.json
{
"rules": {
"accounts": {
".read": "auth != null",
".write": "auth != null",
"$accountId": {
        ".indexOn": ["active", "usedBytes", "addedAt"]
      }
    },
    "routes": {
      ".read": "auth != null",
      ".write": "auth != null",
      "$encodedKey": {
".indexOn": ["accountId", "bucket", "uploadedAt"]
}
},
"instances": {
".read": "auth != null",
".write": "auth != null"
}
}
} 3. FIREBASE INIT (src/firebase.js)
Initialize firebase-admin using FIREBASE_DB_SECRET via credential.cert workaround:
// Use legacy secret via custom token approach:
// Pass databaseAuthVariableOverride: null to get full read/write as admin
admin.initializeApp({
databaseURL: config.FIREBASE_RTDB_URL,
databaseAuthVariableOverride: null // bypass rules, admin access
});
// Authenticate REST calls via ?auth=<secret> query param on RTDB REST API
// Use firebase-admin SDK directly — it accepts RTDB secret as credential
Actually: use firebase-admin with cert from a JSON built from the secret:
// Since only RTDB secret is available (not service account JSON),
// use the RTDB REST API directly with ?auth=SECRET for all operations.
// Do NOT use firebase-admin SDK in this case.
// Implement all RTDB operations as plain fetch() calls to:
// GET ${FIREBASE_RTDB_URL}/path.json?auth=${FIREBASE_DB_SECRET}
// PUT ${FIREBASE_RTDB_URL}/path.json?auth=${FIREBASE_DB_SECRET}
// PATCH ${FIREBASE_RTDB_URL}/path.json?auth=${FIREBASE_DB_SECRET}
// DELETE ${FIREBASE_RTDB_URL}/path.json?auth=${FIREBASE_DB_SECRET}
// For realtime listener: use EventSource (SSE) on:
// GET ${FIREBASE_RTDB_URL}/path.json?auth=${SECRET}&accept=text/event-stream
// Use the 'eventsource' npm package for SSE in Node.js

Export these functions:

rtdbGet(path) → parsed JSON or null
rtdbSet(path, value) → void
rtdbPatch(path, value) → void
rtdbDelete(path) → void
rtdbPush(path, value) → generated key string
rtdbListen(path, onData, onError) → returns { close() } — uses SSE EventSource
rtdbBatchPatch(updates) → single PATCH to root with multi-path object (max RTDB_SYNC_BATCH_SIZE entries per call, auto-chunk if larger) 4. SQLite (src/db.js)
Init
import Database from 'better-sqlite3'
const db = new Database(config.SQLITE_PATH)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
db.pragma('cache_size = -64000') // 64 MB
db.pragma('foreign_keys = ON')
Schema (run on every startup — idempotent)
CREATE TABLE IF NOT EXISTS accounts (
account_id TEXT PRIMARY KEY,
access_key_id TEXT NOT NULL,
secret_key TEXT NOT NULL,
endpoint TEXT NOT NULL,
region TEXT NOT NULL,
bucket TEXT NOT NULL,
quota_bytes INTEGER NOT NULL DEFAULT 5368709120, -- 5 GB default
used_bytes INTEGER NOT NULL DEFAULT 0,
active INTEGER NOT NULL DEFAULT 1,
added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS routes (
encoded_key TEXT PRIMARY KEY,
account_id TEXT NOT NULL REFERENCES accounts(account_id),
bucket TEXT NOT NULL,
object_key TEXT NOT NULL,
size_bytes INTEGER NOT NULL DEFAULT 0,
uploaded_at INTEGER NOT NULL,
instance_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_routes_account ON routes(account_id);
CREATE INDEX IF NOT EXISTS idx_routes_bucket ON routes(bucket);
CREATE INDEX IF NOT EXISTS idx_routes_uploaded ON routes(uploaded_at);
CREATE INDEX IF NOT EXISTS idx_accounts_active ON accounts(active, used_bytes);
Exported functions
// Accounts
upsertAccount(account) // INSERT OR REPLACE
getAllActiveAccounts() // SELECT WHERE active=1 ORDER BY used_bytes ASC
updateUsedBytes(accountId, delta) // UPDATE used_bytes = used_bytes + delta
setUsedBytesAbsolute(accountId, bytes)

// Routes
upsertRoute(route) // INSERT OR REPLACE
getRoute(encodedKey) // returns row or undefined
deleteRoute(encodedKey)
getAllRoutes() // used at startup for RTDB push
countRoutes() 5. IN-MEMORY LRU CACHE (src/cache.js)

Wrap lru-cache. Key = encodedKey, Value = { accountId, bucket, objectKey, sizeBytes }.

export function cacheGet(encodedKey)
export function cacheSet(encodedKey, value)
export function cacheDelete(encodedKey)
export function cacheClear()

Lookup order for every GET/DELETE/HEAD:

LRU cache → hit → use immediately
SQLite getRoute() → hit → populate cache → use
RTDB rtdbGet('/routes/' + encodedKey) → hit → upsert SQLite → populate cache → use
All miss → 404 6. ACCOUNT POOL (src/accountPool.js)
Startup
Load all accounts from SQLite into memory as Map<accountId, account>.
Sort by usedBytes ASC → activeAccounts array.
currentAccountIndex = 0 (points to least-used active account).
selectAccountForUpload(sizeBytes)
for each account in activeAccounts (sorted least-used first):
projected = (account.usedBytes + sizeBytes) / account.quotaBytes
if projected < QUOTA_THRESHOLD:
return account
throw StorageFullError
recordUpload(accountId, sizeBytes)
updateUsedBytes(accountId, +sizeBytes) in SQLite
Update in-memory map
Re-sort activeAccounts
RTDB rtdbPatch('/accounts/' + accountId, { usedBytes: newTotal })
recordDelete(accountId, sizeBytes)

Same as above with -sizeBytes.

reloadAccountsFromRTDB()
Called at startup AND when all accounts full AND on RTDB /accounts change event
Fetches all accounts from RTDB, upserts into SQLite, rebuilds in-memory map
StorageFullError

Custom error class. When thrown:

Log as error with pino
POST to WEBHOOK_ALERT_URL if set (fire-and-forget, don’t await in request path)
Auto-call reloadAccountsFromRTDB() async to check for newly added accounts
Return HTTP 507 with S3 XML error body: <Code>InsufficientStorage</Code> 7. QUOTA POLLER (src/quotaPoller.js)

Poll every QUOTA_POLL_INTERVAL_MS. For each active account:

GET https://{supabase-endpoint}/storage/v1/bucket
Headers: Authorization: Bearer {service_role_key} -- if available, else skip

Since Supabase S3 doesn’t expose a simple “used bytes” API, implement this strategy:

Use S3Client.send(new ListObjectsV2Command({ Bucket, MaxKeys: 1000 })) to list objects
Sum Size fields → compare against stored usedBytes
If difference > 5% → call setUsedBytesAbsolute(accountId, polledBytes)
Log discrepancy at warn level

This runs in background. Any error in poller must be caught and logged — never crash the process.

8. STARTUP SYNC (src/index.js — before server starts listening)

Execute in this exact order — await each step before proceeding:

1. Validate config (exit 1 on error)
2. Init SQLite (create tables)
3. Connect RTDB (test GET /accounts.json — if fail, log warn but continue)
4. reloadAccountsFromRTDB() // pull accounts → SQLite
5. Pull all /routes from RTDB // chunk by 1000 if large
6. Upsert all pulled routes into SQLite (use transaction for speed)
7. Warm LRU cache with top 10 000 most-recent routes from SQLite
8. Register RTDB realtime listener on /routes (onChildAdded, onChildChanged, onChildRemoved)
9. Register RTDB realtime listener on /accounts (onValue — reload full accounts on any change)
10. Start Fastify server on PORT
11. Register instance heartbeat (PATCH /instances/{INSTANCE_ID} every 30s)
12. Start quota poller

Log each step with pino at info level. If RTDB is unreachable at step 3, continue with local SQLite data and log a warn.

9. RTDB REALTIME LISTENERS
   Routes listener (/routes)

Use SSE EventSource on /routes.json?auth=SECRET&accept=text/event-stream.

Parse SSE events:

put event with path / → full replace → clear SQLite routes table, re-insert all, clear LRU
put event with path /{encodedKey} → upsert single route in SQLite + LRU
patch event → upsert each key in SQLite + LRU
Data null means deleted → delete from SQLite + LRU
Accounts listener (/accounts)

On any change → call reloadAccountsFromRTDB() (debounce 2 s to avoid thundering herd).

Reconnect logic

Both listeners must auto-reconnect on error with exponential backoff (1s, 2s, 4s, 8s, max 60s). Log each reconnect attempt.

10. S3 ROUTE HANDLERS (src/routes/s3.js)

Register all routes with Fastify. Disable Fastify’s default body parsing for raw binary routes.

Auth (applied to all routes via preHandler hook)
Check header: x-api-key === config.PROXY_API_KEY
On mismatch → 403 XML: <Code>AccessDenied</Code>
Supported operations
Method Path Operation
PUT /:bucket/:key* Upload object
GET /:bucket/:key* Download object
HEAD /:bucket/:key* Object metadata
DELETE /:bucket/:key* Delete object
GET /:bucket List objects (ListObjectsV2)
PUT /:bucket Create bucket (passthrough to first active account)
DELETE /:bucket Delete bucket (passthrough)
POST /:bucket/:key\* Multipart upload (CreateMultipartUpload, UploadPart, CompleteMultipartUpload, AbortMultipartUpload) — detect by query params
PUT (upload) — exact flow

1. Parse bucket + key from params → encodedKey = base64url(bucket/key)
2. selectAccountForUpload(contentLength || 0)
3. Re-sign request with account credentials using sigv4.js
4. Pipe request body directly to Supabase (no buffering) using undici pipeline or node-fetch stream
5. On Supabase 5xx → retry up to 3 times with exponential backoff (100ms, 200ms, 400ms)
   If all 3 retries fail → fallback: selectAccountForUpload() excluding failed account → retry once
6. On success:
   a. upsertRoute({ encodedKey, accountId, bucket, objectKey: key, sizeBytes, uploadedAt, instanceId })
   b. cacheSet(encodedKey, { accountId, bucket, objectKey: key, sizeBytes })
   c. recordUpload(accountId, sizeBytes)
   d. RTDB: rtdbSet('/routes/' + encodedKey, routeObject) ← triggers other instances via listener
7. Return Supabase response headers + status verbatim

Content-Length: if not provided by client, stream without Content-Length (chunked transfer).

GET (download) — exact flow

1. encodedKey = base64url(bucket/key)
2. Lookup: cache → SQLite → RTDB (fallback chain from section 5)
3. If not found → 404 XML: <Code>NoSuchKey</Code>
4. Re-sign GET request with account credentials
5. Pipe Supabase response stream directly to client (no buffering)
6. Forward all headers from Supabase verbatim (Content-Type, ETag, Last-Modified, etc.)
   DELETE — exact flow
7. Lookup route (same fallback chain)
8. Re-sign DELETE to correct account
9. On success:
   a. deleteRoute(encodedKey) from SQLite
   b. cacheDelete(encodedKey)
   c. recordDelete(accountId, sizeBytes)
   d. rtdbDelete('/routes/' + encodedKey)
10. Return 204
    HEAD — same as GET but no body, return headers only
    LIST (GET /:bucket) — passthrough to first active account
    Multipart upload

Detect by query params:

?uploads → CreateMultipartUpload
?uploadId=X&partNumber=N → UploadPart
?uploadId=X + POST body with <CompleteMultipartUpload> → CompleteMultipartUpload
?uploadId=X + DELETE → AbortMultipartUpload

For multipart: store uploadId → accountId mapping in SQLite:

CREATE TABLE IF NOT EXISTS multipart_uploads (
upload_id TEXT PRIMARY KEY,
account_id TEXT NOT NULL,
bucket TEXT NOT NULL,
object_key TEXT NOT NULL,
started_at INTEGER NOT NULL
);

On Complete → insert final route + recordUpload.

11. REQUEST RE-SIGNING (src/utils/sigv4.js)

Use @aws-sdk/signature-v4 and @smithy/protocol-http.

export async function resignRequest({ originalRequest, account, method, path, query, headers, body })
Strip incoming AWS auth headers (Authorization, X-Amz-\*)
Build new HttpRequest targeting account.endpoint
Sign with account.accessKeyId + account.secretAccessKey + account.region + service s3
Return signed headers to attach to outgoing fetch/undici request
Use undici (built into Node 20) for all outgoing HTTP — not node-fetch, not axios 12. RETRY UTILITY (src/utils/retry.js)
export async function withRetry(fn, { maxAttempts = 3, baseDelayMs = 100, onRetry } = {})
Exponential backoff: attempt 1 → 100ms, attempt 2 → 200ms, attempt 3 → 400ms
Only retry on 5xx status or network errors (ECONNRESET, ETIMEDOUT, ENOTFOUND)
Do NOT retry on 4xx
Call onRetry(attempt, error) before each retry (used for logging) 13. HEALTH ENDPOINT (src/routes/health.js)

GET /health — no auth required

Response (always 200 unless RTDB and SQLite both dead → 503):

{
"status": "ok",
"instanceId": "...",
"uptime": 123.4,
"accounts": {
"total": 22,
"active": 20,
"full": 2
},
"routes": {
"sqliteCount": 150000,
"cacheSize": 10000
},
"rtdb": {
"connected": true,
"listenerActive": true
},
"quota": {
"totalBytes": 107374182400,
"usedBytes": 53687091200,
"percentUsed": 50.0
}
} 14. METRICS ENDPOINT (src/routes/metrics.js)

GET /metrics — no auth required — Prometheus text format

Track these counters/gauges with prom-client:

s3proxy_requests_total{method, operation, status_code}
s3proxy_upload_bytes_total{account_id}
s3proxy_download_bytes_total{account_id}
s3proxy_account_used_bytes{account_id}
s3proxy_account_quota_bytes{account_id}
s3proxy_rtdb_sync_lag_ms (gauge — time since last RTDB event)
s3proxy_cache_hits_total
s3proxy_cache_misses_total
s3proxy_retry_total{operation}
s3proxy_fallback_total{reason} 15. ERROR HANDLER (src/plugins/errorHandler.js)

All errors must return S3-compatible XML:

<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>InternalError</Code>
  <Message>...</Message>
  <RequestId>...</RequestId>
</Error>

Map errors:

404 → NoSuchKey
403 → AccessDenied
507 → InsufficientStorage
400 → InvalidRequest
5xx → InternalError

Set Content-Type: application/xml on all error responses.

16. GRACEFUL SHUTDOWN
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)

async function shutdown() {
log.info('Shutting down...')
await fastify.close() // stop accepting new requests
// Fastify drains in-flight requests up to DRAIN_TIMEOUT_MS
stopQuotaPoller()
closeRTDBListeners()
db.close()
await rtdbPatch('/instances/' + INSTANCE_ID, { healthy: false })
process.exit(0)
}

Fastify’s close() with closeGrace plugin handles the drain. Install @fastify/close-grace and configure delay: config.DRAIN_TIMEOUT_MS.

17. WEBHOOK ALERT (src/utils/webhook.js)
    export function sendAlert(payload) // fire-and-forget, never throws

POST to WEBHOOK_ALERT_URL with body:

{
"instanceId": "...",
"timestamp": "ISO8601",
"level": "critical",
"event": "storage_full | rtdb_disconnect | supabase_error",
"detail": "..."
}

Timeout: 5 seconds. No retry on alert failure.

18. DOCKERFILE
    FROM node:20-alpine AS base
    RUN npm install -g pnpm
    WORKDIR /app
    COPY package.json pnpm-lock.yaml ./
    RUN pnpm install --frozen-lockfile --prod
    COPY src/ ./src/

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s \
 CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/index.js"] 19. DOCKER COMPOSE (docker-compose.yml)
version: '3.9'

x-proxy-common: &proxy-common
build: .
restart: unless-stopped
env_file: .env
volumes: - proxy-data:/app/data # shared SQLite volume across replicas
networks: - proxy-net

services:
proxy-1:
<<: \*proxy-common
environment:
INSTANCE_ID: proxy-1
ports: - "3001:3000"

proxy-2:
<<: \*proxy-common
environment:
INSTANCE_ID: proxy-2
ports: - "3002:3000"

proxy-3:
<<: \*proxy-common
environment:
INSTANCE_ID: proxy-3
ports: - "3003:3000"

volumes:
proxy-data:

networks:
proxy-net:

Note: All replicas share one SQLite file via Docker volume. better-sqlite3 with WAL mode supports concurrent readers + one writer safely.

20. package.json
    {
    "name": "s3-proxy",
    "version": "1.0.0",
    "type": "module",
    "engines": { "node": ">=20.0.0" },
    "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js"
    },
    "dependencies": {
    "@aws-sdk/client-s3": "^3",
    "@aws-sdk/signature-v4": "^3",
    "@smithy/protocol-http": "^3",
    "@fastify/close-grace": "^1",
    "@fastify/rate-limit": "^9",
    "better-sqlite3": "^9",
    "eventsource": "^2",
    "fastify": "^4",
    "lru-cache": "^10",
    "pino": "^8",
    "pino-pretty": "^11",
    "prom-client": "^15",
    "undici": "^6"
    }
    }
21. .gitignore
    node*modules/
    data/
    .env
    *.db
    \_.db-shm
    \*.db-wal
    dist/
22. IMPLEMENTATION CONSTRAINTS
    No buffering of file bodies — all PUT/GET must use Node.js streams / undici pipeline. Never load file content into memory.
    All RTDB writes are fire-and-forget in the request path — do not await RTDB writes inside PUT handler. Use Promise.resolve().then(() => rtdbSet(...)) to push off the event loop.
    SQLite writes ARE synchronous — better-sqlite3 is sync by design. Route writes happen inline before returning response.
    LRU cache is per-process — each instance has its own LRU. RTDB realtime listener keeps them consistent.
    Account credentials never logged — mask secretAccessKey in all log output.
    All unhandled promise rejections must be caught: process.on('unhandledRejection', ...) → log + send alert.
    Request IDs — generate X-Request-Id (nanoid 10 chars) for every request, attach to pino child logger, forward to Supabase as X-Forwarded-Request-Id.
    Content-Type passthrough — never override Content-Type from client on PUT, or from Supabase on GET.
    ETag passthrough — forward Supabase ETag verbatim on GET and HEAD.
    CORS — add Access-Control-Allow-Origin: \* and standard CORS headers. Handle OPTIONS preflight.
23. POCKETBASE COMPATIBILITY NOTE

PocketBase S3 config expects:

Endpoint: http://localhost:3000 (or whatever the proxy runs on)
Bucket: any single bucket name (proxy transparently distributes across accounts)
Access Key: value of PROXY_API_KEY (proxy will validate this as API key)
Secret: any non-empty string (proxy ignores it, only checks x-api-key header)
Region: auto

Document this in a README.md (generate it too).

24. README.md

Generate a complete README with:

Architecture diagram (ASCII)
Quick start (standalone Node)
Quick start (Docker Compose)
All env vars table with descriptions and defaults
How to add a new Supabase account (RTDB JSON example)
How PocketBase connects to this proxy
Health check response explained
Metrics list
FINAL INSTRUCTION

Implement ALL files completely. Start with package.json, then src/config.js, src/firebase.js, src/db.js, src/cache.js, src/accountPool.js, src/utils/, src/plugins/, src/routes/, src/index.js, then config files.

Write complete, runnable code — no // TODO, no // implement this, no stub functions. Every function must have a full implementation.

After all files, output a short “Setup checklist” with the exact commands to run from zero to first request.

# PROJECT AGENT — OPUSHFORCE RULE

---

## PHẦN 1 — ĐỌC CONTEXT TRƯỚC KHI LÀM (BẮT BUỘC)

Trước mỗi task, thực hiện tuần tự:

1. **Scan directory tree** toàn bộ project (không đoán cấu trúc từ tên).
2. Đọc các file tài liệu nếu tồn tại:
   - `README.md` → tổng quan dự án
   - `CHANGE_LOGS.md` → lịch sử thay đổi gần nhất
   - `CHANGE_LOGS_USER.md` → lịch sử yêu cầu user
3. Nếu user paste error/stack trace → đọc stack trace trước, xác định file liên quan, rồi mới đọc code.
4. Nếu chưa rõ yêu cầu → hỏi đúng 1 câu ngắn trước khi làm.

---

## PHẦN 2 — THỰC HIỆN TASK

Thực hiện đúng yêu cầu. Không refactor ngoài phạm vi yêu cầu.

### Ràng buộc kỹ thuật theo loại dự án

| Loại    | Dấu hiệu                   | Ràng buộc                                                         |
| ------- | -------------------------- | ----------------------------------------------------------------- |
| .NET/C# | `*.csproj`, `*.sln`        | Chỉ dùng .NET 4.5/4.6; cập nhật `.csproj` khi thêm/xóa file       |
| Node.js | `package.json`             | Giữ nguyên Node version; nhắc chạy `npm install` khi thêm package |
| Python  | `*.py`, `requirements.txt` | Giữ nguyên Python version; cập nhật `requirements.txt`            |

### Quy tắc quote string (TRÁNH LỖI BUILD)

- **KHÔNG dùng** dấu `"` lồng nhau trong string mà không escape đúng.
- Ưu tiên dùng **single quote** `'` cho string nội bộ bên trong **double quote** `"` (hoặc ngược lại tùy ngôn ngữ).
- Với C#: dùng `@"..."` (verbatim string) hoặc `$"..."` (interpolated) — không mix lồng nhau tuỳ tiện.
- Với JS/TS: ưu tiên template literal `` `...` `` thay vì concat bằng `+` khi có biến.
- Với Shell/Bash (dùng trong cả Windows & Linux): tránh `'` bên trong `'...'`; escape bằng `'\''` hoặc dùng `"..."` bao ngoài.
- Với Python: dùng `"""..."""` cho multiline; không mix `'` và `"` lồng nhau.
- Trước khi viết bất kỳ string nào có ký tự đặc biệt → **kiểm tra tính tương thích Windows & Linux**.

---

## PHẦN 3 — GHI NHẬN SAU MỖI TASK (BẮT BUỘC, KHÔNG BỎ QUA)

### 3a. File `.opushforce.message`

Tạo hoặc ghi đè file `.opushforce.message` ở root project với nội dung:

```
[YYYY-MM-DD HH:MM] (type): mô tả ngắn gọn

- chi tiết thay đổi 1
- chi tiết thay đổi 2
```

**type** dùng một trong các nhãn sau:

- `feat` — tính năng mới
- `fix` — sửa lỗi
- `refactor` — tái cấu trúc code
- `docs` — cập nhật tài liệu
- `chore` — việc vặt, config, dependency
- `style` — chỉnh style/format không ảnh hưởng logic
- `perf` — cải thiện hiệu năng

Ví dụ:

```
[2025-06-15 14:30] (feat): thêm tính năng xuất báo cáo PDF

- Thêm class PdfExporter vào module Reports
- Cập nhật menu để có nút "Xuất PDF"
- Cập nhật PdfExporter.csproj
```

---

### 3b. File `CHANGE_LOGS.md` — Nhật ký thay đổi kỹ thuật

- Nếu file **đã tồn tại** → **append entry mới lên ĐẦU file** (giữ nguyên nội dung cũ bên dưới).
- Nếu file **chưa tồn tại** → tạo mới.

Format entry:

```markdown
## [YYYY-MM-DD HH:MM] — Tên tính năng / Tên fix

**Loại:** feat | fix | refactor | docs | chore  
**Tóm tắt yêu cầu:** Mô tả ngắn gọn yêu cầu ban đầu  
**Nội dung thay đổi:**

- File `path/to/file.cs`: thay đổi gì
- File `path/to/other.js`: thay đổi gì

**Ghi chú kỹ thuật:** (nếu có) Lý do kỹ thuật, cảnh báo, dependency mới

---
```

---

### 3c. File `CHANGE_LOGS_USER.md` — Nhật ký yêu cầu của user

- Nếu file **đã tồn tại** → **append entry mới lên ĐẦU file**.
- Nếu file **chưa tồn tại** → tạo mới.

Format entry:

```markdown
## [YYYY-MM-DD HH:MM] — Tóm tắt yêu cầu

**Yêu cầu gốc của user:** Trích dẫn hoặc paraphrase yêu cầu  
**Kết quả thực hiện:** Đã làm gì, file nào thay đổi  
**Trạng thái:** ✅ Hoàn thành | ⚠️ Hoàn thành một phần | ❌ Chưa làm

---
```

---

## PHẦN 4 — ĐÓNG GÓI ZIP (khi có thay đổi code)

### Đặt tên file ZIP

```
<tên-project>_<YYYYMMDD>_<HHmm>_<nội-dung-ngắn>.zip
```

Ví dụ:

```
opushforce_20250615_1430_feat-export-pdf.zip
opushforce_20250615_0900_fix-null-login.zip
```

### Nội dung ZIP phải bao gồm

- Tất cả **file đã thay đổi** trong task này
- Tất cả **file src hiện có** (để giải nén chép đè là chạy được ngay)
- Các file ghi nhận: `.opushforce.message`, `CHANGE_LOGS.md`, `CHANGE_LOGS_USER.md`

### Không đưa vào ZIP

- `.git/`, `bin/`, `obj/`, `node_modules/`, `__pycache__/`, `*.user`, file tạm, file build artifact

### Quy tắc kỹ thuật khi tạo ZIP (quan trọng — tránh lỗi)

1. **Tránh ký tự `{` và `}` trong tên file/thư mục** bên trong ZIP — gây lỗi trên một số hệ thống.
2. Cấu trúc thư mục bên trong ZIP **phải khớp với cấu trúc project gốc** — giải nén ra → chép đè vào src là xong, không phải di chuyển thêm.
3. Dùng **relative path** trong ZIP (không dùng absolute path).
4. Với Python (`zipfile`): luôn dùng `arcname` để kiểm soát path bên trong ZIP.

Ví dụ Python an toàn:

```python
import zipfile, os
from pathlib import Path

project_root = Path("/home/claude/project")
output_zip = Path("/mnt/user-data/outputs/opushforce_20250615_1430_feat-export-pdf.zip")

exclude_dirs = {".git", "bin", "obj", "node_modules", "__pycache__"}

with zipfile.ZipFile(output_zip, "w", zipfile.ZIP_DEFLATED) as zf:
    for file_path in project_root.rglob("*"):
        # Bỏ qua thư mục excluded
        if any(part in exclude_dirs for part in file_path.parts):
            continue
        if file_path.is_file():
            arcname = file_path.relative_to(project_root)
            # Tránh ký tự đặc biệt trong tên
            safe_name = str(arcname).replace("{", "").replace("}", "")
            zf.write(file_path, safe_name)
```

---

## PHẦN 5 — CHECKLIST TRƯỚC KHI BÁO "XONG"

Tự kiểm tra trước khi kết thúc:

- [ ] Đã đọc đủ context trước khi làm
- [ ] Code thay đổi đúng yêu cầu, không phá vỡ tính năng khác
- [ ] String không bị lỗi quote trên cả Windows & Linux
- [ ] `.opushforce.message` đã tạo/cập nhật
- [ ] `CHANGE_LOGS.md` đã append entry mới lên đầu file
- [ ] `CHANGE_LOGS_USER.md` đã append entry mới lên đầu file
- [ ] File `.csproj` đã cập nhật (nếu thêm/xóa file .NET)
- [ ] `package.json` / `requirements.txt` đã cập nhật (nếu thêm dependency)
- [ ] ZIP đã tạo với đúng tên, đúng cấu trúc, không có ký tự `{}`
- [ ] ZIP đã được đưa vào `/mnt/user-data/outputs/` để download

---

## GHI CHÚ THÊM

- **Mọi thay đổi dù nhỏ** (fix typo, đổi config) đều phải ghi nhận vào 3 file trên.
- **Không bao giờ** ghi đè `CHANGE_LOGS.md` hoặc `CHANGE_LOGS_USER.md` — chỉ append lên đầu.
- Nếu project chưa có `README.md` → nhắc user và hỏi có muốn tạo không.
- Khi không chắc về loại dự án → hỏi trước khi làm.
