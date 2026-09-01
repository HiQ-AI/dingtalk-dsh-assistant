import { z } from 'zod'

const completedResultSchema = z.object({
  status: z.literal('completed'),
  workType: z.enum(['development', 'non-development']).optional(),
  summary: z.string().trim().min(1),
  evidence: z.array(z.string().trim().min(1)).min(1),
  artifacts: z.array(z.string().trim().min(1)).default([]),
  delivery: z.record(z.string(), z.unknown()).optional(),
}).strict()

const informationWaitingResultSchema = z.object({
  status: z.literal('waiting'),
  waitingKind: z.literal('information'),
  summary: z.string().trim().min(1),
  evidence: z.array(z.string().trim().min(1)).default([]),
  artifacts: z.array(z.string().trim().min(1)).default([]),
  waitingReason: z.string().trim().min(1),
  questions: z.array(z.string().trim().min(1)).min(1),
}).strict()

const humanInterventionWaitingResultSchema = z.object({
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

export const taskCheckpointSchema = z.object({
  kind: z.enum(['plan-confirmed', 'stage-completed', 'scope-conflict', 'evidence-gap', 'risk-changed']),
  stageTask: z.string().trim().min(1).optional(),
  summary: z.string().trim().min(1),
  completedItems: z.array(z.string().trim().min(1)).default([]),
  evidence: z.array(z.string().trim().min(1)).default([]),
  remainingItems: z.array(z.string().trim().min(1)).default([]),
  nextStep: z.string().trim().min(1),
  needsCoordinatorDecision: z.boolean().default(false),
}).strict()

export function parseTaskResult(value) {
  const result = taskResultSchema.parse(value)
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
