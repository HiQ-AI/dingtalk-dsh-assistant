import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { createMessageWorkflow } from '../packages/dingtalk-dsh-assistant/message-workflow.js'

// 本文件只验证来源和执行层。协调语义使用真实 native 会话的 message-coordinator.test.js 验证。
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'message-dispatch-'))
  const db = { dbPath: join(dir, 'control.sqlite'), instanceId: randomUUID() }
  let store = await openExecutionStore({ ...db, initialize: true })
  let workflow
  const coordinator = {
    async process(runId, { dispatch }) { await dispatch(runId); return store.query({ kind: 'message.run', runId }) },
    async wake(runId, options) { return this.process(runId, options) },
    async recover({ dispatch }) { for (const run of await store.query({ kind: 'message.pending' })) await dispatch(run.runId) },
    async close() {},
  }
  const build = () => createMessageWorkflow({ store, coordinator, ...options })
  workflow = build()
  const call = async (kind, args) => (await store.command({ id: randomUUID(), kind: `message.${kind}`, args })).result
  t.after(async () => { await workflow.close(); await store.close(); await rm(dir, { recursive: true, force: true }) })
  return {
    get store() { return store }, get workflow() { return workflow }, call,
    async reopen() { await workflow.close(); await store.close(); store = await openExecutionStore(db); workflow = build() },
    async editSnapshot(edit) { await workflow.close(); await store.close(); const connection = new DatabaseSync(db.dbPath); try { edit(connection) } finally { connection.close() }; store = await openExecutionStore(db); workflow = build() },
    async seed(runId = 'm', commands = [{ commandId: `${runId}-answer`, kind: 'answer', args: {} }], extra = {}) {
      await workflow.receive({ runId, sourceKey: runId, sourceVersion: 1, conversationId: 'g', actorId: 'a', body: '核对审核状态', ...extra.source }, { process: false })
      await call('split', { runId, units: [{ unitId: `${runId}-unit`, goalText: '核对审核状态', contextNeeds: extra.needs ?? [] }] })
      await call('accept', { runId, unitId: `${runId}-unit`, commands })
      return runId
    },
  }
}

test('唯一语义入口必须是常驻协调器，旧 judge 不能替代', () => {
  assert.throws(() => createMessageWorkflow({ store: { command() {}, query() {} }, judge() {} }), /MESSAGE_DEPENDENCIES_REQUIRED/)
})

test('receive 重复来源幂等，不重复命令；重启恢复不重复执行', async t => {
  let calls = 0
  const f = await fixture(t, { handlers: { answer: async () => ({ reply: `结果${++calls}` }) } })
  await f.seed()
  await f.workflow.receive({ runId: 'm', sourceKey: 'm', sourceVersion: 1, conversationId: 'g', actorId: 'a', body: '核对审核状态' }, { process: false })
  await Promise.all([f.workflow.process('m'), f.workflow.process('m')])
  assert.equal(calls, 1)
  assert.equal((await f.workflow.state('m')).commands[0].status, 'applied')
  await f.reopen(); await f.workflow.recover()
  assert.equal(calls, 1)
  assert.equal((await f.workflow.state('m')).commands.length, 1)
})

test('handler 效果未知持久保留，重启不得自动重派', async t => {
  let calls = 0
  const f = await fixture(t, { handlers: { answer: async () => { calls++; throw new Error('transport_lost_after_effect') } } })
  await f.seed(); await f.workflow.process('m')
  assert.equal((await f.workflow.state('m')).commands[0].status, 'unknown')
  await f.reopen(); await f.workflow.recover(); await f.workflow.process('m')
  assert.equal(calls, 1)
  assert.equal((await f.workflow.state('m')).commands[0].status, 'unknown')
})

