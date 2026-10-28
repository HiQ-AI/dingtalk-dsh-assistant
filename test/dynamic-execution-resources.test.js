import {createTaskLedgerDetails} from '../packages/dingtalk-dsh-assistant/task-ledger-details.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { readExecutionResourceCatalog } from '../packages/dingtalk-dsh-assistant/execution-resource-catalog.js'

const catalog = { version: 1, resources: [
  { key: 'publish:example:uat', aliases: ['old:uat', 'cluster:example:uat'], purpose: 'publication', description: '示例共享发布目标' },
  { key: 'publish:example:other', aliases: [], purpose: 'publication', description: '另一发布目标' },
  { key: 'workspace:example:integration', aliases: ['old:integration'], purpose: 'workspace', description: '共享集成检出' },
] }

// 使用真实隔离账本和公开命令验证资源生命周期；不读写运行实例或依赖私有锁实现。
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dynamic-execution-resources-'))
  const config = { dbPath: join(root, 'ledger.sqlite'), instanceId: 'resource-tests', initialize: true, ...options }
  let store = await openDynamicTaskStore(config), sequence = 0
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }) })
  const command = (kind, args, id = `command-${++sequence}`) => store.command({ id, kind, args })
  const query = args => store.query(args)
  async function task(taskId) {
    await command('task.create', { taskId, request: '验证共享环境的受管执行互斥' })
    return (await command('task.claim', { taskId })).result.binding
  }
  async function dispatch(binding, resourceKeys, key = 'deploy', resourcePhase) {
    return (await command('execution.dispatch', { binding, key, prompt: '验证指定资源', input: {}, resourceKeys, ...(resourcePhase ? { resourcePhase } : {}) })).result.execution
  }
  async function claim(execution) {
    return (await command('execution.claim', { executionId: execution.executionId })).result.binding
  }
  async function finish(binding) {
    await command('execution.result', { binding, output: { status: 'verified' } })
    await command('execution.drained', { binding })
  }
  async function operation(binding, resourceKeys = []) {
    return (await command('operation.prepare', { binding, key: `effect-${++sequence}`, definition: { toolName: 'pwsh' }, resourceKeys })).result.operation
  }
  return { command, query, task, dispatch, claim, finish, operation,
    openAdditional: options => openDynamicTaskStore({ ...config, initialize: false, ...options }),
    // 仅隔离夹具模拟旧版本落盘形态；绝不接收或修改现场数据库路径。
    async restoreLegacyFixture(rewrite, options = {}) {
      await store.close()
      const db = new DatabaseSync(config.dbPath)
      const details=createTaskLedgerDetails(root)
      try {
        // This fixture intentionally recreates pre-externalization inline records.
        // Decode before changing the historical digest; never mutate a bound reference.
        for(const table of ['dynamic_executions','dynamic_receipts'])for(const row of db.prepare(`SELECT id,body FROM ${table}`).all()){
          const value=details.decode(JSON.parse(row.body),{table,id:row.id})
          db.prepare(`UPDATE ${table} SET body=? WHERE id=?`).run(JSON.stringify(value),row.id)
        }
        rewrite(db)
      } finally { details.close(); db.close() }
      store = await openDynamicTaskStore({ ...config, initialize: false, ...options })
    },
    async reopen(overrides = {}) { await store.close(); store = await openDynamicTaskStore({ ...config, initialize: false, ...overrides }) } }
}

test('执行自身资源查询只返回绑定身份和当前租约，不改变锁或操作账本', async t => {
  const f = await fixture(t)
  const binding = await f.claim(await f.dispatch(await f.task('own'), ['uat2']))
  await f.claim(await f.dispatch(await f.task('unrelated'), ['uat3']))
  const empty = await f.claim(await f.dispatch(await f.task('no-resources'), []))
  const locks = await f.query({ kind: 'resource.list' })
  const snapshot = await f.query({ kind: 'execution.resources', binding })
  assert.deepEqual(Object.keys(snapshot).sort(), ['taskId', 'executionId', 'sessionId', 'requirementRevision', 'controlRevision', 'inputVersion', 'leaseEpoch', 'resourcePhase', 'resources'].sort())
  assert.equal(snapshot.executionId, binding.executionId)
  assert.equal(snapshot.resources.state, 'held')
  assert.deepEqual(snapshot.resources.keys, ['uat2'])
  assert.equal(snapshot.resources.holder, `execution:${binding.executionId}`)
  assert.deepEqual(snapshot.resources.blocking, [])
  assert.deepEqual((await f.query({ kind: 'execution.resources', binding: empty })).resources, { state: 'none', keys: [], holder: null, blocking: [] })
  snapshot.resources.keys.push('forged')
  assert.deepEqual((await f.query({ kind: 'execution.resources', binding })).resources.keys, ['uat2'])
  assert.deepEqual(await f.query({ kind: 'resource.list' }), locks)
  assert.deepEqual(await f.query({ kind: 'operation.list' }), [])
})

