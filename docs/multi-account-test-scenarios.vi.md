# Kich ban kiem thu multi-account cho `s3-proxy`

Tai lieu nay mo ta cac kich ban kiem thu de xac nhan proxy phan bo object qua nhieu backend account va van giu dung cac luong S3 thong dung.

## 1. Luu y ve chien luoc chon account

Proxy hien tai khong dung round-robin cung.

No chon account theo 2 quy tac:

- Chi chon account active ma `(used_bytes + size_upload) / quota_bytes < QUOTA_THRESHOLD`
- Trong cac account hop le, uu tien account co `used_bytes` thap nhat

Neu object da co metadata truoc do, lan `PUT` overwrite se giu nguyen account cu neu route van con ton tai.

## 2. Kich ban tu dong da co

File test: `test/multi-account.test.js`

Chay rieng:

```bash
npm run test:multi-account
```

Hoac chay cung toan bo suite:

```bash
npm test
```

### Kich ban 1: Tao va xoa bucket rong

- `PUT /empty-bucket` -> `200`
- `DELETE /empty-bucket` -> `204`

Muc tieu: xac nhan logical bucket create/delete co hoat dong khi bucket chua co object.

### Kich ban 2: Upload duoc phan bo qua 2 account backend

Thiet lap:

- `acc1`: quota rat nho, la account duoc chon dau tien
- `acc2`: quota lon hon

Buoc test:

1. `PUT /rotating-bucket/alpha.txt`
2. `PUT /rotating-bucket/beta.txt`
3. Kiem tra metadata trong SQLite
4. Kiem tra object that su ton tai tren dung fake upstream

Ky vong:

- `alpha.txt` vao `acc1`
- `beta.txt` vao `acc2`

### Kich ban 3: Cac luong S3 thong dung tren bucket co object nam o nhieu account

Buoc test:

1. `GET /rotating-bucket/alpha.txt`
2. `GET /rotating-bucket/beta.txt`
3. `HEAD /rotating-bucket/beta.txt`
4. `GET /rotating-bucket?list-type=2`
5. `DELETE /rotating-bucket`

Ky vong:

- `GET` tra dung body theo tung object
- `HEAD` tra header, khong co body
- `LIST` nhin thay object tu ca 2 account trong cung logical bucket
- `DELETE bucket` tra `409 BucketNotEmpty` khi van con object

### Kich ban 4: Xoa object va xoa bucket sau khi rong

Buoc test:

1. `DELETE /rotating-bucket/alpha.txt`
2. `DELETE /rotating-bucket/beta.txt`
3. `GET /rotating-bucket/alpha.txt`
4. `GET /rotating-bucket?list-type=2`
5. `DELETE /rotating-bucket`

Ky vong:

- Route duoc danh dau `DELETED`
- Object khong con xuat hien trong LIST
- `GET` object da xoa tra `404`
- Bucket co the xoa khi da rong

### Kich ban 5: Chuyen sang account khac khi account hien tai sap day

Thiet lap:

- `acc1` co `used_bytes` thap hon `acc2`, nhung neu nhan them upload moi se vuot `QUOTA_THRESHOLD`
- `acc2` van con kha dung

Buoc test:

1. Cap nhat `used_bytes` de `acc1` la account it dung hon nhung vuot threshold neu ghi them
2. `PUT /threshold-bucket/gamma.txt`

Ky vong:

- Proxy bo qua `acc1`
- Object moi duoc luu sang `acc2`

### Kich ban 6: Overwrite giu nguyen account da co metadata

Buoc test:

1. Sau khi `gamma.txt` da nam tren `acc2`, dieu chinh `used_bytes` de `acc1` trong "rong" hon
2. `PUT /threshold-bucket/gamma.txt` voi payload moi
3. `GET /threshold-bucket/gamma.txt`

Ky vong:

- Route van tro den `acc2`
- Object tren `acc2` duoc cap nhat body moi
- Object khong bi chuyen backend chi vi co account khac trong hon

## 3. Goi y mo rong them

Neu muon test sau hon tren moi truong that, nen them:

- Multipart upload tren nhieu account
- Truong hop tat ca account deu day -> `507 InsufficientStorage`
- Nhieu proxy instance doc chung RTDB va tai lai route/account sau khi co thay doi
- Reconcile khi metadata noi object ton tai nhung backend tra `404`