test('依赖命令必须等待前置完成，拒绝的前置不能派发后继', async t => {
  const order = []
  const f = await fixture(t, { context: { validateAction: action => ({ allowed: action.objective !== '禁止', reason: '权限拒绝' }) }, handlers: { answer: async action => { order.push(action.objective); return { reply: action.objective } } } })
  await f.seed('m', [
    { commandId: 'first', kind: 'answer', args: { objective: '先查' } },
    { commandId: 'second', kind: 'answer', args: { objective: '后答' }, dependsOn: ['first'] },
  ])
  await f.workflow.process('m'); assert.deepEqual(order, ['先查', '后答'])
  await f.seed('n', [
    { commandId: 'denied', kind: 'answer', args: { objective: '禁止' } },
    { commandId: 'dependent', kind: 'answer', args: { objective: '不应执行' }, dependsOn: ['denied'] },
  ])
  await f.workflow.process('n')
  assert.deepEqual((await f.workflow.state('n')).commands.map(c => c.status), ['rejected', 'rejected'])
  assert.deepEqual(order, ['先查', '后答'])
})

test('已有空材料命令继承持久事项材料，系统读取失败等待；重启可恢复', async t => {
  let ready = false, calls = 0
  const f = await fixture(t, {
    context: { material: async ({ needs, unit }) => { assert.equal(unit.id, 'm-unit'); assert.deepEqual(needs.map(n => n.resourceRef), ['file:sheet']); return ready ? { ready: true, data: { rows: ['完整材料'] } } : { ready: false, reason: 'MATERIAL_READ_FAILED:temporary' } } },
    handlers: { answer: async action => { calls++; assert.deepEqual(action.requiredExecutionMaterials, ['file:sheet']); return { reply: '已核对' } } },
  })
  await f.seed('m', undefined, { needs: [{ resourceRef: 'file:sheet', reason: '核对所需表格' }] })
  await f.workflow.process('m')
  const waiting = await f.workflow.state('m')
  assert.equal(calls, 0); assert.equal(waiting.commands[0].status, 'pending')
  assert.equal(waiting.requests[0].status, 'pending'); assert.match(waiting.requests[0].question, /MATERIAL_READ_FAILED/)
  await f.reopen(); ready = true; await f.workflow.recover()
  assert.equal(calls, 1)
  const done = await f.workflow.state('m')
  assert.equal(done.requests[0].status, 'resolved'); assert.equal(done.commands[0].status, 'applied')
})

test('不完整材料不能以 ready 绕过执行合同', async t => {
  let calls = 0
  const f = await fixture(t, { context: { material: async () => ({ ready: true, data: { projection: { complete: false } } }) }, handlers: { answer: async () => { calls++; return {} } } })
  await f.seed('m', undefined, { needs: [{ resourceRef: 'file:partial' }] }); await f.workflow.process('m')
  assert.equal(calls, 0); assert.equal((await f.workflow.state('m')).requests[0].status, 'pending')
})

test('长执行交还路由队列，另一个消息先完成，原执行提交后不重派', async t => {
  let longInfo, calls = 0
  const f = await fixture(t, { handlers: { answer: async (action, info) => { calls++; if (info.run.runId === 'long') { longInfo = info; return { executionPending: true } } return { reply: '短查询完成' } } } })
  await f.seed('long'); await f.workflow.process('long')
  assert.equal((await f.workflow.state('long')).commands[0].status, 'running')
  await f.seed('short'); await f.workflow.process('short')
  assert.equal((await f.workflow.state('short')).commands[0].status, 'applied')
  await f.call('command.complete', { commandId: longInfo.commandId, leaseEpoch: longInfo.commandLeaseEpoch, result: { reply: '长查询完成' } })
  await f.workflow.commandSettled('long'); await f.workflow.recover()
  assert.equal(calls, 2); assert.equal((await f.workflow.state('long')).commands[0].status, 'applied')
})

test('取消不继承不相关附件等待，关闭后不接受新消息', async t => {
  let cancelled = 0
  const f = await fixture(t, { context: { material: async () => { throw new Error('不应读附件') } }, handlers: { cancel: async () => { cancelled++; return { status: 'cancelled' } } } })
  await f.seed('m', [{ commandId: 'cancel', kind: 'cancel', args: {} }], { needs: [{ resourceRef: 'missing' }] })
  await f.workflow.process('m'); assert.equal(cancelled, 1)
  assert.equal((await f.workflow.state('m')).requests.length, 0)
  await f.workflow.close()
  await assert.rejects(f.workflow.receive({}), /MESSAGE_WORKFLOW_CLOSED/)
})