test('执行自身资源查询拒绝身份错配、暂停及已提交但未排空的执行', async t => {
  const f = await fixture(t)
  const binding = await f.claim(await f.dispatch(await f.task('own'), ['uat2']))
  const foreign = await f.dispatch(await f.task('foreign'), [])
  // 所有版本字段都来自 Host；单独篡改任一字段不能查询当前租约。
  for (const [key, value] of Object.entries({ kind: 'task', taskId: 'other', executionId: foreign.executionId, sessionId: 'other', requirementRevision: 2, controlRevision: 2, inputVersion: 2, inputDigest: 'other', leaseEpoch: 2 })) {
    await assert.rejects(f.query({ kind: 'execution.resources', binding: { ...binding, [key]: value } }), { code: 'DYNAMIC_EXECUTION_LEASE_STALE' }, key)
  }
  await f.command('execution.result', { binding, output: { status: 'verified' } })
  await assert.rejects(f.query({ kind: 'execution.resources', binding }), { code: 'DYNAMIC_EXECUTION_NOT_CURRENT' })
  const paused = await f.claim(await f.dispatch(await f.task('paused'), ['uat3']))
  await f.command('task.control', { taskId: paused.taskId, control: 'paused' })
  await assert.rejects(f.query({ kind: 'execution.resources', binding: paused }), { code: 'DYNAMIC_EXECUTION_NOT_CURRENT' })
})

test('执行续办按新绑定读取更新后的资源，旧绑定不能借用新持锁证明', async t => {
  const f = await fixture(t), owner = await f.task('owner')
  const execution = await f.dispatch(owner, ['uat2']), old = await f.claim(execution)
  await f.finish(old)
  const next = (await f.command('execution.continue', { binding: owner, executionId: execution.executionId, key: 'next', prompt: '核验新资源', input: {}, resourceKeys: ['uat3'] })).result.execution
  const binding = await f.claim(next)
  const snapshot = await f.query({ kind: 'execution.resources', binding })
  assert.equal(snapshot.executionId, old.executionId)
  assert.equal(snapshot.sessionId, old.sessionId)
  assert.ok(snapshot.inputVersion > old.inputVersion)
  assert.ok(snapshot.leaseEpoch > old.leaseEpoch)
  assert.deepEqual(snapshot.resources.keys, ['uat3'])
  assert.equal(snapshot.resources.holder, `execution:${binding.executionId}`)
  await assert.rejects(f.query({ kind: 'execution.resources', binding: old }), { code: 'DYNAMIC_EXECUTION_LEASE_STALE' })
})

test('同一资源只允许一个 execution 取得执行权，结果提交不提前释放', async t => {
  const f = await fixture(t)
  const first = await f.dispatch(await f.task('first'), ['uat2'])
  const second = await f.dispatch(await f.task('second'), ['uat2'])
  const binding = await f.claim(first)
  await assert.rejects(f.claim(second), { code: 'DYNAMIC_RESOURCE_BUSY' })
  assert.equal((await f.query({ kind: 'execution.get', executionId: second.executionId })).status, 'queued')
  await f.command('execution.result', { binding, output: { status: 'verified' } })
  await assert.rejects(f.claim(second), { code: 'DYNAMIC_RESOURCE_BUSY' })
  await f.command('execution.drained', { binding })
  const next = await f.claim(second)
  assert.equal(next.executionId, second.executionId)
  await f.finish(next)
  assert.deepEqual(await f.query({ kind: 'resource.list' }), [])
})

test('资源归一化及多键原子获取不留下部分锁，异键执行可以并行', async t => {
  const f = await fixture(t)
  const first = await f.dispatch(await f.task('first'), ['b'])
  const second = await f.dispatch(await f.task('second'), ['b', 'a', 'b'])
  const independent = await f.dispatch(await f.task('independent'), ['a'])
  assert.deepEqual(second.resourceKeys, ['a', 'b'])
  const firstBinding = await f.claim(first)
  await assert.rejects(f.claim(second), { code: 'DYNAMIC_RESOURCE_BUSY' })
  const independentBinding = await f.claim(independent)
  assert.deepEqual((await f.query({ kind: 'resource.list' })).map(item => item.resourceKey), ['a', 'b'])
  await f.finish(firstBinding)
  await assert.rejects(f.claim(second), { code: 'DYNAMIC_RESOURCE_BUSY' })
  await f.finish(independentBinding)
  await f.finish(await f.claim(second))
})

test('续办省略资源时保留，安全排空后可以显式更新或清空', async t => {
  const f = await fixture(t), owner = await f.task('owner')
  const execution = await f.dispatch(owner, ['uat2'])
  await f.finish(await f.claim(execution))
  const base = { binding: owner, executionId: execution.executionId, prompt: '继续原执行', input: {} }
  const retained = (await f.command('execution.continue', { ...base, key: 'retained' })).result.execution
  assert.deepEqual(retained.resourceKeys, ['uat2'])
  await f.finish(await f.claim(retained))
  const updated = (await f.command('execution.continue', { ...base, key: 'updated', resourceKeys: ['uat3', 'uat3'] })).result.execution
  assert.deepEqual(updated.resourceKeys, ['uat3'])
  await f.finish(await f.claim(updated))
  const cleared = (await f.command('execution.continue', { ...base, key: 'cleared', resourceKeys: [] })).result.execution
  assert.deepEqual(cleared.resourceKeys, [])
  await f.finish(await f.claim(cleared))
})

test('同一续办幂等键不能把变更的资源合同当作原请求', async t => {
  const f = await fixture(t), owner = await f.task('owner')
  const execution = await f.dispatch(owner, ['uat2'])
  await f.finish(await f.claim(execution))
  const args = { binding: owner, executionId: execution.executionId, key: 'resume', prompt: '继续', input: {}, resourceKeys: ['uat3'] }
  await f.command('execution.continue', args)
  await assert.rejects(f.command('execution.continue', { ...args, resourceKeys: ['uat4'] }), { code: 'DYNAMIC_DISPATCH_KEY_CONFLICT' })
})

