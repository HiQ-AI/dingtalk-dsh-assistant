import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { createWorkflowConfiguration } from '../packages/dingtalk-dsh-assistant/workflow-configuration.js'
import { apply as applyResident, inject as residentInject } from '../packages/dingtalk-dsh-assistant/resident.js'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
import { cutoverWorkflow } from '../packages/dingtalk-dsh-assistant/workflow-cutover.js'

const actor = { channel: 'web', actorId: 'configuration-owner' }
const workflowIds = ['task-engineering', 'task-data-change', 'task-general-capability', 'task-progress-query']
const documentKey = instanceId => `dingtalk-dsh-assistant/workflow-configuration-${createHash('sha256').update(instanceId).digest('hex')}`
const instanceId = 'configuration-service-fixture', key = documentKey(instanceId)
const secret = 'isolated-test-password-do-not-echo'
const errorCode = code => error => { assert.equal(error.code, `WORKFLOW_CONFIG_${code}`); assert.equal(error.message, error.code); return true }
function memoryCredentials() {
  const records = new Map()
  let queue = Promise.resolve()
  const service = {
    records, writable: true,
    async readRecord(key) { return structuredClone(records.get(key)) },
    async describeRecord(key) { return { configured: records.has(key), writable: service.writable } },
    modifyRecord(key, mutate) {
      const result = queue.then(async () => {
        const current = structuredClone(records.get(key)), next = await mutate(current)
        if (next !== undefined) records.set(key, structuredClone(next))
        return structuredClone(next === undefined ? current : next)
      })
      queue = result.catch(() => {})
      return result
    },
  }
  return service
}
const create = credentials => createWorkflowConfiguration({ credentials, instanceId, workflowIds, webActorId: actor.actorId })
const variable = (name, value, expectedRevision, options = {}) => ({ name, value, expectedRevision, kind: 'plain', format: 'text', description: '隔离测试变量', ...options })
const binding = (workflowId, variables, expectedRevision) => ({ workflowId, variables, expectedRevision })

test('管理普通与秘密变量，Web投影和快照只含允许字段，Host按类型读取', async () => {
  const service = create(memoryCredentials())
  assert.deepEqual(await service.state(actor), { revision: 0, writable: true, variables: [], bindings: [] })
  await service.saveVariable(variable('database', '{"port":5432,"ssl":false}', 0, { format: 'json' }), actor)
  const saved = await service.saveVariable(variable('password', secret, 1, { kind: 'secret' }), actor)
  assert.equal(saved.revision, 2)
  assert.equal(saved.variables[0].value, '{"port":5432,"ssl":false}')
  assert.equal(Object.hasOwn(saved.variables[1], 'value'), false)
  assert.equal(Object.hasOwn(saved.variables[1], 'versions'), false)
  assert.ok(!JSON.stringify(saved).includes(secret))
  await service.bindWorkflow(binding('task-data-change', [{ alias: 'connection', name: 'database' }, { alias: 'credential', name: 'password' }], 2), actor)
  const metadata = await service.snapshot({ runId: 'run-one', workflowId: 'task-data-change' })
  assert.deepEqual(metadata.variables.map(item => Object.keys(item).sort()), Array(2).fill(['alias', 'format', 'kind', 'name', 'revision']))
  assert.ok(!JSON.stringify(metadata).includes(secret))
  const reader = service.forRun({ runId: 'run-one', workflowId: 'task-data-change' })
  assert.deepEqual(await reader.read('connection'), { port: 5432, ssl: false })
  assert.equal(await reader.readSecret('credential'), secret)
  await assert.rejects(reader.read('credential'), errorCode('KIND_MISMATCH'))
  await assert.rejects(reader.readSecret('connection'), errorCode('KIND_MISMATCH'))
  await assert.rejects(reader.read('missing'), errorCode('BINDING_REQUIRED'))
  const plain = await reader.read('connection'); plain.port = 0
  assert.equal((await reader.read('connection')).port, 5432)
})

