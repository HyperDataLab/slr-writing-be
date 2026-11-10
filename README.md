# slr-writing-be

Backend của phân hệ **SLR AI Writing** thuộc hệ thống ResearchPulse. Phân hệ này lấy kết quả đã được xác nhận từ hệ thống SLR (`slr-be`), kiểm chứng lại bằng chứng và hỗ trợ viết thành bản thảo bài báo khoa học.

> Tài liệu nội bộ. Dự án đang ở giai đoạn khởi tạo (Phase 0), mới có bộ khung và endpoint health check.

## Mục tiêu

- Nhập kết quả SLR đã duyệt và tạo **snapshot bất biến** có version và hash.
- Quản lý **Evidence Registry**: study, finding, evidence, source anchor.
- Lập outline và kế hoạch từng đoạn (ParagraphPlan) trước khi sinh văn bản.
- Sinh văn bản bằng LLM, giới hạn trong bằng chứng đã duyệt, không tự tạo citation, số liệu hay finding.
- Kiểm chứng citation và claim, tạo issue và cho người dùng duyệt, sửa.
- Xuất bản thảo kèm báo cáo chất lượng và audit trail.

Nguyên tắc cốt lõi:

1. Viết từ snapshot đã duyệt, không viết từ dữ liệu chưa xác nhận.
2. Writer không được sửa nội dung khoa học (finding, số liệu, reference).
3. Citation chỉ lấy từ registry.
4. Chặn export khi còn lỗi nghiêm trọng (fail-closed).
5. Con người duyệt tại 3 điểm: outline (H1), nội dung (H2), bản cuối (H3).

Thiết kế chi tiết nằm trong tài liệu `SLR_AI_Writing_Implementation_Roadmap.md` (12 stage S0 đến S11, các phase 0 đến 7).

## Công nghệ

| Thành phần | Công nghệ |
|---|---|
| Runtime | Node.js 22, TypeScript (ESM, NodeNext) |
| Web framework | Express 4 (cùng phiên bản với `slr-be`) |
| Tài liệu API | Swagger UI (`swagger-ui-express`, OpenAPI 3) |
| Database | PostgreSQL 16 (Docker) + Prisma 7 |
| Validate | zod 3 |
| Log | pino (tự che các trường nhạy cảm) |
| Test | vitest, supertest |

Chưa chốt: nhà cung cấp LLM, hàng đợi job.

Vì sao dùng PostgreSQL thay vì Firestore như `slr-be`: hệ thống cần ràng buộc khóa ngoại giữa finding, evidence, study và source anchor, snapshot bất biến, audit log chỉ ghi thêm, và truy vết ngược một câu về nguồn bằng truy vấn quan hệ. Dữ liệu từ `slr-be` được lấy qua API rồi lưu thành snapshot riêng, nên hai database không cần JOIN với nhau.

## Cài đặt và chạy

Yêu cầu: Node.js 22 trở lên, Docker (để chạy PostgreSQL).

```bash
npm install              # tự chạy prisma generate
cp .env.example .env     # chỉnh lại giá trị nếu cần
npm run db:up            # bật PostgreSQL trong Docker (cổng 5433)
npm run dev              # chạy ở chế độ watch, cổng 5100
```

PostgreSQL dùng cổng máy chủ 5433 (không phải 5432) để không đụng Postgres cài sẵn trên máy. Dữ liệu được giữ trong Docker volume `slr_writing_pgdata`. Xóa luôn dữ liệu bằng `docker compose down -v`.

Sau khi chạy:

- Health check: http://localhost:5100/api/health
- Swagger UI: http://localhost:5100/api-docs
- OpenAPI JSON: http://localhost:5100/api-docs.json

## API hiện có

Prefix `/api`. Chi tiết trong Swagger. Mọi route (trừ `/api/health`) cần xác thực.