test('unknown 效果保留资源，原执行只读对账可续办但不能扩大或清空资源', async t => {
  const f = await fixture(t), owner = await f.task('owner')
  const first = await f.dispatch(owner, ['uat2'])
  const second = await f.dispatch(await f.task('second'), ['uat2'])
  const binding = await f.claim(first), operation = await f.operation(binding)
  await f.command('operation.start', { binding, operationId: operation.operationId })
  await f.command('operation.settle', { binding, operationId: operation.operationId, state: 'unknown', result: { lostReceipt: true } })
  await f.finish(binding)
  await assert.rejects(f.claim(second), { code: 'DYNAMIC_RESOURCE_BUSY' })
  const original = await f.query({ kind: 'operation.get', operationId: operation.operationId })
  const base = { binding: owner, executionId: first.executionId, key: 'readback', prompt: '核对原效果', input: {}, definition: { recoveryReadOnly: true } }
  for (const resourceKeys of [[], ['uat3'], ['uat2', 'uat3']]) {
    await assert.rejects(f.command('execution.continue', { ...base, resourceKeys }), { code: 'DYNAMIC_EXECUTION_RESOURCES_HELD' })
  }
  const continued = (await f.command('execution.continue', base)).result.execution
  assert.deepEqual(continued.resourceKeys, ['uat2'])
  const readback = await f.claim(continued)
  await f.finish(readback)
  assert.deepEqual(await f.query({ kind: 'operation.get', operationId: operation.operationId }), original)
  await assert.rejects(f.claim(second), { code: 'DYNAMIC_RESOURCE_BUSY' })
  await f.command('operation.reconcile', { operationId: operation.operationId, state: 'failed', result: { readback: 'confirmed failure' }, evidenceRef: 'fixture-original-effect-readback' })
  await f.finish(await f.claim(second))
})

test('后台 job 未终止时执行排空也不释放，原 job 终态回执可解除等待', async t => {
  const f = await fixture(t), first = await f.dispatch(await f.task('first'), ['uat2'])
  const second = await f.dispatch(await f.task('second'), ['uat2'])
  const binding = await f.claim(first), operation = await f.operation(binding)
  await f.command('operation.start', { binding, operationId: operation.operationId })
  const job = { jobId: 'original-job', owner: binding.sessionId, startedAt: 1, status: 'running' }
  await f.command('operation.job', { binding, operationId: operation.operationId, job })
  await f.finish(binding)
  await assert.rejects(f.claim(second), { code: 'DYNAMIC_RESOURCE_BUSY' })
  await f.command('operation.job', { binding, operationId: operation.operationId, job: { ...job, status: 'completed', finishedAt: 2 } })
  await assert.rejects(f.claim(second), { code: 'DYNAMIC_RESOURCE_BUSY' })
  await f.command('operation.settle', { binding, operationId: operation.operationId, state: 'succeeded', result: { jobReceipt: 'completed' } })
  await f.finish(await f.claim(second))
})

test('停止任务只请求取消，不在原执行和未知效果排空前释放资源', async t => {
  const f = await fixture(t), first = await f.dispatch(await f.task('first'), ['uat2'])
  const second = await f.dispatch(await f.task('second'), ['uat2'])
  const binding = await f.claim(first), operation = await f.operation(binding)
  await f.command('operation.start', { binding, operationId: operation.operationId })
  await f.command('operation.settle', { binding, operationId: operation.operationId, state: 'unknown' })
  await f.command('task.control', { taskId: first.taskId, control: 'cancelled' })
  await assert.rejects(f.claim(second), { code: 'DYNAMIC_RESOURCE_BUSY' })
  await f.command('execution.drained', { binding })
  await assert.rejects(f.claim(second), { code: 'DYNAMIC_RESOURCE_BUSY' })
  await f.command('operation.reconcile', { operationId: operation.operationId, state: 'failed', result: { stopped: true }, evidenceRef: 'fixture-stopped-process-readback' })
  await f.finish(await f.claim(second))
})

test('重启保留 execution 锁及 unknown 效果，恢复排空和对账后才能释放', async t => {
  const f = await fixture(t), first = await f.dispatch(await f.task('first'), ['uat2'])
  const second = await f.dispatch(await f.task('second'), ['uat2'])
  const binding = await f.claim(first), operation = await f.operation(binding, ['uat2'])
  await f.command('operation.start', { binding, operationId: operation.operationId })
  const held = await f.query({ kind: 'resource.list' })
  await f.reopen()
  assert.deepEqual(await f.query({ kind: 'resource.list' }), held)
  assert.equal((await f.query({ kind: 'operation.get', operationId: operation.operationId })).state, 'unknown')
  assert.equal((await f.query({ kind: 'execution.get', executionId: first.executionId })).recovering, true)
  await assert.rejects(f.claim(second), { code: 'DYNAMIC_RESOURCE_BUSY' })
  await f.command('execution.drained', { binding })
  await assert.rejects(f.claim(second), { code: 'DYNAMIC_RESOURCE_BUSY' })
  await f.command('operation.reconcile', { operationId: operation.operationId, state: 'failed', result: { stopped: true }, evidenceRef: 'fixture-restart-readback' })
  await f.finish(await f.claim(second))
})