test('配置文档CAS在原子修改内部比较，并发只有一个发布成功', async () => {
  const credentials = memoryCredentials(), first = create(credentials), second = create(credentials)
  const results = await Promise.allSettled([first.saveVariable(variable('one', 'A', 0), actor), second.saveVariable(variable('two', 'B', 0), actor)])
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(results.filter(item => item.status === 'rejected')[0].reason.code, 'WORKFLOW_CONFIG_REVISION_CONFLICT')
  assert.equal((await first.state(actor)).revision, 1)
  assert.equal((await first.state(actor)).variables.length, 1)
  await assert.rejects(first.setVariableEnabled({ name: 'one', enabled: false, expectedRevision: 0 }, actor), errorCode('REVISION_CONFLICT'))
})

test('冻结精确变量版本和绑定，更新停用不改变旧Run，停用阻止新绑定与新快照', async () => {
  const service = create(memoryCredentials()), workflowId = 'task-data-change'
  await service.saveVariable(variable('target', 'old', 0), actor)
  await service.bindWorkflow(binding(workflowId, [{ alias: 'target', name: 'target' }], 1), actor)
  const original = await service.snapshot({ runId: 'old-run', workflowId })
  await service.saveVariable(variable('target', 'new', 2), actor)
  await service.snapshot({ runId: 'new-run', workflowId })
  assert.equal(await service.forRun({ runId: 'old-run', workflowId }).read('target'), 'old')
  assert.equal(await service.forRun({ runId: 'new-run', workflowId }).read('target'), 'new')
  const disabled = await service.setVariableEnabled({ name: 'target', enabled: false, expectedRevision: 3 }, actor)
  assert.equal(disabled.variables[0].revision, 2)
  assert.equal(disabled.variables[0].enabled, false)
  assert.equal(disabled.bindings.length, 1)
  await assert.rejects(service.snapshot({ runId: 'disabled-run', workflowId }), errorCode('VARIABLE_DISABLED'))
  await assert.rejects(service.bindWorkflow(binding('task-engineering', [{ alias: 'target', name: 'target' }], 4), actor), errorCode('VARIABLE_DISABLED'))
  assert.deepEqual(await service.snapshot({ runId: 'old-run', workflowId }), original)
  assert.equal(await service.forRun({ runId: 'old-run', workflowId }).read('target'), 'old')
  await service.bindWorkflow(binding(workflowId, [], 4), actor)
  assert.deepEqual((await service.snapshot({ runId: 'unbound-run', workflowId })).variables, [])
  assert.equal(await service.forRun({ runId: 'old-run', workflowId }).read('target'), 'old')
})

test('runId独占快照，工程派生同目录沿用初始身份，跨流程读取拒绝', async () => {
  const credentials = memoryCredentials(), service = create(credentials)
  await service.saveVariable(variable('target', 'frozen', 0), actor)
  await service.bindWorkflow(binding('task-engineering', [{ alias: 'target', name: 'target' }], 1), actor)
  const initial = { runId: 'shared', workflowId: `task-engineering-${'a'.repeat(40)}` }
  const metadata = await service.snapshot(initial)
  assert.equal(metadata.workflowId, initial.workflowId)
  assert.equal(metadata.catalogWorkflowId, 'task-engineering')
  await service.saveVariable(variable('target', 'later', 2), actor)
  const revised = { runId: initial.runId, workflowId: `task-engineering-revision-${'b'.repeat(32)}` }
  assert.deepEqual(await service.snapshot(revised), metadata)
  assert.equal(await service.forRun(revised).read('target'), 'frozen')
  assert.equal(credentials.records.size, 2)
  await assert.rejects(service.snapshot({ runId: initial.runId, workflowId: 'task-data-change' }), errorCode('RUN_MISMATCH'))
  await assert.rejects(service.forRun({ runId: initial.runId, workflowId: 'task-data-change' }).read('target'), errorCode('RUN_MISMATCH'))
  assert.equal(credentials.records.size, 2)
  const reader = service.forRun({ runId: 'legacy-run', workflowId: 'task-data-change' })
  assert.equal(typeof reader.read, 'function')
  await assert.rejects(reader.read('target'), errorCode('SNAPSHOT_REQUIRED'))
  assert.equal(credentials.records.size, 2)
  assert.deepEqual((await service.snapshot({ runId: 'internal', workflowId: 'task-general-capability' })).variables, [])
  await assert.rejects(service.bindWorkflow(binding('task-general-capability', [], 3), actor), errorCode('WORKFLOW_UNKNOWN'))
  await assert.rejects(service.snapshot({ runId: 'unknown', workflowId: 'unregistered' }), errorCode('WORKFLOW_UNKNOWN'))
})

