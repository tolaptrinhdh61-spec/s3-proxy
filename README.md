# s3-proxy

S3-compatible multi-account proxy with Firebase RTDB sync. Pools 20+ Supabase S3 accounts behind one endpoint, distributes uploads across accounts by quota, and syncs routing table bidirectionally via Firebase RTDB for multi-instance HA.

---

## Architecture

```
                        ┌──────────────────────────────────┐
                        │         Firebase RTDB             │
                        │  /accounts  /routes  /instances  │
                        └──────┬───────────────┬───────────┘
                   SSE listen  │               │  SSE listen
                               ▼               ▼
┌──────────┐   x-api-key  ┌─────────┐   ┌─────────┐   ┌─────────┐
│PocketBase│─────────────▶│ proxy-1 │   │ proxy-2 │   │ proxy-3 │
│  Client  │              │ :3001   │   │ :3002   │   │ :3003   │
└──────────┘              └────┬────┘   └────┬────┘   └────┬────┘
                               │             │             │
                    shared SQLite volume (WAL mode, Docker)
                               │             │             │
                        ┌──────▼─────────────▼─────────────▼──────┐
                        │           Supabase S3 Accounts            │
                        │  acc-1  acc-2  acc-3  ...  acc-20+       │
                        └──────────────────────────────────────────┘
```

**Upload flow:** Client PUT → proxy selects least-used account under 90% quota → streams body directly to Supabase → saves route to SQLite + RTDB → other instances receive route via SSE listener.

**Download flow:** Client GET → lookup cache → SQLite → RTDB fallback → proxy re-signs request → streams Supabase response directly to client.

---

## Quick Start — Standalone Node

```bash
# 1. Install
pnpm install

# 2. Configure
cp .env.example .env
# Edit .env — fill in PROXY_API_KEY, FIREBASE_RTDB_URL, FIREBASE_DB_SECRET

# 3. Add at least one account to Firebase RTDB (see section below)

# 4. Start
node src/index.js
# Server listens on http://localhost:3000
```

**Verify:**
```bash
curl http://localhost:3000/health
# → {"status":"ok","accounts":{"total":1,"active":1,"full":0},...}
```

---

## Quick Start — Docker Compose

```bash
# 1. Configure
cp .env.example .env
# Edit .env

# 2. Start 3 replicas
docker compose up --build

# proxy-1 → http://localhost:3001
# proxy-2 → http://localhost:3002
# proxy-3 → http://localhost:3003

# Health check
curl http://localhost:3001/health
```

All 3 instances share one SQLite file via Docker volume (`proxy-data`). WAL mode handles concurrent access safely.

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PROXY_API_KEY` | ✅ | — | Client auth key (sent as `x-api-key` header) |
| `FIREBASE_RTDB_URL` | ✅ | — | Firebase RTDB URL e.g. `https://project.firebaseio.com` |
| `FIREBASE_DB_SECRET` | ✅ | — | Firebase RTDB legacy secret token |
| `PORT` | | `3000` | HTTP server port |
| `QUOTA_THRESHOLD` | | `0.90` | Switch account when usage reaches this fraction |
| `QUOTA_POLL_INTERVAL_MS` | | `300000` | Poll Supabase storage every N ms (5 min) |
| `RTDB_SYNC_BATCH_SIZE` | | `400` | Max RTDB writes per batch on startup |
| `DRAIN_TIMEOUT_MS` | | `30000` | Graceful shutdown drain window (ms) |
| `LOG_LEVEL` | | `info` | Pino log level: trace/debug/info/warn/error/fatal |
| `WEBHOOK_ALERT_URL` | | `""` | POST webhook on critical errors (optional) |
| `INSTANCE_ID` | | auto | Auto-generated as `hostname-PID-hex` if not set |
| `SQLITE_PATH` | | `./data/routes.db` | Path to SQLite database file |
| `LRU_MAX` | | `10000` | LRU cache max entries |
| `LRU_TTL_MS` | | `300000` | LRU cache TTL (ms) |

---

## Adding a Supabase Account

Add the account object to Firebase RTDB at `/accounts/{accountId}`:

```json
{
  "accounts": {
    "acc-supabase-01": {
      "accessKeyId": "your-supabase-access-key",
      "secretAccessKey": "your-supabase-secret-key",
      "endpoint": "https://xxxxxxxxxxxx.supabase.co/storage/v1/s3",
      "region": "ap-southeast-1",
      "bucket": "my-bucket",
      "quotaBytes": 5368709120,
      "usedBytes": 0,
      "active": true,
      "addedAt": 1711234567890
    }
  }
}
```

