const fail = code => { throw Object.assign(new Error(code), { code }) }
export function taskModelConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('TASK_SESSION_MODEL_INVALID')
  for (const key of ['provider', 'model']) if (value[key] !== undefined && typeof value[key] !== 'string') fail('TASK_SESSION_MODEL_INVALID')
  const effort = value.reasoningEffort === undefined && value.reasoningMode === undefined ? 'low' : value.reasoningEffort
  if (effort !== undefined && effort !== null && typeof effort !== 'string') fail('TASK_SESSION_REASONING_EFFORT_INVALID')
  const reasoningMode = value.reasoningMode ?? (effort === undefined ? 'inherit' : effort === null || effort === '' ? 'model-default' : 'explicit')
  if (!['inherit', 'model-default', 'explicit'].includes(reasoningMode)
    || reasoningMode === 'explicit' && (typeof effort !== 'string' || !effort.trim())) fail('TASK_SESSION_REASONING_EFFORT_INVALID')
  return { provider: value.provider?.trim() || 'openai-codex', model: value.model?.trim() || 'gpt-6-astra',
    reasoningMode, reasoningEffort: reasoningMode === 'explicit' ? effort.trim() : null }
}
export function taskModelSelection(selection, config) {
  const value = taskModelConfig(config)
  const { reasoningEffort: inherited, ...rest } = selection
  const effort = value.reasoningMode === 'inherit' ? inherited : value.reasoningMode === 'explicit' ? value.reasoningEffort : undefined
  return { ...rest, provider: value.provider, model: value.model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
}
