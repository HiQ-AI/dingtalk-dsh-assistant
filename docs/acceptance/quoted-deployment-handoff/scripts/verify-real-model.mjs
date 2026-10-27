import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import yaml from 'js-yaml'
import { openIndependentCoordination } from '../../../../packages/dingtalk-dsh-assistant/independent-coordination-service.js'
import { createIndependentCoordinationPlanner } from '../../../../packages/dingtalk-dsh-assistant/independent-coordination-planner.js'

// 独立验收脚本：现有语言回放只有提醒用例；此处使用生产引用上下文和原生工具规划器。
// 只挂指定既有模型与只读凭据服务，不连接现场 TaskStore、不加载钉钉适配器，submit 只捕获。
const root = path.resolve(process.argv[2] ?? 'docs/tmp/quoted-deployment-handoff/model')
const profilePath = 'D:/dsh_home/profiles/web/package.json'
process.env.DSH_NATIVE_TEST_PROFILE = profilePath
const installed = createRequire(pathToFileURL(profilePath))
const load = name => import(pathToFileURL(installed.resolve(name)))
const clone = value => structuredClone(value)
const result = { passed: false, provider: 'cortex-gateway', model: 'cortex-cowork', reasoningEffort: 'high',
  realChannelSends: 0, realTaskWrites: 0, standardStreams: 0, providerNetworkCalls: null, cost: null, scenarios: [], sourceSha256: {} }