test('执行声明内操作共享资源且不自锁，操作完成不抢先释放父执行', async t => {
  const f = await fixture(t), first = await f.dispatch(await f.task('first'), ['uat2', 'repository'])
  const second = await f.dispatch(await f.task('second'), ['uat2'])
  const binding = await f.claim(first)
  for (const keys of [[], ['uat2'], ['uat2', 'repository']]) {
    const operation = await f.operation(binding, keys)
    assert.equal((await f.command('operation.start', { binding, operationId: operation.operationId })).dispatchEligible, true)
    await f.command('operation.settle', { binding, operationId: operation.operationId, state: 'succeeded' })
    await assert.rejects(f.claim(second), { code: 'DYNAMIC_RESOURCE_BUSY' })
  }
  await assert.rejects(f.operation(binding, ['new-resource']), { code: 'DYNAMIC_RESOURCE_SCOPE_EXPANSION' })
  await assert.rejects(f.operation(binding, ['uat2', 'new-resource']), { code: 'DYNAMIC_RESOURCE_SCOPE_EXPANSION' })
  await f.finish(binding)
  await f.finish(await f.claim(second))
})

test('准备后未启动的操作也须明确取消，不能用 execution drained 绕过', async t => {
  const f = await fixture(t), first = await f.dispatch(await f.task('first'), ['uat2'])
  const second = await f.dispatch(await f.task('second'), ['uat2'])
  const binding = await f.claim(first), operation = await f.operation(binding)
  await f.finish(binding)
  await assert.rejects(f.claim(second), { code: 'DYNAMIC_RESOURCE_BUSY' })
  await f.command('operation.cancelPrepared', { binding, operationId: operation.operationId, key: operation.key, reason: 'fixture-proven-not-dispatched' })
  await f.finish(await f.claim(second))
})

test('execution 与既有独立 operation 在相同资源上互斥', async t => {
  const f = await fixture(t), legacyOwner = await f.task('legacy')
  const legacy = await f.operation(legacyOwner, ['uat2'])
  await f.command('operation.start', { binding: legacyOwner, operationId: legacy.operationId })
  const execution = await f.dispatch(await f.task('execution'), ['uat2'])
  await assert.rejects(f.claim(execution), { code: 'DYNAMIC_RESOURCE_BUSY' })
  await f.command('operation.settle', { binding: legacyOwner, operationId: legacy.operationId, state: 'succeeded' })
  const binding = await f.claim(execution)
  const next = await f.operation(legacyOwner, ['uat2'])
  await assert.rejects(f.command('operation.start', { binding: legacyOwner, operationId: next.operationId }), { code: 'DYNAMIC_RESOURCE_BUSY' })
  await f.finish(binding)
  await f.command('operation.start', { binding: legacyOwner, operationId: next.operationId })
  await f.command('operation.settle', { binding: legacyOwner, operationId: next.operationId, state: 'succeeded' })
  assert.deepEqual(await f.query({ kind: 'resource.list' }), [])
})

test('查询暴露真实持有者与等待资源，queued 回执不冒充持锁', async t => {
  const f = await fixture(t), first = await f.dispatch(await f.task('first'), ['uat2'])
  const second = await f.dispatch(await f.task('second'), ['uat2'])
  const read = execution => f.query({ kind: 'execution.get', executionId: execution.executionId })
  assert.deepEqual((await read(first)).resources, { state: 'available', keys: ['uat2'], holder: null, blocking: [] })
  const binding = await f.claim(first)
  const holder = `execution:${first.executionId}`
  assert.deepEqual((await read(first)).resources, { state: 'held', keys: ['uat2'], holder, blocking: [] })
  const waiting = { state: 'waiting', keys: ['uat2'], holder: null, blocking: [{ resourceKey: 'uat2', holder }] }
  assert.deepEqual((await read(second)).resources, waiting)
  assert.deepEqual((await f.query({ kind: 'execution.list', taskId: second.taskId }))[0].resources, waiting)
  assert.deepEqual((await f.query({ kind: 'task.blockers', taskId: second.taskId })).executions[0].resources, waiting)
  await f.finish(binding)
  assert.deepEqual((await read(first)).resources, { state: 'released', keys: ['uat2'], holder: null, blocking: [] })
  assert.equal((await read(second)).resources.state, 'available')
  await f.finish(await f.claim(second))
})

test('失败或取消在确认执行排空后释放，不把无副作用终态永久占用', async t => {
  for (const terminal of ['failure', 'cancel']) {
    const f = await fixture(t), first = await f.dispatch(await f.task(`first-${terminal}`), ['uat2'])
    const second = await f.dispatch(await f.task(`second-${terminal}`), ['uat2'])
    const binding = await f.claim(first)
    if (terminal === 'failure') await f.command('execution.result', { binding, error: { code: 'FIXTURE_ERROR' } })
    else await f.command('execution.cancel', { binding })
    await assert.rejects(f.claim(second), { code: 'DYNAMIC_RESOURCE_BUSY' })
    await f.command('execution.drained', { binding })
    await f.finish(await f.claim(second))
  }
})

