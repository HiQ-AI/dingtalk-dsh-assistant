param(
 [Parameter(Mandatory)][string]$GroupId,
 [Parameter(Mandatory)][string]$Marker,
 [Parameter(Mandatory)][string]$Start,
 [Parameter(Mandatory)][string]$Profile,
 [Parameter(Mandatory)][string]$OutputFile
)
$ErrorActionPreference='Stop'
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..'))
$destination=[IO.Path]::GetFullPath($OutputFile)
$allowed=[IO.Path]::GetFullPath((Join-Path $workspace 'docs/tmp'))+[IO.Path]::DirectorySeparatorChar
if(-not $destination.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $destination)){throw '证据文件须为当前工作区 docs/tmp 下的新文件'}
# 只读渠道与正式 HTTP 投影，不补发、不伪造入站或改写任务状态。
$raw=& dws chat +chat-messages --group $GroupId --start $Start --order asc --page-all --page-limit 2 --profile $Profile --format json
if($LASTEXITCODE){throw '渠道读取失败，未判定送达'}
$channel=($raw -join "`n")|ConvertFrom-Json
if($channel.complete-ne $true -or $channel.hasMore -or $channel.failedCount-ne 0 -or $channel.partial){throw '渠道读取不完整，未判定送达'}
$groups=Invoke-RestMethod http://127.0.0.1:18998/state/groups -NoProxy -TimeoutSec 30
$group=@($groups|Where-Object groupId -eq $GroupId)
if($group.Count-gt 1){throw '群投影不唯一'}
$workflow=Invoke-RestMethod http://127.0.0.1:18998/state/workflows -NoProxy -TimeoutSec 30
$runs=@($workflow.messages|Where-Object {$_.conversationId-eq $GroupId -and ($_.body|ConvertTo-Json -Depth 20 -Compress).Contains($Marker)})
$details=@($runs|ForEach-Object {
 Invoke-RestMethod ('http://127.0.0.1:18998/state/workflows?runId='+[Uri]::EscapeDataString($_.runId)) -NoProxy -TimeoutSec 30
})
$tasks=Invoke-RestMethod http://127.0.0.1:18998/state/tasks -NoProxy -TimeoutSec 30
$health=Invoke-RestMethod http://127.0.0.1:18998/health -NoProxy -TimeoutSec 30
$evidence=[ordered]@{
 observedAt=[DateTimeOffset]::Now.ToString('o');groupId=$GroupId;marker=$Marker
 health=@{status=$health.status;inboundProcessing=$health.inboundProcessing;recoveryIssueCount=$health.recoveryIssueCount}
 channel=$channel;group=if($group.Count){$group[0]}else{$null}
 runs=$details;taskIds=@($tasks|ForEach-Object taskId|Sort-Object)
 groupTaskIds=@($tasks|Where-Object groupId -eq $GroupId|ForEach-Object taskId|Sort-Object)
}
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))|Out-Null
$evidence|ConvertTo-Json -Depth 100|Set-Content -LiteralPath $destination -Encoding utf8
$readback=Get-Content -LiteralPath $destination -Raw|ConvertFrom-Json
[pscustomobject]@{
 evidence=$destination;bytes=(Get-Item -LiteralPath $destination).Length
 channelMessages=$readback.channel.messages.Count
 matchingMessages=@($readback.channel.messages|Where-Object {($_|ConvertTo-Json -Depth 20 -Compress).Contains($Marker)}).Count
 runs=$readback.runs.Count;groupTasks=$readback.groupTaskIds.Count;health=$readback.health
}|ConvertTo-Json -Depth 5
