# Hướng dẫn cấu hình và triển khai `s3-proxy`

Tài liệu này hướng dẫn cách cấu hình và triển khai dự án `s3-proxy` bằng tiếng Việt. Nội dung bám theo mã nguồn hiện tại trong repo, bao gồm cấu hình môi trường, Firebase Realtime Database, backend S3 và cách chạy bằng Node.js hoặc Docker Compose.

## 1. Mục đích

`s3-proxy` cung cấp một S3 endpoint logic duy nhất cho client, nhưng dữ liệu thật được phân phối qua nhiều tài khoản S3-compatible ở backend. Proxy dùng:

- SQLite làm control plane cục bộ.
- Firebase RTDB để đồng bộ metadata giữa các instance.
- Nhiều tài khoản S3-compatible để mở rộng dung lượng lưu trữ.

## 2. Yêu cầu trước khi triển khai

Bạn nên chuẩn bị sẵn:

- Node.js `>= 20`
- `npm` hoặc `pnpm`
- Docker và Docker Compose nếu muốn chạy bằng container
- Một Firebase Realtime Database đang hoạt động
- Ít nhất một backend S3-compatible account, ví dụ:
  - AWS S3
  - Cloudflare R2
  - Supabase Storage S3 endpoint
  - MinIO

## 3. Chuẩn bị Firebase Realtime Database

Ứng dụng giao tiếp với RTDB bằng REST API và SSE, sử dụng:

- `FIREBASE_RTDB_URL`: URL gốc của database
- `FIREBASE_DB_SECRET`: database secret dùng cho REST/SSE

Ví dụ:

```env
FIREBASE_RTDB_URL=https://your-project-default-rtdb.asia-southeast1.firebasedatabase.app
FIREBASE_DB_SECRET=your_database_secret
```

### 3.1. Cấu trúc dữ liệu RTDB

Proxy sử dụng các nhánh sau:

- `/accounts`: danh sách tài khoản backend
- `/routes`: metadata object đã đồng bộ
- `/instances`: heartbeat của từng instance proxy

### 3.2. Rules tham khảo

Repo đã có sẵn file [`database.rules.json`](/H:/nodejs-tester/s3-proxy/database.rules.json). Nếu bạn cần áp rules nhanh, có thể dùng nội dung đó làm điểm khởi đầu.

### 3.3. Thêm backend account vào RTDB

Tạo một record tại `/accounts/{accountId}` với định dạng:

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

Ý nghĩa nhanh:

- `accessKeyId`, `secretAccessKey`: thông tin xác thực backend S3
- `endpoint`: endpoint S3-compatible
- `region`: region backend
- `bucket`: bucket vật lý ở backend
- `quotaBytes`: quota tối đa của account
- `usedBytes`: dung lượng đã dùng
- `active`: `true` để cho phép nhận upload mới
- `addedAt`: timestamp mili-giây

## 4. Cấu hình biến môi trường

Từ thư mục gốc của repo:

```bash
cp .env.example .env
# PowerShell: Copy-Item .env.example .env
```

Sau đó cập nhật `.env`.

### 4.1. Biến bắt buộc

```env
PROXY_API_KEY=your-proxy-api-key
FIREBASE_RTDB_URL=https://your-project-default-rtdb.firebaseio.com
FIREBASE_DB_SECRET=your_database_secret
```

- `PROXY_API_KEY`: khóa client phải gửi qua header `x-api-key` hoặc `Authorization: Bearer <key>`
- `FIREBASE_RTDB_URL`: URL gốc RTDB, không cần thêm `.json`
- `FIREBASE_DB_SECRET`: secret dùng để gọi RTDB REST API

### 4.2. Biến tùy chọn

