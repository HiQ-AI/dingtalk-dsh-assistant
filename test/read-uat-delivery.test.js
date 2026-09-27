import test from 'node:test'
import assert from 'node:assert/strict'
import {readback} from '../docs/acceptance/topic-context-completeness/scripts/read-uat-delivery.mjs'
test('UAT独立回读绑定精确PR/ref/pipeline/image/pods与通知，拒绝旧部署和漂移',async()=>{
 const commit='a'.repeat(40),digest='sha256:'+'b'.repeat(64)
 const clients={github:{readPullRequest:async()=>({merged:true,baseBranch:'feature/uat3-base',mergeCommitSha:commit,headCommitSha:commit}),readBranch:async()=>({commitSha:commit})},woodpecker:{listPipelines:async()=>({complete:true,pipelines:[{number:7,commitSha:commit,branch:'feature/uat3-base',status:'success'}]}),readBuildEvidence:async()=>({commitSha:commit,image:'registry.cn-sh1.ctyun.cn/hiq-ai/dataset:uat3',imageDigest:digest})},registry:{readManifest:async()=>({platformDigests:[digest]})},kubernetes:{readDeployment:async()=>({uid:'deployment',ready:true,generation:1,observedGeneration:1,desiredReplicas:1,readyReplicas:1}),readPods:async()=>({complete:true,pods:[{ready:true,deploymentUid:'deployment',imageDigest:digest}]}),readEntry:async()=>({accessible:true})}}
 const input={project:'dataset',commit,pipeline:7,repositoryId:1,clients,notification:async()=>({confirmed:true})}
 assert.equal((await readback(input)).passed,true)
 await assert.rejects(readback({...input,commit:'c'.repeat(40)}),/PR_REF_MISMATCH/)
 await assert.rejects(readback({...input,pipeline:8}),/PIPELINE_MISMATCH/)
 await assert.rejects(readback({...input,notification:async()=>({confirmed:false})}),/NOTIFICATION_UNCONFIRMED/)
 clients.kubernetes.readPods=async()=>({complete:true,pods:[{ready:true,deploymentUid:'deployment',imageDigest:'old'}]})
 await assert.rejects(readback(input),/POD_DIGEST_MISMATCH/)
})
