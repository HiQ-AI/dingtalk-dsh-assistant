import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { available, reason, nativeTaskHost, latestInput, nativeShell, waitUntil, topicTaskCalls } from './fixtures/task-session-native-host.js'

test('restart wakes technical unknown wait once per implementation and retains the effect fence', { skip: !available ? reason : false, timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-runtime-wake-'))
  let host, delegated = false, probed = false, writes = 0, ownerRounds = 0
  t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
  const decide = async (request, h) => {
    const input = latestInput(request), names = request.tools.map(tool => tool.name)
    const topicCalls = topicTaskCalls(request)
    if (topicCalls) return topicCalls
    if (names.includes('group_coordinator_submit')) return [{ name: 'group_coordinator_submit', args: { decision: { actions: input.sources.map(source => ({ action: 'create', sourceId: source.sourceId, objective: source.text })) } } }]
    if (names.includes('task_delegate')) {
      ownerRounds++
      if (!delegated) {
        delegated = true
        h.ctx.tools.register({ name: 'lost_effect', description: 'Unknown effect fixture', parameters: { type: 'object' },
          output: { schema: { type: 'object' }, render: () => [] }, execute() { writes++; throw new Error('lost receipt') } })
        return [{ name: 'task_delegate', args: { key: 'effect', objective: 'Observe one effect' } }]
      }
      return [{ name: 'task_session_submit', args: { decision: { action: 'wait', summary: '等待原操作对账。', evidence: [], limitations: [] } } }]
    }
    if (!probed) { probed = true; return [{ name: 'lost_effect', args: {} }] }
    return [{ name: 'execution_submit', args: { output: { status: 'blocked', summary: '效果未知。', evidence: [], limitations: [], artifacts: [] } } }]
  }
  host = await nativeTaskHost(root, decide)
  await host.service.ingest({ groupId: 'native-group', messageId: 'runtime-wait', senderOpenDingTalkId: 'native-user', text: '测试助手，执行原操作。', timestamp: '2026-10-13T11:00:00Z' })
  await host.service.whenIdle()
  const original = (await host.query('task.list'))[0], before = ownerRounds
  assert.equal((await host.query('operation.list'))[0].state, 'unknown')
  await host.close()
  host = await nativeTaskHost(root, decide, { initialize: false })
  await host.service.recover(); await host.service.whenIdle()
  assert.equal(ownerRounds, before + 1)
  assert.equal((await host.query('task.list'))[0].taskId, original.taskId)
  assert.equal((await host.query('operation.list'))[0].state, 'unknown')
  assert.equal(writes, 1)
  for (let i = 0; i < 3; i++) { await host.service.recover(); await host.service.whenIdle() }
  assert.equal(ownerRounds, before + 1)
  await host.close()
  host = await nativeTaskHost(root, decide, { initialize: false })
  await host.service.recover(); await host.service.whenIdle()
  assert.equal(ownerRounds, before + 1, 'same code restart must not manufacture another wake')
})

test('未知写保留unknown，独立原生终端调查仍可执行', { skip: !available ? reason : false, timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-unknown-native-'))
  let host, delegated = false, calls = 0, writes = 0
  t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
  host = await nativeTaskHost(root, async (request, h) => {
    const input = latestInput(request), names = request.tools.map(tool => tool.name)
    const topicCalls = topicTaskCalls(request)
    if (topicCalls) return topicCalls
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
    if (calls++ === 0) return [{ name: 'concurrent_write_probe', args: {} }]
    if (calls === 2) return [{ name: nativeShell, args: { command: nativeShell === 'pwsh' ? "Write-Output 'independent investigation'" : "printf 'independent investigation'", description: 'Independent read-only investigation' } }]
    return [{ name: 'execution_submit', args: { output: { status: 'completed', summary: '原操作待对账。', evidence: [], limitations: ['没有重复写入。'], artifacts: [] } } }]
  })
  await host.service.ingest({ groupId: 'native-group', messageId: 'unknown-write', senderOpenDingTalkId: 'native-user', text: '测试助手，只执行一次授权动作。', timestamp: '2026-10-13T11:00:00Z' })
  await waitUntil(() => calls >= 3, 'independent investigation returns without replay')
  await host.service.whenIdle()
  assert.equal(writes, 1)
  const operations = await host.query('operation.list')
  assert.equal(operations.length, 2)
  assert.equal(operations[0].state, 'unknown')
  assert.equal(operations[1].state, 'succeeded')
  assert.ok(host.toolResults.some(item => item.name === nativeShell && !item.result.isError))
  assert.equal((await host.query('task.list'))[0].status, 'active')
})

