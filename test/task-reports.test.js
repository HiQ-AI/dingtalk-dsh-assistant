import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskReportQueue, taskReports, taskReportReceipt, taskReportReceiptSchema, classifyTaskReportError } from '../packages/dingtalk-dsh-assistant/task-reports.js'

const value = (changes = {}) => ({ submissionId: 'report1', inputVersion: 2, runSequence: 1, kind: 'stage-completed', stageTask: '核验', summary: '已核验', evidence: ['test passed'], nextStep: '等待', ...changes })
function fixture(options = {}) {
  let task = { taskId: 'task1', state: 'running', inputVersion: 2, runSequence: 1, executionEvents: [], ...options.task }, inputPending = options.inputPending ?? true, tail = Promise.resolve()
  const executed = [], notified = [], suspended = [], errors = []
  const store = { getTask: () => structuredClone(task), async updateTask(id, update) { task = update(structuredClone(task)); return structuredClone(task) } }
  const dependencies = { store, serialize(fn) { const run = tail.then(fn); tail = run.catch(() => {}); return run }, hasPendingInput: () => inputPending,
    async execute(...args) { executed.push(args); return options.execute ? options.execute(...args) : { accepted: true } },
    async suspend(current) { suspended.push(current.taskId) }, async notify(...args) { if (options.notify) await options.notify(...args); notified.push(args) }, onError: (error) => errors.push(error), isClosing: () => false }
  return { queue: createTaskReportQueue(dependencies), restart: () => createTaskReportQueue(dependencies), store, executed, notified, suspended, errors,
    unblock: () => { inputPending = false }, change: (fields) => { task = { ...task, ...fields } } }
}

test('pending报告先落盘，重复提交复用身份，不执行也不通知', async () => {
  const f = fixture()
  const first = await f.queue.submit('task1', 'checkpoint', value())
  const second = await f.queue.submit('task1', 'checkpoint', value())
  assert.equal(first.reviewStatus, 'pending')
  assert.equal(first.contractVersion, 2)
  assert.equal(first.received, true)
  assert.equal(first.applicationStatus, 'pending')
  assert.equal(first.nextAction, 'wait-for-resolution')
  assert.equal('accepted' in first, false)
  assert.equal('status' in first, false)
  assert.equal(second.submissionId, first.submissionId)
  assert.equal(taskReports(f.store.getTask()).length, 1)
  assert.equal(f.executed.length, 0)
  assert.equal(f.notified.length, 0)
  await assert.rejects(f.queue.submit('task1', 'checkpoint', value({ summary: '不同报告' })), /task_report_identity_conflict/)
})

test('完成已提交但报告未结算的恢复只认同一 submission 和结果，不重执行业务', async () => {
  for (const sameSubmission of [true, false]) {
    const f = fixture()
    const result = { inputVersion: 2, runSequence: 1, status: 'completed', summary: '已验证' }
    await f.queue.submit('task1', 'result', { submissionId: 'completion1', ...result })
    await f.queue.drain()
    f.change({ state: 'completed', outcome: 'succeeded', result, executionEvents: [...f.store.getTask().executionEvents,
      { kind: 'task-completed', submissionId: sameSubmission ? 'completion1' : 'different', inputVersion: 2, runSequence: 1 }] })
    const recovered = f.restart()
    recovered.recover(f.store.getTask())
    await recovered.drain()
    assert.equal(f.executed.length, 0)
    assert.equal(taskReports(f.store.getTask())[0].status, sameSubmission ? 'accepted' : 'history-only')
  }
})

test('回执分别表达收件、审阅和应用，不把驳回与系统故障显示成批准', () => {
  for (const [status, reviewStatus, applicationStatus, nextAction] of [
    ['input-wait', 'pending', 'pending', 'wait-for-resolution'],
    ['review-wait', 'pending', 'pending', 'wait-for-resolution'],
    ['accepted', 'approved', 'applied', 'continue'],
    ['rejected', 'rejected', 'blocked', 'revise-report'],
    ['failed', 'failed', 'blocked', 'repair-system'],
    ['history-only', 'stale', 'superseded', 'review-current-input'],
  ]) {
    const receipt = taskReportReceipt('task1', { submissionId: 'report1', status })
    assert.equal(receipt.received, true)
    assert.deepEqual([receipt.reviewStatus, receipt.applicationStatus, receipt.nextAction], [reviewStatus, applicationStatus, nextAction])
    assert.ok(taskReportReceiptSchema.required.every(key => Object.hasOwn(receipt, key)))
    assert.ok(Object.keys(receipt).every(key => Object.hasOwn(taskReportReceiptSchema.properties, key)))
  }
  assert.throws(() => taskReportReceipt('task1', { status: 'corrupt' }), /task_report_status_invalid/)
})

