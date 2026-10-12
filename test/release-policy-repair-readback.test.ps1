$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../docs/acceptance/topic-context-completeness/scripts/deploy-owner-repair.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'CORE_PARSE_FAILED'}
$fn=$ast.Find({param($node)$node-is [Management.Automation.Language.FunctionDefinitionAst]-and $node.Name-eq 'Assert-ConfigurationRestoreReadback'},$true)
Invoke-Expression $fn.Extent.Text
$old=@{packageSha256='package';profileSha256='old-profile'}
$proof=@{beforeSha256='old-profile';afterSha256='new-profile';restore=@{kind='release-policy-repair';proposalSha256='proposal';knownActiveRuns=@(@{matches=$true});deploymentReceipt=@{path='receipt';sha256='receipt-hash'};registrationProposal=@{path='registration';sha256='registration-hash'}}}
$hashes=@{old='old-hash';restore='restore-hash';proposal='proposal';receipt='receipt-hash';registration='registration-hash';before='before-hash'}
function Get-Content {param([string]$LiteralPath,[switch]$Raw)if($LiteralPath-eq 'old'){return $old|ConvertTo-Json -Depth 8};if($LiteralPath-eq 'restore'){return $proof|ConvertTo-Json -Depth 8};throw 'UNEXPECTED_READ'}
function Get-FileHash {param([Parameter(Mandatory)][string]$LiteralPath)if(-not$hashes.ContainsKey($LiteralPath)){throw 'UNEXPECTED_HASH'};@{Hash=$hashes[$LiteralPath]}}
$record=@{restoreConfigurationProposal='proposal';repairOfLaunch='old';repairOfLaunchSha256='old-hash';configurationRestorePath='restore';configurationRestoreSha256='restore-hash';packageSha256='package';sourceProfileSha256='old-profile';profileSha256='new-profile'}
Assert-ConfigurationRestoreReadback $record
$proof.restore.registrationProposal.sha256='wrong';$rejected=$false;try{Assert-ConfigurationRestoreReadback $record}catch{$rejected=$true};if(-not$rejected){throw 'CHANGED_REGISTRATION_PROOF_ACCEPTED'}
$proof.restore.Remove('kind');$proof.restore.beforeConfigProof=@{path='before';sha256='before-hash'};Assert-ConfigurationRestoreReadback $record
Write-Output 'PASS 3/3: release-policy repair readback, changed proof rejection, original repository restore readback'