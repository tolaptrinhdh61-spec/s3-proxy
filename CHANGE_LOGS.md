## [2026-03-26 16:10] — Per-account S3 compatibility + fix import validation

**Loại:** fix/feat  
**Tóm tắt yêu cầu:** kiểm tra tổng thể bug và tăng tính khả thi với nhiều S3-compatible endpoint  
**Nội dung thay đổi:**

- File `src/db.js`: mở rộng schema accounts với `addressing_style` (default `path`) và `payload_signing_mode` (default `unsigned`), kèm migration idempotent và upsert.
- File `src/routes/accounts.js`: parse/validate 2 field mới, trả về trong API response/RTDB document; sửa bug validate theo từng entry (`errorCountBefore`) để tránh skip sai hàng hợp lệ.
- File `src/accountPool.js`: reload account từ RTDB có đọc `addressingStyle` và `payloadSigningMode`.
- File `src/utils/sigv4.js`: hỗ trợ ký request theo `virtual-hosted` style (bucket ở host) khi cần, và cho phép chọn ký payload strict (`signed`) thay vì luôn `UNSIGNED-PAYLOAD`.
- File `test/utils.test.js`, `test/accounts-api.test.js`: bổ sung test cho virtual-hosted signing, field mới và case payload invalid.
- File `README.md`: cập nhật ví dụ account payload với các field tương thích mới.

**Ghi chú kỹ thuật:** thay đổi này giúp proxy linh hoạt hơn khi làm việc đồng thời với nhiều nhà cung cấp S3-compatible có yêu cầu khác nhau về addressing style và payload signing.

---

## [2026-03-26 14:45] — Fix trailing slash bucket URL cho PocketBase

**Loại:** fix  
**Tóm tắt yêu cầu:** PocketBase gửi LIST request dạng `/bucket/?list-type=2` (có trailing slash), Fastify không match route `GET /:bucket` nên trả 404  
**Nội dung thay đổi:**

- File `src/index.js`: thêm `ignoreTrailingSlash: true` vào Fastify init options. Fastify sẽ tự normalize `/bucket/` thành `/bucket` trước khi route matching.

**Ghi chú kỹ thuật:** PocketBase dùng AWS SDK, SDK tự thêm trailing slash vào bucket URL khi gọi ListObjectsV2. Option `ignoreTrailingSlash` là cách chuẩn của Fastify để xử lý trường hợp này, không cần thêm route mirror.

---

## [2026-03-26 14:30] — Fix auth PocketBase AWS SigV4

**Loại:** fix  
**Tóm tắt yêu cầu:** PocketBase kết nối S3 proxy bị lỗi 403 AccessDenied vì proxy không hiểu AWS SigV4 Authorization header  
**Nội dung thay đổi:**

- File `src/plugins/auth.js`: thêm hàm `extractApiKey()` để parse 3 format xác thực: `x-api-key`, `Authorization: Bearer`, và `Authorization: AWS4-HMAC-SHA256 Credential=<key>/...`. Trước đây chỉ hỗ trợ 2 format đầu, dẫn đến PocketBase (dùng AWS SDK gửi SigV4) bị từ chối.

**Ghi chú kỹ thuật:** PocketBase dùng AWS SDK để kết nối S3, SDK tự động ký request theo chuẩn SigV4 với Access Key ID là `PROXY_API_KEY`. Header Authorization có dạng `AWS4-HMAC-SHA256 Credential=<accessKeyId>/<date>/<region>/s3/aws4_request, SignedHeaders=..., Signature=...`. Fix này extract phần `accessKeyId` ra và so sánh với `PROXY_API_KEY`.

---

## [2026-03-26 14:45] — Fix trailing slash bucket URL cho PocketBase

**Loại:** fix  
**Tóm tắt yêu cầu:** PocketBase gửi LIST request dạng `/bucket/?list-type=2` (có trailing slash), Fastify không match route `GET /:bucket` nên trả 404  
**Nội dung thay đổi:**

- File `src/index.js`: thêm `ignoreTrailingSlash: true` vào Fastify init options. Fastify sẽ tự normalize `/bucket/` thành `/bucket` trước khi route matching.

**Ghi chú kỹ thuật:** PocketBase dùng AWS SDK, SDK tự thêm trailing slash vào bucket URL khi gọi ListObjectsV2. Option `ignoreTrailingSlash` là cách chuẩn của Fastify để xử lý trường hợp này, không cần thêm route mirror.

---

## [2026-03-26 14:30] — Fix auth PocketBase AWS SigV4

**Loại:** fix  
**Tóm tắt yêu cầu:** PocketBase kết nối S3 proxy bị lỗi 403 AccessDenied vì proxy không hiểu AWS SigV4 Authorization header  
**Nội dung thay đổi:**

