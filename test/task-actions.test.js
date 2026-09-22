import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskActionCoordinator, taskActions } from '../packages/dingtalk-dsh-assistant/task-actions.js'

const input = (patch = {}) => ({ taskId: 't1', adapterId: 'fixture-write', inputVersion: 1, runSequence: 1, params: { resources: ['db/a'], value: 1 }, authorizationRefs: ['source-1'], ...patch })
function fixture(options = {}) {
  const tasks = new Map((options.tasks ?? ['t1', 't2', 't3'].map(taskId => ({ taskId, state: 'running', inputVersion: 1, runSequence: 1, executionEvents: [] }))).map(task => [task.taskId, structuredClone(task)]))
  let tail = Promise.resolve(), clock = 1000, allowed = true, closing = false
  const calls = [], reads = [], checks = []
  const store = { listTasks: () => [...tasks.values()].map(task => structuredClone(task)), getTask: taskId => structuredClone(tasks.get(taskId)), async updateTask(taskId, fn) { tasks.set(taskId, fn(structuredClone(tasks.get(taskId)))); return this.getTask(taskId) } }
  const adapter = {
    parseParams: params => { if (!Array.isArray(params.resources) || typeof params.value !== 'number') throw new Error('invalid fixture parameters'); return params },
    normalizeResourceKeys: params => params.resources.map(value => value.toLowerCase()),
    async execute(intent) { calls.push(intent); return options.execute?.(intent) ?? { status: 'submitted' } },
    async reconcile(intent) { reads.push(intent); return options.reconcile?.(intent) ?? { status: 'confirmed', receiptRefs: ['readback-1'] } },
  }
  const dependencies = { store, serialize(fn) { const run = tail.then(fn); tail = run.catch(() => {}); return run }, adapters: new Map([['fixture-write', adapter]]),
    async authorize(context) { checks.push(context); return options.authorize ? options.authorize(context) : allowed }, isCancelled: task => task.stopRequested === true, isClosing: () => closing, now: () => clock }
  return { store, coordinator: createTaskActionCoordinator(dependencies), restart: () => createTaskActionCoordinator(dependencies), calls, reads, checks,
    setAllowed: value => { allowed = value }, setClosing: value => { closing = value }, advance: value => { clock += value }, change: (taskId, fields) => store.updateTask(taskId, task => ({ ...task, ...fields })) }
}

test('Host 注册、参数校验与授权先于任何持久动作或副作用', async () => {
  const f = fixture()
  await assert.rejects(f.coordinator.prepare(input({ adapterId: 'shell' })), /adapter_unregistered/)
  await assert.rejects(f.coordinator.prepare(input({ params: { command: 'arbitrary command' } })), /invalid fixture parameters/)
  f.setAllowed(false)
  await assert.rejects(f.coordinator.prepare(input()), /unauthorized/)
  assert.equal(f.coordinator.list().length, 0)
  assert.equal(f.calls.length, 0)
  assert.equal(f.reads.length, 0)
})

test('动作同身份同参数幂等，JSON 键顺序不改变摘要，身份内容冲突拒绝', async () => {
  const f = fixture()
  const first = await f.coordinator.prepare(input({ actionId: 'a1' }))
  const duplicate = await f.coordinator.prepare(input({ actionId: 'a1', params: { value: 1, resources: ['db/a'] } }))
  assert.deepEqual(duplicate, first)
  assert.equal(f.store.getTask('t1').executionEvents.length, 1)
  await assert.rejects(f.coordinator.prepare(input({ actionId: 'a1', params: { resources: ['db/a'], value: 2 } })), /identity_conflict/)
  const [one, two] = await Promise.all([f.coordinator.execute('a1'), f.coordinator.execute('a1')])
  assert.deepEqual(one, two)
  assert.equal(one.status, 'confirmed')
  assert.equal(f.calls.length, 1)
  assert.equal(f.reads.length, 1)
  await f.coordinator.execute('a1')
  assert.equal(f.calls.length, 1)
})

test('跨 Task 全资源原子占用，冲突不占一半，外部调用不锁独立动作', async () => {
  let release, started
  const began = new Promise(resolve => { started = resolve })
  const f = fixture({ execute: intent => intent.taskId === 't1' ? new Promise(resolve => { release = resolve; started() }) : { status: 'submitted' } })
  const a = await f.coordinator.prepare(input({ params: { resources: ['DB/A', 'DB/B'], value: 1 } }))
  const running = f.coordinator.execute(a.actionId)
  await began
  await assert.rejects(f.coordinator.prepare(input({ taskId: 't2', params: { resources: ['db/b', 'db/c'], value: 1 } })), /resource_conflict/)
  assert.equal(f.coordinator.list('t2').length, 0)
  const c = await f.coordinator.prepare(input({ taskId: 't3', params: { resources: ['db/c'], value: 1 } }))
  assert.equal((await f.coordinator.execute(c.actionId)).status, 'confirmed')
  assert.equal(f.coordinator.get(a.actionId).status, 'executing')
  release({ status: 'submitted' })
  await running
  assert.equal(f.calls.length, 2)
})

