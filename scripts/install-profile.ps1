$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$profileRoot = Join-Path $projectRoot '.dsh\profiles\resident'

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    throw 'pnpm 未安装，无法安装 dsh resident profile 依赖。'
}

Push-Location $profileRoot
try {
    pnpm install --prefer-offline --force --ignore-workspace
    if ($LASTEXITCODE -ne 0) {
        throw "pnpm install 失败，退出码：$LASTEXITCODE"
    }
}
finally {
    Pop-Location
}
