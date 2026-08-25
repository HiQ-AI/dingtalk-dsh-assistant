param(
    [string]$ProxyUrl
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$nodeMajor = [int]((& $nodeExe --version).TrimStart('v').Split('.')[0])
$dshCommand = Get-Command dsh.cmd -ErrorAction Stop
$dshEntry = Join-Path (Split-Path -Parent $dshCommand.Source) 'node_modules\@deepseek-ai\dsh\lib\bin.js'
$residentState = Join-Path $dshHome 'storages\dingtalk-group-assistant\dingtalk_group_assistant.json'

if ([string]::IsNullOrWhiteSpace($ProxyUrl) -and (Test-Path -LiteralPath $residentState)) {
    $state = Get-Content -LiteralPath $residentState -Raw | ConvertFrom-Json
    $ProxyUrl = $state.data.scheduler.runtime.proxyUrl
}
if ([string]::IsNullOrWhiteSpace($ProxyUrl)) {
    $ProxyUrl = Get-ItemPropertyValue -Path 'HKCU:\Environment' -Name 'HTTP_PROXY' -ErrorAction SilentlyContinue
}

if ($nodeMajor -lt 24) { throw "dsh 需要 Node.js 24 或更高版本，当前为 $(& $nodeExe --version)。" }
if (-not (Test-Path -LiteralPath $dshEntry)) { throw "缺少本机 dsh 启动入口：$dshEntry" }

$env:DSH_HOME = $dshHome
if (-not [string]::IsNullOrWhiteSpace($ProxyUrl)) {
    $env:HTTP_PROXY = $ProxyUrl
    $env:HTTPS_PROXY = $ProxyUrl
    $env:http_proxy = $ProxyUrl
    $env:https_proxy = $ProxyUrl
}
$env:NO_PROXY = '127.0.0.1,localhost'
$env:no_proxy = $env:NO_PROXY
Push-Location $projectRoot
try {
    & $nodeExe --use-env-proxy $dshEntry web --no-open
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
