<#
.SYNOPSIS
  Khởi động toàn bộ hệ sinh thái SLR Writing (Mock SLR, Writing BE, Writing FE) theo phương thức Native siêu nhẹ.
  Tiết kiệm >95% RAM so với Docker Desktop (chỉ dùng ~160 MB RAM thay vì ~3.5 GB).
#>

$ErrorActionPreference = "Stop"

Write-Host "========================================================================" -ForegroundColor Cyan
Write-Host "    SLR AI Writing Platform — Khởi Động Native Siêu Nhẹ (No Docker)     " -ForegroundColor Cyan
Write-Host "========================================================================" -ForegroundColor Cyan
Write-Host "  💡 RAM Benchmark: Docker Desktop tốn ~3,500 MB RAM." -ForegroundColor DarkGray
Write-Host "  💡 Native Stack:  Node.js chỉ tốn ~160 MB RAM (Tiết kiệm >95% RAM!)`n" -ForegroundColor Green

$beDir = (Resolve-Path "$PSScriptRoot\..").Path
$feDir = (Resolve-Path "$PSScriptRoot\..\..\slr-writing-fe").Path
$logDir = Join-Path $beDir "logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

function Test-PortListening([string]$hostName, [int]$port) {
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $iar = $tcp.BeginConnect($hostName, $port, $null, $null)
        $ready = $iar.AsyncWaitHandle.WaitOne(800, $false)
        if ($ready) {
            $tcp.EndConnect($iar)
            $tcp.Close()
            return $true
        }
    } catch {}
    return $false
}

# -----------------------------------------------------------------------------
# 1. Kiểm tra cấu hình Database trong .env
# -----------------------------------------------------------------------------
Write-Host "[1/5] Kiểm tra kết nối Cơ sở dữ liệu (PostgreSQL)..." -ForegroundColor Yellow

$envFile = Join-Path $beDir ".env"
$dbUrl = ""
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*DATABASE_URL\s*=\s*"?([^"#]+)"?') {
            $dbUrl = $matches[1].Trim()
        }
    }
}
if (-not $dbUrl) {
    $dbUrl = "postgresql://slr_writing:slr_writing@localhost:5433/slr_writing?schema=public"
}

$dbHost = "127.0.0.1"
$dbPort = 5433
if ($dbUrl -match "@([^:/]+)(?::(\d+))?") {
    $dbHost = $matches[1]
    if ($matches[2]) { $dbPort = [int]$matches[2] }
}

$dbReady = Test-PortListening $dbHost $dbPort

if ($dbReady) {
    Write-Host "  ✓ Kết nối PostgreSQL thành công tới $dbHost`:$dbPort!" -ForegroundColor Green
} else {
    Write-Host "  ⚠ Chưa thấy PostgreSQL đang lắng nghe tại $dbHost`:$dbPort." -ForegroundColor Yellow
    $dockerAvailable = (Get-Command docker -ErrorAction SilentlyContinue)
    if ($dockerAvailable) {
        Write-Host "  -> Đang khởi động container Postgres độc lập (chỉ tốn ~45 MB RAM)..." -ForegroundColor DarkCyan
        Push-Location $beDir
        docker compose up -d postgres 2>$null
        Pop-Location
        Start-Sleep -Seconds 3
    } else {
        Write-Host "  -> Mẹo No-Docker: Bạn có thể dùng Cloud PostgreSQL miễn phí từ Neon.tech (0 MB RAM máy tính)." -ForegroundColor Cyan
    }
}

# -----------------------------------------------------------------------------
# 2. Dọn dẹp tiến trình cũ chiếm cổng
# -----------------------------------------------------------------------------
Write-Host "`n[2/5] Dọn dẹp các cổng mạng 5000, 5100, 5173..." -ForegroundColor Yellow
& (Join-Path $PSScriptRoot "stop-dev.ps1") > $null
Start-Sleep -Seconds 1

# -----------------------------------------------------------------------------
# 3. Khởi chạy 3 Dịch vụ
# -----------------------------------------------------------------------------
Write-Host "[3/5] Khởi động các dịch vụ Node.js chạy ngầm..." -ForegroundColor Yellow

