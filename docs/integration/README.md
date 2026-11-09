# Kiểm tra tích hợp với `slr-be` thật

Bộ script này chạy Writing BE **cùng `slr-be` thật** (bản mới nhất của nhánh `dev`) và Firestore/Auth emulator, bằng **token Firebase thật** của emulator. Khác với `docs/demo` của `slr-writing-fe` (dùng `slr-be` giả), ở đây mọi quyết định về quyền đều đi qua `slr-be`:

- đọc project SLR bằng token của người gọi (thành viên, không phải thành viên);
- liên kết project, liệt kê run cho bộ chọn run, import run thật (`from-slr`);
- duyệt H1/H2/H3 chỉ cho **OWNER** (`REQUIRE_SLR_OWNER_FOR_APPROVAL=true`).

Kết quả lần chạy 2026-11-06 (`slr-be@7931e86`) nằm ở mục "Kết quả" bên dưới.

## Chuẩn bị

Các lệnh chạy từ thư mục chứa các repo; `<scratch>` là thư mục tạm bất kỳ (đừng dùng bản `slr-be` đang làm việc của bạn, vì seed ghi vào emulator nhưng `npm ci` và `.env` sẽ ghi vào thư mục).

1. Clone `slr-be` bản mới và cài:
   ```bash
   git clone --depth 1 --branch dev https://github.com/ResearchPulse/slr-be.git <scratch>/slr-be-latest
   cd <scratch>/slr-be-latest && npm ci
   ```
2. Tạo `<scratch>/slr-be-latest/.env` tối thiểu (không có `FIREBASE_PRIVATE_KEY` để dùng chế độ emulator):
   ```
   PORT=5000
   NODE_ENV=development
   DEV_AUTH_ENABLED=false
   FIREBASE_PROJECT_ID=slr-system-dev
   FIRESTORE_EMULATOR_HOST=127.0.0.1:18080
   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
   PDF_PROCESSING_ENABLED=false
   ```
3. Auth emulator: làm theo `slr-writing-fe/docs/demo/README.md` (bước 1). Firestore emulator cần Java 21; trong `slr-be-latest`:
   ```bash
   ./node_modules/.bin/firebase emulators:start --only firestore --project slr-system-dev
   ```
4. Seed dự án SLR mẫu (6 bài, dữ liệu rà soát, run A1–A10) rồi chạy `slr-be`:
   ```bash
   npx tsx src/scripts/seed-slr-artifacts-demo.ts rich
   npx tsx src/server.ts
   ```
5. Tạo ba người dùng trong Auth emulator với **uid trùng người dùng đã seed** (OWNER, REVIEWER) và một người ngoài:
   ```bash
   for u in "leader_user|leader@slr.local" "reviewer_test_1|reviewer1@slr.local" "outsider_user|outsider@example.com"; do
     id=${u%%|*}; em=${u##*|}
     curl -s -X POST "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/slr-system-dev/accounts" \
       -H "Content-Type: application/json" -H "Authorization: Bearer owner" \
       -d "{\"localId\":\"$id\",\"email\":\"$em\",\"password\":\"Demo@12345\",\"displayName\":\"$id\",\"emailVerified\":true}"
   done
   ```
6. Writing BE chế độ tích hợp (cổng 5121, trong `slr-writing-be`):
   ```bash
   npx tsx docs/integration/writing-be.mts
   ```

## Chạy

```bash
node docs/integration/flow-link-import-roles.mjs   # quyền, liên kết, bộ chọn run, import, duyệt owner-only
node docs/integration/flow-pipeline.mjs            # gắn độ phủ RQ, plans, soạn, verification, H2, H3, export
```

Chạy lại `flow-link-import-roles.mjs` tạo thêm project mới trong Postgres dev; `flow-pipeline.mjs` làm tiếp trên project "Leader project" của lần chạy gần nhất.

## Kết quả (2026-11-06)

| Kiểm tra | Kết quả |
| --- | --- |
| Cùng một token Firebase được cả `slr-be` và Writing BE chấp nhận | Đạt |
| Người ngoài đọc project SLR / liên kết project | 403 `FORBIDDEN` / 403 `SLR_PROJECT_ACCESS_DENIED` |
| Thành viên REVIEWER duyệt artifact trên `slr-be` | 403 (chỉ OWNER duyệt được) |
| Bộ chọn run với run thật sau khi OWNER duyệt A1/A2/A7/A10 | `importable: true`, `complete: true` |
| Import run thật (`from-slr`) | 201, snapshot `READY`, cảnh báo thật (`NO_EVIDENCE`, `VALUE_DRIFT`, `CORPUS_ISSUE`) |
| REVIEWER duyệt H1 và H3 trên project của chính họ | 403 `APPROVAL_REQUIRES_OWNER` (đã kiểm cả trên giao diện) |
| OWNER duyệt H1 khi dàn ý chưa gắn câu hỏi nghiên cứu | 422 `BLUEPRINT_NOT_APPROVABLE` (đúng thiết kế: phải gắn độ phủ trước) |
| Sau khi gắn độ phủ RQ: H1, plans, soạn Mở đầu và Thảo luận, verification | Chạy được |
| Export với dữ liệu seed | **Bị chặn đúng thiết kế**, xem dưới |

### Vì sao export bị chặn với dữ liệu seed

Dữ liệu seed của `slr-be` **không có evidence** (không có full text và trích nguyên văn). Hệ quả, đều là hành vi fail-closed đúng:

- 9/9 đoạn Results là `NEEDS_EVIDENCE`, nên Results (section bắt buộc) không soạn được và H3 nói rõ lý do.
- LLM giả luôn viết `[E-01]`, `[E-02]`; dữ liệu thật không có ID đó, nên G1 báo "trích dẫn không nhận diện được". Đây là cổng G1 làm đúng việc.

Muốn đi hết tới export trên dữ liệu thật cần một run có evidence thật (xem lộ trình trong `PROJECT_GUIDE.md`, mục "Chưa chốt").
