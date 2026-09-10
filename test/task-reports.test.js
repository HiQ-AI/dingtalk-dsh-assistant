import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskReportQueue, taskReports } from '../packages/dingtalk-dsh-assistant/task-reports.js'

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
  assert.equal(first.status, 'input-wait')
  assert.equal(second.submissionId, first.submissionId)
  assert.equal(taskReports(f.store.getTask()).length, 1)
  assert.equal(f.executed.length, 0)
  assert.equal(f.notified.length, 0)
  await assert.rejects(f.queue.submit('task1', 'checkpoint', value({ summary: '不同报告' })), /task_report_identity_conflict/)
})

test('输入解除后并发recover一次执行一次通知，终态重复提交不执行', async () => {
  const f = fixture()
  await f.queue.submit('task1', 'checkpoint', value())
  f.unblock()
  for (let i = 0; i < 50; i++) f.queue.recover(f.store.getTask())
  await f.queue.drain()
  assert.equal(f.executed.length, 1)
  assert.equal(f.notified.length, 1)
  assert.equal(f.queue.get('task1', 'report1').status, 'accepted')
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
  assert.equal(restarted.get('task1', 'report1').status, 'accepted')
  assert.equal(f.executed.length, 1)
})

test('已知旧版本与已完成任务只保留事实，未知run和未来版本拒绝', async () => {
  const f = fixture({ inputPending: false })
  assert.equal((await f.queue.submit('task1', 'result', value({ inputVersion: 1 }))).status, 'history-only')
  assert.equal(f.executed.length, 0)
  await assert.rejects(f.queue.submit('task1', 'result', value({ submissionId: 'future', inputVersion: 3 })), /task_input_version_stale/)
  const later = fixture({ task: { runSequence: 2, inputVersion: 4, runHistory: [{ runSequence: 1, inputVersion: 2 }] } })
  assert.equal((await later.queue.submit('task1', 'result', value())).status, 'history-only')
  await assert.rejects(later.queue.submit('task1', 'result', value({ submissionId: 'unknown', runSequence: 0 })), /task_report_unknown_run/)
  const complete = fixture({ task: { state: 'completed' }, inputPending: false })
  assert.equal((await complete.queue.submit('task1', 'result', value())).status, 'history-only')
  assert.equal(complete.executed.length, 0)
})

test('pending期间版本更新不会用旧完成报告推进新目标', async () => {
  const f = fixture()
  await f.queue.submit('task1', 'result', value({ kind: undefined, status: 'completed' }))
  f.change({ inputVersion: 3 })
  f.unblock()
  f.queue.recover(f.store.getTask())
  await f.queue.drain()
  assert.equal(f.queue.get('task1', 'report1').status, 'history-only')
  assert.equal(f.executed.length, 0)
  assert.equal(f.notified.length, 0)
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
  assert.equal(f.queue.get('task1', 'report1').status, 'accepted')
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
  assert.equal(f.queue.get('task1', 'report1').status, 'failed')
})

test('协调重试耗尽落failed并保持Goal门禁，仅显式retry恢复同一报告', async () => {
  let exhausted = true
  const f = fixture({ inputPending: false, execute: () => {
    if (exhausted) throw new Error('topic_request_retry_exhausted:request1')
    return { accepted: true }
  } })
  await f.queue.submit('task1', 'checkpoint', value())
  await f.queue.drain()
  assert.equal(f.queue.get('task1', 'report1').status, 'failed')
  assert.equal(f.queue.hasBlocking(f.store.getTask()), true)
  for (let i = 0; i < 10; i++) f.queue.recover(f.store.getTask())
  await f.queue.drain()
  assert.equal(f.executed.length, 1)
  assert.equal(f.notified.length, 1)
  exhausted = false
  const received = await f.queue.retry('task1', 'report1')
  assert.equal(received.submissionId, 'report1')
  await f.queue.drain()
  assert.equal(f.queue.get('task1', 'report1').status, 'accepted')
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
  assert.equal(f.queue.get('task1', 'report1').status, 'rejected')
  assert.equal(f.queue.get('task1', 'risk1').status, 'accepted')
})

test('failed只允许显式同版本重试，成功后清掉失败通知状态与阻塞', async () => {
  let fail = true
  const f = fixture({ inputPending: false, execute: () => { if (fail) throw new Error('task_review_request_failed:provider'); return { accepted: true } } })
  await f.queue.submit('task1', 'checkpoint', value())
  await f.queue.drain()
  fail = false
  const retry = await f.queue.retry('task1', 'report1')
  assert.equal(retry.status, 'review-wait')
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
  assert.equal(f.queue.get('task1', 'report1').status, 'history-only')
  assert.equal(f.executed.length, 1)
})
