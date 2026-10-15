param([switch]$Check,[Parameter(Mandatory)][int]$ExpectedPid)
$ErrorActionPreference='Stop'
$taskRoot='D:/baibu-agent/tasks/task-4c4780a541c5ea7c51024975de5f121d'
$data=[IO.Path]::GetFullPath("$taskRoot/docs/acceptance/expert-withdraw-fix/round-3/pgdata")
if(-not $data.StartsWith([IO.Path]::GetFullPath($taskRoot)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'DATABASE_SCOPE_INVALID'}
$pg=Get-CimInstance Win32_Process -Filter "ProcessId=$ExpectedPid"
if(-not $pg -or $pg.Name -ne 'postgres.exe' -or $pg.CommandLine -notlike "*-D *round-3*pgdata*-h 127.0.0.1 -p 55432*"){throw 'DATABASE_PROCESS_IDENTITY_MISMATCH'}
if([int](Get-Content -LiteralPath "$data/postmaster.pid" -TotalCount 1) -ne $ExpectedPid){throw 'DATABASE_DATA_IDENTITY_MISMATCH'}
$owners=@(Get-NetTCPConnection -State Listen -LocalPort 55432 | Select-Object -ExpandProperty OwningProcess -Unique)
if($owners.Count -ne 1 -or $owners[0] -ne $ExpectedPid){throw 'DATABASE_PORT_IDENTITY_MISMATCH'}
if($Check){@{checkOnly=$true;writes=0;signals=0;pid=$ExpectedPid;dataDirectory=$data;port=55432}|ConvertTo-Json;exit}
& D:/soft/PostgreSQL/16/bin/pg_ctl.exe -D $data stop -m fast -w -t 30
if($LASTEXITCODE){throw 'DATABASE_GRACEFUL_STOP_FAILED'}
if(Get-Process -Id $ExpectedPid -ErrorAction SilentlyContinue){throw 'DATABASE_PROCESS_STILL_LIVE'}
if(Get-NetTCPConnection -State Listen -LocalPort 55432 -ErrorAction SilentlyContinue){throw 'DATABASE_PORT_STILL_OPEN'}
@{stopped=$true;pid=$ExpectedPid;dataDirectory=$data;dataPreserved=Test-Path -LiteralPath "$data/PG_VERSION";startupReplayed=$false}|ConvertTo-Json
