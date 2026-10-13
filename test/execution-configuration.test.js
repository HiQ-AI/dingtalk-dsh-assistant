import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rename, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { createWorkflowConfiguration } from '../packages/dingtalk-dsh-assistant/workflow-configuration.js'
import { createExecutionController } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { openExecutionRuntime } from '../packages/dingtalk-dsh-assistant/execution.js'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createRegisteredPostgresConnector } from '../packages/dingtalk-dsh-assistant/agent-query-database.js'

const identity = { channel: 'web', actorId: 'configuration-owner' }
const boolean = { type: 'boolean' }
const workflow = execute => ({ id: 'task-data-change', version: 'configuration-test-1', nodes: [
  { id: 'connect', version: '1', executor: 'code', allowedEffects: ['read'], inputSchema: boolean, outputSchema: boolean,
    mapInput: ({ requirement }) => requirement, execute },
  { id: 'report', version: '1', executor: 'agent', allowedEffects: ['read'], provider: 'fixture', model: 'fixture', prompt: '只确认Host结果', allowedTools: [],
    inputSchema: boolean, outputSchema: boolean, mapInput: ({ previousOutput }) => previousOutput },
] })

async function fixture(t, definition, managed = true) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-configuration-execution-'))
  const dbPath = join(directory, 'execution.sqlite'), artifactDirectory = join(directory, 'artifacts')
  let ctx, configuration, controller, store, enabled = managed
  const agentCalls = []
  const sessions = { async run(args) { agentCalls.push(args); await args.onSessionBound(); await args.onResult(args.input); return { status: 'submitted' } },
    async cancel() {}, async assertDrained() {}, async close() {} }
  async function openHost() {
    ctx = new Context()
    await ctx.plugin(LocalCredentialProvider, { path: join(directory, 'credentials.yaml'), watch: false })
    configuration = createWorkflowConfiguration({ instanceId: 'configuration-fixture', credentials: ctx.credentials, workflowIds: ['task-data-change', 'task-production-release'], webActorId: identity.actorId })
  }
  await openHost()
  const artifacts = await openExecutionArtifacts({ directory: artifactDirectory, initialize: true })
  const openController = async initialize => {
    store = await openExecutionStore({ dbPath, instanceId: 'configuration-fixture', initialize })
    controller = createExecutionController({ store, artifacts, sessions, workflows: [definition], ...(enabled ? { configuration } : {}) })
  }
  await openController(true)
  t.after(async () => { await controller.close(); await store.close(); await ctx.fiber.dispose() })
  return { directory, artifacts, agentCalls, get controller() { return controller }, get store() { return store }, get configuration() { return configuration },
    async reopen(managedConfiguration = enabled) { await controller.close(); await store.close(); await ctx.fiber.dispose(); enabled = managedConfiguration; await openHost(); await openController(false) },
    async save(name, kind, value, format = 'text') {
      const state = await configuration.state(identity)
      return configuration.saveVariable({ name, kind, format, value, description: '隔离配置消费验证', expectedRevision: state.revision }, identity)
    },
    async bind() {
      const state = await configuration.state(identity)
      return configuration.bindWorkflow({ workflowId: definition.id, variables: [{ alias: 'dbConfig', name: 'dbConfig' }, { alias: 'dbPassword', name: 'dbPassword' }], expectedRevision: state.revision }, identity)
    },
  }
}

test('真实执行器冻结托管变量，移动导入文件并重建Host后原运行与新运行各用其版本', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), connections = []
  let hold = true
  class Client {
    constructor(options) { connections.push({ database: options.database, password: options.password }) }
    async connect() {}
    async query() { return { rows: [{ verified: true }] } }
    async end() {}
  }
  const definition = workflow(async ({ configuration, runId }) => {
    if (runId === 'old-run' && hold) { entered.resolve(); await release.promise }
    const connect = createRegisteredPostgresConnector({ configuration, connections: { registered: { configAlias: 'dbConfig', passwordAlias: 'dbPassword' } }, Client })
    const client = await connect({ connectionId: 'registered' })
    try { return (await client.query('SELECT 1')).rows[0].verified } finally { await client.end() }
  })
  const f = await fixture(t, definition)
  const source = join(f.directory, 'import.json')
  await writeFile(source, JSON.stringify({ config: { host: '127.0.0.1', port: 5432, db: 'old_database', user: 'readonly' }, password: 'fixture-old-secret' }))
  const imported = JSON.parse(await readFile(source, 'utf8'))
  await f.save('dbConfig', 'plain', JSON.stringify(imported.config), 'json')
  await f.save('dbPassword', 'secret', imported.password)
  await f.bind()
  const args = { commandId: 'old-create', taskId: 'old-task', runId: 'old-run', workflowId: definition.id, input: true }
  await f.controller.createRun(args); await entered.promise
  await f.controller.pause({ commandId: 'pause-old', runId: 'old-run', reason: 'configuration-fixture' })
  hold = false; release.resolve()
  assert.equal((await f.controller.whenIdle('old-run')).run.recoveryReason, 'user_pause')
  await f.save('dbConfig', 'plain', JSON.stringify({ ...imported.config, db: 'new_database' }), 'json')
  await f.save('dbPassword', 'secret', 'fixture-new-secret')
  await rename(source, `${source}.moved`)
  await f.reopen()
  await assert.rejects(readFile(source), { code: 'ENOENT' })
  await f.controller.createRun(args)
  await assert.rejects(f.controller.createRun({ ...args, commandId: 'malicious-reuse', taskId: 'wrong-task' }), { code: 'RUN_EXISTS' })
  await assert.rejects(f.controller.createRun({ ...args, runId: 'poison-run', taskId: 'poison-task' }), { code: 'COMMAND_ID_CONFLICT' })
  await assert.rejects(f.configuration.forRun({ runId: 'poison-run', workflowId: args.workflowId }).read('dbConfig'), { code: 'WORKFLOW_CONFIG_SNAPSHOT_REQUIRED' })
  await assert.rejects(f.configuration.forRun({ runId: 'old-run', workflowId: 'task-production-release' }).read('dbConfig'), { code: 'WORKFLOW_CONFIG_RUN_MISMATCH' })
  await f.controller.resume({ commandId: 'resume-old', runId: 'old-run' })
  assert.equal((await f.controller.whenIdle('old-run')).run.status, 'succeeded')
  await f.controller.createRun({ commandId: 'new-create', taskId: 'new-task', runId: 'new-run', workflowId: definition.id, input: true })
  assert.equal((await f.controller.whenIdle('new-run')).run.status, 'succeeded')
  assert.deepEqual(connections, [{ database: 'old_database', password: 'fixture-old-secret' }, { database: 'new_database', password: 'fixture-new-secret' }])
  assert.equal(f.agentCalls.length, 2)
  assert.ok(f.agentCalls.every(args => !Object.hasOwn(args, 'configuration') && args.input === true))
  assert.doesNotMatch(JSON.stringify(f.agentCalls), /fixture-(?:old|new)-secret|old_database|new_database/)
  const inspect = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await inspect(path)
      else assert.doesNotMatch(await readFile(path, 'utf8'), /fixture-(?:old|new)-secret|old_database|new_database/)
    }
  }
  await inspect(join(f.directory, 'artifacts'))
  assert.doesNotMatch(JSON.stringify(await f.controller.state('old-run')), /fixture-(?:old|new)-secret/)
})

