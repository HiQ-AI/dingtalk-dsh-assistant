import { executionDigest, executionError } from './execution-artifacts.js'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { selectTaskDeliveryFiles } from './task-group-file-delivery.js'

/** 业务准备合同由各领域提供；只接纳受信函数，不解释模型生成的执行代码。 */
export function createTaskStageContracts({ contracts, controller, artifacts,
  readOwnerContract = id => controller.workflowDefinition(id).ownerContract }) {
  const byId = new Map()
  for (const contract of contracts) {
    if (!contract?.id || !contract.version || typeof contract.prepare !== 'function' || byId.has(contract.id))
      throw executionError('TASK_STAGE_CONTRACT_INVALID')
    if (contract.consumes !== undefined && (!Array.isArray(contract.consumes) || !contract.consumes.length
      || contract.consumes.some(item => !item?.id || !Array.isArray(item.versions) || !item.versions.length
        || item.versions.some(version => typeof version !== 'string' || !version)
        || new Set(item.versions).size !== item.versions.length)
      || new Set(contract.consumes.map(item => item.id)).size !== contract.consumes.length))
      throw executionError('TASK_STAGE_CONTRACT_INVALID')
    byId.set(contract.id, contract)
  }
  return {
    get descriptors() {
      return [...byId.values()].map(({ id, version, materialPolicy, consumes }) => {
        const owner = readOwnerContract(id)
        const resultContract = owner?.resultContract ?? (owner ? { id: owner.id, version: owner.version } : null)
        return { id, version,
          ...(materialPolicy ? { materialPolicy: structuredClone(materialPolicy) } : {}),
          ...(consumes ? { consumes: structuredClone(consumes) } : {}),
          ...(resultContract ? { resultContract: structuredClone(resultContract) } : {}) }
      })
    },
    async prepare(context) {
      const { stage, plan, taskId, requirement } = context
      const contract = byId.get(stage.workflowId)
      if (!contract) throw executionError('TASK_STAGE_CONTRACT_UNAVAILABLE')
      const index = context.stageIndex ?? plan.stages.findIndex(item => item.stageId === stage.stageId)
      if (plan.task.taskId !== taskId || index > 0 && plan.task.planRequirementRevision !== plan.task.requirementRevision)
        throw executionError('TASK_STAGE_REQUIREMENT_STALE')
      const policy = contract.materialPolicy
      const validateMaterials = materials => {
        if (!policy) return
        if (!Array.isArray(materials) || materials.length > policy.maxCount
          || Buffer.byteLength(JSON.stringify(materials), 'utf8') > policy.maxBytes)
          throw executionError('TASK_STAGE_MATERIAL_CAPACITY')
        const roles = materials.map(item => item?.role ?? 'supplemental')
        if (roles.some(role => !policy.roles.includes(role))
          || policy.required.some(role => !roles.includes(role))
          || policy.singleton.some(role => roles.filter(value => value === role).length > 1))
          throw executionError('TASK_STAGE_MATERIAL_ROLE_INVALID')
      }
      validateMaterials(requirement.materials ?? [])
      let handoff = null
      if (index > 0) handoff = await readTaskStageHandoff({ taskId, plan, stage: plan.stages[index - 1], controller, artifacts })
      if (handoff && contract.consumes && !contract.consumes.some(item => item.id === handoff.contract.id
        && item.versions.includes(handoff.contract.version))) throw executionError('TASK_STAGE_HANDOFF_UNSUPPORTED')
      const definitionVersion = stage.workflowDigest
        ? controller.workflowDefinition(stage.workflowId, stage.workflowDigest).version : undefined
      const prepared = await contract.prepare({ ...context, stageIndex: index, handoff, definitionVersion })
      if (!prepared?.input || typeof prepared.input !== 'object') throw executionError('TASK_STAGE_INPUT_INVALID')
      if (prepared.input.materials !== undefined) validateMaterials(prepared.input.materials)
      const definition = controller.workflowDefinition(prepared.workflowId ?? stage.workflowId, stage.workflowDigest ?? undefined)
      const first = definition.nodes[0]
      const mapped = first.mapInput({ requirement: prepared.input, previousOutput: undefined, dependencyOutputs: {} })
      const errors = validateJsonSchemaValue(first.inputSchema, mapped)
      if (errors.length) throw executionError('TASK_STAGE_INPUT_INVALID', errors.join('; '))
      return prepared
    },
  }
}

