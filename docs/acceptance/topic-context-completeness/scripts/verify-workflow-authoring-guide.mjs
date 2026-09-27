import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, mkdtemp, stat } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve, dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { openExecutionStore } from '../../../../packages/dingtalk-dsh-assistant/execution-store.js'
import { executionDigest, openExecutionArtifacts } from '../../../../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController } from '../../../../packages/dingtalk-dsh-assistant/execution-controller.js'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const { values } = parseArgs({ options: { output: { type: 'string', default: 'docs/tmp/workflow-authoring-guide/guide-validation.json' } } })
const manual = join(root, 'packages/dingtalk-dsh-assistant/README.md')
const text = await readFile(manual, 'utf8')
const section = text.split('<!-- workflow-authoring-example:start -->')[1]?.split('<!-- workflow-authoring-example:end -->')[0]
const snippet = /```javascript\r?\n([\s\S]*?)\r?\n```/.exec(section ?? '')?.[1]
assert.ok(snippet, '手册必须存在完整示例')
const code = snippet.replace("'./execution-artifacts.js'", JSON.stringify(pathToFileURL(join(root, 'packages/dingtalk-dsh-assistant/execution-artifacts.js')).href))
const { createEvidenceSummaryWorkflow } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
const tmp = join(root, 'docs/tmp/workflow-authoring-guide')
await mkdir(tmp, { recursive: true })
const results = []
for (const kind of ['valid', 'invalid-schema', 'foreign-evidence']) {
  const directory = await mkdtemp(join(tmp, `${kind}-`))
  const store = await openExecutionStore({ dbPath: join(directory, 'control.sqlite'), instanceId: `guide-${kind}`, initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(directory, 'artifacts'), initialize: true })
  const workflow = createEvidenceSummaryWorkflow()
  if (kind === 'foreign-evidence') workflow.nodes[1].execute = async ({ input }) => ({ summary: input.text.trim(), evidenceIds: ['other-source'] })
  const controller = createExecutionController({ store, artifacts, workflows: [workflow] })
  try {
    const request = { commandId: `create-${kind}`, taskId: `task-${kind}`, runId: `run-${kind}`, workflowId: workflow.id,
      input: kind === 'invalid-schema' ? { text: '缺少来源' } : { sourceId: 'source-1', text: '  合成材料  ' } }
    if (kind === 'invalid-schema') {
      await assert.rejects(controller.createRun(request), { code: 'NODE_SCHEMA_INVALID' })
      assert.equal((await store.query({ kind: 'run', runId: request.runId })).run, null)
      results.push({ case: kind, status: 'PASS', observation: '非法输入拒绝且未创建 Run' })
      continue
    }
    await controller.createRun(request)
    const state = await controller.whenIdle(request.runId)
    if (kind === 'valid') {
      assert.equal(state.run.status, 'succeeded')
      assert.equal(state.nodes.filter(node => node.status === 'succeeded').length, 3)
      const output = await artifacts.read(state.nodes.at(-1).outputRef)
      assert.deepEqual(output, { summary: '合成材料', evidenceIds: ['source-1'] })
      await controller.createRun(request)
      assert.equal((await controller.whenIdle(request.runId)).nodes.length, 3)
      results.push({ case: kind, status: 'PASS', observation: '3 节点成功、工件独立读回、相同接纳请求重放不重复创建节点', output })
    } else {
      assert.equal(state.run.status, 'waiting')
      assert.equal(state.nodes.at(-1).waitReason.reference, 'EVIDENCE_RESULT_INVALID')
      results.push({ case: kind, status: 'PASS', observation: '结构合法但引用错误的产物被业务校验阻断' })
    }
  } finally { await controller.close(); await store.close() }
}

const documents = ['packages/dingtalk-dsh-assistant/README.md', 'docs/ops/execution-foundation-local.md',
  'docs/spec/workflow-session-responsibility.md', 'docs/acceptance/topic-context-completeness/round-41.md']
let linkCount = 0
for (const document of documents) {
  const content = await readFile(join(root, document), 'utf8')
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const link = match[1].split('#')[0]
    if (!link || /^[a-z]+:\/\//i.test(link)) continue
    const file = resolve(dirname(join(root, document)), decodeURIComponent(link))
    assert.ok(file.startsWith(root), `引用越出仓库: ${link}`)
    assert.ok((await stat(file)).isFile(), `引用文件不存在: ${link}`)
    linkCount++
  }
}
const report = { testedAt: new Date().toISOString(), sourceDigest: executionDigest(snippet), source: '从当前工作区手册原文提取示例，不维护第二份示例源码', results, localLinks: { checked: linkCount, status: 'PASS' } }
const outputPath = resolve(root, values.output)
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