test('取消后受信节点保存的读取器失效，旧Run不能借重投冻结最新配置', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  let captured
  const f = await fixture(t, workflow(async ({ configuration }) => { captured = configuration; entered.resolve(); await release.promise; await configuration.readSecret('dbPassword'); return true }))
  await f.save('dbConfig', 'plain', '{}', 'json'); await f.save('dbPassword', 'secret', 'fixture-cancelled-secret'); await f.bind()
  await f.controller.createRun({ commandId: 'create', taskId: 'task', runId: 'run', workflowId: 'task-data-change', input: true })
  await entered.promise
  await f.controller.stop({ commandId: 'stop', runId: 'run', reason: 'cancel' }); release.resolve()
  assert.equal((await f.controller.whenIdle('run')).run.status, 'cancelled')
  await assert.rejects(captured.readSecret('dbPassword'))
  assert.equal(f.agentCalls.length, 0)
})

test('未接配置服务时原执行照常，实际读取失败关闭；旧Run缺快照不能自动冻结', async t => {
  const f = await fixture(t, workflow(async ({ input }) => input), false)
  const args = { commandId: 'legacy-create', taskId: 'legacy-task', runId: 'legacy-run', workflowId: 'task-data-change', input: true }
  await f.controller.createRun(args)
  assert.equal((await f.controller.whenIdle('legacy-run')).run.status, 'succeeded')
  await f.reopen(true)
  await f.controller.createRun(args)
  await assert.rejects(f.configuration.forRun({ runId: args.runId, workflowId: args.workflowId }).read('dbConfig'), { code: 'WORKFLOW_CONFIG_SNAPSHOT_REQUIRED' })
  const missing = await fixture(t, workflow(async ({ configuration }) => !!await configuration.readSecret('dbPassword')), false)
  await missing.controller.createRun({ ...args, commandId: 'missing-create', runId: 'missing-run', taskId: 'missing-task' })
  const state = await missing.controller.whenIdle('missing-run')
  assert.equal(state.nodes[0].waitReason.reference, 'WORKFLOW_CONFIGURATION_UNAVAILABLE')
  assert.equal(missing.agentCalls.length, 0)
})

test('正式执行Runtime入口透传配置服务给冻结Run与code节点', async t => {
  const definition = workflow(async ({ configuration }) => (await configuration.read('dbConfig')).host === '127.0.0.1' && (await configuration.readSecret('dbPassword')).length > 0)
  definition.nodes = definition.nodes.slice(0, 1)
  const f = await fixture(t, definition)
  await f.save('dbConfig', 'plain', JSON.stringify({ host: '127.0.0.1' }), 'json')
  await f.save('dbPassword', 'secret', 'fixture-runtime-secret'); await f.bind()
  const runtime = await openExecutionRuntime({ ctx: {}, dbPath: join(f.directory, 'runtime.sqlite'), instanceId: 'runtime-fixture',
    artifactDirectory: join(f.directory, 'runtime-artifacts'), initialize: true, workflows: [definition], configuration: f.configuration })
  t.after(() => runtime.close())
  await runtime.controller.createRun({ commandId: 'runtime-create', runId: 'runtime-run', taskId: 'runtime-task', workflowId: definition.id, input: true })
  const state = await runtime.controller.whenIdle('runtime-run')
  assert.equal(state.run.status, 'succeeded')
  assert.equal(await runtime.artifacts.read(state.nodes[0].outputRef), true)
})
