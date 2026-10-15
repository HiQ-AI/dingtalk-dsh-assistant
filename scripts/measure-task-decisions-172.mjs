import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { decisionScenarios172, measureTaskDecision172 } from '../test/fixtures/model-context-172-decisions.js'
const baselineFile = process.argv[2]
const projectionSource = baselineFile ? await readFile(baselineFile, 'utf8') : execFileSync('git', ['show',
  'c38de6c445b37b7d3a390e969e414033dfe3d2c8:packages/dingtalk-dsh-assistant/model-context.js'], { encoding: 'utf8' })
for (const scenario of decisionScenarios172()) {
  const before = await measureTaskDecision172(scenario, { projectionSource })
  const after = await measureTaskDecision172(scenario)
  console.log(JSON.stringify({ scope: 'actual SDK, scripted identical judgment; UTF-8 JSON bytes, not tokens', baseline: baselineFile ?? 'main-c38de6c', before, after }))
}
