$ErrorActionPreference = 'Stop'

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$toolchainRoot = 'C:\Users\rique\Documents\Codex'
$javaHome = Join-Path $toolchainRoot '.jdk17\jdk-17.0.20+8'
$androidSdk = Join-Path $toolchainRoot '.android-sdk'
$portableGradle = Join-Path $toolchainRoot '.gradle89\gradle-8.9\bin\gradle.bat'
$gradleWrapper = Join-Path $projectDir 'gradlew.bat'

if (-not (Test-Path (Join-Path $javaHome 'bin\java.exe'))) {
  throw "JDK 17 portátil não encontrado em $javaHome"
}
if (-not (Test-Path (Join-Path $androidSdk 'cmdline-tools\latest\bin\sdkmanager.bat'))) {
  throw "Android SDK portátil não encontrado em $androidSdk"
}
if (-not (Test-Path $portableGradle) -and -not (Test-Path $gradleWrapper)) {
  throw 'Gradle 8.9 portátil e Gradle Wrapper não foram encontrados.'
}

$env:JAVA_HOME = $javaHome
$env:ANDROID_HOME = $androidSdk
$env:ANDROID_SDK_ROOT = $androidSdk
$env:GRADLE_USER_HOME = Join-Path $toolchainRoot '.gradle-home'
$env:Path = "$(Join-Path $javaHome 'bin');$(Join-Path $androidSdk 'platform-tools');$env:Path"

$gradleCommand = if (Test-Path $gradleWrapper) { $gradleWrapper } else { $portableGradle }

Push-Location $projectDir
try {
  & $gradleCommand --no-daemon assembleDebug
  if ($LASTEXITCODE -ne 0) {
    throw "Gradle terminou com código $LASTEXITCODE"
  }

  $apk = Join-Path $projectDir 'app\build\outputs\apk\debug\app-debug.apk'
  if (-not (Test-Path $apk)) {
    throw 'A compilação terminou, mas o APK não foi localizado.'
  }

  Write-Host "APK pronto: $apk" -ForegroundColor Green
} finally {
  Pop-Location
}
