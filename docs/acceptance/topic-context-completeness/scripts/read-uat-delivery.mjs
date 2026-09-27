import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createHostPlatformClients } from '../../../../packages/dingtalk-dsh-assistant/platform-host.js'
const exec=promisify(execFile),fail=code=>{throw Error(code)}
const targets={dataset:{repository:'HiQ-AI/dataset',branch:'feature/uat3-base',pr:371,namespace:'hiqlcd-app-uat3',deployment:'dataset',url:'https://editor3.hiqdat.dev/api/dataset/ready'},'dataset-web':{repository:'HiQ-AI/dataset-web',branch:'feature/uat2-base',pr:368,namespace:'hiqlcd-app-uat2',deployment:'dataset-web',url:'https://editor2.hiqdat.dev/'}}
const baseUrl='https://woodpecker.hiqdat.dev',kubeconfig='D:/baibu-agent/.secrets/k3s/kubeconfig-uat.yml'
export async function readback({project,commit,pipeline,repositoryId,clients,notification}){
 const target=targets[project]
 if(!target||! /^[a-f0-9]{40}$/.test(commit)||!Number.isSafeInteger(pipeline)||pipeline<1||!Number.isSafeInteger(repositoryId)||repositoryId<1)fail('UAT_READBACK_ARGUMENT_INVALID')
 const [pr,branch,list]=await Promise.all([clients.github.readPullRequest({repository:target.repository,number:target.pr}),clients.github.readBranch({repository:target.repository,branch:target.branch}),clients.woodpecker.listPipelines({baseUrl,repositoryId})])
 if(!pr.merged||pr.baseBranch!==target.branch||pr.mergeCommitSha!==commit||pr.headCommitSha!==commit||branch.commitSha!==commit)fail('UAT_READBACK_PR_REF_MISMATCH')
 const selected=list.pipelines?.filter(p=>p.number===pipeline&&p.commitSha===commit&&p.branch===target.branch&&p.status==='success')
 if(!list.complete||selected?.length!==1)fail('UAT_READBACK_PIPELINE_MISMATCH')
 const build=await clients.woodpecker.readBuildEvidence({baseUrl,repositoryId,pipelineNumber:pipeline})
 const image='registry.cn-sh1.ctyun.cn/hiq-ai/'+project
 if(build.commitSha!==commit||build.image!==image+':'+target.branch.split('/')[1].replace('-base',''))fail('UAT_READBACK_BUILD_MISMATCH')
 const manifest=await clients.registry.readManifest({image,digest:build.imageDigest})
 const deployment=await clients.kubernetes.readDeployment(target)
 if(!deployment.ready||deployment.generation!==deployment.observedGeneration||deployment.desiredReplicas<1||deployment.readyReplicas!==deployment.desiredReplicas)fail('UAT_READBACK_DEPLOYMENT_NOT_READY')
 const pods=await clients.kubernetes.readPods({...target,deploymentUid:deployment.uid})
 if(!pods.complete||pods.pods.length!==deployment.desiredReplicas||pods.pods.some(p=>!p.ready||p.deploymentUid!==deployment.uid||!manifest.platformDigests.includes(p.imageDigest)))fail('UAT_READBACK_POD_DIGEST_MISMATCH')
 const entry=await clients.kubernetes.readEntry({url:target.url})
 if(!entry.accessible)fail('UAT_READBACK_HTTP_FAILED')
 const notice=await notification({repositoryId,pipeline,commit})
 if(!notice.confirmed)fail('UAT_READBACK_NOTIFICATION_UNCONFIRMED')
 const after=await clients.github.readBranch({repository:target.repository,branch:target.branch})
 if(after.commitSha!==commit)fail('UAT_READBACK_BRANCH_MOVED')
 return{project,commit,pipeline,repositoryId,pr:target.pr,branch:target.branch,build,manifest,deployment,pods,entry,notification:notice,passed:true}
}
async function kubectl(args){return JSON.parse((await exec('kubectl',['--kubeconfig',kubeconfig,'--server','https://192.168.8.8:6443','--insecure-skip-tls-verify','--request-timeout=15s','-n','db-dev',...args,'-o','json'],{windowsHide:true,maxBuffer:1024*1024,timeout:20000})).stdout)}
export async function main(args=process.argv.slice(2)){
 if(args.length!==6||args[0]!=='--project'||args[2]!=='--commit'||args[4]!=='--pipeline'||!targets[args[1]])fail('UAT_READBACK_ARGUMENT_INVALID')
 const project=args[1],commit=args[3],pipeline=Number(args[5])
 const poller=await kubectl(['get','deployment',`woodpecker-${project}-poller`])
 const entries=poller.spec.template.spec.containers.flatMap(c=>c.env??[]).filter(e=>e.name==='WOODPECKER_REPO_ID')
 if(entries.length!==1||! /^\d+$/.test(entries[0].value))fail('UAT_READBACK_POLLER_INVALID')
 const repositoryId=Number(entries[0].value),clients=(await createHostPlatformClients({secretsDirectory:'D:/baibu-agent/.secrets'})).release
 const secret=await kubectl(['get','secret','woodpecker-poller-credentials']),token=Buffer.from(secret.data.WOODPECKER_TOKEN,'base64').toString('utf8')
 const get=async path=>{const response=await fetch(baseUrl+'/api/'+path,{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(20000)});if(!response.ok)fail('UAT_READBACK_NOTIFY_READ_FAILED');return response.json()}
 const notification=async({repositoryId,pipeline,commit})=>{
  const detail=await get(`repos/${repositoryId}/pipelines/${pipeline}`)
  if(detail.commit!==commit||detail.status!=='success')fail('UAT_READBACK_NOTIFY_PIPELINE_MISMATCH')
  const steps=(detail.workflows??[]).flatMap(w=>w.children??[]).filter(s=>s.name==='notify-dingtalk')
  if(steps.length!==1||steps[0].state!=='success'||steps[0].exit_code!==0)return{confirmed:false}
  const rows=await get(`repos/${repositoryId}/logs/${pipeline}/${steps[0].id}`)
  if(!Array.isArray(rows)||rows.some(row=>row.step_id!==steps[0].id))fail('UAT_READBACK_NOTIFY_LOG_INVALID')
  const log=rows.map(row=>row.data?Buffer.from(row.data,'base64').toString('utf8'):'').join('')
  return{confirmed:/DingTalk notification sent status=success/.test(log),stepId:steps[0].id,receipt:'机器人接口errcode=0；不等同群消息独立回读'}
 }
 console.log(JSON.stringify(await readback({project,commit,pipeline,repositoryId,clients,notification}),null,2))
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(/^UAT_READBACK_[A-Z_]+$/.test(error.message)?error.message:'UAT_READBACK_FAILED');process.exitCode=1})
