import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { installTaskPlanSchema, reduceTaskPlanCommand } from '../packages/dingtalk-dsh-assistant/execution-task-plan.js'
import { installTaskOwnerSchema, validateTaskOwnerSchema, reduceTaskOwnerCommand,
  queryTaskOwner, recoverTaskOwners } from '../packages/dingtalk-dsh-assistant/task-owner-store.js'

const at = '2026-09-25T00:00:00.000Z'
test('迁移后的空要求 Task 可绑定原目标且不改写计划版本', () => {
  const db = new DatabaseSync(':memory:')
  try {
    installTaskPlanSchema(db)
    db.prepare("INSERT INTO business_tasks(task_id,requirement_revision,plan_revision,plan_requirement_revision,status,created_at,updated_at) VALUES('legacy',3,1,3,'succeeded',?,?)").run(at, at)
    db.prepare("INSERT INTO task_controls(task_id,control_revision,state) VALUES('legacy',1,'active')").run()
    db.prepare("INSERT INTO task_plan_stages(task_id,plan_revision,stage_id,position,workflow_id,gate,status,attempt,output_ref) VALUES('legacy',1,'stage-1',0,'task-analysis','none','succeeded',1,?)").run('sha256-'+'a'.repeat(64)+'.json')
    const ref = 'sha256-'+'b'.repeat(64)+'.json'
    assert.equal(reduceTaskPlanCommand(db, { kind: 'task.requirement.bind-legacy', args: {
      taskId: 'legacy', expectedRequirementRevision: 3, requirementRef: ref } }, { now: at }).requirementRevision, 3)
    const row = db.prepare("SELECT requirement_revision,requirement_ref,plan_requirement_revision FROM business_tasks WHERE task_id='legacy'").get()
    assert.deepEqual({ ...row }, { requirement_revision: 3, requirement_ref: ref, plan_requirement_revision: 3 })
    assert.throws(() => reduceTaskPlanCommand(db, { kind: 'task.requirement.bind-legacy', args: {
      taskId: 'legacy', expectedRequirementRevision: 3, requirementRef: ref } }, { now: at }),
    { code: 'TASK_REQUIREMENT_LEGACY_CONFLICT' })
  } finally { db.close() }
})
function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  installTaskPlanSchema(db)
  installTaskOwnerSchema(db)
  db.prepare("INSERT INTO business_tasks(task_id,requirement_revision,plan_revision,plan_requirement_revision,status,created_at,updated_at) VALUES('task-1',1,1,1,'active',?,?)").run(at, at)
  db.prepare("INSERT INTO task_controls(task_id,control_revision,state) VALUES('task-1',1,'active')").run()
  db.prepare("INSERT INTO task_plan_stages(task_id,plan_revision,stage_id,position,workflow_id,gate,status,attempt) VALUES('task-1',1,'stage-1',0,'task-general','none','ready',1)").run()
  const send = (kind, args) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = reduceTaskOwnerCommand(db, { kind, args }, { now: at })
      db.exec('COMMIT')
      return result
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  send('task.owner.init', { taskId: 'task-1', sessionId: 'session-1',
    sourceKey: 'source-1', criteria: ['完成原任务目标'] })
  return { db, send, read: kind => queryTaskOwner(db, { kind, taskId: 'task-1' }) }
}

test('同一任务连续事件复用稳定会话，eventKey 重放不会多次处理', () => {
  const f = fixture()
  try {
    const first = f.send('task.owner.event', { taskId: 'task-1', eventKey: 'created', eventType: 'task.created' })
    assert.equal(f.send('task.owner.event', { taskId: 'task-1', eventKey: 'created', eventType: 'task.created' }).eventSeq, first.eventSeq)
    assert.throws(() => f.send('task.owner.event', { taskId: 'task-1', eventKey: 'created', eventType: 'intent.received' }),
      { code: 'TASK_OWNER_EVENT_CONFLICT' })
    const claim = f.send('task.owner.claim', { taskId: 'task-1', turnId: 'turn-1', expectedLeaseEpoch: 0 })
    assert.equal(claim.sessionId, 'session-1')
    f.send('task.owner.sessionBound', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1, sessionId: 'session-1' })
    f.send('task.owner.candidate', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1,
      decision: { action: 'wait', summary: '等待用户提供信息', evidenceRefs: [] } })
    assert.equal(f.send('task.owner.accept', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1 }).status, 'accepted')
    assert.equal(f.read('task.owner').processedWatermark, first.eventSeq)
    assert.equal(f.read('task.owner').sessionId, 'session-1')
    const second = f.send('task.owner.event', { taskId: 'task-1', eventKey: 'new-info', eventType: 'intent.received' })
    const next = f.send('task.owner.claim', { taskId: 'task-1', turnId: 'turn-2', expectedLeaseEpoch: 1 })
    assert.equal(next.eventWatermark, second.eventSeq)
    assert.equal(next.sessionId, 'session-1')
    assert.equal(f.read('task.owner.events').length, 2)
    validateTaskOwnerSchema(f.db)
  } finally { f.db.close() }
})

