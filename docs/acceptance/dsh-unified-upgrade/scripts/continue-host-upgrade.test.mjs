import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const script = fileURLToPath(new URL('./continue-host-upgrade.ps1', import.meta.url));
const quote = value => `'${value.replaceAll("'", "''")}'`;
function run(body) {
  const command = `$ErrorActionPreference='Stop';$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile(${quote(script)},[ref]$tokens,[ref]$errors);if($errors.Count){throw 'AST errors'};foreach($name in @('Assert-ContinuationState','Assert-ContinuationLock','Test-ContinuationProcessesAbsent','Assert-ContinuationDependencies','Assert-ExactControlSnapshot')){$definition=@($ast.FindAll({param($a)$a-is [Management.Automation.Language.FunctionDefinitionAst]-and $a.Name-eq $name},$false));if($definition.Count-ne 1){throw 'missing guard'};. ([scriptblock]::Create($definition[0].Extent.Text))};function Reject($action){$caught=$false;try{& $action}catch{$caught=$true};if(-not $caught){throw 'guard admitted negative'}};${body};'PASS'`;
  return execFileSync('pwsh', ['-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8' });
}
const fixture = `$origin=@{mode='maintenance';backupCreated=$false;hostUpgradeProposal='original.json';maintenanceId='m';startedAt='2026-10-13T10:01:02Z';launchMethod='scheduled-task';launchTaskName='DSH Web Local'};$seal=@{active=$true;phase='stopping';drained=$true;stopPermitted=$true;maintenanceId='m';revision=3;sealedIncarnation='1:old';processIncarnation='1:old';busy=@{nodes=0;owners=0;effects=0;messages=0}};$info=@{LastTaskResult=1;LastRunTime=[datetime]'2026-10-13T10:01:02Z'};`;
test('actual failure seal guard admits only exact scheduled failed offline state', () => {
  assert.match(run(fixture + `$offline=$seal.Clone();$offline.processIncarnation=$null;$offline.stopPermitted=$false;$offline.resumePermitted=$false;Assert-ContinuationState $origin $seal $offline $info 'Ready' $true $true;Reject {Assert-ContinuationState $origin $seal $offline $info 'Ready' $false $true};Reject {Assert-ContinuationState $origin $seal $offline $info 'Ready' $true $false};$info.LastTaskResult=0;Reject {Assert-ContinuationState $origin $seal $offline $info 'Ready' $true $true};$info.LastTaskResult=1;$info.LastRunTime=[datetime]'2026-10-13T10:01:03Z';Reject {Assert-ContinuationState $origin $seal $offline $info 'Ready' $true $true};$info.LastRunTime=[datetime]'2026-10-13T10:01:02Z';$origin.launchMethod='manual';Reject {Assert-ContinuationState $origin $seal $offline $info 'Ready' $true $true};$origin.launchMethod='scheduled-task';$offline.stopPermitted=$true;Reject {Assert-ContinuationState $origin $seal $offline $info 'Ready' $true $true};$offline.stopPermitted=$false;$offline.processIncarnation='1:old';Reject {Assert-ContinuationState $origin $seal $offline $info 'Ready' $true $true};$offline.processIncarnation=$null;$offline.revision=4;Reject {Assert-ContinuationState $origin $seal $offline $info 'Ready' $true $true};$offline.revision=3;$seal.busy.messages=1;Reject {Assert-ContinuationState $origin $seal $offline $info 'Ready' $true $true}`), /PASS/);
});
test('actual process guard rejects Windows launcher path and orphan child; lock guard rejects exited lock', () => {
  assert.match(run(`if(-not(Test-ContinuationProcessesAbsent @() 1 $null 'D:/dsh_home/profiles/web' 'D:/dsh_home/launchers/start-web.ps1' 999)){throw 'empty process list'};$launcher=@{ProcessId=2;ParentProcessId=0;CommandLine=('pwsh -File D:'+ [char]92+'dsh_home'+[char]92+'launchers'+[char]92+'start-web.ps1')};if(Test-ContinuationProcessesAbsent @($launcher) 1 $null 'D:/dsh_home/profiles/web' 'D:/dsh_home/launchers/start-web.ps1' 999){throw 'missed Windows launcher'};$child=@{ProcessId=3;ParentProcessId=1;CommandLine='dws.exe'};if(Test-ContinuationProcessesAbsent @($child) 1 $null 'D:/dsh_home/profiles/web' 'D:/dsh_home/launchers/start-web.ps1' 999){throw 'missed child'};Assert-ContinuationLock @{HasExited=$false};Reject {Assert-ContinuationLock @{HasExited=$true}};Reject {Assert-ContinuationLock $null}`), /PASS/);
});
test('actual closure guard binds native parent declaration hash and rejects arbitrary additions', t => {
  const root = path.resolve(path.dirname(script), '../../../tmp');
  fs.mkdirSync(root, { recursive: true }); const dir = fs.mkdtempSync(path.join(root, 'continuation-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const parent = path.join(dir, 'package.json');
  fs.writeFileSync(parent, JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '0.2.1-alpha.2', peerDependencies: { '@deepseek-ai/dsh-fs': '0.2.1-alpha.2' } }));
  assert.match(run(`$parent=${quote(parent)};$reason=@{declarer='@deepseek-ai/dsh-base';actualName='@deepseek-ai/dsh-base';actualVersion='0.2.1-alpha.2';peer='@deepseek-ai/dsh-fs';range='0.2.1-alpha.2';selected='0.2.1-alpha.2';kind='requiredpeer';optional=$false;declarerManifest=$parent;declarerManifestSha256=(Get-FileHash $parent).Hash.ToLowerInvariant()};$closure=@{extraDirect=@{'@deepseek-ai/dsh-fs'='0.2.1-alpha.2'};reasons=@($reason)};$next=@{'@deepseek-ai/dsh-fs'='0.2.1-alpha.2'};$null=Assert-ContinuationDependencies @{} $next $closure;$next['@deepseek-ai/dsh-unrelated']='0.2.1-alpha.2';Reject {Assert-ContinuationDependencies @{} $next $closure};$next.Remove('@deepseek-ai/dsh-unrelated');$reason.range='fake';Reject {Assert-ContinuationDependencies @{} $next $closure};$reason.range='0.2.1-alpha.2';$reason.declarerManifestSha256='0'*64;Reject {Assert-ContinuationDependencies @{} $next $closure}`), /PASS/);
});
test('actual snapshot guard rejects added task despite subset verifier compatibility', t => {
  const root = path.resolve(path.dirname(script), '../../../tmp'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'continuation-snapshot-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'control-before.json'), JSON.stringify({ tasks: ['t1'], nodes: [], runs: [], legacy: [] }));
  assert.match(run(`$OriginEvidenceDirectory=${quote(dir)};$global:actualSnapshot='{"tasks":["t1"],"nodes":[],"runs":[],"legacy":[]}';function Run-Node{return $global:actualSnapshot};Assert-ExactControlSnapshot;$global:actualSnapshot='{"tasks":["t1","t2"],"nodes":[],"runs":[],"legacy":[]}';Reject {Assert-ExactControlSnapshot}`), /PASS/);
});
