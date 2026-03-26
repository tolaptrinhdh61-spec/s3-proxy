# s3-proxy

S3-compatible multi-account proxy for PocketBase and other S3 clients.

The proxy exposes one logical S3 endpoint while spreading object storage across multiple backend S3-compatible accounts. Object routing, bucket visibility, delete safety, and reconciliation are controlled by metadata in SQLite and replicated through Firebase RTDB.

---

## Architecture Overview

```text
Client / PocketBase
        |
        | path-style S3 API
        v
+------------------------------+
| Fastify S3 Proxy             |
| PUT/GET/HEAD/DELETE/LIST     |
| auth, metrics, health        |
+---------------+--------------+
                |
                | local control plane
                v
+------------------------------+
| SQLite (routes + accounts)   |
| - logical object metadata    |
| - tombstones                 |
| - pending RTDB sync state    |
| - reconciliation markers     |
+---------------+--------------+
                |
                | replication / backfill
                v
+------------------------------+
| Firebase RTDB                |
| /accounts /routes /instances |
+---------------+--------------+
                |
                | signed upstream requests
                v
+------------------------------+
| Backend S3 accounts          |
| acc-1, acc-2, acc-3 ...      |
+------------------------------+
```

### Logical bucket model

The proxy now treats metadata as the authoritative logical control plane.

- SQLite is the primary local source for object routing and logical bucket state.
- Firebase RTDB is the replication and backfill layer across proxy instances.
- Backend buckets are physical storage targets, not the source of truth for LIST semantics.
- New uploads are stored under a namespaced backend key: `<logical-bucket>/<object-key>`.
- Existing rows from older deployments are migrated in place and keep their legacy `backend_key` when present.

### Unified metadata table tradeoff

The existing `routes` table was expanded into a unified object metadata table instead of splitting routing and listing into separate tables.

This keeps lookup, list, tombstone, and reconciliation state in one indexed row per logical object, which reduces cross-table coordination in request paths and in RTDB replication. The tradeoff is a wider row, but it keeps the write path transactional and easier to reason about during recovery.

---

## Request Flows

### PUT object

1. Resolve target account.
   Existing logical objects stay on their current account when possible.
   New logical objects choose the least-used active account below `QUOTA_THRESHOLD`.
2. Stream the body directly to the backend account.
3. After upstream success, commit metadata in SQLite transactionally.
   This updates the logical row, metadata version, local account usage, and tombstone state if the object was being recreated.
4. Update cache and in-memory account state.
5. Attempt RTDB sync.
   If RTDB sync fails, the row remains `PENDING_SYNC` and the background flusher retries later.

### GET / HEAD object

1. Resolve metadata from cache, then SQLite, then RTDB backfill.
2. Route to the backend account from metadata only.
3. Stream the backend response to the client.
4. If metadata says the object exists but the backend returns `404`, mark the row `MISSING_BACKEND`, emit metrics/logs, and stop serving it as visible logical state.

### DELETE object

1. Resolve metadata from cache/SQLite/RTDB.
2. Transition the row to `DELETING` locally.
3. Delete the backend object.
4. Finalize a tombstone row (`DELETED`) only after backend delete succeeds or backend absence is confirmed.
5. Update local usage, cache, and RTDB replication state.

Metadata is never deleted first and then applied to the backend later.

### LIST bucket (`ListObjectsV2`)

Bucket listing is fully metadata-backed.

Supported parameters:

- `prefix`
- `delimiter`
- `max-keys`
- `continuation-token`
- `start-after`

Behavior:

- only `ACTIVE` rows are visible
- tombstones and inconsistent rows are hidden
- continuation tokens are opaque base64url-encoded metadata cursors
- `CommonPrefixes` are generated from metadata, not from a passthrough backend bucket scan

### Bucket create / delete

Logical bucket create is a metadata-level no-op success.
Logical bucket delete returns `409 BucketNotEmpty` while active logical objects still exist.

---

## Metadata Model

SQLite `routes` rows now include logical object control-plane fields equivalent to:

- `encoded_key`
- `bucket`
- `object_key`
- `backend_key`
- `account_id`
- `size_bytes`
- `etag`
- `last_modified`
- `content_type`
- `uploaded_at`
- `updated_at`
- `deleted_at`
- `metadata_version`
- `state`
- `sync_state`
- `reconcile_status`
- `backend_last_seen_at`
- `backend_missing_since`
- `last_reconciled_at`

Important states:

