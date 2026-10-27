// Controlled comparison: load the actual pre-PR adapter while keeping the same
// native fixture/service. The baseline adapter does not forward onInputSettled.
import { registerHooks } from 'node:module'
import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const target = pathToFileURL(resolve(root, 'packages/dingtalk-dsh-assistant/task-topic-coordinator.js')).href
const source = execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, '-C', root,
  'show', 'd27d71aaa851cba9dd089930473db6a490c0b367:packages/dingtalk-dsh-assistant/task-topic-coordinator.js'], { encoding: 'utf8' })
registerHooks({ load(url, context, next) {
  return url === target ? { format: 'module', source, shortCircuit: true } : next(url, context)
} })