test('身份与存储边界明确拒绝，秘密与provider错误不进入错误回执', async () => {
  const credentials = memoryCredentials(), service = create(credentials)
  for (const identity of [undefined, { ...actor, actorId: 'other' }, { ...actor, channel: 'dingtalk' }]) {
    await assert.rejects(service.state(identity), errorCode('FORBIDDEN'))
    await assert.rejects(service.saveVariable(variable('password', secret, 0, { kind: 'secret' }), identity), errorCode('FORBIDDEN'))
  }
  await assert.rejects(createWorkflowConfiguration({ credentials, instanceId, workflowIds }).state(actor), errorCode('FORBIDDEN'))
  await assert.rejects(create(undefined).state(actor), errorCode('UNAVAILABLE'))
  credentials.writable = false
  assert.equal((await service.state(actor)).writable, false)
  await assert.rejects(service.saveVariable(variable('password', secret, 0, { kind: 'secret' }), actor), errorCode('READONLY'))
  credentials.writable = true
  credentials.modifyRecord = async () => { throw new Error(`provider diagnostic ${secret}`) }
  await assert.rejects(service.saveVariable(variable('password', secret, 0, { kind: 'secret' }), actor), errorCode('STORAGE_FAILED'))
})

test('输入严格验证、种类与格式不能改变、非法绑定不发布', async () => {
  const credentials = memoryCredentials(), service = create(credentials)
  for (const invalid of [{ name: '__proto__' }, { name: 'constructor' }, { name: 'prototype' }, { name: 'a.b' }, { value: 42 },
    { value: '汉'.repeat(21846) }, { expectedRevision: -1 }, { actorId: actor.actorId }])
    await assert.rejects(service.saveVariable({ ...variable('valid', 'x', 0), ...invalid }, actor), errorCode('ARGUMENT_INVALID'))
  for (const value of ['{bad', '{"port":1e1000}']) await assert.rejects(service.saveVariable(variable('valid', value, 0, { format: 'json' }), actor), errorCode('JSON_INVALID'))
  await assert.rejects(service.saveVariable(variable('valid', '  ', 0, { kind: 'secret' }), actor), errorCode('SECRET_REQUIRED'))
  await service.saveVariable(variable('valid', '', 0), actor)
  await assert.rejects(service.saveVariable(variable('valid', 'secret', 1, { kind: 'secret' }), actor), errorCode('KIND_IMMUTABLE'))
  await assert.rejects(service.saveVariable(variable('valid', '{}', 1, { format: 'json' }), actor), errorCode('FORMAT_IMMUTABLE'))
  await assert.rejects(service.bindWorkflow(binding('task-data-change', [{ alias: 'same', name: 'valid' }, { alias: 'same', name: 'valid' }], 1), actor), errorCode('ALIAS_DUPLICATE'))
  await assert.rejects(service.bindWorkflow(binding('task-data-change', [{ alias: 'missing', name: 'unknown' }], 1), actor), errorCode('VARIABLE_UNKNOWN'))
  await assert.rejects(service.setVariableEnabled({ name: 'missing', enabled: false, expectedRevision: 1 }, actor), errorCode('VARIABLE_UNKNOWN'))
  assert.equal((await service.state(actor)).revision, 1)
  assert.throws(() => createWorkflowConfiguration({ credentials, instanceId, workflowIds: undefined }), errorCode('ARGUMENT_INVALID'))
  assert.throws(() => createWorkflowConfiguration({ credentials, workflowIds }), errorCode('ARGUMENT_INVALID'))
})

