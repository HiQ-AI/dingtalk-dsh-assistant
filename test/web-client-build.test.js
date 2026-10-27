import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { Script, runInNewContext, createContext, runInContext } from 'node:vm'

const execute = promisify(execFile)
const root = new URL('../', import.meta.url)
const requireClient = createRequire(new URL('../packages/dingtalk-dsh-assistant/package.json', import.meta.url))
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dingtalk-web-build-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, 'scripts'))
  await mkdir(join(directory, 'packages/dingtalk-dsh-assistant'), { recursive: true })
  const builder = join(directory, 'scripts/build-web-client.mjs')
  const source = join(directory, 'packages/dingtalk-dsh-assistant/client.js')
  const target = join(directory, 'packages/dingtalk-dsh-assistant/web-client.js')
  await copyFile(new URL('scripts/build-web-client.mjs', root), builder)
  await copyFile(new URL('packages/dingtalk-dsh-assistant/client.js', root), source)
  return { directory, builder, source, target }
}

test('actual Web build emits one valid module, loads its factory, and matches the checked-in artifact', async t => {
  const f = await fixture(t)
  await execute(process.execPath, [f.builder], { cwd: f.directory })
  await execute(process.execPath, ['--check', f.target])
  const generated = await readFile(f.target, 'utf8')
  new Script(generated)
  assert.equal((generated.match(/const IconRefreshOutline16\s*=/g) ?? []).length, 1)
  assert.equal(generated, (await readFile(new URL('packages/dingtalk-dsh-assistant/web-client.js', root), 'utf8')).replaceAll('\r\n', '\n'), 'tracked artifact must be reproducible, not a separately hand-maintained implementation')
  let loaded
  runInNewContext(generated, { window: { __ModuleLoader__: { load(spec) { loaded = spec } } } })
  assert.equal(loaded.id, '@zzusp/dingtalk-dsh-assistant')
  const imports = []
  const module = loaded.factory(name => { imports.push(name); assert.equal(name, 'react'); return requireClient(name) })
  assert.deepEqual(imports, ['react'])
  assert.equal(module.name, 'dingtalk-dsh-assistant-client')
  assert.equal(typeof module.apply, 'function')
  assert.equal(typeof module.DingTalkDshAssistantCard, 'function')
  assert.equal(typeof module.readResidentOverview, 'function')
  await execute(process.execPath, [f.builder], { cwd: f.directory })
  assert.equal(await readFile(f.target, 'utf8'), generated, 'second build is byte-identical')
})

test('actual Web build rejects invalid generated JavaScript before overwriting a usable artifact', async t => {
  const f = await fixture(t)
  await writeFile(f.target, 'previous usable artifact\n')
  await writeFile(f.source, (await readFile(f.source, 'utf8')) + '\nconst IconRefreshOutline16 = null\n')
  await assert.rejects(execute(process.execPath, [f.builder], { cwd: f.directory }), error => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /Identifier 'IconRefreshOutline16' has already been declared/)
    return true
  })
  assert.equal(await readFile(f.target, 'utf8'), 'previous usable artifact\n')
})

test('official DSH client registry serves the built resource and its real browser module system imports it', async t => {
  let profile, native, Context, Loader, registryPath
  try {
    profile = createRequire(pathToFileURL(resolve(process.env.DSH_NATIVE_TEST_PROFILE ?? fileURLToPath(new URL('.dsh/profiles/resident/package.json', root)))))
    native = createRequire(profile.resolve('@deepseek-ai/dsh-base'))
    Context = profile('@deepseek-ai/cordis').Context
    Loader = profile('@deepseek-ai/cordis-plugin-loader').default
    registryPath = native.resolve('@deepseek-ai/dsh-client-modules')
  } catch (error) {
    t.skip('Installed alpha2 profile required for official client integration; set DSH_NATIVE_TEST_PROFILE: ' + error.message.split('\n')[0])
    return
  }
  const { ClientModuleRegistry } = await import(pathToFileURL(registryPath))
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  ctx.baseUrl = new URL('package.json', root).href
  await ctx.plugin(Loader)
  await ctx.loader.root.update([{ name: new URL('packages/dingtalk-dsh-assistant/index.js', root).href }])
  await ctx.loader.await()
  await ctx.plugin(ClientModuleRegistry)
  await ctx.loader.await()
  const registry = ctx.clientModules, graph = registry.graph(), id = '@zzusp/dingtalk-dsh-assistant'
  const entry = graph.entries.find(item => item.id === id)
  assert.ok(entry, 'real host manifest must contribute a client module')
  const response = await registry.fetchBundle({ method: 'GET', url: entry.url })
  assert.equal(response.status, 200)
  const resource = await response.text()
  new Script(resource)
  const pendingQueue = []
  // This is the initial facade expected by the official bootstrap, not a substitute loader.
  const facade = { mode: 'queue', pendingQueue, load: registration => pendingQueue.push(registration) }
  const context = createContext({ window: { __ModuleLoader__: facade }, console, URL, setTimeout, clearTimeout })
  runInContext(await readFile(join(dirname(registryPath), 'client.js'), 'utf8'), context)
  const registration = pendingQueue.shift()
  const bootstrap = registration.factory(name => { throw new Error('unexpected bootstrap import: ' + name) })
  const loadedResources = []
  const system = bootstrap.createClientModuleSystem(facade, { id: registration.id, exports: bootstrap }, {
    boot: graph, staticModules: { react: requireClient('react') },
    async loadBundle(url) {
      const response = await registry.fetchBundle({ method: 'GET', url })
      assert.equal(response.status, 200)
      loadedResources.push(url)
      runInContext(await response.text(), context)
    },
  })
  const module = await system.import(id)
  assert.equal(typeof module.apply, 'function')
  assert.equal(typeof module.DingTalkDshAssistantCard, 'function')
  assert.equal(typeof module.readResidentOverview, 'function')
  assert.deepEqual(Array.from(module.inject), ['slots', 'locale', 'remote', 'remote.session'])
  // The official browser system may use the combined graph revision instead of the entry revision.
  const resourcePath = url => url.replace(/&rev=[^&]*/u, '')
  assert.ok(loadedResources.some(url => resourcePath(url) === resourcePath(entry.url)), 'official import must actually request this module resource')
})
