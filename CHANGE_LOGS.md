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
- rtdbListen initial event: Firebase SSE gửi `put` với `path: "/"` ngay khi connect — test dựa vào event này

---
