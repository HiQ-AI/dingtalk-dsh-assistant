import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { available, reason, nativeTaskHost, latestInput, waitUntil } from './fixtures/task-session-native-host.js'

test('concurrency-safe is not pure: an unknown native write never dispatches a second call', { skip: !available ? reason : false, timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-unknown-native-'))
  let host, delegated = false, calls = 0, writes = 0
  t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
  host = await nativeTaskHost(root, async (request, h) => {
    const input = latestInput(request), names = request.tools.map(tool => tool.name)
    if (names.includes('group_coordinator_submit')) return [{ name: 'group_coordinator_submit', args: { decision: { actions: input.sources.map(source => ({ action: 'create', sourceId: source.sourceId, objective: source.text })) } } }]
    if (names.includes('task_delegate')) {
      if (!delegated) {
        delegated = true
        h.ctx.tools.register({ name: 'concurrent_write_probe', description: 'Controlled external effect fixture',
          parameters: { type: 'object', properties: {}, additionalProperties: false }, isConcurrencySafe: () => true,
          output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          async execute() { writes++; throw new Error('write_applied_receipt_lost') } })
        return [{ name: 'task_delegate', args: { key: 'write', objective: 'Perform the authorized effect once' } }]
      }
      return [{ name: 'task_session_submit', args: { decision: { action: 'wait', summary: '等待原操作对账，不能重放。', evidence: [], limitations: ['原操作结果未知。'] } } }]
    }
    if (calls++ < 2) return [{ name: 'concurrent_write_probe', args: {} }]
    return [{ name: 'execution_submit', args: { output: { status: 'completed', summary: '原操作待对账。', evidence: [], limitations: ['没有重复写入。'], artifacts: [] } } }]
  })
  await host.service.ingest({ groupId: 'native-group', messageId: 'unknown-write', senderOpenDingTalkId: 'native-user', text: '只执行一次授权动作。', timestamp: '2026-10-13T11:00:00Z' })
  await waitUntil(() => calls >= 3, 'second attempted tool call returns without re-dispatch')
  await host.service.whenIdle()
  assert.equal(writes, 1)
  const operations = await host.query('operation.list')
  assert.equal(operations.length, 1)
  assert.equal(operations[0].state, 'unknown')
  assert.ok(host.toolResults.some(item => JSON.stringify(item.result).includes('DYNAMIC_OPERATION_UNRESOLVED')))
  assert.equal((await host.query('task.list'))[0].status, 'active')
})

test('native start-race rejection retires only its prepared request and completion resumes after the original effect is reconciled', { skip: !available ? reason : false, timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-unknown-race-'))
  let host, ledger, delegated = false, executionCalled = false, writes = 0, injected = false, reconciled = false
  t.after(async () => { await host?.close(); await ledger?.close(); await rm(root, { recursive: true, force: true }) })
  ledger = await openDynamicTaskStore({ dbPath: join(root, 'dynamic.db'), instanceId: 'native-test', initialize: true })
  const originalCommand = ledger.command.bind(ledger)
  // Deterministically insert the legal interleaving after native prepare, before its atomic start.
  // This is a real SQLite ledger fault injector, not a replacement for native sessions/tools.
  const wrappedStore = { query: ledger.query.bind(ledger), command: async command => {
    if (!injected && command.kind === 'operation.start') {
      injected = true
      const binding = command.args.binding
      const { result: { operation } } = await originalCommand({ id: 'race-other-prepare', kind: 'operation.prepare', args: { binding, key: 'other-effect', definition: { toolName: 'external-effect-fixture' }, resourceKeys: [] } })
      await originalCommand({ id: 'race-other-start', kind: 'operation.start', args: { binding, operationId: operation.operationId } })
      await originalCommand({ id: 'race-other-unknown', kind: 'operation.settle', args: { binding, operationId: operation.operationId, state: 'unknown', result: { lostReceipt: true } } })
    }
    return originalCommand(command)
  } }
  host = await nativeTaskHost(root, async (request, h) => {
    const input = latestInput(request), names = request.tools.map(tool => tool.name)
    if (names.includes('group_coordinator_submit')) return [{ name: 'group_coordinator_submit', args: { decision: { actions: input.sources.map(source => ({ action: 'create', sourceId: source.sourceId, objective: source.text })) } } }]
    if (names.includes('task_delegate')) {
      if (!delegated) {
        delegated = true
        h.ctx.tools.register({ name: 'race_write_probe', description: 'Controlled write for dispatch-race testing',
          parameters: { type: 'object', properties: {}, additionalProperties: false }, isConcurrencySafe: () => true,
          output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          async execute() { writes++; return { wrote: true } } })
        return [{ name: 'task_delegate', args: { key: 'race', objective: 'Check the effect exactly once' } }]
      }
      return [{ name: 'task_session_submit', args: { decision: { action: reconciled ? 'complete' : 'wait', summary: reconciled ? '已核对原操作，没有重复执行。' : '原操作待对账。', evidence: [], limitations: [] } } }]
    }
    if (!executionCalled) { executionCalled = true; return [{ name: 'race_write_probe', args: {} }] }
    return [{ name: 'execution_submit', args: { output: { status: 'completed', summary: '本次没有派发新操作。', evidence: [], limitations: ['原操作待核对。'], artifacts: [] } } }]
  }, {store:wrappedStore})
  await host.service.ingest({ groupId: 'native-group', messageId: 'unknown-race', senderOpenDingTalkId: 'native-user', text: '核对原动作，不要重复执行。', timestamp: '2026-10-13T11:00:00Z' })
  await waitUntil(async () => (await host.query('execution.list'))[0]?.drained === true, 'native rejection and execution drain')
  await host.service.whenIdle()
  const operations = await host.query('operation.list'), refused = operations.find(item => item.definition.toolName === 'race_write_probe'), original = operations.find(item => item.key === 'other-effect')
  assert.equal(writes, 0)
  assert.equal(refused.state, 'cancelled')
  assert.equal(refused.result.notDispatched, true)
  assert.equal(original.state, 'unknown')
  reconciled = true
  await originalCommand({ id: 'race-real-readback', kind: 'operation.reconcile', args: { operationId: original.operationId, state: 'succeeded', result: { verified: true }, evidenceRef: 'trusted-original-receipt' } })
  await host.service.recover(); await host.service.whenIdle()
  assert.equal((await host.query('task.list'))[0].status, 'completed')
  assert.equal(writes, 0)
})
