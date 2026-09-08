// 仅修改 UAT 流程配置；--check 零副作用，--apply 用配置版本 CAS 保存并回读。
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const delivery = {
  id: 'workflow-uat-delivery', name: 'UAT 集成与验收', enabled: true,
  description: '适用：新修复/需求进入指定 UAT 并做业务验收。仅对已有精确提交重跑构建时，优先使用“UAT 同提交重构建与恢复”；按目标组合，不重复执行。',
  prompt: `目标：让指定 UAT 运行目标代码，完成本轮授权范围内的业务验收。
1. 核对原始目标、仓库/环境、开发提交、集成线和当前 runbook。计划明确适用项、可复用证据及不适用依据；复用须对应同一版本和场景，不能用旧报告代替本次变化的验证。
2. 新代码交付在本地必要测试/E2E 通过后，以不夹带无关历史的最小变更进入 UAT PR，在授权内合并并记录 SHA。仅重构建已有提交时不另建提交/PR，加载对应重构建流程。
3. 用 D:/baibu-agent/scripts/read-woodpecker-pipeline.ps1 查询元数据与等价构建，参数为 BaseUrl、RepositoryId、PipelineNumber、SecureString Token；凭据来源先按当前部署配置核对。禁止打印完整 variables、认证头或原始失败响应。按 runbook 上传精确源码包或使用规定触发方式，核对源码 SHA、流水线及产物摘要。
4. 等待滚动完成，独立核对 Registry digest、Deployment/Pod imageID、observedGeneration、就绪和重启数；不能只看流水线成功。失败先区分源码、测试、构建、推送和部署阶段，修正后重验受影响项。
5. 在真实 UAT 用同一业务对象验证原问题及相关场景，需要时串联页面/API/数据库；刷新后回读并检查资源缓存。没有业务操作证据不得称业务 E2E 通过。缺少必需业务验收条件时说明未验证项并交主会话协调，不能自行改为健康检查完成。
6. 按检查点工具的单项增量协议及时提交，不以累计历史填 completedItems；被拒绝先修正并确认，再进入下一阶段。结果交主会话，包含分支/PR、SHA、流水线、镜像/Pod、业务验收、复用/不适用依据及剩余边界。
验收：本轮所需源码→PR→流水线→digest→运行 Pod→业务结果可串联；不适用项说明依据。生产发布须属于另行确认的目标。`,
}
const rebuild = {
  id: 'workflow-uat-rebuild', name: 'UAT 同提交重构建与恢复', enabled: true,
  description: '适用：对已指定的 UAT 流水线/精确提交重跑构建，处理取源码、构建、推镜像或滚动失败。新代码修改或要求业务验收时再组合开发/UAT 交付流程。',
  prompt: `目标：在不混用环境、不覆盖更新版本、不重复构建的前提下，恢复指定提交的 UAT 构建与运行。
1. 读取原始授权、失败流水线与当前 runbook，核对仓库、环境、分支、完整 SHA、流水线 number 与 API ID、失败步骤/exit code/关键日志。计划列出本轮适用项、可复用证据、不适用项及理由。仅同提交重构建不新开业务 PR、不改业务代码。
2. 元数据与查重必须使用 D:/baibu-agent/scripts/read-woodpecker-pipeline.ps1，显式传 BaseUrl、RepositoryId、PipelineNumber 和 SecureString Token。先按当前 Deployment 的 Secret 引用取正确凭据，不猜历史 key。脚本完整分页并要求列表包含目标；空响应、未知状态或脚本失败必须调查，不能当作无冲突。禁止自行打印完整 variables、下载令牌、认证头或原始错误响应。
3. 触发前重读查询结果。equivalentBuildAbsent=false 时先核验已有成功/在途构建，不能重复触发；true 也须独立核对分支 HEAD、授权与当前环境运行版本。发现目标比环境已部署版本旧时交主会话协调，不能覆盖。完成该阶段检查点并确认后，才进入重构建。
4. 按当前 runbook 对精确 SHA 上传源码包/触发一次，核对包 SHA 和流水线绑定；请求报错先查询是否已受理再重试。触发后用同一脚本回读等价列表，核对只出现预期的新流水线。跟踪所有必需步骤，不把上传成功视为部署完成。
5. 独立串联源码 SHA、构建产物 digest、Registry、Deployment/Pod imageID、就绪和重启数。仅恢复构建且目标只要求运行健康时执行适当健康检查，并明确“未执行业务 E2E”；若目标要求业务验收或运行变化影响业务场景，组合 UAT 交付流程执行必需用例，不能以 HTTP 200 替代。
6. 每阶段按工具要求只提交本次新增单项，拒绝后先纠正，禁止先做后补报。向主会话交付失败/新流水线链接、SHA、digest、运行结果、复用/不适用依据、未验证项与简短复盘；不能用单次临时故障推导未经复核的长期规则。
验收：指定提交绑定正确，查重与版本保护证据完整，构建/部署及本轮必需验收通过；没有授权或证据的范围如实保留。`,
}
const mode = process.argv[2]
assert.ok(['--check', '--apply'].includes(mode), '使用 --check 或 --apply，apply 后跟备份目录')
const endpoint = 'http://127.0.0.1:18998'
const getConfig = async () => { const r = await fetch(endpoint + '/state/agent-config'); assert.equal(r.status, 200); return r.json() }
const before = await getConfig()
const original = before.taskPrompts.find(p => p.id === delivery.id)
assert.ok(original)
assert.ok(!before.taskPrompts.some(p => p.id === rebuild.id), '重构建流程已存在，请先复核，不覆盖')
const taskPrompts = before.taskPrompts.map(p => p.id === delivery.id ? delivery : p)
taskPrompts.push(rebuild)
if (mode === '--check') console.log(JSON.stringify({version:before.taskPromptsVersion, originalRevision:original.revision, update:delivery.name, add:rebuild.name, total:taskPrompts.length}))
else {
  assert.ok(process.argv[3], '必须指定配置备份目录')
  const output = resolve(process.argv[3]); await mkdir(output, {recursive:true})
  await writeFile(resolve(output, 'before.json'), JSON.stringify(before,null,2), {flag:'wx'})
  const r = await fetch(endpoint + '/config/agent', {method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify({taskPrompts,taskPromptsVersion:before.taskPromptsVersion})})
  assert.equal(r.status,200,'配置提交失败，不盲目重试；检查版本冲突')
  const after = await getConfig()
  assert.equal(after.taskPromptsVersion,before.taskPromptsVersion+1)
  assert.equal(after.taskPrompts.length,taskPrompts.length)
  for (const item of before.taskPrompts.filter(p=>p.id!==delivery.id)) assert.deepEqual(after.taskPrompts.find(p=>p.id===item.id),item)
  for (const item of [delivery,rebuild]) assert.deepEqual(after.taskPrompts.find(p=>p.id===item.id),{...item,revision:item===delivery?original.revision+1:1})
  for (const key of Object.keys(before).filter(k=>!['taskPrompts','taskPromptsVersion'].includes(k))) assert.deepEqual(after[key],before[key])
  await writeFile(resolve(output,'after.json'),JSON.stringify(after,null,2),{flag:'wx'})
  console.log(JSON.stringify({verified:true,version:after.taskPromptsVersion,total:after.taskPrompts.length,unrelatedSettingsPreserved:true}))
}
