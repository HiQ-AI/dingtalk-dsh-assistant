import { z } from 'zod'

// 接纳新要求时共用；历史持久化 Schema 不套用此限制。
export const acceptanceCriterionSchema = z.string().trim().min(1)
export const acceptanceCriteriaSchema = z.array(acceptanceCriterionSchema).min(1)

export const taskContextProgressImpactSchema = z.enum(['preserve', 'replan']).describe('必填语义声明：preserve确认不改变目标、授权、验收或既有证据有效性；replan明确要求使旧判断失效。无法判断时先读取来源补判，不得省略或默认replan。')
export const taskContextInputContract = Object.freeze({ required: ['progressImpact'], progressImpact: ['preserve', 'replan'],
  preserve: '目标、授权、验收及既有证据有效性不变', replan: '明确变更目标、授权、验收或证据有效性，使旧判断失效',
  missingClassification: 'reject-without-cancelling', cancellation: 'task-cancel / cancelTask' })
export function taskContextSemanticsProblem(value) {
  if (!['preserve', 'replan'].includes(value.progressImpact)) return 'TASK_CONTEXT_CLASSIFICATION_REQUIRED'
  if (value.progressImpact === 'preserve' && (value.authorizationChange === 'changed' || value.objective !== undefined
    || value.acceptanceCriteria !== undefined || value.stageTasks !== undefined || value.impactEvidence !== undefined)) return 'TASK_CONTEXT_CLASSIFICATION_CONFLICT'
  return null
}
export function assertTaskContextSemantics(value) {
  const problem = taskContextSemanticsProblem(value)
  if (problem) throw Object.assign(new Error(problem), { code: problem })
}

export const taskTitleSchema = z.string().trim().min(1).max(30)
export function taskTitle(value) {
  const characters = Array.from(String(value ?? '').replace(/\s+/gu, ' ').trim())
  return characters.length > 30 ? `${characters.slice(0, 29).join('')}…` : characters.join('')
}
