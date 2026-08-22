$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-Sha256Hex([string]$path) {
  $stream = [IO.File]::OpenRead($path)
  try {
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $sha256.Dispose() }
  } finally {
    $stream.Dispose()
  }
}

$appRootPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$package = Get-Content -Raw -LiteralPath (Join-Path $appRootPath 'package.json') | ConvertFrom-Json
$version = [string]$package.version
$runtimeIdentifier = 'win-x64'
$nodeVersion = '22.13.1'
$stageRootPath = Join-Path ([IO.Path]::GetTempPath()) "coffee-dashboard-release-$PID"
$payloadRootPath = Join-Path $stageRootPath 'payload'
$payloadZipPath = Join-Path $stageRootPath 'payload.zip'
$publishRootPath = Join-Path $stageRootPath 'publish'
$productionAppPath = Join-Path $stageRootPath 'production-app'
$releaseRootPath = Join-Path $appRootPath 'release'
$releaseFileName = "CoffeeDashboard-v$version-$runtimeIdentifier.exe"
$releaseFilePath = Join-Path $releaseRootPath $releaseFileName
$checksumFilePath = "$releaseFilePath.sha256"
$dotnetCommand = if ($env:COFFEE_DASHBOARD_DOTNET) { $env:COFFEE_DASHBOARD_DOTNET } else { (Get-Command dotnet -ErrorAction Stop).Source }

if (Test-Path -LiteralPath $stageRootPath) { throw "临时目录已存在，拒绝覆盖：$stageRootPath" }
New-Item -ItemType Directory -Path $payloadRootPath,$publishRootPath,$productionAppPath,$releaseRootPath -Force | Out-Null

try {
  Push-Location $appRootPath
  try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci 失败。' }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw '生产构建失败。' }
  } finally {
    Pop-Location
  }

  Copy-Item -LiteralPath (Join-Path $appRootPath 'package.json'),(Join-Path $appRootPath 'package-lock.json') -Destination $productionAppPath
  Push-Location $productionAppPath
  try {
    npm ci --omit=dev --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw '生产依赖安装失败。' }
  } finally {
    Pop-Location
  }

  $payloadAppPath = Join-Path $payloadRootPath 'app'
  $payloadRuntimePath = Join-Path $payloadRootPath 'runtime'
  New-Item -ItemType Directory -Path $payloadAppPath,$payloadRuntimePath -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $appRootPath 'dist') -Destination $payloadAppPath -Recurse
  Copy-Item -LiteralPath (Join-Path $productionAppPath 'node_modules') -Destination $payloadAppPath -Recurse
  Copy-Item -LiteralPath (Join-Path $appRootPath 'package.json') -Destination $payloadAppPath

  $nodeArchiveName = "node-v$nodeVersion-win-x64.zip"
  $nodeArchivePath = Join-Path $stageRootPath $nodeArchiveName
  $nodeChecksumsPath = Join-Path $stageRootPath 'SHASUMS256.txt'
  $nodeExtractPath = Join-Path $stageRootPath 'node-runtime'
  $nodeDistributionUrl = "https://nodejs.org/dist/v$nodeVersion"
  Invoke-WebRequest -UseBasicParsing -Uri "$nodeDistributionUrl/$nodeArchiveName" -OutFile $nodeArchivePath
  Invoke-WebRequest -UseBasicParsing -Uri "$nodeDistributionUrl/SHASUMS256.txt" -OutFile $nodeChecksumsPath
  $checksumLine = Get-Content -LiteralPath $nodeChecksumsPath | Where-Object { $_ -match "\s$([regex]::Escape($nodeArchiveName))$" } | Select-Object -First 1
  if (-not $checksumLine) { throw "Node.js 官方校验清单中未找到 $nodeArchiveName。" }
  $expectedNodeHash = ($checksumLine -split '\s+')[0].ToLowerInvariant()
  $actualNodeHash = Get-Sha256Hex $nodeArchivePath
  if ($actualNodeHash -ne $expectedNodeHash) { throw "Node.js 官方发行包 SHA-256 校验失败。" }
  Expand-Archive -LiteralPath $nodeArchivePath -DestinationPath $nodeExtractPath
  $nodeSourceRoot = Join-Path $nodeExtractPath "node-v$nodeVersion-win-x64"
  Copy-Item -LiteralPath (Join-Path $nodeSourceRoot 'node.exe') -Destination (Join-Path $payloadRuntimePath 'node.exe')
  Copy-Item -LiteralPath (Join-Path $nodeSourceRoot 'LICENSE') -Destination (Join-Path $payloadRuntimePath 'NODE-LICENSE.txt')
  Set-Content -LiteralPath (Join-Path $payloadRootPath 'VERSION.txt') -Value "豆迹 CoffeeDashboard v$version`r`nNode.js v$nodeVersion`r`n" -Encoding UTF8

  Compress-Archive -Path (Join-Path $payloadRootPath '*') -DestinationPath $payloadZipPath -CompressionLevel Optimal
  $projectPath = Join-Path $appRootPath 'launcher\CoffeeDashboard.Launcher.csproj'
  & $dotnetCommand publish $projectPath -c Release -r $runtimeIdentifier --self-contained true -o $publishRootPath "-p:PayloadZip=$payloadZipPath" "-p:Version=$version" "-p:FileVersion=$version.0" "-p:InformationalVersion=$version"
  if ($LASTEXITCODE -ne 0) { throw 'Windows 启动器编译失败。' }
  $publishedExecutable = Join-Path $publishRootPath 'CoffeeDashboard.exe'
  if (-not (Test-Path -LiteralPath $publishedExecutable)) { throw '未找到编译后的 CoffeeDashboard.exe。' }

  $smokeProcess = Start-Process -FilePath $publishedExecutable -ArgumentList '--smoke-test' -PassThru -Wait
  if ($smokeProcess.ExitCode -ne 0) { throw "单文件发行包自检失败，退出代码：$($smokeProcess.ExitCode)" }
  $hash = Get-Sha256Hex $publishedExecutable
  Copy-Item -LiteralPath $publishedExecutable -Destination $releaseFilePath -Force
  Set-Content -LiteralPath $checksumFilePath -Value "$hash  $releaseFileName" -Encoding ASCII
  Write-Output "WINDOWS_RELEASE=$releaseFilePath"
  Write-Output "SHA256=$hash"
} finally {
  if (Test-Path -LiteralPath $stageRootPath) {
    $resolvedStage = [IO.Path]::GetFullPath($stageRootPath)
    $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedStage.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw "临时目录越界：$resolvedStage" }
    Remove-Item -LiteralPath $resolvedStage -Recurse -Force
  }
}
