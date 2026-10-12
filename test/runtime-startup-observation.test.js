import test from 'node:test'
import assert from 'node:assert/strict'
import {projectStartupInspection as projectActual,validateStartupInspection} from '../packages/dingtalk-dsh-assistant/runtime-startup-observation.js'
const projectStartupInspection=(config,input)=>projectActual(config,{...input,completeness:{status:'complete-retained-window',returnedBytes:Buffer.byteLength(input.raw),limitBytes:524288}})
const config={booleanProperties:['approval.notification-outbox.enabled'],springConditions:[{className:'ApprovalNotificationOutboxTask',property:'approval.notification-outbox.enabled'}]}
const startedAt='2026-10-12T08:25:00Z'
const raw=[
 '2026-10-12T08:25:01Z    ApprovalNotificationOutboxTask:',
 '2026-10-12T08:25:01Z       Did not match:',
 "2026-10-12T08:25:01Z          - @ConditionalOnProperty (approval.notification-outbox.enabled=true) found different value in property 'enabled' (OnPropertyCondition)",
 '2026-10-12T08:25:02Z password=SUPERSECRET request body PRIVATE'
].join(String.fromCharCode(10))
const container={command:['sh','-c','java -Dapproval.notification-outbox.enabled=false -Dpassword=SUPERSECRET -jar my-app.jar --approval.notification-outbox.enabled=false'],env:[{name:'PASSWORD',value:'SUPERSECRET'}]}
test('only registered boolean declarations and same-start negative condition projected without credentials',()=>{
 const out=projectStartupInspection(config,{container,startedAt,raw})
 assert.deepEqual(out.properties[0].jvmDeclarations,[false]);assert.deepEqual(out.properties[0].springArguments,[false])
 assert.equal(out.properties[0].effectiveValueProven,false);assert.equal(out.conditions[0].excludedByCondition,true)
 assert.ok(!JSON.stringify(out).includes('SUPERSECRET'));assert.ok(!JSON.stringify(out).includes('PRIVATE'))
})
for(const kind of ['missing','prior-start','wrong-class','wrong-property'])test(`missing retained or wrong identity startup never proves exclusion: ${kind}`,()=>{
 const actual=kind==='missing'?'':kind==='prior-start'?raw.replaceAll('2026-10-12T08:25:01Z','2026-10-12T08:24:59Z'):kind==='wrong-class'?raw.replaceAll('ApprovalNotificationOutboxTask','DifferentTask'):raw.replaceAll('approval.notification-outbox.enabled','another.enabled')
 assert.equal(projectStartupInspection(config,{container,startedAt,raw:actual}).conditions[0].excludedByCondition,null)
})
test('similar unregistered property cannot satisfy registered boolean projection',()=>{
 const out=projectStartupInspection(config,{container:{command:['java -DapprovalXnotification-outboxXenabled=false']},startedAt,raw:''})
 assert.deepEqual(out.properties[0].jvmDeclarations,[])
})
for(const value of [{booleanProperties:['password'],springConditions:[]},{...config,extra:'secret'},{...config,springConditions:[{className:'Task;exec',property:config.booleanProperties[0]}]}])test('invalid or nonboolean projection registration rejected',()=>assert.throws(()=>validateStartupInspection(value),/CONFIG_INVALID/))
test('positive condition remains distinct from absent/excluded; conflicting reports return unavailable',()=>{
 const positive=[
  '2026-10-12T08:25:03Z    ApprovalNotificationOutboxTask:',
  '2026-10-12T08:25:03Z       Matched:',
  '2026-10-12T08:25:03Z          - @ConditionalOnProperty (approval.notification-outbox.enabled=true) matched (OnPropertyCondition)'
 ].join(String.fromCharCode(10))
 const out=projectStartupInspection(config,{container,startedAt,raw:positive});assert.equal(out.conditions[0].status,'matched');assert.equal(out.conditions[0].excludedByCondition,false)
 const conflict=projectStartupInspection(config,{container,startedAt,raw:raw+String.fromCharCode(10)+positive});assert.equal(conflict.conditions[0].status,'unavailable');assert.equal(conflict.conditions[0].excludedByCondition,null)
})

test('cap boundary, overflow and unknown integrity never prove condition exclusion',()=>{
 const capped=raw+'x'.repeat(524288-Buffer.byteLength(raw))
 for(const value of [capped,capped+'late omitted positive condition']){
  const out=projectStartupInspection(config,{container,startedAt,raw:value})
  assert.equal(out.conditions[0].status,'unavailable');assert.equal(out.conditions[0].excludedByCondition,null)
 }
 const unknown=projectActual(config,{container,startedAt,raw})
 assert.equal(unknown.conditions[0].excludedByCondition,null);assert.equal(unknown.windowIntegrity.status,'unknown')
})
