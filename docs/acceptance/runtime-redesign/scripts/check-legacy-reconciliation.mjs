import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {prepareReconciliation} from './reconcile-cutover-legacy.mjs'
const [sourcePath,manifestPath]=process.argv.slice(2)
const source=JSON.parse(await readFile(sourcePath,'utf8'))
const manifest=JSON.parse(await readFile(manifestPath,'utf8'))
const original=JSON.stringify(source)
const next=prepareReconciliation(source,manifest)
assert.equal(JSON.stringify(source),original)
assert.deepEqual(next.tables.tasks,source.tables.tasks)
for(const item of manifest.coordination) assert.equal(next.tables.groups[manifest.groupId].coordinationRequests[item.id].status,'superseded')
const out=next.tables.groups[manifest.groupId].outbox.find(x=>x.outboundId===manifest.outbounds[0].id)
assert.equal(out.status,'superseded')
assert.equal(out.deliveredMessageId,source.tables.groups[manifest.groupId].outbox.find(x=>x.outboundId===out.outboundId).deliveredMessageId)
for(const mutate of [m=>m.coordination.pop(),m=>m.coordination[0].expectedUpdatedAt='changed',m=>m.outbounds[0].textSha256='changed',m=>m.outbounds[0].completionOutboundId='missing']) {
 const altered=structuredClone(manifest);mutate(altered);assert.throws(()=>prepareReconciliation(source,altered))
}
console.log(JSON.stringify({passed:5,sourceUnchanged:true,tasksUnchanged:true,oldAcknowledgementNotMarkedDelivered:true}))
