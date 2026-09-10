import { z } from 'zod'
import { toToolJsonSchema } from './tool-schema.js'

export function assertCurrentTaskPrompts(task, prompts) {
  const current = new Map(prompts.filter((item) => item.enabled).map((item) => [item.id, item.revision]))
  for (const ref of task.taskPromptRefs ?? []) {
    if (current.get(ref.id) !== ref.revision) throw new Error(`task_prompt_selection_stale:${ref.id}`)
  }
}

export const isDiagnosticCheckpoint = (checkpoint) => ['scope-conflict', 'evidence-gap', 'risk-changed'].includes(checkpoint.kind)

const executionVersion = { inputVersion: z.number().int().positive(), runSequence: z.number().int().positive(), submissionId: z.string().trim().min(1).optional() }
const taskPromptRefSchema = z.object({ id: z.string().trim().min(1), revision: z.number().int().positive() }).strict()
const workflowAssessmentSchema = z.object({
  promptRefs: z.array(taskPromptRefSchema),
  reusedEvidence: z.array(z.string().trim().min(1)).default([]),
  inapplicableSteps: z.array(z.object({ promptId: z.string().trim().min(1), step: z.string().trim().min(1), reason: z.string().trim().min(1) }).strict()).default([]),
  exceptions: z.array(z.object({ requirement: z.string().trim().min(1), basisMessageIds: z.array(z.string().trim().min(1)).min(1), reason: z.string().trim().min(1) }).strict()).default([]),
}).strict()

const completedResultSchema = z.object({
  ...executionVersion,
  status: z.literal('completed'),
  workType: z.enum(['development', 'non-development']).optional(),
  summary: z.string().trim().min(1),
  evidence: z.array(z.string().trim().min(1)).min(1),
  artifacts: z.array(z.string().trim().min(1)).default([]),
  delivery: z.record(z.string(), z.unknown()).optional(),
}).strict()

const informationWaitingResultSchema = z.object({
  ...executionVersion,
  status: z.literal('waiting'),
  waitingKind: z.literal('information'),
  summary: z.string().trim().min(1),
  evidence: z.array(z.string().trim().min(1)).default([]),
  artifacts: z.array(z.string().trim().min(1)).default([]),
  waitingReason: z.string().trim().min(1),
  questions: z.array(z.string().trim().min(1)).min(1),
}).strict()

const humanInterventionWaitingResultSchema = z.object({
  ...executionVersion,
  status: z.literal('waiting'),
  waitingKind: z.literal('human-intervention'),
  summary: z.string().trim().min(1),
  evidence: z.array(z.string().trim().min(1)).min(1),
  artifacts: z.array(z.string().trim().min(1)).default([]),
  waitingReason: z.string().trim().min(1),
  blockerCategory: z.enum(['redline', 'network', 'disk', 'resource', 'unexpected', 'human-decision']),
  risk: z.string().trim().min(1).default('未单独说明；以阻塞原因、现场证据和申请范围为准。'),
  attemptedActions: z.array(z.string().trim().min(1)).default([]),
  requestedAction: z.string().trim().min(1),
}).strict()

export const taskResultSchema = z.union([completedResultSchema, informationWaitingResultSchema, humanInterventionWaitingResultSchema])

function parseResultShape(value) {
  const schema = value?.status === 'completed'
    ? completedResultSchema
    : value?.status === 'waiting' && value?.waitingKind === 'information'
      ? informationWaitingResultSchema
      : value?.status === 'waiting' && value?.waitingKind === 'human-intervention'
        ? humanInterventionWaitingResultSchema
        : null
  if (!schema) throw new Error(`task_result_invalid:${JSON.stringify({ issues: [{ path: value?.status === 'waiting' ? 'waitingKind' : 'status', message: 'unsupported discriminator' }] })}`)
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  const issues = parsed.error.issues.slice(0, 8).map((issue) => ({ path: issue.path.join('.') || '$', message: issue.message }))
  throw new Error(`task_result_invalid:${JSON.stringify({ issues })}`)
}

// 历史存储保留旧宽契约；新提交只使用下面按 kind 区分的契约。
export const storedTaskCheckpointBaseSchema = z.object({
  ...executionVersion,
  kind: z.enum(['plan-confirmed', 'stage-completed', 'scope-conflict', 'evidence-gap', 'risk-changed']),
  stageTask: z.string().trim().min(1).optional(),
  stageId: z.string().trim().min(1).optional(),
  summary: z.string().trim().min(1),
  completedItems: z.array(z.string().trim().min(1)).default([]),
  evidence: z.array(z.string().trim().min(1)).default([]),
  remainingItems: z.array(z.string().trim().min(1)).default([]),
  nextStep: z.string().trim().min(1),
  needsCoordinatorDecision: z.boolean().default(false),
  workflowAssessment: workflowAssessmentSchema.optional(),
}).strict()

const checkpointBase = storedTaskCheckpointBaseSchema.omit({ kind: true, workflowAssessment: true })
const checkpointBranches = [
  checkpointBase.extend({ kind: z.literal('plan-confirmed'), completedItems: z.array(z.string()).max(0).default([]), workflowAssessment: workflowAssessmentSchema.optional() }),
  checkpointBase.extend({ kind: z.literal('stage-completed'), stageTask: z.string().trim().min(1), evidence: z.array(z.string().trim().min(1)).min(1) }),
  ...['scope-conflict', 'evidence-gap', 'risk-changed'].map((kind) => checkpointBase.extend({ kind: z.literal(kind), completedItems: z.array(z.string()).max(0).default([]) })),
]
export const taskCheckpointSchema = z.discriminatedUnion('kind', checkpointBranches)
export const taskCheckpointJsonSchema = toToolJsonSchema(taskCheckpointSchema)
export const taskResultJsonSchema = toToolJsonSchema(taskResultSchema)

export function parseTaskResult(value) {
  const result = parseResultShape(value)
  if (result.status === 'waiting' && result.waitingKind === 'human-intervention' && ['network', 'resource'].includes(result.blockerCategory)) {
    const detail = `${result.summary}\n${result.waitingReason}\n${result.requestedAction}`
    if (/goal.{0,20}(轮|round).{0,20}(耗尽|用尽|exhaust)|继续.{0,12}(等待|监控|轮询|重试)|continue.{0,12}(waiting|monitoring|polling|retrying)|仍在.{0,8}(正常)?运行|still running/iu.test(detail)) {
      throw new Error('task_waiting_requires_real_human_action')
    }
  }
  return result
}

export function parseTaskCheckpoint(value) {
  const schema = checkpointBranches.find((branch) => branch.shape.kind.value === value?.kind)
  if (!schema) throw new Error('task_checkpoint_invalid:{"issues":[{"path":"kind","message":"unsupported discriminator"}]}')
  const result = schema.safeParse(value)
  if (result.success) return result.data
  const issues = result.error.issues.slice(0, 8).map((issue) => ({ path: issue.path.join('.') || '$', message: issue.message }))
  throw new Error(`task_checkpoint_invalid:${JSON.stringify({ issues, allowedFields: Object.keys(schema.shape), inputVersion: value?.inputVersion, runSequence: value?.runSequence })}`)
}
