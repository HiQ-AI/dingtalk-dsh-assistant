import { executionDigest, executionError } from './execution-artifacts.js'

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
export function createTaskWorkflowContracts({ controller, store, artifacts, prepareRepairContext }) {
  const readableStore = Object.freeze({ query: query => store.query(query) })
  const readableArtifacts = Object.freeze({ read: ref => artifacts.read(ref) })
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
  return {
    async readStageArtifacts({ taskId, stage, state, plan }) {
      const context = await contextFor(taskId, stage, plan, state)
      if (context.state.run.status !== 'succeeded' || context.state.nodes.at(-1)?.outputRef !== stage.outputRef)
        throw executionError('WORKFLOW_OWNER_STAGE_MISMATCH')
      // 旧终态仍可读原引用；未绑定合同不能套当前领域扩展。
      return context.contract?.readArtifacts ? context.contract.readArtifacts(context) : {}
    },
    async authorizeCompletion({ taskId, decision, plan, requirement }) {
      if (!plan?.stages.length || plan.task.status !== 'succeeded'
        || plan.task.planRequirementRevision !== plan.task.requirementRevision
        || plan.stages.some(stage => stage.status !== 'succeeded' || !stage.outputRef)) return false
      const contexts = []
      for (const stage of plan.stages) {
        const context = await contextFor(taskId, stage, plan)
        requiredContract(context)
        const final = context.state.nodes.at(-1)
        if (context.state.run.status !== 'succeeded' || final?.status !== 'succeeded' || final.outputRef !== stage.outputRef) return false
        contexts.push({ ...context, output: await artifacts.read(stage.outputRef) })
      }
      const known = new Set(plan.stages.flatMap(stage => [stage.outputRef, ...(stage.evidenceRefs ?? [])]))
      const items = await store.query({ kind: 'task.owner.acceptance', taskId })
      if (!decision.evidenceRefs?.length || !decision.evidenceRefs.every(ref => known.has(ref))
        || !items.length || decision.assessments?.length !== items.length
        || !items.every(item => decision.assessments.some(assessment => assessment.itemId === item.itemId
          && assessment.status === 'satisfied' && assessment.evidenceRefs?.length
          && assessment.evidenceRefs.every(ref => known.has(ref))))) return false
      const stages = contexts.map(context => ({ stage: context.stage, output: context.output, contractId: context.contract.id }))
      for (const context of contexts) if (await context.contract.validateCompletion({ ...context, requirement, decision, stages }) !== true) return false
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