let host, planner, independent
try {
  await mkdir(root, { recursive: true })
  for (const file of ['independent-coordination-planner.js', 'independent-coordination-service.js', 'tool-schema.js'])
    result.sourceSha256[file] = createHash('sha256').update(await readFile(new URL(`../../../../packages/dingtalk-dsh-assistant/${file}`, import.meta.url))).digest('hex')
  // !!js 只保留表达式为数据，不执行配置代码；绝不把原配置/凭据放入诊断。
  const schema = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => ({ expression: value }) })])
  const profile = yaml.load(await readFile('D:/dsh_home/profiles/web/cordis.patch.yml', 'utf8'), { schema })
  const route = profile.find(row => row.id === 'llm-pi-ai')?.config?.providers?.[result.provider]
  assert.ok(route?.apiKeyEnv && route.models?.some(model => model.id === result.model), 'configured model route required')
  const credentials = await load('@deepseek-ai/dsh-credentials-local')
  const credentialBytes = await readFile('D:/dsh_home/.credentials.yaml')
  const credentialText = credentialBytes.toString('utf8')
  const credentialDigest = createHash('sha256').update(credentialBytes).digest('hex')
  assert.equal(credentials.renderFlatLayoutMigration(credentialText), undefined, 'read-only verification must not migrate credentials')
  assert.ok(credentials.parseCredentialsDocument(credentialText, 'configured-store').refs.has(route.apiKeyEnv), 'configured reference unavailable')
  result.credentialMetadata = { reference: route.apiKeyEnv, configured: true, migrationRequired: false }
  const { nativeTaskHost, available, reason } = await import('../../../../test/fixtures/task-session-native-host.js')
  assert.ok(available, reason)
  host = await nativeTaskHost(path.join(root, 'runtime'), () => { throw new Error('SCRIPTED_MODEL_MUST_NOT_EXECUTE') })
  // 官方 provider 的初始化只读加载现代凭据格式；未调用 set/unset/login/refresh API。
  await host.ctx.plugin(credentials.default, { dshHome: 'D:/dsh_home', watch: false })
  await host.ctx.plugin(await load('@deepseek-ai/dsh-llm-pi-ai'), { providers: { [result.provider]: route } })
  await host.ctx.loader.await()
  const selection = { provider: result.provider, model: result.model, reasoningEffort: result.reasoningEffort }
  await host.ctx.llm.resolveCallConfig(selection)
  host.ctx.on('llm/stream', (request, next) => {
    assert.equal(request.provider, result.provider); assert.equal(request.model, result.model)
    result.standardStreams++
    const submit = request.tools.find(tool => tool.name === 'coordination_submit')
    if (!result.submitToolSchema && submit) result.submitToolSchema = { rootKeys: Object.keys(submit.parameters),
      rootProperties: Object.keys(submit.parameters.properties ?? {}), rootRequired: submit.parameters.required ?? [],
      branchCount: submit.parameters.oneOf?.length ?? 0 }
    return next()
  })
  for (const reconsidered of [false, true]) {
    const scenario = { name: reconsidered ? 'reconsider-active-already-undertaken' : 'completed-original-reopen',
      sourcePreserved: true, submitted: null, contextReads: [], errors: [], usage: [] }
    result.scenarios.push(scenario)
    const groupId = 'synthetic-deploy-group', actorId = 'synthetic-requester', unitId = 'synthetic-unit'
    const quote = { messageId: 'synthetic-delivery', senderName: '合成交付人', content:
      '已完成实施并更新原PR：后端 #417 https://github.com/HiQ-AI/dataset/pull/417、前端 #389 https://github.com/HiQ-AI/dataset-web/pull/389。\n终审详情页确认编辑后立即持久变为“待提交”，无需保存；计算、刷新、重新进入仍可编辑。取消不改状态，重开后新旧导入及相关保护已做必要定向验证。代码复核和远端交付核对已完成，未再扩大验收范围。\n尚未合并或部署。新UPR的UAT专有适配已随材料交付，后续集成时需应用。验证使用隔离环境，未覆盖真实SSO、异步队列及外部计算引擎。' }
    const owner = { reservationId: `synthetic-reservation-${reconsidered ? 'repair' : 'initial'}`, generation: 1,
      groupId, unitId, unitRevision: 1, dispatchOwner: 'coordination', semanticState: 'reserved', settled: false,
      sourceSnapshot: { messageId: 'synthetic-deploy-message', messageVersion: 1, actorId, senderName: '合成请求人',
        text: '部署到UAT2', unitText: '部署到UAT2', sourceRefs: [{ start: 0, end: 7, quote: '部署到UAT2' }],
        occurredAt: '2026-10-27T04:15:53.180Z' } }
    const source = { sourceId: 'synthetic-source', groupId, messageId: owner.sourceSnapshot.messageId,
      version: 1, actorId, text: owner.sourceSnapshot.text, quote, resources: [], channel: 'im' }
    const target = { taskId: 'synthetic-original-task', groupId, title: '排查终审数据点击编辑后状态未持久保留',
      objective: '在原终审详情页编辑确认基础上修复状态持久化：确认编辑后立即变为待提交，计算、刷新和重新进入仍可编辑；取消不改状态。完成新旧导入及保护路径必要验证并交付后端#417、前端#389，不自行合并或部署。',
      request: '终审数据点击编辑确认后，待提交状态应立即持久化；沿原开发线实施、验证并交付PR。',
      requirements: ['确认编辑后立即持久为待提交', '计算、刷新、重新进入仍可编辑，取消不改状态', '交付dataset#417及dataset-web#389；当前尚未部署'],
      requirementRevision: 3, contextRevision: 3, controlRevision: 1, runSequence: 3, status: 'completed', control: 'active', drained: true,
      completion: { summary: '后端#417和前端#389已交付，未合并或部署。' } }
    if (reconsidered) Object.assign(target, { status: 'active', drained: false, requirementRevision: 4, runSequence: 4,
      objective: '将已交付的终审详情页重新编辑二次确认及状态持久化改动，沿原开发线集成部署到UAT2，核验实际运行结果并报告证据及限制；复用已完成实施和有效验证，不扩大验收范围或发布生产。',
      request: '原终审详情编辑确认和状态持久化已交付后端#417、前端#389；现已承接沿原开发线集成部署UAT2，复用既有验证，不发布生产。',
      requirements: ['原PR417/389已由本任务承接集成部署UAT2', '核验实际运行结果并报告证据及限制，复用有效验证，不重复实施、不发布生产'],
      completion: null })
    const tasks = [...Array.from({ length: 26 }, (_, index) => ({ taskId: `synthetic-other-${index + 1}`, groupId,
      title: index === 21 ? '修复终审只读UPR导入覆盖并部署UAT2' : `其他独立业务事项${index + 1}`,
      objective: index === 21 ? '修复终审只读UPR导入覆盖问题，既有修复已部署UAT2；不含终审详情编辑后待提交状态问题。' : `完成其他独立业务事项${index + 1}，与终审详情编辑状态持久化无关。`,
      status: 'completed', control: 'active', drained: true, requirementRevision: 1, controlRevision: 1, runSequence: 1 })), target]
    const arrangement = { id: 'synthetic-original-arrangement', revision: 1, sourceId: 'synthetic-coordination-source', groupId,
      state: 'needs_clarification', memberIds: [], question: '要将哪项改动部署到UAT2？请提供具体事项名称或PR编号。' }
    const ledger = { id: arrangement.sourceId, state: 'reserved', ...(reconsidered ? { contextReconsideration: {
      coordinationId: arrangement.id, expectedRevision: 1, question: arrangement.question, reason: '旧预约遗漏原消息引用，按同一原来源重新核对' } } : {}) }
    const residentStore = {
      getSourceDispatchOwnership: () => clone(owner), listSourceDispatchOwnership: () => [clone(owner)],
      getGroup: () => ({ groupId, messages: [{ ...owner.sourceSnapshot, senderOpenDingTalkId: actorId, senderName: '合成请求人' }] }) }
    const query = async (kind, args) => {
      if (kind === 'source.list') return [clone(source)]
      if (kind === 'coordination.source') return clone(ledger)
      if (kind === 'coordination.runtime') return { mode: 'active' }
      if (kind === 'task.list') return clone(tasks)
      if (kind === 'task.get') return clone(tasks.find(task => task.taskId === args.taskId))
      if (kind === 'coordination.list') return reconsidered ? [clone(arrangement)] : []
      if (kind === 'coordination.get') return { coordination: clone(arrangement), members: [] }
      if (['notification.list', 'coordination.schedule.list', 'coordination.occurrence.list'].includes(kind)) return []
      throw new Error(`UNEXPECTED_READ:${kind}`)
    }
    independent = openIndependentCoordination({ config: {}, residentStore, query,
      command: async () => { throw new Error('BUSINESS_COMMAND_FORBIDDEN') }, planner: { close: async () => {} } })
    const request = { ...owner, attempt: 0 }, initial = await independent.context(request)
    assert.equal(initial.source.quotedMessage.content, quote.content)
    assert.equal(initial.tasks.length, 20); assert.equal(initial.hasMore, true)
    await writeFile(path.join(root, `${scenario.name}-input.json`), JSON.stringify(initial, null, 2))
    const stop = host.ctx.on('session/event', (_session, event) => {
      if (event.type === 'assistant/message' && event.data?.usage) scenario.usage.push(event.data.usage)
      if (event.type === 'agent/error') scenario.errors.push({ type: event.type, code: event.data?.code ?? null })
    })
    planner = createIndependentCoordinationPlanner({ ctx: host.ctx, root: path.join(root, 'runtime'),
      getWorkspaceDir: () => path.join(root, 'runtime'), getModelSelection: () => selection, agentPreset: 'native-test',
      context: async (input, args = {}) => { scenario.contextReads.push(clone(args)); return independent.context(input, args) },
      submit: async (_input, proposal) => { scenario.submitted = clone(proposal); return { status: 'captured-only', businessEffects: 0 } } })
    const started = Date.now()
    const timer = setTimeout(() => { void planner?.close() }, 120000)
    try {
      await planner.plan(request)
      const proposal = scenario.submitted
      assert.equal(proposal.kind, 'arrangement', 'must not ask user to repeat supplied PRs')
      assert.equal(proposal.members.length, 1)
      assert.equal(proposal.members[0].taskId, target.taskId)
      assert.equal(proposal.members[0].action, reconsidered ? 'task-observe' : 'task-reopen')
      if (reconsidered) {
        for (const key of ['context', 'objective', 'requirements', 'progressImpact']) assert.equal(proposal.members[0][key], undefined)
      } else {
        assert.equal(proposal.members[0].progressImpact, 'replan')
        assert.match(JSON.stringify(proposal), /UAT2/)
      }
      assert.ok(scenario.contextReads.some(args => args.taskIds?.includes(target.taskId)), 'must read original full task before proposing reopen')
      scenario.passed = true
    } catch (error) {
      scenario.passed = false; scenario.failure = { name: error.name, code: error.code ?? null, assertion: error.code === 'ERR_ASSERTION' ? error.message : null }
    } finally {
      clearTimeout(timer); scenario.elapsedMs = Date.now() - started; stop(); await planner.close(); planner = undefined
      await independent.close(); independent = undefined
    }
    await writeFile(path.join(root, `${scenario.name}-result.json`), JSON.stringify(scenario, null, 2))
  }
  result.credentialStoreUnchanged = createHash('sha256').update(await readFile('D:/dsh_home/.credentials.yaml')).digest('hex') === credentialDigest
  result.passed = result.scenarios.length === 2 && result.scenarios.every(item => item.passed) && result.credentialStoreUnchanged
} catch (error) {
  result.failure = { name: error.name, code: error.code ?? null }
} finally {
  await planner?.close(); await independent?.close(); await host?.close()
  result.boundary = 'Production planner/context + real installed cortex-gateway/cortex-cowork high; synthetic 27-task catalog and captured-only submit. No production TaskStore/channel, no credential writes. Costs and provider retries unknown.'
  await writeFile(path.join(root, 'model-result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ passed: result.passed, provider: result.provider, model: result.model, standardStreams: result.standardStreams,
    scenarios: result.scenarios.map(item => ({ name: item.name, passed: item.passed, elapsedMs: item.elapsedMs, failure: item.failure })), failure: result.failure }))
  if (!result.passed) process.exitCode = 1
}