- File `src/plugins/auth.js`: thêm hàm `extractApiKey()` để parse 3 format xác thực: `x-api-key`, `Authorization: Bearer`, và `Authorization: AWS4-HMAC-SHA256 Credential=<key>/...`. Trước đây chỉ hỗ trợ 2 format đầu, dẫn đến PocketBase (dùng AWS SDK gửi SigV4) bị từ chối.

**Ghi chú kỹ thuật:** PocketBase dùng AWS SDK để kết nối S3, SDK tự động ký request theo chuẩn SigV4 với Access Key ID là `PROXY_API_KEY`. Header Authorization có dạng `AWS4-HMAC-SHA256 Credential=<accessKeyId>/<date>/<region>/s3/aws4_request, SignedHeaders=..., Signature=...`. Fix này extract phần `accessKeyId` ra và so sánh với `PROXY_API_KEY`.

---

## [2026-03-26 13:48] — Them Postman collection kiem thu end-to-end cho production

**Loại:** feat  
**Tóm tắt yêu cầu:** tạo `postman.json` để kiểm thử toàn bộ luồng nghiệp vụ hiện tại, dùng được như tài liệu cho kiểm thử trên môi trường production  
**Nội dung thay đổi:**

- File `postman.json`: them Postman collection hoan chinh cho smoke check `health`/`metrics`, import 2 backend accounts, verify multi-account placement bang `usedBytes`, test `PUT`/`GET`/`HEAD`/`LIST`/`DELETE`, bucket lifecycle, multipart complete, abort multipart, va cleanup cuoi luong.
- File `postman.json`: bo sung collection variables cho `baseUrl`, `apiKey`, 2 account backend, payload test, multipart state, va script reset `runId` de moi lan chay sinh bucket/object key rieng.
- File `README.md`, `deploy.vi.md`: bo sung huong dan ngan ve cach import va chay `postman.json` tren staging/production, dong thoi neu ro collection chi xoa object test + logical bucket, khong xoa backend accounts.
- File `.opushforce.message`: cap nhat thong diep tom tat cho artifact kiem thu moi.

**Ghi chú kỹ thuật:** collection nay duoc thiet ke theo behavior thuc te cua proxy la `least-used + QUOTA_THRESHOLD`, nen assert phan bo object dua tren `GET /admin/accounts` va `usedBytes` thay vi round-robin cung. Da validate local bang parse JSON `postman.json`.

---

## [2026-03-26 13:21] — Them admin API de them va import nhieu accounts

**Loại:** feat  
**Tóm tắt yêu cầu:** thêm API để lưu thêm backend accounts, hỗ trợ import nhiều account cùng lúc và dùng được với các payload export JSON  
**Nội dung thay đổi:**

- File `src/routes/accounts.js`: them admin routes `GET /admin/accounts`, `POST /admin/accounts`, `POST /admin/accounts/import`; ho tro upsert 1 account, import nhieu account, validate payload, sync SQLite + RTDB, va khong tra ve secret key trong response.
- File `src/index.js`: dang ky `accountRoutes` vao Fastify bootstrap.
- File `src/firebase.js`: sua normalize path cho RTDB REST/SSE, dac biet la root patch `/.json`, de `rtdbBatchPatch('/')` hoat dong dung cho import nhieu records.
- File `test/accounts-api.test.js`: them integration test voi fake RTDB de kiem tra import 1 account, bulk import tu map/export shape, GET list accounts, va validation 400.
- File `README.md`, `deploy.vi.md`: bo sung tai lieu va vi du curl cho accounts admin API.
- File `package.json`: them script `test:accounts-api` va noi suite moi vao `npm test`.

**Ghi chú kỹ thuật:** accounts API ghi vao SQLite truoc de node hien tai dung duoc ngay, sau do batch patch len RTDB de cac instance khac nhan thay doi. Payload import ho tro 3 dang chinh: object don, `{ "accounts": [ ... ] }`, va `{ "accounts": { "acc01": { ... } } }`.

---

## [2026-03-26 12:01] — Them kich ban kiem thu multi-account va luong S3 thong dung

**Loại:** feat  
**Tóm tắt yêu cầu:** viet cac kich ban kiem thu de cau hinh nhieu account, kiem tra viec luu object duoc chuyen sang account khac, va thu cac luong S3 thuong gap nhu tao, get, head, list, delete  
**Nội dung thay đổi:**

- File `test/multi-account.test.js`: them integration test voi 2 fake S3 upstream de kiem tra create/delete bucket rong, phan bo object qua 2 account, GET/HEAD/LIST tren multi-account, delete object + tombstone, bucket not empty, threshold switch, va overwrite giu nguyen account cu.
- File `docs/multi-account-test-scenarios.vi.md`: them tai lieu mo ta chien luoc chon account, cac kich ban tu dong da co, ky vong tung buoc, va huong mo rong them.
- File `package.json`: them script `test:multi-account` va noi suite moi vao `npm test`.