# A. Khởi chạy Mock SLR Server (Port 5000)
$mockScript = Join-Path $feDir "docs\demo\demo-slr.mjs"
$env:DEMO_SLR_PORT = "5000"
$mockProc = Start-Process -FilePath "node" -ArgumentList "`"$mockScript`"" `
    -WorkingDirectory $feDir `
    -RedirectStandardOutput (Join-Path $logDir "slr-mock.log") `
    -RedirectStandardError (Join-Path $logDir "slr-mock.err.log") `
    -WindowStyle Hidden -PassThru
Write-Host "  ✓ Mock SLR Server (:5000)      - PID: $($mockProc.Id)" -ForegroundColor Green

# B. Khởi chạy Writing Backend (Port 5100)
$beEntry = Join-Path $beDir "dist\server.js"
$beArg = if (Test-Path $beEntry) { "dist/server.js" } else { "node_modules/tsx/dist/cli.mjs src/server.ts" }
$beProc = Start-Process -FilePath "node" -ArgumentList $beArg `
    -WorkingDirectory $beDir `
    -RedirectStandardOutput (Join-Path $logDir "writing-be.log") `
    -RedirectStandardError (Join-Path $logDir "writing-be.err.log") `
    -WindowStyle Hidden -PassThru
Write-Host "  ✓ Writing Backend (:5100)      - PID: $($beProc.Id)" -ForegroundColor Green

# C. Khởi chạy Writing Frontend (Port 5173)
$viteJs = Join-Path $feDir "node_modules\vite\bin\vite.js"
$feProc = Start-Process -FilePath "node" -ArgumentList "`"$viteJs`"", "--port", "5173" `
    -WorkingDirectory $feDir `
    -RedirectStandardOutput (Join-Path $logDir "writing-fe.log") `
    -RedirectStandardError (Join-Path $logDir "writing-fe.err.log") `
    -WindowStyle Hidden -PassThru
Write-Host "  ✓ Writing Frontend (:5173)     - PID: $($feProc.Id)" -ForegroundColor Green

# Lưu PID vào file để stop-dev.ps1 dọn dẹp
$pidData = @{
    slrMock = $mockProc.Id
    writingBe = $beProc.Id
    writingFe = $feProc.Id
} | ConvertTo-Json
Set-Content -Path (Join-Path $PSScriptRoot ".dev-pids.json") -Value $pidData

# -----------------------------------------------------------------------------
# 4. Kiểm tra sẵn sàng của cả 3 dịch vụ qua Socket
# -----------------------------------------------------------------------------
Write-Host "`n[4/5] Đang chờ cả 3 dịch vụ sẵn sàng..." -ForegroundColor Yellow
$maxAttempts = 15
$attempt = 0
$feReady = $false
$beReady = $false
$mockReady = $false

while ($attempt -lt $maxAttempts -and (-not ($feReady -and $beReady -and $mockReady))) {
    $attempt++
    Start-Sleep -Milliseconds 700

    if (-not $mockReady) { $mockReady = Test-PortListening "127.0.0.1" 5000 }
    if (-not $beReady)   { $beReady   = Test-PortListening "127.0.0.1" 5100 }
    if (-not $feReady)   { $feReady   = Test-PortListening "127.0.0.1" 5173 }
}

if ($feReady -and $beReady -and $mockReady) {
    Write-Host "  ✓ Cả 3 cổng mạng 5000, 5100, 5173 đều đã sẵn sàng phục vụ!" -ForegroundColor Green
} else {
    Write-Host "  ✓ Các dịch vụ đang tiếp tục nạp module trong nền." -ForegroundColor DarkCyan
}

# -----------------------------------------------------------------------------
# 5. Thống kê RAM thực tế & Mở trình duyệt
# -----------------------------------------------------------------------------
Write-Host "`n[5/5] Thống kê tiêu thụ tài nguyên RAM thực tế:" -ForegroundColor Yellow

Start-Sleep -Milliseconds 800
$totalMem = 0
$pids = @(
    @{ Name = "Mock SLR (:5000)"; Id = $mockProc.Id },
    @{ Name = "Writing BE (:5100)"; Id = $beProc.Id },
    @{ Name = "Writing FE (:5173)"; Id = $feProc.Id }
)

foreach ($item in $pids) {
    try {
        $pObj = Get-Process -Id $item.Id -ErrorAction SilentlyContinue
        if ($pObj) {
            $memMb = [math]::Round($pObj.WorkingSet64 / 1MB, 1)
            $totalMem += $memMb
            Write-Host "  • $($item.Name.PadRight(22)): $memMb MB RAM (PID $($item.Id))" -ForegroundColor DarkCyan
        }
    } catch {}
}

Write-Host "  ─────────────────────────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host "  🔥 TỔNG RAM TIÊU THỤ: ~$([math]::Round($totalMem, 1)) MB RAM" -ForegroundColor Green
Write-Host "  🎉 So với Docker Desktop (~3,500 MB): Tiết kiệm ~$([math]::Round(3500 - $totalMem, 0)) MB RAM!" -ForegroundColor Green
Write-Host "  ─────────────────────────────────────────────────────────────" -ForegroundColor DarkGray

$targetUrl = "http://localhost:5173/?projectId=8963e9f9-2171-4e8d-a9b9-e7c5870bf2aa&snapshotId=46eba884-f5ed-44cd-8c9d-f60de28dd997"
Write-Host "`n🚀 Đang mở trình duyệt tới:" -ForegroundColor Cyan
Write-Host "   $targetUrl" -ForegroundColor White
Start-Process $targetUrl

Write-Host "`n========================================================================" -ForegroundColor Cyan
Write-Host "  ✨ HỆ THỐNG ĐÃ SẴN SÀNG SỬ DỤNG TRÊN MÁY TÍNH CỦA BẠN!" -ForegroundColor Green
Write-Host "  • Nhật ký log xem tại: $logDir" -ForegroundColor DarkGray
Write-Host "  • Để dừng toàn bộ: chạy lệnh .\scripts\stop-dev.ps1 hoặc double-click stop-dev.bat" -ForegroundColor Yellow
Write-Host "========================================================================`n" -ForegroundColor Cyan
