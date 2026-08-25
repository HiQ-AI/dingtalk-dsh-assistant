$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$env:DSH_HOME = Join-Path $projectRoot '.dsh'
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$nodeMajor = [int]((& $nodeExe --version).TrimStart('v').Split('.')[0])
$dshCommand = Get-Command dsh.cmd -ErrorAction Stop
$dshEntry = Join-Path (Split-Path -Parent $dshCommand.Source) 'node_modules\@deepseek-ai\dsh\lib\bin.js'

if ($nodeMajor -lt 24) { throw "dsh 需要 Node.js 24 或更高版本，当前为 $(& $nodeExe --version)。" }
if (-not (Test-Path -LiteralPath $dshEntry)) { throw "缺少本机 dsh 启动入口：$dshEntry" }

Push-Location $projectRoot
try {
    & $nodeExe $dshEntry --profile resident --dump-config
    if ($LASTEXITCODE -ne 0) { throw "dsh profile dump 失败，退出码：$LASTEXITCODE" }
}
finally {
    Pop-Location
}
