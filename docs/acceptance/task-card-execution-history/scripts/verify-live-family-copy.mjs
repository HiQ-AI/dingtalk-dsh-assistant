import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, relative, dirname, isAbsolute } from 'node:path'
import { DatabaseSync, backup } from 'node:sqlite'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { openExecutionStore } from '../../../../packages/dingtalk-dsh-assistant/execution-store.js'
import { groupTaskExecutions } from '../../../../packages/dingtalk-dsh-assistant/workflow-service.js'

const { values } = parseArgs({ options: {
  db: { type: 'string' }, snapshot: { type: 'string' }, evidence: { type: 'string' }
} })
for (const name of ['db', 'snapshot', 'evidence']) assert.ok(values[name], `需要 --${name}`)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const livePath = resolve(values.db), evidence = resolve(values.evidence)
const allowed = relative(join(root, 'docs/tmp'), evidence)
assert.ok(allowed && !allowed.startsWith('..') && !isAbsolute(allowed), '证据目录必须位于当前检出 docs/tmp 内')
await mkdir(evidence, { recursive: false })
const copyPath = join(evidence, 'control-copy.sqlite')
assert.notEqual(copyPath.toLowerCase(), livePath.toLowerCase())
const quote = name => `"${name.replaceAll('"', '""')}"`
const canonical = value => JSON.stringify(value, (_, item) => item instanceof Uint8Array ? [...item] : item)
function state(database) {
  return Object.fromEntries(database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => {
    const rows = database.prepare(`SELECT * FROM ${quote(name)}`).all().map(canonical).sort()
    return [name, { count: rows.length, digest: createHash('sha256').update(rows.join('\n')).digest('hex') }]
  }))
}
const live = new DatabaseSync(livePath, { readOnly: true })
let beforeLive
try {
  beforeLive = state(live)
  await backup(live, copyPath)
} finally { live.close() }
const copy = new DatabaseSync(copyPath, { readOnly: true })
const before = state(copy), instanceId = copy.prepare('SELECT instance_id FROM execution_meta').get().instance_id
copy.close()
const store = await openExecutionStore({ dbPath: copyPath, instanceId })
let families, catalog
try {
  families = await store.query({ kind: 'task.families' })
  catalog = await store.query({ kind: 'task.catalog' })
} finally { await store.close() }
const readback = new DatabaseSync(copyPath, { readOnly: true })
const after = state(readback)
readback.close()
const liveAfter = new DatabaseSync(livePath, { readOnly: true })
const afterLive = state(liveAfter)
liveAfter.close()
const physical = JSON.parse(await readFile(resolve(values.snapshot), 'utf8'))
const grouped = groupTaskExecutions(physical, families)
const definitions = [
  { name: '评审意见草稿回显', match: /评审意见.*保存草稿/u, count: 7 },
  { name: '数据集合并归一化', match: /两个来源各为0\.5 kg/u, count: 6 }
]
const byId = new Map(physical.map(task => [task.taskId, task]))
const cases = definitions.map(definition => {
  const family = families.find(item => item.taskIds.some(id => definition.match.test(canonical(byId.get(id)))))
  assert.ok(family, `${definition.name} 找到真实任务`)
  assert.equal(family.taskIds.length, definition.count)
  const cards = grouped.filter(card => family.taskIds.includes(card.taskId))
  assert.equal(cards.length, 1)
  assert.equal(cards[0].taskId, family.latestTaskId)
  const { archivedAt, ...original } = byId.get(family.latestTaskId)
  for (const [key, value] of Object.entries(original)) assert.deepEqual(cards[0][key], value, `现有卡片字段 ${key}`)
  const latestRuns = catalog.find(task => task.taskId === family.latestTaskId).runs
  if (definition.count === 7) assert.equal(latestRuns.length, 4)
  if (definition.count === 6) {
    const fourth = catalog.find(task => task.taskId === family.taskIds[3])
    assert.ok(fourth.runs.some(run => run.status === 'succeeded'))
    assert.equal(byId.get(fourth.taskId).outcome, 'cancelled')
  }
  return { name: definition.name, executions: family.taskIds.length, cards: cards.length, latestStageRuns: latestRuns.length, preservedCardFields: Object.keys(original).length }
})
assert.equal(cases.reduce((count, item) => count + item.executions, 0), 13)
assert.equal(cases.reduce((count, item) => count + item.cards, 0), 2)
const changedTables = Object.keys(before).filter(name => before[name].digest !== after[name]?.digest)
const liveChangedTables = Object.keys(beforeLive).filter(name => beforeLive[name].digest !== afterLive[name]?.digest)
const summary = { verified: true, cases, tableCount: Object.keys(before).length,
  copyBusinessDataUnchanged: changedTables.length === 0, changedTables,
  liveChangedTables, liveAccess: '仅 readOnly SQLite 连接及一致备份；正常运行可自行追加',
  limitation: '只验证数据库副本和聚合实现，不代表部署或两项业务重新验收' }
await writeFile(join(evidence, 'private-readback.json'), JSON.stringify({ families, catalog, before, after, beforeLive, afterLive }, null, 2))
await writeFile(join(evidence, 'summary.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary, null, 2))