test('已独立确认的本机出站消息回声被隔离，不进入执行', async t => {
  let calls = 0
  const f = await fixture(t, { handlers: { answer: async () => { calls++; return { reply: '完成' } } } })
  await f.seed('out'); await f.workflow.process('out')
  await f.call('notification.prepare', { runId: 'out', notificationId: 'notice', commandId: 'out-answer', payload: { text: '完成', conversationId: 'g' }, disclosure: { conversationId: 'g', authorizationRef: 'out' } })
  const { notification } = await f.call('notification.claim', { notificationId: 'notice' })
  await f.call('notification.sent', { notificationId: 'notice', leaseEpoch: notification.leaseEpoch, ack: { messageId: 'out-message' } })
  await f.call('notification.readback', { notificationId: 'notice', leaseEpoch: notification.leaseEpoch, evidence: { messageId: 'out-message', conversationId: 'g' } })
  await f.workflow.receive({ runId: 'echo', sourceKey: 'echo', sourceVersion: 1, conversationId: 'g', actorId: 'a', body: '完成', context: { sourceMessageId: 'out-message' } }, { process: false })
  await f.workflow.recover()
  const echo = await f.workflow.state('echo')
  assert.equal(echo.run.status, 'superseded'); assert.equal(echo.run.reason, 'outbound_echo')
  assert.equal(echo.commands.length, 0); assert.equal(calls, 1)
})


test('恢复扫描自动结算已消费零事项的历史屏障且不执行任务', async t => {
 let executed=0
 const f=await fixture(t,{handlers:{answer:async()=>{executed++;return {}}}})
 await f.call('receive',{runId:'zero-history',sourceKey:'zero-history',sourceVersion:1,conversationId:'g',actorId:'a',body:'无需处理',barriers:[{barrierId:'history-fence',targetSourceKey:'task-source'}]})
 const b=(await f.call('coordinator.claim',{conversationId:'g',expectedLeaseEpoch:0,turnId:'zero-turn',sourceRuns:[{runId:'zero-history',sourceVersion:1}]})).binding
 await f.call('coordinator.commit',{conversationId:'g',turnId:b.turnId,leaseEpoch:b.leaseEpoch,decisions:[{runId:'zero-history',sourceVersion:1,units:[]}]})
 await f.editSnapshot(db=>db.prepare("UPDATE message_items SET body=json_set(body,'$.status','pending') WHERE item_id='barrier:history-fence'").run())
 await f.workflow.recover()
 const after=await f.store.query({kind:'message.run',runId:'zero-history'})
 assert.equal(after.barriers[0].status,'resolved');assert.equal(after.run.status,'settled');assert.equal(executed,0)
 assert.equal(after.commands.length,0);assert.equal(after.requests.length,0)
 await f.workflow.recover();assert.equal(executed,0)
})


test('新零事项提交精确通知本轮已解除屏障，普通重扫不重复通知', async t => {
 const notified=[]
 const f=await fixture(t)
 const coordinator={async close(){},async process(runId,{dispatch}){
  const b=(await f.call('coordinator.claim',{conversationId:'g',expectedLeaseEpoch:0,turnId:'new-zero-turn',sourceRuns:[{runId,sourceVersion:1}]})).binding
  await f.call('coordinator.commit',{conversationId:'g',turnId:b.turnId,leaseEpoch:b.leaseEpoch,decisions:[{runId,sourceVersion:1,units:[]}]})
  await dispatch(runId,{resolvedCoordinatorTurnId:b.turnId})
  await dispatch(runId)
  await dispatch(runId,{resolvedCoordinatorTurnId:'another-turn'})
 }}
 const workflow=createMessageWorkflow({store:f.store,coordinator,context:{onBarrierResolved:async barrier=>notified.push(barrier.id)}})
 t.after(()=>workflow.close())
 await workflow.receive({runId:'new-zero',sourceKey:'new-zero',sourceVersion:1,conversationId:'g',actorId:'a',body:'无需动作',barriers:[{barrierId:'new-fence',targetTaskId:'existing-task'}]},{process:false})
 await workflow.process('new-zero')
 assert.deepEqual(notified,['new-fence'])
 const state=await f.store.query({kind:'message.run',runId:'new-zero'})
 assert.equal(state.run.status,'settled');assert.equal(state.commands.length,0)
})
