import testRunner from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, writeFile, symlink, rm, readdir, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { get } from 'node:http'
import { available, reason, nativeTaskHost, latestInput, topicTaskCalls } from './fixtures/task-session-native-host.js'

const exec = promisify(execFile)
const source = fileURLToPath(new URL('../packages/dingtalk-dsh-assistant/', import.meta.url))
const test = (name, run) => testRunner(name, { timeout: 30000, ...(!available ? { skip: reason } : {}) }, run)
const call = (name, args) => ({ name, args })
const finish = action => call('task_session_submit', { decision: { action, summary: 'Package verification.', evidence: [], limitations: [] } })

async function pack(t) {
  const root = await mkdtemp(join(tmpdir(), 'task-package-native-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let manifest
  if (process.env.RELEASE_PACKAGE_DIRECTORY) {
    const version = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).version
    const tarball = resolve(process.env.RELEASE_PACKAGE_DIRECTORY, 'zzusp-dingtalk-dsh-assistant-' + version + '.tgz')
    const { stdout } = await exec('tar', ['-tf', tarball])
    manifest = { files: stdout.trim().split(/\r?\n/).map(path => ({ path: path.replace(/^package\//, '') })) }
    await exec('tar', ['-xzf', tarball, '-C', root])
  } else {
  let npm
  for (const candidate of [process.env.npm_execpath, join(dirname(process.execPath), 'npm'),
    join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean)) {
    const path = await realpath(candidate).catch(() => null)
    if (path?.endsWith('npm-cli.js')) { npm = path; break }
  }
  assert.ok(npm, 'An installed npm CLI is required for a real package test')
  // Give npm ordinary independent inodes: some cloud overlay source inodes exceed
  // Number.MAX_SAFE_INTEGER and npm/tar can otherwise alias different files.
  const staging = join(root, 'source'); await mkdir(staging)
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isFile()) await copyFile(join(source, entry.name), join(staging, entry.name))
  }
  const { stdout } = await exec(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', root, '--cache', join(root, 'npm-cache')], { cwd: staging })
  ;[manifest] = JSON.parse(stdout)
  await exec('tar', ['-xzf', join(root, manifest.filename), '-C', root])
  }
  const dir = join(root, 'package'), pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  // Inspect the extracted artifact, never resolve missing runtime imports from source.
  // Cover static imports/re-exports and literal dynamic imports/require calls in every packed JS file.
  const packedPaths = new Set(manifest.files.map(entry => entry.path))
  assert.ok(packedPaths.has('task-boundary-instructions.js'), 'The shared task boundary runtime must ship')
  for (const entry of manifest.files.filter(entry => entry.path.endsWith('.js'))) {
    const code = await readFile(join(dir, entry.path), 'utf8')
    assert.equal(code, await readFile(join(source, entry.path), 'utf8'), `Packed runtime bytes differ: ${entry.path}`)
    const references = code.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"\r\n]+)['"]/g)
    for (const [, specifier] of references) {
      const target = fileURLToPath(new URL(specifier, pathToFileURL(join(dir, entry.path))))
      const relative = target.slice(dir.length + 1).replaceAll('\\', '/')
      assert.ok(target.startsWith(dir + '/') || target.startsWith(dir + '\\'), `Runtime import escapes package: ${entry.path}: ${specifier}`)
      assert.ok(packedPaths.has(relative), `Missing packed runtime dependency: ${entry.path}: ${specifier}`)
      await readFile(target)
    }
  }
  assert.ok(pkg.files.every(path => !path.includes('*')), 'Publication must use an explicit runtime allowlist')
  assert.ok(manifest.files.some(entry => entry.path === 'notification-delivery.js'), 'The durable notification helper must ship in the runtime tarball')
  assert.equal(pkg.exports['./execution'], undefined)
  assert.equal(pkg.exports['./platform-host'], undefined)
  assert.doesNotMatch(await readFile(join(dir, 'README.md'), 'utf8'), /ownerContract|NodeRun|workflow\.register|task-workflow\.js/, 'The automatically included package README must not advertise the retired engine')
  const retired = /^(?:legacy-|workflow-|platform-host|task-workflow|task-owner-|task-release-|task-uat-pr|task-group-file|execution-store|execution-controller|execution-task-purge)/
  for (const entry of manifest.files) {
    assert.ok(!retired.test(entry.path), `Retired asset was packed: ${entry.path}`)
    assert.ok(!/SKILL\.md|source-map\.json|(?:^|\/)skills\//.test(entry.path))
    if (entry.path.endsWith('.js')) assert.doesNotMatch(await readFile(join(dir, entry.path), 'utf8'), /小小鹏|D:[/\\]baibu-agent|HiQ-AI\/dataset(?:-web)?|bytebase\.baibu/i)
  }
  // Use the already installed official dependency tree; no source fallback or dependency download.
  const installed = createRequire(join(source, 'package.json'))
  for (const name of Object.keys(pkg.dependencies)) {
    const target = dirname(installed.resolve(name + '/package.json'))
    const link = join(dir, 'node_modules', name)
    await mkdir(dirname(link), { recursive: true })
    await symlink(await realpath(target), link, 'junction')
  }
  const delivery = await import(pathToFileURL(join(dir, 'notification-delivery.js')).href)
  assert.equal(typeof delivery.deliverTaskNotification, 'function')
  assert.equal(typeof (await import(pathToFileURL(join(dir, 'dws-adapter.js')).href)).createDwsAdapter, 'function')
  return { root, dir, pkg, manifest }
}

test('actual npm tarball has only the generic runtime and runs a personal-skill task from its extracted files', async t => {
  const f = await pack(t), service = await import(pathToFileURL(join(f.dir, 'task-session-service.js')).href)
  assert.equal((await import(pathToFileURL(join(f.dir, 'index.js')).href)).name, 'dingtalk-dsh-assistant-web')
  const personal = join(f.root, 'personal'), work = join(f.root, 'runtime')
  await mkdir(join(personal, 'external-guide'), { recursive: true }); await mkdir(work)
  await writeFile(join(personal, 'external-guide', 'SKILL.md'), '---\nname: external-guide\ndescription: External user-owned guide.\n---\nPACKED_PERSONAL_BODY\n')
  let step = 0
  const h = await nativeTaskHost(work, async request => {
    const input = latestInput(request), names = request.tools.map(tool => tool.name)
    const topicCalls = topicTaskCalls(request)
    if (topicCalls) return topicCalls
    if (names.includes('task_delegate')) {
      if (input.executions.length) return [finish('complete')]
      assert.ok(JSON.stringify(request).includes('External user-owned guide.'))
      return [call('task_delegate', { key: 'packed-guide', objective: 'Read the external guide', skillNames: ['external-guide'] }), finish('wait')]
    }
    if (step++ === 0) return [call('skill', { name: 'external-guide' })]
    assert.ok(JSON.stringify(request).includes('PACKED_PERSONAL_BODY'))
    return [call('execution_submit', { output: { status: 'completed', summary: 'Read actual external skill.', evidence: [], limitations: [], artifacts: [] } })]
  }, { skillDirs: [personal], serviceFactory: service.openTaskSessionService })
  t.after(() => h.close())
  try {
    await h.service.ingest({ groupId: 'native-group', messageId: 'packed-skill', senderOpenDingTalkId: 'native-user', text: '测试助手，Read my external guide.', occurredAt: '2026-10-13T17:00:00Z', timestamp: '2026-10-13T17:00:00Z' })
    await h.service.whenIdle()
    assert.equal((await h.query('task.list'))[0].status, 'completed')
    assert.equal((await h.query('task.list'))[0].topicRefs.length, 1)
    assert.equal(h.residentStore.listTopics('native-group').length, 1)
    assert.deepEqual(await h.query('operation.list'), [])
    assert.deepEqual((await h.service.recover()).failures, [])
  } finally { await h.close() }
})

test('actual extracted resident starts and serves health without legacy entrypoints or personal assets', async t => {
  const f = await pack(t), resident = await import(pathToFileURL(join(f.dir, 'resident.js')).href)
  const work = join(f.root, 'runtime'); await mkdir(work)
  const h = await nativeTaskHost(work, () => { throw new Error('Startup must not call a model') }, { resident: true })
  t.after(() => h.close())
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const env = Object.fromEntries(['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','NO_PROXY','no_proxy'].map(key => [key, process.env[key]]))
  t.after(() => { for (const [key,value] of Object.entries(env)) if (value === undefined) delete process.env[key]; else process.env[key] = value })
  let fiber
  try {
    fiber = await h.ctx.plugin(resident, { host: '127.0.0.1', port, proxyUrl: '', agentWorkspaceDir: work, agentPreset: 'native-test',
      dws: { enabled: false }, taskSessions: { dbPath: join(work, 'resident.db'), instanceId: 'packed-runtime', initialize: true,
        ownerActorId: 'native-user', webActorId: 'native-user', ingressEpoch: '2026-10-13T00:00:00Z', recoveryIntervalMs: 60000 } })
    const health = await new Promise((resolve,reject) => get(`http://127.0.0.1:${port}/health`, { agent: false }, response => {
      let text = ''; response.on('data', chunk => { text += chunk }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }))
    }).on('error', reject))
    assert.equal(health.status, 200); assert.equal(health.body.status, 'ok')
    assert.equal(h.requests.length, 0)
    for (const name of ['workflow', 'execution', 'goal']) assert.equal(h.ctx.get(name), undefined)
  } finally { await fiber?.dispose(); await h.close() }
})