- `ACTIVE`: visible logical object
- `DELETING`: delete in progress, hidden from normal list output
- `DELETED`: tombstone retained for safe delete semantics and replication
- `MISSING_BACKEND`: metadata existed but backend object was not found
- `ORPHANED`: backend object detected without trusted logical metadata
- `PENDING_SYNC` lives in `sync_state` and means the row still needs RTDB replication

Indexes were added for:

- `(bucket, object_key, state, deleted_at)` for list performance
- `(account_id, backend_key)` for backend inventory reconciliation
- `(sync_state, updated_at)` for pending RTDB flushes

---

## SQLite and RTDB Responsibilities

### SQLite

SQLite is the authoritative local control plane.

- request-path reads use SQLite before RTDB
- PUT/DELETE metadata commits happen in SQLite transactions
- logical list results come from SQLite only
- tombstones and reconciliation state live here first

### Firebase RTDB

RTDB is replication, coordination, and backfill.

- other instances receive route/account updates through SSE listeners
- startup backfills local SQLite from `/accounts` and `/routes`
- rows that fail RTDB replication stay `PENDING_SYNC` and are retried by the background flusher
- RTDB is not treated as an optional cache for bucket state anymore

---

## Quota Poller and Reconciler

### Quota poller

`src/quotaPoller.js` now focuses on usage verification only.

- scans backend inventory with the shared scanner
- compares actual backend bytes with stored `used_bytes`
- corrects drift when it exceeds `QUOTA_DRIFT_THRESHOLD_RATIO`
- never crashes the process

### Reconciler

`src/reconciler.js` periodically scans backend inventory and repairs metadata drift.

Detected cases:

- backend object exists but metadata is missing
- metadata exists but backend object is missing
- size / ETag / last-modified drift
- metadata points to the wrong account

Safe remediation rules:

- mark missing backend rows instead of deleting data aggressively
- keep tombstones for confirmed deletes
- auto-heal metadata only when the backend object can be mapped safely
- mark suspicious rows with reconciliation status instead of destroying storage
- keep pending RTDB sync for repaired rows until replication succeeds

The reconciler is guarded against crashes, uses interval backoff, and keeps per-account scan progress in memory so a failed scan can resume on the next cycle instead of starting over blindly.

---

## PocketBase Integration Notes

PocketBase still talks to one logical S3 endpoint.

Recommended PocketBase S3 settings:

| Field | Value |
| --- | --- |
| Endpoint | `http://localhost:3000` |
| Bucket | your logical proxy bucket |
| Region | `auto` |
| Access Key ID | `PROXY_API_KEY` |
| Secret Key | any non-empty value |

Why adding backend accounts increases capacity:

- new logical uploads can be placed on different backend accounts
- per-account quota remains independent
- aggregate proxy capacity grows with the active backend pool

Why metadata-backed list matters for PocketBase:

- bucket listing now reflects logical state across all backend accounts
- PocketBase sees one coherent bucket instead of whichever backend happened to be queried first

What is still eventually consistent:

- RTDB replication between instances when a local commit succeeds but RTDB is temporarily unavailable
- reconciliation-based repairs for legacy objects or backend-side drift
- account `used_bytes` convergence across instances when RTDB account patches are delayed and quota verification has not yet run

---

## Failure Semantics and Recovery

### Backend upload fails before SQLite metadata write

- request fails
- no metadata row is committed
- local usage is unchanged

### Backend upload succeeds but SQLite metadata write fails

- request fails
- proxy attempts a compensating backend delete
- if rollback delete also fails, the object may remain orphaned on the backend and the failure is logged/alerted

### Backend upload + SQLite write succeed but RTDB sync fails

- request still succeeds locally
- metadata row remains `PENDING_SYNC`
- background pending-sync flush retries RTDB replication

### Backend says `404` for a metadata-backed object

- row is marked `MISSING_BACKEND`
- visibility is removed from normal logical listing
- metrics/logs are emitted for investigation and later reconciliation

---

## Setup and Run

### Standalone Node

```bash
pnpm install
cp .env.example .env
node src/index.js
```

### Docker Compose

```bash
docker compose up --build
```

### Add a backend account in RTDB

Write `/accounts/{accountId}` like:

```json
{
  "accessKeyId": "your-access-key",
  "secretAccessKey": "your-secret-key",
  "endpoint": "https://project.supabase.co/storage/v1/s3",
  "region": "ap-southeast-1",
  "bucket": "physical-backend-bucket",
  "quotaBytes": 5368709120,
  "usedBytes": 0,
  "active": true,
  "addedAt": 1774490000000
}
```

The proxy listens to `/accounts` via RTDB SSE and reloads without restart.

### Admin accounts API

The proxy also exposes authenticated admin APIs for adding or importing backend accounts without editing RTDB manually.