test('100变量和4MiB完整历史上限原子拒绝且不更改持久版本', async () => {
  const credentials = memoryCredentials(), service = create(credentials)
  for (let index = 0; index < 100; index++) await service.saveVariable(variable(`item${index}`, 'x', index), actor)
  await assert.rejects(service.saveVariable(variable('overflow', 'x', 100), actor), errorCode('LIMIT_EXCEEDED'))
  assert.equal((await service.state(actor)).variables.length, 100)
  const large = create(memoryCredentials()), chunk = 'x'.repeat(64 * 1024)
  for (let index = 0; index < 63; index++) await large.saveVariable(variable('large', chunk, index), actor)
  await assert.rejects(large.saveVariable(variable('large', chunk, 63), actor), errorCode('LIMIT_EXCEEDED'))
  assert.equal((await large.state(actor)).revision, 63)
  assert.equal((await large.state(actor)).variables[0].revision, 63)
})

test('损坏持久记录不静默重置或读取最新版本', async () => {
  const credentials = memoryCredentials(), service = create(credentials)
  credentials.records.set(key, { kind: 'grant', payload: { schemaVersion: 8, secret } })
  await assert.rejects(service.state(actor), errorCode('STORED_INVALID'))
  await assert.rejects(service.saveVariable(variable('one', 'x', 0), actor), errorCode('STORED_INVALID'))
  assert.equal(credentials.records.get(key).payload.secret, secret)
})

test('正式native provider隔离持久化，移动来源文件并重启后仍读取冻结版本', async t => {
  const parent = resolve('docs/tmp/workflow-configuration-tests')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'native-')), path = join(directory, 'credentials.yaml')
  const source = join(directory, 'source.json'), moved = join(directory, 'source-moved.json')
  await writeFile(source, JSON.stringify({ database: { host: '127.0.0.1', port: 5432 }, password: secret }))
  const imported = JSON.parse(await readFile(source, 'utf8'))
  const first = new Context()
  await first.plugin(LocalCredentialProvider, { path, watch: false })
  t.after(() => first.fiber.dispose())
  const service = create(first.credentials), run = { runId: 'native-run', workflowId: 'task-data-change' }
  await service.saveVariable(variable('database', JSON.stringify(imported.database), 0, { format: 'json' }), actor)
  await service.saveVariable(variable('password', imported.password, 1, { kind: 'secret' }), actor)
  await service.bindWorkflow(binding(run.workflowId, [{ alias: 'db', name: 'database' }, { alias: 'auth', name: 'password' }], 2), actor)
  const snapshot = await service.snapshot(run)
  await service.saveVariable(variable('password', 'isolated-rotated-password', 3, { kind: 'secret' }), actor)
  await rename(source, moved)
  await assert.rejects(readFile(source), { code: 'ENOENT' })
  await first.fiber.dispose()
  // 默认原生后端确为明文；只检查本测试临时目录，不触碰正式凭据。
  assert.ok((await readFile(path, 'utf8')).includes(secret))
  const restarted = new Context()
  await restarted.plugin(LocalCredentialProvider, { path, watch: false })
  t.after(() => restarted.fiber.dispose())
  const reloaded = create(restarted.credentials)
  assert.deepEqual(await reloaded.snapshot(run), snapshot)
  assert.deepEqual(await reloaded.forRun(run).read('db'), imported.database)
  assert.equal(await reloaded.forRun(run).readSecret('auth'), secret)
  await reloaded.snapshot({ ...run, runId: 'new-native-run' })
  assert.equal(await reloaded.forRun({ ...run, runId: 'new-native-run' }).readSecret('auth'), 'isolated-rotated-password')
  const publicRead = await reloaded.state(actor)
  assert.ok(!JSON.stringify(publicRead).includes(secret))
  assert.equal(publicRead.variables[1].revision, 2)
  assert.ok((await restarted.credentials.listRecords()).every(record => record.key.startsWith('dingtalk-dsh-assistant/')))
})

