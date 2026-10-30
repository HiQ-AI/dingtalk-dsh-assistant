import test from 'node:test'
import assert from 'node:assert/strict'
import { available, reason } from './fixtures/task-session-native-host.js'
import { retiredCoordinationHost } from './fixtures/retired-coordination-native.js'

test('retired reorder assessments remain historical while explicit changed scope reaches only the original Task Owner',
  { skip: !available ? reason : false, timeout: 20000 }, async t => {
    const assessment = { id: 'old-assessment', state: 'pending', decision: null, originalDependencies: [], proposedDependencies: ['a'] }
    const member = { id: 'b', taskId: 'B', coordinationId: 'batch', state: 'applied', dependencies: [],
      instruction: '原B工作', reorderAssessment: assessment }
    const f = await retiredCoordinationHost(t, { name: 'retired-reorder-', tasks: [{ taskId: 'A' }, { taskId: 'B' }], rows: {
      coordination: [{ id: 'batch', groupId: 'native-group', state: 'active', revision: 1, memberIds: ['a', 'b'] }],
      coordination_members: [{ id: 'a', taskId: 'A', coordinationId: 'batch', state: 'waiting', dependencies: [], instruction: '原A工作' }, member],
      wakes: [{ id: 'old-reorder', taskId: 'B', kind: 'coordination.reorder', state: 'pending', payload: { instructionId: 'b', assessmentId: assessment.id } }],
    } })
    let h = f.host
    await h.service.recover(); await h.service.whenIdle()
    const history = await h.query('coordination.get', { coordinationId: 'batch' })
    const saved = history.members.find(item => item.id === 'b')
    assert.deepEqual(saved.reorderAssessment, assessment)
    assert.deepEqual(saved.dependencies, [])
    assert.equal(saved.state, 'applied'); assert.equal(saved.retirement.previousState, 'applied')
    const oldWake = (await h.query('wake.list', { taskId: 'B' })).find(wake => wake.id === 'old-reorder')
    assert.equal(oldWake.state, 'acked'); assert.equal(oldWake.retirement.previousState, 'pending')
    assert.deepEqual(await h.query('task.list'), f.beforeTasks)
    assert.deepEqual(await h.query('execution.list'), [])
    await h.service.appendTaskContext({ taskId: 'B', requestId: 'scope-change', context: '先核对A的完成证据，再处理B；当前不启动执行',
      objective: '核对前置结果后继续原B工作', expectedRequirementRevision: 1, expectedControlRevision: 1, progressImpact: 'replan' })
    await h.service.whenIdle()
    const after = await h.query('task.get', { taskId: 'B' })
    assert.equal(after.requirementRevision, 2); assert.equal(after.runSequence, 1)
    assert.equal(after.objective, '核对前置结果后继续原B工作')
    assert.equal(after.status, 'active')
    assert.deepEqual(await h.query('task.get', { taskId: 'A' }), f.beforeTasks.find(task => task.taskId === 'A'))
    assert.deepEqual(await h.query('coordination.get', { coordinationId: 'batch' }), history)
    assert.deepEqual(await h.query('execution.list'), [])
    assert.ok(f.requests.every(request => !request.tools.some(tool => tool.name === 'task_coordination_reorder_assess')))
    h = await f.restart(); await h.service.recover(); await h.service.whenIdle()
    assert.deepEqual(await h.query('task.get', { taskId: 'B' }), after)
    assert.deepEqual(await h.query('coordination.get', { coordinationId: 'batch' }), history)
    assert.equal(h.sent.length, 0)
  })
