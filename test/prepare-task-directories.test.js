import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

test('任务根准备真实验证零写、CAS、继承、幂等和权限边界', { skip: process.platform !== 'win32' }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'task-acl-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const script = resolve('scripts/prepare-task-directories.ps1').replaceAll("'", "''")
  const fixture = join(temp, 'verify.ps1')
  await writeFile(fixture, `
$ErrorActionPreference='Stop'
$root=Join-Path $PSScriptRoot 'workspace';$tasks=Join-Path $root 'tasks';$evidence=Join-Path $PSScriptRoot 'evidence'
New-Item -ItemType Directory -Path $tasks|Out-Null
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$tokens=$null;$errors=$null
$scriptAst=[Management.Automation.Language.Parser]::ParseFile('${script}',[ref]$tokens,[ref]$errors)
$ownerGuard=$scriptAst.Find({param($n)$n-is[Management.Automation.Language.FunctionDefinitionAst]-and$n.Name-eq'AssertOwner'},$true)
. ([scriptblock]::Create($ownerGuard.Extent.Text))
$foreign=[pscustomobject]@{};$foreign|Add-Member ScriptMethod GetOwner {param($type)[Security.Principal.SecurityIdentifier]::new('S-1-5-18')}
try{AssertOwner $foreign;throw 'FOREIGN_OWNER_ACCEPTED'}catch{if($_.Exception.Message-ne'TASK_ACL_FOREIGN_OWNER'){throw}}
$acl=Get-Acl $tasks;$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]'Modify,ChangePermissions',[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
$guests=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-546')
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($guests,[Security.AccessControl.FileSystemRights]::WriteData,[Security.AccessControl.AccessControlType]::Deny))
$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($system,[Security.AccessControl.FileSystemRights]::ReadAndExecute,[Security.AccessControl.AccessControlType]::Allow))
Set-Acl -LiteralPath $tasks -AclObject $acl
$existing=New-Item -ItemType Directory -Path (Join-Path $tasks 'existing')
$protected=New-Item -ItemType Directory -Path (Join-Path $tasks 'protected-child')
$protectedAcl=Get-Acl $protected.FullName;$protectedAcl.SetAccessRuleProtection($true,$true);Set-Acl -LiteralPath $protected.FullName -AclObject $protectedAcl
$protectedSddl=(Get-Acl $protected.FullName).Sddl
$before=Get-Acl $tasks;$beforeSddl=$before.Sddl;$beforeOwner=$before.Owner;$systemRights=($before.Access|Where-Object {$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value-eq$system.Value}).FileSystemRights
function RunPrepare([string[]]$extra){
 $result=& pwsh -NoProfile -File '${script}' @extra 2>&1
 return @{code=$LASTEXITCODE;text=($result -join "\n")}
}
$check=RunPrepare @('-WorkspaceRoot',$root,'-Check');if($check.code){throw $check.text};$facts=$check.text|ConvertFrom-Json
if($facts.writes-ne0-or-not$facts.needsChange-or(Test-Path $evidence)-or(Get-Acl $tasks).Sddl-ne$beforeSddl){throw 'CHECK_MUTATED'}
$stale=RunPrepare @('-WorkspaceRoot',$root,'-ExpectedAclSha256',('0'*64),'-EvidenceDirectory',$evidence)
if($stale.code-eq0-or$stale.text-notmatch'TASK_ACL_CHANGED'-or(Test-Path $evidence)){throw 'CAS_NOT_ENFORCED'}
$apply=RunPrepare @('-WorkspaceRoot',$root,'-ExpectedAclSha256',$facts.aclSha256,'-EvidenceDirectory',$evidence)
if($apply.code){throw $apply.text};$applied=$apply.text|ConvertFrom-Json
$after=Get-Acl $tasks
if($after.Owner-ne$beforeOwner-or-not$after.AreAccessRulesProtected){throw 'OWNER_OR_PROTECTION_CHANGED'}
if(-not($after.Access|Where-Object {$_.AccessControlType-eq'Deny'-and$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value-eq$guests.Value})){throw 'DENY_REMOVED'}
if(-not($after.Access|Where-Object {$_.AccessControlType-eq'Allow'-and$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value-eq$system.Value-and$_.FileSystemRights-eq$systemRights})){throw 'OTHER_SID_CHANGED'}
function AssertInheritedFull([string]$path){
 $rules=(Get-Acl $path).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
 if(-not($rules|Where-Object {$_.IdentityReference.Value-eq$sid.Value-and$_.IsInherited-and(([int]$_.FileSystemRights-band2032127)-eq2032127)})){throw "INHERITANCE_MISSING:$path"}
}
AssertInheritedFull $existing.FullName
if((Get-Acl $protected.FullName).Sddl-ne$protectedSddl){throw 'PROTECTED_CHILD_CHANGED'}
$new=New-Item -ItemType Directory -Path (Join-Path $existing.FullName 'new-grandchild')
AssertInheritedFull $new.FullName
$repeat=RunPrepare @('-WorkspaceRoot',$root,'-ExpectedAclSha256',$applied.aclSha256,'-EvidenceDirectory',(Join-Path $PSScriptRoot 'unused'))
if($repeat.code-or($repeat.text|ConvertFrom-Json).changed-or(Test-Path (Join-Path $PSScriptRoot 'unused'))){throw 'NOT_IDEMPOTENT'}
foreach($invalid in @('.',([IO.Path]::GetPathRoot($root)))){
 $rejected=RunPrepare @('-WorkspaceRoot',$invalid,'-Check');if($rejected.code-eq0){throw 'INVALID_ROOT_ACCEPTED'}
}
$junction=Join-Path $PSScriptRoot 'linked';New-Item -ItemType Junction -Path $junction -Target $root|Out-Null
try{$rejected=RunPrepare @('-WorkspaceRoot',$junction,'-Check');if($rejected.code-eq0-or$rejected.text-notmatch'TASK_ACL_REPARSE_OR_NON_DIRECTORY'){throw 'REPARSE_ACCEPTED'}}finally{[IO.Directory]::Delete($junction)}
if(-not(Test-Path (Join-Path $evidence 'before.json'))-or-not(Test-Path (Join-Path $evidence 'after.json'))){throw 'EVIDENCE_MISSING'}
'TASK_ACL_TEST_PASS'
`)
  const result = spawnSync('pwsh', ['-NoProfile', '-File', fixture], { encoding: 'utf8', windowsHide: true, timeout: 60000 })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /TASK_ACL_TEST_PASS/)
})