/** 只从当前计划成功阶段和其冻结定义构造交接；引用存在不构成准入。 */
export async function readTaskStageHandoff({ taskId, plan, stage, controller, artifacts }) {
  if (plan.task.taskId !== taskId || plan.task.planRequirementRevision !== plan.task.requirementRevision
    || !plan.stages.some(item => item.stageId === stage?.stageId && item.runId === stage.runId
      && item.outputRef === stage.outputRef && item.status === 'succeeded')
    || !stage?.outputRef || !stage.runId) throw executionError('TASK_STAGE_HANDOFF_STALE')
  const state = await controller.state(stage.runId), final = state?.nodes?.at(-1)
  if (state?.run?.taskId !== taskId || state.run.runId !== stage.runId || state.run.status !== 'succeeded'
    || state.run.workflowId !== stage.workflowId || state.run.workflowDigest !== stage.workflowDigest
    || state.pendingInputCount || final?.status !== 'succeeded' || final.outputRef !== stage.outputRef
    || final.generation !== state.run.generation) throw executionError('TASK_STAGE_HANDOFF_STALE')
  const owner = controller.workflowDefinition(stage.workflowId, stage.workflowDigest).ownerContract
  if (!owner) throw executionError('WORKFLOW_OWNER_CONTRACT_UNAVAILABLE')
  const value = await artifacts.read(stage.outputRef)
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || owner.resultContract?.requiredFields.some(field => !Object.hasOwn(value, field)))
    throw executionError('WORKFLOW_RESULT_CONTRACT_INVALID')
  return { kind: 'workflow-stage-result', contract: { id: owner.resultContract?.id ?? owner.id,
    version: owner.resultContract?.version ?? owner.version }, taskId,
    requirementRevision: plan.task.requirementRevision, planRevision: plan.task.planRevision,
    stageId: stage.stageId, runId: stage.runId, workflowDigest: stage.workflowDigest, outputRef: stage.outputRef, value }
}

// 只在本进程中把受信合同准备的输入交给 Controller；模型/持久 JSON 不能伪造票据。
const repairAdmissions = new WeakMap()
const requiredContract = context => {
  if (!context.contract) throw executionError('WORKFLOW_OWNER_CONTRACT_UNAVAILABLE')
  return context.contract
}
async function inspectRepair(context) {
  const { contract, stage, state, plan, store } = context
  if (!contract?.inspectRepair) return null
  const inspected = await contract.inspectRepair(context)
  const known = new Set(state.nodes.flatMap(node => [node.outputRef, ...(node.evidenceRefs ?? [])].filter(Boolean)))
  if (!Array.isArray(inspected?.evidenceRefs) || inspected.evidenceRefs.some(ref => !known.has(ref)))
    throw executionError('WORKFLOW_OWNER_ARTIFACT_SCOPE_MISMATCH')
  const effects = await store.query({ kind: 'effect.list', runId: stage.runId })
  return { ...inspected, stageId: stage.stageId, runId: stage.runId,
    repairable: inspected?.repairable === true && plan.task.controlState === 'active'
      && state.run.status === 'waiting' && state.nodes.every(node => node.drained)
      && !state.pendingInputCount && effects.every(effect => ['succeeded', 'failed'].includes(effect.state)),
    repairBinding: { stageId: stage.stageId, runId: stage.runId, generation: state.run.generation,
      runRevision: state.run.revision, requirementRevision: plan.task.requirementRevision } }
}
function assertRepairContext(value, state) {
  if (value?.taskId !== state.run.taskId || value.runId !== state.run.runId || value.generation !== state.run.generation)
    throw executionError('WORKFLOW_REPAIR_CONTEXT_MISMATCH')
}

