import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewRequestAllowed, eligibleReviewer, executeReview } from '../scripts/local-acceptance-review.mjs'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const origin='http://127.0.0.1:19001', fixture={applicationId:'review-test',processId:'process-test'}
test('准备前初始化可证明零资源；旧缺账和已开始但未关闭资源保持拒绝', async t => {
 const root=await mkdtemp(join(tmpdir(),'review-init-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const config={uatEnvironment:'uat2',ssoOrigin:'https://editor2.hiqdat.dev',evidenceRoot:root,accountsFile:join(root,'unused.json'),playwrightModule:join(root,'unused.mjs'),accountKey:'editor_uat_admin',reviewFixture:fixture}
 const input={uatEnvironment:'uat2',namespace:'acceptance-'+ 'a'.repeat(32),baseUrl:origin}
 for(const mode of ['cleanup','verify-cleanup'])await assert.rejects(executeReview(mode,config,input),/CLEANUP_UNCONFIRMED/)
 await executeReview('initialize',config,input)
 await assert.rejects(executeReview('initialize',config,input),/ALREADY_INITIALIZED/)
 assert.equal((await executeReview('cleanup',config,input)).createdResources,0)
 assert.equal((await executeReview('verify-cleanup',config,input)).empty,true)
 const path=join(root,input.namespace,'review-ledger.json'),ledger=JSON.parse(await readFile(path,'utf8'))
 ledger.sessionClosed=false;await writeFile(path,JSON.stringify(ledger))
 await assert.rejects(executeReview('cleanup',config,input),/CLEANUP_UNCONFIRMED/)
 ledger.sessionClosed=true;ledger.browserClosed=false;await writeFile(path,JSON.stringify(ledger))
 await assert.rejects(executeReview('verify-cleanup',config,input),/CLEANUP_UNCONFIRMED/)
 await assert.rejects(executeReview('verify-cleanup',config,{...input,baseUrl:'http://127.0.0.1:19002'}),/LEDGER_IDENTITY/)
})
test('前端Host配置先初始化ledger再安装依赖',async()=>{
 const source=await readFile(new URL('../docs/acceptance/topic-context-completeness/scripts/prepare-task-uat-configuration.mjs',import.meta.url),'utf8')
 assert.match(source,/frontend\.prepareSteps = \[command\(review, reviewRuntimePath, files\[2\], 'initialize'\), command\(review, reviewRuntimePath, files\[0\], 'prepare-web'\)\]/)
})
test('评审场景只允许指定对象读取，拒绝提交、分配、上传和异源',()=>{
 const allowed=(path,method='GET',body)=>reviewRequestAllowed(origin+path,method,origin,'xhr',body,fixture)
 assert.equal(allowed('/api/dataset/approval/reviewContext?applicationId=review-test'),true)
 assert.equal(allowed('/api/dataset/approval/reviewContext?applicationId=other'),false)
 assert.equal(allowed('/api/dataset/approval/reviewContext?applicationId=review-test&unexpected=1'),false)
 for(const path of ['/approval/approve','/approval/assign','/approval/saveReply','/approval/attachment/upload'])assert.equal(allowed('/api/dataset'+path,'POST',{}),false)
 assert.equal(allowed('/api/dataset/data/getNewDataDetails','POST',{processId:'process-test',scene:0,isShow:'baseInfo'}),true)
 assert.equal(allowed('/api/dataset/data/getNewDataDetails','POST',{processId:'other',scene:0,isShow:'baseInfo'}),false)
 assert.equal(reviewRequestAllowed('https://editor2.hiqdat.dev/api/dataset/approval/reviewContext?applicationId=review-test','GET',origin,'xhr',undefined,fixture),false)
})
test('评审必须是真实未提交审核人，不能用管理员身份或旧轮结果冒充',()=>{
 const context={currentRound:2,reviewers:[{id:'reviewer',type:'LCA_EXPERT'}]}
 assert.equal(eligibleReviewer(context,[],'reviewer'),true)
 assert.equal(eligibleReviewer(context,[],'admin'),false)
 assert.equal(eligibleReviewer(context,[{reviewerId:'reviewer',reviewType:'LCA_EXPERT',round:2,status:'REVISION'}],'reviewer'),false)
 assert.equal(eligibleReviewer(context,[{reviewerId:'reviewer',reviewType:'LCA_EXPERT',round:1,status:'APPROVED'}],'reviewer'),false)
 assert.equal(eligibleReviewer(context,[{reviewerId:'reviewer',reviewType:'LCA_EXPERT',round:1,status:'REVISION'}],'reviewer'),true)
})
