// Native dsh-llm codes are provider-neutral contracts. A PI_AI_ERROR is
// deliberately not retryable unless its in-band Codex error has a verified shape.
const nativeTransient = new Set(['SERVER', 'RATE_LIMIT', 'TIMEOUT', 'EMPTY_RESPONSE'])
const credentials = new Set(['AUTH', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL'])
const quota = new Set(['QUOTA', 'ACCOUNT_QUOTA'])
const configuration = new Set(['NO_ADAPTER', 'INVALID_CATALOG', 'INVALID_MODEL_INFO', 'INVALID_MODEL_CONTEXT',
  'INVALID_MODEL_REASONING', 'UNSUPPORTED_REASONING_EFFORT', 'INVALID_REQUEST'])
const overloaded = 'Codex error: Our servers are currently overloaded. Please try again later.'
const processingError = 'Codex error: An error occurred while processing your request.'
export function classifyExecutionProviderFailure(cause) {
  const code = cause?.code, message = String(cause?.message ?? ''), firstLine = message.split('\n')[0].trim()
  if (credentials.has(code)) return { category: 'credentials', retryable: false, nextAction: 'verify-and-restore-provider-credentials' }
  if (quota.has(code)) return { category: 'quota', retryable: false, nextAction: 'verify-and-restore-provider-quota' }
  if (configuration.has(code)) return { category: 'configuration', retryable: false, nextAction: 'inspect-provider-configuration' }
  const diagnostics = /\n\[Codex diagnostics: (\{[^\n]*\})\]\s*$/.exec(message)
  let httpStatus
  try { httpStatus = diagnostics && JSON.parse(diagnostics[1]).httpStatus } catch {}
  // Contradictory transport errors must not turn a credential/permission denial into a retry.
  const transport = code === 'TRANSPORT' && firstLine && !/authentication failed|permission denied|invalid credential|insufficient quota/i.test(firstLine)
  const inBand = code === 'PI_AI_ERROR' && (firstLine === overloaded && (!message.includes('[Codex diagnostics:') || httpStatus === 200)
    || httpStatus === 200 && firstLine.startsWith(processingError))
  if (nativeTransient.has(code) || transport || inBand)
    return { category: 'transient', retryable: true, nextAction: 'retry-with-persisted-backoff' }
  return { category: 'unclassified', retryable: false, nextAction: 'inspect-native-provider-error-before-requesting-an-operation' }
}
