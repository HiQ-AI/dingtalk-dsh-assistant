import { openExecutionRuntime } from './execution.js'
import { defineExecutionWorkflow } from './execution-controller.js'
import { executionDigest, executionError } from './execution-artifacts.js'
import { createAnalysisTaskWorkflow, createReadOnlyTaskWorkflows } from './task-workflow.js'
import { createMessageWorkflow } from './message-workflow.js'
import { createMessageModel } from './message-model.js'
import { taskWorkflowCatalog } from './message-context.js'
import { createWorkflowNotifications, workflowResultText } from './workflow-notifications.js'
import { createEngineeringRegistry } from './workflow-engineering.js'
import { createDataChangeTaskWorkflow } from './workflow-data-change.js'
import { createReleaseTaskWorkflow, releaseWorkflowKinds } from './task-release-workflows.js'
import { createWorkflowApprovalService } from './workflow-approval.js'
import { queryConversationTaskProgress, singleTaskProgressResult, taskProgressQueryDefinition } from './task-progress-query.js'

const sourceKey = (profile, groupId, messageId) => `dws:${executionDigest([profile, groupId, messageId])}`
export const isDirectedTaskRequest = body => typeof body === 'string' && /(?:小小鹏|@孙鹏(?:\(孙鹏\))?).{0,50}(?:需要(?:你|我)?(?:修复|处理|排查)|请(?:你|帮忙)?(?:修复|处理|排查)|帮(?:我|忙)?(?:修复|处理|排查))/su.test(body)
const requireText = (value, code) => { if (typeof value !== 'string' || !value.trim()) throw executionError(code); return value }
const terminal = status => ['succeeded', 'failed', 'cancelled'].includes(status)
const catalogById = new Map(taskWorkflowCatalog.map(item => [item.id, item]))
const readOnlyCatalog = taskWorkflowCatalog.filter(item => item.mode === 'read-only').map(({ id, purpose }) => ({ id, purpose }))
const externalLabels = Object.freeze(Object.fromEntries(taskWorkflowCatalog.filter(item => item.mode === 'external').map(item => [item.id, item.purpose])))

function createExternalRegistry(external, selected) {
  const configured = !!external && (!!external.dataChangeAdapter || !!external.releaseAdapters && Object.keys(external.releaseAdapters).length > 0)
  if (!configured) return { workflows: [], records: new Map(), byId: new Map() }
  if (typeof external.operationAdapter?.execute !== 'function' || typeof external.operationAdapter?.reconcile !== 'function'
    || typeof external.authorizeExternal !== 'function' || typeof external.prepareRequirement !== 'function') throw executionError('EXTERNAL_WORKFLOW_GATE_REQUIRED')
  const workflows = [], records = new Map(), byId = new Map()
  const add = (workflow, adapter, modelConfig = null) => {
    if (catalogById.get(workflow.id)?.mode !== 'external' || byId.has(workflow.id)) throw executionError('EXTERNAL_WORKFLOW_CATALOG_MISMATCH')
    const definition = defineExecutionWorkflow(workflow)
    const config = { kind: 'external', registryVersion: '1', adapterId: adapter.id, adapterVersion: adapter.version,
      rulesDigest: adapter.rulesDigest, ...(modelConfig ? { modelConfig } : {}) }
    workflows.push(workflow); records.set(workflow.id, { workflowId: workflow.id, definitionVersion: workflow.version, digest: definition.digest, config })
    byId.set(workflow.id, { workflow, adapter })
  }
  if (external.dataChangeAdapter) add(createDataChangeTaskWorkflow({ ...selected, adapter: external.dataChangeAdapter }), external.dataChangeAdapter, selected)
  for (const kind of releaseWorkflowKinds) if (external.releaseAdapters?.[kind]) {
    const adapter = external.releaseAdapters[kind]
    add(createReleaseTaskWorkflow({ kind, adapter }), adapter)
  }
  if (external.releaseAdapters && Object.keys(external.releaseAdapters).some(kind => !releaseWorkflowKinds.includes(kind))) throw executionError('EXTERNAL_WORKFLOW_KIND_UNKNOWN')
  return { workflows, records, byId }
}

