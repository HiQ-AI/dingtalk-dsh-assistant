# Run in PowerShell 7. Installs browser-only dependencies outside the checkout.
# This does not install/run a dsh profile or change any shared deployment.
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$DependencyRoot,
  [switch]$Check
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($DependencyRoot)
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..'))
if ($root.StartsWith($repo, [StringComparison]::OrdinalIgnoreCase)) { throw 'DependencyRoot must be outside the checkout.' }
$parent = Split-Path $root -Parent
if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw "Parent directory missing: $parent" }
if (Test-Path -LiteralPath $root) { throw "Use a fresh DependencyRoot; existing directory: $root" }
$null = Get-Command node,npm -ErrorAction Stop
$primitiveManifest = Join-Path $repo 'packages/dingtalk-dsh-observer/node_modules/@deepseek-ai/dsh-client-ui-primitives/package.json'
if (-not (Test-Path -LiteralPath $primitiveManifest -PathType Leaf)) { throw 'Run pnpm install --frozen-lockfile in the worktree first.' }
if ($Check) { [pscustomobject]@{ check = 'PASS'; dependencyRoot = $root; productionChanges = $false } | ConvertTo-Json; return }
$pkg = Get-Content -LiteralPath $primitiveManifest -Raw | ConvertFrom-Json
$deps = @($pkg.devDependencies.PSObject.Properties | Where-Object {
  $_.Name -notlike '@types/*' -and $_.Name -notin @('@deepseek-ai/cordis','react','react-dom','clsx')
} | ForEach-Object { "$($_.Name)@$($_.Value)" })
$deps += @('react-dom@18.3.1','clsx@2.1.1','zustand@4.5.7','immer@10.1.1','esbuild@0.28.2')
& npm install --prefix $root --no-audit --no-fund @deps
if ($LASTEXITCODE -ne 0) { throw "npm failed: $LASTEXITCODE" }
$entry = Join-Path $root 'node_modules/esbuild/lib/main.js'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'esbuild entry missing after install' }
[pscustomobject]@{ dependencyRoot = $root; esbuildModule = $entry; productionChanges = $false } | ConvertTo-Json