test('执行前重新检查撤销授权、版本及取消，prepare 不能形成永久许可', async () => {
  for (const change of ['authorization', 'version', 'cancel']) {
    const f = fixture()
    const action = await f.coordinator.prepare(input())
    if (change === 'authorization') f.setAllowed(false)
    if (change === 'version') await f.change('t1', { inputVersion: 2 })
    if (change === 'cancel') await f.change('t1', { stopRequested: true })
    await assert.rejects(f.coordinator.execute(action.actionId), /unauthorized|version_stale|execution_stopped/)
    assert.equal(f.calls.length, 0)
    assert.equal(f.coordinator.get(action.actionId).attempt, 0)
  }
})

test('未知结果永远先对账，时间推移与重启不能盲重放或释放资源', async () => {
  let known = false
  const f = fixture({ execute: () => { throw new Error('response lost after possible write') }, reconcile: () => known ? { status: 'confirmed', receiptRefs: ['target-version-9'] } : { status: 'unknown' } })
  const action = await f.coordinator.prepare(input())
  assert.equal((await f.coordinator.execute(action.actionId)).status, 'unknown')
  const restarted = f.restart()
  f.advance(864000000)
  for (let i = 0; i < 10; i++) await restarted.recover()
  await restarted.execute(action.actionId)
  assert.equal(f.calls.length, 1)
  await assert.rejects(restarted.prepare(input({ taskId: 't2' })), /resource_conflict/)
  known = true
  await f.change('t1', { inputVersion: 2, stopRequested: true })
  assert.equal((await restarted.reconcile(action.actionId)).status, 'confirmed')
  assert.equal(f.checks.at(-1).phase, 'reconcile')
  assert.equal(f.calls.length, 1)
  assert.equal((await restarted.prepare(input({ taskId: 't2' }))).status, 'prepared')
})

test('结果确认要求独立读回证据，执行成功或缺失证据不构成 confirmed', async () => {
  const f = fixture({ execute: () => ({ status: 'confirmed', receiptRefs: ['execute-self-claim'] }), reconcile: () => ({ status: 'confirmed', receiptRefs: [] }) })
  const action = await f.coordinator.prepare(input())
  const result = await f.coordinator.execute(action.actionId)
  assert.equal(result.status, 'unknown')
  assert.equal(f.reads.length, 1)
  await assert.rejects(f.coordinator.prepare(input({ taskId: 't2' })), /resource_conflict/)
})

test('已证明未生效的失败才重试，持久预算最多三次，每次重验授权', async () => {
  const f = fixture({ execute: () => ({ status: 'failed', definitelyNotApplied: true, retryable: true, receiptRefs: ['adapter-no-write-proof'] }) })
  const action = await f.coordinator.prepare(input())
  assert.equal((await f.coordinator.execute(action.actionId)).nextRetryAt, 3000)
  await f.coordinator.execute(action.actionId)
  assert.equal(f.calls.length, 1)
  f.advance(2000)
  f.setAllowed(false)
  await assert.rejects(f.coordinator.execute(action.actionId), /unauthorized/)
  assert.equal(f.calls.length, 1)
  f.setAllowed(true)
  assert.equal((await f.restart().execute(action.actionId)).attempt, 2)
  f.advance(10000)
  assert.equal((await f.restart().execute(action.actionId)).attempt, 3)
  f.advance(100000)
  assert.equal((await f.restart().execute(action.actionId)).retryable, false)
  assert.equal(f.calls.length, 3)
})

test('失败的可重试声明没有未生效证据时不能重试', async () => {
  const f = fixture({ execute: () => ({ status: 'failed', definitelyNotApplied: true, retryable: true }), reconcile: () => ({ status: 'unknown' }) })
  const action = await f.coordinator.prepare(input())
  assert.equal((await f.coordinator.execute(action.actionId)).status, 'unknown')
  f.advance(100000)
  await f.restart().execute(action.actionId)
  assert.equal(f.calls.length, 1)
})

test('恢复未执行 prepared 不自动发起写操作，读回授权拒绝不释放未知占用', async () => {
  const f = fixture({ reconcile: () => ({ status: 'unknown' }) })
  const action = await f.coordinator.prepare(input())
  assert.deepEqual(await f.restart().recover(), [])
  assert.equal(f.calls.length, 0)
  await f.coordinator.execute(action.actionId)
  f.setAllowed(false)
  const recovered = await f.restart().recover()
  assert.equal(recovered[0].status, 'rejected')
  assert.match(recovered[0].reason.message, /unauthorized/)
  assert.equal(f.coordinator.get(action.actionId).status, 'unknown')
})

