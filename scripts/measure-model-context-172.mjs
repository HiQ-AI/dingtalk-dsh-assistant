// Synthetic Host JSON comparison; no provider, business store, or network calls.
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from '@deepseek-ai/dsh-session'
import * as after from '../packages/dingtalk-dsh-assistant/model-context.js'
import { context172Fixture } from '../test/fixtures/model-context-172.js'
const baseline = process.argv[2] ?? 'c38de6c445b37b7d3a390e969e414033dfe3d2c8'
const source = execFileSync('git', ['show', baseline + ':packages/dingtalk-dsh-assistant/model-context.js'], { encoding: 'utf8' })
  .replace("'@deepseek-ai/dsh-llm'", JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-llm')))
const before = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
const root = await mkdtemp(join(tmpdir(), 'issue172-measure-')), bytes = value => Buffer.byteLength(JSON.stringify(value))
try {
  const session = Session.create('synthetic-measurement')
  for (const [label, module] of Object.entries({ before, after })) {
    const index = module.createModelContentIndex(session, { root }), raw = context172Fixture()
    const projected = index.project(module.taskModelInput(raw), { reuseVisible: false })
    console.log(JSON.stringify({ baseline, label, scope: 'synthetic projected current Host JSON UTF-8 bytes',
      currentHostJSONBytes: bytes(projected), operationsBytes: bytes(projected.operations), blockerOperationsBytes: bytes(projected.blockers.operations),
      blockersBytes: bytes(projected.blockers), contentIndexBytes: bytes(projected.contentIndex ?? {}),
      historicalGoalBodyBytes: raw.executions.slice(0, 3).reduce((n, execution) => n + Buffer.byteLength(execution.input.objective), 0),
      stageSummaryOccurrences: JSON.stringify(projected).split(raw.executions[3].stageProgress.summary).length - 1,
      fieldValueBytes: Object.fromEntries(Object.entries(projected).map(([key, value]) => [key, bytes(value)])),
      referenceOccurrences: [...JSON.stringify(projected).matchAll(/"contentRef":/g)].length }))
  }
} finally { await rm(root, { recursive: true, force: true }) }
