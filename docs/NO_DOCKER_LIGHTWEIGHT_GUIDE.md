# Hướng dẫn Khởi động Siêu Nhẹ & Tối ưu Tài nguyên (No-Docker Guide)

> **Mục tiêu:** Vận hành toàn bộ hệ sinh thái SLR Writing (Mock SLR, Writing Backend, Writing Frontend) với mức tiêu thụ tài nguyên tối thiểu, **tiết kiệm >95% RAM** so với Docker Desktop.

---

## 1. Tại sao Docker Desktop lại nặng trên Windows?

Khi cài đặt và kích hoạt **Docker Desktop trên Windows**:
1. **Tiến trình Máy ảo `vmmem` (WSL2):** Mặc định chiếm trước từ **2.5 GB đến 4.5 GB RAM** của hệ thống ngay cả khi chưa chạy container nào nặng.
2. **Chi phí Ảo hóa CPU (Hypervisor Overhead):** Làm quạt tản nhiệt của laptop quay liên tục và tiêu hao nhiều pin.
3. **Môi trường chia sẻ:** Các container đóng gói cả Linux kernel mini, glibc và các tầng mạng ảo không cần thiết cho môi trường dev.

### 📊 Bảng so sánh Tiêu thụ Tài nguyên Thực tế

| Thành phần | Chạy qua Docker Desktop | Chạy Native (Script 1-Click) | Mức Tiết Kiệm |
|---|:---:|:---:|:---:|
| **Mock SLR Server** (:5000) | Container Node (~180 MB) | Node.js native (**~37 MB**) | Giảm ~80% |
| **SLR Writing Backend** (:5100) | Container Node (~280 MB) | Node.js native (**~73 MB**) | Giảm ~74% |
| **SLR Writing Frontend** (:5173) | Container Vite/Node (~220 MB) | Vite dev native (**~61 MB**) | Giảm ~72% |
| **WSL2 / Docker Engine (vmmem)**| **~2,800 MB - 3,500 MB** | **0 MB** (Không chạy) | **100%** |
| **TỔNG RAM TIÊU THỤ** | **~3,500 MB – 4,200 MB** | **~171 MB** | **Tiết kiệm >95% RAM!** |

---

## 2. Giải phóng hoàn toàn Docker cho Cơ sở dữ liệu (PostgreSQL)

Hệ thống Writing Backend sử dụng PostgreSQL cho mô hình dữ liệu Phase 1 (snapshots, revisions, audit lineage). Để **hoàn toàn không cần bật Docker Desktop**, bạn có thể chọn 1 trong 2 cách sau:

### 🌟 Lựa chọn 1: Dùng Cloud Database miễn phí (Neon.tech) — *0 MB RAM máy tính* (Khuyên dùng nhất)
1. Truy cập [https://neon.tech](https://neon.tech) và đăng ký tài khoản miễn phí (hỗ trợ đăng nhập qua GitHub/Google, không cần thẻ tín dụng).
2. Bấm **Create Project** (mất đúng 10 giây). Neon cung cấp sẵn một cơ sở dữ liệu PostgreSQL Serverless chuẩn tốc độ cao (0.5 GB lưu trữ miễn phí vĩnh viễn).
3. Sao chép chuỗi kết nối (`Connection string`) dạng:
   ```text
   postgresql://neondb_owner:npg_abc123@ep-cool-lake-xxxx.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
4. Mở file `.env` trong `slr-writing-be`, thay thế dòng `DATABASE_URL`:
   ```env
   DATABASE_URL="postgresql://neondb_owner:npg_abc123@ep-cool-lake-xxxx.us-east-2.aws.neon.tech/neondb?sslmode=require"
   ```
5. Chạy lệnh migrate khởi tạo cấu trúc bảng:
   ```powershell
   npm run db:deploy
   ```
👉 **Từ đây trở đi, bạn có thể xóa hoặc tắt vĩnh viễn Docker Desktop! Máy tính bạn không tốn dù chỉ 1 MB RAM cho Database.**

---

### 🖥️ Lựa chọn 2: Cài PostgreSQL Native cho Windows — *Tốn ~35 MB RAM*
Nếu muốn chạy hoàn toàn offline không cần internet:
1. Mở PowerShell và cài đặt PostgreSQL chính thức của Windows:
   ```powershell
   winget install PostgreSQL.PostgreSQL
   ```
2. PostgreSQL sẽ chạy như một Windows Service nhẹ nhàng ở cổng `5432` hoặc `5433` và chỉ tiêu thụ khoảng 30–35 MB RAM tĩnh.

---

## 3. Cách sử dụng Tiện ích Khởi động 1-Click

Hệ thống đã được trang bị sẵn bộ công cụ tự động hóa khởi động và dừng toàn bộ hệ sinh thái:

### 🖱️ Cách 1: Double-Click chuột trong File Explorer (Tiện lợi nhất)
Tại thư mục gốc của đồ án (`ScientificJournalPublicationTrendTrackingSystem`):
- **Bật hệ thống:** Double-click file [`start-writing-stack.bat`](../../start-writing-stack.bat).
  - Tự động kiểm tra PostgreSQL.
  - Khởi động Mock SLR (:5000), Writing Backend (:5100), Writing Frontend (:5173).
  - Tính toán và in bảng RAM tiêu thụ thực tế.
  - Tự động mở trình duyệt web tới đúng project đang làm việc.
- **Tắt hệ thống:** Double-click file [`stop-writing-stack.bat`](../../stop-writing-stack.bat).
  - Quét sạch các cổng 5000, 5100, 5173.
  - Dừng các tiến trình và giải phóng 100% tài nguyên RAM.

---

### ⌨️ Cách 2: Chạy bằng lệnh npm
Tại thư mục `slr-writing-be`:
```bash
# Khởi động toàn bộ
npm run start:all

# Dừng toàn bộ
npm run stop:all
```

---

### 📜 Cách 3: Chạy trực tiếp file PowerShell Script
```powershell
# Khởi động
.\scripts\start-dev.ps1

# Dừng
.\scripts\stop-dev.ps1
```

---

## 4. Kiểm tra Nhật ký và Gỡ lỗi (Debugging)

Tất cả nhật ký hoạt động (logs) của các tiến trình chạy ngầm được ghi nhận độc lập tại thư mục `logs/` trong `slr-writing-be`:
- `logs/slr-mock.log`: Nhật ký của máy chủ SLR Mock (:5000).
- `logs/writing-be.log`: Nhật ký của máy chủ Writing Backend (:5100).
- `logs/writing-fe.log`: Nhật ký của máy chủ Vite Frontend (:5173).
- `scripts/.dev-pids.json`: Lưu trữ PID của các tiến trình đang chạy để quản lý vòng đời an toàn.
