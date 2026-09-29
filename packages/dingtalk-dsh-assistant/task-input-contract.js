import { z } from 'zod'

// 接纳新要求时共用；历史持久化 Schema 不套用此限制。
export const acceptanceCriterionSchema = z.string().max(2000).trim().min(1)
export const acceptanceCriteriaSchema = z.array(acceptanceCriterionSchema).min(1).max(32)
