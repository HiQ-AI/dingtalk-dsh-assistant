import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')

function harness() {
  let module
  const boundaries = new Map(), entries = [], calls = [], addresses = new Map()
  // Expose the closure's existing close action without changing the shipped module.
  runInNewContext(source.replace('return module.exports', 'return { ...module.exports, close: () => setOpen(false) }'), {
    document: { querySelector: () => null },
    window: { __ModuleLoader__: { load: options => { module = options.factory(() => ({})) } } },
  })
  const ctx = {
    slots: {
      inject(name, callback) { boundaries.set(name, callback) },
      register(options, component) {
        assert.ok(['main.conversation', 'sidebar.footer.action'].includes(options.name))
        if (options.name === 'main.conversation') assert.equal(options.priority, -10)
        const entry = { options, component, active: true }
        entries.push(entry)
        return () => { entry.active = false }
      },
    },
    layout: { selectPanel: value => calls.push(['selectPanel', value]) },
    uiWorkspace: { openSession: target => calls.push(['openSession', target]) },
    sessions: {
      subagentAddress: id => addresses.get(id),
      refreshProjections: async id => { calls.push(['refreshProjections', id]) },
      refresh: async () => { calls.push(['refresh']) },
    },
  }
  module.apply(ctx)
  const mount = name => boundaries.get(name)()
  const content = () => entries.filter(entry => entry.active && entry.options.name === 'main.conversation')
  const sidebarDispose = mount('sidebar.footer.action')
  const open = entries[0].options.inject().onOpen
  return { module, ctx, calls, addresses, mount, content, open, sidebarDispose }
}

test('alpha.2 observer waits for the current slot declaration and restores it across remounts', () => {
  const h = harness()
  assert.deepEqual([...h.module.inject], ['slots', 'sessions', 'uiWorkspace', 'layout'])
  h.open()
  assert.deepEqual(h.calls, [['selectPanel', null]])
  assert.equal(h.content().length, 0)
  const dispose = h.mount('main.conversation')
  assert.equal(h.content().length, 1)
  h.open()
  assert.equal(h.content().length, 1, 'repeated board clicks must not duplicate the single-slot shadow')
  h.module.close()
  assert.equal(h.content().length, 0)
  h.open()
  assert.equal(h.content().length, 1)
  dispose()
  assert.equal(h.content().length, 0)
  const remountDispose = h.mount('main.conversation')
  assert.equal(h.content().length, 1, 'open board survives a host declaration remount')
  remountDispose()
  h.module.close()
  h.open()
  assert.equal(h.content().length, 0, 'disposal removes the visibility subscription')
  h.sidebarDispose()
})

test('alpha.2 observer navigates root and discovered child sessions through uiWorkspace', async () => {
  const h = harness()
  h.mount('main.conversation')
  h.open()
  h.calls.length = 0
  const { openSession } = h.content()[0].options.inject()
  await openSession('root')
  assert.deepEqual(h.calls.splice(0), [['refresh'], ['openSession', 'root']])
  const child = { parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable' }
  h.addresses.set('child', child)
  await openSession('child', 'parent')
  assert.deepEqual(h.calls.splice(0), [['openSession', child]])
  h.addresses.clear()
  h.ctx.sessions.refreshProjections = async id => { h.calls.push(['refreshProjections', id]); h.addresses.set('child', child) }
  await openSession('child', 'parent')
  assert.deepEqual(h.calls.splice(0), [['refreshProjections', 'parent'], ['openSession', child]])
  await openSession('catalogued-child', 'parent')
  assert.deepEqual(h.calls.splice(0), [['refreshProjections', 'parent'], ['refresh'], ['openSession', 'catalogued-child']])
})

test('alpha.2 observer propagates discovery failures without navigating to the wrong session', async () => {
  const h = harness()
  h.mount('main.conversation')
  h.open()
  h.calls.length = 0
  h.ctx.sessions.refreshProjections = async () => { throw new Error('projection unavailable') }
  await assert.rejects(h.content()[0].options.inject().openSession('child', 'parent'), /projection unavailable/)
  assert.deepEqual(h.calls, [])
  assert.equal(h.content().length, 1)
})
