# SLR AI Writing (`slr-writing-be`) — Hướng dẫn dự án cho team và AI-Agent

> **Cách dùng file này.** Gửi nguyên file cho một AI-Agent (hoặc thành viên mới) trước khi giao việc. Sau khi đọc, người đọc phải biết: hệ thống để làm gì, đã làm đến đâu, quy tắc nào không được vi phạm, code nằm ở đâu, cách chạy và test, và module tiếp theo cần làm gì.
>
> - Cập nhật lần cuối: **2026-10-30**. Khi code và file này lệch nhau thì **code đúng**; hãy sửa file này.
> - Tài liệu nền: `docs/SLR_AI_Writing_Implementation_Roadmap.md` (thiết kế đầy đủ, nhiều phần là *đề xuất*), `docs/mvp-scope.md`, `docs/slr-be-survey.md`, `docs/adr/`.
> - `spec.md` ở gốc repo là bản chụp cũ (lúc repo mới khởi tạo). **File này thay thế nó** cho mọi mục về trạng thái hiện tại.

---

## Mục lục

1. [Hệ thống làm gì](#1-hệ-thống-làm-gì)
2. [Nguyên tắc bắt buộc](#2-nguyên-tắc-bắt-buộc)
3. [Kiến trúc tổng thể](#3-kiến-trúc-tổng-thể)
4. [Luồng end-to-end](#4-luồng-end-to-end)
5. [Trạng thái hiện tại](#5-trạng-thái-hiện-tại)
6. [Stack và cấu trúc thư mục](#6-stack-và-cấu-trúc-thư-mục)
7. [Mô hình dữ liệu](#7-mô-hình-dữ-liệu)
8. [API hiện có](#8-api-hiện-có)
9. [Nhập snapshot và kiểm tra sẵn sàng](#9-nhập-snapshot-và-kiểm-tra-sẵn-sàng)
10. [Tích hợp với `slr-be` (đã kiểm chứng trên dữ liệu thật)](#10-tích-hợp-với-slr-be-đã-kiểm-chứng-trên-dữ-liệu-thật)
11. [Xác thực và phân quyền](#11-xác-thực-và-phân-quyền)
12. [Chạy local, test, migration](#12-chạy-local-test-migration)
13. [Quy trình làm việc của team](#13-quy-trình-làm-việc-của-team)
14. [Quy ước code](#14-quy-ước-code)
15. [Lộ trình các module tiếp theo](#15-lộ-trình-các-module-tiếp-theo)
16. [Checklist thêm một module mới](#16-checklist-thêm-một-module-mới)
17. [Quyết định đã chốt, chưa chốt và rủi ro](#17-quyết-định-đã-chốt-chưa-chốt-và-rủi-ro)
18. [Thuật ngữ](#18-thuật-ngữ)
19. [Prompt mẫu giao việc cho AI-Agent](#19-prompt-mẫu-giao-việc-cho-ai-agent)

---

## 1. Hệ thống làm gì

**SLR AI Writing** là phân hệ *hậu tổng hợp* của hệ thống SLR (`slr-be` + `slr-fe`):

- **Đầu vào:** kết quả Systematic Literature Review đã được người dùng xác nhận (câu hỏi nghiên cứu, các nghiên cứu được đưa vào, finding đã trích, theme/claim, artifact A1–A10, dữ liệu PRISMA).
- **Việc hệ thống làm:** nhập thành *bản chụp bất biến* (snapshot), kiểm chứng lại, lập dàn ý và kế hoạch từng đoạn, sinh văn bản có kiểm soát, kiểm chứng citation và claim.
- **Đầu ra:** bản thảo bài báo (Markdown trước, DOCX để sau) kèm citation manifest và báo cáo chất lượng, trong đó **mỗi câu truy vết được về finding → study → source anchor**.

Quyết định lớn đã chốt: **tự xây writing engine**, không dùng phase cuối của AutoResearchClaw, vì hệ thống cần "Writer không được sửa science", citation chỉ lấy từ registry và có các điểm duyệt của con người. Pipeline viết tự do của công cụ khác đi ngược các nguyên tắc này.

Thông điệp bảo vệ đồ án: **"AI chỉ viết văn, không được đổi số liệu khoa học."** Phần số liệu (Methods/PRISMA, đếm nghiên cứu) có thể sinh *bằng mẫu cố định, không cần LLM*.

---

## 2. Nguyên tắc bắt buộc

Mọi code mới phải tuân thủ. Vi phạm một nguyên tắc là lỗi, kể cả khi test xanh.

| # | Nguyên tắc | Ý nghĩa cho code |
|---|---|---|
| 1 | **Artifact-first** | Chỉ viết từ snapshot có version và hash. Không đọc dữ liệu "live" của `slr-be` để viết. |
| 2 | **Writer không sửa science** | Không đổi finding, số liệu, cỡ mẫu, reference registry. LLM chỉ biên tập văn phong. |
| 3 | **Registry-only citation** | Citation phải trỏ tới ID có trong registry. Không tự tạo DOI hay reference. LLM trả về ID, hệ thống kiểm tra ID thuộc evidence pack. |
| 4 | **Fail-closed** | Không chắc thì chặn. Export bị chặn khi có lỗi critical, citation không tồn tại, PRISMA lệch hoặc thiếu duyệt. `NOT_RUN` **không** phải `PASS`. Thiếu xác thực thì 401. |
| 5 | **Human-accountable** | Người dùng (OWNER của project) duyệt ở 3 điểm: **H1** (dàn ý), **H2** (nội dung), **H3** (bản cuối). Mọi lần duyệt ghi vào `ProvenanceEvent`. |
| 6 | **Explicit / inferred / missing** | Suy luận do AI đề xuất phải gắn `inferred` và có lý do; không trình bày như trích dẫn nguyên văn. Thiếu dữ liệu thì ghi "missing", không bịa. |
| 7 | **Immutable** | Snapshot không bị sửa sau khi tạo. Dữ liệu khác nhau là snapshot khác nhau. Nhật ký provenance chỉ ghi thêm. |
| 8 | **Không đánh đồng khái niệm** | Reference tồn tại ≠ reference hỗ trợ claim. Văn bản trôi chảy ≠ bản thảo hợp lệ. `confidence` của classifier ≠ độ chắc chắn khoa học. |
| 9 | **Policy-aware** | Journal Profile có nguồn chính sách và ngày xác minh; profile mặc định phải ghi rõ "chưa xác minh". |

---

## 3. Kiến trúc tổng thể

```mermaid
flowchart LR
    U[Người dùng / Reviewer / OWNER] --> FE[slr-fe<br/>React, cổng 5173]
    FE -->|Firebase ID token| BE[slr-be<br/>Express 4 + Firestore, cổng 5000]
    FE -. giao diện viết bài<br/>chưa làm .-> W

    subgraph Writing [slr-writing-be, cổng 5100]
      W[API Express 4] --> SVC[Services: snapshots,<br/>projects, slr-client]
      SVC --> PG[(PostgreSQL 16<br/>Prisma 7, cổng 5433)]
      SVC -.->|sau này| LLM[LLMProvider<br/>mock + Gemini]
    end

    W -->|GET, forward token người dùng| BE
    BE --> FS[(Firestore / emulator)]
```

Điểm cần nhớ:

- **Hai hệ thống, hai database.** `slr-be` dùng Firestore. `slr-writing-be` dùng PostgreSQL vì cần khoá ngoại giữa finding/evidence/study/anchor, snapshot bất biến, audit chỉ ghi thêm và truy vết lineage bằng truy vấn quan hệ.
- **Dữ liệu đi một chiều:** `slr-be` → Writing (qua API, bằng token của chính người dùng, ADR-001). Writing **không ghi ngược** vào `slr-be`.
- **Dùng chung Firebase project** với `slr-be` (team đã xác nhận). Nhờ đó cùng một `uid` ở hai hệ thống và token người dùng chuyển tiếp được.
- Mọi dữ liệu lấy từ `slr-be` được **sao chép** vào snapshot (ADR-005); phát hiện dữ liệu cũ bằng `corpus_hash`.

---

## 4. Luồng end-to-end

### 4.1 Từ SLR đến bản thảo (đích đến)

```mermaid
flowchart TD
    A[slr-be: Study Selection → Quality → Extraction → Synthesis] --> B[Tạo run artifact A1–A10<br/>OWNER duyệt A1, A10, A2, A7]
    B --> C[POST /snapshots/from-slr]
    C --> D{Readiness<br/>có lỗi chặn?}
    D -- có --> X[422 SNAPSHOT_NOT_READY<br/>không lưu gì]
    D -- không --> E[(Snapshot bất biến<br/>+ cảnh báo)]
    E --> F[Methods / PRISMA<br/>sinh bằng mẫu cố định]
    E --> G[Journal Profile<br/>IMRaD, chưa xác minh]
    G --> H[Outline / Blueprint]
    E --> H
    H --> H1{{H1: OWNER duyệt dàn ý}}
    H1 --> I[ParagraphPlan<br/>finding + evidence + claim strength]
    I --> J[Sinh văn bản bằng LLM<br/>chỉ dùng evidence pack tối thiểu]
    J --> H2{{H2: OWNER duyệt nội dung}}
    H2 --> K[Citation manifest + Verification]
    K --> L{Quality gates<br/>G1–G7 có FAIL?}
    L -- FAIL / NOT_RUN --> M[Review queue: sửa có kiểm soát<br/>rồi chạy lại gate]
    M --> K
    L -- đạt --> H3{{H3: OWNER duyệt bản cuối}}
    H3 --> N[Export Markdown<br/>+ citation manifest + QA report + audit]
```

Đường ưu tiên cho MVP: `C → D → E → F` (có văn bản đầu tiên không cần LLM), sau đó `G → H → H1`, rồi mới đến LLM.

### 4.2 Nhập snapshot (đã làm xong)

```mermaid
flowchart TD
    S[POST /api/projects/:id/snapshots/from-slr<br/>body: runId] --> O{Người gọi sở hữu<br/>project này?}
    O -- không --> N404[404 PROJECT_NOT_FOUND]
    O -- có --> V{runId hợp lệ?}
    V -- không --> N400[400 INVALID_RUN_ID]
    V -- có --> G1[Gọi slr-be bằng token người dùng:<br/>run → corpus của run → A1,A2,A7,A10<br/>→ PRISMA export → RQ findings]
    G1 -->|lỗi upstream| ER[401/403/404/502/504 SLR_*<br/>không lộ nội dung phía trên]
    G1 --> P[parseInput: zod + quét ký tự không lưu được<br/>+ giới hạn độ sâu 64]
    P --> R[assessReadiness]
    R -->|BLOCKED| U422[422 + báo cáo]
    R -->|READY| H{Đã có snapshot cùng<br/>project+source+run+corpusHash+integrityHash?}
    H -- có --> OK200[200 trả snapshot cũ]
    H -- không --> T[Transaction: lưu mọi bảng<br/>+ ProvenanceEvent snapshot.import]
    T --> OK201[201 snapshot mới + warnings]
```

---

## 5. Trạng thái hiện tại

### Đã xong (kèm bằng chứng)

| Hạng mục | Chi tiết |
|---|---|
| Khung repo | Express 4 + TypeScript ESM, Swagger, pino, CI GitHub Actions (có Postgres), ruleset nhánh |
| Tài liệu | README, spec cũ, khảo sát `slr-be`, MVP scope, ADR-001/005/007/011, roadmap |
| Database | 16 model Prisma, 7 migration. Trigger: `ProvenanceEvent` và `SectionRevision` chặn UPDATE, DELETE và TRUNCATE; `Manuscript` và `ManuscriptSection` chặn đổi khoá (dự án, snapshot, `sectionKey`) |
| Snapshot import | Hợp đồng zod, kiểm tra sẵn sàng, lưu trong transaction, idempotent theo nội dung, hash toàn vẹn |
| API | Project + snapshot (xem [mục 8](#8-api-hiện-có)), xác thực từ chối mặc định |
| Client `slr-be` | Lấy run + corpus của run + A1/A2/A7/A10 + PRISMA export + RQ findings; chặn redirect, timeout, giới hạn kích thước |
| Kiểm chứng dữ liệu thật | (PR #12) Đã import thành công một run thật từ `slr-be`; fixture thật nằm ở `tests/fixtures/real/` |
| Xác thực (M1) | Xác minh token Firebase, kiểm tra quyền khi liên kết project, tắt import tay ở production, rate limit `from-slr` (xem mục 11) |
| Methods (M2) | Sinh phần Methods bằng mẫu cố định từ snapshot, 3 lớp: dữ kiện → câu chữ → kiểm tra số (xem M2 ở mục 15) |
| Dàn ý + H1 (M5) | Sinh dàn ý bằng quy tắc từ profile và snapshot, người dùng sửa theo phiên bản, **OWNER của project SLR duyệt H1** (xem M5 ở mục 15) |
| Journal Profile (M3) | Khung bài báo mặc định `generic-imrad`, luôn "chưa xác minh", schema chặt chống trình bày gợi ý như chính sách (xem M3 ở mục 15) |
| Kiểm thử | Hàng trăm test qua (chạy `npm test` để biết con số hiện tại), gồm các bộ QA độc lập do sub-agent viết trong `tests/qa/` |

### Trạng thái nhánh (lúc viết)

| Nhánh | Tình trạng |
|---|---|
| `dev` | Có PR #9 (schema), #10 (snapshot import + API), #11 (client `slr-be`), #12 (kiểm chứng dữ liệu thật, PRISMA export + RQ findings, QA fix). Đây là trạng thái mà file này mô tả |
| `docs/project-guide` | Chỉ chứa file này + một dòng trỏ trong `spec.md`. Chờ PR vào `dev` |
| `main` | Chậm hơn `dev`; chưa cần gấp |

### Chưa làm (thứ tự khuyến nghị ở [mục 15](#15-lộ-trình-các-module-tiếp-theo))

Thử xác thực với token Firebase thật · kiểm tra vai trò OWNER cho H2 và H3 (H1 đã có) · `LLMProvider` · đề xuất dàn ý bằng LLM · ParagraphPlan · sinh văn bản + H2 · citation manifest + verification + gate · export + H3 · giao diện · siết bảo mật còn lại cho production (CSP, Swagger, `x-request-id`) · trigger bất biến cho bảng con.

---

## 6. Stack và cấu trúc thư mục

| Thành phần | Công nghệ | Ghi chú |
|---|---|---|
| Runtime | Node.js 22, TypeScript, ESM (NodeNext) | import nội bộ **phải có đuôi `.js`** |
| Web | Express **4** | cùng major với `slr-be`; không dùng Express 5 |
| Validate | zod **3** | không dùng zod 4 |
| DB | PostgreSQL 16 (Docker, cổng **5433**) + Prisma **7** | adapter `@prisma/adapter-pg`; client sinh vào `src/generated/prisma` (gitignored) |
| Log | pino | token đã được redact |
| API docs | `swagger-ui-express` | OpenAPI **viết tay** ở `src/config/openapi.ts`; thêm route thì phải thêm vào đó |
| Test | vitest 5 + supertest | test tích hợp chạy trên Postgres thật |

```
slr-writing-be/
├─ docs/
│  ├─ PROJECT_GUIDE.md                     ← file này
│  ├─ SLR_AI_Writing_Implementation_Roadmap.md   thiết kế đầy đủ (S0–S11, Phase 0–7, gate G1–G7)
│  ├─ mvp-scope.md                         phạm vi MVP
│  ├─ slr-be-survey.md                     khảo sát đầu ra của slr-be
│  └─ adr/                                 ADR-001 nguồn dữ liệu, 005 nguồn sự thật, 007 Markdown, 011 database
├─ prisma/
│  ├─ schema.prisma                        13 model (chú thích tiếng Việt)
│  └─ migrations/                          4 migration (SQL)
├─ prisma.config.ts                        URL database (mặc định localhost:5433)
├─ docker-compose.yml                      Postgres 16
├─ src/
│  ├─ server.ts, app.ts, routes.ts         khởi động, middleware, gắn router (/health, /projects)
│  ├─ config/                              env.ts (zod), prisma.ts, logger.ts, openapi.ts
│  ├─ middleware/                          auth, error, request-logger, validate
│  ├─ shared/                              errors/app-error.ts, types/common.types.ts
│  └─ modules/
│     ├─ health/                           GET /api/health
│     ├─ projects/                         tạo/liệt kê/xem project; gắn router snapshots
│     ├─ snapshots/                        ★ lõi hiện tại
│     │   ├─ slr-source.schemas.ts         hợp đồng đầu vào (zod, passthrough)
│     │   ├─ snapshot-readiness.ts         hàm thuần: BLOCKED | READY + issues
│     │   ├─ snapshot-import.service.ts    lưu snapshot (transaction), hash, idempotent
│     │   ├─ snapshots.service.ts          liệt kê / xem (không trả payload lớn)
│     │   └─ snapshots.routes.ts
│     ├─ slr-client/slr-client.ts          ★ gọi slr-be bằng token người dùng
│     ├─ auth/                             firebase-verifier.ts, auth.setup.ts (M1)
│     ├─ methods/                          ★ M2: methods.types / -facts / -renderer / -grounding / .service / .routes
│     ├─ blueprint/                        ★ M5: blueprint.types / -generator / -validator / .service / .routes
│     ├─ approvals/                        approvals.service.ts: kiểm tra OWNER, quyết định mới nhất (dùng chung H1/H2/H3)
│     ├─ journal-profiles/                 ★ M3: journal-profile.schema / default-profile / .service / .routes (bộ sinh hợp lệ: shared/constants/generators.ts)
│     └─ evidence | export | jobs | llm | verification/
│                                          ← thư mục RỖNG, chỗ dành cho module sau
└─ tests/
   ├─ fixtures/synthetic-run.ts            dữ liệu GIẢ (ghi rõ trong file)
   ├─ fixtures/real/slr-be-demo-run.json   run THẬT từ slr-be dev seed (bài báo công khai, user seed)
   ├─ api/ snapshots/ slr-client/          test theo module (slr-client/fake-slr-be.ts = server slr-be giả)
   └─ qa/                                  3 bộ QA độc lập do sub-agent viết
```

---

## 7. Mô hình dữ liệu

Quy ước: `externalId` là ID gốc của `slr-be` (giữ nguyên để truy vết), duy nhất trong một snapshot. Mọi khoá ngoại là `onDelete: Restrict`. Dữ liệu con của `ReviewSnapshot` chỉ được ghi lúc import.

```mermaid
erDiagram
    Project ||--o{ ReviewSnapshot : "có"
    Project ||--o{ ProvenanceEvent : "ghi nhật ký"
    ReviewSnapshot ||--o{ ResearchQuestion : ""
    ReviewSnapshot ||--o{ Study : ""
    ReviewSnapshot ||--o{ SourceDocument : ""
    ReviewSnapshot ||--o{ ExtractedFinding : ""
    ReviewSnapshot ||--o{ Evidence : ""
    ReviewSnapshot ||--o{ Claim : ""
    ReviewSnapshot ||--o{ SnapshotArtifact : "A1,A2,A7,A10"
    ReviewSnapshot ||--o{ SnapshotSupplement : "PRISMA export, RQ findings"
    ReviewSnapshot ||--o{ ProvenanceEvent : ""
    Study ||--o{ SourceDocument : ""
    Study ||--o{ ExtractedFinding : ""
    Study ||--o{ Evidence : ""
    SourceDocument ||--o{ Evidence : "neo vào đoạn"
    ExtractedFinding }o--o{ Evidence : "EvidenceFinding"
    ResearchQuestion ||--o{ Claim : ""
    Claim ||--o{ ClaimItem : ""
    ExtractedFinding ||--o{ ClaimItem : ""
    Study ||--o{ ClaimItem : ""
```

| Model | Vai trò |
|---|---|
| `Project` | Không gian làm việc của người dùng, gắn `ownerId` (uid Firebase) và `slrProjectId`. Duy nhất theo (`ownerId`, `slrProjectId`). |
| `ReviewSnapshot` | Bản sao bất biến của một run. Khoá duy nhất: (`projectId`, `sourceSystem`, `sourceRunId`, `corpusHash`, `integrityHash`). `sourceSystem` = `slr-be` (do service tự lấy) hoặc `manual` (client tự gửi). `status`: IMPORTED/READY/BLOCKED/STALE (hiện chỉ dùng READY). |
| `ResearchQuestion`, `Study`, `SourceDocument` | Nội dung corpus. `Study.doi` giữ `null` nếu nguồn không có, **không tự bổ sung**. |
| `ExtractedFinding` | Giá trị *trích xuất* theo consensus của reviewer (id dạng `F:{paperId}:{fieldId}`). **Không phải** kết luận tổng hợp. |
| `Evidence` | Trích dẫn nguyên văn + vị trí nguồn (page/section/paragraph/tableOrFigure/charStart/charEnd), `quoteHash`, `quoteHashVerified`. Vị trí theo đoạn Markdown, `page` thường `null`. |
| `Claim`, `ClaimItem` | Theme do nhà nghiên cứu định nghĩa trong `slr-be`, là nguồn của "synthesis finding". |
| `SnapshotArtifact` | Payload nguyên vẹn của A1/A2/A7/A10 + trạng thái duyệt/validate. |
| `SnapshotSupplement` | Dữ liệu `slr-be` **không đóng băng theo run**: `prisma_writing_export`, `rq_findings`. Snapshot giữ bản sao tại thời điểm import. |
| `Manuscript` | Bản thảo viết từ đúng một snapshot (duy nhất theo `snapshotId`). |
| `ManuscriptSection` | Một mục của bản thảo, theo `sectionKey` (hiện chỉ `methods`). |
| `BlueprintRevision` | Một phiên bản dàn ý của bản thảo: `content` (mục, tiểu mục, coverage), `profileId`/`profileVersion`, `origin` (`generated` hoặc `edited`), `contentHash`. **Chỉ ghi thêm** (trigger chặn UPDATE, DELETE, TRUNCATE). |
| `Approval` | Một quyết định duyệt (H1/H2/H3): `stage`, `targetKind`/`targetId`/`targetHash`, `decision` (`APPROVED`/`REJECTED`), `note`, `decidedBy`, `slrRole`, `seq` tăng dần. **Chỉ ghi thêm**. Trạng thái = quyết định có `seq` lớn nhất. |
| `SectionRevision` | Một phiên bản của mục: `markdown`, `facts` (kèm đường dẫn nguồn), `warnings`, `generator`, `contentHash`. **Chỉ ghi thêm** (trigger DB chặn UPDATE/DELETE); đổi nội dung = phiên bản mới. |
| `ProvenanceEvent` | Nhật ký chỉ ghi thêm (trigger DB chặn UPDATE/DELETE). Ghi `actor`, `activity`, `inputRefs`, `outputRefs`, `method`. |

**Bảng sẽ cần thêm** (đề xuất, chưa có): `ParagraphPlan`, `DraftParagraph`, `CitationRef`, `ReviewIssue`, `QualityGateResult`, `Approval` (H1/H2/H3), `ExportPackage`. Xem roadmap mục 4.

---

## 8. API hiện có

Tiền tố `/api`. Tài liệu tương tác: `/api-docs` (JSON ở `/api-docs.json`).

### Envelope

```jsonc
// thành công
{ "success": true, "data": { ... } }
// thất bại
{ "success": false, "error": { "code": "SNAPSHOT_NOT_READY", "message": "...", "requestId": "...", "details": { ... } } }
```

### Endpoint

| Method | Đường dẫn | Mô tả | Kết quả |
|---|---|---|---|
| GET | `/health` | Kiểm tra sống | 200 |
| GET | `/journal-profiles` | Danh sách profile khung bài báo (hiện có `generic-imrad`, luôn chưa xác minh) | 200; 401 |
| GET | `/journal-profiles/:profileId` | Một profile: mục, thứ tự, ngân sách từ gợi ý, nguồn dữ liệu, trạng thái xác minh | 200; 401; 404 `JOURNAL_PROFILE_NOT_FOUND` |
| POST | `/projects` | Tạo project `{name, slrProjectId}` | 201; 409 `PROJECT_EXISTS`; 400 `VALIDATION_ERROR` |
| GET | `/projects` | Project của người gọi | 200 |
| GET | `/projects/:projectId` | Xem project | 200; 404 `PROJECT_NOT_FOUND` |
| POST | `/projects/:projectId/snapshots/validate` | Chạy thử readiness, **không lưu** | 200 báo cáo |
| POST | `/projects/:projectId/snapshots` | Import tay (`{run, corpus, artifacts, supplements}`) → `sourceSystem='manual'` | 201 mới / 200 đã có / 422 |
| POST | `/projects/:projectId/snapshots/from-slr` | Body `{runId}`; service tự lấy từ `slr-be` → `sourceSystem='slr-be'` | 201 / 200 / 422 / lỗi `SLR_*` |
| GET | `/projects/:projectId/snapshots` | Danh sách (không payload) | 200 |
| GET | `/projects/:projectId/snapshots/:snapshotId` | Số đếm, trạng thái artifact, supplements (kind/hash), issues | 200; 404 `SNAPSHOT_NOT_FOUND` |
| POST | `/projects/:projectId/snapshots/:snapshotId/manuscript/methods` | Sinh phần Methods từ snapshot (mẫu cố định, không LLM). 201 phiên bản mới, 200 khi văn bản không đổi | 201 / 200; 422 `METHODS_INPUT_MISSING` |
| GET | `/projects/:projectId/snapshots/:snapshotId/manuscript/methods` | Phiên bản mới nhất + danh sách các phiên bản (không kèm văn bản) | 200; 404 `METHODS_NOT_GENERATED` |
| POST | `/projects/:projectId/snapshots/:snapshotId/manuscript/blueprint` | Sinh dàn ý đầu tiên bằng quy tắc. 201 khi tạo, 200 khi đã có (không ghi đè). Body tuỳ chọn `{profileId}` | 201 / 200; 404 `JOURNAL_PROFILE_NOT_FOUND` |
| GET | `/projects/:projectId/snapshots/:snapshotId/manuscript/blueprint` | Phiên bản mới nhất + `issues` + `approvable` + `approval` + danh sách phiên bản | 200; 404 `BLUEPRINT_NOT_FOUND` |
| PUT | `/projects/:projectId/snapshots/:snapshotId/manuscript/blueprint` | Lưu bản sửa thành phiên bản kế tiếp. Body `{baseVersion, content}` | 201 / 200; 400 `INVALID_BLUEPRINT`; 409 `STALE_BLUEPRINT` |
| GET | `/projects/:projectId/snapshots/:snapshotId/manuscript/blueprint/revisions/:version` | Một phiên bản dàn ý kèm trạng thái duyệt của nó | 200; 400 `INVALID_VERSION`; 404 `BLUEPRINT_REVISION_NOT_FOUND` |
| POST | `/projects/:projectId/snapshots/:snapshotId/manuscript/blueprint/approve` | **H1**: duyệt phiên bản mới nhất. Body `{version, note?}`. Chỉ OWNER trên `slr-be` | 201 / 200; 403 `APPROVAL_REQUIRES_OWNER`; 409 `STALE_BLUEPRINT`; 422 `BLUEPRINT_NOT_APPROVABLE` |
| POST | `/projects/:projectId/snapshots/:snapshotId/manuscript/blueprint/reject` | **H1**: từ chối (hoặc rút lại lần duyệt). Body `{version, note}`, ghi chú bắt buộc | 201 / 200; 403; 409 |
| GET | `/projects/:projectId/snapshots/:snapshotId/manuscript/methods/revisions/:version` | Một phiên bản đã lưu | 200; 400 `INVALID_VERSION`; 404 `METHODS_REVISION_NOT_FOUND` |

Mọi route cần xác thực. Project/snapshot của người khác luôn trả **404** (không 403, để không dò được ID).

### Mã lỗi

| Nhóm | Mã |
|---|---|
| Xác thực | `UNAUTHORIZED` (401), `INVALID_TOKEN` (401) |
| Đầu vào | `VALIDATION_ERROR`, `INVALID_JSON`, `PAYLOAD_TOO_LARGE` (413), `INVALID_RUN_ID`, `INVALID_SLR_PROJECT_ID`, `INVALID_IMPORT_INPUT`, `RUN_PROJECT_MISMATCH` (400) |
| Nghiệp vụ | `PROJECT_EXISTS` (409), `PROJECT_NOT_FOUND`, `SNAPSHOT_NOT_FOUND` (404), `SNAPSHOT_NOT_READY` (422, `details` = báo cáo), `SLR_PROJECT_ACCESS_DENIED` (403, người gọi không đọc được SLR project trên `slr-be`; project không tồn tại cũng trả mã này), `MANUAL_IMPORT_DISABLED` (403), `RATE_LIMITED` (429), `JOURNAL_PROFILE_NOT_FOUND` (404), `BLUEPRINT_NOT_FOUND` / `BLUEPRINT_REVISION_NOT_FOUND` (404), `INVALID_BLUEPRINT` / `INVALID_REQUEST` (400), `STALE_BLUEPRINT` (409), `BLUEPRINT_NOT_APPROVABLE` (422, `details.issues`), `APPROVAL_REQUIRES_OWNER` (403), `METHODS_INPUT_MISSING` (422), `METHODS_NOT_GENERATED` / `METHODS_REVISION_NOT_FOUND` (404), `INVALID_VERSION` (400), `METHODS_UNGROUNDED_NUMBER` (500, lỗi lập trình: văn bản có số không nằm trong dữ kiện) |
| Upstream `slr-be` | `SLR_AUTH_REJECTED` (401), `SLR_FORBIDDEN` (403), `SLR_NOT_FOUND` (404), `SLR_UPSTREAM_ERROR`, `SLR_INVALID_RESPONSE`, `SLR_RESPONSE_TOO_LARGE`, `SLR_UNREACHABLE` (502), `SLR_TIMEOUT` (504) |
| Khác | `INTERNAL_SERVER_ERROR` (500) |

Lỗi upstream **không bao giờ** lộ URL, nội dung phản hồi hay stack của `slr-be`.

---

## 9. Nhập snapshot và kiểm tra sẵn sàng

### Lớp bảo vệ trước khi lưu

1. **Quét an toàn** (`assertStorable`): từ chối chuỗi chứa NUL hoặc surrogate lẻ và JSON lồng quá 64 tầng (nếu không, Postgres báo lỗi 500).
2. **Zod** (`slr-source.schemas.ts`): chỉ bắt buộc các trường hệ thống lưu; trường lạ được giữ nguyên (`.passthrough()`) để `slr-be` nâng cấp không làm hỏng import.
3. **Readiness** (hàm thuần `assessReadiness`, dễ test).
4. **Transaction** duy nhất cho mọi bảng; id sinh trước để điền khoá ngoại.

### Mã readiness

**Chặn (`blocking`, trả 422, không lưu gì):**
`CORPUS_HASH_MISMATCH`, `NO_RESEARCH_QUESTIONS`, `NO_STUDIES`, `ARTIFACT_MISSING` / `ARTIFACT_INVALID` / `ARTIFACT_REJECTED` / `ARTIFACT_NOT_APPROVED` / `ARTIFACT_PAYLOAD_MISSING` (A1, A10 bắt buộc), `ARTIFACT_ID_MISMATCH`, `DUPLICATE_ID` (study/document/finding/evidence/claim/RQ/loại artifact/claim item), `UNKNOWN_STUDY` / `UNKNOWN_DOCUMENT` / `UNKNOWN_EVIDENCE` / `UNKNOWN_FINDING` / `UNKNOWN_RESEARCH_QUESTION`, `PRISMA_PROJECT_MISMATCH`.

**Cảnh báo (`warning`, vẫn lưu):**
`OPTIONAL_ARTIFACT_MISSING` / `OPTIONAL_ARTIFACT_NOT_USABLE` (A2, A7), `EXTRACTION_INCOMPLETE`, `QUOTE_NOT_VERIFIED`, `CONSENSUS_MISMATCH`, `CLAIM_ITEM_UNRESOLVED`, `VALUE_DRIFT`, `CORPUS_ISSUE`, `NO_EVIDENCE`, `NO_CLAIMS`, `PRISMA_EXPORT_MISSING`, `PRISMA_COUNT_MISMATCH`, `PRISMA_LIST_MISMATCH`, `PRISMA_DUPLICATE_STUDY`, `PRISMA_UNKNOWN_STUDY`.

> Khi thêm module viết bài, **đọc `snapshot.issues`**: ví dụ `NO_EVIDENCE` nghĩa là không được tạo câu nào dạng "trích dẫn đoạn nguồn".

### Danh tính snapshot

- Cùng (project, nguồn, run, corpusHash, **integrityHash**) → trả snapshot cũ (200).
- Cùng run nhưng nội dung khác (ví dụ PRISMA export đã đổi) → **snapshot mới**; snapshot cũ giữ nguyên.
- Import tay (`manual`) và import qua service (`slr-be`) là hai snapshot khác nhau dù nội dung giống, để lần import tay không thể "chiếm chỗ" nhãn `slr-be`.
- `integrityHash` = sha256 của JSON ổn định (khoá sắp xếp) của corpus + artifacts (+ supplements khi có).

---

## 10. Tích hợp với `slr-be` (đã kiểm chứng trên dữ liệu thật)

### Endpoint của `slr-be` mà client dùng

Tiền tố `/api/projects/:slrProjectId/...`, cần Firebase ID token và vai trò trong project.

| Mục đích | Đường dẫn |
|---|---|
| Run | `synthesis/artifacts/runs/:runId` |
| Corpus **của run** (đóng băng) | `synthesis/artifacts/runs/:runId/artifacts/corpus` |
| Artifact | `synthesis/artifacts/runs/:runId/artifacts/{A1,A2,A7,A10}` |
| PRISMA flow cho Methods | `prisma/writing-export.json` (schema `slr-prisma-writing-v1`) |
| Câu trả lời theo RQ | `synthesis/findings` |

Envelope của `slr-be` **không nhất quán**: `{success,isSuccess,data,message}`, `{success,data}`, hoặc dữ liệu trần. `unwrapEnvelope` xử lý cả ba; `{success:false}` luôn là lỗi.

### Điều dữ liệu thật đã dạy (ghi để không giả định sai lại)

1. Artifact không cần validate có `validation_status = "not_applicable"`, không phải `"valid"`.
2. Dự án chưa có full text → `documents = 0`, `evidence = 0` nhưng vẫn có findings và claims. Run vẫn hợp lệ (→ cảnh báo `NO_EVIDENCE`).
3. A10 *không* luôn chứa số PRISMA (`selection.prisma` có thể `null`, `search_strategy.sources` rỗng). Luồng PRISMA lấy từ `prisma/writing-export.json`.
4. `synthesis/findings` có thể rỗng (researcher chưa viết kết luận theo RQ).
5. PRISMA export và RQ findings **không đóng băng theo run** → phải sao chép vào snapshot lúc import.

### Phòng thủ của client (`slr-client.ts`)

Kiểm tra `runId` bằng regex và chặn `slrProjectId` chỉ gồm dấu chấm; `redirect: 'error'` (token không bao giờ đi sang host khác); timeout mỗi request (`SLR_API_TIMEOUT_MS`, mặc định 15 s; chưa có tổng thời gian); giới hạn phản hồi (`SLR_API_MAX_RESPONSE_BYTES`, 50 MB); phản hồi 404 của PRISMA export/RQ findings = "không có" (bỏ qua), mọi lỗi khác làm hỏng import; kiểm tra `run_id`, `artifact_id`, `artifact_type` khớp với yêu cầu.

### Lấy một run thật để thử (môi trường dev)

`slr-be` chạy cổng 5000. Khi `DEV_AUTH_ENABLED=true`, token **`Bearer dev-<uid>`** được chấp nhận (ví dụ `dev-leader_user` là OWNER của dự án seed).

```bash
# trong thư mục slr-be (ghi vào Firestore emulator, chỉ nên chạy khi hiểu tác dụng)
npx tsx src/scripts/seed-slr-artifacts-demo.ts                         # tạo proj_slr_artifacts_demo (6 bài INCLUDED, 3 RQ)
npx tsx src/scripts/seed-synthesis-ready.ts proj_slr_artifacts_demo    # đưa tới trạng thái sẵn sàng Synthesis
```

Sau đó (bằng API với token `dev-leader_user`): `POST synthesis/start` → tạo theme (`POST synthesis/themes`) → thêm evidence (`POST synthesis/themes/<phần-sau-"__"-của-themeId>/evidence`; **dùng id rút gọn**, id đầy đủ trả 404) → `POST synthesis/artifacts/runs` → duyệt A1, A2, A7, A10 (`.../runs/:runId/artifacts/:type/review` với `{decision:'APPROVED'}`) → gọi `from-slr` bên Writing.

---

## 11. Xác thực và phân quyền

**Hiện tại** (`src/middleware/auth.middleware.ts`):

- `requireAuth` **fail-closed**: không có danh tính hợp lệ thì 401.
- Có `Authorization: Bearer ...` *và* đã đăng ký verifier (`setTokenVerifier`) → dùng verifier (sai thì 401 `INVALID_TOKEN`).
- Dev auth chỉ khi `DEV_AUTH_ENABLED=true` **và** `NODE_ENV != production`: danh tính là `DEV_AUTH_UID`, hoặc header `X-Dev-User-Id`. Khi dev auth bật và chưa có verifier, header `Authorization` vẫn được chuyển tiếp nguyên cho `slr-be` (cách thử với `Bearer dev-leader_user`).
- Quyền: người gọi phải sở hữu `Project` (so `ownerId`).

**Đã làm ở M1** (nhánh `feat/firebase-auth`):

- `src/modules/auth/firebase-verifier.ts`: xác minh ID token bằng `firebase-admin` (chữ ký, issuer, audience, hạn dùng), kiểm tra lại `aud` đúng bằng project id và bắt buộc có `aud`, giới hạn thời gian chờ 10 s, không bao giờ ném lỗi hay lộ lý do. Đăng ký lúc khởi động trong `server.ts` qua `configureAuth()` khi có `FIREBASE_PROJECT_ID`.
- `parseEnv` (`src/config/env.ts`): production (hoặc thiếu `NODE_ENV`) mà thiếu `FIREBASE_PROJECT_ID` thì **không khởi động**; `FIREBASE_PROJECT_ID` đặt cùng `DEV_AUTH_ENABLED=true` cũng không khởi động (nếu không, ai không có token vẫn đóng giả được bằng `X-Dev-User-Id`). Giá trị rỗng coi như chưa đặt.
- Liên kết project: `POST /projects` hỏi `slr-be` (`GET /api/projects/:id` bằng token người gọi). Không có quyền hoặc project không tồn tại đều trả cùng một câu 403 `SLR_PROJECT_ACCESS_DENIED` để không dò được ID. Kiểm tra này chạy trước kiểm tra trùng.
- Import tay `POST /snapshots` trả 403 `MANUAL_IMPORT_DISABLED` khi `ALLOW_MANUAL_SNAPSHOT_IMPORT` tắt (mặc định tắt ở production). `validate` và xem danh sách vẫn dùng được.
- `POST /snapshots/from-slr` giới hạn theo người dùng (`FROM_SLR_RATE_LIMIT_PER_MINUTE`, mặc định 20/phút) → 429 `RATE_LIMITED`. Đếm trong bộ nhớ của một tiến trình.
- Tên và `slrProjectId` chứa NUL hoặc surrogate lẻ bị từ chối 400 thay vì lỗi 500 từ database.

**Còn lại của xác thực:** chưa thử với token Firebase thật (cần FE đăng nhập); `FIREBASE_CHECK_REVOKED` cần thông tin service account; chưa có kiểm tra vai trò OWNER trên `slr-be` cho H1–H3 (hiện chỉ kiểm tra là thành viên khi liên kết).

**Lỗ hổng đã biết (ưu tiên cao):**

1. ~~Liên kết project không kiểm tra quyền~~ → đã xử lý ở M1.
2. ~~Import tay lưu dữ liệu tự bịa~~ → đã gắn nhãn `manual` và tắt mặc định ở production.
3. ~~Không có rate limit~~ → đã có cho `from-slr` (đếm trong bộ nhớ, một tiến trình).
4. Swagger công khai ở production; `helmet` đang tắt CSP; `x-request-id` từ client chưa được làm sạch; `FRONTEND_URL` chưa kiểm tra.
5. Dòng con của snapshot (kể cả `SnapshotSupplement`, `SnapshotArtifact`) vẫn UPDATE được ở mức DB; "bất biến" hiện do tầng service giữ.

---

## 12. Chạy local, test, migration

### Yêu cầu
Node.js 22, Docker Desktop. `slr-be` chạy riêng (cổng 5000) nếu cần thử tích hợp thật.

### Lần đầu
```bash
npm install                 # postinstall tự chạy `prisma generate`
cp .env.example .env        # đã đủ giá trị dev
npm run db:up               # Postgres 16 trong Docker, cổng 5433
npm run db:deploy           # áp dụng migration
npm run dev                 # http://localhost:5100  (Swagger: /api-docs)
```

### Biến môi trường chính

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `NODE_ENV` | `production` | Mặc định là production để **an toàn khi thiếu cấu hình**; `.env.example` đặt `development` |
| `PORT` | 5100 | |
| `DATABASE_URL` | `postgresql://slr_writing:slr_writing@localhost:5433/slr_writing?schema=public` | |
| `SLR_API_BASE_URL` | `http://localhost:5000` | Gốc của `slr-be` |
| `SLR_API_TIMEOUT_MS` | 15000 | Timeout mỗi request lên `slr-be` |
| `SLR_API_MAX_RESPONSE_BYTES` | 52428800 | Giới hạn phản hồi từ `slr-be` |
| `DEV_AUTH_ENABLED` | `false` | Chỉ có tác dụng khi không phải production; **không được bật cùng `FIREBASE_PROJECT_ID`** |
| `FIREBASE_PROJECT_ID` | (trống) | Project Firebase phát token, dùng chung với `slr-be`. **Bắt buộc ở production**; trống = chỉ dev auth |
| `FIREBASE_CHECK_REVOKED` | `false` | Từ chối cả token bị thu hồi; cần service account |
| `SLR_VERIFY_PROJECT_ACCESS` | `true` | Hỏi `slr-be` về quyền khi liên kết project |
| `ALLOW_MANUAL_SNAPSHOT_IMPORT` | `true` ngoài production, `false` ở production | Cho phép import tay |
| `FROM_SLR_RATE_LIMIT_PER_MINUTE` | 20 | Số lần gọi `from-slr` mỗi người mỗi phút |
| `REQUIRE_SLR_OWNER_FOR_APPROVAL` | `true` | Duyệt H1 (và H2, H3 sau này) hỏi `slr-be` vai trò của người gọi, chỉ OWNER qua. **Chỉ tắt cho test hoặc làm việc không có `slr-be`**; khi tắt, ai sở hữu project Writing cũng duyệt được |
| `JSON_BODY_LIMIT` | `50mb` | Corpus lớn |

### Test
```bash
npm test                    # vitest run (cần Postgres đang chạy)
npm run typecheck && npm run build
```
- **Ghi kết quả ra file** khi chạy thủ công (`npx vitest run > out.log 2>&1`) và đừng ống qua `grep` (đã từng treo lệnh).
- Test tích hợp tự tạo `Project` riêng cho từng test (provenance chỉ ghi thêm nên không xoá được); dữ liệu thừa vô hại, xoá hết bằng `docker compose down -v`.
- Timeout test 30 s vì database trong Docker có lúc chậm.

### Migration với Prisma 7
`prisma migrate dev` có lúc từ chối chạy trong môi trường không tương tác. Cách dùng được:
```bash
# 1. sửa prisma/schema.prisma
mkdir prisma/migrations/<timestamp>_<tên>
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script > prisma/migrations/<timestamp>_<tên>/migration.sql
npx prisma migrate deploy
npx prisma generate
```
Luôn đọc file SQL sinh ra trước khi áp dụng. CI chạy `migrate deploy` trên database trống nên migration phải chạy được từ đầu.

---

## 13. Quy trình làm việc của team

### Nhánh và PR
- Nhánh dài hạn: `dev` (tích hợp) và `main` (ổn định). Mỗi việc một nhánh: `feat/...`, `fix/...`, `docs/...`, `chore/...`.
- Mở PR vào `dev`; CI **"Typecheck, Test & Build"** phải xanh mới merge. `dev → main` làm khi một mốc ổn định.
- Commit theo kiểu `feat(snapshots): ...`, `fix(slr-client): ...`. Thân commit giải thích *vì sao*.

### Quy trình mỗi bước (bắt buộc)
```mermaid
flowchart LR
    A[Làm MỘT bước nhỏ] --> B[Viết test ngay tại bước đó]
    B --> C[typecheck + build + toàn bộ test]
    C --> D[Commit]
    D --> E[Giao sub-agent Fable 5.1<br/>test ĐỦ trường hợp, cố phá]
    E --> F{Có lỗi thật?}
    F -- có --> G[Sửa, cập nhật test mô tả hành vi cũ,<br/>chạy lại tất cả, commit]
    G --> E2[báo cáo kết quả trung thực]
    F -- không --> E2
    E2 --> H[Push, PR, CI xanh, merge]
```

- **Quy tắc Fable QA:** sau khi triển khai xong mỗi bước, giao cho một sub-agent chạy model Fable 5.1 viết test đối kháng toàn diện. Dặn rõ: *không sửa `src/` hay test cũ, chỉ thêm file mới vào `tests/qa/`, tái hiện từng lỗi trước khi báo*. Đã hiệu quả: lần 1 tìm 7 lỗi thật, lần 2 tìm 6 lỗi thật, những lỗi mà test của người viết bỏ sót.
- Báo cáo trung thực: test đỏ thì nói đỏ kèm output; bước nào bỏ qua thì nói bỏ qua.
- Thử tích hợp thật khi có thể, nhưng **không** sửa dữ liệu dùng chung (Firestore emulator của người khác) khi chưa được cho phép.

---

## 14. Quy ước code

1. **ESM + NodeNext:** `import x from './y.js'` (đuôi `.js` dù file là `.ts`).
2. **Lỗi:** ném `AppError(message, status, code, isOperational?, details?)` hoặc lớp con (`NotFoundError`, `BadRequestError`...). `error.middleware.ts` chuyển thành envelope. Không bao giờ trả message/stack nội bộ ra ngoài (trừ `development`). Mã lỗi viết hoa, ổn định, đã liệt kê ở [mục 8](#8-api-hiện-có).
3. **Envelope:** luôn `{success:true,data}` hoặc `{success:false,error}`.
4. **Express 4:** router lồng nhau cần `Router({ mergeParams: true })` và gõ kiểu tham số (`Request<{projectId:string}>`), nếu không `req.params` không suy ra được.
5. **Route luôn bọc `try { ... } catch (e) { next(e) }`** (Express 4 không bắt lỗi async).
6. **Phân quyền ở mỗi route:** chứng minh người gọi sở hữu project (`getOwnedProject`) *trước* khi chạm dữ liệu; sai chủ → 404.
7. **Hàm thuần cho logic kiểm tra** (như `assessReadiness`) để test không cần database.
8. **Zod 3**, schema ngoại lai dùng `.passthrough()`; schema của dữ liệu *mình* phát hành thì chặt.
9. **Không bao giờ để LLM hay dữ liệu bên ngoài quyết định ID/citation**: luôn đối chiếu với registry/snapshot.
10. **Ghi `ProvenanceEvent`** cho mọi thao tác thay đổi trạng thái có ý nghĩa (import, duyệt H1/H2/H3, sinh bản nháp, export), trong cùng transaction.
11. **Fixture:** dữ liệu giả phải ghi rõ "SYNTHETIC"; dữ liệu thật phải che thông tin cá nhân. Không đưa khoá API hay token vào repo.
12. **Môi trường Windows:** cảnh báo `LF will be replaced by CRLF` là vô hại. Nếu sửa file bằng script, **kiểm tra file không bị rỗng/cắt cụt** (đã từng xảy ra một lần do lỗi mã hoá), ưu tiên công cụ sửa file thay vì script ghi đè.
13. **Mỗi route mới** phải được thêm vào `src/config/openapi.ts` (viết tay) và có test OpenAPI.
14. **Tham số id trong URL** (`:projectId`, `:snapshotId`...) đi qua `guardIdParam` (`src/middleware/param-guard.middleware.ts`): id chứa NUL hoặc dài quá 200 ký tự trả 404 như id không tồn tại, nếu không PostgreSQL báo lỗi và thành 500. Route mới có tham số id mới thì đăng ký `router.param(...)` tương tự. Đường dẫn có mã phần trăm hỏng (`%ZZ`) làm Express ném lỗi 400; `error.middleware.ts` trả 400 `BAD_REQUEST` chung chung thay vì 500.
15. **Văn bản sinh ra phải tách dữ kiện khỏi câu chữ** (xem M2): dữ kiện có đường dẫn nguồn, câu chữ chỉ dùng dữ kiện, và bước kiểm tra số chặn mọi con số không có trong dữ kiện.

---

## 15. Lộ trình các module tiếp theo

Thứ tự khuyến nghị (đã được ba góc nhìn kiến trúc, bảo mật, sản phẩm cân nhắc). Mỗi module: làm nhỏ, có test, rồi QA Fable.

```mermaid
flowchart TD
    M0[Hiện tại: snapshot import + client slr-be<br/>✔ xong] --> M1
    M1[M1 Xác thực Firebase thật<br/>+ kiểm tra quyền khi liên kết project] --> M2
    M2[M2 Methods / PRISMA<br/>sinh bằng mẫu cố định] --> M3
    M3[M3 Journal Profile<br/>hằng số IMRaD] --> M4
    M4[M4 LLMProvider<br/>mock + Gemini] --> M5
    M5[M5 Outline + H1] --> M6
    M6[M6 ParagraphPlan] --> M7
    M7[M7 Sinh văn bản + H2] --> M8
    M8[M8 Citation manifest<br/>+ Verification + Gates] --> M9
    M9[M9 Export + H3] --> M10
    M10[M10 Giao diện viết bài]
    M1 -.song song.-> H[Hardening: rate limit, CSP,<br/>trigger bất biến, tắt import tay ở prod]
```

> Các tên bảng/endpoint dưới đây là **đề xuất**; hãy bám roadmap mục 4–6 và ghi quyết định mới vào ADR.

### M1 — Xác thực Firebase thật (**đã code, chờ merge**; xem mục 11)
- **Mục tiêu:** thay dev auth bằng danh tính thật; ngăn liên kết project không có quyền.
- **Việc:** `firebase-admin`, verifier `verifyIdToken(token, checkRevoked=true)` với `FIREBASE_PROJECT_ID` lấy từ env (bắt buộc ở production, rỗng thì không khởi động); đăng ký bằng `setTokenVerifier` lúc khởi động. Khi `POST /projects`: gọi `GET /api/projects/:slrProjectId` trên `slr-be` bằng token người dùng, yêu cầu tối thiểu vai trò MEMBER (OWNER nếu muốn duyệt H1–H3).
- **Hạn chế cần xử lý:** import tay → tắt ở production hoặc chỉ cho phép khi cờ cấu hình bật; rate limit cho `from-slr`.
- **Test:** token hết hạn/giả/thiếu; user không thuộc project SLR; uid khác nhau cô lập dữ liệu; production không bao giờ bật dev auth.
- **Nghiệm thu:** không còn đường nào vào API mà không có danh tính xác minh khi `NODE_ENV=production`.

### M2 — Methods / PRISMA bằng mẫu cố định (văn bản đầu tiên, không LLM) — **đã code, chờ merge**

**Thiết kế 3 lớp** (để sau này thay phần viết câu bằng LLM mà không đụng tới phần khoa học):

```mermaid
flowchart LR
    S[(Snapshot<br/>A10, A2, PRISMA export)] --> F[Lớp 1: dữ kiện<br/>methods-facts.ts<br/>mỗi dữ kiện có đường dẫn nguồn<br/>explicit hoặc missing]
    F --> R[Lớp 2: câu chữ<br/>methods-renderer.ts<br/>mẫu cố định tiếng Anh]
    R --> G{Lớp 3: kiểm tra số<br/>methods-grounding.ts}
    G -- mọi số nằm trong dữ kiện --> V[(SectionRevision<br/>phiên bản mới)]
    G -- có số lạ --> X[500 METHODS_UNGROUNDED_NUMBER<br/>không lưu gì]
```

- **Lớp 1 (`methods-facts.ts`, hàm thuần):** rút từ snapshot các dữ kiện: câu hỏi nghiên cứu, PICOC, tiêu chí đưa vào/loại ra, nguồn tìm kiếm, các số của luồng PRISMA, lý do loại báo cáo, số nghiên cứu, khoảng năm (tính từ A2), số nghiên cứu đã trích xuất và đã đánh giá chất lượng. Giá trị không có hoặc sai kiểu (âm, thập phân, chuỗi, null, số vượt 2^53) thành `missing`, **không bao giờ đoán**. `0` giữ là `0`. Danh sách lý do loại báo cáo chỉ `explicit` khi **mọi** phần tử hợp lệ; một phần tử hỏng thì cả danh sách là `missing` (không bao giờ hiểu thành "không báo cáo nào bị loại"). Nhãn năm phải đúng 4 chữ số và năm đó phải có nghiên cứu. Văn bản chỉ gồm ký tự vô hình (zero-width, điều khiển) không phải là văn bản.
- **Lớp 2 (`methods-renderer.ts`):** mẫu tiếng Anh cố định, chỉ nói điều dữ kiện cho phép; dữ kiện thiếu được liệt kê là "không báo cáo". Văn bản của người dùng (câu hỏi, tiêu chí, nguồn tìm kiếm) đi qua `clean()`: bỏ ký tự điều khiển và zero-width (`invisible-text.ts`), gộp xuống một dòng, thoát `&` trước (để `&#49;` không thành ký tự), thoát ký hiệu nội dòng (`` ` * _ [ ] ~ < > ``) và cả ký hiệu mở khối ở đầu dòng (`#`, `+`, `-`, `=`, `|`, `1.`, `1)`). Đây là phần sẽ thay bằng LLM ở M4 trở đi.
- **Lớp 3 (`methods-grounding.ts`):** mọi chuỗi chữ số trong văn bản phải nằm trong dữ kiện. Chữ số của mọi hệ chữ (toàn chiều rộng, Ả Rập, Devanagari, chỉ số trên) được quy về ASCII trước khi so. Giới hạn: không thấy số viết bằng chữ ("six"), bỏ qua dấu âm và dấu thập phân (3.5 cần có cả 3 và 5), một chữ số xuất hiện trong chính văn bản của review (ví dụ "87%" trong câu hỏi nghiên cứu) coi như có căn cứ ở mọi nơi, và không kiểm tra số đứng cạnh đúng từ; các phần đó thuộc cổng kiểm chứng ở M8.
- **Lưu trữ:** `Manuscript` (1 snapshot) → `ManuscriptSection` (`methods`) → `SectionRevision` (chỉ ghi thêm). "Không đổi" nghĩa là văn bản giống từng byte (hash chỉ tính trên văn bản và bộ sinh); chỉ đổi phần ẩn như `source_id` mà văn bản vẫn vậy thì không có phiên bản mới (200), còn đổi dữ liệu nguồn làm đổi văn bản thì ra phiên bản kế tiếp (201). Mỗi phiên bản mới ghi `ProvenanceEvent` `manuscript.methods.generate`. Các request đồng thời trên cùng một snapshot được xếp hàng bằng khoá tư vấn của PostgreSQL (`pg_advisory_xact_lock`), nên 40 request cùng lúc vẫn chỉ ra 1 phiên bản và phiên bản không bị đứt quãng.
- **Cảnh báo kèm theo:** `FACT_MISSING` cho mỗi dữ kiện thiếu, và các mã `PRISMA_*` đã ghi lúc import snapshot.
- **Cách thử nhanh:** import snapshot bằng `from-slr`, rồi `POST /projects/:id/snapshots/:sid/manuscript/methods`. Fixture thật `tests/fixtures/real/slr-be-demo-run.json` cho ra văn bản đầy đủ nhưng nhiều dòng "không báo cáo" vì dự án seed không có nguồn tìm kiếm.
- **Ngôn ngữ:** văn bản bản thảo là tiếng Anh (đích là bài báo quốc tế); giao diện và tài liệu nội bộ là tiếng Việt.
- **Còn lại:** Results/Discussion theo cách tương tự (M6, M7); thay mẫu bằng LLM sau M4 phải giữ nguyên lớp 1 và lớp 3.

*Thiết kế ban đầu của M2 (để đối chiếu):*
- **Đầu vào:** `SnapshotArtifact` A10 (`protocol`, `search_strategy`, `selection`, `selected_studies`) + `SnapshotSupplement.prisma_writing_export` (`flow`, `includedStudies`) + A2 (đặc điểm nghiên cứu).
- **Đầu ra:** một `ManuscriptSection` (Markdown) cho Methods và mô tả luồng PRISMA, **mỗi con số kèm khoá nguồn** (ví dụ `flow.recordsScreened`), và `SectionRevision` đầu tiên.
- **Quy tắc:** chỉ lắp từ dữ liệu có sẵn; trường `null`/thiếu → ghi rõ "không báo cáo", **không bịa**. Cảnh báo `PRISMA_*` từ snapshot phải hiện trong kết quả.
- **API:** xem bảng ở mục 8.
- **Test:** golden test với fixture thật; mọi số trong Markdown đều truy được về khoá nguồn; thiếu PRISMA export → có cảnh báo, không có số.
- **Nghiệm thu:** sinh lại cùng snapshot cho ra cùng văn bản (xác định).

### M3 — Journal Profile — **đã code, chờ merge**

Khung bài báo mặc định, **không phải chính sách của một tạp chí nào**. Là hằng số trong code (chưa có bảng, chưa có CRUD), nhưng có schema chặt để sau này thêm profile của tạp chí thật mà không thể vô tình trình bày gợi ý như chính sách.

- **Profile `generic-imrad` (version 1):** 6 mục theo thứ tự: Abstract, Introduction, Methods, Results, Discussion, Conclusion. Mỗi mục có `key`, `order` (1 đến 6, không đứt quãng), `required`, `wordBudget` (min/max), `sources` (dữ liệu để viết mục đó, theo `docs/mvp-scope.md` mục 5), `generator` (bộ sinh đã có, hiện chỉ Methods: `methods-template@1`; mục khác `null`) và `purpose`.
- **Luôn "chưa xác minh":** `verification = { status: 'unverified', verifiedAt: null, verifiedBy: null, policySourceUrls: [] }`, `wordBudgetSource = 'suggested_default'` (số từ là gợi ý của hệ thống, không phải giới hạn của tạp chí), `citationStyle = null`, và có `notice` hiện ở mọi nơi hiển thị profile.
- **Quy tắc trong schema** (`journal-profile.schema.ts`, kiểm tra ngay khi server khởi động — profile vi phạm thì server không chạy):
  - profile `unverified` không được mang ngày xác minh, người xác minh hay nguồn chính sách, bắt buộc có `notice`, và số từ chỉ được là `suggested_default`;
  - profile `verified` bắt buộc có ngày, người xác minh, ít nhất một URL chính sách và tên tạp chí;
  - khoá mục duy nhất; các mục **liệt kê đúng thứ tự** với `order` 1, 2, 3... không đứt quãng (để code đọc theo mảng không xếp ngược bản thảo); `min` không lớn hơn `max`; nguồn thuộc danh sách cho phép (`A1`, `A2`, `A7`, `A10`, `prisma_writing_export`, `rq_findings`, `other_sections`) và không lặp;
  - URL nguồn chính sách và URL tạp chí chỉ nhận **https** trên tên miền công khai (từ chối `javascript:`, `data:`, `file:`, `http`, `localhost`, địa chỉ IP), tối đa 2048 ký tự, nguồn chính sách không lặp; ngày xác minh không được ở tương lai (cho lệch đồng hồ 5 phút);
  - văn bản (tên, mục đích, người xác minh, thông báo) phải có chữ nhìn thấy được, không chỉ khoảng trắng hay ký tự zero-width;
  - `generator` phải nằm trong `KNOWN_GENERATORS` (`src/shared/constants/generators.ts`), nên profile không hứa một cách viết mà hệ thống không có. Thêm bộ sinh mới thì thêm vào danh sách đó;
  - giới hạn: tối đa 20 mục, `version` tối đa 1.000.000, `id` tối đa 64 ký tự.
- **API:** `GET /api/journal-profiles` và `GET /api/journal-profiles/:profileId` (cần đăng nhập; 404 `JOURNAL_PROFILE_NOT_FOUND`). Người gọi nhận **bản sao**, và hằng số gốc được đóng băng sâu (`deepFreeze`), nên không ai sửa được profile mà request sau sẽ thấy. Không có route ghi.
- **Khi chọn tạp chí cụ thể:** thêm một profile mới với `id` riêng vào `PROFILES` (`journal-profiles.service.ts`), điền `journal`, `verification` đầy đủ và `wordBudgetSource: 'journal_policy'`. **Không sửa** `generic-imrad` thành profile của tạp chí. Khi nội dung profile đổi thì tăng `version`.
- **Dùng ở đâu tiếp theo:** M5 (dàn ý) lấy danh sách mục, thứ tự và ngân sách từ profile; bản thảo sẽ ghi `id` và `version` của profile đã dùng.
- **Còn lại:** chưa lưu profile nào vào bản thảo (làm ở M5); chưa có bảng nếu sau này cần profile do người dùng tạo.
- **Quyết định thiết kế đã biết:** profile `verified` vẫn được dùng `wordBudgetSource: 'suggested_default'` (tạp chí có thể không nêu giới hạn từ), và profile `unverified` vẫn được mang tên tạp chí cùng kiểu trích dẫn (bản nháp cho một nơi chưa kiểm tra chính sách), miễn là có `notice`.

*Thiết kế ban đầu của M3 (để đối chiếu):*
- Một **hằng số** IMRaD mặc định (Abstract, Introduction, Methods, Results, Discussion, Conclusion; phân bổ số từ), `verified_at = null`, `policy_source_urls = []`, giao diện/ API phải hiện "chưa xác minh với chính sách tạp chí". Chưa cần CRUD. Khi chọn tạp chí cụ thể mới thêm bảng và người chịu trách nhiệm.

### M4 — `LLMProvider`
- Interface `generateStructured({ promptTemplateId, input, schema }) → { output, modelInfo }` ở `src/modules/llm/`; `MockProvider` cho test; adapter Gemini (nhà cung cấp đề xuất vì `slr-be` đã có client, **chưa chốt**; khoá API chỉ trong biến môi trường).
- Luôn đầu ra có cấu trúc (zod), lưu `provider/model/version`, `promptTemplateVersion`, tham số. Có timeout, retry có giới hạn, giới hạn token, ghi nhận chi phí.

### M5 — Dàn ý (Blueprint) + duyệt H1 — **đã code (bằng quy tắc, chưa dùng LLM), chờ merge**

```mermaid
flowchart TD
    P[(Journal Profile<br/>generic-imrad v1)] --> G
    S[(Snapshot<br/>themes + research questions)] --> G[POST /blueprint<br/>sinh bằng quy tắc cố định]
    G --> V1[(BlueprintRevision v1<br/>origin = generated)]
    V1 --> E{Người dùng sửa?}
    E -- PUT baseVersion + content --> V2[(Version kế tiếp<br/>origin = edited)]
    V2 --> E
    V1 --> C{Validator:<br/>có lỗi chặn?}
    V2 --> C
    C -- có --> X[422 BLUEPRINT_NOT_APPROVABLE<br/>kèm danh sách lỗi]
    C -- không --> R{slr-be: người gọi là OWNER?}
    R -- không --> F[403 APPROVAL_REQUIRES_OWNER]
    R -- có --> A[(Approval H1<br/>ghi seq, hash, vai trò)]
    A --> N[Bước sau M6 chỉ chạy khi<br/>getApprovedBlueprint khác null]
```

- **Sinh dàn ý** (`blueprint-generator.ts`, hàm thuần, cùng đầu vào ra cùng kết quả): lấy mục, thứ tự và số từ gợi ý từ profile; Introduction có tiểu mục "Research questions"; **Results có một tiểu mục cho mỗi theme (claim)** của snapshot, gắn với câu hỏi nghiên cứu mà theme trả lời; Discussion có "Agreement and conflict between studies" và "Limitations"; **coverage**: mỗi câu hỏi nghiên cứu trỏ tới các tiểu mục Results trả lời nó. Câu hỏi không có theme nào trả lời được để trống, không đoán, nên lộ ra thành lỗi chặn cho tới khi người dùng xử lý.
- **Lưu trữ:** `BlueprintRevision` (gắn với `Manuscript` của snapshot, **chỉ ghi thêm**, ghi `profileId` và `profileVersion` đã dùng) và `Approval` (**chỉ ghi thêm**, dùng chung cho H1/H2/H3 về sau: `stage`, `targetKind`, `targetId`, `targetHash`, `decision`, `note`, `decidedBy`, `slrRole`, `seq`). Trạng thái của một phiên bản là quyết định có `seq` lớn nhất về nó, không có quyết định thì là PENDING. Sửa dàn ý sau khi duyệt tạo phiên bản mới ở trạng thái PENDING; lần duyệt cũ vẫn gắn với phiên bản cũ.
- **Sửa dàn ý** (`PUT`): người dùng gửi `baseVersion` và toàn bộ `content`. Nếu `baseVersion` không phải phiên bản mới nhất thì 409 `STALE_BLUEPRINT` (không ghi đè công việc của người khác). Nội dung giống hệt thì 200, không tạo phiên bản. Khoá lạ bị từ chối (`strict`), nên không có gì bị bỏ lặng lẽ. **Bản nháp có lỗi vẫn lưu được**: lỗi chỉ chặn việc duyệt. Tên và thứ tự mục thuộc về profile, không sửa trong dàn ý.
- **Điều kiện duyệt** (`blueprint-validator.ts`). Chặn: `PROFILE_MISMATCH`, `PROFILE_OUTDATED`, `PROFILE_UNKNOWN`, `SECTION_MISSING`, `SECTION_DUPLICATE`, `SECTION_UNKNOWN`, `REQUIRED_SECTION_EXCLUDED`, `WORD_BUDGET_INVALID`, `SUBSECTION_ID_DUPLICATE`, `UNKNOWN_CLAIM`, `UNKNOWN_RESEARCH_QUESTION`, `RESULTS_EMPTY`, `COVERAGE_MISSING`, `COVERAGE_DUPLICATE`, `COVERAGE_UNKNOWN_SUBSECTION`, `COVERAGE_UNRESOLVED` (câu hỏi không có tiểu mục và cũng không có lý do N/A). Cảnh báo: `THEME_NOT_PLACED`, `EXCLUDED_SECTION_HAS_SUBSECTIONS`.
- **H1 chỉ dành cho OWNER trên `slr-be`:** `POST .../blueprint/approve` và `/reject` (`assertSlrOwner` trong `approvals.service.ts`) hỏi `slr-be` vai trò của người gọi bằng chính token của họ **ngay lúc quyết định**, trước khi ghi gì. Chỉ `roleText === 'OWNER'` mới qua; mọi giá trị khác, thiếu, sai kiểu, hay `slr-be` lỗi đều không qua (đóng khi lỗi). Vai trò được ghi vào `Approval.slrRole`. Cấu hình `REQUIRE_SLR_OWNER_FOR_APPROVAL` (mặc định bật) tắt được cho test và làm việc không có `slr-be`; khi tắt, `slrRole` ghi `NOT_CHECKED` để bản ghi không khẳng định một vai trò chưa kiểm tra. Chỉ phiên bản mới nhất mới quyết định được (409 nếu không). Quyết định giống hệt lần trước thì 200, không ghi thêm. Từ chối bắt buộc có ghi chú. Từ chối một phiên bản đã duyệt là rút lại lần duyệt.
- **Cho các bước sau:** `getApprovedBlueprint(manuscriptId)` trả phiên bản mới nhất **chỉ khi** quyết định mới nhất về nó là APPROVED; sửa sau khi duyệt hoặc chưa từng duyệt đều trả `null`. M6 phải gọi hàm này và dừng nếu `null`.
- **Đồng thời:** mọi thao tác ghi trên cùng một snapshot xếp hàng bằng khoá tư vấn của PostgreSQL, nên nhiều request cùng lúc không tạo phiên bản trùng hay quyết định trùng.
- **Còn lại:** LLM chưa tham gia. Sau M4 có thể thêm bước "đề xuất dàn ý" do LLM sinh, vẫn phải qua `validateBlueprint` và H1. Chưa có giao diện (FE đã có kế hoạch màn hình Outline).

*Thiết kế ban đầu của M5 (để đối chiếu):*
- Từ snapshot + Journal Profile + (tuỳ chọn) contribution → `ManuscriptBlueprint` (section, mục tiêu, ngân sách từ, finding/claim dự kiến). Mỗi RQ phải có chỗ đến hoặc lý do N/A. Người dùng sửa/sắp xếp lại; **OWNER duyệt H1** → ghi `Approval` + `ProvenanceEvent`. Không được sang M6 khi chưa có H1.

### M6 — ParagraphPlan
- Mỗi đoạn: rhetorical move, claim slot, danh sách `finding`/`evidence` (ID **phải tồn tại trong snapshot**; plan trỏ ID lạ thì bị từ chối), `claim_strength` (neutral/qualified/strong), qualifier/điều kiện giữ nguyên, citation policy `registry_only`. Trạng thái `READY_TO_DRAFT` chỉ khi mọi claim quan trọng có evidence hợp lệ.

### M7 — Sinh văn bản + H2
- Gửi cho LLM *evidence pack tối thiểu*, không gửi cả corpus. LLM trả `{text, usedEvidenceIds[]}`; hệ thống kiểm tra `usedEvidenceIds ⊆ pack`, **không** nhận reference mới. Mỗi đoạn có revision + lineage. **OWNER duyệt H2** trước khi sang kiểm chứng cuối.

### M8 — Citation manifest + Verification + Quality gates
- `CitationManifest` tách marker khỏi văn xuôi; kiểm tra tồn tại trong registry. Gate G1–G7 (roadmap mục 7): mỗi gate trả `PASS | WARNING | FAIL | NEEDS_REVIEW | NOT_APPLICABLE | NOT_RUN` và **`NOT_RUN` không được coi là pass**. Có lớp tất định (ID, FK, quote khớp, đối soát số PRISMA) và lớp LLM hỗ trợ (evidence có ủng hộ claim không, có mạnh hơn nguồn không); LLM **không** là bằng chứng cuối. Sinh `ReviewIssue` có severity, đích, lý do, đề xuất; sửa có kiểm soát (`RevisionDiff`), claim đổi thì kiểm lại.

### M9 — Export + H3
- Chặn khi có FAIL critical, citation không tồn tại, PRISMA lệch, thiếu H3. Gói gồm: Markdown, citation manifest, báo cáo chất lượng, issue còn mở, lịch sử revision, lời khai sử dụng AI, metadata audit (snapshot + hash + profile + model config). **Truy ngược được một câu về `ParagraphPlan → Finding → Study → SourceAnchor`** bằng một truy vấn.

### M10 — Giao diện
- Chưa có repo FE. Làm CLI hoặc trang trong `slr-fe` trước (đã có đăng nhập và ngữ cảnh project). Màn hình tối thiểu: Import & Readiness, Outline (H1), xem trước Markdown + duyệt (H2/H3).

### Hardening chạy song song
Rate limit; CSP/helmet; tắt Swagger ở production; làm sạch `x-request-id`; kiểm tra `FRONTEND_URL`; trigger DB chặn UPDATE/DELETE trên bảng con của snapshot; tổng thời gian cho `fetchRun`; không có credential mặc định ở production (`DATABASE_URL` bắt buộc).

---

## 16. Checklist thêm một module mới

1. Đọc [mục 2](#2-nguyên-tắc-bắt-buộc) và phần liên quan của roadmap; xác định *nguồn sự thật* của dữ liệu (luôn là snapshot).
2. Tạo `src/modules/<tên>/` với `*.schemas.ts` (zod), `*.service.ts`, `*.routes.ts`. Logic kiểm tra viết thành hàm thuần.
3. Nếu cần bảng: sửa `schema.prisma`, sinh migration (xem [mục 12](#migration-với-prisma-7)), `prisma generate`. FK `Restrict`; dữ liệu đã duyệt thì không UPDATE, tạo revision mới.
4. Gắn router vào `projects.routes.ts` (hoặc `routes.ts`); mọi route đi qua `requireAuth` + `getOwnedProject`.
5. Ghi `ProvenanceEvent` cho thao tác quan trọng; điểm duyệt H1/H2/H3 chỉ cho OWNER.
6. Thêm route vào `src/config/openapi.ts`.
7. Viết test: đơn vị (hàm thuần), API (supertest + Postgres), trường hợp lỗi/phân quyền, rồi `npm run typecheck && npm run build && npm test`.
8. Commit, **giao sub-agent Fable 5.1 QA**, sửa lỗi, cập nhật file này (mục 5 và 15), mở PR vào `dev`.

---

## 17. Quyết định đã chốt, chưa chốt và rủi ro

### Đã chốt

| Chủ đề | Quyết định |
|---|---|
| Hướng | Tự xây writing engine, không dùng AutoResearchClaw |
| Stack | Node + TS + Express 4 + Swagger; PostgreSQL + Prisma 7 (ADR-011) |
| Nguồn dữ liệu | API `slr-be`, token người dùng chuyển tiếp (ADR-001); **dùng chung Firebase project** |
| Nguồn sự thật | Sao chép vào snapshot bất biến, giữ ID gốc, phát hiện cũ bằng `corpus_hash` (ADR-005) |
| Đầu ra | Markdown trước (ADR-007) |
| MVP | A1 (Results), A10 (Methods/PRISMA), A7 (Discussion), A2 (mô tả corpus); một Journal Profile IMRaD "chưa xác minh"; H1/H2/H3 do OWNER duyệt; chưa có SAPEA |
| Quy trình | Từng bước nhỏ, test ngay, QA bằng sub-agent Fable 5.1 |

### Chưa chốt (cần team quyết)

- **Nhà cung cấp LLM** (đề xuất Gemini; cần khoá, chi phí, nơi lưu khoá).
- **Tạp chí mục tiêu** (hiện dùng profile chung).
- **Giao diện:** trang trong `slr-fe` hay repo `slr-writing-fe` mới.
- **Hàng đợi job** (MVP chạy đồng bộ).
- **Tuổi snapshot:** khi PRISMA/RQ trong `slr-be` đổi, UI cần chỉ ra snapshot nào mới nhất và cảnh báo `STALE`.

### Rủi ro / khoảng trống đã biết

- `slr-be` chưa có `certainty` ở A4 → `claim_strength` do người dùng hoặc quy tắc cố định quyết định.
- Source anchor neo theo đoạn Markdown (GROBID), `page` thường `null` → hiển thị vị trí theo section/đoạn.
- Mới thử trên dự án seed **không có full text** (0 evidence). Chưa thử dự án có evidence thật; M8 phụ thuộc điều này. Cần một run có evidence thật để tạo fixture thứ hai.
- Chưa có endpoint "xuất gói" ở `slr-be`; Writing phải gọi nhiều request và có thể thấy dữ liệu đổi giữa các request (đã có cảnh báo `PRISMA_COUNT_MISMATCH`, nhưng không loại trừ hết).
- Danh sách lỗ hổng bảo mật ở [mục 11](#11-xác-thực-và-phân-quyền).

---

## 18. Thuật ngữ

| Thuật ngữ | Nghĩa trong dự án |
|---|---|
| **Run** (`SlrArtifactRun`) | Một lần `slr-be` sinh bộ artifact A1–A10 từ corpus tại thời điểm đó; có `run_id`, `corpus_hash`, danh sách artifact với trạng thái duyệt. |
| **Corpus** | Bản dựng dữ liệu SLR (RQ, studies, documents, findings, evidence, claims) với `corpus_hash`. |
| **Snapshot** | Bản sao bất biến của một run (+ supplements) trong Writing. |
| **Finding (`ExtractedFinding`)** | Giá trị *trích xuất* theo consensus (vd. "Outcome: cải thiện 12%"). **Không** phải kết luận tổng hợp. Tránh nhầm với "finding" trong roadmap thường chỉ kết luận. |
| **Claim / Theme** | Chủ đề do nhà nghiên cứu định nghĩa, gom các finding; nguồn của kết luận tổng hợp (SynthesisFinding). |
| **Evidence** | Trích dẫn nguyên văn kèm vị trí nguồn (source anchor). |
| **Source anchor** | Vị trí trong tài liệu nguồn: section/đoạn/ký tự (và trang nếu có). |
| **Supplement** | Dữ liệu `slr-be` không đóng băng theo run, được sao vào snapshot lúc import. |
| **Readiness** | Kết quả kiểm tra snapshot đủ điều kiện viết: `READY` hoặc `BLOCKED` + danh sách issue. |
| **H1 / H2 / H3** | Điểm duyệt của người dùng: dàn ý / nội dung / bản cuối. |
| **Gate G1–G7** | Các cổng chất lượng của bước kiểm chứng (nguồn, anchor, lập luận, ngữ cảnh, tương thích, citation, phân biệt người nói). |
| **Registry** | Tập study/reference/evidence hợp lệ trong snapshot; citation chỉ được trỏ vào đây. |
| **Fail-closed** | Không chắc chắn thì chặn. |
| **Fable QA** | Bước kiểm thử đối kháng bằng sub-agent Fable 5.1 sau mỗi lần triển khai. |

---

## 19. Prompt mẫu giao việc cho AI-Agent

Sao chép khung dưới đây, thay phần `<...>`:

```text
Bạn đang làm việc trên repo slr-writing-be. Đọc kỹ docs/PROJECT_GUIDE.md trước, đặc biệt
mục 2 (nguyên tắc bắt buộc), 14 (quy ước code) và 16 (checklist thêm module).

Nhiệm vụ: triển khai module <Mx - tên> theo mục 15 của file đó.

Yêu cầu:
- Làm từng bước nhỏ; sau mỗi bước chạy `npm run typecheck && npm run build && npm test`
  (Postgres phải đang chạy: `npm run db:up`). Ghi output vitest ra file, không ống qua grep.
- Chỉ dùng dữ liệu từ snapshot đã lưu. Không gọi slr-be trực tiếp để viết nội dung.
- Không để LLM hoặc dữ liệu ngoài quyết định ID/citation; luôn đối chiếu với snapshot.
- Fail-closed: không chắc thì chặn và báo lỗi rõ ràng, không bịa số liệu.
- Mọi route mới: requireAuth + getOwnedProject, thêm vào src/config/openapi.ts, có test phân quyền.
- Sau khi xong và commit, giao một sub-agent (model fable) test đối kháng toàn diện: chỉ được
  thêm file vào tests/qa/, không sửa src/ hay test cũ, phải tái hiện lỗi trước khi báo.
  Sửa các lỗi thật rồi chạy lại toàn bộ.
- Báo cáo trung thực: test nào đỏ, bước nào bỏ qua, điều gì chưa kiểm chứng được.
- Không push nhánh mới, không sửa dữ liệu dùng chung (Firestore emulator, database của người khác)
  khi chưa được người dùng cho phép. Cuối cùng cập nhật mục 5 và 15 của docs/PROJECT_GUIDE.md.

Bối cảnh bổ sung: <điền>
```