test('新事件和版本变化使旧候选失效，旧租约不能提交', () => {
  const f = fixture()
  try {
    f.send('task.owner.event', { taskId: 'task-1', eventKey: 'e1', eventType: 'task.created' })
    f.send('task.owner.claim', { taskId: 'task-1', turnId: 'turn-1', expectedLeaseEpoch: 0 })
    f.send('task.owner.sessionBound', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1, sessionId: 'session-1' })
    f.send('task.owner.candidate', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1,
      decision: { action: 'advance', summary: '启动排查', evidenceRefs: [], appendStages: [{ workflowId: 'task-general', gate: 'none' }] } })
    f.send('task.owner.event', { taskId: 'task-1', eventKey: 'e2', eventType: 'intent.received' })
    assert.throws(() => f.send('task.owner.accept', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1 }),
      { code: 'TASK_OWNER_CANDIDATE_STALE' })
    assert.equal(f.read('task.owner').processedWatermark, 0)
    f.send('task.owner.release', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1 })
    f.send('task.owner.claim', { taskId: 'task-1', turnId: 'turn-2', expectedLeaseEpoch: 1 })
    assert.throws(() => f.send('task.owner.candidate', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1,
      decision: { action: 'wait', summary: '旧决定', evidenceRefs: [] } }), { code: 'TASK_OWNER_LEASE_STALE' })
    f.db.prepare('UPDATE task_controls SET control_revision=control_revision+1 WHERE task_id=?').run('task-1')
    f.send('task.owner.candidate', { taskId: 'task-1', turnId: 'turn-2', leaseEpoch: 2,
      decision: { action: 'wait', summary: '待处理', evidenceRefs: [] } })
    assert.throws(() => f.send('task.owner.accept', { taskId: 'task-1', turnId: 'turn-2', leaseEpoch: 2 }),
      { code: 'TASK_OWNER_CANDIDATE_STALE' })
  } finally { f.db.close() }
})

test('重启恢复使运行中候选失效并重新排队，不丢事件', () => {
  const f = fixture()
  try {
    f.send('task.owner.event', { taskId: 'task-1', eventKey: 'e1', eventType: 'task.created' })
    f.send('task.owner.claim', { taskId: 'task-1', turnId: 'turn-1', expectedLeaseEpoch: 0 })
    f.send('task.owner.candidate', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1,
      decision: { action: 'wait', summary: '候选已落盘', evidenceRefs: [] } })
    assert.deepEqual(recoverTaskOwners(f.db), { recovered: 1 })
    assert.equal(f.read('task.owner').status, 'pending')
    assert.equal(f.read('task.owner').processedWatermark, 0)
    assert.equal(queryTaskOwner(f.db, { kind: 'task.owners.pending' }).length, 1)
    assert.throws(() => f.send('task.owner.accept', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1 }),
      { code: 'TASK_OWNER_LEASE_STALE' })
    const next = f.send('task.owner.claim', { taskId: 'task-1', turnId: 'turn-2', expectedLeaseEpoch: 2 })
    assert.equal(next.sessionId, 'session-1')
    assert.equal(next.leaseEpoch, 3)
    validateTaskOwnerSchema(f.db)
  } finally { f.db.close() }
})

