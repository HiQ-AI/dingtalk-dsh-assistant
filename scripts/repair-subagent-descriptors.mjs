import { appendFile, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'

const apply = process.argv.includes('--apply')
const root = process.argv.find((value) => value.startsWith('--root='))?.slice('--root='.length)
const statePath = process.argv.find((value) => value.startsWith('--state='))?.slice('--state='.length)
if (!root) throw new Error('必须通过 --root=<DSH session workspace> 指定目标目录')

const leafDisplayName = (objective) => {
  const normalized = objective.trim().replace(/\s+/gu, ' ')
  const heading = normalized.split(/[：:；;]/u, 1)[0] || normalized
  return heading.length <= 20 ? heading : `${heading.slice(0, 19)}…`
}
const taskLabels = new Map()
if (statePath) {
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  for (const task of Object.values(state.tables?.tasks ?? {})) taskLabels.set(task.taskId, leafDisplayName(task.title ?? task.objective))
}

const entries = await readdir(root, { withFileTypes: true })
const plans = []
for (const entry of entries) {
  if (!entry.isDirectory() || !entry.name.startsWith('session-task-')) continue
  const file = path.join(root, entry.name, 'session.jsonl')
  const text = await readFile(file, 'utf8')
  const lines = text.split('\n').filter(Boolean)
  const records = lines.map((line, index) => {
    try { return JSON.parse(line) } catch (error) { throw new Error(`${file}:${index + 1} JSON 无法解析`, { cause: error }) }
  })
  const header = records[0]
  if (header?.type !== 'session' || header.id !== entry.name || header.origin !== 'subagent') continue
  const events = records.slice(1)
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].seq !== index) throw new Error(`${file}:${index + 2} seq 不连续，期望 ${index}，实际 ${events[index].seq}`)
  }
  const taskId = [...taskLabels.keys()].find((candidate) => entry.name.startsWith(`session-${candidate}`))
  const label = taskLabels.get(taskId) ?? entry.name
  const descriptorIndex = events.findIndex((event) => event.type === 'subagent/descriptor')
  if (descriptorIndex >= 0) {
    const descriptor = events[descriptorIndex]
    if (descriptor.data?.provider !== 'dingtalk-dsh-assistant' || descriptor.data?.label === label) continue
    const updated = [...records]
    updated[descriptorIndex + 1] = { ...descriptor, data: snapshotSubagentDescriptor({ mode: 'continuable', provider: 'dingtalk-dsh-assistant', label }) }
    plans.push({ kind: 'update', file, content: `${updated.map((record) => JSON.stringify(record)).join('\n')}\n` })
    continue
  }
  const event = {
    type: 'subagent/descriptor',
    seq: events.length,
    time: Date.now(),
    data: snapshotSubagentDescriptor({ mode: 'continuable', provider: 'dingtalk-dsh-assistant', label }),
  }
  plans.push({ kind: 'append', file, event })
}

if (apply) {
  for (const plan of plans) {
    if (plan.kind === 'append') await appendFile(plan.file, `${JSON.stringify(plan.event)}\n`, 'utf8')
    else {
      const temporary = `${plan.file}.descriptor-update.tmp`
      await writeFile(temporary, plan.content, 'utf8')
      await rename(temporary, plan.file)
    }
  }
}
console.log(JSON.stringify({ mode: apply ? 'apply' : 'check', candidates: plans.length, appends: plans.filter((plan) => plan.kind === 'append').length, updates: plans.filter((plan) => plan.kind === 'update').length, files: plans.map((plan) => plan.file) }, null, 2))
