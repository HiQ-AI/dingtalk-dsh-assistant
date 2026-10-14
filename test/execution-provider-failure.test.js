import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyExecutionProviderFailure as classify } from '../packages/dingtalk-dsh-assistant/execution-provider-failure.js'

for (const code of ['SERVER', 'RATE_LIMIT', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE']) test(`native provider retry contract: ${code}`, () => {
  assert.deepEqual(classify({ code, message: 'native failure' }), { category: 'transient', retryable: true, nextAction: 'retry-with-persisted-backoff' })
})
for (const [code, category] of [['AUTH','credentials'], ['MISSING_CREDENTIAL','credentials'], ['INVALID_CREDENTIAL','credentials'],
  ['QUOTA','quota'], ['ACCOUNT_QUOTA','quota'], ['NO_ADAPTER','configuration'], ['INVALID_REQUEST','configuration']]) test(`provider operation evidence: ${code}`, () => {
  assert.equal(classify({ code, message: 'native failure' }).category, category)
  assert.equal(classify({ code, message: 'native failure' }).retryable, false)
})
const processing = 'Codex error: An error occurred while processing your request. You can retry your request.'
for (const [message, retryable] of [
  ['Codex error: Our servers are currently overloaded. Please try again later.\n[Codex diagnostics: {"httpStatus":200}]', true],
  [processing + '\n[Codex diagnostics: {"httpStatus":200}]', true],
  [processing + '\n[Codex diagnostics: {"httpStatus":401}]', false],
  [processing + '\n[Codex diagnostics: {"httpStatus":429}]', false],
  [processing, false], ['authentication failed', false], ['fetch failed', false],
  ['Codex error: invalid account\n[Codex diagnostics: {"httpStatus":200}]', false],
  [processing + '\n[Codex diagnostics: invalid]', false],
]) test(`in-band provider processing error requires verified envelope: ${message}`, () => {
  assert.equal(classify({ code: 'PI_AI_ERROR', message }).retryable, retryable)
})
for (const message of ['authentication failed', 'permission denied', 'invalid credential', 'insufficient quota']) test(`contradictory transport cannot retry ${message}`, () => {
  assert.equal(classify({ code: 'TRANSPORT', message }).retryable, false)
})

for (const status of [401, 403, 429, 503]) test(`overload special case does not override contradictory HTTP ${status}`, () => {
  const error = { code: 'PI_AI_ERROR', message: 'Codex error: Our servers are currently overloaded. Please try again later.' + '\n[Codex diagnostics: ' + JSON.stringify({ httpStatus: status }) + ']' }
  assert.equal(classify(error).retryable, false); assert.equal(classify(error).category, 'unclassified')
})
test('malformed diagnostic envelope cannot admit overload special case', () => {
  assert.equal(classify({ code: 'PI_AI_ERROR', message: 'Codex error: Our servers are currently overloaded. Please try again later.\n[Codex diagnostics: invalid]' }).retryable, false)
})

test('anonymous field v12 HTTP200 in-band processing error is a failure with transient recovery, not success/auth/quota', async () => {
  const { fieldV12Error, fieldV12NativeEnd } = await import('./fixtures/execution-provider-field-sample.js')
  assert.equal(fieldV12NativeEnd.data.reason.kind, 'error')
  assert.equal(fieldV12Error.phase, undefined); assert.equal(fieldV12Error.status, undefined)
  assert.equal(classify(fieldV12Error).category, 'transient'); assert.equal(classify(fieldV12Error).retryable, true)
})