/** Controller 写入前独立回查资格和准备票据，普通 changeInput 不取得修复权限。 */
export async function validateWorkflowRepairAdmission({ state, plan, definition, repair, input, expectedRevision, store, artifacts, repairAdmission }) {
  const ticket = repairAdmissions.get(repairAdmission)
  if (!ticket || ticket.workflowDigest !== state.run.workflowDigest || ticket.workflowDigest !== definition.digest
    || ticket.inputDigest !== executionDigest(input) || ticket.repairDigest !== executionDigest(repair)
    || expectedRevision !== repair.runRevision) throw executionError('WORKFLOW_REPAIR_NOT_ADMITTED')
  const stage = plan?.stages.find(item => item.stageId === repair.stageId && item.status === 'running')
  if (!stage || plan.task.taskId !== repair.taskId || state.run.taskId !== repair.taskId
    || stage.runId !== state.run.runId || stage.runId !== repair.runId
    || stage.workflowId !== state.run.workflowId || stage.workflowDigest !== state.run.workflowDigest)
    throw executionError('WORKFLOW_REPAIR_NOT_ADMITTED')
  const context = { taskId: repair.taskId, stage, state, plan, contract: definition.ownerContract,
    store: Object.freeze({ query: request => store.query(request) }), artifacts: Object.freeze({ read: ref => artifacts.read(ref) }) }
  const contract = requiredContract(context)
  if (!contract.inspectRepair || !contract.prepareRepair) throw executionError('WORKFLOW_REPAIR_NOT_ADMITTED')
  const observed = await inspectRepair(context)
  const { contextRef, taskId, ...binding } = repair
  if (!observed.repairable || executionDigest(observed.repairBinding) !== executionDigest(binding))
    throw executionError('WORKFLOW_REPAIR_NOT_ADMITTED')
  const material = await artifacts.read(contextRef)
  assertRepairContext(material, state)
  if (ticket.contextDigest !== executionDigest(material)) throw executionError('WORKFLOW_REPAIR_CONTEXT_MISMATCH')
  return state.run.workflowDigest
}

