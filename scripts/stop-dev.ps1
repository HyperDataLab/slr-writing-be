<#
.SYNOPSIS
  Dừng toàn bộ hệ thống SLR Writing (Ports 5000, 5100, 5173) và giải phóng 100% RAM.
#>

$ports = @(5000, 5100, 5173)
$stoppedPids = @()

Write-Host "========================================================================" -ForegroundColor Cyan
Write-Host "    SLR AI Writing Platform — Dừng Tiến Trình & Giải Phóng RAM          " -ForegroundColor Cyan
Write-Host "========================================================================" -ForegroundColor Cyan

# 1. Đọc file PID nếu có
$pidFile = Join-Path $PSScriptRoot ".dev-pids.json"
if (Test-Path $pidFile) {
    try {
        $savedPids = Get-Content $pidFile -Raw | ConvertFrom-Json
        foreach ($prop in $savedPids.PSObject.Properties) {
            $pId = $prop.Value
            if ($pId -and (Get-Process -Id $pId -ErrorAction SilentlyContinue)) {
                Stop-Process -Id $pId -Force -ErrorAction SilentlyContinue
                $stoppedPids += $pId
                Write-Host "  ✓ Đã dừng $($prop.Name) (PID: $pId)" -ForegroundColor Yellow
            }
        }
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    } catch {
        # Bỏ qua lỗi đọc file
    }
}

# 2. Quét các cổng 5000, 5100, 5173 để dọn dẹp triệt để mọi tiến trình mồ côi
foreach ($targetPort in $ports) {
    $connections = Get-NetTCPConnection -LocalPort $targetPort -ErrorAction SilentlyContinue
    if ($connections) {
        foreach ($conn in $connections) {
            $procId = $conn.OwningProcess
            if ($procId -gt 4 -and ($stoppedPids -notcontains $procId)) {
                $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
                if ($proc) {
                    $procName = $proc.ProcessName
                    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
                    $stoppedPids += $procId
                    Write-Host "  ✓ Đã giải phóng cổng $targetPort`: Dừng $procName (PID: $procId)" -ForegroundColor Yellow
                }
            }
        }
    }
}

if ($stoppedPids.Count -eq 0) {
    Write-Host "  ✓ Không có tiến trình nào đang chiếm dụng các cổng 5000, 5100, 5173." -ForegroundColor Green
} else {
    Write-Host "  ✓ Đã dừng tổng cộng $($stoppedPids.Count) tiến trình." -ForegroundColor Green
}

Write-Host "`n🎉 Toàn bộ cổng đã được giải phóng. Tài nguyên RAM đã được hoàn trả!" -ForegroundColor Green
Write-Host "========================================================================`n" -ForegroundColor Cyan
