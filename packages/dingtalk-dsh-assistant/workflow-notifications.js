import { randomUUID } from 'node:crypto'
import { executionDigest } from './execution-artifacts.js'

export const groupReplyInstructions = '发给群成员的回复、summary 和 question 使用直白的业务语言：说明做了什么、结果、实际限制、下一步和需要确认的问题。不要披露插件内部任务或会话编号、任务会话/执行会话、调度、Outbox、Task Owner、Host 等内部机制或原始错误码。内部结构字段和证据引用仍按接口填写，不放进公开正文。业务所需技术细节、文件名、SQL、PR链接和业务编号可以保留；审批等待用一句简短进展说明，例如“Bytebase 工单已新建，等待人工审批。”；详细责任人与恢复条件填结构化 condition，不逐项拼进群正文。用户明确询问插件实现时可以解释相关技术，但不附带本次运行的内部编号。'

// 只识别明确的插件运行标签与机制，避免把业务代码、普通编号当成内部数据。
export function assertGroupReply(text, internalIds = []) {
  if (typeof text !== 'string') return
  if (internalIds.some(id => typeof id === 'string' && id.length >= 8 && text.includes(id))
    || /(?:task|owner|run|session)-[a-f0-9]{32,}\b|(?:任务|会话|执行|流程)(?:编号|[ _-]?id)\s*[:：=]\s*\S+|(?:taskId|sessionId|runId|leaseEpoch|inputDigest)\s*[:：=]\s*\S+|任务会话|执行会话|叶子会话|平台机制|(?:Task Owner|Outbox|IntentRun)\s*(?:已|将|正在|等待|调度|提交|写入)/iu.test(text)) {
    const error = new Error('GROUP_REPLY_INTERNAL_DETAILS: 请将公开正文改成群成员能理解的业务进展，不包含插件内部编号或机制。')
    error.code = 'GROUP_REPLY_INTERNAL_DETAILS'
    throw error
  }
}

export function groupStatusText(status) {
  return ({ 'deployed-and-handed-to-testing':'已部署并交付测试', verified:'已核验', awaiting_confirmation:'等待确认', accepted:'已收到', pending:'等待处理', planned:'等待处理', ready:'等待处理', running:'正在处理', active:'正在处理', waiting:'等待补充信息或确认', paused:'已暂停', succeeded:'已完成', completed:'已完成', failed:'未完成，需要排查原因', blocked:'暂时无法继续', cancelled:'已取消', cancelling:'正在取消', pausing:'正在暂停', unknown:'暂未确认' })[status] ?? '暂未确认'
}
export function groupActionText(intent) {
  return ({cancel:'取消',pause:'暂停',resume:'继续处理',revise:'更新要求'})[intent] ?? '处理'
}

