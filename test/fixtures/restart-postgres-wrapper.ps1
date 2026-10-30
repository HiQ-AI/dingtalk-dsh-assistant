param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('check', 'prepare', 'serve', 'identity', 'cleanup')]
    [string]$Action
)
$ErrorActionPreference = 'Stop'
$pgBin = 'D:\soft\PostgreSQL\16\bin'
$root = Join-Path $PSScriptRoot 'postgres'
$data = Join-Path $root 'data'
$marker = Join-Path $root 'owner.txt'
$ownerText = 'synthetic-task-owner'
$portNumber = 25428

foreach ($tool in @('initdb.exe', 'postgres.exe', 'psql.exe', 'pg_ctl.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $pgBin $tool))) { throw "missing $tool" }
}
if ($Action -eq 'check') {
    if (Get-NetTCPConnection -State Listen -LocalPort $portNumber -ErrorAction SilentlyContinue) {
        throw 'Dedicated port already occupied; inspect original process before reuse'
    }
    Write-Output "zero-write check: PG16 tools available; loopback port=$portNumber; owned data=$data"
    exit 0
}
if ($Action -eq 'prepare') {
    if (Test-Path -LiteralPath $data) { throw 'Existing data: reconcile original instance; do not reinitialize' }
    if (Get-NetTCPConnection -State Listen -LocalPort $portNumber -ErrorAction SilentlyContinue) { throw 'Port occupied' }
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    & (Join-Path $pgBin 'initdb.exe') -D $data -U postgres --no-locale --encoding=UTF8 --auth=trust
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Set-Content -LiteralPath $marker -Value $ownerText -Encoding utf8
    Write-Output 'Prepared task-only empty cluster; not started'
    exit 0
}
if (-not (Test-Path -LiteralPath $marker) -or (Get-Content -LiteralPath $marker -Raw).Trim() -ne $ownerText) {
    throw 'Ownership marker mismatch; no process action permitted'
}
if ($Action -eq 'serve') {
    # Foreground child belongs to the original managed native job.
    & (Join-Path $pgBin 'postgres.exe') -D $data -h 127.0.0.1 -p $portNumber -c 'logging_collector=off'
    exit $LASTEXITCODE
}
$expectedData = (Resolve-Path -LiteralPath $data).Path.Replace('\', '/')
$identity = & (Join-Path $pgBin 'psql.exe') -X -A -t -h 127.0.0.1 -p $portNumber -U postgres -d postgres -v ON_ERROR_STOP=1 -c "SELECT current_setting('data_directory') || '|' || inet_server_port()::text"
if ($LASTEXITCODE -ne 0) { throw 'Cannot independently establish cluster identity' }
if (($identity -join '').Trim().Replace('\', '/') -ne "$expectedData|$portNumber") { throw 'Wrong cluster identity' }
if ($Action -eq 'identity') {
    $exists = & (Join-Path $pgBin 'psql.exe') -X -A -t -h 127.0.0.1 -p $portNumber -U postgres -d postgres -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM pg_database WHERE datname='synthetic_test'"
    if ($LASTEXITCODE -ne 0) { throw 'Database identity query failed' }
    if (($exists -join '').Trim() -eq '0') {
        & (Join-Path $pgBin 'psql.exe') -X -h 127.0.0.1 -p $portNumber -U postgres -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE synthetic_test'
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    & (Join-Path $pgBin 'psql.exe') -X -A -t -h 127.0.0.1 -p $portNumber -U postgres -d synthetic_test -v ON_ERROR_STOP=1 -c "SELECT current_database(), inet_server_addr(), inet_server_port(), current_setting('server_version')"
    exit $LASTEXITCODE
}
if ($Action -eq 'cleanup') {
    & (Join-Path $pgBin 'pg_ctl.exe') -D $data -w stop -m fast
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    if (Get-NetTCPConnection -State Listen -LocalPort $portNumber -ErrorAction SilentlyContinue) { throw 'Listener remains after stop' }
    if (Test-Path -LiteralPath (Join-Path $data 'postmaster.pid')) { throw 'PID file remains after stop' }
    Write-Output 'Owned cluster stopped; retained data and logs for audit; no directory deletion'
}
