import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const marker = '[coordination-repair-preflight-v1]'
const shared = `
${marker}
执行前置与等待约定：
- 先读当前 runbook、目标环境、已允许的可用环境及隔离条件；已有 UAT 隔离 schema/临时数据库可用时复用，不能仅因临时选择 Docker 就转人工阻塞。共享 UAT 本身不代表允许任意 SQL 演练；确实缺少必要资源时提交证据和具体人工动作。
- 独立只读查询按依赖分组批量/并行执行并返回结构化证据；有副作用或先后依赖的步骤严格顺序。后台构建/测试复用既有 job 完成事件唤醒，不以模型定时重复 job_output。需读新输出或作决定时再读取；无事件能力时明确记录限制，按 runbook 有界等待，不能虚称事件已经接入。
- 每项结果独立记录 PASS/FAIL/UNKNOWN 与证据时间、来源；缺证据/超时是 UNKNOWN，不得当通过。工具成功、构建成功、Pod Ready、业务 E2E 分别核验。
`
const additions = {
  'workflow-production-release': `
发布准备必须在合并/生产变更之前完成：从实际生产只读基线与精确候选依赖列出全部前置表、列、索引和迁移，核对基础迁移与增量迁移集合。不能假设较早基础迁移已在生产；声明清单完整性并保留来源。发现缺少基础对象先停止生产执行，补齐候选与审批范围后重审。
将 SQL、后端、前端等实际依赖顺序写入结构化计划；只对当前候选确定顺序，不固定为所有发布一律 SQL 优先。明确停止条件、回退范围及批准所绑定的环境/SQL摘要/候选版本。原批准不覆盖后加 SQL 或变更资源；请求结果不确定先独立回查再决定，不能重放副作用。
`,
  'workflow-data-change': `
数据变更准备先从生产只读基线核对候选依赖和完整迁移集合，逐项标明目标对象 present/missing/unknown 及来源。仅增量 SQL 编译或演练通过不能证明生产基础对象存在；缺基础对象为 FAIL，基线/依赖清单不完整为 UNKNOWN，二者均停止生产推进。
演练只能在 runbook 已允许的隔离环境，记录隔离范围、样本边界与清理方式；演练结果不代表生产已执行。固定 SQL 摘要、目标资源、应用依赖顺序、停止与回退条件后核对精确批准；生产执行后单独回读工单状态、实际 schema/数据及必要业务结果。
`,
}

export function revisePreflightPrompts(config) {
  if (!Number.isInteger(config.taskPromptsVersion) || !Array.isArray(config.taskPrompts)) throw new Error('task_prompt_config_invalid')
  for (const id of Object.keys(additions)) if (!config.taskPrompts.some((prompt) => prompt.id === id)) throw new Error(`task_prompt_missing:${id}`)
  let changed = false
  const taskPrompts = config.taskPrompts.map((prompt) => {
    if (!additions[prompt.id] || prompt.prompt?.includes(marker)) return prompt
    if (!Number.isInteger(prompt.revision) || typeof prompt.prompt !== 'string') throw new Error(`task_prompt_invalid:${prompt.id}`)
    changed = true
    return { ...prompt, revision: prompt.revision + 1, prompt: (prompt.prompt + additions[prompt.id] + shared).trim() }
  })
  return { ...config, taskPrompts, taskPromptsVersion: config.taskPromptsVersion + Number(changed) }
}

// 仅验证提供的证据契约，不连接生产，也不把引用存在当成独立核验。
export function assessReleasePreflight(input) {
  const checks = [], add = (id, status, reason) => checks.push({ id, status, reason })
  const baseline = input.baseline
  add('production-baseline', baseline?.environment === 'production' && baseline.readOnly === true && baseline.observedAt && baseline.evidenceRef ? 'PASS' : 'UNKNOWN', '需实际生产只读基线、发生时间与证据引用')
  const candidate = input.candidate
  const complete = candidate?.dependencyInventoryComplete === true && candidate.revision && candidate.evidenceRef && Array.isArray(candidate.requiredObjects)
  add('candidate-dependencies', complete ? 'PASS' : 'UNKNOWN', '必须声明精确候选依赖集合完整性；空集合也必须有依据')
  for (const name of candidate?.requiredObjects ?? []) {
    const rows = (input.observations ?? []).filter((item) => item.name === name)
    const row = rows.length === 1 ? rows[0] : undefined
    add(`object:${name}`, row?.status === 'missing' && row.evidenceRef ? 'FAIL' : row?.status === 'present' && row.evidenceRef ? 'PASS' : 'UNKNOWN', row?.evidenceRef ?? '缺少唯一可追溯对象观测')
  }
  const env = input.rehearsalEnvironment
  add('rehearsal-environment', env?.authorized === false || env?.isolated === false ? 'FAIL' : env?.authorized === true && env?.isolated === true && env.available === true && env.runbookRef && env.evidenceRef ? 'PASS' : 'UNKNOWN', '需已授权、可用、隔离环境及 runbook；不指定 Docker')
  const order = input.executionOrder
  const explicit = order?.steps?.length && Array.isArray(order.dependencies) && order.evidenceRef && order.stopConditions?.length && order.rollbackScope
  const invalid = explicit && (new Set(order.steps).size !== order.steps.length || order.dependencies.some(({ before, after }) => !order.steps.includes(before) || !order.steps.includes(after) || order.steps.indexOf(before) >= order.steps.indexOf(after)))
  add('execution-order', invalid ? 'FAIL' : explicit ? 'PASS' : 'UNKNOWN', '结构化顺序必须满足已声明依赖并带停止/回退条件')
  return { status: checks.some((check) => check.status === 'FAIL') ? 'FAIL' : checks.some((check) => check.status === 'UNKNOWN') ? 'UNKNOWN' : 'PASS', checks, boundary: '仅检查证据契约完整性，不授予生产执行许可，不证明证据内容真实或业务验收通过。' }
}

async function main() {
  const args = process.argv.slice(2), mode = args.shift()
  if (!['--check', '--write'].includes(mode)) throw new Error('使用 --check|--write --input <config.json> [--output <revised.json>] [--evidence <evidence.json>]')
  const parameters = new Map()
  while (args.length) { const key = args.shift(), value = args.shift(); if (!['--input', '--output', '--evidence'].includes(key) || !value || parameters.has(key)) throw new Error('invalid_arguments'); parameters.set(key, value) }
  if (!parameters.has('--input')) throw new Error('input_required')
  const before = JSON.parse(await readFile(resolve(parameters.get('--input')), 'utf8')), after = revisePreflightPrompts(before)
  const assessment = parameters.has('--evidence') ? assessReleasePreflight(JSON.parse(await readFile(resolve(parameters.get('--evidence')), 'utf8'))) : undefined
  if (mode === '--write') {
    if (!parameters.has('--output')) throw new Error('output_required')
    await writeFile(resolve(parameters.get('--output')), JSON.stringify(after, null, 2), { flag: 'wx' })
  }
  console.log(JSON.stringify({ mode, beforeVersion: before.taskPromptsVersion, proposedVersion: after.taskPromptsVersion, changes: after.taskPrompts.filter((p) => before.taskPrompts.find((b) => b.id === p.id)?.revision !== p.revision).map(({ id, revision }) => ({ id, revision })), ...(assessment ? { assessment } : {}) }))
  if (assessment && assessment.status !== 'PASS') process.exitCode = 2
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