test('多个未知效果须全部对账，最后一个完成也不能释放仍运行的只读续办', async t => {
  const f = await fixture(t), owner = await f.task('owner')
  const first = await f.dispatch(owner, ['uat2'])
  const second = await f.dispatch(await f.task('second'), ['uat2'])
  const binding = await f.claim(first), effects = []
  for (let index = 0; index < 2; index++) {
    const effect = await f.operation(binding)
    await f.command('operation.start', { binding, operationId: effect.operationId })
    await f.command('operation.settle', { binding, operationId: effect.operationId, state: 'unknown' })
    effects.push(effect)
  }
  await f.finish(binding)
  await f.command('operation.reconcile', { operationId: effects[0].operationId, state: 'failed', evidenceRef: 'fixture-first-readback' })
  await assert.rejects(f.claim(second), { code: 'DYNAMIC_RESOURCE_BUSY' })
  const continued = (await f.command('execution.continue', { binding: owner, executionId: first.executionId, key: 'readback', prompt: '验证原效果', definition: { recoveryReadOnly: true } })).result.execution
  const readback = await f.claim(continued)
  await f.command('operation.reconcile', { operationId: effects[1].operationId, state: 'failed', evidenceRef: 'fixture-second-readback' })
  await assert.rejects(f.claim(second), { code: 'DYNAMIC_RESOURCE_BUSY' })
  await f.finish(readback)
  await f.finish(await f.claim(second))
})

test('原 job 失败对账路径释放父执行锁并保留部分效果的不确定性', async t => {
  const f = await fixture(t), owner = await f.task('owner')
  const first = await f.dispatch(owner, ['uat2'])
  const second = await f.dispatch(await f.task('second'), ['uat2'])
  const binding = await f.claim(first), effect = await f.operation(binding)
  await f.command('operation.start', { binding, operationId: effect.operationId })
  await f.command('operation.job', { binding, operationId: effect.operationId, job: { jobId: 'original-job', owner: binding.sessionId, startedAt: 1, status: 'killed', finishedAt: 2 } })
  await f.command('operation.settle', { binding, operationId: effect.operationId, state: 'unknown', result: { reason: 'cancelled-with-partial-effects' } })
  await f.finish(binding)
  await assert.rejects(f.claim(second), { code: 'DYNAMIC_RESOURCE_BUSY' })
  const reconciled = (await f.command('operation.reconcile-job', { binding: owner, operationId: effect.operationId })).result.operation
  assert.equal(reconciled.state, 'failed')
  assert.equal(reconciled.result.partialEffectsPossible, true)
  assert.equal(reconciled.result.previousObservation.reason, 'cancelled-with-partial-effects')
  await f.finish(await f.claim(second))
})

test('任务控制或需求修订取消最后一个 prepared 操作时释放已排空执行', async t => {
  for (const action of ['cancelled', 'paused', 'revise']) {
    const f = await fixture(t), first = await f.dispatch(await f.task(`first-${action}`), ['uat2'])
    const second = await f.dispatch(await f.task(`second-${action}`), ['uat2'])
    const binding = await f.claim(first), operation = await f.operation(binding)
    await f.finish(binding)
    await assert.rejects(f.claim(second), { code: 'DYNAMIC_RESOURCE_BUSY' })
    if (action === 'revise') await f.command('task.revise', { taskId: first.taskId, request: '修订目标，旧操作不再启动' })
    else await f.command('task.control', { taskId: first.taskId, control: action })
    assert.equal((await f.query({ kind: 'operation.get', operationId: operation.operationId })).state, 'cancelled')
    await f.finish(await f.claim(second))
  }
})

test('多执行资源视图每次公开查询最多读取一次锁表，并在释放后读取新状态', async t => {
  const f = await fixture(t), owner = await f.task('owner'), executions = [], bindings = []
  for (let index = 0; index < 12; index++) {
    const pair = index % 6
    executions.push(await f.dispatch(owner, [`cluster:${pair}`, `repository:${pair}`], `deploy-${index}`))
  }
  for (const execution of executions.slice(0, 6)) bindings.push(await f.claim(execution))

  // 数真实 statement 读取，而非只数 prepare，避免缓存语句掩盖逐执行/逐键查询。
  const originalPrepare = DatabaseSync.prototype.prepare
  let counting = false, resourceReads = 0
  const observations = []
  const prepareMock = t.mock.method(DatabaseSync.prototype, 'prepare', function (sql, ...args) {
    const statement = Reflect.apply(originalPrepare, this, [sql, ...args])
    if (!/^\s*SELECT\b/i.test(sql) || !/\bdynamic_resource_locks\b/i.test(sql)) return statement
    return new Proxy(statement, { get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      return (...parameters) => {
        if (counting && ['all', 'get', 'iterate'].includes(property)) resourceReads++
        return Reflect.apply(value, target, parameters)
      }
    } })
  })
  t.after(() => prepareMock.mock.restore())
  async function read(args) {
    resourceReads = 0; counting = true
    try { return await f.query(args) }
    finally {
      counting = false
      observations.push({ query: args.kind, resourceReads })
      assert.ok(resourceReads <= 1, `${args.kind} 执行了 ${resourceReads} 次资源表 SELECT，应与执行数和资源数无关`)
    }
  }
  function assertInitial(view, index) {
    const pair = index % 6, holder = `execution:${executions[pair].executionId}`
    const keys = [`cluster:${pair}`, `repository:${pair}`]
    assert.deepEqual(view.resources, index < 6
      ? { state: 'held', keys, holder, blocking: [] }
      : { state: 'waiting', keys, holder: null, blocking: keys.map(resourceKey => ({ resourceKey, holder })) })
  }

  const initialList = await read({ kind: 'execution.list' })
  assert.equal(initialList.length, executions.length)
  executions.forEach((execution, index) => assertInitial(initialList.find(view => view.executionId === execution.executionId), index))
  assertInitial(await read({ kind: 'execution.get', executionId: executions[7].executionId }), 7)
  const initialBlockers = await read({ kind: 'task.blockers', taskId: owner.taskId })
  assert.equal(initialBlockers.executions.length, executions.length)
  executions.forEach((execution, index) => assertInitial(initialBlockers.executions.find(view => view.executionId === execution.executionId), index))

  // 写入发生在查询窗口之外；下一次读必须看到释放/新 holder，不能复用旧快照。
  await f.finish(bindings[0])
  const releasedList = await read({ kind: 'execution.list', taskId: owner.taskId })
  assert.equal(releasedList.find(view => view.executionId === executions[0].executionId).resources.state, 'released')
  assert.equal(releasedList.find(view => view.executionId === executions[6].executionId).resources.state, 'available')
  await f.claim(executions[6])
  const current = await read({ kind: 'execution.get', executionId: executions[6].executionId })
  assert.equal(current.resources.state, 'held')
  assert.equal(current.resources.holder, `execution:${executions[6].executionId}`)
  const currentBlockers = await read({ kind: 'task.blockers', taskId: owner.taskId })
  assert.equal(currentBlockers.executions.length, executions.length - 1)
  assert.deepEqual(currentBlockers.executions.find(item => item.executionId === current.executionId).resources, current.resources)
  t.diagnostic(JSON.stringify({ executions: executions.length, declaredKeys: executions.length * 2, observations }))
})

