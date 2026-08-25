$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$env:DSH_HOME = Join-Path $projectRoot '.dsh'

Push-Location $projectRoot
try {
    dsh --profile resident --dump-config
}
finally {
    Pop-Location
}
