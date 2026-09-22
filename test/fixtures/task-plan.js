import { prepareTaskPlan } from '../../packages/dingtalk-dsh-assistant/task-plan.js'

// 仅测试使用：显式的一阶段覆盖，不推断真实业务要求间的语义关系。
export function taskPlanFixture({ taskId = 'task-test', inputVersion = 1, runSequence = 1, revision = 1, sourceRefs = [{ messageId: 'm1', messageVersion: 1 }], workflowRefs = [], titles = ['执行并核验'], descriptions = ['结果符合要求'], verificationPolicy = 'semantic' } = {}) {
  const criteria = descriptions.map((description, i) => ({ key: `c${i}`, description, sourceRefs, verificationPolicy }))
  const stages = titles.map((title, i) => ({ key: `s${i}`, title, criterionKeys: criteria.map(item => item.key), dependsOnKeys: i ? [`s${i - 1}`] : [], expectedOutputs: ['核验记录'] }))
  return prepareTaskPlan({ criteria, stages }, { creationId: `${taskId}:${runSequence}:${revision}`, revision, inputVersion, runSequence, sourceRefs, workflowRefs })
}

export function stageOutputFixture(plan, index = 0) {
  const stage = plan.stages[index]
  const artifact = { artifactId: `artifact-${stage.stageId}`, uri: `test://${stage.stageId}`, version: '1' }
  const evidence = { evidenceId: `evidence-${stage.stageId}`, producerKind: 'model', criterionIds: stage.criterionIds, artifactRefs: [artifact.artifactId], sourceRef: `test-receipt-${stage.stageId}`, observedAt: '2026-09-22T00:00:00.000Z', outcome: 'pass', reason: '测试中的模型陈述，不属于独立检查器' }
  return { artifact, evidence, output: { stageId: stage.stageId, planRevision: plan.revision, inputVersion: plan.inputVersion, runSequence: plan.runSequence, artifactRefs: [artifact.artifactId], evidenceRefs: [evidence.evidenceId], blockers: [] } }
}