The proxy detects the change via RTDB SSE listener (debounced 2s) and automatically reloads accounts into memory. No restart required.

**How to find Supabase S3 credentials:**  
Supabase Dashboard → Project → Settings → Storage → S3 Access Keys

---

## PocketBase Integration

PocketBase S3 config (Settings → Files → S3):

| Field | Value |
|-------|-------|
| Endpoint | `http://localhost:3000` (or your proxy host) |
| Bucket | Any name — proxy distributes transparently |
| Region | `auto` |
| Access Key ID | Value of `PROXY_API_KEY` |
| Secret Key | Any non-empty string (proxy ignores it) |

The proxy validates the `x-api-key` header which PocketBase sends as the Access Key ID. The Secret Key field is ignored.

---

## API Endpoints

### S3-compatible (require `x-api-key` header)

| Method | Path | Operation |
|--------|------|-----------|
| `PUT` | `/:bucket/:key*` | Upload object |
| `GET` | `/:bucket/:key*` | Download object |
| `HEAD` | `/:bucket/:key*` | Object metadata |
| `DELETE` | `/:bucket/:key*` | Delete object |
| `GET` | `/:bucket` | List objects |
| `PUT` | `/:bucket` | Create bucket |
| `DELETE` | `/:bucket` | Delete bucket |
| `POST` | `/:bucket/:key*?uploads` | Initiate multipart upload |
| `PUT` | `/:bucket/:key*?uploadId=X&partNumber=N` | Upload part |
| `POST` | `/:bucket/:key*?uploadId=X` | Complete multipart |
| `DELETE` | `/:bucket/:key*?uploadId=X` | Abort multipart |

### System (no auth required)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health status JSON |
| `GET` | `/metrics` | Prometheus metrics |
| `OPTIONS` | `/*` | CORS preflight |

---

## Health Check Response

```json
{
  "status": "ok",
  "instanceId": "proxy-1",
  "uptime": 3600.5,
  "accounts": {
    "total": 22,
    "active": 20,
    "full": 2
  },
  "routes": {
    "sqliteCount": 150000,
    "cacheSize": 9800
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
}
```

Returns `503` only if both RTDB and SQLite are unreachable simultaneously.

---

## Prometheus Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `s3proxy_requests_total` | Counter | `method`, `operation`, `status_code` | Total requests |
| `s3proxy_upload_bytes_total` | Counter | `account_id` | Bytes uploaded per account |
| `s3proxy_download_bytes_total` | Counter | `account_id` | Bytes downloaded per account |
| `s3proxy_account_used_bytes` | Gauge | `account_id` | Current used bytes |
| `s3proxy_account_quota_bytes` | Gauge | `account_id` | Quota bytes |
| `s3proxy_rtdb_sync_lag_ms` | Gauge | — | ms since last RTDB event |
| `s3proxy_cache_hits_total` | Counter | — | LRU cache hits |
| `s3proxy_cache_misses_total` | Counter | — | LRU cache misses |
| `s3proxy_retry_total` | Counter | `operation` | Retry attempts |
| `s3proxy_fallback_total` | Counter | `reason` | Fallback triggers |

---

## Graceful Shutdown

```bash
kill -SIGTERM <pid>
# or Ctrl+C (SIGINT)
```

On shutdown: stops accepting requests → drains in-flight requests (up to `DRAIN_TIMEOUT_MS`) → stops quota poller → closes RTDB listeners → marks instance unhealthy in RTDB → closes SQLite → exits 0.

---

## Setup Checklist (zero to first request)

```bash
# 1. Install Node.js 20+ and pnpm
npm install -g pnpm

# 2. Clone / extract project
cd s3-proxy
pnpm install

# 3. Configure environment
cp .env.example .env
# Edit .env: set PROXY_API_KEY, FIREBASE_RTDB_URL, FIREBASE_DB_SECRET

# 4. Add first Supabase account to Firebase RTDB
# (see "Adding a Supabase Account" section above)

# 5. Start server
node src/index.js

# 6. Test upload
curl -X PUT http://localhost:3000/mybucket/hello.txt \
  -H "x-api-key: your-proxy-api-key" \
  -H "Content-Type: text/plain" \
  --data "hello world"

# 7. Test download
curl http://localhost:3000/mybucket/hello.txt \
  -H "x-api-key: your-proxy-api-key"
# → hello world

# 8. Check health
curl http://localhost:3000/health | jq .
```
