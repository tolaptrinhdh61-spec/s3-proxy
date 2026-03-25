Dưới đây là sơ đồ kiến trúc tổng quan của project, sau đó là bảng phân chia task chi tiết.Dưới đây là bảng phân chia 6 task độc lập — mỗi task có thể giao cho một agent riêng, không phụ thuộc nhau, có input/output rõ ràng và điều kiện kiểm tra cụ thể.

Chi tiết từng task
🟣 T1 — Foundation & Config

Agent có thể bắt đầu ngay, không cần gì trước.

Input: Spec section 1, 18, 19, 20, 21

Output files:

package.json — đủ dependencies, "type": "module"
src/config.js — validate env, export frozen object, exit(1) nếu thiếu
.env.example — tất cả 13 biến
.gitignore, Dockerfile, docker-compose.yml

Điều kiện kiểm tra:

# 1. Install thành công
pnpm install

# 2. Config validate (với env đầy đủ)
PROXY_API_KEY=test FIREBASE_RTDB_URL=https://x.firebaseio.com \
FIREBASE_DB_SECRET=secret node -e "import('./src/config.js')"
# → không throw

# 3. Config validate (thiếu var)
node -e "import('./src/config.js')"
# → process exit code 1, stderr có mô tả biến thiếu

# 4. Docker build
docker build -t s3proxy-test .
# → exit 0
🩵 T2 — Firebase RTDB Layer

Input: Spec section 3 + biến FIREBASE_RTDB_URL, FIREBASE_DB_SECRET

Output files:

src/firebase.js — 7 hàm export, dùng fetch thuần (REST API + SSE)
database.rules.json

Điều kiện kiểm tra:

# Tạo test/firebase.test.js
node test/firebase.test.js
# Phải log:
# ✅ rtdbSet /test/ping
# ✅ rtdbGet /test/ping → { ok: true }
# ✅ rtdbPatch /test/ping → { ok: true, patched: 1 }
# ✅ rtdbDelete /test/ping
# ✅ rtdbListen nhận event trong 3s
# ✅ rtdbBatchPatch 500 entries (auto-chunk 2 lần)
🟡 T3 — Storage Layer

Input: Spec section 4, 5, 6, 7. Không cần Firebase, không cần Fastify.

Output files:

src/db.js — SQLite init + 8 query functions
src/cache.js — LRU wrapper 4 functions
src/accountPool.js — selectAccountForUpload, recordUpload, recordDelete, reloadAccountsFromRTDB, StorageFullError
src/quotaPoller.js — background poller, never crashes

Input mẫu cho test:

// accounts seed (insert trực tiếp vào SQLite)
{ account_id: 'acc1', quota_bytes: 5_000_000_000, used_bytes: 0, active: 1, ... }
{ account_id: 'acc2', quota_bytes: 5_000_000_000, used_bytes: 4_600_000_000, active: 1, ... }

Điều kiện kiểm tra:

node test/storage.test.js
# ✅ upsertAccount + getAllActiveAccounts trả đúng thứ tự used_bytes ASC
# ✅ selectAccountForUpload(100MB) → acc1 (acc2 vượt threshold 90%)
# ✅ recordUpload acc1 +100MB → updateUsedBytes đúng
# ✅ cacheSet / cacheGet hit
# ✅ cacheDelete → miss
# ✅ SQLite migrate chạy 2 lần → không lỗi (idempotent)
# ✅ selectAccountForUpload khi tất cả full → throw StorageFullError
🟠 T4 — Utilities

Input: Spec section 10 (sigv4 phần), 11, 12, 17

Output files:

src/utils/sigv4.js — resignRequest dùng @aws-sdk/signature-v4 + undici
src/utils/retry.js — withRetry, exponential backoff, chỉ retry 5xx/network
src/utils/s3Xml.js — buildErrorXml, buildListBucketResult, buildMultipartXml
src/utils/webhook.js — sendAlert, fire-and-forget, timeout 5s

Điều kiện kiểm tra:

node test/utils.test.js
# ✅ resignRequest tạo header Authorization dạng AWS4-HMAC-SHA256
# ✅ withRetry: fn fail 2 lần rồi pass → gọi đúng 3 lần
# ✅ withRetry: fn trả 404 → không retry, throw ngay
# ✅ buildErrorXml('NoSuchKey','msg','req1') → valid XML có <Code>NoSuchKey</Code>
# ✅ sendAlert({ event:'storage_full'}) → không throw dù WEBHOOK_ALERT_URL= ''
🔵 T5 — Fastify Server & Routes

Input: Spec section 8 (chỉ Fastify setup), 9–15. Nhận T3 + T4 đã xong.

Output files:

src/plugins/auth.js
src/plugins/errorHandler.js
src/routes/s3.js
src/routes/health.js
src/routes/metrics.js

Mock dependencies: T5 có thể dùng mock cho accountPool và db khi test độc lập.

Điều kiện kiểm tra:

# Chạy server với mock accountPool
node test/server.test.js
# ✅ PUT /mybucket/path/to/file → 200, route được lưu
# ✅ GET /mybucket/path/to/file → stream body từ Supabase mock
# ✅ DELETE /mybucket/path/to/file → 204, route xoá
# ✅ HEAD /mybucket/path/to/file → headers only, no body
# ✅ GET /mybucket (list) → XML ListBucketResult
# ✅ x-api-key sai → 403 XML <Code>AccessDenied</Code>
# ✅ GET /health → 200 JSON có keys: status, accounts, routes, rtdb, quota
# ✅ GET /metrics → text/plain có s3proxy_requests_total
# ✅ OPTIONS preflight → 200 với CORS headers
# ✅ Multipart: POST ?uploads, PUT ?partNumber=1, POST ?uploadId=x complete
🟢 T6 — Bootstrap & Sync

Input: Tất cả T2–T5 hoàn thành. Spec section 8 (startup order), 9 (RTDB listeners), 16 (shutdown), 23.

Output files:

src/index.js — 12-bước startup, RTDB listeners, heartbeat, graceful shutdown
README.md

Điều kiện kiểm tra:

# 1. Standalone
node src/index.js
# Log phải xuất hiện đúng thứ tự:
# [1] config validated
# [2] sqlite initialized
# [3] rtdb connected (hoặc warn nếu offline)
# ...
# [10] fastify listening on :3000
# [11] heartbeat started
# [12] quota poller started

# 2. End-to-end upload/download cross-instance
curl -X PUT http://localhost:3001/bucket1/hello.txt \
  -H "x-api-key: $PROXY_API_KEY" \
  -H "Content-Type: text/plain" --data "hello world"
# → 200

curl http://localhost:3002/bucket1/hello.txt \
  -H "x-api-key: $PROXY_API_KEY"
# → "hello world"  (đọc từ instance khác)

# 3. Graceful shutdown
kill -SIGTERM <pid>
# → Log "Shutting down...", drain in-flight, process exit 0

# 4. Docker Compose
docker compose up --build
# → proxy-1, proxy-2, proxy-3 tất cả healthy (/health → 200)
Thứ tự thực hiện & dependency graph
T1 (Foundation)
 ├── T2 (Firebase)    ──────────────────────────┐
 ├── T3 (Storage)     ─────────────┐             │
 └── T4 (Utilities)  ──┐           │             │
                        └── T5 (Routes) ──┐      │
                                           └─── T6 (Bootstrap)

T1 → T2, T3, T4 có thể chạy song song. T5 cần T3 + T4 xong. T6 cần T2 + T3 + T5 xong.