| Biến | Mặc định | Giải thích |
| --- | --- | --- |
| `PORT` | `3000` | Cổng HTTP của proxy |
| `QUOTA_THRESHOLD` | `0.90` | Ngưỡng quota để chọn account upload |
| `QUOTA_POLL_INTERVAL_MS` | `300000` | Chu kỳ kiểm tra quota backend |
| `QUOTA_DRIFT_THRESHOLD_RATIO` | `0.05` | Ngưỡng lệch quota trước khi tự sửa |
| `RECONCILE_INTERVAL_MS` | `900000` | Chu kỳ reconcile metadata và backend |
| `INVENTORY_SCAN_PAGE_SIZE` | `500` | Kích thước page khi scan inventory backend |
| `PENDING_SYNC_BATCH_SIZE` | `200` | Số route chờ sync RTDB mỗi lượt |
| `RTDB_SYNC_BATCH_SIZE` | `400` | Kích thước batch patch lên RTDB |
| `DRAIN_TIMEOUT_MS` | `30000` | Thời gian chờ shutdown |
| `LOG_LEVEL` | `info` | Mức log pino |
| `WEBHOOK_ALERT_URL` | rỗng | Webhook cảnh báo tùy chọn |
| `INSTANCE_ID` | tự sinh | ID instance; nên đặt cố định khi chạy nhiều node |
| `SQLITE_PATH` | `./data/routes.db` | Đường dẫn file SQLite |
| `LRU_MAX` | `10000` | Số phần tử cache metadata tối đa |
| `LRU_TTL_MS` | `300000` | TTL cache metadata |

### 4.3. Mẫu `.env`

```env
PROXY_API_KEY=change-me
FIREBASE_RTDB_URL=https://your-project-default-rtdb.asia-southeast1.firebasedatabase.app
FIREBASE_DB_SECRET=replace-with-secret

PORT=3000
QUOTA_THRESHOLD=0.90
QUOTA_POLL_INTERVAL_MS=300000
QUOTA_DRIFT_THRESHOLD_RATIO=0.05
RECONCILE_INTERVAL_MS=900000
INVENTORY_SCAN_PAGE_SIZE=500
PENDING_SYNC_BATCH_SIZE=200
RTDB_SYNC_BATCH_SIZE=400
DRAIN_TIMEOUT_MS=30000
LOG_LEVEL=info
WEBHOOK_ALERT_URL=
INSTANCE_ID=proxy-a
SQLITE_PATH=./data/routes.db
LRU_MAX=10000
LRU_TTL_MS=300000
```

## 5. Chạy bằng Node.js

### 5.1. Cài dependency

Repo hiện có `package-lock.json`, nên cách an toàn nhất là:

```bash
npm install
```

Nếu bạn dùng `pnpm`, vẫn có thể dùng:

```bash
pnpm install
```

### 5.2. Khởi động ứng dụng

Với Node.js 20, nên nạp `.env` trực tiếp bằng `--env-file`:

```bash
node --env-file=.env src/index.js
```

Lưu ý quan trọng:

- Mã nguồn hiện tại không tự đọc file `.env`.
- Nếu bạn chạy `node src/index.js` mà chưa export biến môi trường từ trước, ứng dụng sẽ dừng do thiếu biến bắt buộc.

### 5.3. Chạy ở chế độ phát triển

```bash
node --env-file=.env --watch src/index.js
```

## 6. Chạy bằng Docker Compose

Repo đã có sẵn [`docker-compose.yml`](/H:/nodejs-tester/s3-proxy/docker-compose.yml) và [`Dockerfile`](/H:/nodejs-tester/s3-proxy/Dockerfile).

### 6.1. Khởi động

```bash
docker compose up -d --build
```

Theo cấu hình hiện tại, Compose sẽ tạo 3 service:

- `proxy-1` lắng nghe ở host port `3001`
- `proxy-2` lắng nghe ở host port `3002`
- `proxy-3` lắng nghe ở host port `3003`

Mỗi service đều đọc biến từ file `.env`, sau đó override thêm:

```env
INSTANCE_ID=proxy-1
INSTANCE_ID=proxy-2
INSTANCE_ID=proxy-3
```

### 6.2. Lưu ý về SQLite volume

Cấu hình Compose hiện tại mount cùng một volume `proxy-data` vào `/app/data` cho cả 3 container. Điều đó có nghĩa là các container đang dùng chung file SQLite.

