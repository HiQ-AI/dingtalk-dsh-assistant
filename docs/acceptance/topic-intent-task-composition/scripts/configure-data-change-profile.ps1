param(
  [switch]$Check,
  [string]$ProfilePath = 'D:/dsh_home/profiles/web/cordis.patch.yml'
)

$ErrorActionPreference = 'Stop'
$resolved = [System.IO.Path]::GetFullPath($ProfilePath)
if ($resolved -ne [System.IO.Path]::GetFullPath('D:/dsh_home/profiles/web/cordis.patch.yml')) {
  throw '仅允许修改本机 web profile'
}
$source = [System.IO.File]::ReadAllText($resolved)
if ($source.Contains('productionPostgres:') -or $source.Contains('uatPostgres:') -or $source.Contains('bytebase:')) {
  if ($source.Contains('productionPostgres:') -and $source.Contains('uatPostgres:') -and
      $source.Contains('bytebase:') -and ($source.Split("adapterVersion: '2'").Length - 1) -eq 1) {
    Write-Output "CHECK_OK profile=$resolved already-configured"
    exit 0
  }
  if (!$source.Contains('productionPostgres:') -or !$source.Contains('uatPostgres:') -or
      !$source.Contains('bytebase:') -or ($source.Split('adapterVersion: 2').Length - 1) -ne 1) {
    throw '数据变更配置已存在或结构不完整，需人工核对'
  }
  $candidate = $source.Replace('adapterVersion: 2', "adapterVersion: '2'")
  if ($Check) { Write-Output "CHECK_OK profile=$resolved repair=adapterVersion-string"; exit 0 }
  $backup = "$resolved.data-change-version-$(Get-Date -Format 'yyyyMMdd-HHmmss').bak"
  [System.IO.File]::Copy($resolved, $backup, $false)
  [System.IO.File]::WriteAllText($resolved, $candidate, [System.Text.UTF8Encoding]::new($false))
  if ([System.IO.File]::ReadAllText($resolved) -ne $candidate) { throw 'Profile 写入后回读不一致' }
  Write-Output "APPLIED profile=$resolved backup=$backup"
  exit 0
}
$newline = if ($source.Contains("`r`n")) { "`r`n" } else { "`n" }
$hostAnchor = '        productionTagWritesEnabled: true'
$workflowAnchor = "          platforms:${newline}            productionApproverActorIds:"
if (($source.Split($hostAnchor).Length - 1) -ne 1 -or
    ($source.Split($workflowAnchor).Length - 1) -ne 1) {
  throw 'Profile 锚点不唯一或当前结构已变化'
}
$dbNames = @('hiq_editor', 'hiq_background_db', 'hiq_admin')
$hostLines = @(
  '        productionPostgres:',
  '          targets:'
)
foreach ($db in $dbNames) {
  $hostLines += @(
    '            - project: projects/flbn',
    '              target:',
    '                instance: instances/flbnpguaf',
    "                database: instances/flbnpguaf/databases/$db",
    '                environment: production'
  )
}
$hostLines += @(
  '        uatPostgres:',
  "          receiptDbPath: 'D:/dsh_home/workflows/runtime-v2/uat-rehearsal-receipts.sqlite'",
  '          targets:'
)
foreach ($db in $dbNames) {
  $hostLines += @(
    '            - project: projects/flbn',
    '              target:',
    '                instance: postgresql/192.168.8.8:30770',
    "                database: $db",
    '                environment: uat'
  )
}
$residentLines = @(
  '            bytebase:',
  '              adapterId: bytebase',
  "              adapterVersion: '2'",
  '              targets:'
)
foreach ($db in $dbNames) {
  $residentLines += @(
    "                - id: $db-production",
    '                  project: projects/flbn',
    '                  target:',
    '                    instance: instances/flbnpguaf',
    "                    database: instances/flbnpguaf/databases/$db",
    '                    environment: production',
    '                  uatTarget:',
    '                    instance: postgresql/192.168.8.8:30770',
    "                    database: $db",
    '                    environment: uat'
  )
}
$candidate = $source.Replace($hostAnchor, $hostAnchor + $newline + ($hostLines -join $newline))
$candidate = $candidate.Replace($workflowAnchor,
  "          platforms:${newline}" + ($residentLines -join $newline) + "${newline}            productionApproverActorIds:")
if ($candidate -eq $source -or ($candidate.Split('bytebase:').Length - 1) -ne 1) {
  throw '候选配置生成失败'
}
if ($Check) {
  Write-Output "CHECK_OK profile=$resolved productionTargets=3 uatTargets=3 bytebaseTargets=3"
  exit 0
}
$backup = "$resolved.data-change-$(Get-Date -Format 'yyyyMMdd-HHmmss').bak"
[System.IO.File]::Copy($resolved, $backup, $false)
[System.IO.File]::WriteAllText($resolved, $candidate, [System.Text.UTF8Encoding]::new($false))
$actual = [System.IO.File]::ReadAllText($resolved)
if ($actual -ne $candidate) { throw 'Profile 写入后回读不一致' }
Write-Output "APPLIED profile=$resolved backup=$backup"