test('持久取消只释放未执行或明确未生效的动作，未知动作保留占用与读回', async () => {
  const f = fixture({ reconcile: () => ({ status: 'unknown' }) })
  const prepared = await f.coordinator.prepare(input({ actionId: 'prepared' }))
  const uncertain = await f.coordinator.prepare(input({ actionId: 'unknown', params: { resources: ['db/unknown'], value: 1 } }))
  await f.coordinator.execute(uncertain.actionId)
  await assert.rejects(f.coordinator.cancelPrepared('t1'), /cancellation_required/)
  const stopRequest = { requestId: 'cancel-1', sourceRefs: ['message-cancel-1'] }
  await f.change('t1', { stopRequested: true, stopRequest })
  const cancelled = await f.coordinator.cancelPrepared('t1')
  assert.equal(cancelled.length, 1)
  assert.equal(cancelled[0].actionId, prepared.actionId)
  assert.equal(cancelled[0].retryable, false)
  assert.deepEqual(cancelled[0].stopRequest, stopRequest)
  assert.deepEqual(cancelled[0].authorizationRefs, ['source-1'])
  assert.equal(f.coordinator.get(uncertain.actionId).status, 'unknown')
  assert.deepEqual(await f.coordinator.cancelPrepared('t1'), [])
  await f.coordinator.prepare(input({ taskId: 't2' }))
  await assert.rejects(f.coordinator.prepare(input({ taskId: 't3', params: { resources: ['db/unknown'], value: 1 } })), /resource_conflict/)
  await f.coordinator.reconcile(uncertain.actionId)
  assert.equal(f.calls.length, 1)
  assert.equal(f.reads.length, 2)
})

test('明确未生效但待重试动作在取消后不再调用适配器', async () => {
  const f = fixture({ execute: () => ({ status: 'failed', definitelyNotApplied: true, retryable: true, receiptRefs: ['no-write'] }) })
  const action = await f.coordinator.prepare(input())
  await f.coordinator.execute(action.actionId)
  await f.change('t1', { stopRequested: true })
  assert.equal((await f.coordinator.cancelPrepared('t1'))[0].error, 'task_action_cancelled')
  f.advance(100000)
  await f.restart().execute(action.actionId)
  assert.equal(f.calls.length, 1)
})

test('Host 关闭期间迟到结果不再读回外部目标或写入存储，重启从 executing 对账', async () => {
  let finish, entered
  const began = new Promise(resolve => { entered = resolve })
  const f = fixture({ execute: () => new Promise(resolve => { finish = resolve; entered() }) })
  const intent = await f.coordinator.prepare(input())
  const running = f.coordinator.execute(intent.actionId)
  await began
  const before = f.store.getTask('t1').executionEvents.length
  f.setClosing(true)
  finish({ status: 'submitted' })
  assert.equal((await running).status, 'executing')
  assert.equal(f.store.getTask('t1').executionEvents.length, before)
  assert.equal(f.reads.length, 0)
  await assert.rejects(f.coordinator.prepare(input({ taskId: 't2' })), /runtime_closed/)
  await assert.rejects(f.coordinator.execute(intent.actionId), /runtime_closed/)
  f.setClosing(false)
  await f.restart().recover()
  assert.equal(f.coordinator.get(intent.actionId).status, 'confirmed')
  assert.equal(f.calls.length, 1)
})

test('子进程已写外部目标后退出，executing 恢复只读回且不重放', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'task-action-crash-'))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const taskFile = join(folder, 'task.json'), targetFile = join(folder, 'target.txt')
  const moduleUrl = new URL('../packages/dingtalk-dsh-assistant/task-actions.js', import.meta.url).href
  const script = `
    import { writeFileSync } from 'node:fs';
    import { createTaskActionCoordinator } from ${JSON.stringify(moduleUrl)};
    let task = { taskId:'t1',state:'running',inputVersion:1,runSequence:1,executionEvents:[] };
    const store={ getTask:()=>structuredClone(task),listTasks:()=>[structuredClone(task)],async updateTask(id,fn){task=fn(task);writeFileSync(process.argv[1],JSON.stringify(task));return task} };
    const adapter={parseParams:x=>x,normalizeResourceKeys:()=>['target'],async execute(){writeFileSync(process.argv[2],'written-once');process.exit(23)},async reconcile(){throw new Error('must restart')}};
    const actions=createTaskActionCoordinator({store,serialize:fn=>fn(),adapters:new Map([['fixture-write',adapter]]),authorize:()=>true,isCancelled:()=>false});
    await actions.prepare(${JSON.stringify(input({ actionId: 'crash-action' }))});
    await actions.execute('crash-action');
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, taskFile, targetFile], { encoding: 'utf8', timeout: 10000 })
  assert.equal(child.status, 23, child.stderr)
  const durable = JSON.parse(readFileSync(taskFile, 'utf8'))
  assert.equal(taskActions(durable)[0].status, 'executing')
  const f = fixture({ tasks: [durable], execute: () => { throw new Error('duplicate write forbidden') }, reconcile: () => ({ status: readFileSync(targetFile, 'utf8') === 'written-once' ? 'confirmed' : 'unknown', receiptRefs: ['target-file-readback'] }) })
  await f.coordinator.recover()
  await f.coordinator.execute('crash-action')
  assert.equal(f.coordinator.get('crash-action').status, 'confirmed')
  assert.equal(f.calls.length, 0)
  assert.equal(f.reads.length, 1)
  assert.equal(readFileSync(targetFile, 'utf8'), 'written-once')
})
