import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
const source = (await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n')

test('single expansion initializes only after asynchronous data, uses displayed sort, and never overwrites manual choice', () => {
  const start = source.indexOf('      useEffect(() => {\n        if (!data) return')
  const fragment = source.slice(start, source.indexOf('      const archiveTask =', start))
  const initialized = { current: false }; let selected = '', data
  const apply = value => { data = value; runInNewContext(fragment, { data, expansionInitialized: initialized, useEffect: fn => fn(), setExpandedTaskId: value => { selected = typeof value === 'function' ? value(selected) : value } }) }
  apply(undefined); assert.equal(initialized.current, false)
  const tasks = [{ taskId: 'old', state: 'running', updatedAt: '2026-01-01' }, { taskId: 'new', state: 'running', updatedAt: '2026-02-01' }, { taskId: 'wait', state: 'waiting' }]
  apply({ tasks }); assert.equal(selected, 'new')
  selected = 'wait'; apply({ tasks }); assert.equal(selected, 'wait')
  selected = ''; apply({ tasks }); assert.equal(selected, '')
  selected = 'new'; apply({ tasks: tasks.map(t => t.taskId === 'new' ? { ...t, archivedAt: 'now' } : t) }); assert.equal(selected, '')
  apply({ tasks }); assert.equal(selected, '')
  initialized.current = false; apply({ tasks: tasks.filter(t => t.state !== 'running') }); assert.equal(selected, '')
})

test('archive guard is synchronous, failure leaves list unchanged, and success updates only the matching task', async () => {
  const fragment = source.slice(source.indexOf('      const archiveTask ='), source.indexOf('      const [error,', source.indexOf('      const archiveTask =')))
  let calls = 0, resolve, reject, feedback, data = { tasks: [{ taskId: 'a' }, { taskId: 'b' }] }, expanded = 'a'
  const env = { archivePending: { current: new Set() }, archivedTasksRef: { current: new Map() }, setArchivingIds() {}, setArchiveFeedback: value => { feedback = value }, setData: fn => { data = fn(data) }, setExpandedTaskId: fn => { expanded = fn(expanded) }, post: () => { calls++; return new Promise((yes, no) => { resolve = yes; reject = no }) }, encodeURIComponent, Error }
  const archive = runInNewContext(`(()=>{${fragment};return archiveTask})()`, env)
  const first = archive({ taskId: 'a', title: '甲' }); await archive({ taskId: 'a' }); assert.equal(calls, 1)
  reject(new Error('offline')); await first; assert.equal(feedback.error, true); assert.equal(data.tasks[0].archivedAt, undefined); assert.equal(expanded, 'a')
  const invalid = archive({ taskId: 'a' }); resolve({}); await invalid; assert.equal(feedback.error, true); assert.equal(data.tasks[0].archivedAt, undefined)
  const success = archive({ taskId: 'a', title: '甲' }); resolve({ taskId: 'a', archivedAt: 'now' }); await success
  assert.equal(data.tasks[0].archivedAt, 'now'); assert.equal(data.tasks[1].archivedAt, undefined); assert.equal(expanded, ''); assert.equal(feedback.error, undefined)
})

test('a list request started before archive cannot resurrect its task or overwrite newer execution state', async () => {
  const fragment = source.slice(source.indexOf('      const pendingRefresh ='), source.indexOf('      const manualRefresh ='))
  let resolve, data
  // The production callback reads this mutable map only after the read resolves.
  const env = { current: new Map() }
  const run = runInNewContext(`(()=>{${fragment};return refresh})()`, { useRef: value => ({ current: value }), useCallback: fn => fn,
    load: () => new Promise(yes => { resolve = yes }), archivedTasksRef: env, setData: value => { data = value }, setUpdatedAt() {}, setError() {}, Date })
  const pending = run(); env.current.set('a', { archivedAt: 'committed' }); resolve({ tasks: [{ taskId: 'a', executionCount: 9 }] }); await pending
  assert.equal(data.tasks[0].archivedAt, 'committed'); assert.equal(data.tasks[0].executionCount, 9)
})
