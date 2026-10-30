import { createHash } from 'node:crypto'
import { z } from 'zod'
import { toToolJsonSchema } from './tool-schema.js'
import { topicMessageCount, topicMessages } from './topic-model.js'
import { formatTaskGroupReply } from './group-reply-format.js'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const replyFingerprint = replies => hash(replies.map(({ updatedAt, ...reply }) => reply))
const fail = code => { throw Object.assign(new Error(code), { code }) }
export const factDecisionSchema = z.strictObject({
  requestId: z.string().min(1), topicId: z.string().min(1), revision: z.number().int().positive(),
  decision: z.strictObject({ actions: z.tuple([]),
    topicUpdate: z.strictObject({ summary: z.string().trim().min(1).max(4000), openQuestions: z.array(z.string().max(500)).max(12).optional() }),
    reply: z.string().trim().min(1).max(6000).optional(), reason: z.string().trim().min(1).max(1000),
    replyToMessageId: z.string().min(1).optional().describe('确需引用时，按Topic上下文选择本话题内真人消息；作者必须属于本次收件人集合，因为引用可能自动提及作者。没有合适引用或需避免叠加提及时省略，直接发送普通群消息，不默认引用最后来源。'),
    atOpenDingTalkIds: z.array(z.string().min(1)).min(1).optional().describe('本次结果应通知的受信群成员ID集合，可多人；从话题原文身份选择，不按姓名猜ID，不自动包含全部参与者。回复时显式填写，正文@姓名不能替代原生提及。'),
  }),
}).superRefine(({ decision }, ctx) => {
  if (!decision.reply) return
  if (!decision.atOpenDingTalkIds) {
    ctx.addIssue({ code: 'custom', path: ['decision', 'atOpenDingTalkIds'], message: '非空回复必须明确选择受信收件人；引用可省略，身份不确定时不猜测。' })
  }
})
export const factDecisionJsonSchema = toToolJsonSchema(factDecisionSchema)

