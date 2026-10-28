import { DatabaseSync } from 'node:sqlite'

// 只读业务账本；不打开带迁移/恢复副作用的运行时 store。
const db = new DatabaseSync(process.argv[2], { readOnly: true })
try {
  const read = name => db.prepare(`SELECT body FROM dynamic_${name}`).all().map(row => JSON.parse(row.body))
  const id = 'coordination-7b4d4a667b1dc14fbc3f1d4517e80162'
  const coordination = read('coordination').find(item => item.id === id)
  if (!coordination) throw new Error('TARGET_COORDINATION_MISSING')
  const members = read('coordination_members').filter(item => item.coordinationId === id)
  const ids = new Set(members.map(item => item.taskId))
  const tasks = read('tasks').filter(item => ids.has(item.taskId))
  const sources = read('coordination_sources').filter(item => item.coordinationId === id || item.acceptedProposal?.coordinationIds?.includes(id))
  const notices = read('notifications').filter(item => item.payload?.fact?.coordinationId === id)
  const events = read('task_events').filter(item => ids.has(item.taskId))
  console.log(JSON.stringify({ observedAt: new Date().toISOString(), coordination: {
    id, state: coordination.state, createdAt: coordination.createdAt, proposal: coordination.proposal,
    summaryRevision: coordination.summaryRevision, lifecycleState: coordination.lifecycleState,
  }, sources: sources.map(item => ({ id: item.id, original: item.original, createdAt: item.createdAt,
    kind: item.acceptedProposal?.kind, coordinationId: item.coordinationId })),
  members: members.map(item => ({ id: item.id, taskId: item.taskId, observation: item.observation,
    commandKind: item.command.kind, dependencies: item.dependencies, state: item.state,
    effectiveVersion: item.effectiveVersion, hasTaskMutationReceipt: Boolean(item.receipt) })),
  tasks: tasks.map(item => ({ taskId: item.taskId, title: item.title, status: item.status, control: item.control,
    requirementRevision: item.requirementRevision, contextRevision: item.contextRevision, controlRevision: item.controlRevision,
    runSequence: item.runSequence, completion: item.completion ? { at: item.completion.at, summary: item.completion.summary } : null })),
  events: events.map(item => ({ id: item.id, taskId: item.taskId, kind: item.kind, recordedAt: item.recordedAt,
    requirementRevision: item.requirementRevision, contextRevision: item.contextRevision, controlRevision: item.controlRevision,
    runSequence: item.runSequence })),
  notifications: notices.map(item => ({ id: item.id, state: item.state, createdAt: item.createdAt,
    text: item.payload.text, summaryRevision: item.payload.fact.summaryRevision,
    deliveredAt: item.receipt?.observedAt, hasDeliveryReceipt: Boolean(item.receipt?.messageId) })),
  }, null, 2))
} finally { db.close() }