test('两个正式native provider共享隔离文件，文件锁内CAS只发布一个版本', async t => {
  const parent = resolve('docs/tmp/workflow-configuration-tests')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'cas-')), path = join(directory, 'credentials.yaml')
  const first = new Context(), second = new Context()
  await first.plugin(LocalCredentialProvider, { path, watch: false })
  await second.plugin(LocalCredentialProvider, { path, watch: false })
  t.after(async () => { await first.fiber.dispose(); await second.fiber.dispose() })
  const results = await Promise.allSettled([create(first.credentials).saveVariable(variable('a', 'first', 0), actor), create(second.credentials).saveVariable(variable('b', 'second', 0), actor)])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'WORKFLOW_CONFIG_REVISION_CONFLICT')
  const third = new Context()
  await third.plugin(LocalCredentialProvider, { path, watch: false })
  t.after(() => third.fiber.dispose())
  const saved = await create(third.credentials).state(actor)
  assert.equal(saved.revision, 1)
  assert.equal(saved.variables.length, 1)
})

test('共享native凭据文件的不同实例隔离变量、相同runId快照及管理身份', async t => {
  const parent = resolve('docs/tmp/workflow-configuration-tests')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'instances-')), context = new Context()
  await context.plugin(LocalCredentialProvider, { path: join(directory, 'credentials.yaml'), watch: false })
  t.after(() => context.fiber.dispose())
  await context.credentials.modifyRecord('dingtalk-dsh-assistant/workflow-configuration', () => ({ kind: 'grant', payload: { legacyValue: 'no-global-fallback' } }))
  const actorA = { channel: 'web', actorId: 'owner-a' }, actorB = { channel: 'web', actorId: 'owner-b' }
  const first = createWorkflowConfiguration({ credentials: context.credentials, instanceId: 'instance-a', workflowIds, webActorId: actorA.actorId })
  const second = createWorkflowConfiguration({ credentials: context.credentials, instanceId: 'instance-b', workflowIds, webActorId: actorB.actorId })
  assert.equal((await first.state(actorA)).revision, 0)
  await first.saveVariable(variable('password', 'isolated-instance-a-secret', 0, { kind: 'secret' }), actorA)
  await first.bindWorkflow(binding('task-data-change', [{ alias: 'password', name: 'password' }], 1), actorA)
  const run = { runId: 'same-local-run-id', workflowId: 'task-data-change' }
  assert.equal((await first.snapshot(run)).instanceId, 'instance-a')
  assert.deepEqual(await second.state(actorB), { revision: 0, writable: true, variables: [], bindings: [] })
  await assert.rejects(second.forRun(run).readSecret('password'), errorCode('SNAPSHOT_REQUIRED'))
  await assert.rejects(second.state(actorA), errorCode('FORBIDDEN'))
  await assert.rejects(first.saveVariable(variable('password', 'forged', 2, { kind: 'secret' }), actorB), errorCode('FORBIDDEN'))
  await second.saveVariable(variable('password', 'isolated-instance-b-secret', 0, { kind: 'secret' }), actorB)
  await second.bindWorkflow(binding('task-data-change', [{ alias: 'password', name: 'password' }], 1), actorB)
  assert.equal((await second.snapshot(run)).instanceId, 'instance-b')
  assert.equal(await first.forRun(run).readSecret('password'), 'isolated-instance-a-secret')
  assert.equal(await second.forRun(run).readSecret('password'), 'isolated-instance-b-secret')
  const records = await context.credentials.listRecords()
  assert.equal(records.length, 5)
  assert.equal((await context.credentials.readRecord(documentKey('instance-a'))).payload.instanceId, 'instance-a')
  assert.equal((await context.credentials.readRecord(documentKey('instance-b'))).payload.instanceId, 'instance-b')
})

