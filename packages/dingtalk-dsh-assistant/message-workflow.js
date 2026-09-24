import { randomUUID } from 'node:crypto'
import { digest, messageSchemas, prepareMessageContext, splitContext, validateSplit, unitContext, candidateCards, intentContext } from './message-context.js'
import { messageSystem } from './message-model.js'

export const defaultMessagePolicy = Object.freeze({ version: 'message-v2.1', initialWindowMs: 45000, linkedWindowMs: 30000, attemptMs: 20000, commitReserveMs: 500, maxClaims: 21, maxCorrections: 2, concurrency: 2, maxInputBytes: 64000, maxOutputBytes: 48000, recoveryDelaysMs: [5000, 30000] })
const limits = { S: [8000, 2000], R: [14000, 1000], I: [16000, 1500] }
const statusQuestion = text => /(?:完成|改完|进度|状态|部署).*[吗？?]/u.test(text) && /(?:审核|任务|问题)/u.test(text)
const directedStatusQuestion = text => /小小鹏/u.test(text) && statusQuestion(text)
function statusFollowup(snapshot) {
  const body = snapshot.source.text.trim()
  const previous = snapshot.history.slice(-6).findLast(item => statusQuestion(item.text))
  if (!previous || /^(?:请|帮我|小小鹏).*(?:修复|处理|排查|部署)/u.test(body)) return null
  if (/匹配到.{0,8}(?:个|项)任务/u.test(body)) return { kind: 'count', sourceKey: previous.sourceKey }
  if (snapshot.quotes.length && (body.match(/问题/gu) ?? []).length >= 2) return { kind: 'scope', sourceKey: previous.sourceKey }
  return null
}

