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
