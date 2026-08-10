# Samaritano - Start rapido (assume install.ps1 ja rodou)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -Path $ScriptDir

Clear-Host
Write-Host ""
Write-Host "  S A M A R I T A N O" -ForegroundColor Red
Write-Host "  Tiago Rocha // Inteligencia local e online" -ForegroundColor DarkGray
Write-Host ""

# Validate state
if (-not (Test-Path "node_modules")) {
    Write-Host "  [ERRO]  Dependencias nao instaladas." -ForegroundColor Red
    Write-Host "  Rode install.bat primeiro." -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Pressione Enter pra sair"
    exit 1
}

# Read PORT from .env when present (default 5070)
$port = 5070
if (Test-Path ".env") {
    $envContent = Get-Content ".env" -Raw -Encoding UTF8
    if ($envContent -match 'PORT=(\d+)') {
        $port = [int]$Matches[1]
    }
}

$url = "http://localhost:$port"
$lanUrl = $null
try {
    $appConfig = Get-Content "config.json" -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($appConfig.server.bindLan) {
        $lanIp = [System.Net.Dns]::GetHostAddresses($env:COMPUTERNAME) |
            Where-Object { $_.AddressFamily -eq 'InterNetwork' -and -not $_.IPAddressToString.StartsWith('127.') } |
            Select-Object -First 1
        if ($lanIp) {
            $lanScheme = if ($appConfig.server.httpsEnabled) { 'https' } else { 'http' }
            $lanPort = if ($appConfig.server.httpsEnabled) { [int]$appConfig.server.httpsPort } else { $port }
            $lanUrl = "$($lanScheme)://$($lanIp.IPAddressToString):$lanPort"
        }
    }
} catch {}

# Inicia o motor local quando o Ollama estiver instalado.
$ollama = Get-Command ollama -ErrorAction SilentlyContinue
if ($ollama) {
    try {
        Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 1 | Out-Null
        Write-Host "  Ollama: ativo" -ForegroundColor Green
    } catch {
        Write-Host "  Iniciando Ollama..." -ForegroundColor Yellow
        Start-Process -FilePath $ollama.Source -ArgumentList 'serve' -WindowStyle Hidden
        Start-Sleep -Seconds 2
    }
} else {
    Write-Host "  [AVISO] Ollama ainda nao esta instalado." -ForegroundColor Yellow
}

Write-Host "  Iniciando servidor em $url" -ForegroundColor White
if ($lanUrl) {
    Write-Host "  Celular na mesma rede: $lanUrl" -ForegroundColor Cyan
}
Write-Host "  Pra parar: feche essa janela ou aperte Ctrl+C" -ForegroundColor Gray
Write-Host "  Motor local: llama3.2:3b + qwen3:4b-instruct" -ForegroundColor DarkGray
Write-Host ""

# Abre o navegador somente depois que o servidor tiver tempo de subir.
$openBrowser = "Start-Sleep -Seconds 3; Start-Process '$url'"
try {
    Start-Process powershell.exe -ArgumentList '-NoProfile', '-WindowStyle', 'Hidden', '-Command', $openBrowser -WindowStyle Hidden
} catch {
    Write-Host "  Abra manualmente: $url" -ForegroundColor Yellow
}

Write-Host "============================================================" -ForegroundColor DarkGray
& npm start

Write-Host ""
Write-Host "Servidor parado." -ForegroundColor Yellow
exit 0
