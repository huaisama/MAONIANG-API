$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
Write-Host ""
Write-Host "  ReplyAPI 启动中..." -ForegroundColor Cyan
Write-Host "  停止：Ctrl+C" -ForegroundColor DarkGray
Write-Host ""
node server.js