// Facts share the task transaction. They are inputs to the existing Topic decision,
// never task wakes, coordination arrangements, or channel notifications themselves.
export function installTopicFacts(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS dynamic_topic_facts(id TEXT PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)));
    CREATE INDEX IF NOT EXISTS topic_fact_pending ON dynamic_topic_facts(
      json_extract(body,'$.groupId'),json_extract(body,'$.topicId'),json_extract(body,'$.state'));`)
}

export function topicFactLedger({ db, get, put }) {
  function bindings(task, input) {
    const values = input ?? task.replyBindings ?? []
    if (!Array.isArray(values)) fail('TOPIC_REPLY_BINDINGS_INVALID')
    const merged = new Map()
    for (const item of values) {
      if (!item.groupId || !item.topicId || !Array.isArray(item.sourceIds) || !item.sourceIds.length) fail('TOPIC_REPLY_BINDINGS_INVALID')
      const sources = item.sourceIds.map(id => get('dynamic_sources', id))
      if (sources.some(source => !source || source.groupId !== item.groupId || !source.actorId || source.channel === 'internal')) fail('TOPIC_REPLY_SOURCE_INVALID')
      const key = JSON.stringify([item.groupId, item.topicId])
      const previous = merged.get(key)
      merged.set(key, { groupId: item.groupId, topicId: item.topicId,
        sourceIds: [...new Set([...(previous?.sourceIds ?? []), ...item.sourceIds])] })
    }
    return [...merged.values()]
  }
  function record(task, kind, result, commandId, inputBindings) {
    const destinations = bindings(task, inputBindings)
    if (inputBindings !== undefined) task.replyBindings = destinations
    const now = new Date().toISOString()
    const originId = task.metadata?.authorizationSourceId ?? task.sourceRefs?.[0]
    const origin = originId ? get('dynamic_sources', originId) : null
    const noGroupReply = !destinations.length && ['web', 'internal'].includes(origin?.channel ?? task.metadata?.channel)
    const humanRequestId = kind === 'needs-input' && result.audience === 'requester'
      ? task.humanRequests?.findLast(request => request.status === 'waiting-reply' && request.audience === 'requester')?.requestId : null
    return (destinations.length ? destinations : [{ groupId: task.groupId, topicId: null, sourceIds: [] }]).map(destination => {
      const id = `topic-fact:${hash([commandId, destination.groupId, destination.topicId])}`
      const fact = { id, ...destination, taskId: task.taskId, taskTitle: task.title, kind,
        audienceKey: hash([...new Set(destination.sourceIds.map(id => get('dynamic_sources', id).actorId))].sort()),
        requirementRevision: task.requirementRevision, runSequence: task.runSequence, commandId,
        ...(humanRequestId ? { humanRequestId } : {}),
        result, state: destination.topicId ? 'pending' : noGroupReply ? 'recorded' : 'unbound',
        ...(noGroupReply ? { reason: 'no-group-reply-source' } : {}), recordedAt: now }
      put('dynamic_topic_facts', fact)
      return fact
    })
  }
  function query(q) {
    if (q.kind === 'topic.fact.pending') return db.prepare(`SELECT id,
      json_extract(body,'$.groupId') groupId, json_extract(body,'$.topicId') topicId,
      json_extract(body,'$.taskId') taskId, substr(json_extract(body,'$.taskTitle'),1,200) taskTitle,
      json_extract(body,'$.humanRequestId') humanRequestId,
      json_extract(body,'$.lastSupersededNotificationId') lastSupersededNotificationId,
      json_extract(body,'$.kind') kind, json_extract(body,'$.recordedAt') recordedAt,
      json_extract(body,'$.requirementRevision') requirementRevision, json_extract(body,'$.runSequence') runSequence,
      (SELECT json_group_array(value) FROM (SELECT value FROM json_each(dynamic_topic_facts.body,'$.sourceIds') ORDER BY key DESC LIMIT 8)) sourceIds,
      substr(json_extract(body,'$.result.summary'),1,1200) summary,
      json_extract(body,'$.result.audience') audience,
      (SELECT json_group_array(substr(value,1,200)) FROM (SELECT value FROM json_each(dynamic_topic_facts.body,'$.result.evidence') LIMIT 4)) evidence,
      (SELECT json_group_array(substr(value,1,200)) FROM (SELECT value FROM json_each(dynamic_topic_facts.body,'$.result.limitations') LIMIT 4)) limitations,
      CASE WHEN json_extract(body,'$.result.audience')='operator' THEN NULL ELSE substr(json_extract(body,'$.result.question'),1,800) END question
      FROM dynamic_topic_facts
      WHERE json_extract(body,'$.groupId')=? AND json_extract(body,'$.topicId')=? AND json_extract(body,'$.state')='pending'
        AND coalesce(json_extract(body,'$.audienceKey'),'')=(SELECT coalesce(json_extract(body,'$.audienceKey'),'')
          FROM dynamic_topic_facts WHERE json_extract(body,'$.groupId')=? AND json_extract(body,'$.topicId')=?
          AND json_extract(body,'$.state')='pending' ORDER BY rowid LIMIT 1)
      ORDER BY rowid LIMIT 4`).all(q.groupId, q.topicId, q.groupId, q.topicId).map(({ sourceIds, summary, audience, evidence, limitations, question, ...row }) => ({ ...row,
        sourceIds: JSON.parse(sourceIds).reverse(), result: { summary, audience, evidence: JSON.parse(evidence), limitations: JSON.parse(limitations), question } }))
    if (q.kind === 'topic.fact.groups') return db.prepare(`SELECT DISTINCT json_extract(body,'$.groupId') groupId
      FROM dynamic_topic_facts WHERE json_extract(body,'$.state')='pending'`).all().map(row => row.groupId)
    if (q.kind === 'topic.fact.unsettled') return !!db.prepare(`SELECT 1 FROM dynamic_topic_facts
      WHERE json_extract(body,'$.groupId')=? AND (json_extract(body,'$.state')='pending' OR
        (json_extract(body,'$.state')='accepted' AND json_type(body,'$.decision')='object' AND json_type(body,'$.projectedAt') IS NULL)) LIMIT 1`).get(q.groupId)
    if (q.kind === 'topic.fact.projections') return db.prepare(`SELECT id, rowid sequence, json_extract(body,'$.decision') decision FROM dynamic_topic_facts
      WHERE json_extract(body,'$.state')='accepted' AND json_type(body,'$.decision')='object'
      AND json_type(body,'$.projectedAt') IS NULL AND rowid>? ORDER BY rowid LIMIT 32`).all(q.afterSequence ?? 0)
      .map(row => ({ id: row.id, sequence: row.sequence, decision: JSON.parse(row.decision) }))
    if (q.kind === 'topic.fact.get') return get('dynamic_topic_facts', q.factId)
    if (q.kind === 'topic.fact.tasks') {
      if (!Array.isArray(q.taskIds) || q.taskIds.length > 8) fail('TOPIC_FACT_PAGE_INVALID')
      return db.prepare(`WITH task_rows AS (SELECT id,body,rowid sequence FROM dynamic_tasks
        UNION ALL SELECT id,body,sequence FROM dynamic_archived_tasks)
        SELECT id taskId, substr(json_extract(body,'$.title'),1,200) title,
        json_extract(body,'$.status') status, json_extract(body,'$.control') control,
        json_extract(body,'$.archivedAt') archivedAt,
        json_extract(body,'$.requirementRevision') requirementRevision, json_extract(body,'$.runSequence') runSequence,
        json_extract(body,'$.controlRevision') controlRevision, json_extract(body,'$.contextRevision') contextRevision,
        (SELECT json_group_array(json_object('requestId',json_extract(value,'$.requestId'),'question',substr(json_extract(value,'$.question'),1,800)))
          FROM (SELECT value FROM json_each(task_rows.body,'$.humanRequests') WHERE json_extract(value,'$.status')='waiting-reply'
            AND json_extract(value,'$.audience')='requester' LIMIT 4)) pendingRequests,
        substr(coalesce(json_extract(body,'$.completion.summary'),json_extract(body,'$.lastDecision.summary')),1,800) summary
        FROM task_rows WHERE id IN (SELECT value FROM json_each(?)) OR
          (json_extract(body,'$.groupId')=? AND (EXISTS(SELECT 1 FROM json_each(body,'$.replyBindings')
            WHERE json_extract(value,'$.topicId')=?) OR EXISTS(SELECT 1 FROM json_each(body,'$.topicRefs')
            WHERE json_extract(value,'$.topicId')=?)))
        ORDER BY (id IN (SELECT value FROM json_each(?))) DESC, sequence DESC LIMIT 8`)
        .all(JSON.stringify(q.taskIds), q.groupId ?? null, q.topicId ?? null, q.topicId ?? null, JSON.stringify(q.taskIds))
        .map(({ pendingRequests, ...task }) => ({ ...task, pendingRequests: JSON.parse(pendingRequests) }))
    }
    if (q.kind === 'topic.fact.sources') {
      if (!Array.isArray(q.sourceIds) || q.sourceIds.length > 32) fail('TOPIC_FACT_PAGE_INVALID')
      return db.prepare(`SELECT id sourceId, json_extract(body,'$.messageId') messageId,
        json_extract(body,'$.groupId') groupId, json_extract(body,'$.actorId') actorId,
        json_extract(body,'$.senderName') senderName, json_extract(body,'$.version') version,
        substr(json_extract(body,'$.text'),1,800) text, length(json_extract(body,'$.text')) textLength
        FROM dynamic_sources WHERE id IN (SELECT value FROM json_each(?)) LIMIT 32`).all(JSON.stringify(q.sourceIds))
    }
    if (q.kind === 'topic.fact.reply-source') return db.prepare(`SELECT id sourceId FROM dynamic_sources
      WHERE json_extract(body,'$.groupId')=? AND json_extract(body,'$.messageId')=?
        AND json_extract(body,'$.actorId')=? AND json_extract(body,'$.version')=?
        AND json_extract(body,'$.channel') NOT IN ('internal','web') LIMIT 1`)
      .get(q.groupId, q.messageId, q.actorId, q.version)
    if (q.kind === 'topic.fact.replies') return db.prepare(`WITH reply_rows AS (SELECT id,body,rowid sequence FROM dynamic_notifications
      UNION ALL SELECT id,body,sequence FROM dynamic_archived_notifications)
      SELECT id outboundId,
      json_extract(body,'$.state') state, json_extract(body,'$.payload.sourceMessageId') sourceMessageId,
      substr(json_extract(body,'$.payload.text'),1,800) text,
      json_extract(body,'$.receipt.messageId') deliveredMessageId, json_extract(body,'$.updatedAt') updatedAt
      FROM reply_rows WHERE json_extract(body,'$.payload.conversationId')=? AND
        (json_extract(body,'$.payload.replyTopicId')=? OR EXISTS(
          SELECT 1 FROM json_each(json_extract(body,'$.payload.topicRefs')) WHERE json_extract(value,'$.topicId')=?))
      ORDER BY json_extract(body,'$.createdAt') DESC, sequence DESC LIMIT 8`).all(q.groupId, q.topicId, q.topicId)
    return undefined
  }
  function reduce(kind, a) {
    if (kind === 'topic.fact.accept') {
      if (!Array.isArray(a.factIds) || !a.factIds.length || a.factIds.length > 8 || new Set(a.factIds).size !== a.factIds.length) fail('TOPIC_FACT_PAGE_INVALID')
      const facts = a.factIds.map(id => get('dynamic_topic_facts', id))
      if (facts.some(f => !f || f.state !== 'pending' || f.groupId !== a.groupId || f.topicId !== a.topicId)) fail('TOPIC_FACT_STALE')
      // Recheck ledger snapshots inside the same SQLite transaction as the intent.
      if (a.taskSnapshot !== hash(query({ kind: 'topic.fact.tasks', taskIds: a.taskIds, groupId: a.groupId, topicId: a.topicId }))
        || a.replySnapshot !== replyFingerprint(query({ kind: 'topic.fact.replies', groupId: a.groupId, topicId: a.topicId }))) return { status: 'topic-stale' }
      const decision = factDecisionSchema.parse(a.submission).decision
      const stamp = new Date().toISOString()
      let notification = null
      if (decision.reply) {
        const source = decision.replyToMessageId ? get('dynamic_sources', a.sourceId) : null
        // Topic membership is checked against the frozen resident revision by the Host.
        // A recipient can be the original requester or reviewer, outside this fact's trigger sources.
        if (JSON.stringify(a.reply.atOpenDingTalkIds) !== JSON.stringify(decision.atOpenDingTalkIds)
          || (decision.replyToMessageId ? !source || source.groupId !== a.groupId || source.messageId !== decision.replyToMessageId
            || a.reply.replyToMessageId !== source.messageId || a.reply.replyToSenderOpenDingTalkId !== source.actorId
            || !decision.atOpenDingTalkIds.includes(source.actorId)
            : a.sourceId || a.reply.replyToMessageId || a.reply.replyToSenderOpenDingTalkId)) fail('TOPIC_REPLY_SOURCE_INVALID')
        notification = { id: `fact-reply:${hash([a.submission.requestId, a.factIds])}`, kind: 'topic-reply', taskId: facts[0].taskId,
          requirementRevision: facts[0].requirementRevision, state: 'prepared', createdAt: stamp, updatedAt: stamp,
          payload: { ...a.reply, text: a.reply.text, conversationId: a.groupId, replyTopicId: a.topicId,
            topicRefs: [{ topicId: a.topicId, revision: a.submission.revision }], taskIds: [...new Set(facts.map(f => f.taskId))],
            ...(source ? { sourceMessageId: source.messageId, sourceId: source.sourceId, sourceVersion: source.version, actorId: source.actorId } : {}),
            coveredEventIds: a.factIds, replyKind: 'substantive', kind: 'topic-reply',
            humanRequests: facts.filter(fact => fact.humanRequestId && currentRequest(fact)).map(fact => ({ taskId: fact.taskId, requestId: fact.humanRequestId })),
            fact: { taskIds: [...new Set(facts.map(f => f.taskId))], eventIds: a.factIds } } }
        notification.notificationId = notification.id
        put('dynamic_notifications', notification)
      }
      for (const [index, fact] of facts.entries()) put('dynamic_topic_facts', { ...fact, state: 'accepted', processedAt: stamp,
        decisionId: a.submission.requestId, notificationId: notification?.id ?? null,
        ...(index === 0 ? { decision: { ...a.submission, groupId: a.groupId, expectedSummary: a.expectedSummary, recordedAt: stamp,
          factIds: a.factIds, notificationId: notification?.id ?? null } } : {}) })
      return { facts: a.factIds, notification, decision }
    }
    if (kind === 'topic.fact.projected') {
      const fact = get('dynamic_topic_facts', a.factId)
      // A delayed projection from a retired intent must not mark a newer decision.
      if (!fact?.decision || fact.state !== 'accepted' || fact.decisionId !== a.decisionId) return { status: 'superseded' }
      put('dynamic_topic_facts', { ...fact, projectedAt: fact.projectedAt ?? new Date().toISOString() })
      return { factId: fact.id }
    }
    return undefined
  }
  function currentRequest(fact) {
    const task = get('dynamic_tasks', fact.taskId)
    return task?.status === 'active' && task.control === 'active' && task.humanRequests?.find(request =>
      request.requestId === fact.humanRequestId && request.status === 'waiting-reply'
      && request.requirementRevision === task.requirementRevision && request.controlRevision === task.controlRevision)
  }
  function requeueUnsent(notification) {
    const pending = []
    for (const id of notification.payload.coveredEventIds ?? []) {
      const fact = get('dynamic_topic_facts', id)
      if (fact?.state !== 'accepted' || fact.notificationId !== notification.id || fact.humanRequestId && !currentRequest(fact)) continue
      const { decision, decisionId, notificationId, projectedAt, processedAt, ...rest } = fact
      const next = { ...rest, state: 'pending', lastSupersededNotificationId: notification.id }
      put('dynamic_topic_facts', next); pending.push(next)
    }
    return pending
  }
  return { bindings, record, query, reduce, requeueUnsent }
}

export function factContextProjection(facts, tasks = []) {
  return facts.map(fact => ({ eventId: fact.id, taskId: fact.taskId, taskTitle: fact.taskTitle.slice(0, 200), kind: fact.kind,
    requirementRevision: fact.requirementRevision, runSequence: fact.runSequence, recordedAt: fact.recordedAt,
    summary: String(fact.result.summary ?? '').slice(0, 2400),
    evidence: (fact.result.evidence ?? []).slice(0, 6).map(value => String(value).slice(0, 400)),
    limitations: (fact.result.limitations ?? []).slice(0, 6).map(value => String(value).slice(0, 400)),
    audience: fact.result.audience,
    ...(fact.humanRequestId && !tasks.some(task => task.taskId === fact.taskId && task.pendingRequests?.some(request => request.requestId === fact.humanRequestId))
      ? { questionState: 'resolved', question: undefined } : { question: fact.result.audience === 'operator' ? undefined : fact.result.question }),
    detailAvailable: true }))
}

// The adapter uses the existing Topic session and resident group lock. The task
// ledger owns the accepted decision/outbox; summary projection is replayable.
export function createTopicFactHandler({ residentStore, query, commit, signature, onNotification, observe }) {
  async function project(fact) {
    await residentStore.applyTopicFactSummary(fact.decision)
    if (fact.decision.notificationId) await onNotification(await query('notification.get', { notificationId: fact.decision.notificationId }))
    await commit('topic.fact.projected', { factId: fact.id, decisionId: fact.decision.requestId }, `fact-projected:${fact.id}:${fact.decision.requestId}`)
  }
  return {
    observe,
    tasks: (groupId, topicId) => query('topic.fact.tasks', { taskIds: [], groupId, topicId }),
    async context(groupId, topic) {
      const started = performance.now()
      const facts = await query('topic.fact.pending', { groupId, topicId: topic.topicId })
      if (!facts.length) return null
      const sourceIds = [...new Set(facts.flatMap(fact => fact.sourceIds))].slice(-32)
      const taskIds = [...new Set(facts.map(fact => fact.taskId))]
      const [sources, tasks, replies] = await Promise.all([
        query('topic.fact.sources', { sourceIds }), query('topic.fact.tasks', { taskIds, groupId, topicId: topic.topicId }),
        query('topic.fact.replies', { groupId, topicId: topic.topicId }),
      ])
      const group = residentStore.getGroup(groupId)
      const total = topicMessageCount(group, topic, topic.revision)
      const projectMessage = ({ messageId, senderName, senderOpenDingTalkId, sourceKind, text, messageVersion }) => ({
        messageId, senderName, senderOpenDingTalkId, sourceKind, text: text.slice(0, 800), messageVersion,
        ...(text.length > 800 ? { textTruncated: true } : {}) })
      const originMessages = topicMessages(group, topic, topic.revision, { limit: 3 }).map(projectMessage)
      const recent = topicMessages(group, topic, topic.revision, { offset: Math.max(0, total - 8), limit: 8 })
        .map(projectMessage)
      const sourceId = facts.at(-1).sourceIds.at(-1)
      const queryResultBytes = Buffer.byteLength(JSON.stringify([facts, sources, tasks, replies]), 'utf8')
      const taskSnapshot = hash(tasks)
      const replySnapshot = replyFingerprint(replies)
      const sourceIdentities = sources.flatMap(source => [source.sourceId, source.messageId, source.actorId])
      const input = { title: topic.title, summary: topic.summary.slice(0, 4000), openQuestions: topic.openQuestions.slice(0, 12),
        facts: factContextProjection(facts, tasks), sources, originMessages, recentMessages: recent, tasks, replies,
        totalMessages: total, readCall: { name: 'group_topic_context_get', arguments: { topicId: topic.topicId, revision: topic.revision } },
        contextIsBounded: true, detailRead: { name: 'group_decision_context_get', section: 'facts' } }
      // All database queries already select bounded rows/fields. Reduce only this
      // small presentation when UTF-8 expands; exact evidence remains an on-demand read.
      while (Buffer.byteLength(JSON.stringify(input), 'utf8') > 22 * 1024 && input.recentMessages.length) input.recentMessages.shift()
      while (Buffer.byteLength(JSON.stringify(input), 'utf8') > 22 * 1024 && input.sources.length > 1) {
        const index = input.sources.findIndex(source => source.sourceId !== sourceId)
        input.sources.splice(index, 1)
      }
      if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 22 * 1024) {
        input.summary = input.summary.slice(0, 1200)
        input.openQuestions = input.openQuestions.map(question => question.slice(0, 200))
        for (const item of [...input.facts, ...input.sources, ...input.originMessages, ...input.tasks, ...input.replies]) {
          for (const key of ['text', 'summary', 'question']) if (typeof item[key] === 'string') item[key] = item[key].slice(0, 240)
          for (const key of ['evidence', 'limitations']) if (Array.isArray(item[key])) item[key] = item[key].map(text => text.slice(0, 100))
        }
      }
      if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 22 * 1024) fail('TOPIC_FACT_CONTEXT_BUDGET')
      return { eventIds: facts.map(fact => fact.id), generation: hash(facts.map(fact => [fact.id, fact.lastSupersededNotificationId])), expectedSummary: topic.summary,
        replySnapshot, taskSnapshot, taskIds, sourceIdentities, input,
        metrics: { trigger: 'task-facts', queryCount: 4, factCount: facts.length, sourceCount: sources.length,
          recentCount: recent.length, taskCount: tasks.length, replyCount: replies.length,
          queryResultBytes, contextBytes: Buffer.byteLength(JSON.stringify(input), 'utf8'), queryAndContextMs: performance.now() - started } }
    },
    read: eventIds => Promise.all(eventIds.map(factId => query('topic.fact.get', { factId }))),
    async submit(request, submission) {
      const context = request.factContext
      submission = factDecisionSchema.parse(submission)
      let reply, sourceId
      if (submission.decision.reply) {
        const group = residentStore.getGroup(request.groupId), topic = residentStore.getTopic(request.groupId, request.topicId)
        if (!topic || topic.revision !== request.revision) return { status: 'topic-stale' }
        const participants = topicMessages(group, topic, request.revision)
          .filter(message => message.senderOpenDingTalkId && !['web', 'internal'].includes(message.sourceKind))
        const target = participants.find(message => message.messageId === submission.decision.replyToMessageId)
        if (submission.decision.replyToMessageId && !target) fail('group_reply_target_not_in_topic')
        const recipients = [...new Set(submission.decision.atOpenDingTalkIds)]
        if (recipients.some(id => !participants.some(message => message.senderOpenDingTalkId === id))) fail('group_reply_recipient_not_in_topic')
        if (target) {
          if (!recipients.includes(target.senderOpenDingTalkId)) fail('group_reply_quote_author_not_in_recipients')
          const source = await query('topic.fact.reply-source', { groupId: request.groupId, messageId: target.messageId,
            actorId: target.senderOpenDingTalkId, version: target.messageVersion })
          if (!source) fail('TOPIC_REPLY_SOURCE_INVALID')
          sourceId = source.sourceId
        }
        submission = { ...submission, decision: { ...submission.decision, atOpenDingTalkIds: recipients } }
        reply = formatTaskGroupReply({ source: { ...target, groupId: request.groupId }, allowUnrouted: !target,
          summary: submission.decision.reply, evidence: [], limitations: [], signature: signature(),
          internalIds: [request.groupId, request.topicId, request.requestId, sourceId, target?.messageId, ...recipients,
            ...context.eventIds, ...context.input.tasks.map(task => task.taskId), ...context.sourceIdentities],
        })
        reply.atOpenDingTalkIds = recipients
      }
      const result = await residentStore.commitTopicFactDecision({ groupId: request.groupId, topicId: request.topicId,
        revision: request.revision, expectedSummary: context.expectedSummary, commit: async () => {
          const receipt = await commit('topic.fact.accept', { groupId: request.groupId, topicId: request.topicId,
            taskIds: context.taskIds, taskSnapshot: context.taskSnapshot, replySnapshot: context.replySnapshot,
            factIds: context.eventIds, expectedSummary: context.expectedSummary, submission, ...(reply ? { reply, ...(sourceId ? { sourceId } : {}) } : {}) }, `fact-decision:${request.requestId}`)
          return { status: receipt.result.status ?? 'accepted', receipt }
        } })
      if (result.status === 'accepted') {
        try {
          await project({ id: context.eventIds[0], decision: { ...submission, groupId: request.groupId,
            expectedSummary: context.expectedSummary, notificationId: result.receipt.result.notification?.id } })
        } catch (error) { error.factDecisionCommitted = true; throw error }
      }
      return { status: result.status, eventIds: context.eventIds }
    },
    async recover() {
      let afterSequence = 0
      const failures = []
      for (;;) {
        const facts = await query('topic.fact.projections', { afterSequence })
        for (const fact of facts) {
          try { await project(fact) }
          catch (error) { failures.push({ id: fact.id, groupId: fact.decision.groupId, code: error.code ?? error.message }) }
          afterSequence = fact.sequence
        }
        if (facts.length < 32) return failures
      }
    },
  }
}
