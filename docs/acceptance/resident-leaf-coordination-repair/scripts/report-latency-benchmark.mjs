import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, relative, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { performance } from 'node:perf_hooks'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openResidentStore } from '../../../../packages/dingtalk-dsh-assistant/store.js'
import { createTaskReportQueue, taskReports } from '../../../../packages/dingtalk-dsh-assistant/task-reports.js'

const acceptanceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const samples = 30
const { values } = parseArgs({ options: { check: { type: 'boolean', default: false }, output: { type: 'string', default: join(acceptanceRoot, 'report-latency-benchmark.json') } }, strict: true })
const outputPath = resolve(values.output)
if (dirname(outputPath) !== acceptanceRoot) throw new Error('benchmark_output_must_stay_in_acceptance_directory')
await stat(acceptanceRoot)
if (values.check) {
  console.log(JSON.stringify({ ok: true, mode: 'check-zero-write', samples, backend: 'DSH DomainFacility + JsonStorageBackend', storage: 'fresh-system-temp', modelCalls: 0, businessActions: 0 }))
} else {
  const parent = await realpath(tmpdir())
  const created = await mkdtemp(join(parent, 'resident-report-latency-'))
  const root = await realpath(created)
  if (dirname(root) !== parent || !basename(root).startsWith('resident-report-latency-') || relative(parent, root).startsWith('..')) throw new Error('benchmark_temp_path_invalid')
  const errors = [], durationsMs = []
  let store, facility, backend, queue, tail = Promise.resolve(), executions = 0
  const open = async () => {
    backend = new JsonStorageBackend(root)
    facility = new DomainFacility({ emit() {}, storage: { backend: { get: () => backend } } }, { backend: 'json' })
    store = await openResidentStore(facility)
  }
  const close = async () => { await queue?.drain(); await store?.close(); await facility?.closeAll(); await backend?.close() }
  try {
    await open()
    await store.subscribe({ groupId: 'benchmark-group' })
    await store.ingest({ groupId: 'benchmark-group', messageId: 'benchmark-input', text: '合成报告性能测试', occurredAt: '2026-09-10T00:00:00Z' })
    const routed = await store.routeMessages({ groupId: 'benchmark-group', routeId: 'benchmark-route', routingRevision: 0, routes: [{ messageId: 'benchmark-input', messageVersion: 1, topics: [{ newTopicKey: 'benchmark', title: '合成性能测试' }] }] })
    const { task } = await store.createTask({ groupId: 'benchmark-group', taskId: 'task-benchmark-report', topicRefs: [{ topicId: routed.topicIdsByKey.benchmark, revision: 1 }], title: '报告落盘基准', objective: '测量合成报告接收', acceptanceCriteria: ['报告持久化可回读'], stageTasks: ['合成核验'] })
    await store.updateTask(task.taskId, current => ({ ...current, state: 'running' }))
    queue = createTaskReportQueue({ store, serialize(fn) { const run = tail.then(fn); tail = run.catch(() => {}); return run }, hasPendingInput: () => true,
      execute: async () => { executions++; throw new Error('benchmark_must_not_execute') }, suspend: async () => {}, notify: async () => { throw new Error('benchmark_must_not_notify') }, onError: error => errors.push(error), isClosing: () => false })
    for (let index = 0; index < samples; index++) {
      const submissionId = `benchmark-report-${index}`
      const before = performance.now()
      const receipt = await queue.submit(task.taskId, 'checkpoint', { submissionId, inputVersion: 1, runSequence: 1, kind: 'stage-completed', stageTask: '合成核验', summary: '合成报告', evidence: ['fixture'], completedItems: [], remainingItems: [], nextStep: '等待输入接纳' })
      durationsMs.push(Number((performance.now() - before).toFixed(3)))
      assert.equal(receipt.status, 'input-wait')
      // 不计入接收耗时；每次独立读磁盘证明 await submit 已完成 JSON 发布。
      const disk = JSON.parse(await readFile(join(root, 'dingtalk_dsh_assistant.json'), 'utf8'))
      assert.ok(taskReports(disk.tables.tasks[task.taskId]).some(report => report.submissionId === submissionId))
    }
    await close()
    await open() // 全新 backend/facility/store；不复用内存缓存。
    const recovered = taskReports(store.getTask(task.taskId))
    assert.equal(recovered.length, samples)
    assert.equal(new Set(recovered.map(report => report.submissionId)).size, samples)
    assert.ok(recovered.every(report => report.status === 'input-wait'))
    assert.equal(executions, 0)
    assert.equal(errors.length, 0)
    const sorted = [...durationsMs].sort((a, b) => a - b)
    const result = { measuredAt: new Date().toISOString(), samples, backend: 'DSH DomainFacility + JsonStorageBackend', scenario: 'synthetic-input-wait-reports',
      measuredBoundary: 'await queue.submit including native JSON atomic publication; setup and independent readback excluded',
      p50Ms: sorted[Math.ceil(samples * 0.50) - 1], p95Ms: sorted[Math.ceil(samples * 0.95) - 1], maxMs: sorted.at(-1), durationsMs,
      independentReopen: { uniqueReports: recovered.length, allInputWait: true }, modelCalls: 0, businessActions: executions,
      limitations: ['合成小存储，非生产全量历史规模。', 'suspend为无操作，不含真实Goal/Session flush成本。', '不包含模型审阅、外部执行、群投递与UI时延。'] }
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
    console.log(JSON.stringify(result))
  } finally {
    try { await close() } finally { await rm(root, { recursive: true, force: true }) }
  }
}