All admin account routes require the same API key as the S3 proxy:

- header: `x-api-key: <PROXY_API_KEY>`

Available routes:

- `GET /admin/accounts`
- `POST /admin/accounts`
- `POST /admin/accounts/import`

Supported request body shapes for `POST`:

Single account:

```json
{
  "accountId": "acc02",
  "accessKeyId": "your-access-key",
  "secretAccessKey": "your-secret-key",
  "endpoint": "https://project.supabase.co/storage/v1/s3",
  "region": "ap-southeast-1",
  "bucket": "physical-backend-bucket",
  "quotaBytes": 5368709120,
  "usedBytes": 0,
  "active": true
}
```

Bulk import as array:

```json
{
  "accounts": [
    {
      "accountId": "acc02",
      "accessKeyId": "key-02",
      "secretAccessKey": "secret-02",
      "endpoint": "https://project-02.supabase.co/storage/v1/s3",
      "region": "ap-southeast-1",
      "bucket": "bucket-02"
    },
    {
      "accountId": "acc03",
      "accessKeyId": "key-03",
      "secretAccessKey": "secret-03",
      "endpoint": "https://project-03.supabase.co/storage/v1/s3",
      "region": "ap-southeast-1",
      "bucket": "bucket-03"
    }
  ]
}
```

Bulk import from an RTDB export-style object:

```json
{
  "accounts": {
    "acc02": {
      "accessKeyId": "key-02",
      "secretAccessKey": "secret-02",
      "endpoint": "https://project-02.supabase.co/storage/v1/s3",
      "region": "ap-southeast-1",
      "bucket": "bucket-02"
    },
    "acc03": {
      "accessKeyId": "key-03",
      "secretAccessKey": "secret-03",
      "endpoint": "https://project-03.supabase.co/storage/v1/s3",
      "region": "ap-southeast-1",
      "bucket": "bucket-03"
    }
  }
}
```

Example:

```bash
curl -X POST http://localhost:3000/admin/accounts/import \
  -H "x-api-key: $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  --data @accounts-import.json
```

---

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listen port |
| `PROXY_API_KEY` | required | client auth key (`x-api-key`) |
| `FIREBASE_RTDB_URL` | required | RTDB base URL |
| `FIREBASE_DB_SECRET` | required | RTDB secret |
| `QUOTA_THRESHOLD` | `0.90` | upload placement threshold |
| `QUOTA_POLL_INTERVAL_MS` | `300000` | quota verification interval |
| `QUOTA_DRIFT_THRESHOLD_RATIO` | `0.05` | minimum relative drift before quota correction |
| `RECONCILE_INTERVAL_MS` | `900000` | reconciler loop interval |
| `INVENTORY_SCAN_PAGE_SIZE` | `500` | backend list page size for quota/reconcile scans |
| `PENDING_SYNC_BATCH_SIZE` | `200` | number of pending metadata rows flushed to RTDB per pass |
| `RTDB_SYNC_BATCH_SIZE` | `400` | RTDB batch patch chunk size |
| `DRAIN_TIMEOUT_MS` | `30000` | shutdown drain window |
| `LOG_LEVEL` | `info` | pino log level |
| `WEBHOOK_ALERT_URL` | empty | optional alert webhook |
| `INSTANCE_ID` | auto | instance ID override |
| `SQLITE_PATH` | `./data/routes.db` | SQLite file path |
| `LRU_MAX` | `10000` | metadata cache max entries |
| `LRU_TTL_MS` | `300000` | metadata cache TTL |

---

## Metrics

Prometheus metrics include the existing request/account/cache counters plus new metadata-control-plane metrics:

- `s3proxy_metadata_list_requests_total`
- `s3proxy_metadata_lookup_duration_seconds`
- `s3proxy_metadata_commit_failures_total`
- `s3proxy_reconciler_mismatches_total`
- `s3proxy_orphan_backend_objects`
- `s3proxy_missing_backend_objects`
- `s3proxy_active_logical_objects`
- `s3proxy_logical_object_bytes`

---

## Health and Validation

```bash
curl http://localhost:3000/health
curl http://localhost:3000/metrics
npm test
```

---

## Rollout Notes

- Existing SQLite databases are migrated in place on startup.
- Existing route rows are backfilled with metadata defaults such as `backend_key`, `state`, `sync_state`, and `metadata_version`.
- New uploads use namespaced backend keys (`<logical-bucket>/<object-key>`).
- Legacy rows continue to work because migrated records retain or default their stored `backend_key`.
- If legacy backend objects exist without metadata and cannot be mapped safely, the reconciler marks them as orphaned instead of exposing them as visible logical objects.
