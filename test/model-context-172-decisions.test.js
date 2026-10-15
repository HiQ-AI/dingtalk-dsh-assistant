import test from 'node:test'
import assert from 'node:assert/strict'
import { decisionScenarios172, measureTaskDecision172 } from './fixtures/model-context-172-decisions.js'
for (const scenario of decisionScenarios172()) test('issue172 actual SDK judgment and read budget: ' + scenario.name, async t => {
  const metrics = await measureTaskDecision172(scenario)
  assert.ok(metrics.hostTextBytes < 3000, 'synthetic ordinary decision information fits without truncating its content')
  const expected = { 'first-entry': 0, 'stage-progress': 0, 'periodic-review': 1, 'new-message': 0, 'unknown-effect': 1, recovery: 1, 'long-new-message': 2 }
  assert.equal(metrics.readCalls, expected[scenario.name])
  assert.equal(metrics.sdkRequests, 1 + metrics.readCalls)
  if (scenario.name === 'long-new-message') assert.ok(metrics.cumulativeHostAndToolTextBytes > Buffer.byteLength(scenario.input.sources[1].text), 'necessary repeated-page input is reported rather than hidden by the Host budget')
  t.diagnostic(JSON.stringify(metrics))
})