export function workflowResultText(output) {
  if (typeof output?.summary === 'string') return output.summary
  if (output?.deliveryStatus === 'pr_verified' && typeof output.url === 'string') return `代码已验证并提交 PR${output.number ? ` #${output.number}` : ''}：${output.url}。当前状态：${({ OPEN: '待合并', MERGED: '已合并', CLOSED: '已关闭' })[output.state] ?? '已核验'}。`
  return null
}
export function taskDecisionConditionText(condition) {
  if (!condition || !['business-input', 'approval', 'capability', 'permission', 'execution'].includes(condition.kind)
    || ['missing', 'responsibleParty', 'resumeWhen'].some(key => typeof condition[key] !== 'string' || !condition[key].trim())) return null
  const clean = value => value.replace(/\s+/gu, ' ').trim()
  return `缺少：${clean(condition.missing)}；需由${clean(condition.responsibleParty)}处理；继续条件：${clean(condition.resumeWhen)}。`
}
export function sameDeliveredText(observed, expected, quoted = false) {
  const normalize = text => typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : null
  const actual = normalize(observed), wanted = normalize(expected)
  if (actual === null || wanted === null) return false
  // 钉钉回读把单行 inline-code 表示成粗体；只变换期望的成对单反引号，保留正文。
  const rendered = normalize(typeof expected === 'string' ? expected.replace(/(^|[^`])`([^`\r\n]+)`(?!`)/gu, '$1**$2**') : expected)
  const prefix = typeof quoted === 'object' && quoted?.sender ? normalize(`@${quoted.sender} `) + ' ' : null
  const body = prefix && actual.startsWith(prefix) ? actual.slice(prefix.length) : actual
  return [wanted, rendered].some(candidate => body === candidate)
}
export function notificationOpenTaskId(ack) {
  return ack?.sendReceipt?.openTaskId ?? ack?.result?.openTaskId ?? ack?.result?.result?.openTaskId
}

// 只把明确指向助手沟通的原文作为静默依据；“不发审核消息”等业务限制不扩张。
export function notificationSilence(run, phase) {
  const text = run.body ?? run.snapshot?.source?.text ?? ''
  const all = text.match(/(?:不要|不用|无需)(?:再)?(?:给我|向我)?回复(?:我)?(?:消息)?[。！!，,；;\s]|(?:不要|不用|无需)回复$/u)
  const lifecycle = text.match(/(?:不要|不用|无需)(?:再)?(?:给我|向我)(?:发送|发|汇报|报告|同步)(?:任务)?(进度|处理结果|结果|状态)(?:消息|通知)?/u)
  const scope = lifecycle?.[1] === '进度' || lifecycle?.[1] === '状态' ? 'assistant_progress' : 'assistant_result'
  const applies = scope === 'assistant_progress' ? phase === 'progress' : phase === 'result' || phase.startsWith('terminal:')
  const quote = all?.[0] ?? (applies ? lifecycle?.[0] : null)
  return quote ? { sourceKey: run.sourceKey, sourceVersion: run.sourceVersion, sourceQuote: quote, scope: all ? 'assistant_all' : scope } : null
}

const manualInterventionText = '处理遇到系统问题，无法继续推进，需要人工介入。'
function systemWaitText() { return manualInterventionText }
function canStillProgress(state) {
  return state.commands.some(c => ['running','pending'].includes(c.status) || ['status','result'].includes(c.kind) && c.status === 'unknown' && c.error === 'INVALID_ARGUMENT' && !c.readonlyRetryCount)
    || state.nodes?.some(n => n.status === 'running') || state.requests.some(r => r.status === 'pending' && r.kind === 'needs_context' && !r.blocked)
}
function needsManualIntervention(state) {
  const run = state.run
  if (run.status !== 'needs_attention' || /^MESSAGE_DEADLINE_BEFORE_CLAIM:/u.test(run.reason ?? '')) return false
  if (run.reason?.startsWith('MESSAGE_CONTEXT_CAPACITY:') && !run.capacityRetryVersion) return false
  if (run.reason === 'recovery_exhausted' && !run.executionStartedAt && !state.nodes?.length && !state.commands.length) return false
  return !canStillProgress(state)
}
export function formatGroupReply(text, responsibility = '') {
  if (typeof text !== 'string' || !text.trim()) throw new Error('WORKFLOW_REPLY_TEXT_REQUIRED')
  assertGroupReply(text)
  const body = text.trim()
  const signatures = [...new Set([
    ...[...responsibility.matchAll(/-[ \t]*([^\r\n，,；;。！!？?`"'“”「」]{1,80}?代回)/gu)].map(match => match[1].trim()),
    ...responsibility.split(/[\r\n；;]/u).map(part => part.trim()).filter(part => /^[^\s，,。！!？?`"'“”「」]{1,40}代回$/u.test(part)),
  ])]
  if (signatures.length > 1) throw new Error('WORKFLOW_REPLY_SIGNATURE_AMBIGUOUS')
  if (!signatures.length || body.split(/\r?\n/u).some(line => line.trim() === `- ${signatures[0]}`)) return body
  const formatted = `${body}\n\n- ${signatures[0]}`
  assertGroupReply(formatted)
  return formatted
}
export function sendWorkflowNotification(adapter, notification) {
  const payload = notification.payload
  if (payload.reportChannel === 'web' || payload.externalMessaging === false
    || notification.disclosure?.authorizationRef?.startsWith('web-rerun:')) throw new Error('WORKFLOW_WEB_NOTIFICATION_FORBIDDEN')
  assertGroupReply(payload.text)
  const base = { groupId: payload.conversationId, text: payload.text, idempotencyKey: notification.id }
  return payload.sourceMessageId && payload.actorId
    ? adapter.sendGroupReply({ ...base, replyToMessageId: payload.sourceMessageId, replyToSenderOpenDingTalkId: payload.actorId })
    : adapter.sendGroup(base)
}

/** 只执行预检过的单条操作。领取后异常进入待核对，调用方不能重试外部动作。 */
export async function executeNotificationOperation({ store, adapter, operationId, expectedFactDigest, authorizationRef }) {
  const operation=await store.query({kind:'message.notificationOperation',operationId})
  if(!operation)throw new Error('MESSAGE_NOTIFICATION_OPERATION_NOT_FOUND')
  if(operation.status==='completed')return operation
  if(operation.status!=='prepared')throw new Error('MESSAGE_NOTIFICATION_OPERATION_RECONCILE_REQUIRED')
  const notification=await store.query({kind:'message.notification',notificationId:operation.snapshot.notificationId})
  if(!adapter?.canDisclose||!await adapter.canDisclose(notification))throw new Error('MESSAGE_NOTIFICATION_DISCLOSURE_FORBIDDEN')
  const type=operation.snapshot.type
  if(type==='recall'&&(!adapter.recall||!adapter.readbackRecall))throw new Error('MESSAGE_NOTIFICATION_RECALL_ADAPTER_REQUIRED')
  if(type==='restore'&&(!adapter.send||!adapter.readback))throw new Error('MESSAGE_NOTIFICATION_SEND_ADAPTER_REQUIRED')
  const command=(kind,args,suffix)=>store.command({id:`notification-operation:${operationId}:${suffix}`,kind,args})
  if(type==='restore')assertGroupReply(operation.snapshot.body)
  const claimed=await command('message.notification.operation.claim',{operationId,expectedFactDigest,authorizationRef},'claim')
  if(!claimed.dispatchEligible)throw new Error('MESSAGE_NOTIFICATION_OPERATION_STALE')
  const snapshot=claimed.result.operation.snapshot
  let ack
  try {
    ack=type==='recall'
      ? await adapter.recall({conversationId:snapshot.conversationId,messageId:snapshot.messageId,operationId})
      : await adapter.send({id:operationId,payload:{conversationId:snapshot.conversationId,sourceMessageId:snapshot.sourceMessageId,actorId:notification.payload.actorId,text:snapshot.body}})
    await command('message.notification.operation.result',{operationId,ack},'result')
  }catch(error){
    await command('message.notification.operation.result',{operationId,error:error.code??error.message},'unknown')
    throw error
  }
  const evidence=type==='recall'
    ? await adapter.readbackRecall({conversationId:snapshot.conversationId,messageId:snapshot.messageId,operationId,ack})
    : await adapter.readback({id:operationId,payload:{conversationId:snapshot.conversationId,sourceMessageId:snapshot.sourceMessageId,text:snapshot.body},ack})
  if(!evidence)return (await store.query({kind:'message.notificationOperation',operationId}))
  return (await command('message.notification.operation.reconcile',{operationId,messageId:evidence.messageId,evidenceRef:evidence.evidenceRef, ...(type==='recall'?{recallStatus:evidence.recallStatus}:{})},'reconcile')).result.operation
}

/** 通知独立于任务执行。ACK不代表送达，未知发送只回查，不再次发送。 */
export function createWorkflowNotifications({ store, artifacts, controller, adapter, groupResponsibility = () => '' }) {
  let flight, beforeSequenceId, preparedCursor = 0, readbackCursor = 0
  const verifiedStarts = new Set()
  const command = (kind, args, id) => store.command({ id, kind, args })
  async function prepare(run, action, phase, text, communicationPhase = phase) {
    if (run.channel === 'web' || run.externalMessaging === false) return
    if (notificationSilence(run, communicationPhase)) return
    // 正文与代次必须取同一个已完成命令快照，不能拿旧正文拼接新 execution 版本。
    const answerReceipt = phase === 'receipt' && action.kind === 'answer'
    if (answerReceipt && action.result?.status === 'blocked' && action.result?.reason === 'execution_tool_failed') text = '本次查询因系统读取问题未完成，执行已停止，需要修复后继续。'
    const attemptVersion = answerReceipt && action.readonlyRetryHistory?.length ? action.result?.inputVersion : undefined
    const starting = phase.startsWith('owner:started:')
    if (starting) {
      let afterSequenceId = 0
      do {
        const page = await store.query({ kind: 'message.notifications', taskId: action.result.taskId,
          states: ['prepared', 'sending', 'acknowledged', 'unknown', 'delivered'], afterSequenceId, limit: 200 })
        const prior = page.find(n => n.payload?.phase?.startsWith('owner:started:')
          && n.payload.fact?.taskId === action.result.taskId && n.payload.conversationId === run.conversationId
          && n.payload.sourceMessageId === run.context?.sourceMessageId && n.payload.fact.sourceVersion === run.sourceVersion)
        if (prior) {
          // 复用精确消息回查核对群历史；未知发送仍只回查，不因重评生成新的“开始”。
          if (adapter?.readback && !verifiedStarts.has(prior.id) && ['acknowledged', 'unknown', 'delivered'].includes(prior.status)) {
            const evidence = await adapter.readback(prior)
            if (evidence) {
              if (prior.status !== 'delivered') await command('message.notification.readback',
                { notificationId: prior.id, leaseEpoch: prior.leaseEpoch, evidence }, `delivered:${prior.id}:${prior.leaseEpoch}`)
              verifiedStarts.add(prior.id)
            }
          }
          return
        }
        if (page.length < 200) break
        afterSequenceId = page.at(-1).sequenceId
      } while (true)
    }
    let recoveredAt = 0, recoveredTime = ''
    if (phase.startsWith('owner:application_wait:')) {
      let afterSequenceId = 0
      do {
        const page = await store.query({ kind: 'task.owner.events', taskId: action.result.taskId, afterSequenceId, limit: 200 })
        for (const event of page) if (event.eventType === 'workflow.succeeded') { recoveredAt = event.eventSeq; recoveredTime = event.createdAt }
        if (page.length < 200) break
        afterSequenceId = page.at(-1).eventSeq
      } while (true)
      afterSequenceId = 0
      do {
        const page = await store.query({ kind: 'message.notifications', states: ['sending','acknowledged','unknown','delivered'], afterSequenceId, limit: 200 })
        if (page.some(n => n.payload?.phase?.startsWith('owner:application_wait:') && n.payload.fact?.taskId === action.result.taskId && (!recoveredTime || n.createdAt >= recoveredTime))) return
        if (page.length < 200) break
        afterSequenceId = page.at(-1).sequenceId
      } while (true)
    }
    const eventKey=phase.startsWith('owner:application_wait:') ? `task.system_wait:${action.result.taskId}:after:${recoveredAt}:${phase.slice('owner:application_wait:'.length)}` : attemptVersion ? `action.reply:${action.commandId}:${phase}:input:${attemptVersion}` : phase.startsWith('owner:') ? `task.owner.report:${phase.slice(6)}`
      : phase.startsWith('terminal:') ? `task.result:${action.result.runId}:${phase}`
      : ['create','reopen'].includes(action.kind) && action.result?.taskId ? `task.accepted:${action.result.taskId}:${run.sourceVersion}:${action.commandId}`
      : action.status==='rejected' ? `action.rejected:${action.commandId}` : `action.reply:${action.commandId}:${phase}`
    const notificationId = `notice-${executionDigest(attemptVersion ? [action.commandId, phase, attemptVersion] : phase.startsWith('owner:') ? eventKey : [action.commandId, phase])}`
    const existing = (phase.startsWith('owner:') ? await store.query({ kind: 'message.notification', eventKey }) : null)
      ?? await store.query({ kind: 'message.notification', notificationId })
      ?? (phase.startsWith('owner:') ? await store.query({ kind: 'message.notification', notificationId: `notice-${executionDigest([action.commandId, phase])}` }) : null)
    if (existing) {
      if (phase.startsWith('owner:') ? existing.eventKey !== eventKey
        : existing.runId !== run.runId || existing.commandId !== action.commandId) throw new Error('MESSAGE_NOTIFICATION_CONFLICT')
      return
    }
    const latest = phase.startsWith('owner:') && action.result?.taskId
      ? await store.query({ kind: 'message.task.latest', taskId: action.result.taskId }) : null
    const sourceRun = latest?.run?.conversationId === run.conversationId ? latest.run : run
    if (notificationSilence(sourceRun, communicationPhase)) return
    const responsibility = groupResponsibility(run.conversationId)
    if (responsibility.includes('引用回复') && (!sourceRun.context?.sourceMessageId || !sourceRun.actorId)) throw new Error('WORKFLOW_REPLY_SOURCE_REQUIRED')
    await command('message.notification.prepare', { runId: run.runId, commandId: action.commandId, notificationId, eventKey,
      payload: { text: formatGroupReply(text, responsibility), phase, conversationId: run.conversationId,
        sourceMessageId: sourceRun.context?.sourceMessageId, actorId: sourceRun.actorId,
        fact: { sourceVersion: run.sourceVersion, runRevision: run.revision, ...(answerReceipt ? { commandLeaseEpoch: action.leaseEpoch, ...(action.result?.inputVersion ? { commandInputVersion: action.result.inputVersion } : {}) } : {}), ...(action.result?.taskId ? { taskId: action.result.taskId } : {}) } },
      disclosure: { conversationId: run.conversationId, authorizationRef: sourceRun.sourceKey },
    }, `prepare:${notificationId}`)
  }
  async function priorWaitUnchanged(run, phase, request) {
    if (!['attention', 'routing_wait', 'system_wait'].includes(phase)) return {}
    let afterSequenceId = 0, latest
    do {
      const page = await store.query({ kind: 'message.notifications', sourceKey: run.sourceKey,
        states: ['sending', 'acknowledged', 'unknown', 'delivered'], afterSequenceId, limit: 200 })
      for (const notice of page) if (notice.payload?.conversationId === run.conversationId) latest = notice
      if (page.length < 200) break
      afterSequenceId = page.at(-1).sequenceId
    } while (true)
    if (!latest) return {}
    const nextEpisode = { episode: latest.id }
    if (latest.payload.phase !== phase) return nextEpisode
    if (phase === 'attention' && systemWaitText(latest.stateFact?.reason) !== systemWaitText(run.reason)) return nextEpisode
    const previous = await store.query({ kind: 'message.run', runId: latest.runId })
    if (previous.run.body !== run.body) return nextEpisode
    if (phase === 'system_wait') {
      const prior = previous.requests.find(item => item.id === latest.requestId)
      const resources = item => [...new Set((item?.needs ?? []).map(need => need.resourceRef).filter(Boolean))].sort()
      if (!prior || executionDigest(resources(prior)) !== executionDigest(resources(request))) return nextEpisode
    }
    return { unchanged: true }
  }
  async function prepareState(run, phase, text, request) {
    if (notificationSilence(run, phase)) return
    const wait = await priorWaitUnchanged(run, phase, request)
    if (wait.unchanged) return
    const stateFact = { revision: run.revision, status: run.status, reason: run.reason ?? null, intentStatus: run.intentStatus ?? null, phase }
    const eventKey = (request ? `request.${phase}:${request.id}:${request.revision}`
      : `message.${phase}:${run.runId}:${run.sourceVersion}:${executionDigest(stateFact)}`) + (wait.episode ? `:after:${wait.episode}` : '')
    const notificationId = `notice-${executionDigest(eventKey)}`
    if (await store.query({ kind: 'message.notification', notificationId })) return
    const responsibility = groupResponsibility(run.conversationId)
    if (responsibility.includes('引用回复') && (!run.context?.sourceMessageId || !run.actorId)) throw new Error('WORKFLOW_REPLY_SOURCE_REQUIRED')
    await command('message.notification.prepare', { runId: run.runId, ...(request ? { requestId: request.id } : { stateFact }), notificationId, eventKey,
      payload: { text: formatGroupReply(text, responsibility), phase, conversationId: run.conversationId,
        sourceMessageId: run.context?.sourceMessageId, actorId: run.actorId,
        fact: { sourceVersion: run.sourceVersion, runRevision: run.revision, ...(request ? { requestRevision: request.revision } : {}) } },
      disclosure: { conversationId: run.conversationId, authorizationRef: run.sourceKey },
    }, `prepare:${notificationId}`)
  }
  async function prepareAcceptance(run, acceptance) {
    if (await store.query({ kind: 'task.deleted', taskId: acceptance.taskId })) return
    if (notificationSilence(run, 'receipt')) return
    const eventKey = `task.accepted:${acceptance.taskId}:${acceptance.requirementRevision}`
    const notificationId = `notice-${executionDigest(eventKey)}`
    if (await store.query({ kind: 'message.notification', notificationId })) return
    // 升级后的承接责任不能让已经送达的同一原命令回执重新发送。
    if (await store.query({ kind: 'message.notification', notificationId: `notice-${executionDigest([acceptance.commandId, 'receipt'])}` })) return
    const responsibility = groupResponsibility(run.conversationId)
    if (responsibility.includes('引用回复') && (!run.context?.sourceMessageId || !run.actorId)) throw new Error('WORKFLOW_REPLY_SOURCE_REQUIRED')
    await command('message.notification.prepare', { runId: run.runId, acceptanceId: acceptance.id, notificationId, eventKey,
      payload: { text: formatGroupReply('正在核对执行条件，处理尚未开始。', responsibility), phase: 'accepted', conversationId: run.conversationId,
        sourceMessageId: run.context?.sourceMessageId, actorId: run.actorId,
        fact: { sourceVersion: acceptance.sourceVersion, runRevision: run.revision, taskId: acceptance.taskId, requirementRevision: acceptance.requirementRevision } },
      disclosure: { conversationId: run.conversationId, authorizationRef: run.sourceKey },
    }, `prepare:${notificationId}`)
  }
  async function drain() {
    const failures = []
    const unresolved = new Map((await store.query({ kind: 'message.notification.diagnostics', status: 'unresolved' })).map(item => [item.id, item.error]))
    const attempt = async (runId, fact, action) => {
      const diagnosticId = `notice-diagnostic-${executionDigest([runId, fact])}`
      try {
        const result = await action()
        if (unresolved.has(diagnosticId)) {
          await command('message.notification.diagnostic', { runId, fact, diagnosticId, resolved: true }, `diagnostic:${randomUUID()}`)
          unresolved.delete(diagnosticId)
        }
        return result
      } catch (error) {
        const code = error.code ?? error.message
        failures.push({ runId, fact, code })
        try {
          if (unresolved.get(diagnosticId) !== code) {
            await command('message.notification.diagnostic', { runId, fact, diagnosticId, error: code }, `diagnostic:${randomUUID()}`)
            unresolved.set(diagnosticId, code)
          }
        }
        catch (diagnosticError) { failures.push({ runId, fact: 'diagnostic', code: diagnosticError.code ?? diagnosticError.message }) }
      }
    }
    const finish = () => { if (failures.length) throw new AggregateError(failures.map(f => new Error(`${f.runId}:${f.fact}:${f.code}`)), `MESSAGE_NOTIFICATION_SCAN_FAILED:${JSON.stringify(failures)}`) }
    const page = await store.query({ kind: 'message.list', limit: 200, ...(beforeSequenceId ? { beforeSequenceId } : {}) })
    beforeSequenceId = page.length === 200 ? page.at(-1).sequenceId : undefined
    for (const listedRun of page) {
      await attempt(listedRun.runId, 'source', async () => {
      const state = await store.query({ kind: 'message.run', runId: listedRun.runId })
      const run = state.run ?? listedRun
      if (run.channel === 'web' || run.externalMessaging === false) return
      if (run.status === 'superseded') return
      const acceptances = await store.query({ kind: 'message.acceptances', runId: run.runId })
      for (const acceptance of acceptances) await attempt(run.runId, acceptance.id, () => prepareAcceptance(run, acceptance))
      if (needsManualIntervention(state)) await attempt(run.runId, 'attention', () => prepareState(run, 'attention', systemWaitText(run.reason)))
      if (run.intentStatus === 'waiting_routing_barrier' && Date.now() - Date.parse(run.createdAt) >= 60_000) {
        await attempt(run.runId, 'routing_wait', () => prepareState(run, 'routing_wait', '目前正在核对可能相关的补充要求，相关处理尚未开始；核对清楚后继续。'))
      }
      if (run.status === 'settled' && (run.snapshot?.replyObligation ?? run.context?.replyObligation)?.required
        && !state.commands.length && !state.requests.some(item => item.status === 'pending')) {
        if (!(await store.query({kind:'message.impact',runId:run.runId})).impact?.coordinatorManaged)
        await attempt(run.runId, 'reply_obligation', () => prepareState(run, 'reply_obligation', /在不在|在[吗嘛么]/u.test(run.body ?? '') ? '在的，请说。' : '已收到。'))
      }
      for (const request of state.requests.filter(item => item.status === 'pending' && item.kind === 'needs_context' && item.blocked && !canStillProgress(state))) {
        await attempt(run.runId, `system_wait:${request.id}`, () => prepareState(run, 'system_wait', manualInterventionText, request))
      }
      for (const request of state.requests.filter(item => item.status === 'pending' && item.kind === 'needs_clarification')) {
        await attempt(run.runId, request.id, async () => {
        if (notificationSilence(run, 'clarification')) return
        const notificationId = `clarify-${executionDigest([run.runId, request.id, request.revision])}`
        const existing = await store.query({ kind: 'message.notification', notificationId })
        if (existing) {
          if (existing.runId !== run.runId || existing.requestId !== request.id) throw new Error('MESSAGE_NOTIFICATION_CONFLICT')
          return
        }
        const responsibility = groupResponsibility(run.conversationId)
        if (responsibility.includes('引用回复') && (!run.context?.sourceMessageId || !run.actorId)) throw new Error('WORKFLOW_REPLY_SOURCE_REQUIRED')
        await command('message.notification.prepare', { runId: run.runId, requestId: request.id, notificationId, eventKey:`request.clarification:${request.id}:${request.revision}`,
          payload: { text: formatGroupReply(request.question ?? request.reason, responsibility), phase: 'clarification', conversationId: run.conversationId, sourceMessageId: run.context?.sourceMessageId, actorId: run.actorId },
          disclosure: { conversationId: run.conversationId, authorizationRef: run.sourceKey },
        }, `prepare:${notificationId}`)
        })
      }
      for (const action of state.commands.filter(item => ['applied', 'rejected'].includes(item.status))) {
        await attempt(run.runId, action.commandId, async () => {
        if (action.result?.taskId && await store.query({ kind: 'task.deleted', taskId: action.result.taskId })) return
        const lifecycle = Boolean(action.result?.taskId) && ['create', 'research', 'answer', 'reopen', 'revise', 'pause', 'resume', 'cancel', 'confirm'].includes(action.kind)
        const hasAcceptance = acceptances.some(item => item.commandId === action.commandId)
        // 补充、更正只更新同一事项；其实际进展由 Owner 统一通知，不逐条承接。
        if (!hasAcceptance && (action.kind !== 'revise' || action.status === 'rejected') && action.result?.reply && (lifecycle || action.status === 'rejected' || action.args.replyPolicy !== 'none')) await prepare(run, action, 'receipt', action.result.reply)
        else if (!hasAcceptance && lifecycle && ['create', 'reopen'].includes(action.kind)) await prepare(run, action, 'receipt', '已接收任务，正在核对执行条件；实际开始和处理结果会继续告知。')
        if (lifecycle) {
          const plan = await controller?.taskPlan(action.result.taskId)
          for (const stage of plan?.stages.filter(item => item.status === 'running') ?? []) {
            if (!stage.runId || plan.task.controlState !== 'active') continue
            const execution = await controller.state(stage.runId)
            if (execution.run.status !== 'running' || execution.run.pauseRequested || execution.run.stopRequested
              || !execution.nodes.some(node => node.status === 'running' && node.startedAt)) continue
            await attempt(run.runId, `started:${stage.runId}`, () => prepare(run, action,
              `owner:started:${stage.runId}`, '任务已开始处理。', 'progress'))
          }
          if (await store.query({ kind: 'message.owner.released-wait', taskId: action.result.taskId }))
            await prepare(run, action, 'owner:application_wait:released', manualInterventionText, 'required_action')
          const reports = await store.query({ kind: 'task.owner.reports', taskId: action.result.taskId })
          for (const report of reports.filter(item => item.applicationStatus === 'blocked').slice(-1)) {
            await attempt(run.runId, `application_wait:${report.reportId}`, () => prepare(run, action,
              `owner:application_wait:${report.reportId}`,
              manualInterventionText, 'required_action'))
          }
          for (const report of reports.filter(item => item.applicationStatus === 'applied'
            && (['complete', 'block'].includes(item.reportType)
              || item.reportType === 'wait' && taskDecisionConditionText(item.facts.condition)
              || item.triggerTypes.includes('workflow.succeeded') && item.facts.evidenceRefs.length
              || item.triggerTypes.includes('workflow.confirmation.required')))) {
            let text = report.reportType === 'complete' ? `任务已完成：${report.facts.summary}`
              : ['block', 'wait'].includes(report.reportType) && taskDecisionConditionText(report.facts.condition)
                ? `${report.reportType === 'block' ? '处理暂时受阻：' : ''}${Array.from(String(report.facts.summary).replace(/\s+/gu, ' ').trim()).slice(0, 160).join('')}`
              : report.reportType === 'block' ? `处理暂时受阻：${Array.from(String(report.facts.summary ?? '').replace(/\s+/gu, ' ').trim()).slice(0, 160).join('')}`
                : report.triggerTypes.includes('workflow.confirmation.required') ? `任务等待确认：${report.facts.summary}`
                  : `任务进展：${report.facts.summary}`
            const approvalStage = report.reportType === 'wait' && report.facts.condition?.kind === 'approval'
              ? plan?.stages.find(stage => stage.status === 'running'
                && ['task-data-change', 'task-data-change-approval-resume'].includes(stage.workflowId)) : null
            if (approvalStage?.runId) {
              const effects = await store.query({ kind: 'effect.list', runId: approvalStage.runId })
              const effect = effects.find(item => item.state === 'prepared' && item.requestId
                && item.definition.action === 'external' && item.definition.payload?.workflowKind === 'data-change'
                && item.definition.payload.stage === 'approval-gate' && item.definition.payload.intent?.approvalSource === 'assistant')
              const issue = effect?.definition.payload.intent.issueId?.match(/^projects\/[^/]+\/issues\/([1-9]\d*)$/u)
              if (issue && (await store.query({ kind: 'approval.get', requestId: effect.requestId })).decision === 'pending')
                text = `Bytebase 工单 #${issue[1]} 已新建，等待人工审批。`
            }
            await attempt(run.runId, report.reportId, () => prepare(run, action, `owner:${report.reportId}`, text, report.reportType === 'complete' ? 'result'
              : ['block', 'wait'].includes(report.reportType) && taskDecisionConditionText(report.facts.condition)
                || report.reportType === 'block' || report.triggerTypes.includes('workflow.confirmation.required') ? 'required_action' : 'progress'))
          }
        }
        if (!['create', 'research', 'answer', 'reopen'].includes(action.kind) || !action.result?.runId) return
        const task = await controller.state(action.result.runId)
        if (!['succeeded', 'failed', 'cancelled'].includes(task.run.status)) return
        const plan = await controller.taskPlan(task.run.taskId)
        if (plan) return
        const last = task.nodes.filter(node => node.outputRef).at(-1)
        const output = last ? await artifacts.read(last.outputRef) : null
        const text = task.run.status === 'succeeded' ? workflowResultText(output) ?? '已完成处理。'
          : task.run.status === 'cancelled' ? '已取消处理。' : '这次处理没有完成，需要先排查原因。'
        await prepare(run, action, `terminal:${task.run.runId}:${task.run.revision}`, text)
        })
      }
      })
    }
    if (!adapter) { finish(); return }
    const prepared = await store.query({ kind: 'message.notifications', states: ['prepared'], afterSequenceId: preparedCursor, limit: 100 })
    const readbacks = await store.query({ kind: 'message.notifications', states: ['acknowledged', 'unknown'], afterSequenceId: readbackCursor, limit: 100 })
    preparedCursor = prepared.length === 100 ? prepared.at(-1).sequenceId : 0
    readbackCursor = readbacks.length === 100 ? readbacks.at(-1).sequenceId : 0
    for (const notification of [...prepared, ...readbacks]) {
      await attempt(notification.runId, notification.id, async () => {
      if (notification.payload?.reportChannel === 'web' || notification.payload?.externalMessaging === false
        || notification.disclosure?.authorizationRef?.startsWith('web-rerun:')) return
      // 同群来源也不替代当前披露校验；群已撤销或配置变化时不外发内容。
      if (!await adapter.canDisclose(notification)) return
      let current = notification
      if (current.status === 'prepared') {
        assertGroupReply(current.payload.text)
        const claimed = await command('message.notification.claim', { notificationId: current.id }, `claim:${current.id}`)
        if (!claimed.dispatchEligible) return
        current = claimed.result.notification
        try {
          const ack = await adapter.send(current)
          await command('message.notification.sent', { notificationId: current.id, leaseEpoch: current.leaseEpoch, ack }, `sent:${current.id}:${current.leaseEpoch}`)
          current = { ...current, status: 'acknowledged', ack }
        } catch (error) {
          await command('message.notification.fail', { notificationId: current.id, leaseEpoch: current.leaseEpoch, error: error.code ?? error.message }, `unknown:${current.id}:${current.leaseEpoch}`)
          current = { ...current, status: 'unknown' }
        }
      }
      if (['acknowledged', 'unknown'].includes(current.status)) {
        const evidence = await adapter.readback(current)
        if (evidence) await command('message.notification.readback', { notificationId: current.id, leaseEpoch: current.leaseEpoch, evidence }, `delivered:${current.id}:${current.leaseEpoch}`)
      }
      })
    }
    finish()
  }
  return { flush() { return flight ??= drain().finally(() => { flight = undefined }) } }
}
