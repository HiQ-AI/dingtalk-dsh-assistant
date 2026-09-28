import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,writeFile,mkdir,rm,readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import yaml from 'js-yaml'
import { assertEchoDisposeWitness,assertEchoMaintenance,verifyEchoBackup } from '../docs/acceptance/topic-context-completeness/scripts/recover-quarantined-echo.mjs'
import { bootstrapProfile } from '../scripts/bootstrap-workflow-maintenance.mjs'
const hash=x=>createHash('sha256').update(x).digest('hex')
test('恢复仅接受同PID/nonce完整disposed见证与精确profile fence',()=>{
 const original='- insert:\n    - id: dingtalk-dsh-assistant\n      name: "@zzusp/dingtalk-dsh-assistant/resident"\n      config: {}\n'
 const config={evidenceDirectory:join(tmpdir(),'witness'),expectedPid:123,nonce:'12345678-1234-1234-1234-123456789012'}
 const fenced=bootstrapProfile(bootstrapProfile(original,'witness',yaml,config),'disable',yaml)
 const record={pid:123,nonce:config.nonce,originalSha256:hash(original),fencedSha256:hash(fenced)}
 const ready={kind:'ready',pid:123,nonce:config.nonce,entryId:'dingtalk-dsh-assistant',moduleName:'@zzusp/dingtalk-dsh-assistant/resident'},disposed={...ready,kind:'disposed'}
 assert.doesNotThrow(()=>assertEchoDisposeWitness(record,ready,disposed,fenced,yaml))
 assert.throws(()=>assertEchoDisposeWitness(record,ready,{...disposed,pid:124},fenced,yaml),/ECHO_DISPOSE_WITNESS_INVALID/)
 assert.throws(()=>assertEchoDisposeWitness(record,ready,{...disposed,kind:'port-closed'},fenced,yaml),/ECHO_DISPOSE_WITNESS_INVALID/)
 assert.throws(()=>assertEchoDisposeWitness(record,ready,disposed,fenced+'# drift',yaml),/ECHO_PROFILE_FENCE_INVALID/)
})
test('维护与唯一running消息节点绑定；开库后failed/process_interrupted不误计busy',()=>{
 const record={maintenanceId:'m',maintenanceRevision:31},state={active:true,phase:'draining',maintenanceId:'m',revision:31,busy:{nodes:0,owners:0,effects:0,messages:1}}
 assert.doesNotThrow(()=>assertEchoMaintenance(state,record,{runningNodes:1}))
 assert.throws(()=>assertEchoMaintenance({...state,busy:{...state.busy,messages:2}},record,{runningNodes:1}),/ECHO_OTHER_WORK_ACTIVE/)
 assert.doesNotThrow(()=>assertEchoMaintenance({...state,busy:{...state.busy,messages:0}},record,{runningNodes:0}))
 assert.throws(()=>assertEchoMaintenance({...state,active:false},record,{runningNodes:1}),/ECHO_MAINTENANCE_CHANGED/)
})
test('续接不能把manifest存在当备份通过：校验scope/所有文件/一致SQLite副本',async t=>{
 const root=await mkdtemp(join(tmpdir(),'echo-backup-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'runtime'))
 const record={runId:'r',instanceId:'i',maintenanceId:'m',maintenanceRevision:31,fencedSha256:'a'.repeat(64)}
 const bytes=Buffer.from('fixture'),manifest={scope:{...record},proof:{verified:true,manifest:[{path:'runtime/control.sqlite',bytes:bytes.length,sha256:hash(bytes)}],database:{restoreFile:'runtime/verified-control.sqlite',sha256:hash(bytes)}}}
 await writeFile(join(root,'manifest.json'),JSON.stringify(manifest))
 await assert.rejects(verifyEchoBackup(root,record),{code:'ENOENT'})
 await writeFile(join(root,'runtime/control.sqlite'),bytes);await writeFile(join(root,'runtime/verified-control.sqlite'),bytes)
 await verifyEchoBackup(root,record)
 await assert.rejects(verifyEchoBackup(root,{...record,runId:'other'}),/ECHO_BACKUP_SCOPE_INVALID/)
 await writeFile(join(root,'runtime/control.sqlite'),'corrupted')
 await assert.rejects(verifyEchoBackup(root,record),/ECHO_BACKUP_CHANGED/)
})
test('PowerShell恢复阶段使用profile CAS与完整退出见证，未包含强停/维护解除/任意hook',async()=>{
 const source=await readFile(new URL('../docs/acceptance/topic-context-completeness/scripts/recover-quarantined-echo.ps1',import.meta.url),'utf8')
 assert.ok(source.indexOf("Wait-Witness 'disposed'")<source.indexOf("Helper 'repair'"))
 assert.ok(source.indexOf("$record.phase='repaired'")<source.indexOf("Node @($bootstrap,'enable'"))
 assert.match(source,/witnessSha256/);assert.match(source,/fencedSha256/);assert.match(source,/ContinueMaintenanceId/)
 assert.doesNotMatch(source,/Stop-Process|active=\$false|Invoke-Expression|ScriptBlock/)
})