test('未知故障及伪造前缀只阻塞系统，明确业务缺口才允许返工', async () => {
  for (const message of ['disk unavailable', 'task_goal_missing:task1', 'task_not_active:task1', 'provider:task_result_objective_not_covered:x', 'task_checkpoint_rejected_suffix']) {
    const f = fixture({ inputPending: false, execute: () => { throw new Error(message) } })
    await f.queue.submit('task1', 'checkpoint', value())
    await f.queue.drain()
    for (let i = 0; i < 10; i++) f.queue.recover(f.store.getTask())
    await f.queue.drain()
    const receipt = f.queue.get('task1', 'report1')
    assert.equal(receipt.reviewStatus, 'failed', message)
    assert.equal(receipt.nextAction, 'repair-system')
    assert.equal(f.queue.hasBlocking(f.store.getTask()), true)
    assert.equal(f.executed.length, 1)
  }
  const business = fixture({ inputPending: false, execute: () => { throw new Error('task_result_objective_not_covered:task1:缺独立证据') } })
  await business.queue.submit('task1', 'result', value())
  await business.queue.drain()
  assert.equal(business.queue.get('task1', 'report1').reviewStatus, 'rejected')
  assert.equal(business.queue.get('task1', 'report1').nextAction, 'revise-report')
  assert.equal(business.queue.hasBlocking(business.store.getTask()), false)
  assert.equal(classifyTaskReportError('task_checkpoint_context_changed:task1'), 'history-only')
  assert.equal(classifyTaskReportError('task_workflow_plan_stale:task1'), 'history-only')
  assert.equal(classifyTaskReportError('task_input_pending:task1'), 'input-wait')
})

test('输入解除后并发recover一次执行一次通知，终态重复提交不执行', async () => {
  const f = fixture()
  await f.queue.submit('task1', 'checkpoint', value())
  f.unblock()
  for (let i = 0; i < 50; i++) f.queue.recover(f.store.getTask())
  await f.queue.drain()
  assert.equal(f.executed.length, 1)
  assert.equal(f.notified.length, 1)
  assert.equal(f.queue.get('task1', 'report1').reviewStatus, 'approved')
  await f.queue.submit('task1', 'checkpoint', value())
  await f.queue.drain()
  assert.equal(f.executed.length, 1)
})

test('进程重建读取持久pending，不要求模型再次提交', async () => {
  const f = fixture()
  await f.queue.submit('task1', 'checkpoint', value())
  const restarted = f.restart()
  f.unblock()
  restarted.recover(f.store.getTask())
  await restarted.drain()
  assert.equal(restarted.get('task1', 'report1').reviewStatus, 'approved')
  assert.equal(f.executed.length, 1)
})

test('已知旧版本与已完成任务只保留事实，未知run和未来版本拒绝', async () => {
  const f = fixture({ inputPending: false })
  assert.equal((await f.queue.submit('task1', 'result', value({ inputVersion: 1 }))).reviewStatus, 'stale')
  assert.equal(f.executed.length, 0)
  await assert.rejects(f.queue.submit('task1', 'result', value({ submissionId: 'future', inputVersion: 3 })), /task_input_version_stale/)
  const later = fixture({ task: { runSequence: 2, inputVersion: 4, runHistory: [{ runSequence: 1, inputVersion: 2 }] } })
  assert.equal((await later.queue.submit('task1', 'result', value())).reviewStatus, 'stale')
  await assert.rejects(later.queue.submit('task1', 'result', value({ submissionId: 'unknown', runSequence: 0 })), /task_report_unknown_run/)
  const complete = fixture({ task: { state: 'completed' }, inputPending: false })
  assert.equal((await complete.queue.submit('task1', 'result', value())).reviewStatus, 'stale')
  assert.equal(complete.executed.length, 0)
})

test('pending期间版本更新不会用旧完成报告推进新目标', async () => {
  const f = fixture()
  await f.queue.submit('task1', 'result', value({ kind: undefined, status: 'completed' }))
  f.change({ inputVersion: 3 })
  f.unblock()
  f.queue.recover(f.store.getTask())
  await f.queue.drain()
  assert.equal(f.queue.get('task1', 'report1').reviewStatus, 'stale')
  assert.equal(f.executed.length, 0)
  assert.equal(f.notified.length, 1)
  assert.equal(f.notified[0][1].staleReview, true)
  for (let i = 0; i < 20; i++) f.queue.recover(f.store.getTask())
  await f.queue.drain()
  assert.equal(f.notified.length, 1)
})