/** 领域合同的公共接入：按冻结定义取规则，公共身份与控制账写入仍由 Host 负责。 */
export function createTaskWorkflowContracts({ controller, store, artifacts, prepareRepairContext, validateFiles, verifyFileDelivery,
  completionPolicy = contract => contract, verifyAcceptance }) {
  const readableStore = Object.freeze({ query: query => store.query(query) })
  const readableArtifacts = Object.freeze({ read: ref => artifacts.read(ref) })
  // 只传递本次真实验收回执给紧接的持久化，不能由模型 JSON 提供；清单变化即失效。
  const verifiedDecisions = new WeakMap()
  async function contextFor(taskId, stage, plan, suppliedState) {
    const state = suppliedState ?? await controller.state(stage.runId)
    if (!state?.run || state.run.taskId !== taskId || state.run.runId !== stage.runId
      || state.run.workflowId !== stage.workflowId || state.run.workflowDigest !== stage.workflowDigest)
      throw executionError('WORKFLOW_OWNER_STAGE_MISMATCH')
    let definition
    try { definition = controller.workflowDefinition(stage.workflowId, stage.workflowDigest) }
    catch (error) { if (error.code !== 'WORKFLOW_VERSION_UNAVAILABLE') throw error }
    return { taskId, stage, state, plan, contract: definition?.ownerContract,
      store: readableStore, artifacts: readableArtifacts }
  }
  async function readDeliveryManifest({ taskId, plan, requirement, decision }) {
    if (!plan || plan.task.taskId !== taskId) throw executionError('WORKFLOW_OWNER_STAGE_MISMATCH')
    const missing = [], entries = [], outputs = [], files = [], states = []
    const current = plan.task.planRequirementRevision === plan.task.requirementRevision
    if (!current) missing.push({ kind: 'requirement', code: 'TASK_STAGE_REQUIREMENT_STALE' })
    if (plan.task.status !== 'succeeded') missing.push({ kind: 'plan', code: 'TASK_DELIVERY_PLAN_INCOMPLETE' })
    for (const stage of plan.stages) {
      if (!current || stage.status !== 'succeeded' || !stage.outputRef) {
        missing.push({ kind: 'stage', stageId: stage.stageId, code: 'TASK_DELIVERY_STAGE_INCOMPLETE' }); continue
      }
      const context = await contextFor(taskId, stage, plan), final = context.state.nodes.at(-1)
      if (context.state.run.status !== 'succeeded' || context.state.pendingInputCount
        || final?.status !== 'succeeded' || final.outputRef !== stage.outputRef
        || final.generation !== context.state.run.generation) throw executionError('WORKFLOW_OWNER_STAGE_MISMATCH')
      const contract = context.contract
      if (!contract) {
        missing.push({ kind: 'stage', stageId: stage.stageId, code: 'WORKFLOW_OWNER_CONTRACT_UNAVAILABLE' }); continue
      }
      const output = await artifacts.read(stage.outputRef), result = contract.resultContract
      const absent = (result?.requiredFields ?? []).filter(field => !output || typeof output !== 'object' || !Object.hasOwn(output, field))
      if (absent.length) missing.push({ kind: 'artifact', stageId: stage.stageId, code: 'WORKFLOW_RESULT_CONTRACT_INVALID', fields: absent })
      outputs.push(output)
      states.push(context.state)
      entries.push({ stageId: stage.stageId, runId: stage.runId, workflowId: stage.workflowId,
        workflowDigest: stage.workflowDigest, outputRef: stage.outputRef,
        contract: { id: contract.id, version: contract.version },
        resultContract: { id: result?.id ?? contract.id, version: result?.version ?? contract.version },
        outputDigest: executionDigest(output), generation: context.state.run.generation,
        ...(context.state.run.revision === undefined ? {} : { runRevision: context.state.run.revision }),
        requiredFields: result?.requiredFields ?? [], valid: absent.length === 0,
        evidenceRefs: [...new Set([stage.outputRef, ...(stage.evidenceRefs ?? [])])] })
    }
    if (!plan.stages.length) missing.push({ kind: 'stage', code: 'TASK_DELIVERY_STAGE_INCOMPLETE' })
    const items = await store.query({ kind: 'task.owner.acceptance', taskId })
    const known = new Set(entries.flatMap(entry => entry.evidenceRefs))
    const assessments = decision?.assessments ?? []
    const acceptance = items.map(item => {
      const matching = assessments.filter(value => value.itemId === item.itemId), assessment = matching[0]
      const evidenceRefs = assessment?.evidenceRefs ?? []
      const verified = matching.length === 1 && assessment.status === 'satisfied' && evidenceRefs.length > 0
        && evidenceRefs.every(ref => known.has(ref))
      if (!verified) missing.push({ kind: 'acceptance', itemId: item.itemId, code: 'TASK_DELIVERY_ACCEPTANCE_UNSATISFIED' })
      return { itemId: item.itemId, criterion: item.criterion,
        status: verified ? 'satisfied' : 'pending', evidenceRefs,
        stageIds: entries.filter(entry => evidenceRefs.some(ref => entry.evidenceRefs.includes(ref))).map(entry => entry.stageId) }
    })
    if (!items.length || assessments.length !== items.length || assessments.some(value => !items.some(item => item.itemId === value.itemId)))
      missing.push({ kind: 'acceptance', code: 'TASK_DELIVERY_ASSESSMENTS_INCOMPLETE' })
    for (const entry of entries) entry.acceptanceItemIds = acceptance.filter(item => item.status === 'satisfied'
      && item.stageIds.includes(entry.stageId)).map(item => item.itemId)
    const required = [...(requirement?.scope?.artifactFiles ?? []), ...(requirement?.fileDelivery?.files ?? [])]
    const unique = [...new Map(required.map(item => [JSON.stringify([item.role, item.fileName]), item])).values()]
    for (const item of unique) {
      let selected
      try { selected = selectTaskDeliveryFiles(outputs, { taskId, requirementRevision: plan.task.requirementRevision, fileDelivery: { files: [item] } }) }
      catch (error) {
        if (error.code !== 'TASK_REQUIRED_FILE_MISSING_OR_AMBIGUOUS') throw error
        missing.push({ kind: 'file', ...item, code: error.code }); continue
      }
      if (!validateFiles) { missing.push({ kind: 'file', ...item, code: 'TASK_DELIVERY_FILE_VERIFIER_UNAVAILABLE' }); continue }
      const file = selected[0]
      const producer = entries.find((entry, index) => {
        try { return selectTaskDeliveryFiles([outputs[index]], { taskId, requirementRevision: plan.task.requirementRevision,
          fileDelivery: { files: [item] } })[0].artifactId === file.artifactId } catch (error) {
          if (error.code !== 'TASK_REQUIRED_FILE_MISSING_OR_AMBIGUOUS') throw error
          return false
        }
      })
      const state = states[entries.indexOf(producer)]
      if (file.producer?.runId !== producer.runId
        || !state.nodes.some(node => node.nodeRunId === file.producer?.nodeRunId && node.status === 'succeeded'
          && node.generation === state.run.generation)) throw executionError('TASK_DELIVERY_FILE_PRODUCER_MISMATCH')
      files.push({ ...file, stageId: producer.stageId, runId: producer.runId, outputRef: producer.outputRef,
        acceptanceItemIds: producer.acceptanceItemIds })
      if (!producer.acceptanceItemIds.length) missing.push({ kind: 'file', ...item, code: 'TASK_DELIVERY_FILE_ASSESSMENT_REQUIRED' })
    }
    // 使用原始描述符一次验证整个批次，保留总大小/数量和摘要边界。
    if (files.length) {
      const descriptors = files.map(({ stageId, runId, outputRef, acceptanceItemIds, ...file }) => file)
      const verified = await validateFiles(descriptors, { taskId, requirementRevision: plan.task.requirementRevision })
      if (!Array.isArray(verified) || executionDigest(verified) !== executionDigest(descriptors))
        throw executionError('TASK_DELIVERY_FILE_VERIFICATION_FAILED')
    }
    if (requirement?.fileDelivery && (!verifyFileDelivery || await verifyFileDelivery(plan, requirement) !== true))
      missing.push({ kind: 'delivery', code: 'TASK_DELIVERY_FILE_RECEIPT_REQUIRED' })
    const manifest = { kind: 'task-delivery-manifest', version: 1, taskId, requirementRevision: plan.task.requirementRevision,
      planRevision: plan.task.planRevision, validation: 'structure-and-evidence-binding',
      complete: missing.length === 0, missing, artifacts: entries, files, acceptance,
      businessValidation: { status: 'unverified', policy: 'domain-items-v1', items: [] } }
    const verified = decision && verifiedDecisions.get(decision)
    if (verified && verified.manifestDigest === executionDigest(manifest)
      && verified.decisionDigest === executionDigest(decision)) manifest.businessValidation = structuredClone(verified.receipt)
    return manifest
  }
  return {
    readDeliveryManifest,
    async readStageArtifacts({ taskId, stage, state, plan }) {
      const context = await contextFor(taskId, stage, plan, state)
      if (context.state.run.status !== 'succeeded' || context.state.nodes.at(-1)?.outputRef !== stage.outputRef)
        throw executionError('WORKFLOW_OWNER_STAGE_MISMATCH')
      // 旧终态仍可读原引用；未绑定合同不能套当前领域扩展。
      return context.contract?.readArtifacts ? context.contract.readArtifacts(context) : {}
    },
    async authorizeCompletion({ taskId, decision, plan, requirement }) {
      if (decision && typeof decision === 'object') verifiedDecisions.delete(decision)
      if (!plan?.stages.length || plan.task.status !== 'succeeded'
        || plan.task.planRequirementRevision !== plan.task.requirementRevision
        || plan.stages.some(stage => stage.status !== 'succeeded' || !stage.outputRef)) return false
      const contexts = []
      for (const stage of plan.stages) {
        const context = await contextFor(taskId, stage, plan)
        requiredContract(context)
        const final = context.state.nodes.at(-1)
        if (context.state.run.status !== 'succeeded' || final?.status !== 'succeeded' || final.outputRef !== stage.outputRef) return false
        contexts.push({ ...context, output: await artifacts.read(stage.outputRef),
          ...(context.state.run.requirementRef ? { input: await artifacts.read(context.state.run.requirementRef) } : {}) })
      }
      const known = new Set(plan.stages.flatMap(stage => [stage.outputRef, ...(stage.evidenceRefs ?? [])]))
      const items = await store.query({ kind: 'task.owner.acceptance', taskId })
      if (!decision.evidenceRefs?.length || !decision.evidenceRefs.every(ref => known.has(ref))
        || !items.length || decision.assessments?.length !== items.length
        || !items.every(item => decision.assessments.some(assessment => assessment.itemId === item.itemId
          && assessment.status === 'satisfied' && assessment.evidenceRefs?.length
            && assessment.evidenceRefs.every(ref => known.has(ref) && decision.evidenceRefs.includes(ref))))) return false
      const manifest = await readDeliveryManifest({ taskId, plan, requirement, decision })
      if (!manifest.complete) return false
      const stages = contexts.map(context => ({ stage: context.stage, output: context.output,
        input: context.input, contractId: context.contract.id }))
      const receipts = []
      // 引用只分派验收责任，不证明满足。各领域只收到自己负责的条目和证据。
      for (const contractId of new Set(stages.map(item => item.contractId))) {
        const domainStages = stages.filter(item => item.contractId === contractId)
        const domainRefs = new Set(domainStages.flatMap(item => [item.stage.outputRef, ...(item.stage.evidenceRefs ?? [])]))
        const acceptanceItems = items.flatMap(item => {
          const assessment = decision.assessments.find(value => value.itemId === item.itemId)
          const evidenceRefs = assessment.evidenceRefs.filter(ref => domainRefs.has(ref))
          return evidenceRefs.length ? [{ itemId: item.itemId, criterion: item.criterion, evidenceRefs }] : []
        })
        const domainDecision = { ...decision,
          evidenceRefs: decision.evidenceRefs.filter(ref => domainRefs.has(ref)),
          assessments: acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied', evidenceRefs: item.evidenceRefs })) }
        const domainRequirement = { ...requirement, acceptanceCriteria: acceptanceItems.map(item => item.criterion), acceptanceItems }
        let domainVerification
        const verifyDomain = typeof verifyAcceptance === 'function'
          ? context => domainVerification ??= Promise.resolve().then(() => verifyAcceptance(context)) : undefined
        for (const context of contexts.filter(item => item.contract.id === contractId)) {
          const policy = completionPolicy(context.contract)
          if (!policy || await policy.validateCompletion({ ...context, requirement: domainRequirement,
            decision: domainDecision, stages: domainStages, acceptanceItems, verifyAcceptance: verifyDomain }) !== true) return false
        }
        for (const item of acceptanceItems) receipts.push({ ...item, validators: domainStages.map(value => {
          const contract = completionPolicy(contexts.find(context => context.stage.stageId === value.stage.stageId).contract)
          return { stageId: value.stage.stageId, runId: value.stage.runId, workflowDigest: value.stage.workflowDigest,
            outputRef: value.stage.outputRef, contract: { id: contract.id, version: contract.version },
            policyDigest: executionDigest({ id: contract.id, version: contract.version, rulesDigest: contract.rulesDigest ?? null,
              validateCompletion: contract.validateCompletion.toString() }) }
        }) })
      }
      verifiedDecisions.set(decision, { decisionDigest: executionDigest(decision), manifestDigest: executionDigest(manifest),
        receipt: { status: 'accepted', policy: 'domain-items-v1', items: receipts } })
      return true
    },
    async inspectCurrentExecution(taskId, suppliedPlan) {
      const plan = suppliedPlan ?? await controller.taskPlan(taskId)
      const stage = plan?.stages.find(item => item.status === 'running')
      if (!stage?.runId) return null
      const context = await contextFor(taskId, stage, plan)
      return inspectRepair(context)
    },
    async repairCurrentStage({ taskId, decision, commandId }) {
      const replay = await store.query({ kind: 'receipt', commandId })
      if (replay) return replay
      const plan = await controller.taskPlan(taskId)
      const stage = plan?.stages.find(item => item.status === 'running')
      if (!stage?.runId) throw executionError('WORKFLOW_REPAIR_NOT_ADMITTED')
      const context = await contextFor(taskId, stage, plan), contract = requiredContract(context)
      if (!contract.inspectRepair || !contract.prepareRepair) throw executionError('WORKFLOW_REPAIR_NOT_ADMITTED')
      const observed = await inspectRepair(context)
      if (!observed?.repairable || executionDigest(observed.repairBinding) !== executionDigest(decision.repair)
        || !decision.evidenceRefs?.length || !decision.evidenceRefs.every(ref => observed.evidenceRefs.includes(ref)))
        throw executionError('WORKFLOW_REPAIR_NOT_ADMITTED')
      const requirement = await artifacts.read(plan.task.requirementRef)
      const prepared = await contract.prepareRepair({ ...context, requirement, observed, prepareRepairContext })
      const material = await artifacts.read(prepared.contextRef)
      assertRepairContext(material, context.state)
      const repair = { ...observed.repairBinding, taskId, contextRef: prepared.contextRef }
      const repairAdmission = Object.freeze({})
      repairAdmissions.set(repairAdmission, { workflowDigest: stage.workflowDigest, inputDigest: executionDigest(prepared.input),
        repairDigest: executionDigest(repair), contextDigest: executionDigest(material) })
      return controller.changeInput({ commandId, runId: stage.runId, inputId: commandId, sourceKey: commandId,
        input: prepared.input, expectedRevision: observed.repairBinding.runRevision, repair, repairAdmission })
    },
  }
}
