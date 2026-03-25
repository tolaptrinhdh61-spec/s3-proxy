## [2025-03-25 11:00] — T3: Storage Layer

**Loại:** feat  
**Tóm tắt yêu cầu:** Implement T3 — Storage Layer: SQLite, LRU cache, Account Pool, Quota Poller  
**Nội dung thay đổi:**

- File `src/db.js`: SQLite init với WAL mode + NORMAL sync + 64MB cache; migrations idempotent (CREATE TABLE IF NOT EXISTS); 11 hàm: upsertAccount, getAllActiveAccounts, updateUsedBytes, setUsedBytesAbsolute, upsertRoute, getRoute, deleteRoute, getAllRoutes, countRoutes, upsertMultipartUpload, getMultipartUpload, deleteMultipartUpload
- File `src/cache.js`: LRU wrapper dùng lru-cache v10; key=encodedKey, value={accountId,bucket,objectKey,sizeBytes}; export cacheGet/cacheSet/cacheDelete/cacheClear/cacheSize
- File `src/accountPool.js`: StorageFullError class; selectAccountForUpload(sizeBytes, excludeIds) iterate sorted accounts check threshold; recordUpload/recordDelete sync SQLite + update in-memory + fire-and-forget RTDB patch; reloadAccountsFromRTDB pull RTDB → upsert SQLite → rebuild in-memory; getAccountsStats cho health endpoint
- File `src/quotaPoller.js`: startQuotaPoller/stopQuotaPoller; ListObjectsV2 phân trang; discrepancy > 5% → setUsedBytesAbsolute; mọi lỗi đều catch + log, không crash; timer.unref() để không block exit
- File `test/storage.test.js`: 8 test cases bao gồm tất cả điều kiện T3 checklist

**Ghi chú kỹ thuật:**  
- accountPool load từ SQLite tại module import time → cần gọi reloadAccountsFromRTDB() ở startup để sync RTDB data  
- recordUpload/recordDelete dùng `Promise.resolve().then(() => rtdbPatch(...))` để push RTDB off event loop (fire-and-forget, không block response)  
- quotaPoller dùng `timer.unref()` để Node.js process có thể exit clean khi không còn request  
- test/storage.test.js override SQLITE_PATH trước khi import db.js để dùng test DB riêng biệt

---

## [2025-03-25 10:00] — T2: Firebase RTDB Layer

**Loại:** feat  
**Tóm tắt yêu cầu:** Implement T2 — Firebase RTDB layer dùng REST API + SSE, không dùng firebase-admin SDK  
**Nội dung thay đổi:**

- File `src/firebase.js`: 7 hàm export (rtdbGet, rtdbSet, rtdbPatch, rtdbDelete, rtdbPush, rtdbListen, rtdbBatchPatch); dùng fetch thuần + eventsource SSE; rtdbBatchPatch tự chunk theo RTDB_SYNC_BATCH_SIZE
- File `database.rules.json`: Firebase RTDB security rules với `.indexOn` cho accounts, routes, instances
- File `test/firebase.test.js`: 6 test case theo checklist T2 — set, get, patch, delete, listen (SSE), batchPatch 500 entries
- File `src/config.js`: validated env config, frozen object, exit(1) nếu thiếu required vars (đã có từ T1)
- File `src/index.js`: stub bootstrap (T6 sẽ implement đầy đủ)
- Files scaffold: `package.json`, `.env.example`, `.gitignore`, `Dockerfile`, `docker-compose.yml`

**Ghi chú kỹ thuật:**  
- Dùng `eventsource` npm package cho SSE (Node.js không có native EventSource)  
- Firebase REST auth: `?auth=FIREBASE_DB_SECRET` — legacy secret token, không cần service account JSON  
- rtdbBatchPatch dùng multi-path PATCH tới root `/` — Firebase nhận object dạng `{ "/routes/key": data }`  
- rtdbListen initial event: Firebase SSE gửi `put` với `path: "/"` ngay khi connect

---
