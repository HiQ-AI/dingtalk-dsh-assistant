import { inspectSession } from '../packages/dingtalk-dsh-assistant/session-persistence.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rename, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { LlmRuntime, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import { openWorkflowService } from '../packages/dingtalk-dsh-assistant/workflow-service.js'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { createWorkflowConfiguration } from '../packages/dingtalk-dsh-assistant/workflow-configuration.js'
import { readExecutedAgentQueryRefs } from '../packages/dingtalk-dsh-assistant/agent-query-tools.js'

const { SessionProjectionRegistry } = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))('@deepseek-ai/dsh-session-projection')
const identity = { channel: 'web', actorId: 'owner' }
const sleep = () => new Promise(resolve => setTimeout(resolve, 20))

test('工程v26正式服务通过原生节点工具消费冻结配置，移动来源并重建Host后仍可查询', { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-managed-query-native-')), source = join(root, 'source'), remote = join(root, 'remote.git')
  await mkdir(source)
  const exec = promisify(execFile), git = async (...args) => (await exec('git', ['-C', source, ...args], { windowsHide: true })).stdout.trim()
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid')
  await writeFile(join(source, 'value.txt'), 'fixture'); await git('add', '.'); await git('commit', '-m', 'fixture')
  await git('init', '--bare', remote); await git('push', remote, 'HEAD:refs/heads/main', 'HEAD:refs/heads/feature/uat2-base')
  const command = { executable: process.execPath, args: ['-e', 'process.exit(0)'] }
  const database = { id: 'managed-db', connectionId: 'registered', environment: 'production', tables: [{ schema: 'public', table: 'approved', columns: ['id'] }] }
  const config = { groupIds: ['g'], ownerActorId: 'owner', webActorId: 'owner', instanceId: 'managed-query',
    dbPath: join(root, 'execution.sqlite'), artifactDirectory: join(root, 'artifacts'),
    repositories: [{ id: 'repo', sourceRepository: source, managedRoot: join(root, 'managed'), remote, baseRef: 'main', githubRepository: 'example/repo', editablePaths: ['value.txt'],
      checks: [{ id: 'build', version: '1', ...command }], localAcceptance: { version: 'fixture', sharedDataProfilePath: join(root, 'unused-profile.json'), prepareSteps: [],
        service: { ...command, args: [...command.args, '127.0.0.1', '{port}'], readyPath: '/' }, scenarios: [{ id: 'fixture', description: '隔离验收声明', ...command }], cleanup: command, verifyCleanup: command } }],
    directQueries: { resources: [], statusResources: [], databases: [database, { ...database, id: 'legacy-db', connectionId: 'legacy' }],
      credentialsPath: join(root, 'original.json'), configurationConnections: { registered: { configAlias: 'dbConfig', passwordAlias: 'dbPassword' } },
      permissions: { resourceIds: [], statusIds: [], databaseIds: ['managed-db', 'legacy-db'] } } }
  const initialStore = await openExecutionStore({ dbPath: config.dbPath, instanceId: config.instanceId, initialize: true }); await initialStore.close()
  await mkdir(config.artifactDirectory)
  const connections = [], requests = [], ownerRejections = [], snapshots = []
  let ctx, service, configuration, turns = 0, capturedTools, capturedQuery
  class Client {
    constructor(options) { connections.push({ database: options.database, password: options.password }); this.sql = [] }
    async connect() {}
    async query(query) {
      const sql = typeof query === 'string' ? query : query.text; this.sql.push(sql)
      if (sql.includes('pg_is_in_recovery')) return { rows: [{ in_recovery: true }] }
      if (sql === 'SHOW transaction_read_only') return { rows: [{ transaction_read_only: 'on' }] }
      if (sql.startsWith('SELECT "id"')) return { rows: [{ id: 7 }] }
      return { rows: [] }
    }
    async end() {}
  }
  const taskOwnerSessions = { async close() {}, async run({ input, binding, tools, queryInput, onQueryEvidence, onSessionBound, onCandidate }) {
    await onSessionBound(); capturedTools = tools; capturedQuery = queryInput
    if (!input.stages.length) {
      if (config.directQueries.configurationConnections?.registered && config.directQueries.permissions.databaseIds.includes('managed-db'))
      await assert.rejects(tools.find(tool => tool.name === 'query_readonly_database').execute({ binding, input: queryInput,
        args: { resourceId: 'managed-db', operation: 'select', table: 'public.approved', columns: ['id'] } }), error => {
        ownerRejections.push(error.code); return error.code === 'QUERY_CONFIGURATION_TASK_NODE_REQUIRED'
      })
      const queried = await tools.find(tool => tool.name === 'read-topic-sources').execute({ binding, input: queryInput, args: { sourceKeys: queryInput.scope.sourceKeys } })
      const keys = ['kind','taskId','sessionId','turnId','leaseEpoch','ownerEpoch','requirementRevision','inputDigest']
      await onQueryEvidence({ binding: Object.fromEntries(keys.map(key => [key, binding[key]])), evidenceRef: queried.evidenceRef })
      const decision = { action: 'advance', summary: '按授权工程阶段执行', evidenceRefs: [queried.evidenceRef],
        planChange: { kind: 'initialize', stages: [{ workflowId: 'task-engineering', gate: 'none' }] } }
      await onCandidate(decision); return { status: 'submitted', decision }
    }
    const decision = { action: input.stages.some(stage => stage.status === 'ready') ? 'advance' : 'wait', summary: '隔离测试只验证原生查询入口', evidenceRefs: [],
      condition: { kind: 'execution', missing: '测试结束于查询后的原生节点', responsibleParty: '隔离测试', resumeWhen: '由测试继续', evidenceRefs: [] } }
    await onCandidate(decision); return { status: 'submitted', decision }
  } }
  const coordinatorSessions = { async close() {}, async run({ input, onSessionBound, onCandidate }) {
    await onSessionBound()
    await onCandidate({ decisions: input.sources.map(item => ({ runId: item.runId, reason: '隔离工程任务', units: [{ spans: [{ start: 0, end: item.body.length }], goalText: item.body,
      binding: { disposition: 'new', candidateId: null }, intent: { kind: 'intent', actions: [{ intent: 'create', arguments: { objective: item.body, repositoryId: 'repo', uatEnvironment: 'uat2', acceptanceCriteria: ['读取登记数据库事实'] }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' } }] })) })
    return { status: 'submitted' }
  } }
  async function open() {
    turns = 0; ctx = new Context()
    new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
    new SessionTitleService(ctx, { fallbackMaxWords: 10, fallbackMaxBytes: 120, maxTitleBytes: 200 })
    new SystemPrompt(ctx, { includeRuntimeContext: false, includeHarnessIdentity: false }); new LlmRuntime(ctx); new ToolRuntime(ctx)
    new JsonlSessionPersistence(ctx, { root: join(root, 'sessions'), packChunks: false, compression: 'none', writeBatchMaxDelayMs: 1 })
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
    await ctx.plugin(LocalCredentialProvider, { path: join(root, 'credentials.yaml'), watch: false })
    configuration = createWorkflowConfiguration({ instanceId: config.instanceId, credentials: ctx.credentials, workflowIds: ['task-engineering'], webActorId: identity.actorId })
    class Scripted extends LlmAdapter {
      async *stream(options) {
        requests.push(JSON.parse(JSON.stringify(options))); turns++
        if (turns % 2) {
          const args = JSON.stringify({ resourceId: 'managed-db', operation: 'select', table: 'public.approved', columns: ['id'] }), id = `call-${turns}`
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id, name: 'query_readonly_database', argumentsDelta: args }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'query_readonly_database', arguments: args } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        } else {
          yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: '隔离数据库事实已读，测试不进入开发。' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: '隔离数据库事实已读，测试不进入开发。' } }; yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
    }
    ctx.llm.registerAdapter(['configuration-fixture'], new Scripted())
    service = await openWorkflowService({ ctx, config, configuration: { ...configuration, snapshot: async args => { snapshots.push(args); return configuration.snapshot(args) } }, databaseClient: Client, coordinatorSessions, taskOwnerSessions,
      legacy: { getAgentConfig: () => ({ provider: 'configuration-fixture', model: 'scripted', workspaceDir: root }), getGroup: () => ({ groupId: 'g', messages: [] }) } })
  }
  async function close() { await service?.close(); await ctx?.fiber.dispose() }
  t.after(close); await open()
  async function save(name, kind, value, format = 'text') {
    const state = await configuration.state(identity)
    await configuration.saveVariable({ name, kind, format, value, description: '隔离测试', expectedRevision: state.revision }, identity)
  }
  const original = config.directQueries.credentialsPath
  await writeFile(original, JSON.stringify({ config: { host: '127.0.0.1', port: 5432, db: 'frozen_database', user: 'readonly' }, password: 'native-fixture-secret-old' }))
  const imported = JSON.parse(await readFile(original, 'utf8'))
  await save('dbConfig', 'plain', JSON.stringify(imported.config), 'json'); await save('dbPassword', 'secret', imported.password)
  await configuration.bindWorkflow({ workflowId: 'task-engineering', variables: [{ alias: 'dbConfig', name: 'dbConfig' }, { alias: 'dbPassword', name: 'dbPassword' }], expectedRevision: (await configuration.state(identity)).revision }, identity)
  async function start(messageId) {
    const accepted = await service.ingest({ groupId: 'g', messageId, senderOpenDingTalkId: 'owner', text: `${messageId} 调查登记事实后开发，提交到uat2` })
    await service.messages.process(accepted.runId)
    const deadline = Date.now() + 35000
    for (;;) {
      const state = await service.state(accepted.runId), taskId = state.commands.find(item => item.result?.taskId)?.result.taskId
      if (taskId) {
        const plan = await service.execution.controller.taskPlan(taskId), runId = plan.stages[0]?.runId
        if (runId) { await service.execution.controller.whenIdle(runId); return { taskId, runId, state: await service.execution.controller.state(runId) } }
      }
      assert.ok(Date.now() < deadline, '未建立工程执行Run'); await service.recoverExecutionTasks(); await sleep()
    }
  }
  const old = await start('old')
  assert.equal(connections.length, 1, JSON.stringify({ old: old.state, requests: requests.length }))
  const record = (await service.execution.store.query({ kind: 'workflow.list' })).find(item => item.config?.runId === old.runId)
  assert.equal(record.definitionVersion, '26'); assert.deepEqual(record.config.databaseQuery.scope.databaseIds, ['managed-db'])
  const definition = service.execution.controller.workflowDefinition(record.workflowId, record.digest)
  assert.ok(definition.nodes.find(node => node.id === 'inspect-and-propose').allowedTools.includes('query_readonly_database'))
  assert.deepEqual(definition.nodes.find(node => node.id === 'apply-changes').allowedTools, ['engineering_repo_inspect', 'engineering_apply_edits'])
  assert.ok(requests.some(request => JSON.stringify(request.tools).includes('query_readonly_database')))
  const originalNode = old.state.nodes.find(node => node.nodeId === 'inspect-and-propose')
  const evidenceRefs = readExecutedAgentQueryRefs((await inspectSession(ctx.sessionPersistence, originalNode.sessionId)).events, ['query_readonly_database'])
  assert.equal(evidenceRefs.length, 1)
  assert.deepEqual((await service.execution.artifacts.read(evidenceRefs[0])).result.rows, [{ id: 7 }])
  await save('dbConfig', 'plain', JSON.stringify({ ...imported.config, db: 'current_database' }), 'json'); await save('dbPassword', 'secret', 'native-fixture-secret-new')
  await rename(original, `${original}.moved`)
  await close(); await open(); await assert.rejects(readFile(original), { code: 'ENOENT' })
  assert.deepEqual(await configuration.forRun({ runId: old.runId, workflowId: record.workflowId }).read('dbConfig'), imported.config)
  const fresh = await start('fresh')
  assert.equal(connections.length, 3)
  assert.deepEqual(connections, [{ database: 'frozen_database', password: 'native-fixture-secret-old' },
    { database: 'frozen_database', password: 'native-fixture-secret-old' }, { database: 'current_database', password: 'native-fixture-secret-new' }])
  assert.ok(ownerRejections.length >= 2)
  const node = fresh.state.nodes.find(item => item.nodeId === 'inspect-and-propose')
  await assert.rejects(capturedTools.find(tool => tool.name === 'query_readonly_database').execute({ binding: { ...node, kind: 'task-node', taskId: fresh.taskId, runId: fresh.runId }, input: capturedQuery,
    args: { resourceId: 'managed-db', operation: 'tables' } }), { code: 'QUERY_BINDING_STALE' })
  for (const run of [old, fresh]) await service.execution.controller.pause({ commandId: `pause-${run.runId}`, runId: run.runId, reason: '完成本轮隔离查询证据' })
  const beforeReset = await service.execution.controller.taskPlan(fresh.taskId)
  await service.execution.controller.controlTask({ commandId: 'pause-reset-task', taskId: fresh.taskId, intent: 'pause', expectedControlRevision: beforeReset.task.controlRevision })
  await service.changeMaintenance({ requestId: 'reset-maintenance-enter', active: true, expectedRevision: 0, maintenanceId: 'configuration-reset', reason: '隔离重置验收' }, identity)
  const resetRequest = { taskId: fresh.taskId, requestId: 'configuration-reset', prepareNewRun: true, reason: '保持工程合同重新执行',
    expectedControlRevision: (await service.execution.controller.taskPlan(fresh.taskId)).task.controlRevision }
  const snapshotCount = snapshots.length
  await service.resetExecution({ ...resetRequest, checkOnly: true }, identity)
  assert.equal(snapshots.length, snapshotCount)
  await save('dbConfig', 'plain', JSON.stringify({ ...imported.config, db: 'reset_database' }), 'json'); await save('dbPassword', 'secret', 'native-fixture-secret-reset')
  const reset = await service.resetExecution(resetRequest, identity)
  assert.equal(snapshots.length, snapshotCount + 1)
  const resetState = await service.execution.controller.state(reset.newRunId)
  assert.equal(resetState.run.pauseRequested, true)
  const resetReader = configuration.forRun({ runId: reset.newRunId, workflowId: resetState.run.workflowId })
  assert.equal((await resetReader.read('dbConfig')).db, 'reset_database')
  assert.equal(await resetReader.readSecret('dbPassword'), 'native-fixture-secret-reset')
  assert.equal((await configuration.forRun({ runId: fresh.runId, workflowId: fresh.state.run.workflowId }).read('dbConfig')).db, 'current_database')
  await save('dbConfig', 'plain', JSON.stringify({ ...imported.config, db: 'post_reset_database' }), 'json'); await save('dbPassword', 'secret', 'native-fixture-secret-after-reset')
  assert.deepEqual(await service.resetExecution(resetRequest, identity), reset)
  assert.equal(snapshots.length, snapshotCount + 1)
  assert.equal((await resetReader.read('dbConfig')).db, 'reset_database')
  await assert.rejects(service.resetExecution({ ...resetRequest, reason: '冲突重投' }, identity), { code: 'COMMAND_ID_CONFLICT' })
  await service.changeMaintenance({ requestId: 'reset-maintenance-exit', active: false, expectedRevision: 1, maintenanceId: 'configuration-reset', reason: '仅继续隔离任务' }, identity)
  await service.execution.controller.controlTask({ commandId: 'resume-reset-task', taskId: fresh.taskId, intent: 'resume', expectedControlRevision: reset.controlRevision })
  await service.execution.controller.whenIdle(reset.newRunId)
  assert.equal(connections.length, 4)
  assert.deepEqual(connections.at(-1), { database: 'reset_database', password: 'native-fixture-secret-reset' })
  const resetQueried = await service.execution.controller.state(reset.newRunId), resetNode = resetQueried.nodes.find(item => item.nodeId === 'inspect-and-propose')
  assert.equal(readExecutedAgentQueryRefs((await inspectSession(ctx.sessionPersistence, resetNode.sessionId)).events, ['query_readonly_database']).length, 1)
  await service.execution.controller.pause({ commandId: 'pause-reset-run', runId: reset.newRunId, reason: '重置Run冻结与原生消费验收完成' })
  for (const variant of ['legacy-only', 'no-permission']) {
    await close()
    config.directQueries.configurationConnections = variant === 'legacy-only' ? {} : { registered: { configAlias: 'dbConfig', passwordAlias: 'dbPassword' } }
    config.directQueries.permissions.databaseIds = variant === 'legacy-only' ? ['managed-db', 'legacy-db'] : []
    await open()
    const count = connections.length, firstRequest = requests.length, next = await start(variant)
    const nextDefinition = service.execution.controller.workflowDefinition(next.state.run.workflowId, next.state.run.workflowDigest)
    assert.equal(nextDefinition.version, '26')
    assert.equal(nextDefinition.nodes.find(item => item.id === 'inspect-and-propose').allowedTools.includes('query_readonly_database'), false)
    assert.ok(requests.length > firstRequest)
    assert.ok(requests.slice(firstRequest).every(request => !JSON.stringify(request.tools).includes('query_readonly_database')))
    assert.equal(connections.length, count)
    await service.execution.controller.pause({ commandId: `pause-${next.runId}`, runId: next.runId, reason: '已验证未授权工具未登记' })
  }
  assert.doesNotMatch(JSON.stringify(requests), /native-fixture-secret-|frozen_database|current_database|reset_database/)
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await inspect(path)
      else assert.doesNotMatch(await readFile(path, 'utf8'), /native-fixture-secret-|frozen_database|current_database|reset_database/)
    }
  }
  await inspect(config.artifactDirectory); await inspect(join(root, 'sessions')); await inspect(join(root, 'tasks'))
})
