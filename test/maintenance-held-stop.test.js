import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
const exec=promisify(execFile)
test('held restart stop continuation requires current process same maintenance and every drained effect boundary',async t=>{
 const core=await readFile(new URL('../docs/acceptance/topic-context-completeness/scripts/deploy-owner-repair.ps1',import.meta.url),'utf8')
 const fn=core.match(/function Test-HeldRestartContinuation[\s\S]+?(?=function Assert-MaintenanceContinuation)/)?.[0]
 assert.ok(fn)
 const dir=await mkdtemp(join(tmpdir(),'held-stop-proof-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const script=join(dir,'check.ps1')
 await writeFile(script,fn+`
$base=@{active=$true;phase='stopping';drained=$true;resumePermitted=$true;stopPermitted=$false;sealedIncarnation='99:old';processIncarnation='100:current';maintenanceId='maintenance';revision=9;busy=@{nodes=0;owners=0;effects=0;messages=0}}
 $names=@('valid','nodes','owners','effects','messages','not-drained','wrong-pid','same-seal','wrong-maintenance','stale-revision','not-held','no-continuation','inactive')
 $result=@()
 foreach($name in $names){
  $state=$base|ConvertTo-Json -Depth 5|ConvertFrom-Json
  $HoldMaintenance=$true;$ContinueMaintenanceId='maintenance';$ExpectedMaintenanceRevision=9
  switch($name){
   {$_ -in @('nodes','owners','effects','messages')} {$state.busy.$name=1}
   'not-drained' {$state.drained=$false}
   'wrong-pid' {$state.processIncarnation='101:other'}
   'same-seal' {$state.sealedIncarnation=$state.processIncarnation}
   'wrong-maintenance' {$state.maintenanceId='other'}
   'stale-revision' {$state.revision=10}
   'not-held' {$HoldMaintenance=$false}
   'no-continuation' {$ContinueMaintenanceId=''}
   'inactive' {$state.active=$false}
  }
  $result+=@{name=$name;accepted=(Test-HeldRestartContinuation $state @{ProcessId=100})}
 }
 $result|ConvertTo-Json`)
 const result=await exec('pwsh',['-NoProfile','-NonInteractive','-File',script],{windowsHide:true})
 const cases=JSON.parse(result.stdout);assert.equal(cases[0].accepted,true);for(const value of cases.slice(1))assert.equal(value.accepted,false,value.name)
 assert.match(core,/current\.CreationDate-ne \$old\.CreationDate/)
 assert.match(core,/lastSnapshot-ne \$snapshot/)
 assert.match(core,/never rewrite the prior Host seal/)
})
