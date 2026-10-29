import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, rmdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { taskDirectories } from '../../../../packages/dingtalk-dsh-assistant/session-workspaces.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeTaskHost, available, reason, waitUntil } from '../../../../test/fixtures/task-session-native-host.js'
import { openTaskSessionService } from '../../../../packages/dingtalk-dsh-assistant/task-session-service.js'
import { openDynamicTaskStore } from '../../../../packages/dingtalk-dsh-assistant/dynamic-task-store.js'

if (!available) throw new Error(reason)
if (process.argv.includes('--material-failure')) {
  const root = await mkdtemp(join(tmpdir(), 'owner-material-failure-'))
  let host, store, target, runs = 0, injected = false, restarting = false
  const submissions = []
  const sessions = {
    async run({ submit }) {
      runs++
      await submit({ action: 'wait', summary: 'Waiting for input', evidence: [], limitations: [] })
      return { status: 'submitted' }
    },
    async cancel() {},
    async close() {},
  }
  try {
    const options = {
      serviceFactory: async args => {
        const submitWebTaskInput = args.residentStore.submitWebTaskInput
        args.residentStore.submitWebTaskInput = input => {
          if (input.requestId === 'revision') submissions.push(structuredClone(input))
          return submitWebTaskInput(input)
        }
        store = await openDynamicTaskStore({ dbPath: args.config.dbPath, instanceId: args.config.instanceId, initialize: !restarting, webActorId: args.config.webActorId })
        const proxy = {
          ...store,
          async command(request) {
            const result = await store.command(request)
            if (request.kind === 'task.revise' && !injected) {
              injected = true
              const task = result.result.task, sourceId = task.sourceRefs.at(-1)
              const directories = await taskDirectories(root, task.taskId, { create: true })
              const digest = createHash('sha256').update(JSON.stringify(sourceId)).digest('hex').slice(0, 32)
              target = join(directories.materials, `source-${digest}.json`)
              await mkdir(target)
            }
            return result
          },
        }
        return openTaskSessionService({ ...args, store: proxy, taskSessions: sessions })
      },
    }
    host = await nativeTaskHost(root, async () => { throw new Error('Unexpected native model call') }, options)
    const task = await host.service.createTask({ groupId: 'native-group', requestId: 'initial', title: 'Failure', objective: 'Check materials' })
    await host.service.whenIdle()
    const before = await host.query('task.get', { taskId: task.taskId })
    let error
    try { await host.service.appendTaskContext({ taskId: task.taskId, requestId: 'revision', progressImpact: 'replan', expectedRequirementRevision: before.requirementRevision, expectedControlRevision: before.controlRevision, context: 'Updated requirements' }) }
    catch (cause) { error = cause.code ?? cause.message }
    await host.service.whenIdle()
    const after = await host.query('task.get', { taskId: task.taskId })
    assert.equal(injected, true)
    assert.ok(error)
    assert.equal(after.requirementRevision, before.requirementRevision + 1)
    assert.equal(runs, 1)
    console.log(JSON.stringify({ result: 'MATERIAL_FAILURE', error, revision: after.requirementRevision, ownerRuns: runs }))
    await host.close()
    await store.close()
    host = undefined
    store = undefined
    await rmdir(target)
    restarting = true
    host = await nativeTaskHost(root, async () => { throw new Error('Unexpected native model call') }, options)
    await host.service.recover()
    await host.service.whenIdle()
    const snapshot = JSON.parse(await readFile(target, 'utf8'))
    assert.equal(runs, 2)
    assert.equal(snapshot.taskId, task.taskId)
    console.log(JSON.stringify({ result: 'RECOVERED', ownerRuns: runs, materialSourceId: snapshot.sourceId }))
    let replayError = null
    try { await host.service.appendTaskContext({ taskId: task.taskId, requestId: 'revision', progressImpact: 'replan', expectedRequirementRevision: before.requirementRevision, expectedControlRevision: before.controlRevision, context: 'Updated requirements' }) }
    catch (cause) { replayError = cause.code ?? cause.message }
    await host.service.whenIdle()
    const replayed = await host.query('task.get', { taskId: task.taskId })
    assert.equal(replayed.requirementRevision, after.requirementRevision)
    assert.equal(runs, 2)
    assert.equal(replayError, null)
    assert.equal(submissions.length, 1)
    console.log(JSON.stringify({ result: 'REPLAY', error: replayError, revision: replayed.requirementRevision, ownerRuns: runs, submissions: submissions.length }))
  } finally {
    await host?.close()
    await store?.close()
    await rm(root, { recursive: true, force: true })
  }
} else if (process.argv.includes('--claim-race') || process.argv.includes('--claim-committed') || process.argv.includes('--held-queued') || process.argv.includes('--held-open-slot')) {
  const openSlot = process.argv.includes('--held-open-slot')
  const heldQueued = process.argv.includes('--held-queued') || openSlot
  const committed = process.argv.includes('--claim-committed')
  const root = await mkdtemp(join(tmpdir(), 'owner-execution-claim-'))
  const gate = Promise.withResolvers(), entered = Promise.withResolvers(), revised = Promise.withResolvers(), ownerDone = Promise.withResolvers()
  const revisionGate = Promise.withResolvers(), holding = Promise.withResolvers()
  let host, store, claimError, executionCurrent, secondId, executionLists = 0, claims = 0, executionRuns = 0, cancels = 0, ownerRuns = 0
  const sessions = {
    async run({ delegate, submit }) {
      ownerRuns++
      if (ownerRuns === 1) {
        await delegate({ key: 'first', objective: 'Inspect the fixture' })
        if (heldQueued) await delegate({ key: 'second', objective: 'Inspect another fixture' })
      }
      await submit({ action: 'wait', summary: 'Waiting for input', evidence: [], limitations: [] })
      if (ownerRuns === 1) ownerDone.resolve()
      return { status: 'submitted' }
    },
    async cancel() {}, async close() {},
  }
  const executionSessions = {
    async run({ binding }) { executionRuns++; executionCurrent = await store.query({ kind: 'execution.current', binding }); return { status: 'stale' } },
    async cancel() { cancels++ }, async feedback() {}, async close() {},
  }
  try {
    host = await nativeTaskHost(root, async () => { throw new Error('Unexpected native model call') }, {
      config: { maxConcurrentExecutions: 1 },
      serviceFactory: async args => {
        store = await openDynamicTaskStore({ dbPath: args.config.dbPath, instanceId: args.config.instanceId, initialize: true, webActorId: args.config.webActorId })
        const proxy = {
          ...store,
          async query(request) { if (request.kind === 'execution.list') executionLists++; return store.query(request) },
          async command(request) {
            if (request.kind === 'task.revise' && heldQueued) { holding.resolve(); await revisionGate.promise }
            if (request.kind === 'execution.claim') { claims++; if (!committed) { entered.resolve(); await gate.promise } }
            let result
            try { result = await store.command(request) }
            catch (error) { if (request.kind === 'execution.claim') claimError = error.code ?? error.message; throw error }
            if (request.kind === 'execution.dispatch' && request.args.key === 'second') secondId = result.result.execution.executionId
            if (request.kind === 'execution.claim' && committed) { entered.resolve(); await gate.promise }
            if (request.kind === 'task.revise') revised.resolve()
            return result
          },
        }
        return openTaskSessionService({ ...args, store: proxy, taskSessions: sessions, executionSessions })
      },
    })
    const task = await host.service.createTask({ groupId: 'native-group', requestId: 'initial', title: 'Claim race', objective: 'Check the task' })
    await Promise.race([Promise.all([entered.promise, ownerDone.promise]), new Promise((_, reject) => setTimeout(() => reject(new Error('claim gate not entered')), 15000))])
    await waitUntil(async () => (await host.query('task.get', { taskId: task.taskId })).drained, 'old owner drained')
    const before = await host.query('task.get', { taskId: task.taskId })
    let settled = false
    const admission = host.service.appendTaskContext({ taskId: task.taskId, requestId: 'revision', progressImpact: 'replan', expectedRequirementRevision: before.requirementRevision, expectedControlRevision: before.controlRevision, context: 'Change requirements' }).then(() => { settled = true })
    let heldSample
    if (heldQueued) {
      await Promise.race([holding.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('hold not entered')), 15000))])
      if (openSlot) {
        gate.resolve()
        await waitUntil(async () => executionRuns === 1 && (await host.query('execution.list', { taskId: task.taskId })).some(item => item.executionId !== secondId && item.drained), 'first execution drained')
      }
      const queued = (await host.query('execution.list', { taskId: task.taskId })).filter(item => item.status === 'queued')
      assert.equal(queued.length, openSlot ? 1 : 2)
      const count = executionLists
      await new Promise(resolve => setTimeout(resolve, 300))
      heldSample = { queued: queued.length, extraExecutionLists: executionLists - count, claims }
      assert.equal(claims, 1)
      assert.ok(heldSample.extraExecutionLists < 10)
      revisionGate.resolve()
    }
    await Promise.race([revised.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('revision not committed')), 15000))])
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(settled, false)
    assert.equal(claims, 1)
    gate.resolve()
    await admission
    await host.service.whenIdle()
    if (openSlot) { assert.equal(executionRuns, 1); assert.equal(executionCurrent, true) }
    else if (committed) { assert.equal(executionRuns, 1); assert.equal(executionCurrent, false) }
    else { assert.equal(executionRuns, 0); assert.ok(claimError) }
    console.log(JSON.stringify({ result: openSlot ? 'HELD_OPEN_SLOT' : heldQueued ? 'HELD_QUEUED' : committed ? 'CLAIM_COMMITTED' : 'CLAIM_RACE', heldSample, claims, claimError, executionRuns, executionCurrent, cancels, ownerRuns, revision: (await host.query('task.get', { taskId: task.taskId })).requirementRevision }))
  } finally {
    revisionGate.resolve()
    gate.resolve()
    await host?.close()
    await store?.close()
    await rm(root, { recursive: true, force: true })
  }
} else if (process.argv.includes('--owner-wake')) {
  const root = await mkdtemp(join(tmpdir(), 'owner-wake-hold-'))
  const wakeGate = Promise.withResolvers(), wakeEntered = Promise.withResolvers(), wakeExited = Promise.withResolvers(), revisionGate = Promise.withResolvers(), holding = Promise.withResolvers()
  let host, store, armed = true, wakeBlocked = false, claims = 0, ownerRuns = 0
  const sessions = {
    async run({ submit }) { ownerRuns++; await submit({ action: 'wait', summary: 'Waiting', evidence: [], limitations: [] }); return { status: 'submitted' } },
    async cancel() {}, async close() {},
  }
  try {
    host = await nativeTaskHost(root, async () => { throw new Error('Unexpected native model call') }, {
      serviceFactory: async args => {
        store = await openDynamicTaskStore({ dbPath: args.config.dbPath, instanceId: args.config.instanceId, initialize: true, webActorId: args.config.webActorId })
        const proxy = {
          ...store,
          async query(request) {
            const result = await store.query(request)
            if (armed && request.kind === 'wake.list' && request.taskId && new Error().stack.includes('task-session-service.js:975:')) {
              armed = false; wakeBlocked = true; wakeEntered.resolve(); await wakeGate.promise
            }
            if (wakeBlocked && request.kind === 'wake.list' && new Error().stack.includes('task-session-service.js:250:')) wakeExited.resolve()
            return result
          },
          async command(request) {
            if (request.kind === 'task.claim') claims++
            if (request.kind === 'task.revise') { holding.resolve(); await revisionGate.promise }
            return store.command(request)
          },
        }
        return openTaskSessionService({ ...args, store: proxy, taskSessions: sessions })
      },
    })
    const task = await host.service.createTask({ groupId: 'native-group', requestId: 'initial', title: 'Owner wake', objective: 'Check the task' })
    await Promise.race([wakeEntered.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('owner wake gate not entered')), 15000))])
    const before = await host.query('task.get', { taskId: task.taskId })
    const admission = host.service.appendTaskContext({ taskId: task.taskId, requestId: 'revision', progressImpact: 'replan', expectedRequirementRevision: before.requirementRevision, expectedControlRevision: before.controlRevision, context: 'Change requirements' })
    await Promise.race([holding.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('revision hold not entered')), 15000))])
    wakeGate.resolve()
    await Promise.race([wakeExited.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('owner did not exit to tracking cleanup')), 15000))])
    assert.equal(claims, 0)
    revisionGate.resolve()
    await admission
    await host.service.whenIdle()
    assert.equal(wakeBlocked, true)
    assert.equal(claims, 1)
    assert.equal(ownerRuns, 1)
    console.log(JSON.stringify({ result: 'OWNER_WAKE_HOLD', claims, ownerRuns, revision: (await host.query('task.get', { taskId: task.taskId })).requirementRevision }))
  } finally {
    wakeGate.resolve(); revisionGate.resolve()
    await host?.close(); await store?.close(); await rm(root, { recursive: true, force: true })
  }
} else if (process.argv.includes('--baseline')) {
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const root = await mkdtemp(join(tmpdir(), 'owner-admission-race-'))
const started = deferred(), releaseOwner = deferred(), releaseGate = deferred()
let host, store, intercept = false, blocked = false, runs = 0, cancelled = []
const sessions = {
  async run({ binding, submit }) {
    runs++
    if (runs === 1) {
      await submit({ action: 'wait', summary: 'Waiting for input', evidence: [], limitations: [] })
      return { status: 'submitted' }
    }
    started.resolve(binding.leaseEpoch)
    await releaseOwner.promise
    return { status: 'cancelled' }
  },
  async cancel(taskId) { cancelled.push({ taskId, runs }) },
  async close() { releaseOwner.resolve() },
}
try {
  host = await nativeTaskHost(root, async () => { throw new Error('Unexpected native model call') }, {
    serviceFactory: async args => {
      store = await openDynamicTaskStore({ dbPath: args.config.dbPath, instanceId: args.config.instanceId, initialize: true, webActorId: args.config.webActorId })
      const proxy = {
        ...store,
        async command(request) {
          const result = await store.command(request)
          if (request.kind === 'task.revise') intercept = true
          return result
        },
        async query(request) {
          if (intercept && !blocked && request.kind === 'execution.list' && request.taskId) {
            blocked = true
            await Promise.race([started.promise, releaseGate.promise])
          }
          return store.query(request)
        },
      }
      return openTaskSessionService({ ...args, store: proxy, taskSessions: sessions })
    },
  })
  const task = await host.service.createTask({ groupId: 'native-group', requestId: 'initial', title: 'Race', objective: 'Check the task' })
  await host.service.whenIdle()
  const before = await host.query('task.get', { taskId: task.taskId })
  let settled = false
  const admission = host.service.appendTaskContext({ taskId: task.taskId, requestId: 'revision', progressImpact: 'replan', expectedRequirementRevision: before.requirementRevision, expectedControlRevision: before.controlRevision, context: 'Change the requirements' }).then(value => { settled = true; return value })
  const lease = await Promise.race([started.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('new owner did not start')), 15000))])
  await waitUntil(() => cancelled.length > 0, 'cancel called after new owner started')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(blocked, true)
  assert.equal(cancelled[0].runs, 2)
  assert.equal(settled, false)
  console.log(JSON.stringify({ result: 'REPRODUCED', lease, ownerRuns: runs, cancelObservedRun: cancelled[0].runs, admissionSettledWhileNewOwnerBlocked: settled }))
  releaseOwner.resolve()
  await admission
} finally {
  releaseGate.resolve()
  releaseOwner.resolve()
  await host?.close()
  await store?.close()
  await rm(root, { recursive: true, force: true })
}
} else {
  throw new Error('Choose --material-failure, --claim-race, --claim-committed, --held-queued, --held-open-slot, --owner-wake, or --baseline')
}
