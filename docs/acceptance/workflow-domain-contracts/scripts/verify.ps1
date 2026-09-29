param([ValidateSet('all', 'contracts', 'integration', 'owner', 'stages', 'detail')][string]$Suite = 'all')
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../../../..')).Path
$testFiles = switch ($Suite) {
  all { @('execution-controller', 'agent-work', 'investigation-domain-contract', 'task-delivery-manifest',
    'task-workflow-contracts', 'task-group-file-delivery', 'task-group-file-runtime', 'workflow-file-delivery-integration',
    'workflow-engineering', 'decision', 'http', 'topic-runtime', 'execution-session-native', 'task-owner-session-native', 'task-workflow',
    'workflow-recovery', 'workflow-agent-service', 'workflow-service', 'task-owner-recovery', 'task-stage-contracts', 'task-owner-store', 'task-owner-delivery-manifest') }
  contracts { @('execution-controller', 'agent-work', 'investigation-domain-contract', 'task-delivery-manifest',
    'task-workflow-contracts', 'task-group-file-delivery', 'task-group-file-runtime', 'workflow-file-delivery-integration',
    'workflow-engineering', 'decision', 'http', 'topic-runtime', 'execution-session-native', 'task-owner-session-native', 'task-workflow') }
  integration { @('workflow-recovery', 'workflow-agent-service', 'workflow-service', 'task-owner-recovery') }
  owner { @('task-owner-store', 'task-owner-delivery-manifest', 'task-owner-recovery', 'task-owner-session-native', 'execution-controller') }
  stages { @('task-stage-contracts') }
  detail { @('workflow-service') }
}
$priorTemp = $env:TEMP; $priorTmp = $env:TMP
Push-Location $repo
try {
  $env:TEMP = $env:TMP = Join-Path $repo 'docs/tmp/workflow-domain-tests'
  New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
  $nodeArgs = @('--test', '--test-concurrency=4')
  if ($Suite -eq 'detail') { $nodeArgs += '--test-name-pattern=真实Owner路径保留工程本地验收' }
  $nodeArgs += $testFiles | ForEach-Object { "test/$_.test.js" }
  & node @nodeArgs
  if ($LASTEXITCODE -ne 0) { throw "workflow-domain $Suite failed: $LASTEXITCODE" }
} finally {
  $env:TEMP = $priorTemp; $env:TMP = $priorTmp
  Pop-Location
}