test('同一原生操作已派发时拒绝再次执行，原账对账后可完成', { skip: !available ? reason : false, timeout: 15000 }, async t => {
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
      const operation = { operationId: command.args.operationId }
      await originalCommand({ id: 'race-other-start', kind: 'operation.start', args: { binding, operationId: operation.operationId } })
      await originalCommand({ id: 'race-other-unknown', kind: 'operation.settle', args: { binding, operationId: operation.operationId, state: 'unknown', result: { lostReceipt: true } } })
    }
    return originalCommand(command)
  } }
  host = await nativeTaskHost(root, async (request, h) => {
    const input = latestInput(request), names = request.tools.map(tool => tool.name)
    const topicCalls = topicTaskCalls(request)
    if (topicCalls) return topicCalls
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
  await host.service.ingest({ groupId: 'native-group', messageId: 'unknown-race', senderOpenDingTalkId: 'native-user', text: '测试助手，核对原动作，不要重复执行。', timestamp: '2026-10-13T11:00:00Z' })
  await waitUntil(async () => (await host.query('execution.list'))[0]?.drained === true, 'native rejection and execution drain')
  await host.service.whenIdle()
  const operations = await host.query('operation.list'), original = operations[0]
  assert.equal(writes, 0)
  assert.equal(operations.length, 1)
  assert.equal(original.state, 'unknown')
  reconciled = true
  await originalCommand({ id: 'race-real-readback', kind: 'operation.reconcile', args: { operationId: original.operationId, state: 'succeeded', result: { verified: true }, evidenceRef: 'trusted-original-receipt' } })
  await host.service.recover(); await host.service.whenIdle()
  assert.equal((await host.query('task.list'))[0].status, 'completed')
  assert.equal(writes, 0)
})

for (const mutation of ['edit', 'write', 'edit-noop']) test('原生文件前置拒绝后同会话读取纠正，无人工处理: ' + mutation, { skip: !available ? reason : false, timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-file-correction-'))
  const { writeFile, readFile } = await import('node:fs/promises')
  let host, delegated=false, step=0, sessionId
  t.after(async()=>{await host?.close();await rm(root,{recursive:true,force:true})})
  const file=join(root,'existing.txt');await writeFile(file,'before')
  host=await nativeTaskHost(root,async(request,h)=>{
    const names=request.tools.map(tool=>tool.name),topic=topicTaskCalls(request)
    if(topic)return topic
    if(names.includes('group_coordinator_submit'))return [{name:'group_coordinator_submit',args:{decision:{actions:latestInput(request).sources.map(source=>({action:'create',sourceId:source.sourceId,objective:source.text}))}}}]
    if(names.includes('task_delegate')){
      if(!delegated){delegated=true;return [{name:'task_delegate',args:{key:'correct-file',objective:'Read and correct the file after a precondition failure'}}]}
      return [{name:'task_session_submit',args:{decision:{action:latestInput(request).executions.every(x=>x.status==='succeeded')?'complete':'wait',summary:'文件已读取并修改',evidence:[],limitations:[]}}}]
    }
    const tool=mutation==='edit-noop'?'edit':mutation
    const args=tool==='edit'?{file_path:file,old_string:'before',new_string:'after'}:{file_path:file,content:'after'}
    if(step++===0)return [{name:tool,args:mutation==='edit-noop'?{...args,new_string:args.old_string}:args}]
    if(step===2){
      assert.equal(await readFile(file,'utf8'),'before')
      const operations=await h.query('operation.list');assert.equal(operations.length,1)
      assert.equal(operations[0].state,'failed');assert.equal(operations[0].result.errorCode,mutation==='edit-noop'?'NATIVE_EDIT_ARGUMENT_REJECTED':'FS_NOT_OBSERVED');assert.equal(operations[0].result.noEffect,true)
      sessionId=(await h.query('execution.list'))[0].sessionId
      return [{name:'read',args:{file_path:file}}]
    }
    if(step===3)return [{name:tool,args}]
    return [{name:'execution_submit',args:{output:{status:'completed',summary:'读取后已完成',evidence:[],limitations:[],artifacts:[]}}}]
  },{fsObservationPolicy:true})
  await host.service.ingest({groupId:'native-group',messageId:'correct-'+mutation,senderOpenDingTalkId:'native-user',text:'测试助手，修改指定文件',timestamp:'2026-10-15T01:00:00Z'})
  await host.service.whenIdle()
  assert.equal(await readFile(file,'utf8'),'after')
  const operations=await host.query('operation.list');assert.deepEqual(operations.map(x=>x.state),['failed','succeeded'])
  assert.equal((await host.query('execution.list')).length,1);assert.equal((await host.query('execution.list'))[0].sessionId,sessionId)
  const task=(await host.query('task.list'))[0];assert.equal(task.status,'completed');assert.equal(task.humanRequests?.length??0,0)
})