test('两个并发提交在异步审阅期间复用同一执行', async () => {
  let release
  const f = fixture({ inputPending: false, execute: () => new Promise((resolve) => { release = resolve }) })
  await Promise.all([f.queue.submit('task1', 'checkpoint', value()), f.queue.submit('task1', 'checkpoint', value())])
  assert.equal(f.executed.length, 1)
  release({ accepted: true })
  await f.queue.drain()
  assert.equal(f.notified.length, 1)
})

test('settled后通知失败再重建，补通知而不重复执行报告', async () => {
  let unavailable = true
  const f = fixture({ inputPending: false, notify: () => { if (unavailable) throw new Error('session flush failed') } })
  await f.queue.submit('task1', 'checkpoint', value())
  await f.queue.drain()
  assert.equal(f.executed.length, 1)
  assert.equal(f.notified.length, 0)
  assert.equal(f.queue.get('task1', 'report1').reviewStatus, 'approved')
  assert.equal(f.queue.hasPending(f.store.getTask()), true)
  assert.equal(taskReports(f.store.getTask())[0].notifiedAt, undefined)
  unavailable = false
  const restarted = f.restart()
  for (let i = 0; i < 50; i++) restarted.recover(f.store.getTask())
  await restarted.drain()
  assert.equal(f.executed.length, 1)
  assert.equal(f.notified.length, 1)
  assert.equal(restarted.hasPending(f.store.getTask()), false)
  assert.ok(taskReports(f.store.getTask())[0].notifiedAt)
})

test('同Task不同报告串行执行，drain等待后续报告完成', async () => {
  let release, active = 0, maximum = 0
  const f = fixture({ inputPending: false, execute: async (_task, _type, report) => {
    active += 1; maximum = Math.max(maximum, active)
    if (report.summary === '第一份') await new Promise(resolve => { release = resolve })
    active -= 1
    return { accepted: true }
  } })
  await f.queue.submit('task1', 'checkpoint', value({ summary: '第一份' }))
  await f.queue.submit('task1', 'checkpoint', value({ submissionId: 'report2', summary: '第二份' }))
  assert.equal(f.executed.length, 1)
  release()
  await f.queue.drain()
  assert.equal(f.executed.length, 2)
  assert.equal(f.notified.length, 2)
  assert.equal(maximum, 1)
})

test('协调失败只通知一次且保持阻塞，Supervisor恢复不自动重试执行', async () => {
  const f = fixture({ inputPending: false, execute: () => { throw new Error('topic_request_not_submitted:test') } })
  await f.queue.submit('task1', 'checkpoint', value())
  await f.queue.drain()
  for (let i = 0; i < 20; i++) f.queue.recover(f.store.getTask())
  await f.queue.drain()
  assert.equal(f.executed.length, 1)
  assert.equal(f.notified.length, 1)
  assert.equal(f.queue.hasPending(f.store.getTask()), false)
  assert.equal(f.queue.hasBlocking(f.store.getTask()), true)
  assert.equal(f.queue.get('task1', 'report1').reviewStatus, 'failed')
})

test('确定性上下文故障保留报告，100 次恢复不重复审阅，业务驳回仍可改稿', async () => {
  const f = fixture({ inputPending: false, execute: () => { throw new Error('topic_context_budget_exceeded') } })
  await f.queue.submit('task1', 'checkpoint', value())
  await f.queue.drain()
  for (let i = 0; i < 100; i++) f.queue.recover(f.store.getTask())
  await f.queue.drain()
  assert.equal(f.queue.get('task1', 'report1').reviewStatus, 'failed')
  assert.equal(f.executed.length, 1)
  assert.equal(f.notified.length, 1)
  assert.equal(f.queue.hasBlocking(f.store.getTask()), true)
  const business = fixture({ inputPending: false, execute: () => ({ accepted: false, code: 'task_checkpoint_rejected' }) })
  await business.queue.submit('task1', 'checkpoint', value())
  await business.queue.drain()
  assert.equal(business.queue.get('task1', 'report1').reviewStatus, 'rejected')
  assert.equal(business.queue.hasBlocking(business.store.getTask()), false)
})

test('协调重试耗尽落failed并保持Goal门禁，仅显式retry恢复同一报告', async () => {
  let exhausted = true
  const f = fixture({ inputPending: false, execute: () => {
    if (exhausted) throw new Error('topic_request_retry_exhausted:request1')
    return { accepted: true }
  } })
  await f.queue.submit('task1', 'checkpoint', value())
  await f.queue.drain()
  assert.equal(f.queue.get('task1', 'report1').reviewStatus, 'failed')
  assert.equal(f.queue.hasBlocking(f.store.getTask()), true)
  for (let i = 0; i < 10; i++) f.queue.recover(f.store.getTask())
  await f.queue.drain()
  assert.equal(f.executed.length, 1)
  assert.equal(f.notified.length, 1)
  exhausted = false
  const received = await f.queue.retry('task1', 'report1')
  assert.equal(received.submissionId, 'report1')
  await f.queue.drain()
  assert.equal(f.queue.get('task1', 'report1').reviewStatus, 'approved')
  assert.equal(f.queue.hasBlocking(f.store.getTask()), false)
  assert.equal(f.executed.length, 2)
})

