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

test('非完成候选不得提交正式清单引用', () => {
  const f = fixture()
  try {
    f.send('task.owner.event', { taskId: 'task-1', eventKey: 'created', eventType: 'task.created' })
    f.send('task.owner.claim', { taskId: 'task-1', turnId: 'turn-1', expectedLeaseEpoch: 0 })
    f.send('task.owner.sessionBound', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1, sessionId: 'session-1' })
    f.send('task.owner.candidate', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1,
      decision: { action: 'wait', summary: '等待执行', evidenceRefs: [] } })
    assert.throws(() => f.send('task.owner.accept', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1,
      deliveryManifestRef: `sha256-${'a'.repeat(64)}.json` }), { code: 'TASK_OWNER_DELIVERY_MANIFEST_INVALID' })
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
    assert.deepEqual(f.read('task.owner.planning').receipts, [])
    assert.deepEqual(recoverTaskOwners(f.db), { recovered: 0 })
    assert.deepEqual(pending().map(item => item.turnId), ['turn-1'])
    assert.equal(f.send('task.owner.applied', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1 }).status, 'applied')
    assert.equal(f.send('task.owner.applied', { taskId: 'task-1', turnId: 'turn-1' }).status, 'applied')
    assert.deepEqual(pending(), [])
    assert.deepEqual(f.read('task.owner.planning').receipts.map(x => [x.turnId,x.planChangeKind]), [['turn-1','appendStages']])
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
    assert.throws(() => f.send('task.owner.accept', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1,
      deliveryManifestRef: 'tasks/task-1/not-a-digest.json' }), { code: 'TASK_OWNER_DELIVERY_MANIFEST_INVALID' })
    const deliveryManifestRef = `tasks/task-1/sha256-${'a'.repeat(64)}.json`
    assert.equal(f.send('task.owner.accept', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1, deliveryManifestRef }).status, 'accepted')
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

