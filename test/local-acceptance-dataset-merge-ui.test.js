import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeDatasetMergeUI, serveDatasetMergeUI } from '../scripts/local-acceptance-dataset-merge-ui.mjs'
const taskId='task-83c651ebdbdb77584a06d1fcb6b9e255'
test('merge UI runner rejects another Task and UAT before loading candidate',async()=>{
 const config={taskId,uatEnvironment:'uat3',playwrightModule:'D:/test/pw.mjs',evidenceRoot:'D:/test/evidence'}
 await assert.rejects(executeDatasetMergeUI('--check',{...config,taskId:'other'}),/TASK_SCOPE_INVALID/)
 await assert.rejects(executeDatasetMergeUI('--check',{...config,uatEnvironment:'uat2'}),/UAT_SCOPE_INVALID/)
})
test('merge UI lifecycle keeps namespace identity and zero-write cleanup',async()=>{
 const root=await mkdtemp(join(tmpdir(),'merge-ui-'))
 try{const config={taskId,uatEnvironment:'uat3',playwrightModule:join(root,'pw.mjs'),evidenceRoot:root}
 const input={taskId,uatEnvironment:'uat3',namespace:'acceptance-'+'a'.repeat(32),baseUrl:'http://127.0.0.1:19321'}
 assert.equal((await executeDatasetMergeUI('initialize',config,input)).initialized,true)
 assert.deepEqual(await executeDatasetMergeUI('verify-cleanup',config,input),{namespace:input.namespace,empty:true,createdResources:0,mode:'read-only'})
 await assert.rejects(executeDatasetMergeUI('initialize',config,input),/EEXIST/)
 await assert.rejects(executeDatasetMergeUI('cleanup',config,{...input,baseUrl:'http://127.0.0.1:19322'}))
 await assert.rejects(executeDatasetMergeUI('cleanup',config,{...input,taskId:'other'}),/INPUT_TASK_INVALID/)
 }finally{await rm(root,{recursive:true,force:true})}
})

test('hosted UI service rejects public binding and mismatched Host context',async()=>{
 const config={taskId,uatEnvironment:'uat3'},input={uatEnvironment:'uat3',namespace:'acceptance-'+'a'.repeat(32),baseUrl:'http://127.0.0.1:19321'}
 await assert.rejects(serveDatasetMergeUI(config,input,{host:'0.0.0.0',port:19321}))
 await assert.rejects(serveDatasetMergeUI(config,input,{host:'127.0.0.1',port:19322}))
 await assert.rejects(serveDatasetMergeUI(config,{...input,uatEnvironment:'uat2'},{host:'127.0.0.1',port:19321}))
})