| Method | Đường dẫn | Mục đích |
|---|---|---|
| POST, GET, PUT | `/projects/:projectId/snapshots/:snapshotId/manuscript/blueprint` | Dàn ý bản thảo: sinh bằng quy tắc, xem, sửa theo phiên bản |
| POST | `.../manuscript/blueprint/approve`, `.../reject` | **H1**: chỉ OWNER của project SLR trên `slr-be` duyệt hoặc từ chối dàn ý |
| GET | `/llm/status` | Có mô hình ngôn ngữ (Gemini) sẵn sàng không. Không có route gửi văn bản cho mô hình; chỉ các bước viết gọi nó |
| GET | `/journal-profiles`, `/journal-profiles/:profileId` | Profile khung bài báo (`generic-imrad` 1 cột, `ieee-conference` 2 cột chuẩn hội thảo) |
| POST, GET | `/projects` | Tạo, liệt kê dự án của người dùng |
| GET | `/projects/:projectId` | Chi tiết một dự án (dự án của người khác trả 404) |
| POST | `/projects/:projectId/snapshots/validate` | Kiểm tra một run của `slr-be` có đủ điều kiện viết không, không lưu gì |
| POST | `/projects/:projectId/snapshots` | Import run thành snapshot. 201 mới, 200 đã import trước đó, 422 nếu có lỗi chặn |
| GET | `/projects/:projectId/snapshots` | Danh sách snapshot |
| GET | `/projects/:projectId/snapshots/:snapshotId` | Chi tiết, số dòng dữ liệu, trạng thái artifact, danh sách cảnh báo |
| POST | `/projects/:projectId/snapshots/:snapshotId/manuscript/methods` | Sinh phần Methods từ snapshot bằng mẫu cố định (201 phiên bản mới, 200 không đổi) |
| GET | `/projects/:projectId/snapshots/:snapshotId/manuscript/methods` | Phiên bản Methods mới nhất và danh sách phiên bản |
| POST, GET | `.../manuscript/export` | Gói nộp bài M9: kiểm tra và đóng gói 7 file học thuật bất biến sau khi duyệt H3 |
| GET | `.../manuscript/export/download` | Tải gói nộp bài nén PKZIP (`submission-package.zip`) |
| GET | `.../manuscript/export/download-pdf` | Tải hoặc duyệt trực tiếp bài báo PDF chuẩn IEEE 2 cột hoặc IMRaD 1 cột (`?format=ieee\|imrad&inline=0\|1`) |
| GET | `.../manuscript/lineage` | Truy vết ngược nguồn bằng chứng từ từng câu bản nháp |

### Lệnh Xuất Bản Thảo PDF

```bash
npm run export:pdf        # Xuất cả 2 định dạng (IEEE 2 cột + IMRaD 1 cột)
npm run export:pdf:ieee   # Xuất định dạng IEEE Two-Column Conference
npm run export:pdf:imrad  # Xuất định dạng Generic IMRaD Single-Column
```

Body của `validate` và import là `{ run, corpus, artifacts }` lấy từ API của `slr-be` (xem `docs/slr-be-survey.md`).

**Xác thực:** hiện chỉ có xác thực dev (`DEV_AUTH_ENABLED=true`, không chạy được ở production). Xác minh token Firebase của `slr-be` (ADR-001) chưa được nối. Khi chưa có xác thực hợp lệ, mọi request bị từ chối (401).

## Biến môi trường

Xem `.env.example`.

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `NODE_ENV` | `production` | `development`, `production` hoặc `test` |
| `PORT` | `5100` | Cổng server |
| `LOG_LEVEL` | tự chọn theo môi trường | `fatal` đến `trace`, hoặc `silent` |
| `LOG_PRETTY` | `true` khi development | Log dễ đọc cho môi trường dev |
| `FRONTEND_URL` | `http://localhost:5173,http://localhost:3000` | Danh sách origin được phép (CORS), cách nhau bằng dấu phẩy |
| `SLR_API_BASE_URL` | `http://localhost:5000` | Địa chỉ backend `slr-be` |
| `DEV_AUTH_ENABLED` | `false` | Bật xác thực dev. Bị bỏ qua khi `NODE_ENV=production` |
| `DEV_AUTH_UID` | `dev_user` | Người dùng mặc định của xác thực dev. Header `X-Dev-User-Id` ghi đè để thử nhiều người dùng |
| `JSON_BODY_LIMIT` | `50mb` | Kích thước tối đa của body JSON (corpus của `slr-be` có thể lớn) |
| `DATABASE_URL` | `postgresql://slr_writing:slr_writing@localhost:5433/slr_writing?schema=public` | Chuỗi kết nối PostgreSQL, khớp với `docker-compose.yml` |

