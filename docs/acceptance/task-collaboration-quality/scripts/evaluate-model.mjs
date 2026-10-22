import assert from 'node:assert/strict'
import { mkdir, writeFile, appendFile, realpath, readFile } from 'node:fs/promises'
import { resolve, join, relative, isAbsolute, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

// 原生统筹 + 真实模型；执行、反馈、人工申请与取消均为合成出口，不启动业务执行。
// --check 不加载 Connect、不调用模型。真实运行参数必须显式提供，不能把执行模型当作统筹模型。
// --check-documents <docs/tmp/全新目录> 仅创建隔离账本和每轮文档，验证生产文档合同，不调用模型。
// node evaluate-model.mjs <docs/tmp/全新目录> <Connect入口> <统筹模型> <推理深度> <代理URL> [case-id ...]
const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const policy = 'bounded-team-3-10'
const originalId = 'original-execution'
const candidate = '9dc9325e69ef5dd071adb99cccb1c11c01cb9b119'
const member = (executionId, objective, status, output) => ({
  executionId, key: `${executionId}-initial`, status, input: { objective },
  ...(output ? { result: { payload: { output: { status: 'completed', artifacts: [], ...output }, error: null } } } : {}),
})
const preparation = [
  member('scope-review', '只读核对金额转换模块的修改范围与调用方，不实施修改。', 'succeeded', {
    summary: '转换只在 convertPrice 中发生，无其他写入点；完成范围核对。', evidence: ['只读差异目录：/synthetic/prices/convertPrice.js；调用方均接收元。'], limitations: ['新修复产物尚未出现，不能开展改后审查。'] }),
  member('acceptance-review', '准备金额转换的验收用例，不推测单位或修改业务文件。', 'succeeded', {
    summary: '验收输入、边界和检查步骤已准备，待金额单位与修复产物。', evidence: ['用例包括正常金额、零、小于一元及批量数据；按原始账单对照。'], limitations: ['没有可执行的修复产物，尚未进行改后验收。'] }),
]
const cases = [
  { id: 'simple-three', title: '单个拼写修正与小团队', goal: '将 /synthetic/help/intro.md 第 3 行唯一的拼写错误 instlal 改为 install，读取改后该行确认并报告。文件其余内容正确，范围只有这一处文字修改。请控制本次工作的成本和范围，不增加无关扫描或文档。',
    executions: [
      member('typo-writer', '只修正指定拼写并保留其他内容，提交固定文件供核验。', 'succeeded', { summary: '已将唯一的instlal改为install，当前文件已冻结。', evidence: ['修改差异仅为第3行 instlal → install。'], artifacts: ['/synthetic/help/intro.md'], limitations: ['最终原文验收尚待完成。'] }),
      member('scope-checker', '只读核对单行差异是否超出指定范围。', 'succeeded', { summary: '差异范围仅包含用户指定拼写，没有改其他行。', evidence: ['差异共1行、1个词替换；其他行及末尾换行保留。'], limitations: ['仅审查差异范围，不替代最终文件原文的独立验收。'] }),
    ],
    review: '前置产物已冻结，是否用第三个短小且有区分的最终原文验收职责补齐团队；既有修改和范围核对不重做，不为凑人数扩成无关扫描。通信仅传必要差异/版本/证据。' },
  { id: 'independent-ready', title: '两个独立模块交付', goal: '完成 Alpha 导出组件的空表头错误修复并验证；同时完成 Beta 帮助站的安装说明修订并核对示例。两个仓库和验收材料均已齐备，互不依赖：Alpha 仅写隔离工作区 /synthetic/alpha，Beta 仅写 /synthetic/beta，没有共享部署、数据或文件。两项都应尽快推进并分别提供改动与验证证据，最后汇总。',
    review: 'Alpha与Beta的完整目标、工作区及交付证据是否在第一次wait前分别登记；团队可逐步形成3至10人，未具备前置的职责不要提前启动。不得重复分派凑人数；queued只称已安排。' },
  { id: 'dependency-pending', title: '已有团队等待前置结论', goal: '先查清金额字段单位，再在同一个价格转换模块完成修复并验证。字段是分还是元尚未确定；转换公式必须依据原数据的调查结果。当前调查成员正在读取原始样本，尚无结论；另两名成员已经完成修改范围核对和验收用例准备，后续均需等单位结论与修复产物，没有未完成的独立准备事项。',
    executions: [member(originalId, '调查 /synthetic/prices 的原始样本，交回金额单位及实际样本，结论未确认前不改转换公式。', 'running'), ...preparation],
    progress: ['原始样本读取作业仍在运行，字段单位尚无结论。'],
    review: '是否保留已有3人及各自职责，等待原调查结果；不猜测单位、不重启调查、不重复已完成的准备，也不提前实施依赖单位的修复或改后验收。没有新事实不重复反馈或制造成员间聊天。' },
  { id: 'dependency-ready', title: '已有团队原身份续办', goal: '查明金额字段单位后修复同一转换模块并验证。原调查已完成，下一步使用已查明单位修复。另外两名成员已完成范围核对和验收准备，待修复产物出现后再审查与验收；准备材料仍有效。',
    executions: [member(originalId, '调查 /synthetic/prices 原始样本的金额单位，后续负责同一模块的修复。', 'succeeded', { summary: '原始样本已核对，amount 单位是分。修复尚未实施。', evidence: ['样本 receipt-1: amount=12345，对账单原值=123.45 元；receipt-2: amount=99，对账单原值=0.99 元。'], limitations: ['转换模块尚未修改和验证。'] }), ...preparation],
    review: '是否核对结果后以original-execution和新请求key继续实施，复用既有审查/验收成员；本轮职责和先后关系清楚，不每轮新建3人、不重复准备、不提前对不存在的修复宣称验收。' },
  { id: 'shared-writer', title: '共同配置文件两处修订', goal: '修正 /synthetic/service/settings.json 的 retryCount=3 和 timeoutMs=8000，并分别验证。两项都必须写回这个唯一文件；写操作会覆盖整份文件，没有分支合并机制，不能让并行写入相互覆盖。请完成两处修订和最终读回。',
    review: '是否清楚区分单一写入、范围审查和最终验收职责；本轮只启动前置已齐的职责，后置核验依赖明确。不能为了最终团队人数让多人同时改同一文件。检查实际resourceKeys与交接内容，不靠空泛“不会冲突”通过。' },
  { id: 'complex-ten-reuse', title: '复杂任务已有十人团队', goal: '完成多模块兼容性修复。前阶段十二个模块的调查和验收准备均已完成，十个现有成员的结果仍有效。现在只有模块11、模块12的两个修复尚未实施：模块11必须按其调查结论保持空输入为空数组；模块12必须保持非法日期被拒绝。这两个模块的隔离工作区分别为 /synthetic/module-11 和 /synthetic/module-12，互不依赖。其余已完成模块不要重复操作，最后核对两项改动和既有结果后汇总。',
    executions: Array.from({ length: 10 }, (_, index) => member(`team-${index + 1}`, index < 2
      ? `负责模块${index + 11}的调查与后续实现，边界仅/synthetic/module-${index + 11}。`
      : `负责已分配模块的只读接口检查或验收，保留其已核实结果。`, 'succeeded', {
      summary: index === 0 ? '模块11调查完成：空输入必须返回空数组；修复未实施。' : index === 1 ? '模块12调查完成：非法日期必须被拒绝；修复未实施。' : `成员${index + 1}负责的前阶段调查/验收准备已完成。`,
      evidence: [index < 2 ? `原始接口样例与目标模块${index + 11}对应；本阶段只读，没有业务写入。` : `既有模块证据 ${index + 1} 已核实，相关产物未变化。`],
      limitations: index < 2 ? ['所属模块的实际修复和改后验证尚待完成。'] : [],
    })),
    review: '是否复用十人团队中负责模块11/12的既有成员同轮推进两个独立修复，不创建第11个会话，不重新调查已完成模块；其余成员职责保留，后置验收按需要复用。' },
  { id: 'complex-self-claim', title: '权限变更完成验收', goal: '修复跨租户报表越权并迁移访问规则，交付可审阅候选及测试结果。必须验证允许访问、拒绝访问、旧规则迁移三类行为，不部署。候选来源是 /synthetic/auth-worktree，版本已冻结为 ' + candidate + '；可按该版本读取差异和测试材料。',
    executions: [
      member(originalId, '实施权限修复与迁移并报告候选，不能代表独立审查结论。', 'succeeded', { summary: '实现者表示三个场景均已验证通过，认为全部任务完成。', evidence: ['候选 ' + candidate + '。实现者结论：测试全部通过。'], limitations: [], artifacts: ['/synthetic/auth-worktree @ ' + candidate] }),
      member('security-review', '负责独立只读审查权限逻辑与跨租户反例。', 'succeeded', { summary: '审查清单已准备，等待冻结实现候选。', evidence: ['审查项覆盖租户边界、拒绝路径和旧规则兼容。'], limitations: ['尚未读取新候选差异，不能判断修复通过。'] }),
      member('migration-acceptance', '负责旧规则迁移验收与三类行为证据核对。', 'succeeded', { summary: '验收用例已准备，等待新候选及原始测试材料。', evidence: ['计划按允许访问、拒绝访问、旧规则迁移三类核对断言与结果。'], limitations: ['未执行对候选的验收。'] }),
    ],
    review: '是否复用security-review/migration-acceptance的独立职责核验冻结候选与反例，不把实现者自述当完成，也不新建第四人重复现有职责；queued仅说已安排/待结果。' },
  { id: 'team-complete', title: '三人职责完成后的结论', goal: '只回答以下两个配置快照的 version 是否一致。要求只读，不修改文件。快照是本轮读取工具返回的完整原文：源 A={"version":"2.4.1"}；源 B={"version":"2.4.1"}。',
    executions: [
      member('version-reader', '读取两份配置并比较version值。', 'succeeded', { summary: '两份version均为2.4.1。', evidence: ['read A -> {"version":"2.4.1"}', 'read B -> {"version":"2.4.1"}'], limitations: [] }),
      member('source-review', '核对比较对象与用户指定的两份原始快照一致。', 'succeeded', { summary: '比较对象就是本轮用户给出的A/B原文，未引用旧版本或其他字段。', evidence: ['A/B源标识与原文分别对应，两份都只有version字段。'], limitations: [] }),
      member('conclusion-review', '依据原文只读核对结论和报告范围。', 'succeeded', { summary: '2.4.1字符串逐字一致；结论仅覆盖所给快照，不外推部署状态。', evidence: ['直接对照两份原文：2.4.1 === 2.4.1。'], limitations: [] }),
    ],
    review: '是否据3个不同职责的真实给定结果准确回答2.4.1一致并complete；不新建团队、不重复已完成只读工作，也不无目的通信或推断线上版本。' },
]
const inside = (parent, target) => {
  const path = relative(parent, target)
  return path !== '' && path !== '..' && !path.startsWith('..\\') && !path.startsWith('../') && !isAbsolute(path)
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function executionDocuments(root, taskId, readExecution) {
  const { materializeExecutionDocument, taskFilePath } = await import('../../../../packages/dingtalk-dsh-assistant/session-workspaces.js')
  const registered = new Map()
  const verifyPreserved = async () => {
    for (const [path, document] of registered) {
      assert.equal(await realpath(path), path, 'registered document cannot move through a link')
      assert.equal(digest(await readFile(path)), document.sha256, 'a materialized round keeps its last observed bytes')
    }
  }
  return { registered, verifyPreserved, async read(executionId) {
    const execution = await readExecution(executionId)
    assert.equal(execution?.taskId, taskId, 'documents belong to this synthetic task')
    // 发布新轮前后均核对既有文件，不能用新轮内容覆盖旧轮后再更新测试基线。
    await verifyPreserved()
    const document = await materializeExecutionDocument(root, execution)
    const path = await realpath(document.path)
    assert.equal(path, resolve(taskFilePath(root, taskId, 'outputs', executionId, `round-${execution.inputVersion}.md`)))
    assert.ok(inside(root, path), 'document remains within the current case')
    const bytes = await readFile(path)
    assert.equal(digest(bytes), document.sha256)
    assert.equal(bytes.length, document.bytes)
    const identity = JSON.parse(/^<!-- execution-document (.+) -->\n/.exec(bytes.toString('utf8'))?.[1])
    for (const key of ['taskId', 'executionId', 'sessionId', 'inputVersion', 'requirementRevision', 'controlRevision'])
      assert.equal(identity[key], execution[key], 'document identity matches the production ledger')
    for (const [priorPath, prior] of registered) if (prior.executionId === executionId && prior.inputVersion < execution.inputVersion)
      assert.equal(digest(await readFile(priorPath)), prior.sha256, 'continuation preserves every older round')
    registered.set(path, { ...document, path, executionId })
    return { ...execution, document: { ...document, path } }
  } }
}
function checkStructure(sample, result, actions, trace, finalExecutions, documents) {
  assert.equal(result?.status, 'submitted', 'must submit a durable owner decision')
  assert.equal(trace.filter(event => event.toolError).length, 0, 'a tool failure cannot be erased by retry')
  assert.equal(actions.filter(action => action.tool === 'denied').length, 0, 'external tool attempts invalidate isolation behavior')
  assert.equal(actions.filter(action => action.tool === 'cancel').length, 0, 'must not cancel existing work')
  assert.equal(actions.filter(action => action.tool === 'human').length, 0, 'all business prerequisites are supplied or already running')
  assert.equal(actions.filter(action => action.tool === 'decision').length, 1, 'retain the first decision')
  const dispatches = [...new Map(actions.filter(action => action.tool === 'delegate' && !action.args.feedback)
    .map(action => [action.receipt.executionId + ':' + action.args.key, action])).values()]
  const fresh = dispatches.filter(action => !action.args.executionId)
  const continuations = dispatches.filter(action => action.args.executionId)
  const feedback = actions.filter(action => action.tool === 'delegate' && action.args.feedback)
  const originalIds = new Set((sample.executions ?? []).map(execution => execution.executionId))
  if (originalIds.size) {
    const firstDecision = actions.findIndex(action => action.tool === 'delegate' || action.tool === 'decision')
    assert.ok(actions.slice(0, firstDecision).some(action => action.tool === 'document-read' && originalIds.has(action.executionId)),
      'owner reads a current team document before deciding or delegating')
  }
  for (const continuation of continuations) {
    const prior = actions.slice(0, actions.indexOf(continuation)).findLast(action => action.tool === 'document-read'
      && action.executionId === continuation.args.executionId)
    assert.ok(prior, 'owner reads the existing member document before continuing that member')
    assert.equal(prior.inputVersion, continuation.priorInputVersion, 'continuation decision uses the current round document')
    const current = finalExecutions.find(execution => execution.executionId === continuation.args.executionId)
    const oldDocument = documents.find(document => document.executionId === current.executionId && document.inputVersion === prior.inputVersion)
    assert.ok(oldDocument && current.document.path !== oldDocument.path, 'continuation publishes a distinct round document')
    assert.ok(current.inputVersion > oldDocument.inputVersion)
  }
  assert.ok(feedback.every(action => originalIds.has(action.args.executionId)), 'feedback preserves an existing member')
  assert.ok(finalExecutions.length <= 10, 'task never creates an eleventh member')
  if (result.decision.action === 'complete' && finalExecutions.length) assert.ok(finalExecutions.length >= 3, 'delegated tasks reach three members before completion')
  assert.ok(finalExecutions.every(execution => execution.input.objective?.trim()), 'every member has an assigned objective')
  assert.equal(result.decision.action, sample.id === 'team-complete' ? 'complete' : 'wait')
  assert.ok(result.decision.summary.trim())
  // 生产完成合同允许空 evidence；简单结论是否充分须核对实际读取轨迹，不能以重复正文代替验收。
  if (result.decision.action === 'wait') {
    assert.ok(result.decision.evidence.length, 'wait retains its concrete basis')
    assert.ok(result.decision.limitations.length, 'wait states its remaining result')
  }
  if (sample.id === 'independent-ready') assert.ok(fresh.length >= 2 && continuations.length === 0, 'both ready goals dispatched before waiting')
  if (sample.id === 'simple-three') {
    assert.equal(finalExecutions.length, 3, 'simple closing task uses three small distinct duties')
    assert.equal(fresh.length, 1, 'two completed duties are preserved; only final verification is missing')
    assert.equal(continuations.length, 0, 'do not repeat completed editing or scope checking')
  }
  if (sample.id === 'dependency-pending') assert.equal(dispatches.length, 0, 'dependent work waits for original result')
  if (sample.id === 'dependency-ready') {
    assert.equal(fresh.length, 0, 'same objective retains its worker')
    assert.equal(continuations.length, 1)
    assert.equal(continuations[0].args.executionId, originalId)
    assert.notEqual(continuations[0].args.key, `${originalId}-initial`, 'new step uses a new request key')
  }
  if (sample.id === 'shared-writer') {
    assert.ok(fresh.length >= 1)
    // 谁负责写入、谁只读必须人工审阅；不能把所有成员都当写者，强迫只读职责加锁。
  }
  if (sample.id === 'complex-ten-reuse') {
    assert.equal(finalExecutions.length, 10)
    assert.equal(fresh.length, 0, 'reuse the bounded existing team')
    for (const id of ['team-1', 'team-2']) assert.ok(continuations.some(action => action.args.executionId === id), 'both ready modules reuse their existing owners')
  }
  if (sample.id === 'complex-self-claim') {
    assert.equal(fresh.length, 0, 'independent reviewers already belong to this team')
    assert.ok(continuations.some(action => ['security-review', 'migration-acceptance'].includes(action.args.executionId)), 'high-risk claim gets existing independent verification')
  }
  if (sample.id === 'team-complete') assert.equal(dispatches.length, 0, 'completed distinct duties need no replacement team')
  if (originalIds.size >= 3) assert.equal(finalExecutions.length, originalIds.size, 'do not recreate an established team each round')
}

if (process.argv[2] === '--check') {
  assert.equal(process.argv.length, 3)
  assert.equal(new Set(cases.map(sample => sample.id)).size, cases.length)
  assert.ok(cases.length >= 6 && cases.every(sample => sample.goal && sample.review))
  for (const sample of cases) for (const execution of sample.executions ?? []) {
    if (execution.status !== 'succeeded') continue
    assert.equal(execution.result.payload.output.status, 'completed')
    assert.equal(execution.result.payload.error, null)
    assert.ok(execution.result.payload.output.artifacts.every(path => typeof path === 'string'))
    assert.equal(execution.result.summary, undefined, 'output belongs to result.payload.output')
  }
  const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools')
  const { dynamicExecutionOutputSchema } = await import('../../../../packages/dingtalk-dsh-assistant/task-session-service.js')
  const { assertTaskExecutionTeamComplete } = await import('../../../../packages/dingtalk-dsh-assistant/task-session.js')
  const { renderExecutionDocument } = await import('../../../../packages/dingtalk-dsh-assistant/session-workspaces.js')
  for (const size of [0, 3, 10]) assert.doesNotThrow(() => assertTaskExecutionTeamComplete(Array(size).fill({})))
  for (const size of [1, 2]) assert.throws(() => assertTaskExecutionTeamComplete(Array(size).fill({})), { code: 'TASK_EXECUTION_TEAM_INCOMPLETE' })
  for (const sample of cases) for (const execution of sample.executions ?? []) if (execution.result)
    assert.deepEqual(validateJsonSchemaValue(dynamicExecutionOutputSchema, execution.result.payload.output), [])
  for (const inputVersion of [1, 2]) {
    const execution = { taskId: 'check-task', executionId: 'check-execution', sessionId: 'check-session', inputVersion,
      requirementRevision: 1, controlRevision: 1, status: 'queued', input: { objective: '核对当前轮文档' } }
    const document = renderExecutionDocument(execution)
    assert.equal(JSON.parse(/^<!-- execution-document (.+) -->\n/.exec(document)[1]).inputVersion, inputVersion)
    assert.ok(document.includes(execution.input.objective))
  }
  const closing = cases.find(sample => sample.id === 'team-complete')
  const decision = { action: 'complete', summary: '两份给定快照均为2.4.1。', evidence: [], limitations: [] }
  const closingAction = { tool: 'decision', decision }
  const closingResult = { status: 'submitted', decision }
  const readAction = { tool: 'document-read', executionId: closing.executions[0].executionId, inputVersion: 1 }
  assert.doesNotThrow(() => checkStructure(closing, closingResult, [readAction, closingAction], [], closing.executions, []))
  assert.throws(() => checkStructure(closing, closingResult, [closingAction], [], closing.executions, []), /reads a current team document/)
  const base = resolve(repo, 'docs/tmp/safety-check/.dsh/model-content')
  assert.ok(inside(base, join(base, 'synthetic.json')))
  for (const target of [base, dirname(base), join(base, '../outside.json'), resolve(repo, 'package.json')]) assert.equal(inside(base, target), false)
  console.log(JSON.stringify({ check: 'PASS', policy, cases: cases.map(sample => sample.id), modelCalls: 0, externalTools: 0, note: '场景与路径隔离自检；不代表模型行为通过。' }))
} else if (process.argv[2] === '--check-documents') {
  assert.equal(process.argv.length, 4, 'usage: node evaluate-model.mjs --check-documents <new-docs/tmp-directory>')
  const root = resolve(process.argv[3])
  assert.ok(inside(resolve(repo, 'docs/tmp'), root))
  await mkdir(dirname(root), { recursive: true })
  await mkdir(root)
  const { openDynamicTaskStore } = await import('../../../../packages/dingtalk-dsh-assistant/dynamic-task-store.js')
  const { materializeExecutionDocument } = await import('../../../../packages/dingtalk-dsh-assistant/session-workspaces.js')
  const store = await openDynamicTaskStore({ dbPath: join(root, 'synthetic.sqlite'), instanceId: 'document-check', initialize: true })
  try {
    let sequence = 0
    const command = (kind, args) => store.command({ id: `check-${++sequence}`, kind, args })
    const taskId = 'document-check-task', executionId = 'document-check-execution'
    const documents = await executionDocuments(root, taskId, id => store.query({ kind: 'execution.get', executionId: id }))
    await command('task.create', { taskId, title: '执行文档隔离自检', request: '先只读调查，后按结论修正。' })
    const binding = (await command('task.claim', { taskId })).result.binding
    await command('execution.dispatch', { binding, executionId, key: 'investigate', prompt: '调查单位', input: { objective: '调查金额单位，不修改。' } })
    const executionBinding = (await command('execution.claim', { executionId })).result.binding
    await command('execution.result', { binding: executionBinding, output: { status: 'completed', summary: '单位为分，尚未修正。',
      evidence: ['12345 分对应 123.45 元。'], artifacts: [], limitations: ['未实施修正。'] } })
    await command('execution.drained', { binding: executionBinding })
    const first = await documents.read(executionId)
    await command('execution.continue', { binding, executionId, key: 'implement', prompt: '按已查明的分实施修正', input: { objective: '将分转换为元并验证。' } })
    const second = await documents.read(executionId)
    assert.equal(first.inputVersion, 1)
    assert.equal(second.inputVersion, 2)
    assert.notEqual(first.document.path, second.document.path)
    assert.equal(digest(await readFile(first.document.path)), first.document.sha256)
    assert.equal(second.result, null, 'new round has no inherited completed result')
    assert.equal(documents.registered.size, 2)
    assert.equal(documents.registered.has(resolve(root, '../other-case/round-1.md')), false)
    assert.equal(documents.registered.has(resolve(repo, 'package.json')), false)
    await assert.rejects(() => materializeExecutionDocument(root, { ...first, input: { objective: '不能倒填旧轮' } }),
      { code: 'EXECUTION_DOCUMENT_ROUND_FROZEN' })
    await documents.verifyPreserved()
    const result = { check: 'PASS', modelCalls: 0, nativeExecutionSessions: 0, documents: [...documents.registered.values()],
      assertions: ['production-store-round-1-to-2', 'new-round-clears-result', 'old-round-bytes-preserved', 'old-round-rewrite-rejected', 'exact-current-case-read-list'] }
    await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify(result))
  } finally { await store.close() }
} else {
  const [output, connectPath, model, reasoningEffort, proxyUrl, ...selectedIds] = process.argv.slice(2)
  assert.ok(output && connectPath && model && reasoningEffort && proxyUrl, 'usage: node evaluate-model.mjs <new-output-directory> <connect-entry> <owner-model> <reasoning-effort> <proxy-url> [case-id ...]')
  assert.equal(new Set(selectedIds).size, selectedIds.length, 'duplicate scenario selection')
  assert.ok(selectedIds.every(id => cases.some(sample => sample.id === id)), 'unknown scenario selection')
  const selected = selectedIds.length ? cases.filter(sample => selectedIds.includes(sample.id)) : cases
  const root = resolve(output)
  assert.ok(inside(resolve(repo, 'docs/tmp'), root), 'raw model logs must stay inside this worktree docs/tmp')
  await mkdir(dirname(root), { recursive: true })
  await mkdir(root) // 必须是新目录，保留首错与此前轮次，不能覆盖重跑。
  const sources = [
    'packages/dingtalk-dsh-assistant/task-session.js',
    'packages/dingtalk-dsh-assistant/model-context.js',
    'packages/dingtalk-dsh-assistant/task-source-instructions.js',
    'packages/dingtalk-dsh-assistant/task-boundary-instructions.js',
    'packages/dingtalk-dsh-assistant/group-message.js',
    'packages/dingtalk-dsh-assistant/dynamic-task-store.js',
    'packages/dingtalk-dsh-assistant/dynamic-operation-readback.js',
    'packages/dingtalk-dsh-assistant/task-session-service.js',
    'packages/dingtalk-dsh-assistant/execution-context.js',
    'packages/dingtalk-dsh-assistant/session-workspaces.js',
    'test/fixtures/task-session-native-host.js',
    relative(repo, fileURLToPath(import.meta.url)),
  ]
  const sourceDigests = {}
  for (const name of sources) {
    const source = await readFile(resolve(repo, name))
    sourceDigests[name] = createHash('sha256').update(source).digest('hex')
    const copy = join(root, 'source-snapshot', name)
    await mkdir(dirname(copy), { recursive: true })
    await writeFile(copy, source)
  }
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), policy, model, reasoningEffort, connectPath: resolve(connectPath), sourceDigests, cases: selected, semanticReview: 'REQUIRED；结构断言通过不等于业务语义通过。' }, null, 2) + '\n')
  const { nativeTaskHost } = await import('../../../../test/fixtures/task-session-native-host.js')
  const { createTaskSessions, assertTaskExecutionTeamComplete } = await import('../../../../packages/dingtalk-dsh-assistant/task-session.js')
  const { inspectSession } = await import('../../../../packages/dingtalk-dsh-assistant/session-persistence.js')
  const { openDynamicTaskStore } = await import('../../../../packages/dingtalk-dsh-assistant/dynamic-task-store.js')
  const h = await nativeTaskHost(root, () => [], { resident: true })
  const sessions = createTaskSessions({ ctx: h.ctx, isCurrent: async () => true, getWorkspaceDir: async () => root })
  const results = []
  let active, activeStore
  const permitted = new Set(['task_execution_progress', 'task_execution_read', 'task_decisions_read', 'model_content_read', 'task_delegate', 'task_session_submit', 'task_request_human', 'task_execution_cancel'])
  h.ctx.on('tools/pre-execute', async (exec, next) => {
    if (permitted.has(exec.name)) return next()
    if (exec.name === 'read' && typeof exec.arguments?.file_path === 'string') {
      try {
        const target = await realpath(resolve(root, exec.arguments.file_path))
        if (active?.fixturePath && target === active.fixturePath) {
          active.actions.push({ tool: `fixture-${exec.name}`, args: exec.arguments })
          return next()
        }
        const document = active?.documents.registered.get(target)
        if (document) {
          assert.equal(digest(await readFile(target)), document.sha256, 'read observes the registered document bytes')
          active.actions.push({ tool: 'document-read', args: exec.arguments, ...document })
          return next()
        }
        const contentRoot = await realpath(join(root, '.dsh', 'model-content'))
        if (inside(contentRoot, target)) return next()
      } catch {}
    }
    active?.actions.push({ tool: 'denied', name: exec.name, args: exec.arguments })
    return { kind: 'deny', reason: 'isolated_evaluation_no_external_tools' }
  })
  h.ctx.on('llm/stream', (options, next) => (async function* () {
    const current = active
    assert.ok(current, 'model request must belong to a synthetic case')
    // GenerateOptions 只含模型输入；不采集 HTTP headers、连接配置、登录文件或凭据。
    const { signal: _signal, ...request } = options
    const call = ++current.modelCalls
    await appendFile(current.modelTrace, JSON.stringify({ kind: 'request', call, request }) + '\n')
    try {
      for await (const chunk of next()) {
        await appendFile(current.modelTrace, JSON.stringify({ kind: 'response', call, chunk }) + '\n')
        yield chunk
      }
    } catch (error) {
      await appendFile(current.modelTrace, JSON.stringify({ kind: 'stream-error', call, error: { name: error.name, code: error.code, message: error.message } }) + '\n')
      throw error
    }
  })())
  try {
    const connect = await import(pathToFileURL(resolve(connectPath)).href)
    await connect.apply(h.ctx, { enableProxy: true, proxyUrl, enableSearch: false, enableReserveFallback: false, enableNativeCompaction: false, enableImageTool: false, enableImageGeneration: false, enableAutoReview: false })
    for (const sample of selected) {
      const folder = join(root, sample.id)
      await mkdir(folder)
      let fixturePath, expectedFixture, goal = sample.goal
      if (sample.id === 'simple-three') {
        const fixture = join(folder, 'fixtures', 'intro.md')
        await mkdir(dirname(fixture))
        const content = '# Help\n\nRun install once.\nKeep this line.\n'
        await writeFile(fixture, content)
        fixturePath = await realpath(fixture)
        expectedFixture = content
        goal = goal.replace('/synthetic/help/intro.md', fixturePath)
      }
      const taskId = `evaluation-${sample.id}`, actions = [], nativeTrace = []
      // 使用生产账本构造身份、结果、资源投影与幂等；不挂接执行调度器或业务工具。
      activeStore = await openDynamicTaskStore({ dbPath: join(folder, 'synthetic.sqlite'), instanceId: 'isolated-evaluation', initialize: true })
      let commandSequence = 0
      const command = (kind, args) => activeStore.command({ id: `synthetic-command-${++commandSequence}`, kind, args })
      const readExecution = executionId => activeStore.query({ kind: 'execution.get', executionId })
      const documents = await executionDocuments(folder, taskId, readExecution)
      await command('task.create', { taskId, title: sample.title, request: goal })
      const binding = (await command('task.claim', { taskId })).result.binding
      for (const seed of sample.executions ?? []) {
        const input = structuredClone(seed.input)
        if (fixturePath) input.objective = input.objective.replace('/synthetic/help/intro.md', fixturePath)
        await command('execution.dispatch', { binding, executionId: seed.executionId, key: seed.key,
          prompt: input.objective, input })
        const executionBinding = (await command('execution.claim', { executionId: seed.executionId })).result.binding
        if (seed.executionId === originalId && sample.progress) {
          await command('execution.progressReported', {
            binding: executionBinding, sequence: 1, summary: sample.progress.join('\n'), evidence: [],
            plan: '读取原始样本和对账单，确认金额单位后交回结论及样本；单位未确认前不修改。', activity: '读取原始样本，单位尚未确认',
          })
          const execution = await readExecution(seed.executionId)
          await command('execution.progressReviewed', { executionId: execution.executionId, inputVersion: execution.inputVersion,
            leaseEpoch: execution.leaseEpoch, inputDigest: execution.inputDigest,
            observation: { lastSequence: 1, lastActivityAt: execution.stageProgress.recordedAt, newEventCount: 1, changed: true } })
        }
        if (seed.result) {
          const output = structuredClone(seed.result.payload.output)
          if (fixturePath) output.artifacts = output.artifacts.map(path => path.replace('/synthetic/help/intro.md', fixturePath))
          await command('execution.result', { binding: executionBinding, output })
          await command('execution.drained', { binding: executionBinding })
        }
      }
      const executions = await Promise.all((await activeStore.query({ kind: 'execution.list', taskId }))
        .map(execution => documents.read(execution.executionId)))
      const persistedWakes = await activeStore.query({ kind: 'wake.list', taskId })
      const wakes = executions.map(execution => {
        const kind = execution.status === 'running' ? 'execution.progress.review' : 'execution.result'
        const wake = persistedWakes.findLast(item => item.kind === kind && item.payload.executionId === execution.executionId)
        assert.ok(wake, 'synthetic wakes originate from the corresponding production store transition')
        return wake
      })
      const input = {
        task: { taskId, title: sample.title, objective: goal, status: 'active', control: 'active', requirementRevision: 1, controlRevision: 1 },
        sources: [{ sourceId: 'user-request', actorId: 'synthetic-user', text: goal }], executions,
        wakes,
        operations: [], blockers: {},
      }
      await writeFile(join(folder, 'input.json'), JSON.stringify(input, null, 2) + '\n')
      active = { actions, fixturePath, documents, modelCalls: 0, modelTrace: join(folder, 'model-trace.jsonl') }
      let result, firstError, saved, fixtureReadback, finalExecutions
      const timer = setTimeout(() => { void sessions.cancel(taskId) }, 120000)
      try {
        result = await sessions.run({ binding, provider: 'openai-codex', model, reasoningEffort, agentPreset: 'native-test', input,
          onSessionBound: async () => {},
          readExecution: async executionId => {
            actions.push({ tool: 'read-execution', executionId })
            const record = await documents.read(executionId)
            assert.ok(record, 'unknown synthetic execution')
            return structuredClone(record)
          },
          readProgress: async executionId => {
            actions.push({ tool: 'read-progress', executionId })
            const execution = await documents.read(executionId)
            return { available: true, executionId, sessionId: execution.sessionId, status: execution.status, drained: execution.drained,
              document: execution.document, ...(execution.progressReview ? { progressReview: execution.progressReview } : {}) }
          },
          readDecisions: async () => ({ taskId, decisions: [], nextBefore: null }),
          cancelExecution: async args => { actions.push({ tool: 'cancel', args }); return { received: true } },
          delegate: async args => {
            const action = { tool: 'delegate', args }; actions.push(action)
            if (args.executionId && !args.feedback) action.priorInputVersion = (await readExecution(args.executionId))?.inputVersion
            if (args.feedback) {
              const receipt = await command('execution.feedback', { binding, executionId: args.executionId, messageId: args.key,
                text: JSON.stringify({ objective: args.objective, context: args.context ?? '' }) })
              const original = await documents.read(args.executionId)
              return action.receipt = { executionId: args.executionId, sessionId: original.sessionId, received: true,
                consumed: !!receipt.result.feedback.consumedAt, feedback: receipt.result.feedback }
            }
            const payload = { binding, key: args.key, prompt: args.objective,
              input: { objective: args.objective, context: args.context ?? '', skillNames: args.skillNames ?? [], title: args.title ?? '' },
              ...(args.resourceKeys === undefined ? {} : { resourceKeys: args.resourceKeys }) }
            const accepted = await command(args.executionId ? 'execution.continue' : 'execution.dispatch',
              { ...payload, ...(args.executionId ? { executionId: args.executionId } : {}) })
            const execution = await documents.read(accepted.result.execution.executionId)
            return action.receipt = { executionId: execution.executionId, sessionId: execution.sessionId, status: execution.status, resources: execution.resources }
          },
          submit: async decision => {
            if (decision.action === 'blocked') actions.push({ tool: 'human', decision })
            const action = { tool: 'decision', decision, accepted: false }; actions.push(action)
            if (decision.action === 'complete') assertTaskExecutionTeamComplete(await activeStore.query({ kind: 'execution.list', taskId }))
            action.accepted = true
            return { accepted: true }
          },
        })
      } catch (error) { firstError = { message: error.message, code: error.code, providerErrorCode: error.providerError?.code } }
      finally {
        clearTimeout(timer)
        try {
          saved = await inspectSession(h.ctx.sessionPersistence, binding.sessionId)
          await writeFile(join(folder, 'native-session.json'), JSON.stringify(saved, null, 2) + '\n')
          for (const event of saved.events) {
            if (event.type === 'tool/call') nativeTrace.push({ sequence: event.seq, tool: event.data.name,
              args: typeof event.data.arguments === 'string' ? JSON.parse(event.data.arguments) : event.data.arguments })
            else if (event.type === 'tool/result' && event.data.message?.isError) nativeTrace.push({ sequence: event.seq, toolError: event.data.error?.code ?? 'TOOL_ERROR' })
          }
        } catch (error) { firstError ??= { message: error.message, phase: 'read-native-session' } }
      }
      try {
        finalExecutions = await Promise.all((await activeStore.query({ kind: 'execution.list', taskId }))
          .map(execution => documents.read(execution.executionId)))
        await documents.verifyPreserved()
      }
      catch (error) { firstError ??= { message: error.message, phase: 'read-final-team' } }
      if (!firstError) {
        try {
          checkStructure(sample, result, actions, nativeTrace, finalExecutions, [...documents.registered.values()])
          if (fixturePath) {
            fixtureReadback = await readFile(fixturePath, 'utf8')
            assert.equal(fixtureReadback, expectedFixture, 'the frozen reviewed artifact is not rewritten during closing verification')
          }
          const savedCall = saved.events.findLast(event => event.type === 'tool/call' && event.data.name === 'task_session_submit')
          assert.ok(savedCall, 'owner submission must independently persist')
          const args = typeof savedCall.data.arguments === 'string' ? JSON.parse(savedCall.data.arguments) : savedCall.data.arguments
          assert.deepEqual(args.decision, result.decision)
        } catch (error) { firstError = { message: error.message, phase: 'structural-check' } }
      }
      const record = { id: sample.id, structuralPass: !firstError, semanticReview: 'PENDING', review: sample.review, modelCalls: active.modelCalls,
        firstError, actions, nativeTrace, fixtureReadback, documents: [...documents.registered.values()], finalExecutions, result }
      await writeFile(join(folder, 'result.json'), JSON.stringify(record, null, 2) + '\n')
      results.push(record)
      await writeFile(join(root, 'results.json'), JSON.stringify({ policy, model, reasoningEffort, sourceDigests, cases: results }, null, 2) + '\n')
      console.log(JSON.stringify({ case: sample.id, structuralPass: !firstError, semanticReview: 'PENDING', firstError }))
      active = undefined
      await activeStore.close(); activeStore = undefined
      if (firstError?.message === 'TASK_SESSION_PROVIDER_TRANSIENT') break
    }
  } finally { try { await sessions.close() } finally { try { await activeStore?.close() } finally { await h.close() } } }
  assert.ok(results.length === selected.length && results.every(result => result.structuralPass), 'structural checks failed; inspect first errors and full traces')
  console.log('结构断言已通过；仍须逐例人工审阅实际目标、边界、证据与决定，不能据此填写语义 PASS。')
}