test('完整Resident按已激活workflow启动，原生credentials透传到配置HTTP且重启持久读取', async t => {
  const parent = resolve('docs/tmp/workflow-configuration-tests')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'resident-'))
  const tables = new Map()
  const domain = { table(name) {
    if (!tables.has(name)) tables.set(name, new Map())
    const data = tables.get(name)
    return { get: key => data.get(key), entries: () => data.entries(), put: async (key, value) => { data.set(key, value) },
      update: async (key, transform) => { const value = transform(data.get(key)); data.set(key, value); return value } }
  }, close: async () => {} }
  const storageDomain = { config: { backend: 'json' }, open: async () => domain }
  const legacy = await openResidentStore(storageDomain)
  await legacy.subscribe({ groupId: 'configuration-test', responsibility: '隔离配置测试' })
  await legacy.close()
  const legacyPath = join(directory, 'legacy.json'), dbPath = join(directory, 'control.db'), artifactDirectory = join(directory, 'artifacts')
  await writeFile(legacyPath, JSON.stringify({ unit: { name: 'dingtalk_dsh_assistant', version: 9 }, tables: Object.fromEntries([...tables].map(([name, data]) => [name, Object.fromEntries(data)])) }))
  await cutoverWorkflow({ legacyPath, journalPath: join(directory, 'dingtalk_dsh_assistant.workflow-seal.json'), dbPath, artifactDirectory,
    instanceId: 'configuration-resident', groupIds: ['configuration-test'], probeStopped: async () => ({ stopped: true, pidPresent: false, listenerPresent: false, autostartDisabled: true }) })
  let provider = new Context()
  await provider.plugin(LocalCredentialProvider, { path: join(directory, 'credentials.yaml'), watch: false })
  let dispose
  t.after(async () => { await dispose?.(); await provider.fiber.dispose() })
  assert.ok(residentInject.includes('credentials'))
  const effects = [], logs = []
  const ctx = { credentials: provider.credentials, effect: callback => effects.push(callback), get: () => undefined,
    logger: { info: value => logs.push(value), warn: value => logs.push(value), error: value => logs.push(value) },
    storage: { backend: new Map([['json', { root: directory }]]) }, storageDomain,
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    agents: { create: async () => { throw Error('MODEL_NOT_EXPECTED') }, resume: async () => { throw Error('MODEL_NOT_EXPECTED') } },
    subagents: { drainDescendants: async () => {} },
  }
  const start = async () => {
    const reserve = createServer()
    await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve))
    const port = reserve.address().port
    await new Promise(resolve => reserve.close(resolve))
    await applyResident(ctx, { host: '127.0.0.1', port, proxyUrl: '', agentWorkspaceDir: directory, dws: { enabled: false, writesAuthorized: false, profile: 'isolated-configuration-fixture' },
      workflow: { groupIds: ['configuration-test'], ownerActorId: actor.actorId, webActorId: actor.actorId, dbPath, artifactDirectory, instanceId: 'configuration-resident' } })
    dispose = effects.at(-1)()
    return `http://127.0.0.1:${port}`
  }
  let base = await start()
  const catalog = await (await fetch(base + '/state/workflows/catalog')).json()
  assert.equal(catalog.engine, 'workflow-v2')
  assert.deepEqual(catalog.groupIds, ['configuration-test'])
  const initial = await fetch(base + '/config/workflow-variables')
  assert.equal(initial.status, 200)
  assert.equal((await initial.json()).revision, 0)
  const response = await fetch(base + '/config/workflow-variables/endpoint', { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'plain', format: 'text', description: '仅测试', value: 'isolated-endpoint', expectedRevision: 0 }) })
  assert.equal(response.status, 200)
  assert.equal((await provider.credentials.readRecord(documentKey('configuration-resident'))).payload.variables[0].versions[0].value, 'isolated-endpoint')
  await dispose(); dispose = undefined
  await provider.fiber.dispose()
  provider = new Context()
  await provider.plugin(LocalCredentialProvider, { path: join(directory, 'credentials.yaml'), watch: false })
  ctx.credentials = provider.credentials
  base = await start()
  const reloaded = await fetch(base + '/config/workflow-variables')
  assert.equal(reloaded.status, 200)
  assert.equal((await reloaded.json()).variables[0].value, 'isolated-endpoint')
  assert.ok(logs.every(value => !String(value).includes('WORKFLOW_CONFIG_UNAVAILABLE')))
})
