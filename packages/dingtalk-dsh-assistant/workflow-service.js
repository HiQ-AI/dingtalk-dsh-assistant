import { openExecutionRuntime } from './execution.js'
import { createTaskOwnerController } from './task-owner-controller.js'
import { defineExecutionWorkflow } from './execution-controller.js'
import { executionDigest, executionError } from './execution-artifacts.js'
import { createAnalysisTaskWorkflow, createReadOnlyTaskWorkflows, createGeneralTaskWorkflow } from './task-workflow.js'
import { createGeneralFileReadCapability, createGeneralIntakeWorkflow, createGeneralCapabilityStepWorkflow, createHistoricalGeneralCapabilityStepWorkflow, createGeneralMarkdownWriteCapability } from './task-general-workflow.js'
import { createTaskMarkdownFileAdapter } from './task-markdown-file.js'
import { createMessageWorkflow } from './message-workflow.js'
import { isPassiveTaskProgress } from './message-ledger.js'
import { createMessageModel } from './message-model.js'
import { taskWorkflowCatalog } from './message-context.js'
import { createWorkflowNotifications, executeNotificationOperation, workflowResultText } from './workflow-notifications.js'
import { createEngineeringRegistry, readEngineeringDeliveryProof } from './workflow-engineering.js'
import { createDataChangeTaskWorkflow } from './workflow-data-change.js'
import { createReleaseTaskWorkflow, createLegacyReleaseTaskWorkflow, releaseWorkflowKinds } from './task-release-workflows.js'
import { createUatPrMergeTaskWorkflow } from './task-uat-pr-merge.js'
import { createWorkflowApprovalService } from './workflow-approval.js'
import { queryConversationTaskProgress, singleTaskProgressResult, taskProgressQueryDefinition } from './task-progress-query.js'

const sourceKey = (profile, groupId, messageId) => `dws:${executionDigest([profile, groupId, messageId])}`
export const isDirectedTaskRequest = body => typeof body === 'string' && /(?:小小鹏|@孙鹏(?:\(孙鹏\))?).{0,50}(?:需要(?:你|我)?(?:修复|处理|排查)|请(?:你|帮忙)?(?:修复|处理|排查)|帮(?:我|忙)?(?:修复|处理|排查))/su.test(body)
const requireText = (value, code) => { if (typeof value !== 'string' || !value.trim()) throw executionError(code); return value }
const terminal = status => ['succeeded', 'failed', 'cancelled'].includes(status)
const catalogById = new Map(taskWorkflowCatalog.map(item => [item.id, item]))
const readOnlyCatalog = taskWorkflowCatalog.filter(item => item.mode === 'read-only').map(({ id, purpose }) => ({ id, purpose }))
const generalCatalog = taskWorkflowCatalog.filter(item => item.mode === 'general').map(({ id, purpose }) => ({ id, purpose }))
const externalLabels = Object.freeze(Object.fromEntries(taskWorkflowCatalog.filter(item => item.mode === 'external').map(item => [item.id, item.purpose])))

export function createSourceDossierCapability(sourceRead) {
  const capability = {
    id: 'organize-topic-sources', effectClass: 'read', description: '将已授权消息逐字整理为带来源键的 Markdown 摘录，不推断未给出的事实',
    identity: 'organize-topic-sources-v1',
    authorize: ({ input, scope }) => sourceRead.authorize({ input, scope }),
    async execute({ input }) {
      const fresh = await sourceRead.execute({ input })
      const markdown = fresh.sources.map(source => `### ${source.sourceKey}\n\n${source.text.split('\n')
        .map(line => `> ${line}`).join('\n')}`).join('\n\n')
      if (Buffer.byteLength(markdown, 'utf8') > 12000) throw executionError('GENERAL_DOSSIER_CAPACITY')
      return { markdown, sourceKeys: fresh.sources.map(source => source.sourceKey) }
    },
    async verify({ input, scope, output }) {
      if (!await capability.authorize({ input, scope })) return { passed: false }
      const fresh = await capability.execute({ input })
      return { passed: executionDigest(fresh) === executionDigest(output),
        outputDigest: executionDigest(fresh), sourceRefs: fresh.sourceKeys }
    },
  }
  return capability
}

/** 仅沿当前 Task 冻结的消息来源和该消息入站附件引用读取平台文本。 */
export function createTaskMessageResourceCapability({ store, readMessage, readResource }) {
  if (typeof readMessage !== 'function' || typeof readResource !== 'function') return null
  const identify = async (input, scope) => {
    if (!input || !scope || typeof input.sourceKey !== 'string' || !Array.isArray(scope.sourceKeys)
      || !scope.sourceKeys.includes(input.sourceKey) || !['mediaId', 'fileId'].includes(input.type)
      || typeof input.resourceId !== 'string' || !input.resourceId) return null
    const source = await store.query({ kind: 'message.source', sourceKey: input.sourceKey })
    if (!source || source.status === 'superseded' || source.conversationId !== scope.conversationId
      || source.sourceVersion !== scope.sourceVersions?.[input.sourceKey]
      || typeof source.context?.sourceMessageId !== 'string') return null
    const ref = source.context.attachments?.find(item => item.source?.type === input.type
      && item.source.resourceId === input.resourceId)?.source
    return ref ? { source, ref } : null
  }
  const load = async (input, scope) => {
    const bound = await identify(input, scope)
    if (!bound) throw executionError('GENERAL_RESOURCE_SCOPE_DENIED')
    const { source, ref } = bound
    const remote = await readMessage(scope.conversationId, source.context.sourceMessageId)
    if (!remote || remote.messageId !== source.context.sourceMessageId
      || (remote.conversationId ?? remote.groupId) !== scope.conversationId
      || remote.text !== source.body || remote.complete === false || remote.hasMore === true
      || remote.failures?.length || !Array.isArray(remote.resourceRefs)
      || !remote.resourceRefs.some(item => item.type === input.type && item.resourceId === input.resourceId))
      throw executionError('GENERAL_RESOURCE_SOURCE_CHANGED')
    const value = await readResource(scope.conversationId, remote.messageId, ref)
    if (!value || typeof value.text !== 'string' || value.complete === false || value.hasMore === true
      || value.failures?.length || value.mediaUnavailable?.length
      || Buffer.byteLength(value.text, 'utf8') > 12000) throw executionError('GENERAL_RESOURCE_READ_INCOMPLETE')
    if (!await identify(input, scope)) throw executionError('GENERAL_RESOURCE_SOURCE_CHANGED')
    const markdown = `### ${input.sourceKey} / ${remote.messageId} / ${input.type}:${input.resourceId}\n\n${value.text.split('\n').map(line => `> ${line}`).join('\n')}`
    if (Buffer.byteLength(markdown, 'utf8') > 16000) throw executionError('GENERAL_RESOURCE_CAPACITY')
    return { markdown, sourceKey: input.sourceKey, messageId: remote.messageId,
      resource: { type: input.type, resourceId: input.resourceId }, contentDigest: executionDigest(value.text) }
  }
  return { id: 'read-task-message-resource', effectClass: 'read', identity: 'read-task-message-resource-v1',
    description: '只读当前业务任务已冻结消息明确引用的 UTF-8 文本附件，最多 12 KiB；返回带精确来源和内容摘要的 Markdown',
    authorize: async ({ input, scope }) => Boolean(await identify(input, scope)),
    execute: ({ input, scope }) => load(input, scope),
    async verify({ input, scope, output }) {
      const fresh = await load(input, scope)
      return { passed: executionDigest(fresh) === executionDigest(output), outputDigest: executionDigest(fresh),
        sourceRefs: [input.sourceKey, `${input.sourceKey}:${fresh.messageId}:${input.type}:${input.resourceId}:${fresh.contentDigest}`] }
    },
  }
}

export async function verifyDefaultGeneralCompletion({ request, acceptanceCriteria, scope, evidence, report }) {
  const isPureCompilation = text => /^(整理|汇总|摘录)/u.test(text)
    && /消息|材料|原文|内容|记录/u.test(text)
    && !/排查|查明|原因|修复|部署|发布|创建|更新|删除|发送|审批|数据库|代码|文件写入/u.test(text)
  const pureCompilation = isPureCompilation(request) && acceptanceCriteria.every(isPureCompilation)
  const dossier = evidence.find(item => item.capabilityId === 'organize-topic-sources'
    && report.evidenceIds.includes(item.evidenceId) && item.verification.passed === true)
  if (!pureCompilation || !dossier || !scope.sourceKeys.every(key => dossier.output.sourceKeys.includes(key))
    || report.summary !== dossier.output.markdown || report.limitations.length)
    return { status: 'unverified', resultVerified: false, criteria: [] }
  return { status: 'satisfied', resultVerified: true,
    criteria: acceptanceCriteria.map(criterion => ({ criterion, passed: true,
      evidenceIds: [dossier.evidenceId] })) }
}

export function rankMessageCandidates(cards, goalText, recentSourceKey = null) {
  const words = [...new Set((goalText ?? '').toLowerCase().match(/[a-z0-9_-]+|[\u4e00-\u9fff]{2}/g) ?? [])]
  const score = card => card.explicitReferenceMatches.length * 10000
    + (recentSourceKey && card.topicId && card.sourceRefs.includes(recentSourceKey) ? 5000 : 0)
    + words.filter(word => card.goal?.toLowerCase().includes(word)).length
  return cards.sort((a, b) => score(b) - score(a) || String(b.relevantTime).localeCompare(String(a.relevantTime)))
}

function createExternalRegistry(external, selected) {
  const configured = !!external && (!!external.dataChangeAdapter || !!external.uatMergeAdapter || !!external.releaseAdapters && Object.keys(external.releaseAdapters).length > 0)
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
  if (external.uatMergeAdapter) add(createUatPrMergeTaskWorkflow({ adapter: external.uatMergeAdapter }), external.uatMergeAdapter)
  for (const kind of releaseWorkflowKinds) if (external.releaseAdapters?.[kind]) {
    const adapter = external.releaseAdapters[kind]
    add(createReleaseTaskWorkflow({ kind, adapter }), adapter)
  }
  if (external.releaseAdapters && Object.keys(external.releaseAdapters).some(kind => !releaseWorkflowKinds.includes(kind))) throw executionError('EXTERNAL_WORKFLOW_KIND_UNKNOWN')
  return { workflows, records, byId }
}