test('已接纳决定在应用回执前持续可查，重启后重放并幂等确认', () => {
  const f = fixture()
  try {
    f.send('task.owner.event', { taskId: 'task-1', eventKey: 'e1', eventType: 'task.created' })
    f.send('task.owner.claim', { taskId: 'task-1', turnId: 'turn-1', expectedLeaseEpoch: 0 })
    f.send('task.owner.sessionBound', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1, sessionId: 'session-1' })
    f.send('task.owner.candidate', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1,
      decision: { action: 'advance', summary: '继续排查', evidenceRefs: [],
        appendStages: [{ workflowId: 'task-general', gate: 'none' }] } })
    f.send('task.owner.accept', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1 })
    const pending = () => queryTaskOwner(f.db, { kind: 'task.owner.actions.pending' })
    assert.deepEqual(pending().map(item => item.turnId), ['turn-1'])
    assert.deepEqual([pending()[0].requirementRevision, pending()[0].planRevision, pending()[0].controlRevision], [1, 1, 1])
    assert.equal(f.read('task.owner').applicationStatus, 'pending')
    assert.deepEqual(recoverTaskOwners(f.db), { recovered: 0 })
    assert.deepEqual(pending().map(item => item.turnId), ['turn-1'])
    assert.equal(f.send('task.owner.applied', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1 }).status, 'applied')
    assert.equal(f.send('task.owner.applied', { taskId: 'task-1', turnId: 'turn-1' }).status, 'applied')
    assert.deepEqual(pending(), [])
    validateTaskOwnerSchema(f.db)
  } finally { f.db.close() }
})

test('complete 仅接纳当前计划全部阶段具有产物与证据的成功状态', () => {
  const f = fixture()
  try {
    f.send('task.owner.event', { taskId: 'task-1', eventKey: 'e1', eventType: 'task.created' })
    f.send('task.owner.claim', { taskId: 'task-1', turnId: 'turn-1', expectedLeaseEpoch: 0 })
    f.send('task.owner.sessionBound', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1, sessionId: 'session-1' })
    f.send('task.owner.candidate', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1,
      decision: { action: 'complete', summary: '任务完成', evidenceRefs: ['proof/result.json'],
        assessments: [{ itemId: 'acceptance-1', status: 'satisfied', evidenceRefs: ['proof/result.json'] }] } })
    assert.throws(() => f.send('task.owner.accept', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1 }),
      { code: 'TASK_OWNER_COMPLETION_UNPROVEN' })
    f.db.prepare("UPDATE business_tasks SET status='succeeded' WHERE task_id='task-1'").run()
    assert.throws(() => f.send('task.owner.accept', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1 }),
      { code: 'TASK_OWNER_COMPLETION_UNPROVEN' })
    f.db.prepare("UPDATE task_plan_stages SET status='succeeded',output_ref='proof/output.json',evidence_refs='[\"proof/result.json\"]' WHERE task_id='task-1'").run()
    assert.equal(f.send('task.owner.accept', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1 }).status, 'accepted')
    assert.equal(f.read('task.owner').decision.action, 'complete')
  } finally { f.db.close() }
})

test('目标验收项必须逐项绑定真实阶段证据，新增目标使旧完成声明失效', () => {
  const f = fixture()
  try {
    f.db.prepare("UPDATE business_tasks SET status='succeeded' WHERE task_id='task-1'").run()
    f.db.prepare("UPDATE task_plan_stages SET status='succeeded',output_ref='proof/output.json',evidence_refs='[\"proof/result.json\"]' WHERE task_id='task-1'").run()
    f.send('task.owner.acceptance.extend', { taskId: 'task-1', itemId: 'acceptance-2',
      criterion: '交付新的调查结论', sourceKey: 'source-2', eventKey: 'acceptance-new-goal' })
    assert.deepEqual(f.read('task.owner.acceptance').map(item => item.itemId), ['acceptance-1', 'acceptance-2'])
    f.send('task.owner.event', { taskId: 'task-1', eventKey: 'e1', eventType: 'workflow.succeeded' })
    f.send('task.owner.claim', { taskId: 'task-1', turnId: 'turn-1', expectedLeaseEpoch: 0 })
    f.send('task.owner.sessionBound', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1, sessionId: 'session-1' })
    f.send('task.owner.candidate', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1,
      decision: { action: 'complete', summary: '全部完成', evidenceRefs: ['proof/result.json'],
        assessments: [{ itemId: 'acceptance-1', status: 'satisfied', evidenceRefs: ['proof/result.json'] }] } })
    assert.throws(() => f.send('task.owner.accept', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1 }),
      { code: 'TASK_OWNER_COMPLETION_UNPROVEN' })
  } finally { f.db.close() }
})