Nếu bạn muốn mỗi instance có control plane cục bộ riêng đúng theo mô hình đồng bộ qua RTDB, nên sửa Compose để mỗi service có volume riêng và giữ `INSTANCE_ID` khác nhau.

## 7. Kiểm tra sau khi triển khai

### 7.1. Health check

```bash
curl http://localhost:3000/health
```

Hoặc nếu chạy Compose:

```bash
curl http://localhost:3001/health
```

Kết quả mong đợi là JSON có các nhóm thông tin:

- `status`
- `accounts`
- `routes`
- `rtdb`
- `quota`

### 7.2. Metrics

```bash
curl http://localhost:3000/metrics
```

Endpoint này không yêu cầu API key.

### 7.3. Gọi thử S3 proxy

Ví dụ upload object:

```bash
curl -X PUT "http://localhost:3000/mybucket/hello.txt" -H "x-api-key: your-proxy-api-key" -H "Content-Type: text/plain" --data-binary "hello world"
```bash
curl -X PUT "http://localhost:3000/s3-proxy-dem9/hello.txt" -H "x-api-key: your-proxy-api-key" -H "Content-Type: text/plain" --data-binary "hello world"
```

Trên PowerShell, nếu cần tránh alias `curl`, hãy dùng `curl.exe`.

Ví dụ list bucket:

```bash
curl "http://localhost:3000/mybucket?list-type=2" -H "x-api-key: your-proxy-api-key"
```

Trên PowerShell, nếu cần tránh alias `curl`, hãy dùng `curl.exe`.

## 8. Kiểm thử nhanh

Chạy test:

```bash
npm test
```

Nếu cần kiểm tra phần Firebase:

```bash
npm run test:firebase
```

## 9. Gợi ý cấu hình production

- Đặt `INSTANCE_ID` cố định cho từng instance.
- Đặt `SQLITE_PATH` trên ổ đĩa bền vững, không dùng thư mục tạm.
- Bật `WEBHOOK_ALERT_URL` nếu bạn cần cảnh báo khi có lỗi nghiêm trọng.
- Giữ `LOG_LEVEL=info` hoặc `warn` cho production; chỉ dùng `debug` khi cần điều tra.
- Đảm bảo RTDB có thể truy cập từ tất cả proxy instance.
- Đảm bảo các backend S3 account đều hỗ trợ path-style request hoặc tương thích với cách proxy đang ký request.

## 10. Sự cố thường gặp

### Thiếu biến môi trường bắt buộc

Ứng dụng sẽ thoát ngay khi thiếu một trong các biến:

- `PROXY_API_KEY`
- `FIREBASE_RTDB_URL`
- `FIREBASE_DB_SECRET`

### RTDB tạm thời không truy cập được

Proxy vẫn có thể khởi động với trạng thái cục bộ từ SQLite, nhưng:

- không backfill đầy đủ từ RTDB
- không nghe được thay đổi `/accounts` và `/routes`
- đồng bộ đa instance sẽ bị chậm hoặc gián đoạn

### Upload không được phân bổ sang account mới

Kiểm tra:

- account trong `/accounts` có `active: true`
- `quotaBytes` đủ lớn
- `usedBytes` không vượt `QUOTA_THRESHOLD`

### Health trả về degraded hoặc 503

Kiểm tra:

- file SQLite có đọc/ghi được không
- RTDB có truy cập được không
- log khởi động có báo lỗi `rtdb unreachable` hoặc `SQLite query failed` không

## 11. Tóm tắt quy trình tối thiểu

1. Tạo `.env` từ `.env.example`.
2. Điền `PROXY_API_KEY`, `FIREBASE_RTDB_URL`, `FIREBASE_DB_SECRET`.
3. Thêm ít nhất một account vào `/accounts/{accountId}` trên RTDB.
4. Chạy `node --env-file=.env src/index.js` hoặc `docker compose up -d --build`.
5. Kiểm tra `/health`, `/metrics` và thử upload/list object.