test('目录从受信工作区读取，重名、无效JSON和删除已登记身份明确失败', async t => {
  const root = await mkdtemp(join(tmpdir(), 'resource-catalog-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.equal(await readExecutionResourceCatalog(root), null)
  await mkdir(join(root, '.dsh'))
  const file = join(root, '.dsh', 'shared-resources.json')
  await writeFile(file, JSON.stringify(catalog))
  assert.equal((await readExecutionResourceCatalog(root)).resources.length, 3)
  await writeFile(file, '{bad-json')
  await assert.rejects(readExecutionResourceCatalog(root), { code: 'DYNAMIC_RESOURCE_CATALOG_INVALID' })
  await writeFile(file, JSON.stringify({ ...catalog, resources: [...catalog.resources, { ...catalog.resources[0], key: 'duplicate' }] }))
  await assert.rejects(readExecutionResourceCatalog(root), { code: 'DYNAMIC_RESOURCE_CATALOG_AMBIGUOUS' })
  const f = await fixture(t, { resourceCatalog: catalog })
  await assert.rejects(f.reopen({ resourceCatalog: { version: 1, resources: catalog.resources.slice(1) } }), { code: 'DYNAMIC_RESOURCE_CATALOG_REBIND_FORBIDDEN' })
  const rebound = structuredClone(catalog)
  rebound.resources[0].purpose = 'workspace'
  await assert.rejects(f.reopen({ resourceCatalog: rebound }), { code: 'DYNAMIC_RESOURCE_CATALOG_REBIND_FORBIDDEN' })
  await f.reopen({ resourceCatalog: null })
  assert.equal((await f.query({ kind: 'resource.catalog' })).resources.length, 3, '配置暂缺仍保留持久映射')
})

test('同一控制库禁止不同目录的第二活跃Host，追加别名只能在原Host关闭后生效', async t => {
  const f = await fixture(t, { resourceCatalog: catalog })
  const extended = structuredClone(catalog)
  extended.resources[0].aliases.push('new:uat')
  await assert.rejects(f.openAdditional({ resourceCatalog: extended }), { code: 'DYNAMIC_STORE_ALREADY_OPEN' })
  const owner = await f.task('owner')
  await assert.rejects(f.dispatch(owner, ['new:uat'], 'not-loaded', 'publish'), { code: 'DYNAMIC_RESOURCE_UNREGISTERED' })
  await f.reopen({ resourceCatalog: extended })
  const held = await f.claim(await f.dispatch(await f.task('new'), ['new:uat'], 'loaded', 'publish'))
  assert.deepEqual((await f.query({ kind: 'execution.resources', binding: held })).resources.keys, ['publish:example:uat'])
})

test('登记别名在委派、排队、operation及联合获取中使用同一个canonical身份', async t => {
  const f = await fixture(t, { resourceCatalog: catalog }), owner = await f.task('owner')
  const first = await f.dispatch(owner, ['old:uat', 'cluster:example:uat'], 'publish', 'publish')
  assert.deepEqual(first.resourceKeys, ['publish:example:uat'])
  const repeated = await f.dispatch(owner, ['publish:example:uat'], 'publish', 'publish')
  assert.equal(repeated.executionId, first.executionId)
  const binding = await f.claim(first)
  const second = await f.dispatch(await f.task('second'), ['publish:example:other', 'cluster:example:uat'], 'publish', 'publish')
  const queued = await f.query({ kind: 'execution.get', executionId: second.executionId })
  assert.equal(queued.resources.state, 'waiting')
  assert.deepEqual(queued.resources.blocking, [{ resourceKey: 'publish:example:uat', holder: `execution:${first.executionId}` }])
  await assert.rejects(f.claim(second), { code: 'DYNAMIC_RESOURCE_BUSY' })
  assert.equal((await f.query({ kind: 'resource.list' })).length, 1, '多键失败不留下另一目标的部分锁')
  const operation = await f.operation(binding, ['cluster:example:uat'])
  assert.deepEqual(operation.resourceKeys, ['publish:example:uat'])
  await f.command('operation.start', { binding, operationId: operation.operationId })
  await f.command('operation.settle', { binding, operationId: operation.operationId, state: 'succeeded', result: { ok: true } })
  await f.finish(binding)
  await f.finish(await f.claim(second))
  await assert.rejects(f.dispatch(owner, ['invented:uat'], 'bad-key', 'publish'), { code: 'DYNAMIC_RESOURCE_UNREGISTERED' })
})

test('本地准备不能占发布资源或通过operation绕过阶段，动态文件锁仍可用', async t => {
  const f = await fixture(t, { resourceCatalog: catalog }), owner = await f.task('owner')
  await assert.rejects(f.dispatch(owner, ['old:uat']), { code: 'DYNAMIC_RESOURCE_PHASE_MISMATCH' })
  const prepared = await f.dispatch(owner, []), binding = await f.claim(prepared)
  assert.equal((await f.query({ kind: 'execution.resources', binding })).resourcePhase, 'prepare')
  await assert.rejects(f.operation(binding, ['old:uat']), { code: 'DYNAMIC_RESOURCE_PHASE_MISMATCH' })
  const file = await f.operation(binding, ['file:isolated-worktree/README.md'])
  await f.command('operation.start', { binding, operationId: file.operationId })
  assert.deepEqual((await f.query({ kind: 'resource.list' })).map(row => row.resourceKey), ['file:isolated-worktree/README.md'])
  await f.command('operation.settle', { binding, operationId: file.operationId, state: 'succeeded', result: {} })
  await f.finish(binding)
  const publish = await f.claim(await f.dispatch(owner, [], 'undeclared-publish', 'publish'))
  await assert.rejects(f.operation(publish, ['old:uat']), { code: 'DYNAMIC_RESOURCE_SCOPE_EXPANSION' })
})

test('切换发布阶段必须原执行及全部effect排空，原会话联合获取且不重放原效果', async t => {
  const f = await fixture(t, { resourceCatalog: catalog }), owner = await f.task('owner')
  const execution = await f.dispatch(owner, ['old:integration'], 'prepare'), binding = await f.claim(execution)
  const args = { binding: owner, executionId: execution.executionId, key: 'publish', prompt: '使用准备好的源码发布', input: {},
    resourcePhase: 'publish', resourceKeys: ['old:uat', 'publish:example:other'] }
  await assert.rejects(f.command('execution.continue', args), { code: 'DYNAMIC_EXECUTION_BUSY' })
  const pending = await f.operation(binding)
  await f.command('operation.start', { binding, operationId: pending.operationId })
  await f.command('operation.settle', { binding, operationId: pending.operationId, state: 'unknown' })
  await f.finish(binding)
  await assert.rejects(f.command('execution.continue', args), { code: 'DYNAMIC_OPERATION_UNRESOLVED' })
  await assert.rejects(f.command('execution.continue', { ...args, definition: { recoveryReadOnly: true } }), { code: 'DYNAMIC_EXECUTION_RESOURCES_HELD' })
  await f.command('operation.reconcile', { operationId: pending.operationId, state: 'succeeded', result: { verified: true }, evidenceRef: 'original-effect-receipt' })
  const next = (await f.command('execution.continue', args)).result.execution
  assert.equal(next.executionId, execution.executionId)
  assert.equal(next.sessionId, execution.sessionId)
  assert.equal(next.resourcePhase, 'publish')
  const publishBinding = await f.claim(next)
  assert.deepEqual((await f.query({ kind: 'execution.resources', binding: publishBinding })).resources.keys, ['publish:example:other', 'publish:example:uat'])
  assert.equal((await f.query({ kind: 'operation.list' })).length, 1, '阶段切换不生成或重放原效果')
  await f.finish(publishBinding)
})

test('升级前多个旧别名持有者全部保留，任一未排空时新canonical请求仍等待', async t => {
  const f = await fixture(t), first = await f.dispatch(await f.task('old-a'), ['old:uat'], 'old-a', 'publish')
  const second = await f.dispatch(await f.task('old-b'), ['cluster:example:uat'], 'old-b', 'publish')
  const firstBinding = await f.claim(first), secondBinding = await f.claim(second)
  const effect = await f.operation(firstBinding, ['old:uat'])
  await f.command('operation.start', { binding: firstBinding, operationId: effect.operationId })
  await f.command('execution.result', { binding: firstBinding, output: { status: 'verified' } })
  const before = await f.query({ kind: 'resource.list' })
  await f.reopen({ resourceCatalog: catalog })
  assert.deepEqual(await f.query({ kind: 'resource.list' }), before, '启动不重写或删除历史锁行')
  const next = await f.dispatch(await f.task('new'), ['publish:example:uat'], 'new', 'publish')
  assert.equal((await f.query({ kind: 'execution.get', executionId: next.executionId })).resources.blocking.length, 2)
  const original = await f.query({ kind: 'execution.get', executionId: first.executionId })
  assert.equal(original.status, 'succeeded')
  assert.equal(original.drained, false)
  assert.equal(original.resources.blocking.length, 1)
  assert.equal(original.resources.state, 'waiting', '结果已提交但锁尚未释放，别名冲突不能误报released或独占held')
  assert.equal(original.resources.holder, `execution:${first.executionId}`)
  await assert.rejects(f.claim(next), { code: 'DYNAMIC_RESOURCE_BUSY' })
  await f.command('execution.drained', { binding: firstBinding })
  await f.command('execution.drained', { binding: secondBinding })
  await assert.rejects(f.claim(next), { code: 'DYNAMIC_RESOURCE_BUSY' }, '旧执行排空不掩盖旧未知效果')
  const unknown = await f.query({ kind: 'operation.get', operationId: effect.operationId })
  assert.equal(unknown.state, 'unknown')
  assert.deepEqual(unknown.resourceKeys, ['old:uat'], '历史操作身份保持不变')
  await f.command('operation.reconcile', { operationId: effect.operationId, state: 'succeeded', result: { verified: true }, evidenceRef: 'old-effect-terminal' })
  await f.finish(await f.claim(next))
})

test('旧独立operation的别名锁在目录安装与文件缺失后都继续阻塞canonical请求', async t => {
  const f = await fixture(t), binding = await f.task('legacy-operation')
  const effect = await f.operation(binding, ['old:uat'])
  await f.command('operation.start', { binding, operationId: effect.operationId })
  const originalLocks = await f.query({ kind: 'resource.list' })
  await f.reopen({ resourceCatalog: catalog })
  await f.reopen({ resourceCatalog: null })
  assert.deepEqual(await f.query({ kind: 'resource.list' }), originalLocks)
  const pending = await f.dispatch(await f.task('publisher'), ['cluster:example:uat'], 'publish', 'publish')
  await assert.rejects(f.claim(pending), { code: 'DYNAMIC_RESOURCE_BUSY' })
  await f.command('operation.reconcile', { operationId: effect.operationId, state: 'failed', result: { verified: true }, evidenceRef: 'old-independent-operation-readback' })
  await f.finish(await f.claim(pending))
})

test('旧无phase委派和续办同key重入仍核验原摘要，归一别名不重放历史效果', async t => {
  const f = await fixture(t), owner = await f.task('legacy-owner')
  const execution = await f.dispatch(owner, ['old:uat'], 'initial')
  const binding = await f.claim(execution), effect = await f.operation(binding)
  await f.command('operation.start', { binding, operationId: effect.operationId })
  await f.command('operation.settle', { binding, operationId: effect.operationId, state: 'succeeded', result: { receipt: 'original' } })
  await f.finish(binding)
  const continuation = { binding: owner, executionId: execution.executionId, key: 'continued', prompt: '旧版续办核验', input: {}, resourceKeys: ['old:uat'] }
  const next = (await f.command('execution.continue', continuation, 'legacy-continue-receipt')).result.execution
  await f.finish(await f.claim(next))
  await f.command('task.drained', { binding: owner })
  const oldDigest = value => createHash('sha256').update(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex')
  const upgradeRecord = record => {
    delete record.resourcePhase
    record.dispatchDigest = oldDigest({ prompt: '验证指定资源', input: {}, definition: null, resourceKeys: ['old:uat'], requirementRevision: 1, controlRevision: 1 })
    for (const item of record.continuations ?? []) {
      delete item.resourcePhase
      item.digest = oldDigest({ prompt: continuation.prompt, input: {}, resourceKeys: ['old:uat'], requirementRevision: 1, controlRevision: 1 })
    }
    return record
  }
  await f.restoreLegacyFixture(db => {
    for (const row of db.prepare('SELECT id,body FROM dynamic_executions').all()) {
      db.prepare('UPDATE dynamic_executions SET body=? WHERE id=?').run(JSON.stringify(upgradeRecord(JSON.parse(row.body))), row.id)
    }
    for (const row of db.prepare('SELECT id,body FROM dynamic_receipts').all()) {
      const body = JSON.parse(row.body)
      if (body.result?.execution) {
        upgradeRecord(body.result.execution)
        db.prepare('UPDATE dynamic_receipts SET body=? WHERE id=?').run(JSON.stringify(body), row.id)
      }
    }
  }, { resourceCatalog: catalog })
  const originalReceipt = await f.query({ kind: 'receipt.get', id: 'legacy-continue-receipt' })
  const currentOwner = (await f.command('task.claim', { taskId: owner.taskId })).result.binding
  const replay = await f.dispatch(currentOwner, ['cluster:example:uat'], 'initial')
  assert.equal(replay.executionId, execution.executionId)
  const resumed = (await f.command('execution.continue', { ...continuation, binding: currentOwner, resourceKeys: ['publish:example:uat'] })).result.execution
  assert.equal(resumed.inputVersion, 2)
  assert.equal(resumed.leaseEpoch, 2)
  assert.equal(resumed.resourcePhase, undefined, '幂等回执不补写旧执行的phase')
  assert.equal((await f.query({ kind: 'operation.list' })).length, 1)
  assert.equal((await f.query({ kind: 'operation.get', operationId: effect.operationId })).result.receipt, 'original')
  assert.deepEqual(await f.query({ kind: 'receipt.get', id: 'legacy-continue-receipt' }), originalReceipt)
  await assert.rejects(f.command('execution.continue', { ...continuation, binding: currentOwner, prompt: '换目标' }), { code: 'DYNAMIC_DISPATCH_KEY_CONFLICT' })
})