test('真实子进程在settled落文件后、通知前退出，恢复仅补一次通知', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'task-report-crash-'))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const file = join(folder, 'task.json')
  const moduleUrl = new URL('../packages/dingtalk-dsh-assistant/task-reports.js', import.meta.url).href
  const script = `
    import { writeFileSync } from 'node:fs';
    import { createTaskReportQueue } from ${JSON.stringify(moduleUrl)};
    let task = { taskId:'task1', state:'running', inputVersion:2, runSequence:1, executionEvents:[] };
    const store = { getTask:()=>structuredClone(task), async updateTask(id, update) { task=update(task); writeFileSync(process.argv[1],JSON.stringify(task)); return task; } };
    const queue = createTaskReportQueue({ store, serialize:fn=>fn(), hasPendingInput:()=>false, execute:async()=>({accepted:true}), suspend:async()=>{}, notify:async()=>process.exit(23), onError:error=>{throw error}, isClosing:()=>false });
    await queue.submit('task1','checkpoint',${JSON.stringify(value())});
    await queue.drain();
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, file], { encoding: 'utf8', timeout: 10000 })
  assert.equal(child.status, 23, child.stderr)
  const durable = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(taskReports(durable)[0].status, 'accepted')
  assert.equal(taskReports(durable)[0].notifiedAt, undefined)
  const restored = fixture({ task: durable, inputPending: false })
  for (let i = 0; i < 10; i++) restored.queue.recover(restored.store.getTask())
  await restored.queue.drain()
  assert.equal(restored.executed.length, 0)
  assert.equal(restored.notified.length, 1)
  assert.ok(taskReports(restored.store.getTask())[0].notifiedAt)
})

test('风险诊断可抢占等待计划，普通阶段仍串行', async () => {
  let finishPlan
  const f = fixture({ inputPending: false, execute: async (_id, _type, report) => {
    if (report.kind === 'plan-confirmed') return new Promise(resolve => { finishPlan = resolve })
    if (report.kind === 'scope-conflict') finishPlan({ accepted: false, code: 'task_checkpoint_rejected' })
    return { accepted: true }
  } })
  await f.queue.submit('task1', 'checkpoint', value({ kind: 'plan-confirmed' }))
  await f.queue.submit('task1', 'checkpoint', value({ kind: 'scope-conflict', submissionId: 'risk1' }))
  await f.queue.drain()
  assert.deepEqual(f.executed.map(args => args[2].kind), ['plan-confirmed', 'scope-conflict'])
  assert.equal(f.queue.get('task1', 'report1').reviewStatus, 'rejected')
  assert.equal(f.queue.get('task1', 'risk1').reviewStatus, 'approved')
})

test('failed只允许显式同版本重试，成功后清掉失败通知状态与阻塞', async () => {
  let fail = true
  const f = fixture({ inputPending: false, execute: () => { if (fail) throw new Error('task_review_request_failed:provider'); return { accepted: true } } })
  await f.queue.submit('task1', 'checkpoint', value())
  await f.queue.drain()
  fail = false
  const retry = await f.queue.retry('task1', 'report1')
  assert.equal(retry.reviewStatus, 'pending')
  assert.equal(retry.error, undefined)
  await f.queue.drain()
  assert.equal(f.executed.length, 2)
  assert.equal(f.notified.length, 2)
  assert.equal(f.queue.hasBlocking(f.store.getTask()), false)
  await assert.rejects(f.queue.retry('task1', 'report1'), /requires_failed/)
})

test('旧版本failed不阻塞新目标、不能retry，恢复归档history', async () => {
  const f = fixture({ inputPending: false, execute: () => { throw new Error('task_review_request_failed:provider') } })
  await f.queue.submit('task1', 'checkpoint', value())
  await f.queue.drain()
  f.change({ inputVersion: 3 })
  assert.equal(f.queue.hasBlocking(f.store.getTask()), false)
  await assert.rejects(f.queue.retry('task1', 'report1'), /retry_stale/)
  f.queue.recover(f.store.getTask())
  await f.queue.drain()
  assert.equal(f.queue.get('task1', 'report1').reviewStatus, 'stale')
  assert.equal(f.executed.length, 1)
})
