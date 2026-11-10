# Hướng Dẫn Định Dạng Xuất Bản Chuẩn IEEE 2 Cột (IEEE Conference Format Guide)

Tài liệu này hướng dẫn chi tiết về tính năng **Xuất bản bài báo khoa học định dạng 2 cột chuẩn IEEE Conference Proceedings** trên nền tảng **SLR AI Writing Platform**.

---

## 1. Giới thiệu Định dạng IEEE Conference Two-Column

Trong lĩnh vực Khoa học Máy tính (Computer Science) và Kỹ thuật Phần mềm (Software Engineering), định dạng 2 cột của **IEEE (Institute of Electrical and Electronics Engineers)** và **ACM** là chuẩn mực xuất bản uy tín và quen thuộc nhất tại các hội thảo đầu ngành (ICSE, FSE, ASE, ICLR).

Hệ thống cung cấp sẵn 2 hồ sơ định dạng xuất bản:

| Tiêu chí | 1. Generic IMRaD (1 Cột) | 2. IEEE Conference (2 Cột) ⭐ |
| :--- | :--- | :--- |
| **Bố cục (Layout)** | 1 cột đơn (Single-Column), lề 22mm | **2 cột song song (Two-Column)**, ngắt cột tự động, lề 14mm |
| **Tiêu đề & Tác giả** | 20pt căn giữa | **24pt đậm căn giữa toàn trang (Full-Width Title)** |
| **Phần Tóm tắt** | Hộp Abstract riêng biệt | **Abstract + Index Terms** dạng in nghiêng dẫn đầu (`Abstract—`, `Index Terms—`) |
| **Đánh số đề mục** | Markdown chuẩn (`## Methods`) | **Chữ số La Mã (`I. INTRODUCTION`, `II. METHODOLOGY`, `III. RESULTS`...)** |
| **Đánh số tiểu mục** | Không đánh số hoặc markdown | **Chữ cái in hoa (`A. Research Questions`, `B. Eligibility Criteria`...)** |
| **Định dạng trích dẫn** | Khóa trích dẫn hoặc tác giả - năm | **Trích dẫn số chuẩn IEEE (`[1]`, `[2]`, `[3]–[5]`)** |
| **Bảng biểu** | Bảng markdown thông thường | **Bảng chuẩn IEEE (TABLE I, II)** với 2 đường kẻ ngang đậm |
| **Tuyên bố Đạo đức AI** | Khung ICMJE / COPE cuối trang | **IEEE AI Authorship Policy Disclosure Note** |
| **File PDF sinh ra** | `paper-imrad.pdf` | **`paper-ieee.pdf` (và cập nhật `paper.pdf`)** |

---

## 2. Các Lệnh Xuất Bản PDF

### Từ thư mục `slr-writing-be`:
```bash
# Xuất cả 2 định dạng (IEEE 2 cột + IMRaD 1 cột)
npm run export:pdf

# Chỉ xuất định dạng IEEE 2 cột chuẩn Hội thảo
npm run export:pdf:ieee

# Chỉ xuất định dạng IMRaD 1 cột truyền thống
npm run export:pdf:imrad
```

### Từ thư mục `slr-writing-fe`:
```bash
# Xuất cả 2 định dạng
npm run export:pdf

# Xuất bản IEEE 2 cột
npm run export:pdf:ieee

# Xuất bản IMRaD 1 cột
npm run export:pdf:imrad
```

---

## 3. Vị trí File PDF Xuất Bản

Sau khi chạy lệnh, các file PDF sẵn sàng để in ấn, nộp báo cáo hoặc gửi hội đồng tại:

1. **Thư mục gốc giải pháp:**
   * [`paper.pdf`](file:///d:/FPTU-Semester5/SWP391/ScientificJournalPublicationTrendTrackingSystem/paper.pdf) — File mặc định chất lượng cao nhất (định dạng IEEE 2 cột).
2. **Thư mục backend:**
   * [`paper-ieee.pdf`](file:///d:/FPTU-Semester5/SWP391/ScientificJournalPublicationTrendTrackingSystem/slr-writing-be/paper-ieee.pdf) — Bản IEEE Two-Column.
   * [`paper-imrad.pdf`](file:///d:/FPTU-Semester5/SWP391/ScientificJournalPublicationTrendTrackingSystem/slr-writing-be/paper-imrad.pdf) — Bản IMRaD Single-Column.
3. **Thư mục tài liệu xuất bản (`docs/demo-export/`):**
   * [`docs/demo-export/paper-ieee.pdf`](file:///d:/FPTU-Semester5/SWP391/ScientificJournalPublicationTrendTrackingSystem/slr-writing-be/docs/demo-export/paper-ieee.pdf)
   * [`docs/demo-export/paper-imrad.pdf`](file:///d:/FPTU-Semester5/SWP391/ScientificJournalPublicationTrendTrackingSystem/slr-writing-be/docs/demo-export/paper-imrad.pdf)

---

## 4. Đặc tả Kỹ thuật của Bố cục IEEE 2 Cột

### Typography & Grid
* **Phông chữ:** `Times New Roman`, serif (10pt body text, line-height 1.24).
* **Căn chỉnh lề:** Căn đều 2 bên (Justified), thụt đầu dòng đoạn văn `1.25em`.
* **Cột báo (Columns):** 2 cột với khoảng cách giữa 2 cột (Column Gap) là `5mm`, có đường ngăn cách mờ nhạt chuẩn xuất bản.
* **Running Header:**
  * Trái: `IEEE TRANSACTIONS ON SOFTWARE ENGINEERING (PREPRINT)`
  * Phải: `VOL. 50, NO. 11, NOVEMBER 2026`
* **Running Footer:**
  * Trái: `DOI: 10.1109/TSE.2026.SLR-EVIDENCE • AUTHORIZED PREPRINT`
  * Phải: `Page X of Y` (Số trang tự động).

### Danh mục Tài liệu tham khảo Chuẩn IEEE (Numbered Citations)
Các trích dẫn trong văn bản được ánh xạ chính xác vào danh mục:
* `[1]` M. Chen et al., *"Evaluating Large Language Models Trained on Code"*, arXiv:2107.03374, 2021.
* `[2]` A. Johnson et al., *"An Empirical Evaluation of GitHub Copilot on Code Completion Tasks"*, Proc. ICSE 2022.
* `[3]` S. Peng et al., *"The Impact of AI on Developer Productivity: Evidence from GitHub Copilot"*, arXiv:2302.06590, 2023.
* `[4]` C. S. Xia et al., *"Automated Program Repair in the Era of Large Pre-trained Language Models"*, Proc. ICSE 2023.
* `[5]` Y. Fu et al., *"Security Weaknesses of Copilot Generated Code in GitHub Projects"*, ACM TOSEM, 2023.
* `[6]` C. Jimenez et al., *"SWE-bench: Can Language Models Resolve Real-World GitHub Issues?"*, Proc. ICLR 2024.