/** Host装配服务。新群只交新控制账；旧历史只读，不写回旧Task或重复调用旧路由。 */
export async function openWorkflowService({ ctx, config, legacy, judge, readMessage, readResource, notifications, engineeringGhCommand, external, execution: suppliedExecution }) {
  if (!Array.isArray(config.groupIds) || !config.groupIds.length || new Set(config.groupIds).size !== config.groupIds.length) throw executionError('WORKFLOW_GROUPS_REQUIRED')
  const groups = new Set(config.groupIds)
  const ownerActorId = requireText(config.ownerActorId, 'WORKFLOW_OWNER_REQUIRED')
  const modelConfig = () => {
    const value = legacy.getAgentConfig()
    return { provider: value.provider, model: value.model, ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) }
  }
  const engineering = createEngineeringRegistry({ repositories: config.repositories ?? [], ownerActorId, modelConfig, author: config.gitAuthor, ghCommand: engineeringGhCommand })
  const selectedExternal = createExternalRegistry(external, modelConfig())
  const externalWorkflows = [...selectedExternal.byId.keys()].map(id => ({ id, purpose: externalLabels[id] }))
  const unavailableWorkflows = Object.entries(externalLabels).filter(([id]) => !selectedExternal.byId.has(id)).map(([, label]) => label)
  const visibleDefinitions = new Map([createAnalysisTaskWorkflow(modelConfig()), ...createReadOnlyTaskWorkflows(modelConfig()), ...selectedExternal.workflows]
    .map(workflow => [workflow.id, workflow]))
  const execution = suppliedExecution ?? await openExecutionRuntime({
    ctx, dbPath: config.dbPath, instanceId: config.instanceId, artifactDirectory: config.artifactDirectory,
    deliveryOptions: { ...engineering.deliveryOptions,
      ...(selectedExternal.workflows.length ? { externalAdapter: external.operationAdapter, authorizeExternal: external.authorizeExternal } : {}) },
    workflows: async store => {
      const selected = modelConfig()
      const workflows = [createAnalysisTaskWorkflow(selected), ...createReadOnlyTaskWorkflows(selected)]
      const definitions = new Map(workflows.map(workflow => [workflow.id, defineExecutionWorkflow(workflow)]))
      const prior = await store.query({ kind: 'workflow.list' })
      const engineeringWorkflows = await engineering.restore(store)
      const historicalWorkflows = prior.filter(record => record.config?.kind !== 'engineering' && record.config?.kind !== 'external').map(record => {
        const previous = [createAnalysisTaskWorkflow(record.config), ...createReadOnlyTaskWorkflows(record.config)].find(item => item.id === record.workflowId)
        if (!previous || previous.version !== record.definitionVersion) throw executionError('WORKFLOW_VERSION_UNAVAILABLE')
        if (defineExecutionWorkflow(previous).digest !== record.digest) throw executionError('WORKFLOW_DEFINITION_DRIFT')
        return previous
      }).filter(item => defineExecutionWorkflow(item).digest !== definitions.get(item.id)?.digest)
      for (const record of prior.filter(item => item.config?.kind === 'external')) {
        const route = selectedExternal.byId.get(record.workflowId), saved = record.config
        if (!route || saved.registryVersion !== '1' || saved.adapterId !== route.adapter.id
          || saved.adapterVersion !== route.adapter.version || saved.rulesDigest !== route.adapter.rulesDigest) throw executionError('EXTERNAL_WORKFLOW_DEFINITION_DRIFT')
        const previous = record.workflowId === 'task-data-change'
          ? createDataChangeTaskWorkflow({ ...saved.modelConfig, adapter: route.adapter })
          : createReleaseTaskWorkflow({ kind: record.workflowId.slice(5), adapter: route.adapter })
        if (previous.version !== record.definitionVersion || defineExecutionWorkflow(previous).digest !== record.digest)
          throw executionError('EXTERNAL_WORKFLOW_DEFINITION_DRIFT')
        if (record.digest !== selectedExternal.records.get(record.workflowId).digest) historicalWorkflows.push(previous)
      }
      for (const workflow of workflows) {
        const definition = definitions.get(workflow.id)
        await store.command({ id: `workflow:${definition.digest}`, kind: 'workflow.register', args: {
          workflowId: workflow.id, definitionVersion: workflow.version, config: selected, digest: definition.digest,
        } })
      }
      for (const record of selectedExternal.records.values()) await store.command({ id: `workflow:${record.digest}`, kind: 'workflow.register', args: record })
      return { workflows: [...workflows, ...engineeringWorkflows, ...selectedExternal.workflows], historicalWorkflows }
    },
  })
  let closed = false, resolveMaterials
  const { store, controller, artifacts } = execution
  if (suppliedExecution && typeof controller.registerWorkflow === 'function') {
    for (const workflow of createReadOnlyTaskWorkflows(modelConfig())) controller.registerWorkflow(workflow)
    for (const workflow of selectedExternal.workflows) controller.registerWorkflow(workflow)
  }
  const notifier = createWorkflowNotifications({ store, controller, artifacts, adapter: notifications,
    groupResponsibility: groupId => legacy.getGroup?.(groupId)?.responsibility ?? '' })
  const legacyGroup = id => legacy.getGroup?.(id)
  const mayCreate = (run, workflowId) => run.actorId === ownerActorId || (workflowId !== undefined && catalogById.get(workflowId)?.mode !== 'external'
    && /任务准入/u.test(legacyGroup(run.conversationId)?.responsibility ?? '') && isDirectedTaskRequest(run.body))
  const messageJudge = judge ?? createMessageModel({ llm: ctx.get?.('llm') ?? ctx.llm, modelConfig })

  async function taskAccess(taskId, actorId, conversationId) {
    const origin = await store.query({ kind: 'message.task', taskId })
    if (!origin || origin.run.conversationId !== conversationId || ![origin.run.actorId, ownerActorId].includes(actorId)) throw executionError('WORKFLOW_TASK_FORBIDDEN')
    return origin
  }
  const approvals = createWorkflowApprovalService({ store, controller, authorizeTask: async ({ taskId, actorId, conversationId, channel }) => {
    const origin = await store.query({ kind: 'message.task', taskId })
    if (!origin || !groups.has(origin.run.conversationId)) return false
    if (channel === 'web') return !!config.webActorId && actorId === config.webActorId
    return conversationId === origin.run.conversationId
  } })
  async function isApprovalRequest(requestId) {
    try { await approvals.get(requestId); return true }
    catch (error) { if (error.code === 'approval_not_found') return false; throw error }
  }
  async function decideApproval(input, identity) {
    if (identity?.channel === 'web' && (!config.webActorId || identity.actorId !== config.webActorId)) throw executionError('WORKFLOW_WEB_ACTOR_FORBIDDEN')
    return approvals.decide(input, identity)
  }
  async function currentTask(taskId, selector) {
    const runs = await store.query({ kind: 'run.list', taskId, limit: 200 })
    const selected = selector && selector !== 'current' ? runs.find(run => run.runId === selector) : runs[0]
    if (!selected) throw executionError('WORKFLOW_TASK_NOT_FOUND')
    return controller.state(selected.runId)
  }
  async function executeWebEvent(event) {
    if(event.status==='pending') {
      try {
        const commandId=`web-task:${event.id}`
        if(event.request.action==='cancel')await controller.stop({commandId,runId:event.executionRunId,reason:event.request.reason})
        else await controller.changeInput({commandId,runId:event.executionRunId,inputId:commandId,sourceKey:commandId,input:event.input,expectedRevision:event.request.inputVersion-1})
        event=(await store.command({id:`web-finish:${event.id}`,kind:'message.web-task.finish',args:{eventId:event.id,result:{status:'accepted',taskId:event.request.taskId,requestId:event.request.requestId}}})).result.event
      } catch(error) {
        if(!['REVISION_CONFLICT','INPUT_PENDING','RUN_TERMINAL','RUN_STOPPING'].includes(error.code))throw error
        event=(await store.command({id:`web-reject:${event.id}`,kind:'message.web-task.finish',args:{eventId:event.id,error:error.code}})).result.event
      }
    }
    if(event.error)throw executionError(event.error)
    return event.result
  }
  async function submitWebTask(request, identity) {
    if(identity?.channel!=='web'||!config.webActorId||identity.actorId!==config.webActorId)throw executionError('WORKFLOW_WEB_ACTOR_FORBIDDEN')
    const origin=await store.query({kind:'message.task',taskId:request.taskId})
    if(!origin)throw executionError('WORKFLOW_TASK_NOT_FOUND')
    await taskAccess(request.taskId,identity.actorId,origin.run.conversationId)
    if(!['cancel','context'].includes(request.action))throw executionError('WORKFLOW_WEB_ACTION_UNSUPPORTED')
    const eventId=executionDigest([request.taskId,requireText(request.requestId,'WORKFLOW_WEB_EVENT_REQUIRED')])
    const prior=await store.query({kind:'message.web-task',eventId})
    if(prior){if(executionDigest(prior.request)!==executionDigest(request)||prior.actorId!==identity.actorId)throw executionError('MESSAGE_WEB_EVENT_CONFLICT');return executeWebEvent(prior)}
    const state=await currentTask(request.taskId)
    const previous=await artifacts.read(state.run.requirementRef)
    const input=request.action==='context'?{...previous,request:`${previous.request}\n\n补充要求：\n${requireText(request.context,'WORKFLOW_CONTEXT_REQUIRED')}`} : null
    const event=(await store.command({id:`web-prepare:${eventId}:${executionDigest(input)}`,kind:'message.web-task.prepare',args:{eventId,request,actorId:identity.actorId,executionRunId:state.run.runId,input}})).result.event
    return executeWebEvent(event)
  }
  async function createTask(action, info) {
    if (!mayCreate(info.run, action.arguments.workflowId) && action.intent !== 'answer') throw executionError('WORKFLOW_ACTION_FORBIDDEN')
    if (info.run.context.editOf) {
      const original = await messages.state(info.run.context.editOf.sourceRunId)
      const previous = original.commands.filter(item => item.args?.taskId && ['create', 'research', 'answer', 'reopen'].includes(item.kind))
      const confirmedNew = (await messages.state(info.run.runId)).requests.some(request => request.unitId === info.unit.unitId && request.reason === 'SOURCE_EDIT_NEW_MATTER' && request.status === 'resolved' && request.answer === '新增独立任务')
      if (previous.length && !confirmedNew) throw executionError('WORKFLOW_EDIT_REQUIRES_EXISTING_TASK')
    }
    if (action.sourceInputRunId) {
      const latest = (await messages.state(action.sourceInputRunId)).run
      if (latest.sourceKey !== info.run.sourceKey || latest.actorId !== info.run.actorId) throw executionError('WORKFLOW_EDIT_SOURCE_MISMATCH')
      info = { ...info, run: latest }
    }
    if (action.arguments.workflowId === 'task-engineering') {
      const prepared = await engineering.prepareTask(action, { ...info, authorizedGroupRequest: mayCreate(info.run, action.arguments.workflowId) }, controller)
      const result = await controller.createRun({ commandId: `dispatch:${info.commandId}`, ...prepared })
      return { taskId: prepared.taskId, runId: result.runId, status: 'accepted', reply: '工程任务已接纳，按登记的仓库范围实施、验证并提交 PR。' }
    }
    const workflowId = action.arguments.workflowId
    if (selectedExternal.byId.has(workflowId)) {
      const taskId = requireText(action.taskId, 'WORKFLOW_TASK_ID_REQUIRED')
      const references = [...new Set(action.requiredExecutionMaterials ?? [])]
      const materials = references.length ? await resolveMaterials({ run: info.run, needs: references.map(resourceRef => ({ resourceRef })) }) : { ready: true, data: { resources: [] } }
      if (!materials.ready) throw executionError('WORKFLOW_REQUIRED_MATERIAL_NOT_READY')
      const input = await external.prepareRequirement({ workflowId, action, info, materials: materials.data.resources })
      const result = await controller.createRun({ commandId: `dispatch:${info.commandId}`, taskId,
        runId: `run-${executionDigest(info.commandId).slice(0, 40)}`, workflowId, input })
      return { taskId, runId: result.runId, status: 'accepted', reply: `${externalLabels[workflowId]}任务已接纳，按受控流程执行并独立回读。` }
    }
    if (catalogById.get(workflowId)?.mode !== 'read-only') throw executionError('WORKFLOW_TYPE_NOT_ADMITTED')
    const taskId = requireText(action.taskId, 'WORKFLOW_TASK_ID_REQUIRED')
    const references = [...new Set(action.requiredExecutionMaterials ?? [])]
    const material = references.length ? await resolveMaterials({ run: info.run, needs: references.map(resourceRef => ({ resourceRef })) }) : { ready: true, data: { resources: [] } }
    if (!material.ready) throw executionError('WORKFLOW_REQUIRED_MATERIAL_NOT_READY')
    const input = {
      request: requireText(action.arguments.objective, 'WORKFLOW_OBJECTIVE_REQUIRED'),
      constraints: [...new Set(action.constraints ?? [...(info.unit.constraints ?? []), ...(info.unit.sharedConstraints ?? [])])],
      materials: [{ id: info.run.sourceKey, text: info.run.body }, ...material.data.resources.filter(item => item.resourceRef !== info.run.sourceKey).map(item => ({ id: item.resourceRef, text: item.text }))],
    }
    const result = await controller.createRun({ commandId: `dispatch:${info.commandId}`, taskId,
      runId: `run-${executionDigest(info.commandId).slice(0, 40)}`, workflowId, input })
    return { taskId, runId: result.runId, status: 'accepted', reply: '任务已接纳，执行进度由工作流记录。' }
  }
  async function taskAction(action, info) {
    if (info.binding.disposition === 'conversation' && ['status', 'result'].includes(action.intent)) {
      const origins = await store.query({ kind: 'message.task-candidates', conversationId: info.run.conversationId, limit: 200 })
      const allRuns = await store.query({ kind: 'run.list', limit: 200 })
      return queryConversationTaskProgress({ queryText: info.unit.goalText, conversationId: info.run.conversationId,
        actorId: info.run.actorId, ownerActorId, occurredAt: info.run.context?.occurredAt ?? info.run.createdAt,
        workflowOrigins: origins, workflowRuns: allRuns, legacyTasks: legacy.listTasks?.() ?? [] })
    }
    const taskId = info.binding.taskId ?? action.taskId
    const origin = await taskAccess(taskId, info.run.actorId, info.run.conversationId)
    const existingRuns = await store.query({ kind: 'run.list', taskId, limit: 200 })
    if (!existingRuns.length) {
      if (['status', 'result'].includes(action.intent)) return singleTaskProgressResult({ taskId, status: origin.command.status, beforeStart: true, reply: `任务尚未开始执行；当前状态：${origin.command.status}` })
      if (!['cancel', 'pause', 'resume', 'revise'].includes(action.intent)) throw executionError('WORKFLOW_ACTION_NOT_ADMITTED')
      const receipt = await store.command({ id: `prestart:${info.commandId}`, kind: 'message.task.control', args: {
        taskId, action: action.intent, actorId: info.run.actorId, sourceRunId: info.run.runId,
        ...(action.intent === 'revise' ? { arguments: { ...origin.command.args.arguments, ...action.arguments }, constraints: [...new Set([...(origin.command.args.constraints ?? []), ...(action.constraints ?? [])])] } : {}),
      } })
      return { taskId, status: receipt.result.command.status, beforeStart: true, reply: `任务执行前已记录${action.intent}，未启动旧请求。` }
    }
    const state = await currentTask(taskId, action.arguments.runId ?? info.binding.runId)
    const args = { commandId: `dispatch:${info.commandId}`, runId: state.run.runId }
    if (action.intent === 'status' || action.intent === 'result') {
      const last = state.nodes.filter(node => node.outputRef).at(-1)
      const output = last ? await artifacts.read(last.outputRef) : null
      return singleTaskProgressResult({ taskId, runId: state.run.runId, status: state.run.status, observedAt: new Date().toISOString(), output,
        reply: action.intent === 'result' && workflowResultText(output) ? workflowResultText(output) : `任务状态：${state.run.status}${state.run.recoveryReason ? `；等待原因：${state.run.recoveryReason}` : ''}` })
    }
    if (action.intent === 'cancel') await controller.stop({ ...args, reason: info.unit.goalText })
    else if (action.intent === 'pause') await controller.pause({ ...args, reason: info.unit.goalText })
    else if (action.intent === 'resume') await controller.resume(args)
    else if (action.intent === 'revise') {
      const previous = await artifacts.read(state.run.requirementRef)
      await controller.changeInput({ ...args, inputId: info.commandId, sourceKey: info.run.sourceKey,
        input: { ...previous, request: requireText(action.arguments.objective, 'WORKFLOW_OBJECTIVE_REQUIRED'),
          constraints: [...new Set([...(previous.constraints ?? []), ...(action.constraints ?? [...(info.unit.constraints ?? []), ...(info.unit.sharedConstraints ?? [])])])] } })
    } else throw executionError('WORKFLOW_ACTION_NOT_ADMITTED')
    const observed = await controller.state(state.run.runId)
    return { taskId, runId: state.run.runId, status: observed.run.status, reply: `已记录${action.intent}请求；当前状态：${observed.run.status}` }
  }
  const handlers = Object.fromEntries(['cancel', 'pause', 'resume', 'revise', 'status', 'result'].map(kind => [kind, taskAction]))
  for (const intent of ['status', 'result']) handlers[intent] = async (action, info) => {
    if (info.binding.engine !== 'legacy') return taskAction(action, info)
    const task = legacy.getTask?.(info.binding.taskId)
    if (!task || task.groupId !== info.run.conversationId) throw executionError('WORKFLOW_TASK_FORBIDDEN')
    return singleTaskProgressResult({ taskId: task.taskId, engine: 'legacy', status: task.state, outcome: task.outcome, observedAt: new Date().toISOString(),
      reply: info.run.actorId === ownerActorId && intent === 'result' ? (typeof task.result === 'string' ? task.result : task.result?.summary ?? task.completion ?? '旧任务没有保存可读取的结果正文。') : `旧任务状态：${task.state}${task.outcome ? `；结果：${task.outcome}` : ''}${task.result?.delivery?.uat2Status ? `；UAT2：${task.result.delivery.uat2Status}` : '；UAT2：未见部署回执'}` })
  }
  handlers.create = createTask
  handlers.research = createTask
  handlers.answer = (action, info) => createTask({ ...action, arguments: { ...action.arguments, workflowId: 'task-analysis', objective: action.arguments.objective ?? info.unit.goalText } }, info)
  handlers.fact = async (action, info) => ({ status: 'recorded', sourceKey: info.run.sourceKey, topic: await store.query({ kind: 'message.topic', topicId: action.binding.topicId }) })
  handlers.no_action = async () => ({ status: 'ignored' })
  handlers.clarification = async (action, info) => resumeRequest({
    runId: action.arguments.runId, requestId: action.arguments.requestId,
    eventId: info.run.sourceKey, answer: action.arguments.answer,
  }, { channel: 'im', actorId: info.run.actorId, conversationId: info.run.conversationId })
  handlers.approval = async (action, info) => {
    const requestId = requireText(action.arguments.requestId, 'WORKFLOW_APPROVAL_REQUEST_REQUIRED')
    if (!info.run.body.includes(requestId) && !info.run.context.quoteRefs?.some(ref => ref.text?.includes(requestId))) throw executionError('WORKFLOW_APPROVAL_SOURCE_REQUIRED')
    return decideApproval({ requestId, decision: action.arguments.decision, eventId: info.run.sourceKey },
      { channel: 'im', actorId: info.run.actorId, conversationId: info.run.conversationId })
  }
  const messages = createMessageWorkflow({ store, judge: messageJudge, policy: config.policy, handlers,
    context: {
      async validateAction(action, info) {
        const reject = reason => ({ allowed: false, reason })
        if (info.binding.engine === 'legacy') {
          const task = legacy.getTask?.(info.binding.taskId)
          if (!task || task.groupId !== info.run.conversationId) return reject('无权读取该旧任务')
          return ['status', 'result', 'no_action'].includes(action.intent) ? { allowed: true } : reject('旧任务只读，请明确发起新工作流任务')
        }
        if (!handlers[action.intent] && action.intent !== 'no_action') return reject(`尚未提供 ${action.intent} 处理流程`)
        if (['create', 'research', 'reopen'].includes(action.intent) && !mayCreate(info.run, action.arguments.workflowId)) return reject('当前消息发送人没有创建业务任务的权限')
        if (['create', 'research', 'answer', 'reopen'].includes(action.intent)) {
          const workflowId = action.intent === 'answer' ? 'task-analysis' : action.arguments.workflowId
          if (!catalogById.has(workflowId) || catalogById.get(workflowId).mode === 'external' && !selectedExternal.byId.has(workflowId)) return reject('请求的任务流程未准入')
          if (workflowId === 'task-engineering' && !engineering.availableWorkflows().some(item => item.repositoryId === action.arguments.repositoryId)) return reject('请求的工程仓库未准入')
        }
        if (['pause', 'cancel', 'resume', 'revise', 'status', 'result'].includes(action.intent) && info.binding.disposition !== 'conversation') {
          const taskId = info.binding.taskId ?? action.taskId
          if (!taskId) return reject('请求未关联到唯一任务')
          const origin = await store.query({ kind: 'message.task', taskId })
          if (!origin || origin.run.conversationId !== info.run.conversationId || ![origin.run.actorId, ownerActorId].includes(info.run.actorId)) return reject('当前发送人无权访问该群中的目标任务')
          if (action.arguments.runId && action.arguments.runId !== 'current') {
            const runs = await store.query({ kind: 'run.list', taskId, limit: 200 })
            if (!runs.some(run => run.runId === action.arguments.runId)) return reject('指定执行版本不属于目标任务')
          }
        }
        return { allowed: true }
      },
      async splitBackground({ history }) {
        const messages = [], omissions = []; let bytes = 0
        for (const item of [...history].reverse()) {
          const size = Buffer.byteLength(JSON.stringify(item))
          if (bytes + size <= 1800) { messages.unshift(item); bytes += size }
          else omissions.push({ sourceKey: item.sourceKey, reason: 'background_budget', contentLength: item.text?.length ?? 0 })
        }
        return { messages, omissions }
      },
      async history(run) {
        const recent = await store.query({ kind: 'message.list', conversationId: run.conversationId, limit: 200 })
        const outboundIds = new Set(await store.query({ kind: 'message.outboundIds', conversationId: run.conversationId }))
        const cutoff = run.context?.occurredAt ?? run.createdAt
        const current = []
        for (const item of recent) {
          if (item.runId === run.runId || (item.context?.occurredAt ?? item.createdAt) >= cutoff || item.reason === 'message_reprocessed') continue
          if (outboundIds.has(item.context?.sourceMessageId)) continue
          current.push(item)
          if (current.length === 30) break
        }
        current.reverse()
        const old = (legacyGroup(run.conversationId)?.messages ?? []).filter(item => (!item.isBackfill || item.routingStatus === 'routed') && (!item.occurredAt || item.occurredAt < cutoff) && typeof item.text === 'string' && item.text.trim()).slice(-30)
          .map(item => ({ sourceKey: sourceKey(config.profile ?? '', run.conversationId, item.messageId), sourceVersion: item.messageVersion ?? 1, text: item.text, ...(item.senderOpenDingTalkId ? { actorId: item.senderOpenDingTalkId } : {}) }))
        return [...old, ...current.map(item => ({ sourceKey: item.sourceKey, sourceVersion: item.sourceVersion, text: item.body, actorId: item.actorId }))].slice(-30)
      },
      async localQuote(ref, run) {
        const key = typeof ref === 'string' ? ref : ref.sourceKey
        const found = await store.query({ kind: 'message.source', sourceKey: key })
        if (found && found.conversationId === run.conversationId) return { sourceKey: key, sourceVersion: found.sourceVersion, text: found.body }
        if (typeof ref === 'object' && ref.text) return ref
        return null
      },
      async candidates({ run, unit, explicitSourceKeys = [] }) {
        const values = await store.query({ kind: 'run.list', limit: 200 })
        const result = []
        const origins = await store.query({ kind: 'message.task-candidates', conversationId: run.conversationId, limit: 200 })
        const quoted = new Set([...(run.context.quoteRefs ?? []).map(ref => ref.sourceKey), ...(run.context.editOf ? [run.sourceKey] : []), ...explicitSourceKeys])
        for (const origin of origins) {
          if (origin.run.runId === run.runId || (['superseded', 'failed'].includes(origin.command.status) && !(run.context.editOf && origin.run.sourceKey === run.sourceKey))) continue
          const item = values.find(value => value.taskId === origin.command.args.taskId)
          const explicit = quoted.has(origin.run.sourceKey)
          result.push({ candidateId: item?.runId ?? origin.command.commandId, taskId: origin.command.args.taskId, ...(origin.command.args.binding?.topicId ? { topicId: origin.command.args.binding.topicId } : {}), ...(item ? { runId: item.runId } : {}),
            title: origin.command.args.arguments.objective, goal: origin.command.args.arguments.objective, state: item?.status ?? 'accepted',
            historyRef: `workflow-task-history:${origin.command.args.taskId}`,
            relevantTime: item?.updatedAt ?? origin.run.createdAt, versions: { requirement: item?.revision ?? 0 },
            sourceRefs: [origin.run.sourceKey], explicitReferenceMatches: explicit ? [origin.run.sourceKey] : [],
            distinguishingFacts: [...(item ? [] : ['任务命令已接纳，执行实例尚未创建']), ...(run.context.editOf && origin.run.sourceKey === run.sourceKey ? ['被本条编辑直接修订的原任务；不得再次创建相同Task'] : [])] })
        }
        const topics = await store.query({ kind: 'message.topics', conversationId: run.conversationId, limit: 200 })
        for (const topic of topics) {
          if (topic.facts.every(fact=>fact.sourceRunId===run.runId)) continue
          if (result.some(card => card.topicId === topic.topicId)) continue
          result.push({ candidateId: topic.topicId, topicId: topic.topicId, title: topic.title, goal: topic.title, state: 'topic', relevantTime: topic.updatedAt,
            versions: { topic: topic.revision }, sourceRefs: topic.facts.flatMap(fact => fact.sourceRefs.map(ref => ref.sourceKey)),
            explicitReferenceMatches: topic.facts.flatMap(fact => fact.sourceRefs.map(ref => ref.sourceKey)).filter(key => quoted.has(key)), distinguishingFacts: ['话题事实，尚未关联执行Task'] })
        }
        const legacyTasks = legacy.listTasks?.() ?? []
        const group = legacyGroup(run.conversationId)
        const legacyTopics = legacy.listTopics?.(run.conversationId) ?? []
        const cutoff = run.context?.occurredAt ?? run.createdAt
        for (const task of legacyTasks) {
          if (task.groupId !== run.conversationId) continue
          if (task.createdAt && task.createdAt >= cutoff) continue
          const sourceIds = [...(task.sourceMessageIds ?? []), ...(group?.outbox ?? []).filter(item => item.taskIds?.includes(task.taskId)).flatMap(item => [item.deliveredMessageId, item.replyToMessageId, ...(item.matterSourceMessageIds ?? [])]),
            ...legacyTopics.filter(topic => task.topicRefs?.some(ref => ref.topicId === topic.topicId)).flatMap(topic => topic.entries?.map(entry => entry.messageId) ?? [])].filter(Boolean)
          const references = [...new Set(sourceIds)].map(id => sourceKey(config.profile ?? '', run.conversationId, id))
          result.push({ candidateId: `legacy:${task.taskId}`, engine: 'legacy', taskId: task.taskId, title: task.title, goal: task.objective ?? task.title, state: task.state,
            historyRef: `task-history:${task.taskId}`,
            relevantTime: task.updatedAt ?? task.completedAt ?? task.createdAt ?? null, versions: { inputVersion: task.inputVersion ?? 1, runSequence: task.runSequence ?? 1 }, sourceRefs: references,
            explicitReferenceMatches: references.filter(key => quoted.has(key)), distinguishingFacts: [`旧引擎任务状态：${task.state}；结果：${task.outcome ?? '未记录'}；UAT2：${task.result?.delivery?.uat2Status ?? '未见部署回执'}；仅支持只读查询`] })
        }
        const words = [...new Set((unit.goalText ?? '').toLowerCase().match(/[a-z0-9_-]+|[\u4e00-\u9fff]{2}/g) ?? [])]
        const score = card => card.explicitReferenceMatches.length * 10000 + words.filter(word => card.goal?.toLowerCase().includes(word)).length
        result.sort((a, b) => score(b) - score(a) || String(b.relevantTime).localeCompare(String(a.relevantTime)))
        const cards = result.slice(0, 8).map((card, index) => {
          if (index > 1 || card.engine !== 'legacy') return card
          const task = legacy.getTask?.(card.taskId)
          const lastChange = task?.objectiveHistory?.at(-1)?.objective
          return { ...card, distinguishingFacts: [...card.distinguishingFacts,
            `最近目标：${String(lastChange ?? task?.objective ?? task?.title ?? '').slice(0, 160)}`,
            `结果：${String(task?.outcome ?? task?.result ?? '未记录').slice(0, 120)}`] }
        })
        const bounded = []
        for (const card of cards) {
          const hasLongDetail = Buffer.byteLength(card.goal ?? '') > 520 || card.distinguishingFacts.some(fact => Buffer.byteLength(fact) > 420)
          const text = hasLongDetail ? JSON.stringify(card) : ''
          if (!hasLongDetail || Buffer.byteLength(text) > 65536) { bounded.push(card); continue }
          const detailRef = `candidate-detail:${executionDigest(card)}`
          await store.command({ id: `material:${run.runId}:${executionDigest([detailRef, text])}`, kind: 'message.material.record', args: { runId: run.runId, resourceRef: detailRef, material: { text } } })
          bounded.push({ ...card, detailRef })
        }
        return { cards: bounded, total: result.length, explicitOverflow: result.slice(8).some(card => card.explicitReferenceMatches.length > 0) }
      },
      async facts({ run, binding }) {
        if (binding.engine === 'legacy') {
          const task = legacy.getTask?.(binding.taskId)
          if (!task || task.groupId !== run.conversationId) throw executionError('WORKFLOW_TASK_FORBIDDEN')
          return { legacyTask: { taskId: task.taskId, title: task.title, objective: task.objective ?? task.title, state: task.state, outcome: task.outcome ?? 'legacy-unknown', updatedAt: task.updatedAt ?? task.createdAt ?? null, uat2Status: task.result?.delivery?.uat2Status ?? null }, readOnly: true }
        }
        const storedTopic = binding.topicId ? await store.query({ kind: 'message.topic', topicId: binding.topicId }) : null
        if (binding.topicId && (!storedTopic || storedTopic.conversationId !== run.conversationId)) throw executionError('WORKFLOW_TOPIC_FORBIDDEN')
        const topic = storedTopic ? { ...storedTopic, facts: storedTopic.facts.map(fact => ({ ...fact, sourceRefs: fact.sourceRefs.map(({ text: _text, ...ref }) => ref) })), sources: [...new Map(storedTopic.facts.flatMap(fact => fact.sourceRefs).map(ref => [`${ref.sourceKey}:${ref.sourceVersion}`, ref])).values()] } : null
        if (topic && !binding.taskId) {
          return { topic, availableWorkflows: [...readOnlyCatalog, ...engineering.availableWorkflows(), ...externalWorkflows], unavailableWorkflows, actorMayCreate: mayCreate(run, 'task-engineering') }
        }
        if (!binding.taskId) return { availableWorkflows: [...readOnlyCatalog, ...engineering.availableWorkflows(), ...externalWorkflows], unavailableWorkflows, actorMayCreate: mayCreate(run, 'task-engineering') }
        await taskAccess(binding.taskId, run.actorId, run.conversationId)
        const runs = await store.query({ kind: 'run.list', taskId: binding.taskId, limit: 200 })
        if (!runs.length) {
          const origin = await store.query({ kind: 'message.task', taskId: binding.taskId })
          return { ...(topic ? { topic } : {}), task: { taskId: binding.taskId, status: origin.command.status, beforeStart: true, objective: origin.command.args.arguments.objective } }
        }
        const state = await currentTask(binding.taskId, binding.runId)
        const { runId, taskId, status, inputGeneration, waitReason, pauseRequested } = state.run
        return { ...(topic ? { topic } : {}), task: { runId, taskId, status, inputGeneration: inputGeneration ?? 0, waitReason: waitReason ?? null, pauseRequested: pauseRequested ?? false }, nodes: state.nodes.map(({ nodeId, status }) => ({ nodeId, status })) }
      },
      async validateActions({ run, unit, binding, intent, requests }) {
        if (!run.context.editOf) return { kind: 'accepted' }
        const original = await messages.state(run.context.editOf.sourceRunId)
        const previous = original.commands.filter(item => item.args?.taskId && ['create', 'research', 'answer', 'reopen'].includes(item.kind))
        if (!previous.length) return { kind: 'accepted' }
        const confirmedNew = requests.some(request => request.unitId === unit.unitId && request.reason === 'SOURCE_EDIT_NEW_MATTER' && request.status === 'resolved' && request.answer === '新增独立任务')
        if (intent.actions.some(action => ['create', 'research', 'answer', 'reopen'].includes(action.intent)) && !confirmedNew) return { kind: 'needs_clarification', reason: 'SOURCE_EDIT_NEW_MATTER', question: '原消息已有任务。本次是修改原任务，还是新增独立事项？若确需新增，请回复“新增独立任务”；否则说明要修改或取消哪个原任务。', needs: [] }
        if (confirmedNew && intent.actions.some(action => ['create', 'research', 'answer', 'reopen'].includes(action.intent)) && binding.taskId) return { kind: 'needs_clarification', reason: 'SOURCE_EDIT_NEW_MATTER_BINDING', question: '新增事项仍关联原任务，请明确新事项的独立目标。', needs: [] }
        if (intent.actions.some(action => ['revise', 'cancel', 'pause', 'resume'].includes(action.intent)) && !previous.some(item => item.args.taskId === binding.taskId)) return { kind: 'needs_clarification', reason: 'SOURCE_EDIT_TARGET_UNRESOLVED', question: '请指定本次编辑要修订、暂停或取消的原任务。', needs: [] }
        if (intent.actions.every(action => action.intent === 'no_action')) return { kind: 'needs_clarification', reason: 'SOURCE_EDIT_CONTROL_UNRESOLVED', question: '原消息已有任务。此次编辑是取消原任务，还是仅修改说明并继续原任务？', needs: [] }
        return { kind: 'accepted' }
      },
      async topicFor({ run, unit, binding, intent, facts }) {
        if (intent.actions.every(action => ['approval', 'clarification'].includes(action.intent))) return null
        if (facts.topic && ![facts.topic.actorId, ownerActorId].includes(run.actorId)) throw executionError('WORKFLOW_TOPIC_FORBIDDEN')
        const sourceTopics=!binding.topicId ? (await store.query({kind:'message.topics',conversationId:run.conversationId,limit:200})).filter(topic=>topic.facts.some(fact=>fact.sourceRefs.some(ref=>ref.sourceKey===run.sourceKey))) : []
        const sourceTopic=sourceTopics.length===1?sourceTopics[0]:null
        const sourceRefs = [{ sourceKey: run.sourceKey, sourceVersion: run.sourceVersion, text: run.body }]
        const constraints = [...new Set([...(unit.constraints ?? []), ...(unit.sharedConstraints ?? []), ...intent.constraints])]
        for (const action of intent.actions) if (action.intent === 'fact' && action.arguments.kind === 'constraint' && typeof action.arguments.text === 'string') constraints.push(action.arguments.text)
        const topicId=unit.topicId ?? binding.topicId ?? sourceTopic?.topicId ?? `topic-${executionDigest([run.runId, unit.unitId]).slice(0, 32)}`
        return { topicId, conversationId: run.conversationId, sourceRunId: run.runId, unitId: unit.unitId,
          title: facts.topic?.title ?? sourceTopic?.title ?? unit.goalText, ...(facts.topic && facts.topic.topicId === topicId ? { expectedRevision: facts.topic.revision } : sourceTopic?.topicId===topicId ? {expectedRevision:sourceTopic.revision} : {}),
          facts: [{ kind: 'fact', text: unit.spans.map(span => run.body.slice(span.start, span.end)).join('\n'), sourceRefs }, ...constraints.map(text => ({ kind: 'constraint', text, sourceRefs }))] }
      },
      material: resolveMaterials = async function ({ run, needs }) {
        const items = []
        const remember = async (resourceRef, text) => {
          const material = { text }
          await store.command({ id: `material:${run.runId}:${executionDigest([resourceRef, material])}`, kind: 'message.material.record', args: { runId: run.runId, resourceRef, material } })
          items.push({ resourceRef, ...(await store.query({ kind: 'message.material', runId: run.runId, resourceRef })) })
        }
        for (const need of needs) {
          const cached = await store.query({ kind: 'message.material', runId: run.runId, resourceRef: need.resourceRef })
          if (cached) { items.push({ resourceRef: need.resourceRef, ...cached }); continue }
          if (need.resourceRef.startsWith('task-history:')) {
            const taskId = need.resourceRef.slice('task-history:'.length)
            const task = legacy.getTask?.(taskId)
            if (task?.groupId !== run.conversationId) return { ready: false }
            const history = (task.objectiveHistory ?? []).slice(-3).map(item => ({ at: item.revisedAt, objective: String(item.objective ?? '').slice(0, 280) }))
            await remember(need.resourceRef, JSON.stringify({ taskId, title: task.title, currentObjective: String(task.objective ?? '').slice(0, 500), state: task.state, outcome: task.outcome, uat2Status: task.result?.delivery?.uat2Status ?? null, ...(run.actorId === ownerActorId ? { result: String(task.result ?? '').slice(0, 500) } : {}), history }))
            continue
          }
          if (need.resourceRef.startsWith('workflow-task-history:')) {
            const taskId = need.resourceRef.slice('workflow-task-history:'.length)
            const origin = await taskAccess(taskId, run.actorId, run.conversationId)
            const runs = await store.query({ kind: 'run.list', taskId, limit: 200 })
            const current = runs[0] ? await currentTask(taskId) : null
            await remember(need.resourceRef, JSON.stringify({ taskId, objective: origin.command.args.arguments.objective,
              sourceKey: origin.run.sourceKey, sourceVersion: origin.run.sourceVersion,
              constraints: origin.command.args.constraints ?? [],
              status: current?.run.status ?? origin.command.status,
              revisions: runs.slice(0, 5).map(item => ({ runId: item.runId, status: item.status, revision: item.revision })),
              nodes: current?.nodes.map(node => ({ nodeId: node.nodeId, status: node.status, waitReason: node.waitReason })) ?? [] }))
            continue
          }
          const quote = run.context.quoteRefs.find(item => item.sourceKey === need.resourceRef)
          if (quote?.text) { await remember(need.resourceRef, quote.text); continue }
          const local = await store.query({ kind: 'message.source', sourceKey: need.resourceRef })
          if (local && local.conversationId === run.conversationId) { await remember(need.resourceRef, local.body); continue }
          const historical = (legacyGroup(run.conversationId)?.messages ?? []).find(item => sourceKey(config.profile ?? '', run.conversationId, item.messageId) === need.resourceRef)
          if (historical?.text) { await remember(need.resourceRef, historical.text); continue }
          if (quote?.messageId && readMessage) {
            const value = await readMessage(run.conversationId, quote.messageId)
            if (value?.text) { await remember(need.resourceRef, value.text); continue }
          }
          const resource = run.context.attachments.find(item => item.resourceRef === need.resourceRef)
          if (resource && readResource) {
            const value = await readResource(run.conversationId, run.context.sourceMessageId, resource.source)
            if (value?.text) { await remember(need.resourceRef, value.text); continue }
          }
          return { ready: false }
        }
        return { ready: items.length > 0, data: { resources: items } }
      },
      async onBarrierResolved(barrier) {
        const source = barrier.targetSourceKey ? await store.query({ kind: 'message.source', sourceKey: barrier.targetSourceKey }) : null
        if (source) void messages.process(source.runId).catch(() => {})
        if (source?.context?.editOf?.sourceRunId) void messages.process(source.context.editOf.sourceRunId).catch(() => {})
        if (barrier.targetTaskId) {
          const state = await currentTask(barrier.targetTaskId)
          if (!terminal(state.run.status) && !state.run.pauseRequested) await controller.recover({ commandId: `unfence:${barrier.id}`, runId: state.run.runId })
        }
      },
    },
  })

  async function resumeRequest(input, identity) {
    if (!['web', 'im'].includes(identity?.channel) || !identity.actorId) throw executionError('WORKFLOW_AUTHENTICATED_ACTOR_REQUIRED')
    if (identity.channel === 'web' && (!config.webActorId || identity.actorId !== config.webActorId)) throw executionError('WORKFLOW_ACTION_FORBIDDEN')
    const data = await messages.state(requireText(input.runId, 'WORKFLOW_RUN_REQUIRED'))
    if (!groups.has(data.run.conversationId)) throw executionError('WORKFLOW_GROUP_NOT_ADMITTED')
    if (identity.channel === 'im' && identity.conversationId !== data.run.conversationId) throw executionError('WORKFLOW_ACTION_FORBIDDEN')
    const request = data.requests.find(item => item.id === input.requestId)
    if (!request || request.kind !== 'needs_clarification') throw executionError('WORKFLOW_CLARIFICATION_NOT_FOUND')
    if (!request.permittedActors?.includes(identity.actorId)) throw executionError('WORKFLOW_ACTION_FORBIDDEN')
    const answer = requireText(input.answer, 'WORKFLOW_ANSWER_REQUIRED')
    const result = await messages.resume({ runId: data.run.runId, requestId: request.id,
      eventId: requireText(input.eventId, 'WORKFLOW_EVENT_REQUIRED'), actorId: identity.actorId, answer })
    return { accepted: true, runId: data.run.runId, requestId: request.id, status: result.request.status, answer: result.request.answer }
  }
  async function reprocessMessage(runId, identity) {
    if(identity?.channel!=='web'||!config.webActorId||identity.actorId!==config.webActorId) throw executionError('WORKFLOW_ACTION_FORBIDDEN')
    const prior=await messages.state(requireText(runId,'WORKFLOW_RUN_REQUIRED'))
    if(!groups.has(prior.run.conversationId)) throw executionError('WORKFLOW_GROUP_NOT_ADMITTED')
    const result=await messages.reprocess(runId)
    return {previousRunId:runId,runId:result.run.runId,status:result.run.status,
      units:result.units.map(unit=>({unitId:unit.id,status:unit.status})),
      requests:result.requests.filter(request=>request.status==='pending').map(request=>({requestId:request.id,kind:request.kind,question:request.question}))}
  }
  async function quotedClarification(message) {
    const messageId = message.quotedMessage?.messageId
    if (!messageId) return null
    const item = await store.query({ kind: 'message.requestByReply', conversationId: message.groupId, messageId })
    if (!item) return null
    return resumeRequest({ runId: item.run.runId, requestId: item.request.id, eventId: sourceKey(config.profile ?? '', message.groupId, message.messageId), answer: message.text }, { channel: 'im', actorId: message.senderOpenDingTalkId, conversationId: message.groupId })
  }
  async function ingest(message) {
    if (closed) throw executionError('WORKFLOW_SERVICE_CLOSED')
    if (!groups.has(message.groupId)) throw executionError('WORKFLOW_GROUP_NOT_ADMITTED')
    const actorId = requireText(message.senderOpenDingTalkId, 'WORKFLOW_AUTHENTICATED_ACTOR_REQUIRED')
    // 只用独立回读的消息 ID 排除自身回声；不能等待通知 flush，否则慢回读会挡住新消息。
    if (actorId === ownerActorId) {
      if (await store.query({ kind: 'message.outboundByMessage', conversationId: message.groupId, messageId: message.messageId }))
        return { accepted: true, duplicate: true, processing: 'outbound-echo' }
    }
    const clarification = await quotedClarification(message)
    if (clarification) return clarification
    // 切换前已可靠处理的消息属于旧引擎；渠道重叠补拉不能重新获得执行权。
    const historical = legacyGroup(message.groupId)?.messages?.find(item => item.messageId === message.messageId)
    if (historical) return { accepted: true, duplicate: true, processing: 'legacy-receipt' }
    const key = sourceKey(config.profile ?? '', message.groupId, message.messageId)
    const existing = await store.query({ kind: 'message.source', sourceKey: key })
    const sourceVersion = message.messageVersion ?? 1
    if (existing && sourceVersion < existing.sourceVersion)
      return { accepted: true, duplicate: true, runId: existing.aliasOf ?? existing.runId, processing: existing.status }
    if (existing && existing.sourceVersion === sourceVersion) {
      if (existing.body !== message.text || existing.actorId !== actorId) throw executionError('WORKFLOW_EDIT_VERSION_REQUIRED')
      return { accepted: true, duplicate: true, runId: existing.aliasOf ?? existing.runId, processing: existing.status }
    }
    if (existing && sourceVersion > existing.sourceVersion && existing.body === message.text && existing.actorId === actorId) {
      const receipt = await store.command({ id: `source-alias:${executionDigest([key, sourceVersion])}`, kind: 'message.source.alias', args: {
        runId: `alias-${executionDigest([key, sourceVersion])}`, sourceKey: key, sourceVersion, conversationId: message.groupId, actorId, body: message.text,
      } })
      return { accepted: true, duplicate: true, runId: receipt.result.run.runId, processing: receipt.result.run.status }
    }
    const quote = message.quotedMessage
    const quoteKey = quote?.messageId ? sourceKey(config.profile ?? '', message.groupId, quote.messageId) : null
    const barriers = quoteKey && actorId === ownerActorId ? [{ barrierId: `fence-${executionDigest([key, sourceVersion, quoteKey])}`, targetSourceKey: quoteKey }] : []
    const result = await messages.receive({ sourceKey: key, sourceVersion, conversationId: message.groupId, actorId,
      body: requireText(message.text, 'WORKFLOW_MESSAGE_BODY_REQUIRED'), barriers,
      context: { sourceMessageId: message.messageId,
        ...(message.senderName ? { senderName: message.senderName } : {}),
        ...(message.occurredAt ? { occurredAt: message.occurredAt } : {}),
        ...(existing ? { editOf: { sourceRunId: existing.aliasOf ?? existing.runId, sourceVersion: existing.sourceVersion, sourceKey: key } } : {}),
        quoteRefs: quoteKey ? [{ sourceKey: quoteKey, messageId: quote.messageId, ...(quote.content ? { text: quote.content } : {}) }] : [],
        attachments: (message.resourceRefs ?? []).map(resource => ({ resourceRef: resource.resourceId, state: 'pending', source: resource })),
        compactPolicy: `${legacyGroup(message.groupId)?.responsibility ?? ''}\n只有已认证任务所有者可以要求执行。具体可用流程由意图节点的availableWorkflows确定，不把分析流程当成工程或数据库执行。`,
      } })
    return { accepted: true, duplicate: false, runId: result.runId, processing: 'pending' }
  }
  async function tasks() {
    const runs = await store.query({ kind: 'run.list', limit: 200 })
    return Promise.all(runs.map(async run => {
      const origin = await store.query({ kind: 'message.task', taskId: run.taskId })
      const state = await controller.state(run.runId)
      const requirement = await artifacts.read(run.requirementRef)
      const final = state.nodes.filter(node => node.outputRef).at(-1)
      const output = final ? await artifacts.read(final.outputRef) : null
      return { taskId: run.taskId, engine: 'workflow-v2', workflowId: run.workflowId, workflowVersion: run.definitionVersion, groupId: origin?.run.conversationId,
        title: requirement.request, objective: requirement.request, inputVersion: run.revision + 1, runSequence: 1,
        state: terminal(run.status) ? 'completed' : state.controllerError ? 'waiting' : run.status === 'running' ? 'running' : run.status === 'queued' ? 'queued' : 'waiting',
        outcome: terminal(run.status) ? run.status : undefined, createdAt: run.createdAt, updatedAt: run.updatedAt,
        result: workflowResultText(output), waitingReason: state.controllerError ?? run.recoveryReason ?? state.nodes.find(node => node.status === 'waiting')?.waitReason?.reference, taskRunId: run.runId,
        stageTasks: state.nodes.map(node => node.nodeId), topicRefs: [], checkpoints: [],
        executionNodes: state.nodes, childSessionId: state.nodes.findLast(node => node.sessionId)?.sessionId,
      }
    }))
  }
  let messageRecoveryFlight, taskRecoveryFlight, taskRecoveryCursor
  async function recoverTasks() {
    const failures = []
    for(const event of await store.query({kind:'message.web-tasks.pending'}))try{await executeWebEvent(event)}catch(error){failures.push({scope:'web-task',eventId:event.id,code:error.code??error.message})}
    const page = await store.query({ kind: 'run.list', limit: 200, activeOnly: true, ...(taskRecoveryCursor ? { beforeSequenceId: taskRecoveryCursor } : {}) })
    taskRecoveryCursor = page.length === 200 ? page.at(-1).sequenceId : undefined
    for (const run of page) {
      if (terminal(run.status) || run.pauseRequested || run.status === 'running') continue
      try {
        if (run.status === 'waiting') {
          const state = await store.query({ kind: 'run', runId: run.runId })
          if (state.nodes?.some(node => node.waitReason?.reference === 'ENGINEERING_VERIFICATION_FAILED')) continue
        }
        await controller.recover({ commandId: `recover:${run.runId}:${run.revision}:${run.claimCount}`, runId: run.runId })
      }
      catch (error) { if (error.code !== 'EXECUTOR_STILL_ACTIVE') failures.push({ scope: 'task', runId: run.runId, code: error.code ?? error.message }) }
    }
    return failures
  }
  async function recoverAll() {
    // 三条恢复通路独立：消息等模型或投递等连接器时，不占住其它通路下一轮恢复。
    const results = await Promise.allSettled([
      messageRecoveryFlight ??= messages.recover().finally(() => { messageRecoveryFlight = undefined }),
      taskRecoveryFlight ??= recoverTasks().finally(() => { taskRecoveryFlight = undefined }),
      notifier.flush(),
    ])
    const failures = results.flatMap((result, index) => result.status === 'rejected'
      ? [{ scope: ['messages', 'tasks', 'notifications'][index], code: result.reason.code ?? result.reason.message }]
      : index === 1 ? result.value : [])
    return { failures }
  }
  function workflowCatalogState() {
    const repositories = engineering.availableWorkflows().map(item => item.repositoryId)
    return taskWorkflowCatalog.map(item => {
      const workflow = visibleDefinitions.get(item.id)
      const available = !!workflow || item.mode === 'engineering' && repositories.length > 0
      return { id: item.id, label: item.label, purpose: item.purpose, mode: item.mode,
        status: available ? 'available' : 'unavailable', version: workflow?.version ?? null,
        nodes: workflow?.nodes.map(node => ({ id: node.id, executor: node.executor, effects: node.allowedEffects })) ?? [],
        ...(item.mode === 'engineering' ? { repositories, reason: available ? '具体节点随任务和仓库配置冻结，在任务详情查看' : '未配置受信工程仓库' }
          : !available ? { reason: '缺少受信平台适配器，当前不能发起' } : {}),
      }
    })
  }
  const messageStages = [{ id: 'receive', label: '接收消息' }, { id: 'context', label: '补全上下文' }, { id: 'S', label: '拆分事项' }, { id: 'R', label: '关联话题' }, { id: 'I', label: '判断意图' }, { id: 'dispatch', label: '派发任务' }]
  async function mailboxes() {
    const messages = [], outbox = []
    for (const groupId of groups) {
      const outboundIds = new Set(await store.query({ kind: 'message.outboundIds', conversationId: groupId }))
      const topicBindings = await store.query({ kind: 'message.topic.bindings', conversationId: groupId })
      const topicRefsBySource = new Map()
      for (const item of topicBindings) topicRefsBySource.set(item.sourceKey, [...(topicRefsBySource.get(item.sourceKey) ?? []), { topicId: item.topic.topicId, revision: item.topic.revision, title: item.topic.title, unitId: item.unitId }])
      const senderNames = new Map((legacyGroup(groupId)?.messages ?? []).filter(item => item.senderOpenDingTalkId && item.senderName).map(item => [item.senderOpenDingTalkId, item.senderName]))
      let beforeSequenceId
      for (;;) {
        const page = await store.query({ kind: 'message.list', conversationId: groupId, limit: 200, ...(beforeSequenceId ? { beforeSequenceId } : {}) })
        for (const run of page) {
          if (outboundIds.has(run.context?.sourceMessageId) || run.reason === 'message_reprocessed') continue
          const topicRefs = topicRefsBySource.get(run.sourceKey) ?? []
          messages.push({ groupId, messageId: run.context?.sourceMessageId, text: run.body, senderOpenDingTalkId: run.actorId,
            senderName: run.context?.senderName ?? senderNames.get(run.actorId), occurredAt: run.context?.occurredAt ?? run.createdAt, sequence: run.sequenceId,
            topicRefs, routingStatus: run.status === 'needs_attention' ? 'failed' : ['settled', 'superseded'].includes(run.status) ? 'routed' : 'pending' })
        }
        if (page.length < 200) break
        beforeSequenceId = page.at(-1).sequenceId
      }
    }
    const states = ['prepared', 'sending', 'acknowledged', 'unknown', 'delivered', 'superseded']
    let afterSequenceId = 0
    for (;;) {
      const page = await store.query({ kind: 'message.notifications', states, afterSequenceId, limit: 200 })
      for (const notice of page) {
        const groupId = notice.payload?.conversationId
        if (!groups.has(groupId)) continue
        outbox.push({ groupId, outboundId: notice.id, text: notice.payload.text, sourceMessageId: notice.payload.sourceMessageId,
          deliveredMessageId: notice.evidence?.messageId, status: notice.status === 'delivered' ? 'sent' : notice.status === 'superseded' ? 'superseded' : 'pending',
          ...(notice.recallStatus ? { recallStatus: notice.recallStatus } : {}),
          createdAt: notice.createdAt, deliveredAt: notice.deliveredAt, deliveryAttemptedAt: notice.startedAt,
          deliveryAttemptCount: notice.leaseEpoch, ...(notice.status === 'unknown' ? { deliveryPendingReason: 'send_unknown' } : {}) })
      }
      if (page.length < 200) break
      afterSequenceId = page.at(-1).sequenceId
    }
    return { messages, outbox }
  }
  async function topics(groupId) {
    const selected=groupId ? [groupId] : [...groups]
    return (await Promise.all(selected.filter(id=>groups.has(id)).map(id=>store.query({kind:'message.topics',conversationId:id,limit:200})))).flat()
  }
  async function topicContext({groupId,topicId,offset=0,limit=50}) {
    if(!groups.has(groupId)) return null
    const topic=await store.query({kind:'message.topic',topicId})
    if(!topic||topic.conversationId!==groupId) return null
    const refs=[...new Set(topic.facts.flatMap(fact=>fact.sourceRefs.map(ref=>ref.sourceKey)))]
    const messages=(await Promise.all(refs.map(key=>store.query({kind:'message.source',sourceKey:key})))).filter(Boolean)
      .map(run=>({messageId:run.context?.sourceMessageId,text:run.body,senderName:run.context?.senderName,occurredAt:run.context?.occurredAt??run.createdAt,sourceKind:'workflow-v2'}))
      .sort((a,b)=>String(a.occurredAt).localeCompare(String(b.occurredAt)))
    return {topic,messages:messages.slice(offset,offset+limit),total:messages.length,offset,limit}
  }
  return {
    ingest, resumeRequest, reprocessMessage, decideApproval, isApprovalRequest, submitWebTask, mailboxes, topics, topicContext, isTask: async taskId => !!await store.query({kind:'message.task',taskId}), messages, execution, tasks, isGroup: id => groups.has(id), flushNotifications: () => notifier.flush(),
    catalog: () => ({ engine: 'workflow-v2', groupIds: [...groups], messageStages, builtInWorkflows: [taskProgressQueryDefinition], workflows: workflowCatalogState() }),
    async state(runId) { return runId ? messages.state(runId) : { engine: 'workflow-v2', groupIds: [...groups], store: store.info,
      messages: await store.query({ kind: 'message.list', limit: 100 }), tasks: await tasks() } },
    recover: recoverAll,
    async close() { closed = true; await messages.close(); if (!suppliedExecution) await execution.close() },
  }
}
