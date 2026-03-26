## [2026-03-26 08:34] — Fix Bootstrap, Runtime, Test Coverage

**Loại:** fix  
**Tóm tắt yêu cầu:** Sau khi user khôi phục `src/config.js`, kiểm tra lại và xử lý các lỗi còn lại để project boot/test được  
**Nội dung thay đổi:**

- File `src/index.js`: bỏ import/plugin `@fastify/close-grace` không tồn tại, sửa RTDB routes listener để xóa route/cache đúng, smoke boot lại entrypoint thành công
- File `src/db.js`: thêm helper `getAllAccounts`, `getAccountById`, `listRoutesByBucket`, `deactivateMissingAccounts` để route lookup/list chuẩn hơn
- File `src/accountPool.js`: thêm `reloadAccountsFromSQLite`, đồng bộ inactive account từ nguồn dữ liệu và giữ in-memory state nhất quán
- File `src/quotaPoller.js`: cập nhật lại `used_bytes` trong memory sau quota poll để tránh lệch thứ tự chọn account
- File `src/routes/s3.js`: fix upload retry bằng buffered body, fix GET stream response, thêm binary content-type parser, sửa multipart theo đúng `PUT part` / `POST complete` / `DELETE abort`, và LIST đọc từ route table local
- File `test/utils.test.js`, `test/storage.test.js`: set env giả lập trong test để không fail sớm vì config validation
- File `test/server.test.js`: thêm integration test cho PUT/GET/HEAD/DELETE/LIST/multipart/auth/health/metrics/CORS
- File `package.json`, `package-lock.json`: thêm script `test`, khóa dependency tree bằng `npm install`, bỏ dependency `@fastify/close-grace` không hợp lệ

**Ghi chú kỹ thuật:**
- `npm test` pass toàn bộ suite local
- `node src/index.js` smoke boot pass với env giả lập và SQLite local
- `test/firebase.test.js` chưa chạy vì cần Firebase RTDB thật

---
## [2025-03-25 12:00] — T4+T5+T6: Utilities, Routes, Bootstrap

**Loại:** feat  
**Tóm tắt yêu cầu:** Implement T4 (Utilities), T5 (Fastify Routes), T6 (Bootstrap)  
**Nội dung thay đổi:**

- File `src/utils/retry.js`: withRetry exponential backoff (100/200/400ms), chỉ retry 5xx + network errors, không retry 4xx
- File `src/utils/s3Xml.js`: 5 builder functions — buildErrorXml, buildListBucketResult, buildInitiateMultipartUploadResult, buildCompleteMultipartUploadResult, buildDeleteObjectsResult
- File `src/utils/sigv4.js`: resignRequest (strip AWS headers, re-sign với account creds), proxyRequest (undici, UNSIGNED-PAYLOAD cho streaming PUT)
- File `src/utils/webhook.js`: sendAlert fire-and-forget, 5s timeout với AbortController, không throw
- File `src/plugins/auth.js`: Fastify plugin fp() validate x-api-key + Bearer token, 403 XML on mismatch
- File `src/plugins/errorHandler.js`: global setErrorHandler + setNotFoundHandler, S3 XML với status code mapping
- File `src/routes/health.js`: GET /health trả JSON đầy đủ, 503 nếu cả RTDB và SQLite chết
- File `src/routes/metrics.js`: GET /metrics Prometheus format, 10 metrics, collectDefaultMetrics
- File `src/routes/s3.js`: PUT (upload+retry+fallback), GET (stream), HEAD, DELETE, LIST, multipart full flow
- File `src/index.js`: 12-bước bootstrap, RTDB SSE listeners với exponential backoff reconnect, heartbeat 30s, graceful shutdown
- File `test/utils.test.js`: 5 test cases T4 checklist
- File `package.json`: thêm fastify-plugin, @aws-crypto/sha256-js

**Ghi chú kỹ thuật:**
- sigv4.js dùng UNSIGNED-PAYLOAD để tránh buffer streaming PUT body — bắt buộc cho file lớn
- s3Routes dùng `request.raw` (Node IncomingMessage) cho body stream, không dùng parsed body
- RTDB listener auto-reconnect với exponential backoff 1s→60s max
- accounts listener debounced 2s để tránh thundering herd
- heartbeat timer dùng `.unref()` để không block Node.js exit

---

## [2025-03-25 11:00] — T3: Storage Layer

**Loại:** feat  
**Tóm tắt yêu cầu:** Implement T3 — Storage Layer: SQLite, LRU cache, Account Pool, Quota Poller  
**Nội dung thay đổi:**

- File `src/db.js`: SQLite init với WAL mode, migrations idempotent, 11 query functions
- File `src/cache.js`: LRU wrapper lru-cache v10, 5 functions
- File `src/accountPool.js`: StorageFullError, selectAccountForUpload, recordUpload, recordDelete, reloadAccountsFromRTDB, getAccountsStats, getAccount
- File `src/quotaPoller.js`: background S3 ListObjectsV2 poller, 5% threshold, never crashes, timer.unref()
- File `test/storage.test.js`: 8 test cases theo checklist T3

---

## [2025-03-25 10:00] — T2: Firebase RTDB Layer

**Loại:** feat  
**Tóm tắt yêu cầu:** Implement T2 — Firebase RTDB layer dùng REST API + SSE  
**Nội dung thay đổi:**

- File `src/firebase.js`: 7 hàm export, dùng fetch thuần + eventsource SSE, auto-chunk rtdbBatchPatch
- File `database.rules.json`: Firebase RTDB security rules với .indexOn
- File `test/firebase.test.js`: 6 test cases theo checklist T2

---