/** 无常驻模型会话。每个判断独立、无工具；数据库是恢复和派发的唯一事实源。 */
export function createMessageWorkflow({ store, judge, context = {}, handlers = {}, policy = {}, clock = Date.now }) {
  if (!store?.command || !store?.query || typeof judge !== 'function') throw new Error('MESSAGE_DEPENDENCIES_REQUIRED')
  const config = { ...defaultMessagePolicy, ...policy }, flights = new Map(), controllers = new Set(), queue = []
  let closed = false, occupied = 0, processTail = Promise.resolve()
  const cmd = async (kind, args, id = `${kind}:${randomUUID()}`) => (await store.command({ id, kind, args })).result
  const state = runId => store.query({ kind: 'message.run', runId })
  const revision = data => data.run.revision ?? data.run.matterSetRevision ?? 0
  const slot = () => new Promise((resolve, reject) => { if (closed) { reject(new Error('MESSAGE_WORKFLOW_CLOSED')); return }; queue.push({ resolve, reject }); drain() })
  function drain() { while (!closed && occupied < config.concurrency && queue.length) { occupied++; queue.shift().resolve(() => { occupied--; drain() }) } }
  async function receive(input, { process: launch = true } = {}) {
    if (closed) throw new Error('MESSAGE_WORKFLOW_CLOSED')
    if (!input.sourceKey || !Number.isInteger(input.sourceVersion) || !input.actorId || !input.conversationId || typeof input.body !== 'string' || !input.body.length) throw new Error('MESSAGE_INPUT_INVALID')
    const runId = input.runId ?? `msg-${digest([input.sourceKey, input.sourceVersion]).slice(0, 40)}`
    const result = await cmd('message.receive', { ...input, runId, policy: config }, `receive:${runId}`)
    if (launch) void process(runId).catch(() => {})
    return { ...result, runId }
  }
  async function reprocess(runId) {
    const previous=await state(runId)
    const nextVersion=previous.run.sourceVersion+1
    const newRunId=`msg-replay-${digest([previous.run.sourceKey,nextVersion]).slice(0,40)}`
    const result=await cmd('message.reprocess',{runId,newRunId},`reprocess:${runId}:${newRunId}`)
    return process(result.run.runId)
  }
  async function waiting(data, unitId, stage, output) {
    return cmd('message.wait', { runId: data.run.runId, unitId, nodeId: stage, expectedRevision: revision(data), reason: output.reason, request: { requestId: digest([data.run.runId, unitId, stage, revision(data), output]), kind: output.kind, question: output.question ?? output.reason, needs: output.needs ?? [], permittedActors: [data.run.actorId] } })
  }
  async function invoke(data, unitId, stage, input, fixedOutput) {
    const runId = data.run.runId, rev = revision(data)
    const prior = data.nodes.find(node => node.unitId === unitId && node.nodeId === stage && ['completed', 'succeeded'].includes(node.status) && (node.revision ?? rev) === rev)
    if (prior) return prior.output?.output ?? prior.output
    if (data.requests.some(request => request.unitId === unitId && request.nodeId === stage && request.status === 'pending')) return null
    const answers = data.requests.filter(request => request.unitId === unitId && request.nodeId === stage && request.status === 'resolved').map(request => ({ requestId: request.id, question: request.question, answer: request.answer }))
    const previousFailure = data.nodes.findLast(node => node.unitId === unitId && node.nodeId === stage && node.status === 'failed')?.error
    input = { ...input, ...(answers.length ? { clarificationAnswers: answers } : {}), ...(previousFailure ? { previousFailure } : {}) }
    const [inputLimit, outputLimit] = limits[stage]
    const inputBytes = Buffer.byteLength(JSON.stringify(input) + messageSystem(stage))
    // UTF8字节是保守token上界，所有schema/system也算入；必需字段不截断。
    if (inputBytes > inputLimit) { await cmd('message.attention', { runId, reason: `MESSAGE_CONTEXT_CAPACITY:${stage}:${unitId}:${inputBytes}/${inputLimit}` }); return null }
    const release = await slot()
    let binding, timer, controller
    try {
      if (closed) return null
      const current = await state(runId)
      if (revision(current) !== rev) return null
      const deadline = current.run.deadline
      const remaining = deadline ? Number(new Date(deadline)) - clock() - config.commitReserveMs : config.attemptMs
      if (remaining <= 0) { await cmd('message.attention', { runId, reason: `MESSAGE_DEADLINE_BEFORE_CLAIM:${stage}:${unitId}` }); return null }
      const claimed = await cmd('message.node.claim', { runId, unitId, nodeId: stage, expectedRevision: rev, estimatedInputTokens: inputBytes, maxOutputTokens: outputLimit, input: { ...input, inputBytes, inputReadyAt: clock() } })
      binding = claimed?.node
      if (!binding) return null
      controller = new AbortController(); controllers.add(controller)
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('MESSAGE_NODE_TIMEOUT')) }, Math.min(config.attemptMs, remaining)) })
      const response = fixedOutput ? { output: fixedOutput, usage: { inputTokens: 0, outputTokens: 0 } } : await Promise.race([judge({ stage, input, schema: messageSchemas[stage], signal: controller.signal, maxOutputTokens: outputLimit }), timeout])
      const output = messageSchemas[stage].parse(response.output ?? response)
      if (stage === 'S') validateSplit(output, current.run.body)
      if (stage === 'R' && output.kind === 'binding' && output.candidateId !== null && !input.candidates.some(card => card.candidateId === output.candidateId)) throw new Error('MESSAGE_UNKNOWN_TARGET')
      if (stage === 'I' && output.kind === 'intent' && output.actions.some((action, index) => action.dependsOn.some(dep => dep >= index))) throw new Error('MESSAGE_ACTION_DEPENDENCY_INVALID')
      const usage = response.usage && Number.isSafeInteger(response.usage.inputTokens) && Number.isSafeInteger(response.usage.outputTokens) ? response.usage : undefined
      const committed = await cmd('message.node.complete', { runId, nodeRunId: binding.nodeRunId, leaseEpoch: binding.leaseEpoch, expectedRevision: rev, ...(usage ? { usage } : {}), output: { output, usage: response.usage ?? {}, inputBytes, resultReadyAt: clock() } })
      if (committed?.status === 'stale') return null
      return output
    } catch (error) {
      if (binding) {
        const failure = error.issues ? `MESSAGE_SCHEMA_INVALID:${JSON.stringify(error.issues.slice(0, 8).map(issue => ({ path: issue.path, message: issue.message }))).slice(0, 1200)}` : error.code ?? error.message
        try { await cmd('message.node.fail', { runId, nodeRunId: binding.nodeRunId, leaseEpoch: binding.leaseEpoch, expectedRevision: rev, error: failure, retryAt: new Date(clock() + config.recoveryDelaysMs[0]).toISOString() }) }
        catch (failure) { if (!['MESSAGE_STALE', 'MESSAGE_NODE_STALE'].includes(failure.code)) throw failure }
      }
      else if (error.code === 'MESSAGE_BUDGET_EXHAUSTED') await cmd('message.attention', { runId, reason: `MESSAGE_BUDGET_EXHAUSTED:${stage}:${unitId}` })
      else if (!['MESSAGE_NODE_NOT_READY', 'MESSAGE_RETRY_NOT_DUE', 'MESSAGE_DEADLINE_EXCEEDED', 'MESSAGE_STALE'].includes(error.code)) throw error
      return null
    } finally { clearTimeout(timer); if (controller) { controller.abort(); controllers.delete(controller) }; release() }
  }
  async function unitDrive(runId, unit) {
    if (closed) return
    let data = await state(runId)
    if (unit.status && ['accepted', 'applied', 'ignored', 'rejected', 'superseded'].includes(unit.status)) return
    if (data.requests.some(request => request.unitId === unit.unitId && request.status === 'pending')) return
    const snapshot = data.run.snapshot
    const base = unitContext(snapshot, unit)
    if (unit.contextNeeds?.length) {
      const material = await context.material?.({ run: data.run, unit, nodeId: 'R', needs: unit.contextNeeds })
      if (!material?.ready) { await waiting(data, unit.unitId, 'R', { kind: 'needs_context', reason: 'UNIT_MATERIAL_PENDING', needs: unit.contextNeeds }); return }
      base.material = material.data
    }
    const candidateStartedAt = clock()
    const rawCandidates = await context.candidates?.({ run: data.run, snapshot, unit }) ?? []
    const candidates = candidateCards(rawCandidates)
    const followup = statusFollowup(snapshot)
    const priorTopic = followup && rawCandidates.find(card => card.topicId && card.sourceRefs?.includes(followup.sourceKey))
    const linked = await invoke(data, unit.unitId, 'R', { ...base, candidates, candidatePreparationMs: clock() - candidateStartedAt }, followup ? { kind: 'binding', disposition: 'conversation', candidateId: priorTopic?.candidateId ?? null, evidence: ['前文任务状态问句的范围补充'] } : undefined)
    if (!linked) return
    if (linked.kind !== 'binding' || linked.disposition === 'unresolved') { await waiting(data, unit.unitId, 'R', linked.kind === 'binding' ? { kind: 'needs_clarification', reason: 'MESSAGE_TARGET_UNRESOLVED' } : linked); return }
    const target = candidates.find(card => card.candidateId === linked.candidateId) ?? null
    const binding = { ...linked, ...target, target }
    data = await state(runId)
    const facts = await context.facts?.({ run: data.run, snapshot, unit, binding }) ?? {}
    const fixedIntent = followup ? { kind: 'intent', actions: followup.kind === 'count'
      ? [{ intent: 'fact', arguments: { kind: 'fact', text: base.text }, dependsOn: [] }]
      : [{ intent: 'status', arguments: { scope: 'conversation' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: followup.kind === 'count' ? 'none' : 'result' } : undefined
    const intent = await invoke(data, unit.unitId, 'I', intentContext(base, binding, facts, snapshot.policy, candidates), fixedIntent)
    if (!intent) return
    if (intent.kind === 'needs_relink') {
      const result = await cmd('message.relink', { runId, unitId: unit.unitId, expectedRevision: revision(data), reason: intent.reason })
      if (result?.run?.status !== 'needs_attention') await unitDrive(runId, unit)
      return
    }
    if (intent.kind === 'needs_resegmentation') { await resegment(runId, intent.reason); return }
    if (intent.kind !== 'intent') { await waiting(data, unit.unitId, 'I', intent); return }
    if (binding.disposition === 'conversation' && intent.actions.every(action => action.intent === 'no_action')
      && /小小鹏/u.test(data.run.body) && /(?:审核|任务).*(?:完成|改完|进度|状态|部署)/u.test(data.run.body)
      && /[吗？?]/u.test(data.run.body)) {
      intent.actions = [{ intent: 'status', arguments: { scope: 'conversation' }, dependsOn: [] }]
      intent.replyPolicy = 'result'
    }
    const admission = await context.validateActions?.({ run: data.run, unit, binding, intent, facts, requests: data.requests })
    if (admission && admission.kind !== 'accepted') { await waiting(data, unit.unitId, 'I', admission); return }
    if (intent.requiredExecutionMaterials.length) {
      const needs = intent.requiredExecutionMaterials.map(resourceRef => ({ resourceRef, reason: 'required_execution_material' }))
      const material = await context.material?.({ run: data.run, unit, nodeId: 'execute', needs })
      if (!material?.ready) {
        if (material?.unsupported) await cmd('message.attention', { runId, reason: `MESSAGE_EXECUTION_MATERIAL_UNSUPPORTED:${material.reason ?? intent.requiredExecutionMaterials.join(',')}` })
        else await waiting(data, unit.unitId, 'execute', { kind: 'needs_context', reason: 'REQUIRED_EXECUTION_MATERIAL_PENDING', needs })
        return
      }
    }
    const topic = await context.topicFor?.({ run: data.run, unit, binding, intent, facts })
    if (topic) binding.topicId = topic.topicId
    if (facts.topic?.facts) base.constraints = [...new Set([...base.constraints, ...facts.topic.facts.filter(fact => fact.kind === 'constraint').map(fact => fact.text)])]
    const commands = intent.actions.every(action => action.intent === 'no_action') ? [] : intent.actions.map((action, index) => { const commandId = `${runId}:${unit.unitId}:${revision(data)}:${index}`; return { commandId, kind: action.intent, args: { taskId: binding.target?.taskId ?? (['create', 'research', 'answer'].includes(action.intent) ? `task-${digest(commandId).slice(0, 32)}` : null), arguments: action.arguments, binding, constraints: [...base.constraints, ...base.sharedConstraints, ...intent.constraints], requiredExecutionMaterials: intent.requiredExecutionMaterials, replyPolicy: intent.replyPolicy }, dependsOn: action.dependsOn.map(dep => `${runId}:${unit.unitId}:${revision(data)}:${dep}`) } })
    await cmd('message.accept', { runId, unitId: unit.unitId, expectedRevision: revision(data), commands, ...(topic ? { topic } : {}), ...(commands.length ? {} : { outcome: 'ignored' }) }, `accept:${runId}:${unit.unitId}:${revision(data)}`)
    await dispatch(runId)
  }
  async function resegment(runId, reason) {
    const before = await state(runId)
    if (!before.run.correction) {
      const changed = before.units.filter(unit => !['applied', 'accepted', 'ignored', 'rejected'].includes(unit.status)).map(unit => unit.unitId)
      const begun = await cmd('message.correction.begin', { runId, expectedRevision: revision(before), unitIds: changed, reason })
      if (begun.run.status === 'needs_attention') return
    }
    const current = await state(runId)
    const result = await invoke(current, '$', 'S', { ...splitContext(current.run.snapshot), correctionEvidence: reason })
    if (!result) return
    if (result.kind !== 'split') { await waiting(current, '$', 'S', result); return }
    const semantic = unit => ({ spans: unit.spans, goalText: unit.goalText, constraints: unit.constraints, contextNeeds: unit.contextNeeds, sharedConstraints: unit.sharedConstraints })
    const used = new Set()
    const units = result.units.map((unit, index) => {
      const next = { ...unit, sharedConstraints: result.sharedConstraints }
      const same = before.units.find(previous => !used.has(previous.unitId) && digest(semantic(previous)) === digest(semantic(next)))
      if (same) { used.add(same.unitId); return { ...semantic(same), unitId: same.unitId, ...(['applied', 'accepted', 'ignored', 'rejected'].includes(same.status) ? { preservedUnitId: same.unitId } : {}) } }
      return { ...next, unitId: `${runId}:r${revision(current)}:u${index}` }
    })
    try { await cmd('message.correction.publish', { runId, expectedRevision: revision(current), correctionId: current.run.correction.id, units }) }
    catch (error) { if (error.code !== 'MESSAGE_CORRECTION_EFFECT_PENDING') throw error; await cmd('message.attention', { runId, reason: 'RESEGMENTATION_CHANGES_APPLIED_EFFECT' }); return }
    const published = await state(runId)
    await Promise.all(published.units.filter(unit => unit.status !== 'superseded').map(unit => unitDrive(runId, unit)))
  }
  async function dispatch(runId) {
    const data = await state(runId)
    await Promise.all(data.commands.filter(command => !['applied', 'rejected', 'unknown', 'failed', 'running', 'superseded'].includes(command.status)).map(async command => {
      const action = { intent: command.kind, ...command.args }
      const info = { run: data.run, unit: data.units.find(unit => unit.unitId === command.unitId), binding: command.args.binding, commandId: command.commandId }
      const blocked = command.dependsOn?.find(id => data.commands.find(item => item.commandId === id)?.status === 'rejected')
      const validation = blocked ? { allowed: false, reason: '依赖动作已拒绝' } : await context.validateAction?.(action, info)
      if (validation?.allowed === false) {
        try { await cmd('message.command.reject', { commandId: command.commandId, reason: validation.reason }, `reject:${command.commandId}`) }
        catch (error) { if (!['MESSAGE_COMMAND_NOT_READY', 'MESSAGE_STALE'].includes(error.code)) throw error }
        await dispatch(runId)
        return
      }
      const handler = command.kind === 'no_action' ? async () => ({ outcome: 'ignored' }) : handlers[command.kind]
      if (!handler) {
        await cmd('message.attention', { runId, reason: `UNSUPPORTED_HANDLER:${command.kind}:${command.commandId}` }, `unsupported:${command.commandId}`)
        return
      }
      let receipt
      try { receipt = await store.command({ id: `dispatch:${command.commandId}:${randomUUID()}`, kind: 'message.command.claim', args: { commandId: command.commandId } }) }
      catch (error) { if (['MESSAGE_COMMAND_NOT_READY', 'MESSAGE_DEPENDENCY_PENDING', 'MESSAGE_INPUT_PENDING', 'MESSAGE_STALE'].includes(error.code)) return; throw error }
      if (!receipt.dispatchEligible || !receipt.result?.command) return
      const claimed = receipt.result.command
      try {
        const result = await handler(action, info)
        await cmd('message.command.complete', { commandId: command.commandId, leaseEpoch: claimed.leaseEpoch, result })
      } catch (error) { await cmd('message.command.fail', { commandId: command.commandId, leaseEpoch: claimed.leaseEpoch, error: error.code ?? error.message }); return }
      // 回执提交即唤醒其已就绪后继，不能等待同批其它慢动作或下一次恢复轮询。
      await dispatch(runId)
    }))
    const final = await state(runId)
    if (final.run.status === 'settled') {
      for (const barrier of final.barriers.filter(item => item.status === 'pending')) {
        await cmd('message.barrier.resolve', { runId, barrierId: barrier.id, resolution: 'all_units_applied_or_no_action' }, `barrier:${barrier.id}:resolve`)
        await context.onBarrierResolved?.(barrier, final)
      }
    }
  }
  async function drive(runId) {
    if (closed) return state(runId)
    let data = await state(runId)
    if (!data?.run || ['superseded', 'needs_attention', 'buffered'].includes(data.run.status)) return data
    if (data.run.status === 'settled') { await dispatch(runId); return state(runId) }
    if (!data.run.context?.quoteRefs?.length && /^先别管(?:它|这个|这件事|了)[。.!！\s]*$/u.test(data.run.body.trim())) {
      await cmd('message.quiet', { runId, body: data.run.body }, `quiet:${runId}`)
      return state(runId)
    }
    if (data.run.correction) { await resegment(runId, data.run.correction.reason); return state(runId) }
    if (!data.run.snapshot) {
      const snapshot = await prepareMessageContext(data.run, context)
      await cmd('message.snapshot', { runId, snapshot }, `snapshot:${runId}`)
      data = await state(runId)
    }
    if (!data.units.length) {
      const followup = statusFollowup(data.run.snapshot)
      const text = data.run.body
      const fixed = followup?.kind === 'scope' || directedStatusQuestion(text) ? { kind: 'split', units: [{ spans: [{ start: 0, end: text.length }], goalText: followup ? `前文状态问句：${data.run.snapshot.history.findLast(item=>item.sourceKey===followup.sourceKey)?.text ?? ''}；补充的问题范围：${text}` : text, constraints: [], contextNeeds: [] }], sharedConstraints: [], coverage: [{ start: 0, end: text.length, role: 'unit' }] } : undefined
      const result = await invoke(data, '$', 'S', splitContext(data.run.snapshot), fixed)
      if (!result) return state(runId)
      if (result.kind !== 'split') { await waiting(data, '$', 'S', result); return state(runId) }
      await cmd('message.split', { runId, expectedRevision: revision(data), units: result.units.map((unit, index) => ({ ...unit, unitId: `${runId}:u${index}`, sharedConstraints: result.sharedConstraints })) }, `split:${runId}:${revision(data)}`)
      data = await state(runId)
    }
    await Promise.all(data.units.map(unit => unitDrive(runId, unit)))
    await dispatch(runId)
    return state(runId)
  }
  function process(runId) {
    if (closed) return Promise.reject(new Error('MESSAGE_WORKFLOW_CLOSED'))
    if (!flights.has(runId)) {
      const flight = processTail.then(async () => {
        const data = await state(runId)
        if (data.run.status === 'pending' && !data.run.activatedAt) await cmd('message.activate', { runId }, `activate:${runId}`)
        return drive(runId)
      }).catch(async error => {
      if (!closed && !['MESSAGE_STALE', 'MESSAGE_NODE_STALE'].includes(error.code)) await cmd('message.attention', { runId, reason: `MESSAGE_CONTEXT_OR_DISPATCH_FAILED:${error.code ?? error.message}` })
      return state(runId)
      }).finally(() => flights.delete(runId))
      flights.set(runId, flight)
      processTail = flight.catch(() => {})
    }
    return flights.get(runId)
  }
  async function recover() {
    const pending = await store.query({ kind: 'message.pending' })
    const results = []
    for (const run of pending) {
      results.push(await recoverOne(run))
    }
    return results
  }
  async function recoverOne(run) {
      if (run.context?.sourceMessageId && await store.query({ kind: 'message.outboundByMessage', conversationId: run.conversationId, messageId: run.context.sourceMessageId })) {
        try { await cmd('message.echo.quarantine', { runId: run.runId }, `echo-quarantine:${run.runId}`) }
        catch (error) { if (error.code !== 'MESSAGE_ECHO_QUARANTINE_FORBIDDEN') throw error }
        return
      }
      const readonly = await state(run.runId)
      const retryable = readonly.commands.filter(item => ['status', 'result'].includes(item.kind) && item.status === 'unknown' && item.error === 'INVALID_ARGUMENT' && !item.readonlyRetryCount)
      if (retryable.length && (run.status === 'pending' || run.status === 'needs_attention' && run.reason === 'recovery_exhausted')) {
        for (const command of retryable) await cmd('message.command.retry.readonly', { commandId: command.commandId }, `readonly-retry:${command.commandId}`)
        return process(run.runId)
      }
      if (run.status === 'needs_attention') {
        const stage = run.reason?.startsWith('MESSAGE_CONTEXT_CAPACITY:S:$:') ? 'S' : run.reason?.startsWith('MESSAGE_CONTEXT_CAPACITY:R:') ? 'R' : run.reason?.startsWith('MESSAGE_CONTEXT_CAPACITY:I:') ? 'I' : null
        const version = stage === 'S' ? 's-compact-v1' : stage === 'R' ? 'r-bounded-cards-v2' : stage === 'I' ? 'i-bounded-facts-v1' : null
        if (!version || run.capacityRetryVersion === version) return
        const retried = await cmd('message.capacity.retry', { runId: run.runId, projectionVersion: version }, `capacity-retry:${run.runId}:${version}`)
        if (!retried?.retry) return
        return process(run.runId)
      }
      const pendingState = await state(run.runId)
      if (pendingState.requests.some(request => request.status === 'pending')) {
        const data = pendingState
        for (const request of data.requests.filter(item => context.material && item.status === 'pending' && item.kind === 'needs_context')) {
          const material = await context.material({ run, unit: data.units.find(unit => unit.unitId === request.unitId), nodeId: request.nodeId, needs: request.needs })
          if (material?.ready) await cmd('message.wake', { runId: run.runId, requestId: request.id, eventId: `material:${request.id}:${digest(material.data ?? {})}`, actorId: run.actorId, answer: material.data ?? {} })
        }
        return process(run.runId)
      }
      if (run.activatedAt && Date.parse(run.deadline) <= clock()) {
        try { await cmd('message.recover', { runId: run.runId }) }
        catch (error) { if (['MESSAGE_RECOVERY_EXHAUSTED', 'MESSAGE_NOT_RECOVERABLE'].includes(error.code)) return; throw error }
      }
      return process(run.runId)
  }
  async function resume(input) { const result = await cmd('message.wake', input, `wake:${input.eventId}`); if (result?.run?.runId) await process(result.run.runId); return result }
  async function close() { closed = true; for (const controller of controllers) controller.abort(); for (const item of queue.splice(0)) item.reject(new Error('MESSAGE_WORKFLOW_CLOSED')); await Promise.allSettled(flights.values()) }
  return { receive, reprocess, process, recover, resume, state, close }
}
