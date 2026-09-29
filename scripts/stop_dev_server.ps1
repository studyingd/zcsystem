# 停止本地开发服务器（run.py）。
# 用法：powershell -File scripts/stop_dev_server.ps1
#
# 注意：Start-Process 启动的 uv 只是包装进程，直接 Stop-Process 杀 uv 会把
# python 子进程变成孤儿——它仍占用 5000 端口（Windows 允许重复绑定），之后
# 新启动的实例会与它共享端口、请求被随机分流到旧代码进程，表现为"改了代码
# 不生效"。本脚本按进程树强杀（/T），并兜底清理仍在监听 5000 的进程。

$ErrorActionPreference = 'SilentlyContinue'

$pidFile = Join-Path $PSScriptRoot '..\.run-pid'
if (Test-Path $pidFile) {
    $launcherPid = (Get-Content $pidFile -ErrorAction SilentlyContinue).Trim()
    if ($launcherPid -match '^\d+$') {
        taskkill /PID $launcherPid /T /F | Out-Null
        Write-Host "killed process tree of launcher PID $launcherPid"
    }
    Remove-Item $pidFile -Force
}

# 兜底：清理仍监听 5000 端口的进程（历史孤儿）
$listeners = Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue
foreach ($conn in $listeners) {
    taskkill /PID $conn.OwningProcess /T /F | Out-Null
    Write-Host "killed orphan listener PID $($conn.OwningProcess)"
}

Start-Sleep -Seconds 1
if (Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue) {
    Write-Warning 'port 5000 is still in use'
    exit 1
}
Write-Host 'port 5000 released, server stopped.'
