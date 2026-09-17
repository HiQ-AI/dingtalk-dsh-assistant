// 只修订适用的 UAT 交付流程；--check 零副作用，--apply 使用配置版本 CAS 并回读。
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const endpoint = 'http://127.0.0.1:18998'
const flowId = 'workflow-uat-delivery'
const oldStep = '3. 用 D:/baibu-agent/scripts/read-woodpecker-pipeline.ps1 查询元数据与等价构建，参数为 BaseUrl、RepositoryId、PipelineNumber、SecureString Token；凭据来源先按当前部署配置核对。禁止打印完整 variables、认证头或原始失败响应。按 runbook 上传精确源码包或使用规定触发方式，核对源码 SHA、流水线及产物摘要。'
const newStep = '3. 用 D:/baibu-agent/scripts/read-woodpecker-pipeline.ps1 查询元数据与等价构建，参数为 BaseUrl、RepositoryId、PipelineNumber、SecureString Token；凭据来源先按当前部署配置核对。禁止打印完整 variables、认证头或原始失败响应。对于已接入源码包入口的 HiQ UAT 仓库，上传精确源码包是默认部署路径，不是可选优化。合并前先从目标 UAT 分支当前头核对 `.woodpecker` 流水线具备 `prepare-uploaded-source` 且仅在没有 `SOURCE_PACKAGE_ID` 时运行 `clone-source`，并核对仓库存在现行 `scripts/upload-woodpecker-source.ps1`；缺任一项时，上传 201 也不能证明流水线会消费代码包，不得进入合并/上传，须在当前授权内补齐部署基础或提交范围冲突。前置成立后，PR 合并并取得目标分支完整 merge SHA，立即在该远端分支头的干净检出中运行上传脚本，核对客户端退出码、201 接收回执、源码 SHA、包 SHA256、manual 流水线号及实际 `prepare-uploaded-source`，并确认没有执行 `clone-source`；不得先等待自动 clone 流水线。上传请求异常时先用脚本查询同 SHA 是否已受理，不能盲目重试。缺少正确脚本、受控凭据、干净分支头或上传/接收证据时停留在部署阶段继续诊断，不得静默退回慢速 clone 后把任务当作按流程完成。只有当前仓库或环境的现行 runbook 明确未接入源码包入口时，才能记录不适用依据并使用其规定触发路径。'

const mode = process.argv[2]
assert.ok(['--check', '--apply'].includes(mode), '使用 --check 或 --apply；apply 后跟证据目录')
const getConfig = async () => {
  const response = await fetch(`${endpoint}/state/agent-config`)
  assert.equal(response.status, 200, '读取本地配置失败')
  return response.json()
}
const before = await getConfig()
const matches = before.taskPrompts.filter((item) => item.id === flowId)
assert.equal(matches.length, 1, 'UAT 交付流程必须且只能存在一条')
const current = matches[0]
const alreadyUpdated = current.prompt.includes(newStep)
assert.ok(alreadyUpdated || current.prompt.includes(oldStep), 'UAT 交付流程基线不匹配，停止而非覆盖未知版本')

if (mode === '--check') {
  console.log(JSON.stringify({ verified: true, flowId, revision: current.revision, taskPromptsVersion: before.taskPromptsVersion, alreadyUpdated }))
} else {
  assert.ok(process.argv[3], 'apply 必须指定证据目录')
  assert.ok(!alreadyUpdated, '流程已经是目标版本，不重复写入')
  const evidenceDir = resolve(process.argv[3])
  await mkdir(evidenceDir, { recursive: true })
  const taskPrompts = before.taskPrompts.map((item) => item.id === flowId ? { ...item, prompt: item.prompt.replace(oldStep, newStep) } : item)
  await writeFile(resolve(evidenceDir, 'before-prompt.json'), JSON.stringify({ taskPromptsVersion: before.taskPromptsVersion, prompt: current }, null, 2), { flag: 'wx' })
  const response = await fetch(`${endpoint}/config/agent`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskPrompts, taskPromptsVersion: before.taskPromptsVersion }) })
  assert.equal(response.status, 200, '配置提交失败；检查版本冲突，不盲目重试')
  const after = await getConfig()
  const updated = after.taskPrompts.find((item) => item.id === flowId)
  assert.equal(after.taskPromptsVersion, before.taskPromptsVersion + 1)
  assert.equal(updated.revision, current.revision + 1)
  assert.ok(updated.prompt.includes(newStep))
  for (const item of before.taskPrompts.filter((value) => value.id !== flowId)) assert.deepEqual(after.taskPrompts.find((value) => value.id === item.id), item)
  for (const key of Object.keys(before).filter((value) => !['taskPrompts', 'taskPromptsVersion'].includes(value))) assert.deepEqual(after[key], before[key])
  await writeFile(resolve(evidenceDir, 'after-prompt.json'), JSON.stringify({ taskPromptsVersion: after.taskPromptsVersion, prompt: updated }, null, 2), { flag: 'wx' })
  console.log(JSON.stringify({ verified: true, flowId, revision: updated.revision, taskPromptsVersion: after.taskPromptsVersion, unrelatedConfigurationPreserved: true }))
}
