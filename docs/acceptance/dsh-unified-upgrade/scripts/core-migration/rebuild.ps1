param(
  [Parameter(Mandatory)][string]$WorkRoot,
  [switch]$Check
)
$ErrorActionPreference='Stop'
$archiveRoot=$PSScriptRoot
$repositoryRoot=[IO.Path]::GetFullPath((Join-Path $archiveRoot '../../../../../'))
$WorkRoot=[IO.Path]::GetFullPath($WorkRoot)
$sourceRoot=Join-Path $WorkRoot 'core-migration-source'
$runtimeRoot=Join-Path $WorkRoot 'migration-runtime'
$toolRoot=Join-Path $WorkRoot 'toolchain'
$artifactRoot=Join-Path $WorkRoot 'migration-artifacts'
$patch=Join-Path $repositoryRoot 'docs/acceptance/dsh-unified-upgrade/fixtures/owned-session-migration.patch'
$commit='d743267388641bc76f17c45ce8b4c231aed1d32c'
function Invoke-Checked { param([string]$Program,[string[]]$Arguments) & $Program @Arguments; if($LASTEXITCODE -ne 0){throw "$Program failed ($LASTEXITCODE)"} }
if ((node --version) -ne 'v24.19.0'){throw '需要 Node.js 24.19.0（原验收运行时）'}
if ((pnpm --version) -ne '10.13.1'){throw '需要 pnpm 10.13.1（原验收包管理器）'}
if($Check){
  if(!(Test-Path -LiteralPath $sourceRoot)){throw '--Check 要求现有独立 upstream checkout；本模式不创建任何目录'}
  if((git -C $sourceRoot rev-parse HEAD) -ne $commit){throw 'upstream commit mismatch'}
  Invoke-Checked git @('-C',$sourceRoot,'apply','--check',$patch)
  Write-Output 'PASS: exact upstream commit + complete patch apply check; zero writes'
  return
}
if(Test-Path -LiteralPath $WorkRoot){throw 'WorkRoot 必须是尚不存在的独立目录；拒绝覆盖已有构建和会话'}
New-Item -ItemType Directory -Path $WorkRoot,$runtimeRoot,$toolRoot,$artifactRoot | Out-Null
Invoke-Checked git @('-c','core.autocrlf=false','clone','--filter=blob:none','--depth','1','--branch','dsh-v0.2.1-alpha.2','--sparse','https://github.com/deepseek-ai/deepseek-harness.git',$sourceRoot)
Invoke-Checked git @('-C',$sourceRoot,'sparse-checkout','set','packages/session','scripts','vendor/cordis','vendor/cosmokit','packages/core/session','packages/core/agent','packages/llm/llm','packages/util','snapshots/sdk','snapshots/session')
if((git -C $sourceRoot rev-parse HEAD) -ne $commit){throw 'upstream commit mismatch'}
Invoke-Checked git @('-C',$sourceRoot,'apply','--check',$patch)
Invoke-Checked git @('-C',$sourceRoot,'apply',$patch)
Copy-Item -LiteralPath (Join-Path $archiveRoot 'runtime-package.json') -Destination (Join-Path $runtimeRoot 'package.json')
Copy-Item -LiteralPath (Join-Path $archiveRoot 'toolchain-package.json') -Destination (Join-Path $toolRoot 'package.json')
# 独立 workspace 骨架：阻止 pnpm 向上继承插件主仓 workspace。
foreach($directory in @($runtimeRoot,$toolRoot)){Set-Content -LiteralPath (Join-Path $directory 'pnpm-workspace.yaml') -Value 'packages: []';Invoke-Checked pnpm @('--dir',$directory,'install','--registry=https://registry.npmjs.org')}
Invoke-Checked node @((Join-Path $archiveRoot 'build-edges.mjs'),$WorkRoot)
foreach($name in @('v0-to-v1','v1-to-v2','v2-to-v3','v3-to-v4')){Invoke-Checked node @((Join-Path $toolRoot 'node_modules/typescript/bin/tsc'),'-p',(Join-Path $sourceRoot "packages/session/session-format-$name/tsconfig.local.json"))}
# Worker 必须在 registry JSONL 尚在 runtime 时复制官方 index/types，之后 inline 四条本地边。
Invoke-Checked node @((Join-Path $archiveRoot 'build-worker.mjs'),$WorkRoot)
$manifest=@()
$runtime=Get-Content (Join-Path $runtimeRoot 'package.json') -Raw | ConvertFrom-Json -AsHashtable
$runtime.pnpm=@{overrides=@{}}
foreach($name in @('session-format-v0-to-v1','session-format-v1-to-v2','session-format-v2-to-v3','session-format-v3-to-v4','session-persistence-jsonl')){
  $packageRoot=Join-Path $sourceRoot "packages/session/$name"
  $metadata=Get-Content (Join-Path $packageRoot 'package.json') -Raw | ConvertFrom-Json
  if($metadata.version -ne '0.2.1-alpha.2' -or $metadata.dsh.localMigration.upstreamCommit -ne $commit -or $metadata.dsh.localMigration.patch -ne 'owned-dingtalk-convergent-session-migration-v1'){throw 'package provenance mismatch'}
  Invoke-Checked npm @('pack',$packageRoot,'--pack-destination',$artifactRoot,'--silent')
  $tar=Join-Path $artifactRoot "deepseek-ai-dsh-$name-0.2.1-alpha.2.tgz"
  $sha=(Get-FileHash -LiteralPath $tar -Algorithm SHA256).Hash.ToLower()
  $unique="deepseek-ai-dsh-$name-0.2.1-alpha.2-local-$($sha.Substring(0,12)).tgz"
  $destination=Join-Path $artifactRoot $unique
  Move-Item -LiteralPath $tar -Destination $destination
  $runtime.dependencies["@deepseek-ai/dsh-$name"]="file:../migration-artifacts/$unique"
  $runtime.pnpm.overrides["@deepseek-ai/dsh-$name"]="file:../migration-artifacts/$unique"
  $manifest+=@{name=$metadata.name;version=$metadata.version;path=$destination;sha256=$sha;bytes=(Get-Item -LiteralPath $destination).Length;localMigration=$metadata.dsh.localMigration}
}
$runtime | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $runtimeRoot 'package.json')
$manifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $artifactRoot 'manifest.json')
Invoke-Checked pnpm @('--dir',$runtimeRoot,'install','--registry=https://registry.npmjs.org')
Invoke-Checked node @((Join-Path $archiveRoot 'run-tests.mjs'),'--work-root',$WorkRoot,'--case','synthetic')
Write-Output "PASS: five local exact-alpha2 packages; manifest=$artifactRoot/manifest.json"