**Ghi chú kỹ thuật:** test moi xac nhan behavior hien tai la `least-used + QUOTA_THRESHOLD`, khong phai round-robin cung. Da verify local bang `node test/multi-account.test.js` va `npm test` deu pass.

---

## [2026-03-26 11:47] — Fix SigV4 path + payload signing cho Supabase

**Loại:** fix  
**Tóm tắt yêu cầu:** kiểm tra lỗi `404` rồi tiếp tục xử lý `SignatureDoesNotMatch` khi `PUT /s3-proxy-dem9/hello.txt` qua proxy  
**Nội dung thay đổi:**

- File `src/utils/sigv4.js`: giữ nguyên base path của `account.endpoint` như `/storage/v1/s3` khi dựng `HttpRequest` và URL upstream.
- File `src/utils/sigv4.js`: không còn strip header `x-amz-content-sha256`, giúp `UNSIGNED-PAYLOAD` được đưa vào canonical request và `SignedHeaders`.
- File `test/utils.test.js`: bổ sung assert để kiểm tra URL đã giữ `/storage/v1/s3`, preserve `x-amz-content-sha256`, và `Authorization` có ký header này.
- File `.opushforce.message`: cập nhật bản ghi ngắn gọn cho fix SigV4 hiện tại.
- File `CHANGE_LOGS.md`: thêm entry kỹ thuật cho lỗi ký request Supabase.
- File `CHANGE_LOGS_USER.md`: thêm entry theo góc nhìn yêu cầu của user.

**Ghi chú kỹ thuật:** fix này xử lý cả hai nguyên nhân trong cùng luồng ký request: URL upstream bị mất endpoint base path và canonical signing bị lệch vì bỏ `x-amz-content-sha256`. Đã verify local bằng `npm test` và request thật `PUT`/`GET` trả `200`.

---

## [2026-03-26 09:38] — Metadata-backed logical bucket and reconciliation

**Loại:** feat  
**Tóm tắt yêu cầu:** upgrade metadata from routing helper to logical control plane, add metadata-backed list, reconciler, and docs updates  
**Nội dung thay đổi:**

- File `src/db.js`: mở rộng bảng `routes` thành unified metadata table với tombstone, `backend_key`, `sync_state`, `reconcile_status`, migration idempotent, và helper giao dịch cho upload/delete/reconciliation.
- File `src/routes/s3.js`: thay PUT/GET/HEAD/DELETE/LIST sang metadata-first flow, ListObjectsV2 từ SQLite, backend key namespacing cho write mới, delete an toàn bằng `DELETING` -> `DELETED`.
- File `src/reconciler.js`: thêm background reconciler quét inventory backend, đánh dấu drift, auto-heal an toàn, flush pending RTDB sync, và không làm crash process.
- File `src/inventoryScanner.js`: tách shared inventory scan dùng lại cho quota poller và reconciler.
- File `src/quotaPoller.js`: refactor chỉ còn usage verification, dùng inventory scanner chung và đồng bộ absolute `used_bytes`.
- File `src/accountPool.js`: đồng bộ in-memory account state từ DB rows giao dịch thay vì blind increment/decrement.
- File `src/index.js`: bootstrap lại RTDB backfill/listeners/workers để hỗ trợ metadata control plane mới.
- File `src/routes/metrics.js`: thêm metric cho metadata list, lookup latency, commit failure, reconciler mismatch, orphan/missing objects, logical object counts/bytes.
- File `src/metadata.js`, `src/controlPlane.js`: gom helper backend key, continuation token, RTDB document shape, pending sync replication.
- File `src/firebase.js`, `src/routes/health.js`, `src/utils/s3Xml.js`: cập nhật supporting layers cho delete auth, health count visible object, XML ListObjectsV2 metadata-backed.
- File `database.rules.json`, `.env.example`, `README.md`: cập nhật index RTDB, env vars mới, và tài liệu triển khai/kiến trúc/failure semantics.
- File `test/storage.test.js`, `test/server.test.js`: cập nhật test theo metadata commit transaction, tombstone, pagination, delimiter, và metrics mới.

**Ghi chú kỹ thuật:**

- Migration giữ nguyên bảng `routes` và mở rộng nó thành unified metadata table để không cần tách dữ liệu routing/listing sang bảng mới.
- Write mới dùng `backend_key` dạng `<logical-bucket>/<object-key>`; row cũ được migrate in place và giữ tương thích qua `backend_key` cũ/default.
- RTDB sync có thể eventual nếu remote tạm lỗi; row sẽ giữ `PENDING_SYNC` và được background flusher gửi lại.

---

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