/** Host装配服务。新群只交新控制账；旧历史只读，不写回旧Task或重复调用旧路由。 */
export async function openWorkflowService({ ctx, config, legacy, judge, readMessage, readResource, notifications, engineeringGhCommand, external, generalCapabilities = [], generalCompletionCheck, generalCompletionIdentity, execution: suppliedExecution, taskOwnerSessions }) {
  if (!Array.isArray(config.groupIds) || !config.groupIds.length || new Set(config.groupIds).size !== config.groupIds.length) throw executionError('WORKFLOW_GROUPS_REQUIRED')
  if (generalCompletionCheck && (!generalCompletionIdentity || typeof generalCompletionIdentity !== 'string')) throw executionError('GENERAL_COMPLETION_IDENTITY_REQUIRED')
  const groups = new Set(config.groupIds)
  const ownerActorId = requireText(config.ownerActorId, 'WORKFLOW_OWNER_REQUIRED')
  const modelConfig = () => {
    const value = legacy.getAgentConfig()
    return { provider: value.provider, model: value.model, ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) }
  }
  const engineering = createEngineeringRegistry({ repositories: config.repositories ?? [], ownerActorId, modelConfig, author: config.gitAuthor, ghCommand: engineeringGhCommand })
  const selectedExternal = createExternalRegistry(external, modelConfig())
  const externalWorkflows = [...selectedExternal.byId.keys()].map(id => ({ id, purpose: externalLabels[id],
    ...(external?.availableTargets ? { targetIds: external.availableTargets.filter(item => item.workflowId === id).map(item => item.targetId) } : {}) }))
  const unavailableWorkflows = Object.entries(externalLabels).filter(([id]) => !selectedExternal.byId.has(id)).map(([, label]) => label)
  const generalStore = { current: suppliedExecution?.store ?? null }
  const generalArtifacts = { current: suppliedExecution?.artifacts ?? null }
  const sourceRead = {
    id: 'read-topic-sources', effectClass: 'read', description: '只读核对当前话题已授权的消息原文', identity: 'read-topic-sources-v1',
    async authorize({ input, scope }) {
      if (!Array.isArray(input.sourceKeys) || !input.sourceKeys.length || input.sourceKeys.length > 16
        || !Array.isArray(scope.sourceKeys) || input.sourceKeys.some(key => !scope.sourceKeys.includes(key))) return false
      const sources = await Promise.all(input.sourceKeys.map(sourceKey => generalStore.current.query({ kind: 'message.source', sourceKey })))
      return sources.every(source => source?.conversationId === scope.conversationId && source.status !== 'superseded'
        && (!scope.sourceVersions || source.sourceVersion === scope.sourceVersions[source.sourceKey]))
    },
    async execute({ input }) {
      const sources = await Promise.all(input.sourceKeys.map(sourceKey => generalStore.current.query({ kind: 'message.source', sourceKey })))
      const projected = sources.map(source => ({ sourceKey: source.sourceKey, sourceVersion: source.sourceVersion, text: source.body }))
      if (Buffer.byteLength(JSON.stringify(projected)) > 32000) throw executionError('GENERAL_SOURCE_CAPACITY')
      return { sources: projected }
    },
    async verify({ input, scope, output }) {
      if (await sourceRead.authorize({ input, scope }) !== true) return { passed: false }
      const fresh = await sourceRead.execute({ input })
      return { passed: executionDigest(fresh) === executionDigest(output), outputDigest: executionDigest(fresh),
        sourceRefs: fresh.sources.map(source => source.sourceKey) }
    },
  }
  const predecessorRead = {
    id: 'read-predecessor-artifact', effectClass: 'read', description: '只读核对本任务前一阶段的已验收产物',
    identity: 'read-predecessor-artifact-v1',
    async authorize({ input, scope }) {
      return typeof input.outputRef === 'string' && input.outputRef === scope.predecessorOutputRef
    },
    async execute({ input }) { return { outputRef: input.outputRef,
      value: await generalArtifacts.current.read(input.outputRef) } },
    async verify({ input, scope, output }) {
      if (!await predecessorRead.authorize({ input, scope })) return { passed: false }
      const fresh = await predecessorRead.execute({ input })
      return { passed: executionDigest(fresh) === executionDigest(output),
        outputDigest: executionDigest(fresh), sourceRefs: [input.outputRef] }
    },
  }
  const sourceDossier = createSourceDossierCapability(sourceRead)
  const messageResourceRead = createTaskMessageResourceCapability({ store: { query: (...args) => generalStore.current.query(...args) }, readMessage, readResource })
  const readableFiles = config.generalFileRead?.readablePaths ?? []
  const fileRead = config.generalFileRead ? createGeneralFileReadCapability(config.generalFileRead) : null
  const markdownFileAdapter = config.taskOutputDirectory || config.artifactDirectory
    ? createTaskMarkdownFileAdapter({ root: config.taskOutputDirectory ?? config.artifactDirectory }) : null
  const markdownWrite = markdownFileAdapter ? createGeneralMarkdownWriteCapability({ fileAdapter: markdownFileAdapter }) : null
  const capabilities = [sourceRead, predecessorRead, sourceDossier, ...(messageResourceRead ? [messageResourceRead] : []), ...(fileRead ? [fileRead] : []), ...(markdownWrite ? [markdownWrite] : []), ...generalCapabilities]
  const stepCapabilities = capabilities.filter(item => ['read', 'file.write'].includes(item.effectClass))
  const intakeWorkflow = createGeneralIntakeWorkflow()
  const stepWorkflow = createGeneralCapabilityStepWorkflow({ capabilities: stepCapabilities })
  const historicalStepWorkflow = createHistoricalGeneralCapabilityStepWorkflow({ capabilities: stepCapabilities.filter(item => item.effectClass === 'read') })
  const completionCheck = generalCompletionCheck ?? verifyDefaultGeneralCompletion
  const generalWorkflowWith = (selected, available) => createGeneralTaskWorkflow({ ...selected, capabilities: available, completionCheck,
    completionIdentity: generalCompletionIdentity ?? 'task-result-verification-v3' })
  const generalWorkflow = selected => generalWorkflowWith(selected, capabilities.filter(item => item.effectClass === 'read'))
  const visibleDefinitions = new Map([createAnalysisTaskWorkflow(modelConfig()), ...createReadOnlyTaskWorkflows(modelConfig()), generalWorkflow(modelConfig()), intakeWorkflow, stepWorkflow, ...selectedExternal.workflows]
    .map(workflow => [workflow.id, workflow]))
  const execution = suppliedExecution ?? await openExecutionRuntime({
    ctx, dbPath: config.dbPath, instanceId: config.instanceId, artifactDirectory: config.artifactDirectory,
    readTools: ['engineering_repo_inspect'], repositoryInspect: engineering.repositoryInspect,
    deliveryOptions: { ...engineering.deliveryOptions,
      ...(markdownFileAdapter ? { fileAdapter: markdownFileAdapter } : {}),
      authorizeFile: async ({ binding, action, prepared }) => {
        if (action !== 'file' || !binding?.taskId || prepared?.taskId !== binding.taskId
          || prepared.runId !== binding.runId || prepared.nodeRunId !== binding.nodeRunId
          || prepared.generation !== binding.generation || prepared.requirementDigest !== binding.requirementDigest) return false
        const plan = await generalStore.current.query({ kind: 'task.plan', taskId: binding.taskId })
        const origin = await generalStore.current.query({ kind: 'message.task', taskId: binding.taskId })
        const stage = plan?.stages.find(item => item.runId === binding.runId && item.workflowId === 'task-general-capability')
        const run = stage ? await generalStore.current.query({ kind: 'run', runId: binding.runId }) : null
        if (!plan || !origin || !stage || !run || stage.status !== 'running' || run.run.status !== 'running'
          || run.run.requirementRef !== stage.requirementRef || plan.task.controlState !== 'active') return false
        const current = await generalArtifacts.current.read(plan.task.requirementRef)
        const step = await generalArtifacts.current.read(stage.requirementRef)
        const { predecessorOutputRef: _predecessorOutputRef, ...stepScope } = step.scope ?? {}
        if (!current.scope?.writeMarkdown || !step.scope?.writeMarkdown
          || executionDigest(current.scope) !== executionDigest(stepScope)) return false
        return { principalId: origin.run.actorId, authorizationRef: plan.task.requirementRef }
      },
      ...(selectedExternal.workflows.length ? { externalAdapter: external.operationAdapter, authorizeExternal: external.authorizeExternal } : {}) },
    workflows: async (store, artifacts) => {
      generalStore.current = store
      const selected = modelConfig()
      const workflows = [createAnalysisTaskWorkflow(selected), ...createReadOnlyTaskWorkflows(selected), generalWorkflow(selected), intakeWorkflow, stepWorkflow]
      const definitions = new Map(workflows.map(workflow => [workflow.id, defineExecutionWorkflow(workflow)]))
      const prior = await store.query({ kind: 'workflow.list' })
      const activeDefinitions = new Set()
      let beforeSequenceId
      for (;;) {
        const page = await store.query({ kind: 'run.list', limit: 200,
          ...(beforeSequenceId ? { beforeSequenceId } : {}) })
        for (const run of page) if (!terminal(run.status))
          activeDefinitions.add(`${run.workflowId}:${run.workflowDigest}`)
        if (page.length < 200) break
        beforeSequenceId = page.at(-1).sequenceId
      }
      beforeSequenceId = undefined
      for (;;) {
        const page = await store.query({ kind: 'task.plans.pending', limit: 200,
          ...(beforeSequenceId ? { beforeSequenceId } : {}) })
        for (const task of page) {
          const plan = await store.query({ kind: 'task.plan', taskId: task.taskId })
          for (const stage of plan.stages) if (stage.workflowDigest && !['succeeded', 'invalidated'].includes(stage.status))
            activeDefinitions.add(`${stage.workflowId}:${stage.workflowDigest}`)
        }
        if (page.length < 200) break
        beforeSequenceId = page.at(-1).sequenceId
      }
      const engineeringWorkflows = await engineering.restore(store, artifacts)
      const historicalWorkflows = prior.filter(record => record.config?.kind !== 'engineering'
        && record.config?.kind !== 'external'
        && activeDefinitions.has(`${record.workflowId}:${record.digest}`)).map(record => {
        const candidates = [createAnalysisTaskWorkflow(record.config), ...createReadOnlyTaskWorkflows(record.config),
          generalWorkflow(record.config), intakeWorkflow, stepWorkflow, historicalStepWorkflow,
          ...((fileRead || messageResourceRead) ? [generalWorkflowWith(record.config,
            [sourceRead, predecessorRead, sourceDossier, ...(fileRead ? [fileRead] : []), ...generalCapabilities])] : []),
          ...(fileRead ? [generalWorkflowWith(record.config,
            [sourceRead, predecessorRead, sourceDossier, ...generalCapabilities])] : [])]
          .filter(item => item.id === record.workflowId && item.version === record.definitionVersion)
        if (!candidates.length) throw executionError('WORKFLOW_VERSION_UNAVAILABLE')
        const previous = candidates.find(item => {
          const definition = defineExecutionWorkflow(item)
          return [definition.digest, ...definition.legacyDigests].includes(record.digest)
        })
        if (!previous) throw executionError('WORKFLOW_DEFINITION_DRIFT')
        return previous
      }).filter(item => ![definitions.get(item.id)?.digest, ...(definitions.get(item.id)?.legacyDigests ?? [])].includes(defineExecutionWorkflow(item).digest))
      for (const record of prior.filter(item => item.config?.kind === 'external'
        && activeDefinitions.has(`${item.workflowId}:${item.digest}`))) {
        const route = selectedExternal.byId.get(record.workflowId), saved = record.config
        if (!route || saved.registryVersion !== '1' || saved.adapterId !== route.adapter.id
          || saved.adapterVersion !== route.adapter.version || saved.rulesDigest !== route.adapter.rulesDigest) throw executionError('EXTERNAL_WORKFLOW_DEFINITION_DRIFT')
        const previous = record.workflowId === 'task-data-change'
          ? createDataChangeTaskWorkflow({ ...saved.modelConfig, adapter: route.adapter })
          : record.workflowId === 'task-uat-pr-merge'
            ? createUatPrMergeTaskWorkflow({ adapter: route.adapter })
          : (record.definitionVersion === '1' ? createLegacyReleaseTaskWorkflow : createReleaseTaskWorkflow)({ kind: record.workflowId.slice(5), adapter: route.adapter })
        if (previous.version !== record.definitionVersion || ![defineExecutionWorkflow(previous).digest, ...defineExecutionWorkflow(previous).legacyDigests].includes(record.digest))
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
  let taskOwner
  external?.bindStore?.(store)
  external?.bindExecution?.({ store, controller, artifacts })
  generalStore.current = store
  generalArtifacts.current = artifacts
  if (suppliedExecution && typeof controller.registerWorkflow === 'function') {
    for (const workflow of createReadOnlyTaskWorkflows(modelConfig())) controller.registerWorkflow(workflow)
    controller.registerWorkflow(generalWorkflow(modelConfig()))
    controller.registerWorkflow(intakeWorkflow)
    controller.registerWorkflow(stepWorkflow)
    for (const workflow of selectedExternal.workflows) controller.registerWorkflow(workflow)
  }
  const notifier = createWorkflowNotifications({ store, controller, artifacts, adapter: notifications,
    groupResponsibility: groupId => legacy.getGroup?.(groupId)?.responsibility ?? '' })
  async function authorizedNotificationOperation(notification, authorizationRef, type) {
    if (!notification || !groups.has(notification.payload?.conversationId) || !config.webActorId) throw executionError('WORKFLOW_NOTIFICATION_FORBIDDEN')
    const source = await store.query({ kind: 'message.source', sourceKey: requireText(authorizationRef, 'WORKFLOW_NOTIFICATION_AUTHORIZATION_REQUIRED') })
    const action = type === 'recall' ? '撤回通知' : '补发通知'
    const authorizedTargets = [notification.id, notification.evidence?.messageId].filter(Boolean)
    if (!source || source.actorId !== ownerActorId || source.conversationId !== notification.payload.conversationId
      || source.status === 'superseded'
      || !source.body.split(/\r?\n/u).some(line => authorizedTargets.some(id => line.trim() === `${action} ${id}`)))
      throw executionError('WORKFLOW_NOTIFICATION_AUTHORIZATION_REQUIRED')
    return source
  }
  async function prepareWorkflowNotificationOperation(input) {
    const notice = await store.query({ kind: 'message.notification', notificationId: input.notificationId })
    await authorizedNotificationOperation(notice, input.authorizationRef, input.type)
    return (await store.command({ id: `notification-operation:${input.operationId}:prepare`, kind: 'message.notification.operation.prepare', args: input })).result.operation
  }
  async function executeWorkflowNotificationOperation(input) {
    const operation = await store.query({ kind: 'message.notificationOperation', operationId: input.operationId })
    if (!operation) throw executionError('MESSAGE_NOTIFICATION_OPERATION_NOT_FOUND')
    const notice = await store.query({ kind: 'message.notification', notificationId: operation.snapshot.notificationId })
    await authorizedNotificationOperation(notice, input.authorizationRef, operation.snapshot.type)
    const adapter = { ...notifications,
      async readbackRecall(args) {
        const observation = await notifications.readbackRecall(args)
        if (!observation || observation.recallStatus !== 'SUCCESS' || observation.messageId !== args.messageId) return undefined
        const evidence = await artifacts.put(observation)
        return { ...observation, evidenceRef: evidence.ref }
      },
      async readback(args) {
        const observation = await notifications.readback(args)
        if (!observation?.messageId) return undefined
        const evidence = await artifacts.put(observation)
        return { ...observation, evidenceRef: evidence.ref }
      },
    }
    return executeNotificationOperation({ store, adapter, ...input })
  }
  async function reconcileWorkflowNotificationOperation(input) {
    const operation = await store.query({ kind: 'message.notificationOperation', operationId: input.operationId })
    if (!operation || !['acknowledged', 'unknown', 'in_flight'].includes(operation.status)) throw executionError('MESSAGE_NOTIFICATION_OPERATION_RECONCILE_REQUIRED')
    const notice = await store.query({ kind: 'message.notification', notificationId: operation.snapshot.notificationId })
    await authorizedNotificationOperation(notice, input.authorizationRef, operation.snapshot.type)
    if (input.authorizationRef !== operation.snapshot.authorizationRef) throw executionError('WORKFLOW_NOTIFICATION_AUTHORIZATION_REQUIRED')
    const snapshot = operation.snapshot
    const observed = snapshot.type === 'recall'
      ? await notifications.readbackRecall({ conversationId: snapshot.conversationId, messageId: snapshot.messageId, operationId: operation.id, ack: operation.ack })
      : await notifications.readback({ id: operation.id, payload: { conversationId: snapshot.conversationId, sourceMessageId: snapshot.sourceMessageId, text: snapshot.body }, ack: operation.ack })
    if (!observed?.messageId || snapshot.type === 'recall' && (observed.messageId !== snapshot.messageId || observed.recallStatus !== 'SUCCESS'))
      return operation
    if (!await notifications.canDisclose(notice)) throw executionError('WORKFLOW_NOTIFICATION_FORBIDDEN')
    const evidence = await artifacts.put(observed)
    return (await store.command({ id: `notification-operation:${operation.id}:reconcile`, kind: 'message.notification.operation.reconcile', args: {
      operationId: operation.id, messageId: observed.messageId, evidenceRef: evidence.ref,
      ...(snapshot.type === 'recall' ? { recallStatus: observed.recallStatus } : {}),
    } })).result.operation
  }
  const legacyGroup = id => legacy.getGroup?.(id)
  const investigationConfirmation = request => request.reason === 'COMPLETED_INVESTIGATION_REPORTED_AGAIN'
    || (request.nodeId === 'I' && request.kind === 'needs_clarification'
      && /此前对应任务仅授权排查分析/u.test(String(request.reason)))
  const mayCreate = async (run, workflowId, binding) => {
    if (run.actorId === ownerActorId) return true
    if (!/任务准入/u.test(legacyGroup(run.conversationId)?.responsibility ?? '')) return false
    if (isDirectedTaskRequest(run.body)) return true
    const state = await store.query({ kind: 'message.run', runId: run.runId })
    return state.requests.some(request => investigationConfirmation(request)
      && request.status === 'resolved' && /^(?:是|需要|请|好|可以|同意|继续|修复)/u.test(String(request.answer).trim()))
  }
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
    const item = await approvals.get(input.requestId)
    const prepared = item.effect.definition?.payload
    if (prepared?.workflowKind === 'production-release' && prepared.operation === 'approval-gate'
      || prepared?.workflowKind === 'data-change' && prepared.stage === 'approval-gate') {
      if (identity?.channel !== 'web') throw executionError('WORKFLOW_APPROVAL_WEB_REQUIRED')
    }
    const result = await approvals.decide(input, identity)
    const effect = item.effect
    if (effect?.runId) {
      const state = await controller.state(effect.runId)
      if (await store.query({ kind: 'task.owner', taskId: state.run.taskId }))
        await taskOwner.event({ taskId: state.run.taskId,
          eventKey: `approval:${input.requestId}:${executionDigest(result)}`,
          eventType: 'approval.resolved', payload: { requestId: input.requestId, decision: result } })
    }
    return result
  }
  async function listApprovalRequests() {
    const approvals = await store.query({ kind: 'approval.list', limit: 200 })
    const rows = await Promise.all(approvals.map(async approval => {
      const effect = await store.query({ kind: 'effect.get', effectId: approval.effectId })
      const prepared = effect.definition?.payload
      const productionRelease = prepared?.workflowKind === 'production-release' && prepared.operation === 'approval-gate'
      const dataChange = prepared?.workflowKind === 'data-change' && prepared.stage === 'approval-gate'
      if (!productionRelease && !dataChange) return null
      const state = await controller.state(effect.runId)
      const origin = await store.query({ kind: 'message.task', taskId: state.run.taskId })
      if (!origin || !groups.has(origin.run.conversationId)) return null
      return { requestId: approval.requestId, taskId: state.run.taskId, groupId: origin.run.conversationId,
        objective: origin.command.args.arguments?.objective ?? (productionRelease ? '生产发布' : '数据变更'),
        requestedAction: productionRelease
          ? `审批生产发布 ${prepared.resourceKey}，提交 ${prepared.expected.commitSha}，标签 ${prepared.expected.tag}`
          : `审批数据变更工单 ${prepared.intent.issueId}，任务 ${prepared.intent.taskId}，SQL 摘要 ${prepared.intent.sheetSha256}`,
        waitingReason: productionRelease ? '等待真人批准后创建生产 Tag' : '等待真人批准 Bytebase 工单对应的生产数据变更',
        risk: productionRelease ? '生产发布会更新运行服务' : '生产数据库将执行工单中的 SQL',
        evidence: productionRelease
          ? [prepared.resourceKey, prepared.expected.commitSha, prepared.expected.tag]
          : [prepared.resourceKey, prepared.intent.issueId, prepared.intent.taskId,
            prepared.intent.sheetSha256, prepared.intent.packageDigest], attemptedActions: [],
        createdAt: approval.createdAt, status: approval.decision === 'pending' ? 'waiting-reply' : 'answered',
        decision: approval.decision, decidedAt: approval.updatedAt, decisionSource: approval.decisionSource,
        taskState: state.run.status }
    }))
    return rows.filter(Boolean)
  }
  async function currentTask(taskId, selector) {
    const runs = await store.query({ kind: 'run.list', taskId, limit: 200 })
    const selected = selector && selector !== 'current' ? runs.find(run => run.runId === selector) : runs[0]
    if (!selected) throw executionError('WORKFLOW_TASK_NOT_FOUND')
    return controller.state(selected.runId)
  }
  async function taskFacts(origin, selector) {
    const taskId = origin.command.args.taskId
    const plan = await controller.taskPlan(taskId)
    const runs = await store.query({ kind: 'run.list', taskId, limit: 200 })
    const state = runs.length ? await currentTask(taskId, selector) : null
    const last = state?.nodes.filter(node => node.outputRef).at(-1)
    const outputStage = plan?.stages.findLast(stage => stage.outputRef)
    const outputRef = outputStage?.outputRef ?? last?.outputRef ?? null
    const output = outputRef ? await artifacts.read(outputRef) : null
    const result = output && typeof output === 'object' ? {
      outputRef, stageId: outputStage?.stageId ?? null,
      summary: typeof output.summary === 'string' ? output.summary.slice(0, 700) : null,
      evidenceIds: Array.isArray(output.evidenceIds) ? output.evidenceIds.slice(0, 32) : [],
      limitations: Array.isArray(output.limitations) ? output.limitations.slice(0, 16) : [],
    } : outputRef ? { outputRef } : null
    const blockedStage = plan?.stages.find(stage => stage.status === 'blocked')
    const objectiveAssessment = plan?.task.planRequirementRevision !== plan?.task.requirementRevision
      ? { status: 'unassessed', evidenceRefs: [], reason: '新增任务要求尚未由当前计划覆盖' }
      : state?.run.status === 'succeeded' && state.run.workflowId === 'task-general'
      && output?.outcome === 'completed' && result?.evidenceIds?.length
      ? { status: 'satisfied', evidenceRefs: [outputRef, ...result.evidenceIds], reason: '通用任务的 Host 完成核验已通过' }
      : blockedStage
        ? { status: 'insufficient_evidence', evidenceRefs: [blockedStage.outputRef].filter(Boolean), reason: blockedStage.unavailableReason ?? '后续阶段受阻' }
        : { status: 'unassessed', evidenceRefs: [outputRef].filter(Boolean), reason: '执行状态和结果已记录；尚无逐项业务目标核验' }
    const notifications = []
    let afterSequenceId = 0
    for (;;) {
      const page = await store.query({ kind: 'message.notifications', runId: origin.run.runId,
        states: ['prepared', 'sending', 'acknowledged', 'unknown', 'delivered', 'superseded'], afterSequenceId, limit: 200 })
      for (const notice of page) {
        const replacements = await store.query({ kind: 'message.notificationReplacements', notificationId: notice.id })
        notifications.push({ notificationId: notice.id, eventKey: notice.eventKey ?? null, phase: notice.payload.phase,
          status: notice.status, messageId: notice.evidence?.messageId ?? null, recallStatus: notice.recallStatus ?? null,
          replacements: replacements.map(item => ({ messageId: item.messageId, status: item.status })) })
      }
      if (page.length < 200) break
      afterSequenceId = page.at(-1).sequenceId
    }
    const requirement = plan?.task.requirementRef ? await artifacts.read(plan.task.requirementRef) : null
    return { taskId, objective: requirement?.request ?? origin.command.args.arguments.objective,
      sourceKey: origin.run.sourceKey, sourceVersion: origin.run.sourceVersion,
      topicId: origin.command.args.binding?.topicId ?? null,
      workflowId: state?.run.workflowId ?? origin.command.args.arguments.workflowId,
      status: plan?.task.status ?? state?.run.status ?? origin.command.status,
      nodes: state?.nodes.map(node => ({ nodeId: node.nodeId, status: node.status, waitReason: node.waitReason })) ?? [],
      run: state ? { runId: state.run.runId, status: state.run.status, revision: state.run.revision } : null,
      stages: plan?.stages.map(stage => ({ stageId: stage.stageId, workflowId: stage.workflowId,
        status: stage.status, runId: stage.runId ?? null, outputRef: stage.outputRef ?? null })) ?? [],
      result, objectiveAssessment, notifications,
    }
  }
  async function topicTaskFacts(topic, run) {
    const origins = await store.query({ kind: 'message.task-candidates', conversationId: run.conversationId, limit: 200 })
    const sourceKeys = new Set(topic.sources.map(ref => ref.sourceKey))
    const matched = origins.filter(origin => ['accepted', 'applied'].includes(origin.command.status)
      && (origin.command.args.binding?.topicId === topic.topicId
        || !origin.command.args.binding?.topicId && sourceKeys.has(origin.run.sourceKey)))
    const unique = [...new Map(matched.map(origin => [origin.command.args.taskId, origin])).values()]
    const tasks = []
    for (const origin of unique.slice(0, 20)) {
      try { await taskAccess(origin.command.args.taskId, run.actorId, run.conversationId) }
      catch (error) { if (error.code === 'WORKFLOW_TASK_FORBIDDEN') continue; throw error }
      tasks.push(await taskFacts(origin))
    }
    return { tasks, total: unique.length, hasMore: unique.length > 20 || origins.length === 200 }
  }
  const stageRunId = (taskId, planRevision, stageId, attempt = 1) =>
    `run-${executionDigest({ taskId, planRevision, stageId, attempt })}`
  async function createPlannedTask({ action, info }) {
    const taskId = requireText(action.taskId, 'WORKFLOW_TASK_ID_REQUIRED')
    const sourceKeys = [...new Set([info.run.sourceKey,
      ...(action.binding?.topicId ? await store.query({ kind: 'message.topic.sources', topicId: action.binding.topicId }) : [])])]
    if (sourceKeys.length > 16) throw executionError('TASK_SOURCE_CAPACITY')
    const sources = await Promise.all(sourceKeys.map(key => store.query({ kind: 'message.source', sourceKey: key })))
    if (sources.some(source => !source || source.conversationId !== info.run.conversationId
      || source.status === 'superseded')) throw executionError('TASK_SOURCE_NOT_CURRENT')
    const references = [...new Set(action.requiredExecutionMaterials ?? [])]
    const resolved = references.length ? await resolveMaterials({ run: info.run,
      needs: references.map(resourceRef => ({ resourceRef })) }) : { ready: true, data: { resources: [] } }
    if (!resolved.ready) throw executionError('WORKFLOW_REQUIRED_MATERIAL_NOT_READY')
    const objective = requireText(action.arguments.objective, 'WORKFLOW_OBJECTIVE_REQUIRED')
    const requirement = { request: objective, objective,
      acceptanceCriteria: action.arguments.acceptanceCriteria ?? [objective],
      constraints: [...new Set(action.constraints ?? [...(info.unit.constraints ?? []), ...(info.unit.sharedConstraints ?? [])])],
      explicitStages: action.arguments.explicitStages ?? [],
      materials: resolved.data.resources.map(item => ({ id: item.resourceRef, text: item.text })),
      target: Object.fromEntries(['repositoryId', 'targetId', 'commitSha', 'releaseTag', 'changeRef', 'pullRequestNumber', 'headCommitSha']
        .filter(key => action.arguments[key] !== undefined).map(key => [key, action.arguments[key]])),
      scope: { conversationId: info.run.conversationId, sourceKeys,
        sourceVersions: Object.fromEntries(sources.map(source => [source.sourceKey, source.sourceVersion])),
        readableFiles, writeMarkdown: /(?:生成|创建|写入|输出|保存).{0,16}(?:Markdown|md文件|文档|文件)/iu.test(info.run.body) },
      authorization: { actorId: info.run.actorId, sourceKey: info.run.sourceKey,
        sourceVersion: info.run.sourceVersion, commandId: info.commandId,
        ownerConfirmed: info.ownerConfirmed === true } }
    const saved = await artifacts.put(requirement)
    await store.command({ id: `task-accept:${info.commandId}`, kind: 'task.accept', args: {
      taskId, requirementRef: saved.ref, requirementRevision: 1,
      sessionId: `owner-${executionDigest(taskId).slice(0, 40)}`,
      criteria: requirement.acceptanceCriteria, sourceKey: info.run.sourceKey,
      eventKey: `task-created-${executionDigest(taskId).slice(0, 40)}`,
    } })
    let planningError = null
    try {
      await taskOwner.drive(taskId)
      const failures = await taskOwner.applyPending()
      planningError = failures[0]?.code ?? null
    } catch (cause) { planningError = cause.code ?? cause.message }
    const plan = await controller.taskPlan(taskId)
    return { taskId, runId: plan.stages[0]?.runId ?? null, planningError }
  }
  async function advanceBusinessTask(taskId, continuation) {
    let plan = await controller.advanceTaskPlan(taskId)
    const currentIndex = plan.stages.findIndex(stage => !['succeeded', 'invalidated'].includes(stage.status))
    const current = plan.stages[currentIndex]
    const predecessorOutputRef = plan.stages[currentIndex - 1]?.outputRef ?? null
    if (!current || current.status !== 'ready' || current.unavailableReason || current.requirementRef) return plan
    const requirement = plan.task.requirementRef ? await artifacts.read(plan.task.requirementRef) : null
    if (!requirement?.request) return plan
    if (current.workflowId === 'task-general-capability') {
      const step = continuation?.ownerStep
      if (!step)
        throw executionError('GENERAL_STEP_NOT_BOUND')
      await controller.bindTaskStageInput({ commandId: `stage-input:${taskId}:${plan.task.planRevision}:${current.stageId}`,
        taskId, planRevision: plan.task.planRevision, stageId: current.stageId, predecessorOutputRef,
        input: { capabilityId: step.capabilityId, input: step.input,
          scope: { ...requirement.scope, predecessorOutputRef }, expectedEvidence: step.expectedEvidence } })
      return controller.advanceTaskPlan(taskId)
    }
    const origin = continuation?.command ? continuation : await store.query({ kind: 'message.task.latest', taskId })
      ?? await store.query({ kind: 'message.task', taskId })
    if (!origin) return plan
    const previous = predecessorOutputRef ? await artifacts.read(predecessorOutputRef) : null
    const args = origin.command.args
    const objective = requirement.request
    const targetArgs = { ...args.arguments, ...requirement.target, objective }
    const input = current.workflowId === 'task-general'
      ? { request: objective, acceptanceCriteria: requirement.acceptanceCriteria,
        constraints: requirement.constraints, scope: { ...requirement.scope, predecessorOutputRef } }
      : { request: objective, constraints: requirement.constraints,
        materials: [...(requirement.materials ?? []), ...(predecessorOutputRef ? [{ id: predecessorOutputRef, text: JSON.stringify(previous) }] : [])] }
    if (current.workflowId === 'task-engineering') {
      const action = { taskId, arguments: { ...targetArgs, workflowId: 'task-engineering' }, constraints: requirement.constraints }
      const source = { run: origin.run, unit: { constraints: [], sharedConstraints: [] },
        commandId: `stage:${taskId}:${plan.task.planRevision}:${current.stageId}`,
        stageRunId: controller.plannedTaskStageRunId({ taskId, planRevision: plan.task.planRevision, stageId: current.stageId, attempt: current.attempt }),
        authorizedGroupRequest: await mayCreate(origin.run, 'task-engineering') }
      const prepared = await engineering.prepareTask(action, source, controller)
      await controller.bindTaskStageInput({ commandId: `stage-input:${taskId}:${plan.task.planRevision}:${current.stageId}`, taskId,
        planRevision: plan.task.planRevision, stageId: current.stageId, predecessorOutputRef,
        input: prepared.input, workflowId: prepared.workflowId })
    } else if (current.workflowId === 'task-uat-deployment' || current.workflowId === 'task-uat-pr-merge') {
      if (!selectedExternal.byId.has(current.workflowId)) throw executionError('EXTERNAL_WORKFLOW_UNAVAILABLE')
      const completed = plan.stages.slice(0, currentIndex).filter(stage => stage.status === 'succeeded')
      const merged = [...completed].reverse().find(stage => stage.workflowId === 'task-uat-pr-merge' && stage.outputRef)
      const engineered = [...completed].reverse().find(stage => stage.runId && stage.workflowId.startsWith('task-engineering-'))
      let engineeringProof
      if (engineered) engineeringProof = await readEngineeringDeliveryProof({ state: await controller.state(engineered.runId), artifacts, store, taskId })
      const mergedProof = merged ? await artifacts.read(merged.outputRef) : null
      if (mergedProof && (mergedProof.baseBranch === undefined || mergedProof.mergeCommitSha === undefined))
        throw executionError('UAT_MERGE_SOURCE_INVALID')
      const action = { taskId, arguments: { ...targetArgs, workflowId: current.workflowId,
        ...(current.workflowId === 'task-uat-pr-merge' && engineeringProof ? {
          pullRequestNumber: engineeringProof.pullRequest.number,
          headCommitSha: engineeringProof.pullRequest.commitSha } : {}),
        ...(current.workflowId === 'task-uat-deployment' && mergedProof ? { commitSha: mergedProof.mergeCommitSha } : {}) },
        constraints: requirement.constraints }
      const materials = current.workflowId === 'task-uat-deployment' && mergedProof
        ? [{ resourceRef: `uat-merge-task:${taskId}:${merged.runId}` }]
        : engineeringProof && current.workflowId === 'task-uat-deployment'
          ? [{ resourceRef: `engineering-task:${taskId}:${engineered.runId}` }] : []
      const input = await external.prepareRequirement({ workflowId: current.workflowId, action, materials })
      await controller.bindTaskStageInput({ commandId: `stage-input:${taskId}:${plan.task.planRevision}:${current.stageId}`,
        taskId, planRevision: plan.task.planRevision, stageId: current.stageId, predecessorOutputRef, input })
    } else if (selectedExternal.byId.has(current.workflowId)) {
      const action = { taskId, arguments: { ...targetArgs, workflowId: current.workflowId }, constraints: requirement.constraints }
      const input = await external.prepareRequirement({ workflowId: current.workflowId, action, materials: [] })
      await controller.bindTaskStageInput({ commandId: `stage-input:${taskId}:${plan.task.planRevision}:${current.stageId}`,
        taskId, planRevision: plan.task.planRevision, stageId: current.stageId, predecessorOutputRef, input })
    } else if (visibleDefinitions.has(current.workflowId)) {
      await controller.bindTaskStageInput({ commandId: `stage-input:${taskId}:${plan.task.planRevision}:${current.stageId}`, taskId,
        planRevision: plan.task.planRevision, stageId: current.stageId, predecessorOutputRef, input })
    }
    return controller.advanceTaskPlan(taskId)
  }
  async function prepareInitialStage({ taskId, stage, decision, plan }) {
    const requirement = await artifacts.read(plan.task.requirementRef)
    const origin = await store.query({ kind: 'message.task', taskId })
    if (!origin || !requirement?.request) throw executionError('TASK_REQUIREMENT_MISSING')
    const args = { ...origin.command.args.arguments, ...requirement.target, objective: requirement.request }
    if (stage.workflowId === 'task-general-capability') {
      const step = stage.capabilityStep ?? decision.appendStages?.[0]?.capabilityStep
      if (!step) throw executionError('GENERAL_STEP_NOT_BOUND')
      return { input: { capabilityId: step.capabilityId, input: step.input,
        scope: { ...requirement.scope, predecessorOutputRef: null }, expectedEvidence: step.expectedEvidence } }
    }
    if (stage.workflowId === 'task-engineering') {
      const prepared = await engineering.prepareTask({ taskId,
        arguments: { ...args, workflowId: 'task-engineering' }, constraints: requirement.constraints }, {
        run: origin.run, unit: { constraints: [], sharedConstraints: [] },
        commandId: `stage:${taskId}:1:stage-1`, stageRunId: stageRunId(taskId, 1, 'stage-1'),
        authorizedGroupRequest: await mayCreate(origin.run, 'task-engineering'),
      }, controller)
      return { input: prepared.input, workflowId: prepared.workflowId }
    }
    if (selectedExternal.byId.has(stage.workflowId)) return { input: await external.prepareRequirement({
      workflowId: stage.workflowId,
      action: { taskId, arguments: { ...args, workflowId: stage.workflowId }, constraints: requirement.constraints },
      materials: [],
    }) }
    const sources = await Promise.all(requirement.scope.sourceKeys.map(key => store.query({ kind: 'message.source', sourceKey: key })))
    return { input: { request: requirement.request, constraints: requirement.constraints,
      materials: [...sources.map(source => ({ id: source.sourceKey, text: source.body })), ...(requirement.materials ?? [])] } }
  }
  taskOwner = createTaskOwnerController({ ctx, store, artifacts, controller, modelConfig,
    ...(taskOwnerSessions ? { sessionRunner: taskOwnerSessions } : {}),
    capabilityCatalog: stepCapabilities.map(item => ({ id: item.id, description: item.description,
      effectClass: item.effectClass })),
    workflowCatalog: taskWorkflowCatalog.filter(item => !['task-general', 'task-analysis'].includes(item.id))
      .map(item => ({ id: item.id, purpose: item.purpose, mode: item.mode,
        available: item.mode !== 'external' || selectedExternal.byId.has(item.id),
        ...(externalWorkflows.find(entry => entry.id === item.id)?.targetIds
          ? { targetIds: externalWorkflows.find(entry => entry.id === item.id).targetIds } : {}) })),
    prepareInitialStage,
    advanceTask: advanceBusinessTask,
    authorizeCompletion: async ({ taskId, decision }) => {
      const plan = await controller.taskPlan(taskId)
      if (!plan?.stages.length || plan.task.status !== 'succeeded'
        || plan.task.planRequirementRevision !== plan.task.requirementRevision) return false
      const initial = await artifacts.read(plan.task.requirementRef)
      const evidence = await Promise.all(plan.stages.filter(stage => stage.workflowId === 'task-general-capability'
        && stage.status === 'succeeded' && stage.outputRef).map(async stage => ({
        evidenceId: stage.outputRef, ...(await artifacts.read(stage.outputRef)),
      })))
      if (!plan.stages.every(stage => stage.status === 'succeeded')) return false
      if (plan.stages.some(stage => stage.workflowId !== 'task-general-capability'))
        return decision.evidenceRefs.length > 0 && decision.evidenceRefs.every(ref => plan.stages.some(stage =>
          stage.outputRef === ref || stage.evidenceRefs?.includes(ref)))
      const assessment = await completionCheck({ request: initial.request,
        acceptanceCriteria: initial.acceptanceCriteria, constraints: initial.constraints,
        scope: initial.scope, evidence, report: { summary: decision.summary,
          evidenceIds: decision.evidenceRefs, limitations: [] } })
      return assessment?.status === 'satisfied' && assessment.resultVerified === true
        && Array.isArray(assessment.criteria) && assessment.criteria.length === initial.acceptanceCriteria.length
        && assessment.criteria.every((item, index) => item.criterion === initial.acceptanceCriteria[index]
          && item.passed === true && item.evidenceIds?.length
          && item.evidenceIds.every(ref => decision.evidenceRefs.includes(ref)))
    },
    authorizeStages: async ({ taskId, stages }) => {
      const plan = await controller.taskPlan(taskId)
      if (!plan || !stages.length || stages.length > 16 || plan.task.controlState !== 'active') return false
      const requirement = await artifacts.read(plan.task.requirementRef)
      const origin = await store.query({ kind: 'message.task', taskId })
      if (!origin || !requirement?.authorization
        || !requirement.authorization.ownerConfirmed && !await mayCreate(origin.run)) return false
      const userText = [requirement.request, ...requirement.explicitStages].join('\n')
      for (const stage of stages) {
        if (stage.workflowId === 'task-general-capability') {
          const step = stage.capabilityStep
          const capability = stepCapabilities.find(item => item.id === step?.capabilityId)
          if (!step || !capability || stage.gate !== 'none' || !step.expectedEvidence?.trim()) return false
          const scope = { ...requirement.scope, predecessorOutputRef: plan.stages.at(-1)?.outputRef ?? null }
          if (!await capability.authorize({ input: step.input, scope })) return false
          const proposed = executionDigest({ capabilityId: step.capabilityId, input: step.input, scope: requirement.scope })
          for (const prior of plan.stages) if (prior.workflowId === 'task-general-capability' && prior.requirementRef) {
            const used = await artifacts.read(prior.requirementRef)
            if (executionDigest({ capabilityId: used.capabilityId, input: used.input, scope: requirement.scope }) === proposed) return false
          }
          continue
        }
        const item = catalogById.get(stage.workflowId)
        if (!item || item.id === 'task-general' || item.mode === 'external' && !selectedExternal.byId.has(item.id)) return false
        if (item.mode === 'engineering' && !requirement.target.repositoryId) return false
        if (item.mode === 'external' && !requirement.target.targetId) return false
        if (item.id === 'task-uat-pr-merge' && !/合并|部署|提测|UAT/iu.test(userText)) return false
        if (item.id === 'task-production-release' && !/生产发布|上线/iu.test(userText)) return false
        if (item.id === 'task-data-change' && !/数据变更|SQL/iu.test(userText)) return false
      }
      return true
    } })
  async function executeWebEvent(event) {
    if(event.status==='pending') {
      try {
        const commandId=`web-task:${event.id}`
        if(event.request.action==='cancel') {
          const plan = await controller.taskPlan(event.request.taskId)
          if (plan) await controller.controlTask({ commandId, taskId: event.request.taskId,
            intent: 'cancel', expectedControlRevision: plan.task.controlRevision })
          else await controller.stop({commandId,runId:event.executionRunId,reason:event.request.reason})
        } else await controller.changeInput({commandId,runId:event.executionRunId,inputId:commandId,sourceKey:commandId,input:event.input,expectedRevision:event.request.inputVersion-1})
        if (await store.query({ kind: 'task.owner', taskId: event.request.taskId }))
          await taskOwner.event({ taskId: event.request.taskId, eventKey: `web:${event.id}`,
            eventType: event.request.action === 'cancel' ? 'control.changed' : 'intent.received',
            payload: { action: event.request.action, requestId: event.request.requestId,
              actorId: event.actorId, input: event.input } })
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
    if(request.action==='reissue-repository')return engineering.reissueTask(request,controller,artifacts)
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
  async function ownerConfirmedPriorTask(action, info) {
    if (!action.binding?.priorTaskId) return false
    const requests = (await messages.state(info.run.runId)).requests
    for (const request of requests.filter(item => item.status === 'resolved' && item.unitId === info.unit.unitId && item.eventId)) {
      const answer = await store.query({ kind: 'message.source', sourceKey: request.eventId })
      if (answer?.actorId === ownerActorId) return true
    }
    return false
  }
  async function createTask(action, info) {
    const ownerConfirmed = await ownerConfirmedPriorTask(action, info)
    if (!await mayCreate(info.run, action.arguments.workflowId, info.binding) && !ownerConfirmed && action.intent !== 'answer') throw executionError('WORKFLOW_ACTION_FORBIDDEN')
    info = { ...info, ownerConfirmed }
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
    const result = await createPlannedTask({ action, info })
    return { taskId: result.taskId, runId: result.runId, status: 'accepted',
      reply: result.planningError
        ? `任务已接纳；执行会话规划受阻：${result.planningError}。请在任务页查看并处理。`
        : '任务已接纳，执行会话将按目标和授权安排后续步骤。' }
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
    const currentPlan = await controller.taskPlan(taskId)
    const recordIntent = () => taskOwner.event({ taskId, eventKey: `intent:${info.commandId}`,
      eventType: 'intent.received', payload: { action: action.intent, sourceRunId: info.run.runId,
        actorId: info.run.actorId, arguments: action.arguments, constraints: action.constraints } })
    const extendAcceptance = async () => {
      const criteria = action.arguments.acceptanceCriteria ?? [action.arguments.objective]
      for (const [index, criterion] of criteria.entries()) await store.command({
        id: `acceptance:${info.commandId}:${index}`, kind: 'task.owner.acceptance.extend',
        args: { taskId, itemId: `acceptance-${executionDigest([info.commandId, index]).slice(0, 32)}`,
          criterion, sourceKey: info.run.sourceKey,
          eventKey: `acceptance-event-${executionDigest([info.commandId, index]).slice(0, 32)}` },
      })
    }
    if (currentPlan && ['pause', 'cancel', 'resume'].includes(action.intent)) {
      const controlled = await controller.controlTask({ commandId: `task-control:${info.commandId}`, taskId,
        intent: action.intent, expectedControlRevision: currentPlan.task.controlRevision })
      await taskOwner.event({ taskId, eventKey: `control:${info.commandId}`, eventType: 'control.changed',
        payload: { intent: action.intent, sourceRunId: info.run.runId,
          controlRevision: controlled.plan.task.controlRevision } })
      return { taskId, runId: controlled.plan.stages.findLast(stage => stage.runId)?.runId ?? null,
        status: controlled.plan.task.status, reply: `已记录任务${action.intent}请求；当前状态：${controlled.plan.task.status}` }
    }
    if (action.intent === 'report') {
      if (!currentPlan || currentPlan.task.status !== 'succeeded'
        || currentPlan.task.planRequirementRevision !== currentPlan.task.requirementRevision)
        throw executionError('TASK_REPORT_NOT_READY')
      await taskOwner.event({ taskId, eventKey: `report-language:${info.commandId}`,
        eventType: 'report.preference.changed', payload: { language: action.arguments.language,
          sourceRunId: info.run.runId, actorId: info.run.actorId } })
      await taskOwner.drive(taskId)
      const failures = await taskOwner.applyPending()
      if (failures.length) throw executionError(failures[0].code)
      return { taskId, status: 'accepted', reply: '已按当前任务的已核验结果重新生成报告。' }
    }
    if (['reopen', 'revise'].includes(action.intent)) {
      if (!currentPlan) throw executionError('TASK_PLAN_NOT_FOUND')
      let plan = currentPlan
      const wasCancelled = plan.task.controlState === 'cancelled'
      if (action.intent === 'reopen' && wasCancelled) {
        const authorization = await artifacts.put({ taskId, sourceKey: info.run.sourceKey,
          actorId: info.run.actorId, conversationId: info.run.conversationId,
          intent: action.intent, commandId: info.commandId })
        await controller.controlTask({ commandId: `task-reopen:${info.commandId}`, taskId, intent: 'reopen',
          expectedControlRevision: plan.task.controlRevision,
          requirementRevision: plan.task.requirementRevision, authorizationRef: authorization.ref })
        plan = await controller.taskPlan(taskId)
      }
      const current = plan.stages.find(stage => stage.status === 'waiting_confirmation')
      if (current && action.intent === 'reopen' && !wasCancelled) {
        const predecessor = plan.stages[current.position - 1]
        if (!predecessor?.outputRef) throw executionError('TASK_CONFIRMATION_OUTPUT_MISSING')
        await controller.confirmTaskStage({ commandId: `confirm:${info.commandId}`, taskId,
          stageId: current.stageId, planRevision: plan.task.planRevision, outputRef: predecessor.outputRef })
        await recordIntent()
        await taskOwner.drive(taskId)
        const failures = await taskOwner.applyPending()
        if (failures.length) throw executionError(failures[0].code)
        return { taskId, status: 'accepted', reply: '已记录对当前方案的确认，执行会话将继续安排后续步骤。' }
      }
      const previous = await artifacts.read(plan.task.requirementRef)
      const objective = requireText(action.arguments.objective, 'WORKFLOW_OBJECTIVE_REQUIRED')
      const source = await store.query({ kind: 'message.source', sourceKey: info.run.sourceKey })
      if (!source || source.status === 'superseded') throw executionError('TASK_SOURCE_NOT_CURRENT')
      const next = { ...previous, request: objective, objective,
        acceptanceCriteria: action.arguments.acceptanceCriteria ?? previous.acceptanceCriteria,
        constraints: [...new Set([...(previous.constraints ?? []), ...(action.constraints ?? [])])],
        explicitStages: [...new Set([...(previous.explicitStages ?? []), ...(action.arguments.explicitStages ?? [])])],
        target: { ...previous.target, ...Object.fromEntries(['repositoryId', 'targetId', 'commitSha', 'releaseTag', 'changeRef', 'pullRequestNumber', 'headCommitSha']
          .filter(key => action.arguments[key] !== undefined).map(key => [key, action.arguments[key]])) },
        scope: { ...previous.scope, sourceKeys: [...new Set([...previous.scope.sourceKeys, info.run.sourceKey])],
          sourceVersions: { ...previous.scope.sourceVersions, [info.run.sourceKey]: source.sourceVersion },
          writeMarkdown: previous.scope.writeMarkdown || /(?:生成|创建|写入|输出|保存).{0,16}(?:Markdown|md文件|文档|文件)/iu.test(info.run.body) },
        authorization: { actorId: info.run.actorId, sourceKey: info.run.sourceKey,
          sourceVersion: info.run.sourceVersion, commandId: info.commandId } }
      const saved = await artifacts.put(next)
      await store.command({ id: `task-requirement:${info.commandId}`, kind: 'task.requirement.update', args: {
        taskId, expectedRequirementRevision: plan.task.requirementRevision, requirementRef: saved.ref,
        eventKey: `intent:${info.commandId}`,
      } })
      await extendAcceptance()
      let planningError = null
      try {
        await taskOwner.drive(taskId)
        const failures = await taskOwner.applyPending()
        planningError = failures[0]?.code ?? null
      } catch (cause) { planningError = cause.code ?? cause.message }
      return { taskId, status: 'accepted', reply: planningError
        ? `已更新当前任务要求；执行会话规划受阻：${planningError}。请在任务页查看并处理。`
        : '已更新当前任务要求，执行会话将核对受影响的步骤。' }
    }
    const existingRuns = await store.query({ kind: 'run.list', taskId, limit: 200 })
    if (!existingRuns.length) {
      if (['status', 'result'].includes(action.intent)) return singleTaskProgressResult({ taskId,
        status: currentPlan?.task.status ?? origin.command.status, beforeStart: true,
        reply: `任务尚未开始执行；当前状态：${currentPlan?.task.status ?? origin.command.status}` })
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
      const owner = currentPlan ? await store.query({ kind: 'task.owner', taskId }) : null
      const taskComplete = owner?.decision?.action === 'complete' && owner.applicationStatus === 'applied'
        && currentPlan?.task.planRequirementRevision === currentPlan?.task.requirementRevision
        && owner.eventWatermark === owner.processedWatermark
      const status = currentPlan ? taskComplete ? 'succeeded' : currentPlan.task.status : state.run.status
      return singleTaskProgressResult({ taskId, runId: state.run.runId, status, observedAt: new Date().toISOString(), output,
        reply: action.intent === 'result' && workflowResultText(output)
          ? `${taskComplete ? '任务结果' : '当前流程结果'}：${workflowResultText(output)}`
          : `任务状态：${status}${state.run.recoveryReason ? `；等待原因：${state.run.recoveryReason}` : ''}` })
    }
    if (action.intent === 'cancel') await controller.stop({ ...args, reason: info.unit.goalText })
    else if (action.intent === 'pause') await controller.pause({ ...args, reason: info.unit.goalText })
    else if (action.intent === 'resume') await controller.resume(args)
    else if (action.intent === 'revise') {
      const previous = await artifacts.read(state.run.requirementRef)
      await controller.changeInput({ ...args, inputId: info.commandId, sourceKey: info.run.sourceKey,
        input: { ...previous, request: requireText(action.arguments.objective, 'WORKFLOW_OBJECTIVE_REQUIRED'),
          constraints: [...new Set([...(previous.constraints ?? []), ...(action.constraints ?? [...(info.unit.constraints ?? []), ...(info.unit.sharedConstraints ?? [])])])] } })
      if (currentPlan) await recordIntent()
    } else throw executionError('WORKFLOW_ACTION_NOT_ADMITTED')
    const observed = await controller.state(state.run.runId)
    return { taskId, runId: state.run.runId, status: observed.run.status, reply: `已记录${action.intent}请求；当前状态：${observed.run.status}` }
  }
  const handlers = Object.fromEntries(['cancel', 'pause', 'resume', 'revise', 'report', 'reopen', 'status', 'result'].map(kind => [kind, taskAction]))
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
  handlers.fact = async (action, info) => {
    const topic = await store.query({ kind: 'message.topic', topicId: action.binding.topicId })
    const taskId = info.binding.taskId ?? action.taskId
    if (taskId) {
      const origin = await store.query({ kind: 'message.task', taskId })
      if (origin?.run.conversationId === info.run.conversationId
        && await store.query({ kind: 'task.owner', taskId }))
        await taskOwner.event({ taskId, eventKey: `topic-fact:${info.commandId}`,
          eventType: action.arguments.kind === 'constraint' ? 'intent.received' : 'topic.fact',
          payload: { sourceKey: info.run.sourceKey, actorId: info.run.actorId,
            kind: action.arguments.kind, text: action.arguments.text } })
    }
    return { status: 'recorded', sourceKey: info.run.sourceKey, topic }
  }
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
  async function passiveTopic(run) {
    const quotes = run.context?.quoteRefs ?? []
    if (!quotes.length || quotes.length > 4) return null
    const matches = new Map()
    for (const quote of quotes) {
      if (!quote.messageId || !quote.sourceKey) continue
      const sourceKeys = [quote.sourceKey]
      const notification = await store.query({ kind: 'message.outboundByMessage', conversationId: run.conversationId, messageId: quote.messageId })
      if (notification?.status === 'delivered' && notification.evidence?.messageId === quote.messageId && notification.payload?.sourceMessageId)
        sourceKeys.push(sourceKey(config.profile ?? '', run.conversationId, notification.payload.sourceMessageId))
      for (const item of legacyGroup(run.conversationId)?.outbox ?? [])
        if (item.status === 'sent' && item.deliveredMessageId === quote.messageId && item.sourceMessageId)
          sourceKeys.push(sourceKey(config.profile ?? '', run.conversationId, item.sourceMessageId))
      for (const evidenceSourceKey of new Set(sourceKeys)) {
        const evidence = await store.query({ kind: 'message.source', sourceKey: evidenceSourceKey })
        if (!evidence || evidence.conversationId !== run.conversationId || evidence.sourceKey === run.sourceKey) continue
        const topics = await store.query({ kind: 'message.topic.source', sourceKey: evidenceSourceKey })
        for (const topic of topics.filter(item => item.conversationId === run.conversationId))
          matches.set(topic.topicId, { topicId: topic.topicId, evidenceSourceKey, quoteMessageId: quote.messageId })
      }
    }
    return matches.size === 1 ? matches.values().next().value : null
  }
  const messages = createMessageWorkflow({ store, judge: messageJudge, policy: config.policy, handlers,
    context: {
      passiveTopic,
      async authorizePriorityControl({ run, unit, binding }) {
        const taskId = binding?.taskId ?? binding?.target?.taskId
        if (!taskId || binding?.disposition !== 'existing') return null
        const origin = await store.query({ kind: 'message.task', taskId })
        if (!origin || origin.run.conversationId !== run.conversationId || origin.run.actorId !== run.actorId) return null
        const text = unit.goalText?.trim().replace(/^@\S+\s*/u, '') ?? ''
        const actions = [
          [/^(?:暂停|先停|先暂停)(?:这个|该|当前)?任务[。！!]?$/u, 'pause'],
          [/^(?:取消|停止)(?:这个|该|当前)?任务[。！!]?$/u, 'cancel'],
          [/^(?:恢复|继续)(?:这个|该|当前)?任务[。！!]?$/u, 'resume'],
        ].filter(([pattern]) => pattern.test(text))
        return actions.length === 1 ? { taskId, action: actions[0][1] } : null
      },
      async validateAction(action, info) {
        const reject = reason => ({ allowed: false, reason })
        if (info.binding.engine === 'legacy') {
          const task = legacy.getTask?.(info.binding.taskId)
          if (!task || task.groupId !== info.run.conversationId) return reject('无权读取该旧任务')
          return ['status', 'result', 'no_action', 'fact'].includes(action.intent) ? { allowed: true } : reject('旧任务只读，请明确发起新工作流任务')
        }
        if (!handlers[action.intent] && action.intent !== 'no_action') return reject(`尚未提供 ${action.intent} 处理流程`)
        if (['create', 'research', 'reopen'].includes(action.intent) && !await mayCreate(info.run, action.arguments.workflowId, info.binding)
          && !await ownerConfirmedPriorTask(action, info)) return reject('当前消息发送人没有创建业务任务的权限')
        if (['create', 'research', 'answer', 'reopen'].includes(action.intent)
          && !action.arguments.objective?.trim()) return reject('任务目标未明确')
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
          result.push({ candidateId: `legacy:${task.taskId}`, engine: 'legacy', taskId: task.taskId, title: task.title ?? task.objective ?? task.taskId, goal: task.objective ?? task.title ?? task.taskId, state: task.state,
            historyRef: `task-history:${task.taskId}`,
            relevantTime: task.updatedAt ?? task.completedAt ?? task.createdAt ?? null, versions: { inputVersion: task.inputVersion ?? 1, runSequence: task.runSequence ?? 1 }, sourceRefs: references,
            explicitReferenceMatches: references.filter(key => quoted.has(key)), distinguishingFacts: [`旧引擎任务状态：${task.state}；结果：${task.outcome ?? '未记录'}；UAT2：${task.result?.delivery?.uat2Status ?? '未见部署回执'}；仅支持只读查询`] })
        }
        const previous = run.snapshot?.history?.at(-1)
        const recentReference = /^(?:这|这个|刚才|上面|前面|不是让你)/u.test(run.body.trim())
          && previous?.actorId === run.actorId ? previous.sourceKey : null
        rankMessageCandidates(result, unit.goalText, recentReference)
        const cards = result.slice(0, 8).map((card, index) => {
          if (index > 1 || card.engine !== 'legacy') return card
          const task = legacy.getTask?.(card.taskId)
          const lastChange = task?.objectiveHistory?.at(-1)?.objective
          return { ...card, distinguishingFacts: [...card.distinguishingFacts,
            `最近目标：${String(lastChange ?? task?.objective ?? task?.title ?? '').slice(0, 160)}`,
            `结果：${String(task?.outcome ?? task?.result ?? '未记录').slice(0, 120)}`] }
        })
        for (const card of cards) {
          if (!card.taskId || card.engine === 'legacy') continue
          let origin
          try { origin = await taskAccess(card.taskId, run.actorId, run.conversationId) }
          catch (error) { if (error.code === 'WORKFLOW_TASK_FORBIDDEN') continue; throw error }
          const facts = await taskFacts(origin)
          if (facts.result?.outputRef) card.resultRef = facts.result.outputRef
          card.distinguishingFacts.push(`执行状态：${facts.status}；业务目标：${facts.objectiveAssessment.status}`)
          if (facts.result?.summary) card.distinguishingFacts.push(`已执行结果：${facts.result.summary.slice(0, 240)}`)
          if (facts.result?.limitations?.length) card.distinguishingFacts.push(`结果限制：${facts.result.limitations.slice(0, 4).join('；')}`)
        }
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
          return { topic, ...(await topicTaskFacts(topic, run)), availableWorkflows: [...readOnlyCatalog, ...generalCatalog, ...engineering.availableWorkflows(), ...externalWorkflows], unavailableWorkflows, actorMayCreate: await mayCreate(run, 'task-investigation', binding) }
        }
        if (!binding.taskId) return { availableWorkflows: [...readOnlyCatalog, ...generalCatalog, ...engineering.availableWorkflows(), ...externalWorkflows], unavailableWorkflows, actorMayCreate: await mayCreate(run, 'task-investigation', binding) }
        await taskAccess(binding.taskId, run.actorId, run.conversationId)
        const origin = await store.query({ kind: 'message.task', taskId: binding.taskId })
        const detail = await taskFacts(origin, binding.runId)
        return { ...(topic ? { topic } : {}), task: detail,
          ...(topic ? { topicTasks: await topicTaskFacts(topic, run) } : {}) }
      },
      async validateActions({ run, unit, binding, intent, requests }) {
        for (const action of intent.actions.filter(item => item.intent === 'clarification')) {
          const target = action.arguments.runId === run.runId ? await messages.state(run.runId)
            : await messages.state(action.arguments.runId).catch(() => null)
          const request = target?.requests.find(item => item.id === action.arguments.requestId)
          if (!request || request.kind !== 'needs_clarification' || request.status !== 'pending') return {
            kind: 'needs_clarification', reason: 'CLARIFICATION_TARGET_INVALID',
            question: '这条消息没有可确认的待答澄清，请明确所指的排查事项。', needs: [],
          }
        }
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
      async bindTopic({ run, unit, binding, facts }) {
        const topicId = binding.topicId ?? (binding.disposition === 'conversation'
          ? `topic-${executionDigest([run.conversationId, 'conversation']).slice(0, 32)}`
          : `topic-${executionDigest([run.runId, unit.unitId]).slice(0, 32)}`)
        const topic = await store.query({ kind: 'message.topic', topicId })
        if (topic && topic.conversationId !== run.conversationId) throw executionError('WORKFLOW_TOPIC_FORBIDDEN')
        const sourceRefs = [{ sourceKey: run.sourceKey, sourceVersion: run.sourceVersion, text: run.body }]
        return { topicId, conversationId: run.conversationId, sourceRunId: run.runId, unitId: unit.unitId,
          title: topic?.title ?? facts?.topic?.title ?? unit.goalText,
          ...(topic ? { expectedRevision: topic.revision } : {}),
          facts: [{ kind: 'fact', text: unit.spans.map(span => run.body.slice(span.start, span.end)).join('\n'), sourceRefs }] }
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
            let origin
            try { origin = await taskAccess(taskId, run.actorId, run.conversationId) }
            catch (error) {
              if (error.code !== 'WORKFLOW_TASK_FORBIDDEN') throw error
              items.push({ resourceRef: need.resourceRef, unavailable: 'not_authorized' })
              continue
            }
            await remember(need.resourceRef, JSON.stringify(await taskFacts(origin)))
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
          const runs = await store.query({ kind: 'run.list', taskId: barrier.targetTaskId, limit: 1 })
          if (!runs.length) return
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
    const ownerAnswer = identity.actorId === ownerActorId
    if (!request.permittedActors?.includes(identity.actorId) && !ownerAnswer) throw executionError('WORKFLOW_ACTION_FORBIDDEN')
    const answer = requireText(input.answer, 'WORKFLOW_ANSWER_REQUIRED')
    const result = await messages.resume({ runId: data.run.runId, requestId: request.id,
      eventId: requireText(input.eventId, 'WORKFLOW_EVENT_REQUIRED'), actorId: identity.actorId, answer, ownerAnswer })
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
    if (!item.request.permittedActors?.includes(message.senderOpenDingTalkId)
      && message.senderOpenDingTalkId !== ownerActorId) return null
    const eventId=sourceKey(config.profile ?? '', message.groupId, message.messageId)
    const duplicate=await store.query({kind:'message.source',sourceKey:eventId})
    if(duplicate&&duplicate.status!=='superseded')await store.command({id:`clarification-fold:${duplicate.runId}:${item.request.id}`,kind:'message.clarification.fold',args:{runId:duplicate.runId,targetRunId:item.run.runId,requestId:item.request.id,eventId,replyToMessageId:messageId}})
    return resumeRequest({ runId: item.run.runId, requestId: item.request.id, eventId, answer: message.text }, { channel: 'im', actorId: message.senderOpenDingTalkId, conversationId: message.groupId })
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
    const byTask = new Map()
    for (const run of runs) {
      const group = byTask.get(run.taskId) ?? []
      group.push(run)
      byTask.set(run.taskId, group)
    }
    const owners = await store.query({ kind: 'task.owners.list', limit: 200 })
    for (const owner of owners) if (!byTask.has(owner.taskId)) byTask.set(owner.taskId, [])
    return Promise.all([...byTask].map(async ([taskId, taskRuns]) => {
      const plan = await controller.taskPlan(taskId)
      const currentStage = plan?.stages.find(stage => !['succeeded', 'invalidated'].includes(stage.status)) ?? plan?.stages.at(-1)
      const run = taskRuns.find(item => item.runId === currentStage?.runId) ?? taskRuns[0]
      const origin = await store.query({ kind: 'message.task', taskId })
      const owner = owners.find(item => item.taskId === taskId)
      const ownerComplete = owner?.decision?.action === 'complete' && owner.applicationStatus === 'applied'
        && plan?.task.planRequirementRevision === plan?.task.requirementRevision
        && owner.eventWatermark === owner.processedWatermark
      const state = run ? await controller.state(run.runId) : null
      const firstRun = plan?.stages[0]?.runId
        ? taskRuns.find(item => item.runId === plan.stages[0].runId) ?? await store.query({ kind: 'run', runId: plan.stages[0].runId }).then(item => item.run)
        : taskRuns.at(-1)
      const requirementRef = plan?.task.requirementRef ?? firstRun?.requirementRef ?? plan?.stages[0]?.requirementRef
      const requirement = requirementRef ? await artifacts.read(requirementRef) : null
      const outputRef = currentStage?.outputRef ?? state?.nodes.filter(node => node.outputRef).at(-1)?.outputRef
      const output = outputRef ? await artifacts.read(outputRef) : null
      const planState = plan?.task.status
      return { taskId, engine: 'workflow-v2', workflowId: run?.workflowId ?? currentStage?.workflowId,
        workflowVersion: run?.definitionVersion, groupId: origin?.run.conversationId,
        title: requirement?.request ?? origin?.command.args.arguments?.objective ?? taskId,
        objective: requirement?.request ?? origin?.command.args.arguments?.objective ?? taskId,
        inputVersion: (run?.revision ?? 0) + 1, runSequence: taskRuns.length,
        state: ownerComplete ? 'completed' : owner?.status === 'blocked' || planState === 'blocked' || planState === 'waiting_confirmation'
          || planState === 'succeeded' ? 'waiting' : !run ? 'queued'
          : terminal(run.status) && !plan ? 'completed' : state.controllerError ? 'waiting'
            : run.status === 'running' ? 'running' : run.status === 'queued' ? 'queued' : 'waiting',
        outcome: ownerComplete ? 'succeeded' : plan ? undefined : run && terminal(run.status) ? run.status : undefined,
        createdAt: plan?.task.createdAt ?? run?.createdAt, updatedAt: plan?.task.updatedAt ?? run?.updatedAt,
        result: workflowResultText(output),
        waitingReason: owner?.lastFailure ? `任务负责会话受阻：${owner.lastFailure}`
          : currentStage?.unavailableReason ?? (currentStage?.status === 'waiting_confirmation' ? '等待阶段确认' : null)
          ?? state?.controllerError ?? run?.recoveryReason ?? state?.nodes.find(node => node.status === 'waiting')?.waitReason?.reference,
        taskRunId: run?.runId ?? null,
        stageTasks: state?.nodes.map(node => node.nodeId) ?? [], topicRefs: [], checkpoints: [],
        executionNodes: state?.nodes ?? [], childSessionId: owner?.sessionId ?? state?.nodes.findLast(node => node.sessionId)?.sessionId,
        taskOwner: owner ? { sessionId: owner.sessionId, status: owner.status, decision: owner.decision?.action ?? null,
          eventWatermark: owner.eventWatermark, processedWatermark: owner.processedWatermark } : null,
        ...(plan ? { plan: { version: plan.task.planRevision, currentStageId: currentStage?.stageId ?? null,
          stages: plan.stages.map(stage => ({ stageId: stage.stageId,
            title: taskWorkflowCatalog.find(item => item.id === stage.workflowId)?.label ?? stage.stageId,
            status: stage.status, workflowId: stage.workflowId, runId: stage.runId, outputRef: stage.outputRef })) } } : {}),
      }
    }))
  }
  let messageRecoveryFlight, taskRecoveryFlight, taskRecoveryCursor
  async function recoverTasks() {
    const failures = []
    for(const event of await store.query({kind:'message.web-tasks.pending'}))try{await executeWebEvent(event)}catch(error){failures.push({scope:'web-task',eventId:event.id,code:error.code??error.message})}
    let ownerCursor
    do {
      const owners = await store.query({ kind: 'task.owners.list', limit: 100,
        ...(ownerCursor ? { beforeSequenceId: ownerCursor } : {}) })
      for (const item of owners) try {
        const plan = await controller.taskPlan(item.taskId)
        if (plan?.stages.some(stage => stage.status === 'running')) await controller.advanceTaskPlan(item.taskId)
        await taskOwner.observe(item.taskId)
      }
      catch (error) { failures.push({ scope: 'task-plan', taskId: item.taskId, code: error.code ?? error.message }) }
      ownerCursor = owners.length === 100 ? owners.at(-1).sequenceId : undefined
    } while (ownerCursor)
    let planCursor
    do {
      const plans = await controller.pendingTaskPlans({ limit: 100,
        ...(planCursor ? { beforeSequenceId: planCursor } : {}) })
      for (const plan of plans) if (!await store.query({ kind: 'task.owner', taskId: plan.taskId })) {
        try { await advanceBusinessTask(plan.taskId) }
        catch (error) { failures.push({ scope: 'legacy-task-plan', taskId: plan.taskId, code: error.code ?? error.message }) }
      }
      planCursor = plans.length === 100 ? plans.at(-1).sequenceId : undefined
    } while (planCursor)
    const page = await store.query({ kind: 'run.list', limit: 200, activeOnly: true, ...(taskRecoveryCursor ? { beforeSequenceId: taskRecoveryCursor } : {}) })
    taskRecoveryCursor = page.length === 200 ? page.at(-1).sequenceId : undefined
    for (const run of page) {
      if (terminal(run.status) || run.pauseRequested || run.status === 'running') continue
      try {
        if (run.status === 'waiting') {
          const state = await store.query({ kind: 'run', runId: run.runId })
          if (state.nodes?.some(node => ['ENGINEERING_VERIFICATION_FAILED', 'ENGINEERING_INDEX_CAPACITY_EXCEEDED', 'EXECUTION_BUDGET_EXHAUSTED', 'EDIT_PREPARED_INVALID', 'ENGINEERING_EDIT_SCOPE_MISMATCH', 'ENGINEERING_NO_CHANGES_PROPOSED'].includes(node.waitReason?.reference))) continue
        }
        await controller.recover({ commandId: `recover:${run.runId}:${run.revision}:${run.claimCount}`, runId: run.runId })
      }
      catch (error) { if (error.code !== 'EXECUTOR_STILL_ACTIVE') failures.push({ scope: 'task', runId: run.runId, code: error.code ?? error.message }) }
    }
    failures.push(...await taskOwner.recover())
    return failures
  }
  async function recoverAll() {
    // 三条恢复通路独立：消息等模型或投递等连接器时，不占住其它通路下一轮恢复。
    const results = await Promise.allSettled([
      messageRecoveryFlight ??= messages.recover().finally(() => { messageRecoveryFlight = undefined }),
      recoverExecutionTasks(),
      notifier.flush(),
    ])
    const failures = results.flatMap((result, index) => result.status === 'rejected'
      ? [{ scope: ['messages', 'tasks', 'notifications'][index], code: result.reason.code ?? result.reason.message }]
      : index === 1 ? result.value : [])
    return { failures }
  }
  function recoverExecutionTasks() {
    return taskRecoveryFlight ??= recoverTasks().finally(() => { taskRecoveryFlight = undefined })
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
          : !available ? { reason: '受信平台目标、客户端或验证未齐，当前不能发起' } : {}),
      }
    })
  }
  const messageStages = [{ id: 'receive', label: '接收消息' }, { id: 'context', label: '补全上下文' }, { id: 'S', label: '拆分事项' }, { id: 'R', label: '关联话题' },
    { id: 'routing-barrier', label: '等待新消息归类' }, { id: 'IB', label: '按话题判断意图' }, { id: 'intent-check', label: '检查话题新输入' }, { id: 'dispatch', label: '派发任务' }]
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
          const workflowStatus = ['routing_blocked', 'intent_blocked'].includes(run.routingStatus) || run.intentStatus === 'intent_blocked' ? 'routing_blocked'
            : run.routingStatus === 'routing_pending' ? 'routing' : run.intentStatus ?? (run.status === 'needs_attention' ? 'routing_blocked' : run.status === 'settled' ? 'processed' : 'routing')
          messages.push({ groupId, messageId: run.context?.sourceMessageId, text: run.body, senderOpenDingTalkId: run.actorId,
            senderName: run.context?.senderName ?? senderNames.get(run.actorId), occurredAt: run.context?.occurredAt ?? run.createdAt, sequence: run.sequenceId,
            topicRefs, workflowStatus, ...(run.reason ? { workflowStatusDetail: run.reason } : {}),
            routingStatus: run.status === 'needs_attention' ? 'failed' : run.reason === 'message_quiet' && isPassiveTaskProgress(run.body) && !topicRefs.length ? 'pending' : ['settled', 'superseded'].includes(run.status) ? 'routed' : 'pending' })
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
          deliveryAttemptCount: notice.leaseEpoch, ...(notice.status === 'unknown' ? { deliveryPendingReason: 'send_unknown' } : {}),
          ...(notice.status === 'acknowledged' ? { deliveryPendingReason: 'message_not_observed' } : {}) })
        for (const replacement of await store.query({ kind: 'message.notificationReplacements', notificationId: notice.id }))
          outbox.push({ groupId, outboundId: `replacement:${replacement.id}`, text: replacement.body,
            sourceMessageId: replacement.sourceMessageId, deliveredMessageId: replacement.messageId,
            replacesNotificationId: notice.id, status: 'sent', createdAt: replacement.recordedAt, deliveredAt: replacement.recordedAt })
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
    const refs=[...new Set([...topic.facts.flatMap(fact=>fact.sourceRefs.map(ref=>ref.sourceKey)),...await store.query({kind:'message.topic.sources',topicId})])]
    const messages=(await Promise.all(refs.map(key=>store.query({kind:'message.source',sourceKey:key})))).filter(Boolean)
      .map(run=>({messageId:run.context?.sourceMessageId,text:run.body,senderName:run.context?.senderName,occurredAt:run.context?.occurredAt??run.createdAt,sourceKind:'workflow-v2'}))
      .sort((a,b)=>String(a.occurredAt).localeCompare(String(b.occurredAt)))
    return {topic,messages:messages.slice(offset,offset+limit),total:messages.length,offset,limit}
  }
  return {
    ingest, resumeRequest, reprocessMessage, decideApproval, isApprovalRequest, listApprovalRequests, submitWebTask, mailboxes, topics, topicContext,
    prepareWorkflowNotificationOperation, executeWorkflowNotificationOperation, reconcileWorkflowNotificationOperation,
    isTask: async taskId => !!await store.query({kind:'message.task',taskId}), messages, execution, tasks, isGroup: id => groups.has(id), flushNotifications: () => notifier.flush(),
    catalog: () => ({ engine: 'workflow-v2', groupIds: [...groups], messageStages, builtInWorkflows: [taskProgressQueryDefinition], workflows: workflowCatalogState() }),
    async state(runId) { return runId ? messages.state(runId) : { engine: 'workflow-v2', groupIds: [...groups], store: store.info,
      messages: await store.query({ kind: 'message.list', limit: 100 }), tasks: await tasks() } },
    recover: recoverAll, recoverExecutionTasks,
    async close() { closed = true; await messages.close(); await taskOwner.close(); if (!suppliedExecution) await execution.close() },
  }
}