Không commit file `.env`.

## Scripts

| Lệnh | Mô tả |
|---|---|
| `npm run dev` | Chạy dev, tự reload (`tsx watch`) |
| `npm run build` | Biên dịch TypeScript ra `dist/` |
| `npm start` | Chạy bản đã build |
| `npm test` | Chạy toàn bộ test một lần |
| `npm run test:watch` | Chạy test ở chế độ watch |
| `npm run typecheck` | Kiểm tra kiểu, không sinh file |
| `npm run db:up` / `db:down` | Bật / tắt PostgreSQL trong Docker |
| `npm run db:generate` | Sinh Prisma Client vào `src/generated/prisma` (không commit) |
| `npm run db:migrate` | Tạo và áp dụng migration ở máy dev (`prisma migrate dev`) |
| `npm run db:deploy` | Áp dụng migration có sẵn (dùng cho CI, môi trường thật) |
| `npm run db:studio` | Mở Prisma Studio để xem dữ liệu |

## Cấu trúc thư mục

```
src/
├─ app.ts            Tạo Express app (middleware, routes, error handler)
├─ server.ts         Khởi động server, tắt an toàn khi nhận SIGTERM/SIGINT
├─ routes.ts         Gom route của các module dưới /api
├─ config/           env (zod), logger, openapi
├─ middleware/       auth, error, request-logger, validation
├─ generated/        Prisma Client sinh tự động (không commit)
├─ shared/           error dùng chung, type dùng chung
└─ modules/
   ├─ health/            Health check (đã có)
   ├─ projects/          Dự án viết, gắn với một project SLR (đã có)
   ├─ snapshots/         Import run từ slr-be, readiness, snapshot (đã có)
   ├─ evidence/          Study, finding, evidence, source anchor
   ├─ journal-profiles/  Yêu cầu của tạp chí
   ├─ manuscripts/       Bản thảo, outline, paragraph plan, draft
   ├─ verification/      Kiểm chứng citation, claim và quality gate
   ├─ export/            Xuất bản thảo và audit
   ├─ jobs/              Quản lý job chạy dài
   └─ llm/               Lớp trừu tượng gọi LLM
prisma/               schema.prisma và migrations (schema snapshot Phase 1)
prisma.config.ts      Cấu hình Prisma (URL kết nối)
docker-compose.yml    PostgreSQL cho môi trường dev
tests/                Test (vitest)
docs/                 Tài liệu thiết kế
```

Các module ngoài `health` hiện là thư mục trống, sẽ được triển khai theo từng phase.

## Quy ước

- **Tên file:** `<tên>.routes.ts`, `<tên>.controller.ts`, `<tên>.service.ts` trong thư mục module.
- **Import:** có đuôi `.js` (yêu cầu của ESM với NodeNext), ví dụ `import x from './x.js'`.
- **Response thành công:** `{ "success": true, "data": ... }`.
- **Response lỗi:** `{ "success": false, "error": { "code", "message", "requestId" } }`. Mã lỗi nằm trong `AppError`.
- **Request ID:** mỗi request có header `X-Request-Id`, dùng để truy vết log.
- **Validate input:** dùng middleware `validate(schema)` với zod.

## Quy trình làm việc với Git

- `main`: nhánh ổn định, chỉ cập nhật qua Pull Request.
- `dev`: nhánh tích hợp.
- Làm việc trên nhánh con (ví dụ `<tên>/feat/<nội-dung>`), mở PR vào `dev`.
- Commit theo dạng `feat:`, `fix:`, `chore:`, `docs:`, `test:`.

## Liên quan

- `slr-be`, `slr-fe`: hệ thống SLR, nguồn dữ liệu đầu vào.
- `slr-writing-fe`: giao diện cho phân hệ này (dự kiến).