test('负责人连续纠正不设次数上限，新输入立即解除退避', () => {
  const f = fixture()
  try {
    f.send('task.owner.event', { taskId: 'task-1', eventKey: 'created', eventType: 'task.created' })
    for (let attempt = 1; attempt <= 3; attempt++) {
      f.send('task.owner.claim', { taskId: 'task-1', turnId: `turn-${attempt}`, expectedLeaseEpoch: attempt - 1 })
      const result = f.send('task.owner.release', { taskId: 'task-1', turnId: `turn-${attempt}`,
        leaseEpoch: attempt, reason: 'TASK_OWNER_NO_DECISION' })
      assert.equal(result.failureCount, attempt)
    }
    assert.equal(f.read('task.owner').status, 'pending')
    assert.ok(Date.parse(f.read('task.owner').retryAt) > Date.parse(at))
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

test('已接纳动作实现错误立即等待修复，不原样重试', () => {
  const f = fixture()
  try {
    f.send('task.owner.event', { taskId: 'task-1', eventKey: 'created', eventType: 'task.created' })
    f.send('task.owner.claim', { taskId: 'task-1', turnId: 'turn-1', expectedLeaseEpoch: 0 })
    f.send('task.owner.sessionBound', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1, sessionId: 'session-1' })
    f.send('task.owner.candidate', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1,
      decision: { action: 'advance', summary: '推进', evidenceRefs: [] } })
    f.send('task.owner.accept', { taskId: 'task-1', turnId: 'turn-1', leaseEpoch: 1 })
    for (let attempt = 1; attempt <= 1; attempt++)
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


test('取消或暂停不再调度 Owner，恢复后保留未读事件', () => {
  for (const state of ['cancelled', 'cancelling', 'paused', 'pausing']) {
    const f = fixture()
    try {
      f.send('task.owner.event', { taskId: 'task-1', eventKey: 'created', eventType: 'task.created' })
      f.db.prepare('UPDATE task_controls SET state=?').run(state)
      f.send('task.owner.event', { taskId: 'task-1', eventKey: 'control', eventType: 'control.changed' })
      assert.deepEqual(queryTaskOwner(f.db, { kind: 'task.owners.pending' }), [])
      assert.throws(() => f.send('task.owner.claim', { taskId: 'task-1', turnId: 'stopped', expectedLeaseEpoch: 0 }), { code: 'TASK_OWNER_NOT_CLAIMABLE' })
      f.db.prepare("UPDATE task_controls SET state='active'").run()
      assert.equal(queryTaskOwner(f.db, { kind: 'task.owners.pending' }).length, 1)
      assert.equal(f.send('task.owner.claim', { taskId: 'task-1', turnId: 'resumed', expectedLeaseEpoch: 0 }).eventWatermark, 2)
    } finally { f.db.close() }
  }
})

test('Owner 执行途中取消，释放后不累计失败或再次唤醒', () => {
  const f = fixture()
  try {
    f.send('task.owner.event', { taskId: 'task-1', eventKey: 'created', eventType: 'task.created' })
    f.send('task.owner.claim', { taskId: 'task-1', turnId: 'turn', expectedLeaseEpoch: 0 })
    f.db.prepare("UPDATE task_controls SET state='cancelled'").run()
    f.send('task.owner.release', { taskId: 'task-1', turnId: 'turn', leaseEpoch: 1, reason: 'TASK_OWNER_CONTROL_BLOCKED' })
    assert.equal(f.read('task.owner').status, 'idle')
    assert.equal(f.read('task.owner').failureCount, 0)
    assert.equal(f.read('task.owner').lastFailure, null)
    assert.deepEqual(queryTaskOwner(f.db, { kind: 'task.owners.pending' }), [])
  } finally { f.db.close() }
})

test('新接纳验收合同在消息入口与 Owner 一致，16/17/32/100 成功且非法字段拒绝', async () => {
  const { messageSchemas } = await import('../packages/dingtalk-dsh-assistant/message-context.js')
  const intent = acceptanceCriteria => ({ kind: 'intent', actions: [{ intent: 'create', arguments: { objective: '完成目标', acceptanceCriteria }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'result' })
  for (const criteria of [16, 17, 32, 100].map(count => Array.from({ length: count }, (_, i) => `验收 ${i + 1}`))) {
    assert.equal(messageSchemas.I.safeParse(intent(criteria)).success, true)
    const f = fixture()
    try {
      f.db.prepare('DELETE FROM task_acceptance_items').run()
      f.db.prepare('DELETE FROM task_owners').run()
      const result = f.send('task.owner.init', { taskId: 'task-1', sessionId: 'session-1', sourceKey: 'source-1', criteria })
      assert.equal(result.status, 'applied')
      assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM task_acceptance_items').get().count, criteria.length)
      validateTaskOwnerSchema(f.db)
      assert.equal(f.read('task.owner').sessionId, 'session-1')
    } finally { f.db.close() }
  }
  for (const criteria of [[], [' '], ['x'.repeat(2001)], [' '.repeat(2000) + 'x'], [42], '条件', null]) {
    assert.equal(messageSchemas.I.safeParse(intent(criteria)).success, false, JSON.stringify(criteria))
    const f = fixture()
    try {
      assert.throws(() => f.send('task.owner.init', { taskId: 'task-1', sessionId: 'session-1', sourceKey: 'source-1', criteria }), { code: 'TASK_OWNER_CRITERIA_INVALID' })
    } finally { f.db.close() }
  }
})

test('历史 Owner 验收记录读取不套用新接纳数量或长度限制', () => {
  const f = fixture()
  try {
    for (let index = 2; index <= 40; index++) f.db.prepare('INSERT INTO task_acceptance_items(task_id,item_id,criterion,source_key) VALUES(?,?,?,?)')
      .run('task-1', `acceptance-${index}`, '历史要求'.repeat(600), 'source-1')
    validateTaskOwnerSchema(f.db)
    assert.equal(f.read('task.owner').sessionId, 'session-1')
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM task_acceptance_items').get().count, 40)
  } finally { f.db.close() }
})

test('Owner累计验收超原32项仍完整保存，重复追加幂等，非法条件零写',()=>{
 const f=fixture();const args=index=>({taskId:'task-1',itemId:`acceptance-${index}`,criterion:`条件${index}`,sourceKey:'source-1',eventKey:`add-${index}`})
 try{
  for(let index=2;index<=100;index++)f.send('task.owner.acceptance.extend',args(index))
  assert.equal(queryTaskOwner(f.db,{kind:'task.owner.acceptance',taskId:'task-1'}).length,100)
  const before=f.read('task.owner')
  assert.equal(f.send('task.owner.acceptance.extend',args(100)).status,'existing')
  assert.deepEqual(f.read('task.owner'),before)
  assert.throws(()=>f.send('task.owner.acceptance.extend',{...args(101),criterion:' '}),{code:'TASK_OWNER_CRITERIA_INVALID'})
  assert.deepEqual(f.read('task.owner'),before)
  assert.equal(queryTaskOwner(f.db,{kind:'task.owner.acceptance',taskId:'task-1'}).length,100)
 }finally{f.db.close()}
})

 test('规划证据只返回本任务已应用的 initialize/append，截断明确标记', () => {
  const f = fixture()
  try {
    const insert = f.db.prepare(`INSERT INTO task_owner_turns(turn_id,task_id,lease_epoch,event_watermark,requirement_revision,plan_revision,control_revision,authorization_revision,input_fence_revision,status,application_status,candidate_json,decision_json,created_at,updated_at) VALUES(?, 'task-1',?,0,1,1,1,1,1,?,?, ?,?,?,?)`)
    const decision = kind => JSON.stringify({ action: 'advance', planChange: { kind, stages: [{ workflowId: 'task-general' }] } })
    insert.run('failed',1,'released',null,decision('initialize'),null,at,at)
    insert.run('pending',2,'accepted','pending',decision('append'),decision('append'),at,at)
    const noPlan = JSON.stringify({action:'advance',evidenceRefs:[]})
    const replace = JSON.stringify({action:'advance',planChange:{kind:'replaceSuffix',stages:[{workflowId:'task-general'}]},appendStages:[{workflowId:'task-general'}]})
    insert.run('no-plan',202,'accepted','applied',noPlan,noPlan,at,at)
    insert.run('replace',203,'accepted','applied',replace,replace,at,at)
    insert.run('first',3,'accepted','applied',decision('initialize'),decision('initialize'),at,at)
    insert.run('second',4,'accepted','applied',decision('append'),decision('append'),at,at)
    const result = f.read('task.owner.planning')
    assert.equal(result.truncated, false)
    assert.deepEqual(result.receipts.map(x => [x.turnId,x.planChangeKind,x.workflowIds]), [['first','initialize',['task-general']],['second','append',['task-general']]])
    assert.deepEqual(queryTaskOwner(f.db,{kind:'task.owner.planning',taskId:'other'}), {receipts:[],truncated:false})
    assert.throws(()=>queryTaskOwner(f.db,{kind:'task.owner.planning',taskId:'task-1',other:true}))
    for(let i=0;i<199;i++) insert.run(`extra-${i}`,i+5,'accepted','applied',decision('append'),decision('append'),at,at)
    assert.equal(f.read('task.owner.planning').truncated,true)
    assert.equal(f.read('task.owner.planning').receipts.length,200)
  } finally { f.db.close() }
})

test('Owner受管恢复严格校验版本和已释放失败，不改Task及会话', () => {
  const f = fixture()
  try {
    f.send('task.owner.event', { taskId: 'task-1', eventKey: 'create-retry', eventType: 'task.created' })
    for (let lease = 1; lease <= 3; lease++) {
      f.send('task.owner.claim', { taskId: 'task-1', turnId: `failed-${lease}`, expectedLeaseEpoch: lease - 1 })
      f.send('task.owner.sessionBound', { taskId: 'task-1', turnId: `failed-${lease}`, leaseEpoch: lease, sessionId: 'session-1' })
      f.send('task.owner.release', { taskId: 'task-1', turnId: `failed-${lease}`, leaseEpoch: lease, reason: 'TASK_OWNER_NO_DECISION' })
    }
    const before = f.read('task.owner'), task = f.db.prepare('SELECT * FROM business_tasks').get()
    const args = { taskId: 'task-1', eventKey: 'repair-v1', payloadRef: 'sha256-' + 'a'.repeat(64) + '.json',
      expectedOwnerRevision: before.revision, expectedLeaseEpoch: before.leaseEpoch,
      expectedRequirementRevision: before.requirementRevision, expectedControlRevision: before.controlRevision, expectedLastFailure: before.lastFailure }
    assert.throws(() => f.send('task.owner.retry', { ...args, expectedOwnerRevision: before.revision - 1 }), { code: 'TASK_OWNER_RETRY_STALE' })
    assert.throws(() => f.send('task.owner.retry', { ...args, expectedLastFailure: 'TASK_OWNER_TIMEOUT' }), { code: 'TASK_OWNER_RETRY_STALE' })
    f.db.prepare("UPDATE task_controls SET state='paused'").run()
    assert.throws(() => f.send('task.owner.retry', args), { code: 'TASK_OWNER_RETRY_FORBIDDEN' })
    f.db.prepare("UPDATE task_controls SET state='active'").run()
    assert.equal(f.send('task.owner.retry', args).status, 'pending')
    const after = f.read('task.owner')
    assert.equal(after.sessionId, before.sessionId); assert.equal(after.ownerEpoch, before.ownerEpoch)
    assert.equal(after.failureCount, 0); assert.equal(after.lastFailure, null)
    assert.deepEqual(f.db.prepare('SELECT * FROM business_tasks').get(), task)
    assert.equal(f.db.prepare("SELECT event_type FROM task_events WHERE event_key='repair-v1'").get().event_type, 'system.recovery')
    assert.throws(() => f.send('task.owner.retry', { ...args, expectedOwnerRevision: after.revision, expectedLastFailure: null }), { code: 'TASK_OWNER_RETRY_FORBIDDEN' })
  } finally { f.db.close() }
})

test('Owner受管恢复拒绝未知错误和未应用候选', () => {
 for (const scenario of ['unknown', 'candidate', 'applying', 'running']) {
  const f = fixture()
  try {
   f.db.prepare("UPDATE task_owners SET status='blocked',failure_count=3,last_failure='TASK_OWNER_NO_DECISION'").run()
   if (scenario === 'unknown') f.db.prepare("UPDATE task_owners SET last_failure='UNKNOWN_STORAGE_RESULT'").run()
   if (scenario === 'running') f.db.prepare("UPDATE task_owners SET current_turn_id='live'").run()
   if (['candidate','applying'].includes(scenario)) f.db.prepare(`INSERT INTO task_owner_turns(turn_id,task_id,lease_epoch,event_watermark,requirement_revision,plan_revision,control_revision,authorization_revision,input_fence_revision,status,application_status,created_at,updated_at)
    VALUES('pending','task-1',1,0,1,1,1,1,0,?,?,?,?)`).run(scenario === 'candidate' ? 'candidate' : 'accepted', scenario === 'applying' ? 'pending' : null, at, at)
   const owner = f.read('task.owner')
   assert.throws(() => f.send('task.owner.retry', { taskId: 'task-1', eventKey: 'recovery', payloadRef: 'sha256-'+'a'.repeat(64)+'.json',
    expectedOwnerRevision: owner.revision, expectedLeaseEpoch: owner.leaseEpoch, expectedRequirementRevision: owner.requirementRevision,
    expectedControlRevision: owner.controlRevision, expectedLastFailure: owner.lastFailure }), { code: 'TASK_OWNER_RETRY_FORBIDDEN' })
   assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_events').get().n, 0)
  } finally { f.db.close() }
 }
})

for(const mode of ['known','unknown','pending','effect','running'])test(`原生discard仅封存明确未执行的blocked修复动作：${mode}`,()=>{
 const f=fixture()
 try{
  f.db.exec("CREATE TABLE execution_runs(run_id TEXT,task_id TEXT,workflow_id TEXT,status TEXT); CREATE TABLE execution_nodes(run_id TEXT,drained INTEGER,status TEXT); CREATE TABLE execution_effects(run_id TEXT); CREATE TABLE execution_inputs(run_id TEXT,status TEXT)")
  f.db.prepare("UPDATE task_plan_stages SET workflow_id='task-investigation' WHERE task_id='task-1'").run()
  f.db.prepare("INSERT INTO execution_runs VALUES('r','task-1','task-investigation',?)").run(mode==='running'?'running':'failed')
  f.db.prepare("INSERT INTO execution_nodes VALUES('r',?,?)").run(mode==='running'?0:1,mode==='running'?'running':'failed')
  if(mode==='effect')f.db.prepare("INSERT INTO execution_effects VALUES('r')").run()
  f.send('task.owner.event',{taskId:'task-1',eventKey:'created',eventType:'task.created'})
  f.send('task.owner.claim',{taskId:'task-1',turnId:'turn-1',expectedLeaseEpoch:0})
  f.send('task.owner.sessionBound',{taskId:'task-1',turnId:'turn-1',leaseEpoch:1,sessionId:'session-1'})
  const decision={action:'repairCurrentStage',summary:'非法阶段修复',evidenceRefs:[],repair:{stageId:'stage-1',runId:'r',generation:1,runRevision:0,requirementRevision:1}}
  f.send('task.owner.candidate',{taskId:'task-1',turnId:'turn-1',leaseEpoch:1,decision})
  f.send('task.owner.accept',{taskId:'task-1',turnId:'turn-1',leaseEpoch:1})
  if(mode!=='pending')for(let n=0;n<1;n++)f.send('task.owner.action.fail',{taskId:'task-1',turnId:'turn-1',leaseEpoch:1,reason:mode==='unknown'?'UNKNOWN_FAILURE':'WORKFLOW_REPAIR_NOT_ADMITTED'})
  const discard=()=>f.send('task.owner.discard',{taskId:'task-1',turnId:'turn-1',leaseEpoch:1,reason:'WORKFLOW_REPAIR_NOT_ADMITTED'})
  if(mode==='known'){
   assert.equal(discard().status,'discarded')
   const turn=f.db.prepare("SELECT * FROM task_owner_turns WHERE turn_id='turn-1'").get()
   assert.equal(turn.application_status,'discarded');assert.equal(turn.application_failures,1);assert.deepEqual(JSON.parse(turn.decision_json),decision)
   assert.equal(f.read('task.owner').sessionId,'session-1')
  }else assert.throws(discard,/TASK_OWNER_ACTION_ALREADY_APPLIED|TASK_OWNER_ACTION_STILL_CURRENT|TASK_OWNER_DISCARD_UNSAFE/)
 }finally{f.db.close()}
})


test('新消息尚未归类时释放Owner不消耗失败预算', () => {
  const f = fixture()
  try {
    f.send('task.owner.event', { taskId: 'task-1', eventKey: 'created', eventType: 'task.created' })
    for (let n = 1; n <= 4; n++) {
      f.send('task.owner.claim', { taskId: 'task-1', turnId: `waiting-${n}`, expectedLeaseEpoch: n - 1 })
      const result = f.send('task.owner.release', { taskId: 'task-1', turnId: `waiting-${n}`, leaseEpoch: n, reason: 'MESSAGE_INPUT_PENDING' })
      assert.equal(result.failureCount, 0)
    }
    assert.equal(f.read('task.owner').status, 'pending')
  } finally { f.db.close() }
})

test('无计划的非法replaceSuffix在候选写入前拒绝，同turn可initialize且不消耗失败预算',()=>{
 const f=fixture();try{
  f.db.exec("DELETE FROM task_plan_stages; UPDATE business_tasks SET plan_revision=0,plan_requirement_revision=0,status='pending'")
  f.send('task.owner.event',{taskId:'task-1',eventKey:'new',eventType:'task.created'})
  const claim=f.send('task.owner.claim',{taskId:'task-1',turnId:'initial',expectedLeaseEpoch:0})
  const binding={taskId:'task-1',turnId:'initial',leaseEpoch:claim.leaseEpoch}
  f.send('task.owner.sessionBound',{...binding,sessionId:claim.sessionId})
  const decision={action:'advance',summary:'先调查',evidenceRefs:[],planChange:{kind:'replaceSuffix',affectedFrom:0,stages:[{workflowId:'task-investigation',gate:'none'}]}}
  assert.throws(()=>f.send('task.owner.candidate',{...binding,decision:structuredClone(decision)}),{code:'TASK_OWNER_ADVANCE_CONFLICT'})
  const row=f.db.prepare('SELECT status,candidate_json FROM task_owner_turns WHERE turn_id=?').get('initial')
  assert.equal(row.status,'running');assert.equal(row.candidate_json,null)
  decision.planChange={kind:'initialize',stages:[{workflowId:'task-investigation',gate:'none'}]}
  f.send('task.owner.candidate',{...binding,decision});f.send('task.owner.accept',binding)
  assert.equal(f.read('task.owner').failureCount,0)
 }finally{f.db.close()}
})


for(const mode of ['unaccepted','accepted','application'])test(`计划冲突受管恢复仅接受未接纳原轮：${mode}`,()=>{
 const f=fixture();try{
  f.send('task.owner.event',{taskId:'task-1',eventKey:'start',eventType:'task.created'})
  for(let lease=1;lease<=3;lease++){
   f.send('task.owner.claim',{taskId:'task-1',turnId:`conflict-${lease}`,expectedLeaseEpoch:lease-1})
   f.send('task.owner.release',{taskId:'task-1',turnId:`conflict-${lease}`,leaseEpoch:lease,reason:'TASK_OWNER_ADVANCE_CONFLICT'})
  }
  if(mode==='accepted')f.db.exec("UPDATE task_owner_turns SET decision_json='{}' WHERE lease_epoch=3")
  if(mode==='application')f.db.exec("UPDATE task_owner_turns SET application_status='applied' WHERE lease_epoch=3")
  const before=f.read('task.owner'),turns=f.db.prepare('SELECT * FROM task_owner_turns').all()
  const args={taskId:'task-1',eventKey:'retry',payloadRef:'sha256-'+'a'.repeat(64)+'.json',expectedOwnerRevision:before.revision,expectedLeaseEpoch:before.leaseEpoch,expectedRequirementRevision:before.requirementRevision,expectedControlRevision:before.controlRevision,expectedLastFailure:before.lastFailure}
  if(mode==='unaccepted'){assert.equal(f.send('task.owner.retry',args).status,'pending');assert.equal(f.read('task.owner').sessionId,before.sessionId)}
  else assert.throws(()=>f.send('task.owner.retry',args),{code:'TASK_OWNER_RETRY_FORBIDDEN'})
  assert.deepEqual(f.db.prepare('SELECT * FROM task_owner_turns').all(),turns)
 }finally{f.db.close()}
})

test('暂态动作超过原三次后仍可恢复且退避时间持久化', () => {
 const f=fixture(); try {
  f.send('task.owner.event',{taskId:'task-1',eventKey:'start-transient',eventType:'task.created'})
  f.send('task.owner.claim',{taskId:'task-1',turnId:'transient',expectedLeaseEpoch:0})
  f.send('task.owner.sessionBound',{taskId:'task-1',turnId:'transient',leaseEpoch:1,sessionId:'session-1'})
  f.send('task.owner.candidate',{taskId:'task-1',turnId:'transient',leaseEpoch:1,decision:{action:'advance',summary:'继续执行',evidenceRefs:[]}})
  f.send('task.owner.accept',{taskId:'task-1',turnId:'transient',leaseEpoch:1})
  for(let count=1;count<=8;count++)assert.equal(f.send('task.owner.action.fail',{taskId:'task-1',turnId:'transient',leaseEpoch:1,reason:'ECONNRESET'}).failureCount,count)
  const pending=queryTaskOwner(f.db,{kind:'task.owner.actions.pending'})
  assert.equal(pending.length,1);assert.ok(Date.parse(pending[0].retryAt)>Date.parse(at));assert.equal(f.read('task.owner').status,'idle')
 } finally {f.db.close()}
})

test('可纠正动作仅封存失败候选，当前Owner收到诊断继续', () => {
 const f=fixture();try {
  f.send('task.owner.event',{taskId:'task-1',eventKey:'start-correction',eventType:'task.created'})
  f.send('task.owner.claim',{taskId:'task-1',turnId:'correctable',expectedLeaseEpoch:0})
  f.send('task.owner.sessionBound',{taskId:'task-1',turnId:'correctable',leaseEpoch:1,sessionId:'session-1'})
  f.send('task.owner.candidate',{taskId:'task-1',turnId:'correctable',leaseEpoch:1,decision:{action:'advance',summary:'继续执行',evidenceRefs:[]}})
  f.send('task.owner.accept',{taskId:'task-1',turnId:'correctable',leaseEpoch:1})
  assert.equal(f.send('task.owner.action.fail',{taskId:'task-1',turnId:'correctable',leaseEpoch:1,reason:'TASK_OWNER_ADVANCE_CONFLICT'}).status,'correct')
  assert.equal(queryTaskOwner(f.db,{kind:'task.owner.actions.pending'}).length,0)
  assert.equal(f.read('task.owner').status,'pending');assert.equal(f.read('task.owner').lastFailure,'TASK_OWNER_ADVANCE_CONFLICT')
  assert.equal(f.read('task.owner').sessionId,'session-1')
 } finally {f.db.close()}
})