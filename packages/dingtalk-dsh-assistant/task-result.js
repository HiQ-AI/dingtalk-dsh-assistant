import { z } from 'zod'

const executionVersion = { inputVersion: z.number().int().positive(), runSequence: z.number().int().positive() }
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

export const taskCheckpointSchema = z.object({
  ...executionVersion,
  kind: z.enum(['plan-confirmed', 'stage-completed', 'scope-conflict', 'evidence-gap', 'risk-changed']),
  stageTask: z.string().trim().min(1).optional(),
  summary: z.string().trim().min(1),
  completedItems: z.array(z.string().trim().min(1)).default([]),
  evidence: z.array(z.string().trim().min(1)).default([]),
  remainingItems: z.array(z.string().trim().min(1)).default([]),
  nextStep: z.string().trim().min(1),
  needsCoordinatorDecision: z.boolean().default(false),
  workflowAssessment: workflowAssessmentSchema.optional(),
}).strict()

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
  return taskCheckpointSchema.parse(value)
}
