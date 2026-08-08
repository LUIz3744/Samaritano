$ErrorActionPreference = 'Stop'

$toolchainRoot = 'C:\Users\rique\Documents\Codex'
$javaHome = Join-Path $toolchainRoot '.jdk17\jdk-17.0.20+8'
$androidSdk = Join-Path $toolchainRoot '.android-sdk'
$sdkManager = Join-Path $androidSdk 'cmdline-tools\latest\bin\sdkmanager.bat'

$env:JAVA_HOME = $javaHome
$env:ANDROID_HOME = $androidSdk
$env:ANDROID_SDK_ROOT = $androidSdk

if (-not (Test-Path $sdkManager)) {
  throw "sdkmanager não encontrado em $sdkManager"
}

$licenses = (1..20 | ForEach-Object { 'y' }) -join [Environment]::NewLine
$licenses | & $sdkManager --licenses
& $sdkManager 'platform-tools' 'platforms;android-35' 'build-tools;35.0.0' 'ndk;29.0.13113456' 'cmake;3.31.6'
if ($LASTEXITCODE -ne 0) {
  throw "A instalação do Android SDK terminou com código $LASTEXITCODE"
}

Write-Host 'Android SDK 35 instalado.' -ForegroundColor Green
