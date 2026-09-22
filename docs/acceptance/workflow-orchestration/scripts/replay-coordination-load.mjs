import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createCoordinationSessions } from '../../../../packages/dingtalk-dsh-assistant/coordination-sessions.js'

// 真实新旧队列模块 + 确定性模型替身。虚拟时间只用于排序和等待，不是线上耗时。
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const baseline = '83fc504596f0faff4c65f92991a444ea13f6af5a'
const temporary = await mkdtemp(path.join(tmpdir(), 'coordination-replay-'))
const flush = () => new Promise(resolve => setImmediate(resolve))
const percentile = (values, quantile) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * quantile) - 1)] ?? 0
const summary = values => ({ count: values.length, p50: percentile(values, .5), p95: percentile(values, .95), max: Math.max(0, ...values) })

async function replay(factory, multiplier) {
  const jobs = []
  for (const [groupId, shift] of [['a', 0], ['b', 1]]) {
    for (let time = shift; time < 96; time += 2 / multiplier) jobs.push({ groupId, role: 'route', arrival: time })
    for (let time = shift + 1; time < 96; time += 8 / multiplier) jobs.push({ groupId, role: 'review', arrival: time })
  }
  jobs.sort((a, b) => a.arrival - b.arrival || a.groupId.localeCompare(b.groupId) || a.role.localeCompare(b.role))
  jobs.forEach((job, index) => { job.id = `${job.role}-${index}`; job.request = { groupId: job.groupId, requestId: `coord-${job.role === 'review' ? 'checkpoint' : 'route'}-${index}` } })
  const clock = { time: 0 }, active = new Map(), peaks = new Map(), routeBurst = new Map(), maxBurst = new Map(), running = [], completed = [], errors = [], deliveries = []
  const dateNow = Date.now
  Date.now = () => 1_800_000_000_000 + clock.time * 10
  const manager = factory({ isCurrent: () => true, onError: error => errors.push(error.message), create: async entry => {
    const job = jobs.find(item => item.request === entry.request), events = []
    let resolveIdle
    const idle = new Promise(resolve => { resolveIdle = resolve })
    return { agent: { session: { id: entry.sessionId, snapshotEvents: () => events, append(type, data) { events.push({ type, data }) } }, inbox: {},
      steer(message) {
        assert.equal(active.get(job.groupId) ?? 0, 0, '每群模型并发不得超过1')
        job.started = clock.time; job.events = events
        active.set(job.groupId, 1); peaks.set(job.groupId, Math.max(peaks.get(job.groupId) ?? 0, 1))
        const waitingReview = jobs.some(item => item.groupId === job.groupId && item.role === 'review' && item.arrival <= clock.time && item.started === undefined)
        const count = job.role === 'route' && waitingReview ? (routeBurst.get(job.groupId) ?? 0) + 1 : 0
        routeBurst.set(job.groupId, count); maxBurst.set(job.groupId, Math.max(maxBurst.get(job.groupId) ?? 0, count))
        events.push({ type: 'user/message', data: message })
        running.push({ job, end: clock.time + 1, finish() { active.set(job.groupId, 0); completed.push(job); resolveIdle() } })
      }, whenIdle: () => idle, cancel: () => resolveIdle(),
    }, async dispose() {} }
  } })
  try {
    for (; clock.time < 1000 && completed.length < jobs.length; clock.time++) {
      for (const job of jobs.filter(item => item.arrival === clock.time)) deliveries.push(manager.dispatch(job.request, { id: job.id }).catch(error => errors.push(error.message)))
      await flush()
      for (let index = running.length - 1; index >= 0; index--) if (running[index].end <= clock.time) running.splice(index, 1)[0].finish()
      await flush()
    }
    await Promise.all(deliveries)
    assert.deepEqual(errors, [])
    assert.equal(completed.length, jobs.length)
    const waits = role => jobs.filter(job => !role || job.role === role).map(job => (job.started - job.arrival) * 10)
    return { multiplier, jobs: jobs.length, durationVirtualMs: clock.time * 10, peakPerGroup: Object.fromEntries(peaks), maxRouteStartsWhileReviewQueued: Object.fromEntries(maxBurst), waitVirtualMs: { all: summary(waits()), route: summary(waits('route')), review: summary(waits('review')) }, dispatchTraceDigest: createHash('sha256').update(JSON.stringify(jobs.map(({ id, started }) => ({ id, started })))).digest('hex') }
  } finally { await manager.close(); Date.now = dateNow }
}

try {
  for (const filename of ['coordination-sessions.js', 'task-report-step-gate.js']) {
    const source = execFileSync('git', ['show', `${baseline}:packages/dingtalk-dsh-assistant/${filename}`], { cwd: root, encoding: 'utf8' })
    await writeFile(path.join(temporary, filename), source)
  }
  await writeFile(path.join(temporary, 'package.json'), JSON.stringify({ type: 'module' }))
  const old = await import(pathToFileURL(path.join(temporary, 'coordination-sessions.js')).href)
  const rounds = []
  for (const multiplier of [.5, 1, 2]) for (let round = 1; round <= 3; round++) {
    const before = await replay(old.createCoordinationSessions, multiplier)
    const after = await replay(createCoordinationSessions, multiplier)
    assert.ok(Object.values(after.maxRouteStartsWhileReviewQueued).every(value => value <= 2))
    rounds.push({ round, multiplier, baseline: before, current: after })
  }
  for (const multiplier of [.5, 1, 2]) {
    const repeats = rounds.filter(item => item.multiplier === multiplier)
    assert.ok(repeats.every(item => item.current.dispatchTraceDigest === repeats[0].current.dispatchTraceDigest && item.baseline.dispatchTraceDigest === repeats[0].baseline.dispatchTraceDigest), '三轮输入相同应产生相同调度轨迹')
  }
  const currentModuleSha256 = createHash('sha256').update(await readFile(path.join(root, 'packages/dingtalk-dsh-assistant/coordination-sessions.js'))).digest('hex')
  console.log(JSON.stringify({ baselineCommit: baseline, currentCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), currentIncludesWorkingTree: true, currentModuleSha256, workload: { horizonTicks: 96, tickVirtualMs: 10, serviceTicks: 1, groups: 2, baselineRouteIntervalTicks: 2, baselineReviewIntervalTicks: 8 }, boundary: '真实新旧队列模块；fake agent、虚拟时间、有限事件流。只验证调度、公平性和单群并发，不证明真实provider token、渠道延迟、持续过载容量或业务验收。', rounds }, null, 2))
} finally {
  const resolved = path.resolve(temporary), parent = path.resolve(tmpdir())
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('coordination-replay-')) throw new Error('temporary_cleanup_boundary_invalid')
  await rm(resolved, { recursive: true, force: true })
}