test('负责人连续三次无有效提交后可见阻塞，新输入重新开放而不重建Task', () => {
  const f = fixture()
  try {
    f.send('task.owner.event', { taskId: 'task-1', eventKey: 'created', eventType: 'task.created' })
    for (let attempt = 1; attempt <= 3; attempt++) {
      f.send('task.owner.claim', { taskId: 'task-1', turnId: `turn-${attempt}`, expectedLeaseEpoch: attempt - 1 })
      const result = f.send('task.owner.release', { taskId: 'task-1', turnId: `turn-${attempt}`,
        leaseEpoch: attempt, reason: 'TASK_OWNER_NO_DECISION' })
      assert.equal(result.failureCount, attempt)
    }
    assert.equal(f.read('task.owner').status, 'blocked')
    assert.deepEqual(queryTaskOwner(f.db, { kind: 'task.owners.pending' }), [])
    f.send('task.owner.event', { taskId: 'task-1', eventKey: 'followup', eventType: 'intent.received' })
    assert.equal(f.read('task.owner').status, 'pending')
    assert.equal(f.read('task.owner').failureCount, 0)
  } finally { f.db.close() }
})

test('接纳后应用前收到新意图会丢弃旧决定并保留新事件', () => {
  const f = fixture()
  try {
    f.send('task.owner.event', { taskId: 'task-1', eventKey: 'created', eventType: 'task.created' })
    f.send('task.owner.claim', { taskId: 'task-1', turnId: 'turn-1', expectedLeaseEpoch: 0 })
    f.send('task.owner.sessionBound', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1, sessionId: 'session-1' })
    f.send('task.owner.candidate', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1,
      decision: { action: 'advance', summary: '启动阶段', evidenceRefs: [] } })
    f.send('task.owner.accept', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1 })
    f.send('task.owner.event', { taskId: 'task-1', eventKey: 'new-input', eventType: 'intent.received' })
    assert.equal(f.send('task.owner.discard', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1 }).status, 'discarded')
    assert.equal(f.read('task.owner.reports')[0].applicationStatus, 'discarded')
    assert.equal(f.read('task.owner').status, 'pending')
    assert.equal(f.read('task.owner').processedWatermark, 1)
    assert.equal(f.read('task.owner').eventWatermark, 2)
  } finally { f.db.close() }
})

test('只有已绑定会话被确认缺失后才能换代，原任务和事件仍在', () => {
  const f = fixture()
  try {
    assert.throws(() => f.send('task.owner.replace-session', { taskId: 'task-1',
      expectedLeaseEpoch: 0, newSessionId: 'session-2', reason: 'SESSION_NOT_FOUND' }),
    { code: 'TASK_OWNER_REPLACEMENT_CONFLICT' })
    f.send('task.owner.event', { taskId: 'task-1', eventKey: 'created', eventType: 'task.created' })
    f.send('task.owner.claim', { taskId: 'task-1', turnId: 'turn-1', expectedLeaseEpoch: 0 })
    f.send('task.owner.sessionBound', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1, sessionId: 'session-1' })
    f.send('task.owner.release', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1,
      reason: 'TASK_OWNER_SESSION_MISSING' })
    assert.throws(() => f.send('task.owner.replace-session', { taskId: 'task-1',
      expectedLeaseEpoch: 1, newSessionId: 'session-2', reason: 'IO_ERROR' }),
    { code: 'TASK_OWNER_REPLACEMENT_CONFLICT' })
    assert.equal(f.send('task.owner.replace-session', { taskId: 'task-1',
      expectedLeaseEpoch: 1, newSessionId: 'session-2', reason: 'SESSION_NOT_FOUND' }).ownerEpoch, 2)
    assert.equal(f.read('task.owner').sessionId, 'session-2')
    assert.equal(f.read('task.owner').sessionBound, false)
    assert.equal(f.read('task.owner.events').length, 2)
  } finally { f.db.close() }
})

