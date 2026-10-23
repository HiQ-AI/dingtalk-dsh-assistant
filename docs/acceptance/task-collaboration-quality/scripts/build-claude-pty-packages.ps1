param(
  [Parameter(Mandatory)][string]$HostSource,
  [Parameter(Mandatory)][string]$OutputDirectory,
  [switch]$Check
)
$ErrorActionPreference = 'Stop'
$HostSource = (Resolve-Path -LiteralPath $HostSource).Path
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$expectedBase = '687f282e8625c6b8d11ff58211a90524be2e4317'
$head = (& git -C $HostSource rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $head -ne $expectedBase) { throw 'Requires an isolated DSH rc.2 source checkout.' }
$patch = Join-Path $PSScriptRoot 'dsh-rc2-pty-lifecycle.patch'
$exitOrderPatch = Join-Path $PSScriptRoot 'node-pty-exit-order.patch'
& git -C $HostSource apply --reverse --check $patch
if ($LASTEXITCODE -ne 0) { throw 'Apply the reviewed lifecycle patch to the isolated checkout first.' }
$packageSource = Join-Path $HostSource 'packages/subprocess/subprocess-local'
$ptySource = (Resolve-Path -LiteralPath (Join-Path $packageSource 'node_modules/node-pty')).Path
$ptyAgent = Get-Content -LiteralPath (Join-Path $ptySource 'lib/windowsPtyAgent.js') -Raw
if ($ptyAgent -notmatch 'this\._ptyNative\.kill\(this\._pty, this\._useConptyDll\);\s*(?://[^\r\n]*\r?\n\s*)?this\._conoutSocketWorker\.dispose\(\);') {
  throw 'The locked node-pty workspace worker-dispose patch is missing.'
}
if (Test-Path -LiteralPath $OutputDirectory) { throw 'OutputDirectory must be new; previous evidence is retained.' }
if ($Check) { Write-Output 'CHECK PASS: rc.2 source, lifecycle patch and dependency patch verified'; return }
& pnpm --dir $HostSource exec tsc -b packages/subprocess/subprocess-local/tsconfig.json
if ($LASTEXITCODE -ne 0) { throw 'Host TypeScript build failed.' }
& pnpm --dir $packageSource exec tsdown
if ($LASTEXITCODE -ne 0) { throw 'Host package bundle failed.' }
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
$hostStage = Join-Path $OutputDirectory 'host-stage'
$ptyStage = Join-Path $OutputDirectory 'pty-stage'
New-Item -ItemType Directory -Path $hostStage,$ptyStage | Out-Null
& pnpm --dir $packageSource pack --pack-destination $OutputDirectory
if ($LASTEXITCODE -ne 0) { throw 'Host package packing failed.' }
$baseTarball = Join-Path $OutputDirectory 'deepseek-ai-dsh-subprocess-local-0.2.1-rc.2.tgz'
& tar -xf $baseTarball -C $hostStage
if ($LASTEXITCODE -ne 0) { throw 'Host package extraction failed.' }
foreach ($item in Get-ChildItem -LiteralPath $ptySource -Force) {
  if ($item.Name -ne 'node_modules') { Copy-Item -LiteralPath $item.FullName -Destination $ptyStage -Recurse }
}
& git apply --unsafe-paths --directory=$ptyStage --check $exitOrderPatch
if ($LASTEXITCODE -ne 0) { throw 'node-pty exit ordering patch does not match the locked source.' }
& git apply --unsafe-paths --directory=$ptyStage $exitOrderPatch
if ($LASTEXITCODE -ne 0) { throw 'node-pty exit ordering patch failed.' }
$hostManifestPath = Join-Path $hostStage 'package/package.json'
$hostManifest = Get-Content -LiteralPath $hostManifestPath -Raw | ConvertFrom-Json -AsHashtable
$hostManifest.version = '0.2.1-rc.2.pty.2'
$hostManifest.dependencies['node-pty'] = '1.2.0-beta.15.dsh.2'
$hostManifest | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $hostManifestPath -Encoding utf8NoBOM
$ptyManifestPath = Join-Path $ptyStage 'package.json'
$ptyManifest = Get-Content -LiteralPath $ptyManifestPath -Raw | ConvertFrom-Json -AsHashtable
$ptyManifest.version = '1.2.0-beta.15.dsh.2'
$ptyManifest | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $ptyManifestPath -Encoding utf8NoBOM
foreach ($stage in @((Join-Path $hostStage 'package'), $ptyStage)) {
  Push-Location $stage
  try {
    & npm pack --ignore-scripts --pack-destination $OutputDirectory
    if ($LASTEXITCODE -ne 0) { throw "Packing failed: $stage" }
  } finally { Pop-Location }
}
$artifacts = @('deepseek-ai-dsh-subprocess-local-0.2.1-rc.2.pty.2.tgz','node-pty-1.2.0-beta.15.dsh.2.tgz') | ForEach-Object {
  $artifactPath = Join-Path $OutputDirectory $_
  @{ file = $_; sha256 = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant(); bytes = (Get-Item -LiteralPath $artifactPath).Length }
}
@{ base = $head; lifecyclePatchSha256 = (Get-FileHash -LiteralPath $patch -Algorithm SHA256).Hash.ToLowerInvariant(); exitOrderPatchSha256 = (Get-FileHash -LiteralPath $exitOrderPatch -Algorithm SHA256).Hash.ToLowerInvariant(); artifacts = @($artifacts) } |
  ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'manifest.json') -Encoding utf8NoBOM
Get-Content -LiteralPath (Join-Path $OutputDirectory 'manifest.json')