test('已接纳动作应用连续失败有界阻塞，不在恢复循环中无限重试', () => {
  const f = fixture()
  try {
    f.send('task.owner.event', { taskId: 'task-1', eventKey: 'created', eventType: 'task.created' })
    f.send('task.owner.claim', { taskId: 'task-1', turnId: 'turn-1', expectedLeaseEpoch: 0 })
    f.send('task.owner.sessionBound', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1, sessionId: 'session-1' })
    f.send('task.owner.candidate', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1,
      decision: { action: 'advance', summary: '推进', evidenceRefs: [] } })
    f.send('task.owner.accept', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1 })
    for (let attempt = 1; attempt <= 3; attempt++)
      assert.equal(f.send('task.owner.action.fail', { taskId: 'task-1', turnId: 'turn-1',
        leaseEpoch: 1, reason: 'DOWNSTREAM_UNAVAILABLE' }).failureCount, attempt)
    assert.equal(f.read('task.owner').status, 'blocked')
    assert.equal(f.read('task.owner').lastFailure, 'DOWNSTREAM_UNAVAILABLE')
    assert.deepEqual(queryTaskOwner(f.db, { kind: 'task.owner.actions.pending' }), [])
  } finally { f.db.close() }
})

test('已完成排查收到同任务新意图后可追加开发，重启保留待应用决定', () => {
  const f = fixture()
  try {
    f.db.prepare("UPDATE business_tasks SET status='succeeded' WHERE task_id='task-1'").run()
    f.db.prepare("UPDATE task_plan_stages SET status='succeeded',output_ref='proof/investigation.json',evidence_refs='[\"proof/cause.json\"]' WHERE task_id='task-1'").run()
    f.send('task.owner.event', { taskId: 'task-1', eventKey: 'continue-dev', eventType: 'intent.received' })
    f.send('task.owner.claim', { taskId: 'task-1', turnId: 'turn-dev', expectedLeaseEpoch: 0 })
    f.send('task.owner.sessionBound', { taskId: 'task-1', turnId: 'turn-dev', leaseEpoch: 1, sessionId: 'session-1' })
    f.send('task.owner.candidate', { taskId: 'task-1', turnId: 'turn-dev', leaseEpoch: 1,
      decision: { action: 'advance', summary: '追加开发流程', evidenceRefs: ['proof/investigation.json'],
        appendStages: [{ workflowId: 'task-engineering', gate: 'none' }] } })
    assert.equal(f.send('task.owner.accept', { taskId: 'task-1', turnId: 'turn-dev', leaseEpoch: 1 }).status, 'accepted')
    assert.deepEqual(recoverTaskOwners(f.db), { recovered: 0 })
    assert.deepEqual(queryTaskOwner(f.db, { kind: 'task.owner.actions.pending' }).map(item => item.turnId), ['turn-dev'])
    validateTaskOwnerSchema(f.db)
  } finally { f.db.close() }
})

test('已完成计划缺少追加阶段或新意图时拒绝再次 advance', () => {
  for (const [eventType, appendStages] of [
    ['intent.received', undefined], ['workflow.succeeded', [{ workflowId: 'task-engineering', gate: 'none' }]],
  ]) {
    const f = fixture()
    try {
      f.db.prepare("UPDATE business_tasks SET status='succeeded' WHERE task_id='task-1'").run()
      f.send('task.owner.event', { taskId: 'task-1', eventKey: 'event-1', eventType })
      f.send('task.owner.claim', { taskId: 'task-1', turnId: 'turn-1', expectedLeaseEpoch: 0 })
      f.send('task.owner.sessionBound', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1, sessionId: 'session-1' })
      f.send('task.owner.candidate', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1,
        decision: { action: 'advance', summary: '继续处理', evidenceRefs: [], ...(appendStages ? { appendStages } : {}) } })
      assert.throws(() => f.send('task.owner.accept', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1 }),
        { code: 'TASK_OWNER_ADVANCE_CONFLICT' })
    } finally { f.db.close() }
  }
})
